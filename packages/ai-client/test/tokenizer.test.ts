import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_NGRAM_SIZE, FINGERPRINT_HEX_LENGTH, TOKENIZER_ID, ngramHashes, tokenize } from "../src/index.js";

describe("tokenize", () => {
  it("lowercases and splits runs of [a-z0-9_] and single symbols", () => {
    expect(tokenize("GET /Orders/42?x=1")).toEqual(["get", "/", "orders", "/", "42", "?", "x", "=", "1"]);
    expect(tokenize("snake_case_9 Id")).toEqual(["snake_case_9", "id"]);
  });

  it("drops all whitespace, including newlines, tabs and Unicode spaces", () => {
    expect(tokenize(" a\tb\r\nc\u00a0d\u3000e ")).toEqual(["a", "b", "c", "d", "e"]);
    expect(tokenize("")).toEqual([]);
    expect(tokenize(" \n\t ")).toEqual([]);
  });

  it("treats every symbol as its own token, including a run of the same symbol", () => {
    expect(tokenize("{}[]==")).toEqual(["{", "}", "[", "]", "=", "="]);
  });

  it("splits non-ASCII text into single code points, surrogate pairs kept whole", () => {
    expect(tokenize("aé😀b")).toEqual(["a", "é", "😀", "b"]);
    expect(tokenize("ÄB")).toEqual(["ä", "b"]);
  });

  it("is independent of letter case", () => {
    fc.assert(fc.property(fc.string(), (s) => {
      expect(tokenize(s.toUpperCase().toLowerCase())).toEqual(tokenize(s.toLowerCase()));
    }));
  });

  it("is deterministic and yields no empty token and no token with whitespace", () => {
    fc.assert(fc.property(fc.string({ unit: "binary" }), (s) => {
      const a = tokenize(s);
      expect(tokenize(s)).toEqual(a);
      for (const t of a) {
        expect(t).not.toBe("");
        expect(/\s/u.test(t)).toBe(false);
      }
    }));
  });

  it("is invariant under a change of the whitespace between tokens", () => {
    fc.assert(fc.property(fc.array(fc.stringMatching(/^[a-z0-9_]{1,6}$/), { maxLength: 12 }), (words) => {
      // Adjacent words would merge into one run, so join with at least one whitespace character.
      expect(tokenize(words.join(" "))).toEqual(tokenize(words.join(" \n\t ")));
    }));
  });
});

describe("ngramHashes", () => {
  const h = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 12);

  it("hashes each window of n tokens joined by a newline, truncated to 12 hex characters", () => {
    const got = ngramHashes(["a", "b", "c"], 2);
    expect(got).toEqual(new Set([h("a\nb"), h("b\nc")]));
    for (const f of got) expect(f).toMatch(/^[0-9a-f]{12}$/);
  });

  it("matches fixed known answers of token-ngram-sha256-v1 (computed outside this code with `printf ... | sha256sum | cut -c1-12`)", () => {
    // sha256("a\nb") and the three windows of "get\n/\norders", "/\norders\n/", "orders\n/\n42": LF joins, UTF-8, first 12 hex characters.
    expect(ngramHashes(["a", "b"], 2)).toEqual(new Set(["7e18f737311b"]));
    expect(ngramHashes(tokenize("GET /Orders/42"), 3)).toEqual(new Set(["4f54fad17038", "c8df6ffca5a1", "895f250f632b"]));
  });

  it("returns an empty set for fewer than n tokens and for no tokens", () => {
    expect(ngramHashes(["a", "b"], 3).size).toBe(0);
    expect(ngramHashes([], 1).size).toBe(0);
  });

  it("returns exactly one hash for exactly n tokens", () => {
    expect(ngramHashes(["a", "b", "c"], 3)).toEqual(new Set([h("a\nb\nc")]));
  });

  it("collapses repeated windows into one element", () => {
    expect(ngramHashes(["a", "a", "a", "a"], 2).size).toBe(1);
  });

  it("distinguishes token boundaries", () => {
    expect(ngramHashes(["ab", "c"], 2)).not.toEqual(ngramHashes(["a", "bc"], 2));
  });

  it("rejects an n that is not an integer of at least 1", () => {
    for (const n of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => ngramHashes(["a"], n)).toThrow(RangeError);
    }
  });

  it("has at most max(0, tokens - n + 1) elements and is deterministic", () => {
    fc.assert(fc.property(fc.array(fc.string({ maxLength: 4 }), { maxLength: 30 }), fc.integer({ min: 1, max: 6 }), (tokens, n) => {
      const a = ngramHashes(tokens, n);
      expect(a.size).toBeLessThanOrEqual(Math.max(0, tokens.length - n + 1));
      expect(ngramHashes(tokens, n)).toEqual(a);
    }));
  });

  it("matches a shared window: text that contains a restricted run of n tokens contains its fingerprints", () => {
    const restricted = tokenize("alpha beta gamma delta epsilon zeta");
    const payload = tokenize("prefix words alpha beta gamma delta epsilon zeta suffix");
    const fp = ngramHashes(restricted, 3);
    const found = ngramHashes(payload, 3);
    for (const f of fp) expect(found.has(f)).toBe(true);
  });

  it("exports the constants of the audit configuration schema", () => {
    expect(TOKENIZER_ID).toBe("token-ngram-sha256-v1");
    expect(DEFAULT_NGRAM_SIZE).toBe(12);
    expect(FINGERPRINT_HEX_LENGTH).toBe(12);
  });
});
