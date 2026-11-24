import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkRepository,
  checkVersionPins,
  loadManifests,
  loadRecord,
  loadWorkspaces,
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

describe("workspace dependencies (task 4.9-A)", () => {
  const workspaces = new Map([
    ["@phoenix/ai-client", "0.0.0"],
    ["@phoenix/verifier", "0.0.0"],
  ]);
  const check = (deps: Record<string, string>, rec: PinRecord = record) => checkVersionPins([manifest(deps)], rec, workspaces);

  it("accepts a real workspace package with its own exact version and needs no record entry", () => {
    const r = check({ "@phoenix/ai-client": "0.0.0", "@phoenix/verifier": "0.0.0" }, { dependencies: [] });
    expect(r.findings).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.checked).toBe(2);
  });

  it("does not exclude an @phoenix package that does not exist", () => {
    const r = check({ "@phoenix/ghost": "0.0.0" });
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.kind).toBe("missing_entry");
    expect(r.findings[0]!.name).toBe("@phoenix/ghost");
  });

  it("does not exclude a workspace name when no workspace list is given (the default is none)", () => {
    const r = checkVersionPins([manifest({ "@phoenix/ai-client": "0.0.0" })], record);
    expect(r.findings.map((f) => f.kind)).toEqual(["missing_entry"]);
  });

  it("reports a version that differs from the workspace package, with both versions", () => {
    const r = check({ "@phoenix/ai-client": "0.0.1" });
    expect(r.ok).toBe(false);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0]!;
    expect(f.kind).toBe("workspace_mismatch");
    expect(f.manifestVersion).toBe("0.0.1");
    expect(f.workspaceVersion).toBe("0.0.0");
    expect(f.message).toContain("0.0.1");
    expect(f.message).toContain("0.0.0");
  });

  it.each(["^0.0.0", "~0.0.0", ">=0.0.0", "0.x", "*", "0.0", "workspace:*", "file:../ai-client", ""])("does not accept the declaration %j of a workspace package", (v) => {
    const r = check({ "@phoenix/ai-client": v });
    expect(r.ok).toBe(false);
    expect(r.findings[0]!.kind).toBe("range_operator");
  });

  it("does not accept latest for a workspace package", () => {
    const r = check({ "@phoenix/verifier": "latest" });
    expect(r.findings[0]!.kind).toBe("latest");
  });

  it("keeps the third-party checks when workspaces are given: missing entry, mismatch, not verified", () => {
    const r = check({ "@phoenix/ai-client": "0.0.0", delta: "9.9.9", alpha: "1.2.4", beta: "2.0.0" });
    expect(r.findings.map((f) => `${f.kind}:${f.name}`).sort()).toEqual(["mismatch:alpha", "missing_entry:delta", "not_verified:beta"]);
  });

  it("a workspace name does not hide a third-party package of another name", () => {
    expect(check({ "@phoenix/ai-client-extra": "0.0.0" }).findings.map((f) => f.kind)).toEqual(["missing_entry"]);
  });
});

describe("loadWorkspaces", () => {
  const dirs: string[] = [];
  const make = (rootManifest: unknown, packages: Record<string, unknown>): string => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "phx-pins-")));
    dirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify(rootManifest));
    for (const [dir, pkg] of Object.entries(packages)) {
      mkdirSync(join(root, "packages", dir), { recursive: true });
      writeFileSync(join(root, "packages", dir, "package.json"), JSON.stringify(pkg));
    }
    return root;
  };
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("lists the packages of a repository that declares the workspace pattern packages/*", () => {
    const root = make({ workspaces: ["packages/*"] }, { a: { name: "@x/a", version: "1.2.3" }, b: { name: "@x/b", version: "0.0.0" } });
    expect([...loadWorkspaces(root)].sort()).toEqual([["@x/a", "1.2.3"], ["@x/b", "0.0.0"]]);
  });
  it("lists nothing when the root does not declare the pattern", () => {
    for (const rootManifest of [{}, { workspaces: [] }, { workspaces: ["other/*"] }, { workspaces: "packages/*" }]) {
      expect(loadWorkspaces(make(rootManifest, { a: { name: "@x/a", version: "1.2.3" } })).size).toBe(0);
    }
  });
  it("skips a package without a string name or without an exact version", () => {
    const root = make(
      { workspaces: ["packages/*"] },
      { a: { version: "1.2.3" }, b: { name: "@x/b" }, c: { name: "@x/c", version: "^1.0.0" }, d: { name: "@x/d", version: "1.0" }, e: { name: "", version: "1.0.0" }, f: { name: "@x/f", version: "1.0.0" } },
    );
    expect([...loadWorkspaces(root)]).toEqual([["@x/f", "1.0.0"]]);
  });
  it("does not include a name that two directories claim", () => {
    const root = make({ workspaces: ["packages/*"] }, { a: { name: "@x/dup", version: "1.0.0" }, b: { name: "@x/dup", version: "2.0.0" }, c: { name: "@x/ok", version: "1.0.0" } });
    expect([...loadWorkspaces(root)]).toEqual([["@x/ok", "1.0.0"]]);
  });
  it("the real repository: the four packages, each with its own version", () => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    expect([...loadWorkspaces(root)].sort()).toEqual([
      ["@phoenix/ai-client", "0.0.0"],
      ["@phoenix/analyzer", "0.0.0"],
      ["@phoenix/discovery-loop", "0.0.0"],
      ["@phoenix/verifier", "0.0.0"],
    ]);
  });
});

describe("checkRepository with the workspace dependencies of discovery-loop (real files)", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  it("the three sibling dependencies are declared and are not reported", () => {
    const m = loadManifests(root).find((x) => x.path === "packages/discovery-loop/package.json");
    expect(m?.dependencies).toMatchObject({ "@phoenix/ai-client": "0.0.0", "@phoenix/analyzer": "0.0.0", "@phoenix/verifier": "0.0.0" });
    expect(checkRepository(root).findings).toEqual([]);
  });
  it("the same manifests without the workspace list would be reported (the exclusion is what the list does, not a prefix)", () => {
    const r = checkVersionPins(loadManifests(root), { dependencies: [] });
    expect(r.findings.filter((f) => f.name.startsWith("@phoenix/")).map((f) => f.kind)).toEqual(["missing_entry", "missing_entry", "missing_entry"]);
  });
  it("the version of a workspace package in the real manifests is the version of that package", () => {
    const wrong = new Map([...loadWorkspaces(root)].map(([n, v]) => [n, n === "@phoenix/verifier" ? "9.9.9" : v] as [string, string]));
    const r = checkVersionPins(loadManifests(root), loadRecord(root), wrong);
    expect(r.findings.map((f) => `${f.kind}:${f.name}`)).toEqual(["workspace_mismatch:@phoenix/verifier"]);
  });
});
