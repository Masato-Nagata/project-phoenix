// Task 4.1, stage B: the module has no dependency on the other packages and no I/O, issues approvals only itself, and exports no way to
// register one. A static check of the source text, with positive controls.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.js";
import { isStartupApproval } from "../src/config/startup.js";

const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");
const FORBIDDEN: readonly { id: string; re: RegExp }[] = [
  { id: "node module", re: /node:[a-z_/]+|from\s+["'](?:fs|net|os|path|child_process|http|https|crypto)["']/ },
  { id: "process", re: /\bprocess\b/ },
  { id: "Date", re: /\bDate\b/ },
  { id: "random", re: /Math\.random|getRandomValues|randomUUID|randomBytes/ },
  { id: "clock", re: /\bperformance\b|hrtime|\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b/ },
  { id: "network", re: /\bfetch\s*\(|XMLHttpRequest|WebSocket/ },
  { id: "dynamic import", re: /\bimport\s*\(|\brequire\s*\(/ },
  { id: "eval", re: /\beval\s*\(|new Function\s*\(/ },
];
function violations(source: string, allowed: ReadonlySet<string>): string[] {
  const found = FORBIDDEN.filter((f) => f.re.test(source)).map((f) => f.id);
  for (const m of source.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/gm)) {
    if (!allowed.has(m[1] as string)) found.push(`import ${m[1]}`);
  }
  return found;
}
const STARTUP_IMPORTS = new Set(["../schema/types.js", "./limits.js", "./runConfig.js"]);

describe("stage B: no dependency on the other packages, no I/O", () => {
  const source = read("../src/config/startup.ts");
  it("imports only the schema types, the constants and stage A, and uses no file, network, process, clock, random source or eval", () => {
    expect(violations(source, STARTUP_IMPORTS)).toEqual([]);
    // the words may appear in comments that explain the rule; no code (import or identifier) may name another package
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/ai-client|verifier|analyzer|@phoenix/);
  });
  it("positive control: the checker reports each forbidden use and each foreign import", () => {
    for (const bad of [
      'import { x } from "../../ai-client/src/index.js";',
      'import { y } from "@phoenix/verifier";',
      'import fs from "node:fs";',
      "const t = Date.now();",
      "setTimeout(() => 1, 1);",
      "const r = Math.random();",
      "const e = process.env.X;",
      "await fetch(url);",
      'await import("x");',
      "eval(code);",
    ]) {
      expect(violations(bad, STARTUP_IMPORTS).length, bad).toBeGreaterThan(0);
    }
    expect(violations('import type { Result } from "../schema/types.js";\nconst x = 1;', STARTUP_IMPORTS)).toEqual([]);
  });
});

describe("approvals and validated configurations cannot be registered from outside", () => {
  it("the module exports only the intended names, and neither WeakSet", () => {
    expect(read("../src/config/index.ts")).not.toMatch(/export\s*\{[^}]*isStartupApproval/);
    const names = [...read("../src/config/startup.ts").matchAll(/^export (?:async )?(?:function|const|class|interface|type) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]).sort();
    expect(names).toEqual([
      "AuditLoad", "CredentialView", "EXPECTED_CONFIG_FILES", "LeaseCheckView", "LeaseTimingView", "PolicyLoad", "STARTUP_CHECK_ORDER", "STARTUP_NAME_VOCABULARY", "STARTUP_REFUSAL_CODES",
      "StartupApproval", "StartupCheckId", "StartupPorts", "StartupRefusal", "StartupRefusalCode", "checkStartupRefusals", "isStartupApproval",
    ]);
    const stageA = [...read("../src/config/runConfig.ts").matchAll(/^export (?:async )?(?:function|const|class|interface|type) ([A-Za-z0-9_]+)/gm)].map((m) => m[1]).sort();
    expect(stageA).toEqual(["ConfigIssue", "ConfigIssueCode", "RunConfig", "RunLimits", "isValidatedRunConfig", "validateRunConfig"]);
    expect(read("../src/config/startup.ts")).not.toMatch(/export[^\n]*issuedApprovals/);
    expect(read("../src/config/runConfig.ts")).not.toMatch(/export[^\n]*validatedConfigs/);
  });
  it("the package entry exposes no function that registers, issues or forges an approval or a validated configuration", () => {
    const names = Object.keys(publicApi);
    expect(names).toContain("checkStartupRefusals");
    expect(names).toContain("isValidatedRunConfig");
    // the existing isolation guards (R6.11) allow only `deriveApprovalStatus` among the names that contain "approv"; the approval guard of stage B
    // is therefore reachable from the module path of this package, not from the package entry
    expect(names).not.toContain("isStartupApproval");
    expect(names.filter((n) => /approv/i.test(n))).toEqual(["deriveApprovalStatus"]);
    expect(names.filter((n) => /register|issue|forge|mint|grant|brand/i.test(n))).toEqual([]);
    expect(names.filter((n) => /WeakSet|issued|validatedConfigs/i.test(n))).toEqual([]);
  });
  it("isStartupApproval and isValidatedRunConfig only read: they accept no argument that adds to a set", () => {
    expect(isStartupApproval.length).toBe(1);
    expect(publicApi.isValidatedRunConfig.length).toBe(1);
    const approval = Object.freeze({ payloadAuditConfig: "pass" });
    expect(isStartupApproval(approval)).toBe(false);
    expect(isStartupApproval(approval)).toBe(false); // asking twice registers nothing
  });
});