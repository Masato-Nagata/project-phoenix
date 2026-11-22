// Task 4.6 W3-A: the Run_Manifest `provider`, `excludedFields` and `config` sections. Deterministic and offline.
// External values below are TEST-ONLY fixed values; none of them is a measurement.
// **Validates: Requirements 22.3, 3.7**
import { describe, expect, it } from "vitest";
import { RUN_CONFIG_PROVIDERS } from "../src/config/limits.js";
import { buildConfigSection, buildExcludedFields } from "../src/manifest/configSection.js";
import { buildProviderSection } from "../src/manifest/providerSection.js";
import { SCHEMAS } from "../src/schema/index.js";

const CANARY = "canary-secret-value-91x";
const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
};
const codeOf = (r: { ok: boolean; error?: { code: string } }): string | undefined => (r.ok ? undefined : r.error?.code);

describe("provider section", () => {
  const MOCK = { configuredProvider: "mock", identity: { id: "mock", version: "1", model: "not_applicable" } };
  const KIRO = { configuredProvider: "kiro-cli", identity: { id: "kiro-cli", version: "9.9.9-test", model: "test-model" } };

  it("builds the mock section with isMock true and the kiro-cli section with isMock false", () => {
    expect(buildProviderSection(MOCK)).toEqual({ ok: true, value: { id: "mock", version: "1", model: "not_applicable", isMock: true } });
    expect(buildProviderSection(KIRO)).toEqual({ ok: true, value: { id: "kiro-cli", version: "9.9.9-test", model: "test-model", isMock: false } });
  });

  it("refuses an identity field that is `unknown` in any letter case, in each of the three fields (with a passing control)", () => {
    for (const word of ["unknown", "Unknown", "UNKNOWN"]) {
      for (const field of ["id", "version", "model"] as const) {
        const input = { configuredProvider: "kiro-cli", identity: { ...KIRO.identity, [field]: word } };
        expect(codeOf(buildProviderSection(input)), `${field}=${word}`).toBe("identity_unknown");
      }
    }
    expect(buildProviderSection(KIRO).ok).toBe(true);
  });

  it("refuses a missing, empty, blank, padded, over-long or non-string field", () => {
    const bad: unknown[] = ["", " ", " x", "x ", "x".repeat(257), 1, null, undefined];
    for (const v of bad) {
      expect(codeOf(buildProviderSection({ configuredProvider: "kiro-cli", identity: { ...KIRO.identity, version: v } })), String(v)).toBe("identity_field_invalid");
    }
    expect(codeOf(buildProviderSection({ configuredProvider: "kiro-cli", identity: { id: "kiro-cli", version: "1" } }))).toBe("identity_keys");
    expect(codeOf(buildProviderSection({ configuredProvider: "kiro-cli", identity: { ...KIRO.identity, extra: "x" } }))).toBe("identity_keys");
  });

  it("refuses a configured provider outside the closed set (the set equals RUN_CONFIG_PROVIDERS)", () => {
    for (const bad of ["replay", "", "MOCK", 1, null]) expect(codeOf(buildProviderSection({ ...MOCK, configuredProvider: bad })), String(bad)).toBe("configured_provider_invalid");
    // the closed set of the section equals the run configuration set: each configured name is accepted with a matching identity
    expect(buildProviderSection(MOCK).ok).toBe(true);
    expect(buildProviderSection(KIRO).ok).toBe(true);
    expect([...RUN_CONFIG_PROVIDERS]).toEqual(["mock", "kiro-cli"]);
  });

  it("keeps the mock flag and the identity in agreement", () => {
    expect(codeOf(buildProviderSection({ configuredProvider: "mock", identity: { id: "other", version: "1", model: "not_applicable" } }))).toBe("mock_identity_mismatch");
    expect(codeOf(buildProviderSection({ configuredProvider: "mock", identity: { id: "mock", version: "1", model: "m" } }))).toBe("mock_identity_mismatch");
    expect(codeOf(buildProviderSection({ configuredProvider: "kiro-cli", identity: { id: "mock", version: "1", model: "m" } }))).toBe("mock_flag_mismatch");
  });

  it("refuses a non-object input, extra keys, accessors, symbol keys and a foreign prototype, and never runs a getter", () => {
    for (const v of [undefined, null, [], "x", 1]) expect(codeOf(buildProviderSection(v))).toBe("input_not_plain_object");
    expect(codeOf(buildProviderSection({ ...MOCK, extra: 1 }))).toBe("input_keys");
    expect(codeOf(buildProviderSection({ configuredProvider: "mock" }))).toBe("input_keys");
    let ran = false;
    const g = { configuredProvider: "mock" };
    Object.defineProperty(g, "identity", { enumerable: true, get: () => ((ran = true), MOCK.identity) });
    expect(codeOf(buildProviderSection(g))).toBe("input_not_plain_object");
    expect(ran).toBe(false);
    expect(codeOf(buildProviderSection({ ...MOCK, [Symbol("s")]: 1 }))).toBe("input_not_plain_object");
    class K {
      configuredProvider = "mock";
      identity = MOCK.identity;
    }
    expect(codeOf(buildProviderSection(new K()))).toBe("input_not_plain_object");
  });

  it("does not change a deep-frozen input, returns fresh objects, and never echoes a value in an error", () => {
    const input = deepFreeze({ configuredProvider: "kiro-cli", identity: { id: "kiro-cli", version: "1.0.0", model: "m" } });
    const before = JSON.stringify(input);
    const r = buildProviderSection(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(r.ok && Object.isFrozen(r.value)).toBe(false);
    const e = buildProviderSection({ configuredProvider: "kiro-cli", identity: { id: CANARY, version: "unknown", model: "m" } });
    expect(e.ok).toBe(false);
    expect(JSON.stringify(e)).not.toContain(CANARY);
  });
});

describe("excludedFields section", () => {
  it("equals the schema constant, in order, and is a fresh array on every call", () => {
    const schemaConst = (SCHEMAS["run-manifest"] as { properties: { excludedFields: { const: unknown } } }).properties.excludedFields.const;
    expect(buildExcludedFields()).toEqual(schemaConst);
    expect(buildExcludedFields()).toEqual(["runId", "wallClock"]);
    const a = buildExcludedFields();
    a.push("x" as never);
    expect(buildExcludedFields()).toEqual(["runId", "wallClock"]);
    expect(buildExcludedFields()).not.toBe(buildExcludedFields());
  });
});

describe("config section", () => {
  const H1 = "1".repeat(64);
  const H2 = "2".repeat(64);
  const effective = (): Record<string, unknown> => ({
    schemaVersion: 1,
    provider: "mock",
    mockFixtureSet: "default-widget-v1",
    limits: { iterations: 3, experiments: 10 },
    testApi: { baseAddress: "http://test.invalid" },
    mask: { paths: ["/a"] },
    envNames: ["EXAMPLE_ONE"],
  });
  const good = (): Record<string, unknown> => ({ effectiveConfig: effective(), policyConfigSha256: H1, preparationTableSha256: H2, leasePropagationDelayMs: 40 });

  it("copies the effective configuration and adds the two hashes and the delay in the same flat object", () => {
    const r = buildConfigSection(good());
    expect(r).toEqual({ ok: true, value: { ...effective(), policyConfigSha256: H1, preparationTableSha256: H2, leasePropagationDelayMs: 40 } });
  });

  it("adds no above-the-bound flag and no audit-configuration kind", () => {
    const r = buildConfigSection(good());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).sort()).toEqual(
      [...Object.keys(effective()), "policyConfigSha256", "preparationTableSha256", "leasePropagationDelayMs"].sort(),
    );
    expect(buildConfigSection({ ...good(), auditConfigKind: "fixture" }).ok).toBe(false);
  });

  it("refuses a missing or extra input key", () => {
    const { leasePropagationDelayMs: _d, ...missing } = good();
    void _d;
    expect(codeOf(buildConfigSection(missing))).toBe("input_keys");
    expect(codeOf(buildConfigSection({ ...good(), x: 1 }))).toBe("input_keys");
    for (const v of [undefined, null, [], "x"]) expect(codeOf(buildConfigSection(v))).toBe("input_not_plain_object");
  });

  it("refuses a configuration that is not plain JSON, is not an object, or is not what stage A issues", () => {
    expect(codeOf(buildConfigSection({ ...good(), effectiveConfig: { ...effective(), limits: { a: undefined } } }))).toBe("config_not_json");
    expect(codeOf(buildConfigSection({ ...good(), effectiveConfig: { ...effective(), limits: { a: NaN } } }))).toBe("config_not_json");
    expect(codeOf(buildConfigSection({ ...good(), effectiveConfig: [] }))).toBe("config_not_object");
    expect(codeOf(buildConfigSection({ ...good(), effectiveConfig: null }))).toBe("config_not_object");
    expect(codeOf(buildConfigSection({ ...good(), effectiveConfig: { ...effective(), schemaVersion: 2 } }))).toBe("config_schema_version");
    expect(codeOf(buildConfigSection({ ...good(), effectiveConfig: { ...effective(), provider: "replay" } }))).toBe("config_provider");
    expect(codeOf(buildConfigSection({ ...good(), effectiveConfig: { ...effective(), provider: 1 } }))).toBe("config_provider");
    let ran = false;
    const g = effective();
    Object.defineProperty(g, "limits", { enumerable: true, get: () => ((ran = true), {}) });
    expect(codeOf(buildConfigSection({ ...good(), effectiveConfig: g }))).toBe("config_not_json");
    expect(ran).toBe(false);
  });

  it("refuses a configuration that already holds one of the keys that this section adds", () => {
    for (const key of ["policyConfigSha256", "preparationTableSha256", "leasePropagationDelayMs"]) {
      expect(codeOf(buildConfigSection({ ...good(), effectiveConfig: { ...effective(), [key]: H1 } })), key).toBe("config_reserved_key");
    }
  });

  it("refuses a hash that is malformed, upper case, short, not a string, or all zeros", () => {
    for (const bad of ["", "A".repeat(64), "1".repeat(63), "1".repeat(65), 1, null, "0".repeat(64)]) {
      expect(codeOf(buildConfigSection({ ...good(), policyConfigSha256: bad })), String(bad)).toBe("policy_hash_invalid");
      expect(codeOf(buildConfigSection({ ...good(), preparationTableSha256: bad })), String(bad)).toBe("table_hash_invalid");
    }
  });

  it("refuses a delay that is negative, fractional, unsafe, or not a number, and accepts zero", () => {
    for (const bad of [-1, 1.5, 2 ** 60, "40", null, NaN]) expect(codeOf(buildConfigSection({ ...good(), leasePropagationDelayMs: bad })), String(bad)).toBe("delay_invalid");
    expect(buildConfigSection({ ...good(), leasePropagationDelayMs: 0 }).ok).toBe(true);
  });

  it("does not change a deep-frozen input and returns a copy that does not alias it", () => {
    const input = deepFreeze(good());
    const before = JSON.stringify(input);
    const r = buildConfigSection(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const out = r.value as Record<string, { [k: string]: unknown }>;
    (out["limits"] as { [k: string]: unknown })["iterations"] = 99;
    expect(JSON.stringify(input)).toBe(before);
  });

  it("an error never carries a value of the input", () => {
    const r = buildConfigSection({ ...good(), effectiveConfig: { ...effective(), provider: CANARY } });
    expect(r).toEqual({ ok: false, error: { code: "config_provider" } });
    expect(JSON.stringify(buildConfigSection({ ...good(), policyConfigSha256: CANARY }))).not.toContain(CANARY);
  });
});