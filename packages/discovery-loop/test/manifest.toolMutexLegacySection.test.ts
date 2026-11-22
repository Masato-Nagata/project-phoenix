// Task 4.6 W3-A: the Run_Manifest `toolVersions`, `mutualExclusion` and `legacyStartState` sections. Deterministic and offline.
// Every external value below (versions, image id, nonce hash, process id, approver, timestamp, identity) is a TEST-ONLY fixed value.
// None of them is a measurement, and no builder obtains any of them: the builders only check form and agreement.
// **Validates: Requirements 22.3, 24.2, 24.16, 12.8**
import { describe, expect, it } from "vitest";
import { buildLegacyStartStateSection } from "../src/manifest/legacyStartStateSection.js";
import { buildMutualExclusionSection } from "../src/manifest/mutualExclusionSection.js";
import { buildToolVersionsSection } from "../src/manifest/toolVersionsSection.js";

const CANARY = "canary-secret-value-91x";
const H = (c: string): string => c.repeat(64);
const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
};
const codeOf = (r: { ok: boolean; error?: { code: string } }): string | undefined => (r.ok ? undefined : r.error?.code);

describe("toolVersions", () => {
  const good = (): Record<string, unknown> => ({
    node: "1.2.3",
    npm: "4.5.6",
    dependencies: { "zeta-lib": "1.0.0", "@scope/alpha": "2.0.0-rc.1", "beta-lib": "3.1.4" },
    runtimeImageDigest: `sha256:${H("a")}`,
  });

  it("accepts exact versions and the image id, and lists the dependencies sorted by name", () => {
    const r = buildToolVersionsSection(good());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value.dependencies)).toEqual(["@scope/alpha", "beta-lib", "zeta-lib"]);
    expect(r.value).toEqual({ ...good(), dependencies: { "@scope/alpha": "2.0.0-rc.1", "beta-lib": "3.1.4", "zeta-lib": "1.0.0" } });
  });

  it("refuses a missing or extra top-level key (nothing is filled in)", () => {
    for (const k of ["node", "npm", "dependencies", "runtimeImageDigest"]) {
      const x = good();
      delete x[k];
      expect(codeOf(buildToolVersionsSection(x)), k).toBe("input_keys");
    }
    expect(codeOf(buildToolVersionsSection({ ...good(), extra: 1 }))).toBe("input_keys");
    for (const v of [undefined, null, [], "x"]) expect(codeOf(buildToolVersionsSection(v))).toBe("input_not_plain_object");
  });

  it("refuses a node or npm value that is not major.minor.patch (a leading v, a range, a tag, a pre-release, a blank)", () => {
    for (const bad of ["v1.2.3", "1.2", "1.2.3.4", "^1.2.3", "latest", "1.2.3-rc.1", "01.2.3", "", " 1.2.3", 1, null]) {
      expect(codeOf(buildToolVersionsSection({ ...good(), node: bad })), `node ${String(bad)}`).toBe("node_invalid");
      expect(codeOf(buildToolVersionsSection({ ...good(), npm: bad })), `npm ${String(bad)}`).toBe("npm_invalid");
    }
  });

  it("refuses a dependency version that is a range, a tag or empty, and a name that is not a package name", () => {
    for (const bad of ["^1.0.0", "~1.0.0", "1.x", "*", "latest", ">=1.0.0", "", "1.0", "github:a/b", 1, null]) {
      expect(buildToolVersionsSection({ ...good(), dependencies: { "a-lib": "1.0.0", "b-lib": bad } }), String(bad)).toEqual({ ok: false, error: { code: "dependency_version_invalid", index: 1 } });
    }
    for (const bad of ["", "A-Upper", "has space", "../x", "_hidden", ".dot", "x".repeat(215), "__proto__"]) {
      expect(codeOf(buildToolVersionsSection({ ...good(), dependencies: { [bad]: "1.0.0" } })), bad).toBe("dependency_name_invalid");
    }
  });

  it("refuses an empty dependency list and a list that is not a plain object", () => {
    expect(codeOf(buildToolVersionsSection({ ...good(), dependencies: {} }))).toBe("dependencies_empty");
    for (const bad of [null, [], "x", [["a", "1.0.0"]]]) expect(codeOf(buildToolVersionsSection({ ...good(), dependencies: bad }))).toBe("dependencies_not_plain_object");
    let ran = false;
    const g = {};
    Object.defineProperty(g, "a-lib", { enumerable: true, get: () => ((ran = true), "1.0.0") });
    expect(codeOf(buildToolVersionsSection({ ...good(), dependencies: g }))).toBe("dependencies_not_plain_object");
    expect(ran).toBe(false);
  });

  it("refuses an image identifier without the sha256: prefix or with a wrong length, case or type", () => {
    for (const bad of [H("a"), `sha256:${H("a").slice(1)}`, `sha256:${H("A")}`, `SHA256:${H("a")}`, `sha256:${H("a")}\n`, "", 1, null]) {
      expect(codeOf(buildToolVersionsSection({ ...good(), runtimeImageDigest: bad })), String(bad)).toBe("image_digest_invalid");
    }
  });

  it("does not change a deep-frozen input, copies the dependencies, and never echoes a value in an error", () => {
    const input = deepFreeze(good());
    const before = JSON.stringify(input);
    const r = buildToolVersionsSection(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.dependencies).not.toBe(input["dependencies"]);
    (r.value.dependencies as Record<string, string>)["added"] = "1.0.0";
    expect(JSON.stringify(input)).toBe(before);
    const e = buildToolVersionsSection({ ...good(), dependencies: { "a-lib": CANARY } });
    expect(e.ok).toBe(false);
    expect(JSON.stringify(e)).not.toContain(CANARY);
    expect(JSON.stringify(buildToolVersionsSection({ ...good(), runtimeImageDigest: CANARY }))).not.toContain(CANARY);
  });
});

