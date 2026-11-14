// Feature: discovery-loop, Property 3: Citation verification is sound and complete
// **Validates: Requirements 5.2, 5.5, 5.7**
//
// For any file content, line range of at most 100 lines inside the file, and quote, `verifyCitation` returns
// `verified` if and only if the quote, after LF normalization, is a contiguous exact substring of the LF-joined text of
// that range; for any substring taken from that text the result is `verified`; repeated calls give the same result.
//
// The oracle in this file is written independently of the implementation: its own line scanner, its own line-ending
// normalization, and a naive search over arrays of code points (the implementation uses String.prototype.includes).
//
// Reproducibility record: SEED = 330003, NUM_RUNS = 400. All generated text is neutral (letters, spaces, line endings,
// a byte-order mark, accented and non-BMP characters).
import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { verifyCitation, type Citation, type SourceBundle } from "../src/index.js";

const SEED = 330003;
const NUM_RUNS = 400;
const TIMEOUT_MS = 120_000;

// ------------------------------------------------------------------------------------------ oracle (independent)

/** Own line scanner: CRLF, lone CR, and LF each end a line; a final terminator does not start a new line. */
function oracleLines(text: string): string[] {
  const out: string[] = [];
  let current = "";
  let pendingTerminator = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "\r") {
      if (text.charAt(i + 1) === "\n") i += 1;
      out.push(current);
      current = "";
      pendingTerminator = true;
    } else if (ch === "\n") {
      out.push(current);
      current = "";
      pendingTerminator = true;
    } else {
      current += ch;
      pendingTerminator = false;
    }
  }
  if (!pendingTerminator && current !== "") out.push(current);
  return out;
}

const oracleNormalize = (s: string): string => s.split("\r\n").join("\n").split("\r").join("\n");

/** Naive contiguous search over code points. */
function containsCodePoints(haystack: string, needle: string): boolean {
  const h = [...haystack];
  const n = [...needle];
  if (n.length === 0) return true;
  for (let i = 0; i + n.length <= h.length; i += 1) {
    let j = 0;
    while (j < n.length && h[i + j] === n[j]) j += 1;
    if (j === n.length) return true;
  }
  return false;
}

// ----------------------------------------------------------------------------------------------- generators

const PIECES = ["a", "b", "c", " ", "\t", "x", "\u00e9", "\u{1F600}", "\uFEFF", "\n", "\r", "\r\n", "\n\n", ""] as const;
const contentArb = fc
  .array(fc.constantFrom(...PIECES), { maxLength: 60 })
  .map((parts) => parts.join(""));
/** Larger files, so the 100-line range limit is reached inside the file. */
const longContentArb = fc
  .tuple(fc.integer({ min: 101, max: 160 }), fc.constantFrom("\n", "\r\n", "\r"), fc.boolean())
  .map(([count, terminator, finalTerminator]) => {
    const lines = Array.from({ length: count }, (_, i) => `line${i}`);
    return lines.join(terminator) + (finalTerminator ? terminator : "");
  });

const bundleFor = (text: string): SourceBundle => {
  const normalized = oracleNormalize(text);
  return {
    manifest: [{ path: "f.txt", sha256Lf: createHash("sha256").update(normalized, "utf8").digest("hex") }],
    files: [{ path: "f.txt", text: normalized }],
  };
};

const NON_BLANK = /\S/u;

/** Picks a valid range of the file from three free integers. */
function rangeOf(lines: readonly string[], a: number, b: number): { start: number; end: number } {
  const start = 1 + (a % lines.length);
  const maxLength = Math.min(100, lines.length - start + 1);
  return { start, end: start + (b % maxLength) };
}

/**
 * Re-encodes each LF of an already normalized string with a chosen line ending. A lone CR directly followed by an LF
 * would merge into one CRLF and change the content, so in that one position the LF is kept.
 */
const reencode = (s: string, endings: readonly string[]): string => {
  let k = 0;
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    const ch = s.charAt(i);
    if (ch !== "\n") {
      out += ch;
      continue;
    }
    const choice = endings[k % endings.length] ?? "\n";
    k += 1;
    out += choice === "\r" && s.charAt(i + 1) === "\n" ? "\n" : choice;
  }
  return out;
};

const endingsArb = fc.array(fc.constantFrom("\n", "\r\n", "\r"), { minLength: 1, maxLength: 5 });

// ------------------------------------------------------------------------------------------------ properties

