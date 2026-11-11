import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EXPR_LIMITS,
  EXPR_OPERATORS,
  canonicalExpr,
  evaluate,
  validateDeclarations,
  validateExpr,
  type DerivedDecl,
  type EvalResult,
  type Expr,
  type ExprContext,
  type ExprShape,
  type Json,
  type LookupTable,
} from "../src/index.js";
import { NAME_RE } from "../src/expr/validate.js";

function loadVectors<T>(name: string): T {
  return JSON.parse(readFileSync(new URL(`../test-vectors/${name}`, import.meta.url), "utf8")) as T;
}

interface EvalCase {
  id: string;
  expr: Expr;
  input?: Json;
  derived?: DerivedDecl[];
  tables?: LookupTable[];
  expect: EvalResult;
}
interface EvalVectors { input: Json; derived: DerivedDecl[]; tables: LookupTable[]; cases: EvalCase[] }
interface ValidationCase {
  id: string;
  expr: unknown;
  expect: { valid: true } | { valid: false; issues: { code: string; at: string }[] };
}
interface ValidationVectors { shape: ExprShape; cases: ValidationCase[] }

const evalVectors = loadVectors<EvalVectors>("expr-evaluation.json");
const validationVectors = loadVectors<ValidationVectors>("expr-validation.json");

const lit = (value: number | string | boolean | null): Expr => ({ op: "lit", value });
const emptyCtx = (input: Json = {}): ExprContext => ({ input, derived: [], tables: [] });
const noShape: ExprShape = { derivedNames: [], tableNames: [] };

describe("golden evaluation vectors", () => {
  it("has a non-trivial set of vectors with unique ids", () => {
    const ids = evalVectors.cases.map((c) => c.id);
    expect(ids.length).toBeGreaterThan(100);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it.each(evalVectors.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const ctx: ExprContext = {
      input: c.input ?? evalVectors.input,
      derived: c.derived ?? evalVectors.derived,
      tables: c.tables ?? evalVectors.tables,
    };
    expect(evaluate(c.expr, ctx)).toEqual(c.expect);
  });

  it("every evaluation vector expression passes static validation against its own declarations", () => {
    for (const c of evalVectors.cases) {
      // Runtime-only cases deliberately reference undeclared names.
      if (/undeclared|unknown_table|forward_reference|self_reference|invalid_expression/.test(c.id)) continue;
      const derived = c.derived ?? evalVectors.derived;
      const shape: ExprShape = {
        derivedNames: derived.map((d) => d.name),
        tableNames: (c.tables ?? evalVectors.tables).map((t) => t.name),
      };
      const r = validateExpr(c.expr, shape);
      expect(r.ok, c.id).toBe(true);
    }
  });
});

describe("golden validation vectors", () => {
  it.each(validationVectors.cases.map((c) => [c.id, c] as const))("%s", (_id, c) => {
    const r = validateExpr(c.expr, validationVectors.shape);
    if (c.expect.valid) {
      expect(r.ok).toBe(true);
    } else {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.map((i) => ({ code: i.code, at: i.at }))).toEqual(c.expect.issues);
    }
  });
});

describe("operator vocabulary", () => {
  it("is exactly the generic set of the design", () => {
    expect([...EXPR_OPERATORS].sort()).toEqual(
      ["add", "and", "count", "derived", "elem", "eq", "ge", "gt", "idiv", "if", "input", "is_type",
        "le", "lit", "lookup", "lt", "mul", "ne", "not", "or", "sub", "sum"].sort(),
    );
  });

  it("accepts every listed operator name and rejects a name outside the list", () => {
    for (const op of EXPR_OPERATORS) {
      const r = validateExpr({ op }, noShape);
      expect(r.ok === false && r.error.every((i) => i.code !== "unknown_operator"), op).toBe(true);
    }
    const bad = validateExpr({ op: "total" }, noShape);
    expect(bad.ok === false && bad.error[0]?.code).toBe("unknown_operator");
  });
});

