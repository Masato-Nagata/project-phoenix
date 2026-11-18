// Task 4.4, unit U1: the RunSession (`src/orchestrator/session.ts`). Deterministic, offline, with a fake monotonic clock; no timer is used.
// **Validates: Requirements 11.9, 11.12, 11.16, 11.17, 15.6, 24.12, 24.15**
import { describe, expect, it } from "vitest";
import { ABORTING_REASONS, createRunSession, type RunSession } from "../src/orchestrator/session.js";
import { TERMINATION_REASONS, type TerminationReason } from "../src/orchestrator/types.js";

function fakeClock(start: number): { nowMs(): number; set(v: number): void; readonly calls: number } {
  let t = start;
  let calls = 0;
  return {
    nowMs: () => {
      calls += 1;
      return t;
    },
    set: (v: number) => {
      t = v;
    },
    get calls() {
      return calls;
    },
  };
}
function make(clock: { nowMs(): number }, runSeconds = 5): RunSession {
  const r = createRunSession({ clock, runSeconds });
  if (!r.ok) throw new Error("setup failed");
  return r.value;
}

const ABORTING_LITERAL = ["isolation_violation", "launcher_killed", "lease_unavailable", "error", "time_limit_reached"] as const;
const NON_ABORTING_LITERAL = [
  "payload_audit_blocked",
  "provider_failure",
  "policy_rejection_limit",
  "no_further_experiments",
  "experiment_limit_reached",
  "iteration_limit_reached",
] as const;
const VIEW_KEYS = [
  "attributeSymptom", "checkDeadline", "deadlineAtMs", "deadlineReached", "experimentCount", "finalize", "iterationCount", "limitsUsed", "markStarted", "noteAcceptedExperiment",
  "noteIteration", "noteProviderRetry", "noteRejectedExperiment", "policyRejectionCount", "providerRetryCount", "raise", "remainingMs", "signal", "started",
  "startedAtMs", "terminationStatus",
];

