// Task 4.4, unit U3: static checks of `src/orchestrator/observeReads.ts` (source text with comments removed, each detector with a positive control;
// nothing is started).
// **Validates: Requirements 15.6, 15.13, 19.7**
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as observeModule from "../src/orchestrator/observeReads.js";

const RAW = readFileSync(fileURLToPath(new URL("../src/orchestrator/observeReads.ts", import.meta.url)), "utf8");

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const SRC = stripComments(RAW);
const specifiersOf = (source: string): string[] => [...stripComments(source).matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)].map((m) => m[1] as string);
const valueImports = (source: string): string[] => [...stripComments(source).matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1] as string);
const exportsOf = (source: string): string[] => [...stripComments(source).matchAll(/^export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+(\w+)/gm)].map((m) => m[1] as string);
function membersOf(source: string, iface: string): string[] {
  const body = new RegExp(`export interface ${iface}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(stripComments(source))?.[1] ?? "";
  return [...body.matchAll(/^ {2}(?:readonly )?(\w+)\??\s*[(:]/gm)].map((m) => m[1] as string);
}

describe("imports", () => {
  it("imports only ./types.js and ../isolation/index.js (the barrel), the barrel once for the function and once for the type", () => {
    expect(specifiersOf(RAW).sort()).toEqual(["../isolation/index.js", "../isolation/index.js", "./types.js"]);
    expect(valueImports(RAW)).toEqual(["../isolation/index.js"]);
    expect(SRC).toMatch(/^import \{ detectIsolationViolation \} from "\.\.\/isolation\/index\.js";$/m);
    expect(SRC).toMatch(/^import type \{ IsolationViolation \} from "\.\.\/isolation\/index\.js";$/m);
    expect(SRC).toMatch(/^import type \{ AnalysisFsPort \} from "\.\/types\.js";$/m);
  });
  it("positive control: other specifiers are seen", () => {
    expect(specifiersOf('import fs from "node:fs";\nimport { a } from "../store/runRecordStore.js";\nimport type { b } from "./session.js";').sort()).toEqual(["../store/runRecordStore.js", "./session.js", "node:fs"]);
    expect(valueImports('import type { A } from "./types.js";\nimport { b } from "./types.js";')).toEqual(["./types.js"]);
  });
});

describe("no clock, process, random source, network or dynamic code", () => {
  const FORBIDDEN: readonly { id: string; re: RegExp }[] = [
    { id: "Date", re: /\bDate\b/ },
    { id: "process", re: /\bprocess\b|\bglobalThis\b/ },
    { id: "timer", re: /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bperformance\b|hrtime/ },
    { id: "random", re: /Math\.random|getRandomValues|randomUUID|randomBytes/ },
    { id: "node module", re: /node:[a-z_/]+/ },
    { id: "dynamic import", re: /\bimport\s*\(|\brequire\s*\(/ },
    { id: "eval", re: /\beval\s*\(|new Function\s*\(/ },
    { id: "network", re: /\bfetch\s*\(|XMLHttpRequest|WebSocket/ },
  ];
  const found = (source: string): string[] => FORBIDDEN.filter((f) => f.re.test(stripComments(source))).map((f) => f.id);
  it("holds", () => {
    expect(found(RAW)).toEqual([]);
  });
  it("positive control", () => {
    expect(found("const t = new Date();")).toContain("Date");
    expect(found("const e = process.env.X;")).toContain("process");
    expect(found("setTimeout(f, 1);")).toContain("timer");
    expect(found("setInterval(f, 1);")).toContain("timer");
    expect(found("Math.random();")).toContain("random");
    expect(found('import fs from "node:fs";')).toContain("node module");
    expect(found('await import("x");')).toContain("dynamic import");
    expect(found('const r = require("x");')).toContain("dynamic import");
    expect(found("fetch(u);")).toContain("network");
    expect(found("// Date, process, setTimeout( and node:fs in a comment\nconst a = 1;")).toEqual([]);
  });
});

describe("no contact with the session, the store, the channel or the probes", () => {
  const MENTIONS = /\b(?:RunRecordStore|RecordWriter|RunSession|IsolationDeps|verifyGroundTruthAccessDenial|nodeDeps|listDir|terminationLatch)\b|\b(?:channel|terminate|session)\b/i;
  it("holds", () => {
    expect(SRC).not.toMatch(MENTIONS);
  });
  it("positive control", () => {
    for (const bad of ["RunRecordStore", "RecordWriter", "channel", "terminate", "session", "RunSession", "terminationLatch", "IsolationDeps", "verifyGroundTruthAccessDenial", "nodeDeps", "listDir"]) {
      expect(MENTIONS.test(`const x = ${bad};`), bad).toBe(true);
    }
    expect(MENTIONS.test("// session in a comment\nconst a = 1;".replace(/\/\/[^\n]*/, ""))).toBe(false);
  });
});

describe("a read failure is always rethrown", () => {
  it("both wrapper methods report and then throw the caught value; nothing else happens in the catch block", () => {
    const shape = /catch \(e\) \{\s*noteFailure\(observer, "(read|stat)", path, e\);\s*throw e;\s*\}/g;
    expect([...SRC.matchAll(shape)].map((m) => m[1])).toEqual(["read", "stat"]);
    expect(SRC.match(/\bthrow e;/g)?.length).toBe(2);
  });
  it("each wrapper method calls the original once, with the same argument, and returns its value as it is", () => {
    expect([...SRC.matchAll(/\bfs\.(\w+)\(([^)]*)\)/g)].map((m) => `${m[1]}(${m[2]})`)).toEqual(["readFile(path)", "lstat(path)"]);
    expect(SRC).toMatch(/return await fs\.readFile\(path\);/);
    expect(SRC).toMatch(/return await fs\.lstat\(path\);/);
  });
  it("no `.catch(` and no fallback value for a failed read", () => {
    expect(SRC).not.toMatch(/\.catch\s*\(|\.then\s*\(|\bPromise\.(?:resolve|allSettled|any|race)\b/);
    expect(SRC).not.toMatch(/\bretry\b|\bsetTimeout\b/i);
  });
  it("positive control: a swallowing catch is not accepted by the shape check", () => {
    const shape = /catch \(e\) \{\s*noteFailure\(observer, "(read|stat)", path, e\);\s*throw e;\s*\}/g;
    expect([...'catch (e) { noteFailure(observer, "read", path, e); return new Uint8Array(); }'.matchAll(shape)]).toEqual([]);
    expect([...'catch (e) { noteFailure(observer, "read", path, e);\n throw e;\n }'.matchAll(shape)]).toHaveLength(1);
    expect(/\.catch\s*\(/.test("p.catch(() => new Uint8Array());")).toBe(true);
  });
  it("the observer has no list: no array, map, set, counter or push in the module", () => {
    expect(SRC).not.toMatch(/\.push\(|\bnew (?:Map|Set|WeakMap|WeakSet|Array)\b|\+\+|\+= /);
    expect(/\.push\(/.test("log.push(path);")).toBe(true);
  });
});

describe("exported names", () => {
  const SECRETISH = /secret|password|token|apikey|content|bytes|body|message/i;
  it("the exported identifiers and runtime names are pinned", () => {
    expect(exportsOf(RAW).sort()).toEqual(["ReadAccess", "ReadObserver", "createReadObserver", "observeAnalysisReads"]);
    expect(Object.keys(observeModule).sort()).toEqual(["createReadObserver", "observeAnalysisReads"]);
  });
  it("no exported identifier contains approv (any case)", () => {
    expect(exportsOf(RAW).filter((n) => /approv/i.test(n))).toEqual([]);
    expect(Object.keys(observeModule).filter((n) => /approv/i.test(n))).toEqual([]);
    expect(exportsOf("export function isApproved() {}").filter((n) => /approv/i.test(n))).toEqual(["isApproved"]);
  });
  it("the members of the exported interfaces are pinned, and none is named like a secret or a payload holder", () => {
    const access = membersOf(RAW, "ReadAccess");
    const observer = membersOf(RAW, "ReadObserver");
    expect(access).toEqual(["op", "path", "errorCode"]);
    expect(observer).toEqual(["report", "firstViolation"]);
    for (const n of [...exportsOf(RAW), ...access, ...observer]) expect(SECRETISH.test(n), n).toBe(false);
    // positive control
    expect(membersOf("export interface V {\n  readonly apiKey: string;\n  send(message: string): void;\n  body(): void;\n}", "V")).toEqual(["apiKey", "send", "body"]);
    expect(["apiKey", "send", "body", "content", "bytes", "token", "secret", "password", "message", "ok"].filter((n) => SECRETISH.test(n))).toEqual([
      "apiKey", "send", "body", "content", "bytes", "token", "secret", "password", "message",
    ].filter((n) => n !== "send"));
  });
});
