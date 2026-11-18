// Termination latch of the Loop_Orchestrator (task 4.4, unit U1; R11.9, R11.12, R11.16, R11.17, R15.6, R24.12, R24.15).
//
// A Run ends with exactly ONE termination reason. Several causes can be detected during a Run (an isolation violation while a limit is being
// checked, a stale heartbeat while the deadline passes, ...). The latch keeps one reason and decides, by a fixed priority, which one stays.
// It is pure and synchronous: no I/O, no clock, no timer, no shared module state. It holds reason strings and the state, nothing else (no
// payload, path, message or secret).
//
// Fallback `error` (task 4.4 unit U1; R11.12, R11.17): an `error` that was latched ONLY as the safe-side answer to an unexplained symptom, or to a
// value that is not a termination reason, is not a found cause. The latch keeps one private boolean for it (nothing about the symptom or the bad
// value is stored). While that boolean is set, `attributeSymptom` keeps returning `classified: false`, however often it is called. The boolean is
// cleared only by an explicit, valid `raise("error")` while the latch is pending, or when a strictly higher cause replaces the `error`. After
// `finalize()` the boolean is frozen like the reason.
//
// States:
//   none       no cause has been raised yet
//   pending    a cause is latched; a strictly HIGHER priority cause may still replace it
//   finalized  frozen. The reason can never change again. This holds whatever happens afterwards; in particular a failed write of the
//              `termination` record must not change a finalized reason (the writer reports its failure by raising `error`, which is
//              then ignored). Finalizing happens when the termination record is about to be written (U2).
//
// Priority (human decision, highest first; the two limits of the last group have the SAME rank, and the first one detected stays):
//   1 isolation_violation  2 launcher_killed  3 lease_unavailable  4 error  5 time_limit_reached  6 payload_audit_blocked
//   7 provider_failure  8 policy_rejection_limit  9 no_further_experiments  10 experiment_limit_reached = iteration_limit_reached
import type { Result } from "../schema/types.js";
import { TERMINATION_REASONS, type TerminationReason } from "./types.js";

/** Rank groups, highest priority first. Index 0 is the highest priority. Every termination reason appears exactly once. */
export const TERMINATION_PRIORITY: readonly (readonly TerminationReason[])[] = Object.freeze([
  Object.freeze(["isolation_violation"] as const),
  Object.freeze(["launcher_killed"] as const),
  Object.freeze(["lease_unavailable"] as const),
  Object.freeze(["error"] as const),
  Object.freeze(["time_limit_reached"] as const),
  Object.freeze(["payload_audit_blocked"] as const),
  Object.freeze(["provider_failure"] as const),
  Object.freeze(["policy_rejection_limit"] as const),
  Object.freeze(["no_further_experiments"] as const),
  Object.freeze(["experiment_limit_reached", "iteration_limit_reached"] as const),
]);

// A `Record` over the closed union: leaving a reason out is a compile error. A test pins it to `TERMINATION_PRIORITY`.
const RANK: Readonly<Record<TerminationReason, number>> = Object.freeze({
  isolation_violation: 0,
  launcher_killed: 1,
  lease_unavailable: 2,
  error: 3,
  time_limit_reached: 4,
  payload_audit_blocked: 5,
  provider_failure: 6,
  policy_rejection_limit: 7,
  no_further_experiments: 8,
  experiment_limit_reached: 9,
  iteration_limit_reached: 9,
});

/** 0 is the highest priority. `experiment_limit_reached` and `iteration_limit_reached` have the same rank. */
export function rankOf(reason: TerminationReason): number {
  return RANK[reason];
}

const isReason = (v: unknown): v is TerminationReason => typeof v === "string" && (TERMINATION_REASONS as readonly string[]).includes(v);

/**
 * Observable signs of an interruption. They are SYMPTOMS, never termination reasons: no value of this list is in `TERMINATION_REASONS`.
 * `interrupted` and `forced_stop` mirror a Runner outcome with status `interrupted` (cause `forced_stop`); `lease_check_interrupted` mirrors a
 * `LeaseCheckInterrupted` (`why` is `aborted` or `deadline`); `timeout` is a deadline expiry that was observed without a latched cause.
 */
export const SYMPTOMS = Object.freeze(["interrupted", "forced_stop", "timeout", "lease_check_interrupted"] as const);
export type Symptom = (typeof SYMPTOMS)[number];

/**
 * What `raise` did.
 *   latched / upgraded                       the reason is now the pending reason
 *   latched_invalid_reason / upgraded_invalid_reason   the argument was not a termination reason (a defect); `error` was raised instead
 *   ignored_not_higher                       same or lower priority than the pending reason (also the same reason twice, and the other limit of the last rank)
 *   ignored_finalized                        the latch is finalized
 * An invalid reason whose `error` is not higher than the pending reason, or that arrives after finalization, reports the plain `ignored_*` outcome.
 */