describe("creation and the monotonic clock", () => {
  it("reads the clock once and computes the deadline (start 1000, 5 s gives 6000)", () => {
    const c = fakeClock(1_000);
    const s = make(c, 5);
    expect(c.calls).toBe(1);
    expect(s.startedAtMs).toBe(1_000);
    expect(s.deadlineAtMs).toBe(6_000);
  });
  it("accepts the bounds 1 and 3600 seconds", () => {
    expect(make(fakeClock(0), 1).deadlineAtMs).toBe(1_000);
    expect(make(fakeClock(10), 3600).deadlineAtMs).toBe(3_600_010);
  });
  it("deadlineReached and remainingMs follow the fake clock, also exactly at the deadline and beyond", () => {
    const c = fakeClock(1_000);
    const s = make(c, 5);
    expect([s.deadlineReached(), s.remainingMs()]).toEqual([false, 5_000]);
    c.set(5_999);
    expect([s.deadlineReached(), s.remainingMs()]).toEqual([false, 1]);
    c.set(6_000);
    expect([s.deadlineReached(), s.remainingMs()]).toEqual([true, 0]);
    c.set(9_000);
    expect([s.deadlineReached(), s.remainingMs()]).toEqual([true, 0]);
    c.set(Number.MAX_SAFE_INTEGER);
    expect(s.remainingMs()).toBe(0);
  });
  it("a later clock reading that is not a finite number is a clock fault, not a reached deadline", () => {
    for (const v of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const c = fakeClock(0);
      const s = make(c, 5);
      c.set(v);
      expect([s.deadlineReached(), s.remainingMs(), s.checkDeadline()]).toEqual([false, 0, "clock_fault"]);
    }
    const t = createRunSession({ clock: { nowMs: (() => { let n = 0; return () => { if (n++ === 0) return 0; throw new Error("clock broke"); }; })() }, runSeconds: 5 });
    expect(t.ok).toBe(true);
    if (t.ok) expect([t.value.deadlineReached(), t.value.remainingMs(), t.value.checkDeadline()]).toEqual([false, 0, "clock_fault"]);
  });
  it("the options accept no wall clock: only clock and runSeconds are read, and an extra wall clock is never called", () => {
    let wallCalls = 0;
    const opts = { clock: fakeClock(0), runSeconds: 5, wall: { nowIso: () => (wallCalls += 1, "x") }, wallClock: { nowIso: () => (wallCalls += 1, "x") } };
    const r = createRunSession(opts as never);
    expect(r.ok).toBe(true);
    if (r.ok) {
      r.value.deadlineReached();
      r.value.remainingMs();
      r.value.raise("error");
      r.value.finalize();
    }
    expect(wallCalls).toBe(0);
  });
  it("invalid runSeconds gives invalid_options and never throws", () => {
    for (const bad of [0, 3601, 1.5, "5", Number.NaN, Number.POSITIVE_INFINITY, -1, undefined, null, 2 ** 53]) {
      let r: unknown;
      expect(() => {
        r = createRunSession({ clock: fakeClock(0), runSeconds: bad as never });
      }, String(bad)).not.toThrow();
      expect(r, String(bad)).toEqual({ ok: false, error: { code: "invalid_options" } });
    }
  });
  it("a missing or invalid clock, or a clock that returns a non-finite value or throws, gives invalid_options and never throws", () => {
    const clocks: readonly unknown[] = [
      undefined, null, {}, 5, "clock", { nowMs: 1 }, { nowMs: () => Number.NaN }, { nowMs: () => Number.POSITIVE_INFINITY }, { nowMs: () => "1" }, { nowMs: () => undefined },
      { nowMs: () => { throw new Error("boom"); } }, { nowMs: () => Number.MAX_SAFE_INTEGER },
    ];
    for (const clock of clocks) {
      let r: unknown;
      expect(() => {
        r = createRunSession({ clock: clock as never, runSeconds: 5 });
      }).not.toThrow();
      expect(r).toEqual({ ok: false, error: { code: "invalid_options" } });
    }
  });
  it("missing options give invalid_options", () => {
    for (const o of [undefined, null, 5, "x"]) expect(createRunSession(o as never)).toEqual({ ok: false, error: { code: "invalid_options" } });
  });
});

/** A clock whose next reading is any value (also a bad one) or an Error to throw. */
function scriptedClock(start: number): { nowMs(): number; set(v: unknown): void } {
  let v: unknown = start;
  return {
    nowMs: () => {
      if (v instanceof Error) throw v;
      return v as number;
    },
    set: (x: unknown) => {
      v = x;
    },
  };
}
/** What unit U4 does with the result of `checkDeadline()` (the contract; U1 itself never raises). */
function u4Step(s: RunSession): void {
  const d = s.checkDeadline();
  if (d === "reached") s.raise("time_limit_reached");
  else if (d === "clock_fault") s.raise("error");
}

