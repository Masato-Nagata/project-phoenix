// Source_Bundler (design: packages/analyzer, "Source_Bundler (R1)" and "Source_Bundler decisions (OD-7)"; task 2.1).
//
// The bundler reads exactly the files named by the allowlist, in the listed order, through an injected
// `FileSystemPort`. It never lists a directory, never expands a wildcard, and never touches a path that is not an
// allowlist entry, the allowlist documents, or a parent directory of an entry. Any defect stops the whole build:
// the result is an error and there is no bundle and no manifest (fail closed).
//
// Order of the checks: (1) allowlist JSON; (2) the form of every entry; (3) duplicates; (4) the Markdown table;
// (5) per entry in order: link checks, existence, kind, read, UTF-8, LF normalization, hash; (6) the manifest equals
// the allowlist (R1.7). Checks 1 to 4 need no access to the listed files, so no listed file is read when one fails.
import { createHash } from "node:crypto";
import { normalizeLf } from "../citation/verify.js";
import type { Result } from "../expr/types.js";
import {
  ALLOWLIST_JSON_PATH,
  ALLOWLIST_MD_PATH,
  compareAllowlists,
  findDuplicate,
  parseAllowlistJson,
  parseAllowlistTable,
  validateEntryForm,
} from "./allowlist.js";
import type { BundleError, FileSystemPort, SourceBundle, SourceBundleFile, SourceBundleManifestEntry } from "./types.js";

export const MANIFEST_HASH_RULE = "sha256 over UTF-8 bytes after CRLF and lone CR are replaced by LF";

const err = (code: BundleError["code"], detail: string, path?: string): BundleError =>
  path === undefined ? { code, detail } : { code, path, detail };

const joinPath = (root: string, rel: string): string => (root.endsWith("/") ? `${root}${rel}` : `${root}/${rel}`);
const isNotFound = (e: unknown): boolean => typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT";

