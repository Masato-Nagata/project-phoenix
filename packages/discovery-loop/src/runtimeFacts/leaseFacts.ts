// Run_Manifest runtime facts, task 4.6 work unit W4-A: the reading and the checking of `/run/lease/lease.json`.
//
// What this module is: a pure parser, a pure consistency check against the values the runtime already holds, a snapshot, and a pure
// comparison of two snapshots. The only I/O is the injected read port, which reads one file and has no write method.
//
// What this module does NOT claim:
//   - Every value of `lease.json` is DECLARED BY THE LAUNCHER. `launcher_pid` is a process id of the host; the container cannot see that
//     process, and nothing here says it exists or that it holds a lock. `launcher_start_ticks` is checked for form only.
//   - A snapshot is not proof that the mutual exclusion (mode `mechanical`) holds. This module never decides a mode.
//   - It is not the lease watcher. It does not check heartbeats and does not replace `LeaseWatcher` of the verifier, which is not changed.
//
// Rules: the raw nonce is only hashed here; it is never part of a result, a snapshot or an error. Every error is a closed code and never
// carries an input value. An input is never changed, an accessor of an input is never run, and nothing unknown is filled in. A file that
// cannot be read, or that changed since the first read, is refused (fail closed). There is no retry.
import { createHash } from "node:crypto";
import { strictParse } from "../schema/strictParse.js";
import type { Result } from "../schema/types.js";

// ---------------------------------------------------------------------------------------------
// Local helpers. This unit does not import the helpers of `manifest/` (the module boundary of W3-A is kept); these are the ones it uses,
// with the same contract: own DATA properties only (an accessor is never run), no symbol key, no foreign prototype, nothing is changed.
// ---------------------------------------------------------------------------------------------
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ZERO_SHA256 = "0".repeat(64);

