// Task 4.6 W6-B: the start-state measurement in the start sequence (`startRun.ts`, step 14b), through the REAL Loop_Orchestrator: real stage B,
// real start gate, real startRun, the REAL verifier Runner (`createRunner`) over the verifier FAKE http port, the real RunRecordStore on a
// MemoryFileSystem (test/support/mockRunWorld.ts; its manifest port is the test-only one, so a Run is sealed whatever the start state; the real
// ManifestPort is task W6-C). Every product, value and canary is SYNTHETIC; no network.
// **Validates: Requirements 9.5, 9.8, 11.12, 22.3, 24.9, 24.15**
import { describe, expect, it } from "vitest";
import { buildWorld, type World } from "./support/mockRunWorld.js";
import type { Any } from "./support/orchestratorFakes.js";

const CANARY = "canary-secret-value-w6b";
const products = (body: unknown, status = 200) => ({ status, body: JSON.stringify(body) });
const at = (w: World, label: string): number => w.http.seen.indexOf(label);
const count = (w: World, label: string): number => w.http.seen.filter((s) => s === label).length;
const kinds = (w: World): string[] => w.records().map((r) => r.kind);
const terminationOf = (w: World): unknown => w.records().find((r) => r.kind === "termination")?.payload;

/** A spy around the real Runner: counts the measurement calls and records what they received; the method is the real one. */
function spyRunner(log: { calls: number; signal?: AbortSignal; options?: Any; results: Any[] }, before?: (w: World) => void) {
  return (runner: Any, w: () => World): unknown => ({
    health: runner.health.bind(runner),
    execute: runner.execute.bind(runner),
    measureStartState: async (signal: AbortSignal, options: Any) => {
      log.calls += 1;
      log.signal = signal;
      log.options = options;
      before?.(w());
      const r = await runner.measureStartState(signal, options);
      log.results.push(r);
      return r;
    },
  });
}

describe("the measurement after a passed health check", () => {
  it("measures once, with the Run signal and the Run deadline, before the first Experiment; the Run then goes on to its normal end", async () => {
    const log = { calls: 0, results: [] as Any[] } as { calls: number; signal?: AbortSignal; options?: Any; results: Any[] };
    const w = await buildWorld({ wrapRunner: spyRunner(log) });
    const r = await w.run();
    expect(r.sealed).toBe(true);
    if (r.sealed) expect(r.summary.terminationReason).toBe("iteration_limit_reached");
    expect(log.calls).toBe(1);
    expect(log.results[0]).toMatchObject({ ok: true });
    expect(log.results[0].identity).toMatch(/^[0-9a-f]{64}$/);
    // the signal of the session (not aborted at that moment) and the Run deadline: the session started at 1 000 with the default 1 800 s
    expect(log.signal).toBeInstanceOf(AbortSignal);
    expect(log.options).toEqual({ notAfterMs: 1_000 + 1_800_000 });
    // order: health, the measurement's reset and GET, then the Experiments with their own reset each (unchanged behaviour)
    expect(w.http.seen.slice(0, 3)).toEqual(["GET /health", "POST /reset", "GET /products"]);
    expect(count(w, "GET /products")).toBe(1);
    expect(count(w, "POST /reset")).toBeGreaterThanOrEqual(2);
    expect(w.http.seen.indexOf("POST /reset", at(w, "GET /products"))).toBeGreaterThan(at(w, "GET /products"));
    expect(count(w, "GET /orders")).toBeGreaterThanOrEqual(2);
    expect(w.providerCalls.length).toBeGreaterThan(0);
  });

  it("does not measure when the health check fails; no phase runs", async () => {
    const log = { calls: 0, results: [] as Any[] };
    const w = await buildWorld({
      wrapRunner: (runner: Any, ww: () => World) => {
        const s = spyRunner(log)(runner, ww) as Any;
        return { ...s, health: async () => ({ ok: false, error: "unhealthy" }) };
      },
    });
    const r = await w.run();
    expect(log.calls).toBe(0);
    expect(count(w, "POST /reset")).toBe(0);
    expect(count(w, "GET /products")).toBe(0);
    expect(w.providerCalls).toHaveLength(0);
    expect(terminationOf(w)).toEqual({ terminationReason: "error" });
    expect(r.sealed).toBe(true); // the test-only manifest port of mockRunWorld seals whatever the start state
  });
});

