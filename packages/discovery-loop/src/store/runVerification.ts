// Evidence_Store verification and the reader acceptance function (design: "Verification operation (read-only)";
// R12.7 to R12.11, R12.16, R12.23, R12.24, A9).
//
// Everything here works through `ReadOnlyFileSystemPort` (listDir, readFile): there is no write, rename, mkdir or
// remove in reach, so verification cannot modify a Run directory (R12.10). The Completion_Marker is written by the
// Launcher (M2); this module only reads it.
import { createHash } from "node:crypto";
import { canonicalJson } from "../canonical/index.js";
import { createSchemaValidator, type Json, type SchemaValidator } from "../schema/index.js";
import { joinPath, type FileSystemPort } from "./fileSystemPort.js";
import { GENESIS_HASH, MANIFEST_FILE, RECORDS_FILE, type JsonObject } from "./runRecordStore.js";

/** The only file-system operations verification may use. */
export type ReadOnlyFileSystemPort = Pick<FileSystemPort, "listDir" | "readFile">;

/** Completion_Marker: the SHA-256 of `manifest.json`, written last by the Launcher (design: "Layout"). */
export const COMPLETION_MARKER_FILE = "COMPLETE";
/** Reason_File: failing step or `interrupted`, written by the Launcher into an incomplete export. */
export const REASON_FILE = "REASON.json";
/** Directory under `discovery/runs/` that is never a source of complete Runs (R12.24). */
export const INCOMING_DIR = ".incoming";

/** The only files in a Run directory that the Run_Manifest need not list (R12.9). The manifest does not list itself. */
const UNLISTED_OK: ReadonlySet<string> = new Set([MANIFEST_FILE, COMPLETION_MARKER_FILE, REASON_FILE]);
const MAX_WALK_DEPTH = 16;
const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
const HEX64 = /^[0-9a-f]{64}$/;

export type MismatchKind = "modified" | "missing" | "unlisted" | "chain_break";
export interface Mismatch {
  /** Record id (`rec-000007`, or `manifest.chain`) for a chain break, relative path otherwise. */
  where: string;
  kind: MismatchKind;
}
export type IncompleteReason = "no_manifest" | "manifest_invalid" | "no_completion_marker";
export interface VerificationReport {
  result: "success" | "failure";
  /** True when there is no usable Run_Manifest, or (with `requireMarker`) no Completion_Marker (R12.11). */
  incomplete: boolean;
  /** Sorted by `where`, then `kind`. Empty when incomplete. */
  mismatches: Mismatch[];
  /** Present when `incomplete` is true. `manifest_invalid` carries the reason in `detail`. */
  incompleteReason?: IncompleteReason;
  detail?: string;
  /** SHA-256 of the exact bytes of `manifest.json`, when it exists. */
  manifestSha256?: string;
}
export interface VerifyOptions {
  /** A completed Run directory must hold a Completion_Marker; a Run_Volume or Incoming_Export need not. */
  requireMarker?: boolean;
  validator?: SchemaValidator;
}

const sha256Hex = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const dec = new TextDecoder("utf-8", { fatal: false });
let defaultValidator: SchemaValidator | undefined;
const validatorOf = (v?: SchemaValidator): SchemaValidator => v ?? (defaultValidator ??= createSchemaValidator());