/** A closed code and, for a list position, an index. No input value is ever echoed. */
interface SectionError<C extends string> {
  readonly code: C;
  readonly index?: number;
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

/** Own data property value, or `{ present: false }` when absent or an accessor. A getter is never run. */
function dataValue(o: object, key: string): { present: boolean; value?: unknown } {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (d === undefined || !("value" in d)) return { present: false };
  return { present: true, value: d.value };
}

/** True when the own enumerable keys are exactly `keys` (any order, no extra, none missing). */
function hasExactKeys(o: object, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}
/** The size bound of the file, the same as the bound of the lease directory view of the runtime (4 KiB). */
export const LEASE_JSON_MAX_BYTES = 4096;

/** The seven keys the Launcher writes (`New-RunLease`), and no other. */
export const LEASE_JSON_KEYS: readonly string[] = Object.freeze([
  "heartbeat_interval_ms",
  "issued_by",
  "launcher_pid",
  "launcher_start_ticks",
  "nonce_sha256",
  "run_id",
  "stale_after_ms",
]);

/** The Launcher run id format (a private copy; the parity with the other copies is pinned by a test). */
const RUN_ID = /^run-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/;
/** .NET `DateTime.Ticks` as decimal text: positive, no leading zero, at most 3155378975999999999 (the last tick of year 9999). */
const TICKS = /^[1-9][0-9]{0,18}$/;
const MAX_TICKS = 3155378975999999999n;
const MAX_PID = 4294967295;
const MAX_NONCE_LENGTH = 1024;

/** The values of `lease.json`, as declared by the Launcher. Frozen. */
export interface LeaseJsonFacts {
  readonly runId: string;
  /** Declared by the Launcher; not checked inside the container. */
  readonly launcherPid: number;
  /** Declared by the Launcher; form only. Decimal text of .NET ticks. */
  readonly launcherStartTicks: string;
  readonly nonceSha256: string;
  readonly heartbeatIntervalMs: number;
  readonly staleAfterMs: number;
}

/** The values the runtime already holds. `nonce` is `PHOENIX_LEASE_NONCE`; it is hashed and never kept. */
export interface LeaseFactsExpectation {
  readonly runId: string;
  readonly nonce: string;
  readonly heartbeatIntervalMs: number;
  readonly staleAfterMs: number;
}

/** What one successful read gives. Issued only by this module. Frozen. */
export interface LeaseFactsSnapshot {
  readonly declaredBy: "launcher";
  readonly facts: LeaseJsonFacts;
  /** SHA-256 (lowercase hex) of the exact text that was read, as UTF-8. */
  readonly textSha256: string;
}

export type LeaseFactsErrorCode =
  | "expectation_not_plain_object"
  | "expectation_keys"
  | "expectation_run_id_invalid"
  | "expectation_nonce_invalid"
  | "expectation_timing_invalid"
  | "lease_json_not_string"
  | "lease_json_too_large"
  | "lease_json_invalid_json"
  | "lease_json_not_object"
  | "field_missing"
  | "field_unknown"
  | "issued_by_invalid"
  | "run_id_invalid"
  | "launcher_pid_invalid"
  | "launcher_start_ticks_invalid"
  | "nonce_hash_invalid"
  | "heartbeat_invalid"
  | "stale_invalid"
  | "stale_not_above_heartbeat"
  | "run_id_mismatch"
  | "nonce_mismatch"
  | "heartbeat_mismatch"
  | "stale_mismatch"
  | "lease_read_absent"
  | "lease_read_failed"
  | "lease_read_answer_invalid"
  | "lease_json_changed"
  | "snapshot_not_issued";
export type LeaseFactsError = SectionError<LeaseFactsErrorCode>;

const fail = (code: LeaseFactsErrorCode): Result<never, LeaseFactsError> => sectionFail(code);
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const sha256Text = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------------------------------------
// The read port
// ---------------------------------------------------------------------------------------------
/** `absent`: the file does not exist. `error`: anything else (unreadable, not a regular file, too large). */
export type LeaseJsonReadAnswer = { readonly kind: "ok"; readonly text: string } | { readonly kind: "absent" } | { readonly kind: "error" };

/** The one read operation of this unit. There is no write, no list and no other file. */
export interface LeaseJsonReadPort {
  readLeaseJson(): LeaseJsonReadAnswer;
}

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------
/** Pure. Parses the text of `lease.json` under the strict JSON rules (no duplicate key, size bound) and checks the form of every field. */
export function parseLeaseJsonText(text: unknown): Result<LeaseJsonFacts, LeaseFactsError> {
  if (typeof text !== "string") return fail("lease_json_not_string");
  const parsed = strictParse(text, { maxBytes: LEASE_JSON_MAX_BYTES, maxDepth: 4 });
  if (!parsed.ok) return fail(parsed.error.code === "size_exceeded" ? "lease_json_too_large" : "lease_json_invalid_json");
  const root = parsed.value;
  if (!isPlainDataObject(root)) return fail("lease_json_not_object");

  const own = Object.keys(root);
  if (LEASE_JSON_KEYS.some((k) => !own.includes(k))) return fail("field_missing");
  if (!hasExactKeys(root, LEASE_JSON_KEYS)) return fail("field_unknown");

  const field = (k: string): unknown => dataValue(root, k).value;
  if (field("issued_by") !== "launcher") return fail("issued_by_invalid");
  const runId = field("run_id");
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return fail("run_id_invalid");
  const pid = field("launcher_pid");
  if (!posInt(pid) || pid > MAX_PID) return fail("launcher_pid_invalid");
  const ticks = field("launcher_start_ticks");
  if (typeof ticks !== "string" || !TICKS.test(ticks) || BigInt(ticks) > MAX_TICKS) return fail("launcher_start_ticks_invalid");
  const nonce = field("nonce_sha256");
  if (typeof nonce !== "string" || !SHA256_HEX.test(nonce) || nonce === ZERO_SHA256) return fail("nonce_hash_invalid");
  const heartbeat = field("heartbeat_interval_ms");
  if (!posInt(heartbeat)) return fail("heartbeat_invalid");
  const stale = field("stale_after_ms");
  if (!posInt(stale)) return fail("stale_invalid");
  if (stale <= heartbeat) return fail("stale_not_above_heartbeat");

  return {
    ok: true,
    value: Object.freeze({ runId, launcherPid: pid, launcherStartTicks: ticks, nonceSha256: nonce, heartbeatIntervalMs: heartbeat, staleAfterMs: stale }),
  };
}

// ---------------------------------------------------------------------------------------------
// Consistency check and snapshot
// ---------------------------------------------------------------------------------------------
interface CheckedExpectation {
  readonly runId: string;
  readonly nonceSha256: string;
  readonly heartbeatIntervalMs: number;
  readonly staleAfterMs: number;
}

function checkExpectation(input: unknown): Result<CheckedExpectation, LeaseFactsError> {
  if (!isPlainDataObject(input)) return fail("expectation_not_plain_object");
  if (!hasExactKeys(input, ["runId", "nonce", "heartbeatIntervalMs", "staleAfterMs"])) return fail("expectation_keys");
  const runId = dataValue(input, "runId").value;
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return fail("expectation_run_id_invalid");
  const nonce = dataValue(input, "nonce").value;
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > MAX_NONCE_LENGTH) return fail("expectation_nonce_invalid");
  const heartbeat = dataValue(input, "heartbeatIntervalMs").value;
  const stale = dataValue(input, "staleAfterMs").value;
  if (!posInt(heartbeat) || !posInt(stale) || stale <= heartbeat) return fail("expectation_timing_invalid");
  return { ok: true, value: { runId, nonceSha256: sha256Text(nonce), heartbeatIntervalMs: heartbeat, staleAfterMs: stale } };
}

