// Task 4.4, stage 2: static checks of `src/orchestrator/` (source text only, each with a positive control; nothing is executed except pure
// reads of constants). Covers: the import boundary, no clock / process / dynamic code, no reverse import of the orchestrator, the narrow use of
// `config/startup.js`, the shape of the start gate (one call per step, in order, consume before the first await, only `loopDeps.isolation`),
// no exported name that contains "approv" (R6.11), and the seventeen keys of `LoopDeps` (task 4.4 unit U0).
// **Validates: Requirements 2.14, 2.15, 2.16, 15.14, 15.15, 15.16**
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { STARTUP_NAME_VOCABULARY } from "../src/index.js";
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
  it("holds exactly the eight planned files", () => {
    expect(files).toEqual(["consume.ts", "envAllowlist.ts", "recordWriter.ts", "session.ts", "startGate.ts", "terminate.ts", "terminationLatch.ts", "types.ts"]);
  });
});

describe("(a) the import boundary", () => {
  const ALLOWED: readonly RegExp[] = [
    /^\.\/(?:consume|envAllowlist|recordWriter|session|startGate|terminate|terminationLatch|types)\.js$/,
    /^\.\.\/gate\/mayStartRun\.js$/,
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
    ]) {
      expect(outside(bad).length, bad).toBeGreaterThan(0);
    }
    expect(outside('import type { Result } from "../schema/types.js";\nimport { a } from "./consume.js";')).toEqual([]);
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