export type RaiseOutcome = "latched" | "upgraded" | "latched_invalid_reason" | "upgraded_invalid_reason" | "ignored_not_higher" | "ignored_finalized";

export type TerminationStatus =
  | { readonly state: "none" }
  | { readonly state: "pending"; readonly reason: TerminationReason }
  | { readonly state: "finalized"; readonly reason: TerminationReason };

export interface Attribution {
  readonly reason: TerminationReason;
  /**
   * true: a real cause explains the symptom. false: the current reason is an `error` that was only the fallback for an unexplained symptom or
   * an invalid reason value (the Run ends with `error`); this stays false on every later call until a real cause replaces or confirms it.
   */
  readonly classified: boolean;
}

export type FinalizeResult = Result<{ readonly reason: TerminationReason; readonly alreadyFinalized: boolean }, { readonly code: "no_cause" }>;

export interface TerminationLatch {
  /**
   * Raises a cause. The first cause is latched; a strictly higher priority replaces a pending one; the same or a lower priority is ignored (for
   * the same rank the FIRST detected stays). A value that is not a termination reason is a defect: it latches `error` (fail closed), is never
   * stored or echoed, and `raise` never throws. After `finalize()` every raise is ignored.
   */
  raise(reason: TerminationReason): RaiseOutcome;
  status(): TerminationStatus;
  /**
   * Freezes the pending reason. Idempotent: a second call returns the same reason with `alreadyFinalized: true`. With no cause latched it
   * returns `no_cause` and the state stays `none`; it never invents a reason.
   */
  finalize(): FinalizeResult;
  /**
   * Explains an interruption symptom with the cause that is already latched (pending or finalized) and changes nothing.
   * If NO cause exists it does not guess: it raises `error` as a fallback (an interruption that nobody can explain is a defect) and returns
   * `{ reason: "error", classified: false }`. Every later call, while that fallback `error` is current (pending or finalized), returns
   * `classified: false` again and changes nothing. The result becomes `classified: true` only when an explicit `raise("error")` confirms the
   * cause while pending, or when a strictly higher cause replaces the fallback. A real cause (also an explicit `error`) gives `classified: true`.
   *
   * It is for interruptions caused by an abort or by the Run deadline (a Runner `interrupted` / `forced_stop`, a `LeaseCheckInterrupted`).
   * It is NOT for a per-call provider `timeout`: that is an ordinary failed call counted under the retry limit (unit U5). A Runner
   * `interrupted` with `fatal: true` carries an explicit cause: the CALLER raises `error` with `raise("error")` before attributing.
   * A symptom is never stored and never becomes a reason.
   */
  attributeSymptom(symptom: Symptom): Attribution;
}

const NONE: TerminationStatus = Object.freeze({ state: "none" as const });
const NO_CAUSE: FinalizeResult = Object.freeze({ ok: false as const, error: Object.freeze({ code: "no_cause" as const }) });

export function createTerminationLatch(): TerminationLatch {
  let state: "none" | "pending" | "finalized" = "none";
  let current: TerminationReason | undefined;
  // true: the current `error` was latched only as the fallback of an unexplained symptom or of an invalid reason value. Never true for another reason.
  let errorIsFallback = false;

  // `fallback` is true when the `error` is raised by the latch itself (unexplained symptom, invalid value), false for a caller's valid reason.
  const apply = (r: TerminationReason, invalid: boolean, fallback: boolean): RaiseOutcome => {
    if (state === "finalized") return "ignored_finalized";
    if (current === undefined) {
      current = r;
      state = "pending";
      errorIsFallback = fallback;
      return invalid ? "latched_invalid_reason" : "latched";
    }
    if (rankOf(r) < rankOf(current)) {
      current = r;
      errorIsFallback = fallback;
      return invalid ? "upgraded_invalid_reason" : "upgraded";
    }
    // An explicit valid `error` on top of the pending fallback `error` confirms the cause. The outcome stays the plain ignore.
    if (!fallback && r === "error" && current === "error") errorIsFallback = false;
    return "ignored_not_higher";
  };

  return Object.freeze({
    raise(reason: TerminationReason): RaiseOutcome {
      if (isReason(reason)) return apply(reason, false, false);
      return apply("error", true, true);
    },
    status(): TerminationStatus {
      if (current === undefined || state === "none") return NONE;
      return Object.freeze({ state, reason: current });
    },
    finalize(): FinalizeResult {
      if (current === undefined) return NO_CAUSE;
      const alreadyFinalized = state === "finalized";
      state = "finalized";
      return Object.freeze({ ok: true as const, value: Object.freeze({ reason: current, alreadyFinalized }) });
    },
    attributeSymptom(_symptom: Symptom): Attribution {
      void _symptom;
      if (current !== undefined) return Object.freeze({ reason: current, classified: !(current === "error" && errorIsFallback) });
      apply("error", false, true);
      return Object.freeze({ reason: "error" as const, classified: false });
    },
  });
}
