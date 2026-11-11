// Evidence_Store write path (design: "Evidence_Store"; R12.1 to R12.6, R12.13, R12.14, R12.17, R17.8, R19.2, R19.7).
//
// One Run writes `records.jsonl` (hash-chained canonical JSON lines) and `blobs/<sha256>` into the Run_Volume
// directory. The API is `append` and `putBlob` (plus `putAiOutput`); a modify or delete request is
// answered with a `store_rejection` record and changes nothing else. There is no Approval code here (R12.3).
import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical/index.js";
import { createSchemaValidator, type Json, type Result, type SchemaValidator } from "../schema/index.js";
import { joinPath, type FileSystemPort } from "./fileSystemPort.js";
import { SecretScanner, type SecretConfig } from "./secretScanner.js";

export const GENESIS_HASH = "0".repeat(64);
export const RECORDS_FILE = "records.jsonl";
export const BLOBS_DIR = "blobs";
export const MANIFEST_FILE = "manifest.json";

export type JsonObject = { [k: string]: Json };
export type RecordKind =
  | "run_started" | "isolation_checks" | "source_bundle_manifest" | "payload_audit" | "ai_call" | "ai_output"
  | "ai_rejected" | "ai_content_discarded" | "hypothesis_revision" | "citation_verification" | "experiment"
  | "experiment_invalid" | "policy_decision" | "experiment_dropped" | "observation" | "comparison" | "evidence"
  | "store_rejection" | "lease_event" | "termination" | "error";

export interface RecordEnvelope {
  schemaVersion: 1;
  seq: number;
  id: string;
  kind: RecordKind;
  prevHash: string;
  payload: JsonObject;
  hash: string;
}
/** Reference to a blob inside a payload (design: "Evidence_Store record envelope"). */
export interface BlobRef {
  blob: string;
  bytes: number;
}

export type OpenError =
  | { kind: "run_volume_missing"; message: string }
  | { kind: "run_volume_not_empty"; message: string };

export type WriteError =
  /** The record is not valid (schema, canonical form). Nothing was written. */
  | { kind: "invalid_record"; message: string }
  /** A secret pattern matched. Nothing of the record was written; a rejection record names the pattern id only. */
  | { kind: "secret_rejected"; patternId: string; rejectionRecordId: string }
  /** A write step failed. The previous records are intact; the store accepts no further writes (R12.14). */
  | { kind: "io_failure"; message: string }
  | { kind: "store_failed"; message: string };

/** A modify or delete request. The target is untouched; the rejection record id is returned. */
export interface RejectedRequest {
  kind: "rejected";
  attempt: "modify_record" | "delete_record";
  rejectionRecordId: string;
}

/**
 * Everything of the Run_Manifest except what the store knows itself: `schemaVersion`, `chain` (record count and
 * last-record hash) and `artifacts` (every file by relative path and SHA-256). Supplying one of those is an error.
 * The rest (config, limits, provider identity, tool versions, termination reason, ...) is validated by the
 * `run-manifest` schema. The schema has no approval field, so Approval_Records cannot be listed (R12.16).
 */
export type ManifestInput = JsonObject;
export interface SealedManifest {
  manifest: JsonObject;
  /** SHA-256 of the exact bytes of `manifest.json`; this is the content of the Completion_Marker. */
  sha256: string;
}

export interface RunRecordStoreOptions {
  secrets?: SecretConfig;
  validator?: SchemaValidator;
}
export interface WriteOptions {
  /** Identity of the writer, named in a rejection record. */
  component?: string;
}

const REC_ID_RE = /^rec-[0-9]{6,}$/;
const sha256Hex = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const enc = new TextEncoder();

function safeComponent(raw: string | undefined): string {
  const c = (raw ?? "").trim();
  return c === "" ? "unknown" : c.slice(0, 64);
}

export class RunRecordStore {
  private readonly records: RecordEnvelope[] = [];
  private bytes: Uint8Array = new Uint8Array(0);
  private lastHash = GENESIS_HASH;
  private failure: string | undefined;
  private blobsDirReady = false;
  private readonly knownBlobs = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private sealed = false;

