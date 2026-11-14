// Citation_Verifier (design: packages/analyzer, "Citation_Verifier (R5)"; task 2.4).
//
// Pure and deterministic: the only inputs are the Citation and the Source_Bundle (R5.5). No AI call, no network, no
// clock, no file system. The result of one Citation never depends on another Citation (R5.4).
//
// Check order for one Citation (R5.2), stopping at the first failure:
//   1. malformed_citation   (R5.1)
//   2. file_not_in_bundle   (case-sensitive, character-for-character path comparison, no normalization)
//   3. source_unavailable   (R5.9: hash differs from the manifest, file text missing or ambiguous, or not valid text)
//   4. range_out_of_bounds
//   5. quote_not_found
// Step 3 is placed after step 2 and before step 4 because it needs the file entry and the file content. A malformed
// Citation is reported as malformed even when its file is unavailable, because the file cannot be trusted to be named.
import { createHash } from "node:crypto";
import type { SourceBundle } from "../bundle/types.js";

export interface Citation {
  file: string;
  startLine: number;
  endLine: number;
  quote: string;
}

export type CitationFailure =
  | "malformed_citation"
  | "file_not_in_bundle"
  | "range_out_of_bounds"
  | "quote_not_found"
  | "source_unavailable";

export type CitationResult = { verified: true } | { verified: false; reason: CitationFailure };

/** R5.1 limits. */
export const CITATION_LIMITS = {
  maxRangeLines: 100,
  maxQuoteCodePoints: 1000,
} as const;

/** CRLF and lone CR become LF (R5.7). Nothing else is changed. */
export function normalizeLf(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

// A string is well formed UTF-16 (and so encodable as UTF-8) when it has no lone surrogate.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
const isWellFormedText = (s: string): boolean => !LONE_SURROGATE.test(s);

function countCodePoints(s: string): number {
  let n = 0;
  for (const _ of s) n += 1;
  return n;
}

/** Lines of LF-normalized text (R5.7): a final LF does not start a line, and an empty text has no line. */
function splitLines(normalized: string): string[] {
  if (normalized === "") return [];
  const parts = normalized.split("\n");
  if (normalized.endsWith("\n")) parts.pop();
  return parts;
}

function isWellFormedCitation(c: unknown): c is Citation {
  try {
    if (typeof c !== "object" || c === null) return false;
    const { file, startLine, endLine, quote } = c as Record<string, unknown>;
    if (typeof file !== "string" || file.length < 1) return false;
    if (typeof startLine !== "number" || !Number.isSafeInteger(startLine) || startLine < 1) return false;
    if (typeof endLine !== "number" || !Number.isSafeInteger(endLine) || endLine < 1) return false;
    if (startLine > endLine) return false;
    if (endLine - startLine + 1 > CITATION_LIMITS.maxRangeLines) return false;
    if (typeof quote !== "string") return false;
    if (!/\S/u.test(quote)) return false;
    if (countCodePoints(quote) > CITATION_LIMITS.maxQuoteCodePoints) return false;
    return true;
  } catch {
    return false;
  }
}

type PreparedFile = { available: true; lines: string[] } | { available: false };

function prepareFile(bundle: SourceBundle, path: string): PreparedFile {
  const manifestEntries = bundle.manifest.filter((e) => e.path === path);
  const fileEntries = bundle.files.filter((f) => f.path === path);
  const entry = manifestEntries[0];
  const file = fileEntries[0];
  if (manifestEntries.length !== 1 || fileEntries.length !== 1 || entry === undefined || file === undefined) {
    return { available: false };
  }
  if (typeof file.text !== "string" || !isWellFormedText(file.text)) return { available: false };
  const normalized = normalizeLf(file.text);
  const actual = createHash("sha256").update(normalized, "utf8").digest("hex");
  if (actual !== entry.sha256Lf) return { available: false };
  return { available: true, lines: splitLines(normalized) };
}

function verifyWith(c: Citation, bundle: SourceBundle, cache: Map<string, PreparedFile>): CitationResult {
  const fail = (reason: CitationFailure): CitationResult => ({ verified: false, reason });

  if (!isWellFormedCitation(c)) return fail("malformed_citation");

  if (!bundle.manifest.some((e) => e.path === c.file)) return fail("file_not_in_bundle");

  let prepared = cache.get(c.file);
  if (prepared === undefined) {
    prepared = prepareFile(bundle, c.file);
    cache.set(c.file, prepared);
  }
  if (!prepared.available) return fail("source_unavailable");

  if (c.endLine > prepared.lines.length) return fail("range_out_of_bounds");

  const rangeText = prepared.lines.slice(c.startLine - 1, c.endLine).join("\n");
  const quote = normalizeLf(c.quote);
  // A quote with a lone surrogate cannot equal any code-point sequence of well-formed text.
  if (!isWellFormedText(quote)) return fail("quote_not_found");
  return rangeText.includes(quote) ? { verified: true } : fail("quote_not_found");
}

/** Verifies one Citation against the bundle (R5.2). Pure. */
export function verifyCitation(c: Citation, bundle: SourceBundle): CitationResult {
  return verifyWith(c, bundle, new Map());
}

/** Verifies every Citation independently, in order; one result per Citation (R5.3, R5.4). Pure. */
export function verifyCitations(cs: readonly Citation[], bundle: SourceBundle): CitationResult[] {
  const cache = new Map<string, PreparedFile>();
  return cs.map((c) => verifyWith(c, bundle, cache));
}
