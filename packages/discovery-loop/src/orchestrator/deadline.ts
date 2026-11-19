// Deadline checkpoint and deadline timer of the Loop_Orchestrator (task 4.4, unit U4; R11.12, R11.17).
//
// THE ONE DEADLINE TEST. Every deadline decision uses `session.checkDeadline()` and nothing else. `reached` raises `time_limit_reached`;
// `clock_fault` raises `error` (a deadline that can no longer be enforced is never classified as `time_limit_reached`). The boolean
// `deadlineReached` of the session is not used here: it is false during a clock fault, so on its own it would let a faulty clock pass as
// "not reached". Raising either reason aborts `session.signal` (U1), which is the signal that the Runner, the provider call and the lease
// check receive: that is the interruption of the work in flight.
//
// THE TIMER. `armDeadlineTimer` schedules a callback on the injected `TimerPort` (a duration on the monotonic clock). On each fire:
//   - cancelled, or the session is finalized: nothing at all;
//   - `reached`: raise `time_limit_reached`, no re-arm;   `clock_fault`: raise `error`, no re-arm;
//   - `ok` (an early fire): the monotonic clock must have advanced across the wait (the port contract: the delay is a duration on that clock,
//     and every wait is at least `MIN_REARM_MS`). No progress at all (`remainingMs` did not decrease: a frozen clock, or a timer that fires
//     synchronously inside `schedule`) means the deadline cannot be enforced: raise `error`. Otherwise re-arm with the remaining time.
//   - a re-arm that throws or returns no usable handle: raise `error`. A first arm that fails is reported to the caller instead.
// There is NO count of fires and NO ratio between the clock progress and the requested delay: a Run is never ended with `error` only because
// a timer fired early many times while the monotonic clock advances normally (human decision of task 4.4 unit U4).
//
// KNOWN LIMIT (not hidden, needs a human decision). If the monotonic clock advances but much more slowly than the timer waits, or a timer
// repeatedly fires early by a large but positive amount, the existing contracts give no tolerance to tell this from normal operation. The
// timer then keeps re-arming (each wait is at least `MIN_REARM_MS`, so there is no busy loop) and the Run is bounded only by the monotonic
// clock. A tolerance, or an independent real-time reference, would need a decision; it is not invented here.
//
// No wall clock and no timer of the platform is used here: only the session (monotonic clock) and the injected `TimerPort`.
import type { Result } from "../schema/types.js";
import type { RunSession } from "./session.js";
import type { TimerPort } from "./types.js";

/** The shortest wait of the deadline timer, in milliseconds. */
export const MIN_REARM_MS = 100;

/**
 * `continue` when no cause is latched after the check; `stop` when a cause is latched or finalized (from this check or from anywhere else).
 * Never throws: a failure of the check itself raises `error`.
 */
export function deadlineCheckpoint(session: RunSession): "continue" | "stop" {
  try {
    const c = session.checkDeadline();
    if (c === "reached") session.raise("time_limit_reached");
    else if (c !== "ok") session.raise("error"); // `clock_fault`, and any answer that is not one of the three: fail closed
    return session.terminationStatus().state === "none" ? "continue" : "stop";
  } catch {
    try {
      session.raise("error");
    } catch {
      // nothing more can be done; the caller stops
    }
    return "stop";
  }
}

export interface DeadlineTimer {
  /** Idempotent. After it, a late fire does nothing and nothing is re-armed. */
  cancel(): void;
}

type Handle = { cancel(): void };

const delayFor = (remaining: number): number => (Number.isFinite(remaining) ? Math.max(MIN_REARM_MS, Math.ceil(remaining)) : MIN_REARM_MS);

const isHandle = (h: unknown): h is Handle => {
  try {
    return typeof h === "object" && h !== null && typeof (h as { cancel?: unknown }).cancel === "function";
  } catch {
    return false;
  }
};

/** Arms the deadline timer of a Run. A first arm that fails is an error result (the caller refuses the start); nothing is raised for it. */
export function armDeadlineTimer(session: RunSession, timers: TimerPort): Result<DeadlineTimer, { readonly code: "timer_unavailable" }> {
  let cancelled = false;
  let handle: Handle | undefined;
  let before = 0; // `remainingMs()` read right before the `schedule` call that produced the current wait
  let generation = 0; // a fire of an older wait is stale

  const raiseError = (): void => {
    try {
      session.raise("error");
    } catch {
      // the session never throws; nothing more can be done
    }
  };

  /** One `schedule` call. `before` is stored BEFORE the call, so a fire inside `schedule` sees it. */
  const arm = (): boolean => {
    try {
      const remaining = session.remainingMs();
      before = remaining;
      generation += 1;
      const mine = generation;
      const h: unknown = timers.schedule(delayFor(remaining), () => fire(mine));
      if (!isHandle(h)) return false;
      if (generation === mine) handle = h; // a synchronous fire may already have armed a newer wait
      return true;
    } catch {
      return false;
    }
  };

  const fire = (mine: number): void => {
    try {
      if (cancelled || mine !== generation) return;
      if (session.terminationStatus().state === "finalized") return;
      const c = session.checkDeadline();
      if (c === "reached") {
        session.raise("time_limit_reached");
        return;
      }
      if (c !== "ok") {
        session.raise("error");
        return;
      }
      const now = session.remainingMs();
      if (!(now < before)) {
        session.raise("error"); // no progress of the monotonic clock across a wait: the deadline cannot be enforced
        return;
      }
      if (!arm()) raiseError();
    } catch {
      raiseError();
    }
  };

  if (!arm()) {
    cancelled = true;
    return { ok: false, error: Object.freeze({ code: "timer_unavailable" as const }) };
  }
  return {
    ok: true,
    value: Object.freeze({
      cancel(): void {
        cancelled = true;
        const h = handle;
        handle = undefined;
        if (h === undefined) return;
        try {
          h.cancel();
        } catch {
          // a throwing cancel of the port changes nothing: the cancelled flag already makes every later fire inert
        }
      },
    }),
  };
}
