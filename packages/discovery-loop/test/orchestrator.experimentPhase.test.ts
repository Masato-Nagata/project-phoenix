// Task 4.4, unit U6b: the experiment phase (`src/orchestrator/experimentPhase.ts`). Deterministic and offline: the REAL RunSession, the REAL
// `callProvider` (U5), the REAL EvidenceStore and the REAL id counters, on a fixed monotonic clock, with in-memory fakes of the writer, the audit port,
// the provider, the response gate, the policy, the runner, the comparator and the lease. Nothing waits on real time; all data is synthetic.
// **Validates: Requirements 6.7, 7.2, 7.4, 7.8, 8.11, 10.8, 11.7, 11.9, 11.14, 12.14, 22.2**
import { describe, expect, it } from "vitest";
import { EvidenceStore } from "../src/model/evidenceStore.js";
import * as phaseModule from "../src/orchestrator/experimentPhase.js";
import {
  EXPERIMENT_ERROR_CAUSES,
  EXPERIMENT_ERROR_CODES,
  EXPERIMENT_ERROR_PHASES,
  EXPERIMENT_INVALID_CODES,
  runExperimentPhase,
} from "../src/orchestrator/experimentPhase.js";
import { createIdCounters } from "../src/orchestrator/ids.js";
import { RECORDS_UNAVAILABLE_MESSAGE } from "../src/orchestrator/providerCall.js";
import type { RecordWriter } from "../src/orchestrator/recordWriter.js";
import { createRunSession } from "../src/orchestrator/session.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const SHA = "a".repeat(64);
const MSG_SECRET = "MSG_SECRET_sk-live-0123456789";
const PATH_SECRET = "/home/SECRET_PATH_user/project/file.txt";
const APPROVAL_MARKER = "APPROVAL_MARKER_xyz";
const AI_MARKER = "AI_STRING_MARKER_" + "z".repeat(40);
const CLAIM_REV = "clm-0001-r1";
const ITER = 1;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---------------------------------------------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------------------------------------------
const CLAIM_TARGET = { kind: "claim", id: "clm-0001" };
const HYP_TARGET = { kind: "hypothesis", id: "hyp-1" };
function exp(key: string, target: Loose = CLAIM_TARGET, over: Loose = {}): Loose {
  return {
    localKey: key,
    target,
    requests: [{ method: "GET", path: "/items" }],
    prediction: { target: { list: "requests", index: 0 }, status: 200, fields: [{ path: "a", value: 1 }] },
    ...over,
  };
}
const observation = (id: string, outcome: string, extra: Loose = {}): Loose => ({
  experimentId: id,
  outcome,
  preparation: [],
  responses: [{ status: 200, bodyKind: "json", body: { a: 1 } }],
  stateChecks: [],
  maskSha256: SHA,
  ...extra,
});
const executedOutcome = (id: string): Loose => ({ status: "executed", observation: observation(id, "executed"), preparationLog: [] });
const timedOut = (detail?: string) => (id: string): Loose => ({ status: "timed_out", ...(detail === undefined ? {} : { detail }), observation: observation(id, "timed_out") });
const notExecuted = (reason: string, extra: Loose = {}) => (id: string): Loose => ({
  status: "not_executed",
  reason,
  ...extra,
  observation: observation(id, "not_executed", { notExecuted: { reason } }),
});
const aborted = (reason: string, extra: Loose = {}) => (id: string): Loose => ({ status: "aborted", reason, ...extra, observation: observation(id, "aborted", { abortReason: reason }) });
const interrupted = (cause: string, phase: string, extra: Loose = {}) => (id: string): Loose => ({
  status: "interrupted",
  cause,
  experimentId: id,
  phase,
  sentRequests: 0,
  collectedResponses: 0,
  collectedStateChecks: 0,
  ...extra,
});

type OutcomeFn = (id: string, ctx: Loose) => Loose;

// ---------------------------------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------------------------------
interface Opts {
  readonly retries?: number;
  readonly experiments?: Loose[];
  readonly rejected?: Loose[];
  readonly gate?: "fail";
  readonly limits?: { experiments?: number; rejectedExperiments?: number };
  readonly policy?: (n: number, e: Loose) => Loose; // "accept" | "reject" | "throw" | a payload object
  readonly runner?: OutcomeFn[]; // per execute call; the last repeats
  readonly runnerThrows?: boolean;
  readonly runnerReturns?: unknown;
  readonly compare?: (prediction: Loose, observation: Loose, mask: Loose) => Loose;
  readonly failAt?: (key: string, nth: number) => string | undefined;
  readonly lease?: () => Loose;
  readonly setup?: (ctx: { session: ReturnType<typeof makeSession>; clock: { t: number } }) => void;
  readonly hypothesis?: Loose;
  readonly drainThrows?: boolean;
}

function makeSession(clock: { t: number; nowMs(): number }) {
  const made = createRunSession({ clock, runSeconds: 3600 });
  if (!made.ok) throw new Error("setup failed");
  return made.value;
}

