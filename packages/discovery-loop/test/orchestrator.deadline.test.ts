// Task 4.4, unit U4: the deadline checkpoint and the deadline timer (`src/orchestrator/deadline.ts`). Deterministic and offline: the REAL
// RunSession on a scripted monotonic clock, and a scripted fake TimerPort whose callbacks the test fires by hand. Nothing waits on real time.
// **Validates: Requirements 11.12, 11.17**
import { describe, expect, it, vi } from "vitest";
import { MIN_REARM_MS, armDeadlineTimer, deadlineCheckpoint } from "../src/orchestrator/deadline.js";
import { createRunSession, type RunSession } from "../src/orchestrator/session.js";
import type { TimerPort } from "../src/orchestrator/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

function clockAt(start: number): { nowMs(): number; set(v: number): void; add(ms: number): void } {
  let t = start;
  return {
    nowMs: () => t,
    set: (v: number) => {
      t = v;
    },
    add: (ms: number) => {
      t += ms;
    },
  };
}
function session(clock: { nowMs(): number }, runSeconds = 5): RunSession {
  const r = createRunSession({ clock, runSeconds });
  if (!r.ok) throw new Error("setup failed");
  return r.value;
}

interface Entry {
  readonly delay: number;
  readonly fire: () => void;
  cancelled: number;
}
interface TimerOpts {
  /** The n-th `schedule` call (1-based) throws. */
  readonly throwAt?: number;
  /** From the n-th call on, `schedule` returns a handle without `cancel`. */
  readonly noCancelFrom?: number;
  /** `schedule` calls the callback synchronously, before it returns. */
  readonly syncFire?: boolean;
  /** The handle's `cancel` throws. */
  readonly cancelThrows?: boolean;
}
function fakeTimers(o: TimerOpts = {}): { timers: TimerPort; calls: Entry[]; fireLast(): void } {
  const calls: Entry[] = [];
  const timers: TimerPort = {
    schedule(delay, onFire) {
      const n = calls.length + 1;
      if (o.throwAt === n) throw new Error("schedule failed");
      const entry: Entry = { delay, fire: onFire, cancelled: 0 };
      calls.push(entry);
      if (o.syncFire === true) onFire();
      if (o.noCancelFrom !== undefined && n >= o.noCancelFrom) return {} as Loose;
      return {
        cancel: () => {
          entry.cancelled += 1;
          if (o.cancelThrows === true) throw new Error("cancel failed");
        },
      };
    },
  };
  return {
    timers,
    calls,
    fireLast: () => {
      const last = calls.at(-1);
      if (last === undefined) throw new Error("nothing scheduled");
      last.fire();
    },
  };
}
const arm = (s: RunSession, t: TimerPort) => {
  const r = armDeadlineTimer(s, t);
  if (!r.ok) throw new Error("arm failed");
  return r.value;
};

describe("MIN_REARM_MS", () => {
  it("is 100", () => {
    expect(MIN_REARM_MS).toBe(100);
  });
});

