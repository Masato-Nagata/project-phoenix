// Task 4.2: static checks of the isolation module (independence from the Payload_Auditor and stage B, the single node:fs adapter, no /run/out,
// no waiver, data-only expectation type), each with a positive control. Reads source text only; no evaluation/ access.
// **Validates: Requirements 2.14, 2.15, 15.13, 15.14, 15.16**
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import * as isolation from "../src/isolation/index.js";
import type { IsolationExpectation } from "../src/isolation/types.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const ISO = join(SRC, "isolation");
const PKGS = fileURLToPath(new URL("../../", import.meta.url));

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const importsOf = (code: string): string[] => [...code.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)].map((m) => m[1] as string);
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" || e.name === "dist" ? [] : walk(join(dir, e.name))) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}
const isoFiles = readdirSync(ISO).filter((f) => f.endsWith(".ts"));

const FOREIGN = /ai-client|verifier|analyzer|config\/startup|startup\.js|mayStartRun|@phoenix\//;
function foreignImports(code: string): string[] {
  return importsOf(stripComments(code)).filter((s) => FOREIGN.test(s) || /^\.\.\/(?!(?:schema\/types|canonical\/canonicalJson)\.js$)/.test(s));
}
// Isolation-import rule. relPath is POSIX-style and relative to SRC. Returns the offending specifiers (empty = allowed).
const ISOLATION_SPEC = /(^|\/)isolation(\/|$)/;
const ORCHESTRATOR_ALLOWED = new Set(["../isolation/index.js", "../isolation/types.js"]);
/** The composition root (task 4.9-B) builds the real IsolationDeps: main.ts may import the node:fs adapter, and nothing else of the module. */
const MAIN_ALLOWED = new Set(["./isolation/nodeDeps.js"]);
const mentionsIsolation = (code: string): boolean => importsOf(stripComments(code)).some((s) => ISOLATION_SPEC.test(s));
function isolationViolations(relPath: string, code: string): string[] {
  const parts = relPath.split("/");
  if (parts[0] === "isolation") return [];
  const specs = importsOf(stripComments(code)).filter((s) => ISOLATION_SPEC.test(s));
  if (relPath === "main.ts") return specs.filter((s) => !MAIN_ALLOWED.has(s));
  // only the top level of orchestrator/ may use the two exact public specifiers; nested files may not
  const topLevelOrchestrator = parts.length === 2 && parts[0] === "orchestrator";
  return topLevelOrchestrator ? specs.filter((s) => !ORCHESTRATOR_ALLOWED.has(s)) : specs;
}
const FS = /(?:^|[^\w])(?:node:)?fs(?:\/promises)?["']/;
const importsFs = (code: string): boolean => importsOf(stripComments(code)).some((s) => FS.test(`${s}"`) || s === "node:fs" || s === "node:fs/promises" || s === "fs");

describe("independence of the access-denial module", () => {
  it("lists the planned files", () => {
    expect(isoFiles.sort()).toEqual(["attestation.ts", "bundleHash.ts", "classify.ts", "importScan.ts", "index.ts", "nodeDeps.ts", "probeSet.ts", "types.ts", "verify.ts", "violation.ts"]);
  });
  // (G2-C, 2026-11-27) bundleHash.ts uses the existing canonical JSON; that one module is the only addition to the allowed imports from outside the folder.
  it("imports nothing from ai-client, verifier, analyzer, config/startup.ts or mayStartRun (only ../schema/types.js and ../canonical/canonicalJson.js outside the folder)", () => {
    for (const f of isoFiles) expect(foreignImports(readFileSync(join(ISO, f), "utf8")), f).toEqual([]);
  });
  it("positive control: the checker reports each foreign import", () => {
    for (const bad of [
      'import { x } from "../config/startup.js";',
      'import { y } from "../../../ai-client/src/index.js";',
      'import { z } from "@phoenix/verifier";',
      'import { m } from "../gate/mayStartRun.js";',
      'export * from "../store/index.js";',
    ]) {
      expect(foreignImports(bad).length, bad).toBeGreaterThan(0);
    }
    expect(foreignImports('import type { Json } from "../schema/types.js";\nimport { a } from "./classify.js";')).toEqual([]);
    expect(foreignImports('import { canonicalJson } from "../canonical/canonicalJson.js";')).toEqual([]);
    for (const other of ['import { x } from "../canonical/other.js";', 'import { x } from "../canonical/index.js";', 'import { x } from "../store/index.js";']) expect(foreignImports(other).length, other).toBeGreaterThan(0);
  });
  it("none of the other runtime sources, and no other package, imports the isolation module (orchestrator/ only the public barrel and types)", () => {
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f).split(sep).join("/");
      expect(isolationViolations(rel, readFileSync(f, "utf8")), rel).toEqual([]);
    }
    for (const pkg of ["ai-client", "verifier", "analyzer"]) {
      for (const f of walk(join(PKGS, pkg, "src"))) expect(mentionsIsolation(readFileSync(f, "utf8")), `${pkg}/${relative(join(PKGS, pkg, "src"), f)}`).toBe(false);
    }
  });
  it("positive control: a fixture import of the isolation module is reported", () => {
    expect(isolationViolations("gate/x.ts", 'import { verifyGroundTruthAccessDenial } from "../isolation/verify.js";')).toEqual(["../isolation/verify.js"]);
    expect(isolationViolations("gate/x.ts", 'import { a } from "./other.js";')).toEqual([]);
    expect(mentionsIsolation('import { verifyGroundTruthAccessDenial } from "../isolation/verify.js";')).toBe(true);
    expect(mentionsIsolation('import { a } from "./other.js";')).toBe(false);
  });
  it("positive control: orchestrator/ may import only the public barrel and the types", () => {
    const barrel = 'import { verifyGroundTruthAccessDenial } from "../isolation/index.js";';
    const types = 'import type { IsolationDeps } from "../isolation/types.js";';
    expect(isolationViolations("orchestrator/startGate.ts", barrel)).toEqual([]);
    expect(isolationViolations("orchestrator/types.ts", types)).toEqual([]);
    expect(isolationViolations("orchestrator/startGate.ts", `${barrel}\n${types}`)).toEqual([]);
    for (const spec of ["verify", "nodeDeps", "violation", "attestation", "probeSet", "classify", "importScan"]) {
      const s = `../isolation/${spec}.js`;
      expect(isolationViolations("orchestrator/startGate.ts", `import { a } from "${s}";`), s).toEqual([s]);
    }
    expect(isolationViolations("orchestrator/startGate.ts", 'import { a } from "../isolation";')).toEqual(["../isolation"]);
    expect(isolationViolations("orchestrator/startGate.ts", 'import { a } from "../isolation/";')).toEqual(["../isolation/"]);
    expect(isolationViolations("orchestrator/startGate.ts", 'export * from "../isolation/verify.js";')).toEqual(["../isolation/verify.js"]);
    expect(isolationViolations("orchestrator/startGate.ts", `${barrel}\nimport { b } from "../isolation/nodeDeps.js";`)).toEqual(["../isolation/nodeDeps.js"]);
    expect(isolationViolations("orchestrator/sub/x.ts", 'import { a } from "../../isolation/index.js";')).toEqual(["../../isolation/index.js"]);
    expect(isolationViolations("orchestrator/startGate.ts", 'import { a } from "./other.js";\nimport { b } from "../schema/types.js";')).toEqual([]);
  });
  it("main.ts imports exactly the node:fs adapter of the isolation module", () => {
    const src = readFileSync(join(SRC, "main.ts"), "utf8");
    expect(importsOf(stripComments(src)).filter((s) => ISOLATION_SPEC.test(s))).toEqual(["./isolation/nodeDeps.js"]);
  });
  it("positive control: main.ts may import nodeDeps.js only, and no other file may import nodeDeps.js", () => {
    expect(isolationViolations("main.ts", 'import { createNodeIsolationDeps } from "./isolation/nodeDeps.js";')).toEqual([]);
    for (const spec of ["./isolation/index.js", "./isolation/verify.js", "./isolation/types.js", "./isolation/attestation.js"]) {
      expect(isolationViolations("main.ts", `import { a } from "${spec}";`), spec).toEqual([spec]);
    }
    expect(isolationViolations("runtime/startupPorts.ts", 'import { a } from "../isolation/nodeDeps.js";')).toEqual(["../isolation/nodeDeps.js"]);
    expect(isolationViolations("index.ts", 'import { a } from "./isolation/nodeDeps.js";')).toEqual(["./isolation/nodeDeps.js"]);
  });
  it("positive control: every other directory may not import the isolation module, public or not", () => {
    const cases: [string, string][] = [
      ["store/runRecordStore.ts", "../isolation/index.js"],
      ["config/startup.ts", "../isolation/index.js"],
      ["config/startup.ts", "../isolation/types.js"],
      ["gate/mayStartRun.ts", "../isolation/index.js"],
      ["model/x.ts", "../isolation/index.js"],
      ["index.ts", "./isolation/index.js"],
    ];
    for (const [rel, spec] of cases) expect(isolationViolations(rel, `import { a } from "${spec}";`), `${rel} ${spec}`).toEqual([spec]);
  });
});

