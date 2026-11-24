// Task 4.9-B: static checks of the runtime entry point `src/main.ts` and of the fixed instruction templates (source text and file bytes only;
// nothing is executed except pure reads of constants). Each check has a positive control.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TEMPLATE_IDS, TERMINATION_REASON_NAMES, UNSEALED_FAILURE_NAMES } from "../src/main.js";
import { TERMINATION_REASONS, UNSEALED_FAILURE_CODES } from "../src/orchestrator/types.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const TEMPLATES = fileURLToPath(new URL("../data/templates/", import.meta.url));
const MAIN = readFileSync(join(SRC, "main.ts"), "utf8");

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

/** The exact imports of main.ts. No wildcard; a new import needs a new entry here. */
const MAIN_IMPORTS = [
  "node:fs", "node:path", "node:url",
  "@phoenix/ai-client", "@phoenix/analyzer", "@phoenix/verifier",
  "./config/index.js",
  "./isolation/nodeDeps.js",
  "./orchestrator/loopOrchestrator.js", "./orchestrator/runComposition.js",
  "./runtime/analysisFs.js", "./runtime/auditAdapter.js", "./runtime/clocks.js", "./runtime/runnerFactory.js", "./runtime/semanticHash.js",
  "./runtime/startupInputs.js", "./runtime/startupPorts.js",
  "./runtimeFacts/fsReadAdapters.js",
  "./schema/index.js",
  "./store/index.js",
].sort();
const outsideList = (source: string): string[] => [...new Set(specifiersOf(source))].filter((s) => !MAIN_IMPORTS.includes(s));
const FORBIDDEN_SPECIFIER = /(^|\/)(gate|manifest|report|approval|evaluation)(\/|$)|ground[-_]?truth|override|^node:(child_process|net|http|https|dgram|worker_threads)$|^@phoenix\/[^/]+\//i;
const FORBIDDEN_CODE = /\bApprovalReader\b|\bevaluation\b|\bprocess\.exit\s*\(|\bfetch\s*\(|\beval\s*\(|new Function\s*\(/;

describe("main.ts: the import boundary", () => {
  it("imports exactly the listed modules", () => {
    expect([...new Set(specifiersOf(MAIN))].sort()).toEqual(MAIN_IMPORTS);
  });
  it("of the orchestrator, only loopOrchestrator.js and runComposition.js", () => {
    expect(specifiersOf(MAIN).filter((s) => /(^|\/)orchestrator(\/|$)/.test(s)).sort()).toEqual(["./orchestrator/loopOrchestrator.js", "./orchestrator/runComposition.js"]);
  });
  it("no import of a forbidden module or area, no deep @phoenix import, no forbidden code", () => {
    expect(specifiersOf(MAIN).filter((s) => FORBIDDEN_SPECIFIER.test(s))).toEqual([]);
    expect(code(MAIN).match(FORBIDDEN_CODE)?.[0]).toBeUndefined();
  });
  it.each([
    ['import { x } from "./orchestrator/types.js";', true],
    ['import { r } from "./report/index.js";', true],
    ['import { m } from "./manifest/configSection.js";', true],
    ['import { g } from "./gate/mayStartRun.js";', true],
    ['import cp from "node:child_process";', true],
    ['import { h } from "node:http";', true],
    ['import { d } from "@phoenix/ai-client/dist/hash.js";', true],
    ['import { a } from "./config/index.js";', false],
  ] as const)("positive and negative control of the boundary: %j", (src, reported) => {
    const flagged = outsideList(src).length > 0 || specifiersOf(src).some((s) => FORBIDDEN_SPECIFIER.test(s));
    expect(flagged).toBe(reported);
  });
  it.each([["process.exit(1);"], ["const r = new ApprovalReader();"], ["await fetch(u);"]])("positive control of the code check: %j", (src) => {
    expect(code(src).match(FORBIDDEN_CODE)).not.toBeNull();
  });
  it("negative control: a forbidden word in a comment or a string is not code", () => {
    expect(code('// process.exit( is never used\nconst s = "evaluation";').match(FORBIDDEN_CODE)).toBeNull();
  });
  it("the package entry does not export or import main", () => {
    expect(specifiersOf(readFileSync(join(SRC, "index.ts"), "utf8")).filter((s) => /(^|\/)main(\.js)?$/.test(s))).toEqual([]);
    expect(specifiersOf('export * from "./main.js";').filter((s) => /(^|\/)main(\.js)?$/.test(s))).toEqual(["./main.js"]);
  });
});

describe("main.ts: the environment, the nonce, the audit adapter, the exit", () => {
  it("reads the process environment in exactly one place", () => {
    expect(code(MAIN).match(/\bprocess\.env\b/g)).toHaveLength(1);
    expect(code("const a = process.env; const b = process.env.X;").match(/\bprocess\.env\b/g)).toHaveLength(2);
  });
  it("the raw lease nonce goes only to the lease port, composeRun, and the two secret detectors", () => {
    const uses = code(MAIN).split("\n").filter((l) => /\bleaseNonce\b/.test(l)).map((l) => l.trim());
    expect(uses).toHaveLength(5);
    const allowed = [
      /^const leaseNonce = environment\[NONCE_NAME\] \?\? "";$/,
      /^lease: \{ directory: paths\.leaseDir, runId, nonce: leaseNonce, propagationDelayMs, clock, sleeper \},$/,
      /secretValues: \[\{ name: NONCE_NAME, value: leaseNonce \}\]/,
      /secrets: \{ envValues: \[\{ name: NONCE_NAME, value: leaseNonce \}\] \}/,
      /^nonce: leaseNonce,$/,
    ];
    for (const u of uses) expect(allowed.some((re) => re.test(u)), u).toBe(true);
    // positive control: a print of the nonce is not one of the allowed uses
    expect(allowed.some((re) => re.test("write(leaseNonce);"))).toBe(false);
  });
  it("the audit adapter is created once, inside the function of the Run (never at module level)", () => {
    const c = code(MAIN);
    expect(c.match(/\bcreateAuditAdapter\s*[<(]/g)).toHaveLength(1);
    const at = c.search(/\bcreateAuditAdapter\s*[<(]/);
    expect(at).toBeGreaterThan(c.indexOf("async function runChecked("));
    expect(c.lastIndexOf("\nasync function readBakedPolicy(")).toBeGreaterThan(at);
  });
  it("sets process.exitCode and never calls process.exit; the start is guarded by isEntryPoint", () => {
    const c = code(MAIN);
    expect(c).not.toMatch(/\bprocess\.exit\s*\(/);
    expect(c.match(/process\.exitCode = /g)).toHaveLength(2);
    expect(c).toMatch(/\nif \(isEntryPoint\(process\.argv\[1\], import\.meta\.url\)\) \{\n\s+runMain\(\)\.then\(/);
    // the only top-level call is the guarded one: no other statement at column 0 calls a function
    const isTopLevelCall = (l: string): boolean => /^[A-Za-z_$][\w$.]*\s*\(/.test(l) && !/^if\s*\(/.test(l);
    expect(c.split("\n").filter(isTopLevelCall)).toEqual([]);
    expect(["runMain();", "if (x) {"].filter(isTopLevelCall)).toEqual(["runMain();"]);
  });
  it("the output line takes no detail of a sub-module: no `.detail` is read and no `detail` key is written", () => {
    expect(code(MAIN)).not.toMatch(/\.detail\b|\bdetail\s*:/);
    expect(code("const d = composed.error.detail;")).toMatch(/\.detail\b|\bdetail\s*:/);
    expect(code("return outcome(2, x, { code, detail });")).not.toMatch(/\.detail\b|\bdetail\s*:/); // shorthand is caught below
    expect(code(MAIN)).not.toMatch(/\bdetail\b/);
    expect(code("return outcome(2, x, { code, detail });")).toMatch(/\bdetail\b/);
  });
  it("the local lists of termination reasons and unsealed failures equal the orchestrator's", () => {
    expect([...TERMINATION_REASON_NAMES]).toEqual([...TERMINATION_REASONS]);
    expect([...UNSEALED_FAILURE_NAMES]).toEqual([...UNSEALED_FAILURE_CODES]);
  });
});

describe("the fixed instruction templates", () => {
  const ids = Object.values(TEMPLATE_IDS);
  it("the directory holds exactly one file per template id", () => {
    expect(readdirSync(TEMPLATES).sort()).toEqual(ids.map((id) => `${id}.txt`).sort());
    expect(ids).toEqual(["hypothesis-generation-v1", "experiment-generation-v1", "hypothesis-revision-v1"]);
  });
  it.each(Object.values(TEMPLATE_IDS))("%s is ASCII text with LF line ends, no BOM, no CR, no tab, and one final LF", (id) => {
    const bytes = readFileSync(join(TEMPLATES, `${id}.txt`));
    expect(bytes.length).toBeGreaterThan(0);
    expect([...bytes].every((b) => b === 0x0a || (b >= 0x20 && b < 0x7f))).toBe(true);
    expect(bytes[bytes.length - 1]).toBe(0x0a);
    expect(bytes[bytes.length - 2]).not.toBe(0x0a);
    expect(createHash("sha256").update(bytes).digest("hex")).toMatch(/^[0-9a-f]{64}$/);
  });
  it("positive control of the byte check: a BOM, a CR and a tab are refused", () => {
    for (const bad of [Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]), Buffer.from("a\r\n"), Buffer.from("a\tb\n")]) {
      expect([...bad].every((b) => b === 0x0a || (b >= 0x20 && b < 0x7f))).toBe(false);
    }
  });
});