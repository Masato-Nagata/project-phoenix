// Shared fixtures for the masking and Comparator tests (tasks 2.12 to 2.14). Neutral names only.
import { maskConfigHash, type MaskConfig, type Observation, type ObservedResponse, type Prediction } from "../../src/index.js";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export const cfgOf = (...paths: string[]): MaskConfig => ({ paths });

export function deepFreeze<T>(v: T): T {
  if (typeof v === "object" && v !== null && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

export const jsonResponse = (status: number, body: JsonValue): ObservedResponse => ({ status, bodyKind: "json", body });

/** An executed Observation with one response, carrying the hash of `cfg` as the runner would store it. */
export function observation(cfg: MaskConfig, responses: ObservedResponse[], over: Partial<Observation> = {}): Observation {
  return { experimentId: "exp-1", outcome: "executed", responses, stateChecks: [], maskSha256: maskConfigHash(cfg), ...over };
}

export function prediction(status: number, fields: { path: string; value: JsonValue }[], target: Prediction["target"] = { list: "requests", index: 0 }): Prediction {
  return { target, status, fields };
}