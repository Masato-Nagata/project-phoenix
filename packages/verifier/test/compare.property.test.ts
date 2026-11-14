// Feature: discovery-loop, Property 13: Comparator results are exact, ordered and repeatable
// **Validates: Requirements 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11**
//
// For any Prediction, Observation and mask configuration, the Comparator result equals the result of an independent
// oracle (own masking, own path lookup, own canonical comparison): the status code is compared first and never masked,
// a predicted field is compared by exact value and type after masking, fields that the Prediction does not name are
// ignored, differences are ordered by path in code-point order after the status, a `not_executed`, `timed_out` or
// `aborted` Experiment is `not_comparable` with that reason, the inputs are not modified, and repeated calls give
// byte-identical results whatever the clock says. A predicted object or list value is masked like the Observation before
// it is compared, and predicting the true value of any existing path is a match (the truth property).
//
// Reproducibility record: SEED = 550002, NUM_RUNS = 400. All generated values are neutral.
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MASK_TOKEN, compare, deriveMaskNote, maskConfigHash, type ComparisonResult, type Difference, type Json, type Observation, type Prediction } from "../src/index.js";
import { deepFreeze, jsonResponse, type JsonValue } from "./helpers/compareFixtures.js";
import { TOKEN, allPaths, bodyArb, canon, coveredPrefix, makePattern, oracleHashOf, oracleLookup, oracleMask, oracleMaskPredicted, patternPickArb } from "./helpers/maskOracle.js";

const SEED = 550002;
const NUM_RUNS = 400;
const TIMEOUT_MS = 120_000;

afterEach(() => vi.useRealTimers());

type Absent = { $absent: true };
const ABSENT: Absent = { $absent: true };

interface Scenario {
  body: { [k: string]: JsonValue };
  patterns: string[];
  maskedAtCapture: boolean;
  statusOk: boolean;
  fields: { path: string; value: JsonValue; kind: "same" | "other" | "gone" }[];
}

const fieldPickArb = fc.record({ i: fc.nat(), kind: fc.constantFrom("same", "same", "other", "gone"), other: fc.integer({ min: -3, max: 3 }), where: fc.nat(3) });

const scenarioArb: fc.Arbitrary<Scenario> = fc
  .tuple(bodyArb, fc.array(patternPickArb, { maxLength: 3 }), fc.boolean(), fc.boolean(), fc.array(fieldPickArb, { minLength: 1, maxLength: 5 }))
  .map(([body, picks, maskedAtCapture, statusOk, fieldPicks]) => {
    const patterns = picks.map((p) => makePattern(body, p));
    const paths = allPaths(body);
    const fields = fieldPicks.map((fp) => {
      if (fp.kind === "gone" || paths.length === 0) return { path: `zz${fp.where}`, value: fp.other as JsonValue, kind: "gone" as const };
      const path = paths[fp.i % paths.length] as string;
      const actual = oracleLookup(body, path).value as JsonValue;
      return fp.kind === "same" ? { path, value: actual, kind: "same" as const } : { path, value: fp.other as JsonValue, kind: "other" as const };
    });
    return { body, patterns, maskedAtCapture, statusOk, fields };
  });

function build(s: Scenario): { p: Prediction; o: Observation; cfg: { paths: string[] } } {
  const cfg = { paths: s.patterns };
  const captured = s.maskedAtCapture ? oracleMask(s.body, s.patterns) : s.body;
  const o: Observation = { experimentId: "exp-1", outcome: "executed", responses: [jsonResponse(200, captured as Json)], stateChecks: [], maskSha256: oracleHashOf(s.patterns) };
  const p: Prediction = { target: { list: "requests", index: 0 }, status: s.statusOk ? 200 : 404, fields: s.fields.map((f) => ({ path: f.path, value: f.value as Json })) };
  return { p, o, cfg };
}

