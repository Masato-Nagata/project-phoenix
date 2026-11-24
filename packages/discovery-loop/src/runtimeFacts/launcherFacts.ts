// Run_Manifest runtime facts, task 4.6 work unit W4-C part C2: the reading and the checking of `/run/lease/launcher-facts.json`.
//
// What this module is: a pure parser, a pure cross-check against the two values the runtime holds itself, a snapshot, a pure comparison
// of two snapshots, and the start-up read and the re-read before sealing. The only I/O is the injected read port, which reads one file and
// has no write method. The file is written by the Launcher (task 4.9, not changed here); this module only receives and checks it.
//
// The contract (version 2, closed set of six keys, no other key, at most 4 KiB):
//   { "schema_version": 2, "issued_by": "launcher", "run_id": "<run id>", "runtime_image_id": "sha256:<64 hex>", "audit_config_sha256": "<64 hex>",
//     "audit_config_kind": "fixture" }
// Version 1 (the five keys without the kind) and every unknown version are refused: a version-1 file is never sealed. The only kind that is
// defined is `fixture` (the synthetic audit configuration of the Mock Run); no value for a real audit configuration is defined, so none is
// accepted. The kind is a Launcher DECLARATION: the runtime cannot tell a fixture from a real configuration by the file.
//
// Declared versus observed (the snapshot keeps the two apart; nothing in it is called "verified" unless the runtime compared it):
//   - `declared`: every value of the file, as DECLARED BY THE LAUNCHER.
//   - `confirmedByRuntime`: the values that the runtime holds itself and that were found EQUAL to the declared ones: the run id (from
//     `PHOENIX_RUN_ID`) and the SHA-256 of the audit configuration bytes (measured by the runtime from the mounted file). For these two
//     the file is a second, independent statement, not the only source.
//   - `unverifiedByRuntime`: `audit_config_kind` and `runtime_image_id`. The container cannot inspect its own image and cannot tell what the
//     audit configuration was built from. Both are Launcher declarations and never independent verification results. A Launcher that
//     declares a wrong image id or a wrong kind cannot be detected here.
//
// What this module does NOT claim: that the Launcher wrote the file (no authentication), that the image id names the running image,
// that the audit configuration is a real or a fixture configuration, or that the file was not written between two reads by the Launcher.
// A re-read that finds the same text only shows that the text did not change between the two reads.
//
// Rules: an error is a closed code and never carries a value or a path. An input is never changed, an accessor of an input is never run,
// nothing unknown is filled in, a file that cannot be read or that changed since the first read is refused (fail closed), no retry.
import { createHash } from "node:crypto";
import { strictParse } from "../schema/strictParse.js";
import type { Result } from "../schema/types.js";

// ---------------------------------------------------------------------------------------------
// Local helpers (the module boundary of W3-A, W4-A and W4-B is kept; same contract as theirs)
// ---------------------------------------------------------------------------------------------
interface SectionError<C extends string> {
  readonly code: C;
}
const sectionFail = <C extends string>(code: C): Result<never, SectionError<C>> => ({ ok: false, error: { code } });

