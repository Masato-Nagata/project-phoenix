// Task 4.9-B: the production wall clock and timer port. No real waiting: the backend is a fake, and the one test of the global backend uses
// fake timers. Synthetic values only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TIMER_DELAY_MS, createTimerPort, createWallClock, type TimerBackend } from "../src/runtime/clocks.js";

class FakeBackend implements TimerBackend {
  readonly fires: (() => void)[] = [];
  readonly delays: number[] = [];
  readonly cleared: unknown[] = [];
  clearThrows = false;
  set(fire: () => void, delayMs: number): unknown {
    this.fires.push(fire);
    this.delays.push(delayMs);
    return this.fires.length - 1;
  }
  clear(handle: unknown): void {
    this.cleared.push(handle);
    if (this.clearThrows) throw new Error("clear failed");
  }
}

describe("wall clock", () => {
  it("gives an ISO 8601 UTC time with milliseconds", () => {
    expect(createWallClock(() => Date.UTC(2026, 0, 2, 3, 4, 5, 678)).nowIso()).toBe("2026-01-02T03:04:05.678Z");
  });
  it("uses Date.now by default and is a valid time", () => {
    const t = createWallClock().nowIso();
    expect(t).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(Number.isNaN(Date.parse(t))).toBe(false);
  });
  it("throws a RangeError with a fixed text for a clock that is not a finite number or is out of range", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, "1" as unknown as number, undefined as unknown as number, 8.64e15 + 1]) {
      const clock = createWallClock(() => bad);
      expect(() => clock.nowIso(), String(bad)).toThrow(RangeError);
    }
    expect(() => createWallClock(() => Number.NaN).nowIso()).toThrow("wall clock unavailable");
  });
  it("is frozen", () => {
    expect(Object.isFrozen(createWallClock())).toBe(true);
  });
});

describe("timer port with a fake backend", () => {
  it("fires once, then the timer is no longer active", () => {
    const b = new FakeBackend();
    const port = createTimerPort(b);
    let n = 0;
    port.schedule(250, () => (n += 1));
    expect(b.delays).toEqual([250]);
    expect(port.activeCount()).toBe(1);
    b.fires[0]?.();
    expect(n).toBe(1);
    expect(port.activeCount()).toBe(0);
    b.fires[0]?.(); // a second fire of the same timer does nothing
    expect(n).toBe(1);
  });

  it("cancel stops the timer, is idempotent, and makes a late fire inert", () => {
    const b = new FakeBackend();
    const port = createTimerPort(b);
    let n = 0;
    const h = port.schedule(10, () => (n += 1));
    h.cancel();
    h.cancel();
    expect(b.cleared).toEqual([0]); // cleared exactly once
    expect(port.activeCount()).toBe(0);
    b.fires[0]?.();
    expect(n).toBe(0);
  });

  it("cancel after the timer fired does not touch the backend", () => {
    const b = new FakeBackend();
    const port = createTimerPort(b);
    const h = port.schedule(10, () => undefined);
    b.fires[0]?.();
    h.cancel();
    expect(b.cleared).toEqual([]);
  });

  it("cancelAll cancels every pending timer and nothing else, and can be repeated", () => {
    const b = new FakeBackend();
    const port = createTimerPort(b);
    const fired: number[] = [];
    port.schedule(1, () => fired.push(1));
    port.schedule(2, () => fired.push(2));
    port.schedule(3, () => fired.push(3));
    b.fires[1]?.(); // the second one already fired
    expect(port.activeCount()).toBe(2);
    port.cancelAll();
    expect(port.activeCount()).toBe(0);
    expect(b.cleared.sort()).toEqual([0, 2]);
    port.cancelAll();
    expect(b.cleared).toHaveLength(2);
    b.fires[0]?.();
    b.fires[2]?.();
    expect(fired).toEqual([2]);
  });

  it("an exception of the callback is swallowed and the timer is finished", () => {
    const b = new FakeBackend();
    const port = createTimerPort(b);
    port.schedule(5, () => {
      throw new Error("callback failed");
    });
    expect(() => b.fires[0]?.()).not.toThrow();
    expect(port.activeCount()).toBe(0);
  });

  it("a throwing backend.clear does not make cancel throw", () => {
    const b = new FakeBackend();
    b.clearThrows = true;
    const port = createTimerPort(b);
    const h = port.schedule(5, () => undefined);
    expect(() => h.cancel()).not.toThrow();
    expect(port.activeCount()).toBe(0);
  });

  it("a backend that fires synchronously leaves nothing tracked", () => {
    let n = 0;
    const sync: TimerBackend = { set: (fire) => (fire(), 0), clear: () => undefined };
    const port = createTimerPort(sync);
    const h = port.schedule(0, () => (n += 1));
    expect(n).toBe(1);
    expect(port.activeCount()).toBe(0);
    expect(() => h.cancel()).not.toThrow();
  });

  it("accepts the delays 0 and MAX_TIMER_DELAY_MS and refuses every other value", () => {
    const b = new FakeBackend();
    const port = createTimerPort(b);
    port.schedule(0, () => undefined);
    port.schedule(MAX_TIMER_DELAY_MS, () => undefined);
    expect(b.delays).toEqual([0, MAX_TIMER_DELAY_MS]);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, MAX_TIMER_DELAY_MS + 1, "5" as unknown as number, undefined as unknown as number]) {
      expect(() => port.schedule(bad, () => undefined), String(bad)).toThrow(RangeError);
    }
    expect(() => port.schedule(5, "x" as unknown as () => void)).toThrow(TypeError);
    expect(b.delays).toHaveLength(2); // a refused call starts nothing
    expect(port.activeCount()).toBe(2);
  });

  it("timers do not share state: cancelling one leaves the others", () => {
    const b = new FakeBackend();
    const port = createTimerPort(b);
    const fired: string[] = [];
    const a = port.schedule(1, () => fired.push("a"));
    port.schedule(1, () => fired.push("b"));
    a.cancel();
    b.fires[0]?.();
    b.fires[1]?.();
    expect(fired).toEqual(["b"]);
  });
});

describe("timer port with the global backend (fake timers)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  it("fires after the delay and not before; a cancelled timer never fires", () => {
    vi.useFakeTimers();
    const port = createTimerPort();
    let fired = 0;
    let cancelled = 0;
    port.schedule(1000, () => (fired += 1));
    const c = port.schedule(1000, () => (cancelled += 1));
    c.cancel();
    vi.advanceTimersByTime(999);
    expect(fired).toBe(0);
    vi.advanceTimersByTime(1);
    expect(fired).toBe(1);
    expect(cancelled).toBe(0);
    expect(port.activeCount()).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancelAll leaves no timer in the process", () => {
    vi.useFakeTimers();
    const port = createTimerPort();
    port.schedule(5000, () => undefined);
    port.schedule(9000, () => undefined);
    expect(vi.getTimerCount()).toBe(2);
    port.cancelAll();
    expect(vi.getTimerCount()).toBe(0);
  });
});