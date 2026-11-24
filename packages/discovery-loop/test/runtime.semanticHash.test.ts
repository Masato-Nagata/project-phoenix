// Task 4.9-B: the production `semanticSha256Of`. It must give exactly the value of the existing contract, `sha256Hex(canonicalJson(input))`
// over the semantic part of a claim (condition, effect, citations, and threshold only when the claim has one). Synthetic values only.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "@phoenix/ai-client";
import type { Json } from "@phoenix/ai-client";
import { semanticSha256Of, type SemanticHashInput } from "../src/runtime/semanticHash.js";

const base = (): SemanticHashInput => ({
  condition: { op: "eq", left: { ref: "request.method" }, right: { value: "GET" } },
  effect: { description: "The response status is 200.", kind: "status" },
  citations: [{ file: "legacy/src/utils.php", startLine: 1, endLine: 3 }],
});
const reference = (v: unknown): string => sha256Hex(canonicalJson(v as Json));
const valueOf = (r: ReturnType<typeof semanticSha256Of>): string => {
  if (!r.ok) throw new Error("expected ok");
  return r.value;
};

describe("semanticSha256Of", () => {
  it("equals sha256Hex(canonicalJson(input)) of the existing contract, as 64 lowercase hex characters", () => {
    const v = base();
    const h = valueOf(semanticSha256Of(v));
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(reference(v));
  });

  it("includes the threshold only when the claim has one (null counts as present, undefined as absent)", () => {
    const without = valueOf(semanticSha256Of(base()));
    const explicitUndefined = valueOf(semanticSha256Of({ ...base(), threshold: undefined } as unknown as SemanticHashInput));
    expect(explicitUndefined).toBe(without);
    const withThreshold = { ...base(), threshold: { max: 3 } };
    expect(valueOf(semanticSha256Of(withThreshold))).toBe(reference(withThreshold));
    expect(valueOf(semanticSha256Of(withThreshold))).not.toBe(without);
    const withNull = { ...base(), threshold: null };
    expect(valueOf(semanticSha256Of(withNull))).toBe(reference(withNull));
    expect(valueOf(semanticSha256Of(withNull))).not.toBe(without);
  });

  it("does not depend on the key order of the input or of nested objects", () => {
    const a = base();
    const b: SemanticHashInput = { citations: a.citations, effect: { kind: "status", description: "The response status is 200." }, condition: a.condition };
    expect(valueOf(semanticSha256Of(b))).toBe(valueOf(semanticSha256Of(a)));
  });

  it("does not hash a key other than the four", () => {
    const extra = { ...base(), aiStated: { confidence: 0.9 } } as unknown as SemanticHashInput;
    expect(valueOf(semanticSha256Of(extra))).toBe(valueOf(semanticSha256Of(base())));
  });

  it("changes when any of the four parts changes", () => {
    const h0 = valueOf(semanticSha256Of(base()));
    expect(valueOf(semanticSha256Of({ ...base(), condition: { op: "ne" } }))).not.toBe(h0);
    expect(valueOf(semanticSha256Of({ ...base(), effect: { kind: "other" } }))).not.toBe(h0);
    expect(valueOf(semanticSha256Of({ ...base(), citations: [] }))).not.toBe(h0);
  });

  it("refuses with the closed code and no value for input that has no canonical form", () => {
    const CANARY = "CANARY-semantic-5e2a";
    const bads: unknown[] = [
      null,
      undefined,
      "x",
      { effect: {}, citations: [] }, // condition missing
      { ...base(), condition: undefined },
      { ...base(), effect: { n: Number.NaN } },
      { ...base(), citations: [{ s: `${CANARY}\ud800` }] }, // a lone surrogate
      { ...base(), condition: { f: () => CANARY } },
    ];
    for (const bad of bads) {
      const r = semanticSha256Of(bad as SemanticHashInput);
      expect(r, String(bad)).toEqual({ ok: false, error: { code: "semantic_hash_failed" } });
      expect(JSON.stringify(r)).not.toContain(CANARY);
    }
  });

  it("never throws, also for a hostile accessor", () => {
    const hostile = {};
    Object.defineProperty(hostile, "condition", { enumerable: true, get: () => { throw new Error("boom"); } });
    expect(() => semanticSha256Of(hostile as SemanticHashInput)).not.toThrow();
    expect(semanticSha256Of(hostile as SemanticHashInput).ok).toBe(false);
  });

  it("property: equals the contract value for any JSON parts, and fails exactly when the contract has no canonical form", () => {
    fc.assert(
      fc.property(fc.jsonValue(), fc.jsonValue(), fc.jsonValue(), fc.option(fc.jsonValue(), { nil: undefined }), (condition, effect, citations, threshold) => {
        const input = (threshold === undefined ? { condition, effect, citations } : { condition, effect, citations, threshold }) as SemanticHashInput;
        const got = semanticSha256Of(input);
        let expected: string | undefined;
        try {
          expected = reference(input);
        } catch {
          expected = undefined;
        }
        if (expected === undefined) expect(got.ok).toBe(false);
        else expect(got).toEqual({ ok: true, value: expected });
      }),
      { numRuns: 100 },
    );
  });
});