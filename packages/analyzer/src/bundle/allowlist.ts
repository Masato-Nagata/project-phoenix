// Allowlist parsing and validation (design: "Source_Bundler decisions (OD-7, C5-1 to C5-7)"; R1.1 to R1.5).
//
// Everything here is pure: text in, result out. No file access. Every defect is an error that names the offending
// entry or document and no partial result is returned (fail closed).
import { normalizeLf } from "../citation/verify.js";
import type { Json, Result } from "../expr/types.js";
import { parseStrictJson } from "./strictJson.js";
import type { BundleError } from "./types.js";

export const ALLOWLIST_JSON_PATH = "docs/ai-input-allowlist.json";
export const ALLOWLIST_MD_PATH = "docs/ai-input-allowlist.md";

/** The only top-level keys of the allowlist JSON (C5-1). `description` and `location_note` are ignored. */
const ALLOWED_KEYS = ["schema_version", "description", "location_note", "files"] as const;

/** The shape check of test GS30: a .php file directly under legacy/src or a .sql file directly under legacy/sql (C5-7). */
export const ENTRY_SHAPE = /^legacy\/(?:src\/[A-Za-z0-9_]+\.php|sql\/[A-Za-z0-9_]+\.sql)$/;
const MAX_ENTRY_LENGTH = 256;

const err = (code: BundleError["code"], detail: string, path?: string): BundleError =>
  path === undefined ? { code, detail } : { code, path, detail };

/** Parses and validates the allowlist JSON text. Returns the entries in the listed order. */
export function parseAllowlistJson(text: string): Result<string[], BundleError> {
  const parsed = parseStrictJson(text);
  if (!parsed.ok) return { ok: false, error: err("allowlist_invalid_json", parsed.error, ALLOWLIST_JSON_PATH) };
  const doc: Json = parsed.value;
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    return { ok: false, error: err("allowlist_invalid_json", "the document is not an object", ALLOWLIST_JSON_PATH) };
  }
  for (const key of Object.keys(doc)) {
    if (!(ALLOWED_KEYS as readonly string[]).includes(key)) {
      return { ok: false, error: err("allowlist_unknown_field", `unknown top-level key ${JSON.stringify(key)}`, ALLOWLIST_JSON_PATH) };
    }
  }
  if (doc["schema_version"] !== 1) {
    return { ok: false, error: err("allowlist_unsupported_version", "schema_version must be the integer 1", ALLOWLIST_JSON_PATH) };
  }
  const files = doc["files"];
  if (!Array.isArray(files) || files.length === 0) {
    return { ok: false, error: err("allowlist_no_files", "`files` is missing, not a list, or empty", ALLOWLIST_JSON_PATH) };
  }
  const out: string[] = [];
  for (let i = 0; i < files.length; i += 1) {
    const entry = files[i];
    if (typeof entry !== "string") {
      return { ok: false, error: err("allowlist_entry_not_string", `files[${i}] is not a string`, ALLOWLIST_JSON_PATH) };
    }
    out.push(entry);
  }
  return { ok: true, value: out };
}

/**
 * Checks the form of one entry (R1.3, C5-3, C5-7). The entry must already be in normal form: nothing is normalized.
 * Order of the checks: empty or surrounding whitespace, absolute, traversal, backslash, wildcard, empty or `.`
 * segment, shape.
 */
export function validateEntryForm(entry: string): BundleError | undefined {
  if (entry.length === 0 || entry !== entry.trim()) return err("entry_shape", "empty entry or surrounding whitespace", entry);
  if (entry.startsWith("/") || entry.startsWith("\\") || /^[A-Za-z]:/.test(entry) || entry.startsWith("~")) {
    return err("entry_absolute", "absolute path", entry);
  }
  const segments = entry.split(/[\\/]/);
  if (segments.includes("..")) return err("entry_traversal", "traversal segment `..`", entry);
  if (entry.includes("\\")) return err("entry_shape", "backslash", entry);
  if (/[*?[\]{}]/.test(entry)) return err("entry_shape", "wildcard character", entry);
  if (entry.split("/").some((s) => s === "" || s === ".")) return err("entry_traversal", "empty or `.` segment", entry);
  if (entry.length > MAX_ENTRY_LENGTH || !ENTRY_SHAPE.test(entry)) {
    return err("entry_shape", "not a .php file directly under legacy/src or a .sql file directly under legacy/sql", entry);
  }
  return undefined;
}