function harness(o: Opts = {}) {
  const log: string[] = [];
  const clock = { t: 1_000, nowMs(): number { return this.t; } };
  const session = makeSession(clock);
  const store = new EvidenceStore();
  const ids = createIdCounters();
  const made = store.createClaimRevision({ claimId: "clm-0001", reason: "initial", aiClaim: { confidence: "low" }, aiOutputRecordId: "rec-000900" });
  if (!made.ok) throw new Error("setup failed");
  o.setup?.({ session, clock });

  const recs: { id: string; kind: string; payload: Loose }[] = [];
  const counts = new Map<string, number>();
  let seq = 0;
  const nextId = (): string => `rec-${String(++seq).padStart(6, "0")}`;
  let drained = true;
  const writer = {
    append: async (kind: string, payload: Loose): Promise<Loose> => {
      log.push(`append:${kind}`);
      const n = (counts.get(kind) ?? 0) + 1;
      counts.set(kind, n);
      const c = o.failAt?.(kind, n);
      if (c !== undefined) return { ok: false, error: { code: c } };
      const r = { id: nextId(), kind, payload: JSON.parse(JSON.stringify(payload)) };
      recs.push(r);
      drained = false;
      return { ok: true, value: { id: r.id, kind } };
    },
    putBlob: async (data: Uint8Array): Promise<Loose> => ({ ok: true, value: { blob: "blob-1", bytes: data.length } }),
    putAiOutput: async (data: Uint8Array): Promise<Loose> => {
      const r = { id: nextId(), kind: "ai_output", payload: {} };
      recs.push(r);
      return { ok: true, value: { record: { id: r.id }, blob: { blob: `out-${recs.length}`, bytes: data.length } } };
    },
    drain: async (): Promise<void> => {
      log.push("drain");
      if (o.drainThrows === true && (counts.get("policy_decision") ?? 0) > 0) throw new Error(MSG_SECRET);
      await Promise.resolve();
      await Promise.resolve();
      drained = true;
    },
    state: () => ({ down: false, sealed: false, terminationWritten: false, secretRejections: 0 }),
    records: (): Loose => ({ ok: true, value: Object.freeze(recs.map((r) => Object.freeze({ id: r.id, kind: r.kind, payload: r.payload }))) }),
  } as Loose as RecordWriter;

  const completeCalls: Loose[] = [];
  const audit = {
    prepareAudit: (): Loose => ({ ok: true, value: { bytes: new Uint8Array([1, 2, 3]), ctx: { handle: true } } }),
    auditPayload: (): Loose => ({
      audit: { result: "pass", payloadSha256: SHA, bytesWithheld: false, auditedBytes: new Uint8Array([1, 2, 3]), checks: [{ id: "A01", outcome: "pass" }], matches: [] },
      request: { req: completeCalls.length + 1 },
    }),
  };
  const provider = {
    identity: { id: "mock", version: "1", model: "not_applicable" },
    complete(req: Loose): Loose {
      log.push("complete");
      completeCalls.push(req);
      return Promise.resolve({ ok: true, value: enc("{}") });
    },
  };
  const responseGate = {
    gateProviderResult(k: string): Loose {
      if (o.gate === "fail") {
        return {
          kind: "failed_call",
          reason: "unparseable",
          retryable: true,
          source: "gate",
          gate: { reason: "invalid_json", issues: [{ code: "invalid_json", path: "" }], toolCallLike: false, sha256: SHA, byteLength: 7 },
          toolCall: false,
        };
      }
      return {
        kind: "accepted",
        result: { ok: true, kind: k, sha256: SHA, byteLength: 7, experiments: o.experiments ?? [exp("alpha")], rejectedExperiments: o.rejected ?? [] },
      };
    },
    gateResponse: (): Loose => undefined,
    resolveResponseLimits: (): Loose => ({ ok: true, value: {} }),
  };

  const policyCalls: Loose[] = [];
  const policy = {
    evaluateForRecord(e: Loose, cfg: Loose): Loose {
      policyCalls.push({ e, cfg });
      log.push("evaluate");
      const d = o.policy !== undefined ? o.policy(policyCalls.length, e) : "accept";
      if (d === "throw") throw new Error(MSG_SECRET);
      if (typeof d === "object") return d;
      return {
        experimentId: e.experimentId,
        decision: d,
        ruleIds: d === "accept" ? [] : ["POL-001"],
        experimentSha256: SHA,
        policyConfigSha256: SHA,
        preparationTableSha256: SHA,
      };
    },
  };

  const runnerCalls: Loose[] = [];
  const runner = {
    async execute(e: Loose, decisionRecordId: string, signal: AbortSignal, options: Loose): Promise<Loose> {
      log.push("execute");
      runnerCalls.push({
        e,
        decisionRecordId,
        signal,
        options,
        kindsAtCall: recs.map((r) => r.kind),
        decisionVisible: recs.some((r) => r.id === decisionRecordId && r.kind === "policy_decision" && r.payload.experimentId === e.experimentId),
        drainedAtCall: drained,
      });
      if (o.runnerThrows === true) throw new Error(MSG_SECRET);
      if ("runnerReturns" in o) return o.runnerReturns;
      const script = o.runner ?? [executedOutcome];
      const fn = script[Math.min(runnerCalls.length - 1, script.length - 1)] as OutcomeFn;
      return fn(e.experimentId, { session, clock });
    },
  };

  const compareCalls: Loose[] = [];
  const comparator = {
    compare(prediction: Loose, obs: Loose, mask: Loose): Loose {
      compareCalls.push({ prediction, obs, mask });
      if (o.compare !== undefined) return o.compare(prediction, obs, mask);
      if (obs.outcome !== "executed") return { experimentId: obs.experimentId, result: "not_comparable", reason: obs.outcome, differences: [], maskSha256: SHA };
      return { experimentId: obs.experimentId, result: "match", differences: [], maskSha256: SHA };
    },
  };

  let leaseCalls = 0;
  const leasePort = {
    approvalLike: { approved: true, token: APPROVAL_MARKER },
    check: async (): Promise<Loose> => {
      leaseCalls += 1;
      return o.lease !== undefined ? o.lease() : { valid: true };
    },
  };
  const timers = { schedule: (): Loose => ({ cancel: (): void => undefined }) };

  const input = {
    session,
    writer,
    clock,
    timers,
    provider,
    audit,
    auditConfig: { cfg: true },
    responseGate,
    responseLimits: { lim: 1 },
    validator: { v: 1 },
    evidenceStore: store,
    ids,
    leasePort,
    bundle: { b: 1 },
    templateId: "tpl-1",
    stored: [],
    limits: { providerCallSeconds: 30, providerRetries: o.retries ?? 0, experiments: o.limits?.experiments ?? 10, rejectedExperiments: o.limits?.rejectedExperiments ?? 10 },
    iteration: ITER,
    hypothesis: o.hypothesis ?? { hypothesisId: "hyp-1", claims: [{ claimId: "clm-0001", claimRevisionId: CLAIM_REV, revision: 1 }] },
    policy,
    policyConfig: { cfg: "policy" },
    runner,
    comparator,
    mask: { mask: "cfg" },
  } as Loose;

  return {
    session,
    clock,
    store,
    ids,
    log,
    recs,
    completeCalls,
    policyCalls,
    runnerCalls,
    compareCalls,
    leaseCalls: () => leaseCalls,
    run: (): Promise<Loose> => runExperimentPhase(input),
    of: (k: string) => recs.filter((r) => r.kind === k),
    kinds: () => recs.map((r) => r.kind),
    status: () => session.terminationStatus(),
  };
}
type H = ReturnType<typeof harness>;
const afterCall = (h: H): string[] => {
  const kinds = h.kinds();
  return kinds.slice(kinds.lastIndexOf("ai_call") + 1);
};
const reasonOf = (h: H): string | undefined => {
  const s = h.status() as Loose;
  return s.state === "none" ? undefined : s.reason;
};