  private constructor(
    private readonly fs: FileSystemPort,
    private readonly dir: string,
    private readonly scanner: SecretScanner,
    private readonly validator: SchemaValidator,
  ) {}

  /**
   * Opens the store on the mounted Run_Volume directory. Refuses unless the directory exists (the
   * Launcher creates it, C3) and is empty (R12.1, R12.2). It creates nothing here and assumes no
   * particular host file system.
   */
  static async open(
    fs: FileSystemPort,
    dir: string,
    options: RunRecordStoreOptions = {},
  ): Promise<Result<RunRecordStore, OpenError>> {
    const names = await fs.listDir(dir);
    if (names === undefined) return { ok: false, error: { kind: "run_volume_missing", message: "the Run_Volume directory does not exist" } };
    if (names.length > 0) {
      return { ok: false, error: { kind: "run_volume_not_empty", message: `the Run_Volume directory is not empty (${names.length} entries)` } };
    }
    return {
      ok: true,
      value: new RunRecordStore(fs, dir, new SecretScanner(options.secrets), options.validator ?? createSchemaValidator()),
    };
  }

  get count(): number {
    return this.records.length;
  }
  get lastRecordHash(): string {
    return this.lastHash;
  }
  /** Copy of the stored records, oldest first. */
  list(): readonly RecordEnvelope[] {
    return structuredClone(this.records);
  }

  /** Appends one record. All-or-nothing: a rejected or failed write leaves the stored records unchanged. */
  append(kind: RecordKind, payload: JsonObject, options: WriteOptions = {}): Promise<Result<RecordEnvelope, WriteError>> {
    return this.serial(() => this.appendNow(kind, payload, options));
  }

  /** Stores exact bytes as `blobs/<sha256>` and returns the reference. Secret content rejects the whole blob. */
  putBlob(data: Uint8Array, options: WriteOptions = {}): Promise<Result<BlobRef, WriteError>> {
    return this.serial(() => this.putBlobNow(data, options));
  }

  /**
   * Stores AI output as the exact received bytes (blob named by its SHA-256) and appends an `ai_output`
   * record that references the blob (R17.8). Nothing is decoded, trimmed or normalized.
   */
  putAiOutput(data: Uint8Array, options: WriteOptions = {}): Promise<Result<{ record: RecordEnvelope; blob: BlobRef }, WriteError>> {
    return this.serial(async () => {
      const blob = await this.putBlobNow(data, options);
      if (!blob.ok) return blob;
      const rec = await this.appendNow("ai_output", { output: { blob: blob.value.blob, bytes: blob.value.bytes } }, options);
      return rec.ok ? { ok: true as const, value: { record: rec.value, blob: blob.value } } : rec;
    });
  }

  /**
   * Seals the Run: writes exactly one `manifest.json` (R12.8). It lists `records.jsonl` (when records exist) and every
   * blob by relative path and SHA-256, and carries the record count and last-record hash. It does not list itself.
   * After a successful seal the store accepts no further writes and a second seal fails. A secret hit in the input
   * appends a rejection record, writes no manifest and leaves the store unsealed.
   */
  seal(input: ManifestInput, options: WriteOptions = {}): Promise<Result<SealedManifest, WriteError>> {
    return this.serial(() => this.sealNow(input, options));
  }

  /** A request to modify a stored record is refused and recorded (R12.5). The record stays byte-identical. */
  requestModify(recordId: string, component: string): Promise<Result<never, WriteError | RejectedRequest>> {
    return this.rejectRequest("modify_record", recordId, component);
  }
  /** A request to delete a stored record is refused and recorded (R12.5). */
  requestDelete(recordId: string, component: string): Promise<Result<never, WriteError | RejectedRequest>> {
    return this.rejectRequest("delete_record", recordId, component);
  }

  // ---------------------------------------------------------------------------------------------

