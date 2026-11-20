// Task 4.4, unit U2: static checks of `src/orchestrator/recordWriter.ts` and `src/orchestrator/terminate.ts` (source text with comments removed,
// each detector with a positive control; nothing is started).
// **Validates: Requirements 12.5, 12.13, 12.14, 12.11, 11.15, 11.16**
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as recordWriterModule from "../src/orchestrator/recordWriter.js";
import * as terminateModule from "../src/orchestrator/terminate.js";

const dir = (f: string): string => fileURLToPath(new URL(`../src/orchestrator/${f}`, import.meta.url));
const RAW: Readonly<Record<string, string>> = { "recordWriter.ts": readFileSync(dir("recordWriter.ts"), "utf8"), "terminate.ts": readFileSync(dir("terminate.ts"), "utf8") };
const FILES = Object.keys(RAW);
const raw = (f: string): string => RAW[f] as string;

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const blankStrings = (s: string): string => s.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
const code = (s: string): string => blankStrings(stripComments(s));
const count = (re: RegExp, s: string): number => [...s.matchAll(re)].length;
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
  { id: "timer or clock", re: /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bperformance\b|hrtime|queueMicrotask|\bnowMs\b/ },
  { id: "hash computation", re: /\bcreateHash\b|\bsha256\s*\(|\bsha256Hex\b|\bcrypto\b|\.digest\(/ },
  { id: "eval", re: /\beval\s*\(|new Function\s*\(/ },
  { id: "dynamic import", re: /\bimport\s*\(|\brequire\s*\(/ },
  { id: "node module", re: /node:[a-z_/]+/ },
];
const keepNodeStrings = (s: string): string => stripComments(s).replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, (m) => (/node:/.test(m) ? m : '""'));
const found = (source: string): string[] => FORBIDDEN.filter((f) => f.re.test(keepNodeStrings(source))).map((f) => f.id);

describe("no clock, timer, process, random source, hash computation or dynamic code", () => {
  it("holds for both files", () => {
    for (const f of FILES) expect(found(raw(f)), f).toEqual([]);
  });
  it("positive control", () => {
    expect(found("const t = new Date();")).toContain("Date");
    expect(found("const e = process.env.X;")).toContain("process");
    expect(found("Math.random();")).toContain("random");
    expect(found("setTimeout(f, 1);")).toContain("timer or clock");
    expect(found("performance.now();")).toContain("timer or clock");
    expect(found("session.clock.nowMs();")).toContain("timer or clock");
    expect(found('import { createHash } from "node:crypto";')).toEqual(expect.arrayContaining(["hash computation", "node module"]));
    expect(found("const h = sha256(x);")).toContain("hash computation");
    expect(found("x.update(y).digest('hex');")).toContain("hash computation");
    expect(found("eval(x);")).toContain("eval");
    expect(found('await import("x");')).toContain("dynamic import");
    expect(found("const s = sealed.value.sha256;\n// Date, process and setTimeout( in a comment")).toEqual([]);
  });
  it("no module-level mutable state: no top-level let or var, no top-level collection", () => {
    const bad = (s: string): string[] => [...code(s).matchAll(/^(?:let|var)\s+(\w+)|^const\s+(\w+)\s*(?::[^=]+)?=\s*new\s+(?:Map|Set|WeakMap|WeakSet|Array)\b/gm)].map((m) => (m[1] ?? m[2]) as string);
    for (const f of FILES) expect(bad(raw(f)), f).toEqual([]);
    expect(bad("let counter = 0;")).toEqual(["counter"]);
    expect(bad("const cache = new Map<string, number>();")).toEqual(["cache"]);
  });
});

describe("imports", () => {
  const ALLOWED: Readonly<Record<string, readonly string[]>> = {
    "recordWriter.ts": ["../schema/types.js", "../store/runRecordStore.js"],
    "terminate.ts": ["./recordWriter.js", "./session.js", "./types.js"],
  };
  const EVERY_ALLOWED = ["./types.js", "./session.js", "./terminationLatch.js", "./recordWriter.js", "../schema/types.js", "../store/runRecordStore.js"];
  const outside = (allowed: readonly string[], source: string): string[] => specifiersOf(source).filter((s) => !allowed.includes(s));
  const valueImports = (source: string): string[] => [...stripComments(source).matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1] as string);
  it("each file imports only its pinned specifiers, all within the list of the task", () => {
    for (const f of FILES) {
      expect(outside(ALLOWED[f] as readonly string[], raw(f)), f).toEqual([]);
      expect(outside(EVERY_ALLOWED, raw(f)), f).toEqual([]);
    }
    expect(specifiersOf(raw("recordWriter.ts")).sort()).toEqual(["../schema/types.js", "../store/runRecordStore.js"]);
    expect(specifiersOf(raw("terminate.ts")).sort()).toEqual(["./recordWriter.js", "./session.js", "./types.js"]);
  });
  it("every import is type-only; the store is imported as exactly `import type { RunRecordStore }`", () => {
    for (const f of FILES) expect(valueImports(raw(f)), f).toEqual([]);
    expect(stripComments(raw("recordWriter.ts"))).toMatch(/^import type \{ RunRecordStore \} from "\.\.\/store\/runRecordStore\.js";$/m);
    const storeImports = [...stripComments(raw("recordWriter.ts")).matchAll(/from\s*"\.\.\/store\/[^"]+"/g)];
    expect(storeImports).toHaveLength(1);
    expect(valueImports("import { A } from \"./types.js\";")).toEqual(["./types.js"]);
    expect(outside(EVERY_ALLOWED, 'import type { A } from "../store/secretScanner.js";')).toEqual(["../store/secretScanner.js"]);
    expect(outside(EVERY_ALLOWED, 'import { x } from "../isolation/index.js";')).toEqual(["../isolation/index.js"]);
  });
  it("no store type is named: every store type is derived by indexing the class (WriteError, RecordKind, JsonObject, BlobRef, RecordEnvelope, SealedManifest)", () => {
    const NAMED = /\b(?:WriteError|RecordKind|JsonObject|BlobRef|RecordEnvelope|SealedManifest|OpenError)\b/;
    for (const f of FILES) expect(code(raw(f)), f).not.toMatch(NAMED);
    expect(stripComments(raw("recordWriter.ts"))).toMatch(/Parameters<RunRecordStore\["append"\]>\[0\]/);
    expect(stripComments(raw("recordWriter.ts"))).toMatch(/Awaited<ReturnType<RunRecordStore\[K\]>>/);
    expect(NAMED.test("import type { WriteError } from")).toBe(true);
  });
});

describe("exported names", () => {
  const WRITER_NAMES = ["WRITER_ERROR_CODES", "WriterErrorCode", "WriterResult", "WriterState", "WriterRecordView", "RecordWriter", "TerminationChannel", "RecordWriterParts", "createRecordWriter"];
  const TERMINATE_NAMES = ["TerminationBase", "TerminatorInput", "Terminator", "createTerminator"];
  const SECRETISH = /secret|password|token|apikey|path|payload|response|body|message/i;
  // Two exceptions, each bound to ONE interface (task 4.4 unit U4 final fix): the pinned counter `secretRejections` of `WriterState` (a number of
  // rejections, never a value) and `payload` of `WriterRecordView` (the verifier `RecordView` contract names it so; it holds a committed record
  // payload). A member with the same name in any other interface is NOT excepted.
  const EXCEPTIONS: readonly { readonly iface: string; readonly member: string }[] = [
    { iface: "WriterState", member: "secretRejections" },
    { iface: "WriterRecordView", member: "payload" },
  ];
  const secretishMembers = (byInterface: Readonly<Record<string, readonly string[]>>): string[] =>
    Object.entries(byInterface).flatMap(([iface, names]) =>
      names.filter((n) => SECRETISH.test(n) && !EXCEPTIONS.some((e) => e.iface === iface && e.member === n)).map((n) => `${iface}.${n}`),
    );
  it("the exported names of each file are pinned (text and runtime)", () => {
    expect(exportsOf(raw("recordWriter.ts")).sort()).toEqual([...WRITER_NAMES].sort());
    expect(exportsOf(raw("terminate.ts")).sort()).toEqual([...TERMINATE_NAMES].sort());
    expect(Object.keys(recordWriterModule).sort()).toEqual(["WRITER_ERROR_CODES", "createRecordWriter"]);
    expect(Object.keys(terminateModule).sort()).toEqual(["createTerminator"]);
  });
  it("no exported name contains approv (any case)", () => {
    for (const f of FILES) expect(exportsOf(raw(f)).filter((n) => /approv/i.test(n)), f).toEqual([]);
    expect([...Object.keys(recordWriterModule), ...Object.keys(terminateModule)].filter((n) => /approv/i.test(n))).toEqual([]);
    expect(exportsOf("export function isApproved() {}").filter((n) => /approv/i.test(n))).toEqual(["isApproved"]);
  });
  it("no exported identifier and no member of an exported interface is named like a secret or a payload holder (parameters are not members)", () => {
    const members = {
      RecordWriter: membersOf(raw("recordWriter.ts"), "RecordWriter"),
      TerminationChannel: membersOf(raw("recordWriter.ts"), "TerminationChannel"),
      RecordWriterParts: membersOf(raw("recordWriter.ts"), "RecordWriterParts"),
      WriterState: membersOf(raw("recordWriter.ts"), "WriterState"),
      WriterRecordView: membersOf(raw("recordWriter.ts"), "WriterRecordView"),
      Terminator: membersOf(raw("terminate.ts"), "Terminator"),
      TerminatorInput: membersOf(raw("terminate.ts"), "TerminatorInput"),
    };
    expect(members.RecordWriter.sort()).toEqual(["append", "drain", "putAiOutput", "putBlob", "records", "state"]);
    expect(members.WriterRecordView.sort()).toEqual(["id", "kind", "payload"]);
    expect(members.TerminationChannel.sort()).toEqual(["appendTermination", "closeAdmission", "drain", "seal", "state"]);
    expect(members.RecordWriterParts.sort()).toEqual(["channel", "writer"]);
    expect(members.WriterState.sort()).toEqual(["down", "failure", "invalidRecords", "sealed", "secretRejections", "terminationWritten"]);
    expect(members.Terminator).toEqual(["terminate"]);
    expect(members.TerminatorInput.sort()).toEqual(["base", "channel", "manifest", "runId", "session", "startedAt", "wallClock"]);
    for (const f of FILES) expect(exportsOf(raw(f)).filter((n) => SECRETISH.test(n)), f).toEqual([]);
    expect(secretishMembers(members)).toEqual([]);
    // the `append` signature has a parameter named payload; it is a parameter, not a member
    expect(code(raw("recordWriter.ts"))).toMatch(/append\(kind: [^,]+, payload: /);
    // positive control
    expect(membersOf("export interface V {\n  readonly apiKey: string;\n  send(message: string): void;\n  body(): void;\n}", "V")).toEqual(["apiKey", "send", "body"]);
    expect(["apiKey", "send", "body", "ok"].filter((n) => SECRETISH.test(n))).toEqual(["apiKey", "body"]);
  });
  it("the `payload` exception applies to WriterRecordView only; the `secretRejections` exception to WriterState only (positive controls)", () => {
    const view = membersOf("export interface WriterRecordView {\n  readonly id: string;\n  readonly payload: string;\n}", "WriterRecordView");
    const other = membersOf("export interface Other {\n  readonly payload: string;\n}", "Other");
    expect(view).toEqual(["id", "payload"]);
    expect(other).toEqual(["payload"]);
    // the real exception: `payload` in WriterRecordView is allowed
    expect(secretishMembers({ WriterRecordView: view })).toEqual([]);
    // the same member name in any other interface is reported
    expect(secretishMembers({ Other: other })).toEqual(["Other.payload"]);
    expect(secretishMembers({ WriterRecordView: view, Other: other })).toEqual(["Other.payload"]);
    // also in the interfaces of this very file, and `secretRejections` outside WriterState
    expect(secretishMembers({ RecordWriter: ["append", "payload"] })).toEqual(["RecordWriter.payload"]);
    expect(secretishMembers({ WriterState: ["down", "secretRejections"] })).toEqual([]);
    expect(secretishMembers({ WriterRecordView: ["secretRejections"] })).toEqual(["WriterRecordView.secretRejections"]);
    // no real interface of the two files carries a `payload` member except WriterRecordView
    for (const [iface, file] of [
      ["RecordWriter", "recordWriter.ts"],
      ["TerminationChannel", "recordWriter.ts"],
      ["RecordWriterParts", "recordWriter.ts"],
      ["WriterState", "recordWriter.ts"],
      ["Terminator", "terminate.ts"],
      ["TerminatorInput", "terminate.ts"],
    ] as const) {
      expect(membersOf(raw(file), iface), iface).not.toContain("payload");
    }
  });
});

describe("shape of terminate.ts", () => {
  const c = stripComments(raw("terminate.ts"));
  it("`sealed: true` is produced in exactly one place", () => {
    expect(count(/\bsealed:\s*true\b/g, c)).toBe(1);
    expect(count(/\bsealed:\s*true\b/g, "return { sealed: true, summary };\nreturn { sealed: true };")).toBe(2); // positive control
  });
  it("calls each collaborator the planned number of times and nothing else", () => {
    expect(count(/\.build\(/g, c)).toBe(1);
    expect(count(/\.seal\(/g, c)).toBe(1);
    expect(count(/\.appendTermination\(/g, c)).toBe(1);
    expect(count(/\.append\(/g, c)).toBe(0); // the terminator has no ordinary write
    expect(count(/\.nowIso\(/g, c)).toBe(1);
    expect(count(/\.closeAdmission\(/g, c)).toBe(1);
    expect(count(/\.drain\(/g, c)).toBe(1);
    expect(count(/\.state\(/g, c)).toBe(2); // the check before the finalize, and the re-read after it
    expect(count(/\.finalize\(/g, c)).toBe(2); // the first call and the one after the `no_cause` fallback
    expect(count(/\.raise\(/g, c)).toBe(2); // after a rejected write, and the `no_cause` fallback: both raise `error` and nothing else
    expect(count(/\.raise\("error"\)/g, c)).toBe(2);
    expect(c).not.toMatch(/\bwriter\b/); // the terminator never sees the public writer
    expect(c).not.toMatch(/\.abort\(|\.signal\b|\.complete\(|\.execute\(|\.schedule\(|\bprovider\b|\brunner\b/);
    expect(c).not.toMatch(/\.attributeSymptom\(|\.note\w+\(|\.markStarted\(/);
  });
  it("the order in the source is: close admission, drain, state, raise, finalize, state, termination record, wall clock, build, seal", () => {
    const at = [
      "channel.closeAdmission()",
      "await channel.drain()",
      "channel.state()",
      'session.raise("error")',
      "session.finalize()",
      "const after = channel.state()",
      "channel.appendTermination(",
      "wallClock.nowIso()",
      "manifest.build(",
      "channel.seal(",
    ].map((s) => c.indexOf(s));
    expect(at.every((i) => i >= 0)).toBe(true);
    expect([...at]).toEqual([...at].sort((a, b) => a - b));
    // `closeAdmission()` is the first statement of `finish` (no await before it); the try block opens right before it
    expect(c).toMatch(/async function finish\([^)]*\)[^{]*\{[\s\S]*?\btry \{\s*channel\.closeAdmission\(\);/);
    expect(c.slice(c.indexOf("async function finish"), c.indexOf("channel.closeAdmission()"))).not.toMatch(/\bawait\b/);
  });
  it("the Manifest base is derived from ManifestCore (U0 stays the single source) and the hash is read from the store result", () => {
    expect(c).toMatch(/export type TerminationBase = Omit<ManifestCore, "runId" \| "terminationReason" \| "limitsUsed" \| "wallClock">;/);
    expect(c).toMatch(/manifestSha256: sealed\.value\.sha256\b/);
    expect(c).toMatch(/\{ terminationReason: reason \}/);
  });
  it("memoizes: the promise is stored on the first call", () => {
    expect(c).toMatch(/memo \?\?= finish\(input\)/);
    expect(count(/\bfinish\(/g, c)).toBe(2); // the definition and the one call
  });
});

describe("shape of recordWriter.ts", () => {
  const c = stripComments(raw("recordWriter.ts"));
  it("the store is called lazily at call time (so a spy installed after creation is seen) and only through the queue", () => {
    // public append, putBlob, putAiOutput, the internal termination append, and the internal seal
    expect(count(/\bstore\.(?:append|putBlob|putAiOutput|seal)\(/g, c)).toBe(5);
    expect(count(/\bstore\.append\("termination"/g, c)).toBe(1); // the termination record has exactly one writer: the channel
    expect(count(/\bstore\.seal\(/g, c)).toBe(1);
    expect(c).not.toMatch(/\.bind\(/);
    expect(c).toMatch(/tail\.then\(job\)/);
  });
  it("the closed codes are the twelve pinned values", () => {
    expect([...recordWriterModule.WRITER_ERROR_CODES]).toEqual([
      "invalid_record", "secret_rejected", "io_failure", "store_failed", "writer_down", "duplicate_termination", "closed_after_termination", "termination_missing", "already_sealed",
      "evidence_rejected", "admission_closed", "termination_reserved",
    ]);
    expect(recordWriterModule.WRITER_ERROR_CODES).toHaveLength(12);
  });
  it("admission is checked at accept time (before the job is queued); drain takes the tail without a store call; the gates run inside the job", () => {
    expect(c).toMatch(/admissionClosed \? refusedNow<T>\(terminationWritten \? "closed_after_termination" : "admission_closed"\) : start\(\)/);
    expect(count(/\badmit\(/g, c)).toBe(3); // the three ordinary writes (the definition is `const admit = ...`); the two channel writes never use it
    expect(count(/\bexec<\w+>\(\s*afterTermination/g, c)).toBe(3); // the ordinary writes keep the job-time closed_after_termination gate
    expect(c).toMatch(/const drain = \(\): Promise<void> => tail\.then\(noop, noop\);/);
    expect(c).toMatch(/closeAdmission: \(\): void => \{\s*admissionClosed = true;\s*\}/);
    expect(count(/\badmissionClosed = /g, c)).toBe(2); // the declaration and the one assignment, in closeAdmission
    expect(c).toMatch(/secretRejections > 0 \? "evidence_rejected"/);
    expect(count(/"evidence_rejected"/g, c)).toBe(3); // the code list and the two queue-time gates
    expect(c).toMatch(/kind === "termination"\s*\? refusedNow<AppendOk>\("termination_reserved"\)/);
  });
  it("authority: no registry, map, symbol or lookup leads from the public writer to the channel; only terminate.ts names the channel type", () => {
    const REGISTRY = /\b(?:WeakMap|WeakSet|WeakRef|Map|Set|Symbol|FinalizationRegistry|Reflect|Proxy|registry)\b|\bgetOwnPropertySymbols\b/;
    expect(code(c)).not.toMatch(REGISTRY);
    expect(REGISTRY.test("const r = new WeakMap<object, object>();")).toBe(true); // positive control
    expect(REGISTRY.test("export const k = Symbol('x');")).toBe(true);
    // the only runtime exports are the code list and the factory, and the factory takes a store (never a writer)
    expect(Object.keys(recordWriterModule).sort()).toEqual(["WRITER_ERROR_CODES", "createRecordWriter"]);
    expect(code(c)).toMatch(/export function createRecordWriter\(store: RunRecordStore\): RecordWriterParts \{/);
    expect(count(/^export (?:async )?function /gm, code(c))).toBe(1);
    // the public writer object carries no member that refers to the channel
    const writerBlock = /const writer = Object\.freeze\(\{([\s\S]*?)\} satisfies RecordWriter\)/.exec(code(c))?.[1] ?? "";
    expect(writerBlock.length).toBeGreaterThan(0);
    expect(writerBlock).not.toMatch(/\bchannel\b|\bseal\b|appendTermination|closeAdmission|store\.seal|store\.append\("termination"/);
    expect(code(c)).toMatch(/return Object\.freeze\(\{ writer, channel \}\);/);
    // `channel` is created after `writer` and `writer` never mentions it (checked above); the factory result is the only link, held by the composition code
    expect(code(c).indexOf("const writer =")).toBeLessThan(code(c).indexOf("const channel ="));
    // only terminate.ts (and the writer file itself) uses the channel, in the whole orchestrator source folder. startRun.ts (unit U4) creates the
    // writer and HANDS the channel on as a separate result field, so it may name the type `TerminationChannel`, and nothing else of the channel.
    const others = readdirSync(dir("")).filter((f) => f.endsWith(".ts") && f !== "recordWriter.ts" && f !== "terminate.ts");
    expect(others.length).toBeGreaterThan(0);
    for (const f of others) {
      const forbidden = f === "startRun.ts" ? /\bRecordWriterParts\b|\bcloseAdmission\b|\bappendTermination\b/ : /\bTerminationChannel\b|\bRecordWriterParts\b|\bcloseAdmission\b|\bappendTermination\b/;
      expect(stripComments(readFileSync(dir(f), "utf8")), f).not.toMatch(forbidden);
    }
    // startRun.ts never calls a channel method: the channel only flows through to its result
    expect(stripComments(readFileSync(dir("startRun.ts"), "utf8"))).not.toMatch(/\bchannel\.\w+/);
    expect(stripComments(raw("terminate.ts"))).toMatch(/\bTerminationChannel\b/);
    expect(stripComments(raw("terminate.ts"))).not.toMatch(/\bRecordWriter\b|\bcreateRecordWriter\b/);
  });
  it("no result copies a message, a pattern id or a path of the store", () => {
    expect(code(c)).not.toMatch(/\.message\b|\.patternId\b|\.rejectionRecordId\b|\.path\b/);
    expect(c).not.toMatch(/console\.|logger|JSON\.stringify/);
  });
});
