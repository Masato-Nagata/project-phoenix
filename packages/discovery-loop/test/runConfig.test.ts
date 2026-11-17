// Task 4.1, stage A: `validateRunConfig` (R11.7, R11.8, R11.10, R8.11, R17.2, R9.14). Synthetic data only: neutral names and fictitious values.
// Assertions compare codes and JSON pointers, never input text. Stage B (start-up refusals with ports) is not tested here.
import { describe, expect, it } from "vitest";
import { RUN_CONFIG_KNOWN_NAMES, RUN_LIMITS, RUN_LIMIT_KEYS, validateRunConfig, type ConfigIssue, type RunLimitKey } from "../src/index.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const base = (): Any => ({
  schemaVersion: 1,
  provider: "mock",
  limits: {},
  testApi: { baseAddress: "http://reverse-proxy:8080" },
  mask: { paths: [] },
  envNames: [],
});
const withLimits = (limits: Record<string, unknown>, extra: Record<string, unknown> = {}): Any => ({ ...base(), ...extra, limits });
const issuesOf = (raw: unknown): ConfigIssue[] => {
  const r = validateRunConfig(raw);
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};
const expectOnly = (raw: unknown, code: string, path: string): void => expect(issuesOf(raw)).toEqual([{ code, path }]);
const accepted = (raw: unknown) => {
  const r = validateRunConfig(raw);
  if (!r.ok) throw new Error(`expected acceptance, got ${JSON.stringify(r.error)}`);
  return r.value;
};
const defaults = (): Record<string, number> => Object.fromEntries(RUN_LIMIT_KEYS.map((k) => [k, RUN_LIMITS[k].default]));
/** A companion setting that keeps the cross-field rules true when a boundary value of one limit is tested on its own. */
const companion = (k: RunLimitKey, v: number): Record<string, number> =>
  k === "runSeconds" && v < 120 ? { providerCallSeconds: 1 } : k === "perExperimentSeconds" && v < 10 ? { perRequestSeconds: 1 } : {};

