// Citation_Verifier unit tests (task 2.4; R5.1, R5.2, R5.3, R5.5, R5.7, R5.9).
// All files and quotes are neutral fixtures (short words, small line counts). No business value appears here.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CITATION_LIMITS,
  normalizeLf,
  verifyCitation,
  verifyCitations,
  type Citation,
  type SourceBundle,
} from "../src/index.js";

const sha = (text: string): string => createHash("sha256").update(normalizeLf(text), "utf8").digest("hex");

function bundleOf(files: readonly (readonly [string, string])[]): SourceBundle {
  return {
    manifest: files.map(([path, text]) => ({ path, sha256Lf: sha(text) })),
    files: files.map(([path, text]) => ({ path, text: normalizeLf(text) })),
  };
}

const bundle = bundleOf([
  ["a.txt", "alpha\nbeta\ngamma\n"],
  ["empty.txt", ""],
  ["bom.txt", "\uFEFFabc\n"],
  ["utf8.txt", "caf\u00e9 \u{1F600} end\n"],
]);

const cite = (file: string, startLine: number, endLine: number, quote: string): Citation => ({ file, startLine, endLine, quote });

describe("normalizeLf (R5.7)", () => {
  it("replaces CRLF and lone CR with LF and changes nothing else", () => {
    expect(normalizeLf("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
    expect(normalizeLf("\r\r\n\n")).toBe("\n\n\n");
    expect(normalizeLf(" a\t")).toBe(" a\t");
  });
});

describe("verifyCitation: verified cases", () => {
  it("accepts a quote inside one line, across lines, and with any line ending in the quote", () => {
    expect(verifyCitation(cite("a.txt", 2, 2, "beta"), bundle)).toEqual({ verified: true });
    expect(verifyCitation(cite("a.txt", 2, 3, "beta\ngamma"), bundle)).toEqual({ verified: true });
    expect(verifyCitation(cite("a.txt", 2, 3, "beta\r\ngamma"), bundle)).toEqual({ verified: true });
    expect(verifyCitation(cite("a.txt", 2, 3, "beta\rgamma"), bundle)).toEqual({ verified: true });
    expect(verifyCitation(cite("a.txt", 1, 3, "ha\nbe"), bundle)).toEqual({ verified: true });
  });

  it("keeps the byte-order mark and does not trim or fold anything", () => {
    expect(verifyCitation(cite("bom.txt", 1, 1, "\uFEFFabc"), bundle)).toEqual({ verified: true });
    expect(verifyCitation(cite("bom.txt", 1, 1, "abc"), bundle)).toEqual({ verified: true });
    expect(verifyCitation(cite("utf8.txt", 1, 1, "\u{1F600} end"), bundle)).toEqual({ verified: true });
    expect(verifyCitation(cite("a.txt", 1, 1, "Alpha"), bundle)).toEqual({ verified: false, reason: "quote_not_found" });
    expect(verifyCitation(cite("utf8.txt", 1, 1, "cafe\u0301"), bundle)).toEqual({ verified: false, reason: "quote_not_found" });
  });
});

describe("verifyCitation: failure reasons and their fixed order (R5.2)", () => {
  it("reports quote_not_found when the quote is outside the cited range", () => {
    expect(verifyCitation(cite("a.txt", 1, 1, "beta"), bundle)).toEqual({ verified: false, reason: "quote_not_found" });
    // The LF that ends the last cited line is not part of the range text.
    expect(verifyCitation(cite("a.txt", 1, 3, "gamma\n"), bundle)).toEqual({ verified: false, reason: "quote_not_found" });
  });

  it("reports range_out_of_bounds from the line count of R5.7", () => {
    expect(verifyCitation(cite("a.txt", 3, 3, "gamma"), bundle)).toEqual({ verified: true });
    expect(verifyCitation(cite("a.txt", 3, 4, "gamma"), bundle)).toEqual({ verified: false, reason: "range_out_of_bounds" });
    expect(verifyCitation(cite("empty.txt", 1, 1, "x"), bundle)).toEqual({ verified: false, reason: "range_out_of_bounds" });
  });

  it("reports file_not_in_bundle for any path that is not equal character for character", () => {
    for (const file of ["A.txt", "./a.txt", "a.txt ", "dir/../a.txt", "b.txt"]) {
      expect(verifyCitation(cite(file, 1, 1, "alpha"), bundle)).toEqual({ verified: false, reason: "file_not_in_bundle" });
    }
  });

  it("reports malformed_citation first, for every R5.1 violation", () => {
    const bad: unknown[] = [
      cite("a.txt", 0, 1, "a"),
      cite("a.txt", 2, 1, "a"),
      cite("a.txt", 1.5, 2, "a"),
      cite("a.txt", 1, 102, "a"),
      cite("a.txt", 1, 1, " \t\n"),
      cite("a.txt", 1, 1, ""),
      cite("a.txt", 1, 1, "x".repeat(CITATION_LIMITS.maxQuoteCodePoints + 1)),
      cite("", 1, 1, "a"),
      { file: "a.txt", startLine: "1", endLine: 1, quote: "a" },
      { file: "a.txt", startLine: 1, endLine: 1 },
      null,
      "text",
      {},
    ];
    for (const c of bad) {
      expect(verifyCitation(c as Citation, bundle)).toEqual({ verified: false, reason: "malformed_citation" });
    }
    // A malformed Citation to a missing file is malformed, not file_not_in_bundle.
    expect(verifyCitation(cite("missing.txt", 0, 1, "a"), bundle)).toEqual({ verified: false, reason: "malformed_citation" });
  });

  it("applies the limits exactly: 100 lines and 1000 code points are allowed", () => {
    const hundredOneLines = bundleOf([["big.txt", `${"l\n".repeat(150)}`]]);
    expect(verifyCitation(cite("big.txt", 1, 100, "l"), hundredOneLines)).toEqual({ verified: true });
    expect(verifyCitation(cite("big.txt", 1, 101, "l"), hundredOneLines)).toEqual({ verified: false, reason: "malformed_citation" });
    const thousand = "\u{1F600}".repeat(CITATION_LIMITS.maxQuoteCodePoints);
    expect(verifyCitation(cite("a.txt", 1, 1, thousand), bundle)).toEqual({ verified: false, reason: "quote_not_found" });
  });
});

describe("verifyCitation: source_unavailable (R5.9)", () => {
  it("fails every Citation of a file whose text differs from the manifest hash, and only that file", () => {
    const tampered: SourceBundle = {
      manifest: bundle.manifest,
      files: bundle.files.map((f) => (f.path === "a.txt" ? { path: f.path, text: `${f.text}x` } : f)),
    };
    expect(verifyCitation(cite("a.txt", 1, 1, "alpha"), tampered)).toEqual({ verified: false, reason: "source_unavailable" });
    expect(verifyCitation(cite("a.txt", 9, 9, "alpha"), tampered)).toEqual({ verified: false, reason: "source_unavailable" });
    expect(verifyCitation(cite("utf8.txt", 1, 1, "end"), tampered)).toEqual({ verified: true });
  });

  it("fails when the file text is missing, listed twice, or not valid text", () => {
    const missing: SourceBundle = { manifest: bundle.manifest, files: bundle.files.filter((f) => f.path !== "a.txt") };
    expect(verifyCitation(cite("a.txt", 1, 1, "alpha"), missing)).toEqual({ verified: false, reason: "source_unavailable" });
    const twice: SourceBundle = { manifest: bundle.manifest, files: [...bundle.files, ...bundle.files.filter((f) => f.path === "a.txt")] };
    expect(verifyCitation(cite("a.txt", 1, 1, "alpha"), twice)).toEqual({ verified: false, reason: "source_unavailable" });
    const lone = bundleOf([["lone.txt", "a\uD800b\n"]]);
    expect(verifyCitation(cite("lone.txt", 1, 1, "a"), lone)).toEqual({ verified: false, reason: "source_unavailable" });
  });

  it("does not match a quote that contains a lone surrogate", () => {
    expect(verifyCitation(cite("a.txt", 1, 1, "a\uDC00"), bundle)).toEqual({ verified: false, reason: "quote_not_found" });
  });
});

describe("verifyCitations (R5.3, R5.4, R5.5)", () => {
  it("returns one result per Citation in order, and a failed Citation does not change the others", () => {
    const cs = [cite("a.txt", 1, 1, "alpha"), cite("a.txt", 1, 1, "nope"), cite("x.txt", 1, 1, "a"), cite("a.txt", 3, 3, "gamma")];
    expect(verifyCitations(cs, bundle)).toEqual([
      { verified: true },
      { verified: false, reason: "quote_not_found" },
      { verified: false, reason: "file_not_in_bundle" },
      { verified: true },
    ]);
    expect(verifyCitations(cs, bundle)).toEqual(cs.map((c) => verifyCitation(c, bundle)));
    expect(verifyCitations([], bundle)).toEqual([]);
  });

  it("does not modify its inputs", () => {
    const frozen: SourceBundle = Object.freeze({
      manifest: Object.freeze(bundle.manifest.map((m) => Object.freeze({ ...m }))),
      files: Object.freeze(bundle.files.map((f) => Object.freeze({ ...f }))),
    });
    const c = Object.freeze(cite("a.txt", 2, 3, "beta\r\ngamma"));
    expect(verifyCitation(c, frozen)).toEqual({ verified: true });
  });
});