describe("a failed measurement starts no phase and no Experiment", () => {
  const cases: Array<[string, Any, string]> = [
    ["a status other than 200", products({ success: true, data: [] }, 500), "error"],
    ["success that is not true", products({ success: false, data: [] }), "error"],
    ["data that is not a list", products({ success: true, data: {} }), "error"],
    ["a transport failure", new Error("boom"), "error"],
  ];
  for (const [label, reply, reason] of cases) {
    it(`${label}: no provider call, no Experiment, the termination record names ${reason}`, async () => {
      const w = await buildWorld({ productsReply: reply });
      await w.run();
      expect(w.providerCalls).toHaveLength(0);
      expect(count(w, "POST /reset")).toBe(1); // the measurement's own reset only
      expect(kinds(w)).not.toContain("experiment");
      expect(terminationOf(w)).toEqual({ terminationReason: reason });
      // the control: the same world with the default answer runs its phases
      const ok = await buildWorld();
      await ok.run();
      expect(ok.providerCalls.length).toBeGreaterThan(0);
    });
  }

  it("a timeout (the answer arrives after the 10 s budget) gives error, no phase", async () => {
    const w = await buildWorld({
      productsReply: async (_s, ww) => {
        ww.time.t += 10_001;
        return products({ success: true, data: [] });
      },
    });
    await w.run();
    expect(w.providerCalls).toHaveLength(0);
    expect(terminationOf(w)).toEqual({ terminationReason: "error" });
  });

  it("an abort (the Run deadline passes and its timer fires during the measurement) keeps time_limit_reached, not error; no phase", async () => {
    const w = await buildWorld({
      productsReply: async (_s, ww) => {
        ww.time.t = 1_000 + 1_800_000; // the Run deadline
        for (const t of ww.timers) if (t.cancelled === 0) t.fire(); // the deadline timer: time_limit_reached is latched and the signal aborted
        return products({ success: true, data: [] });
      },
    });
    await w.run();
    expect(w.providerCalls).toHaveLength(0);
    expect(terminationOf(w)).toEqual({ terminationReason: "time_limit_reached" });
  });

  it("a stale heartbeat during the measurement gives launcher_killed; another lease failure gives lease_unavailable", async () => {
    for (const [reason, expected] of [["heartbeat_stale", "launcher_killed"], ["revoked", "lease_unavailable"]] as const) {
      const log = { calls: 0, results: [] as Any[] };
      const w = await buildWorld({ wrapRunner: spyRunner(log, (ww) => ww.lease.invalidFrom(ww.lease.calls + 1, { valid: false, reason })) });
      await w.run();
      expect(log.results[0]).toEqual({ ok: false, code: "lease_unavailable", leaseReason: reason });
      expect(count(w, "POST /reset"), reason).toBe(0); // nothing is sent while the lease is invalid
      expect(w.http.sentWhileInvalid).toBe(0);
      expect(w.providerCalls).toHaveLength(0);
      expect(terminationOf(w)).toEqual({ terminationReason: expected });
    }
  });

  it("a measurement that throws is a failure: error, no phase, the normal end (termination record), nothing leaks", async () => {
    const w = await buildWorld({
      wrapRunner: (runner: Any) => ({
        health: runner.health.bind(runner),
        execute: runner.execute.bind(runner),
        measureStartState: async () => {
          throw new Error(CANARY);
        },
      }),
    });
    const r = await w.run();
    expect(w.providerCalls).toHaveLength(0);
    expect(terminationOf(w)).toEqual({ terminationReason: "error" });
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(JSON.stringify(w.records())).not.toContain(CANARY);
  });

  it("is never retried: one measurement per Run, also after a failure", async () => {
    const log = { calls: 0, results: [] as Any[] };
    const w = await buildWorld({ productsReply: products({ success: false }), wrapRunner: spyRunner(log) });
    await w.run();
    expect(log.calls).toBe(1);
    expect(count(w, "GET /products")).toBe(1);
  });
});

describe("a Runner without the measurement is refused", () => {
  it("runner_start_refused before run_started: nothing is written, nothing is sent", async () => {
    const w = await buildWorld({ wrapRunner: (runner: Any) => ({ health: runner.health.bind(runner), execute: runner.execute.bind(runner) }) });
    const r = await w.run();
    expect(r).toEqual({ sealed: false, started: false, failure: "runner_start_refused" });
    expect(w.records()).toEqual([]);
    expect(w.http.seen).toEqual([]);
  });
});