describe(`Property 3: Citation verification is sound and complete (seed ${SEED}, numRuns ${NUM_RUNS})`, () => {
  it("completeness: every non-blank substring of the cited range is verified, whatever line endings the quote uses", () => {
    fc.assert(
      fc.property(
        fc.oneof(contentArb, longContentArb),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        fc.nat(),
        endingsArb,
        (text, a, b, c, d, endings) => {
          const lines = oracleLines(oracleNormalize(text));
          fc.pre(lines.length > 0);
          const { start, end } = rangeOf(lines, a, b);
          const rangeText = lines.slice(start - 1, end).join("\n");
          const cps = [...rangeText];
          const from = c % (cps.length + 1);
          const to = from + (d % (cps.length - from + 1));
          const substring = cps.slice(from, to).join("");
          fc.pre(NON_BLANK.test(substring));
          const quote = reencode(substring, endings);
          const citation: Citation = { file: "f.txt", startLine: start, endLine: end, quote };
          expect(verifyCitation(citation, bundleFor(text))).toEqual({ verified: true });
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("soundness: an arbitrary quote is verified if and only if it is a substring of the range text", () => {
    const quoteArb = fc
      .array(fc.constantFrom("a", "b", "c", " ", "x", "\n", "\r\n", "\u{1F600}", "Z", "\u00e9"), { maxLength: 12 })
      .map((p) => p.join(""));
    fc.assert(
      fc.property(fc.oneof(contentArb, longContentArb), fc.nat(), fc.nat(), quoteArb, (text, a, b, quote) => {
        const lines = oracleLines(oracleNormalize(text));
        fc.pre(lines.length > 0);
        const { start, end } = rangeOf(lines, a, b);
        const rangeText = lines.slice(start - 1, end).join("\n");
        const result = verifyCitation({ file: "f.txt", startLine: start, endLine: end, quote }, bundleFor(text));
        if (!NON_BLANK.test(quote)) {
          expect(result).toEqual({ verified: false, reason: "malformed_citation" });
        } else if (containsCodePoints(rangeText, oracleNormalize(quote))) {
          expect(result).toEqual({ verified: true });
        } else {
          expect(result).toEqual({ verified: false, reason: "quote_not_found" });
        }
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("range rules: a range of at most 100 lines inside the file is checked, a longer one is malformed, one past the end is out of bounds", () => {
    fc.assert(
      fc.property(fc.oneof(contentArb, longContentArb), fc.nat(), fc.nat(), (text, a, b) => {
        const lines = oracleLines(oracleNormalize(text));
        const bundle = bundleFor(text);
        const quote = "Z"; // never present in the generated text, so only the range checks decide
        if (lines.length === 0) {
          expect(verifyCitation({ file: "f.txt", startLine: 1, endLine: 1, quote }, bundle)).toEqual({
            verified: false,
            reason: "range_out_of_bounds",
          });
          return;
        }
        const start = 1 + (a % lines.length);
        const tooLong = { file: "f.txt", startLine: start, endLine: start + 100, quote };
        expect(verifyCitation(tooLong, bundle)).toEqual({ verified: false, reason: "malformed_citation" });
        const endLine = lines.length + 1 + (b % 3); // always beyond the last line
        if (endLine - start + 1 <= 100) {
          expect(verifyCitation({ file: "f.txt", startLine: start, endLine, quote }, bundle)).toEqual({
            verified: false,
            reason: "range_out_of_bounds",
          });
        }
        const last = verifyCitation({ file: "f.txt", startLine: Math.max(1, lines.length - 99), endLine: lines.length, quote }, bundle);
        expect(last).toEqual({ verified: false, reason: "quote_not_found" });
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("determinism: repeated calls give the same result and the inputs are not modified", () => {
    fc.assert(
      fc.property(contentArb, fc.nat(), fc.nat(), fc.string({ maxLength: 8 }), (text, a, b, quote) => {
        const lines = oracleLines(oracleNormalize(text));
        const start = 1 + (a % Math.max(1, lines.length));
        const citation: Citation = Object.freeze({ file: "f.txt", startLine: start, endLine: start + (b % 3), quote });
        const bundle = bundleFor(text);
        const frozen: SourceBundle = Object.freeze({
          manifest: Object.freeze(bundle.manifest.map((m) => Object.freeze({ ...m }))),
          files: Object.freeze(bundle.files.map((f) => Object.freeze({ ...f }))),
        });
        const first = verifyCitation(citation, frozen);
        for (let i = 0; i < 3; i += 1) expect(verifyCitation(citation, frozen)).toEqual(first);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);
});
