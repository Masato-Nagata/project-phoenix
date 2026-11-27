// Task 4.6 W3-A: the Run_Manifest `aiSandbox` and `residualRisks` sections. Deterministic and offline.
// External values below are TEST-ONLY fixed values; none of them is a measurement.
// **Validates: Requirements 16.12, 12.8, 15.12**
import { describe, expect, it } from "vitest";
import { RESIDUAL_RISK_IDS } from "../src/isolation/types.js";
import { buildAiSandboxSection } from "../src/manifest/aiSandboxSection.js";
import { RESIDUAL_RISK_ID_LIST, buildResidualRisks } from "../src/manifest/residualRisksSection.js";

const CANARY = "canary-secret-value-91x";
const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
};
const codeOf = (r: { ok: boolean; error?: { code: string } }): string | undefined => (r.ok ? undefined : r.error?.code);

describe("aiSandbox", () => {
  const MOCK = { provider: "mock", sandbox: { applicable: false } };
  const KIRO = { provider: "kiro-cli", sandbox: { applicable: true, destinations: ["host-one.invalid", "host-two.invalid"] } };

  it("a mock Run is not_applicable with no destination", () => {
    expect(buildAiSandboxSection(MOCK)).toEqual({ ok: true, value: { safetyStatus: "not_applicable", permittedDestinations: [] } });
  });

  it("a kiro-cli Run is UNVERIFIED (no verification record exists), with the declared destinations in the given order", () => {
    expect(buildAiSandboxSection(KIRO)).toEqual({ ok: true, value: { safetyStatus: "UNVERIFIED", permittedDestinations: ["host-one.invalid", "host-two.invalid"] } });
  });

  it("never produces `verified`, whatever the input carries", () => {
    for (const extra of [{ verified: true }, { safetyStatus: "verified" }, { verification: { ok: true } }]) {
      const r = buildAiSandboxSection({ ...KIRO, sandbox: { ...KIRO.sandbox, ...extra } });
      expect(r.ok).toBe(false);
    }
    expect(buildAiSandboxSection({ ...KIRO, safetyStatus: "verified" }).ok).toBe(false);
  });

  it("refuses a provider and a sandbox that disagree", () => {
    expect(codeOf(buildAiSandboxSection({ provider: "mock", sandbox: { applicable: true, destinations: ["h.invalid"] } }))).toBe("applicable_mismatch");
    expect(codeOf(buildAiSandboxSection({ provider: "kiro-cli", sandbox: { applicable: false } }))).toBe("applicable_mismatch");
  });

  it("refuses a missing, empty, duplicated or malformed destination list for kiro-cli (a missing fact is not filled in)", () => {
    expect(codeOf(buildAiSandboxSection({ provider: "kiro-cli", sandbox: { applicable: true } }))).toBe("sandbox_shape");
    expect(codeOf(buildAiSandboxSection({ provider: "kiro-cli", sandbox: { applicable: true, destinations: "x" } }))).toBe("destinations_not_array");
    expect(codeOf(buildAiSandboxSection({ provider: "kiro-cli", sandbox: { applicable: true, destinations: [] } }))).toBe("destinations_empty");
    for (const bad of [1, null, "", "x".repeat(256), undefined]) {
      expect(buildAiSandboxSection({ provider: "kiro-cli", sandbox: { applicable: true, destinations: ["ok.invalid", bad] } })).toEqual({ ok: false, error: { code: "destination_invalid", index: 1 } });
    }
    expect(buildAiSandboxSection({ provider: "kiro-cli", sandbox: { applicable: true, destinations: ["a.invalid", "a.invalid"] } })).toEqual({ ok: false, error: { code: "destination_duplicate", index: 1 } });
    // eslint-disable-next-line no-sparse-arrays
    expect(codeOf(buildAiSandboxSection({ provider: "kiro-cli", sandbox: { applicable: true, destinations: ["a.invalid", , "b.invalid"] } }))).toBe("destination_invalid");
  });

  it("refuses malformed input: shape, provider, extra keys, accessors", () => {
    for (const v of [undefined, null, [], 1]) expect(codeOf(buildAiSandboxSection(v))).toBe("input_not_plain_object");
    expect(codeOf(buildAiSandboxSection({ provider: "mock" }))).toBe("input_keys");
    expect(codeOf(buildAiSandboxSection({ ...MOCK, extra: 1 }))).toBe("input_keys");
    for (const p of ["replay", "", "MOCK", 1]) expect(codeOf(buildAiSandboxSection({ ...MOCK, provider: p })), String(p)).toBe("provider_invalid");
    expect(codeOf(buildAiSandboxSection({ ...MOCK, sandbox: null }))).toBe("sandbox_not_plain_object");
    expect(codeOf(buildAiSandboxSection({ ...MOCK, sandbox: {} }))).toBe("sandbox_shape");
    expect(codeOf(buildAiSandboxSection({ ...MOCK, sandbox: { applicable: "no" } }))).toBe("sandbox_shape");
    expect(codeOf(buildAiSandboxSection({ ...MOCK, sandbox: { applicable: false, destinations: [] } }))).toBe("sandbox_shape");
    let ran = false;
    const g = { provider: "mock" };
    Object.defineProperty(g, "sandbox", { enumerable: true, get: () => ((ran = true), { applicable: false }) });
    expect(codeOf(buildAiSandboxSection(g))).toBe("input_not_plain_object");
    expect(ran).toBe(false);
  });

  it("does not change a deep-frozen input, returns fresh arrays, and never echoes a value in an error", () => {
    const input = deepFreeze({ provider: "kiro-cli", sandbox: { applicable: true, destinations: ["a.invalid"] } });
    const before = JSON.stringify(input);
    const r = buildAiSandboxSection(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.permittedDestinations).not.toBe(input.sandbox.destinations);
    r.value.permittedDestinations.push("x");
    expect(JSON.stringify(input)).toBe(before);
    const a = buildAiSandboxSection(MOCK);
    const b = buildAiSandboxSection(MOCK);
    expect(a.ok && b.ok && a.value.permittedDestinations !== b.value.permittedDestinations).toBe(true);
    expect(JSON.stringify(buildAiSandboxSection({ provider: "kiro-cli", sandbox: { applicable: true, destinations: [CANARY, CANARY] } }))).not.toContain(CANARY);
  });
});