/** A plain object with only own enumerable string-keyed data properties (no accessor, no symbol key, Object.prototype or null prototype). */
function isPlainDataObject(v: unknown): v is object {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key !== "string") return false;
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (d === undefined || !("value" in d) || d.enumerable !== true) return false;
  }
  return true;
}
function dataValue(o: object, key: string): { present: boolean; value?: unknown } {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (d === undefined || !("value" in d)) return { present: false };
  return { present: true, value: d.value };
}
function hasExactKeys(o: object, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ZERO_SHA256 = "0".repeat(64);
/** The run id format of the Launcher (a private copy, as in leaseFacts.ts; a test pins the parity). */
const RUN_ID = /^run-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/;
/** The local image id that the Launcher reads from Docker: `sha256:` and 64 lowercase hex characters (the grammar of W3-A). */
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const sha256Text = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const hashOk = (v: unknown): v is string => typeof v === "string" && SHA256_HEX.test(v) && v !== ZERO_SHA256;

/** The size bound of the file, the same 4 KiB as `lease.json` (a test pins that the adapter uses the same number). */
export const LAUNCHER_FACTS_MAX_BYTES = 4096;
/** The only schema version this parser accepts. */
export const LAUNCHER_FACTS_SCHEMA_VERSION = 2;
/** The six keys of the contract, and no other. */
export const LAUNCHER_FACTS_KEYS: readonly string[] = Object.freeze(["audit_config_kind", "audit_config_sha256", "issued_by", "run_id", "runtime_image_id", "schema_version"]);
/** The audit configuration kinds that are defined. Only the fixture of the Mock Run; no value for a real configuration is defined. */
export const AUDIT_CONFIG_KINDS: readonly string[] = Object.freeze(["fixture"]);
/** The declared values that the runtime does not verify, in a fixed order. */
const UNVERIFIED_BY_RUNTIME = Object.freeze(["audit_config_kind", "runtime_image_id"] as const);

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------
/** The values of the file, as declared by the Launcher. Frozen. */
export interface LauncherDeclaredFacts {
  readonly runId: string;
  /** Declared by the Launcher; the runtime cannot check it. */
  readonly runtimeImageId: string;
  /** Declared by the Launcher; the snapshot also holds the equal value that the runtime measured. */
  readonly auditConfigSha256: string;
  /** Declared by the Launcher; the runtime cannot check it. One of `AUDIT_CONFIG_KINDS`. */
  readonly auditConfigKind: string;
}

/** The values the runtime holds itself. `auditConfigSha256` is the SHA-256 of the bytes of the mounted audit configuration. */
export interface LauncherFactsExpectation {
  readonly runId: string;
  readonly auditConfigSha256: string;
}

/** What one successful read gives. Issued only by this module. Frozen. */
export interface LauncherFactsSnapshot {
  readonly declaredBy: "launcher";
  readonly declared: LauncherDeclaredFacts;
  /** Values that the runtime holds and that equal the declared ones (the run id and the audit configuration hash). */
  readonly confirmedByRuntime: { readonly runId: string; readonly auditConfigSha256: string };
  /** Declared values that the runtime does not verify. */
  readonly unverifiedByRuntime: readonly ["audit_config_kind", "runtime_image_id"];
  /** SHA-256 (lowercase hex) of the exact text that was read, as UTF-8. */
  readonly textSha256: string;
}

export type LauncherFactsErrorCode =
  | "expectation_not_plain_object"
  | "expectation_keys"
  | "expectation_run_id_invalid"
  | "expectation_audit_sha256_invalid"
  | "facts_not_string"
  | "facts_too_large"
  | "facts_invalid_json"
  | "facts_not_object"
  | "field_missing"
  | "field_unknown"
  | "schema_version_invalid"
  | "issued_by_invalid"
  | "run_id_invalid"
  | "runtime_image_id_invalid"
  | "audit_config_sha256_invalid"
  | "audit_config_kind_invalid"
  | "run_id_mismatch"
  | "audit_config_sha256_mismatch"
  | "facts_read_absent"
  | "facts_read_failed"
  | "facts_read_answer_invalid"
  | "facts_changed"
  | "snapshot_not_issued";
export type LauncherFactsError = SectionError<LauncherFactsErrorCode>;

const fail = (code: LauncherFactsErrorCode): Result<never, LauncherFactsError> => sectionFail(code);

// ---------------------------------------------------------------------------------------------
// The read port
// ---------------------------------------------------------------------------------------------
/** `absent`: the file does not exist. `error`: anything else (unreadable, not a regular file, too large). */
export type LauncherFactsReadAnswer = { readonly kind: "ok"; readonly text: string } | { readonly kind: "absent" } | { readonly kind: "error" };

/** The one read operation of this unit. There is no write, no list and no other file. */
export interface LauncherFactsReadPort {
  readLauncherFacts(): LauncherFactsReadAnswer;
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------
/** Pure. Parses the text under the strict JSON rules (no duplicate key, size bound) and checks the form of every field. */
export function parseLauncherFactsText(text: unknown): Result<LauncherDeclaredFacts, LauncherFactsError> {
  if (typeof text !== "string") return fail("facts_not_string");
  const parsed = strictParse(text, { maxBytes: LAUNCHER_FACTS_MAX_BYTES, maxDepth: 4 });
  if (!parsed.ok) return fail(parsed.error.code === "size_exceeded" ? "facts_too_large" : "facts_invalid_json");
  const root = parsed.value;
  if (!isPlainDataObject(root)) return fail("facts_not_object");

  const own = Object.keys(root);
  if (LAUNCHER_FACTS_KEYS.some((k) => !own.includes(k))) return fail("field_missing");
  if (!hasExactKeys(root, LAUNCHER_FACTS_KEYS)) return fail("field_unknown");

  const field = (k: string): unknown => dataValue(root, k).value;
  if (field("schema_version") !== LAUNCHER_FACTS_SCHEMA_VERSION) return fail("schema_version_invalid");
  if (field("issued_by") !== "launcher") return fail("issued_by_invalid");
  const runId = field("run_id");
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return fail("run_id_invalid");
  const image = field("runtime_image_id");
  if (typeof image !== "string" || !IMAGE_ID.test(image) || image === `sha256:${ZERO_SHA256}`) return fail("runtime_image_id_invalid");
  const audit = field("audit_config_sha256");
  if (!hashOk(audit)) return fail("audit_config_sha256_invalid");
  const kind = field("audit_config_kind");
  if (typeof kind !== "string" || !AUDIT_CONFIG_KINDS.includes(kind)) return fail("audit_config_kind_invalid");

  return { ok: true, value: Object.freeze({ runId, runtimeImageId: image, auditConfigSha256: audit, auditConfigKind: kind }) };
}

// ---------------------------------------------------------------------------------------------
// Cross-check and snapshot
// ---------------------------------------------------------------------------------------------
function checkExpectation(input: unknown): Result<LauncherFactsExpectation, LauncherFactsError> {
  if (!isPlainDataObject(input)) return fail("expectation_not_plain_object");
  if (!hasExactKeys(input, ["runId", "auditConfigSha256"])) return fail("expectation_keys");
  const runId = dataValue(input, "runId").value;
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return fail("expectation_run_id_invalid");
  const audit = dataValue(input, "auditConfigSha256").value;
  if (!hashOk(audit)) return fail("expectation_audit_sha256_invalid");
  return { ok: true, value: { runId, auditConfigSha256: audit } };
}

/** Everything this module issued, and nothing else. A copy or a look-alike is not a snapshot. */
const issued = new WeakSet<object>();

/**
 * Pure. Parses the text, then checks that the run id and the audit configuration hash equal the values the runtime holds. The expectation
 * is checked first, so a bad expectation is never reported as a fault of the file. The result is a frozen snapshot.
 */
export function createLauncherFactsSnapshot(text: unknown, expectation: unknown): Result<LauncherFactsSnapshot, LauncherFactsError> {
  const expected = checkExpectation(expectation);
  if (!expected.ok) return expected;
  const parsed = parseLauncherFactsText(text);
  if (!parsed.ok) return parsed;
  const d = parsed.value;
  if (d.runId !== expected.value.runId) return fail("run_id_mismatch");
  if (d.auditConfigSha256 !== expected.value.auditConfigSha256) return fail("audit_config_sha256_mismatch");
  const snapshot: LauncherFactsSnapshot = Object.freeze({
    declaredBy: "launcher" as const,
    declared: d,
    confirmedByRuntime: Object.freeze({ runId: expected.value.runId, auditConfigSha256: expected.value.auditConfigSha256 }),
    unverifiedByRuntime: UNVERIFIED_BY_RUNTIME,
    textSha256: sha256Text(text as string),
  });
  issued.add(snapshot);
  return { ok: true, value: snapshot };
}

/** True only for a snapshot that this module issued. */
export function isLauncherFactsSnapshot(x: unknown): x is LauncherFactsSnapshot {
  return typeof x === "object" && x !== null && issued.has(x);
}

/** Pure. `ok` only when both are snapshots of this module and are the same: the same text hash and the same value in every field. */
export function compareLauncherFactsSnapshots(first: unknown, second: unknown): Result<true, LauncherFactsError> {
  if (!isLauncherFactsSnapshot(first) || !isLauncherFactsSnapshot(second)) return fail("snapshot_not_issued");
  const a = first.declared;
  const b = second.declared;
  const same =
    first.textSha256 === second.textSha256 &&
    a.runId === b.runId &&
    a.runtimeImageId === b.runtimeImageId &&
    a.auditConfigSha256 === b.auditConfigSha256 &&
    a.auditConfigKind === b.auditConfigKind &&
    first.confirmedByRuntime.runId === second.confirmedByRuntime.runId &&
    first.confirmedByRuntime.auditConfigSha256 === second.confirmedByRuntime.auditConfigSha256;
  return same ? { ok: true, value: true } : fail("facts_changed");
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------
/** One read of the port. An exception, a shape that is not one of the three answers, and a non-string text are refused. */
function readText(port: LauncherFactsReadPort): Result<string, LauncherFactsError> {
  let answer: unknown;
  try {
    answer = port.readLauncherFacts();
  } catch {
    return fail("facts_read_failed");
  }
  if (!isPlainDataObject(answer)) return fail("facts_read_answer_invalid");
  const kind = dataValue(answer, "kind").value;
  if (kind === "absent" && hasExactKeys(answer, ["kind"])) return fail("facts_read_absent");
  if (kind === "error" && hasExactKeys(answer, ["kind"])) return fail("facts_read_failed");
  if (kind === "ok" && hasExactKeys(answer, ["kind", "text"])) {
    const text = dataValue(answer, "text").value;
    return typeof text === "string" ? { ok: true, value: text } : fail("facts_read_answer_invalid");
  }
  return fail("facts_read_answer_invalid");
}

/** The start-up snapshot: one read, then `createLauncherFactsSnapshot`. */
export function readLauncherFactsSnapshot(port: LauncherFactsReadPort, expectation: unknown): Result<LauncherFactsSnapshot, LauncherFactsError> {
  const text = readText(port);
  if (!text.ok) return text;
  return createLauncherFactsSnapshot(text.value, expectation);
}

/**
 * The re-read before sealing: one read, no retry. A read that fails is refused. A text that differs from the start-up text by one byte is
 * `facts_changed`, before it is parsed. A text that is equal is checked again against the expectation and compared field by field.
 * Returns the start-up snapshot itself (nothing new is issued).
 */
export function confirmLauncherFactsUnchanged(port: LauncherFactsReadPort, expectation: unknown, start: unknown): Result<LauncherFactsSnapshot, LauncherFactsError> {
  if (!isLauncherFactsSnapshot(start)) return fail("snapshot_not_issued");
  const text = readText(port);
  if (!text.ok) return text;
  if (sha256Text(text.value) !== start.textSha256) return fail("facts_changed");
  const again = createLauncherFactsSnapshot(text.value, expectation);
  if (!again.ok) return again;
  const same = compareLauncherFactsSnapshots(start, again.value);
  return same.ok ? { ok: true, value: start } : same;
}
