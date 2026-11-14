// The real monotonic clock and sleeper of the runtime (task 2.15). `performance.now()` is monotonic: it does not follow the wall clock.
import type { MonotonicClock, Sleeper } from "./types.js";

export function createSystemClock(): MonotonicClock {
  return { nowMs: () => performance.now() };
}

/** Resolves after `ms`; rejects at once when the signal aborts. */
export function createSystemSleeper(): Sleeper {
  return {
    sleep(ms: number, signal?: AbortSignal): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted === true) return reject(new Error("aborted"));
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, Math.max(0, ms));
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
  };
}