describe("stage A: the document", () => {
  it("accepts the minimal configuration with limits: {} and resolves all 14 defaults", () => {
    const c = accepted(base());
    expect(c.limits).toEqual(defaults());
    expect(RUN_LIMIT_KEYS).toHaveLength(14);
    expect(c.schemaVersion).toBe(1);
    expect(c.provider).toBe("mock");
    expect(c.mockFixtureSet).toBe("default-widget-v1");
  });

  for (const key of ["schemaVersion", "provider", "limits", "testApi", "mask", "envNames"]) {
    it(`refuses a configuration without the required key ${key}`, () => {
      const raw = base();
      delete raw[key];
      expectOnly(raw, "required_missing", `/${key}`);
    });
  }
  it("refuses a missing testApi.baseAddress and a missing mask.paths, by the pointer of the missing key", () => {
    expectOnly({ ...base(), testApi: {} }, "required_missing", "/testApi/baseAddress");
    expectOnly({ ...base(), mask: {} }, "required_missing", "/mask/paths");
  });
  it("reports every missing required key, sorted by pointer", () => {
    expect(issuesOf({})).toEqual(
      ["/envNames", "/limits", "/mask", "/provider", "/schemaVersion", "/testApi"].map((path) => ({ code: "required_missing", path })),
    );
  });

  it("refuses an input that is not a plain data object", () => {
    expectOnly(null, "null_value", "");
    for (const bad of [undefined, 1, "x", true, [], [base()], new Map(), new Date(0), () => base()]) expectOnly(bad, "wrong_type", "");
    class Holder { schemaVersion = 1; }
    expectOnly(new Holder(), "wrong_type", "");
  });

  it("refuses null for every required key and never reads null as absent", () => {
    for (const key of ["schemaVersion", "provider", "limits", "testApi", "mask", "envNames"]) {
      expectOnly({ ...base(), [key]: null }, "null_value", `/${key}`);
    }
    expectOnly({ ...base(), testApi: { baseAddress: null } }, "null_value", "/testApi/baseAddress");
    expectOnly({ ...base(), mask: { paths: null } }, "null_value", "/mask/paths");
  });

  it("refuses an unknown key at every level and points at the parent with the fixed placeholder (never the key name)", () => {
    expectOnly({ ...base(), extra: 1 }, "unknown_key", "/<unknown>");
    expectOnly(withLimits({ extra: 1 }), "unknown_key", "/limits/<unknown>");
    expectOnly({ ...base(), testApi: { baseAddress: "http://reverse-proxy:8080", extra: 1 } }, "unknown_key", "/testApi/<unknown>");
    expectOnly({ ...base(), mask: { paths: [], extra: 1 } }, "unknown_key", "/mask/<unknown>");
  });

  it("refuses mask.token with any value as an unknown key (C2-1: the token is a constant, not a setting)", () => {
    for (const token of ["<masked>", "x", "", null, 1, true, {}, []]) expectOnly({ ...base(), mask: { paths: [], token } }, "unknown_key", "/mask/token");
    expect(issuesOf({ ...base(), mask: { token: "<masked>" } })).toEqual([{ code: "required_missing", path: "/mask/paths" }, { code: "unknown_key", path: "/mask/token" }]);
  });

  it("schemaVersion must be 1", () => {
    for (const v of [0, 2, "1", true]) expectOnly({ ...base(), schemaVersion: v }, "enum_mismatch", "/schemaVersion");
  });
  it("provider is a closed set and a non-string is a type error", () => {
    expectOnly({ ...base(), provider: "replay" }, "enum_mismatch", "/provider");
    expectOnly({ ...base(), provider: 1 }, "wrong_type", "/provider");
    expect(accepted({ ...base(), provider: "kiro-cli" }).provider).toBe("kiro-cli");
  });
  it("testApi.baseAddress is the closed set of two addresses; an equivalent spelling is refused", () => {
    for (const a of ["http://127.0.0.1:8056", "http://reverse-proxy:8080"]) expect(accepted({ ...base(), testApi: { baseAddress: a } }).testApi.baseAddress).toBe(a);
    for (const a of ["http://127.0.0.1:8056/", "http://localhost:8056", "http://0x7f.0.0.1:8056", "https://reverse-proxy:8080", ""]) {
      expectOnly({ ...base(), testApi: { baseAddress: a } }, "enum_mismatch", "/testApi/baseAddress");
    }
  });
});

