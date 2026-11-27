// Replay support (task 4.7, step A2; R22.4, R22.5; human decisions D1 to D5 of 2026-11-27).
//
// What this module holds, and nothing else:
//   - the replay-only ports of the replay session: a FIXED monotonic clock, timers that NEVER fire, and a lease port that always answers
//     `valid`. They are not measurements and say nothing about the runtime guarantees of a Run (the result states `lease: not_measured`);
//   - the divergence cell: the first request-side or runner-side mismatch that a replay part noticed (closed codes and record ids only);
//   - the comparison of the regenerated records with the original (canonical form, hash and prevHash included, in order) and the closed
//     result types of the replay with the block that states what the replay does and does not guarantee.
// Pure: no I/O, no clock, no environment, no import of the orchestrator, the runtime adapters or a sibling package.

/** The value of the fixed monotonic clock of a replay session. */
export const REPLAY_CLOCK_MS = 0;

export interface FixedClock {
  nowMs(): number;
}
/** A monotonic clock that never advances: no deadline and no per-call limit of the replay can be reached by time. */
export function createFixedClock(): FixedClock {
  return Object.freeze({ nowMs: (): number => REPLAY_CLOCK_MS });
}

export interface SilentTimers {
  schedule(delayMs: number, onFire: () => void): { cancel(): void };
  /** How many timers were requested (for the tests); none of them ever fires. */
  scheduled(): number;
}
/** Timers that never fire. A clock-dependent end can therefore never be produced artificially during a replay. */
export function createSilentTimers(): SilentTimers {
  let count = 0;
  return Object.freeze({
    schedule(_delayMs: number, _onFire: () => void): { cancel(): void } {
      count += 1;
      return Object.freeze({ cancel: (): void => undefined });
    },
    scheduled: (): number => count,
  });
}

export interface ReplayLeasePort {
  check(options: unknown): Promise<{ readonly valid: true }>;
  /** How many checks were answered (for the tests). */
  checks(): number;
}
/**
 * The replay-only lease port. It always answers `valid`: a replay holds no Run_Lease and measures nothing about one. It is never injected into
 * a Run (the composition root of a Run, `main.ts`, cannot reach this module).
 */
export function createReplayLeasePort(): ReplayLeasePort {
  let count = 0;
  return Object.freeze({
    check: async (_options: unknown): Promise<{ readonly valid: true }> => {
      count += 1;
      return Object.freeze({ valid: true as const });
    },
    checks: (): number => count,
  });
}

// ---------------------------------------------------------------------------------------------
// The divergence cell
// ---------------------------------------------------------------------------------------------
/** A request-side mismatch: the regenerated request is not the recorded one (R22.5). The replay reports `diverged`. */
export const REQUEST_MISMATCH_CODES = Object.freeze([
  "request_not_buildable",
  "request_unexpected",
  "request_kind_mismatch",
  "request_hash_mismatch",
  "request_not_from_replay_audit",
  "request_attempt_mismatch",
  "request_order_mismatch",
] as const);
export type RequestMismatchCode = (typeof REQUEST_MISMATCH_CODES)[number];

/** A runner-side mismatch: the Experiment handed to the recorded Runner is not the recorded one. The replay reports `different`. */
export const RUNNER_MISMATCH_CODES = Object.freeze([
  "runner_unexpected_call",
  "runner_experiment_mismatch",
  "runner_decision_mismatch",
  "runner_not_accepted",
  "runner_observation_missing",
] as const);
export type RunnerMismatchCode = (typeof RUNNER_MISMATCH_CODES)[number];

export interface Mismatch {
  readonly side: "request" | "runner";
  readonly code: RequestMismatchCode | RunnerMismatchCode;
  /** The id of the recorded record the regenerated item was compared with (`payload_audit`, `ai_call` or `policy_decision`), when there is one. */
  readonly recordedRecordId?: string;
}