async function readText(fs: FileSystemPort, path: string, utf8Code: BundleError["code"], missingCode: BundleError["code"]): Promise<Result<string, BundleError>> {
  let bytes: Uint8Array;
  try {
    bytes = await fs.readFile(path);
  } catch (e) {
    return { ok: false, error: err(isNotFound(e) ? missingCode : "entry_unreadable", "the file could not be read") };
  }
  try {
    // fatal: an invalid sequence is an error. ignoreBOM: the byte-order mark is kept as U+FEFF (R5.7).
    return { ok: true, value: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  } catch {
    return { ok: false, error: err(utf8Code, "the file is not valid UTF-8") };
  }
}

/** SHA-256 (lowercase hex) of the UTF-8 bytes of an already LF-normalized text. */
export const sha256OfNormalized = (normalized: string): string => createHash("sha256").update(normalized, "utf8").digest("hex");

/** R1.7: the manifest paths equal the allowlist entries exactly, in the same order, with nothing extra or missing. */
export function verifyManifest(allowlist: readonly string[], manifest: readonly SourceBundleManifestEntry[]): BundleError | undefined {
  if (manifest.length !== allowlist.length) {
    return err("manifest_mismatch", `the manifest has ${manifest.length} entries, the allowlist ${allowlist.length}`);
  }
  for (let i = 0; i < allowlist.length; i += 1) {
    const m = manifest[i];
    if (m === undefined || m.path !== allowlist[i]) return err("manifest_mismatch", `entry ${i} differs`, allowlist[i]);
  }
  return undefined;
}

async function checkAndRead(fs: FileSystemPort, repoRoot: string, entry: string): Promise<Result<SourceBundleFile, BundleError>> {
  const segments = entry.split("/");
  // Parent directories first: a symbolic link or junction anywhere on the path is a link (C5-4).
  for (let n = 1; n < segments.length; n += 1) {
    const dir = segments.slice(0, n).join("/");
    let st: Awaited<ReturnType<FileSystemPort["lstat"]>>;
    try {
      st = await fs.lstat(joinPath(repoRoot, dir));
    } catch (e) {
      return { ok: false, error: err(isNotFound(e) ? "entry_missing" : "entry_unreadable", `the directory ${dir} cannot be examined`, entry) };
    }
    if (st.kind === "symlink") return { ok: false, error: err("entry_link", `the directory ${dir} is a link`, entry) };
    if (st.kind !== "dir") return { ok: false, error: err("entry_unreadable", `${dir} is not a directory`, entry) };
  }
  const full = joinPath(repoRoot, entry);
  let st: Awaited<ReturnType<FileSystemPort["lstat"]>>;
  try {
    st = await fs.lstat(full);
  } catch (e) {
    return { ok: false, error: err(isNotFound(e) ? "entry_missing" : "entry_unreadable", "the file cannot be examined", entry) };
  }
  if (st.kind === "symlink") return { ok: false, error: err("entry_link", "the entry is a symbolic link or junction", entry) };
  if (st.kind === "dir") return { ok: false, error: err("entry_directory", "the entry is a directory", entry) };
  if (st.kind !== "file") return { ok: false, error: err("entry_unreadable", "the entry is not a regular file", entry) };
  if (st.nlink !== 1) return { ok: false, error: err("entry_link", `the entry has ${st.nlink} hard links`, entry) };
  const text = await readText(fs, full, "entry_not_utf8", "entry_missing");
  if (!text.ok) return { ok: false, error: { ...text.error, path: entry } };
  return { ok: true, value: { path: entry, text: normalizeLf(text.value) } };
}

/**
 * Builds the Source_Bundle (R1.1 to R1.8). `allowlistJsonPath` and `allowlistMdPath` are relative to `repoRoot`.
 * On any defect the result is an error and nothing else is produced.
 */
export async function buildSourceBundle(
  fs: FileSystemPort,
  repoRoot: string,
  allowlistJsonPath: string = ALLOWLIST_JSON_PATH,
  allowlistMdPath: string = ALLOWLIST_MD_PATH,
): Promise<Result<SourceBundle, BundleError>> {
  const json = await readText(fs, joinPath(repoRoot, allowlistJsonPath), "allowlist_invalid_json", "allowlist_missing");
  if (!json.ok) return { ok: false, error: { ...json.error, code: json.error.code === "entry_unreadable" ? "allowlist_missing" : json.error.code, path: allowlistJsonPath } };
  const parsed = parseAllowlistJson(json.value);
  if (!parsed.ok) return parsed;
  const entries = parsed.value;

  for (const entry of entries) {
    const bad = validateEntryForm(entry);
    if (bad !== undefined) return { ok: false, error: bad };
  }
  const dup = findDuplicate(entries);
  if (dup !== undefined) return { ok: false, error: dup };

  const md = await readText(fs, joinPath(repoRoot, allowlistMdPath), "allowlist_md_mismatch", "allowlist_missing");
  if (!md.ok) return { ok: false, error: { ...md.error, code: md.error.code === "entry_unreadable" ? "allowlist_missing" : md.error.code, path: allowlistMdPath } };
  const table = parseAllowlistTable(md.value);
  if (!table.ok) return table;
  const diff = compareAllowlists(entries, table.value);
  if (diff !== undefined) return { ok: false, error: diff };

  const files: SourceBundleFile[] = [];
  for (const entry of entries) {
    const file = await checkAndRead(fs, repoRoot, entry);
    if (!file.ok) return file;
    files.push(file.value);
  }
  const manifest: SourceBundleManifestEntry[] = files.map((f) => ({ path: f.path, sha256Lf: sha256OfNormalized(f.text) }));
  const mismatch = verifyManifest(entries, manifest);
  if (mismatch !== undefined) return { ok: false, error: mismatch };
  return { ok: true, value: { manifest, files } };
}

// ------------------------------------------------------------------------------------------ serialization

/** Canonical JSON text: sorted keys, no whitespace. Only strings, integers, arrays and objects occur in the manifest. */
function canonicalText(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" && Number.isSafeInteger(v)) return String(v);
  if (Array.isArray(v)) return `[${v.map(canonicalText).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonicalText(o[k])}`).join(",")}}`;
  }
  throw new Error("not serializable");
}

/**
 * The manifest document as canonical JSON (UTF-8). It holds no byte count, no timestamp, and no host path, so
 * identical inputs give identical bytes (R1.8). The shape is the M1 schema `source-bundle-manifest`.
 */
export function serializeManifest(manifest: readonly SourceBundleManifestEntry[]): Uint8Array {
  const doc = {
    schemaVersion: 1,
    hashRule: MANIFEST_HASH_RULE,
    files: manifest.map((m) => ({ path: m.path, sha256Lf: m.sha256Lf })),
  };
  return new TextEncoder().encode(canonicalText(doc));
}

/**
 * The bundle content in the format of the reference builder: for each file the header `=== FILE: <path> ===`, the
 * LF-normalized text, and one LF. Identical inputs give identical text (R1.8).
 */
export function renderBundleText(bundle: SourceBundle): string {
  let out = "";
  for (const f of bundle.files) out += `=== FILE: ${f.path} ===\n${f.text}\n`;
  return out;
}