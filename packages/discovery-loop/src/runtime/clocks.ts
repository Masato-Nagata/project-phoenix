// Production wall clock and timer port of the runtime (task 4.9-B). Both are the real adapters of the `wallClock` and `timers` ports of the
// Loop_Orchestrator; nothing else lives here.
//
// Wall clock. Used for the Run_Manifest `wallClock` field only (an excluded field). It is never a limit, a deadline or a lease; the monotonic
// clock of the verifier (`createSystemClock`) is the only clock for those. The text is an ISO 8601 UTC time with milliseconds. A clock that
// does not give a finite number, or a time outside the range of `Date`, throws a `RangeError` with a fixed text; the callers of the port
// already turn a throw into a refusal or an `error`.
//
// Timers. `schedule(delayMs, onFire)` starts ONE timer and returns `{ cancel }`. Rules:
//   - a delay that is not a finite number from 0 to MAX_TIMER_DELAY_MS throws (a larger value would make Node.js fire after 1 ms, which would
//     be an early fire that no caller expects); a callback that is not a function throws;
//   - `cancel` is idempotent, never throws, and after it a late fire does nothing;
//   - an exception of the callback is swallowed: a throw inside a timer would end the process before the Run is terminated and sealed;
//   - every pending timer is kept in one table until it fires or is cancelled, so `activeCount` shows a leak and `cancelAll` removes
//     everything that is left (the composition root calls it once after the Run, whatever the result);
//   - timers are NOT unreferenced: a Run that waits only for a timer must not end the process.
// The backend is injected so that tests need no real waiting; the default backend is the global `setTimeout` and `clearTimeout`.

/** The largest delay of a Node.js timer. */
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface WallClock {
  nowIso(): string;
}

/** `now` is injected for tests; the default is `Date.now`. */
export function createWallClock(now: () => number = Date.now): WallClock {
  return Object.freeze({
    nowIso: (): string => {
      const ms: unknown = now();
      if (typeof ms !== "number" || !Number.isFinite(ms)) throw new RangeError("wall clock unavailable");
      return new Date(ms).toISOString();
    },
  });
}

export interface TimerBackend {
  set(fire: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const GLOBAL_BACKEND: TimerBackend = Object.freeze({
  set: (fire: () => void, delayMs: number): unknown => setTimeout(fire, delayMs),
  clear: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
});

export interface ManagedTimerPort {
  schedule(delayMs: number, onFire: () => void): { cancel(): void };
  /** The number of timers that were started and have neither fired nor been cancelled. */
  activeCount(): number;
  /** Cancels every pending timer. Idempotent. */
  cancelAll(): void;
}

export function createTimerPort(backend: TimerBackend = GLOBAL_BACKEND): ManagedTimerPort {
  const pending = new Map<number, () => void>();
  let nextId = 0;

  const schedule = (delayMs: number, onFire: () => void): { cancel(): void } => {
    if (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0 || delayMs > MAX_TIMER_DELAY_MS) throw new RangeError("timer delay out of range");
    if (typeof onFire !== "function") throw new TypeError("timer callback is not a function");
    nextId += 1;
    const id = nextId;
    let done = false;
    let handle: unknown;
    const cancel = (): void => {
      if (done) return;
      done = true;
      pending.delete(id);
      try {
        backend.clear(handle);
      } catch {
        // cancel never throws; `done` already makes a late fire inert
      }
    };
    handle = backend.set(() => {
      if (done) return;
      done = true;
      pending.delete(id);
      try {
        onFire();
      } catch {
        // swallowed on purpose: see the header
      }
    }, delayMs);
    // a backend that fires synchronously has already set `done`: nothing is left to track
    if (!done) pending.set(id, cancel);
    return Object.freeze({ cancel });
  };

  return Object.freeze({
    schedule,
    activeCount: (): number => pending.size,
    cancelAll: (): void => {
      for (const cancel of [...pending.values()]) cancel();
    },
  });
}