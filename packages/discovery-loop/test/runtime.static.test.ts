// Task 4.9-A and 4.9-B: static checks of `src/runtime/` and of the workspace declarations (source text and JSON only, each check with a
// positive control; nothing is executed). Covers: the closed file list, the import boundary of each file, `@phoenix/*` only through the public
// root entry, no access to the orchestrator, the report side, the approval side or evaluation data, nobody else imports `runtime/` or a sibling
// package, the package entry does not export it, and the workspace graph (declared dependencies, project references, no cycle).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = fileURLToPath(new URL("../", import.meta.url));
const SRC = join(PKG, "src");
const RUNTIME = join(SRC, "runtime");
const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));

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
const files = readdirSync(RUNTIME).filter((f) => f.endsWith(".ts")).sort();
const text = (f: string): string => readFileSync(join(RUNTIME, f), "utf8");
const json = (p: string): Record<string, unknown> => JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>;

/** The imports each runtime file may have. Exact specifiers, no wildcard. */
const ALLOWED: Record<string, readonly string[]> = {
  "analysisFs.ts": ["node:fs", "node:path", "../schema/types.js"],
  "auditAdapter.ts": ["@phoenix/ai-client"],
  "clocks.ts": [],
  "runnerFactory.ts": ["@phoenix/verifier"],
  "semanticHash.ts": ["@phoenix/ai-client"],
  "startupInputs.ts": ["./analysisFs.js"],
  "startupPorts.ts": ["@phoenix/ai-client", "@phoenix/verifier", "../config/index.js", "./startupInputs.js"],
};
const outside = (file: string, source: string): string[] => specifiersOf(source).filter((s) => !(ALLOWED[file] ?? []).includes(s));
const PHOENIX_ROOT_ENTRY = /^@phoenix\/(?:ai-client|analyzer|verifier)$/;
const deepPhoenix = (source: string): string[] => specifiersOf(source).filter((s) => s.startsWith("@phoenix/") && !PHOENIX_ROOT_ENTRY.test(s));
const reachesOtherPackage = (source: string): string[] => specifiersOf(source).filter((s) => /(^|\/)(ai-client|analyzer|verifier)\/(src|dist)\b/.test(s) || /\.\.\/\.\.\//.test(s));
const FORBIDDEN_WORDS = /evaluation|ground[_ -]?truth|approv|override|ApprovalReader|\breport\b|process\.env|node:child_process|node:net|node:http|\bfetch\s*\(/i;
/**
 * Every forbidden word found in a source: in the CODE (comments removed, string literals blanked) and in every module SPECIFIER (import,
 * export-from, dynamic import, require). A forbidden word that is only inside an ordinary string literal or a comment is not reported.
 */
const forbiddenIn = (source: string): string[] => [
  ...[...code(source).matchAll(new RegExp(FORBIDDEN_WORDS.source, "gi"))].map((m) => m[0]),
  ...specifiersOf(source).flatMap((s) => [...s.matchAll(new RegExp(FORBIDDEN_WORDS.source, "gi"))].map((m) => m[0])),
];
const mentionsOrchestrator = (source: string): boolean => specifiersOf(source).some((s) => /(^|\/)orchestrator(\/|$)/.test(s));
const mentionsRuntime = (source: string): boolean => specifiersOf(source).some((s) => /(^|\/)runtime(\/|$)/.test(s));
const mentionsSibling = (source: string): boolean => specifiersOf(source).some((s) => s.startsWith("@phoenix/"));

describe("the folder", () => {
  it("holds exactly the planned files", () => {
    expect(files).toEqual(["analysisFs.ts", "auditAdapter.ts", "clocks.ts", "runnerFactory.ts", "semanticHash.ts", "startupInputs.ts", "startupPorts.ts"]);
    expect(Object.keys(ALLOWED).sort()).toEqual(files);
  });
});

describe("(a) the import boundary of each file", () => {
  it("every import is on the exact list of its file", () => {
    for (const f of files) expect(outside(f, text(f)), f).toEqual([]);
  });
  it("positive control: a foreign import is reported", () => {
    expect(outside("clocks.ts", 'import fs from "node:fs";')).toEqual(["node:fs"]);
    expect(outside("semanticHash.ts", 'import { x } from "@phoenix/verifier";')).toEqual(["@phoenix/verifier"]);
    expect(outside("auditAdapter.ts", 'import { y } from "../orchestrator/types.js";')).toEqual(["../orchestrator/types.js"]);
    expect(outside("analysisFs.ts", 'import { z } from "node:fs";')).toEqual([]);
  });
  it("only analysisFs.ts imports node:fs or node:path", () => {
    for (const f of files) expect(specifiersOf(text(f)).some((s) => s === "node:fs" || s === "node:path"), f).toBe(f === "analysisFs.ts");
  });
});

describe("(b) @phoenix packages are used only through the public root entry", () => {
  it("no runtime file has a deep import or a path into another package", () => {
    for (const f of files) {
      expect(deepPhoenix(text(f)), f).toEqual([]);
      expect(reachesOtherPackage(text(f)), f).toEqual([]);
    }
  });
  it("positive control", () => {
    expect(deepPhoenix('import { a } from "@phoenix/ai-client/dist/hash.js";')).toEqual(["@phoenix/ai-client/dist/hash.js"]);
    expect(deepPhoenix('import { a } from "@phoenix/discovery-loop";')).toEqual(["@phoenix/discovery-loop"]);
    expect(deepPhoenix('import { a } from "@phoenix/ai-client";')).toEqual([]);
    expect(reachesOtherPackage('import { a } from "../../../ai-client/src/index.js";').length).toBeGreaterThan(0);
    expect(reachesOtherPackage('import { a } from "../schema/types.js";')).toEqual([]);
  });
});

describe("(c) no access to the orchestrator, the report or approval side, evaluation data, the environment or the network", () => {
  it("the code of every runtime file (comments removed, strings blanked) contains none of the forbidden words", () => {
    for (const f of files) expect(code(text(f)).match(FORBIDDEN_WORDS)?.[0], f).toBeUndefined();
  });
  it("no module specifier of any runtime file contains a forbidden word (code and specifiers together)", () => {
    for (const f of files) expect(forbiddenIn(text(f)), f).toEqual([]);
  });
  it("no runtime file imports the orchestrator", () => {
    for (const f of files) expect(mentionsOrchestrator(text(f)), f).toBe(false);
  });
  // This check is about CODE: identifiers, member names and module names outside string literals (strings are blanked on purpose, see the
  // negative control below). It is not a path check: a path string is not evidence of isolation (R15.13), and the read of an evaluation
  // location is refused by the container boundary and measured by the access-denial verification. Inside runtime/, the file system is
  // reachable only through node:fs, which check (a) allows in analysisFs.ts alone, and that adapter reads only below an injected root.
  // Each control is its own test, so that one failing control does not hide the result of the others.
  it.each([
    ["const x = process.env.A;", "process.env"],
    ["const evaluation = 1;", "evaluation"],
    ["readGroundTruth(x);", "GroundTruth"],
    ["new ApprovalReader()", "Approv"],
    ["await fetch(u)", "fetch("],
    ["const o = override();", "override"],
  ])("positive control (code): %j is reported", (bad, word) => {
    expect(code(bad).match(FORBIDDEN_WORDS)?.[0], bad).toBeDefined();
    expect(forbiddenIn(bad).join(" "), bad).toContain(word);
  });
  it.each([
    ["import cp from 'node:child_process';", "node:child_process"],
    ['import { spawn } from "node:child_process";', "node:child_process"],
    ['import net from "node:net";', "node:net"],
    ['import { request } from "node:http";', "node:http"],
    ['export { get } from "node:http";', "node:http"],
    ['const m = await import("node:net");', "node:net"],
    ['const cp = require("node:child_process");', "node:child_process"],
    ['import { r } from "../report/index.js";', "report"],
    ['import { a } from "../evaluation/x.js";', "evaluation"],
  ])("positive control (specifier): %j is reported", (bad, word) => {
    expect(forbiddenIn(bad), bad).toContain(word);
  });
  it.each([
    ['// uses the evaluation folder\nconst a = "evaluation";'],
    ['const s = "node:child_process";'],
    ["const t = 'node:http and node:net';"],
    ['// import net from "node:net";\nconst a = 1;'],
    ['/* import { request } from "node:http"; */\nconst b = 2;'],
    ['const msg = "see the report of the evaluation";'],
  ])("negative control: a forbidden word only in a string literal or a comment is not reported: %j", (ok) => {
    expect(code(ok).match(FORBIDDEN_WORDS), ok).toBeNull();
    expect(forbiddenIn(ok), ok).toEqual([]);
  });
  it("positive and negative control of the orchestrator import check", () => {
    expect(mentionsOrchestrator('import type { LoopDeps } from "../orchestrator/types.js";')).toBe(true);
    expect(mentionsOrchestrator('import { a } from "./clocks.js";')).toBe(false);
  });
});

describe("(d) nothing else in src imports the runtime folder or a sibling package; the package entry does not export it", () => {
  // `main.ts` (task 4.9-B, the composition root) is the only file of src that may import `./runtime/` and `@phoenix/*`. Its exception is not a
  // skip: the test below pins its runtime and sibling imports to an exact list.
  const IMPORTERS: readonly string[] = ["main.ts"];
  const MAIN_RUNTIME_IMPORTS = [
    "./runtime/analysisFs.js", "./runtime/auditAdapter.js", "./runtime/clocks.js", "./runtime/runnerFactory.js", "./runtime/semanticHash.js",
    "./runtime/startupInputs.js", "./runtime/startupPorts.js",
  ];
  const MAIN_SIBLING_IMPORTS = ["@phoenix/ai-client", "@phoenix/analyzer", "@phoenix/verifier"];
  const runtimeAndSiblingOf = (source: string): { runtime: string[]; siblings: string[] } => ({
    runtime: [...new Set(specifiersOf(source).filter((s) => /(^|\/)runtime(\/|$)/.test(s)))].sort(),
    siblings: [...new Set(specifiersOf(source).filter((s) => s.startsWith("@phoenix/")))].sort(),
  });
  it("main.ts imports exactly the listed runtime adapters and the three sibling root entries, and nothing of runtime/ is re-exported", () => {
    const source = readFileSync(join(SRC, "main.ts"), "utf8");
    expect(runtimeAndSiblingOf(source)).toEqual({ runtime: [...MAIN_RUNTIME_IMPORTS].sort(), siblings: MAIN_SIBLING_IMPORTS });
    expect(source).not.toMatch(/^\s*export\s*(?:\*|\{[^}]*\})\s*from\s*["']\.\/runtime\//m);
  });
  it("positive control of the main.ts exception: an extra runtime import or a deep sibling import is a difference", () => {
    const extra = runtimeAndSiblingOf('import { a } from "./runtime/other.js";\nimport { b } from "@phoenix/verifier/dist/x.js";');
    expect(extra.runtime).not.toEqual([...MAIN_RUNTIME_IMPORTS].sort());
    expect(extra.siblings).not.toEqual(MAIN_SIBLING_IMPORTS);
  });
  it("holds for every file outside runtime/", () => {
    const all = walk(SRC).filter((f) => !rel(f).startsWith("runtime/"));
    expect(all.map(rel)).toEqual(expect.arrayContaining(["index.ts", "config/startup.ts", "orchestrator/loopOrchestrator.ts"]));
    for (const f of all) {
      if (IMPORTERS.includes(rel(f))) continue;
      const source = readFileSync(f, "utf8");
      expect(mentionsRuntime(source), rel(f)).toBe(false);
      expect(mentionsSibling(source), rel(f)).toBe(false);
    }
  });
  it("positive control", () => {
    expect(mentionsRuntime('import { createTimerPort } from "./runtime/clocks.js";')).toBe(true);
    expect(mentionsRuntime('export * from "../runtime/index.js";')).toBe(true);
    expect(mentionsSibling('import { a } from "@phoenix/verifier";')).toBe(true);
    expect(mentionsRuntime('import { a } from "./other.js";')).toBe(false);
  });
  it("the package entry neither imports nor re-exports anything of runtime/ (import and export specifiers)", () => {
    expect(mentionsRuntime(readFileSync(join(SRC, "index.ts"), "utf8"))).toBe(false);
  });
  it("positive and negative controls of the package entry check", () => {
    for (const bad of [
      'export * from "./runtime/clocks.js";',
      'export * as rt from "./runtime/clocks.js";',
      'export { createTimerPort } from "./runtime/clocks.js";',
      'export type { WallClock } from "./runtime/clocks.js";',
      'export {\n  createAnalysisFs,\n  ANALYSIS_FILE_MAX_BYTES,\n} from "./runtime/analysisFs.js";',
      'import { createTimerPort } from "./runtime/clocks.js";\nexport { createTimerPort };',
      'import * as rt from "./runtime/clocks.js";\nexport default rt;',
      'const m = await import("./runtime/clocks.js");',
    ]) {
      expect(mentionsRuntime(bad), bad).toBe(true);
    }
    for (const ok of [
      "// the runtime exports no Approval writer or reader\nexport * from \"./store/index.js\";",
      "/* the runtime entry point */\nexport const PACKAGE_NAME = \"x\";",
      'export * from "./config/index.js"; // runtime configuration',
    ]) {
      expect(mentionsRuntime(ok), ok).toBe(false);
    }
  });
});

describe("(e) the workspace graph", () => {
  const SIBLINGS = ["ai-client", "analyzer", "verifier"] as const;
  it("discovery-loop declares exactly the three sibling dependencies, as exact versions, and keeps its other dependencies", () => {
    const deps = json(join(PKG, "package.json"))["dependencies"] as Record<string, string>;
    expect(deps).toEqual({
      "@phoenix/ai-client": "0.0.0",
      "@phoenix/analyzer": "0.0.0",
      "@phoenix/verifier": "0.0.0",
      ajv: "8.20.0",
      "ajv-formats": "3.0.1",
    });
  });
  it("every @phoenix package that src/runtime imports is declared", () => {
    const deps = json(join(PKG, "package.json"))["dependencies"] as Record<string, string>;
    for (const f of files) for (const s of specifiersOf(text(f))) if (s.startsWith("@phoenix/")) expect(deps[s], `${f}: ${s}`).toBe("0.0.0");
  });
  it("discovery-loop references exactly the three sibling projects and keeps its compiler settings", () => {
    const ts = json(join(PKG, "tsconfig.json"));
    const refs = (ts["references"] as { path: string }[]).map((r) => r.path).sort();
    expect(refs).toEqual(["../ai-client", "../analyzer", "../verifier"]);
    expect(ts["extends"]).toBe("../../tsconfig.base.json");
    expect(ts["compilerOptions"]).toEqual({ types: ["node"], rootDir: "src", outDir: "dist", tsBuildInfoFile: "dist/.tsbuildinfo" });
    expect(ts["include"]).toEqual(["src/**/*.ts"]);
  });
  it("no cycle: no sibling package declares, references or imports discovery-loop", () => {
    for (const name of SIBLINGS) {
      const dir = join(PACKAGES, name);
      const pkg = json(join(dir, "package.json"));
      for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
        expect(Object.keys((pkg[section] as Record<string, string> | undefined) ?? {}), `${name} ${section}`).not.toContain("@phoenix/discovery-loop");
      }
      expect(json(join(dir, "tsconfig.json"))["references"], name).toBeUndefined();
      for (const f of walk(join(dir, "src"))) {
        expect(specifiersOf(readFileSync(f, "utf8")).filter((s) => /discovery-loop/.test(s)), `${name}/${relative(dir, f)}`).toEqual([]);
      }
    }
  });
  it("the root project lists the siblings before discovery-loop (the build order)", () => {
    const order = (json(join(PKG, "..", "..", "tsconfig.json"))["references"] as { path: string }[]).map((r) => r.path);
    const last = order.indexOf("packages/discovery-loop");
    expect(last).toBe(order.length - 1);
    for (const s of SIBLINGS) expect(order.indexOf(`packages/${s}`)).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("packages/verifier")).toBeLessThan(last);
  });
});