/** The expected result, from the definition. */
function expected(s: Scenario): ComparisonResult {
  const diffs: Difference[] = [];
  if (!s.statusOk) diffs.push({ path: "$status", predicted: 404, observed: 200 });
  const masked = oracleMask(s.body, s.patterns);
  const fieldDiffs: Difference[] = [];
  for (const f of s.fields) {
    const prefix = coveredPrefix(f.path, s.patterns);
    if (prefix !== undefined) {
      // Masked on both sides: only the existence of the outermost masked node is still checked.
      if (!oracleLookup(masked, prefix).found) fieldDiffs.push({ path: f.path, predicted: TOKEN, observed: ABSENT as unknown as Json });
      continue;
    }
    // The predicted value is masked like the Observation (design "Comparator decisions", item 6).
    const predicted = oracleMaskPredicted(f.value, f.path, s.patterns);
    const seen = oracleLookup(masked, f.path);
    if (!seen.found) fieldDiffs.push({ path: f.path, predicted: predicted as Json, observed: ABSENT as unknown as Json });
    else if (canon(predicted) !== canon(seen.value as JsonValue)) fieldDiffs.push({ path: f.path, predicted: predicted as Json, observed: seen.value as Json });
  }
  fieldDiffs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  diffs.push(...fieldDiffs);
  return { experimentId: "exp-1", result: diffs.length === 0 ? "match" : "mismatch", differences: diffs, maskSha256: oracleHashOf(s.patterns) };
}