describe("checkDeadline and the clock fault", () => {
  it("is ok before the deadline, reached exactly at it and after it", () => {
    const c = scriptedClock(1_000);
    const s = make(c, 5); // deadline 6000
    expect(s.checkDeadline()).toBe("ok");
    c.set(5_999);
    expect(s.checkDeadline()).toBe("ok");
    c.set(6_000);
    expect(s.checkDeadline()).toBe("reached");
    c.set(9_000);
    expect(s.checkDeadline()).toBe("reached");
  });
  it("a clock that throws gives clock_fault", () => {
    const c = scriptedClock(0);
    const s = make(c, 5);
    c.set(new Error("boom"));
    expect(s.checkDeadline()).toBe("clock_fault");
  });
  it("NaN, +Infinity, -Infinity, a string, undefined and null readings give clock_fault", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1000", undefined, null]) {
      const c = scriptedClock(0);
      const s = make(c, 5);
      c.set(bad);
      expect(s.checkDeadline(), String(bad)).toBe("clock_fault");
    }
  });
  it("the fault is latched: a normal reading before the deadline, or after it, never gives ok or reached again", () => {
    const c = scriptedClock(0);
    const s = make(c, 5); // deadline 5000
    c.set(Number.NaN);
    expect(s.checkDeadline()).toBe("clock_fault");
    c.set(100);
    expect(s.checkDeadline()).toBe("clock_fault");
    c.set(5_000);
    expect(s.checkDeadline()).toBe("clock_fault");
    c.set(99_999);
    expect(s.checkDeadline()).toBe("clock_fault");
  });
  it("a fault first seen through remainingMs is latched for checkDeadline, and remainingMs stays 0 when the clock recovers", () => {
    const c = scriptedClock(0);
    const s = make(c, 5);
    c.set(Number.NaN);
    expect(s.remainingMs()).toBe(0);
    c.set(100);
    expect(s.remainingMs()).toBe(0);
    expect(s.checkDeadline()).toBe("clock_fault");
  });
  it("a fault first seen through deadlineReached is latched: deadlineReached is false during and after it, checkDeadline reports it", () => {
    const c = scriptedClock(0);
    const s = make(c, 5);
    c.set(new Error("boom"));
    expect(s.deadlineReached()).toBe(false);
    c.set(99_999); // past the deadline, but the fault wins
    expect(s.deadlineReached()).toBe(false);
    expect(s.remainingMs()).toBe(0);
    expect(s.checkDeadline()).toBe("clock_fault");
  });
  it("a fault changes nothing by itself: no termination status, no abort", () => {
    const c = scriptedClock(0);
    const s = make(c, 5);
    c.set(Number.NaN);
    s.checkDeadline();
    s.deadlineReached();
    s.remainingMs();
    expect(s.terminationStatus()).toEqual({ state: "none" });
    expect(s.signal.aborted).toBe(false);
  });
  it("the U4 contract: a clock fault ends with error, never time_limit_reached; reached gives time_limit_reached", () => {
    const c = scriptedClock(0);
    const s = make(c, 5);
    c.set(Number.NaN);
    u4Step(s);
    expect(s.terminationStatus()).toEqual({ state: "pending", reason: "error" });
    expect(s.signal.aborted).toBe(true);
    expect(s.signal.reason).toBe("error");
    // later the clock recovers and passes the deadline: still the fault, still error
    c.set(99_999);
    u4Step(s);
    expect(s.terminationStatus()).toEqual({ state: "pending", reason: "error" });
    expect(s.finalize()).toEqual({ ok: true, value: { reason: "error", alreadyFinalized: false } });

    const d = scriptedClock(0);
    const r = make(d, 5);
    u4Step(r);
    expect(r.terminationStatus()).toEqual({ state: "none" });
    d.set(5_000);
    u4Step(r);
    expect(r.terminationStatus()).toEqual({ state: "pending", reason: "time_limit_reached" });
    expect(r.signal.reason).toBe("time_limit_reached");
  });
  it("two sessions are independent: a fault in one leaves the other ok, also when interleaved", () => {
    const ca = scriptedClock(0);
    const cb = scriptedClock(0);
    const a = make(ca, 5);
    const b = make(cb, 5);
    ca.set(Number.NaN);
    expect(a.checkDeadline()).toBe("clock_fault");
    expect(b.checkDeadline()).toBe("ok");
    ca.set(0);
    cb.set(5_000);
    expect(a.checkDeadline()).toBe("clock_fault");
    expect(b.checkDeadline()).toBe("reached");
    expect(b.remainingMs()).toBe(0);
    cb.set(10);
    expect(b.checkDeadline()).toBe("ok");
    expect(b.remainingMs()).toBe(4_990);
  });
});