// ---------------------------------------------------------------------------------------------------------------------------------
describe("generation and individual validation", () => {
  it("makes one provider call and writes experiment, policy_decision, observation, comparison and evidence for one claim Experiment", async () => {
    const h = harness();
    const r = await h.run();
    expect(h.completeCalls).toHaveLength(1);
    expect(afterCall(h)).toEqual(["experiment", "policy_decision", "observation", "comparison", "evidence"]);
    expect(r.kind).toBe("completed");
    expect(r.acceptedInPhase).toBe(1);
    expect(r.rejectedInPhase).toBe(0);
    expect(h.status().state).toBe("none");
  });

  it("the experiment record has the decided payload and the normalized Experiment has no localKey but the experimentId", async () => {
    const h = harness({ experiments: [exp("alpha")] });
    await h.run();
    const rec = h.of("experiment")[0] as Loose;
    expect(rec.payload).toEqual({
      experimentId: "exp-1-1",
      iteration: ITER,
      localKey: "alpha",
      target: CLAIM_TARGET,
      testedClaimRevisionId: CLAIM_REV,
      experiment: exp("alpha"),
    });
    const normalized = h.policyCalls[0].e;
    expect(normalized.localKey).toBeUndefined();
    expect(normalized.experimentId).toBe("exp-1-1");
    expect(normalized.requests).toEqual(exp("alpha").requests);
    expect(h.policyCalls[0].cfg).toEqual({ cfg: "policy" });
    expect(h.runnerCalls[0].e).toEqual(normalized);
  });

  it("a hypothesis target resolves to the current hypothesisId, has no testedClaimRevisionId and creates no per-Claim Evidence", async () => {
    const h = harness({ experiments: [exp("alpha", HYP_TARGET)] });
    const r = await h.run();
    const payload = (h.of("experiment")[0] as Loose).payload;
    expect("testedClaimRevisionId" in payload).toBe(false);
    expect(h.of("evidence")).toHaveLength(0);
    expect(afterCall(h)).toEqual(["experiment", "policy_decision", "observation", "comparison"]);
    expect(r.evidenceIdsForRevision).toEqual([]);
    expect(h.store.experimentStatusOf(CLAIM_REV)).toEqual({ ok: true, value: "absent" });
  });

  it("a gate-rejected Experiment is an experiment_invalid record with its original index, not a failed provider call", async () => {
    const h = harness({
      experiments: [exp("alpha"), exp("gamma")],
      rejected: [{ index: 1, issues: [{ code: "bad_value", path: "/requests/0/path" }, { code: AI_MARKER, path: `/${AI_MARKER}/x` }] }],
    });
    const r = await h.run();
    const inv = h.of("experiment_invalid");
    expect(inv).toHaveLength(1);
    expect((inv[0] as Loose).payload).toEqual({
      requestKind: "experiment_generation",
      aiOutputRecordId: (h.of("ai_output")[0] as Loose).id,
      index: 1,
      issues: [
        { code: "bad_value", path: "/requests/0/path" },
        { code: "invalid", path: "/<key>/x" },
      ],
    });
    expect(h.completeCalls).toHaveLength(1);
    expect(h.session.providerRetryCount).toBe(0);
    expect(h.of("ai_rejected")).toHaveLength(0);
    expect(r.acceptedInPhase).toBe(2);
    expect(JSON.stringify(h.recs)).not.toContain(AI_MARKER);
  });

  it("an unknown claim id and an unknown hypothesis id are experiment_invalid with unknown_target; the AI id is not recorded; no id is spent", async () => {
    const h = harness({ experiments: [exp("a1", { kind: "claim", id: "clm-0099" }), exp("a2", { kind: "hypothesis", id: AI_MARKER }), exp("a3")] });
    const r = await h.run();
    const inv = h.of("experiment_invalid").map((x) => (x as Loose).payload);
    expect(inv.map((p: Loose) => [p.index, p.issues])).toEqual([
      [0, [{ code: "unknown_target", path: "/target/id" }]],
      [1, [{ code: "unknown_target", path: "/target/id" }]],
    ]);
    expect(JSON.stringify(h.recs)).not.toContain(AI_MARKER);
    expect(h.policyCalls).toHaveLength(1);
    expect(h.runnerCalls).toHaveLength(1);
    expect((h.of("experiment")[0] as Loose).payload.experimentId).toBe("exp-1-1");
    expect(r.acceptedInPhase).toBe(1);
    expect(h.session.policyRejectionCount).toBe(0);
  });

  it("a repeated localKey within the response is experiment_invalid with duplicate_local_key; the first stays", async () => {
    const h = harness({ experiments: [exp("same"), exp("same")] });
    await h.run();
    const inv = h.of("experiment_invalid").map((x) => (x as Loose).payload);
    expect(inv).toHaveLength(1);
    expect(inv[0].index).toBe(1);
    expect(inv[0].issues).toEqual([{ code: "duplicate_local_key", path: "/localKey" }]);
    expect(h.runnerCalls).toHaveLength(1);
  });

  it("an inconsistent gate-rejected index raises error without a record", async () => {
    const h = harness({ experiments: [exp("a")], rejected: [{ index: 7, issues: [] }] });
    const r = await h.run();
    expect(r.kind).toBe("stopped");
    expect(reasonOf(h)).toBe("error");
    expect(h.runnerCalls).toHaveLength(0);
  });

  it("a failed provider call (retries exhausted) ends with provider_failure and no record of this phase", async () => {
    const h = harness({ gate: "fail" });
    const r = await h.run();
    expect(r.kind).toBe("stopped");
    expect(reasonOf(h)).toBe("provider_failure");
    expect(h.policyCalls).toHaveLength(0);
    expect(h.kinds()).not.toContain("experiment");
  });

  it("invalid inputs (iteration, limits, hypothesis) raise error before any provider call", async () => {
    for (const bad of [{ hypothesis: { hypothesisId: "", claims: [] } }, { limits: { experiments: 0 } }]) {
      const h = harness(bad as Opts);
      const r = await h.run();
      expect([r.kind, reasonOf(h), h.completeCalls.length]).toEqual(["stopped", "error", 0]);
    }
  });
});

