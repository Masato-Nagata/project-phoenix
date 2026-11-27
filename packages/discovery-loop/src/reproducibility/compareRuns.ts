// Reproducibility comparison of two Runs (R22.1, R22.7, R22.8, R22.9; task 4.7, step A1).
//
// Order of work (fixed):
//   1. Each Run is accepted with the one reader acceptance function `acceptRun` (R12.23, R12.24). Acceptance is NOT weakened or
//      re-implemented here. Both Runs are accepted before anything is compared; a Run that is not accepted is `incomplete` and
//      nothing is compared (R22.8).
//   2. The bytes of `records.jsonl` that `acceptRun` read and verified are the bytes that are compared. The file is not read a second
//      time, so the verified content and the compared content cannot differ.
//   3. The ordered record sequences are compared by CANONICAL serialization of each parsed record (R22.1). Raw bytes of `records.jsonl`
//      are not compared: verification recomputes each hash from the parsed record, so it does not guarantee that a stored line is itself
//      in canonical form.
//
// What is compared: the ordered records, in full (`schemaVersion`, `seq`, `id`, `kind`, `prevHash`, `payload`, `hash`). Not compared (R22.9
// and R22.1): the Run_Manifest as a whole (its run id and wall-clock values are the excluded fields), the Completion_Marker, the
// Reason_File and the Launcher record. Records hold none of the excluded fields (the envelope has no run id or wall-clock field and the
// `run_started` payload is empty), so removing them from a record is the identity and nothing else is removed. No other field is excluded.
// A blob is content-addressed: its name is its SHA-256, `acceptRun` verified every listed blob against that name, and records carry the
// blob hash, so equal canonical records mean equal blobs.
import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical/index.js";
import type { Json, SchemaValidator } from "../schema/index.js";
import { joinPath } from "../store/fileSystemPort.js";
import { RECORDS_FILE } from "../store/runRecordStore.js";
import { acceptRun, type Mismatch, type ReadOnlyFileSystemPort, type RunAcceptance, type RunRejectionReason } from "../store/runVerification.js";

/** The excluded fields every Run_Manifest must list (R22.1). The run-manifest schema holds the same constant. */
export const REQUIRED_EXCLUDED_FIELDS: readonly string[] = Object.freeze(["runId", "wallClock"]);

export type CompareRejectionReason = RunRejectionReason | "excluded_fields_contract";
export type CompareSideStatus =
  | { accepted: true }
  | { accepted: false; reason: CompareRejectionReason; detail?: string; mismatches?: Mismatch[] };

export type CompareRunsResult =
  | { result: "identical"; records: number }
  | {
      result: "different";
      /** Record id of the first record that is present in only one Run, or whose canonical form differs. */
      firstDifferingRecord: string;
      difference: "content" | "only_in_a" | "only_in_b";
      recordsA: number;
      recordsB: number;
    }
  | { result: "incomplete"; a: CompareSideStatus; b: CompareSideStatus };

export interface CompareRunsOptions {
  /** Passed to `acceptRun` unchanged. */
  validator?: SchemaValidator;
}

export type CompareInternalCode = "records_read_inconsistent" | "records_hash_mismatch" | "records_unparseable" | "chain_count_mismatch";
/**
 * A state that acceptance rules out. It is thrown, never returned as a comparison result, so an internal fault cannot be mistaken for
 * `identical`, `different` or `incomplete`.
 */
export class CompareRunsInternalError extends Error {
  constructor(readonly code: CompareInternalCode) {
    super(`compareRuns internal error: ${code}`);
    this.name = "CompareRunsInternalError";
  }
}

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const dec = new TextDecoder("utf-8", { fatal: false });

interface AcceptedSide {
  status: CompareSideStatus;
  /** Canonical serialization of each record, in order. Present only when the side is accepted. */
  records?: string[];
}

