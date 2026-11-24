// Task 4.6 W3-A: agreement of the section builders with the M1 `run-manifest` schema, pins to the duplicated definitions, source purity,
// who imports the new modules, and the unchanged public surface of W1 and W2. Deterministic and offline.
// Every external value below is a TEST-ONLY fixed value; none is a measurement. No `ManifestPort` is built here (that is W5).
// **Validates: Requirements 12.8, 12.13, 22.3**
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUN_CONFIG_PROVIDERS } from "../src/config/limits.js";
import * as aiSandboxModule from "../src/manifest/aiSandboxSection.js";
import * as configModule from "../src/manifest/configSection.js";
import * as envModule from "../src/manifest/envSection.js";
import * as isolationModule from "../src/manifest/isolationSection.js";
import * as legacyModule from "../src/manifest/legacyStartStateSection.js";
import * as mutexModule from "../src/manifest/mutualExclusionSection.js";
import * as plainDataModule from "../src/manifest/plainData.js";
import * as providerModule from "../src/manifest/providerSection.js";
import * as residualModule from "../src/manifest/residualRisksSection.js";
import * as sourceBundleModule from "../src/manifest/sourceBundleSection.js";
import * as toolsModule from "../src/manifest/toolVersionsSection.js";
import { createSchemaValidator } from "../src/schema/index.js";
import { isAccessDenialResult, verifyGroundTruthAccessDenial } from "../src/isolation/index.js";
import { ALLOWED, makeDeps } from "./support/isolationFakes.js";

const H = (c: string): string => c.repeat(64);
const validator = createSchemaValidator();
const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`section refused: ${JSON.stringify(r.error)}`);
  return r.value;
};