export interface DivergenceCell {
  noteRequest(code: RequestMismatchCode, recordedRecordId?: string): void;
  noteRunner(code: RunnerMismatchCode, recordedRecordId?: string): void;
  /** The FIRST mismatch noted; later ones are counted, never kept. */
  first(): Mismatch | undefined;
  count(): number;
}
export function createDivergenceCell(): DivergenceCell {
  let firstSeen: Mismatch | undefined;
  let n = 0;
  const note = (m: Mismatch): void => {
    n += 1;
    if (firstSeen === undefined) firstSeen = Object.freeze(m);
  };
  return Object.freeze({
    noteRequest: (code: RequestMismatchCode, recordedRecordId?: string): void =>
      note(recordedRecordId === undefined ? { side: "request", code } : { side: "request", code, recordedRecordId }),
    noteRunner: (code: RunnerMismatchCode, recordedRecordId?: string): void =>
      note(recordedRecordId === undefined ? { side: "runner", code } : { side: "runner", code, recordedRecordId }),
    first: (): Mismatch | undefined => firstSeen,
    count: (): number => n,
  });
}

// ---------------------------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------------------------
/** What a replay does and does not do (human decision of 2026-11-27, section 12). A constant: it is the same for every result. */
export const REPLAY_GUARANTEES = Object.freeze({
  context: "copied_inputs",
  providerRequest: "regenerated_hash_compared",
  providerResponse: "recorded",
  observation: "recorded",
  policy: "reevaluated",
  comparator: "reexecuted",
  audit: "reused_not_reexecuted",
  sourceBundler: "not_reexecuted",
  allowlist: "not_reverified",
  lease: "not_measured",
  isolation: "not_measured",
  legacy: "no_new_experiment",
  realAi: "not_called",
} as const);
export type ReplayGuarantees = typeof REPLAY_GUARANTEES;

/** Why a replay was not carried out. Decided from the original Run and the inputs only, before anything is regenerated. */
export const REPLAY_INCOMPLETE_REASONS = Object.freeze([
  "run_not_accepted",
  "excluded_fields_contract",
  "cache_limit_exceeded",
  "run_changed_during_verification",
  "records_invalid",
  "manifest_invalid",
  "provider_not_mock",
  "termination_invalid",
  "termination_not_replayable",
  "record_kind_not_replayable",
  "leading_records_unexpected",
  "request_bytes_withheld",
  "provider_outcome_not_restorable",
  "observation_not_restorable",
  "references_invalid",
  "audit_records_inconsistent",
  "source_bundle_not_restorable",
  "source_bundle_inconsistent",
  "template_inconsistent",
  "external_input_missing",
  "external_input_too_large",
  "external_input_invalid",
  "external_input_hash_mismatch",
  "policy_decision_hash_mismatch",
] as const);
export type ReplayIncompleteReason = (typeof REPLAY_INCOMPLETE_REASONS)[number];

export type ReplayDifference = "content" | "only_in_original" | "only_in_replay" | "termination_reason" | "replay_source_mismatch" | "recorded_data_unconsumed";

export type ReplayRunResult =
  | { readonly result: "identical"; readonly records: number; readonly regenerated: number; readonly terminationReason: string; readonly guarantees: ReplayGuarantees }
  | {
      readonly result: "different";
      readonly firstDifferingRecord: string;
      readonly difference: ReplayDifference;
      readonly cause?: RunnerMismatchCode | "unconsumed_audits" | "unconsumed_responses" | "unconsumed_observations" | "context_record_mismatch";
      readonly guarantees: ReplayGuarantees;
    }
  | {
      readonly result: "diverged";
      readonly firstDifferingRecord: string;
      readonly cause: RequestMismatchCode;
      /** The recorded request record (`payload_audit` or `ai_call`) whose hash the regenerated request did not match, when there is one. */
      readonly recordedRequestRecord?: string;
      readonly guarantees: ReplayGuarantees;
    }
  | { readonly result: "incomplete"; readonly reason: ReplayIncompleteReason; readonly detail?: string };

export const recordIdOf = (index: number): string => `rec-${String(index + 1).padStart(6, "0")}`;