describe("stage A: limits", () => {
  it("limits: {} is accepted; limits absent, null or an array is refused", () => {
    expect(accepted(withLimits({})).limits).toEqual(defaults());
    const noLimits = base();
    delete noLimits.limits;
    expectOnly(noLimits, "required_missing", "/limits");
    expectOnly({ ...base(), limits: null }, "null_value", "/limits");
    expectOnly({ ...base(), limits: [] }, "wrong_type", "/limits");
  });

  for (const k of RUN_LIMIT_KEYS) {
    const spec = RUN_LIMITS[k];
    describe(k, () => {
      it("takes its default only when the key is absent", () => {
        expect(accepted(withLimits({})).limits[k]).toBe(spec.default);
      });
      it("refuses null (null is not absent) and wrong types", () => {
        expectOnly(withLimits({ [k]: null }), "null_value", `/limits/${k}`);
        for (const v of ["3", true, [], {}]) expectOnly(withLimits({ [k]: v }), "wrong_type", `/limits/${k}`);
      });
      it("refuses a non-integer number", () => {
        for (const v of [spec.min + 0.5, Number.NaN, Number.POSITIVE_INFINITY]) expectOnly(withLimits({ [k]: v }), "not_integer", `/limits/${k}`);
      });
      it(`accepts ${spec.min} and ${spec.max}, refuses ${spec.min - 1} and ${spec.max + 1}`, () => {
        for (const v of [spec.min, spec.max]) expect(accepted(withLimits({ [k]: v, ...companion(k, v) })).limits[k]).toBe(v);
        expectOnly(withLimits({ [k]: spec.min - 1 }), "out_of_range", `/limits/${k}`);
        expectOnly(withLimits({ [k]: spec.max + 1 }), spec.bound === "fixed" ? "above_fixed_bound" : "out_of_range", `/limits/${k}`);
      });
    });
  }

  it("the existing and the new ranges are the decided ones", () => {
    const range = (k: RunLimitKey): string => `${RUN_LIMITS[k].min}..${RUN_LIMITS[k].max}`;
    expect(Object.fromEntries(RUN_LIMIT_KEYS.map((k) => [k, range(k)]))).toEqual({
      iterations: "1..10", experiments: "1..100", rejectedExperiments: "1..100", runSeconds: "1..3600", providerCallSeconds: "1..600",
      providerRetries: "0..10", responseBytes: "1..1048576", claimsPerHypothesis: "1..50", citationsPerClaim: "1..5",
      experimentsPerResponse: "1..100", requestsPerExperiment: "1..10", requestBodyBytes: "1..8192", perRequestSeconds: "1..60", perExperimentSeconds: "1..600",
    });
  });

  it("a value above a fixed schema bound is above_fixed_bound and is never truncated or ignored", () => {
    for (const [k, v] of [["claimsPerHypothesis", 51], ["citationsPerClaim", 6], ["requestsPerExperiment", 11], ["requestBodyBytes", 8193]] as const) {
      expectOnly(withLimits({ [k]: v }), "above_fixed_bound", `/limits/${k}`);
    }
    for (const [k, v] of [["responseBytes", 1048577], ["experimentsPerResponse", 101], ["runSeconds", 3601], ["providerRetries", 11]] as const) {
      expectOnly(withLimits({ [k]: v }), "out_of_range", `/limits/${k}`);
    }
  });

  it("providerCallSeconds <= runSeconds is judged on the effective values", () => {
    expectOnly(withLimits({ runSeconds: 60 }), "cross_field", "/limits/runSeconds"); // the default per-call limit (120) is above 60
    expectOnly(withLimits({ runSeconds: 119 }), "cross_field", "/limits/runSeconds");
    expect(accepted(withLimits({ runSeconds: 120 })).limits.providerCallSeconds).toBe(120);
    expect(accepted(withLimits({ runSeconds: 60, providerCallSeconds: 60 })).limits.runSeconds).toBe(60);
    expectOnly(withLimits({ runSeconds: 60, providerCallSeconds: 61 }), "cross_field", "/limits/providerCallSeconds");
    expect(accepted(withLimits({ providerCallSeconds: 600 })).limits.providerCallSeconds).toBe(600);
    expectOnly(withLimits({ runSeconds: 100, providerCallSeconds: 101 }), "cross_field", "/limits/providerCallSeconds");
  });
  it("perExperimentSeconds >= perRequestSeconds, on the effective values, in both directions", () => {
    expectOnly(withLimits({ perExperimentSeconds: 5 }), "cross_field", "/limits/perExperimentSeconds"); // the default request limit (10) is above 5
    expect(accepted(withLimits({ perExperimentSeconds: 10 })).limits.perRequestSeconds).toBe(10);
    expectOnly(withLimits({ perRequestSeconds: 60, perExperimentSeconds: 59 }), "cross_field", "/limits/perExperimentSeconds");
    expect(accepted(withLimits({ perRequestSeconds: 60, perExperimentSeconds: 60 })).limits.perRequestSeconds).toBe(60);
    expect(accepted(withLimits({ perRequestSeconds: 60 })).limits.perExperimentSeconds).toBe(60);
  });
  it("the cross-field rules are not evaluated when a value is invalid (only the schema issue is reported)", () => {
    expect(issuesOf(withLimits({ runSeconds: 3601, providerCallSeconds: 600 }))).toEqual([{ code: "out_of_range", path: "/limits/runSeconds" }]);
  });
});

