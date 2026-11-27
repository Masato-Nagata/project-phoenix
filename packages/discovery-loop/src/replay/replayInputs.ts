// Inputs of a replay (task 4.7, step A2; R12.23, R22.4, R22.5, R22.8; human decisions D1 to D5 of 2026-11-27).
//
// ORDER (fixed; the first failure ends the preparation with `incomplete` and nothing is regenerated):
//   1. ACCEPTANCE. The existing `acceptRun` is called unchanged, through a read-only port that (a) reads every file through a SIZE-BOUNDED
//      read (the limit of a read is the rest of the 64 MiB budget, checked by the port BEFORE the bytes are taken), (b) keeps the bytes it
//      handed to `acceptRun`, and (c) notices a file that was read twice with different bytes. After acceptance only these kept bytes are
//      used: `records.jsonl` and the listed blobs are never read again, so the replay works on the verified data only.
//   2. RECORDS. Every line of the verified `records.jsonl` is strictly parsed (no duplicate key) and validated against the `record-envelope`
//      schema (`additionalProperties: false`); seq, id, prevHash and hash are checked again against the verified chain.
//   3. PLAN. The payloads that the replay uses are checked against their closed shapes and the existing schemas (`experiment`,
//      `observation`, `comparison-result`), and their references are checked (payload_audit -> ai_output -> ai_call, experiment ->
//      policy_decision -> observation -> comparison, blobs, hashes). The Source_Bundle and the template table are restored from the recorded
//      request envelopes and checked against `source_bundle_manifest` and `manifest.sourceBundle`. The pre-replay judgement (a closed list,
//      from the original Run only) refuses what a replay cannot reproduce faithfully.
//   4. EXTERNAL INPUTS. The policy configuration and the preparation table that a human named explicitly: parsed once, loaded with the injected
//      verifier loader, and their hashes compared with `manifest.config` and EVERY `policy_decision`. Nothing is filled in from a default, a
//      current value or the environment.
// Pure apart from the injected read port: no orchestrator, runtime or sibling import, no clock, no environment. No message, path or
// content of a file goes into a result: closed codes only.
import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical/index.js";
import { validateRunConfig, type RunConfig } from "../config/index.js";
import { DEFAULT_PARSE_LIMITS, strictParse, type Json, type SchemaValidator } from "../schema/index.js";
import { joinPath } from "../store/fileSystemPort.js";
import { GENESIS_HASH, RECORDS_FILE } from "../store/runRecordStore.js";
import { acceptRun, type ReadOnlyFileSystemPort } from "../store/runVerification.js";
import type { ReplayIncompleteReason } from "./replaySupport.js";

// ---------------------------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------------------------
/** The budget of everything a replay reads from the Run directory (human decision of 2026-11-27): the sum of the bytes of every read. */
export const REPLAY_CACHE_LIMIT_BYTES = 64 * 1024 * 1024;
/** A directory of a Run with more entries than this is refused (the listing is not part of the byte budget). */
export const REPLAY_MAX_DIR_ENTRIES = 4096;
/** Each external input is at most this size (the parse limit stage B uses for the baked policy data). */
export const EXTERNAL_INPUT_MAX_BYTES = DEFAULT_PARSE_LIMITS.maxBytes;
const RECORD_LINE_LIMITS = Object.freeze({ maxBytes: 8 * 1024 * 1024, maxDepth: 64 });
const ENVELOPE_MAX_DEPTH = 64;

const COPIED_KINDS = ["run_started", "isolation_checks", "source_bundle_manifest"] as const;
const REQUEST_KINDS = ["hypothesis_generation", "experiment_generation", "hypothesis_revision"] as const;
const STORED_TYPES = ["hypothesis_revision", "experiment", "observation", "comparison"] as const;
const TERMINATION_REASONS = [
  "iteration_limit_reached", "experiment_limit_reached", "time_limit_reached", "no_further_experiments", "provider_failure",
  "payload_audit_blocked", "policy_rejection_limit", "isolation_violation", "lease_unavailable", "launcher_killed", "error",
] as const;
/** Ends that depend on the clock, the lease, the Launcher, the isolation measurement, or causes of `error` that the records do not identify. */
export const NOT_REPLAYABLE_TERMINATIONS: readonly string[] = Object.freeze(["time_limit_reached", "lease_unavailable", "launcher_killed", "isolation_violation", "error"]);
/** Record kinds whose presence means an event that a replay cannot reproduce (a lease event, a store rejection, an error record). */
export const NOT_REPLAYABLE_KINDS: readonly string[] = Object.freeze(["lease_event", "store_rejection", "error"]);
/** `not_executed` reasons whose Runner value carries what the Observation does not hold (the lease cause, the `fatal` flag). */
const NOT_RESTORABLE_NOT_EXECUTED: readonly string[] = Object.freeze(["lease_unavailable", "runner_internal_error"]);
const SHA256 = /^[0-9a-f]{64}$/;
const REC_ID = /^rec-[0-9]{6,}$/;

export type Incomplete = { readonly ok: false; readonly reason: ReplayIncompleteReason; readonly detail?: string };
const incomplete = (reason: ReplayIncompleteReason, detail?: string): Incomplete =>
  Object.freeze(detail === undefined ? { ok: false as const, reason } : { ok: false as const, reason, detail });