describe("policy and runner order", () => {
  it("the runner is called only after the policy_decision record is committed and drained, with the signal, notAfterMs and the decision id", async () => {
    const h = harness();
    await h.run();
    const call = h.runnerCalls[0];
    expect(call.decisionVisible).toBe(true);
    expect(call.drainedAtCall).toBe(true);
    expect(call.kindsAtCall.slice(-2)).toEqual(["experiment", "policy_decision"]);
    const i = h.log.indexOf("append:policy_decision");
    expect(i).toBeGreaterThan(h.log.indexOf("evaluate"));
    const d = h.log.indexOf("drain", i);
    expect(d).toBeGreaterThan(i);
    expect(h.log.indexOf("execute")).toBeGreaterThan(d);
    expect(call.signal).toBe(h.session.signal);
    expect(call.options).toEqual({ notAfterMs: h.session.deadlineAtMs });
    expect(call.decisionRecordId).toBe((h.of("policy_decision")[0] as Loose).id);
  });

  it("the policy_decision payload is the evaluateForRecord payload exactly", async () => {
    const h = harness();
    await h.run();
    expect((h.of("policy_decision")[0] as Loose).payload).toEqual({
      experimentId: "exp-1-1",
      decision: "accept",
      ruleIds: [],
      experimentSha256: SHA,
      policyConfigSha256: SHA,
      preparationTableSha256: SHA,
    });
  });

  it("a policy_decision write failure raises error and the runner is never called", async () => {
    const h = harness({ failAt: (k) => (k === "policy_decision" ? "io_failure" : undefined) });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.runnerCalls.length]).toEqual(["stopped", "error", 0]);
    expect(h.session.experimentCount).toBe(0);
  });

  it("a drain that throws raises error and the runner is never called", async () => {
    const h = harness({ drainThrows: true });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.runnerCalls.length]).toEqual(["stopped", "error", 0]);
    expect(JSON.stringify(h.recs)).not.toContain(MSG_SECRET);
  });

  it("an experiment write failure raises error and the policy is never evaluated", async () => {
    const h = harness({ failAt: (k) => (k === "experiment" ? "io_failure" : undefined) });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.policyCalls.length, h.runnerCalls.length]).toEqual(["stopped", "error", 0, 0]);
  });

  it("a policy that throws, or returns a malformed or foreign payload, raises error and the runner is not called", async () => {
    for (const policy of [() => "throw", () => ({ experimentId: "other", decision: "accept" }), () => ({ experimentId: "exp-1-1", decision: "maybe" })]) {
      const h = harness({ policy });
      const r = await h.run();
      expect([r.kind, reasonOf(h), h.runnerCalls.length, h.of("policy_decision").length]).toEqual(["stopped", "error", 0, 0]);
    }
  });

  it("accept counts the Experiment before execution; reject counts a rejection, writes the decision and does not execute", async () => {
    const h = harness({ experiments: [exp("a"), exp("b")], policy: (n) => (n === 1 ? "reject" : "accept") });
    const r = await h.run();
    expect(h.of("policy_decision").map((x) => (x as Loose).payload.decision)).toEqual(["reject", "accept"]);
    expect(h.runnerCalls).toHaveLength(1);
    expect(h.runnerCalls[0].e.experimentId).toBe("exp-1-2");
    expect([h.session.experimentCount, h.session.policyRejectionCount]).toEqual([1, 1]);
    expect([r.kind, r.acceptedInPhase, r.rejectedInPhase]).toEqual(["completed", 1, 1]);
  });
});

describe("limits and the end of the phase", () => {
  it("the Experiment limit mid-response: later valid Experiments are dropped without policy or runner, then experiment_limit_reached", async () => {
    const h = harness({ experiments: [exp("a"), exp("b"), exp("c")], limits: { experiments: 1 } });
    const r = await h.run();
    expect(h.of("experiment_dropped").map((x) => (x as Loose).payload)).toEqual([{ reason: "experiment_limit" }, { reason: "experiment_limit" }]);
    expect(h.policyCalls).toHaveLength(1);
    expect(h.runnerCalls).toHaveLength(1);
    expect(h.of("experiment")).toHaveLength(1);
    expect([r.kind, r.reason, reasonOf(h)]).toEqual(["limit", "experiment_limit_reached", "experiment_limit_reached"]);
    expect(h.session.signal.aborted).toBe(false);
  });

  it("the Experiment limit reached before the call drops every valid Experiment", async () => {
    const h = harness({ experiments: [exp("a"), exp("b")], limits: { experiments: 1 }, setup: ({ session }) => session.noteAcceptedExperiment() });
    const r = await h.run();
    expect(h.of("experiment_dropped")).toHaveLength(2);
    expect([h.policyCalls.length, h.runnerCalls.length, h.of("experiment").length]).toEqual([0, 0, 0]);
    expect([r.kind, r.reason, reasonOf(h)]).toEqual(["limit", "experiment_limit_reached", "experiment_limit_reached"]);
  });

  it("a drop write failure raises error", async () => {
    const h = harness({ experiments: [exp("a")], limits: { experiments: 1 }, setup: ({ session }) => session.noteAcceptedExperiment(), failAt: (k) => (k === "experiment_dropped" ? "io_failure" : undefined) });
    const r = await h.run();
    expect([r.kind, reasonOf(h)]).toEqual(["stopped", "error"]);
  });

  it("the rejected-Experiment limit stops with policy_rejection_limit when it is reached (>=), and later Experiments are not evaluated", async () => {
    const h = harness({ experiments: [exp("a"), exp("b"), exp("c")], limits: { rejectedExperiments: 2 }, policy: () => "reject" });
    const r = await h.run();
    expect(h.policyCalls).toHaveLength(2);
    expect(h.runnerCalls).toHaveLength(0);
    expect([r.kind, r.reason, reasonOf(h), r.rejectedInPhase]).toEqual(["limit", "policy_rejection_limit", "policy_rejection_limit", 2]);
  });

  it("a rejection count that is one below the limit goes on, and the cumulative session count is used", async () => {
    const h = harness({ experiments: [exp("a")], limits: { rejectedExperiments: 2 }, policy: () => "reject", setup: ({ session }) => session.noteRejectedExperiment() });
    const r = await h.run();
    expect([r.reason, reasonOf(h)]).toEqual(["policy_rejection_limit", "policy_rejection_limit"]);
    const h2 = harness({ experiments: [exp("a")], limits: { rejectedExperiments: 3 }, policy: () => "reject", setup: ({ session }) => session.noteRejectedExperiment() });
    const r2 = await h2.run();
    expect([r2.reason, reasonOf(h2)]).toEqual(["no_further_experiments", "no_further_experiments"]);
  });

  it("no_further_experiments: an empty list, all invalid, all rejected below the limit", async () => {
    const empty = harness({ experiments: [] });
    const r1 = await empty.run();
    expect([r1.kind, r1.reason, reasonOf(empty)]).toEqual(["limit", "no_further_experiments", "no_further_experiments"]);

    const invalid = harness({ experiments: [exp("a", { kind: "claim", id: "clm-0099" })], rejected: [{ index: 1, issues: [{ code: "bad_type", path: "" }] }] });
    const r2 = await invalid.run();
    expect([r2.reason, reasonOf(invalid), invalid.of("experiment_invalid").length, invalid.policyCalls.length]).toEqual(["no_further_experiments", "no_further_experiments", 2, 0]);

    const rejected = harness({ experiments: [exp("a"), exp("b")], policy: () => "reject" });
    const r3 = await rejected.run();
    expect([r3.reason, reasonOf(rejected), r3.rejectedInPhase, r3.acceptedInPhase]).toEqual(["no_further_experiments", "no_further_experiments", 2, 0]);
  });

  it("the experiment limit takes effect at the NEXT Experiment, not after the last accepted one", async () => {
    const h = harness({ experiments: [exp("a")], limits: { experiments: 1 } });
    const r = await h.run();
    expect([r.kind, h.status().state]).toEqual(["completed", "none"]);
  });
});

