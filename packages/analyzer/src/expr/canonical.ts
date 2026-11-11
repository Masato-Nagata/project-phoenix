// Canonical text form of an expression: sorted keys, no whitespace, integers without fractional lexeme.

import type { Expr } from "./types.js";

function canon(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return Number.isFinite(v) ? String(v === 0 ? 0 : v) : "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return "null";
}

/** Deterministic: structurally equal expressions give identical text, whatever the key order. */
export function canonicalExpr(e: Expr): string {
  return canon(e);
}