describe("stage A: mockFixtureSet and provider", () => {
  it("absent with mock resolves to the default set; present is kept", () => {
    expect(accepted(base()).mockFixtureSet).toBe("default-widget-v1");
    expect(accepted({ ...base(), mockFixtureSet: "default-widget-v1" }).mockFixtureSet).toBe("default-widget-v1");
  });
  it("null, an unknown name, and a non-string are refused with no fallback", () => {
    expectOnly({ ...base(), mockFixtureSet: null }, "null_value", "/mockFixtureSet");
    expectOnly({ ...base(), mockFixtureSet: "other-set" }, "enum_mismatch", "/mockFixtureSet");
    expectOnly({ ...base(), mockFixtureSet: "" }, "enum_mismatch", "/mockFixtureSet");
    expectOnly({ ...base(), mockFixtureSet: 1 }, "wrong_type", "/mockFixtureSet");
  });
  it("is refused for a provider other than mock (R11.8 (e)), even with a valid name", () => {
    expectOnly({ ...base(), provider: "kiro-cli", mockFixtureSet: "default-widget-v1" }, "cross_field", "/mockFixtureSet");
  });
  it("is absent in the result for a provider other than mock", () => {
    const c = accepted({ ...base(), provider: "kiro-cli" });
    expect(Object.hasOwn(c, "mockFixtureSet")).toBe(false);
  });
});

describe("stage A: mask.paths and envNames keep their meaning and only their grammar is limited", () => {
  it("accepts every valid mask entry form, duplicates, and the empty list", () => {
    const paths = ["a", "a.b", "a[0]", "a[*]", "[0]", "[*]", "[9999]", "a.b[3].c_d", "_x", "a", "a"];
    expect(accepted({ ...base(), mask: { paths } }).mask.paths).toEqual(paths);
    expect(accepted(base()).mask.paths).toEqual([]);
  });
  it("refuses an entry outside the grammar of parseMaskPattern", () => {
    for (const p of ["", ".a", "a.", "a..b", "a[", "a[]", "a[01]", "a[10000]", "a[-1]", "1a", "a b", "a-b", "a.[0]", "é", "a[*"]) {
      expectOnly({ ...base(), mask: { paths: ["ok", p] } }, "pattern_mismatch", "/mask/paths/1");
    }
  });
  it("limits a path to 128 characters and the list to 64 entries", () => {
    const longest = "a".repeat(128);
    expect(accepted({ ...base(), mask: { paths: [longest] } }).mask.paths).toEqual([longest]);
    expectOnly({ ...base(), mask: { paths: ["a".repeat(129)] } }, "pattern_mismatch", "/mask/paths/0");
    expect(accepted({ ...base(), mask: { paths: Array.from({ length: 64 }, () => "a") } }).mask.paths).toHaveLength(64);
    expectOnly({ ...base(), mask: { paths: Array.from({ length: 65 }, () => "a") } }, "out_of_range", "/mask/paths");
  });
  it("refuses a non-string entry by type", () => {
    expectOnly({ ...base(), mask: { paths: [1] } }, "wrong_type", "/mask/paths/0");
    expectOnly({ ...base(), mask: { paths: [null] } }, "null_value", "/mask/paths/0");
  });
  it("accepts environment variable names of 1 to 128 characters of [A-Za-z0-9_] not starting with a digit", () => {
    const names = ["A", "_", "KIRO_API_KEY", "lower_case9", "A".repeat(128)];
    expect(accepted({ ...base(), envNames: names }).envNames).toEqual(names);
  });
  it("refuses the other names, and adds no limit on how many names there are", () => {
    for (const n of ["", "1A", "A-B", "A B", "A.B", "A=B", "é", "A".repeat(129)]) expectOnly({ ...base(), envNames: [n] }, "pattern_mismatch", "/envNames/0");
    expect(accepted({ ...base(), envNames: Array.from({ length: 300 }, (_, i) => `NAME_${i}`) }).envNames).toHaveLength(300);
  });
});