describe("outcomes: executed", () => {
  it("match, mismatch and not_comparable map to supports, contradicts and inconclusive, with consistent record ids", async () => {
    const results = ["match", "mismatch", "not_comparable"] as const;
    const expected = { match: "supports", mismatch: "contradicts", not_comparable: "inconclusive" } as const;
    for (const result of results) {
      const h = harness({
        compare: (_p, obs) => ({
          experimentId: obs.experimentId,
          result,
          ...(result === "not_comparable" ? { reason: "prediction_missing" } : {}),
          differences: result === "mismatch" ? [{ path: "a", predicted: 1, observed: 2 }] : [],
          maskSha256: SHA,
        }),
      });
      const r = await h.run();
      const ev = (h.of("evidence")[0] as Loose).payload;
      expect(ev).toEqual({
        evidenceId: "evd-1",
        kind: "experiment",
        claimRevisionId: CLAIM_REV,
        outcome: expected[result],
        experimentId: "exp-1-1",
        comparisonRecordId: (h.of("comparison")[0] as Loose).id,
        observationRecordId: (h.of("observation")[0] as Loose).id,
        predictionRecordId: (h.of("experiment")[0] as Loose).id,
      });
      expect(r.executed[0].comparisonResult).toBe(result);
      expect(h.store.evidenceOf(CLAIM_REV, "experiment")).toMatchObject({ ok: true });
      expect(h.status().state).toBe("none");
    }
  });

  it("the Evidence in the store has the status derived from the outcome", async () => {
    const h = harness();
    await h.run();
    expect(h.store.experimentStatusOf(CLAIM_REV)).toEqual({ ok: true, value: "supported" });
    const h2 = harness({ compare: (_p, obs) => ({ experimentId: obs.experimentId, result: "mismatch", differences: [], maskSha256: SHA }) });
    await h2.run();
    expect(h2.store.experimentStatusOf(CLAIM_REV)).toEqual({ ok: true, value: "contradicted" });
  });

  it("the comparator receives the prediction of the Experiment, the observation as returned and the mask", async () => {
    const h = harness();
    await h.run();
    expect(h.compareCalls[0].prediction).toEqual(exp("alpha").prediction);
    expect(h.compareCalls[0].obs.experimentId).toBe("exp-1-1");
    expect(h.compareCalls[0].mask).toEqual({ mask: "cfg" });
  });

  it("the observation and comparison records are JSON copies, and the result shape is pinned", async () => {
    const h = harness({ experiments: [exp("a"), exp("b", HYP_TARGET)] });
    const r = await h.run();
    expect((h.of("observation")[0] as Loose).payload).toEqual(observation("exp-1-1", "executed"));
    expect((h.of("comparison")[0] as Loose).payload).toEqual({ experimentId: "exp-1-1", result: "match", differences: [], maskSha256: SHA });
    expect(r.kind).toBe("completed");
    expect(r.executed.map((x: Loose) => [x.experimentId, x.evidenceIds, x.comparisonResult])).toEqual([
      ["exp-1-1", ["evd-1"], "match"],
      ["exp-1-2", [], "match"],
    ]);
    expect(r.evidenceIdsForRevision).toEqual(["evd-1"]);
    const e0 = h.of("experiment")[0] as Loose;
    const o0 = h.of("observation")[0] as Loose;
    const c0 = h.of("comparison")[0] as Loose;
    expect(r.storedRefsForRevision.slice(0, 3)).toEqual([
      { partId: "exp-1-1-experiment", type: "experiment", recordId: e0.id },
      { partId: "exp-1-1-observation", type: "observation", recordId: o0.id },
      { partId: "exp-1-1-comparison", type: "comparison", recordId: c0.id },
    ]);
    expect(new Set(r.storedRefsForRevision.map((x: Loose) => x.partId)).size).toBe(6);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("a comparator that throws, returns a malformed result or a foreign id raises error", async () => {
    for (const compare of [
      () => {
        throw new Error(MSG_SECRET);
      },
      () => ({ experimentId: "exp-1-1", result: "maybe", differences: [], maskSha256: SHA }),
      () => ({ experimentId: "other", result: "match", differences: [], maskSha256: SHA }),
      () => ({ experimentId: "exp-1-1", result: "match", differences: [] }),
    ]) {
      const h = harness({ compare });
      const r = await h.run();
      expect([r.kind, reasonOf(h), h.of("comparison").length, h.of("evidence").length]).toEqual(["stopped", "error", 0, 0]);
    }
  });

  it("a runner that throws, or returns an odd outcome or an observation of another Experiment, raises error", async () => {
    for (const o of [{ runnerThrows: true }, { runnerReturns: "x" }, { runnerReturns: { status: "executed", observation: observation("other", "executed") } }, { runnerReturns: { status: "executed", observation: observation("exp-1-1", "timed_out") } }]) {
      const h = harness(o as Opts);
      const r = await h.run();
      expect([r.kind, reasonOf(h), h.of("evidence").length]).toEqual(["stopped", "error", 0]);
      expect(JSON.stringify(h.recs)).not.toContain(MSG_SECRET);
    }
  });
});

describe("outcomes: timed_out, aborted, not_executed", () => {
  it("timed_out with transport_error: not_comparable comparison, inconclusive Evidence, an error record, and the Run goes on", async () => {
    const h = harness({ experiments: [exp("a"), exp("b")], runner: [timedOut("transport_error"), executedOutcome] });
    const r = await h.run();
    expect(h.runnerCalls).toHaveLength(2);
    expect((h.of("comparison")[0] as Loose).payload.reason).toBe("timed_out");
    expect((h.of("evidence")[0] as Loose).payload.outcome).toBe("inconclusive");
    expect((h.of("error")[0] as Loose).payload).toEqual({ code: "transport_error", experimentId: "exp-1-1", phase: "execute", cause: "transport_error" });
    expect(h.of("error")).toHaveLength(1);
    expect([r.kind, h.status().state]).toEqual(["completed", "none"]);
    expect(h.store.experimentStatusOf(CLAIM_REV)).toEqual({ ok: true, value: "supported" });
  });

  it("timed_out with transport_error and a failed error write: no further Experiment, Run ends with error", async () => {
    const h = harness({ experiments: [exp("a"), exp("b")], runner: [timedOut("transport_error")], failAt: (k) => (k === "error" ? "io_failure" : undefined) });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.runnerCalls.length]).toEqual(["stopped", "error", 1]);
  });

  it("timed_out with another detail, and a non-fatal not_executed, go on without an error record", async () => {
    const h = harness({ experiments: [exp("a"), exp("b"), exp("c")], runner: [timedOut("request_time_limit"), notExecuted("preparation_failed", { detail: MSG_SECRET }), notExecuted("timeout_before_requests")] });
    const r = await h.run();
    expect(h.runnerCalls).toHaveLength(3);
    expect(h.of("error")).toHaveLength(0);
    expect(h.of("evidence").map((x) => (x as Loose).payload.outcome)).toEqual(["inconclusive", "inconclusive", "inconclusive"]);
    expect(h.of("comparison").map((x) => (x as Loose).payload.reason)).toEqual(["timed_out", "not_executed", "not_executed"]);
    expect([r.kind, h.status().state]).toEqual(["completed", "none"]);
    expect(JSON.stringify(h.recs)).not.toContain(MSG_SECRET);
  });

  it("run_time_limit (timed_out or not_executed) raises time_limit_reached, not an error, records the outcome and stops", async () => {
    for (const outcome of [timedOut("run_time_limit"), notExecuted("timeout_before_requests", { detail: "run_time_limit" }), notExecuted("preparation_failed", { detail: "run_time_limit" })]) {
      const h = harness({ experiments: [exp("a"), exp("b")], runner: [outcome] });
      const r = await h.run();
      expect([r.kind, reasonOf(h), h.runnerCalls.length, h.of("error").length]).toEqual(["stopped", "time_limit_reached", 1, 0]);
      expect(h.of("observation")).toHaveLength(1);
      expect(h.of("comparison")).toHaveLength(1);
      expect((h.of("evidence")[0] as Loose).payload.outcome).toBe("inconclusive");
    }
  });

  it("a lease hint raises lease_unavailable or launcher_killed and stops", async () => {
    const cases: [OutcomeFn, string][] = [
      [aborted("lease_unavailable", { leaseReason: "revoked", terminationReason: "lease_unavailable" }), "lease_unavailable"],
      [aborted("lease_unavailable", { leaseReason: "heartbeat_stale", terminationReason: "launcher_killed" }), "launcher_killed"],
      [aborted("lease_unavailable"), "lease_unavailable"],
      [notExecuted("lease_unavailable", { leaseReason: "heartbeat_stale", terminationReason: "launcher_killed" }), "launcher_killed"],
      [notExecuted("lease_unavailable", { leaseReason: "missing", terminationReason: "lease_unavailable" }), "lease_unavailable"],
    ];
    for (const [outcome, reason] of cases) {
      const h = harness({ experiments: [exp("a"), exp("b")], runner: [outcome] });
      const r = await h.run();
      expect([r.kind, reasonOf(h), h.runnerCalls.length, h.of("error").length]).toEqual(["stopped", reason, 1, 0]);
      expect((h.of("comparison")[0] as Loose).payload.result).toBe("not_comparable");
    }
  });

  it("aborted address_not_allowed: not_comparable path, inconclusive Evidence, an error record, error, and no later Experiment", async () => {
    const h = harness({ experiments: [exp("a"), exp("b")], runner: [aborted("address_not_allowed")] });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.runnerCalls.length]).toEqual(["stopped", "error", 1]);
    expect((h.of("comparison")[0] as Loose).payload).toMatchObject({ result: "not_comparable", reason: "aborted" });
    expect((h.of("evidence")[0] as Loose).payload.outcome).toBe("inconclusive");
    expect((h.of("error")[0] as Loose).payload).toEqual({ code: "address_not_allowed", experimentId: "exp-1-1", phase: "execute", cause: "address_not_allowed" });
  });

  it("not_executed with fatal raises error with an error record; the Runner detail is not recorded", async () => {
    const h = harness({ experiments: [exp("a"), exp("b")], runner: [notExecuted("runner_internal_error", { fatal: true, detail: MSG_SECRET })] });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.runnerCalls.length]).toEqual(["stopped", "error", 1]);
    expect((h.of("error")[0] as Loose).payload).toEqual({ code: "fatal", experimentId: "exp-1-1", phase: "execute", cause: "runner_internal_error" });
    expect(JSON.stringify(h.recs)).not.toContain(MSG_SECRET);
  });

  it("not_executed policy_not_accepted / runner_not_healthy after an accepted decision: error stop, records kept, no later Experiment, closed cause only", async () => {
    for (const reason of ["policy_not_accepted", "runner_not_healthy"]) {
      const h = harness({ experiments: [exp("a"), exp("b")], runner: [notExecuted(reason, { detail: MSG_SECRET })] });
      const r = await h.run();
      expect([r.kind, reasonOf(h), h.runnerCalls.length]).toEqual(["stopped", "error", 1]);
      expect(h.of("observation")).toHaveLength(1);
      expect((h.of("comparison")[0] as Loose).payload).toMatchObject({ result: "not_comparable", reason: "not_executed" });
      expect((h.of("evidence")[0] as Loose).payload.outcome).toBe("inconclusive");
      expect(h.of("error")).toHaveLength(1);
      expect((h.of("error")[0] as Loose).payload).toEqual({ code: "runner_refused", experimentId: "exp-1-1", phase: "execute", cause: reason });
      expect(JSON.stringify(h.of("error"))).not.toContain(MSG_SECRET);
    }
  });

  it("runner_refused with a failed error write still stops with error and runs no later Experiment", async () => {
    const h = harness({ experiments: [exp("a"), exp("b")], runner: [notExecuted("runner_not_healthy")], failAt: (k) => (k === "error" ? "io_failure" : undefined) });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.runnerCalls.length]).toEqual(["stopped", "error", 1]);
  });

  it("runner_refused does not lower a latched cause", async () => {
    const h = harness({
      experiments: [exp("a")],
      runner: [(id, ctx) => {
        ctx.session.raise("isolation_violation");
        return notExecuted("policy_not_accepted")(id);
      }],
    });
    const r = await h.run();
    expect([r.kind, reasonOf(h)]).toEqual(["stopped", "isolation_violation"]);
    expect(h.of("observation")).toHaveLength(1);
  });

  it("a comparator that does not answer not_comparable with the matching reason for a non-executed outcome is a fault", async () => {
    const h = harness({ runner: [timedOut("transport_error")], compare: (_p, obs) => ({ experimentId: obs.experimentId, result: "match", differences: [], maskSha256: SHA }) });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.of("comparison").length]).toEqual(["stopped", "error", 0]);
    const h2 = harness({ runner: [timedOut()], compare: (_p, obs) => ({ experimentId: obs.experimentId, result: "not_comparable", reason: "prediction_missing", differences: [], maskSha256: SHA }) });
    await h2.run();
    expect(reasonOf(h2)).toBe("error");
  });
});

