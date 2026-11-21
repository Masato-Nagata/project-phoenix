// Task 4.4, stage 2: static checks of `src/orchestrator/` (source text only, each with a positive control; nothing is executed except pure
// reads of constants). Covers: the import boundary, no clock / process / dynamic code, no reverse import of the orchestrator, the narrow use of
// `config/startup.js`, the shape of the start gate (one call per step, in order, consume before the first await, only `loopDeps.isolation`),
// no exported name that contains "approv" (R6.11), and the seventeen keys of `LoopDeps` (task 4.4 unit U0). Unit U6a adds ids.ts, leaseBoundary.ts
// and hypothesisPhase.ts (15 files), the one import of the EvidenceStore, and a describe for the three files. Unit U6b adds experimentPhase.ts
// (16 files), its one value import of the EvidenceStore (experimentRuleComponent), and a describe with the source-order check (policy_decision, drain, execute).
// **Validates: Requirements 2.14, 2.15, 2.16, 15.14, 15.15, 15.16**
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STARTUP_NAME_VOCABULARY } from "../src/index.js";
import * as experimentPhaseModule from "../src/orchestrator/experimentPhase.js";
import * as hypothesisPhaseModule from "../src/orchestrator/hypothesisPhase.js";
import * as idsModule from "../src/orchestrator/ids.js";
import * as leaseBoundaryModule from "../src/orchestrator/leaseBoundary.js";
import * as providerCallModule from "../src/orchestrator/providerCall.js";
import * as typesModule from "../src/orchestrator/types.js";
import { LEASE_REASONS, START_GATE_REFUSAL_CODES, TERMINATION_REASONS, type LoopDeps } from "../src/orchestrator/types.js";
import { startGate } from "../src/orchestrator/startGate.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ORCH = join(SRC, "orchestrator");

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const blankStrings = (s: string): string => s.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
const code = (s: string): string => blankStrings(stripComments(s));
function specifiersOf(source: string): string[] {
  const c = stripComments(source);
  const found: string[] = [];
  for (const m of c.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) found.push(m[1] as string);
  for (const m of c.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) found.push(m[1] as string);
  for (const m of c.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) found.push(m[1] as string);
  for (const m of c.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g)) found.push(m[1] as string);
  return found;
}
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" || e.name === "dist" ? [] : walk(join(dir, e.name))) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}
const rel = (f: string): string => relative(SRC, f).split(sep).join("/");
const files = readdirSync(ORCH).filter((f) => f.endsWith(".ts")).sort();
const text = (f: string): string => readFileSync(join(ORCH, f), "utf8");

describe("the folder", () => {
  it("holds exactly the sixteen planned files", () => {
    expect(files).toEqual([
      "consume.ts", "deadline.ts", "envAllowlist.ts", "experimentPhase.ts", "hypothesisPhase.ts", "ids.ts", "leaseBoundary.ts", "observeReads.ts", "providerCall.ts",
      "recordWriter.ts", "session.ts", "startGate.ts", "startRun.ts", "terminate.ts", "terminationLatch.ts", "types.ts",
    ]);
  });
});