const sha256Hex = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
type Obj = { [k: string]: Json };
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isText = (v: unknown): v is string => typeof v === "string" && v !== "";
const isHex = (v: unknown): v is string => typeof v === "string" && SHA256.test(v);
const isInt = (v: unknown, lo: number, hi = Number.MAX_SAFE_INTEGER): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;
const inList = (list: readonly string[], v: unknown): v is string => typeof v === "string" && list.includes(v);
/** Exactly these keys (required) plus optionally these. */
function keysAre(o: Obj, required: readonly string[], optional: readonly string[] = []): boolean {
  const keys = Object.keys(o);
  return required.every((k) => Object.hasOwn(o, k)) && keys.every((k) => required.includes(k) || optional.includes(k));
}
const copyBytes = (b: Uint8Array): Uint8Array => new Uint8Array(b);

// ---------------------------------------------------------------------------------------------
// 1. Acceptance through a bounded, capturing port
// ---------------------------------------------------------------------------------------------
export type BoundedRead = { readonly kind: "ok"; readonly bytes: Uint8Array } | { readonly kind: "missing" } | { readonly kind: "too_large" };
/**
 * The only file access of a replay. `readBounded` must refuse a file larger than `maxBytes` WITHOUT taking its bytes (`too_large`), and
 * answer `missing` for a path that is not an existing regular file. `listDir` answers the names of a directory, or `undefined`.
 */
export interface BoundedReadPort {
  listDir(path: string): Promise<string[] | undefined>;
  readBounded(path: string, maxBytes: number): Promise<BoundedRead>;
}

/** Thrown inside `acceptRun` when the budget is exhausted or a listing is too long; caught here, never passed on. */
class ReplayReadLimit extends Error {
  constructor() {
    super("replay read limit");
    this.name = "ReplayReadLimit";
  }
}

interface Capture {
  readonly fs: ReadOnlyFileSystemPort;
  get(path: string): Uint8Array | undefined;
  total(): number;
  limitHit(): boolean;
  changed(): boolean;
}

/** `limitBytes` is the budget of the whole replay: each read may take at most what is left of it. */
export function createCapture(port: BoundedReadPort, limitBytes: number): Capture {
  const kept = new Map<string, Uint8Array>();
  let total = 0;
  let limit = false;
  let changed = false;
  const fs: ReadOnlyFileSystemPort = {
    async listDir(path: string): Promise<string[] | undefined> {
      const names = await port.listDir(path);
      if (names !== undefined && names.length > REPLAY_MAX_DIR_ENTRIES) {
        limit = true;
        throw new ReplayReadLimit();
      }
      return names === undefined ? undefined : [...names];
    },
    async readFile(path: string): Promise<Uint8Array | undefined> {
      const rest = limitBytes - total;
      const r = await port.readBounded(path, rest < 0 ? 0 : rest);
      if (r.kind === "missing") return undefined;
      if (r.kind === "too_large" || r.bytes.byteLength > rest) {
        limit = true;
        throw new ReplayReadLimit();
      }
      total += r.bytes.byteLength;
      const before = kept.get(path);
      if (before !== undefined && sha256Hex(before) !== sha256Hex(r.bytes)) changed = true;
      if (before === undefined) kept.set(path, copyBytes(r.bytes));
      return copyBytes(r.bytes);
    },
  };
  return {
    fs,
    get: (path: string): Uint8Array | undefined => kept.get(path),
    total: (): number => total,
    limitHit: (): boolean => limit,
    changed: (): boolean => changed,
  };
}

export interface AcceptedRun {
  readonly ok: true;
  readonly manifest: Obj;
  /** The verified bytes of `records.jsonl`. */
  readonly recordsBytes: Uint8Array;
  /** The verified listed blobs, by hash. */
  readonly blobs: ReadonlyMap<string, Uint8Array>;
  /** Bytes read from the Run directory (the sum that the budget counts). */
  readonly readBytes: number;
}

const REQUIRED_EXCLUDED_FIELDS = ["runId", "wallClock"];

/** Step 1. Acceptance with the unchanged `acceptRun`; afterwards only the kept bytes. */
export async function acceptForReplay(port: BoundedReadPort, dir: string, validator: SchemaValidator, limitBytes = REPLAY_CACHE_LIMIT_BYTES): Promise<AcceptedRun | Incomplete> {
  const capture = createCapture(port, limitBytes);
  let accepted: Awaited<ReturnType<typeof acceptRun>>;
  try {
    accepted = await acceptRun(capture.fs, dir, { validator });
  } catch {
    if (capture.limitHit()) return incomplete("cache_limit_exceeded");
    return incomplete("run_not_accepted", "read_failed");
  }
  if (capture.limitHit()) return incomplete("cache_limit_exceeded");
  if (capture.changed()) return incomplete("run_changed_during_verification");
  if (!accepted.accepted) return incomplete("run_not_accepted", accepted.reason);
  const manifest = accepted.manifest as Obj;
  const ex = manifest["excludedFields"];
  if (!Array.isArray(ex) || ex.length !== REQUIRED_EXCLUDED_FIELDS.length || !ex.every((v, i) => v === REQUIRED_EXCLUDED_FIELDS[i])) {
    return incomplete("excluded_fields_contract");
  }
  const artifacts = manifest["artifacts"];
  if (!Array.isArray(artifacts)) return incomplete("manifest_invalid", "artifacts");
  let recordsBytes: Uint8Array | undefined;
  const blobs = new Map<string, Uint8Array>();
  for (const a of artifacts) {
    if (!isObj(a)) return incomplete("manifest_invalid", "artifacts");
    const path = a["path"];
    const hash = a["sha256"];
    if (!isStr(path) || !isHex(hash)) return incomplete("manifest_invalid", "artifacts");
    const bytes = capture.get(joinPath(dir, path));
    if (bytes === undefined || sha256Hex(bytes) !== hash) return incomplete("run_changed_during_verification");
    if (path === RECORDS_FILE) recordsBytes = bytes;
    else if (path === `blobs/${hash}`) blobs.set(hash, bytes);
    else return incomplete("manifest_invalid", "artifact_path");
  }
  if (recordsBytes === undefined) return incomplete("records_invalid", "no_records");
  return Object.freeze({ ok: true as const, manifest, recordsBytes, blobs, readBytes: capture.total() });
}

