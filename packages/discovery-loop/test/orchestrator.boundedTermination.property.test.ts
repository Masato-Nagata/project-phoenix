// Task 4.5, Property 18: every Run terminates within bounds with exactly one reason (design.md, "Property 18").
// The composition root (`createLoopOrchestrator`) with the real session, latch, writer, Terminator and RunRecordStore, driven through the
// test-support world of the Mock Run (`support/mockRunWorld.ts`). The only change is the provider: a SCRIPTED provider answers each call with a
// step (success through the real Mock_Provider wrapper, failure, timeout, garbage, hang until the per-call timer or the Run deadline, audit violation).
// Time is a FAKE clock (`world.time`) and the timers are the recorded entries of `world.timers`; nothing waits for real time, nothing uses the network.
// The property tests use a FIXED seed (SEED below). Re-run one failing case: `fc.assert(..., { seed: SEED, path: "<path printed by fast-check>" })`.
// This file only tests the existing termination contract. It changes nothing in `src/`.
// **Validates: Requirements 2.10, 3.8, 3.9, 4.9, 8.10, 8.11, 11.7, 11.8, 11.9, 11.10, 11.11, 11.12, 11.13, 11.14, 11.15, 11.16, 11.17, 11.18**
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE } from "../src/index.js";
import { createLoopOrchestrator } from "../src/orchestrator/loopOrchestrator.js";
import { rankOf } from "../src/orchestrator/terminationLatch.js";
import { TERMINATION_REASONS, type RunResult } from "../src/orchestrator/types.js";
import { RUN_DIR, buildWorld, volumeText, type Any, type World, type WorldOptions } from "./support/mockRunWorld.js";

const SEED = 4_050_018;
const NUM_RUNS = 30;
const TIMEOUT_MS = 300_000;
/** The design bound: the elapsed fake-clock time is at most the Run time limit plus 30 seconds. */
const SLACK_MS = 30_000;
const ALL_REASONS: readonly string[] = TERMINATION_REASONS;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

// ---------------------------------------------------------------------------------------------------------------------------------
// the scripted provider
// ---------------------------------------------------------------------------------------------------------------------------------
type Step =
  /** A valid response of the real Mock_Provider. */
  | { readonly k: "ok" }
  /** The call takes `ms` of fake time, then the Mock_Provider answers. */
  | { readonly k: "slow"; readonly ms: number }
  /** A provider failure after `ms` of fake time. */
  | { readonly k: "fail"; readonly reason: "error" | "timeout"; readonly ms: number }
  /** Bytes that are not JSON (the gate rejects them as unparseable). */
  | { readonly k: "garbage" }
  /** A valid experiment_generation response with no Experiment (other request kinds get the normal answer). */
  | { readonly k: "empty" }
  /** The call never answers; the per-call timer fires (after the call limit of fake time). */
  | { readonly k: "hang_call" }
  /** The call never answers; the Run deadline timer fires `extra` ms after the deadline. With `down`, every store write fails first. */
  | { readonly k: "hang_deadline"; readonly extra: number; readonly down: boolean }
  /** The provider guard reports an audit violation. */
  | { readonly k: "violation" };

type Fault = "none" | "ai_call_down" | "payload_audit_down";

interface Scenario {
  readonly iterations: 1 | 2;
  readonly experiments: number;
  readonly retries: number;
  readonly callSeconds: number;
  readonly runSeconds: number;
  readonly script: readonly Step[];
  readonly fault: Fault;
}

interface CallSeen {
  readonly kind: string;
  readonly at: number;
}

/** Fires the Run deadline timer (the first timer of the world) after moving the fake clock to `deadlineAt + extra`. */
function fireDeadline(w: World, deadlineAt: number, extra: number): void {
  w.time.t = Math.max(w.time.t, deadlineAt + extra);
  const entry = w.timers[0];
  if (entry !== undefined) entry.fire();
}