describe("(a) the import boundary", () => {
  const ALLOWED: readonly RegExp[] = [
    /^\.\/(?:consume|deadline|envAllowlist|experimentPhase|hypothesisPhase|ids|leaseBoundary|providerCall|recordWriter|session|startGate|startRun|terminate|terminationLatch|types)\.js$/,
    /^\.\.\/gate\/mayStartRun\.js$/,
    /^\.\.\/model\/evidenceStore\.js$/, // the EvidenceStore class (type), CITATION_VERIFIER (hypothesisPhase.ts only) and experimentRuleComponent (experimentPhase.ts only); checked in its own test below
    /^\.\.\/isolation\/(?:index|types)\.js$/,
    /^\.\.\/config\/(?:startup|runConfig)\.js$/,
    /^\.\.\/schema\/types\.js$/,
    /^\.\.\/store\/fileSystemPort\.js$/,
    /^\.\.\/store\/runRecordStore\.js$/, // type-only, for `RunRecordStore` and `OpenError` (checked in its own test below)
  ];
  const outside = (source: string): string[] => specifiersOf(source).filter((s) => !ALLOWED.some((re) => re.test(s)));
  it("every import of every file is on the list (no verifier, ai-client, analyzer, @phoenix, nodeDeps or node:)", () => {
    for (const f of files) expect(outside(text(f)), f).toEqual([]);
  });
  it("positive control: each foreign import is reported", () => {
    for (const bad of [
      'import { x } from "../../../verifier/src/index.js";',
      'import type { y } from "../../ai-client/src/index.js";',
      'import { z } from "@phoenix/analyzer";',
      'import { n } from "../isolation/nodeDeps.js";',
      'import fs from "node:fs";',
      'import { s } from "../store/secretScanner.js";',
      'import { i } from "../index.js";',
      'export * from "../isolation/verify.js";',
      'import { f } from "../model/facts.js";',
      'import { s } from "../model/sanitize.js";',
      'import type { E } from "../model/types.js";',
      'import { e } from "../model/index.js";',
    ]) {
      expect(outside(bad).length, bad).toBeGreaterThan(0);
    }
    expect(outside('import type { Result } from "../schema/types.js";\nimport { a } from "./consume.js";')).toEqual([]);
    expect(outside('import { CITATION_VERIFIER, type EvidenceStore } from "../model/evidenceStore.js";')).toEqual([]);
    expect(outside('import { a } from "./ids.js";\nimport { b } from "./leaseBoundary.js";\nimport { c } from "./hypothesisPhase.js";')).toEqual([]);
  });
  it("the EvidenceStore is imported by hypothesisPhase.ts (CITATION_VERIFIER, EvidenceStore type) and experimentPhase.ts (experimentRuleComponent, EvidenceStore type) only (U6a, U6b)", () => {
    const evidenceStoreViolations = (source: string, allowedValue = "CITATION_VERIFIER"): string[] => {
      const bad: string[] = [];
      for (const m of stripComments(source).matchAll(/^\s*import\s+(type\s+)?([^;]*?)\s*\bfrom\s*["']\.\.\/model\/evidenceStore\.js["']/gm)) {
        const braces = /^\{([^}]*)\}$/.exec((m[2] as string).trim());
        if (braces === null) {
          bad.push("not a named import");
          continue;
        }
        for (const n of (braces[1] as string).split(",").map((x) => x.trim()).filter((x) => x !== "")) {
          const name = n.replace(/^type\s+/, "");
          if (name !== allowedValue && name !== "EvidenceStore") bad.push(name);
          else if (name === "EvidenceStore" && m[1] === undefined && !n.startsWith("type ")) bad.push("value import of EvidenceStore");
        }
      }
      return bad;
    };
    const importers = files.filter((f) => specifiersOf(text(f)).includes("../model/evidenceStore.js"));
    expect(importers).toEqual(["experimentPhase.ts", "hypothesisPhase.ts"]);
    for (const f of files) expect(evidenceStoreViolations(text(f), f === "experimentPhase.ts" ? "experimentRuleComponent" : "CITATION_VERIFIER"), f).toEqual([]);
    expect(text("hypothesisPhase.ts")).toMatch(/import \{ CITATION_VERIFIER, type EvidenceStore \} from "\.\.\/model\/evidenceStore\.js";/);
    expect(text("experimentPhase.ts")).toMatch(/import \{ experimentRuleComponent, type EvidenceStore \} from "\.\.\/model\/evidenceStore\.js";/);
    // the value of one file is a violation in the other
    expect(evidenceStoreViolations(text("experimentPhase.ts"))).toEqual(["experimentRuleComponent"]);
    expect(evidenceStoreViolations(text("hypothesisPhase.ts"), "experimentRuleComponent")).toEqual(["CITATION_VERIFIER"]);
    expect(evidenceStoreViolations('import { experimentRuleComponent } from "../model/evidenceStore.js";', "experimentRuleComponent")).toEqual([]);
    expect(evidenceStoreViolations('import { CITATION_VERIFIER, experimentRuleComponent } from "../model/evidenceStore.js";', "experimentRuleComponent")).toEqual(["CITATION_VERIFIER"]);
    // positive control
    expect(evidenceStoreViolations('import { EvidenceStore } from "../model/evidenceStore.js";')).toEqual(["value import of EvidenceStore"]);
    expect(evidenceStoreViolations('import { experimentRuleComponent } from "../model/evidenceStore.js";')).toEqual(["experimentRuleComponent"]);
    expect(evidenceStoreViolations('import * as m from "../model/evidenceStore.js";')).toEqual(["not a named import"]);
    expect(evidenceStoreViolations('import type { EvidenceStore } from "../model/evidenceStore.js";')).toEqual([]);
    expect(evidenceStoreViolations('import { CITATION_VERIFIER, type EvidenceStore } from "../model/evidenceStore.js";')).toEqual([]);
    expect(specifiersOf('import { a } from "../model/evidenceStore.js";')).toEqual(["../model/evidenceStore.js"]);
  });
  it("the run record store is imported as a type, and only RunRecordStore and OpenError (U0)", () => {
    const storeViolations = (source: string): string[] => {
      const bad: string[] = [];
      for (const m of stripComments(source).matchAll(/^\s*import\s+(type\s+)?([^;]*?)\s*\bfrom\s*["']\.\.\/store\/runRecordStore\.js["']/gm)) {
        const braces = /^\{([^}]*)\}$/.exec((m[2] as string).trim());
        if (m[1] === undefined || braces === null) {
          bad.push("not a type-only named import");
          continue;
        }
        for (const n of (braces[1] as string).split(",").map((x) => x.trim()).filter((x) => x !== "")) if (n !== "RunRecordStore" && n !== "OpenError") bad.push(n);
      }
      return bad;
    };
    for (const f of files) expect(storeViolations(text(f)), f).toEqual([]);
    expect(text("types.ts")).toMatch(/import type \{ OpenError, RunRecordStore \} from "\.\.\/store\/runRecordStore\.js";/);
    // positive control
    expect(storeViolations('import { RunRecordStore } from "../store/runRecordStore.js";')).toEqual(["not a type-only named import"]);
    expect(storeViolations('import type { RunRecordStore, WriteError } from "../store/runRecordStore.js";')).toEqual(["WriteError"]);
    expect(storeViolations('import type { SealedManifest } from "../store/runRecordStore.js";')).toEqual(["SealedManifest"]);
    expect(storeViolations('import type * as S from "../store/runRecordStore.js";')).toEqual(["not a type-only named import"]);
    expect(storeViolations('import type { RunRecordStore, OpenError } from "../store/runRecordStore.js";')).toEqual([]);
  });
  it("runConfig, fileSystemPort and the schema types are imported as types only", () => {
    const typeOnlyViolations = (source: string): string[] => {
      const bad: string[] = [];
      for (const m of stripComments(source).matchAll(/^\s*import\s+(type\s+)?[^;]*?\bfrom\s*["']([^"']+)["']/gm)) {
        if (/^\.\.\/(?:config\/runConfig|store\/fileSystemPort|schema\/types)\.js$/.test(m[2] as string) && m[1] === undefined) bad.push(m[2] as string);
      }
      return bad;
    };
    for (const f of files) expect(typeOnlyViolations(text(f)), f).toEqual([]);
    expect(typeOnlyViolations('import { Result } from "../schema/types.js";')).toEqual(["../schema/types.js"]);
    expect(typeOnlyViolations('import type { Result } from "../schema/types.js";')).toEqual([]);
  });
});

describe("(b) no process, clock, random source or dynamic code", () => {
  const FORBIDDEN: readonly { id: string; re: RegExp }[] = [
    { id: "process", re: /\bprocess\b|\bglobalThis\b/ },
    { id: "Date", re: /\bDate\b/ },
    { id: "random", re: /Math\.random|getRandomValues|randomUUID|randomBytes/ },
    { id: "clock", re: /\bperformance\b|hrtime|\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/ },
    { id: "eval", re: /\beval\s*\(|new Function\s*\(/ },
    { id: "dynamic import", re: /\bimport\s*\(|\brequire\s*\(/ },
    { id: "network", re: /\bfetch\s*\(|XMLHttpRequest|WebSocket/ },
    { id: "node module", re: /node:[a-z_/]+/ },
  ];
  const found = (source: string): string[] => FORBIDDEN.filter((f) => f.re.test(stripComments(source).replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => (/node:/.test(m) ? m : '""')))).map((f) => f.id);
  it("holds for every file", () => {
    for (const f of files) expect(found(text(f)), f).toEqual([]);
  });
  it("positive control", () => {
    expect(found("const e = process.env.X;")).toContain("process");
    expect(found("const t = new Date();")).toContain("Date");
    expect(found("const r = Math.random();")).toContain("random");
    expect(found("setTimeout(f, 1);")).toContain("clock");
    expect(found("eval(x);")).toContain("eval");
    expect(found("new Function('a');")).toContain("eval");
    expect(found('await import("x");')).toContain("dynamic import");
    expect(found('import fs from "node:fs";')).toContain("node module");
    expect(found("// process, Date and eval( in a comment\nconst a = 1;")).toEqual([]);
  });
});

describe("(c) nothing imports the orchestrator except the orchestrator", () => {
  const mentionsOrchestrator = (source: string): boolean => specifiersOf(source).some((s) => /(^|\/)orchestrator(\/|$)/.test(s));
  it("src/gate, src/isolation, config/startup.ts and every other file of src do not import it; the package entry does not re-export it", () => {
    const all = walk(SRC).filter((f) => !rel(f).startsWith("orchestrator/"));
    expect(all.map(rel)).toEqual(expect.arrayContaining(["gate/mayStartRun.ts", "config/startup.ts", "index.ts"]));
    expect(all.some((f) => rel(f).startsWith("isolation/"))).toBe(true);
    for (const f of all) expect(mentionsOrchestrator(readFileSync(f, "utf8")), rel(f)).toBe(false);
  });
  it("positive control: fixtures with the import are reported", () => {
    for (const bad of [
      'import { startGate } from "../orchestrator/startGate.js";',
      'export * from "../orchestrator/index.js";',
      'import type { LoopDeps } from "../orchestrator/types.js";',
    ]) {
      expect(mentionsOrchestrator(bad), bad).toBe(true);
    }
    expect(mentionsOrchestrator('import { a } from "./other.js";')).toBe(false);
  });
});

describe("(d) config/startup.js is used for isStartupApproval and types only", () => {
  const offenders = (source: string): string[] => {
    const bad: string[] = [];
    for (const m of stripComments(source).matchAll(/^\s*import\s+(type\s+)?([^;]*?)\s+from\s*["']\.\.\/config\/startup\.js["']/gm)) {
      if (m[1] !== undefined) continue;
      const names = (m[2] as string).replace(/[{}]/g, "").split(",").map((n) => n.trim()).filter((n) => n !== "");
      for (const n of names) if (n !== "isStartupApproval" && !n.startsWith("type ")) bad.push(n);
    }
    return bad;
  };
  it("holds for every file", () => {
    for (const f of files) expect(offenders(text(f)), f).toEqual([]);
    expect(text("consume.ts")).toMatch(/import \{ isStartupApproval \} from "\.\.\/config\/startup\.js";/);
  });
  it("positive control", () => {
    expect(offenders('import { checkStartupRefusals } from "../config/startup.js";')).toEqual(["checkStartupRefusals"]);
    expect(offenders('import { isStartupApproval, STARTUP_CHECK_ORDER } from "../config/startup.js";')).toEqual(["STARTUP_CHECK_ORDER"]);
    expect(offenders('import { isStartupApproval, type StartupApproval } from "../config/startup.js";')).toEqual([]);
    expect(offenders('import type { StartupApproval } from "../config/startup.js";')).toEqual([]);
  });
});

describe("(e) the orchestrator may import the gate (the legitimate import of task 4.3)", () => {
  const importsGate = (source: string): boolean => specifiersOf(source).some((s) => /(^|\/)gate(\/|$)|mayStartRun/.test(s));
  const isForbiddenImporter = (relPath: string): boolean => relPath.startsWith("isolation/") || relPath === "config/startup.ts";
  it("only startGate.ts imports the gate, and no orchestrator file is a forbidden importer of it", () => {
    const importers = walk(SRC).filter((f) => importsGate(readFileSync(f, "utf8"))).map(rel);
    expect(importers).toContain("orchestrator/startGate.ts");
    for (const f of files) expect(isForbiddenImporter(`orchestrator/${f}`), f).toBe(false);
    for (const i of importers) expect(isForbiddenImporter(i), i).toBe(false);
    expect(importsGate(text("types.ts"))).toBe(false);
    expect(importsGate(text("consume.ts"))).toBe(false);
  });
  it("positive control: the same detector reports a forbidden importer", () => {
    expect(importsGate('import { mayStartRun } from "../gate/mayStartRun.js";')).toBe(true);
    expect(isForbiddenImporter("isolation/verify.ts")).toBe(true);
    expect(isForbiddenImporter("config/startup.ts")).toBe(true);
    expect(isForbiddenImporter("orchestrator/startGate.ts")).toBe(false);
  });
});

describe("the shape of the start gate", () => {
  const gateCode = code(text("startGate.ts"));
  const count = (re: RegExp, s: string = gateCode): number => [...s.matchAll(re)].length;
  it("calls each step exactly once, in the fixed order", () => {
    const steps = ["consumeStartup(", "buildAllowedEnvNames(", "verifyGroundTruthAccessDenial(", "isAccessDenialResult(", "mayStartRun("];
    const at = steps.map((s) => {
      expect(gateCode.split(s).length - 1, s).toBe(1);
      return gateCode.indexOf(s);
    });
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // the lease check helper is defined before the gate, calls `check` once, and is used once after step 6
    expect(gateCode.split(".call(port)").length - 1).toBe(1);
    expect(count(/\bcheckLease\(/g)).toBe(2); // definition and the single call
    expect(gateCode.indexOf("mayStartRun(")).toBeLessThan(gateCode.lastIndexOf("checkLease("));
  });
  it("consumes before the first await of the gate function", () => {
    const body = gateCode.slice(gateCode.indexOf("export async function startGate"));
    expect(body.indexOf("consumeStartup(")).toBeGreaterThan(-1);
    expect(body.indexOf("await")).toBeGreaterThan(body.indexOf("consumeStartup("));
  });
  it("consume.ts is synchronous: no async, await, Promise or then", () => {
    expect(code(text("consume.ts"))).not.toMatch(/\basync\b|\bawait\b|\bPromise\b|\.then\b/);
  });
  it("reads only loopDeps.isolation", () => {
    const keys = [...gateCode.matchAll(/\bloopDeps\.(\w+)/g)].map((m) => m[1]);
    expect(keys).toEqual(["isolation"]);
    expect(gateCode).not.toMatch(/\bloopDeps\s*\[/);
    expect(gateCode.match(/\bloopDeps\b/g)?.length).toBe(2); // the parameter and the one read
  });
  it("has no branch on the provider or on Mock", () => {
    expect(gateCode).not.toMatch(/\b\w*(?:mock|provider)\w*\b/i);
  });
  it("the allowed names do not use the list of names that stage B read, and no value of the environment", () => {
    const c = code(text("envAllowlist.ts"));
    expect(c).not.toMatch(/envVarsRead|\bprocess\b|\benv\b/);
    expect(c).toMatch(/startup\.config\.envNames/);
    expect(c).toMatch(/startup\.credentials/);
  });
  it("positive control: the detectors catch the forbidden shapes", () => {
    expect(code('if (startup.config.provider === "mock") return;')).toMatch(/\b\w*(?:mock|provider)\w*\b/i);
    expect([...code("const a = loopDeps.fs; const b = loopDeps.isolation;").matchAll(/\bloopDeps\.(\w+)/g)].map((m) => m[1])).toEqual(["fs", "isolation"]);
    expect(code("const x = startup.envVarsRead;")).toMatch(/envVarsRead/);
    expect(code("export async function f() { await g(); }")).toMatch(/\basync\b/);
  });
});

describe("exported names (R6.11) and the vocabularies", () => {
  const exportsOf = (source: string): string[] => [...stripComments(source).matchAll(/^export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+(\w+)/gm)].map((m) => m[1] as string);
  it("no exported identifier of any orchestrator file contains approv (any case)", () => {
    for (const f of files) {
      const names = exportsOf(text(f));
      expect(names.length, f).toBeGreaterThan(0);
      expect(names.filter((n) => /approv/i.test(n)), f).toEqual([]);
    }
    expect(Object.keys(typesModule).filter((n) => /approv/i.test(n))).toEqual([]);
  });
  it("positive control: the detector reports a forbidden name", () => {
    expect(exportsOf("export function isApproved() {}\nexport const OK = 1;").filter((n) => /approv/i.test(n))).toEqual(["isApproved"]);
  });
  it("exports exactly the intended runtime names", () => {
    expect(exportsOf(text("startGate.ts"))).toEqual(["startGate"]);
    expect(exportsOf(text("consume.ts"))).toEqual(["ConsumeResult", "consumeStartup"]);
    expect(exportsOf(text("envAllowlist.ts"))).toEqual(["buildAllowedEnvNames"]);
    expect(exportsOf(text("providerCall.ts"))).toEqual(["RECORDS_UNAVAILABLE_MESSAGE", "ProviderCallInput", "ProviderCallResult", "callProvider"]);
    expect(Object.keys(providerCallModule).sort()).toEqual(["RECORDS_UNAVAILABLE_MESSAGE", "callProvider"]);
    expect(exportsOf(text("ids.ts"))).toEqual(["INVALID_ITERATION_MESSAGE", "IdCounters", "createIdCounters"]);
    expect(Object.keys(idsModule).sort()).toEqual(["INVALID_ITERATION_MESSAGE", "createIdCounters"]);
    expect(exportsOf(text("leaseBoundary.ts"))).toEqual(["checkLeaseBoundary"]);
    expect(Object.keys(leaseBoundaryModule)).toEqual(["checkLeaseBoundary"]);
    expect(exportsOf(text("hypothesisPhase.ts"))).toEqual([
      "PredecessorClaimRef", "PredecessorRef", "SemanticHashInput", "SemanticSha256Of", "HypothesisPhaseInput", "AcceptedClaimRef", "HypothesisPhaseResult", "runHypothesisPhase",
    ]);
    expect(Object.keys(hypothesisPhaseModule)).toEqual(["runHypothesisPhase"]);
    expect(exportsOf(text("experimentPhase.ts"))).toEqual([
      "CurrentHypothesisRef", "ExperimentPhaseInput", "ComparisonResultName", "ExecutedExperiment", "ExperimentPhaseSummary", "ExperimentLimitReason", "ExperimentPhaseResult",
      "EXPERIMENT_INVALID_CODES", "EXPERIMENT_ERROR_CODES", "EXPERIMENT_ERROR_PHASES", "EXPERIMENT_ERROR_CAUSES", "runExperimentPhase",
    ]);
    expect(Object.keys(experimentPhaseModule)).toEqual(["EXPERIMENT_INVALID_CODES", "EXPERIMENT_ERROR_CODES", "EXPERIMENT_ERROR_PHASES", "EXPERIMENT_ERROR_CAUSES", "runExperimentPhase"]);
    expect(Object.keys(typesModule).sort()).toEqual(["LEASE_REASONS", "START_GATE_REFUSAL_CODES", "TERMINATION_REASONS", "UNSEALED_FAILURE_CODES"]);
  });
  it("the lease reasons equal those of stage B; the refusal codes and termination reasons are closed and distinct", () => {
    expect([...LEASE_REASONS]).toEqual([...STARTUP_NAME_VOCABULARY.leaseReasons]);
    expect(new Set(START_GATE_REFUSAL_CODES).size).toBe(START_GATE_REFUSAL_CODES.length);
    expect(START_GATE_REFUSAL_CODES).toHaveLength(9);
    expect([...TERMINATION_REASONS]).toEqual([
      "iteration_limit_reached", "experiment_limit_reached", "time_limit_reached", "no_further_experiments", "provider_failure", "payload_audit_blocked",
      "policy_rejection_limit", "isolation_violation", "lease_unavailable", "launcher_killed", "error",
    ]);
  });
});

describe("types", () => {
  const KEYS = [
    "analysis", "analysisFs", "audit", "clock", "comparator", "fs", "isolation", "manifest", "policy", "provider", "repoRoot", "responseGate", "runVolumeDir", "runnerFactory",
    "storeFactory", "timers", "wallClock",
  ];
  const keysOf = (source: string): string[] => {
    const body = /export interface LoopDeps<[^>]*> \{([\s\S]*?)\n\}/.exec(stripComments(source))?.[1] ?? "";
    return [...body.matchAll(/^ {2}readonly (\w+)\??:/gm)].map((m) => m[1] as string).sort();
  };
  it("LoopDeps has exactly the 17 listed keys", () => {
    expect(keysOf(text("types.ts"))).toEqual(KEYS);
    expect(KEYS).toHaveLength(17);
    // compile-time form (checked by tsc when this file is type-checked): a missing or an extra key is an error
    const all: Record<keyof LoopDeps, true> = {
      isolation: true, fs: true, runVolumeDir: true, clock: true, wallClock: true, timers: true, provider: true, audit: true,
      responseGate: true, policy: true, runnerFactory: true, comparator: true, analysisFs: true, repoRoot: true, analysis: true, storeFactory: true, manifest: true,
    };
    expect(Object.keys(all)).toHaveLength(17);
  });
  it("positive control: the key extractor sees a missing and an extra key", () => {
    expect(keysOf("export interface LoopDeps<T = unknown> {\n  readonly a: number;\n  readonly b?: string;\n}")).toEqual(["a", "b"]);
    expect(keysOf("export interface Other {\n  readonly a: number;\n}")).toEqual([]);
  });
  it("startGate takes (loopDeps, startup)", () => {
    expect(startGate.length).toBe(2);
    expect(/export async function startGate<[^>]*>\(\s*loopDeps: LoopDeps<[^)]*>,\s*startup: StartupApproval</.test(stripComments(text("startGate.ts")))).toBe(true);
  });
});

describe("providerCall.ts (task 4.4, unit U5)", () => {
  const src = code(text("providerCall.ts"));
  const NO_TERMINATION = /\bchannel\b|\bTerminationChannel\b|\bappendTermination\b|\bseal\s*\(|\bcloseAdmission\b|\bterminate\b|\bcreateTerminator\b/i;
  const usesDeps = (s: string): boolean => /\bdeps\b|\bloopDeps\b|\bLoopDeps\b/.test(s);
  /** The text from the last `deadlineCheckpoint(` before `.complete(` up to `.complete(`. `undefined` when there is no such pair. */
  const preCallSlice = (s: string): string | undefined => {
    const at = s.indexOf(".complete(");
    if (at < 0) return undefined;
    const from = s.lastIndexOf("deadlineCheckpoint(", at);
    return from < 0 ? undefined : s.slice(from, at);
  };
  const awaitsBetween = (s: string): boolean => /\bawait\b|\basync\b/.test(preCallSlice(s) ?? "await");
  /** The text from `.records()` up to the next `.raise(`. */
  const recordsToRaise = (s: string): string | undefined => {
    const at = s.indexOf(".records()");
    if (at < 0) return undefined;
    const to = s.indexOf(".raise(", at);
    return to < 0 ? undefined : s.slice(at, to);
  };

  it("holds no reference to the termination capability, the seal, the admission closing or the terminator", () => {
    expect(src).not.toMatch(NO_TERMINATION);
    expect(code(text("providerCall.ts"))).not.toMatch(/\bTerminationChannel\b/);
  });
  it("positive control: each forbidden token is reported, a comment is not", () => {
    for (const bad of ["const c = channel;", "x: TerminationChannel;", "c.appendTermination({});", "c.seal(m);", "c.closeAdmission();", "terminate(x);", "createTerminator(y);"]) {
      expect(code(bad), bad).toMatch(NO_TERMINATION);
    }
    expect(code("// channel, seal( and terminate in a comment\nconst a = 1;")).not.toMatch(NO_TERMINATION);
  });
  it("takes its ports explicitly: no `deps`, `loopDeps` or `LoopDeps` anywhere in the code", () => {
    expect(usesDeps(src)).toBe(false);
    expect(src).toMatch(/\bProviderCallInput<TAudit, TRequest>/);
    expect(usesDeps("const x = deps.provider;")).toBe(true);
    expect(usesDeps("function f(loopDeps: LoopDeps) {}")).toBe(true);
    expect(usesDeps("function f(input: ProviderCallInput<A, B>) {}")).toBe(false);
  });
  it("uses the one deadline test (`deadlineCheckpoint`) and never `deadlineReached`", () => {
    expect(src).toMatch(/\bdeadlineCheckpoint\(/);
    expect(src).not.toMatch(/\bdeadlineReached\b/);
    expect(code("if (s.deadlineReached()) s.raise(x);")).toMatch(/\bdeadlineReached\b/);
  });
  it("the synchronous pre-call check is directly before `.complete(`: no await and no async between them, one call, in a function that is not async", () => {
    expect(src.split(".complete(").length - 1).toBe(1);
    expect(preCallSlice(src)).toBeDefined();
    expect(awaitsBetween(src)).toBe(false);
    expect(src).toMatch(/\bfunction invokeProvider\b/);
    expect(src).not.toMatch(/\basync function invokeProvider\b/);
    // the slice contains the three parts of the check
    expect(preCallSlice(src)).toMatch(/deadlineCheckpoint\(session\)/);
  });
  it("positive control: an await, an async function, or a missing check between the check and the call is reported", () => {
    expect(awaitsBetween("if (deadlineCheckpoint(s) !== 1) return; await x(); p.complete(r);")).toBe(true);
    expect(awaitsBetween("if (deadlineCheckpoint(s) !== 1) return; const f = async () => 1; p.complete(r);")).toBe(true);
    expect(awaitsBetween("p.complete(r);")).toBe(true); // no check before the call: reported as a violation
    expect(awaitsBetween("if (deadlineCheckpoint(s) !== 1) return; p.complete(r);")).toBe(false);
    expect(awaitsBetween("await a(); if (deadlineCheckpoint(s) !== 1) return; p.complete(r);")).toBe(false);
  });
  it("no await between the read of the snapshot and the raise of `error` when it is unavailable", () => {
    const slice = recordsToRaise(src);
    expect(slice).toBeDefined();
    expect(slice).not.toMatch(/\bawait\b/);
    expect(recordsToRaise("const s = w.records(); await x(); session.raise('error');")).toMatch(/\bawait\b/);
    expect(recordsToRaise("const s = w.records(); session.raise('error');")).not.toMatch(/\bawait\b/);
    expect(recordsToRaise("const s = 1;")).toBeUndefined();
  });
  it("the fixed text of the one sanctioned throw equals the text of startRun.ts, and no other `throw` exists", () => {
    expect(providerCallModule.RECORDS_UNAVAILABLE_MESSAGE).toBe("run records unavailable");
    expect(text("startRun.ts")).toContain('"run records unavailable"');
    expect([...src.matchAll(/\bthrow\b/g)]).toHaveLength(1);
    expect(src).toMatch(/throw new Error\(RECORDS_UNAVAILABLE_MESSAGE\)/);
  });
});

describe("ids.ts, leaseBoundary.ts and hypothesisPhase.ts (task 4.4, unit U6a)", () => {
  const U6A = ["hypothesisPhase.ts", "ids.ts", "leaseBoundary.ts"] as const;
  const NO_TERMINATION = /\bchannel\b|\bTerminationChannel\b|\bappendTermination\b|\bseal\s*\(|\bcloseAdmission\b|\bterminate\b|\bcreateTerminator\b/i;
  const FOREIGN_PACKAGE = /ai-client|analyzer|verifier|@phoenix/;
  const foreignImports = (source: string): string[] => specifiersOf(source).filter((s) => FOREIGN_PACKAGE.test(s) || /^node:/.test(s));

  it("hold no reference to the termination capability, the seal, the admission closing or the terminator", () => {
    for (const f of U6A) expect(code(text(f)), f).not.toMatch(NO_TERMINATION);
  });
  it("positive control: each forbidden token is reported, a comment is not", () => {
    for (const bad of ["const c = channel;", "x: TerminationChannel;", "c.appendTermination({});", "c.seal(m);", "c.closeAdmission();", "terminate(x);", "createTerminator(y);"]) {
      expect(code(bad), bad).toMatch(NO_TERMINATION);
    }
    expect(code("// channel, seal( and terminate in a comment\nconst a = 1;")).not.toMatch(NO_TERMINATION);
  });
  it("use the one deadline test and never `deadlineReached`", () => {
    for (const f of U6A) expect(code(text(f)), f).not.toMatch(/\bdeadlineReached\b/);
    expect(code(text("leaseBoundary.ts"))).toMatch(/\bdeadlineCheckpoint\(/);
    expect(code(text("hypothesisPhase.ts"))).toMatch(/\bdeadlineCheckpoint\(/);
    expect(code("if (s.deadlineReached()) s.raise(x);")).toMatch(/\bdeadlineReached\b/);
  });
  it("import no node: module and no ai-client, analyzer or verifier (the analysis comes in through the port)", () => {
    for (const f of U6A) expect(foreignImports(text(f)), f).toEqual([]);
    expect(foreignImports('import { a } from "../../../analyzer/src/index.js";')).toHaveLength(1);
    expect(foreignImports('import { b } from "../../ai-client/src/index.js";')).toHaveLength(1);
    expect(foreignImports('import { c } from "../../../verifier/src/index.js";')).toHaveLength(1);
    expect(foreignImports('import { d } from "node:crypto";')).toHaveLength(1);
    expect(foreignImports('import { e } from "./deadline.js";')).toEqual([]);
  });
  it("take no `deps`, `loopDeps` or `LoopDeps`, and never call the provider directly (only through callProvider)", () => {
    for (const f of U6A) expect(code(text(f)), f).not.toMatch(/\bdeps\b|\bloopDeps\b|\bLoopDeps\b/);
    expect(code(text("hypothesisPhase.ts"))).not.toMatch(/\.complete\(/);
    expect(code(text("hypothesisPhase.ts"))).toMatch(/\bcallProvider\b/);
  });
  it("hypothesisPhase.ts calls noteProviderRetry exactly once, after the cause check, and only for a re-call", () => {
    const src = code(text("hypothesisPhase.ts"));
    expect(src.split("noteProviderRetry(").length - 1).toBe(1);
    expect(src.indexOf("mayCall(session)")).toBeLessThan(src.indexOf("noteProviderRetry("));
  });
  it("leaseBoundary.ts calls `check` once, on the same instance", () => {
    const src = code(text("leaseBoundary.ts"));
    expect(src.split(".call(port").length - 1).toBe(1);
    expect(src).not.toMatch(/\.check\(/);
  });
  it("the only throws are the fixed RangeError of ids.ts and none in the other two files", () => {
    expect([...code(text("ids.ts")).matchAll(/\bthrow\b/g)]).toHaveLength(1);
    expect(code(text("ids.ts"))).toMatch(/throw new RangeError\(INVALID_ITERATION_MESSAGE\)/);
    // hypothesisPhase.ts re-throws the sanctioned error of callProvider, and its own `new Error` text is only used for the non-JSON guard
    expect(code(text("leaseBoundary.ts"))).not.toMatch(/\bthrow\b/);
    expect([...code(text("hypothesisPhase.ts")).matchAll(/\bthrow\b/g)].length).toBe(3);
  });
});

describe("experimentPhase.ts (task 4.4, unit U6b)", () => {
  const raw = text("experimentPhase.ts");
  const src = code(raw);
  const NO_TERMINATION = /\bchannel\b|\bTerminationChannel\b|\bappendTermination\b|\bseal\s*\(|\bcloseAdmission\b|\bterminate\b|\bcreateTerminator\b/i;
  const FOREIGN_PACKAGE = /ai-client|analyzer|verifier|@phoenix/;
  const foreignImports = (source: string): string[] => specifiersOf(source).filter((s) => FOREIGN_PACKAGE.test(s) || /^node:/.test(s));
  /** Positions of the `policy_decision` append, the `drain()` and the `.execute(` in the source text with the strings kept (comments removed). */
  const order = (source: string): { policy: number[]; drain: number[]; execute: number[] } => {
    const c = stripComments(source);
    const all = (re: RegExp): number[] => [...c.matchAll(re)].map((m) => m.index as number);
    return { policy: all(/"policy_decision"/g), drain: all(/\.drain\(\)/g), execute: all(/\.execute\(/g) };
  };
  const orderOk = (source: string): boolean => {
    const o = order(source);
    return o.policy.length === 1 && o.drain.length === 1 && o.execute.length === 1 && (o.policy[0] as number) < (o.drain[0] as number) && (o.drain[0] as number) < (o.execute[0] as number);
  };

  it("holds no reference to the termination capability, the seal, the admission closing or the terminator", () => {
    expect(src).not.toMatch(NO_TERMINATION);
    for (const bad of ["const c = channel;", "x: TerminationChannel;", "c.appendTermination({});", "c.seal(m);", "c.closeAdmission();", "terminate(x);", "createTerminator(y);"]) {
      expect(code(bad), bad).toMatch(NO_TERMINATION);
    }
  });
  it("imports no node: module and no ai-client, analyzer or verifier; takes no `deps`, `loopDeps` or `LoopDeps`; never calls the provider directly", () => {
    expect(foreignImports(raw)).toEqual([]);
    expect(src).not.toMatch(/\bdeps\b|\bloopDeps\b|\bLoopDeps\b/);
    expect(src).not.toMatch(/\.complete\(/);
    expect(src).toMatch(/\bcallProvider\b/);
    expect(foreignImports('import { c } from "../../../verifier/src/index.js";')).toHaveLength(1);
    expect(foreignImports('import { e } from "./deadline.js";')).toEqual([]);
  });
  it("uses the one deadline test, never `deadlineReached`, and no provider retry counter of its own", () => {
    expect(src).toMatch(/\bdeadlineCheckpoint\(/);
    expect(src).not.toMatch(/\bdeadlineReached\b/);
    expect(src).not.toMatch(/\bnoteProviderRetry\b/);
  });
  it("the `policy_decision` append and the `drain()` come before the one `.execute(` (positive control)", () => {
    expect(orderOk(raw)).toBe(true);
    expect(orderOk('w.append("policy_decision", p); await w.drain(); r.execute(e);')).toBe(true);
    expect(orderOk('w.append("policy_decision", p); r.execute(e); await w.drain();')).toBe(false);
    expect(orderOk('await w.drain(); r.execute(e); w.append("policy_decision", p);')).toBe(false);
    expect(orderOk('r.execute(e); w.append("policy_decision", p); await w.drain();')).toBe(false);
    expect(orderOk('w.append("policy_decision", p); r.execute(e);')).toBe(false);
    expect(orderOk('w.append("policy_decision", p); await w.drain(); r.execute(e); r.execute(e);')).toBe(false);
    expect(orderOk('// "policy_decision"\nawait w.drain(); r.execute(e);')).toBe(false);
  });
  it("the runner and the comparator are called through the injected ports, once each", () => {
    expect(src.split(".execute(").length - 1).toBe(1);
    expect(src.split(".compare(").length - 1).toBe(1);
    expect(src.split(".evaluateForRecord(").length - 1).toBe(1);
    expect(src.split("experimentRuleComponent(").length - 1).toBe(1);
  });
  it("the only throws are the re-throws of the sanctioned error of callProvider and the fixed non-JSON guard", () => {
    expect([...src.matchAll(/\bthrow\b/g)]).toHaveLength(3);
    expect(src).toMatch(/throw state\.thrown/);
    expect(src).toMatch(/throw new Error\(""\)/);
  });
});
