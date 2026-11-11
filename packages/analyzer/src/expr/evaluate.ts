// Total, deterministic evaluator of Rule_Expression_Language ASTs. Pure: no I/O, clock or random source.
//
// Evaluation order (part of the definition):
//  - Operands of add, mul, sub, idiv, eq, ne, lt, le, gt, ge are evaluated left to right; an evaluation
//    error of a later operand wins over a type error of an earlier one. Types are checked afterwards,
//    left to right, and a type error is reported at the offending operand.
//  - and / or evaluate and type-check one argument at a time and stop at the first false / true.
//  - add, mul and sum are computed exactly (BigInt) and EVERY intermediate result is range-checked: each
//    partial sum / partial product, in operand (element) order, and the result of each node. The first
//    out-of-range value gives `overflow` at the pointer of the node that computes it, even if a later
//    operation would bring the value back into range (M1 review resolution 2).
//  - Before the first step the whole AST is checked structurally (shape, keys, arity, literals, names,
//    cycles; not the static size and depth limits). Any violation gives `invalid_expression`, also for
//    parts that short-circuiting would never visit (M1 review resolution 3).

import {
  EXPR_LIMITS as L,
  type EvalErrorCode,
  type EvalResult,
  type Expr,
  type ExprContext,
  type Scalar,
  type TypeName,
} from "./types.js";
import { NAME_RE } from "./validate.js";

const MAX = BigInt(L.maxSafeInteger);
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]{1,4}\])*$/;

class EvalAbort {
  constructor(readonly code: EvalErrorCode, readonly at: string) {}
}

interface Env {
  visible: number;               // number of derived values visible to the expression being evaluated
  elem: { value: unknown } | null;
}

interface State {
  ctx: ExprContext;
  steps: number;
  /** Node objects already checked structurally (also makes shared sub-objects cheap). */
  verified: Set<object>;
}

// ---------------------------------------------------------------------------------------------
// Structural check (total, iterative, never throws except EvalAbort("invalid_expression"))

const NARY = { req: ["op", "args"], opt: [] as string[] };
const BIN = { req: ["op", "left", "right"], opt: [] as string[] };
const SHAPES: ReadonlyMap<string, { req: readonly string[]; opt: readonly string[] }> = new Map([
  ["lit", { req: ["op", "value"], opt: [] }],
  ["input", { req: ["op", "path"], opt: [] }],
  ["elem", { req: ["op", "path"], opt: [] }],
  ["derived", { req: ["op", "name"], opt: [] }],
  ["lookup", { req: ["op", "table", "key"], opt: [] }],
  ["add", NARY], ["mul", NARY], ["and", NARY], ["or", NARY],
  ["sub", BIN], ["eq", BIN], ["ne", BIN], ["lt", BIN], ["le", BIN], ["gt", BIN], ["ge", BIN],
  ["idiv", { req: ["op", "left", "right", "round"], opt: [] }],
  ["not", { req: ["op", "arg"], opt: [] }],
  ["if", { req: ["op", "cond", "then", "else"], opt: [] }],
  ["is_type", { req: ["op", "ref", "type"], opt: [] }],
  ["sum", { req: ["op", "over", "each"], opt: [] }],
  ["count", { req: ["op", "over"], opt: ["where"] }],
]);
const ROUND_MODES: readonly string[] = ["floor", "trunc", "ceil"];
const TYPE_NAMES: readonly string[] = ["int", "real", "string", "bool", "null", "array", "object", "missing"];

interface Frame {
  node: unknown;
  parent: Frame | null;
  seg: string;
  exit: boolean;
}

