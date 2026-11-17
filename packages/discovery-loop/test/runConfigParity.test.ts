// Task 4.1, stage A: parity between the local copies of this package and the code that defines the values (design: "Mask and environment
// names (DECIDED)"). discovery-loop has no runtime dependency on the other packages, so `src` keeps local constants and this TEST imports the
// sibling SOURCES (as `aiClientJsonParity.test.ts` and `mockProviderSchema.test.ts` do) to keep the copies from drifting apart.
// The existing masking code is NOT changed; it is only read.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOCK_FIXTURE_SET_NAME as AI_DEFAULT_FIXTURE_SET,
  DEFAULT_RESPONSE_LIMITS,
  MOCK_FIXTURE_SETS,
  resolveResponseLimits,
} from "../../ai-client/src/index.js";
import { validateMaskConfig } from "../../verifier/src/compare/mask.js";
import { parseMaskPattern } from "../../verifier/src/compare/path.js";
import { LIMIT_MAXIMA } from "../../verifier/src/policy/config.js";
import { validateRunnerLimits } from "../../verifier/src/runner/runner.js";
import { DEFAULT_RUNNER_LIMITS, EXPERIMENT_TIMEOUT_RANGE_MS, REQUEST_TIMEOUT_RANGE_MS } from "../../verifier/src/runner/types.js";
import {
  DEFAULT_MOCK_FIXTURE_SET_NAME,
  MASK_PATH_PATTERN,
  MAX_MASK_PATHS,
  MAX_MASK_PATH_LENGTH,
  MOCK_FIXTURE_SET_NAMES,
  RUN_CONFIG_KNOWN_NAMES,
  RUN_LIMITS,
  SCHEMAS,
  validateRunConfig,
} from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const maskRegex = new RegExp(MASK_PATH_PATTERN, "u");
const localMaskCheck = (s: string): boolean => s.length >= 1 && s.length <= MAX_MASK_PATH_LENGTH && maskRegex.test(s);
/** The whole stage A (schema pattern, length, Ajv) on one mask entry: the end-to-end side of the parity. */
const stageAAccepts = (s: string): boolean =>
  validateRunConfig({ schemaVersion: 1, provider: "mock", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [s] }, envNames: [] }).ok;
/** The existing masking code: the grammar and the configuration check. */
const verifierAccepts = (s: string): boolean => parseMaskPattern(s) !== undefined && validateMaskConfig({ paths: [s] }).ok;
/** Every string of at most `maxLen` tokens over `tokens`. */
function* enumerate(tokens: readonly string[], maxLen: number): Generator<string> {
  let level: string[] = [""];
  yield "";
  for (let n = 1; n <= maxLen; n += 1) {
    const next: string[] = [];
    for (const prefix of level) for (const t of tokens) next.push(prefix + t);
    for (const s of next) yield s;
    level = next;
  }
}