/** Duplicates are detected case-insensitively (ASCII folding): entries that differ only in case collide (C5-3). */
export function findDuplicate(entries: readonly string[]): BundleError | undefined {
  const seen = new Map<string, number>();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] as string;
    const folded = entry.replace(/[A-Z]/g, (c) => c.toLowerCase());
    const first = seen.get(folded);
    if (first !== undefined) return err("entry_duplicate", `duplicate of files[${first}] (compared without regard to case)`, entry);
    seen.set(folded, i);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------- Markdown table

const mismatch = (detail: string): BundleError => err("allowlist_md_mismatch", detail, ALLOWLIST_MD_PATH);

/** Splits a table row into trimmed cells. Returns undefined when the row does not start and end with `|`. */
function cellsOf(line: string): string[] | undefined {
  if (!line.startsWith("|")) return undefined;
  const trimmed = line.trimEnd();
  if (trimmed.length < 2 || !trimmed.endsWith("|")) return undefined;
  return trimmed.slice(1, -1).split("|").map((c) => c.trim());
}

/**
 * Reads the allowlist table of `docs/ai-input-allowlist.md` (C5-2). Grammar, on the LF-normalized text:
 * exactly one line starts with `### Allowed`; after it blank lines are skipped; the header row is `| File | Reason |`;
 * then a separator row of two columns; then the data rows (lines that start with `|`) up to the first other line.
 * Each data row has two cells: a single code span, and a non-empty text. Nothing outside that table is read.
 */
export function parseAllowlistTable(markdown: string): Result<string[], BundleError> {
  const lines = normalizeLf(markdown).split("\n");
  const headings: number[] = [];
  lines.forEach((l, i) => {
    if (l.startsWith("### Allowed")) headings.push(i);
  });
  if (headings.length !== 1) return { ok: false, error: mismatch(`expected exactly one "### Allowed" heading, found ${headings.length}`) };
  let i = (headings[0] as number) + 1;
  while (i < lines.length && (lines[i] as string).trim() === "") i += 1;
  const header = i < lines.length ? cellsOf(lines[i] as string) : undefined;
  if (header === undefined || header.length !== 2 || header[0] !== "File" || header[1] !== "Reason") {
    return { ok: false, error: mismatch("the header row is not `| File | Reason |`") };
  }
  i += 1;
  const separator = i < lines.length ? cellsOf(lines[i] as string) : undefined;
  if (separator === undefined || separator.length !== 2 || !separator.every((c) => /^:?-+:?$/.test(c))) {
    return { ok: false, error: mismatch("the separator row is missing or not two columns") };
  }
  i += 1;
  const paths: string[] = [];
  while (i < lines.length && (lines[i] as string).startsWith("|")) {
    const row = cellsOf(lines[i] as string);
    if (row === undefined || row.length !== 2) return { ok: false, error: mismatch(`data row ${paths.length + 1} does not have exactly two cells`) };
    const m = /^`([^`]+)`$/.exec(row[0] as string);
    if (m === null) return { ok: false, error: mismatch(`data row ${paths.length + 1}: the first cell is not a single code span`) };
    if ((row[1] as string) === "") return { ok: false, error: mismatch(`data row ${paths.length + 1}: the second cell is empty`) };
    paths.push(m[1] as string);
    i += 1;
  }
  if (paths.length === 0) return { ok: false, error: mismatch("the table has no data row") };
  return { ok: true, value: paths };
}

/** R1.5: the JSON list and the table must be equal in set and order. Names the first differing entry. */
export function compareAllowlists(json: readonly string[], table: readonly string[]): BundleError | undefined {
  const n = Math.max(json.length, table.length);
  for (let i = 0; i < n; i += 1) {
    const a = json[i];
    const b = table[i];
    if (a !== b) {
      return mismatch(`first difference at index ${i}: json=${a === undefined ? "missing" : JSON.stringify(a)} table=${b === undefined ? "missing" : JSON.stringify(b)}`);
    }
  }
  return undefined;
}