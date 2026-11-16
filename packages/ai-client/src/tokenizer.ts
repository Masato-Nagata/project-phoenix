// Shared tokenizer and n-gram fingerprint primitives (design "How fingerprints are produced without giving the runtime access to
// `evaluation/`", steps 1 and 2). Pure functions. The Payload_Auditor (task 3.4) and the Audit_Config_Builder (task 3.7) both import
// them from here, so the two cannot drift.
import { sha256Hex } from "./hash.js";

/** Value of `tokenizer` in the audit configuration schema. A change of any rule below requires a new identifier. */
export const TOKENIZER_ID = "token-ngram-sha256-v1" as const;
/** Default n-gram size (design: `n = 12`). */
export const DEFAULT_NGRAM_SIZE = 12;
/** Fingerprints are SHA-256 truncated to this many hexadecimal characters. */
export const FINGERPRINT_HEX_LENGTH = 12;

const WORD_CHAR = /^[a-z0-9_]$/;
const SPACE = /^\s$/u;

/**
 * Rules of `token-ngram-sha256-v1` (a change of any rule requires a new `TOKENIZER_ID`):
 * 1. Lowercase the text with `String.prototype.toLowerCase` (locale independent). No Unicode normalization.
 * 2. Read the text by Unicode code point. A maximal run of `[a-z0-9_]` is one token.
 * 3. Any other code point that is not whitespace is a token of its own (one code point).
 * 4. Whitespace (`\s` with the `u` flag) separates tokens and is dropped.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = [];
  let run = "";
  for (const ch of text.toLowerCase()) {
    if (WORD_CHAR.test(ch)) {
      run += ch;
      continue;
    }
    if (run !== "") {
      tokens.push(run);
      run = "";
    }
    if (!SPACE.test(ch)) tokens.push(ch);
  }
  if (run !== "") tokens.push(run);
  return tokens;
}

/**
 * Rules of `token-ngram-sha256-v1`: the set of fingerprints of all windows of `n` consecutive tokens.
 * 1. A window is its `n` tokens joined by LF (`"\n"`). A token never contains whitespace, so the join is unambiguous.
 * 2. The joined text is encoded as UTF-8 and hashed with SHA-256.
 * 3. The fingerprint is the first 12 lowercase hexadecimal characters of the digest.
 * 4. Fewer than `n` tokens give an empty set; equal windows give one element.
 * 5. `n` must be an integer of at least 1, otherwise `RangeError`.
 */
export function ngramHashes(tokens: readonly string[], n: number): Set<string> {
  if (!Number.isInteger(n) || n < 1) throw new RangeError("n must be an integer of at least 1");
  const out = new Set<string>();
  for (let i = 0; i + n <= tokens.length; i++) {
    out.add(sha256Hex(tokens.slice(i, i + n).join("\n")).slice(0, FINGERPRINT_HEX_LENGTH));
  }
  return out;
}