async function assemble(kind: "mock" | "kiro-cli"): Promise<Record<string, unknown>> {
  const denial = await verifyGroundTruthAccessDenial(makeDeps().deps, { allowedEnvNames: ALLOWED });
  expect(isAccessDenialResult(denial)).toBe(true);
  const mock = kind === "mock";
  const effectiveConfig = { schemaVersion: 1, provider: kind, ...(mock ? { mockFixtureSet: "default-widget-v1" } : {}), limits: { iterations: 3 }, testApi: { baseAddress: "http://test.invalid" }, mask: { paths: [] }, envNames: ["EXAMPLE_ONE"] };
  return {
    schemaVersion: 1,
    runId: "run-test-0001",
    wallClock: { startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:10:00Z" },
    excludedFields: configModule.buildExcludedFields(),
    terminationReason: "iteration_limit_reached",
    finalHypothesisRevision: "none",
    config: must(configModule.buildConfigSection({ effectiveConfig, policyConfigSha256: H("1"), preparationTableSha256: H("2"), leasePropagationDelayMs: 40 })),
    limitsUsed: { iterations: 3, acceptedExperiments: 4, rejectedExperiments: 1 },
    provider: must(
      providerModule.buildProviderSection({
        configuredProvider: kind,
        identity: mock ? { id: "mock", version: "1", model: "not_applicable" } : { id: "kiro-cli", version: "1.2.3-test", model: "test-model" },
      }),
    ),
    toolVersions: must(toolsModule.buildToolVersionsSection({ node: "1.2.3", npm: "4.5.6", dependencies: { "dep-one": "1.0.0" }, runtimeImageDigest: `sha256:${H("a")}` })),
    sourceBundle: must(sourceBundleModule.buildSourceBundleSection([{ path: "src/a.php", sha256Lf: H("b") }])),
    legacyStartState: must(legacyModule.buildLegacyStartStateSection({ identity: H("c") })),
    envVarsRead: must(envModule.buildEnvSection([{ name: "EXAMPLE_ONE", set: true }], [])),
    payload_audit: { configCheck: "pass", audits: 2, passed: 2, blocked: 0, auditConfigSha256: H("d") },
    ground_truth_access_denial: must(isolationModule.buildGroundTruthAccessDenial(denial)),
    isolationChecks: must(isolationModule.buildIsolationChecks(denial)),
    mutualExclusion: mock
      ? must(mutexModule.buildMutualExclusionSection({ mode: "mechanical", lease: { nonceSha256: H("e"), launcherPid: 4242, heartbeatIntervalMs: 1000, staleAfterMs: 5000 } }))
      : must(mutexModule.buildMutualExclusionSection({ mode: "attestation", attestation: { approver: "Reviewer One", timestamp: "2026-01-01T00:00:00+09:00" } })),
    aiSandbox: must(
      aiSandboxModule.buildAiSandboxSection(mock ? { provider: "mock", sandbox: { applicable: false } } : { provider: "kiro-cli", sandbox: { applicable: true, destinations: ["h.invalid"] } }),
    ),
    residualRisks: residualModule.buildResidualRisks(),
    chain: { records: 12, lastHash: H("6") },
    artifacts: [{ path: "records.jsonl", sha256: H("7") }],
  };
}

describe("agreement with the M1 run-manifest schema", () => {
  it("a Run_Manifest made of the section builders (mock) is accepted by the schema, with the mock sandbox not_applicable", async () => {
    const m = await assemble("mock");
    const r = validator.validate("run-manifest", m as never);
    expect(r.ok ? [] : r.error).toEqual([]);
    expect((m["aiSandbox"] as { safetyStatus: string }).safetyStatus).toBe("not_applicable");
    expect((m["provider"] as { isMock: boolean }).isMock).toBe(true);
  });

  it("the kiro-cli form (UNVERIFIED sandbox, attestation mode) is accepted by the schema", async () => {
    const m = await assemble("kiro-cli");
    const r = validator.validate("run-manifest", m as never);
    expect(r.ok ? [] : r.error).toEqual([]);
    expect((m["aiSandbox"] as { safetyStatus: string }).safetyStatus).toBe("UNVERIFIED");
    expect((m["provider"] as { isMock: boolean }).isMock).toBe(false);
  });

  it("control: the same validator refuses a manifest with a missing section, an extra section, or a changed constant", async () => {
    const base = await assemble("mock");
    for (const key of ["toolVersions", "legacyStartState", "aiSandbox", "residualRisks", "mutualExclusion", "isolationChecks", "ground_truth_access_denial", "provider", "config", "excludedFields"]) {
      const { [key]: _removed, ...rest } = base;
      void _removed;
      expect(validator.validate("run-manifest", rest as never).ok, key).toBe(false);
    }
    expect(validator.validate("run-manifest", { ...base, approvals: [] } as never).ok).toBe(false);
    expect(validator.validate("run-manifest", { ...base, excludedFields: ["runId"] } as never).ok).toBe(false);
  });

  it("the sections are independent of each other: the builders of different sections share no object", async () => {
    const a = await assemble("mock");
    const b = await assemble("mock");
    expect(a).toEqual(b);
    expect(a["residualRisks"]).not.toBe(b["residualRisks"]);
    expect(a["excludedFields"]).not.toBe(b["excludedFields"]);
  });
});

describe("pins to the definitions that are duplicated here", () => {
  it("the configured provider set of the provider and config builders equals RUN_CONFIG_PROVIDERS, and nothing else is accepted", () => {
    const identity = (n: string): Record<string, string> => (n === "mock" ? { id: "mock", version: "1", model: "not_applicable" } : { id: n, version: "1.0.0", model: "m" });
    const cfg = (n: string): unknown => ({ effectiveConfig: { schemaVersion: 1, provider: n }, policyConfigSha256: H("1"), preparationTableSha256: H("2"), leasePropagationDelayMs: 0 });
    for (const n of RUN_CONFIG_PROVIDERS) {
      expect(providerModule.buildProviderSection({ configuredProvider: n, identity: identity(n) }).ok, n).toBe(true);
      expect(configModule.buildConfigSection(cfg(n)).ok, n).toBe(true);
    }
    for (const n of ["replay", "other"]) {
      expect(providerModule.buildProviderSection({ configuredProvider: n, identity: identity(n) }).ok, n).toBe(false);
      expect(configModule.buildConfigSection(cfg(n)).ok, n).toBe(false);
    }
  });
});

describe("source of the new modules", () => {
  const SRC = fileURLToPath(new URL("../src/", import.meta.url));
  const NEW_FILES = [
    "plainData.ts",
    "providerSection.ts",
    "configSection.ts",
    "isolationSection.ts",
    "aiSandboxSection.ts",
    "residualRisksSection.ts",
    "toolVersionsSection.ts",
    "mutualExclusionSection.ts",
    "legacyStartStateSection.ts",
  ];
  const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
  const code = (f: string): string => strip(readFileSync(`${SRC}manifest/${f}`, "utf8"));
  const specifiers = (c: string): string[] => [...c.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1] as string);

  // A reference to a Node.js built-in module is a string literal that starts with `node:` (import, export from, require and import()).
  // A property named `node` (`readonly node: string`, `{ node: "1.2.3" }`) has no quote right before `node:` and is not a reference.
  const NODE_BUILTIN_REFERENCE = /["'`]node:/;

  it("each is pure: no process, clock, random, dynamic code or console in the code (comments excluded)", () => {
    for (const f of NEW_FILES) expect(code(f), f).not.toMatch(/\bprocess\b|\bDate\b|\bperformance\b|Math\.random|\brequire\s*\(|\beval\b|\bFunction\b|\bimport\s*\(|\bJSON\b|console|\bfetch\b|setTimeout/);
  });

  it("each makes no reference to a Node.js built-in module (the `node:` check keeps its force)", () => {
    for (const f of NEW_FILES) expect(code(f), f).not.toMatch(NODE_BUILTIN_REFERENCE);
  });

  it("the built-in reference detector separates a property named node from a module reference", () => {
    for (const allowed of ["readonly node: string;", 'const v = { node: "26.13.0" };', 'return { node, npm };', "interface X { node: string }"]) {
      expect(strip(allowed), allowed).not.toMatch(NODE_BUILTIN_REFERENCE);
    }
    for (const forbidden of ['import "node:fs";', 'import fs from "node:fs";', 'import { readFileSync } from "node:fs";', 'export * from "node:path";', 'const fs = require("node:fs");', 'const m = await import("node:fs");', "import fs from 'node:fs';", "const fs = require(`node:fs`);"]) {
      expect(strip(forbidden), forbidden).toMatch(NODE_BUILTIN_REFERENCE);
    }
  });

  it("positive control: the built-in detector fires on a real source that contains such a reference", () => {
    const withReference = `${code("providerSection.ts")}\nimport fs from "node:fs";\n`;
    expect(withReference).toMatch(NODE_BUILTIN_REFERENCE);
    expect(code("toolVersionsSection.ts")).toMatch(/readonly node: string/); // the property that the old pattern mistook for a reference
  });

  it("each imports only ../schema/types.js and ./plainData.js (no isolation module, no other package, no file system)", () => {
    for (const f of NEW_FILES) {
      for (const s of specifiers(code(f))) expect(["../schema/types.js", "./plainData.js"], `${f}: ${s}`).toContain(s);
    }
    expect(specifiers(code("residualRisksSection.ts"))).toEqual([]);
  });

  it("positive control: the detector sees the imports of a file that has them, and the purity pattern sees a forbidden token", () => {
    expect(specifiers(code("providerSection.ts")).sort()).toEqual(["../schema/types.js", "./plainData.js"]);
    expect(strip("const a = 1; // process\nconst b = process.env;")).toMatch(/\bprocess\b/);
  });

  it("in src outside the manifest/ folder, only orchestrator/manifestPort.ts (task 4.6 W5) imports them, never plainData.js; not src/index.ts", () => {
    const files = (readdirSync(SRC, { recursive: true, encoding: "utf8" }) as string[]).filter((f) => f.endsWith(".ts")).map((f) => f.split("\\").join("/"));
    const needle = /manifest\/(plainData|providerSection|configSection|isolationSection|aiSandboxSection|residualRisksSection|toolVersionsSection|mutualExclusionSection|legacyStartStateSection)\.js/;
    const importers = files.filter((f) => !f.startsWith("manifest/") && needle.test(readFileSync(`${SRC}${f}`, "utf8")));
    expect(importers).toEqual(["orchestrator/manifestPort.ts"]);
    expect(readFileSync(`${SRC}orchestrator/manifestPort.ts`, "utf8")).not.toMatch(/manifest\/plainData\.js/);
    expect(readFileSync(`${SRC}index.ts`, "utf8")).not.toMatch(needle);
    // positive control: the detector finds a builder import in a source text
    expect(needle.test('import { buildConfigSection } from "../manifest/configSection.js";')).toBe(true);
    expect(files.filter((f) => /manifest\/envSection\.js/.test(readFileSync(`${SRC}${f}`, "utf8")))).toEqual(["orchestrator/loopOrchestrator.ts", "orchestrator/manifestPort.ts"]); // positive control
  });
});

describe("the public surface of W1 and W2 is unchanged", () => {
  it("each still exports exactly what it exported before the helper was extracted", () => {
    expect(Object.keys(envModule).sort()).toEqual(["buildEnvSection"]);
    expect(Object.keys(sourceBundleModule).sort()).toEqual(["SOURCE_BUNDLE_HASH_RULE", "SOURCE_BUNDLE_SCHEMA_VERSION", "buildSourceBundleSection"]);
  });

  it("the helper module exports the helpers only (nothing of W1 or W2 moved into the public barrel)", () => {
    expect(Object.keys(plainDataModule).sort()).toEqual(["SHA256_HEX", "ZERO_SHA256", "copyPlainJson", "dataValue", "hasExactKeys", "isPlainDataObject", "sectionFail"]);
    const index = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
    expect(index).not.toMatch(/plainData|manifest\//);
  });
});