/** The reads of one `acceptRun` call. The bytes of `records.jsonl` that were verified are kept and reused. */
function capturingPort(fs: ReadOnlyFileSystemPort, recordsPath: string): { port: ReadOnlyFileSystemPort; recordsReads: () => number; recordsBytes: () => Uint8Array | undefined } {
  let reads = 0;
  let captured: Uint8Array | undefined;
  const port: ReadOnlyFileSystemPort = {
    listDir: (path) => fs.listDir(path),
    async readFile(path) {
      const bytes = await fs.readFile(path);
      if (path === recordsPath) {
        reads += 1;
        captured = bytes;
      }
      return bytes;
    },
  };
  return { port, recordsReads: () => reads, recordsBytes: () => captured };
}

function rejected(a: Extract<RunAcceptance, { accepted: false }>): CompareSideStatus {
  const mismatches = a.report?.mismatches ?? [];
  return {
    accepted: false,
    reason: a.reason,
    ...(a.report?.detail !== undefined ? { detail: a.report.detail } : {}),
    ...(mismatches.length > 0 ? { mismatches } : {}),
  };
}

function excludedFieldsHold(manifest: { [k: string]: Json }): boolean {
  const ex = manifest["excludedFields"];
  return Array.isArray(ex) && ex.length === REQUIRED_EXCLUDED_FIELDS.length && ex.every((v, i) => v === REQUIRED_EXCLUDED_FIELDS[i]);
}

function canonicalRecords(bytes: Uint8Array | undefined): string[] {
  if (bytes === undefined) return [];
  const lines = dec.decode(bytes).split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => {
    try {
      return canonicalJson(JSON.parse(line) as Json);
    } catch {
      throw new CompareRunsInternalError("records_unparseable");
    }
  });
}

async function acceptSide(fs: ReadOnlyFileSystemPort, dir: string, options: CompareRunsOptions): Promise<AcceptedSide> {
  const cap = capturingPort(fs, joinPath(dir, RECORDS_FILE));
  const accepted = await acceptRun(cap.port, dir, options.validator !== undefined ? { validator: options.validator } : {});
  if (!accepted.accepted) return { status: rejected(accepted) };
  if (!excludedFieldsHold(accepted.manifest)) return { status: { accepted: false, reason: "excluded_fields_contract" } };

  // Consistency of what was read: `acceptRun` reads `records.jsonl` once, and the bytes it verified are the bytes used below.
  if (cap.recordsReads() !== 1) throw new CompareRunsInternalError("records_read_inconsistent");
  const bytes = cap.recordsBytes();
  const artifacts = accepted.manifest["artifacts"] as { path: string; sha256: string }[];
  const listed = artifacts.find((x) => x.path === RECORDS_FILE);
  if (bytes === undefined ? listed !== undefined : listed === undefined || listed.sha256 !== sha256Hex(bytes)) {
    throw new CompareRunsInternalError("records_hash_mismatch");
  }
  const records = canonicalRecords(bytes);
  if (records.length !== (accepted.manifest["chain"] as { records: number }).records) throw new CompareRunsInternalError("chain_count_mismatch");
  return { status: { accepted: true }, records };
}

const recordId = (index: number): string => `rec-${String(index + 1).padStart(6, "0")}`;

/**
 * Compares two Runs for reproducibility (R22.1, R22.7). Reads only; never writes. Throws `CompareRunsInternalError` for a state that
 * acceptance excludes, and rethrows a failed read.
 */
export async function compareRuns(fs: ReadOnlyFileSystemPort, dirA: string, dirB: string, options: CompareRunsOptions = {}): Promise<CompareRunsResult> {
  const a = await acceptSide(fs, dirA, options);
  const b = await acceptSide(fs, dirB, options);
  if (a.records === undefined || b.records === undefined) return { result: "incomplete", a: a.status, b: b.status };

  const ra = a.records;
  const rb = b.records;
  const common = Math.min(ra.length, rb.length);
  const different = (index: number, difference: "content" | "only_in_a" | "only_in_b"): CompareRunsResult => ({
    result: "different",
    firstDifferingRecord: recordId(index),
    difference,
    recordsA: ra.length,
    recordsB: rb.length,
  });
  for (let i = 0; i < common; i += 1) {
    if (ra[i] !== rb[i]) return different(i, "content");
  }
  if (ra.length > common) return different(common, "only_in_a");
  if (rb.length > common) return different(common, "only_in_b");
  return { result: "identical", records: ra.length };
}