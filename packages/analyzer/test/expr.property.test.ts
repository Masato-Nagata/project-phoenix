// Property 24: Expression evaluation is total and deterministic.
// **Validates: Requirements 4.6**
//
// Reproducibility record: the fast-check seed and run counts below are fixed on purpose.
//   SEED = 240624, MAIN_RUNS = 400, LIMIT_RUNS = 150, STRUCTURE_RUNS = 100
// All generated values are neutral (short names such as "x", "y", small integers, fictitious paths).
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  EXPR_LIMITS,
  evaluate,
  validateDeclarations,
  validateExpr,
  type DerivedDecl,
  type EvalErrorCode,
  type EvalResult,
  type Expr,
  type ExprContext,
  type ExprShape,
  type Json,
  type LookupTable,
} from "../src/index.js";

const SEED = 240624;
const MAIN_RUNS = 400;
const LIMIT_RUNS = 150;
const STRUCTURE_RUNS = 100;
const TEST_TIMEOUT_MS = 120_000;

const CODES: readonly EvalErrorCode[] = [
  "input_missing", "type_error", "division_by_zero", "overflow",
  "lookup_miss", "unknown_reference", "array_expected", "limit_exceeded", "invalid_expression",
];
const MAX = EXPR_LIMITS.maxSafeInteger;

// ---------------------------------------------------------------- generators

const intish = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: -5, max: 20 }) },
  { weight: 2, arbitrary: fc.constantFrom(MAX, -MAX, MAX - 1, 0, 1, -1) },
  { weight: 1, arbitrary: fc.maxSafeInteger() },
);
const scalarLit = fc.oneof(
  intish,
  fc.constantFrom("x", "y", "z", ""),
  fc.boolean(),
  fc.constant(null),
);

const inputPath = fc.oneof(
  { weight: 8, arbitrary: fc.constantFrom(
    "requests[0].body.count", "requests[0].body.label", "requests[0].body.items", "requests[0].body.flag",
    "requests[0].body.ratio", "requests[0].body.missing", "requests[1].body.count", "requests[0]",
    "requests[0].body.items[0].n", "items", "items[1]", "count",
  ) },
  { weight: 1, arbitrary: fc.constantFrom("a..b", "[0]", "x.", "1a", "requests[00000]", "") },
  { weight: 1, arbitrary: fc.string({ maxLength: 8 }) },
);
const aggPath = fc.constantFrom("requests", "requests[0].body.items", "items", "requests[0].body.flag", "nope");
const elemPath = fc.constantFrom("", "", "n", "tag", "flag", "m.k", "nope");

const exprArb: fc.Arbitrary<Expr> = fc.letrec<{ expr: Expr }>((tie) => {
  const e = tie("expr");
  const leaf = fc.oneof(
    scalarLit.map((value): Expr => ({ op: "lit", value })),
    inputPath.map((path): Expr => ({ op: "input", path })),
    elemPath.map((path): Expr => ({ op: "elem", path })),
    fc.constantFrom("d0", "d1", "d2", "d3").map((name): Expr => ({ op: "derived", name })),
  );
  const refArb = fc.oneof(
    inputPath.map((path) => ({ op: "input" as const, path })),
    elemPath.map((path) => ({ op: "elem" as const, path })),
  );
  const types = ["int", "real", "string", "bool", "null", "array", "object", "missing"] as const;
  return {
    expr: fc.oneof(
      { maxDepth: 5, depthIdentifier: "expr-depth" },
      leaf,
      fc.record({ op: fc.constant("lookup" as const), table: fc.constantFrom("t1", "t2", "t3"), key: e }) as fc.Arbitrary<Expr>,
      fc.record({
        op: fc.constantFrom("add" as const, "mul" as const, "and" as const, "or" as const),
        args: fc.array(e, { minLength: 1, maxLength: 5 }),
      }) as fc.Arbitrary<Expr>,
      fc.record({
        op: fc.constantFrom("sub" as const, "eq" as const, "ne" as const, "lt" as const, "le" as const, "gt" as const, "ge" as const),
        left: e, right: e,
      }) as fc.Arbitrary<Expr>,
      fc.record({
        op: fc.constant("idiv" as const), left: e, right: e,
        round: fc.constantFrom("floor" as const, "trunc" as const, "ceil" as const),
      }) as fc.Arbitrary<Expr>,
      fc.record({ op: fc.constant("not" as const), arg: e }) as fc.Arbitrary<Expr>,
      fc.record({ op: fc.constant("if" as const), cond: e, then: e, else: e }) as fc.Arbitrary<Expr>,
      fc.record({ op: fc.constant("is_type" as const), ref: refArb, type: fc.constantFrom(...types) }) as fc.Arbitrary<Expr>,
      fc.record({ op: fc.constant("sum" as const), over: aggPath, each: e }) as fc.Arbitrary<Expr>,
      fc.record({ op: fc.constant("count" as const), over: aggPath }) as fc.Arbitrary<Expr>,
      fc.record({ op: fc.constant("count" as const), over: aggPath, where: e }) as fc.Arbitrary<Expr>,
    ),
  };
}).expr;

