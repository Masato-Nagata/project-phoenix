// Task 4.2: static checks of the isolation module (independence from the Payload_Auditor and stage B, the single node:fs adapter, no /run/out,
// no waiver, data-only expectation type), each with a positive control. Reads source text only; no evaluation/ access.
// **Validates: Requirements 2.14, 2.15, 15.13, 15.14, 15.16**
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
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
  return importsOf(stripComments(code)).filter((s) => FOREIGN.test(s) || /^\.\.\/(?!schema\/types\.js$)/.test(s));
}
const FS = /(?:^|[^\w])(?:node:)?fs(?:\/promises)?["']/;
const importsFs = (code: string): boolean => importsOf(stripComments(code)).some((s) => FS.test(`${s}"`) || s === "node:fs" || s === "node:fs/promises" || s === "fs");

describe("independence of the access-denial module", () => {
  it("lists the planned files", () => {
    expect(isoFiles.sort()).toEqual(["attestation.ts", "classify.ts", "importScan.ts", "index.ts", "nodeDeps.ts", "probeSet.ts", "types.ts", "verify.ts", "violation.ts"]);
  });
  it("imports nothing from ai-client, verifier, analyzer, config/startup.ts or mayStartRun (only ../schema/types.js outside the folder)", () => {
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
  });
  it("none of the other runtime sources, and no other package, imports the isolation module", () => {
    const mentions = (code: string): boolean => importsOf(stripComments(code)).some((s) => /(^|\/)isolation(\/|$)/.test(s));
    for (const f of walk(SRC)) {
      if (f.startsWith(ISO)) continue;
      expect(mentions(readFileSync(f, "utf8")), relative(SRC, f)).toBe(false);
    }
    for (const pkg of ["ai-client", "verifier", "analyzer"]) {
      for (const f of walk(join(PKGS, pkg, "src"))) expect(mentions(readFileSync(f, "utf8")), `${pkg}/${relative(join(PKGS, pkg, "src"), f)}`).toBe(false);
    }
  });
  it("positive control: a fixture import of the isolation module is reported", () => {
    const mentions = (code: string): boolean => importsOf(stripComments(code)).some((s) => /(^|\/)isolation(\/|$)/.test(s));
    expect(mentions('import { verifyGroundTruthAccessDenial } from "../isolation/verify.js";')).toBe(true);
    expect(mentions('import { a } from "./other.js";')).toBe(false);
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