describe("limits and defaults equal the code that defines them", () => {
  it("the response limits equal DEFAULT_RESPONSE_LIMITS of ai-client", () => {
    expect(RUN_LIMITS.responseBytes.default).toBe(DEFAULT_RESPONSE_LIMITS.maxResponseBytes);
    expect(RUN_LIMITS.claimsPerHypothesis.default).toBe(DEFAULT_RESPONSE_LIMITS.maxClaims);
    expect(RUN_LIMITS.citationsPerClaim.default).toBe(DEFAULT_RESPONSE_LIMITS.maxCitationsPerClaim);
    expect(RUN_LIMITS.experimentsPerResponse.default).toBe(DEFAULT_RESPONSE_LIMITS.maxExperiments);
    expect(RUN_LIMITS.requestsPerExperiment.default).toBe(DEFAULT_RESPONSE_LIMITS.maxRequestsPerExperiment);
    expect(RUN_LIMITS.requestBodyBytes.default).toBe(DEFAULT_RESPONSE_LIMITS.maxRequestBodyBytes);
  });
  it("every resolved response limit, at its minimum and its maximum, is accepted by resolveResponseLimits", () => {
    const names = {
      responseBytes: "maxResponseBytes", claimsPerHypothesis: "maxClaims", citationsPerClaim: "maxCitationsPerClaim",
      experimentsPerResponse: "maxExperiments", requestsPerExperiment: "maxRequestsPerExperiment", requestBodyBytes: "maxRequestBodyBytes",
    } as const;
    for (const pick of ["min", "max", "default"] as const) {
      const overrides = Object.fromEntries(Object.entries(names).map(([k, n]) => [n, RUN_LIMITS[k as keyof typeof names][pick]]));
      const r = resolveResponseLimits(overrides);
      expect(r.ok, pick).toBe(true);
      if (r.ok) for (const [k, n] of Object.entries(names)) expect((r.value as Any)[n]).toBe(RUN_LIMITS[k as keyof typeof names][pick]);
    }
  });
  it("the fixed bounds are the bounds of the Hypothesis and Experiment schemas and of the policy loader", () => {
    const hyp = SCHEMAS["hypothesis-proposal"] as Any;
    const exp = SCHEMAS["experiment"] as Any;
    expect(hyp.properties.claims.maxItems).toBe(RUN_LIMITS.claimsPerHypothesis.max);
    expect(hyp.$defs.Claim.properties.citations.maxItems).toBe(RUN_LIMITS.citationsPerClaim.max);
    expect(exp.properties.requests.maxItems).toBe(RUN_LIMITS.requestsPerExperiment.max);
    expect(LIMIT_MAXIMA.requests).toBe(RUN_LIMITS.requestsPerExperiment.max);
    expect(LIMIT_MAXIMA.bodyBytes).toBe(RUN_LIMITS.requestBodyBytes.max);
    for (const k of ["claimsPerHypothesis", "citationsPerClaim", "requestsPerExperiment", "requestBodyBytes"] as const) expect(RUN_LIMITS[k].bound).toBe("fixed");
  });
  it("the time limits equal the ranges and defaults of the Runner (R9.14)", () => {
    expect(RUN_LIMITS.perRequestSeconds.default * 1000).toBe(DEFAULT_RUNNER_LIMITS.requestTimeoutMs);
    expect(RUN_LIMITS.perExperimentSeconds.default * 1000).toBe(DEFAULT_RUNNER_LIMITS.experimentTimeoutMs);
    expect(RUN_LIMITS.perRequestSeconds.min * 1000).toBe(REQUEST_TIMEOUT_RANGE_MS.min);
    expect(RUN_LIMITS.perRequestSeconds.max * 1000).toBe(REQUEST_TIMEOUT_RANGE_MS.max);
    expect(RUN_LIMITS.perExperimentSeconds.min * 1000).toBe(EXPERIMENT_TIMEOUT_RANGE_MS.min);
    expect(RUN_LIMITS.perExperimentSeconds.max * 1000).toBe(EXPERIMENT_TIMEOUT_RANGE_MS.max);
    for (const [r, e] of [[1, 1], [60, 600], [10, 60], [1, 600], [60, 60]] as const) {
      expect(validateRunnerLimits({ requestTimeoutMs: r * 1000, experimentTimeoutMs: e * 1000 }), `${r}/${e}`).toEqual([]);
    }
    expect(validateRunnerLimits({ requestTimeoutMs: 61_000, experimentTimeoutMs: 600_000 })).not.toEqual([]);
    expect(validateRunnerLimits({ requestTimeoutMs: 60_000, experimentTimeoutMs: 59_000 })).not.toEqual([]);
  });
  it("the Mock_Provider fixture set names equal MOCK_FIXTURE_SETS, and the default name is the one of ai-client", () => {
    expect([...MOCK_FIXTURE_SET_NAMES].sort()).toEqual(Object.keys(MOCK_FIXTURE_SETS).sort());
    expect(DEFAULT_MOCK_FIXTURE_SET_NAME).toBe(AI_DEFAULT_FIXTURE_SET);
  });
});

