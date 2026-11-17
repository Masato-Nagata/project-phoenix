// Task 4.3: static checks of the start gate (`src/gate/`). Source text only; no evaluation/ access, no execution of the gate.
//   - the gate has no import of any kind, so it cannot depend on the access-denial module, the Payload_Auditor, config/startup.ts or any other module;
//   - the modules that produce its two inputs (and the other packages) do not import the gate;
//   - the gate has no waiver, Mock exception, environment, clock, state or branching beyond one strict AND.
// A legitimate import of the gate by a future module (the Loop_Orchestrator of task 4.4, or a test) is NOT reported. Each check has a positive control.
// **Validates: Requirements 2.14, 2.15, 2.16, 15.14, 15.16**
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const GATE = join(SRC, "gate");
const PKGS = fileURLToPath(new URL("../../", import.meta.url));
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const blankStrings = (s: string): string => s.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
const code = (s: string): string => blankStrings(stripComments(s));
/** Every module specifier of a file: `import ... from`, `export ... from`, side-effect `import "x"`, `import("x")` and `require("x")`. */
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
const gateFiles = readdirSync(GATE).filter((f) => f.endsWith(".ts"));
describe("the gate imports nothing", () => {
  it("contains the planned file", () => {
    expect(gateFiles).toContain("mayStartRun.ts");
  });
  it("has no import, re-export, side-effect import, dynamic import or require in any file of src/gate/", () => {
    for (const f of gateFiles) expect(specifiersOf(readFileSync(join(GATE, f), "utf8")), f).toEqual([]);
  });
  it("positive control: every form of dependency is reported, including the forbidden modules by name", () => {
    for (const bad of [
      'import { verifyGroundTruthAccessDenial } from "../isolation/verify.js";',
      'import type { AccessDenialResult } from "../isolation/types.js";',
      'import { checkStartupRefusals } from "../config/startup.js";',
      'import { auditConfig } from "../../../ai-client/src/index.js";',
      'import { run } from "@phoenix/verifier";',
      'export * from "./other.js";',
      'export { a } from "./other.js";',
      'import "./sideEffect.js";',
      'const m = await import("./lazy.js");',
      'const r = require("./cjs");',
    ]) {
      expect(specifiersOf(bad).length, bad).toBeGreaterThan(0);
    }
    expect(specifiersOf('// import { x } from "../isolation/types.js";\n/* import y from "z"; */\nexport const a = 1;')).toEqual([]);
    expect(specifiersOf('const s = "not an import";')).toEqual([]);
  });
});
describe("no producer of a gate input, and no other package, imports the gate", () => {
  const rel = (f: string): string => relative(SRC, f).split(sep).join("/");
  /** The modules that must stay independent of the gate: the access-denial module and stage B of start-up (task 4.1). Others may import it. */
  const isForbiddenImporter = (relPath: string): boolean => relPath.startsWith("isolation/") || relPath === "config/startup.ts";
  const mentionsGate = (source: string): boolean => specifiersOf(source).some((s) => /(^|\/)gate(\/|$)|mayStartRun/.test(s));
  it("the access-denial module (src/isolation/) and config/startup.ts do not import the gate", () => {
    const files = walk(SRC).filter((f) => isForbiddenImporter(rel(f)));
    expect(files.map(rel)).toContain("config/startup.ts");
    expect(files.some((f) => rel(f).startsWith("isolation/"))).toBe(true);
    for (const f of files) expect(mentionsGate(readFileSync(f, "utf8")), rel(f)).toBe(false);
  });
  it("ai-client, verifier and analyzer (the Payload_Auditor and the other packages) do not import the gate", () => {
    for (const pkg of ["ai-client", "verifier", "analyzer"]) {
      const dir = join(PKGS, pkg, "src");
      for (const f of walk(dir)) expect(mentionsGate(readFileSync(f, "utf8")), `${pkg}/${relative(dir, f)}`).toBe(false);
    }
  });
  it("positive control: an import of the gate from a forbidden module is reported", () => {
    const fixtures: readonly (readonly [string, string])[] = [
      ["isolation/verify.ts", 'import { mayStartRun } from "../gate/mayStartRun.js";'],
      ["isolation/types.ts", 'import type { AccessDenialStatus } from "../gate/mayStartRun.js";'],
      ["config/startup.ts", 'import { mayStartRun } from "../gate/mayStartRun.js";'],
      ["config/startup.ts", 'export * from "../gate/mayStartRun.js";'],
    ];
    for (const [path, source] of fixtures) {
      expect(isForbiddenImporter(path), path).toBe(true);
      expect(mentionsGate(source), source).toBe(true);
    }
  });
  it("a legitimate import of the gate is not reported: the future Loop_Orchestrator (task 4.4) and any other module may import it", () => {
    const legit = 'import { mayStartRun } from "../gate/mayStartRun.js";';
    expect(mentionsGate(legit)).toBe(true); // the detector sees the import ...
    for (const path of ["orchestrator/loopOrchestrator.ts", "orchestrator/index.ts", "gate/mayStartRun.ts", "store/runRecordStore.ts", "index.ts"]) {
      expect(isForbiddenImporter(path), path).toBe(false); // ... but it is a violation only for the forbidden importers
    }
    expect(mentionsGate('import { a } from "./other.js";')).toBe(false);
  });
});
describe("the gate has no waiver, environment, clock, state or extra branch (R15.14)", () => {
  const FORBIDDEN: readonly { id: string; re: RegExp }[] = [
    { id: "process/global", re: /\bprocess\b|\bglobalThis\b|\bglobal\b|\bwindow\b/ },
    { id: "node builtin", re: /node:/ },
    { id: "network", re: /\bfetch\s*\(|\bXMLHttpRequest\b|\bWebSocket\b/ },
    { id: "dynamic code", re: /\beval\s*\(|new Function\s*\(|\bimport\s*\(|\brequire\s*\(/ },
    { id: "clock/random", re: /Math\.random|Date\.now|new Date|\bDate\b|performance\.now|hrtime|\bcrypto\b/ },
    { id: "mutable state", re: /\b(?:let|var)\b|\bclass\b|\bstatic\b/ },
    { id: "async/exceptions", re: /\basync\b|\bawait\b|\bPromise\b|\bthrow\b|\btry\b|\bcatch\b/ },
    { id: "extra branch", re: /\|\||\?\?|\?\.|\?|\bif\b|\belse\b|\bswitch\b|\bfor\b|\bwhile\b|\bdo\b/ },
    { id: "waiver vocabulary", re: /\b(?:mock\w*|waiv\w*|skip\w*|fallback\w*|bypass\w*|override\w*|disable\w*|force\w*|exempt\w*|flag\w*|option\w*|config\w*)\b/i },
  ];
  const found = (source: string): string[] => FORBIDDEN.filter((f) => f.re.test(code(source))).map((f) => f.id);
  it("holds for every file of src/gate/", () => {
    for (const f of gateFiles) expect(found(readFileSync(join(GATE, f), "utf8")), f).toEqual([]);
  });
  it("has exactly one return statement, a strict AND of two strict equalities", () => {
    const c = code(readFileSync(join(GATE, "mayStartRun.ts"), "utf8"));
    expect([...c.matchAll(/\breturn\b[^;]*;/g)].map((m) => m[0].replace(/\s+/g, " "))).toEqual(['return payloadAuditConfig === "" && accessDenial === "";']);
    const raw = stripComments(readFileSync(join(GATE, "mayStartRun.ts"), "utf8"));
    expect(raw).toMatch(/return payloadAuditConfig === "pass" && accessDenial === "verified";/);
    expect(c).not.toMatch(/[^=!]==[^=]|!=/);
  });
  it("exports exactly one runtime value (mayStartRun) and two types; no default or star export", () => {
    const c = stripComments(readFileSync(join(GATE, "mayStartRun.ts"), "utf8"));
    expect([...c.matchAll(/^export\s+(?!type\b)(\w+)\s+(\w+)/gm)].map((m) => [m[1], m[2]])).toEqual([["function", "mayStartRun"]]);
    expect([...c.matchAll(/^export\s+type\s+(\w+)/gm)].map((m) => m[1])).toEqual(["PayloadAuditConfigCheck", "AccessDenialStatus"]);
    expect(c).not.toMatch(/export\s+default|export\s*\*|export\s*\{/);
  });
  it("declares exactly two parameters", () => {
    const c = stripComments(readFileSync(join(GATE, "mayStartRun.ts"), "utf8"));
    const m = /export function mayStartRun\(([^)]*)\)/.exec(c);
    expect(m).not.toBeNull();
    expect((m?.[1] ?? "").split(",").map((p) => p.trim()).filter((p) => p.length > 0)).toEqual(["payloadAuditConfig: PayloadAuditConfigCheck", "accessDenial: AccessDenialStatus"]);
  });
  it("positive control: each forbidden construct is reported", () => {
    expect(found("const e = process.env.X;")).toContain("process/global");
    expect(found('import { readFileSync } from "node:fs";')).not.toContain("node builtin"); // strings are blanked: the import check above covers it
    expect(found("const x = node:fs;")).toContain("node builtin");
    expect(found("const t = Date.now();")).toContain("clock/random");
    expect(found("let cache = false;")).toContain("mutable state");
    expect(found("async function f() { await g(); }")).toContain("async/exceptions");
    expect(found("return a === 1 || b === 2;")).toContain("extra branch");
    expect(found("return a ? b : c;")).toContain("extra branch");
    expect(found("function g(mockRun: boolean) {}")).toContain("waiver vocabulary");
    expect(found("const waived = true;")).toContain("waiver vocabulary");
    expect(found("eval(x);")).toContain("dynamic code");
    expect(found("// process is only a comment\nconst a = 1;")).toEqual([]);
    expect(found('export const A = "mock";')).toEqual([]);
  });
});