describe("residualRisks", () => {
  const SIX = [
    "read_denial_positive_control_unverified",
    "mount_inspection_source_kind_unmeasured",
    "mount_inspection_run_binding_weak",
    "mount_inspection_pre_start_snapshot",
    "import_analysis_self_attestation",
    "env_values_not_inspected",
  ];

  // (task 4.7 step A3, human decision of 2026-11-27, R24.19) the seventh identifier is appended; the six above keep their text, order and status
  const SEVEN = [...SIX, "mutual_exclusion_single_session_scope"];
  it("is the six existing identifiers in their fixed order, then the seventh of R24.19, each unresolved", () => {
    expect(buildResidualRisks()).toEqual(SEVEN.map((id) => ({ id, status: "unresolved" })));
    expect(buildResidualRisks().every((r) => r.status === "unresolved")).toBe(true);
    expect(new Set(buildResidualRisks().map((r) => r.id)).size).toBe(7);
  });

  it("equals RESIDUAL_RISK_IDS of the isolation module (a new identifier there must be decided here too)", () => {
    expect([...RESIDUAL_RISK_ID_LIST]).toEqual([...RESIDUAL_RISK_IDS]);
  });

  it("returns fresh entries on every call, so a change of one result does not reach the next", () => {
    const a = buildResidualRisks();
    a[0]!.id = "changed" as never;
    a.pop();
    expect(buildResidualRisks()).toEqual(SEVEN.map((id) => ({ id, status: "unresolved" })));
    expect(buildResidualRisks()[0]).not.toBe(buildResidualRisks()[0]);
    expect(() => (RESIDUAL_RISK_ID_LIST as string[]).push("x")).toThrow();
  });
});