// Run_Manifest `excludedFields` and `config` section builders (task 4.6, work unit W3-A).
//
// Pure: no I/O, no clock, no environment. `config` is a copy of the validated run configuration (effective values) plus the two
// configuration hashes of OD-17 and the lease propagation delay, flat in one object (the M1 schema keeps `config` a free object). Every
// external value is an EXPLICIT input; this module checks the form only. It does not recompute a hash (that needs the verifier and belongs to
// the composition root), it does not add an "above the bound" flag (a value above a fixed bound is refused at stage A, so the flag would
// always be false), and it does not record the audit configuration kind (its channel is undecided, task 4.9).
import type { Json, Result } from "../schema/types.js";
import { SHA256_HEX, ZERO_SHA256, copyPlainJson, dataValue, hasExactKeys, isPlainDataObject, sectionFail, type SectionError } from "./plainData.js";

/** The schema constant of `excludedFields` (R22.1). A fresh array is returned on every call. */
export function buildExcludedFields(): ["runId", "wallClock"] {
  return ["runId", "wallClock"];
}

/** Same closed set as `RUN_CONFIG_PROVIDERS` of `config/limits.ts` (a test pins the equality). */
const CONFIGURED_PROVIDERS: readonly string[] = Object.freeze(["mock", "kiro-cli"]);
/** The keys that this builder adds; the copied configuration may not contain them. */
const ADDED_KEYS = ["policyConfigSha256", "preparationTableSha256", "leasePropagationDelayMs"] as const;

export type ConfigSection = { readonly [k: string]: Json };

export type ConfigSectionErrorCode =
  | "input_not_plain_object"
  | "input_keys"
  | "config_not_json"
  | "config_not_object"
  | "config_reserved_key"
  | "config_schema_version"
  | "config_provider"
  | "policy_hash_invalid"
  | "table_hash_invalid"
  | "delay_invalid";
export type ConfigSectionError = SectionError<ConfigSectionErrorCode>;

const fail = (code: ConfigSectionErrorCode): Result<never, ConfigSectionError> => sectionFail(code);

const hashOk = (v: unknown): v is string => typeof v === "string" && SHA256_HEX.test(v) && v !== ZERO_SHA256;

/**
 * Input: `{ effectiveConfig, policyConfigSha256, preparationTableSha256, leasePropagationDelayMs }`.
 * `effectiveConfig` is the validated run configuration (plain JSON, `schemaVersion` 1, a known `provider`). Each hash is 64 lowercase hex
 * characters and not all zeros (the all-zero value marks an experiment that could not be hashed). The delay is a non-negative safe integer.
 */
export function buildConfigSection(input: unknown): Result<ConfigSection, ConfigSectionError> {
  if (!isPlainDataObject(input)) return fail("input_not_plain_object");
  if (!hasExactKeys(input, ["effectiveConfig", "policyConfigSha256", "preparationTableSha256", "leasePropagationDelayMs"])) return fail("input_keys");

  const copy = copyPlainJson(dataValue(input, "effectiveConfig").value);
  if (copy === undefined) return fail("config_not_json");
  if (typeof copy !== "object" || copy === null || Array.isArray(copy)) return fail("config_not_object");
  if (ADDED_KEYS.some((k) => Object.hasOwn(copy, k))) return fail("config_reserved_key");
  if (copy["schemaVersion"] !== 1) return fail("config_schema_version");
  const provider = copy["provider"];
  if (typeof provider !== "string" || !CONFIGURED_PROVIDERS.includes(provider)) return fail("config_provider");

  const policy = dataValue(input, "policyConfigSha256").value;
  if (!hashOk(policy)) return fail("policy_hash_invalid");
  const table = dataValue(input, "preparationTableSha256").value;
  if (!hashOk(table)) return fail("table_hash_invalid");
  const delay = dataValue(input, "leasePropagationDelayMs").value;
  if (typeof delay !== "number" || !Number.isSafeInteger(delay) || delay < 0) return fail("delay_invalid");

  return {
    ok: true,
    value: { ...copy, policyConfigSha256: policy, preparationTableSha256: table, leasePropagationDelayMs: delay },
  };
}