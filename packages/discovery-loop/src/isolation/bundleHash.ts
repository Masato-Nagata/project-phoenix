// Pure part of `bundleSha256` (design.md, item 7a; hashRule `dist-bundle-sha256-v1`). No file, no clock, no process access: the walk is in
// nodeDeps.ts, the use is in verify.ts. It holds the path grammar, the limits, the ordering, and the hashed document.
//
// The hashed document has exactly four keys: hashRule, roots, skippedDirectories, files. `files` is a list of { path, sha256 } where `sha256` is
// the SHA-256 of the RAW bytes of the file (no decoding, no line-ending change). The document is written with the existing canonical JSON, and
// `bundleSha256` is the SHA-256 of its UTF-8 bytes. Every path is ASCII, so the ASCII ordinal order, the UTF-8 byte order and the UTF-16 order agree.
import { createHash } from "node:crypto";

import { canonicalJson } from "../canonical/canonicalJson.js";
import type { Json } from "../schema/types.js";
import type { BundleFailureCode } from "./types.js";

export const BUNDLE_HASH_RULE = "dist-bundle-sha256-v1" as const;

/** A value equal to a limit is accepted; a value above it fails. Files, bytes, directories and entries are counted over all roots together. */
export const BUNDLE_LIMITS = Object.freeze({
  /** one file */
  fileBytes: 8 * 1024 * 1024,
  files: 5000,
  totalBytes: 64 * 1024 * 1024,
  /** directories that are walked, the roots themselves included (a skipped `node_modules` is not walked) */
  directories: 1000,
  /** everything found while listing: files, directories, skipped directories, links, special files, invalid names */
  entries: 10000,
  /** a root has depth 0 */
  depth: 16,
});

const ELEMENT = /^[A-Za-z0-9._@+-]+$/;

/** ASCII ordinal order (UTF-16 code units). Never a locale comparison. */
export const ordinalCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** `<root label>/<path inside the root>`: elements of `A-Z a-z 0-9 . _ @ + -`, separator `/`, no empty element, no `.` or `..`, nothing absolute or trailing. */
export function isValidBundlePath(path: unknown): boolean {
  if (typeof path !== "string" || path.length === 0) return false;
  return path.split("/").every((e) => e !== "" && e !== "." && e !== ".." && ELEMENT.test(e));
}

export interface BundleFileHash {
  readonly path: string;
  readonly sha256: string;
}

export interface BundleDocumentInput {
  readonly roots: readonly string[];
  readonly skippedDirectories: readonly string[];
  readonly files: readonly BundleFileHash[];
}

/** `bundle_path_invalid` for a path outside the grammar, `bundle_duplicate` for a repeated path or two paths that differ only in letter case. */
export function findBundlePathProblem(input: BundleDocumentInput): BundleFailureCode | undefined {
  const all = [...input.roots, ...input.skippedDirectories, ...input.files.map((f) => f.path)];
  if (!all.every(isValidBundlePath)) return "bundle_path_invalid";
  const seen = new Set<string>();
  for (const p of [...input.roots, ...input.skippedDirectories, ...input.files.map((f) => f.path)]) {
    const k = p.toLowerCase();
    if (seen.has(k)) return "bundle_duplicate";
    seen.add(k);
  }
  return undefined;
}

/** The document in its sorted form (every array is sorted after collection, never by the order of the walk). */
export function bundleDocument(input: BundleDocumentInput): Json {
  return {
    hashRule: BUNDLE_HASH_RULE,
    roots: [...input.roots].sort(ordinalCompare),
    skippedDirectories: [...input.skippedDirectories].sort(ordinalCompare),
    files: [...input.files].sort((a, b) => ordinalCompare(a.path, b.path)).map((f) => ({ path: f.path, sha256: f.sha256 })),
  };
}

/** The canonical JSON text of the document (exposed so that a test can compare the exact bytes with an independent implementation). */
export function bundleDocumentText(input: BundleDocumentInput): string {
  return canonicalJson(bundleDocument(input));
}

/** The SHA-256 (lowercase hex) of the UTF-8 bytes of the canonical document. */
export function computeBundleSha256(input: BundleDocumentInput): string {
  return createHash("sha256").update(Buffer.from(bundleDocumentText(input), "utf8")).digest("hex");
}