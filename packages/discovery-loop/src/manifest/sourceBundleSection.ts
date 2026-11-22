// Run_Manifest `sourceBundle` section builder (task 4.6, work unit W1).
//
// Pure: no I/O, no clock, no randomness. Never mutates its input and never aliases it: the result holds fresh objects.
// The shape is the M1 schema `source-bundle-manifest` (src/schema/schemas.ts), which is authoritative (decision D1):
// `schemaVersion` const 1, `hashRule` const text, `files` with at least one `{ path, sha256Lf }`.
// The constants are defined here, not imported from the analyzer (no workspace dependency); a test pins equality with
// the analyzer's `MANIFEST_HASH_RULE` and `serializeManifest`.
//
// Decision D2: a missing, empty or invalid file list is REFUSED. Nothing is filled in or defaulted, and the error
// carries a closed code and a position only, never an input value.
import type { Result } from "../schema/types.js";

export const SOURCE_BUNDLE_SCHEMA_VERSION = 1 as const;
export const SOURCE_BUNDLE_HASH_RULE = "sha256 over UTF-8 bytes after CRLF and lone CR are replaced by LF" as const;

export interface SourceBundleSectionFile {
  readonly path: string;
  readonly sha256Lf: string;
}

export interface SourceBundleSection {
  readonly schemaVersion: typeof SOURCE_BUNDLE_SCHEMA_VERSION;
  readonly hashRule: typeof SOURCE_BUNDLE_HASH_RULE;
  readonly files: readonly SourceBundleSectionFile[];
}

export type SourceBundleSectionErrorCode =
  | "files_not_array"
  | "files_empty"
  | "entry_not_plain_object"
  | "entry_keys"
  | "path_not_string"
  | "path_invalid"
  | "hash_not_string"
  | "hash_invalid"
  | "path_duplicate";

/** `index` is the position in the file list; absent for list-level errors. No input value is ever echoed. */
export interface SourceBundleSectionError {
  readonly code: SourceBundleSectionErrorCode;
  readonly index?: number;
}

// Same rules as the M1 schema `source-bundle-manifest` (path: relative, forward-slash, no dot segment, 1 to 256).
const PATH_PATTERN = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const DOT_SEGMENT = /(^|\/)\.{1,2}(\/|$)/;
const MAX_PATH_LENGTH = 256;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

const fail = (code: SourceBundleSectionErrorCode, index?: number): Result<never, SourceBundleSectionError> =>
  index === undefined ? { ok: false, error: { code } } : { ok: false, error: { code, index } };

/** Own data property value of a plain object, or `undefined` when absent or an accessor. */
function dataValue(o: object, key: string): { present: boolean; value?: unknown } {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (d === undefined || !("value" in d)) return { present: false };
  return { present: true, value: d.value };
}

/** A plain object with only own enumerable string-keyed data properties (no accessor, no symbol key). */
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

/**
 * Builds the `sourceBundle` section from the validated Source_Bundle file list (allowlist order is kept).
 * Beyond the schema, one rule is added: a duplicate path is refused, compared case-insensitively with ASCII folding,
 * which is the rule of the analyzer's Source_Bundler (`findDuplicate`, entry_duplicate), so a list the bundler accepted
 * is never refused here for that reason.
 */
export function buildSourceBundleSection(files: unknown): Result<SourceBundleSection, SourceBundleSectionError> {
  if (!Array.isArray(files)) return fail("files_not_array");
  if (files.length === 0) return fail("files_empty");

  const out: SourceBundleSectionFile[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < files.length; i += 1) {
    const slot = Object.getOwnPropertyDescriptor(files, String(i));
    if (slot === undefined || !("value" in slot)) return fail("entry_not_plain_object", i);
    const entry: unknown = slot.value;
    if (!isPlainDataObject(entry)) return fail("entry_not_plain_object", i);

    const keys = Object.keys(entry);
    if (keys.length !== 2 || !keys.includes("path") || !keys.includes("sha256Lf")) return fail("entry_keys", i);

    const path = dataValue(entry, "path").value;
    if (typeof path !== "string") return fail("path_not_string", i);
    if (path.length < 1 || path.length > MAX_PATH_LENGTH || !PATH_PATTERN.test(path) || DOT_SEGMENT.test(path)) {
      return fail("path_invalid", i);
    }
    const hash = dataValue(entry, "sha256Lf").value;
    if (typeof hash !== "string") return fail("hash_not_string", i);
    if (!SHA256_PATTERN.test(hash)) return fail("hash_invalid", i);

    const folded = path.replace(/[A-Z]/g, (c) => c.toLowerCase());
    if (seen.has(folded)) return fail("path_duplicate", i);
    seen.add(folded);

    out.push({ path, sha256Lf: hash });
  }
  return {
    ok: true,
    value: { schemaVersion: SOURCE_BUNDLE_SCHEMA_VERSION, hashRule: SOURCE_BUNDLE_HASH_RULE, files: out },
  };
}
