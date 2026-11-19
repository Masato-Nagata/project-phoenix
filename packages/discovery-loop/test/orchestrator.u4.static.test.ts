// Task 4.4, unit U4: static checks of `src/orchestrator/startRun.ts` and `src/orchestrator/deadline.ts` (source text with comments removed;
// each detector with a positive control).
// **Validates: Requirements 11.12, 11.17, 12.14, 15.12, 24.15**
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as deadlineModule from "../src/orchestrator/deadline.js";
import * as startRunModule from "../src/orchestrator/startRun.js";
import { UNSEALED_FAILURE_CODES } from "../src/orchestrator/types.js";

const read = (f: string): string => readFileSync(fileURLToPath(new URL(`../src/orchestrator/${f}`, import.meta.url)), "utf8");
const RAW: Readonly<Record<string, string>> = { "startRun.ts": read("startRun.ts"), "deadline.ts": read("deadline.ts") };
const FILES = Object.keys(RAW);
const raw = (f: string): string => RAW[f] as string;

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const blankStrings = (s: string): string => s.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
const code = (s: string): string => blankStrings(stripComments(s));
const specifiersOf = (source: string): string[] => [...stripComments(source).matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)].map((m) => m[1] as string);
const valueImports = (source: string): string[] => [...stripComments(source).matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1] as string);
const exportsOf = (source: string): string[] => [...stripComments(source).matchAll(/^export\s+(?:async\s+)?(?:function|const|class|interface|type)\s+(\w+)/gm)].map((m) => m[1] as string);