// ---------------------------------------------------------------------------------------------
// 2. Records
// ---------------------------------------------------------------------------------------------
export interface ParsedRecord {
  readonly index: number;
  readonly seq: number;
  readonly id: string;
  readonly kind: string;
  readonly prevHash: string;
  readonly hash: string;
  readonly payload: Obj;
  /** The canonical serialization of the whole record (what D5 compares). */
  readonly canonical: string;
}

/** Step 2. Strict parse and `record-envelope` validation of every verified line; the chain is checked again. */
export function parseRecords(bytes: Uint8Array, validator: SchemaValidator, chain: unknown): { readonly ok: true; readonly records: readonly ParsedRecord[] } | Incomplete {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return incomplete("records_invalid", "utf8");
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] !== "") return incomplete("records_invalid", "unterminated");
  lines.pop();
  const out: ParsedRecord[] = [];
  let prev = GENESIS_HASH;
  for (let i = 0; i < lines.length; i += 1) {
    const parsed = strictParse(lines[i] as string, RECORD_LINE_LIMITS);
    if (!parsed.ok) return incomplete("records_invalid", "parse");
    const valid = validator.validate("record-envelope", parsed.value);
    if (!valid.ok) return incomplete("records_invalid", "record_envelope");
    const r = parsed.value as Obj;
    const { hash, ...head } = r;
    if (r["seq"] !== i + 1 || r["id"] !== `rec-${String(i + 1).padStart(6, "0")}` || r["prevHash"] !== prev || !isHex(hash)) return incomplete("records_invalid", "chain");
    if (sha256Hex(canonicalJson(head as Json)) !== hash) return incomplete("records_invalid", "hash");
    prev = hash;
    out.push(
      Object.freeze({
        index: i,
        seq: i + 1,
        id: r["id"] as string,
        kind: r["kind"] as string,
        prevHash: r["prevHash"] as string,
        hash,
        payload: r["payload"] as Obj,
        canonical: canonicalJson(r as Json),
      }),
    );
  }
  if (!isObj(chain) || chain["records"] !== out.length || chain["lastHash"] !== prev) return incomplete("records_invalid", "chain_count");
  return { ok: true, records: Object.freeze(out) };
}

// ---------------------------------------------------------------------------------------------
// 3. The plan
// ---------------------------------------------------------------------------------------------
export interface ProviderIdentity {
  readonly id: string;
  readonly version: string;
  readonly model: string;
}
export interface RecordedAudit {
  readonly id: string;
  readonly index: number;
  readonly requestKind: string;
  readonly attempt: number;
  readonly result: "pass" | "blocked";
  readonly payloadSha256: string;
  readonly bytesWithheld: boolean;
  readonly checks: readonly { readonly id: string; readonly outcome: string; readonly detail?: string }[];
  readonly matches: readonly { readonly checkId: string; readonly matchId: string }[];
  readonly hasBlob: boolean;
}
export type RecordedAnswer =
  | { readonly outcome: "response"; readonly bytes: Uint8Array; readonly responseSha256: string }
  | { readonly outcome: "provider_error"; readonly providerReason: string }
  | { readonly outcome: "timeout" };
export interface RecordedCall {
  readonly id: string;
  readonly index: number;
  readonly requestKind: string;
  readonly attempt: number;
  readonly payloadAuditRecordId: string;
  readonly requestSha256: string;
  readonly answer: RecordedAnswer;
}
/** The Runner value restored from a recorded Observation under the existing contract (see `restoreRunnerValue`). */
export type RestoredRunnerValue =
  | { readonly status: "executed"; readonly observation: Obj; readonly preparationLog: Json }
  | { readonly status: "not_executed"; readonly reason: string; readonly step?: number; readonly detail?: string; readonly observation: Obj }
  | { readonly status: "aborted"; readonly reason: "address_not_allowed"; readonly observation: Obj };
export interface RecordedExecution {
  readonly experimentId: string;
  readonly experimentRecordId: string;
  /** Canonical JSON of the normalized Experiment the Runner received: the AI Experiment without `localKey`, plus `experimentId`. */
  readonly normalizedCanonical: string;
  readonly decisionRecordId: string;
  /** Absent when the original Run wrote no Observation after the accepted decision. */
  readonly value?: RestoredRunnerValue;
}
export interface RestoredBundle {
  readonly manifest: readonly { readonly path: string; readonly sha256Lf: string }[];
  readonly files: readonly { readonly path: string; readonly text: string }[];
}
export interface ReplayPlan {
  readonly records: readonly ParsedRecord[];
  /** Canonical records of the original Run without the `termination` record. */
  readonly originalCanonical: readonly string[];
  readonly copied: number;
  readonly termination: { readonly index: number; readonly reason: string };
  readonly config: RunConfig;
  readonly configHashes: { readonly policyConfigSha256: string; readonly preparationTableSha256: string };
  readonly identity: ProviderIdentity;
  readonly bundle: RestoredBundle;
  /** templateId -> SHA-256, restored from the recorded envelopes. */
  readonly templates: ReadonlyMap<string, string>;
  /** The template id of each request kind, restored from the recorded envelopes; `undefined` for a kind the original never requested. */
  readonly templateIds: { readonly hypothesis_generation?: string; readonly experiment_generation?: string; readonly hypothesis_revision?: string };
  readonly audits: readonly RecordedAudit[];
  readonly calls: readonly RecordedCall[];
  readonly executions: readonly RecordedExecution[];
  readonly policyDecisions: readonly { readonly id: string; readonly policyConfigSha256: string; readonly preparationTableSha256: string }[];
}

