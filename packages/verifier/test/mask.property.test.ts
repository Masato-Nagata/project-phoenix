// Feature: discovery-loop, Property 12: Masking is idempotent
// **Validates: Requirements 10.2, 10.12**
//
// For any JSON value and any mask configuration, `maskJson(maskJson(v, cfg), cfg)` equals `maskJson(v, cfg)`, and
// masking never adds a path that was absent. In addition: the result does not depend on the order or the repetition
// of the paths, equals an independent outermost-wins oracle, and leaves the input unchanged.
//
// Reproducibility record: SEED = 550001, NUM_RUNS = 400. All generated values are neutral.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { maskConfigHash, maskJson, validateMaskConfig, type Json } from "../src/index.js";
import { deepFreeze } from "./helpers/compareFixtures.js";
import { allPaths, jsonArb, makePattern, oracleHashOf, oracleMask, patternPickArb } from "./helpers/maskOracle.js";

const SEED = 550001;
const NUM_RUNS = 400;
const TIMEOUT_MS = 120_000;

const caseArb = fc.tuple(jsonArb, fc.array(patternPickArb, { maxLength: 4 })).map(([value, picks]) => ({ value, patterns: picks.map((p) => makePattern(value, p)) }));

describe(`Property 12: Masking is idempotent (seed ${SEED}, numRuns ${NUM_RUNS})`, () => {
  it("every generated pattern is a valid mask path", () => {
    fc.assert(
      fc.property(caseArb, ({ patterns }) => {
        expect(validateMaskConfig({ paths: patterns }).ok, patterns.join(" | ")).toBe(true);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("is idempotent and equals the independent oracle", () => {
    fc.assert(
      fc.property(caseArb, ({ value, patterns }) => {
        const once = maskJson(value as Json, { paths: patterns });
        expect(once).toEqual(oracleMask(value, patterns));
        expect(maskJson(once, { paths: patterns })).toEqual(once);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("does not depend on the order or the repetition of the paths, and the hash does not either", () => {
    fc.assert(
      fc.property(caseArb, ({ value, patterns }) => {
        const base = maskJson(value as Json, { paths: patterns });
        const shuffled = [...patterns].reverse().flatMap((p, i) => (i % 2 === 0 ? [p, p] : [p]));
        expect(maskJson(value as Json, { paths: shuffled })).toEqual(base);
        expect(maskConfigHash({ paths: shuffled })).toBe(maskConfigHash({ paths: patterns }));
        expect(maskConfigHash({ paths: patterns })).toBe(oracleHashOf(patterns));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("never adds a path that was absent, never changes the input, and shares no node with it", () => {
    fc.assert(
      fc.property(caseArb, ({ value, patterns }) => {
        const before = JSON.stringify(value);
        const frozen = deepFreeze(structuredClone(value));
        const masked = maskJson(frozen as Json, { paths: patterns });
        expect(JSON.stringify(value)).toBe(before);
        expect(JSON.stringify(frozen)).toBe(before);
        const existing = new Set(allPaths(value));
        expect(allPaths(masked as never).filter((p) => !existing.has(p))).toEqual([]);
        if (typeof masked === "object" && masked !== null && typeof frozen === "object" && frozen !== null) expect(masked).not.toBe(frozen);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("with no path it returns an equal copy", () => {
    fc.assert(
      fc.property(jsonArb, (value) => {
        expect(maskJson(value as Json, { paths: [] })).toEqual(value);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);
});