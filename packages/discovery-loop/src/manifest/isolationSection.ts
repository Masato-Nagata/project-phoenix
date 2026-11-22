// Run_Manifest `ground_truth_access_denial` and `isolationChecks` section builders (task 4.6, work unit W3-A; design item 10).
//
// Pure: no I/O, no clock, no environment. The input is the access-denial result as DATA. This module does NOT import the isolation module
// (the static isolation test allows only the orchestrator to do that), so it cannot check the brand of the result: the caller that holds the
// branded result (W5, from the start gate) must check `isAccessDenialResult` before calling. Here only the form and the agreement of the
// parts are checked, and a result that is not `verified` is refused (a refused start writes no Manifest, so `failed` is unreachable in a
// sealed Manifest). The six check ids and their fixed order are a local copy; a test pins them to `CHECK_ORDER` of the isolation module.
// Every error is a closed code and a position, never an input value. The input is never changed and never aliased.
import type { Json, Result } from "../schema/types.js";
import { copyPlainJson, dataValue, hasExactKeys, isPlainDataObject, sectionFail, type SectionError } from "./plainData.js";

export const ISOLATION_CHECK_IDS: readonly string[] = Object.freeze(["import_analysis", "read_denial", "mount_inspection", "uid", "rootfs_readonly", "env_names"]);

export interface GroundTruthAccessDenialSection {
  readonly status: "verified";
  readonly executedInThisRun: true;
  readonly checks: ["read_denial", "mount_inspection"];
}
export interface IsolationCheckEntry {
  readonly id: string;
  readonly status: "verified";
  readonly measuredBy: "runtime" | "launcher";
  readonly measured: Json;
}

export type IsolationSectionErrorCode =
  | "input_not_plain_object"
  | "input_keys"
  | "status_not_verified"
  | "checks_not_array"
  | "checks_count"
  | "entry_not_plain_object"
  | "entry_keys"
  | "entry_id"
  | "entry_status_not_verified"
  | "entry_measured_by"
  | "entry_measured_not_json";
export type IsolationSectionError = SectionError<IsolationSectionErrorCode>;

const fail = (code: IsolationSectionErrorCode, index?: number): Result<never, IsolationSectionError> => sectionFail(code, index);

function validated(input: unknown): Result<IsolationCheckEntry[], IsolationSectionError> {
  if (!isPlainDataObject(input)) return fail("input_not_plain_object");
  if (!hasExactKeys(input, ["status", "runId", "checks"])) return fail("input_keys");
  if (dataValue(input, "status").value !== "verified") return fail("status_not_verified");
  const checks = dataValue(input, "checks").value;
  if (!Array.isArray(checks)) return fail("checks_not_array");
  if (checks.length !== ISOLATION_CHECK_IDS.length) return fail("checks_count");

  const out: IsolationCheckEntry[] = [];
  for (let i = 0; i < checks.length; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(checks, String(i));
    if (slot === undefined || !("value" in slot)) return fail("entry_not_plain_object", i);
    const entry: unknown = slot.value;
    if (!isPlainDataObject(entry)) return fail("entry_not_plain_object", i);
    if (!hasExactKeys(entry, ["id", "status", "measuredBy", "measured"])) return fail("entry_keys", i);
    const id = dataValue(entry, "id").value;
    if (id !== ISOLATION_CHECK_IDS[i]) return fail("entry_id", i);
    if (dataValue(entry, "status").value !== "verified") return fail("entry_status_not_verified", i);
    const measuredBy = dataValue(entry, "measuredBy").value;
    if (measuredBy !== "runtime" && measuredBy !== "launcher") return fail("entry_measured_by", i);
    const measured = copyPlainJson(dataValue(entry, "measured").value);
    if (measured === undefined) return fail("entry_measured_not_json", i);
    out.push({ id: id as string, status: "verified", measuredBy, measured });
  }
  return { ok: true, value: out };
}

/** `{ status, executedInThisRun, checks }`. `executedInThisRun` is a constant: a Run whose verification did not run writes no Manifest. */
export function buildGroundTruthAccessDenial(accessDenial: unknown): Result<GroundTruthAccessDenialSection, IsolationSectionError> {
  const r = validated(accessDenial);
  if (!r.ok) return r;
  return { ok: true, value: { status: "verified", executedInThisRun: true, checks: ["read_denial", "mount_inspection"] } };
}

/** The six checks in the fixed order, each as `{ id, status, measuredBy, measured }` with a fresh copy of `measured`. */
export function buildIsolationChecks(accessDenial: unknown): Result<IsolationCheckEntry[], IsolationSectionError> {
  return validated(accessDenial);
}