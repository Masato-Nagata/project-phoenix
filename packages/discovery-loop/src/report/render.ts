// Plain-text report renderer (R6.12, R6.13). Output is text, never markup: every value is escaped so that
// AI-supplied text cannot introduce HTML, markdown structure or terminal control sequences.
import type { ReportEntry } from "./facts.js";

/** Escapes to printable ASCII: backslash, quotes, markup characters, markdown/control characters and non-ASCII become \uXXXX. */
export function escapeText(value: string): string {
  let out = "";
  for (const ch of value) {
    const cp = ch.codePointAt(0) as number;
    if (/[A-Za-z0-9 _.:\/@#=+,;()-]/.test(ch)) out += ch;
    else if (cp > 0xffff) out += `\\u{${cp.toString(16)}}`;
    else out += `\\u${cp.toString(16).padStart(4, "0")}`;
  }
  return out;
}

const list = (ids: readonly string[]): string => (ids.length === 0 ? "none" : ids.map(escapeText).join(", "));

/**
 * One block per Claim revision. The four facts are four labelled lines (no combined value). The
 * contradicting Evidence line is always present, lists every id with no cap, and sits in the same block
 * as any `supported` status or `approved` Approval status. A `contradicted` or `mixed` status is printed
 * as it is, never replaced or hidden.
 */
export function renderEntry(entry: ReportEntry): string {
  const f = entry.facts;
  return [
    `Claim revision: ${escapeText(f.claimRevisionId)}`,
    `  Origin: ${escapeText(f.origin)}`,
    `  Source evidence status: ${escapeText(f.sourceEvidenceStatus)}`,
    `  Experiment evidence status: ${escapeText(f.experimentEvidenceStatus)}`,
    `  Approval status: ${escapeText(f.approvalStatus)}`,
    `  Contradicting evidence (${entry.contradictingEvidenceIds.length}): ${list(entry.contradictingEvidenceIds)}`,
    `  Evidence (${entry.evidenceIds.length}): ${list(entry.evidenceIds)}`,
  ].join("\n");
}

export function renderReportText(entries: readonly ReportEntry[]): string {
  return entries.map(renderEntry).join("\n\n") + (entries.length === 0 ? "" : "\n");
}
