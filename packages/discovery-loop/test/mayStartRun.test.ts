// Task 4.3: the start gate `mayStartRun`. Truth table, unknown inputs, type safety, purity, and mutation checks.
//
// Two different kinds of mutation check are kept apart (see the last two describe blocks):
//   (1) MODEL mutants: hand-written alternative implementations inside this file. They prove that the specification check
//       (`matchesSpec`) can tell a wrong gate from the right one. They say nothing about the real file.
//   (2) SOURCE mutants: text mutations of the real file `src/gate/mayStartRun.ts`, transpiled and run. They prove that the same check
//       kills defects in the real code. This is a hand-made list of mutations, not a run of a mutation-testing tool.
// **Validates: Requirements 2.14, 2.15, 2.16, 15.14, 15.15, 15.16**
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import * as gate from "../src/gate/mayStartRun.js";
import { mayStartRun } from "../src/gate/mayStartRun.js";
const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const SOURCE_PATH = join(TEST_DIR, "..", "src", "gate", "mayStartRun.ts");
type Gate = (a: unknown, b: unknown) => unknown;
const asGate = (f: unknown): Gate => f as Gate;
const real = asGate(mayStartRun);
/** Values that a caller outside the type system could pass. None of them is the exact literal. */
const hostileProxy = new Proxy(
  {},
  {
    get: () => {
      throw new Error("property read");
    },
    has: () => {
      throw new Error("has");
    },
    getPrototypeOf: () => {
      throw new Error("prototype read");
    },
  },
);
const UNKNOWN_VALUES: readonly unknown[] = [
  undefined, null, "", " ", "PASS", "Pass", "VERIFIED", "Verified", " pass", "pass ", "pass\0", "pa ss", "verified ", "\tverified", "passed",
  "ok", "true", "blocked", "failed", "unverified", "not_measured",
  0, 1, -1, NaN, 1n, true, false, Symbol("pass"), Symbol.for("verified"),
  [], ["pass"], ["verified"], {}, { status: "verified" }, { status: "pass" }, { payloadAuditConfig: "pass" },
  { checks: [], runId: "r", status: "verified" },
  new String("pass"), new String("verified"),
  { toString: () => "pass" }, { valueOf: () => "pass" }, { toString: () => "verified" },
  { [Symbol.toPrimitive]: () => "pass" }, { [Symbol.toPrimitive]: () => "verified" },
  () => "pass", () => "verified", hostileProxy,
];
const VALID_FIRST: readonly unknown[] = ["pass", "blocked"];
const VALID_SECOND: readonly unknown[] = ["verified", "failed"];
/** The specification: exactly one pair of strictly equal literals gives `true`. */
const spec = (a: unknown, b: unknown): boolean => a === "pass" && b === "verified";
/**
 * The specification check. Returns the list of input pairs on which `candidate` differs from the specification (a result that is not the
 * identical boolean, or a throw, also counts as a difference). An empty list means the candidate matches on the whole domain.
 */