/** Builds an expression of exactly n nodes (n >= 1) with depth <= 3 and at most 16 arguments per node. */
function treeOfNodes(n: number): Expr {
  if (n === 1) return lit(0);
  if (n === 2) return { op: "not", arg: lit(true) };
  const k = Math.min(16, n - 1);
  const base = Math.floor((n - 1) / k);
  const extra = (n - 1) % k;
  const args: Expr[] = [];
  for (let i = 0; i < k; i++) args.push(treeOfNodes(base + (i < extra ? 1 : 0)));
  return { op: "add", args };
}

function countNodes(e: unknown): number {
  if (typeof e !== "object" || e === null) return 0;
  const o = e as Record<string, unknown>;
  let n = typeof o["op"] === "string" ? 1 : 0;
  for (const v of Object.values(o)) n += Array.isArray(v) ? v.reduce((a: number, x) => a + countNodes(x), 0) : countNodes(v);
  return n;
}

function nestedNot(depth: number): Expr {
  let e: Expr = lit(true);
  for (let i = 1; i < depth; i++) e = { op: "not", arg: e };
  return e;
}

const codes = (r: ReturnType<typeof validateExpr>): string[] => (r.ok ? [] : r.error.map((i) => i.code));

describe("static limits", () => {
  it("accepts 200 nodes and rejects 201", () => {
    const e200 = treeOfNodes(200);
    const e201 = treeOfNodes(201);
    expect(countNodes(e200)).toBe(200);
    expect(countNodes(e201)).toBe(201);
    expect(validateExpr(e200, noShape).ok).toBe(true);
    expect(codes(validateExpr(e201, noShape))).toEqual(["node_limit"]);
  });

  it("accepts depth 12 and rejects depth 13, reporting once", () => {
    expect(validateExpr(nestedNot(12), noShape).ok).toBe(true);
    expect(codes(validateExpr(nestedNot(13), noShape))).toEqual(["depth_limit"]);
    expect(codes(validateExpr(nestedNot(500), noShape))).toEqual(["depth_limit"]);
  });

  it("accepts 16 arguments and rejects 17", () => {
    const mk = (n: number): Expr => ({ op: "or", args: Array.from({ length: n }, () => lit(true)) });
    expect(validateExpr(mk(16), noShape).ok).toBe(true);
    expect(codes(validateExpr(mk(17), noShape))).toEqual(["arity"]);
  });

  it("accepts a 256-character string literal and rejects 257", () => {
    expect(validateExpr(lit("a".repeat(256)), noShape).ok).toBe(true);
    expect(codes(validateExpr(lit("a".repeat(257)), noShape))).toEqual(["string_too_long"]);
  });

  it("accepts a 128-character path and rejects 129", () => {
    expect(validateExpr({ op: "input", path: "a".repeat(128) }, noShape).ok).toBe(true);
    expect(codes(validateExpr({ op: "input", path: "a".repeat(129) }, noShape))).toEqual(["bad_path"]);
  });

  it("terminates on a cyclic structure and on hostile input", () => {
    const cyc: Record<string, unknown> = { op: "not" };
    cyc["arg"] = cyc;
    expect(codes(validateExpr(cyc, noShape))).toEqual(["depth_limit"]);
    expect(validateExpr(JSON.parse('{"op":"lit","value":1,"__proto__":{"op":"x"}}'), noShape).ok).toBe(false);
    expect(validateExpr(undefined, noShape).ok).toBe(false);
  });
});