describe("deadlineCheckpoint", () => {
  it("ok: continue, nothing is raised", () => {
    const s = session(clockAt(0));
    expect(deadlineCheckpoint(s)).toBe("continue");
    expect(s.terminationStatus()).toEqual({ state: "none" });
    expect(s.signal.aborted).toBe(false);
  });
  it("reached: stop, time_limit_reached is raised and the signal is aborted with that reason", () => {
    const c = clockAt(0);
    const s = session(c, 5);
    c.set(5_000);
    expect(deadlineCheckpoint(s)).toBe("stop");
    expect(s.terminationStatus()).toEqual({ state: "pending", reason: "time_limit_reached" });
    expect(s.signal.aborted).toBe(true);
    expect(s.signal.reason).toBe("time_limit_reached");
  });
  it("clock_fault: stop with error, never time_limit_reached, also when the faulty clock reads past the deadline later", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY]) {
      const c = clockAt(0);
      const s = session(c, 5);
      c.set(bad);
      expect(deadlineCheckpoint(s)).toBe("stop");
      c.set(99_999);
      expect(deadlineCheckpoint(s)).toBe("stop");
      expect(s.terminationStatus()).toEqual({ state: "pending", reason: "error" });
      expect(s.signal.reason).toBe("error");
    }
  });
  it("a cause latched elsewhere gives stop, also a lower one, and a finalized one", () => {
    const a = session(clockAt(0));
    a.raise("experiment_limit_reached");
    expect(deadlineCheckpoint(a)).toBe("stop");
    expect(a.terminationStatus()).toEqual({ state: "pending", reason: "experiment_limit_reached" });
    const b = session(clockAt(0));
    b.raise("isolation_violation");
    expect(deadlineCheckpoint(b)).toBe("stop");
    const c = session(clockAt(0));
    c.raise("iteration_limit_reached");
    c.finalize();
    expect(deadlineCheckpoint(c)).toBe("stop");
    expect(c.terminationStatus()).toEqual({ state: "finalized", reason: "iteration_limit_reached" });
  });
  it("reached after a latched error keeps error (U1 priority); reached after a lower limit upgrades it", () => {
    const c1 = clockAt(0);
    const s1 = session(c1, 5);
    s1.raise("error");
    c1.set(5_000);
    expect(deadlineCheckpoint(s1)).toBe("stop");
    expect(s1.terminationStatus()).toEqual({ state: "pending", reason: "error" });
    const c2 = clockAt(0);
    const s2 = session(c2, 5);
    s2.raise("experiment_limit_reached");
    c2.set(5_000);
    expect(deadlineCheckpoint(s2)).toBe("stop");
    expect(s2.terminationStatus()).toEqual({ state: "pending", reason: "time_limit_reached" });
  });
  it("never reads deadlineReached", () => {
    const c = clockAt(0);
    const s = session(c, 5);
    const reads: string[] = [];
    const guarded = new Proxy(s, {
      get(target, prop, receiver) {
        reads.push(String(prop));
        return Reflect.get(target, prop, receiver) as unknown;
      },
    });
    deadlineCheckpoint(guarded);
    c.set(5_000);
    deadlineCheckpoint(guarded);
    expect(reads).toContain("checkDeadline");
    expect(reads).not.toContain("deadlineReached");
  });
  it("never throws: a session whose check throws gives stop and raises error", () => {
    const raise = vi.fn();
    const hostile = {
      checkDeadline: () => {
        throw new Error("boom");
      },
      raise,
      terminationStatus: () => ({ state: "none" }),
    } as unknown as RunSession;
    expect(deadlineCheckpoint(hostile)).toBe("stop");
    expect(raise).toHaveBeenCalledWith("error");
  });
});