  private serial<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private rejectRequest(
    attempt: "modify_record" | "delete_record",
    recordId: string,
    component: string,
  ): Promise<Result<never, WriteError | RejectedRequest>> {
    return this.serial(async () => {
      const payload: JsonObject = {
        attempt,
        component: safeComponent(component),
        reason: attempt === "modify_record" ? "stored records cannot be modified" : "stored records cannot be deleted",
        ...(REC_ID_RE.test(recordId) ? { targetRecordId: recordId } : {}),
      };
      const rec = await this.appendNow("store_rejection", payload, { component });
      if (!rec.ok) return rec;
      return { ok: false as const, error: { kind: "rejected" as const, attempt, rejectionRecordId: rec.value.id } };
    });
  }

  private failed(): WriteError | undefined {
    if (this.sealed) return { kind: "store_failed", message: "the Run is sealed" };
    return this.failure === undefined ? undefined : { kind: "store_failed", message: this.failure };
  }

  private async sealNow(input: ManifestInput, options: WriteOptions): Promise<Result<SealedManifest, WriteError>> {
    const down = this.failed();
    if (down) return { ok: false, error: down };
    for (const key of ["schemaVersion", "chain", "artifacts"]) {
      if (key in input) return { ok: false, error: { kind: "invalid_record", message: `the manifest input must not set ${key}` } };
    }
    const target = joinPath(this.dir, MANIFEST_FILE);
    let existing: Uint8Array | undefined;
    try {
      existing = await this.fs.readFile(target);
    } catch (e) {
      return this.fail(e, []); // a failed read is an unrecoverable write-path error too (R12.14)
    }
    if (existing !== undefined) {
      return { ok: false, error: { kind: "store_failed", message: `${MANIFEST_FILE} already exists` } };
    }
    const artifacts: { path: string; sha256: string }[] = [
      ...(this.records.length > 0 ? [{ path: RECORDS_FILE, sha256: sha256Hex(this.bytes) }] : []),
      ...[...this.knownBlobs].map((h) => ({ path: `${BLOBS_DIR}/${h}`, sha256: h })),
    ].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const manifest: JsonObject = {
      schemaVersion: 1,
      ...input,
      chain: { records: this.records.length, lastHash: this.lastHash },
      artifacts,
    };

    let bytes: Uint8Array;
    try {
      const hit = this.scanner.scanRecord(manifest);
      if (hit !== undefined) return this.rejectSecret(hit, options);
      bytes = enc.encode(`${canonicalJson(manifest)}\n`);
    } catch (e) {
      return { ok: false, error: { kind: "invalid_record", message: `not canonical JSON: ${(e as { issue?: { code?: string } }).issue?.code ?? "error"}` } };
    }
    const checked = this.validator.validate("run-manifest", manifest);
    if (!checked.ok) {
      const first = checked.error[0];
      return { ok: false, error: { kind: "invalid_record", message: `invalid manifest: ${first?.code ?? "?"} at ${first?.path ?? ""}` } };
    }

    const tmp = `${target}.tmp`;
    try {
      await this.fs.writeFileSynced(tmp, bytes);
      await this.fs.rename(tmp, target);
      await this.fs.syncDir(this.dir);
    } catch (e) {
      return this.fail(e, [tmp]);
    }
    this.sealed = true;
    return { ok: true, value: { manifest, sha256: sha256Hex(bytes) } };
  }

  private build(kind: RecordKind, payload: JsonObject): RecordEnvelope {
    const seq = this.records.length + 1;
    const head = {
      schemaVersion: 1 as const,
      seq,
      id: `rec-${String(seq).padStart(6, "0")}`,
      kind,
      prevHash: this.lastHash,
      payload,
    };
    return { ...head, hash: sha256Hex(canonicalJson(head as unknown as Json)) };
  }