describe("outcomes: interrupted", () => {
  it("forced_stop keeps a latched cause, writes only an error record, and creates no observation, comparison or Evidence", async () => {
    const h = harness({
      experiments: [exp("a"), exp("b")],
      runner: [(id, ctx) => {
        ctx.session.raise("isolation_violation");
        return interrupted("forced_stop", "seq", { detail: PATH_SECRET })(id);
      }],
    });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.runnerCalls.length]).toEqual(["stopped", "isolation_violation", 1]);
    expect((h.of("error")[0] as Loose).payload).toEqual({ code: "experiment_interrupted", experimentId: "exp-1-1", phase: "seq", cause: "forced_stop" });
    expect(h.of("observation").length + h.of("comparison").length + h.of("evidence").length).toBe(0);
    expect(JSON.stringify(h.recs)).not.toContain(PATH_SECRET);
    expect(h.store.experimentStatusOf(CLAIM_REV)).toEqual({ ok: true, value: "absent" });
  });

  it("forced_stop without any latched cause falls back to error (never invented)", async () => {
    const h = harness({ runner: [interrupted("forced_stop", "reset")] });
    await h.run();
    expect(reasonOf(h)).toBe("error");
  });

  it("fatal_error, and forced_stop with fatal, raise error; an unknown cause or phase is mapped to unknown", async () => {
    const h = harness({ experiments: [exp("a"), exp("b")], runner: [interrupted("fatal_error", "state", { fatal: true, detail: MSG_SECRET })] });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.runnerCalls.length]).toEqual(["stopped", "error", 1]);
    expect((h.of("error")[0] as Loose).payload).toEqual({ code: "experiment_interrupted", experimentId: "exp-1-1", phase: "state", cause: "fatal_error" });
    expect(JSON.stringify(h.recs)).not.toContain(MSG_SECRET);

    const h2 = harness({ runner: [interrupted("forced_stop", "prep", { fatal: true })] });
    await h2.run();
    expect(reasonOf(h2)).toBe("error");

    const h3 = harness({ runner: [interrupted(AI_MARKER, AI_MARKER)] });
    await h3.run();
    expect((h3.of("error")[0] as Loose).payload).toMatchObject({ phase: "unknown", cause: "unknown" });
    expect(reasonOf(h3)).toBe("error");
    expect(JSON.stringify(h3.recs)).not.toContain(AI_MARKER);
  });

  it("a failed error-record write ends with error", async () => {
    const h = harness({ runner: [interrupted("forced_stop", "seq")], failAt: (k) => (k === "error" ? "io_failure" : undefined) });
    const r = await h.run();
    expect([r.kind, reasonOf(h)]).toEqual(["stopped", "error"]);
  });

  it("a latched cause that is higher than error is not lowered by an error outcome", async () => {
    const h = harness({
      runner: [(id, ctx) => {
        ctx.session.raise("isolation_violation");
        return notExecuted("runner_internal_error", { fatal: true })(id);
      }],
    });
    await h.run();
    expect(reasonOf(h)).toBe("isolation_violation");
  });
});