/** Mostly well-formed ASTs (no stray `elem`, aggregates only with element-level bodies, `d0`/`t1` references). */
function wellFormed(refs: boolean): fc.Arbitrary<Expr> {
  const elemBody: fc.Arbitrary<Expr> = fc.letrec<{ b: Expr }>((tie) => ({
    b: fc.oneof(
      { maxDepth: 2, depthIdentifier: "elem-depth" },
      fc.oneof(
        scalarLit.map((value): Expr => ({ op: "lit", value })),
        elemPath.map((path): Expr => ({ op: "elem", path })),
      ),
      fc.record({ op: fc.constantFrom("add" as const, "mul" as const, "and" as const, "or" as const), args: fc.array(tie("b"), { minLength: 2, maxLength: 3 }) }) as fc.Arbitrary<Expr>,
      fc.record({ op: fc.constantFrom("eq" as const, "gt" as const, "sub" as const), left: tie("b"), right: tie("b") }) as fc.Arbitrary<Expr>,
    ),
  })).b;
  return fc.letrec<{ w: Expr }>((tie) => {
    const w = tie("w");
    const leaves: fc.Arbitrary<Expr>[] = [
      scalarLit.map((value): Expr => ({ op: "lit", value })),
      inputPath.filter((p) => p !== "").map((path): Expr => ({ op: "input", path })),
    ];
    if (refs) leaves.push(fc.constant<Expr>({ op: "derived", name: "d0" }));
    return {
      w: fc.oneof(
        { maxDepth: 4, depthIdentifier: "wf-depth" },
        fc.oneof(...leaves),
        fc.record({ op: fc.constantFrom("add" as const, "mul" as const, "and" as const, "or" as const), args: fc.array(w, { minLength: 2, maxLength: 4 }) }) as fc.Arbitrary<Expr>,
        fc.record({ op: fc.constantFrom("sub" as const, "eq" as const, "ne" as const, "lt" as const, "le" as const, "gt" as const, "ge" as const), left: w, right: w }) as fc.Arbitrary<Expr>,
        fc.record({ op: fc.constant("idiv" as const), left: w, right: w, round: fc.constantFrom("floor" as const, "trunc" as const, "ceil" as const) }) as fc.Arbitrary<Expr>,
        fc.record({ op: fc.constant("not" as const), arg: w }) as fc.Arbitrary<Expr>,
        fc.record({ op: fc.constant("if" as const), cond: w, then: w, else: w }) as fc.Arbitrary<Expr>,
        fc.record({ op: fc.constant("lookup" as const), table: fc.constantFrom("t1", "t2"), key: w }) as fc.Arbitrary<Expr>,
        fc.record({ op: fc.constant("is_type" as const), ref: inputPath.filter((p) => p !== "").map((path) => ({ op: "input" as const, path })), type: fc.constantFrom("int", "string", "bool", "null", "array", "missing") }) as fc.Arbitrary<Expr>,
        fc.record({ op: fc.constant("sum" as const), over: aggPath, each: elemBody }) as fc.Arbitrary<Expr>,
        fc.record({ op: fc.constant("count" as const), over: aggPath, where: elemBody }) as fc.Arbitrary<Expr>,
      ),
    };
  }).w;
}
const wellFormedMain = wellFormed(true);

/** Valid-looking ASTs, plus ASTs with one field replaced by junk, plus arbitrary JSON. */
const rawExprArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 8, arbitrary: wellFormedMain as fc.Arbitrary<unknown> },
  { weight: 4, arbitrary: exprArb as fc.Arbitrary<unknown> },
  {
    weight: 3,
    arbitrary: fc.tuple(exprArb, fc.jsonValue({ maxDepth: 2 }), fc.nat(5)).map(([e, junk, k]): unknown => {
      const keys = Object.keys(e);
      const o = { ...(e as unknown as Record<string, unknown>) };
      o[keys[k % keys.length] as string] = junk;
      return o;
    }),
  },
  { weight: 1, arbitrary: fc.record({ op: fc.string({ maxLength: 6 }) }) },
  { weight: 1, arbitrary: fc.jsonValue({ maxDepth: 2 }) },
);

