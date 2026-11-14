// The note for reports (design: "Masking decisions", item 5; C2-5). Derived only from the stored Prediction and the
// mask configuration, so it is deterministic and needs no new field in any record. It never changes a comparison
// result, an Evidence outcome, or an Evidence_Status: R6.6 turns every `match` into the outcome `supports`, unchanged.
import { isPathMasked, validateMaskConfig } from "./mask.js";
import type { MaskConfig, Prediction, Result } from "./types.js";

export interface MaskNote {
  readonly predictedFields: number;
  readonly maskedFields: number;
  /** The number of predicted fields that were not masked, that is, that carried a value comparison. */
  readonly unmaskedFields: number;
  /** True when every predicted field was masked: the agreement rests on the status code alone. */
  readonly statusOnly: boolean;
}

/** Counts masked and unmasked predicted fields. An error when the configuration is invalid. */
export function deriveMaskNote(prediction: Prediction, cfg: MaskConfig): Result<MaskNote, string> {
  const valid = validateMaskConfig(cfg);
  if (!valid.ok) return { ok: false, error: "the mask configuration is invalid" };
  const maskedFields = prediction.fields.filter((f) => isPathMasked(f.path, valid.value)).length;
  const predictedFields = prediction.fields.length;
  const unmaskedFields = predictedFields - maskedFields;
  return { ok: true, value: { predictedFields, maskedFields, unmaskedFields, statusOnly: predictedFields > 0 && unmaskedFields === 0 } };
}