describe("boundaries: lease, deadline and abort", () => {
  it("an invalid lease before the call raises lease_unavailable and makes no provider call", async () => {
    const h = harness({ lease: () => ({ valid: false, reason: "revoked" }) });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.completeCalls.length, h.recs.length]).toEqual(["stopped", "lease_unavailable", 0, 0]);
  });

  it("a stale heartbeat before the call raises launcher_killed", async () => {
    const h = harness({ lease: () => ({ valid: false, reason: "heartbeat_stale" }) });
    await h.run();
    expect(reasonOf(h)).toBe("launcher_killed");
  });

  it("the deadline before the call stops with time_limit_reached", async () => {
    const h = harness({ setup: ({ clock }) => { clock.t = 1_000 + 3_600_000; } });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.completeCalls.length]).toEqual(["stopped", "time_limit_reached", 0]);
  });

  it("the deadline between Experiments starts no further Experiment", async () => {
    const h = harness({
      experiments: [exp("a"), exp("b")],
      runner: [(id, ctx) => {
        ctx.clock.t = 1_000 + 3_600_000;
        return executedOutcome(id);
      }],
    });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.runnerCalls.length, h.of("evidence").length]).toEqual(["stopped", "time_limit_reached", 1, 1]);
    expect(h.of("experiment")).toHaveLength(1);
  });

  it("an abort between Experiments (a cause raised while one ran) starts no further Experiment, and the finished one is recorded", async () => {
    const h = harness({
      experiments: [exp("a"), exp("b")],
      runner: [(id, ctx) => {
        ctx.session.raise("lease_unavailable");
        return executedOutcome(id);
      }],
    });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.runnerCalls.length]).toEqual(["stopped", "lease_unavailable", 1]);
    expect(afterCall(h)).toEqual(["experiment", "policy_decision", "observation", "comparison", "evidence"]);
    expect(h.session.signal.aborted).toBe(true);
  });

  it("a cause latched while the experiment record is written stops before the policy; one latched while the decision is written stops before the runner", async () => {
    let s1: Loose;
    const a = harness({
      setup: ({ session }) => { s1 = session; },
      failAt: (k) => {
        if (k === "experiment") s1.raise("lease_unavailable");
        return undefined;
      },
    });
    const ra = await a.run();
    expect([ra.kind, a.policyCalls.length, a.runnerCalls.length, reasonOf(a)]).toEqual(["stopped", 0, 0, "lease_unavailable"]);

    let s2: Loose;
    const b = harness({
      setup: ({ session }) => { s2 = session; },
      failAt: (k) => {
        if (k === "policy_decision") s2.raise("lease_unavailable");
        return undefined;
      },
    });
    const rb = await b.run();
    expect([rb.kind, b.policyCalls.length, b.runnerCalls.length, reasonOf(b)]).toEqual(["stopped", 1, 0, "lease_unavailable"]);
  });

  it("a write failure at every record kind stops the phase with error and starts no further Experiment", async () => {
    const cases: [string, Opts][] = [
      ["experiment_invalid", { experiments: [exp("a", { kind: "claim", id: "clm-0099" })] }],
      ["experiment_dropped", { experiments: [exp("a")], limits: { experiments: 1 }, setup: ({ session }) => session.noteAcceptedExperiment() }],
      ["experiment", {}],
      ["policy_decision", {}],
      ["observation", {}],
      ["comparison", {}],
      ["evidence", {}],
      ["error", { runner: [timedOut("transport_error")] }],
    ];
    for (const [kind, extra] of cases) {
      const h = harness({ experiments: [exp("a"), exp("b")], ...extra, failAt: (k) => (k === kind ? "io_failure" : undefined) });
      const r = await h.run();
      expect([kind, r.kind, reasonOf(h)]).toEqual([kind, "stopped", "error"]);
      expect(h.runnerCalls.length).toBeLessThanOrEqual(1);
    }
  });

  it("an experiment whose evidence is refused by the store (unknown revision) raises error", async () => {
    const h = harness({ hypothesis: { hypothesisId: "hyp-1", claims: [{ claimId: "clm-0001", claimRevisionId: "clm-0001-r9" }] } });
    const r = await h.run();
    expect([r.kind, reasonOf(h), h.of("evidence").length]).toEqual(["stopped", "error", 0]);
  });
});