/**
 * The Runner value restored from a recorded Observation, under the existing contract of the verifier Runner (`ExecutionOutcome`):
 *   executed                       -> { status, observation, preparationLog = observation.preparation }
 *   not_executed (reason, step, detail mirrored in `observation.notExecuted`) -> { status, reason, step?, detail?, observation }, except the
 *                                     reasons that carry a lease cause or the `fatal` flag outside the Observation, and the detail
 *                                     `run_time_limit` (a clock-dependent end)
 *   aborted with `address_not_allowed` (no lease cause) -> { status, reason, observation }
 * `timed_out` is never restorable: its `detail` (transport error, Experiment or Run time limit) is not in the Observation, and each detail leads
 * to different records. Anything else is `undefined`.
 */
export function restoreRunnerValue(observation: Obj): RestoredRunnerValue | undefined {
  const outcome = observation["outcome"];
  if (outcome === "executed") {
    const prep = observation["preparation"];
    if (!Array.isArray(prep) || observation["notExecuted"] !== undefined || observation["abortReason"] !== undefined) return undefined;
    return { status: "executed", observation, preparationLog: prep };
  }
  if (outcome === "not_executed") {
    const ne = observation["notExecuted"];
    if (!isObj(ne) || observation["abortReason"] !== undefined) return undefined;
    const reason = ne["reason"];
    if (!isText(reason) || NOT_RESTORABLE_NOT_EXECUTED.includes(reason)) return undefined;
    const detail = ne["detail"];
    if (detail === "run_time_limit") return undefined;
    const step = ne["step"];
    return {
      status: "not_executed",
      reason,
      ...(isInt(step, 0) ? { step } : {}),
      ...(isStr(detail) ? { detail } : {}),
      observation,
    };
  }
  if (outcome === "aborted") {
    if (observation["abortReason"] !== "address_not_allowed" || observation["notExecuted"] !== undefined) return undefined;
    return { status: "aborted", reason: "address_not_allowed", observation };
  }
  return undefined;
}

function checkAuditShape(p: Obj): boolean {
  if (!keysAre(p, ["requestKind", "attempt", "result", "payloadSha256", "bytesWithheld", "checks", "matches"], ["blob"])) return false;
  if (!inList(REQUEST_KINDS, p["requestKind"]) || !isInt(p["attempt"], 1, 11) || (p["result"] !== "pass" && p["result"] !== "blocked")) return false;
  if (!isHex(p["payloadSha256"]) || typeof p["bytesWithheld"] !== "boolean") return false;
  const checks = p["checks"];
  const matches = p["matches"];
  if (!Array.isArray(checks) || !Array.isArray(matches)) return false;
  for (const c of checks) if (!isObj(c) || !keysAre(c, ["id", "outcome"], ["detail"]) || !isStr(c["id"]) || !isStr(c["outcome"]) || (c["detail"] !== undefined && !isStr(c["detail"]))) return false;
  for (const m of matches) if (!isObj(m) || !keysAre(m, ["checkId", "matchId"]) || !isStr(m["checkId"]) || !isStr(m["matchId"])) return false;
  const blob = p["blob"];
  if (blob !== undefined && (!isObj(blob) || !keysAre(blob, ["blob", "bytes"]) || !isHex(blob["blob"]) || !isInt(blob["bytes"], 0))) return false;
  return true;
}

const CALL_BASE = ["requestKind", "attempt", "payloadAuditRecordId", "provider", "requestSha256", "outcome"];
function checkCallShape(p: Obj): boolean {
  const outcome = p["outcome"];
  const extra = outcome === "response" ? ["responseSha256", "responseBytes", "aiOutputRecordId"] : outcome === "timeout" ? ["timeoutBy"] : outcome === "provider_error" ? ["providerReason"] : outcome === "interrupted" ? [] : undefined;
  if (extra === undefined || !keysAre(p, [...CALL_BASE, ...extra])) return false;
  const paId = p["payloadAuditRecordId"];
  if (!inList(REQUEST_KINDS, p["requestKind"]) || !isInt(p["attempt"], 1, 11) || !isStr(paId) || !REC_ID.test(paId) || !isHex(p["requestSha256"])) return false;
  const prov = p["provider"];
  if (!isObj(prov) || !keysAre(prov, ["id", "version", "model"]) || !isStr(prov["id"]) || !isStr(prov["version"]) || !isStr(prov["model"])) return false;
  const outId = p["aiOutputRecordId"];
  if (outcome === "response") return isHex(p["responseSha256"]) && isInt(p["responseBytes"], 0) && isStr(outId) && REC_ID.test(outId);
  if (outcome === "timeout") return p["timeoutBy"] === "provider" || p["timeoutBy"] === "orchestrator";
  if (outcome === "provider_error") return inList(["error", "unmatched_request", "tool_call_detected", "undeterminable"], p["providerReason"]);
  return true;
}

