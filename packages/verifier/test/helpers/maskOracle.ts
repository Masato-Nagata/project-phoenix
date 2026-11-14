// An independent oracle for masking and comparison, written without the code under test: its own path enumeration,
// its own pattern-to-regular-expression translation, its own outermost-wins masking, and its own canonical comparison.
import { createHash } from "node:crypto";
import fc from "fast-check";
import type { JsonValue } from "./compareFixtures.js";

export const TOKEN = "<masked>";
export const KEYS = ["a", "b", "c", "d"] as const;

const scalarArb: fc.Arbitrary<JsonValue> = fc.oneof(
  fc.integer({ min: -3, max: 3 }),
  fc.string({ maxLength: 3 }),
  fc.boolean(),
  fc.constant(null),
  fc.constant(TOKEN),
);

const node: (n: number) => fc.Arbitrary<JsonValue> = fc.memo(
  (n: number): fc.Arbitrary<JsonValue> =>
    n <= 1
      ? scalarArb
      : fc.oneof(
          scalarArb,
          fc.array(node(n - 1), { maxLength: 4 }),
          fc.dictionary(fc.constantFrom(...KEYS), node(n - 1), { maxKeys: 4 }) as fc.Arbitrary<JsonValue>,
        ),
);

/** Values of depth up to 4 whose object keys come from a small alphabet, so that generated paths hit. */
export const jsonArb: fc.Arbitrary<JsonValue> = node(4);
/** A body that is an object (so that every path starts with a key). */
export const bodyArb: fc.Arbitrary<{ [k: string]: JsonValue }> = fc.dictionary(fc.constantFrom(...KEYS), node(3), { minKeys: 1, maxKeys: 4 });

// ---------------------------------------------------------------------------------------------------- enumeration

const joinKey = (prefix: string, key: string): string => (prefix === "" ? key : `${prefix}.${key}`);

/** Every concrete path of a value (the root excluded), in the form used by predictions and masks. */
export function allPaths(v: JsonValue, prefix = ""): string[] {
  const out: string[] = [];
  if (Array.isArray(v)) {
    v.forEach((x, i) => {
      const p = `${prefix}[${i}]`;
      out.push(p, ...allPaths(x, p));
    });
  } else if (typeof v === "object" && v !== null) {
    for (const k of Object.keys(v)) {
      const p = joinKey(prefix, k);
      out.push(p, ...allPaths(v[k] as JsonValue, p));
    }
  }
  return out;
}

/** Splits a path or pattern into its tokens, as strings: `a`, `.b`, `[0]`, `[*]`. */
export function tokens(p: string): string[] {
  return [...p.matchAll(/\[(?:\*|\d+)\]|\.?[A-Za-z_][A-Za-z0-9_]*/g)].map((m) => m[0]);
}

/** A regular expression that matches exactly the concrete paths a pattern designates (not its descendants). */
export function patternRegExp(pattern: string): RegExp {
  const src = tokens(pattern)
    .map((t) => {
      if (t === "[*]") return "\\[\\d+\\]";
      if (t.startsWith("[")) return `\\[${t.slice(1, -1)}\\]`;
      return t.startsWith(".") ? `\\.${t.slice(1)}` : t;
    })
    .join("");
  return new RegExp(`^${src}$`);
}

/** True if the path equals what a pattern designates, or lies below it (some leading part of it is designated). */
export function coveredByAny(path: string, patterns: readonly string[]): boolean {
  const res = patterns.map(patternRegExp);
  const toks = tokens(path);
  for (let n = 1; n <= toks.length; n += 1) {
    const prefix = toks.slice(0, n).join("");
    if (res.some((r) => r.test(prefix))) return true;
  }
  return false;
}

/** The shortest leading part of a path that a pattern designates (the outermost masked node), or undefined. */
export function coveredPrefix(path: string, patterns: readonly string[]): string | undefined {
  const res = patterns.map(patternRegExp);
  const toks = tokens(path);
  for (let n = 1; n <= toks.length; n += 1) {
    const prefix = toks.slice(0, n).join("");
    if (res.some((r) => r.test(prefix))) return prefix;
  }
  return undefined;
}