const itemArb = fc.record({ n: intish, tag: fc.constantFrom("x", "y"), flag: fc.boolean() });
const requestArb = fc.record({
  method: fc.constantFrom("GET", "POST"),
  path: fc.constantFrom("/a", "/b"),
  pathParams: fc.dictionary(fc.constantFrom("p", "q"), fc.constantFrom("x", "y")),
  body: fc.record(
    {
      count: intish,
      label: fc.constantFrom("x", "y", "z"),
      items: fc.array(itemArb, { maxLength: 6 }),
      flag: fc.boolean(),
      ratio: fc.double({ noNaN: true, noDefaultInfinity: true }),
    },
    { requiredKeys: [] },
  ),
});
const inputArb: fc.Arbitrary<Json> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ requests: fc.array(requestArb, { maxLength: 2 }), preparation: fc.constant<Json[]>([]) }) as fc.Arbitrary<Json> },
  { weight: 2, arbitrary: fc.record({ items: fc.array(itemArb, { maxLength: 8 }), count: intish }) as fc.Arbitrary<Json> },
  { weight: 1, arbitrary: fc.jsonValue({ maxDepth: 3 }) as fc.Arbitrary<Json> },
);

const tableArb: fc.Arbitrary<LookupTable> = fc.record({
  name: fc.constantFrom("t1", "t2"),
  entries: fc.uniqueArray(
    fc.record({ key: fc.oneof(fc.integer({ min: -3, max: 3 }), fc.constantFrom("x", "y", "z")), value: scalarLit }),
    { selector: (en) => `${typeof en.key}:${String(en.key)}`, maxLength: 6 },
  ),
});
const tablesArb = fc.uniqueArray(tableArb, { selector: (t) => t.name, maxLength: 2 });
const derivedArb = fc.array(fc.oneof(wellFormed(false), exprArb), { maxLength: 4 }).map((es): DerivedDecl[] => es.map((expr, i) => ({ name: `d${i}`, expr })));

// ---------------------------------------------------------------- helpers

function isDefinedResult(r: unknown): r is EvalResult {
  if (typeof r !== "object" || r === null) return false;
  const o = r as Record<string, unknown>;
  if (o["ok"] === true) {
    const v = o["value"];
    return v === null || typeof v === "boolean" || typeof v === "string"
      || (typeof v === "number" && Number.isSafeInteger(v) && Math.abs(v) <= MAX && !Object.is(v, -0));
  }
  if (o["ok"] === false) {
    const err = o["error"] as { code?: unknown; at?: unknown } | undefined;
    return err !== undefined && CODES.includes(err.code as EvalErrorCode) && typeof err.at === "string";
  }
  return false;
}

/** Same content, every object's keys in reverse order (own-property definition keeps "__proto__" safe). */
function reorder(x: unknown): unknown {
  if (Array.isArray(x)) return x.map(reorder);
  if (typeof x === "object" && x !== null) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x).reverse()) {
      Object.defineProperty(out, k, {
        value: reorder((x as Record<string, unknown>)[k]), enumerable: true, writable: true, configurable: true,
      });
    }
    return out;
  }
  return x;
}

function snapshot(x: unknown): string {
  return JSON.stringify(x);
}

function sortedIssues(r: ReturnType<typeof validateExpr>): string {
  return r.ok ? "ok" : JSON.stringify(r.error.map((i) => `${i.code}@${i.at}`).sort());
}