/** Restores and checks the envelope bytes of one audit: canonical JSON, the closed envelope shape, the source parts, the stored parts. */
interface Envelope {
  readonly kind: string;
  readonly templateId: string;
  readonly templateSha256: string;
  readonly sourceCanonical: string;
  readonly bundle: RestoredBundle;
  readonly stored: readonly { readonly type: string; readonly recordId: string; readonly recordSha256: string; readonly contentCanonical: string }[];
}
function readEnvelope(bytes: Uint8Array): Envelope | undefined {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
  const parsed = strictParse(text, { maxBytes: bytes.byteLength + 1, maxDepth: ENVELOPE_MAX_DEPTH });
  if (!parsed.ok || !isObj(parsed.value) || canonicalJson(parsed.value) !== text) return undefined;
  const e = parsed.value;
  const kind = e["kind"];
  if (!keysAre(e, ["schemaVersion", "kind", "instruction", "parts"]) || e["schemaVersion"] !== 1 || !inList(REQUEST_KINDS, kind)) return undefined;
  const ins = e["instruction"];
  if (!isObj(ins) || !keysAre(ins, ["templateId", "sha256"])) return undefined;
  const templateId = ins["templateId"];
  const templateSha256 = ins["sha256"];
  if (!isText(templateId) || !isHex(templateSha256)) return undefined;
  const parts = e["parts"];
  if (!Array.isArray(parts)) return undefined;
  const manifest: { path: string; sha256Lf: string }[] = [];
  const files: { path: string; text: string }[] = [];
  const stored: { type: string; recordId: string; recordSha256: string; contentCanonical: string }[] = [];
  let i = 0;
  for (; i < parts.length; i += 1) {
    const p = parts[i];
    if (!isObj(p) || p["type"] !== "source_file") break;
    const path = p["path"];
    const sha256Lf = p["sha256Lf"];
    const fileText = p["text"];
    if (!keysAre(p, ["partId", "type", "path", "sha256Lf", "text"]) || p["partId"] !== `src-${i + 1}` || !isText(path) || !isHex(sha256Lf) || !isStr(fileText)) return undefined;
    if (sha256Hex(fileText) !== sha256Lf) return undefined;
    manifest.push({ path, sha256Lf });
    files.push({ path, text: fileText });
  }
  if (manifest.length === 0) return undefined;
  for (; i < parts.length; i += 1) {
    const p = parts[i];
    if (!isObj(p) || !keysAre(p, ["partId", "type", "recordId", "recordSha256", "content"])) return undefined;
    const type = p["type"];
    const recordId = p["recordId"];
    const recordSha256 = p["recordSha256"];
    const content = p["content"];
    if (!isText(p["partId"]) || !inList(STORED_TYPES, type) || !isStr(recordId) || !REC_ID.test(recordId) || !isHex(recordSha256) || content === undefined) return undefined;
    stored.push({ type, recordId, recordSha256, contentCanonical: canonicalJson(content) });
  }
  return {
    kind,
    templateId,
    templateSha256,
    sourceCanonical: canonicalJson(parts.slice(0, manifest.length) as Json),
    bundle: { manifest, files },
    stored,
  };
}

/** The effective run configuration of the Run: `manifest.config` without the three keys that the manifest adds, re-validated by stage A. */
function configOf(manifest: Obj): { config: RunConfig; hashes: { policyConfigSha256: string; preparationTableSha256: string } } | undefined {
  const c = manifest["config"];
  if (!isObj(c)) return undefined;
  const { policyConfigSha256, preparationTableSha256, leasePropagationDelayMs, ...effective } = c;
  if (!isHex(policyConfigSha256) || !isHex(preparationTableSha256) || !isInt(leasePropagationDelayMs, 0)) return undefined;
  const v = validateRunConfig(effective);
  if (!v.ok) return undefined;
  if (canonicalJson(v.value as unknown as Json) !== canonicalJson(effective as Json)) return undefined;
  return { config: v.value, hashes: { policyConfigSha256, preparationTableSha256 } };
}