describe("the public view and the counters", () => {
  it("has exactly the pinned keys and is frozen", () => {
    const s = make(fakeClock(0));
    expect(Object.keys(s).sort()).toEqual(VIEW_KEYS);
    expect(VIEW_KEYS).toHaveLength(21);
    expect(Object.isFrozen(s)).toBe(true);
  });
  it("starts with all counters at 0 and started false", () => {
    const s = make(fakeClock(0));
    expect([s.iterationCount, s.experimentCount, s.policyRejectionCount, s.providerRetryCount, s.started]).toEqual([0, 0, 0, 0, false]);
    expect(s.limitsUsed()).toEqual({ iterations: 0, acceptedExperiments: 0, rejectedExperiments: 0 });
  });
  it("each increment adds exactly 1 to its own counter", () => {
    const s = make(fakeClock(0));
    s.noteIteration();
    expect([s.iterationCount, s.experimentCount, s.policyRejectionCount, s.providerRetryCount]).toEqual([1, 0, 0, 0]);
    s.noteAcceptedExperiment();
    expect([s.iterationCount, s.experimentCount, s.policyRejectionCount, s.providerRetryCount]).toEqual([1, 1, 0, 0]);
    s.noteRejectedExperiment();
    expect([s.iterationCount, s.experimentCount, s.policyRejectionCount, s.providerRetryCount]).toEqual([1, 1, 1, 0]);
    s.noteProviderRetry();
    expect([s.iterationCount, s.experimentCount, s.policyRejectionCount, s.providerRetryCount]).toEqual([1, 1, 1, 1]);
    s.noteIteration();
    s.noteIteration();
    s.noteAcceptedExperiment();
    expect([s.iterationCount, s.experimentCount]).toEqual([3, 2]);
  });
  it("limitsUsed maps iterations, accepted and rejected Experiments, is frozen, and is a snapshot", () => {
    const s = make(fakeClock(0));
    for (let i = 0; i < 2; i++) s.noteIteration();
    for (let i = 0; i < 3; i++) s.noteAcceptedExperiment();
    s.noteRejectedExperiment();
    for (let i = 0; i < 4; i++) s.noteProviderRetry(); // not part of limitsUsed
    const u = s.limitsUsed();
    expect(u).toEqual({ iterations: 2, acceptedExperiments: 3, rejectedExperiments: 1 });
    expect(Object.keys(u).sort()).toEqual(["acceptedExperiments", "iterations", "rejectedExperiments"]);
    expect(Object.isFrozen(u)).toBe(true);
    expect(s.providerRetryCount).toBe(4);
    s.noteIteration();
    expect(u.iterations).toBe(2);
    expect(s.limitsUsed().iterations).toBe(3);
  });
  it("has no setter or reset: assignments throw and the counters do not change", () => {
    const s = make(fakeClock(0)) as unknown as Record<string, unknown>;
    (s["noteIteration"] as () => void)();
    for (const k of ["iterationCount", "experimentCount", "policyRejectionCount", "providerRetryCount", "started", "startedAtMs", "deadlineAtMs", "signal", "reset"]) {
      expect(() => {
        s[k] = 99;
      }, k).toThrow();
    }
    expect([s["iterationCount"], s["experimentCount"], s["policyRejectionCount"], s["providerRetryCount"], s["started"]]).toEqual([1, 0, 0, 0, false]);
    expect(Object.keys(s).some((k) => /reset|set[A-Z]|decrement/.test(k))).toBe(false);
  });
  it("markStarted sets started once and is idempotent", () => {
    const s = make(fakeClock(0));
    expect(s.started).toBe(false);
    s.markStarted();
    expect(s.started).toBe(true);
    s.markStarted();
    expect(s.started).toBe(true);
  });
  it("JSON of the view holds only numbers, booleans and an empty signal, and no canary of an invalid reason", () => {
    const s = make(fakeClock(1_000));
    s.markStarted();
    s.noteIteration();
    s.raise("CANARY-1b2c3d" as never);
    const parsed = JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
    delete parsed["signal"];
    expect(parsed).toEqual({ startedAtMs: 1_000, deadlineAtMs: 6_000, started: true, iterationCount: 1, experimentCount: 0, policyRejectionCount: 0, providerRetryCount: 0 });
    for (const v of Object.values(parsed)) expect(["number", "boolean"]).toContain(typeof v);
    expect(JSON.stringify(s)).not.toContain("CANARY");
    expect(JSON.stringify(s.terminationStatus())).toBe('{"state":"pending","reason":"error"}');
    expect(JSON.stringify(s.limitsUsed())).toBe('{"iterations":1,"acceptedExperiments":0,"rejectedExperiments":0}');
  });
});