function assertTotalAndDeterministic(expr: unknown, derived: unknown, tables: unknown, input: Json): EvalResult {
  const decl = validateDeclarations(derived, tables);
  const ctx: ExprContext = decl.ok
    ? { input, derived: decl.value.derived, tables: decl.value.tables }
    : { input, derived: derived as DerivedDecl[], tables: tables as LookupTable[] };
  const shape: ExprShape = {
    derivedNames: ctx.derived.map((d) => d.name),
    tableNames: ctx.tables.map((t) => t.name),
  };
  const v = validateExpr(expr, shape);
  if (!v.ok) expect(v.error.length).toBeGreaterThan(0);

  const before = snapshot([expr, ctx]);
  let r1!: EvalResult;
  expect(() => { r1 = evaluate(expr as Expr, ctx); }).not.toThrow();
  if (v.ok) {
    // Contract of Property 24: accepted expressions give a value or a defined error.
    expect(isDefinedResult(r1)).toBe(true);
  } else {
    // Rejected ASTs are outside the contract (e.g. a non-scalar `lit` is returned as is), but
    // evaluation must still not throw and must return a result object.
    expect(typeof r1 === "object" && r1 !== null && typeof (r1 as { ok?: unknown }).ok === "boolean").toBe(true);
    if (!r1.ok) expect(isDefinedResult(r1)).toBe(true);
  }
  expect(snapshot([expr, ctx])).toBe(before); // evaluation does not mutate its arguments

  // repeated evaluation
  expect(evaluate(expr as Expr, ctx)).toStrictEqual(r1);
  expect(evaluate(expr as Expr, ctx)).toStrictEqual(r1);

  // structurally cloned, key-reordered AST, declarations, and input
  const ctx2 = reorder(ctx) as ExprContext;
  const expr2 = reorder(expr) as Expr;
  expect(evaluate(expr2, ctx2)).toStrictEqual(r1);
  const v2 = validateExpr(expr2, shape);
  expect(v2.ok).toBe(v.ok);
  expect(sortedIssues(v2)).toBe(sortedIssues(v));
  return r1;
}

// ---------------------------------------------------------------- properties