describe("declaration validation", () => {
  const e1: Expr = lit(1);

  it("accepts the golden declarations", () => {
    expect(validateDeclarations(evalVectors.derived, evalVectors.tables).ok).toBe(true);
  });

  it("rejects a reference to a later or the same derived value", () => {
    const r = validateDeclarations(
      [{ name: "a", expr: { op: "derived", name: "b" } }, { name: "b", expr: e1 }], []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.map((i) => [i.code, i.at])).toEqual([["unknown_reference", "/derived/0/expr/name"]]);
    const self = validateDeclarations([{ name: "a", expr: { op: "derived", name: "a" } }], []);
    expect(self.ok).toBe(false);
  });

  it("rejects a reference to an undeclared table and accepts a declared one", () => {
    const d = [{ name: "a", expr: { op: "lookup", table: "t", key: e1 } }];
    expect(validateDeclarations(d, []).ok).toBe(false);
    expect(validateDeclarations(d, [{ name: "t", entries: [{ key: 1, value: 2 }] }]).ok).toBe(true);
  });

  it("enforces counts: 32 derived values, 16 tables, 64 entries", () => {
    const derived = (n: number) => Array.from({ length: n }, (_, i) => ({ name: `d${i}`, expr: e1 }));
    const table = (i: number, n = 1) => ({ name: `t${i}`, entries: Array.from({ length: n }, (_, j) => ({ key: j, value: j })) });
    expect(validateDeclarations(derived(32), []).ok).toBe(true);
    expect(validateDeclarations(derived(33), []).ok).toBe(false);
    expect(validateDeclarations([], Array.from({ length: 16 }, (_, i) => table(i))).ok).toBe(true);
    expect(validateDeclarations([], Array.from({ length: 17 }, (_, i) => table(i))).ok).toBe(false);
    expect(validateDeclarations([], [table(0, 64)]).ok).toBe(true);
    expect(validateDeclarations([], [table(0, 65)]).ok).toBe(false);
    expect(validateDeclarations([], [table(0, 0)]).ok).toBe(false);
  });

  it("rejects duplicate names and duplicate keys, but allows the same text as int and string key", () => {
    expect(validateDeclarations([{ name: "a", expr: e1 }, { name: "a", expr: e1 }], []).ok).toBe(false);
    expect(validateDeclarations([], [{ name: "t", entries: [{ key: 1, value: 1 }] }, { name: "t", entries: [{ key: 1, value: 1 }] }]).ok).toBe(false);
    expect(validateDeclarations([], [{ name: "t", entries: [{ key: "k", value: 1 }, { key: "k", value: 2 }] }]).ok).toBe(false);
    expect(validateDeclarations([], [{ name: "t", entries: [{ key: 1, value: 1 }, { key: "1", value: 2 }] }]).ok).toBe(true);
  });

  it("rejects bad names, bad key kinds, and non-array inputs", () => {
    expect(validateDeclarations([{ name: "1a", expr: e1 }], []).ok).toBe(false);
    expect(validateDeclarations([], [{ name: "t", entries: [{ key: true, value: 1 }] }]).ok).toBe(false);
    expect(validateDeclarations([], [{ name: "t", entries: [{ key: 1.5, value: 1 }] }]).ok).toBe(false);
    expect(validateDeclarations({}, []).ok).toBe(false);
    expect(validateDeclarations([], "x").ok).toBe(false);
  });
});

