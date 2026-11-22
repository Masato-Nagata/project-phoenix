// Run_Manifest `aiSandbox` section builder (task 4.6, work unit W3-A).
//
// Pure: no I/O, no clock, no environment. Inputs are explicit: the configured provider and the sandbox facts of the startup approval
// (`{ applicable: false }` or `{ applicable: true, destinations }`). Decisions: a mock Run has no sandbox (`not_applicable`, no destination);
// a kiro-cli Run is `UNVERIFIED` because no verification record exists yet, and this module never produces `verified`. The destinations are
// declared values, not measured ones. Every error is a closed code, never an input value. The input is never changed and never aliased.
import type { Result } from "../schema/types.js";
import { dataValue, hasExactKeys, isPlainDataObject, sectionFail, type SectionError } from "./plainData.js";

export interface AiSandboxSection {
  readonly safetyStatus: "not_applicable" | "UNVERIFIED";
  readonly permittedDestinations: string[];
}

export type AiSandboxSectionErrorCode =
  | "input_not_plain_object"
  | "input_keys"
  | "provider_invalid"
  | "sandbox_not_plain_object"
  | "sandbox_shape"
  | "applicable_mismatch"
  | "destinations_not_array"
  | "destinations_empty"
  | "destination_invalid"
  | "destination_duplicate";
export type AiSandboxSectionError = SectionError<AiSandboxSectionErrorCode>;

const fail = (code: AiSandboxSectionErrorCode, index?: number): Result<never, AiSandboxSectionError> => sectionFail(code, index);

/** Input: `{ provider: "mock" | "kiro-cli", sandbox }`. */
export function buildAiSandboxSection(input: unknown): Result<AiSandboxSection, AiSandboxSectionError> {
  if (!isPlainDataObject(input)) return fail("input_not_plain_object");
  if (!hasExactKeys(input, ["provider", "sandbox"])) return fail("input_keys");
  const provider = dataValue(input, "provider").value;
  if (provider !== "mock" && provider !== "kiro-cli") return fail("provider_invalid");
  const sandbox = dataValue(input, "sandbox").value;
  if (!isPlainDataObject(sandbox)) return fail("sandbox_not_plain_object");
  const applicable = dataValue(sandbox, "applicable").value;
  if (typeof applicable !== "boolean") return fail("sandbox_shape");

  if (!applicable) {
    if (!hasExactKeys(sandbox, ["applicable"])) return fail("sandbox_shape");
    if (provider !== "mock") return fail("applicable_mismatch");
    return { ok: true, value: { safetyStatus: "not_applicable", permittedDestinations: [] } };
  }
  if (!hasExactKeys(sandbox, ["applicable", "destinations"])) return fail("sandbox_shape");
  if (provider !== "kiro-cli") return fail("applicable_mismatch");
  const list = dataValue(sandbox, "destinations").value;
  if (!Array.isArray(list)) return fail("destinations_not_array");
  if (list.length === 0) return fail("destinations_empty");

  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < list.length; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(list, String(i));
    if (slot === undefined || !("value" in slot)) return fail("destination_invalid", i);
    const d: unknown = slot.value;
    if (typeof d !== "string" || d.length < 1 || d.length > 255) return fail("destination_invalid", i);
    if (seen.has(d)) return fail("destination_duplicate", i);
    seen.add(d);
    out.push(d);
  }
  return { ok: true, value: { safetyStatus: "UNVERIFIED", permittedDestinations: out } };
}