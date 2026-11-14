// Comparator (design: "Comparator Masking", "Masking decisions (OD-7)", "Comparator decisions (task 2.12)"; R10; task 2.12).
//
// Pure: no AI call, no clock, no random value, no I/O. It never modifies its inputs and never throws. Identical inputs
// give a byte-identical result (R10.11). The result is the only basis for `experiment` Evidence (R10.13); this module
// neither creates Evidence nor decides what a `match` means for a Claim (R6.6 is applied elsewhere, unchanged).
//
// Order of the `not_comparable` reasons (the first that applies wins):
//   1. the Experiment was not executed, timed out, or was aborted          (R10.8)
//   2. the Prediction is missing or malformed                              (R10.9: prediction_missing)
//   3. the mask configuration is missing or invalid, or its hash differs
//      from the one stored in the Observation                              (R10.9, C2-4: mask_config_invalid)
//   4. the response body cannot be read as structured data                 (R10.9: observation_unparseable)
// Otherwise the result is `match` or `mismatch`.
import { maskConfigHash, maskJson, maskPredictedValue, validateMaskConfig, maskedPrefixLength, MASK_TOKEN } from "./mask.js";
import { parseConcretePath, type Segment } from "./path.js";
import type { ComparisonResult, Difference, Json, MaskConfig, NotComparableReason, Observation, ObservedResponse, Prediction } from "./types.js";

/** Stands for "no configuration": the hash recorded when there is no valid mask configuration. */
export const NO_MASK_CONFIG_HASH = "0".repeat(64);

const absent = (): Json => ({ $absent: true });

function cloneJson(v: Json): Json {
  if (Array.isArray(v)) return v.map(cloneJson);
  if (typeof v === "object" && v !== null) {
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(v)) Object.defineProperty(out, k, { value: cloneJson(v[k] as Json), enumerable: true, writable: true, configurable: true });
    return out;
  }
  return v;
}

/** Exact equality: same type and same value, no coercion, no tolerance (R10.3). Object key order does not matter. */
function jsonEqual(a: Json, b: Json): boolean {
  if (a === null || b === null) return a === b;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i] as Json));
  if (Array.isArray(b)) return false;
  if (typeof a === "object") {
    if (typeof b !== "object") return false;
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k] as Json, b[k] as Json));
  }
  return typeof a === typeof b && a === b;
}

function lookup(body: Json, segs: readonly Segment[]): { found: true; value: Json } | { found: false } {
  let cur: Json = body;
  for (const s of segs) {
    if (s.kind === "key") {
      if (typeof cur !== "object" || cur === null || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, s.name)) return { found: false };
      cur = cur[s.name] as Json;
    } else if (s.kind === "index") {
      if (!Array.isArray(cur) || s.n >= cur.length) return { found: false };
      cur = cur[s.n] as Json;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: cur };
}

const isInt = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n);

/** True if the Prediction has the shape of the M1 schema (checked at run time because the input is untrusted data). */
function wellFormedPrediction(p: unknown): p is Prediction {
  if (typeof p !== "object" || p === null) return false;
  const { target, status, fields } = p as { target?: unknown; status?: unknown; fields?: unknown };
  if (typeof target !== "object" || target === null) return false;
  const { list, index } = target as { list?: unknown; index?: unknown };
  if ((list !== "requests" && list !== "stateChecks") || !isInt(index) || index < 0) return false;
  if (!isInt(status) || !Array.isArray(fields)) return false;
  return fields.every((f: unknown) => {
    if (typeof f !== "object" || f === null) return false;
    const { path, value } = f as { path?: unknown; value?: unknown };
    return typeof path === "string" && parseConcretePath(path) !== undefined && value !== undefined;
  });
}

function wellFormedObservation(o: unknown): o is Observation {
  if (typeof o !== "object" || o === null) return false;
  const x = o as Partial<Observation>;
  return typeof x.experimentId === "string" && typeof x.outcome === "string" && Array.isArray(x.responses) && Array.isArray(x.stateChecks) && typeof x.maskSha256 === "string";
}