describe("the mask path grammar equals parseMaskPattern, and the mask configuration agrees with validateMaskConfig", () => {
  it("constants: at most 64 entries and 128 characters, as in validateMaskConfig and parseMaskPattern", () => {
    expect(MAX_MASK_PATH_LENGTH).toBe(128);
    expect(MAX_MASK_PATHS).toBe(64);
    expect(validateMaskConfig({ paths: Array.from({ length: 64 }, () => "a") }).ok).toBe(true);
    expect(validateMaskConfig({ paths: Array.from({ length: 65 }, () => "a") }).ok).toBe(false);
    expect(parseMaskPattern("a".repeat(128))).toBeDefined();
    expect(parseMaskPattern("a".repeat(129))).toBeUndefined();
  });
  it("edge cases agree", () => {
    const cases = ["", "a", "a.b", "[0]", "[*]", "a[0]", "a[*]", "a[01]", "a[10000]", "a[9999]", "a[", "a[]", "a.", ".a", "a..b", "a.[0]", "[0].a", "[0][1]",
      "a[0]b", "a[0].b", "1a", "_", "a b", "é", "a-b", "a[*].b[*]", "a".repeat(128), "a".repeat(129), "[*".padEnd(128, "x"), "a.b.c.d.e", "A_1.b2"];
    // line terminators, control and look-alike characters: `$` of a JavaScript regular expression without the m flag must not accept a trailing newline
    cases.push("a\n", "a\r", "\na", "a\u2028", "a\u0000", "[0]\n", " a", "a ", "\ta", "ａ", "[１]", "a[٣]", "a\u200b", "a.b\n", "[*]\u0000");
    for (const s of cases) {
      expect(localMaskCheck(s), `regex ${JSON.stringify(s)}`).toBe(parseMaskPattern(s) !== undefined);
      expect(stageAAccepts(s), `stage A ${JSON.stringify(s)}`).toBe(parseMaskPattern(s) !== undefined);
      expect(verifierAccepts(s), `verifier ${JSON.stringify(s)}`).toBe(parseMaskPattern(s) !== undefined);
    }
  });
  it("digit and bracket boundaries of an index agree, end to end", () => {
    const idx = ["0", "00", "01", "1", "9", "10", "99", "100", "999", "1000", "9999", "10000", "99999", "*", "**", "-1", "+1", "1.0", "1e2", "0x1", ""];
    for (const i of idx) {
      for (const s of [`[${i}]`, `a[${i}]`, `a[${i}].b`, `[${i}][${i}]`, `a.[${i}]`]) {
        expect(stageAAccepts(s), JSON.stringify(s)).toBe(parseMaskPattern(s) !== undefined);
        expect(localMaskCheck(s), JSON.stringify(s)).toBe(parseMaskPattern(s) !== undefined);
      }
    }
  });
  it("EXHAUSTIVE: every string of up to 5 characters over a 9-character alphabet, and up to 6 over a 7-character one, is judged alike by the regex, stage A and the existing code", () => {
    const mismatches: string[] = [];
    let accepted = 0;
    let rejected = 0;
    const check = (s: string): void => {
      const expected = parseMaskPattern(s) !== undefined;
      if (expected) accepted += 1;
      else rejected += 1;
      if (localMaskCheck(s) !== expected || stageAAccepts(s) !== expected || verifierAccepts(s) !== expected) mismatches.push(s);
    };
    for (const s of enumerate(["a", "_", "0", "9", "[", "]", "*", ".", "-"], 5)) check(s);
    for (const s of enumerate(["[", "]", "0", "1", "*", "a", "."], 6)) check(s);
    expect(mismatches.slice(0, 10)).toEqual([]);
    // positive control: the enumeration is not trivial, it contains many accepted and many rejected entries
    expect(accepted).toBeGreaterThan(1000);
    expect(rejected).toBeGreaterThan(100_000);
  }, 120_000);
  it("the 128-character boundary agrees end to end for every kind of last segment", () => {
    for (const unit of ["a", ".a", "[0]", "[*]", "a[0]", "_1"]) {
      for (let n = 120; n <= 135; n += 1) {
        const s = unit.repeat(n).slice(0, n);
        expect(stageAAccepts(s), `${unit} ${n}`).toBe(parseMaskPattern(s) !== undefined);
      }
    }
  });
  it("agree on generated strings (valid-looking and arbitrary)", () => {
    const alphabet = ["a", "Z", "_", "0", "1", "9", "[", "]", "*", ".", "-", " ", "é", "[0]", "[*]", ".a", "ab"];
    const arbitrary = fc.array(fc.constantFrom(...alphabet), { maxLength: 14 }).map((a) => a.join(""));
    const lengthEdge = fc.tuple(fc.constantFrom("a", ".a", "[0]"), fc.integer({ min: 120, max: 135 })).map(([u, n]) => u.repeat(n).slice(0, n));
    fc.assert(
      fc.property(fc.oneof(arbitrary, lengthEdge), (s) => {
        expect(localMaskCheck(s)).toBe(parseMaskPattern(s) !== undefined);
      }),
      { seed: 410_201, numRuns: 4000 },
    );
  });
  it("the names that an issue may echo are exactly the property names of the run-config schema, plus the removed `token`", () => {
    const names = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) return void node.forEach(walk);
      if (typeof node !== "object" || node === null) return;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "properties" && typeof v === "object" && v !== null) for (const name of Object.keys(v)) names.add(name);
        walk(v);
      }
    };
    walk(SCHEMAS["run-config"]);
    expect([...names].sort()).toEqual([...RUN_CONFIG_KNOWN_NAMES].filter((n) => n !== "token").sort());
    expect(RUN_CONFIG_KNOWN_NAMES).toContain("token");
    expect(new Set(RUN_CONFIG_KNOWN_NAMES).size).toBe(RUN_CONFIG_KNOWN_NAMES.length);
  });
  it("a configuration accepted by stage A is accepted by validateMaskConfig; a token key is refused by both", () => {
    const paths = ["a", "a[*].b", "[0]", "a", "x_y.z[3]"];
    const stage = validateRunConfig({ schemaVersion: 1, provider: "mock", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths }, envNames: [] });
    expect(stage.ok).toBe(true);
    expect(validateMaskConfig({ paths }).ok).toBe(true);
    const withToken = validateMaskConfig({ paths, token: "<masked>" });
    expect(withToken.ok).toBe(false);
    if (!withToken.ok) expect(withToken.error.join(" ")).toContain("not configurable");
    const refused = validateRunConfig({ schemaVersion: 1, provider: "mock", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths, token: "<masked>" }, envNames: [] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error).toEqual([{ code: "unknown_key", path: "/mask/token" }]);
  });
});