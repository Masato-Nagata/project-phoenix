// RunSession of the Loop_Orchestrator (task 4.4, unit U1; R11.9, R11.12, R11.16, R11.17, R15.6, R24.12, R24.15).
//
// One session per Run, built by a factory; there is no module-level mutable state, so two sessions share nothing. It holds numbers, booleans,
// reason strings and one AbortController, and nothing else: no secret, raw path, provider response text, approval, lease or payload.
//
// Clock: the session takes the MONOTONIC clock port only. It reads it once at creation (`startedAtMs`) and then at `checkDeadline()`,
// `deadlineReached()` and `remainingMs()`. It uses no other clock and no timer. Starting and cancelling the deadline timer is unit U4's job.
//
// Clock fault (task 4.4 unit U1; R11.12, R11.17): a clock that throws, or returns a value that is not a finite number, after creation is a
// FAULT. It is latched in one private boolean the first time any method sees it, and it stays: later normal readings do not undo it. A fault is
// not "deadline reached": it means the deadline can no longer be enforced. U4 contract: `checkDeadline()` returns "ok", "reached" or
// "clock_fault"; `reached` -> the caller calls `session.raise("time_limit_reached")`; `clock_fault` -> the caller calls `session.raise("error")`
// and ends the Run at once with `error` (it must not continue working: a clock fault means the deadline can no longer be enforced); `ok` ->
// continue. A clock fault is never classified as `time_limit_reached`. The session itself never raises or aborts because of a clock fault.
//
// Abort: the session owns an AbortController; only the signal is public. A raise that latches or upgrades a cause in `ABORTING_REASONS` aborts
// the controller ONCE, with the reason string as the abort reason (never a message). The other reasons occur between calls, or must let
// accepted Experiments finish (`experiment_limit_reached`, R11.9), so they never abort. Once the latch is finalized nothing aborts any more.
// `signal.reason` is the FIRST aborting reason; the final termination reason is always the one of `terminationStatus()` / `finalize()`.
// The signal is meant for the Runner `execute(e, id, signal, ...)`, the provider `complete(req, { timeoutMs, signal })` and the lease check.
import type { Result } from "../schema/types.js";
import { createTerminationLatch, type Attribution, type FinalizeResult, type RaiseOutcome, type Symptom, type TerminationStatus } from "./terminationLatch.js";
import type { ManifestCore, MonotonicClockPort, TerminationReason } from "./types.js";

/** Reasons that abort the shared signal: a stop of the whole Run. Every other reason lets the work in flight finish or happens between calls. */
export const ABORTING_REASONS: readonly TerminationReason[] = Object.freeze([
  "isolation_violation",
  "launcher_killed",
  "lease_unavailable",
  "error",
  "time_limit_reached",
] as const);

// Stage A range of `limits.runSeconds` (`RUN_LIMITS.runSeconds` in `config/limits.ts`: min 1, max 3600, default 1800). A copy, so that this
// file imports nothing but the orchestrator types and the schema types.
const RUN_SECONDS_MIN = 1;
const RUN_SECONDS_MAX = 3600;

export interface RunSessionOptions {
  readonly clock: MonotonicClockPort;
  /** A safe integer from 1 to 3600. */
  readonly runSeconds: number;
}

export interface RunSession {
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly signal: AbortSignal;
  /** true after `markStarted()` (the `run_started` record was written; set by U4/U7). */
  readonly started: boolean;
  readonly iterationCount: number;
  readonly experimentCount: number;
  readonly policyRejectionCount: number;
  readonly providerRetryCount: number;
  /**
   * The one deadline test U4 must use. Reads the monotonic clock and returns:
   *   "clock_fault"  the clock threw or returned a value that is not a finite number, now or earlier. The fault is latched: the result never
   *                  goes back to "ok" or "reached", even when the clock later returns normal values. A fault wins over everything else.
   *   "reached"      no fault and `t >= deadlineAtMs`.
   *   "ok"           no fault and `t < deadlineAtMs`.
   * U4 contract: `reached` -> the caller calls `session.raise("time_limit_reached")`; `clock_fault` -> the caller calls `session.raise("error")`
   * and ends the Run at once with `error` (it must not continue working: a clock fault means the deadline can no longer be enforced); `ok` ->
   * continue. A clock fault is never classified as `time_limit_reached`. This method never raises, never aborts and never throws.
   */
  checkDeadline(): "ok" | "reached" | "clock_fault";
  /**
   * true ONLY for a normal (non-faulty) reading with `t >= deadlineAtMs`; false on a clock fault, current or latched. This value alone is NOT
   * safe to drive the Run: a fault looks like "not reached". U4 must use `checkDeadline()`, not this method, as its deadline test.
   */
  deadlineReached(): boolean;
  /** Milliseconds to the deadline, never negative; 0 whenever a clock fault is current or latched (also if the clock recovers). */
  remainingMs(): number;
  noteIteration(): void;
  noteAcceptedExperiment(): void;
  noteRejectedExperiment(): void;
  noteProviderRetry(): void;
  /** The counters for the Manifest core. Frozen. */
  limitsUsed(): ManifestCore["limitsUsed"];
  markStarted(): void;
  raise(reason: TerminationReason): RaiseOutcome;
  attributeSymptom(symptom: Symptom): Attribution;
  finalize(): FinalizeResult;
  terminationStatus(): TerminationStatus;
}