describe(`Property 13: Comparator results are exact, ordered and repeatable (seed ${SEED}, numRuns ${NUM_RUNS})`, () => {
  it("equals the independent oracle, whether or not the Observation was masked at capture", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { p, o, cfg } = build(s);
        expect(compare(p, o, cfg)).toEqual(expected(s));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("lists the status first and then the paths in ascending code-point order", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { p, o, cfg } = build(s);
        const paths = compare(p, o, cfg).differences.map((d) => d.path);
        const rest = paths[0] === "$status" ? paths.slice(1) : paths;
        expect(rest).toEqual([...rest].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
        expect(paths.indexOf("$status") <= 0).toBe(true);
        expect(paths.filter((x) => x === "$status").length).toBe(s.statusOk ? 0 : 1);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("ignores Observation fields that the Prediction does not name", () => {
    fc.assert(
      fc.property(scenarioArb, fc.jsonValue({ maxDepth: 2 }), (s, extra) => {
        const { p, o, cfg } = build(s);
        const widened: Observation = { ...o, responses: [jsonResponse(200, { ...(o.responses[0]?.body as object), zz_extra: extra } as Json)] };
        expect(compare(p, widened, cfg)).toEqual(compare(p, o, cfg));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("reports a value of another type as a difference: no coercion, no case folding, no trimming", () => {
    const near = (v: JsonValue): JsonValue =>
      typeof v === "number" ? String(v) : typeof v === "string" ? (v === v.toUpperCase() ? `${v} ` : v.toUpperCase()) : typeof v === "boolean" ? (v ? 1 : 0) : v === null ? 0 : v;
    fc.assert(
      fc.property(bodyArb, fc.nat(), (body, i) => {
        const leaves = allPaths(body).filter((pth) => {
          const v = oracleLookup(body, pth).value as JsonValue;
          return v === null || typeof v !== "object";
        });
        fc.pre(leaves.length > 0);
        const path = leaves[i % leaves.length] as string;
        const value = oracleLookup(body, path).value as JsonValue;
        const cfg = { paths: [] as string[] };
        const o: Observation = { experimentId: "exp-1", outcome: "executed", responses: [jsonResponse(200, body as Json)], stateChecks: [], maskSha256: maskConfigHash(cfg) };
        const exact = compare({ target: { list: "requests", index: 0 }, status: 200, fields: [{ path, value: value as Json }] }, o, cfg);
        expect(exact.result).toBe("match");
        const other = compare({ target: { list: "requests", index: 0 }, status: 200, fields: [{ path, value: near(value) as Json }] }, o, cfg);
        expect(other.result).toBe("mismatch");
        expect(other.differences).toEqual([{ path, predicted: near(value), observed: value }]);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("a Prediction made only of masked fields stays a match, and the note derived from the records says status only (R6.6 unchanged)", () => {
    fc.assert(
      fc.property(bodyArb, fc.nat(), fc.array(fc.integer({ min: -3, max: 3 }), { minLength: 1, maxLength: 4 }), (body, i, values) => {
        const paths = allPaths(body);
        fc.pre(paths.length > 0);
        const chosen = values.map((_, k) => paths[(i + k) % paths.length] as string);
        const cfg = { paths: [...chosen] };
        const o: Observation = { experimentId: "exp-1", outcome: "executed", responses: [jsonResponse(200, oracleMask(body, cfg.paths) as Json)], stateChecks: [], maskSha256: maskConfigHash(cfg) };
        const p: Prediction = { target: { list: "requests", index: 0 }, status: 200, fields: chosen.map((path, k) => ({ path, value: values[k] as Json })) };
        const r = compare(p, o, cfg);
        expect(r.result).toBe("match");
        expect(r.differences).toEqual([]);
        expect(deriveMaskNote(p, cfg)).toEqual({ ok: true, value: { predictedFields: chosen.length, maskedFields: chosen.length, unmaskedFields: 0, statusOnly: true } });
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("reports the state of the Experiment as the reason, never a match or a mismatch (R10.8)", () => {
    fc.assert(
      fc.property(scenarioArb, fc.constantFrom("not_executed", "timed_out", "aborted"), (s, outcome) => {
        const { p, o, cfg } = build(s);
        const r = compare(p, { ...o, outcome }, cfg);
        expect(r).toEqual({ experimentId: "exp-1", result: "not_comparable", reason: outcome, differences: [], maskSha256: oracleHashOf(s.patterns) });
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("answers mask_config_invalid when the hash of the Observation differs from the configuration's", () => {
    fc.assert(
      fc.property(scenarioArb, fc.constantFrom("zz1", "zz2"), (s, extraPath) => {
        const { p, o, cfg } = build(s);
        const other = { paths: [...s.patterns, extraPath] };
        fc.pre(oracleHashOf(other.paths) !== oracleHashOf(s.patterns));
        expect(compare(p, o, other)).toMatchObject({ result: "not_comparable", reason: "mask_config_invalid" });
        expect(compare(p, o, cfg).result).not.toBe("not_comparable");
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("does not modify its inputs, shares no node with them, and is repeatable whatever the clock says (R10.10, R10.11)", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const built = build(s);
        const p = deepFreeze(structuredClone(built.p));
        const o = deepFreeze(structuredClone(built.o));
        const cfg = deepFreeze(structuredClone(built.cfg));
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2003-03-03T03:03:03Z"));
        const first = compare(p, o, cfg);
        vi.setSystemTime(new Date("2044-04-04T04:04:04Z"));
        const second = compare(p, o, cfg);
        vi.useRealTimers();
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
        expect(JSON.stringify(p)).toBe(JSON.stringify(built.p));
        expect(JSON.stringify(o)).toBe(JSON.stringify(built.o));
        for (const d of first.differences) {
          for (const side of [d.predicted, d.observed]) {
            if (typeof side === "object" && side !== null) expect(Object.isFrozen(side)).toBe(false); // a copy, not the frozen input
          }
        }
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("the truth property: the true value of any existing path, as a Prediction, matches whatever the mask configuration is", () => {
    // Conditions: the status code is equal, the body is comparable (JSON), and every predicted path is valid and exists.
    fc.assert(
      fc.property(bodyArb, fc.array(patternPickArb, { maxLength: 3 }), fc.boolean(), fc.array(fc.nat(), { minLength: 1, maxLength: 5 }), (body, picks, maskedAtCapture, idx) => {
        const paths = allPaths(body);
        fc.pre(paths.length > 0);
        const patterns = picks.map((pk) => makePattern(body, pk));
        const captured = maskedAtCapture ? oracleMask(body, patterns) : body;
        const o: Observation = { experimentId: "exp-1", outcome: "executed", responses: [jsonResponse(200, captured as Json)], stateChecks: [], maskSha256: oracleHashOf(patterns) };
        const chosen = idx.map((i) => paths[i % paths.length] as string);
        const p: Prediction = { target: { list: "requests", index: 0 }, status: 200, fields: chosen.map((path) => ({ path, value: oracleLookup(body, path).value as Json })) };
        const r = compare(p, o, { paths: patterns });
        expect(r.differences).toEqual([]);
        expect(r.result).toBe("match");
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("a difference shows the masked predicted value, and the Prediction is left as it was", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const built = build(s);
        const p = deepFreeze(structuredClone(built.p));
        const r = compare(p, built.o, built.cfg);
        for (const d of r.differences) {
          if (d.path === "$status") continue;
          // With a repeated path the difference may belong to either entry; the shown value is the masked form of one of them.
          const candidates = s.fields.filter((x) => x.path === d.path).map((x) => (coveredPrefix(x.path, s.patterns) !== undefined ? TOKEN : oracleMaskPredicted(x.value, x.path, s.patterns)));
          expect(candidates.map((c) => canon(c))).toContain(canon(d.predicted as JsonValue));
        }
        expect(JSON.stringify(p)).toBe(JSON.stringify(built.p));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("the constant token is what masked predicted fields show in a difference", () => {
    expect(MASK_TOKEN).toBe(TOKEN);
  });
});