// Types of the masking and the Comparator (design: "Comparator Masking", "Masking decisions (OD-7, C2-1 to C2-6)";
// R10; tasks 2.12 to 2.14). The record shapes follow the M1 schemas `prediction`, `observation`, and `comparison-result`.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/**
 * The paths whose values are replaced by the mask token. The token itself is not a setting: it is the constant
 * `MASK_TOKEN` (C2-1), so a configuration cannot change it.
 */
export interface MaskConfig {
  readonly paths: readonly string[];
}

export interface PredictedField {
  readonly path: string;
  readonly value: Json;
}

/** M1 schema `prediction`. */
export interface Prediction {
  readonly target: { readonly list: "requests" | "stateChecks"; readonly index: number };
  readonly status: number;
  readonly fields: readonly PredictedField[];
}

export interface ObservedResponse {
  readonly status: number;
  readonly bodyKind: "json" | "text" | "empty";
  readonly body?: Json;
}

/** M1 schema `observation` (the parts the Comparator reads). */
export interface Observation {
  readonly experimentId: string;
  readonly outcome: "executed" | "timed_out" | "aborted" | "not_executed";
  readonly responses: readonly ObservedResponse[];
  readonly stateChecks: readonly ObservedResponse[];
  readonly maskSha256: string;
}

export type NotComparableReason =
  | "not_executed"
  | "timed_out"
  | "aborted"
  | "prediction_missing"
  | "observation_unparseable"
  | "mask_config_invalid";

export interface Difference {
  readonly path: string;
  readonly predicted: Json;
  readonly observed: Json;
}

/** M1 schema `comparison-result`. */
export interface ComparisonResult {
  readonly experimentId: string;
  readonly result: "match" | "mismatch" | "not_comparable";
  readonly reason?: NotComparableReason;
  readonly differences: readonly Difference[];
  readonly maskSha256: string;
}
