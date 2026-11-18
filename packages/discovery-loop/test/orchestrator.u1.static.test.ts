// Task 4.4, unit U1: static and consistency checks of `src/orchestrator/terminationLatch.ts` and `src/orchestrator/session.ts`
// (source text with comments removed, each check with a positive control; nothing is started).
// **Validates: Requirements 11.9, 11.12, 11.16, 11.17, 15.6, 24.12, 24.15**
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as sessionModule from "../src/orchestrator/session.js";
import { ABORTING_REASONS } from "../src/orchestrator/session.js";
import * as latchModule from "../src/orchestrator/terminationLatch.js";
import { TERMINATION_PRIORITY, rankOf } from "../src/orchestrator/terminationLatch.js";
import { TERMINATION_REASONS } from "../src/orchestrator/types.js";

const dir = (f: string): string => fileURLToPath(new URL(`../src/orchestrator/${f}`, import.meta.url));
const RAW: Readonly<Record<string, string>> = { "terminationLatch.ts": readFileSync(dir("terminationLatch.ts"), "utf8"), "session.ts": readFileSync(dir("session.ts"), "utf8") };
const FILES = Object.keys(RAW);
const raw = (f: string): string => RAW[f] as string;

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const blankStrings = (s: string): string => s.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
const code = (s: string): string => blankStrings(stripComments(s));
function specifiersOf(source: string): string[] {
  const found: string[] = [];
  for (const m of stripComments(source).matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) found.push(m[1] as string);
  for (const m of stripComments(source).matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) found.push(m[1] as string);
  return found;
}
const exportsOf = (source: string): string[] => [...stripComments(source).matchAll(/^export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+(\w+)/gm)].map((m) => m[1] as string);
function membersOf(source: string, iface: string): string[] {
  const body = new RegExp(`export interface ${iface}\\b[^{]*\\{([\\s\\S]*?)\\n\\}`).exec(stripComments(source))?.[1] ?? "";
  return [...body.matchAll(/^ {2}(?:readonly )?(\w+)\??\s*[(:]/gm)].map((m) => m[1] as string);
}

const FORBIDDEN: readonly { id: string; re: RegExp }[] = [
  { id: "Date", re: /\bDate\b/ },
  { id: "process", re: /\bprocess\b|\bglobalThis\b/ },
  { id: "random", re: /Math\.random|getRandomValues|randomUUID|randomBytes/ },
  { id: "timer or clock", re: /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bperformance\b|hrtime|queueMicrotask/ },
  { id: "wall clock", re: /\bwallClock\b|\bWallClockPort\b|nowIso/ },
  { id: "timer port", re: /\bTimerPort\b|\btimers\b|\.schedule\(/ },
  { id: "eval", re: /\beval\s*\(|new Function\s*\(/ },
  { id: "dynamic import", re: /\bimport\s*\(|\brequire\s*\(/ },
  { id: "node module", re: /node:[a-z_/]+/ },
];
const keepNodeStrings = (s: string): string => stripComments(s).replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => (/node:/.test(m) ? m : '""'));
const found = (source: string): string[] => FORBIDDEN.filter((f) => f.re.test(keepNodeStrings(source))).map((f) => f.id);

describe("no clock, timer, process, random source or dynamic code", () => {
  it("holds for both files", () => {
    for (const f of FILES) expect(found(raw(f)), f).toEqual([]);
  });
  it("the identifier wallClock does not appear anywhere in either file, comments included", () => {
    for (const f of FILES) expect(raw(f), f).not.toMatch(/wallClock/);
  });
  it("positive control", () => {
    expect(found("const t = new Date();")).toContain("Date");
    expect(found("const e = process.env.X;")).toContain("process");
    expect(found("Math.random();")).toContain("random");
    expect(found("setTimeout(f, 1);")).toContain("timer or clock");
    expect(found("performance.now();")).toContain("timer or clock");
    expect(found("opts.wallClock.nowIso();")).toContain("wall clock");
    expect(found("deps.timers.schedule(1, f);")).toContain("timer port");
    expect(found("eval(x);")).toContain("eval");
    expect(found('import fs from "node:fs";')).toContain("node module");
    expect(found("// Date, process and setTimeout( in a comment\nconst a = 1;")).toEqual([]);
  });
  it("no module-level mutable state: no top-level let or var, and no top-level collection", () => {
    const bad = (s: string): string[] => [...code(s).matchAll(/^(?:let|var)\s+(\w+)|^const\s+(\w+)\s*(?::[^=]+)?=\s*new\s+(?:Map|Set|WeakMap|WeakSet|Array)\b/gm)].map((m) => (m[1] ?? m[2]) as string);
    for (const f of FILES) expect(bad(raw(f)), f).toEqual([]);
    expect(bad("let counter = 0;")).toEqual(["counter"]);
    expect(bad("const cache = new Map<string, number>();")).toEqual(["cache"]);
    expect(bad("const FROZEN = Object.freeze([1]);\nfunction f() { let x = 1; }")).toEqual([]);
  });
});

describe("imports", () => {
  const ALLOWED: Readonly<Record<string, readonly string[]>> = {
    "terminationLatch.ts": ["./types.js", "../schema/types.js"],
    "session.ts": ["./types.js", "../schema/types.js", "./terminationLatch.js"],
  };
  const outside = (f: string, source: string): string[] => specifiersOf(source).filter((s) => !(ALLOWED[f] as readonly string[]).includes(s));
  it("each file imports only the allowed specifiers", () => {
    for (const f of FILES) expect(outside(f, raw(f)), f).toEqual([]);
    expect(specifiersOf(raw("terminationLatch.ts")).sort()).toEqual(["../schema/types.js", "./types.js"]);
    expect(specifiersOf(raw("session.ts")).sort()).toEqual(["../schema/types.js", "./terminationLatch.js", "./types.js"]);
  });
  it("the schema types and the session's types are imported as types only; the latch uses the runtime list TERMINATION_REASONS", () => {
    for (const f of FILES) expect(raw(f), f).toMatch(/import type \{ Result \} from "\.\.\/schema\/types\.js";/);
    expect(raw("session.ts")).toMatch(/import type \{[^}]*\} from "\.\/types\.js";/);
    expect(raw("terminationLatch.ts")).toMatch(/import \{ TERMINATION_REASONS, type TerminationReason \} from "\.\/types\.js";/);
  });
  it("positive control", () => {
    expect(outside("session.ts", 'import { x } from "../store/runRecordStore.js";')).toEqual(["../store/runRecordStore.js"]);
    expect(outside("terminationLatch.ts", 'import { s } from "./session.js";')).toEqual(["./session.js"]); // the latch does not import the session
    expect(outside("session.ts", 'import { l } from "./terminationLatch.js";')).toEqual([]);
    expect(outside("session.ts", 'import fs from "node:fs";')).toEqual(["node:fs"]);
    expect(outside("session.ts", 'import { c } from "../config/limits.js";')).toEqual(["../config/limits.js"]);
  });
});

describe("exported names", () => {
  const LATCH_NAMES = ["SYMPTOMS", "Symptom", "RaiseOutcome", "TerminationStatus", "Attribution", "FinalizeResult", "TerminationLatch", "TERMINATION_PRIORITY", "rankOf", "createTerminationLatch"];
  const SESSION_NAMES = ["ABORTING_REASONS", "RunSessionOptions", "RunSession", "InvalidSessionOptions", "createRunSession"];
  const SECRETISH = /secret|password|token|apikey|path|payload|response|body|message/i;
  it("the exported names of each file are pinned (text and runtime)", () => {
    expect(exportsOf(raw("terminationLatch.ts")).sort()).toEqual([...LATCH_NAMES].sort());
    expect(exportsOf(raw("session.ts")).sort()).toEqual([...SESSION_NAMES].sort());
    expect(Object.keys(latchModule).sort()).toEqual(["SYMPTOMS", "TERMINATION_PRIORITY", "createTerminationLatch", "rankOf"].sort());
    expect(Object.keys(sessionModule).sort()).toEqual(["ABORTING_REASONS", "createRunSession"].sort());
  });
  it("no exported name contains approv (any case)", () => {
    for (const f of FILES) expect(exportsOf(raw(f)).filter((n) => /approv/i.test(n)), f).toEqual([]);
    expect([...Object.keys(latchModule), ...Object.keys(sessionModule)].filter((n) => /approv/i.test(n))).toEqual([]);
    expect(exportsOf("export function isApproved() {}").filter((n) => /approv/i.test(n))).toEqual(["isApproved"]);
  });
  it("no exported name, and no member of the public view types, is named like a secret or a payload holder", () => {
    const session = membersOf(raw("session.ts"), "RunSession");
    const latch = membersOf(raw("terminationLatch.ts"), "TerminationLatch");
    expect(session.sort()).toEqual([
      "attributeSymptom", "checkDeadline", "deadlineAtMs", "deadlineReached", "experimentCount", "finalize", "iterationCount", "limitsUsed", "markStarted", "noteAcceptedExperiment",
      "noteIteration", "noteProviderRetry", "noteRejectedExperiment", "policyRejectionCount", "providerRetryCount", "raise", "remainingMs", "signal", "started",
      "startedAtMs", "terminationStatus",
    ]);
    expect(latch.sort()).toEqual(["attributeSymptom", "finalize", "raise", "status"]);
    for (const f of FILES) expect(exportsOf(raw(f)).filter((n) => SECRETISH.test(n)), f).toEqual([]);
    expect([...session, ...latch].filter((n) => SECRETISH.test(n))).toEqual([]);
    // positive control
    expect(membersOf("export interface V {\n  readonly apiKey: string;\n  readonly rawPath: string;\n  send(message: string): void;\n  body(): void;\n}", "V")).toEqual(["apiKey", "rawPath", "send", "body"]);
    expect(["apiKey", "rawPath", "send", "body", "ok"].filter((n) => SECRETISH.test(n))).toEqual(["apiKey", "rawPath", "body"]);
  });
});

describe("consistency with the existing types", () => {
  it("TERMINATION_PRIORITY and rankOf cover exactly TERMINATION_REASONS, each reason once", () => {
    const flat = TERMINATION_PRIORITY.flatMap((g) => [...g]);
    expect(flat).toHaveLength(TERMINATION_REASONS.length);
    expect(new Set(flat).size).toBe(flat.length);
    expect([...flat].sort()).toEqual([...TERMINATION_REASONS].sort());
    TERMINATION_PRIORITY.forEach((g, i) => {
      for (const r of g) expect(rankOf(r), r).toBe(i);
    });
    expect(TERMINATION_PRIORITY.map((g) => g.length)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 2]);
    for (const r of TERMINATION_REASONS) expect(Number.isInteger(rankOf(r)), r).toBe(true);
  });
  it("ABORTING_REASONS is a subset of TERMINATION_REASONS and contains the five highest-ranked-or-time reasons only", () => {
    for (const r of ABORTING_REASONS) expect((TERMINATION_REASONS as readonly string[]).includes(r), r).toBe(true);
    expect(ABORTING_REASONS).toHaveLength(5);
    expect(new Set(ABORTING_REASONS).size).toBe(5);
    expect(Math.max(...ABORTING_REASONS.map((r) => rankOf(r)))).toBe(4);
    expect(Object.isFrozen(ABORTING_REASONS)).toBe(true);
  });
  it("the Manifest vocabulary is tied in the source: limitsUsed returns ManifestCore['limitsUsed'] (checked by tsc, since src/ is type-checked)", () => {
    expect(raw("session.ts")).toMatch(/limitsUsed\(\): ManifestCore\["limitsUsed"\]/);
    expect(raw("session.ts")).toMatch(/import type \{[^}]*\bManifestCore\b[^}]*\} from "\.\/types\.js";/);
    expect(raw("terminationLatch.ts")).toMatch(/Record<TerminationReason, number>/); // exhaustiveness of the rank table
  });
  it("the stage A range of runSeconds cited in session.ts is the one of the limits table (1..3600)", () => {
    const limits = readFileSync(fileURLToPath(new URL("../src/config/limits.ts", import.meta.url)), "utf8");
    expect(limits).toMatch(/runSeconds: Object\.freeze\(\{ min: 1, max: 3600,/);
    expect(raw("session.ts")).toMatch(/RUN_SECONDS_MIN = 1;/);
    expect(raw("session.ts")).toMatch(/RUN_SECONDS_MAX = 3600;/);
  });
  it("symptoms are not termination reasons, and the sources do not list them as reasons", () => {
    for (const s of latchModule.SYMPTOMS) expect((TERMINATION_REASONS as readonly string[]).includes(s), s).toBe(false);
    expect(latchModule.SYMPTOMS).toHaveLength(4);
  });
});
