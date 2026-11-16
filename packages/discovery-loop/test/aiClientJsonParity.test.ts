// The JSON rules of `packages/ai-client` (strict parse, canonical form) are a port of the ones in this package, because ai-client must not
// depend on discovery-loop. This test keeps the two from drifting apart: same accept/reject decision, same failure code, same canonical text.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { strictJsonParse as aiParse, tryCanonicalJson as aiTryCanonical } from "../../ai-client/src/index.js";
import { strictParse, tryCanonicalJson } from "../src/index.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const FC = { seed: 34_002, numRuns: 300 };
const LIMITS = { maxBytes: 262144, maxDepth: 32 };

/** Strings that are likely to be near-JSON: valid JSON, and the same with small damage. */
const nearJson = fc.oneof(
  fc.jsonValue().map((v) => JSON.stringify(v)),
  fc.jsonValue().map((v) => JSON.stringify(v, null, 2)),
  fc.tuple(fc.jsonValue(), fc.nat(), fc.constantFrom('"', "{", "}", ",", ":", "\\", "\u0001", "é", "\ud800", "1e999", "-0", "9007199254740993", '"a":1,"a":2'))
    .map(([v, at, ins]) => { const t = JSON.stringify(v); const i = at % (t.length + 1); return t.slice(0, i) + ins + t.slice(i); }),
  fc.string(),
);

describe("ai-client JSON rules equal the discovery-loop rules", () => {
  it("strict parse: same decision, same failure code, same value", () => {
    fc.assert(
      fc.property(nearJson, (text) => {
        const a = aiParse(enc(text), { maxDepth: LIMITS.maxDepth, maxBytes: LIMITS.maxBytes });
        const b = strictParse(enc(text), LIMITS);
        expect(a.ok).toBe(b.ok);
        if (a.ok && b.ok) {
          // parsed values can still be refused by the canonical writer (for example 1e+21); both must agree on that too
          const ca = aiTryCanonical(a.value);
          const cb = tryCanonicalJson(b.value);
          expect(ca.ok).toBe(cb.ok);
          if (ca.ok && cb.ok) expect(ca.value).toBe(cb.value);
        }
        if (!a.ok && !b.ok) expect(a.error.code).toBe(b.error.code);
      }),
      FC,
    );
  });

  it("canonical form: same text, or both refuse", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const a = aiTryCanonical(v);
        const b = tryCanonicalJson(v);
        expect(a.ok).toBe(b.ok);
        if (a.ok && b.ok) expect(a.value).toBe(b.value);
      }),
      FC,
    );
    for (const odd of [Number.NaN, 2 ** 53, "\ud800", "\udc00x", -0, { b: 1, a: 2 }, [undefined], { a: undefined }]) {
      const a = aiTryCanonical(odd);
      const b = tryCanonicalJson(odd);
      expect(a.ok).toBe(b.ok);
      if (a.ok && b.ok) expect(a.value).toBe(b.value);
    }
  });
});