const byPath = (a: Difference, b: Difference): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * Compares a Prediction with an Observation (R10.1 to R10.9). The status code is always compared and is never masked.
 * A predicted field whose path is masked (it equals a mask entry or lies below one) is masked on both sides. The only
 * thing still checked is that the masked node exists in the (masked) body: a masked node that is absent from the
 * Observation is a difference, whose predicted value is the token. Below a masked node nothing can differ.
 */
export function compare(prediction: Prediction | undefined, observation: Observation, cfg: MaskConfig | undefined): ComparisonResult {
  const valid = validateMaskConfig(cfg);
  const hash = valid.ok ? maskConfigHash(valid.value) : NO_MASK_CONFIG_HASH;
  const experimentId = typeof (observation as Partial<Observation> | undefined)?.experimentId === "string" ? observation.experimentId : "";
  const notComparable = (reason: NotComparableReason): ComparisonResult => ({ experimentId, result: "not_comparable", reason, differences: [], maskSha256: hash });
  try {
    if (!wellFormedObservation(observation)) return notComparable("observation_unparseable");
    // 1. The state of the Experiment (R10.8).
    if (observation.outcome === "not_executed" || observation.outcome === "timed_out" || observation.outcome === "aborted") return notComparable(observation.outcome);
    // 2. The Prediction (R10.9).
    if (!wellFormedPrediction(prediction)) return notComparable("prediction_missing");
    // 3. The mask configuration, and its agreement with the one used at capture (R10.9, C2-4).
    if (!valid.ok || observation.maskSha256 !== hash) return notComparable("mask_config_invalid");
    const mask = valid.value;

    const response: ObservedResponse | undefined = (prediction.target.list === "requests" ? observation.responses : observation.stateChecks)[prediction.target.index];
    const differences: Difference[] = [];
    // The status code: always compared, never masked.
    if (response === undefined || response.status !== prediction.status) {
      differences.push({ path: "$status", predicted: prediction.status, observed: response === undefined ? absent() : response.status });
    }
    // 4. A predicted field needs a structured body (R10.9); a missing response has no body and every field is absent.
    let body: Json | undefined;
    if (response !== undefined && prediction.fields.length > 0) {
      if (response.bodyKind !== "json" || response.body === undefined) return notComparable("observation_unparseable");
      body = maskJson(response.body, mask); // masking again is a no-op for a body masked at capture (C2)
    }
    const fieldDiffs: Difference[] = [];
    for (const f of prediction.fields) {
      const segs = parseConcretePath(f.path) as Segment[];
      const maskedLength = maskedPrefixLength(f.path, mask);
      if (maskedLength !== undefined) {
        // A masked path (or a path below a masked node) is masked on both sides. What can still be checked is that the
        // masked node exists; below it the Observation holds only the token, so nothing more can differ.
        const node = body === undefined ? ({ found: false } as const) : lookup(body, segs.slice(0, maskedLength));
        if (!node.found) fieldDiffs.push({ path: f.path, predicted: MASK_TOKEN, observed: absent() });
        continue;
      }
      // The predicted value is masked like the Observation: masked descendants of an object or list value become the token
      // (a new value; the Prediction is not modified). The difference shows this masked value, the one that was compared.
      const predicted = maskPredictedValue(f.value, f.path, mask);
      const seen = body === undefined ? ({ found: false } as const) : lookup(body, segs);
      if (!seen.found) fieldDiffs.push({ path: f.path, predicted, observed: absent() });
      else if (!jsonEqual(predicted, seen.value)) fieldDiffs.push({ path: f.path, predicted, observed: cloneJson(seen.value) });
    }
    // `Array.prototype.sort` is stable: equal paths keep the order of the Prediction.
    differences.push(...fieldDiffs.sort(byPath));
    return { experimentId, result: differences.length === 0 ? "match" : "mismatch", differences, maskSha256: hash };
  } catch {
    // Anything unforeseen in the data (for example a body nested too deeply to mask) is not a comparison result.
    return notComparable("observation_unparseable");
  }
}