function pointerOf(f: Frame): string {
  const segs: string[] = [];
  for (let cur: Frame | null = f; cur !== null; cur = cur.parent) segs.push(cur.seg);
  return segs.reverse().join("");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pathOk(v: unknown, allowEmpty: boolean): boolean {
  if (typeof v !== "string") return false;
  if (v === "") return allowEmpty;
  return v.length <= L.maxPathLength && PATH_RE.test(v);
}

function literalOk(v: unknown): boolean {
  if (v === null || typeof v === "boolean") return true;
  if (typeof v === "string") return v.length <= L.maxStringLength;
  return typeof v === "number" && Number.isSafeInteger(v);
}

function nameOk(v: unknown): boolean {
  return typeof v === "string" && NAME_RE.test(v);
}

/**
 * Verifies the shape of every node reachable from `root`. Static size and depth limits are not enforced
 * here (they belong to validateExpr; the run-time limits apply during evaluation). Cycles are invalid.
 */
function checkStructure(st: State, root: unknown, prefix: string): void {
  const onPath = new Set<object>();
  const stack: Frame[] = [{ node: root, parent: null, seg: prefix, exit: false }];
  while (stack.length > 0) {
    const f = stack.pop() as Frame;
    if (f.exit) {
      onPath.delete(f.node as object);
      continue;
    }
    const o = f.node;
    const bad = (): never => fail("invalid_expression", pointerOf(f));
    if (!isPlainObject(o)) return bad();
    if (onPath.has(o)) return bad();
    if (st.verified.has(o)) continue;
    const op = Object.hasOwn(o, "op") ? o["op"] : undefined;
    const shape = typeof op === "string" ? SHAPES.get(op) : undefined;
    if (shape === undefined) return bad();
    const keys = Object.keys(o);
    if (keys.some((k) => !shape.req.includes(k) && !shape.opt.includes(k))) return bad();
    if (shape.req.some((k) => !Object.hasOwn(o, k))) return bad();

    const children: [string, unknown][] = [];
    switch (op) {
      case "lit":
        if (!literalOk(o["value"])) return bad();
        break;
      case "input":
        if (!pathOk(o["path"], false)) return bad();
        break;
      case "elem":
        if (!pathOk(o["path"], true)) return bad();
        break;
      case "derived":
        if (!nameOk(o["name"])) return bad();
        break;
      case "lookup":
        if (!nameOk(o["table"])) return bad();
        children.push(["/key", o["key"]]);
        break;
      case "add": case "mul": case "and": case "or": {
        const a = o["args"];
        if (!Array.isArray(a) || a.length < L.minNaryArgs || a.length > L.maxNaryArgs) return bad();
        a.forEach((x: unknown, i: number) => children.push([`/args/${i}`, x]));
        break;
      }
      case "sub": case "eq": case "ne": case "lt": case "le": case "gt": case "ge":
        children.push(["/left", o["left"]], ["/right", o["right"]]);
        break;
      case "idiv":
        if (typeof o["round"] !== "string" || !ROUND_MODES.includes(o["round"])) return bad();
        children.push(["/left", o["left"]], ["/right", o["right"]]);
        break;
      case "not":
        children.push(["/arg", o["arg"]]);
        break;
      case "if":
        children.push(["/cond", o["cond"]], ["/then", o["then"]], ["/else", o["else"]]);
        break;
      case "is_type": {
        if (typeof o["type"] !== "string" || !TYPE_NAMES.includes(o["type"])) return bad();
        const ref = o["ref"];
        if (!isPlainObject(ref) || (ref["op"] !== "input" && ref["op"] !== "elem")) return bad();
        children.push(["/ref", ref]);
        break;
      }
      case "sum":
        if (!pathOk(o["over"], false)) return bad();
        children.push(["/each", o["each"]]);
        break;
      case "count":
        if (!pathOk(o["over"], false)) return bad();
        if (Object.hasOwn(o, "where")) children.push(["/where", o["where"]]);
        break;
      default:
        return bad();
    }
    st.verified.add(o);
    if (children.length === 0) continue;
    onPath.add(o);
    stack.push({ node: o, parent: f.parent, seg: f.seg, exit: true });
    for (let i = children.length - 1; i >= 0; i--) {
      const [seg, node] = children[i] as [string, unknown];
      stack.push({ node, parent: f, seg, exit: false });
    }
  }
}
function fail(code: EvalErrorCode, at: string): never {
  throw new EvalAbort(code, at);
}

function isInt(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v);
}

export function typeOf(v: unknown): TypeName {
  if (v === null) return "null";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "string") return "string";
  if (typeof v === "number") return Number.isSafeInteger(v) ? "int" : "real";
  if (Array.isArray(v)) return "array";
  if (typeof v === "object") return "object";
  return "missing";
}

type Found = { found: true; value: unknown } | { found: false };