export interface SequenceDifference {
  readonly index: number;
  readonly difference: "content" | "only_in_original" | "only_in_replay";
}
/**
 * The first index from `from` on at which the canonical records differ, or that exists in only one of the two sequences. `original` is the
 * original Run WITHOUT its `termination` record; `regenerated` is everything the replay store holds. `undefined` when they are equal.
 */
export function firstSequenceDifference(original: readonly string[], regenerated: readonly string[], from: number): SequenceDifference | undefined {
  const common = Math.min(original.length, regenerated.length);
  for (let i = from; i < common; i += 1) if (original[i] !== regenerated[i]) return { index: i, difference: "content" };
  if (original.length > common && original.length > from) return { index: Math.max(common, from), difference: "only_in_original" };
  if (regenerated.length > common && regenerated.length > from) return { index: Math.max(common, from), difference: "only_in_replay" };
  return undefined;
}

export interface Classification {
  readonly original: readonly string[];
  readonly regenerated: readonly string[];
  /** The number of leading records that were copied as inputs (D5: 3). */
  readonly copied: number;
  readonly originalTermination: { readonly index: number; readonly reason: string };
  readonly replayTermination: string;
  readonly mismatch: Mismatch | undefined;
  readonly unconsumed: { readonly audits: number; readonly responses: number; readonly observations: number };
}
/**
 * The closed classification (D1, D5; R22.4, R22.5): a request-side mismatch is `diverged` with the first differing record; otherwise any
 * difference of the regenerated records, of the termination reason, a runner-side mismatch, or recorded data that the replay did not use is
 * `different`; else `identical`. A mismatch found after the replay started is never reported as `incomplete`.
 */
export function classifyReplay(c: Classification): ReplayRunResult {
  const g = REPLAY_GUARANTEES;
  const diff = firstSequenceDifference(c.original, c.regenerated, c.copied);
  const firstId = (fallback: number): string => recordIdOf(diff === undefined ? fallback : diff.index);
  const m = c.mismatch;
  if (m !== undefined && m.side === "request") {
    return Object.freeze({
      result: "diverged" as const,
      firstDifferingRecord: firstId(c.regenerated.length),
      cause: m.code as RequestMismatchCode,
      ...(m.recordedRecordId === undefined ? {} : { recordedRequestRecord: m.recordedRecordId }),
      guarantees: g,
    });
  }
  const runnerCause = m !== undefined && m.side === "runner" ? (m.code as RunnerMismatchCode) : undefined;
  if (diff !== undefined) {
    return Object.freeze({
      result: "different" as const,
      firstDifferingRecord: recordIdOf(diff.index),
      difference: diff.difference,
      ...(runnerCause === undefined ? {} : { cause: runnerCause }),
      guarantees: g,
    });
  }
  if (c.replayTermination !== c.originalTermination.reason) {
    return Object.freeze({ result: "different" as const, firstDifferingRecord: recordIdOf(c.originalTermination.index), difference: "termination_reason" as const, guarantees: g });
  }
  if (runnerCause !== undefined) {
    return Object.freeze({ result: "different" as const, firstDifferingRecord: recordIdOf(c.originalTermination.index), difference: "replay_source_mismatch" as const, cause: runnerCause, guarantees: g });
  }
  const u = c.unconsumed;
  const unconsumed = u.audits > 0 ? "unconsumed_audits" : u.responses > 0 ? "unconsumed_responses" : u.observations > 0 ? "unconsumed_observations" : undefined;
  if (unconsumed !== undefined) {
    return Object.freeze({ result: "different" as const, firstDifferingRecord: recordIdOf(c.originalTermination.index), difference: "recorded_data_unconsumed" as const, cause: unconsumed, guarantees: g });
  }
  return Object.freeze({
    result: "identical" as const,
    records: c.original.length + 1,
    regenerated: c.regenerated.length - c.copied,
    terminationReason: c.replayTermination,
    guarantees: g,
  });
}