describe("run-time limits and totality", () => {
  it("returns limit_exceeded when an aggregate would exceed the step limit", () => {
    const leaf = (): Expr => ({ op: "add", args: [lit(1), lit(1), lit(1)] });                 // 4 nodes
    const each: Expr = { op: "add", args: Array.from({ length: 16 }, leaf) };                  // 65 nodes
    const e: Expr = { op: "sum", over: "xs", each };
    const input = { xs: Array.from({ length: 1000 }, () => 0) };
    expect(validateExpr(e, noShape).ok).toBe(true);
    const r = evaluate(e, emptyCtx(input));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("limit_exceeded");
    // Fewer elements stay within the limit: 65 * 700 + 1 = 45,501 steps.
    const small = evaluate(e, emptyCtx({ xs: Array.from({ length: 700 }, () => 0) }));
    expect(small).toEqual({ ok: true, value: 48 * 700 });
  });

  it("returns limit_exceeded for exponential derived-value chains", () => {
    const derived: DerivedDecl[] = [{ name: "d0", expr: lit(1) }];
    for (let i = 1; i < 32; i++) {
      const prev: Expr = { op: "derived", name: `d${i - 1}` };
      derived.push({ name: `d${i}`, expr: { op: "add", args: [prev, prev] } });
    }
    expect(validateDeclarations(derived, []).ok).toBe(true);
    const r = evaluate({ op: "derived", name: "d31" }, { input: {}, derived, tables: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("limit_exceeded");
    expect(evaluate({ op: "derived", name: "d5" }, { input: {}, derived, tables: [] })).toEqual({ ok: true, value: 32 });
  });

  it("accepts 1000 array elements and rejects 1001", () => {
    const e: Expr = { op: "count", over: "xs" };
    expect(evaluate(e, emptyCtx({ xs: new Array(1000).fill(0) as Json[] }))).toEqual({ ok: true, value: 1000 });
    expect(evaluate(e, emptyCtx({ xs: new Array(1001).fill(0) as Json[] }))).toEqual({
      ok: false, error: { code: "limit_exceeded", at: "/over" },
    });
  });

  it("never throws on unvalidated or hostile expressions", () => {
    const hostile: unknown[] = [
      null, undefined, 5, "x", [], {}, { op: "zzz" }, { op: "add" }, { op: "add", args: 5 }, { op: "not" },
      { op: "if" }, { op: "lookup", table: "t" }, { op: "sum", over: "xs" }, { op: "input", path: 7 },
      { op: "idiv", left: lit(1), right: lit(1), round: "sideways" },
    ];
    for (const h of hostile) {
      const r = evaluate(h as Expr, emptyCtx({ xs: [1] }));
      expect(typeof r.ok).toBe("boolean");
    }
  });

  it("returns limit_exceeded, not an exception, for a 100,000-deep unvalidated expression", () => {
    let e: Expr = lit(true);
    for (let i = 0; i < 100000; i++) e = { op: "not", arg: e };
    const r = evaluate(e, emptyCtx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("limit_exceeded");
  });

  it("is deterministic and does not modify the input document", () => {
    const input = JSON.parse(JSON.stringify(evalVectors.input)) as Json;
    const frozen = (v: unknown): void => {
      if (typeof v === "object" && v !== null) { Object.values(v).forEach(frozen); Object.freeze(v); }
    };
    frozen(input);
    const before = JSON.stringify(input);
    for (const c of evalVectors.cases) {
      const ctx: ExprContext = { input, derived: evalVectors.derived, tables: evalVectors.tables };
      expect(evaluate(c.expr, ctx)).toEqual(evaluate(c.expr, ctx));
    }
    expect(JSON.stringify(input)).toBe(before);
  });

  it("treats integers outside the safe range in the input as non-integers", () => {
    const input = JSON.parse('{"big": 9007199254740993}') as Json;
    const r = evaluate({ op: "add", args: [{ op: "input", path: "big" }, lit(1)] }, emptyCtx(input));
    expect(r).toEqual({ ok: false, error: { code: "type_error", at: "/args/0" } });
    expect(evaluate({ op: "is_type", ref: { op: "input", path: "big" }, type: "real" }, emptyCtx(input))).toEqual({ ok: true, value: true });
  });

  it("returns 0 for a negative zero in the input", () => {
    const r = evaluate({ op: "input", path: "z" }, emptyCtx(JSON.parse('{"z": -0}') as Json));
    expect(r.ok && Object.is(r.value, 0)).toBe(true);
  });

  it("does not read inherited properties", () => {
    for (const path of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(evaluate({ op: "input", path }, emptyCtx({}))).toEqual({ ok: false, error: { code: "input_missing", at: "" } });
    }
  });
});

describe("canonicalExpr", () => {
  it("is independent of key order and contains no whitespace", () => {
    const a: Expr = { op: "gt", left: { op: "input", path: "a.b" }, right: lit(0) };
    const b = JSON.parse('{"right":{"value":0,"op":"lit"},"left":{"path":"a.b","op":"input"},"op":"gt"}') as Expr;
    expect(canonicalExpr(a)).toBe(canonicalExpr(b));
    expect(canonicalExpr(a)).toBe('{"left":{"op":"input","path":"a.b"},"op":"gt","right":{"op":"lit","value":0}}');
  });

  it("round-trips through JSON for every golden vector", () => {
    for (const c of evalVectors.cases) {
      const text = canonicalExpr(c.expr);
      expect(canonicalExpr(JSON.parse(text) as Expr), c.id).toBe(text);
      expect(JSON.parse(text), c.id).toEqual(c.expr);
    }
  });
});

describe("M1 review: LocalKey format of derived and table names (resolution 1)", () => {
  const e1: Expr = lit(1);
  const name = (n: number): string => "a".repeat(n);

  it("uses ^[a-z][a-z0-9_]{0,31}$", () => {
    expect(NAME_RE.source).toBe("^[a-z][a-z0-9_]{0,31}$");
  });

  it("accepts 32-character names and rejects widened-only names in declarations", () => {
    expect(validateDeclarations([{ name: name(32), expr: e1 }], [{ name: name(32), entries: [{ key: 1, value: 1 }] }]).ok).toBe(true);
    for (const bad of [name(33), "A", "D_cost", "_a", "a-b", "1a", "", "Ab"]) {
      const d = validateDeclarations([{ name: bad, expr: e1 }], []);
      expect(d.ok, `derived ${bad}`).toBe(false);
      if (!d.ok) expect(d.error.map((i) => i.code)).toEqual(["bad_name"]);
      const t = validateDeclarations([], [{ name: bad, entries: [{ key: 1, value: 1 }] }]);
      expect(t.ok, `table ${bad}`).toBe(false);
      if (!t.ok) expect(t.error.map((i) => i.code)).toEqual(["bad_name"]);
    }
  });

  it("reports bad_name for names referenced by derived and lookup, and unknown_reference for well-formed undeclared names", () => {
    const shape: ExprShape = { derivedNames: [name(32)], tableNames: ["t"] };
    expect(validateExpr({ op: "derived", name: name(32) }, shape).ok).toBe(true);
    expect(codes(validateExpr({ op: "derived", name: name(33) }, shape))).toEqual(["bad_name"]);
    expect(codes(validateExpr({ op: "derived", name: "Zed" }, shape))).toEqual(["bad_name"]);
    expect(codes(validateExpr({ op: "derived", name: "zed" }, shape))).toEqual(["unknown_reference"]);
    expect(codes(validateExpr({ op: "lookup", table: "T", key: e1 }, shape))).toEqual(["bad_name"]);
    expect(codes(validateExpr({ op: "lookup", table: "u", key: e1 }, shape))).toEqual(["unknown_reference"]);
  });

  it("leaves request-input reference paths unchanged (capitals and long segments stay valid)", () => {
    expect(validateExpr({ op: "input", path: "Requests[0].Body.Count" }, noShape).ok).toBe(true);
    expect(validateExpr({ op: "input", path: "a".repeat(100) }, noShape).ok).toBe(true);
  });
});

describe("M1 review: overflow at every intermediate node (resolution 2)", () => {
  const MAX = EXPR_LIMITS.maxSafeInteger;
  const add = (...args: Expr[]): Expr => ({ op: "add", args });
  const mul = (...args: Expr[]): Expr => ({ op: "mul", args });
  const sub = (left: Expr, right: Expr): Expr => ({ op: "sub", left, right });
  const overflow = (at: string): EvalResult => ({ ok: false, error: { code: "overflow", at } });

  it("never returns ok:true when an intermediate result left the range", () => {
    const cases: [string, Expr, string][] = [
      ["(MAX + 1) - 1", sub(add(lit(MAX), lit(1)), lit(1)), "/left"],
      ["MAX * 2 / 2", { op: "idiv", left: mul(lit(MAX), lit(2)), right: lit(2), round: "trunc" }, "/left"],
      ["n-ary sum MAX + 1 - 1", add(lit(MAX), lit(1), lit(-1)), ""],
      ["n-ary sum -MAX - 1 + 1", add(lit(-MAX), lit(-1), lit(1)), ""],
      ["n-ary product MAX * 2 * 0", mul(lit(MAX), lit(2), lit(0)), ""],
      ["0 - (MAX + 1) + 1", add(sub(lit(0), add(lit(MAX), lit(1))), lit(1)), "/args/0/right"],
      ["nested add/sub/mul", add(lit(1), sub(mul(lit(MAX), lit(3)), mul(lit(MAX), lit(2)))), "/args/1/left"],
      ["first node in order wins", sub(add(lit(MAX), lit(MAX)), mul(lit(MAX), lit(MAX))), "/left"],
    ];
    for (const [label, e, at] of cases) {
      expect(evaluate(e, emptyCtx()), label).toEqual(overflow(at));
    }
  });

  it("accepts values that stay in range at every step, including the boundary", () => {
    expect(evaluate(add(lit(MAX), lit(-1), lit(1)), emptyCtx())).toEqual({ ok: true, value: MAX });
    expect(evaluate(add(lit(-MAX), lit(MAX), lit(MAX)), emptyCtx())).toEqual({ ok: true, value: MAX });
    expect(evaluate(mul(lit(MAX), lit(1), lit(-1)), emptyCtx())).toEqual({ ok: true, value: -MAX });
  });

  it("checks every partial total of a sum aggregate", () => {
    const e: Expr = { op: "sum", over: "xs", each: { op: "elem", path: "" } };
    expect(evaluate(e, emptyCtx({ xs: [MAX, 1, -1] }))).toEqual(overflow(""));
    expect(evaluate(e, emptyCtx({ xs: [-MAX, -1, 1] }))).toEqual(overflow(""));
    expect(evaluate(e, emptyCtx({ xs: [MAX, -1, 1] }))).toEqual({ ok: true, value: MAX });
  });
});

describe("M1 review: invalid_expression for structurally invalid ASTs (resolution 3)", () => {
  const invalid = (at = ""): EvalResult => ({ ok: false, error: { code: "invalid_expression", at, cause: "structural" } });
  const ctx = emptyCtx({ xs: [1] });

  it("is returned, without throwing, for each kind of structural defect", () => {
    const cyc: Record<string, unknown> = { op: "not" };
    cyc["arg"] = cyc;
    const cycArr: Record<string, unknown> = { op: "add", args: [{ op: "lit", value: 1 }] };
    (cycArr["args"] as unknown[]).push(cycArr);
    const defects: [string, unknown][] = [
      ["null", null], ["undefined", undefined], ["number", 5], ["string", "x"], ["array", []], ["empty object", {}],
      ["unknown op", { op: "zzz" }], ["op not a string", { op: 7 }], ["missing key", { op: "not" }],
      ["extra key", { op: "lit", value: 1, more: 2 }], ["arity 1", { op: "add", args: [lit(1)] }],
      ["arity 17", { op: "or", args: Array.from({ length: 17 }, () => lit(true)) }],
      ["args not an array", { op: "add", args: 5 }],
      ["float literal", lit(1.5)], ["NaN literal", lit(Number.NaN)], ["Infinity literal", lit(Number.POSITIVE_INFINITY)],
      ["unsafe integer literal", lit(2 ** 53)], ["object literal", { op: "lit", value: {} }], ["undefined literal", { op: "lit", value: undefined }],
      ["bad derived name", { op: "derived", name: "Bad" }], ["bad table name", { op: "lookup", table: "Bad", key: lit(1) }],
      ["bad path", { op: "input", path: "a..b" }], ["empty input path", { op: "input", path: "" }],
      ["bad round", { op: "idiv", left: lit(1), right: lit(1), round: "up" }],
      ["bad type name", { op: "is_type", ref: { op: "input", path: "xs" }, type: "float" }],
      ["is_type ref not input/elem", { op: "is_type", ref: lit(1), type: "int" }],
      ["cyclic through a field", cyc], ["cyclic through args", cycArr],
    ];
    for (const [label, d] of defects) {
      let r!: EvalResult;
      expect(() => { r = evaluate(d as Expr, ctx); }, label).not.toThrow();
      expect(r, label).toMatchObject({ ok: false, error: { code: "invalid_expression", cause: "structural" } });
    }
  });

  it("reports the pointer of the offending node, also in branches that evaluation would skip", () => {
    expect(evaluate({ op: "and", args: [lit(false), { op: "zzz" } as unknown as Expr] }, ctx)).toEqual(invalid("/args/1"));
    expect(evaluate({ op: "if", cond: lit(true), then: lit(1), else: { op: "add" } as unknown as Expr }, ctx)).toEqual(invalid("/else"));
    expect(evaluate({ op: "sum", over: "xs", each: { op: "zzz" } as unknown as Expr }, emptyCtx({ xs: [] }))).toEqual(invalid("/each"));
    expect(evaluate({ op: "add", args: [lit(1), null as unknown as Expr] }, ctx)).toEqual(invalid("/args/1"));
  });

  it("checks the declaration expression of a derived value when it is used", () => {
    const derived = [{ name: "bad", expr: { op: "zzz" } as unknown as Expr }];
    expect(evaluate({ op: "derived", name: "bad" }, { input: {}, derived, tables: [] })).toEqual(invalid("/derived/0/expr"));
  });

  it("keeps the other codes for well-formed expressions and ignores static size and depth limits", () => {
    expect(evaluate({ op: "derived", name: "nope" }, ctx)).toEqual({ ok: false, error: { code: "unknown_reference", at: "" } });
    expect(evaluate({ op: "elem", path: "" }, ctx)).toEqual({ ok: false, error: { code: "unknown_reference", at: "" } });
    expect(evaluate(nestedNot(40), ctx)).toEqual({ ok: true, value: false });
  });
});

describe("M1 policy: structural defect versus internal fault (design item 14, R4.18)", () => {
  const SECRET = "boom-secret-text";
  const throwing = (): never => { throw new Error(SECRET); };

  it("gives invalid_expression with cause 'structural' for a structurally invalid AST", () => {
    expect(evaluate({ op: "zzz" } as unknown as Expr, emptyCtx())).toEqual({
      ok: false, error: { code: "invalid_expression", at: "", cause: "structural" },
    });
  });

  it("gives internal_error with cause 'internal_fault' for an unexpected exception, never ok:true, never throws, no exception text", () => {
    // 1. throws while the structure is checked (getter on an AST node)
    const astGetter = { op: "lit" } as Record<string, unknown>;
    Object.defineProperty(astGetter, "value", { enumerable: true, get: throwing });
    // 2. throws during evaluation (getter on the input document)
    const inputGetter: Record<string, unknown> = {};
    Object.defineProperty(inputGetter, "x", { enumerable: true, get: throwing });
    // 3. throws during evaluation (Proxy as the input document)
    const proxy = new Proxy({}, { has: throwing, get: throwing, getOwnPropertyDescriptor: throwing, ownKeys: throwing });
    const cases: [string, Expr, ExprContext][] = [
      ["getter in the AST", astGetter as unknown as Expr, emptyCtx()],
      ["getter in the input", { op: "input", path: "x" }, emptyCtx(inputGetter as Json)],
      ["proxy as the input", { op: "input", path: "x" }, emptyCtx(proxy as Json)],
    ];
    for (const [label, e, c] of cases) {
      let r!: EvalResult;
      expect(() => { r = evaluate(e, c); }, label).not.toThrow();
      expect(r, label).toEqual({ ok: false, error: { code: "internal_error", at: "", cause: "internal_fault" } });
      expect(JSON.stringify(r), label).not.toContain(SECRET);
    }
  });

  it("sets cause only for invalid_expression and internal_error", () => {
    const r = evaluate({ op: "input", path: "missing" }, emptyCtx());
    expect(r).toEqual({ ok: false, error: { code: "input_missing", at: "" } });
    expect(r.ok === false && "cause" in r.error).toBe(false);
  });
});

describe("M1 policy: -0 normalization (design item 13, R4.19)", () => {
  it("normalizes -0 in literals and in lookup-table values; eq treats -0 and 0 as equal", () => {
    const r1 = evaluate(lit(-0), emptyCtx());
    expect(r1.ok && Object.is(r1.value, 0)).toBe(true);
    const tables: LookupTable[] = [{ name: "t", entries: [{ key: "k", value: -0 }] }];
    const r2 = evaluate({ op: "lookup", table: "t", key: lit("k") }, { input: {}, derived: [], tables });
    expect(r2.ok && Object.is(r2.value, 0)).toBe(true);
    expect(evaluate({ op: "eq", left: lit(-0), right: lit(0) }, emptyCtx())).toEqual({ ok: true, value: true });
    const r3 = evaluate({ op: "mul", args: [lit(-0), lit(1)] }, emptyCtx());
    expect(r3.ok && Object.is(r3.value, 0)).toBe(true);
  });
});