const FORBIDDEN: readonly { id: string; re: RegExp }[] = [
  { id: "process", re: /\bprocess\b|\bglobalThis\b/ },
  { id: "Date", re: /\bDate\b/ },
  { id: "random", re: /Math\.random|getRandomValues|randomUUID/ },
  { id: "platform timer", re: /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bqueueMicrotask\b/ },
  { id: "clock", re: /\bperformance\b|hrtime/ },
  { id: "node module", re: /node:[a-z_/]+/ },
  { id: "dynamic code", re: /\beval\s*\(|new Function\s*\(|\bimport\s*\(|\brequire\s*\(/ },
];
const found = (source: string): string[] => FORBIDDEN.filter((f) => f.re.test(stripComments(source).replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => (/node:/.test(m) ? m : '""')))).map((f) => f.id);

describe("forbidden constructs", () => {
  it("none in either file", () => {
    for (const f of FILES) expect(found(raw(f)), f).toEqual([]);
  });
  it("positive control", () => {
    expect(found("const t = Date.now();")).toContain("Date");
    expect(found("setTimeout(f, 1);")).toContain("platform timer");
    expect(found("performance.now();")).toContain("clock");
    expect(found('import x from "node:timers";')).toContain("node module");
    expect(found("// setTimeout and Date in a comment\nconst a = 1;")).toEqual([]);
  });
});

describe("imports", () => {
  it("each file imports exactly its pinned specifiers; the config and schema imports are type-only", () => {
    expect(specifiersOf(raw("startRun.ts")).sort()).toEqual(["../config/startup.js", "../schema/types.js", "./deadline.js", "./recordWriter.js", "./session.js", "./types.js"]);
    expect(specifiersOf(raw("deadline.ts")).sort()).toEqual(["../schema/types.js", "./session.js", "./types.js"]);
    expect(valueImports(raw("startRun.ts")).sort()).toEqual(["./deadline.js", "./recordWriter.js", "./session.js"]);
    expect(valueImports(raw("deadline.ts"))).toEqual([]);
    // positive control
    expect(valueImports('import { StartupApproval } from "../config/startup.js";')).toEqual(["../config/startup.js"]);
    expect(valueImports('import type { StartupApproval } from "../config/startup.js";')).toEqual([]);
  });
});

describe("the one deadline test", () => {
  it("no file uses deadlineReached in code; both use checkDeadline only through the session", () => {
    for (const f of FILES) expect(code(raw(f)), f).not.toMatch(/\bdeadlineReached\b/);
    expect(code(raw("deadline.ts"))).toMatch(/session\.checkDeadline\(\)/);
    expect(code(raw("startRun.ts"))).not.toMatch(/checkDeadline/); // startRun goes through deadlineCheckpoint
    expect(code("if (s.deadlineReached()) s.raise(x);")).toMatch(/\bdeadlineReached\b/); // positive control
  });
  it("the timer stores `before` BEFORE it calls schedule, and has no fire counter", () => {
    const c = code(raw("deadline.ts"));
    const armBody = c.slice(c.indexOf("const arm = ()"), c.indexOf("const fire ="));
    expect(armBody.indexOf("before = remaining")).toBeGreaterThan(-1);
    expect(armBody.indexOf("before = remaining")).toBeLessThan(armBody.indexOf("timers.schedule("));
    expect(c).not.toMatch(/\bfires?\s*(?:\+\+|\+=)|\bcount\s*(?:\+\+|\+=)|\bMAX_FIRES\b|\bmaxFires\b/);
  });
});

describe("responsibility of startRun.ts", () => {
  const c = code(raw("startRun.ts"));
  it("does not terminate, seal, read the store or touch a later phase", () => {
    expect(c).not.toMatch(/\bterminate\b|\bcreateTerminator\b|\bobserveReads\b|\bobserveAnalysisReads\b|\bcreateLoopOrchestrator\b/);
    expect(c).not.toMatch(/\.seal\(|\.list\(|\.putBlob\(|\.putAiOutput\(|\bRunRecordStore\b|opened\.value\.\w+/);
    expect(c).not.toMatch(/\bdeps\.(?:provider|audit|responseGate|comparator|analysis|analysisFs|repoRoot|manifest|isolation)\b/);
    expect(c).not.toMatch(/\bmayStartRun\b|\bstartGate\(|\bexecute\(/);
    // positive control
    expect(code("await channel.seal(x); deps.provider.complete(r);")).toMatch(/\.seal\(/);
    expect(code("deps.provider.complete(r);")).toMatch(/\bdeps\.(?:provider|audit)\b/);
  });
  it("writes exactly run_started with {} and isolation_checks, through the writer only", () => {
    expect([...c.matchAll(/\bwriter\.append\(/g)]).toHaveLength(2);
    expect(stripComments(raw("startRun.ts"))).toMatch(/writer\.append\("run_started", \{\}, "orchestrator"\)/);
    expect(stripComments(raw("startRun.ts"))).toMatch(/writer\.append\("isolation_checks", isolationChecksPayload\(gate\), "orchestrator"\)/);
  });
  it("no await between the last status check and the run_started write", () => {
    const s = stripComments(raw("startRun.ts"));
    const from = s.indexOf('if (session.terminationStatus().state !== "none")');
    const to = s.indexOf('writer.append("run_started"');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    expect([...s.slice(from, to).matchAll(/\bawait\b/g)]).toHaveLength(1); // the await of the append itself
  });
  // Final fix (R12.14, R24.15): the acceptance check over the writer fails closed. The detector reads the adapter function.
  const adapterOf = (source: string): { found: boolean; raiseBeforeThrow: boolean; constantMessage: boolean } => {
    const body = /function committedRecordsOrStop\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(stripComments(source))?.[1] ?? "";
    const raise = body.indexOf('session.raise("error")');
    const thrown = body.indexOf("throw new Error(");
    return {
      found: body.length > 0,
      raiseBeforeThrow: raise > -1 && thrown > raise,
      constantMessage: /throw new Error\(RECORDS_UNAVAILABLE_MESSAGE\);/.test(body) && !/`|\$\{|throw new Error\([^)]*\+/.test(body),
    };
  };
  it("the acceptance adapter latches error (session.raise) before it throws, and the thrown message is a fixed constant", () => {
    const s = stripComments(raw("startRun.ts"));
    expect(adapterOf(raw("startRun.ts"))).toEqual({ found: true, raiseBeforeThrow: true, constantMessage: true });
    expect(s).toMatch(/const RECORDS_UNAVAILABLE_MESSAGE = "[a-z ]+";/); // a plain string literal, no error text
    expect(s).toMatch(/isAccepted: deps\.policy\.createAcceptanceCheck\(\(\) => committedRecordsOrStop\(writer, session\)\),/);
    expect(s).not.toMatch(/createAcceptanceCheck\(\(\) => writer\.records\(\)\)/);
    expect([...s.matchAll(/\.records\(\)/g)]).toHaveLength(1); // the only read of the records is inside the adapter
    expect(s).toMatch(/if \(r\.ok\) return r\.value;/); // only an ok answer passes the records on
    // positive controls: each defect is reported
    const good = 'function committedRecordsOrStop(w: W, s: S): X {\n  s.raise("error");\n  throw new Error(RECORDS_UNAVAILABLE_MESSAGE);\n}';
    expect(adapterOf(good.replace(/s\.raise/, "session.raise"))).toEqual({ found: true, raiseBeforeThrow: true, constantMessage: true });
    const swapped = 'function committedRecordsOrStop(w: W, s: S): X {\n  throw new Error(RECORDS_UNAVAILABLE_MESSAGE);\n  session.raise("error");\n}';
    expect(adapterOf(swapped).raiseBeforeThrow).toBe(false);
    const templated = 'function committedRecordsOrStop(w: W, s: S): X {\n  session.raise("error");\n  throw new Error(`failed: ${String(e)}`);\n}';
    expect(adapterOf(templated).constantMessage).toBe(false);
    const concatenated = 'function committedRecordsOrStop(w: W, s: S): X {\n  session.raise("error");\n  throw new Error("failed: " + e);\n}';
    expect(adapterOf(concatenated).constantMessage).toBe(false);
    expect(adapterOf("const x = 1;").found).toBe(false);
  });
  it("PhaseRun names no channel", () => {
    const body = /export interface PhaseRun \{([\s\S]*?)\n\}/.exec(stripComments(raw("startRun.ts")))?.[1] ?? "";
    expect(body.length).toBeGreaterThan(0);
    expect(body).not.toMatch(/channel/i);
    expect("readonly terminationChannel: TerminationChannel;").toMatch(/channel/i); // positive control
  });
  it("every failure code it uses is a code of UNSEALED_FAILURE_CODES", () => {
    const s = stripComments(raw("startRun.ts"));
    const mapper = /export function mapRunStartedFailure\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(s)?.[1] ?? "";
    expect(mapper.length).toBeGreaterThan(0);
    const used = new Set([...s.matchAll(/refused\("(\w+)"\)/g), ...mapper.matchAll(/return "(\w+)";/g)].map((m) => m[1] as string));
    expect(used.size).toBeGreaterThan(3);
    for (const u of used) expect((UNSEALED_FAILURE_CODES as readonly string[]).includes(u), u).toBe(true);
  });
});

describe("exported names", () => {
  it("are pinned (text and runtime) and none contains approv", () => {
    expect(exportsOf(raw("startRun.ts")).sort()).toEqual(["PhaseRun", "StartRunResult", "mapRunStartedFailure", "startRun"]);
    expect(exportsOf(raw("deadline.ts")).sort()).toEqual(["DeadlineTimer", "MIN_REARM_MS", "armDeadlineTimer", "deadlineCheckpoint"]);
    expect(Object.keys(startRunModule).sort()).toEqual(["mapRunStartedFailure", "startRun"]);
    expect(Object.keys(deadlineModule).sort()).toEqual(["MIN_REARM_MS", "armDeadlineTimer", "deadlineCheckpoint"]);
    for (const f of FILES) expect(exportsOf(raw(f)).filter((n) => /approv/i.test(n)), f).toEqual([]);
    expect(exportsOf("export function isApproved() {}").filter((n) => /approv/i.test(n))).toEqual(["isApproved"]);
  });
});
