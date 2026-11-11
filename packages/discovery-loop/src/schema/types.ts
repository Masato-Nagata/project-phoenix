// Shared primitives of the schema layer (design: "Common primitives").
// Local copies on purpose: discovery-loop has no workspace dependency on analyzer yet, and the
// shapes are structurally identical to packages/analyzer/src/expr/types.ts.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Every schema that the validator wrapper knows, by its short name. */
export const SCHEMA_NAMES = [
  "common",
  "facts",
  "source-bundle-manifest",
  "rule-expression",
  "citation",
  "hypothesis-proposal",
  "prediction",
  "experiment",
  "observation",
  "comparison-result",
  "evidence",
  "record-envelope",
  "approval-record",
  "run-manifest",
] as const;
export type SchemaName = (typeof SCHEMA_NAMES)[number];

export type IssueCode =
  // strict parse stage
  | "size_exceeded"
  | "invalid_utf8"
  | "invalid_json"
  | "depth_exceeded"
  | "duplicate_key"
  | "unsafe_number"
  // schema stage
  | "undefined_field"
  | "missing_field"
  | "bad_type"
  | "bad_value"
  | "schema_violation";

/** `path` is a JSON pointer into the document. For `undefined_field` and `missing_field` it ends with the field name. */
export interface Issue {
  code: IssueCode;
  path: string;
  message: string;
  /** Ajv keyword for schema-stage issues. */
  keyword?: string;
}

export interface ParseLimits {
  /** Maximum size of the input in bytes. Checked before any parsing (R17.3). */
  maxBytes: number;
  /** Maximum nesting depth of arrays and objects (R17.6: more than 32 levels is rejected). */
  maxDepth: number;
}

export const DEFAULT_PARSE_LIMITS: ParseLimits = Object.freeze({
  maxBytes: 262144,
  maxDepth: 32,
});