function matchesSpec(candidate: Gate): string[] {
  const first = [...VALID_FIRST, ...UNKNOWN_VALUES];
  const second = [...VALID_SECOND, ...UNKNOWN_VALUES];
  const diffs: string[] = [];
  for (const [i, a] of first.entries()) {
    for (const [j, b] of second.entries()) {
      let got: unknown;
      try {
        got = candidate(a, b);
      } catch {
        got = "threw";
      }
      if (got !== spec(a, b)) diffs.push(`first[${i}] second[${j}]`);
    }
  }
  return diffs;
}
describe("truth table", () => {
  const TABLE: readonly (readonly ["pass" | "blocked", "verified" | "failed", boolean])[] = [
    ["pass", "verified", true],
    ["pass", "failed", false],
    ["blocked", "verified", false],
    ["blocked", "failed", false],
  ];
  it.each(TABLE)("(%s, %s) gives %s", (a, b, expected) => {
    expect(mayStartRun(a, b)).toBe(expected);
  });
  it("is true for exactly one of the four input combinations", () => {
    const trues = TABLE.filter(([a, b]) => mayStartRun(a, b));
    expect(trues).toEqual([["pass", "verified", true]]);
  });
  it("the real function agrees with the specification on the whole domain (valid and unknown values)", () => {
    expect(matchesSpec(real)).toEqual([]);
  });
});
describe("unknown and unverified input fails closed", () => {
  it("returns exactly false for every unknown value in either position, with the other position valid", () => {
    for (const v of UNKNOWN_VALUES) {
      expect(real(v, "verified")).toBe(false);
      expect(real("pass", v)).toBe(false);
      expect(real(v, v)).toBe(false);
    }
  });
  it("missing arguments (an unexecuted or unverified state) give false", () => {
    expect((mayStartRun as unknown as () => unknown)()).toBe(false);
    expect((mayStartRun as unknown as (a: unknown) => unknown)("pass")).toBe(false);
    expect((mayStartRun as unknown as (a: unknown) => unknown)("verified")).toBe(false);
  });
  it("swapped arguments give false", () => {
    expect(real("verified", "pass")).toBe(false);
  });
  it("a whole access-denial result object is not accepted: the status must be passed, not the object", () => {
    expect(real("pass", { status: "verified", runId: "r", checks: [] })).toBe(false);
  });
  it("extra arguments change nothing (no hidden third parameter)", () => {
    const f = mayStartRun as unknown as (...a: unknown[]) => unknown;
    expect(f("pass", "failed", "verified")).toBe(false);
    expect(f("pass", "failed", true, { mock: true })).toBe(false);
    expect(f("blocked", "verified", "pass")).toBe(false);
    expect(f("pass", "verified", false)).toBe(true);
  });
  it("positive control: the exact literals still give true", () => {
    expect(real("pass", "verified")).toBe(true);
  });
});
describe("purity", () => {
  it("has exactly two parameters and the module exports exactly one runtime value", () => {
    expect(mayStartRun.length).toBe(2);
    expect(Object.keys(gate)).toEqual(["mayStartRun"]);
  });
  it("is deterministic and keeps no state across calls", () => {
    const seq = [
      ["pass", "verified"], ["pass", "failed"], ["pass", "verified"], ["blocked", "verified"], ["pass", "verified"], ["blocked", "failed"],
    ] as const;
    const first = seq.map(([a, b]) => mayStartRun(a, b));
    const second = seq.map(([a, b]) => mayStartRun(a, b));
    expect(second).toEqual(first);
    expect(first).toEqual([true, false, true, false, true, false]);
  });
  it("never reads a property or the prototype of its arguments", () => {
    expect(() => real(hostileProxy, hostileProxy)).not.toThrow();
    expect(real(hostileProxy, "verified")).toBe(false);
    expect(real("pass", hostileProxy)).toBe(false);
  });
  it("does not mutate or freeze an object argument", () => {
    const o = { status: "verified" };
    real("pass", o);
    expect(Object.isFrozen(o)).toBe(false);
    expect(o).toEqual({ status: "verified" });
  });
});
// ---------------------------------------------------------------------------------------------------------------------------------
// Type safety. `tsc -b` compiles `src/` only, and Vitest does not type-check, so a `@ts-expect-error` in this file would prove nothing.
// The checks below therefore compile a virtual probe file with the TypeScript compiler API against the real sources and compare the
// diagnostics, as (line, TypeScript code) pairs, with the pairs that each rejected line is expected to produce. The comparison is exact:
// an unexpected, missing, duplicated or differently coded diagnostic, or any diagnostic on an accepted line, fails the test.
// ---------------------------------------------------------------------------------------------------------------------------------
describe("type safety (compiler API over the real sources)", () => {
  const PROBE_PATH = join(TEST_DIR, "__mayStartRunTypeProbe.ts");
  const norm = (p: string): string => resolve(p).replace(/\\/g, "/");
  // Accepted lines come first: none of them may produce any diagnostic.
  const ACCEPTED_LINES: readonly string[] = [
    'import { mayStartRun } from "../src/gate/mayStartRun.js";',
    'import type { AccessDenialStatus, PayloadAuditConfigCheck } from "../src/gate/mayStartRun.js";',
    'import type { AccessDenialResult } from "../src/isolation/types.js";',
    'import type { StartupApproval } from "../src/config/startup.js";',
    "type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;",
    "declare const result: AccessDenialResult;",
    "declare const approval: StartupApproval;",
    "// --- accepted ---",
    'export const g1: boolean = mayStartRun("pass", "verified");',
    'export const g2: boolean = mayStartRun("blocked", "failed");',
    "export const g3: boolean = mayStartRun(approval.payloadAuditConfig, result.status);",
    "export const g4: AccessDenialStatus = result.status;",
    "export const g5: PayloadAuditConfigCheck = approval.payloadAuditConfig;",
    "export const g6: Equals<AccessDenialStatus, AccessDenialResult['status']> = true;",
    "// --- rejected ---",
  ];
  // Each rejected line carries the EXACT list of TypeScript diagnostic codes it must produce (one entry per diagnostic, in any order).
  // The codes follow from the syntax of the line, not from observed output:
  //   2345  "Argument of type X is not assignable to parameter of type Y". The compiler reports only the FIRST failing argument of a call,
  //         so a call with two wrong arguments still gives exactly one 2345.
  //   2554  "Expected 2 arguments, but got N" (wrong argument count; reported before any argument is compared).
  //   2322  "Type X is not assignable to type Y" (an assignment or initializer, not an argument).
  const BAD_PROBES: readonly { readonly text: string; readonly why: string; readonly codes: readonly number[] }[] = [
    { text: 'export const b1 = mayStartRun("verified", "pass");', why: "swapped (first argument fails)", codes: [2345] },
    { text: 'export const b2 = mayStartRun("pass", "pass");', why: "wrong second literal", codes: [2345] },
    { text: 'export const b3 = mayStartRun("verified", "verified");', why: "wrong first literal", codes: [2345] },
    { text: 'export const b4 = mayStartRun("PASS", "verified");', why: "other case", codes: [2345] },
    { text: 'export const b5 = mayStartRun("pass" as string, "verified");', why: "widened string", codes: [2345] },
    { text: 'export const b6 = mayStartRun("pass", result);', why: "whole result object", codes: [2345] },
    { text: 'export const b7 = mayStartRun(approval, "verified");', why: "whole approval object", codes: [2345] },
    { text: 'export const b8 = mayStartRun("pass");', why: "missing argument", codes: [2554] },
    { text: 'export const b9 = mayStartRun("pass", "verified", true);', why: "third argument", codes: [2554] },
    { text: 'export const b10 = mayStartRun(undefined, "verified");', why: "undefined", codes: [2345] },
    { text: 'export const b11 = mayStartRun("pass", null);', why: "null", codes: [2345] },
    { text: 'export const b12: string = mayStartRun("pass", "verified");', why: "the return type is boolean, not string", codes: [2322] },
    { text: 'export const b13: "pass" = "blocked" as PayloadAuditConfigCheck;', why: "the type is not narrowed to pass", codes: [2322] },
  ];
  const PROBE_LINES: readonly string[] = [...ACCEPTED_LINES, ...BAD_PROBES.map((p) => `${p.text} // BAD ${p.why}`)];
  const PROBE_TEXT = PROBE_LINES.join("\n") + "\n";
  /** The expected diagnostics as "line:code" pairs, sorted by line and then by code. A line with two codes appears twice. */
  const expectedPairs: readonly string[] = BAD_PROBES.flatMap((p, i) => p.codes.map((code) => [ACCEPTED_LINES.length + i + 1, code] as const))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([line, code]) => `${line}:TS${code}`);
  it("accepts the intended calls and types, and rejects every BAD line (and only those)", () => {
    const options: ts.CompilerOptions = {
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      verbatimModuleSyntax: true,
      isolatedModules: true,
      target: ts.ScriptTarget.ES2023,
      lib: ["lib.es2023.d.ts"],
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      noEmit: true,
      types: [],
      skipLibCheck: true,
    };
    const host = ts.createCompilerHost(options);
    const isProbe = (f: string): boolean => norm(f) === norm(PROBE_PATH);
    const origGet = host.getSourceFile.bind(host);
    const origExists = host.fileExists.bind(host);
    const origRead = host.readFile.bind(host);
    host.getSourceFile = (f, langOrOptions, onError, shouldCreate) =>
      isProbe(f) ? ts.createSourceFile(f, PROBE_TEXT, langOrOptions, true) : origGet(f, langOrOptions, onError, shouldCreate);
    host.fileExists = (f) => isProbe(f) || origExists(f);
    host.readFile = (f) => (isProbe(f) ? PROBE_TEXT : origRead(f));
    const program = ts.createProgram({ rootNames: [PROBE_PATH], options, host });
    const sf = program.getSourceFile(PROBE_PATH);
    expect(sf).toBeDefined();
    const diagnostics = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)];
    // One entry per diagnostic: nothing is merged. A diagnostic without a position gets line 0, which no expected pair has, so it fails the check.
    const located = diagnostics.map((d) => ({
      line: d.file === undefined || d.start === undefined ? 0 : d.file.getLineAndCharacterOfPosition(d.start).line + 1,
      code: d.code,
      text: ts.flattenDiagnosticMessageText(d.messageText, " | "),
    }));
    const actualPairs = located
      .map((d) => [d.line, d.code] as const)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map(([line, code]) => `${line}:TS${code}`);
    const detail = located.map((d) => `line ${d.line} TS${d.code}: ${d.text}`).join("\n");
    // Exact multiset equality: an unexpected diagnostic (on a BAD line or on any other line), a missing one, a wrong code, or a duplicate fails.
    expect(actualPairs, `actual diagnostics:\n${detail}`).toEqual(expectedPairs);
    expect(BAD_PROBES.length).toBe(13);
    expect(expectedPairs.length).toBe(13);
    // No expected pair falls on an accepted line.
    expect(expectedPairs.every((p) => Number(p.split(":")[0]) > ACCEPTED_LINES.length)).toBe(true);
  }, 120_000);
});
// ---------------------------------------------------------------------------------------------------------------------------------
// (1) MODEL mutants. These are NOT mutations of the real code. They show that `matchesSpec` is sensitive.
// ---------------------------------------------------------------------------------------------------------------------------------
describe("model mutants: the specification check distinguishes wrong gates (hand-written, not the real code)", () => {
  const MODEL_MUTANTS: readonly (readonly [string, Gate])[] = [
    ["OR instead of AND", (a, b) => a === "pass" || b === "verified"],
    ["only the audit input", (a) => a === "pass"],
    ["only the access-denial input", (_a, b) => b === "verified"],
    ["negated audit input (!== blocked)", (a, b) => a !== "blocked" && b === "verified"],
    ["negated access-denial input (!== failed)", (a, b) => a === "pass" && b !== "failed"],
    ["loose equality", (a, b) => a == "pass" && b == "verified"],
    ["truthiness of the access-denial input", (a, b) => a === "pass" && Boolean(b)],
    ["case-insensitive", (a, b) => String(a).toLowerCase() === "pass" && String(b).toLowerCase() === "verified"],
    ["trims whitespace", (a, b) => String(a).trim() === "pass" && String(b).trim() === "verified"],
    ["accepts a whole result object", (a, b) => a === "pass" && (b === "verified" || (typeof b === "object" && b !== null && (b as { status?: unknown }).status === "verified"))],
    ["swapped parameters", (a, b) => b === "pass" && a === "verified"],
    ["always true", () => true],
    ["always false", () => false],
    ["non-boolean result (bitwise AND)", (a, b) => (a === "pass") & (b === "verified")],
    ["throws on unknown input", (a, b) => {
      if (typeof a !== "string" || typeof b !== "string") throw new Error("bad input");
      return a === "pass" && b === "verified";
    }],
    ["reads a property of the second argument", (a, b) => a === "pass" && (b as { x?: unknown }).x === undefined && b === "verified"],
  ];
  it("positive control: a correct model passes the check", () => {
    expect(matchesSpec((a, b) => a === "pass" && b === "verified")).toEqual([]);
  });
  it.each(MODEL_MUTANTS)("kills the model mutant: %s", (_name, mutant) => {
    expect(matchesSpec(mutant).length).toBeGreaterThan(0);
  });
});
// ---------------------------------------------------------------------------------------------------------------------------------
// (2) SOURCE mutants. These mutate the TEXT of the real file and run the result through the same check.
// ---------------------------------------------------------------------------------------------------------------------------------
describe("source mutants: text mutations of the real src/gate/mayStartRun.ts, transpiled and checked", () => {
  const REAL_SOURCE = readFileSync(SOURCE_PATH, "utf8");
  const RETURN_LINE = 'return payloadAuditConfig === "pass" && accessDenial === "verified";';
  function load(source: string): Gate {
    const out = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2023 } });
    const exported: Record<string, unknown> = {};
    new Function("exports", out.outputText)(exported);
    const fn = exported["mayStartRun"];
    if (typeof fn !== "function") throw new Error("mutant does not export mayStartRun");
    return fn as Gate;
  }
  const SOURCE_MUTANTS: readonly (readonly [string, string])[] = [
    ["AND becomes OR", RETURN_LINE.replace("&&", "||")],
    ["AND becomes bitwise AND", RETURN_LINE.replace("&&", "&")],
    ["audit operand removed", 'return accessDenial === "verified";'],
    ["access-denial operand removed", 'return payloadAuditConfig === "pass";'],
    ["audit check negated (!== blocked)", RETURN_LINE.replace('payloadAuditConfig === "pass"', 'payloadAuditConfig !== "blocked"')],
    ["access-denial check negated (!== failed)", RETURN_LINE.replace('accessDenial === "verified"', 'accessDenial !== "failed"')],
    ["strict equality loosened (audit)", RETURN_LINE.replace('payloadAuditConfig === "pass"', 'payloadAuditConfig == "pass"')],
    ["strict equality loosened (both)", RETURN_LINE.replaceAll("===", "==")],
    ["truthiness of the access-denial input", RETURN_LINE.replace('accessDenial === "verified"', "Boolean(accessDenial)")],
    ["literals exchanged", RETURN_LINE.replace('"pass"', '"@1"').replace('"verified"', '"pass"').replace('"@1"', '"verified"')],
    ["always true", "return true;"],
    ["always false", "return false;"],
    ["parameters swapped", RETURN_LINE.replace("payloadAuditConfig ===", "accessDenial ===").replace('accessDenial === "verified"', 'payloadAuditConfig === "verified"')],
    ["reads a property of the second argument", RETURN_LINE.replace("&&", "&& (accessDenial as unknown as string).length > 0 &&")],
  ];
  it("positive control: the unmutated real source passes the specification check", () => {
    expect(RETURN_LINE.length).toBeGreaterThan(0);
    expect(REAL_SOURCE).toContain(RETURN_LINE);
    expect(matchesSpec(load(REAL_SOURCE))).toEqual([]);
  });
  it.each(SOURCE_MUTANTS)("kills the source mutant: %s", (_name, replacement) => {
    const mutated = REAL_SOURCE.replace(RETURN_LINE, replacement);
    expect(mutated).not.toBe(REAL_SOURCE); // the mutation really changed the text
    expect(matchesSpec(load(mutated)).length).toBeGreaterThan(0);
  });
});