describe("Property 24: expression evaluation is total and deterministic", () => {
  it(`arbitrary valid and invalid ASTs, declarations and inputs (seed ${SEED}, ${MAIN_RUNS} runs)`, () => {
    fc.assert(
      fc.property(rawExprArb, derivedArb, tablesArb, inputArb, (expr, derived, tables, input) => {
        assertTotalAndDeterministic(expr, derived, tables, input);
      }),
      { seed: SEED, numRuns: MAIN_RUNS },
    );
  }, TEST_TIMEOUT_MS);

  it("the generators reach valid ASTs, successful values, and several error codes", () => {
    const samples = fc.sample(
      fc.tuple(rawExprArb, derivedArb, tablesArb, inputArb), { seed: SEED, numRuns: 600 },
    );
    let valid = 0;
    let okValues = 0;
    const codes = new Set<string>();
    for (const [expr, derived, tables, input] of samples) {
      const decl = validateDeclarations(derived, tables);
      if (!decl.ok) continue;
      const shape: ExprShape = { derivedNames: decl.value.derived.map((d) => d.name), tableNames: decl.value.tables.map((t) => t.name) };
      if (!validateExpr(expr, shape).ok) continue;
      valid += 1;
      const r = evaluate(expr as Expr, { input, derived: decl.value.derived, tables: decl.value.tables });
      if (r.ok) okValues += 1; else codes.add(r.error.code);
    }
    expect(valid).toBeGreaterThan(60);
    expect(okValues).toBeGreaterThan(10);
    expect(codes.size).toBeGreaterThanOrEqual(4);
  });

  it(`step and element limits give limit_exceeded exactly at the boundary (seed ${SEED}, ${LIMIT_RUNS} runs)`, () => {
    // each = add of m adds of 15 `elem ""` nodes: 1 + 16m nodes per element, one `sum` node, all elements 1.
    const heavy = (m: number): Expr => ({
      op: "sum", over: "items",
      each: { op: "add", args: Array.from({ length: m }, (): Expr => ({ op: "add", args: Array.from({ length: 15 }, (): Expr => ({ op: "elem", path: "" })) })) },
    });
    const expected = (m: number, len: number): EvalResult => {
      const steps = 1 + len * (1 + 16 * m);
      if (len > EXPR_LIMITS.maxAggregateElements || steps > EXPR_LIMITS.maxSteps) {
        return { ok: false, error: { code: "limit_exceeded", at: expect.any(String) as unknown as string } };
      }
      return { ok: true, value: len * 15 * m };
    };
    const check = (m: number, len: number): void => {
      const e = heavy(m);
      const input: Json = { items: Array.from({ length: len }, () => 1) };
      expect(validateExpr(e, { derivedNames: [], tableNames: [] }).ok).toBe(true);
      const ctx: ExprContext = { input, derived: [], tables: [] };
      const r = evaluate(e, ctx);
      expect(r).toMatchObject(expected(m, len));
      expect(evaluate(e, ctx)).toStrictEqual(r);
    };
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 11 }), fc.integer({ min: 0, max: 1100 }), (m, len) => check(m, len)),
      { seed: SEED, numRuns: LIMIT_RUNS },
    );
    for (let m = 2; m <= 11; m++) {
      const edge = Math.floor((EXPR_LIMITS.maxSteps - 1) / (1 + 16 * m));
      for (const len of [edge - 1, edge, edge + 1, EXPR_LIMITS.maxAggregateElements - 1, EXPR_LIMITS.maxAggregateElements, EXPR_LIMITS.maxAggregateElements + 1]) {
        if (len >= 0) check(m, len);
      }
    }
  }, TEST_TIMEOUT_MS);

  it(`exponential derived-value fan-out terminates with limit_exceeded (seed ${SEED}, ${LIMIT_RUNS} runs)`, () => {
    // d0 = 1; d(i) = add(d(i-1), d(i-1)): the number of node visits doubles per level. 32 declarations are allowed.
    const chain = (n: number): DerivedDecl[] =>
      Array.from({ length: n }, (_, i): DerivedDecl => ({
        name: `d${i}`,
        expr: i === 0
          ? { op: "lit", value: 1 }
          : { op: "add", args: [{ op: "derived", name: `d${i - 1}` }, { op: "derived", name: `d${i - 1}` }] },
      }));
    fc.assert(
      fc.property(fc.integer({ min: 1, max: EXPR_LIMITS.maxDerived }), (n) => {
        const decl = validateDeclarations(chain(n), []);
        expect(decl.ok).toBe(true);
        if (!decl.ok) return;
        const ctx: ExprContext = { input: {}, derived: decl.value.derived, tables: [] };
        const target: Expr = { op: "derived", name: `d${n - 1}` };
        const r = evaluate(target, ctx);
        expect(isDefinedResult(r)).toBe(true);
        expect(evaluate(target, ctx)).toStrictEqual(r);
        const level = n - 1; // visits are at least 2^level
        if (level >= 16) expect(r).toMatchObject({ ok: false, error: { code: "limit_exceeded" } });
        if (level <= 3) expect(r).toStrictEqual({ ok: true, value: 2 ** level });
      }),
      { seed: SEED, numRuns: LIMIT_RUNS },
    );
  }, TEST_TIMEOUT_MS);

  it(`static size and depth limits decide validity; evaluation stays total beyond them (seed ${SEED}, ${STRUCTURE_RUNS} runs)`, () => {
    const chainOfNot = (depth: number): Expr => {
      let e: Expr = { op: "lit", value: true };
      for (let i = 1; i < depth; i++) e = { op: "not", arg: e };
      return e;
    };
    const shape: ExprShape = { derivedNames: [], tableNames: [] };
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.integer({ min: 2, max: 260 }), (depth, extra) => {
        const d = chainOfNot(depth);
        const vd = validateExpr(d, shape);
        expect(vd.ok).toBe(depth <= EXPR_LIMITS.maxDepth);
        const rd = evaluate(d, { input: {}, derived: [], tables: [] });
        expect(isDefinedResult(rd)).toBe(true);
        expect(rd).toStrictEqual({ ok: true, value: depth % 2 === 1 });

        // node count: a list of `extra` literal `not` nodes joined by and-trees of 16
        let level: Expr[] = Array.from({ length: extra }, (): Expr => ({ op: "not", arg: { op: "lit", value: false } }));
        let nodes = extra * 2;
        while (level.length > 1) {
          const next: Expr[] = [];
          for (let i = 0; i < level.length; i += 16) {
            const group = level.slice(i, i + 16);
            if (group.length === 1) { next.push(group[0] as Expr); continue; }
            next.push({ op: "and", args: group });
            nodes += 1;
          }
          level = next;
        }
        const tree = level[0] as Expr;
        const vt = validateExpr(tree, shape);
        if (nodes > EXPR_LIMITS.maxNodes) expect(vt.ok).toBe(false);
        else expect(vt.ok).toBe(true);
        const rt = evaluate(tree, { input: {}, derived: [], tables: [] });
        expect(isDefinedResult(rt)).toBe(true);
        expect(rt).toStrictEqual({ ok: true, value: true });
      }),
      { seed: SEED, numRuns: STRUCTURE_RUNS },
    );
  }, TEST_TIMEOUT_MS);

  it("extremely deep ASTs are rejected statically and evaluation never throws", () => {
    const shape: ExprShape = { derivedNames: [], tableNames: [] };
    for (const depth of [100, 1000, 100_000]) {
      let e: Expr = { op: "lit", value: true };
      for (let i = 1; i < depth; i++) e = { op: "not", arg: e };
      const v = validateExpr(e, shape);
      expect(v.ok).toBe(false);
      const ctx: ExprContext = { input: {}, derived: [], tables: [] };
      let r!: EvalResult;
      expect(() => { r = evaluate(e, ctx); }).not.toThrow();
      expect(isDefinedResult(r)).toBe(true);
      expect(evaluate(e, ctx)).toStrictEqual(r);
    }
  }, TEST_TIMEOUT_MS);
});