/** Step 3. The plan of the replay, or the closed reason why the Run cannot be replayed faithfully. Decided from the original Run only. */
export function buildReplayPlan(records: readonly ParsedRecord[], manifest: Obj, blobs: ReadonlyMap<string, Uint8Array>, validator: SchemaValidator): { readonly ok: true; readonly plan: ReplayPlan } | Incomplete {
  // the configuration and the provider of the Run
  const cfg = configOf(manifest);
  if (cfg === undefined) return incomplete("manifest_invalid", "config");
  const provider = manifest["provider"];
  if (!isObj(provider)) return incomplete("manifest_invalid", "provider");
  const providerId = provider["id"];
  const providerVersion = provider["version"];
  const providerModel = provider["model"];
  if (!isStr(providerId) || !isStr(providerVersion) || !isStr(providerModel)) return incomplete("manifest_invalid", "provider");
  if (cfg.config.provider !== "mock" || provider["isMock"] !== true) return incomplete("provider_not_mock");
  const identity: ProviderIdentity = Object.freeze({ id: providerId, version: providerVersion, model: providerModel });

  // the termination record: exactly one, the last, equal to the manifest
  const last = records[records.length - 1];
  const terminations = records.filter((r) => r.kind === "termination");
  if (last === undefined || last.kind !== "termination" || terminations.length !== 1) return incomplete("termination_invalid");
  const reason = last.payload["terminationReason"];
  if (!keysAre(last.payload, ["terminationReason"]) || !inList(TERMINATION_REASONS, reason) || manifest["terminationReason"] !== reason) return incomplete("termination_invalid");
  if (NOT_REPLAYABLE_TERMINATIONS.includes(reason)) return incomplete("termination_not_replayable", reason);
  for (const r of records) if (NOT_REPLAYABLE_KINDS.includes(r.kind)) return incomplete("record_kind_not_replayable", r.kind);

  // the leading records: the copied input context of D5
  for (let i = 0; i < COPIED_KINDS.length; i += 1) if (records[i]?.kind !== COPIED_KINDS[i]) return incomplete("leading_records_unexpected");
  for (const r of records.slice(COPIED_KINDS.length)) if ((COPIED_KINDS as readonly string[]).includes(r.kind)) return incomplete("leading_records_unexpected");
  const runStarted = records[0] as ParsedRecord;
  if (Object.keys(runStarted.payload).length !== 0) return incomplete("leading_records_unexpected");
  const sbm = (records[2] as ParsedRecord).payload;
  const sbFiles = sbm["files"];
  if (!keysAre(sbm, ["files"]) || !Array.isArray(sbFiles)) return incomplete("leading_records_unexpected");
  const manifestBundle = manifest["sourceBundle"];
  const manifestFiles = isObj(manifestBundle) ? manifestBundle["files"] : undefined;
  if (!Array.isArray(manifestFiles) || canonicalJson(manifestFiles) !== canonicalJson(sbFiles)) return incomplete("source_bundle_inconsistent", "manifest");

  const byId = new Map<string, ParsedRecord>();
  for (const r of records) byId.set(r.id, r);

  // payload_audit, ai_output, ai_call: shapes, blobs, adjacency and the one-to-one references
  const audits: RecordedAudit[] = [];
  const calls: RecordedCall[] = [];
  const callOfAudit = new Map<string, ParsedRecord>();
  for (const r of records) {
    if (r.kind === "ai_call") {
      if (!checkCallShape(r.payload)) return incomplete("records_invalid", "ai_call");
      const paId = r.payload["payloadAuditRecordId"] as string;
      if (callOfAudit.has(paId)) return incomplete("references_invalid", "ai_call_duplicate");
      callOfAudit.set(paId, r);
      const prov = r.payload["provider"] as Obj;
      if (prov["id"] !== identity.id || prov["version"] !== identity.version || prov["model"] !== identity.model) return incomplete("references_invalid", "provider_identity");
      if (r.payload["outcome"] === "interrupted") return incomplete("provider_outcome_not_restorable", "interrupted");
      if (r.payload["outcome"] === "timeout" && r.payload["timeoutBy"] !== "provider") return incomplete("provider_outcome_not_restorable", "timeout_by_orchestrator");
    } else if (r.kind === "ai_output") {
      const out = r.payload["output"];
      const outBlob = isObj(out) ? out["blob"] : undefined;
      if (!keysAre(r.payload, ["output"]) || !isObj(out) || !keysAre(out, ["blob", "bytes"]) || !isHex(outBlob) || !isInt(out["bytes"], 0)) return incomplete("records_invalid", "ai_output");
      const bytes = blobs.get(outBlob);
      if (bytes === undefined || bytes.byteLength !== out["bytes"]) return incomplete("references_invalid", "ai_output_blob");
    }
  }
  const usedOutputs = new Set<string>();
  let passed = 0;
  let blocked = 0;
  for (const r of records) {
    if (r.kind !== "payload_audit") continue;
    const p = r.payload;
    if (!checkAuditShape(p)) return incomplete("records_invalid", "payload_audit");
    const withheld = p["bytesWithheld"] === true;
    if (withheld) return incomplete("request_bytes_withheld");
    const result = p["result"] as "pass" | "blocked";
    const blob = p["blob"];
    if (isObj(blob)) {
      const bytes = blobs.get(blob["blob"] as string);
      if (blob["blob"] !== p["payloadSha256"] || bytes === undefined || bytes.byteLength !== blob["bytes"]) return incomplete("audit_records_inconsistent", "blob");
    }
    const call = callOfAudit.get(r.id);
    if (result === "pass") {
      passed += 1;
      if (call === undefined) return incomplete("audit_records_inconsistent", "pass_without_call");
      const c = call.payload;
      if (c["requestKind"] !== p["requestKind"] || c["attempt"] !== p["attempt"] || c["requestSha256"] !== p["payloadSha256"]) return incomplete("audit_records_inconsistent", "call_mismatch");
      const outcome = c["outcome"];
      let answer: RecordedAnswer;
      if (outcome === "response") {
        const out = records[r.index + 1];
        if (out === undefined || out.kind !== "ai_output" || out.id !== c["aiOutputRecordId"] || records[r.index + 2]?.id !== call.id) return incomplete("references_invalid", "response_order");
        const o = out.payload["output"] as Obj;
        if (o["blob"] !== c["responseSha256"] || o["bytes"] !== c["responseBytes"] || usedOutputs.has(out.id)) return incomplete("references_invalid", "response_link");
        usedOutputs.add(out.id);
        const bytes = blobs.get(o["blob"] as string) as Uint8Array;
        answer = { outcome: "response", bytes, responseSha256: o["blob"] as string };
      } else {
        if (records[r.index + 1]?.id !== call.id) return incomplete("references_invalid", "call_order");
        answer = outcome === "provider_error" ? { outcome: "provider_error", providerReason: c["providerReason"] as string } : { outcome: "timeout" };
      }
      calls.push(
        Object.freeze({
          id: call.id,
          index: call.index,
          requestKind: c["requestKind"] as string,
          attempt: c["attempt"] as number,
          payloadAuditRecordId: r.id,
          requestSha256: c["requestSha256"] as string,
          answer,
        }),
      );
    } else {
      blocked += 1;
      if (call !== undefined) return incomplete("audit_records_inconsistent", "blocked_with_call");
    }
    audits.push(
      Object.freeze({
        id: r.id,
        index: r.index,
        requestKind: p["requestKind"] as string,
        attempt: p["attempt"] as number,
        result,
        payloadSha256: p["payloadSha256"] as string,
        bytesWithheld: false,
        checks: (p["checks"] as Obj[]).map((c) => (c["detail"] === undefined ? { id: c["id"] as string, outcome: c["outcome"] as string } : { id: c["id"] as string, outcome: c["outcome"] as string, detail: c["detail"] as string })),
        matches: (p["matches"] as Obj[]).map((m) => ({ checkId: m["checkId"] as string, matchId: m["matchId"] as string })),
        hasBlob: isObj(blob),
      }),
    );
  }
  for (const [paId] of callOfAudit) if (byId.get(paId)?.kind !== "payload_audit") return incomplete("references_invalid", "ai_call_target");
  for (const r of records) if (r.kind === "ai_output" && !usedOutputs.has(r.id)) return incomplete("references_invalid", "ai_output_unreferenced");

  // the counts of the Run_Manifest agree with the records; the audit configuration hash is present
  const pa = manifest["payload_audit"];
  if (!isObj(pa) || pa["audits"] !== audits.length || pa["passed"] !== passed || pa["blocked"] !== blocked || pa["configCheck"] !== "pass" || !isHex(pa["auditConfigSha256"])) {
    return incomplete("audit_records_inconsistent", "manifest_counts");
  }

  // the Source_Bundle and the templates, from the recorded envelopes
  let bundle: RestoredBundle | undefined;
  let sourceCanonical: string | undefined;
  const templates = new Map<string, string>();
  const templateIds: { hypothesis_generation?: string; experiment_generation?: string; hypothesis_revision?: string } = {};
  for (const a of audits) {
    if (!a.hasBlob) continue;
    const bytes = blobs.get(a.payloadSha256);
    const env = bytes === undefined ? undefined : readEnvelope(bytes);
    if (env === undefined || env.kind !== a.requestKind) return incomplete("source_bundle_not_restorable", "envelope");
    if (sourceCanonical === undefined) {
      sourceCanonical = env.sourceCanonical;
      bundle = env.bundle;
    } else if (sourceCanonical !== env.sourceCanonical) {
      return incomplete("source_bundle_inconsistent", "envelopes");
    }
    const known = templates.get(env.templateId);
    if (known !== undefined && known !== env.templateSha256) return incomplete("template_inconsistent");
    templates.set(env.templateId, env.templateSha256);
    const kind = env.kind as "hypothesis_generation" | "experiment_generation" | "hypothesis_revision";
    const prior = templateIds[kind];
    if (prior !== undefined && prior !== env.templateId) return incomplete("template_inconsistent");
    templateIds[kind] = env.templateId;
    // every stored part names an earlier record of its type, with the hash and the content of that record's payload
    for (const s of env.stored) {
      const target = byId.get(s.recordId);
      if (target === undefined || target.index >= a.index || target.kind !== s.type) return incomplete("references_invalid", "stored_part");
      const payloadCanonical = canonicalJson(target.payload as Json);
      if (sha256Hex(payloadCanonical) !== s.recordSha256 || payloadCanonical !== s.contentCanonical) return incomplete("references_invalid", "stored_part_hash");
    }
  }
  if (bundle === undefined) return incomplete("source_bundle_not_restorable", "no_envelope");
  if (canonicalJson(bundle.manifest as unknown as Json) !== canonicalJson(sbFiles as Json)) return incomplete("source_bundle_inconsistent", "source_bundle_manifest");

  // experiment -> policy_decision -> observation -> comparison
  const executions: RecordedExecution[] = [];
  const policyDecisions: { id: string; policyConfigSha256: string; preparationTableSha256: string }[] = [];
  for (const r of records) {
    if (r.kind === "experiment") {
      const p = r.payload;
      if (!keysAre(p, ["experimentId", "iteration", "localKey", "target", "experiment"], ["testedClaimRevisionId"]) || !isText(p["experimentId"]) || !isInt(p["iteration"], 0)) return incomplete("records_invalid", "experiment");
      const ai = p["experiment"];
      if (!isObj(ai) || !validator.validate("experiment", ai).ok || ai["localKey"] !== p["localKey"] || canonicalJson(ai["target"] as Json) !== canonicalJson(p["target"] as Json)) return incomplete("records_invalid", "experiment");
    } else if (r.kind === "policy_decision") {
      const p = r.payload;
      if (!keysAre(p, ["experimentId", "decision", "ruleIds", "experimentSha256", "policyConfigSha256", "preparationTableSha256"])) return incomplete("records_invalid", "policy_decision");
      const ruleIds = p["ruleIds"];
      if ((p["decision"] !== "accept" && p["decision"] !== "reject") || !Array.isArray(ruleIds) || !ruleIds.every(isStr)) return incomplete("records_invalid", "policy_decision");
      const experimentSha256 = p["experimentSha256"];
      const policyConfigSha256 = p["policyConfigSha256"];
      const preparationTableSha256 = p["preparationTableSha256"];
      if (!isHex(experimentSha256) || !isHex(policyConfigSha256) || !isHex(preparationTableSha256)) return incomplete("records_invalid", "policy_decision");
      const exp = records[r.index - 1];
      if (exp === undefined || exp.kind !== "experiment" || exp.payload["experimentId"] !== p["experimentId"]) return incomplete("references_invalid", "policy_decision_experiment");
      policyDecisions.push({ id: r.id, policyConfigSha256, preparationTableSha256 });
      if (p["decision"] !== "accept") continue;
      const ai = exp.payload["experiment"] as Obj;
      const normalized: Obj = { experimentId: exp.payload["experimentId"] as string };
      for (const k of Object.keys(ai)) if (k !== "localKey") normalized[k] = ai[k] as Json;
      const next = records[r.index + 1];
      let value: RestoredRunnerValue | undefined;
      if (next !== undefined && next.kind === "observation") {
        if (!validator.validate("observation", next.payload).ok || next.payload["experimentId"] !== p["experimentId"]) return incomplete("records_invalid", "observation");
        value = restoreRunnerValue(next.payload);
        if (value === undefined) return incomplete("observation_not_restorable", String(next.payload["outcome"]));
        const cmp = records[r.index + 2];
        if (cmp === undefined || cmp.kind !== "comparison" || !validator.validate("comparison-result", cmp.payload).ok || cmp.payload["experimentId"] !== p["experimentId"]) return incomplete("references_invalid", "comparison");
      }
      executions.push(
        Object.freeze({
          experimentId: p["experimentId"] as string,
          experimentRecordId: exp.id,
          normalizedCanonical: canonicalJson(normalized),
          decisionRecordId: r.id,
          ...(value === undefined ? {} : { value }),
        }),
      );
    } else if (r.kind === "observation") {
      const pd = records[r.index - 1];
      if (pd === undefined || pd.kind !== "policy_decision" || pd.payload["decision"] !== "accept") return incomplete("references_invalid", "observation_decision");
    } else if (r.kind === "comparison") {
      const obs = records[r.index - 1];
      if (obs === undefined || obs.kind !== "observation") return incomplete("references_invalid", "comparison_observation");
    }
  }
  for (const r of records) {
    if (r.kind === "experiment" && records[r.index + 1]?.kind !== "policy_decision") {
      // an experiment record is always followed by its decision, unless the Run stopped in between (a latched cause, not replayable here)
      return incomplete("references_invalid", "experiment_without_decision");
    }
  }

  const originalCanonical = records.slice(0, records.length - 1).map((r) => r.canonical);
  return {
    ok: true,
    plan: Object.freeze({
      records,
      originalCanonical,
      copied: COPIED_KINDS.length,
      termination: Object.freeze({ index: last.index, reason }),
      config: cfg.config,
      configHashes: cfg.hashes,
      identity,
      bundle,
      templates,
      templateIds: Object.freeze({ ...templateIds }),
      audits: Object.freeze(audits),
      calls: Object.freeze(calls),
      executions: Object.freeze(executions),
      policyDecisions: Object.freeze(policyDecisions),
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// 4. External inputs
// ---------------------------------------------------------------------------------------------
/** The injected verifier loader: `loadPreparationTable`, `loadPolicyConfig(raw, table)`, then the two hashes of OD-17 (as stage B does). */
export type PolicyLoader<TPolicy, TTable> = (
  policyRaw: Json,
  tableRaw: Json,
) => { readonly ok: true; readonly policy: TPolicy; readonly table: TTable; readonly policySha256: string; readonly tableSha256: string } | { readonly ok: false };

export interface LoadedExternalInputs<TPolicy, TTable> {
  readonly ok: true;
  readonly policy: TPolicy;
  readonly table: TTable;
}

/**
 * Step 4. Each input was read ONCE by the caller (bounded); the same bytes are parsed here once and the same loaded objects are handed to the
 * replay. Missing, too large, unparseable, not loadable, or a hash that differs from `manifest.config` or from any `policy_decision`: refused.
 */
export function verifyExternalInputs<TPolicy, TTable>(
  policyRead: BoundedRead,
  tableRead: BoundedRead,
  loader: PolicyLoader<TPolicy, TTable>,
  plan: Pick<ReplayPlan, "configHashes" | "policyDecisions">,
): LoadedExternalInputs<TPolicy, TTable> | Incomplete {
  for (const r of [policyRead, tableRead]) {
    if (r.kind === "missing") return incomplete("external_input_missing");
    if (r.kind === "too_large" || r.bytes.byteLength > EXTERNAL_INPUT_MAX_BYTES) return incomplete("external_input_too_large");
  }
  if (policyRead.kind !== "ok" || tableRead.kind !== "ok") return incomplete("external_input_missing");
  const p = strictParse(policyRead.bytes, DEFAULT_PARSE_LIMITS);
  const t = strictParse(tableRead.bytes, DEFAULT_PARSE_LIMITS);
  if (!p.ok || !t.ok) return incomplete("external_input_invalid", "parse");
  let loaded: ReturnType<PolicyLoader<TPolicy, TTable>>;
  try {
    loaded = loader(p.value, t.value);
  } catch {
    return incomplete("external_input_invalid", "load");
  }
  if (!loaded.ok) return incomplete("external_input_invalid", "load");
  if (loaded.policySha256 !== plan.configHashes.policyConfigSha256 || loaded.tableSha256 !== plan.configHashes.preparationTableSha256) {
    return incomplete("external_input_hash_mismatch");
  }
  for (const d of plan.policyDecisions) {
    if (d.policyConfigSha256 !== loaded.policySha256 || d.preparationTableSha256 !== loaded.tableSha256) return incomplete("policy_decision_hash_mismatch");
  }
  return Object.freeze({ ok: true as const, policy: loaded.policy, table: loaded.table });
}