describe("independence of sessions", () => {
  it("two sessions with different clocks and counters share nothing when interleaved", () => {
    const ca = fakeClock(0);
    const cb = fakeClock(500);
    const a = make(ca, 10);
    const b = make(cb, 20);
    expect([a.startedAtMs, a.deadlineAtMs, b.startedAtMs, b.deadlineAtMs]).toEqual([0, 10_000, 500, 20_500]);
    a.noteIteration();
    b.noteAcceptedExperiment();
    a.noteProviderRetry();
    b.noteRejectedExperiment();
    a.markStarted();
    ca.set(10_000);
    expect([a.deadlineReached(), b.deadlineReached()]).toEqual([true, false]);
    expect(a.raise("isolation_violation")).toBe("latched");
    expect(a.finalize().ok).toBe(true);
    expect(a.signal.aborted).toBe(true);
    expect(b.signal.aborted).toBe(false);
    expect(b.terminationStatus()).toEqual({ state: "none" });
    expect(b.started).toBe(false);
    expect(b.finalize()).toEqual({ ok: false, error: { code: "no_cause" } });
    expect(b.raise("provider_failure")).toBe("latched");
    expect(a.terminationStatus()).toEqual({ state: "finalized", reason: "isolation_violation" });
    expect([a.iterationCount, a.experimentCount, a.policyRejectionCount, a.providerRetryCount]).toEqual([1, 0, 0, 1]);
    expect([b.iterationCount, b.experimentCount, b.policyRejectionCount, b.providerRetryCount]).toEqual([0, 1, 1, 0]);
    expect(b.signal.aborted).toBe(false);
  });
});

describe("abort behavior", () => {
  it("the signal is an AbortSignal and is not aborted at start", () => {
    const s = make(fakeClock(0));
    expect(s.signal).toBeInstanceOf(AbortSignal);
    expect(s.signal.aborted).toBe(false);
    expect(Object.keys(s)).not.toContain("controller");
  });
  it("each aborting reason aborts exactly once, with the reason string", () => {
    for (const reason of ABORTING_LITERAL) {
      const s = make(fakeClock(0));
      let events = 0;
      s.signal.addEventListener("abort", () => {
        events += 1;
      });
      expect(s.raise(reason), reason).toBe("latched");
      expect(s.signal.aborted, reason).toBe(true);
      expect(s.signal.reason, reason).toBe(reason);
      expect(events, reason).toBe(1);
      expect(s.raise(reason), reason).toBe("ignored_not_higher"); // the same raise again
      expect(events, reason).toBe(1);
      expect(s.signal.reason, reason).toBe(reason);
    }
  });
  it("a higher aborting upgrade does not abort twice; the signal keeps the first reason and the status the final one", () => {
    const s = make(fakeClock(0));
    let events = 0;
    s.signal.addEventListener("abort", () => {
      events += 1;
    });
    expect(s.raise("time_limit_reached")).toBe("latched");
    expect(s.raise("isolation_violation")).toBe("upgraded");
    expect(events).toBe(1);
    expect(s.signal.reason).toBe("time_limit_reached");
    expect(s.terminationStatus()).toEqual({ state: "pending", reason: "isolation_violation" });
  });
  it("no other reason aborts, in particular experiment_limit_reached (accepted Experiments finish, R11.9)", () => {
    for (const reason of NON_ABORTING_LITERAL) {
      const s = make(fakeClock(0));
      expect(s.raise(reason), reason).toBe("latched");
      expect(s.signal.aborted, reason).toBe(false);
      expect(s.terminationStatus(), reason).toEqual({ state: "pending", reason });
    }
  });
  it("the aborting list is exactly the five reasons, and the two lists partition the 11 reasons", () => {
    expect([...ABORTING_REASONS]).toEqual([...ABORTING_LITERAL]);
    expect([...ABORTING_LITERAL, ...NON_ABORTING_LITERAL].sort()).toEqual([...TERMINATION_REASONS].sort());
  });
  it("a non-aborting cause upgraded by an aborting one aborts then, once", () => {
    const s = make(fakeClock(0));
    s.raise("provider_failure");
    expect(s.signal.aborted).toBe(false);
    expect(s.raise("error")).toBe("upgraded");
    expect(s.signal.aborted).toBe(true);
    expect(s.signal.reason).toBe("error");
  });
  it("a lower cause after an aborting one does not abort again or change the signal", () => {
    const s = make(fakeClock(0));
    s.raise("lease_unavailable");
    expect(s.raise("provider_failure")).toBe("ignored_not_higher");
    expect(s.signal.reason).toBe("lease_unavailable");
  });
  it("after finalize no new abort happens, and the status stays", () => {
    const s = make(fakeClock(0));
    s.raise("provider_failure");
    expect(s.finalize()).toEqual({ ok: true, value: { reason: "provider_failure", alreadyFinalized: false } });
    for (const r of ABORTING_LITERAL) expect(s.raise(r), r).toBe("ignored_finalized");
    expect(s.raise("nope" as never)).toBe("ignored_finalized");
    expect(s.signal.aborted).toBe(false);
    expect(s.terminationStatus()).toEqual({ state: "finalized", reason: "provider_failure" });
  });
  it("an invalid reason latches error and aborts with the string error, never the bad value", () => {
    const s = make(fakeClock(0));
    expect(s.raise("CANARY-zz" as never)).toBe("latched_invalid_reason");
    expect(s.signal.aborted).toBe(true);
    expect(s.signal.reason).toBe("error");
  });
});

