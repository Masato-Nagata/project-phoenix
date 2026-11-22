// Run_Manifest `provider` section builder (task 4.6, work unit W3-A).
//
// Pure: no I/O, no clock, no environment. The identity of the provider and the configured provider name are EXPLICIT inputs; this module
// only checks their form and that they agree. Nothing is filled in: a missing, empty or `unknown` field is refused (decision of W3-A), and
// the error carries a closed code only, never an input value. The input is never changed and never aliased.
import type { Result } from "../schema/types.js";
import { dataValue, hasExactKeys, isPlainDataObject, sectionFail, type SectionError } from "./plainData.js";

/** Same closed set as `RUN_CONFIG_PROVIDERS` of `config/limits.ts` (a test pins the equality; this module does not import the config). */
const CONFIGURED_PROVIDERS: readonly string[] = Object.freeze(["mock", "kiro-cli"]);
const MAX_FIELD_LENGTH = 256;

export interface ProviderSection {
  readonly id: string;
  readonly version: string;
  readonly model: string;
  readonly isMock: boolean;
}

export type ProviderSectionErrorCode =
  | "input_not_plain_object"
  | "input_keys"
  | "configured_provider_invalid"
  | "identity_not_plain_object"
  | "identity_keys"
  | "identity_field_invalid"
  | "identity_unknown"
  | "mock_identity_mismatch"
  | "mock_flag_mismatch";
export type ProviderSectionError = SectionError<ProviderSectionErrorCode>;

const fail = (code: ProviderSectionErrorCode): Result<never, ProviderSectionError> => sectionFail(code);

const fieldOk = (v: unknown): v is string => typeof v === "string" && v.length > 0 && v.length <= MAX_FIELD_LENGTH && v.trim() === v;
const isUnknownText = (v: string): boolean => v.toLowerCase() === "unknown";

/**
 * Input: `{ configuredProvider, identity: { id, version, model } }`. `isMock` is derived from the configured provider, and it must agree with
 * the identity: a mock Run has the identity id `mock` and the model `not_applicable`; no other configured provider may use the id `mock`.
 */
export function buildProviderSection(input: unknown): Result<ProviderSection, ProviderSectionError> {
  if (!isPlainDataObject(input)) return fail("input_not_plain_object");
  if (!hasExactKeys(input, ["configuredProvider", "identity"])) return fail("input_keys");

  const configured = dataValue(input, "configuredProvider").value;
  if (typeof configured !== "string" || !CONFIGURED_PROVIDERS.includes(configured)) return fail("configured_provider_invalid");

  const identity = dataValue(input, "identity").value;
  if (!isPlainDataObject(identity)) return fail("identity_not_plain_object");
  if (!hasExactKeys(identity, ["id", "version", "model"])) return fail("identity_keys");
  const id = dataValue(identity, "id").value;
  const version = dataValue(identity, "version").value;
  const model = dataValue(identity, "model").value;
  if (!fieldOk(id) || !fieldOk(version) || !fieldOk(model)) return fail("identity_field_invalid");
  if (isUnknownText(id) || isUnknownText(version) || isUnknownText(model)) return fail("identity_unknown");

  const isMock = configured === "mock";
  if (isMock && (id !== "mock" || model !== "not_applicable")) return fail("mock_identity_mismatch");
  if (!isMock && id === "mock") return fail("mock_flag_mismatch");
  return { ok: true, value: { id, version, model, isMock } };
}