function scriptedProvider(w: World, script: readonly Step[], deadlineAt: number, callMs: number): { provider: Any; calls: CallSeen[] } {
  const real = w.deps.provider as Any;
  const calls: CallSeen[] = [];
  const provider = {
    identity: real.identity,
    complete(req: Any, opts: Any): Promise<Any> {
      const step: Step = script[calls.length] ?? { k: "ok" };
      calls.push({ kind: String(req.kind), at: w.time.t });
      switch (step.k) {
        case "ok":
          return real.complete(req, opts);
        case "slow":
          w.time.t += step.ms;
          return real.complete(req, opts);
        case "fail":
          w.time.t += step.ms;
          return Promise.resolve({ ok: false, error: { reason: step.reason, detail: "scripted failure" } });
        case "garbage":
          return Promise.resolve({ ok: true, value: enc("not json") });
        case "empty":
          if (req.kind === "experiment_generation") return Promise.resolve({ ok: true, value: enc('{"experiments":[]}') });
          return real.complete(req, opts);
        case "violation":
          return Promise.resolve({ ok: false, error: { reason: "audit_violation", detail: "scripted", violation: { code: "not_audited" } } });
        case "hang_call":
          return new Promise((resolve) => {
            opts.signal.addEventListener("abort", () => resolve({ ok: false, error: { reason: "error", detail: "aborted" } }), { once: true });
            queueMicrotask(() => {
              w.time.t += callMs;
              // the timer of THIS call is the newest timer that is neither the deadline timer nor cancelled
              const mine = [...w.timers].reverse().find((e) => e !== w.timers[0] && e.cancelled === 0);
              if (mine !== undefined) mine.fire();
            });
          });
        case "hang_deadline":
          return new Promise((resolve) => {
            opts.signal.addEventListener("abort", () => resolve({ ok: false, error: { reason: "error", detail: "aborted" } }), { once: true });
            queueMicrotask(() => {
              if (step.down) w.armStoreFailure();
              fireDeadline(w, deadlineAt, step.extra);
            });
          });
      }
    },
  };
  return { provider, calls };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// running a scenario
// ---------------------------------------------------------------------------------------------------------------------------------
interface Outcome {
  readonly w: World;
  readonly r: RunResult;
  readonly s: Scenario;
  readonly calls: CallSeen[];
  readonly startAt: number;
  readonly deadlineAt: number;
}
interface Hooks {
  /** Extra world options (for example a large source text). */
  readonly world?: Partial<WorldOptions>;
  /** Replacements for keys of `LoopDeps`, built after the world exists. */
  readonly deps?: (w: World, c: { deadlineAt: number }) => Record<string, unknown>;
}

const base = (over: Partial<Scenario> = {}): Scenario => ({ iterations: 1, experiments: 20, retries: 0, callSeconds: 5, runSeconds: 60, script: [], fault: "none", ...over });

async function execute(s: Scenario, hooks: Hooks = {}): Promise<Outcome> {
  const fault: Partial<WorldOptions> =
    s.fault === "none" ? {} : { failAppend: { kind: s.fault === "payload_audit_down" ? "payload_audit" : "ai_call", error: "io_failure" } };
  const w = await buildWorld({
    iterations: s.iterations,
    limits: { experiments: s.experiments, providerRetries: s.retries, providerCallSeconds: s.callSeconds, runSeconds: s.runSeconds },
    ...fault,
    ...(hooks.world ?? {}),
  });
  const startAt = w.time.t;
  const deadlineAt = startAt + s.runSeconds * 1000;
  const sp = scriptedProvider(w, s.script, deadlineAt, s.callSeconds * 1000);
  const deps: Any = { ...(w.deps as Any), provider: sp.provider, ...(hooks.deps?.(w, { deadlineAt }) ?? {}) };
  const r = await createLoopOrchestrator(deps, w.extras).run(w.approval);
  return { w, r, s, calls: sp.calls, startAt, deadlineAt };
}

const reasonOf = (r: RunResult): string | undefined => (r.sealed ? r.summary.terminationReason : r.terminationReason);
const payloads = (w: World, kind: string): Any[] => w.records().filter((x) => x.kind === kind).map((x) => x.payload as Any);
const kindsOf = (w: World): string[] => w.records().map((x) => x.kind);
const manifestOf = (w: World): Any => JSON.parse(dec(w.mem.peek(`${RUN_DIR}/${MANIFEST_FILE}`) as Uint8Array));

// ---------------------------------------------------------------------------------------------------------------------------------
// the invariants of Property 18 (they hold for every scenario, sealed or not)
// ---------------------------------------------------------------------------------------------------------------------------------
function checkInvariants(x: Outcome): void {
  const { w, r, s, calls, startAt, deadlineAt } = x;
  const ctx = JSON.stringify(s);
  const recs = w.records();
  const terms = recs.filter((e) => e.kind === "termination");
  const reason = reasonOf(r);

  // exactly one termination reason, from the defined set; the record, the result and the Manifest name the same one
  expect(terms.length, ctx).toBeLessThanOrEqual(1);
  if (reason !== undefined) expect(ALL_REASONS.includes(reason), ctx).toBe(true);
  if (terms.length === 1 && reason !== undefined) expect((terms[0]?.payload as Any).terminationReason, ctx).toBe(reason);
  if (r.sealed) {
    expect(reason, ctx).toBeDefined();
    expect(terms, ctx).toHaveLength(1);
    expect(kindsOf(w)[recs.length - 1], ctx).toBe("termination");
    expect(w.manifestExists(), ctx).toBe(true);
    expect(manifestOf(w).terminationReason, ctx).toBe(reason);
  } else {
    expect(w.manifestExists(), ctx).toBe(false); // never a Manifest for an unsealed Run
    expect(Object.keys(r), ctx).not.toContain("summary");
  }

  // an injected write failure ends the Run with `error`, whatever else happened
  if (s.fault !== "none") expect(reason, ctx).toBe("error");
  if (s.fault === "payload_audit_down") {
    expect(calls, ctx).toHaveLength(0); // no audit record, so no provider call
    expect(r.sealed, ctx).toBe(false);
  }

  // iterations, Experiments, attempts
  const audits = payloads(w, "payload_audit");
  expect(payloads(w, "experiment").length, ctx).toBeLessThanOrEqual(s.experiments);
  expect(calls.length, ctx).toBeLessThanOrEqual((s.retries + 1) * 2 * s.iterations);
  expect(audits.length, ctx).toBeGreaterThanOrEqual(calls.length); // every provider call has its own audit record first
  for (const a of audits) {
    expect(a.attempt, ctx).toBeGreaterThanOrEqual(1);
    expect(a.attempt, ctx).toBeLessThanOrEqual(s.retries + 1);
  }
  if (r.sealed) {
    const m = manifestOf(w);
    expect(m.limitsUsed.iterations, ctx).toBeLessThanOrEqual(s.iterations);
    expect(m.limitsUsed.acceptedExperiments, ctx).toBeLessThanOrEqual(s.experiments);
    expect(String(m.finalHypothesisRevision), ctx).toMatch(/^(none|hyp-\d+)$/);
    const ids = payloads(w, "hypothesis_revision").map((p) => p.hypothesisId);
    if (m.finalHypothesisRevision === "none") expect(ids, ctx).toHaveLength(0);
    else expect(ids, ctx).toContain(m.finalHypothesisRevision);
  }

  // time: no call starts at or after the deadline; the end is within the Run limit plus 30 seconds
  for (const c of calls) expect(c.at, ctx).toBeLessThan(deadlineAt);
  expect(w.time.t - startAt, ctx).toBeLessThanOrEqual(s.runSeconds * 1000 + SLACK_MS);
  if (reason === "time_limit_reached") expect(w.time.t, ctx).toBeGreaterThanOrEqual(deadlineAt);

  // after a limit, no further provider call and no closing revision
  const aiCalls = payloads(w, "ai_call");
  const lastKind = aiCalls[aiCalls.length - 1]?.requestKind;
  if (reason === "iteration_limit_reached") {
    expect(lastKind, ctx).toBe("experiment_generation");
    expect(payloads(w, "hypothesis_revision"), ctx).toHaveLength(s.iterations); // the generation and one revision per further Iteration, none after the last
  }
  if (reason === "experiment_limit_reached" || reason === "no_further_experiments") expect(lastKind, ctx).toBe("experiment_generation");
  if (reason === "provider_failure") {
    const rejected = payloads(w, "ai_rejected");
    expect(rejected[rejected.length - 1]?.attempt, ctx).toBe(s.retries + 1); // the retries are used up, never fewer, never more
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// generators
// ---------------------------------------------------------------------------------------------------------------------------------
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 5, arbitrary: fc.constant<Step>({ k: "ok" }) },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: SLACK_MS }).map((ms): Step => ({ k: "slow", ms })) },
  { weight: 3, arbitrary: fc.record({ reason: fc.constantFrom("error" as const, "timeout" as const), ms: fc.integer({ min: 0, max: SLACK_MS }) }).map((x): Step => ({ k: "fail", ...x })) },
  { weight: 2, arbitrary: fc.constant<Step>({ k: "garbage" }) },
  { weight: 2, arbitrary: fc.constant<Step>({ k: "empty" }) },
  { weight: 2, arbitrary: fc.constant<Step>({ k: "hang_call" }) },
  { weight: 1, arbitrary: fc.record({ extra: fc.integer({ min: 0, max: SLACK_MS }), down: fc.boolean() }).map((x): Step => ({ k: "hang_deadline", ...x })) },
  { weight: 1, arbitrary: fc.constant<Step>({ k: "violation" }) },
);

