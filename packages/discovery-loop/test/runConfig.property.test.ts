// Feature: discovery-loop, Property: RunConfig stage A (task 4.1)
// **Validates: Requirements 11.7, 11.8, 11.10, 8.11, 17.2, 9.14**
// Fixed seeds and bounded run counts, so a failure can be reproduced. Synthetic data only; assertions compare codes, pointers and numbers.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RUN_CONFIG_KNOWN_NAMES, RUN_LIMITS, RUN_LIMIT_KEYS, validateRunConfig, type ConfigIssue, type RunLimitKey } from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const RUNS = { seed: 410_101, numRuns: 300 };

const keyArb = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,10}$/);
const indexArb = fc.constantFrom("[0]", "[7]", "[*]", "[9999]");
const segmentArb = fc.oneof(keyArb, indexArb);
/** A mask entry that `parseMaskPattern` accepts: a first segment, then `.name` or an index. */
const maskPathArb = fc
  .tuple(segmentArb, fc.array(fc.oneof(keyArb.map((k) => `.${k}`), indexArb), { maxLength: 4 }))
  .map(([first, rest]) => first + rest.join(""))
  .filter((p) => p.length <= 128);
const envNameArb = fc.stringMatching(/^[A-Za-z_][A-Za-z0-9_]{0,40}$/);

const limitsArb = fc
  .record(
    Object.fromEntries(RUN_LIMIT_KEYS.map((k) => [k, fc.integer({ min: RUN_LIMITS[k].min, max: RUN_LIMITS[k].max })])) as Record<RunLimitKey, fc.Arbitrary<number>>,
    { requiredKeys: [] },
  )
  // the cross-field rules hold on the effective values
  .filter((l) => (l.providerCallSeconds ?? 120) <= (l.runSeconds ?? 1800) && (l.perExperimentSeconds ?? 60) >= (l.perRequestSeconds ?? 10));

const validArb = fc
  .record({
    provider: fc.constantFrom("mock", "kiro-cli"),
    useFixture: fc.boolean(),
    limits: limitsArb,
    baseAddress: fc.constantFrom("http://127.0.0.1:8056", "http://reverse-proxy:8080"),
    paths: fc.array(maskPathArb, { maxLength: 8 }),
    envNames: fc.array(envNameArb, { maxLength: 6 }),
  })
  .map((v) => {
    const raw: Any = {
      schemaVersion: 1,
      provider: v.provider,
      limits: v.limits,
      testApi: { baseAddress: v.baseAddress },
      mask: { paths: v.paths },
      envNames: v.envNames,
    };
    if (v.provider === "mock" && v.useFixture) raw.mockFixtureSet = "default-widget-v1";
    return raw;
  });

const issuesOf = (raw: unknown): ConfigIssue[] => {
  const r = validateRunConfig(raw);
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};
const reorder = (o: Any): Any => {
  if (Array.isArray(o) || typeof o !== "object" || o === null) return o;
  const out: Any = {};
  for (const k of Object.keys(o).reverse()) out[k] = reorder(o[k]);
  return out;
};

describe("Property: an absent optional key is never refused and takes its default", () => {
  it("accepts every valid configuration and resolves each effective value to the given value or the default", () => {
    fc.assert(
      fc.property(validArb, (raw) => {
        const r = validateRunConfig(raw);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        for (const k of RUN_LIMIT_KEYS) expect(r.value.limits[k]).toBe(raw.limits[k] ?? RUN_LIMITS[k].default);
        expect(r.value.provider).toBe(raw.provider);
        expect(r.value.mockFixtureSet).toBe(raw.provider === "mock" ? "default-widget-v1" : undefined);
        expect(r.value.mask.paths).toEqual(raw.mask.paths);
        expect(r.value.envNames).toEqual(raw.envNames);
      }),
      RUNS,
    );
  });
});

