import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  checkRepository,
  checkVersionPins,
  type ManifestInput,
  type PinRecord,
} from "../src/tools/versionPinning.js";

const record: PinRecord = {
  dependencies: [
    { name: "alpha", version: "1.2.3", verification: { status: "verified" } },
    { name: "beta", version: "2.0.0", verification: { status: "candidate_observed" } },
    { name: "gamma", version: "3.1.4", verification: { status: "unverified" } },
  ],
};

const manifest = (
  deps: Record<string, string>,
  dev: Record<string, string> = {},
): ManifestInput => ({ path: "fixture/package.json", dependencies: deps, devDependencies: dev });

describe("checkVersionPins (fixtures)", () => {
  it("passes on a verified exact match in dependencies and devDependencies", () => {
    const r = checkVersionPins([manifest({ alpha: "1.2.3" }), manifest({}, { alpha: "1.2.3" })], record);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(2);
  });

  it("reports the name and both versions on a mismatch", () => {
    const r = checkVersionPins([manifest({ alpha: "1.2.4" })], record);
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0]!;
    expect(f.kind).toBe("mismatch");
    expect(f.name).toBe("alpha");
    expect(f.manifestVersion).toBe("1.2.4");
    expect(f.recordVersion).toBe("1.2.3");
    expect(f.message).toContain("1.2.4");
    expect(f.message).toContain("1.2.3");
  });

  it.each(["^1.2.3", "~1.2.3", ">=1.2.3", "1.x", "*", "1.2"])("fails on range operator %s", (v) => {
    const r = checkVersionPins([manifest({ alpha: v })], record);
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.kind).toBe("range_operator");
  });

  it("fails on latest", () => {
    const r = checkVersionPins([manifest({ alpha: "latest" })], record);
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.kind).toBe("latest");
  });

  it("fails when the record has no entry", () => {
    const r = checkVersionPins([manifest({ delta: "9.9.9" })], record);
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.kind).toBe("missing_entry");
    expect(r.findings[0]!.name).toBe("delta");
  });

  it("treats a candidate_observed entry as not verified", () => {
    const r = checkVersionPins([manifest({ beta: "2.0.0" })], record);
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.kind).toBe("not_verified");
    expect(r.findings[0]!.status).toBe("candidate_observed");
  });

  it("treats an unverified entry as not verified", () => {
    const r = checkVersionPins([manifest({ gamma: "3.1.4" })], record);
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.kind).toBe("not_verified");
    expect(r.findings[0]!.status).toBe("unverified");
  });
});

describe("checkRepository (real files)", () => {
  it("passes on the real manifests and docs/version-pinning.json", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const r = checkRepository(root);
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked).toBeGreaterThanOrEqual(8);
  });
});
