// Static, total validation of Rule_Expression_Language ASTs. Never throws.

import {
  EXPR_LIMITS as L,
  type DerivedDecl,
  type Expr,
  type ExprIssue,
  type ExprIssueCode,
  type ExprShape,
  type LookupTable,
  type Result,
} from "./types.js";

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]{1,4}\])*$/;
// LocalKey format (M1 review resolution 1); equal to LOCAL_KEY_PATTERN in packages/discovery-loop.
export const NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_ISSUES = 50;
const ROUNDS: readonly string[] = ["floor", "trunc", "ceil"];
const TYPES: readonly string[] = ["int", "real", "string", "bool", "null", "array", "object", "missing"];

interface VState {
  shape: ExprShape;
  nodes: number;
  stop: boolean;
  depthReported: boolean;
  issues: ExprIssue[];
}

function esc(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function add(s: VState, code: ExprIssueCode, at: string, message: string): void {
  if (s.issues.length < MAX_ISSUES) s.issues.push({ code, at, message });
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function has(o: Record<string, unknown>, k: string): boolean {
  return Object.hasOwn(o, k);
}

/** Reports unknown and missing fields; returns true when all required fields are present. */
function checkKeys(
  s: VState, o: Record<string, unknown>, at: string, req: readonly string[], opt: readonly string[] = [],
): boolean {
  let ok = true;
  for (const k of Object.keys(o)) {
    if (!req.includes(k) && !opt.includes(k)) {
      add(s, "unknown_field", `${at}/${esc(k)}`, "field is not defined for this operator");
    }
  }
  for (const k of req) {
    if (!has(o, k)) {
      add(s, "missing_field", `${at}/${k}`, "required field is missing");
      ok = false;
    }
  }
  return ok;
}

function checkPath(s: VState, v: unknown, at: string, allowEmpty: boolean): void {
  if (typeof v !== "string") { add(s, "bad_type", at, "path must be a string"); return; }
  if (v === "" && allowEmpty) return;
  if (v.length > L.maxPathLength || !PATH_RE.test(v)) add(s, "bad_path", at, "path is malformed or too long");
}

function checkLiteral(s: VState, v: unknown, at: string): void {
  if (v === null || typeof v === "boolean") return;
  if (typeof v === "string") {
    if (v.length > L.maxStringLength) add(s, "string_too_long", at, "string literal exceeds the limit");
    return;
  }
  if (typeof v === "number" && Number.isSafeInteger(v)) return;
  add(s, "bad_value", at, "literal must be a safe integer, string, boolean or null");
}

function visit(s: VState, node: unknown, at: string, depth: number, inAgg: boolean): void {
  if (s.stop) return;
  s.nodes += 1;
  if (s.nodes > L.maxNodes) {
    add(s, "node_limit", at, "expression exceeds the node limit");
    s.stop = true;
    return;
  }
  if (depth > L.maxDepth) {
    if (!s.depthReported) add(s, "depth_limit", at, "expression exceeds the depth limit");
    s.depthReported = true;
    return;
  }
  if (!isObj(node)) { add(s, "not_object", at, "expression node must be an object"); return; }
  if (!has(node, "op")) { add(s, "missing_field", `${at}/op`, "required field is missing"); return; }
  const op = node["op"];
  if (typeof op !== "string") { add(s, "bad_type", `${at}/op`, "operator must be a string"); return; }
  const child = (k: string, inA: boolean = inAgg): void => visit(s, node[k], `${at}/${k}`, depth + 1, inA);

  switch (op) {
    case "lit":
      if (checkKeys(s, node, at, ["op", "value"])) checkLiteral(s, node["value"], `${at}/value`);
      return;
    case "input":
      if (checkKeys(s, node, at, ["op", "path"])) checkPath(s, node["path"], `${at}/path`, false);
      return;
    case "elem":
      if (!inAgg) add(s, "elem_outside_aggregate", at, "elem is valid only inside each or where");
      if (checkKeys(s, node, at, ["op", "path"])) checkPath(s, node["path"], `${at}/path`, true);
      return;
    case "derived":
      if (checkKeys(s, node, at, ["op", "name"])) {
        const n = node["name"];
        if (typeof n !== "string") add(s, "bad_type", `${at}/name`, "name must be a string");
        else if (!NAME_RE.test(n)) add(s, "bad_name", `${at}/name`, "invalid derived value name");
        else if (!s.shape.derivedNames.includes(n)) add(s, "unknown_reference", `${at}/name`, "derived value is not declared before use");
      }
      return;
    case "lookup":
      if (checkKeys(s, node, at, ["op", "table", "key"])) {
        const t = node["table"];
        if (typeof t !== "string") add(s, "bad_type", `${at}/table`, "table must be a string");
        else if (!NAME_RE.test(t)) add(s, "bad_name", `${at}/table`, "invalid table name");
        else if (!s.shape.tableNames.includes(t)) add(s, "unknown_reference", `${at}/table`, "lookup table is not declared");
        child("key");
      }
      return;
    case "add": case "mul": case "and": case "or":
      if (checkKeys(s, node, at, ["op", "args"])) {
        const a = node["args"];
        if (!Array.isArray(a)) { add(s, "bad_type", `${at}/args`, "args must be an array"); return; }
        if (a.length < L.minNaryArgs || a.length > L.maxNaryArgs) {
          add(s, "arity", `${at}/args`, `args must have ${L.minNaryArgs} to ${L.maxNaryArgs} items`);
        }
        const n = Math.min(a.length, L.maxNaryArgs);
        for (let i = 0; i < n; i++) visit(s, a[i], `${at}/args/${i}`, depth + 1, inAgg);
      }
      return;
    case "sub": case "eq": case "ne": case "lt": case "le": case "gt": case "ge":
      if (checkKeys(s, node, at, ["op", "left", "right"])) { child("left"); child("right"); }
      return;
    case "idiv":
      if (checkKeys(s, node, at, ["op", "left", "right", "round"])) {
        const r = node["round"];
        if (typeof r !== "string" || !ROUNDS.includes(r)) add(s, "bad_value", `${at}/round`, "round must be floor, trunc or ceil");
        child("left"); child("right");
      }
      return;
    case "not":
      if (checkKeys(s, node, at, ["op", "arg"])) child("arg");
      return;
    case "if":
      if (checkKeys(s, node, at, ["op", "cond", "then", "else"])) { child("cond"); child("then"); child("else"); }
      return;
    case "is_type":
      if (checkKeys(s, node, at, ["op", "ref", "type"])) {
        const t = node["type"];
        if (typeof t !== "string" || !TYPES.includes(t)) add(s, "bad_value", `${at}/type`, "unknown type name");
        const ref = node["ref"];
        if (isObj(ref) && ref["op"] !== "input" && ref["op"] !== "elem") {
          add(s, "bad_value", `${at}/ref`, "ref must be an input or elem node");
        } else {
          child("ref");
        }
      }
      return;
    case "sum": case "count": {
      if (inAgg) add(s, "nested_aggregate", at, "aggregates cannot be nested");
      const isSum = op === "sum";
      if (checkKeys(s, node, at, isSum ? ["op", "over", "each"] : ["op", "over"], isSum ? [] : ["where"])) {
        checkPath(s, node["over"], `${at}/over`, false);
        if (isSum) child("each", true);
        else if (has(node, "where")) child("where", true);
      }
      return;
    }
    default:
      add(s, "unknown_operator", `${at}/op`, "operator is not part of the language");
  }
}

function validateAt(e: unknown, shape: ExprShape, prefix: string, issues: ExprIssue[]): void {
  const s: VState = { shape, nodes: 0, stop: false, depthReported: false, issues };
  visit(s, e, prefix, 1, false);
}

/** Static validation: shape, limits, unknown operators, references outside the Hypothesis. Total. */
export function validateExpr(e: unknown, ctx: ExprShape): Result<Expr, ExprIssue[]> {
  const issues: ExprIssue[] = [];
  try {
    validateAt(e, ctx, "", issues);
  } catch {
    issues.push({ code: "bad_value", at: "", message: "expression could not be inspected" });
  }
  return issues.length === 0 ? { ok: true, value: e as Expr } : { ok: false, error: issues };
}

export interface ValidatedDeclarations { derived: DerivedDecl[]; tables: LookupTable[] }

/**
 * Validates the derived-value and lookup-table declarations of a Hypothesis.
 * A derived expression may refer only to derived values declared before it.
 */
export function validateDeclarations(derived: unknown, tables: unknown): Result<ValidatedDeclarations, ExprIssue[]> {
  const issues: ExprIssue[] = [];
  const s: VState = { shape: { derivedNames: [], tableNames: [] }, nodes: 0, stop: false, depthReported: false, issues };
  const tableNames: string[] = [];

  try {
    if (!Array.isArray(tables)) {
      add(s, "bad_type", "/tables", "tables must be an array");
    } else {
      if (tables.length > L.maxTables) add(s, "too_many_declarations", "/tables", "too many lookup tables");
      tables.slice(0, L.maxTables).forEach((t: unknown, i) => {
        const at = `/tables/${i}`;
        if (!isObj(t)) { add(s, "not_object", at, "table must be an object"); return; }
        if (!checkKeys(s, t, at, ["name", "entries"])) return;
        const nm = t["name"];
        if (typeof nm !== "string" || !NAME_RE.test(nm)) add(s, "bad_name", `${at}/name`, "invalid table name");
        else if (tableNames.includes(nm)) add(s, "duplicate_name", `${at}/name`, "duplicate table name");
        else tableNames.push(nm);
        const en = t["entries"];
        if (!Array.isArray(en)) { add(s, "bad_type", `${at}/entries`, "entries must be an array"); return; }
        if (en.length < 1 || en.length > L.maxTableEntries) add(s, "arity", `${at}/entries`, `entries must have 1 to ${L.maxTableEntries} items`);
        const seen = new Set<string>();
        en.slice(0, L.maxTableEntries).forEach((x: unknown, j) => {
          const eat = `${at}/entries/${j}`;
          if (!isObj(x)) { add(s, "not_object", eat, "entry must be an object"); return; }
          if (!checkKeys(s, x, eat, ["key", "value"])) return;
          const k = x["key"];
          if (typeof k === "number" && Number.isSafeInteger(k)) {
            if (seen.has(`n:${k}`)) add(s, "duplicate_key", `${eat}/key`, "duplicate table key");
            seen.add(`n:${k}`);
          } else if (typeof k === "string" && k.length <= L.maxStringLength) {
            if (seen.has(`s:${k}`)) add(s, "duplicate_key", `${eat}/key`, "duplicate table key");
            seen.add(`s:${k}`);
          } else {
            add(s, "bad_value", `${eat}/key`, "key must be a safe integer or a string within the limit");
          }
          checkLiteral(s, x["value"], `${eat}/value`);
        });
      });
    }

    const derivedNames: string[] = [];
    if (!Array.isArray(derived)) {
      add(s, "bad_type", "/derived", "derived must be an array");
    } else {
      if (derived.length > L.maxDerived) add(s, "too_many_declarations", "/derived", "too many derived values");
      derived.slice(0, L.maxDerived).forEach((d: unknown, i) => {
        const at = `/derived/${i}`;
        if (!isObj(d)) { add(s, "not_object", at, "derived value must be an object"); return; }
        if (!checkKeys(s, d, at, ["name", "expr"])) return;
        validateAt(d["expr"], { derivedNames: [...derivedNames], tableNames }, `${at}/expr`, issues);
        const nm = d["name"];
        if (typeof nm !== "string" || !NAME_RE.test(nm)) add(s, "bad_name", `${at}/name`, "invalid derived value name");
        else if (derivedNames.includes(nm)) add(s, "duplicate_name", `${at}/name`, "duplicate derived value name");
        else derivedNames.push(nm);
      });
    }
  } catch {
    issues.push({ code: "bad_value", at: "", message: "declarations could not be inspected" });
  }
  return issues.length === 0
    ? { ok: true, value: { derived: derived as DerivedDecl[], tables: tables as LookupTable[] } }
    : { ok: false, error: issues };
}