describe("only nodeDeps.ts imports node:fs", () => {
  it("holds for the folder", () => {
    for (const f of isoFiles) expect(importsFs(readFileSync(join(ISO, f), "utf8")), f).toBe(f === "nodeDeps.ts");
  });
  it("positive control", () => {
    expect(importsFs('import { promises } from "node:fs";')).toBe(true);
    expect(importsFs('import fs from "node:fs/promises";')).toBe(true);
    expect(importsFs('import { createHash } from "node:crypto";')).toBe(false);
  });
});

describe("the pure modules use no process, network or dynamic code", () => {
  const FORBIDDEN: { id: string; re: RegExp }[] = [
    { id: "process", re: /\bprocess\b/ },
    { id: "child_process/net/http", re: /node:(?:child_process|net|http|https|dgram|dns|worker_threads|vm)/ },
    { id: "fetch", re: /\bfetch\s*\(/ },
    { id: "dynamic import", re: /\bimport\s*\(|\brequire\s*\(/ },
    { id: "eval", re: /\beval\s*\(|new Function\s*\(/ },
    { id: "random/clock", re: /Math\.random|Date\.now|new Date|performance\.now|hrtime/ },
  ];
  // string literals are blanked: the scanner names constructs such as "process" and "eval" as data
  const blank = (s: string): string => s.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, '""');
  const found = (code: string): string[] => FORBIDDEN.filter((f) => f.re.test(blank(stripComments(code)))).map((f) => f.id);
  it("holds for every file except nodeDeps.ts (which uses process only for ids and environment NAMES)", () => {
    for (const f of isoFiles.filter((x) => x !== "nodeDeps.ts")) expect(found(readFileSync(join(ISO, f), "utf8")), f).toEqual([]);
  });
  it("nodeDeps.ts reads only the keys of the environment, never a value", () => {
    const code = stripComments(readFileSync(join(ISO, "nodeDeps.ts"), "utf8"));
    expect([...code.matchAll(/process\.env[^\n;]*/g)].map((m) => m[0])).toEqual(["process.env) },"]);
    expect(code).toMatch(/Object\.keys\(process\.env\)/);
    expect(found(code).filter((x) => x !== "process")).toEqual([]);
  });
  it("positive control", () => {
    expect(found("const e = process.env.X;")).toContain("process");
    expect(found('await import("x");')).toContain("dynamic import");
    expect(found("const t = Date.now();")).toContain("random/clock");
    expect(found("// process is only a comment\nconst a = 1;")).toEqual([]);
  });
});

describe("the module never touches /run/out", () => {
  const code = (f: string): string => stripComments(readFileSync(join(ISO, f), "utf8"));
  it("no source of the folder names /run/out outside comments, except the expected mount list of the attestation check (data, once)", () => {
    for (const f of isoFiles.filter((x) => x !== "attestation.ts")) expect(code(f), f).not.toMatch(/\/run\/out/);
    expect(code("attestation.ts").match(/\/run\/out/g)?.length).toBe(1);
    expect(code("attestation.ts")).toMatch(/^\s*"\/run\/out",$/m);
  });
  it("positive control", () => {
    expect(stripComments('const p = "/run/out/records.jsonl";')).toMatch(/\/run\/out/);
    expect(stripComments("// the module never touches /run/out\nconst a = 1;")).not.toMatch(/\/run\/out/);
  });
});

describe("no waiver (R15.14)", () => {
  it("the verification takes exactly two arguments and the folder exports no waiver-like name", () => {
    expect(isolation.verifyGroundTruthAccessDenial.length).toBe(2);
    expect(Object.keys(isolation).filter((n) => /waive|skip|bypass|disable|override|ignore|allowFail|force|relax/i.test(n))).toEqual([]);
  });
  it("every field of IsolationExpectation is `readonly string` or `readonly string[]`", () => {
    const text = readFileSync(join(ISO, "types.ts"), "utf8");
    const body = /export interface IsolationExpectation \{([\s\S]*?)\n\}/.exec(text)?.[1] ?? "";
    const fields = body.split("\n").map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("//"));
    expect(fields.length).toBeGreaterThan(0);
    for (const l of fields) expect(l, l).toMatch(/^readonly \w+: (?:readonly string\[\]|string);$/);
    // compile-time form of the same statement (checked by tsc when this file is type-checked)
    type AllStrings = { [K in keyof IsolationExpectation]: IsolationExpectation[K] extends string | readonly string[] ? true : false };
    const proof: AllStrings = { allowedEnvNames: true };
    expect(proof.allowedEnvNames).toBe(true);
  });
  it("positive control: the field checker rejects a boolean, an optional and an enum field", () => {
    const re = /^readonly \w+: (?:readonly string\[\]|string);$/;
    for (const bad of ["readonly waive: boolean;", "readonly x?: string;", "readonly mode: 'a' | 'b';", "x: string;"]) expect(re.test(bad), bad).toBe(false);
  });
});

// Task 4.9-E2: where the environment-name constants and the allowed-name list are defined, composed and referenced.
// WHAT THIS PROVES, AND WHAT IT DOES NOT. It scans the identifiers in the source text outside comments. That pins the files in which each
// identifier occurs today: the definition and the one composition in isolation/verify.ts, the barrel re-export of the four Launcher names,
// the one call of composeAllowedEnvNames in orchestrator/envAllowlist.ts, and the places where the allowed list is passed to env_names. Together
// with the import rules above it shows that no AI-client, verifier, analyzer, manifest, store or config source names these identifiers. It does
// NOT prove the data flow of a running program (a renamed alias or a string-built name would escape a text scan); that is covered by the tests
// of the modules themselves. Presence of a NAME in the environment is a different permission from reading a value, from sending anything to an
// AI service and from an Approval; this scan only shows that the list has no other consumer in the source.
describe("the environment-name constants and the allowed-name list (task 4.9-E2)", () => {
  const usesIdentifier = (code: string, name: string): boolean => new RegExp(`\\b${name}\\b`).test(stripComments(code));
  const occurrences = (code: string, name: string): number => [...stripComments(code).matchAll(new RegExp(`\\b${name}\\b`, "g"))].length;
  const filesUsing = (name: string): string[] =>
    walk(SRC)
      .filter((f) => usesIdentifier(readFileSync(f, "utf8"), name))
      .map((f) => relative(SRC, f).split(sep).join("/"))
      .sort();

  it("RUNTIME_BASE_ENV_NAMES occurs outside comments in isolation/verify.ts only: once as the definition and once in the composition", () => {
    expect(filesUsing("RUNTIME_BASE_ENV_NAMES")).toEqual(["isolation/verify.ts"]);
    expect(occurrences(readFileSync(join(ISO, "verify.ts"), "utf8"), "RUNTIME_BASE_ENV_NAMES")).toBe(2);
  });
  it("the public barrel does not re-export RUNTIME_BASE_ENV_NAMES (the package surface is not widened)", () => {
    expect(Object.keys(isolation)).not.toContain("RUNTIME_BASE_ENV_NAMES");
    expect(usesIdentifier(readFileSync(join(ISO, "index.ts"), "utf8"), "RUNTIME_BASE_ENV_NAMES")).toBe(false);
  });
  it("MODULE_ENV_NAMES occurs only in isolation/verify.ts and in the barrel re-export isolation/index.ts", () => {
    expect(filesUsing("MODULE_ENV_NAMES")).toEqual(["isolation/index.ts", "isolation/verify.ts"]);
  });
  it("composeAllowedEnvNames is used outside the isolation folder by orchestrator/envAllowlist.ts only", () => {
    expect(filesUsing("composeAllowedEnvNames").filter((f) => !f.startsWith("isolation/"))).toEqual(["orchestrator/envAllowlist.ts"]);
  });
  it("the allowed list (`allowedEnvNames`) is named only by the isolation types and check, and by the start gate and its result type", () => {
    expect(filesUsing("allowedEnvNames")).toEqual(["isolation/types.ts", "isolation/verify.ts", "orchestrator/startGate.ts", "orchestrator/types.ts"]);
  });
  it("no source of ai-client, verifier or analyzer names the constants, the compose function or the allowed list", () => {
    for (const pkg of ["ai-client", "verifier", "analyzer"]) {
      for (const f of walk(join(PKGS, pkg, "src"))) {
        const code = readFileSync(f, "utf8");
        for (const id of ["MODULE_ENV_NAMES", "RUNTIME_BASE_ENV_NAMES", "composeAllowedEnvNames", "allowedEnvNames"]) {
          expect(usesIdentifier(code, id), `${pkg}/${relative(join(PKGS, pkg, "src"), f)} ${id}`).toBe(false);
        }
      }
    }
  });
  it("positive control: the scanner counts an identifier in code, ignores a comment, and does not match a longer name", () => {
    expect(usesIdentifier("const a = RUNTIME_BASE_ENV_NAMES;", "RUNTIME_BASE_ENV_NAMES")).toBe(true);
    expect(usesIdentifier("// RUNTIME_BASE_ENV_NAMES is only a comment\nconst a = 1;", "RUNTIME_BASE_ENV_NAMES")).toBe(false);
    expect(usesIdentifier("/* RUNTIME_BASE_ENV_NAMES */ const a = 1;", "RUNTIME_BASE_ENV_NAMES")).toBe(false);
    expect(usesIdentifier("const X_RUNTIME_BASE_ENV_NAMES_Y = 1;", "RUNTIME_BASE_ENV_NAMES")).toBe(false);
    expect(occurrences("a(RUNTIME_BASE_ENV_NAMES); b(RUNTIME_BASE_ENV_NAMES);", "RUNTIME_BASE_ENV_NAMES")).toBe(2);
  });
});