describe("Property: one mutation gives exactly the expected issue", () => {
  const requiredKeys = ["schemaVersion", "provider", "limits", "testApi", "mask", "envNames"] as const;
  const mutation = fc.oneof(
    fc.constantFrom(...requiredKeys).map((k) => ({ kind: "remove", key: k })),
    fc.constantFrom(...requiredKeys).map((k) => ({ kind: "null", key: k })),
    fc.tuple(fc.constantFrom(...RUN_LIMIT_KEYS), fc.constantFrom("null", "string", "fraction", "below", "above")).map(([k, how]) => ({ kind: "limit", key: k, how })),
    fc.tuple(fc.constantFrom("", "limits", "testApi", "mask"), keyArb.filter((k) => !RUN_CONFIG_KNOWN_NAMES.includes(k))).map(([where, name]) => ({ kind: "unknown", where, name })),
  );

  it("refuses with the expected code at the expected pointer and with no other issue", () => {
    fc.assert(
      fc.property(validArb, mutation, (raw, m) => {
        const cfg = structuredClone(raw) as Any;
        let expected: ConfigIssue;
        if (m.kind === "remove") {
          delete cfg[m.key];
          expected = { code: "required_missing", path: `/${m.key}` };
        } else if (m.kind === "null") {
          cfg[m.key] = null;
          expected = { code: "null_value", path: `/${m.key}` };
        } else if (m.kind === "limit") {
          const spec = RUN_LIMITS[m.key as RunLimitKey];
          const path = `/limits/${m.key}`;
          if (m.how === "null") { cfg.limits[m.key] = null; expected = { code: "null_value", path }; }
          else if (m.how === "string") { cfg.limits[m.key] = "7"; expected = { code: "wrong_type", path }; }
          else if (m.how === "fraction") { cfg.limits[m.key] = spec.min + 0.5; expected = { code: "not_integer", path }; }
          else if (m.how === "below") { cfg.limits[m.key] = spec.min - 1; expected = { code: "out_of_range", path }; }
          else { cfg.limits[m.key] = spec.max + 1; expected = { code: spec.bound === "fixed" ? "above_fixed_bound" : "out_of_range", path }; }
        } else {
          const holder = m.where === "" ? cfg : cfg[m.where];
          holder[m.name] = 1;
          expected = { code: "unknown_key", path: `${m.where === "" ? "" : `/${m.where}`}/<unknown>` };
        }
        expect(issuesOf(cfg)).toEqual([expected]);
      }),
      { seed: 410_102, numRuns: 500 },
    );
  });
});

describe("Property: order, purity and safety", () => {
  it("key order of the input never changes the result or the issue order", () => {
    fc.assert(
      fc.property(validArb, fc.boolean(), (raw, spoil) => {
        const cfg = structuredClone(raw) as Any;
        if (spoil) { cfg.zzz = 1; cfg.limits.runSeconds = 0; cfg.mask.token = "x"; }
        const a = validateRunConfig(cfg);
        const b = validateRunConfig(reorder(cfg));
        expect(b).toEqual(a);
      }),
      { seed: 410_103, numRuns: 200 },
    );
  });

  it("any number of unknown keys under one parent gives exactly one issue, at the placeholder, whatever the names and the order", () => {
    fc.assert(
      fc.property(validArb, fc.uniqueArray(fc.string({ minLength: 0, maxLength: 12 }).filter((k) => !RUN_CONFIG_KNOWN_NAMES.includes(k) && k !== "mockFixtureSet"), { minLength: 1, maxLength: 4 }), (raw, names) => {
        const cfg = structuredClone(raw) as Any;
        for (const n of names) Object.defineProperty(cfg, n, { value: 1, enumerable: true, writable: true, configurable: true });
        expect(issuesOf(cfg)).toEqual([{ code: "unknown_key", path: "/<unknown>" }]);
        expect(issuesOf(reorder(cfg))).toEqual([{ code: "unknown_key", path: "/<unknown>" }]);
      }),
      { seed: 410_106, numRuns: 200 },
    );
  });

  it("the input is never modified, and a result is frozen, fresh, and shares no array or object with the input", () => {
    fc.assert(
      fc.property(validArb, (raw) => {
        const before = structuredClone(raw);
        const r = validateRunConfig(raw);
        expect(raw).toEqual(before);
        if (!r.ok) return;
        for (const o of [r.value, r.value.limits, r.value.testApi, r.value.mask, r.value.mask.paths, r.value.envNames]) expect(Object.isFrozen(o)).toBe(true);
        expect(r.value.mask.paths).not.toBe(raw.mask.paths);
        expect(r.value.envNames).not.toBe(raw.envNames);
        expect(r.value.limits).not.toBe(raw.limits);
        expect(validateRunConfig(raw)).toEqual(r);
      }),
      { seed: 410_104, numRuns: 200 },
    );
  });

  it("no issue contains a value of the input: a canary in strings, in unsafe key names and in wrongly typed values", () => {
    const CANARY = "CANARY_0b5d_SECRET";
    const spoil = fc.constantFrom("provider", "baseAddress", "path", "envName", "unknownKey", "limitValue", "fixture", "token");
    fc.assert(
      fc.property(validArb, fc.array(spoil, { minLength: 1, maxLength: 5 }), (raw, spoils) => {
        const cfg = structuredClone(raw) as Any;
        for (const s of spoils) {
          if (s === "provider") cfg.provider = `${CANARY}-x`;
          else if (s === "baseAddress") cfg.testApi.baseAddress = `${CANARY}-x`;
          else if (s === "path") cfg.mask.paths.push(`${CANARY}-x`);
          else if (s === "envName") cfg.envNames.push(`${CANARY}-x`);
          else if (s === "unknownKey") { cfg[`${CANARY}-x`] = CANARY; cfg[CANARY] = CANARY; cfg.limits[CANARY] = CANARY; }
          else if (s === "limitValue") cfg.limits.iterations = `${CANARY}-x`;
          else if (s === "fixture") cfg.mockFixtureSet = `${CANARY}-x`;
          else cfg.mask.token = `${CANARY}-x`;
        }
        const text = JSON.stringify(validateRunConfig(cfg));
        expect(text).not.toContain(CANARY);
        expect(text).not.toContain("SECRET");
      }),
      { seed: 410_105, numRuns: 200 },
    );
  });
});