/** Outermost-wins masking, written from the definition: a designated node becomes the token and is not entered. */
export function oracleMask(v: JsonValue, patterns: readonly string[], path = ""): JsonValue {
  if (path !== "" && patterns.some((p) => patternRegExp(p).test(path))) return TOKEN;
  if (Array.isArray(v)) return v.map((x, i) => oracleMask(x, patterns, `${path}[${i}]`));
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.keys(v).map((k) => [k, oracleMask(v[k] as JsonValue, patterns, joinKey(path, k))]));
  }
  return v;
}

/**
 * The value of a predicted field after masking, from the definition (R10.2): put the value at its path in an otherwise
 * empty document, mask the document like an Observation, and read the path back. (The filler of an array is `null`; it
 * is never read.)
 */
export function oracleMaskPredicted(value: JsonValue, path: string, patterns: readonly string[]): JsonValue {
  let doc: JsonValue = value;
  for (const t of tokens(path).reverse()) {
    if (t.startsWith("[")) {
      const i = Number(t.slice(1, -1));
      const arr: JsonValue[] = Array.from({ length: i + 1 }, () => null);
      arr[i] = doc;
      doc = arr;
    } else {
      doc = { [t.startsWith(".") ? t.slice(1) : t]: doc };
    }
  }
  return oracleLookup(oracleMask(doc, patterns), path).value as JsonValue;
}

// ------------------------------------------------------------------------------------------------------ comparison

/** Canonical text with sorted keys; numbers, strings, booleans and null keep their type. */
export function canon(v: JsonValue): string {
  if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
  if (typeof v === "object" && v !== null) {
    return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k] as JsonValue)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

export function oracleLookup(v: JsonValue, path: string): { found: boolean; value?: JsonValue } {
  let cur: JsonValue = v;
  for (const t of tokens(path)) {
    if (t.startsWith("[")) {
      const i = Number(t.slice(1, -1));
      if (!Array.isArray(cur) || i >= cur.length) return { found: false };
      cur = cur[i] as JsonValue;
    } else {
      const k = t.startsWith(".") ? t.slice(1) : t;
      if (typeof cur !== "object" || cur === null || Array.isArray(cur) || !Object.keys(cur).includes(k)) return { found: false };
      cur = cur[k] as JsonValue;
    }
  }
  return { found: true, value: cur };
}

export const oracleHashOf = (paths: readonly string[]): string =>
  createHash("sha256")
    .update(`{"paths":[${[...new Set(paths)].sort().map((p) => JSON.stringify(p)).join(",")}]}`, "utf8")
    .digest("hex");

// ------------------------------------------------------------------------------------------------ pattern making

export interface PatternPick {
  i: number;
  wild: number;
  cut: number;
  random: { kind: "key" | "index" | "any"; key: number; n: number }[];
}

export const patternPickArb: fc.Arbitrary<PatternPick> = fc.record({
  i: fc.nat(),
  wild: fc.nat(255),
  cut: fc.nat(3),
  random: fc.array(fc.record({ kind: fc.constantFrom("key", "index", "any"), key: fc.nat(3), n: fc.nat(3) }), { minLength: 1, maxLength: 4 }),
}) as fc.Arbitrary<PatternPick>;

/** A valid mask pattern: derived from an existing path (some indexes widened to [*], optionally cut), or random. */
export function makePattern(value: JsonValue, pick: PatternPick): string {
  const paths = allPaths(value);
  if (paths.length > 0 && pick.wild % 5 !== 0) {
    const toks = tokens(paths[pick.i % paths.length] as string);
    const keep = Math.max(1, toks.length - (pick.cut % toks.length));
    return toks.slice(0, keep).map((t, k) => (t.startsWith("[") && ((pick.wild >> (k % 8)) & 1) === 1 ? "[*]" : t)).join("");
  }
  let s = "";
  pick.random.forEach((r, k) => {
    const key = KEYS[r.key % KEYS.length] as string;
    if (k === 0) s += r.kind === "index" ? `${key}[${r.n}]` : r.kind === "any" ? `${key}[*]` : key;
    else s += r.kind === "key" ? `.${key}` : r.kind === "index" ? `[${r.n}]` : "[*]";
  });
  return s;
}