describe("stage A: safe, deterministic, pure results", () => {
  const CANARY = "CANARY_7c1e_SECRET";

  it("sorts issues by pointer and then by code, whatever the key order of the input", () => {
    const messy = { envNames: ["A-B"], z: 1, mask: { token: "x", paths: [1] }, limits: { runSeconds: 0, iterations: null }, provider: "other", testApi: {}, a: 2 };
    const reversed: Any = {};
    for (const k of Object.keys(messy).reverse()) reversed[k] = (messy as Any)[k];
    const one = issuesOf(messy);
    expect(issuesOf(reversed)).toEqual(one);
    const keys = one.map((i) => `${i.path} ${i.code}`);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(keys).size).toBe(keys.length);
    expect(one.length).toBeGreaterThanOrEqual(8);
  });

  it("never puts a value or an unknown key name of the input into an issue: a canary in every string position and as a key name", () => {
    const hostile: Any = {
      schemaVersion: CANARY,
      provider: CANARY,
      mockFixtureSet: CANARY,
      limits: { iterations: CANARY, runSeconds: [CANARY], [CANARY]: CANARY, "x/y": CANARY },
      testApi: { baseAddress: CANARY, [`${CANARY}-key`]: CANARY, [CANARY]: CANARY },
      mask: { token: CANARY, paths: [CANARY, `a.${CANARY}!`], [CANARY]: 1 },
      envNames: [CANARY, `${CANARY}-name`],
      [CANARY]: { nested: CANARY },
      [`${CANARY}.`]: { nested: CANARY },
    };
    const text = JSON.stringify(issuesOf(hostile));
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("SECRET");
    expect(text).toContain("<unknown>");
    expect(text).not.toContain("<key>");
  });

  it("writes every key name that the schema does not define as the fixed placeholder, whatever its characters and length", () => {
    for (const k of ["abc_123", "k".repeat(33), "a/b", "a~b", "sk-live-1234", "CANARY_7c1e_SECRET", "", "__proto__", "constructor", "Limits", "runSeconds2"]) {
      const raw = JSON.parse(`{"schemaVersion":1,"provider":"mock","limits":{},"testApi":{"baseAddress":"http://reverse-proxy:8080"},"mask":{"paths":[]},"envNames":[],${JSON.stringify(k)}:1}`);
      expectOnly(raw, "unknown_key", "/<unknown>");
      expect(Object.hasOwn(raw, k)).toBe(true);
    }
  });
  it("echoes only the names that this package defines (a key at the wrong level, or the removed token), never text of the input", () => {
    expectOnly({ ...base(), runSeconds: 1 }, "unknown_key", "/runSeconds");
    expectOnly({ ...base(), limits: { paths: 1 } }, "unknown_key", "/limits/paths");
    expectOnly({ ...base(), mask: { paths: [], token: "x" } }, "unknown_key", "/mask/token");
    expectOnly({ ...base(), testApi: { baseAddress: "http://reverse-proxy:8080", provider: 1 } }, "unknown_key", "/testApi/provider");
    expect(RUN_CONFIG_KNOWN_NAMES).toContain("token");
    for (const n of RUN_CONFIG_KNOWN_NAMES) expect(n, n).toMatch(/^[A-Za-z]+$/);
  });
  it("several unknown keys under one parent give one issue, so the number of unknown keys is not reported and the order never matters", () => {
    expectOnly({ ...base(), a: 1, b: 2, "c-d": 3 }, "unknown_key", "/<unknown>");
    expect(issuesOf({ ...base(), a: 1, b: 2, mask: { paths: [], x: 1, y: 2, token: 3 }, limits: { zz: 1 } })).toEqual([
      { code: "unknown_key", path: "/<unknown>" },
      { code: "unknown_key", path: "/limits/<unknown>" },
      { code: "unknown_key", path: "/mask/<unknown>" },
      { code: "unknown_key", path: "/mask/token" },
    ]);
    const forward = { ...base(), a: 1, b: 2, c: 3 };
    const backward = { c: 3, b: 2, a: 1, ...base() };
    expect(issuesOf(backward)).toEqual(issuesOf(forward));
  });
  it("every pointer is a valid JSON Pointer: tokens start after a slash and contain no raw `/`, and `~` only as `~0` or `~1`", () => {
    const hostile = { ...base(), "a/b": 1, "x~y": 2, "~1": 3, "": 4, limits: { "p/q": 1, runSeconds: "x" }, envNames: ["A-B", 1] };
    for (const i of issuesOf(hostile)) {
      expect(i.path === "" || i.path.startsWith("/"), i.path).toBe(true);
      for (const token of i.path.split("/").slice(1)) expect(token, i.path).toMatch(/^(?:[^~/]|~[01])*$/);
    }
  });
  it("a secret-looking key name is not echoed even when it uses only letters, digits and underscores and is short", () => {
    const secret = "sk_live_4f9a8b7c6d5e";
    const text = JSON.stringify(issuesOf({ ...base(), [secret]: 1, limits: { [secret]: 1 }, mask: { paths: [], [secret]: 1 } }));
    expect(text).not.toContain(secret);
    expect(text).not.toContain("sk_live");
  });
  it("does not modify the input, returns a new frozen object that shares nothing with it, and is deterministic", () => {
    const input = { ...base(), mockFixtureSet: "default-widget-v1", mask: { paths: ["a", "b[*]"] }, envNames: ["X_Y"], limits: { runSeconds: 600, providerCallSeconds: 60 } };
    const before = structuredClone(input);
    const first = accepted(input);
    expect(input).toEqual(before);
    const second = accepted(input);
    expect(second).toEqual(first);
    expect(first).not.toBe(second);
    for (const o of [first, first.limits, first.testApi, first.mask, first.mask.paths, first.envNames]) expect(Object.isFrozen(o)).toBe(true);
    expect(first.mask).not.toBe(input.mask);
    expect(first.mask.paths).not.toBe(input.mask.paths);
    expect(first.envNames).not.toBe(input.envNames);
    expect(first.testApi).not.toBe(input.testApi);
    input.mask.paths.push("late");
    input.envNames.push("LATE");
    input.limits.runSeconds = 1;
    expect(first.mask.paths).toEqual(["a", "b[*]"]);
    expect(first.envNames).toEqual(["X_Y"]);
    expect(first.limits.runSeconds).toBe(600);
  });

  it("does not modify the input on a refusal either, and the issues are frozen", () => {
    const input = { ...base(), limits: { runSeconds: 0 }, extra: { a: [1, 2] } };
    const before = structuredClone(input);
    const issues = issuesOf(input);
    expect(input).toEqual(before);
    expect(Object.isFrozen(issues[0])).toBe(true);
  });

  it("values JSON cannot carry are refused at their pointer: undefined, functions, symbols, bigints, accessors, non-plain objects, holes", () => {
    expectOnly(withLimits({ iterations: undefined }), "wrong_type", "/limits/iterations");
    expectOnly(withLimits({ iterations: () => 1 }), "wrong_type", "/limits/iterations");
    expectOnly(withLimits({ iterations: Symbol("x") }), "wrong_type", "/limits/iterations");
    expectOnly(withLimits({ iterations: 1n }), "wrong_type", "/limits/iterations");
    expectOnly({ ...base(), envNames: [new Date(0)] }, "wrong_type", "/envNames/0");
    // eslint-disable-next-line no-sparse-arrays
    expectOnly({ ...base(), envNames: ["A", , "B"] }, "wrong_type", "/envNames/1");
  });
  it("never runs a getter of the input", () => {
    let calls = 0;
    const raw = base();
    Object.defineProperty(raw.limits, "iterations", { enumerable: true, get() { calls += 1; return 3; } });
    expectOnly(raw, "wrong_type", "/limits/iterations");
    expect(calls).toBe(0);
  });
  it("never throws and leaks no message for a hostile input", () => {
    const proxy = new Proxy({}, { ownKeys() { throw new Error(CANARY); }, getPrototypeOf() { throw new Error(CANARY); } });
    const r = validateRunConfig(proxy);
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CANARY);
    const cyc: Any = base();
    cyc.limits.self = cyc;
    expect(validateRunConfig(cyc).ok).toBe(false);
  });
  it("is deterministic for the same input", () => {
    const bad = { ...base(), limits: { runSeconds: 0, providerCallSeconds: 1000 }, x: 1 };
    expect(issuesOf(bad)).toEqual(issuesOf(bad));
  });
});