function safeRelativePath(p: string): boolean {
  if (p === "" || p.includes("\\") || p.includes("\0") || p.startsWith("/")) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

interface Internal {
  report: VerificationReport;
  manifest?: JsonObject;
  markerText?: string;
}

async function verifyInternal(fs: ReadOnlyFileSystemPort, dir: string, options: VerifyOptions): Promise<Internal> {
  const incomplete = (reason: IncompleteReason, detail: string | undefined, manifestSha256?: string): Internal => ({
    report: {
      result: "failure",
      incomplete: true,
      mismatches: [],
      incompleteReason: reason,
      ...(detail !== undefined ? { detail } : {}),
      ...(manifestSha256 !== undefined ? { manifestSha256 } : {}),
    },
  });

  // 1. Run_Manifest and, for a completed Run directory, Completion_Marker.
  const manifestBytes = await fs.readFile(joinPath(dir, MANIFEST_FILE));
  if (manifestBytes === undefined) return incomplete("no_manifest", undefined);
  const manifestSha256 = sha256Hex(manifestBytes);
  const markerBytes = await fs.readFile(joinPath(dir, COMPLETION_MARKER_FILE));
  const markerText = markerBytes === undefined ? undefined : dec.decode(markerBytes);
  if (options.requireMarker === true && markerText === undefined) return incomplete("no_completion_marker", undefined, manifestSha256);

  const parsed = validatorOf(options.validator).parseAndValidate("run-manifest", manifestBytes, {
    maxBytes: MAX_MANIFEST_BYTES,
    maxDepth: 32,
  });
  if (!parsed.ok) {
    const first = parsed.error[0];
    return { ...incomplete("manifest_invalid", `${first?.code ?? "invalid"} at ${first?.path ?? ""}`, manifestSha256), ...(markerText !== undefined ? { markerText } : {}) };
  }
  const manifest = parsed.value as JsonObject;
  const artifacts = manifest["artifacts"] as { path: string; sha256: string }[];
  const chain = manifest["chain"] as { records: number; lastHash: string };

  const listed = new Map<string, string>();
  for (const a of artifacts) {
    if (!safeRelativePath(a.path)) return { ...incomplete("manifest_invalid", "artifact path is not a safe relative path", manifestSha256), ...(markerText !== undefined ? { markerText } : {}) };
    if (UNLISTED_OK.has(a.path)) return { ...incomplete("manifest_invalid", `artifact list names ${a.path}`, manifestSha256), ...(markerText !== undefined ? { markerText } : {}) };
    if (listed.has(a.path)) return { ...incomplete("manifest_invalid", "artifact path listed twice", manifestSha256), ...(markerText !== undefined ? { markerText } : {}) };
    listed.set(a.path, a.sha256);
  }

  const found = new Map<string, Mismatch>();
  const flag = (where: string, kind: MismatchKind): void => {
    found.set(`${kind}\0${where}`, { where, kind });
  };
  const cache = new Map<string, Uint8Array | undefined>();
  const read = async (rel: string): Promise<Uint8Array | undefined> => {
    if (!cache.has(rel)) cache.set(rel, await fs.readFile(joinPath(dir, rel)));
    return cache.get(rel);
  };

  // 2. Hash of every listed artifact.
  for (const [rel, expected] of listed) {
    const bytes = await read(rel);
    if (bytes === undefined) flag(rel, "missing");
    else if (sha256Hex(bytes) !== expected) flag(rel, "modified");
    else if (rel.startsWith("blobs/") && rel !== `blobs/${expected}`) flag(rel, "modified"); // blob name is its hash
  }

  // 3. Files present but not listed (stale `.tmp` files included).
  const present: string[] = [];
  await walk(fs, dir, "", present, 0);
  for (const rel of present) {
    if (listed.has(rel)) continue;
    if (!rel.includes("/") && UNLISTED_OK.has(rel)) continue;
    flag(rel, "unlisted");
  }

  // 4. Hash chain, then chain count and last hash against the manifest.
  const recordsBytes = await read(RECORDS_FILE);
  const blobRefs = new Set<string>();
  let count = 0;
  let lastStored = GENESIS_HASH;
  if (recordsBytes !== undefined) {
    const text = dec.decode(recordsBytes);
    const lines = text.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    else if (lines.length > 0) flag(`rec-${String(lines.length).padStart(6, "0")}`, "chain_break"); // unterminated last line
    let prev = GENESIS_HASH;
    for (const [i, line] of lines.entries()) {
      const n = i + 1;
      const expectedId = `rec-${String(n).padStart(6, "0")}`;
      count = n;
      let rec: unknown;
      try {
        rec = JSON.parse(line);
      } catch {
        flag(expectedId, "chain_break");
        continue;
      }
      const r = rec as Record<string, unknown> | null;
      if (
        r === null || typeof r !== "object" || Array.isArray(r) ||
        r["seq"] !== n || r["id"] !== expectedId || typeof r["hash"] !== "string" || typeof r["prevHash"] !== "string" ||
        r["prevHash"] !== prev
      ) {
        flag(expectedId, "chain_break");
      } else {
        const { hash, ...head } = r;
        let recomputed: string | undefined;
        try {
          recomputed = sha256Hex(canonicalJson(head as Json));
        } catch {
          recomputed = undefined;
        }
        if (recomputed !== hash) flag(expectedId, "chain_break");
        collectBlobRefs(r["payload"], blobRefs);
      }
      // Continue from the stored hash: one altered record shows up as one break, not as a break at every later record.
      if (r !== null && typeof r === "object" && typeof r["hash"] === "string") {
        prev = r["hash"];
        lastStored = r["hash"];
      }
    }
  }
  if (chain.records !== count) flag("manifest.chain", "chain_break");
  else if (chain.lastHash !== lastStored) flag("manifest.chain", "chain_break");

  // 5. Each blob reference resolves to a listed blob.
  for (const b of blobRefs) {
    if (!listed.has(`blobs/${b}`)) flag(`blobs/${b}`, "missing");
  }

  const mismatches = [...found.values()].sort((a, b) =>
    a.where < b.where ? -1 : a.where > b.where ? 1 : a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0,
  );
  return {
    manifest,
    ...(markerText !== undefined ? { markerText } : {}),
    report: { result: mismatches.length === 0 ? "success" : "failure", incomplete: false, mismatches, manifestSha256 },
  };
}

async function walk(fs: ReadOnlyFileSystemPort, root: string, rel: string, out: string[], depth: number): Promise<void> {
  const names = await fs.listDir(rel === "" ? root : joinPath(root, rel));
  if (names === undefined) return;
  for (const name of names) {
    const childRel = rel === "" ? name : `${rel}/${name}`;
    const sub = await fs.listDir(joinPath(root, childRel));
    if (sub === undefined) out.push(childRel);
    else if (depth >= MAX_WALK_DEPTH) out.push(`${childRel}/`); // too deep to be a Run artifact: reported unlisted
    else await walk(fs, root, childRel, out, depth + 1);
  }
}

function collectBlobRefs(v: unknown, out: Set<string>): void {
  if (Array.isArray(v)) {
    for (const x of v) collectBlobRefs(x, out);
  } else if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (typeof o["blob"] === "string" && HEX64.test(o["blob"])) out.add(o["blob"]);
    for (const x of Object.values(o)) collectBlobRefs(x, out);
  }
}

