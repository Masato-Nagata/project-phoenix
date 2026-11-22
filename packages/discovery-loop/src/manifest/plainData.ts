// Internal helpers shared by the Run_Manifest section builders (task 4.6 W3-A). NOT exported from src/index.ts.
//
// Pure: no I/O, no clock, no randomness. The helpers read own DATA properties only: an accessor is never run, a symbol key and a foreign
// prototype are refused, and the input is never changed. Domain rules (names, grammars, error vocabularies) stay in each builder.
import type { Json, Result } from "../schema/types.js";

/** Closed code plus an optional list position. No input value is ever echoed. */
export interface SectionError<C extends string> {
  readonly code: C;
  readonly index?: number;
}

export const sectionFail = <C extends string>(code: C, index?: number): Result<never, SectionError<C>> =>
  index === undefined ? { ok: false, error: { code } } : { ok: false, error: { code, index } };

/** A plain object with only own enumerable string-keyed data properties (no accessor, no symbol key). */
export function isPlainDataObject(v: unknown): v is object {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key !== "string") return false;
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (d === undefined || !("value" in d) || d.enumerable !== true) return false;
  }
  return true;
}

/** Own data property value of an object, or `{ present: false }` when absent or an accessor. A getter is never run. */
export function dataValue(o: object, key: string): { present: boolean; value?: unknown } {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (d === undefined || !("value" in d)) return { present: false };
  return { present: true, value: d.value };
}

/** True when the own enumerable keys of a plain data object are exactly `keys` (any order, no extra, none missing). */
export function hasExactKeys(o: object, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const ZERO_SHA256 = "0".repeat(64);

const MAX_JSON_DEPTH = 32;
const FAIL: unique symbol = Symbol("not-json");

function copyNode(v: unknown, depth: number): Json | typeof FAIL {
  if (v === null) return null;
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      return Number.isFinite(v) && (!Number.isInteger(v) || Number.isSafeInteger(v)) ? v : FAIL;
    case "object":
      break;
    default:
      return FAIL;
  }
  if (depth >= MAX_JSON_DEPTH) return FAIL;
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) return FAIL;
    const out: Json[] = [];
    for (let i = 0; i < v.length; i += 1) {
      const d = Object.getOwnPropertyDescriptor(v, String(i));
      if (d === undefined || !("value" in d) || d.enumerable !== true) return FAIL;
      const c = copyNode(d.value, depth + 1);
      if (c === FAIL) return FAIL;
      out.push(c);
    }
    if (Reflect.ownKeys(v).length !== v.length + 1) return FAIL; // an extra own property or a symbol key
    return out;
  }
  if (!isPlainDataObject(v)) return FAIL;
  const out: { [k: string]: Json } = {};
  for (const key of Object.keys(v)) {
    if (key === "__proto__") return FAIL;
    const c = copyNode(dataValue(v, key).value, depth + 1);
    if (c === FAIL) return FAIL;
    out[key] = c;
  }
  return out;
}

/**
 * A fresh deep copy of plain JSON data (objects, arrays, strings, booleans, null, finite numbers; integers must be safe), or `undefined`
 * when the value is anything else: an accessor, a symbol key, a foreign prototype, a hole, `undefined`, a non-finite number, a `__proto__`
 * key, or a nesting deeper than 32 levels. The result never aliases the input.
 */
export function copyPlainJson(v: unknown): Json | undefined {
  const c = copyNode(v, 0);
  return c === FAIL ? undefined : c;
}