describe("armDeadlineTimer", () => {
  it("the first delay is the remaining time, never below MIN_REARM_MS", () => {
    const big = fakeTimers();
    arm(session(clockAt(0), 5), big.timers);
    expect(big.calls.map((e) => e.delay)).toEqual([5_000]);
    const c = clockAt(0);
    const s = session(c, 5);
    c.set(4_950); // 50 ms left
    const tiny = fakeTimers();
    arm(s, tiny.timers);
    expect(tiny.calls.map((e) => e.delay)).toEqual([100]);
  });
  it("an early fire with clock progress re-arms with the remaining time; the deadline then raises time_limit_reached and stops re-arming", () => {
    const c = clockAt(0);
    const s = session(c, 5);
    const t = fakeTimers();
    arm(s, t.timers);
    c.set(3_000);
    t.fireLast();
    expect(t.calls.map((e) => e.delay)).toEqual([5_000, 2_000]);
    expect(s.terminationStatus()).toEqual({ state: "none" });
    c.set(4_950);
    t.fireLast();
    expect(t.calls.map((e) => e.delay)).toEqual([5_000, 2_000, 100]);
    c.set(5_000);
    t.fireLast();
    expect(t.calls).toHaveLength(3);
    expect(s.terminationStatus()).toEqual({ state: "pending", reason: "time_limit_reached" });
    expect(s.signal.aborted).toBe(true);
    expect(s.signal.reason).toBe("time_limit_reached");
  });
  it("a clock fault at a fire raises error (never time_limit_reached), aborts, and does not re-arm", () => {
    const c = clockAt(0);
    const s = session(c, 5);
    const t = fakeTimers();
    arm(s, t.timers);
    c.set(Number.NaN);
    t.fireLast();
    expect(t.calls).toHaveLength(1);
    expect(s.terminationStatus()).toEqual({ state: "pending", reason: "error" });
    expect(s.signal.reason).toBe("error");
  });
  it("a fire after cancel() does nothing; cancel() is idempotent and cancels the current handle once", () => {
    const c = clockAt(0);
    const s = session(c, 5);
    const t = fakeTimers();
    const timer = arm(s, t.timers);
    c.set(1_000);
    t.fireLast(); // re-armed once
    timer.cancel();
    timer.cancel();
    expect(t.calls.map((e) => e.cancelled)).toEqual([0, 1]);
    c.set(5_000);
    t.fireLast();
    t.calls[0]?.fire();
    expect(t.calls).toHaveLength(2);
    expect(s.terminationStatus()).toEqual({ state: "none" });
  });
  it("a fire after finalize() does nothing", () => {
    const c = clockAt(0);
    const s = session(c, 5);
    const t = fakeTimers();
    arm(s, t.timers);
    s.raise("experiment_limit_reached");
    s.finalize();
    c.set(5_000);
    t.fireLast();
    expect(t.calls).toHaveLength(1);
    expect(s.terminationStatus()).toEqual({ state: "finalized", reason: "experiment_limit_reached" });
  });
  it("a throwing handle cancel is swallowed", () => {
    const t = fakeTimers({ cancelThrows: true });
    const timer = arm(session(clockAt(0)), t.timers);
    expect(() => timer.cancel()).not.toThrow();
    expect(t.calls[0]?.cancelled).toBe(1);
  });
  it("a first arm that throws, or that returns no handle with cancel, is reported to the caller and raises nothing", () => {
    for (const opts of [{ throwAt: 1 }, { noCancelFrom: 1 }] as const) {
      const s = session(clockAt(0));
      const r = armDeadlineTimer(s, fakeTimers(opts).timers);
      expect(r).toEqual({ ok: false, error: { code: "timer_unavailable" } });
      expect(s.terminationStatus()).toEqual({ state: "none" });
    }
  });
  it("a re-arm that throws, or that returns no handle with cancel, raises error", () => {
    for (const opts of [{ throwAt: 2 }, { noCancelFrom: 2 }] as const) {
      const c = clockAt(0);
      const s = session(c, 5);
      const t = fakeTimers(opts);
      arm(s, t.timers);
      c.set(1_000);
      t.fireLast();
      expect(s.terminationStatus(), JSON.stringify(opts)).toEqual({ state: "pending", reason: "error" });
      expect(s.signal.reason).toBe("error");
    }
  });
  it("a timer that fires synchronously inside schedule is detected by the no-progress rule: error, at most 2 schedule calls", () => {
    const s = session(clockAt(0), 5);
    const t = fakeTimers({ syncFire: true });
    const r = armDeadlineTimer(s, t.timers);
    expect(t.calls.length).toBeLessThanOrEqual(2);
    expect(s.terminationStatus()).toEqual({ state: "pending", reason: "error" });
    expect(r.ok).toBe(true); // the arm itself returned a handle; the caller sees the latched cause before it writes
  });
  it("a clock that does not move raises error at the first fire", () => {
    const s = session(clockAt(0), 5);
    const t = fakeTimers();
    arm(s, t.timers);
    t.fireLast();
    expect(t.calls).toHaveLength(1);
    expect(s.terminationStatus()).toEqual({ state: "pending", reason: "error" });
  });
  it("1000 early fires on a normally advancing clock never end in error: there is no count-based rule, and every delay is at least MIN_REARM_MS", () => {
    const c = clockAt(0);
    const s = session(c, 3600); // 3 600 000 ms; 1000 fires of 1 ms progress never reach it
    const t = fakeTimers();
    arm(s, t.timers);
    for (let i = 0; i < 1000; i++) {
      c.add(1);
      t.fireLast();
    }
    expect(s.terminationStatus()).toEqual({ state: "none" });
    expect(s.signal.aborted).toBe(false);
    expect(t.calls).toHaveLength(1001);
    for (const e of t.calls) {
      expect(Number.isInteger(e.delay)).toBe(true);
      expect(e.delay).toBeGreaterThanOrEqual(MIN_REARM_MS);
    }
    expect(t.calls.at(-1)?.delay).toBe(3_600_000 - 1000);
  });
  it("a timer raise never overwrites a higher-priority cause that is latched (U1 rule)", () => {
    const c = clockAt(0);
    const s = session(c, 5);
    const t = fakeTimers();
    arm(s, t.timers);
    s.raise("isolation_violation");
    c.set(5_000);
    t.fireLast();
    expect(s.terminationStatus()).toEqual({ state: "pending", reason: "isolation_violation" });
    expect(s.signal.reason).toBe("isolation_violation");
  });
  it("two timers of two sessions share nothing", () => {
    const ca = clockAt(0);
    const cb = clockAt(0);
    const a = session(ca, 5);
    const b = session(cb, 5);
    const ta = fakeTimers();
    const tb = fakeTimers();
    arm(a, ta.timers).cancel();
    arm(b, tb.timers);
    cb.set(5_000);
    ta.fireLast();
    tb.fireLast();
    expect(a.terminationStatus()).toEqual({ state: "none" });
    expect(b.terminationStatus()).toEqual({ state: "pending", reason: "time_limit_reached" });
  });
});