describe("Property 24 (structural totality): evaluate rejects what validateExpr rejects structurally", () => {
  // **Validates: Requirements 4.6, 4.14**
  // Issue codes that describe the shape of the AST. The others (limits, references, aggregate placement)
  // are not structural in the sense of the evaluator.
  const STRUCTURAL = new Set(["not_object", "missing_field", "unknown_field", "bad_type", "bad_value", "bad_path", "unknown_operator", "arity", "string_too_long", "bad_name"]);
  const NON_STRUCTURAL = new Set(["unknown_reference", "elem_outside_aggregate", "nested_aggregate"]);
  const shape: ExprShape = { derivedNames: ["d0", "d1"], tableNames: ["t1", "t2"] };
  const ctx: ExprContext = { input: { requests: [{ body: { count: 1, items: [{ n: 1 }] } }], items: [1, 2] }, derived: [], tables: [] };

  const junk: fc.Arbitrary<unknown> = fc.oneof(
    fc.anything(),
    fc.constantFrom(undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1.5, -0, 2 ** 53, [], {}, { op: "zzz" }, { op: "lit" }),
    fc.jsonValue({ maxDepth: 2 }),
  );

  /** Replaces one value (or deletes one key) in a deep copy of a valid AST. */
  function mutate(base: unknown, pick: number, replacement: unknown, remove: boolean): unknown {
    const copy = JSON.parse(JSON.stringify(base)) as unknown;
    const slots: { parent: Record<string, unknown> | unknown[]; key: string | number }[] = [];
    const walk = (v: unknown): void => {
      if (typeof v !== "object" || v === null) return;
      for (const k of Object.keys(v)) {
        slots.push({ parent: v as Record<string, unknown>, key: k });
        walk((v as Record<string, unknown>)[k]);
      }
    };
    walk(copy);
    if (slots.length === 0) return replacement;
    const s = slots[pick % slots.length] as (typeof slots)[number];
    if (remove && !Array.isArray(s.parent)) delete (s.parent as Record<string, unknown>)[s.key as string];
    else (s.parent as Record<string, unknown>)[s.key as string] = replacement;
    return copy;
  }

  const valid: Expr[] = [
    { op: "add", args: [{ op: "lit", value: 1 }, { op: "input", path: "requests[0].body.count" }] },
    { op: "if", cond: { op: "lit", value: true }, then: { op: "derived", name: "d0" }, else: { op: "lookup", table: "t1", key: { op: "lit", value: "x" } } },
    { op: "and", args: [{ op: "lit", value: false }, { op: "not", arg: { op: "lit", value: true } }] },
    { op: "idiv", left: { op: "lit", value: 7 }, right: { op: "lit", value: 2 }, round: "floor" },
    { op: "sum", over: "items", each: { op: "elem", path: "" } },
    { op: "count", over: "requests[0].body.items", where: { op: "is_type", ref: { op: "elem", path: "n" }, type: "int" } },
  ];

  it(`never throws and never returns ok:true for a structurally rejected AST (seed ${SEED}, ${MAIN_RUNS} runs)`, () => {
    let rejected = 0;
    fc.assert(
      fc.property(fc.oneof(junk, fc.tuple(fc.constantFrom(...valid), fc.nat(1000), junk, fc.boolean()).map(([b, p, r, rm]) => mutate(b, p, r, rm))), (x) => {
        const v = validateExpr(x, shape);
        let r!: EvalResult;
        expect(() => { r = evaluate(x as Expr, ctx); }).not.toThrow();
        expect(isDefinedResult(r)).toBe(true);
        if (v.ok) return;
        const cs = v.error.map((i) => i.code);
        const structural = cs.some((c) => STRUCTURAL.has(c));
        const onlyShapeCodes = cs.every((c) => STRUCTURAL.has(c) || NON_STRUCTURAL.has(c));
        if (structural && onlyShapeCodes) {
          rejected += 1;
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.error.code).toBe("invalid_expression");
        }
      }),
      { seed: SEED, numRuns: MAIN_RUNS },
    );
    expect(rejected).toBeGreaterThan(50);
  }, TEST_TIMEOUT_MS);
});