function readPath(root: unknown, path: string): Found {
  if (path === "") return { found: true, value: root };
  if (!PATH_RE.test(path)) return { found: false };
  let cur: unknown = root;
  for (const m of path.matchAll(/([A-Za-z_][A-Za-z0-9_]*)|\[([0-9]{1,4})\]/g)) {
    const name = m[1];
    const idx = m[2];
    if (name !== undefined) {
      if (typeof cur !== "object" || cur === null || Array.isArray(cur) || !Object.hasOwn(cur, name)) return { found: false };
      cur = (cur as Record<string, unknown>)[name];
    } else if (idx !== undefined) {
      const i = Number(idx);
      if (!Array.isArray(cur) || i >= cur.length) return { found: false };
      cur = cur[i];
    }
  }
  return { found: true, value: cur };
}

function toInt(v: bigint, at: string): number {
  if (v > MAX || v < -MAX) fail("overflow", at);
  return Number(v);
}

function scalarOf(v: unknown, at: string): Scalar {
  if (typeof v === "number") return v === 0 ? 0 : v;
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  return fail("type_error", at);
}

function step(st: State, at: string): void {
  st.steps += 1;
  if (st.steps > L.maxSteps) fail("limit_exceeded", at);
}

function evalBool(st: State, e: Expr, at: string, env: Env): boolean {
  const v = ev(st, e, at, env);
  if (typeof v !== "boolean") fail("type_error", at);
  return v;
}

function intOperands(vals: readonly Scalar[], at: string, keys: readonly string[]): bigint[] {
  return vals.map((v, i) => {
    if (!isInt(v)) fail("type_error", `${at}/${keys[i] ?? i}`);
    return BigInt(v);
  });
}

function resolveArray(st: State, over: string, at: string): unknown[] {
  const r = readPath(st.ctx.input, over);
  if (!r.found) return fail("input_missing", `${at}/over`);
  if (!Array.isArray(r.value)) return fail("array_expected", `${at}/over`);
  if (r.value.length > L.maxAggregateElements) return fail("limit_exceeded", `${at}/over`);
  return r.value;
}

