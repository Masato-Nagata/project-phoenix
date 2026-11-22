// Run_Manifest `legacyStartState` section builder (task 4.6, work unit W3-A).
//
// Pure: no I/O, no clock, no environment, and no measurement. The identity of the Legacy_App starting state is an EXPLICIT input. The hash
// rule that produces it is NOT decided (design open point), so this module imposes no hash format: it only refuses a missing, blank,
// over-long or control-character value, and the placeholder words `unknown` and `unmeasured`, so that a value that stands for "not known" is
// never recorded as an identity. Every error is a closed code, never an input value. The input is never changed and never aliased.
import type { Result } from "../schema/types.js";
import { dataValue, hasExactKeys, isPlainDataObject, sectionFail, type SectionError } from "./plainData.js";

const MAX_IDENTITY_LENGTH = 1024;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const PLACEHOLDERS: readonly string[] = Object.freeze(["unknown", "unmeasured"]);

export interface LegacyStartStateSection {
  readonly identity: string;
}

export type LegacyStartStateSectionErrorCode = "input_not_plain_object" | "input_keys" | "identity_invalid" | "identity_placeholder";
export type LegacyStartStateSectionError = SectionError<LegacyStartStateSectionErrorCode>;

const fail = (code: LegacyStartStateSectionErrorCode): Result<never, LegacyStartStateSectionError> => sectionFail(code);

/** Input: `{ identity }`. */
export function buildLegacyStartStateSection(input: unknown): Result<LegacyStartStateSection, LegacyStartStateSectionError> {
  if (!isPlainDataObject(input)) return fail("input_not_plain_object");
  if (!hasExactKeys(input, ["identity"])) return fail("input_keys");
  const identity = dataValue(input, "identity").value;
  if (typeof identity !== "string" || identity.trim().length === 0 || identity.length > MAX_IDENTITY_LENGTH || CONTROL.test(identity)) {
    return fail("identity_invalid");
  }
  if (PLACEHOLDERS.includes(identity.trim().toLowerCase())) return fail("identity_placeholder");
  return { ok: true, value: { identity } };
}