describe("no leak and the vocabularies", () => {
  it("no secret marker, host path, approval-like marker or AI string appears in any record", async () => {
    const h = harness({
      experiments: [exp("a"), exp("b", { kind: "claim", id: AI_MARKER }), exp("c"), exp("d")],
      rejected: [{ index: 4, issues: [{ code: "bad_type", path: `/${AI_MARKER}` }] }],
      runner: [timedOut("transport_error"), notExecuted("preparation_failed", { detail: `${MSG_SECRET} ${PATH_SECRET}` }), interrupted("forced_stop", "seq", { detail: `${MSG_SECRET} ${PATH_SECRET}` })],
    });
    await h.run();
    const text = JSON.stringify(h.recs);
    for (const marker of [MSG_SECRET, PATH_SECRET, APPROVAL_MARKER, AI_MARKER]) expect(text).not.toContain(marker);
    expect(h.of("error").length).toBeGreaterThan(0);
  });

  it("pins the closed vocabularies and the exported names", () => {
    expect([...EXPERIMENT_ERROR_CODES]).toEqual(["transport_error", "experiment_interrupted", "address_not_allowed", "fatal", "runner_refused"]);
    expect([...EXPERIMENT_ERROR_PHASES]).toEqual(["not_started", "reset", "prep", "boundary", "seq", "state", "execute", "unknown"]);
    expect([...EXPERIMENT_ERROR_CAUSES]).toEqual(["forced_stop", "fatal_error", "transport_error", "address_not_allowed", "runner_internal_error", "policy_not_accepted", "runner_not_healthy", "unknown"]);
    expect([...EXPERIMENT_INVALID_CODES]).toEqual([
      "size_exceeded", "invalid_utf8", "invalid_json", "depth_exceeded", "duplicate_key", "unsafe_number", "undefined_field", "missing_field", "bad_type",
      "bad_value", "schema_violation", "unknown_target", "duplicate_local_key", "invalid",
    ]);
    expect(Object.keys(phaseModule).sort()).toEqual(["EXPERIMENT_ERROR_CAUSES", "EXPERIMENT_ERROR_CODES", "EXPERIMENT_ERROR_PHASES", "EXPERIMENT_INVALID_CODES", "runExperimentPhase"]);
    expect(RECORDS_UNAVAILABLE_MESSAGE).toBe("run records unavailable");
  });
});