describe("mutualExclusion", () => {
  const lease = (): Record<string, unknown> => ({ nonceSha256: H("5"), launcherPid: 4242, heartbeatIntervalMs: 1000, staleAfterMs: 5000 });
  const MECH = (): Record<string, unknown> => ({ mode: "mechanical", lease: lease() });
  const ATT = (): Record<string, unknown> => ({ mode: "attestation", attestation: { approver: "Reviewer One", timestamp: "2026-01-01T00:00:00+09:00" } });

  it("builds the mechanical and the attestation form, each with only its own part", () => {
    expect(buildMutualExclusionSection(MECH())).toEqual({ ok: true, value: MECH() });
    expect(buildMutualExclusionSection(ATT())).toEqual({ ok: true, value: ATT() });
    const m = buildMutualExclusionSection(MECH());
    expect(m.ok && Object.keys(m.value).sort()).toEqual(["lease", "mode"]);
    const a = buildMutualExclusionSection(ATT());
    expect(a.ok && Object.keys(a.value).sort()).toEqual(["attestation", "mode"]);
  });

  it("refuses a mode without its part, a part of the other mode, and an unknown mode", () => {
    expect(codeOf(buildMutualExclusionSection({ mode: "mechanical" }))).toBe("input_keys");
    expect(codeOf(buildMutualExclusionSection({ mode: "attestation" }))).toBe("input_keys");
    expect(codeOf(buildMutualExclusionSection({ ...MECH(), attestation: ATT()["attestation"] }))).toBe("input_keys");
    expect(codeOf(buildMutualExclusionSection({ ...ATT(), lease: lease() }))).toBe("input_keys");
    expect(codeOf(buildMutualExclusionSection({ mode: "manual", lease: lease() }))).toBe("mode_invalid");
    expect(codeOf(buildMutualExclusionSection({ lease: lease() }))).toBe("mode_invalid");
    for (const v of [undefined, null, [], "x"]) expect(codeOf(buildMutualExclusionSection(v))).toBe("input_not_plain_object");
  });

  it("refuses a lease that is incomplete, has an extra key, or has an invalid field", () => {
    expect(codeOf(buildMutualExclusionSection({ mode: "mechanical", lease: null }))).toBe("lease_not_plain_object");
    const { launcherPid: _p, ...noPid } = lease();
    void _p;
    expect(codeOf(buildMutualExclusionSection({ mode: "mechanical", lease: noPid }))).toBe("lease_keys");
    expect(codeOf(buildMutualExclusionSection({ mode: "mechanical", lease: { ...lease(), propagationDelayMs: 40 } }))).toBe("lease_keys");
    for (const bad of [H("A"), H("5").slice(1), "", 1, null]) expect(codeOf(buildMutualExclusionSection({ mode: "mechanical", lease: { ...lease(), nonceSha256: bad } })), String(bad)).toBe("nonce_invalid");
    for (const bad of [0, -1, 1.5, "4242", null, 2 ** 60]) {
      expect(codeOf(buildMutualExclusionSection({ mode: "mechanical", lease: { ...lease(), launcherPid: bad } })), String(bad)).toBe("pid_invalid");
      expect(codeOf(buildMutualExclusionSection({ mode: "mechanical", lease: { ...lease(), heartbeatIntervalMs: bad } })), String(bad)).toBe("heartbeat_invalid");
      expect(codeOf(buildMutualExclusionSection({ mode: "mechanical", lease: { ...lease(), staleAfterMs: bad } })), String(bad)).toBe("stale_invalid");
    }
    expect(codeOf(buildMutualExclusionSection({ mode: "mechanical", lease: { ...lease(), staleAfterMs: 1000 } }))).toBe("stale_not_above_heartbeat");
    expect(codeOf(buildMutualExclusionSection({ mode: "mechanical", lease: { ...lease(), staleAfterMs: 999 } }))).toBe("stale_not_above_heartbeat");
    expect(buildMutualExclusionSection({ mode: "mechanical", lease: { ...lease(), staleAfterMs: 1001 } }).ok).toBe(true);
  });

  it("refuses an attestation that is incomplete, has an extra key, or has an invalid approver or timestamp", () => {
    expect(codeOf(buildMutualExclusionSection({ mode: "attestation", attestation: 1 }))).toBe("attestation_not_plain_object");
    expect(codeOf(buildMutualExclusionSection({ mode: "attestation", attestation: { approver: "A" } }))).toBe("attestation_keys");
    expect(codeOf(buildMutualExclusionSection({ mode: "attestation", attestation: { approver: "A", timestamp: "2026-01-01T00:00:00Z", note: "x" } }))).toBe("attestation_keys");
    for (const bad of ["", " ", " A", "A ", "A\nB", "x".repeat(257), 1, null]) {
      expect(codeOf(buildMutualExclusionSection({ mode: "attestation", attestation: { approver: bad, timestamp: "2026-01-01T00:00:00Z" } })), String(bad)).toBe("approver_invalid");
    }
    for (const bad of ["", "2026-01-01", "2026-01-01 00:00:00Z", "2026-13-01T00:00:00Z", "2026-01-32T00:00:00Z", "2026-01-01T24:00:00Z", "2026-01-01T00:60:00Z", "2026-01-01T00:00:60Z", "2026-01-01T00:00:00", "2026-01-01T00:00:00+24:00", "2026-01-01T00:00:00+09:60", 1, null]) {
      expect(codeOf(buildMutualExclusionSection({ mode: "attestation", attestation: { approver: "A", timestamp: bad } })), String(bad)).toBe("timestamp_invalid");
    }
    for (const ok of ["2026-01-01T00:00:00Z", "2026-01-01T23:59:59.123Z", "2026-12-31T00:00:00-05:30"]) {
      expect(buildMutualExclusionSection({ mode: "attestation", attestation: { approver: "A", timestamp: ok } }).ok, ok).toBe(true);
    }
  });

  it("never runs a getter, and does not change or alias a deep-frozen input", () => {
    let ran = false;
    const g = { mode: "mechanical" };
    Object.defineProperty(g, "lease", { enumerable: true, get: () => ((ran = true), lease()) });
    expect(codeOf(buildMutualExclusionSection(g))).toBe("input_not_plain_object");
    expect(ran).toBe(false);
    const input = deepFreeze(MECH());
    const before = JSON.stringify(input);
    const r = buildMutualExclusionSection(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(r.ok && r.value.mode === "mechanical" && r.value.lease !== (input["lease"] as object)).toBe(true);
  });

  it("an error never carries a value of the input", () => {
    const e = buildMutualExclusionSection({ mode: "attestation", attestation: { approver: CANARY, timestamp: CANARY } });
    expect(e.ok).toBe(false);
    expect(JSON.stringify(e)).not.toContain(CANARY);
    expect(JSON.stringify(buildMutualExclusionSection({ mode: "mechanical", lease: { ...lease(), nonceSha256: CANARY } }))).not.toContain(CANARY);
  });
});

describe("legacyStartState", () => {
  it("accepts a non-blank identity as given, with no hash rule imposed", () => {
    expect(buildLegacyStartStateSection({ identity: H("3") })).toEqual({ ok: true, value: { identity: H("3") } });
    expect(buildLegacyStartStateSection({ identity: "any-identity-string" })).toEqual({ ok: true, value: { identity: "any-identity-string" } });
  });

  it("refuses a missing, blank, over-long, control-character or non-string identity", () => {
    for (const bad of ["", "   ", "\t", "a\nb", "a\u0000b", "x".repeat(1025), 1, null, undefined, {}]) {
      expect(codeOf(buildLegacyStartStateSection({ identity: bad })), String(bad)).toBe("identity_invalid");
    }
    expect(buildLegacyStartStateSection({ identity: "x".repeat(1024) }).ok).toBe(true);
  });

  it("refuses the placeholder words that stand for 'not known'", () => {
    for (const bad of ["unknown", "Unknown", "UNMEASURED", " unmeasured "]) expect(codeOf(buildLegacyStartStateSection({ identity: bad })), bad).toBe("identity_placeholder");
  });

  it("refuses a missing key, an extra key and a non-plain input, and never runs a getter", () => {
    expect(codeOf(buildLegacyStartStateSection({}))).toBe("input_keys");
    expect(codeOf(buildLegacyStartStateSection({ identity: "x", extra: 1 }))).toBe("input_keys");
    for (const v of [undefined, null, [], "x"]) expect(codeOf(buildLegacyStartStateSection(v))).toBe("input_not_plain_object");
    let ran = false;
    const g = {};
    Object.defineProperty(g, "identity", { enumerable: true, get: () => ((ran = true), "x") });
    expect(codeOf(buildLegacyStartStateSection(g))).toBe("input_not_plain_object");
    expect(ran).toBe(false);
  });

  it("does not change a frozen input, and an error does not echo the value", () => {
    const input = deepFreeze({ identity: "id-1" });
    const r = buildLegacyStartStateSection(input);
    expect(r.ok && r.value !== (input as object)).toBe(true);
    expect(JSON.stringify(buildLegacyStartStateSection({ identity: `${CANARY}\n` }))).not.toContain(CANARY);
  });
});