/**
 * Verification operation (R12.9 to R12.11). Recomputes every artifact hash and every chain link, compares the file
 * list with the Run_Manifest, and reports each mismatch with the record id or path. It reads only; it never creates
 * or modifies a file (R12.10). Works on a Run_Volume, an Incoming_Export or a Run directory.
 */
export async function verifyRunDirectory(fs: ReadOnlyFileSystemPort, dir: string, options: VerifyOptions = {}): Promise<VerificationReport> {
  return (await verifyInternal(fs, dir, options)).report;
}

export type RunRejectionReason = IncompleteReason | "incoming_directory" | "marker_mismatch" | "verification_failed";
export type RunAcceptance =
  | { accepted: true; manifest: JsonObject; manifestSha256: string; report: VerificationReport }
  | { accepted: false; status: "incomplete"; reason: RunRejectionReason; report?: VerificationReport };

/** True when any path segment is `.incoming`, whatever follows it (R12.24). */
export function isIncomingPath(path: string): boolean {
  return path.split(/[\\/]+/).includes(INCOMING_DIR);
}

/**
 * The one reader acceptance function (R12.23, R12.24), used by the evaluator, the reproducibility check, the replay
 * and the report entry point. A Run is accepted only if the Completion_Marker exists, its content equals the SHA-256
 * of the Run_Manifest, and verification succeeds. Anything else is `incomplete`. A directory under
 * `discovery/runs/.incoming/` is never accepted, and nothing in it is read.
 */
export async function acceptRun(fs: ReadOnlyFileSystemPort, dir: string, options: Omit<VerifyOptions, "requireMarker"> = {}): Promise<RunAcceptance> {
  if (isIncomingPath(dir)) return { accepted: false, status: "incomplete", reason: "incoming_directory" };
  const { report, manifest, markerText } = await verifyInternal(fs, dir, { ...options, requireMarker: true });
  if (report.incomplete) {
    return { accepted: false, status: "incomplete", reason: report.incompleteReason ?? "no_manifest", report };
  }
  // The marker holds the lowercase hex hash, optionally followed by one line break from the writer.
  const marker = (markerText ?? "").replace(/\r?\n$/, "");
  if (marker !== report.manifestSha256) return { accepted: false, status: "incomplete", reason: "marker_mismatch", report };
  if (report.result !== "success" || manifest === undefined) {
    return { accepted: false, status: "incomplete", reason: "verification_failed", report };
  }
  return { accepted: true, manifest, manifestSha256: report.manifestSha256 as string, report };
}