describe("symptoms through the session", () => {
  it("with no cause, a symptom raises error, aborts, and reports classified: false", () => {
    const s = make(fakeClock(0));
    expect(s.attributeSymptom("lease_check_interrupted")).toEqual({ reason: "error", classified: false });
    expect(s.signal.aborted).toBe(true);
    expect(s.signal.reason).toBe("error");
    expect(s.terminationStatus()).toEqual({ state: "pending", reason: "error" });
  });
  it("with a cause, a symptom returns it and neither changes nor aborts anything", () => {
    const s = make(fakeClock(0));
    s.raise("experiment_limit_reached");
    expect(s.attributeSymptom("forced_stop")).toEqual({ reason: "experiment_limit_reached", classified: true });
    expect(s.signal.aborted).toBe(false);
    expect(s.terminationStatus()).toEqual({ state: "pending", reason: "experiment_limit_reached" });
  });
  it("a symptom after the time limit is attributed to it (U4 raises time_limit_reached from the timer callback or on deadlineReached)", () => {
    const c = fakeClock(0);
    const s = make(c, 1);
    c.set(1_000);
    if (s.deadlineReached()) s.raise("time_limit_reached"); // what U4 does; U1 starts no timer
    expect(s.attributeSymptom("interrupted")).toEqual({ reason: "time_limit_reached", classified: true });
    expect(s.signal.reason).toBe("time_limit_reached");
  });
  it("the Runner fatal-error case: the caller raises error first, then attributes", () => {
    const s = make(fakeClock(0));
    s.raise("error");
    expect(s.attributeSymptom("interrupted")).toEqual({ reason: "error", classified: true });
  });
});

describe("types of the final status", () => {
  it("the session never reports a reason outside the 11", () => {
    const all: readonly string[] = TERMINATION_REASONS;
    const seen: TerminationReason[] = [];
    for (const r of TERMINATION_REASONS) {
      const s = make(fakeClock(0));
      s.raise(r);
      const st = s.terminationStatus();
      if (st.state !== "none") seen.push(st.reason);
    }
    expect(seen.every((r) => all.includes(r))).toBe(true);
    expect(seen).toHaveLength(11);
  });
});