  private async appendNow(kind: RecordKind, payload: JsonObject, options: WriteOptions): Promise<Result<RecordEnvelope, WriteError>> {
    const down = this.failed();
    if (down) return { ok: false, error: down };

    let envelope: RecordEnvelope;
    let secretHit: string | undefined;
    try {
      envelope = this.build(kind, payload);
      secretHit = this.scanner.scanRecord(envelope as unknown as Json);
    } catch (e) {
      return { ok: false, error: { kind: "invalid_record", message: `not canonical JSON: ${(e as { issue?: { code?: string } }).issue?.code ?? "error"}` } };
    }
    if (secretHit !== undefined) return this.rejectSecret(secretHit, options);

    const checked = this.validator.validate("record-envelope", envelope);
    if (!checked.ok) {
      const first = checked.error[0];
      return { ok: false, error: { kind: "invalid_record", message: `invalid record: ${first?.code ?? "?"} at ${first?.path ?? ""}` } };
    }
    return this.persist(envelope);
  }

  /** Appends the rejection for a secret hit. The rejection never contains the matched value. */
  private async rejectSecret(patternId: string, options: WriteOptions): Promise<Result<never, WriteError>> {
    let component = safeComponent(options.component);
    if (this.scanner.scanText(component) !== undefined) component = "redacted";
    const payload: JsonObject = {
      attempt: "secret_pattern",
      component,
      patternId,
      reason: "content matched a configured secret pattern and was not written",
    };
    const envelope = this.build("store_rejection", payload);
    const checked = this.validator.validate("record-envelope", envelope);
    if (!checked.ok) return { ok: false, error: { kind: "invalid_record", message: "rejection record invalid" } };
    const written = await this.persist(envelope);
    if (!written.ok) return written;
    return { ok: false, error: { kind: "secret_rejected", patternId, rejectionRecordId: envelope.id } };
  }

  /** Atomic write (design): old bytes + new line to a temp file, fsync, rename over, sync the directory. */
  private async persist(envelope: RecordEnvelope): Promise<Result<RecordEnvelope, WriteError>> {
    const line = enc.encode(`${canonicalJson(envelope as unknown as Json)}\n`);
    const next = new Uint8Array(this.bytes.length + line.length);
    next.set(this.bytes, 0);
    next.set(line, this.bytes.length);
    const target = joinPath(this.dir, RECORDS_FILE);
    const tmp = `${target}.tmp`;
    try {
      await this.fs.writeFileSynced(tmp, next);
      await this.fs.rename(tmp, target);
      await this.fs.syncDir(this.dir);
    } catch (e) {
      return this.fail(e, [tmp]);
    }
    this.bytes = next;
    this.records.push(envelope);
    this.lastHash = envelope.hash;
    return { ok: true, value: envelope };
  }

  private async putBlobNow(data: Uint8Array, options: WriteOptions): Promise<Result<BlobRef, WriteError>> {
    const down = this.failed();
    if (down) return { ok: false, error: down };
    const hit = this.scanner.scanBytes(data);
    if (hit !== undefined) return this.rejectSecret(hit, options);
    const hash = sha256Hex(data);
    const ref: BlobRef = { blob: hash, bytes: data.length };
    if (this.knownBlobs.has(hash)) return { ok: true, value: ref };
    const blobsDir = joinPath(this.dir, BLOBS_DIR);
    const target = joinPath(blobsDir, hash);
    const tmp = `${target}.tmp`;
    try {
      if (!this.blobsDirReady) {
        await this.fs.mkdir(blobsDir);
        this.blobsDirReady = true;
      }
      await this.fs.writeFileSynced(tmp, data);
      await this.fs.rename(tmp, target);
      await this.fs.syncDir(blobsDir);
    } catch (e) {
      return this.fail(e, [tmp]);
    }
    this.knownBlobs.add(hash);
    return { ok: true, value: ref };
  }

  private async fail(e: unknown, tmpFiles: string[]): Promise<Result<never, WriteError>> {
    const message = `write failed: ${(e as { code?: string } | null)?.code ?? (e instanceof Error ? e.name : "error")}`;
    this.failure = message;
    for (const t of tmpFiles) {
      try {
        await this.fs.removeFile(t);
      } catch {
        // A stale temporary file is reported as `unlisted` by verification (design).
      }
    }
    return { ok: false, error: { kind: "io_failure", message } };
  }
}