/** Everything this module issued, and nothing else. A copy or a look-alike is not a snapshot. */
const issued = new WeakSet<object>();

/**
 * Pure. Parses the text, then checks that the run id, the SHA-256 of the nonce, and the heartbeat and stale limits equal the values the
 * runtime holds. The result is a frozen snapshot of Launcher-declared values.
 */
export function createLeaseFactsSnapshot(text: unknown, expectation: unknown): Result<LeaseFactsSnapshot, LeaseFactsError> {
  const expected = checkExpectation(expectation);
  if (!expected.ok) return expected;
  const parsed = parseLeaseJsonText(text);
  if (!parsed.ok) return parsed;
  const f = parsed.value;
  if (f.runId !== expected.value.runId) return fail("run_id_mismatch");
  if (f.nonceSha256 !== expected.value.nonceSha256) return fail("nonce_mismatch");
  if (f.heartbeatIntervalMs !== expected.value.heartbeatIntervalMs) return fail("heartbeat_mismatch");
  if (f.staleAfterMs !== expected.value.staleAfterMs) return fail("stale_mismatch");
  const snapshot: LeaseFactsSnapshot = Object.freeze({ declaredBy: "launcher" as const, facts: f, textSha256: sha256Text(text as string) });
  issued.add(snapshot);
  return { ok: true, value: snapshot };
}

/** True only for a snapshot that this module issued. */
export function isLeaseFactsSnapshot(x: unknown): x is LeaseFactsSnapshot {
  return typeof x === "object" && x !== null && issued.has(x);
}

/**
 * Pure. `ok` only when both are snapshots of this module and they are the same: the same text hash and the same value in every field.
 * Anything else, including a value that differs in one field only, is `lease_json_changed`.
 */
export function compareLeaseFactsSnapshots(first: unknown, second: unknown): Result<true, LeaseFactsError> {
  if (!isLeaseFactsSnapshot(first) || !isLeaseFactsSnapshot(second)) return fail("snapshot_not_issued");
  const a = first.facts;
  const b = second.facts;
  const same =
    first.textSha256 === second.textSha256 &&
    a.runId === b.runId &&
    a.launcherPid === b.launcherPid &&
    a.launcherStartTicks === b.launcherStartTicks &&
    a.nonceSha256 === b.nonceSha256 &&
    a.heartbeatIntervalMs === b.heartbeatIntervalMs &&
    a.staleAfterMs === b.staleAfterMs;
  return same ? { ok: true, value: true } : fail("lease_json_changed");
}

// ---------------------------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------------------------
/** One read of the port. An exception, a shape that is not one of the three answers, and a non-string text are refused. */
function readText(port: LeaseJsonReadPort): Result<string, LeaseFactsError> {
  let answer: unknown;
  try {
    answer = port.readLeaseJson();
  } catch {
    return fail("lease_read_failed");
  }
  if (!isPlainDataObject(answer)) return fail("lease_read_answer_invalid");
  const kind = dataValue(answer, "kind").value;
  if (kind === "absent" && hasExactKeys(answer, ["kind"])) return fail("lease_read_absent");
  if (kind === "error" && hasExactKeys(answer, ["kind"])) return fail("lease_read_failed");
  if (kind === "ok" && hasExactKeys(answer, ["kind", "text"])) {
    const text = dataValue(answer, "text").value;
    return typeof text === "string" ? { ok: true, value: text } : fail("lease_read_answer_invalid");
  }
  return fail("lease_read_answer_invalid");
}

/** The start-up snapshot: one read, then `createLeaseFactsSnapshot`. */
export function readLeaseFactsSnapshot(port: LeaseJsonReadPort, expectation: unknown): Result<LeaseFactsSnapshot, LeaseFactsError> {
  const text = readText(port);
  if (!text.ok) return text;
  return createLeaseFactsSnapshot(text.value, expectation);
}

/**
 * The re-read before sealing: one read, no retry. A read that fails is refused. A text that differs from the start-up text by one byte is
 * `lease_json_changed`, before it is parsed. A text that is equal is checked again against the expectation and compared field by field.
 * Returns the start-up snapshot itself (nothing new is issued).
 */
export function confirmLeaseFactsUnchanged(port: LeaseJsonReadPort, expectation: unknown, start: unknown): Result<LeaseFactsSnapshot, LeaseFactsError> {
  if (!isLeaseFactsSnapshot(start)) return fail("snapshot_not_issued");
  const text = readText(port);
  if (!text.ok) return text;
  if (sha256Text(text.value) !== start.textSha256) return fail("lease_json_changed");
  const again = createLeaseFactsSnapshot(text.value, expectation);
  if (!again.ok) return again;
  const same = compareLeaseFactsSnapshots(start, again.value);
  return same.ok ? { ok: true, value: start } : same;
}