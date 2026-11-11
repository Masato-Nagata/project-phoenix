// Rule_Expression_Language types (design: "Rule_Expression_Language").
// Pure data types only. No I/O.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export type Scalar = number | string | boolean | null;

export type RoundMode = "floor" | "trunc" | "ceil";
export type TypeName = "int" | "real" | "string" | "bool" | "null" | "array" | "object" | "missing";

export interface LitExpr { op: "lit"; value: Scalar }
export interface InputExpr { op: "input"; path: string }
export interface ElemExpr { op: "elem"; path: string }
export interface DerivedExpr { op: "derived"; name: string }
export interface LookupExpr { op: "lookup"; table: string; key: Expr }
export interface NaryExpr { op: "add" | "mul" | "and" | "or"; args: Expr[] }
export interface BinaryExpr { op: "sub" | "eq" | "ne" | "lt" | "le" | "gt" | "ge"; left: Expr; right: Expr }
export interface IdivExpr { op: "idiv"; left: Expr; right: Expr; round: RoundMode }
export interface NotExpr { op: "not"; arg: Expr }
export interface IfExpr { op: "if"; cond: Expr; then: Expr; else: Expr }
export interface IsTypeExpr { op: "is_type"; ref: InputExpr | ElemExpr; type: TypeName }
export interface SumExpr { op: "sum"; over: string; each: Expr }
export interface CountExpr { op: "count"; over: string; where?: Expr }

export type Expr =
  | LitExpr | InputExpr | ElemExpr | DerivedExpr | LookupExpr | NaryExpr | BinaryExpr
  | IdivExpr | NotExpr | IfExpr | IsTypeExpr | SumExpr | CountExpr;

export interface LookupEntry { key: number | string; value: Scalar }
export interface LookupTable { name: string; entries: readonly LookupEntry[] }
export interface DerivedDecl { name: string; expr: Expr }

export type EvalErrorCode =
  | "input_missing" | "type_error" | "division_by_zero" | "overflow"
  | "lookup_miss" | "unknown_reference" | "array_expected" | "limit_exceeded"
  | "invalid_expression" | "internal_error";

/** Diagnostic discriminator; set only for `invalid_expression` ('structural') and `internal_error` ('internal_fault'). */
export type EvalErrorCause = "structural" | "internal_fault";

/** `at` is a JSON pointer into the AST. Errors inside a derived value use `/derived/<index>/expr...`. */
export interface EvalError { code: EvalErrorCode; at: string; cause?: EvalErrorCause }
export type EvalResult = { ok: true; value: Scalar } | { ok: false; error: EvalError };

export interface ExprContext {
  input: Json;
  derived: readonly DerivedDecl[];
  tables: readonly LookupTable[];
}

/** Names visible to an expression during static validation. */
export interface ExprShape {
  derivedNames: readonly string[];
  tableNames: readonly string[];
}

export type ExprIssueCode =
  | "not_object" | "missing_field" | "unknown_field" | "bad_type" | "bad_value" | "bad_path"
  | "unknown_operator" | "arity" | "string_too_long" | "node_limit" | "depth_limit"
  | "unknown_reference" | "elem_outside_aggregate" | "nested_aggregate"
  | "too_many_declarations" | "bad_name" | "duplicate_name" | "duplicate_key";

export interface ExprIssue { code: ExprIssueCode; at: string; message: string }

export const EXPR_LIMITS = {
  maxNodes: 200,
  maxDepth: 12,
  minNaryArgs: 2,
  maxNaryArgs: 16,
  maxStringLength: 256,
  maxPathLength: 128,
  maxDerived: 32,
  maxTables: 16,
  maxTableEntries: 64,
  maxAggregateElements: 1000,
  maxSteps: 50000,
  maxSafeInteger: 9007199254740991,
} as const;

/** The complete operator vocabulary. Generic names only. */
export const EXPR_OPERATORS = [
  "lit", "input", "elem", "derived", "lookup", "add", "mul", "sub", "idiv",
  "eq", "ne", "lt", "le", "gt", "ge", "and", "or", "not", "if", "is_type", "sum", "count",
] as const;