function ev(st: State, e: Expr, at: string, env: Env): Scalar {
  step(st, at);
  switch (e.op) {
    case "lit":
      return e.value === 0 ? 0 : e.value;   // normalizes -0, like every other number source
    case "input": {
      const r = readPath(st.ctx.input, e.path);
      return r.found ? scalarOf(r.value, at) : fail("input_missing", at);
    }
    case "elem": {
      if (env.elem === null) return fail("unknown_reference", at);
      const r = readPath(env.elem.value, e.path);
      return r.found ? scalarOf(r.value, at) : fail("input_missing", at);
    }
    case "derived": {
      const idx = st.ctx.derived.findIndex((d) => d.name === e.name);
      if (idx < 0 || idx >= env.visible) return fail("unknown_reference", at);
      const d = st.ctx.derived[idx];
      if (d === undefined) return fail("unknown_reference", at);
      checkStructure(st, d.expr, `/derived/${idx}/expr`);
      return ev(st, d.expr, `/derived/${idx}/expr`, { visible: idx, elem: null });
    }
    case "lookup": {
      const table = st.ctx.tables.find((t) => t.name === e.table);
      if (table === undefined) return fail("unknown_reference", at);
      const key = ev(st, e.key, `${at}/key`, env);
      if (typeof key !== "string" && !isInt(key)) return fail("lookup_miss", at);
      const hit = table.entries.find((x) => typeof x.key === typeof key && x.key === key);
      return hit === undefined ? fail("lookup_miss", at) : hit.value === 0 ? 0 : hit.value;
    }
    case "add": case "mul": {
      const vals = e.args.map((a, i) => ev(st, a, `${at}/args/${i}`, env));
      const ints = intOperands(vals, at, vals.map((_, i) => `args/${i}`));
      let acc = e.op === "add" ? 0n : 1n;
      for (const n of ints) {
        acc = e.op === "add" ? acc + n : acc * n;
        toInt(acc, at);                     // every partial result must be in range
      }
      return toInt(acc, at);
    }
    case "sub": {
      const l = ev(st, e.left, `${at}/left`, env);
      const r = ev(st, e.right, `${at}/right`, env);
      const [a, b] = intOperands([l, r], at, ["left", "right"]);
      return toInt((a as bigint) - (b as bigint), at);
    }
    case "idiv": {
      const l = ev(st, e.left, `${at}/left`, env);
      const r = ev(st, e.right, `${at}/right`, env);
      const [a, b] = intOperands([l, r], at, ["left", "right"]) as [bigint, bigint];
      if (b === 0n) return fail("division_by_zero", at);
      let q = a / b;                        // BigInt division truncates toward zero
      const rem = a % b;
      if (rem !== 0n) {
        const negative = (a < 0n) !== (b < 0n);
        if (e.round === "floor" && negative) q -= 1n;
        else if (e.round === "ceil" && !negative) q += 1n;
        else if (e.round !== "floor" && e.round !== "ceil" && e.round !== "trunc") return fail("type_error", at);
      }
      return toInt(q, at);
    }
    case "eq": case "ne": {
      const l = ev(st, e.left, `${at}/left`, env);
      const r = ev(st, e.right, `${at}/right`, env);
      if (typeOf(l) === "real") fail("type_error", `${at}/left`);
      if (typeOf(r) === "real") fail("type_error", `${at}/right`);
      const same = typeOf(l) === typeOf(r) && l === r;
      return e.op === "eq" ? same : !same;
    }
    case "lt": case "le": case "gt": case "ge": {
      const l = ev(st, e.left, `${at}/left`, env);
      const r = ev(st, e.right, `${at}/right`, env);
      const [a, b] = intOperands([l, r], at, ["left", "right"]) as [bigint, bigint];
      if (e.op === "lt") return a < b;
      if (e.op === "le") return a <= b;
      if (e.op === "gt") return a > b;
      return a >= b;
    }
    case "and": case "or": {
      const stopOn = e.op === "or";
      for (let i = 0; i < e.args.length; i++) {
        const a = e.args[i];
        if (a === undefined) return fail("type_error", at);
        if (evalBool(st, a, `${at}/args/${i}`, env) === stopOn) return stopOn;
      }
      return !stopOn;
    }
    case "not":
      return !evalBool(st, e.arg, `${at}/arg`, env);
    case "if":
      return evalBool(st, e.cond, `${at}/cond`, env) ? ev(st, e.then, `${at}/then`, env) : ev(st, e.else, `${at}/else`, env);
    case "is_type": {
      step(st, `${at}/ref`);
      const ref = e.ref;
      let r: Found;
      if (ref.op === "input") r = readPath(st.ctx.input, ref.path);
      else if (env.elem === null) return fail("unknown_reference", `${at}/ref`);
      else r = readPath(env.elem.value, ref.path);
      return (r.found ? typeOf(r.value) : "missing") === e.type;
    }
    case "sum": {
      const arr = resolveArray(st, e.over, at);
      let total = 0n;
      for (const item of arr) {
        const v = ev(st, e.each, `${at}/each`, { visible: env.visible, elem: { value: item } });
        if (!isInt(v)) fail("type_error", `${at}/each`);
        total += BigInt(v);
        toInt(total, at);                   // every partial total must be in range
      }
      return toInt(total, at);
    }
    case "count": {
      const arr = resolveArray(st, e.over, at);
      const where = e.where;
      if (where === undefined) return arr.length;
      let n = 0;
      for (const item of arr) {
        if (evalBool(st, where, `${at}/where`, { visible: env.visible, elem: { value: item } })) n += 1;
      }
      return n;
    }
    default:
      return fail("type_error", at);
  }
}

/** Total: always returns a value or a defined error, never throws. Deterministic. */
export function evaluate(e: Expr, ctx: ExprContext): EvalResult {
  const st: State = { ctx, steps: 0, verified: new Set<object>() };
  try {
    checkStructure(st, e, "");
    const value = ev(st, e, "", { visible: ctx.derived.length, elem: null });
    return { ok: true, value };
  } catch (err) {
    if (err instanceof EvalAbort) {
      return err.code === "invalid_expression"
        ? { ok: false, error: { code: err.code, at: err.at, cause: "structural" } }
        : { ok: false, error: { code: err.code, at: err.at } };
    }
    if (err instanceof RangeError) return { ok: false, error: { code: "limit_exceeded", at: "" } };
    // Unexpected exception: a defect, not a bad input. No message, stack or exception text is returned.
    return { ok: false, error: { code: "internal_error", at: "", cause: "internal_fault" } };
  }
}