export interface InvalidSessionOptions {
  readonly code: "invalid_options";
}

const invalid = (): Result<RunSession, InvalidSessionOptions> => ({ ok: false, error: Object.freeze({ code: "invalid_options" as const }) });

/** Never throws. An invalid `runSeconds`, a missing or invalid clock, a clock that throws or returns a non-finite number, or unsafe arithmetic gives `invalid_options`. */
export function createRunSession(opts: RunSessionOptions): Result<RunSession, InvalidSessionOptions> {
  try {
    if (typeof opts !== "object" || opts === null) return invalid();
    const clock = opts.clock;
    const runSeconds = opts.runSeconds;
    if (typeof runSeconds !== "number" || !Number.isSafeInteger(runSeconds) || runSeconds < RUN_SECONDS_MIN || runSeconds > RUN_SECONDS_MAX) return invalid();
    if (typeof clock !== "object" || clock === null || typeof clock.nowMs !== "function") return invalid();
    const startedAtMs: unknown = clock.nowMs();
    if (typeof startedAtMs !== "number" || !Number.isFinite(startedAtMs)) return invalid();
    const deadlineAtMs = startedAtMs + runSeconds * 1000;
    if (!Number.isFinite(deadlineAtMs) || Math.abs(deadlineAtMs) > Number.MAX_SAFE_INTEGER) return invalid();
    return { ok: true, value: build(clock, startedAtMs, deadlineAtMs) };
  } catch {
    return invalid();
  }
}

function build(clock: MonotonicClockPort, startedAtMs: number, deadlineAtMs: number): RunSession {
  const latch = createTerminationLatch();
  const controller = new AbortController();
  let aborted = false;
  let started = false;
  let iterations = 0;
  let accepted = 0;
  let rejected = 0;
  let retries = 0;

  // Latched the first time a reading is not a finite number (or the clock throws); never reset. Shared by the three deadline methods.
  let clockFault = false;

  /** A finite reading, or undefined on a fault (current or latched). After a fault the clock is not read again. */
  const now = (): number | undefined => {
    if (clockFault) return undefined;
    try {
      const t: unknown = clock.nowMs();
      if (typeof t === "number" && Number.isFinite(t)) return t;
    } catch {
      // handled below: a throwing clock is a fault
    }
    clockFault = true;
    return undefined;
  };

  // Aborts once, and only while the latch is pending with an aborting reason. After `finalize()` the state is not pending, so nothing aborts.
  const abortIfNeeded = (): void => {
    const s = latch.status();
    if (s.state !== "pending" || aborted || !ABORTING_REASONS.includes(s.reason)) return;
    aborted = true;
    controller.abort(s.reason);
  };

  const view: RunSession = {
    startedAtMs,
    deadlineAtMs,
    signal: controller.signal,
    get started(): boolean {
      return started;
    },
    get iterationCount(): number {
      return iterations;
    },
    get experimentCount(): number {
      return accepted;
    },
    get policyRejectionCount(): number {
      return rejected;
    },
    get providerRetryCount(): number {
      return retries;
    },
    checkDeadline(): "ok" | "reached" | "clock_fault" {
      const t = now();
      if (t === undefined) return "clock_fault";
      return t >= deadlineAtMs ? "reached" : "ok";
    },
    deadlineReached(): boolean {
      const t = now();
      return t !== undefined && t >= deadlineAtMs;
    },
    remainingMs(): number {
      const t = now();
      return t === undefined ? 0 : Math.max(0, deadlineAtMs - t);
    },
    noteIteration(): void {
      iterations += 1;
    },
    noteAcceptedExperiment(): void {
      accepted += 1;
    },
    noteRejectedExperiment(): void {
      rejected += 1;
    },
    noteProviderRetry(): void {
      retries += 1;
    },
    limitsUsed(): ManifestCore["limitsUsed"] {
      return Object.freeze({ iterations, acceptedExperiments: accepted, rejectedExperiments: rejected });
    },
    markStarted(): void {
      started = true;
    },
    raise(reason: TerminationReason): RaiseOutcome {
      const outcome = latch.raise(reason);
      if (outcome !== "ignored_not_higher" && outcome !== "ignored_finalized") abortIfNeeded();
      return outcome;
    },
    attributeSymptom(symptom: Symptom): Attribution {
      const attribution = latch.attributeSymptom(symptom);
      if (!attribution.classified) abortIfNeeded();
      return attribution;
    },
    finalize(): FinalizeResult {
      return latch.finalize();
    },
    terminationStatus(): TerminationStatus {
      return latch.status();
    },
  };
  return Object.freeze(view);
}
