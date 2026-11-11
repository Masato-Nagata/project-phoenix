// Removal of AI-supplied authority-like content (R4.11, R6.16, R23.6). Pure; the value is dropped and
// only the field name and the JSON pointer of its parent object are reported.
import type { JsonObject } from "./types.js";

export interface DiscardedField {
  path: string;
  name: string;
}

/**
 * Reserved at Claim level: Origin, Evidence_Status and approval-like names. Matching ignores case and the
 * separators `_` and `-`, so `evidence_status` and `evidenceStatus` are the same name.
 */
export function isAuthorityLikeName(name: string): boolean {
  const n = name.toLowerCase().replace(/[_-]/g, "");
  return n === "origin" || n.startsWith("evidence") || n.endsWith("evidencestatus") || n.startsWith("approv");
}

/** Returns a shallow copy without authority-like fields (original untouched) and the list of discarded fields. */
export function discardAiAuthorityFields(
  claim: JsonObject,
  path = "",
): { cleaned: JsonObject; discarded: DiscardedField[] } {
  const cleaned: JsonObject = {};
  const discarded: DiscardedField[] = [];
  for (const name of Object.keys(claim)) {
    if (isAuthorityLikeName(name)) discarded.push({ path, name });
    else cleaned[name] = claim[name];
  }
  discarded.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { cleaned, discarded };
}
