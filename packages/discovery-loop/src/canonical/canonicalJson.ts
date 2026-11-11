// Canonical JSON (design: "Canonical JSON"; R12.15, R17.8, R22.1).
// UTF-8; object keys sorted by UTF-16 code-unit order (RFC 8785); no whitespace between tokens;
// shortest standard string escapes; integers in plain decimal; no `-0`; non-finite and unsafe
// integers rejected; lone surrogates rejected; non-JSON values rejected.
import { strictParse } from "../schema/strictParse.js";
import { DEFAULT_PARSE_LIMITS, type Issue, type IssueCode, type Json, type ParseLimits, type Result } from "../schema/types.js";

export type CanonicalIssueCode = IssueCode | "non_json_value" | "lone_surrogate" | "not_canonical";

export interface CanonicalIssue {
  code: CanonicalIssueCode;
  path: string;
  message: string;
}

/** Thrown by `canonicalJson` and `canonicalBytes` when a value cannot be written canonically. */
export class CanonicalJsonError extends Error {
  constructor(readonly issue: CanonicalIssue) {
    super(`${issue.code} at "${issue.path}": ${issue.message}`);
    this.name = "CanonicalJsonError";
  }
}

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
/** Nesting guard for serialization (also stops cycles). Independent of the parse limit. */
const MAX_SERIALIZE_DEPTH = 256;

function pointerToken(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

function fail(code: CanonicalIssueCode, path: string, message: string): never {
  throw new CanonicalJsonError({ code, path, message });
}

function writeString(s: string, path: string): string {
  let out = '"';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let esc: string | undefined;
    if (c === 0x22) esc = '\\"';
    else if (c === 0x5c) esc = "\\\\";
    else if (c < 0x20) {
      esc =
        c === 0x08 ? "\\b" : c === 0x09 ? "\\t" : c === 0x0a ? "\\n" : c === 0x0c ? "\\f" : c === 0x0d ? "\\r"
          : `\\u${c.toString(16).padStart(4, "0")}`;
    } else if (c >= 0xd800 && c <= 0xdbff) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        i++;
        continue;
      }
      fail("lone_surrogate", path, `lone high surrogate at index ${i}`);
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      fail("lone_surrogate", path, `lone low surrogate at index ${i}`);
    }
    if (esc !== undefined) {
      out += s.slice(start, i) + esc;
      start = i + 1;
    }
  }
  return out + s.slice(start) + '"';
}

function writeNumber(n: number, path: string): string {
  if (!Number.isFinite(n)) fail("unsafe_number", path, "number is not finite");
  if (Object.is(n, -0)) return "0";
  if (Number.isInteger(n)) {
    if (Math.abs(n) > MAX_SAFE) fail("unsafe_number", path, "integer is outside the safe integer range");
    return n.toString(10);
  }
  return String(n); // ECMAScript shortest round-trip form
}

function write(v: unknown, path: string, ancestors: unknown[]): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      return writeNumber(v, path);
    case "string":
      return writeString(v, path);
    case "object":
      break;
    default:
      return fail("non_json_value", path, `${typeof v} is not a JSON value`);
  }
  if (ancestors.includes(v)) fail("non_json_value", path, "circular reference");
  if (ancestors.length >= MAX_SERIALIZE_DEPTH) fail("depth_exceeded", path, `nesting is deeper than ${MAX_SERIALIZE_DEPTH} levels`);
  ancestors.push(v);
  let out: string;
  if (Array.isArray(v)) {
    const parts: string[] = [];
    for (let i = 0; i < v.length; i++) {
      if (!(i in v)) fail("non_json_value", `${path}/${i}`, "sparse array hole");
      parts.push(write(v[i], `${path}/${i}`, ancestors));
    }
    out = `[${parts.join(",")}]`;
  } else {
    const proto = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) fail("non_json_value", path, "only plain objects are JSON values");
    if (Object.getOwnPropertySymbols(v).length > 0) fail("non_json_value", path, "symbol keys are not JSON");
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort(); // default sort compares UTF-16 code units
    const parts: string[] = [];
    for (const k of keys) {
      const childPath = `${path}/${pointerToken(k)}`;
      const desc = Object.getOwnPropertyDescriptor(obj, k);
      if (desc === undefined || !("value" in desc)) fail("non_json_value", childPath, "accessor properties are not JSON");
      parts.push(`${writeString(k, childPath)}:${write(desc.value, childPath, ancestors)}`);
    }
    out = `{${parts.join(",")}}`;
  }
  ancestors.pop();
  return out;
}

/** Canonical JSON text of a JSON value. Throws `CanonicalJsonError` for anything that is not canonical-writable. */
export function canonicalJson(v: Json): string {
  return write(v, "", []);
}

/** Canonical JSON as UTF-8 bytes (no BOM). */
export function canonicalBytes(v: Json): Uint8Array {
  return new Uint8Array(Buffer.from(canonicalJson(v), "utf8"));
}

/** Non-throwing form of `canonicalJson`. */
export function tryCanonicalJson(v: unknown): Result<string, CanonicalIssue> {
  try {
    return { ok: true, value: write(v, "", []) };
  } catch (e) {
    if (e instanceof CanonicalJsonError) return { ok: false, error: e.issue };
    throw e;
  }
}

/**
 * Parses stored bytes or text with the strict parser. Unless `requireCanonical` is false, the input
 * must also equal the canonical serialization of what it parsed to, so a stored record round-trips
 * byte for byte.
 */
export function parseCanonical(
  input: string | Uint8Array,
  opts: { limits?: ParseLimits; requireCanonical?: boolean } = {},
): Result<Json, CanonicalIssue> {
  const parsed = strictParse(input, opts.limits ?? DEFAULT_PARSE_LIMITS);
  if (!parsed.ok) {
    const e: Issue = parsed.error;
    return { ok: false, error: { code: e.code, path: e.path, message: e.message } };
  }
  if (opts.requireCanonical === false) return { ok: true, value: parsed.value };
  const again = tryCanonicalJson(parsed.value);
  if (!again.ok) return again;
  const text = typeof input === "string" ? input : new TextDecoder("utf-8").decode(input);
  if (again.value !== text) {
    return { ok: false, error: { code: "not_canonical", path: "", message: "input is valid JSON but not in canonical form" } };
  }
  return { ok: true, value: parsed.value };
}
