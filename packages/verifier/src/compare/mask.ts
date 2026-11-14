// Masking (design: "Comparator Masking" and "Masking decisions (OD-7, C2-1 to C2-6)"; R10.2, R10.12; task 2.12).
//
// Masking makes non-deterministic values comparable and records reproducible. It is NOT a confidentiality control:
// it replaces only the configured paths and leaves every other value as it is. What may be sent to an AI is decided
// by the Payload_Auditor alone (C2-6).
//
// Properties, by construction:
//  - one fixed token, a constant of this module (C2-1); a configuration cannot change it;
//  - a path that does not exist is never created: only existing nodes are replaced;
//  - the result does not depend on the order or the repetition of the paths: one pass decides, for each node, whether
//    some path ends there, and the outermost such node is replaced (a parent mask covers its children);
//  - masking twice gives the same result, because a replaced node is a string and the paths below it no longer exist;
//  - the input is never modified.
import { createHash } from "node:crypto";
import { parseConcretePath, parseMaskPattern, patternCovers, type Segment } from "./path.js";
import type { Json, MaskConfig, Result } from "./types.js";

/** The one fixed mask token (C2-1). */
export const MASK_TOKEN = "<masked>" as const;

const MAX_PATHS = 64;
const MAX_DEPTH = 64;

/**
 * Validates a raw mask configuration (C2-1, C2-4). Only the key `paths` is allowed; in particular a `token` key is
 * refused, because the token is not configurable. Never throws.
 */
export function validateMaskConfig(raw: unknown): Result<MaskConfig, string[]> {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, error: ["the mask configuration is missing or not an object"] };
  const proto: unknown = Object.getPrototypeOf(raw);
  if (proto !== Object.prototype && proto !== null) return { ok: false, error: ["the mask configuration is not a plain object"] };
  for (const key of Object.keys(raw)) {
    if (key === "token") errors.push("the mask token is not configurable");
    else if (key !== "paths") errors.push(`unknown field ${JSON.stringify(key)}`);
  }
  const paths = (raw as { paths?: unknown }).paths;
  if (!Array.isArray(paths) || paths.length > MAX_PATHS) {
    errors.push(`paths must be a list of at most ${MAX_PATHS} entries`);
  } else {
    paths.forEach((p: unknown, i) => {
      if (typeof p !== "string" || parseMaskPattern(p) === undefined) errors.push(`paths[${i}] is not a valid mask path`);
    });
  }
  if (errors.length > 0) return { ok: false, error: errors };
  return { ok: true, value: Object.freeze({ paths: Object.freeze([...(paths as string[])]) }) };
}

/**
 * The hash of a mask configuration (C2-4): SHA-256 of the canonical JSON of `{"paths": [...]}` with the paths sorted
 * by code point and without duplicates. It does not depend on the order or the repetition of the paths.
 */
export function maskConfigHash(cfg: MaskConfig): string {
  const sorted = [...new Set(cfg.paths)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const text = `{"paths":[${sorted.map((p) => JSON.stringify(p)).join(",")}]}`;
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function compile(cfg: MaskConfig): Segment[][] {
  const out: Segment[][] = [];
  for (const p of new Set(cfg.paths)) {
    const segs = parseMaskPattern(p);
    if (segs === undefined) throw new Error("invalid mask path");
    out.push(segs);
  }
  return out;
}

function define(o: { [k: string]: Json }, key: string, value: Json): void {
  Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });
}

function walk(v: Json, patterns: readonly (readonly Segment[])[], depth: number): Json {
  if (depth > MAX_DEPTH) throw new RangeError("the value is nested too deeply to mask");
  if (patterns.some((p) => p.length === 0)) return MASK_TOKEN;
  if (Array.isArray(v)) {
    return v.map((x, i) =>
      walk(
        x,
        patterns.filter((p) => { const s = p[0] as Segment; return (s.kind === "index" && s.n === i) || s.kind === "any"; }).map((p) => p.slice(1)),
        depth + 1,
      ),
    );
  }
  if (typeof v === "object" && v !== null) {
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(v)) {
      const sub = patterns.filter((p) => { const s = p[0] as Segment; return s.kind === "key" && s.name === key; }).map((p) => p.slice(1));
      define(out, key, walk(v[key] as Json, sub, depth + 1));
    }
    return out;
  }
  return v;
}

/**
 * Replaces the value at each configured path by `MASK_TOKEN`. Returns a new value; the input is not modified and no
 * node is shared with it. Throws only for a configuration with an invalid path or a value nested deeper than 64 levels.
 * Only `cfg.paths` is read; any other property of `cfg` (a `token`, for example) has no effect.
 */
export function maskJson(v: Json, cfg: MaskConfig): Json {
  return walk(v, compile(cfg), 0);
}

function copy(v: Json): Json {
  if (Array.isArray(v)) return v.map(copy);
  if (typeof v === "object" && v !== null) {
    const out: { [k: string]: Json } = {};
    for (const key of Object.keys(v)) define(out, key, copy(v[key] as Json));
    return out;
  }
  return v;
}

/**
 * Masks the value of a predicted field, the same way the Observation is masked (R10.2, design "Comparator decisions", item 6).
 * `concretePath` is where the value sits in the body. The result is what `maskJson` would leave at that path of a body that
 * holds `v` there:
 *  - if the path is masked (it equals a mask entry or lies below one), the whole value is the token;
 *  - otherwise every mask entry that continues below the path is applied inside the value, outermost node first, with the
 *    same rules as `maskJson` (`[*]` stands for an array index only; an absent path is never created; masking twice is a no-op);
 *  - otherwise the value is returned unchanged.
 * Always returns a new value; the input is not modified and no node is shared with it. Throws only for an invalid path or
 * configuration, or when the value must be masked and is nested deeper than 64 levels.
 */
export function maskPredictedValue(v: Json, concretePath: string, cfg: MaskConfig): Json {
  const concrete = parseConcretePath(concretePath);
  if (concrete === undefined) throw new Error("invalid predicted path");
  const patterns = compile(cfg);
  if (patterns.some((p) => patternCovers(p, concrete))) return MASK_TOKEN;
  const below = patterns.filter((p) => p.length > concrete.length && patternCovers(p.slice(0, concrete.length), concrete)).map((p) => p.slice(concrete.length));
  return below.length === 0 ? copy(v) : walk(v, below, 0);
}

/**
 * For a concrete predicted path: the number of leading segments that form the outermost masked node, or undefined
 * when the path is not masked. A path is masked when it equals a mask entry or lies below one (`[*]` stands for any
 * index). The status code is not a path and is never masked.
 */
export function maskedPrefixLength(concretePath: string, cfg: MaskConfig): number | undefined {
  const concrete = parseConcretePath(concretePath);
  if (concrete === undefined) return undefined;
  let best: number | undefined;
  for (const p of compile(cfg)) {
    if (patternCovers(p, concrete) && (best === undefined || p.length < best)) best = p.length;
  }
  return best;
}

/** True if a concrete predicted path is masked (see `maskedPrefixLength`). */
export function isPathMasked(concretePath: string, cfg: MaskConfig): boolean {
  return maskedPrefixLength(concretePath, cfg) !== undefined;
}