const scenarioArb: fc.Arbitrary<Scenario> = fc.record({
  iterations: fc.constantFrom(1 as const, 2 as const),
  experiments: fc.constantFrom(1, 20),
  retries: fc.integer({ min: 0, max: 3 }),
  callSeconds: fc.integer({ min: 1, max: 30 }),
  runSeconds: fc.integer({ min: 30, max: 300 }),
  script: fc.array(stepArb, { maxLength: 8 }),
  fault: fc.constantFrom<Fault>("none", "none", "none", "ai_call_down", "payload_audit_down"),
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the properties
// ---------------------------------------------------------------------------------------------------------------------------------
describe("Property 18: every Run terminates within bounds with exactly one reason (scripted provider, fake clock)", () => {
  it(
    "for any scripted provider behavior, limits and store fault: one reason, inside the bounds, and no call after a limit",
    async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArb, async (s) => {
          checkInvariants(await execute(s));
        }),
        { seed: SEED, numRuns: NUM_RUNS },
      );
    },
    TIMEOUT_MS,
  );

  it(
    "the same scenario run twice ends the same way: same reason, same sealed state, same record kinds, same provider calls",
    async () => {
      await fc.assert(
        fc.asyncProperty(scenarioArb, async (s) => {
          const a = await execute(s);
          const b = await execute(s);
          expect([reasonOf(b.r), b.r.sealed, kindsOf(b.w), b.calls.map((c) => c.kind), b.w.time.t]).toEqual([reasonOf(a.r), a.r.sealed, kindsOf(a.w), a.calls.map((c) => c.kind), a.w.time.t]);
        }),
        { seed: SEED + 1, numRuns: 10 },
      );
    },
    TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the cases that fix the contract (each one also passes the invariants above)
// ---------------------------------------------------------------------------------------------------------------------------------
async function run(s: Scenario, hooks: Hooks = {}): Promise<Outcome> {
  const x = await execute(s, hooks);
  checkInvariants(x);
  return x;
}
function expectSealed(x: Outcome, reason: string): void {
  expect(x.r.sealed).toBe(true);
  if (x.r.sealed) expect(x.r.summary.terminationReason).toBe(reason);
}
function expectUnsealed(x: Outcome, failure: string, reason: string): void {
  expect(x.r.sealed).toBe(false);
  if (x.r.sealed) return;
  expect([x.r.failure, x.r.terminationReason, x.r.started]).toEqual([failure, reason, true]);
}

describe("limits and the end of the loop", () => {
  it("control: no fault, two Iterations: iteration_limit_reached, four calls, no closing revision, sealed", async () => {
    const x = await run(base({ iterations: 2 }));
    expectSealed(x, "iteration_limit_reached");
    expect(x.calls.map((c) => c.kind)).toEqual(["hypothesis_generation", "experiment_generation", "hypothesis_revision", "experiment_generation"]);
    expect(manifestOf(x.w).finalHypothesisRevision).toBe("hyp-2");
  });

  it("the Experiment limit ends the Run before any revision, even with an Iteration left", async () => {
    const x = await run(base({ iterations: 2, experiments: 1 }));
    expectSealed(x, "experiment_limit_reached");
    expect(x.calls.map((c) => c.kind)).toEqual(["hypothesis_generation", "experiment_generation"]);
    expect(payloads(x.w, "experiment")).toHaveLength(1);
  });

  it("an accepted response with no Experiment ends the Run with no_further_experiments and makes no revision", async () => {
    const x = await run(base({ iterations: 2, script: [{ k: "ok" }, { k: "empty" }] }));
    expectSealed(x, "no_further_experiments");
    expect(x.calls.map((c) => c.kind)).toEqual(["hypothesis_generation", "experiment_generation"]);
    expect(payloads(x.w, "hypothesis_revision")).toHaveLength(1);
  });
});

describe("provider success and failure", () => {
  it("a failed attempt that is retried and then succeeds does not end the Run with provider_failure", async () => {
    const x = await run(base({ retries: 1, script: [{ k: "fail", reason: "error", ms: 0 }] }));
    expectSealed(x, "iteration_limit_reached");
    expect(x.calls.map((c) => c.kind)).toEqual(["hypothesis_generation", "hypothesis_generation", "experiment_generation"]);
    expect(payloads(x.w, "ai_rejected")).toHaveLength(1);
    expect(payloads(x.w, "payload_audit").filter((a) => a.requestKind === "hypothesis_generation").map((a) => a.attempt)).toEqual([1, 2]);
  });

  it("retries + 1 failed attempts end the Run with provider_failure; the last attempt number is retries + 1; nothing is called after", async () => {
    const fail: Step = { k: "fail", reason: "error", ms: 0 };
    const x = await run(base({ retries: 2, script: [fail, fail, fail, fail] }));
    expectSealed(x, "provider_failure");
    expect(x.calls).toHaveLength(3);
    expect(payloads(x.w, "ai_rejected").map((p) => p.attempt)).toEqual([1, 2, 3]);
    expect(manifestOf(x.w).finalHypothesisRevision).toBe("none");
  });

  it("per-call timeouts (the per-call timer fires) are failed calls under the retry limit and end with provider_failure", async () => {
    const x = await run(base({ retries: 1, callSeconds: 5, runSeconds: 60, script: [{ k: "hang_call" }, { k: "hang_call" }] }));
    expectSealed(x, "provider_failure");
    expect(x.calls).toHaveLength(2);
    expect(payloads(x.w, "ai_call").map((p) => [p.outcome, p.timeoutBy])).toEqual([["timeout", "orchestrator"], ["timeout", "orchestrator"]]);
    expect(x.w.time.t - x.startAt).toBe(10_000);
  });

  it("unparseable responses are failed calls under the retry limit and end with provider_failure", async () => {
    const x = await run(base({ retries: 1, script: [{ k: "garbage" }, { k: "garbage" }] }));
    expectSealed(x, "provider_failure");
    expect(x.calls).toHaveLength(2);
    expect(payloads(x.w, "ai_rejected").map((p) => [p.reason, p.source])).toEqual([["unparseable", "gate"], ["unparseable", "gate"]]);
  });
});

describe("the Run deadline", () => {
  it("the deadline timer fires during a call: the call is interrupted, the Run is sealed with time_limit_reached, one termination record", async () => {
    const x = await run(base({ script: [{ k: "hang_deadline", extra: 0, down: false }] }));
    expectSealed(x, "time_limit_reached");
    expect(x.calls).toHaveLength(1);
    expect(payloads(x.w, "ai_call").map((p) => p.outcome)).toEqual(["interrupted"]);
    expect(kindsOf(x.w).filter((k) => k === "termination")).toHaveLength(1);
    expect(x.w.time.t).toBe(x.deadlineAt);
  });

  it("the boundary is exact: a call that ends 1 ms before the deadline goes on; a call that ends AT the deadline stops the Run", async () => {
    // `fail` with ms: the fake clock moves during the call. retries 0, so an ordinary failure would end with provider_failure.
    const before = await run(base({ runSeconds: 30, script: [{ k: "fail", reason: "error", ms: 29_999 }] }));
    expectSealed(before, "provider_failure");
    const at = await run(base({ runSeconds: 30, script: [{ k: "fail", reason: "error", ms: 30_000 }] }));
    expectSealed(at, "time_limit_reached");
    expect(at.calls).toHaveLength(1);
  });

  it("a slow successful call that crosses the deadline stops the Run at the next check: time_limit_reached, no further call", async () => {
    const x = await run(base({ runSeconds: 30, script: [{ k: "slow", ms: 30_000 }] }));
    expectSealed(x, "time_limit_reached");
    expect(x.calls).toHaveLength(1);
  });
});

describe("priority and the race between abort and termination", () => {
  it("the deadline raised while a provider failure is being recorded wins: time_limit_reached, not provider_failure (the control gives provider_failure)", async () => {
    expect(rankOf("time_limit_reached")).toBeLessThan(rankOf("provider_failure"));
    const control = await run(base({ script: [{ k: "fail", reason: "error", ms: 0 }] }));
    expectSealed(control, "provider_failure");
    let gateCalls = 0;
    const raced = await run(base({ script: [{ k: "fail", reason: "error", ms: 0 }] }), {
      deps: (w, { deadlineAt }) => ({
        responseGate: {
          ...(w.deps.responseGate as Any),
          gateProviderResult: (...args: unknown[]): unknown => {
            const out = (w.deps.responseGate as Any).gateProviderResult(...args);
            gateCalls += 1;
            if (gateCalls === 1) fireDeadline(w, deadlineAt, 0); // the abort arrives after the gate has judged the call
            return out;
          },
        },
      }),
    });
    expect(gateCalls).toBe(1);
    expectSealed(raced, "time_limit_reached");
    expect(raced.calls).toHaveLength(1);
  });

  it("the deadline plus a store that went down ends unsealed with `error`, which outranks time_limit_reached; nothing is sealed", async () => {
    expect(rankOf("error")).toBeLessThan(rankOf("time_limit_reached"));
    const x = await run(base({ script: [{ k: "hang_deadline", extra: 0, down: true }] }));
    expectUnsealed(x, "store_failed", "error");
    expect(x.calls).toHaveLength(1);
  });

  it("an abort and timer fires during termination or after it change nothing: the reason, the records and the volume stay the same", async () => {
    const fireAll = (w: World, deadlineAt: number): void => {
      w.time.t = Math.max(w.time.t, deadlineAt + 5_000);
      for (const e of w.timers) e.fire();
    };
    let during = 0;
    const x = await run(base({ iterations: 2 }), {
      deps: (w, { deadlineAt }) => ({
        manifest: {
          build: (core: Any): unknown => {
            during += 1;
            fireAll(w, deadlineAt); // the reason is already finalized here
            return (w.deps.manifest as Any).build(core);
          },
        },
      }),
    });
    expect(during).toBe(1);
    expectSealed(x, "iteration_limit_reached");
    const before = volumeText(x.w.mem);
    fireAll(x.w, x.deadlineAt); // late fires after the Run has returned
    expect(volumeText(x.w.mem)).toBe(before);
    expect(kindsOf(x.w).filter((k) => k === "termination")).toHaveLength(1);
    expect(manifestOf(x.w).terminationReason).toBe("iteration_limit_reached");
  });
});

describe("audit failures", () => {
  it("a payload_audit record that cannot be written: no provider call, unsealed store_failed with `error` (the control is sealed with calls)", async () => {
    const control = await run(base());
    expectSealed(control, "iteration_limit_reached");
    expect(control.calls.length).toBeGreaterThan(0);
    const x = await run(base({ fault: "payload_audit_down" }));
    expectUnsealed(x, "store_failed", "error");
    expect(x.calls).toHaveLength(0);
    expect(x.w.providerCalls).toHaveLength(0);
  });

  it("an audit violation reported by the provider guard ends the Run with `error` at once: one call, no retry, whatever the retry limit", async () => {
    const x = await run(base({ retries: 2, script: [{ k: "violation" }] }));
    expect(reasonOf(x.r)).toBe("error");
    expect(x.calls).toHaveLength(1);
    expect(payloads(x.w, "ai_call")).toHaveLength(0);
    expect(payloads(x.w, "payload_audit")).toHaveLength(1);
  });

  it("a blocked audit (payload over 4 MiB) ends the Run with payload_audit_blocked: no provider call, no retry, no failed-call record, sealed", async () => {
    const sourceText = `<?php\n// synthetic large content\n${"x".repeat(4 * 1024 * 1024 + 1)}\n`;
    const x = await run(base({ retries: 2 }), { world: { sourceText } });
    expectSealed(x, "payload_audit_blocked");
    expect(x.calls).toHaveLength(0);
    expect(payloads(x.w, "payload_audit").map((p) => [p.result, p.attempt])).toEqual([["blocked", 1]]);
    expect(kindsOf(x.w)).not.toContain("ai_call");
    expect(kindsOf(x.w)).not.toContain("ai_rejected");
  });

  it("a failed ai_call write after a provider answer ends the Run with `error`, unsealed, with no further provider call", async () => {
    const x = await run(base({ iterations: 2, fault: "ai_call_down" }));
    expectUnsealed(x, "store_failed", "error");
    expect(x.calls).toHaveLength(1);
  });
});