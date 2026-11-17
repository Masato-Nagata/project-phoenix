// Run configuration validation, stage A (task 4.1; design: "Run configuration validation: stage A, stage B, and who checks what"; R11.7, R11.8,
// R11.10, R8.11, R17.2, R9.14).
//
// `validateRunConfig` is pure: no I/O, no clock, no random source, no environment. It never modifies its input and it returns a new,
// deeply frozen `RunConfig` in which every default is resolved. Order: (1) the input is a plain data object; (2) schema `run-config`
// (unknown keys at every level, null, type, integer, range, enum, required, grammar); (3) explicit defaults for ABSENT optional keys
// (`null` is never absent); (4) cross-field rules on the EFFECTIVE values; (5) fixed bounds are part of (2) and are reported as
// `above_fixed_bound`. A refusal reports every issue found in the first step that fails; an issue is `{ code, path }` and never carries a value.
// Stage B (policy, audit configuration, credentials, destinations, lease, locations) is a separate task step and is not here.
import { createSchemaValidator, type SchemaValidator } from "../schema/validator.js";
import type { Issue, Result } from "../schema/types.js";
import {
  DEFAULT_MOCK_FIXTURE_SET_NAME,
  RUN_CONFIG_KNOWN_NAMES,
  RUN_LIMITS,
  RUN_LIMIT_KEYS,
  type RunConfigProvider,
  type RunLimitKey,
  type TestApiBaseAddress,
  UNKNOWN_KEY_PLACEHOLDER,
} from "./limits.js";

export type ConfigIssueCode =
  | "required_missing"
  | "unknown_key"
  | "null_value"
  | "wrong_type"
  | "not_integer"
  | "out_of_range"
  | "enum_mismatch"
  | "cross_field"
  | "above_fixed_bound"
  | "pattern_mismatch";

/** `path` is a JSON Pointer (RFC 6901). It names the setting, never its value. A key name that the schema does not define is written `<unknown>`. */
export interface ConfigIssue {
  readonly code: ConfigIssueCode;
  readonly path: string;
}

export type RunLimits = { readonly [K in RunLimitKey]: number };

/** The validated, fully resolved run configuration. Deeply frozen; shares no object with the input. */
export interface RunConfig {
  readonly schemaVersion: 1;
  readonly provider: RunConfigProvider;
  /** Resolved for the provider `mock` (the default name when the key was absent); absent for any other provider. */
  readonly mockFixtureSet?: string;
  readonly limits: RunLimits;
  readonly testApi: { readonly baseAddress: TestApiBaseAddress };
  readonly mask: { readonly paths: readonly string[] };
  readonly envNames: readonly string[];
}

/**
 * The configurations that `validateRunConfig` returned. Only that function adds to this set and no function of this module exposes it, so
 * `isValidatedRunConfig` is true for exactly the objects that stage A returned: not for the input, not for a copy, not for a structural look-alike.
 */
const validatedConfigs = new WeakSet<object>();

/** True only for an object that `validateRunConfig` itself returned (stage B refuses any other `RunConfig`). */
export function isValidatedRunConfig(x: unknown): x is RunConfig {
  return typeof x === "object" && x !== null && validatedConfigs.has(x);
}

let cachedValidator: SchemaValidator | undefined;
const validator = (): SchemaValidator => (cachedValidator ??= createSchemaValidator());

/**
 * A key name of the INPUT goes into a pointer only when it is one of the names that this package defines; any other key name is free text
 * (a user can name a key after a secret) and is written as the fixed placeholder. Several unknown keys under one parent therefore give ONE
 * issue (the count is not reported), and the pointer never depends on the key order or the text of the input.
 */
const safeKey = (k: string): string => (RUN_CONFIG_KNOWN_NAMES.includes(k) ? k : UNKNOWN_KEY_PLACEHOLDER);
const pointerToken = (s: string): string => s.replace(/~/g, "~0").replace(/\//g, "~1");
const unescapeToken = (s: string): string => s.replace(/~1/g, "/").replace(/~0/g, "~");

const MAX_SCAN_DEPTH = 8;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Reads an own data property without running a getter. `found: false` for an accessor. */
function ownData(o: object, key: string): { found: true; value: unknown } | { found: false } {
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d !== undefined && "value" in d ? { found: true, value: d.value } : { found: false };
}

/**
 * Finds what JSON cannot carry (undefined, function, symbol, bigint, accessor, non-plain object, hole in an array, too deep). Such a value is
 * reported at its pointer as `wrong_type`. Reading uses property descriptors, so no getter of the input runs.
 */
function scanNonJson(v: unknown, path: string, depth: number, out: ConfigIssue[]): void {
  if (v === null) return;
  const t = typeof v;
  if (t === "string" || t === "boolean" || t === "number") return;
  if (t !== "object" || depth > MAX_SCAN_DEPTH) {
    out.push({ code: "wrong_type", path });
    return;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i += 1) {
      const e = ownData(v, String(i));
      if (!e.found) out.push({ code: "wrong_type", path: `${path}/${i}` });
      else scanNonJson(e.value, `${path}/${i}`, depth + 1, out);
    }
    return;
  }
  if (!isPlainObject(v)) {
    out.push({ code: "wrong_type", path });
    return;
  }
  for (const k of Object.keys(v)) {
    const childPath = `${path}/${pointerToken(safeKey(k))}`;
    const e = ownData(v, k);
    if (!e.found) out.push({ code: "wrong_type", path: childPath });
    else scanNonJson(e.value, childPath, depth + 1, out);
  }
}

/** The value at a pointer of a validated-shape document; `undefined` when the path does not exist. Own data properties only. */
function valueAt(root: unknown, path: string): unknown {
  if (path === "") return root;
  let cur: unknown = root;
  for (const token of path.split("/").slice(1)) {
    const key = unescapeToken(token);
    if (Array.isArray(cur)) {
      const i = Number(key);
      cur = Number.isInteger(i) ? cur[i] : undefined;
    } else if (isPlainObject(cur) && Object.hasOwn(cur, key)) {
      cur = cur[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

const limitKeyOf = (path: string): RunLimitKey | undefined => {
  const m = /^\/limits\/([A-Za-z0-9_]+)$/.exec(path);
  const key = m?.[1];
  return key !== undefined && Object.hasOwn(RUN_LIMITS, key) ? (key as RunLimitKey) : undefined;
};

function mapIssue(i: Issue, raw: unknown): ConfigIssue {
  if (i.code === "undefined_field") {
    const at = i.path.lastIndexOf("/");
    const parent = i.path.slice(0, at);
    return { code: "unknown_key", path: `${parent}/${pointerToken(safeKey(unescapeToken(i.path.slice(at + 1))))}` };
  }
  if (i.code === "missing_field") return { code: "required_missing", path: i.path };
  const path = i.path;
  if (valueAt(raw, path) === null) return { code: "null_value", path };
  switch (i.keyword) {
    case "type": {
      const limit = limitKeyOf(path);
      return { code: limit !== undefined && typeof valueAt(raw, path) === "number" ? "not_integer" : "wrong_type", path };
    }
    case "enum":
    case "const":
      return { code: "enum_mismatch", path };
    case "minimum":
    case "maximum": {
      const limit = limitKeyOf(path);
      if (i.keyword === "maximum" && limit !== undefined && RUN_LIMITS[limit].bound === "fixed") return { code: "above_fixed_bound", path };
      return { code: "out_of_range", path };
    }
    case "maxItems":
      return { code: "out_of_range", path };
    case "pattern":
    case "minLength":
    case "maxLength":
      return { code: "pattern_mismatch", path };
    default:
      return { code: "wrong_type", path };
  }
}

/** Sorted by path (code point order), then by code, without exact duplicates: the order never depends on the key order of the input. */
function finish(issues: readonly ConfigIssue[]): ConfigIssue[] {
  const seen = new Set<string>();
  const out: ConfigIssue[] = [];
  for (const i of issues) {
    const key = `${i.path}\u0000${i.code}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(Object.freeze({ code: i.code, path: i.path }));
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
}

/**
 * Stage A of the start-up validation. Returns the resolved configuration or every issue of the first failing step. Never throws for any
 * input (a hostile input yields issues); never reads a getter of the input; never modifies the input.
 */
export function validateRunConfig(raw: unknown): Result<RunConfig, ConfigIssue[]> {
  try {
    // (1) a plain data object
    if (raw === null) return { ok: false, error: finish([{ code: "null_value", path: "" }]) };
    if (!isPlainObject(raw)) return { ok: false, error: finish([{ code: "wrong_type", path: "" }]) };
    const nonJson: ConfigIssue[] = [];
    scanNonJson(raw, "", 0, nonJson);
    if (nonJson.length > 0) return { ok: false, error: finish(nonJson) };

    // (2) the schema; Ajv reports a type issue and a value issue for the same path, only the type issue is kept
    const checked = validator().validate("run-config", raw);
    if (!checked.ok) {
      const typePaths = new Set(checked.error.filter((i) => i.keyword === "type").map((i) => i.path));
      const kept = checked.error.filter((i) => i.keyword === "type" || !typePaths.has(i.path));
      return { ok: false, error: finish(kept.map((i) => mapIssue(i, raw))) };
    }

    // (3) explicit defaults, in a fresh object; a key counts as given when it is an own property (`null` was refused above)
    const input = raw as Record<string, unknown>;
    const given = input["limits"] as Record<string, unknown>;
    const limits: Record<string, number> = {};
    for (const k of RUN_LIMIT_KEYS) limits[k] = Object.hasOwn(given, k) ? (given[k] as number) : RUN_LIMITS[k].default;
    const provider = input["provider"] as RunConfigProvider;
    const mockGiven = Object.hasOwn(input, "mockFixtureSet");

    // (4) cross-field rules on the effective values; the issue is reported at a key that the input contains
    const issues: ConfigIssue[] = [];
    if ((limits["providerCallSeconds"] as number) > (limits["runSeconds"] as number)) {
      issues.push({ code: "cross_field", path: Object.hasOwn(given, "providerCallSeconds") ? "/limits/providerCallSeconds" : "/limits/runSeconds" });
    }
    if ((limits["perExperimentSeconds"] as number) < (limits["perRequestSeconds"] as number)) {
      issues.push({ code: "cross_field", path: Object.hasOwn(given, "perExperimentSeconds") ? "/limits/perExperimentSeconds" : "/limits/perRequestSeconds" });
    }
    if (mockGiven && provider !== "mock") issues.push({ code: "cross_field", path: "/mockFixtureSet" });
    if (issues.length > 0) return { ok: false, error: finish(issues) };

    // the result: copies only, frozen
    const testApi = input["testApi"] as { baseAddress: TestApiBaseAddress };
    const mask = input["mask"] as { paths: string[] };
    const config: RunConfig = {
      schemaVersion: 1,
      provider,
      ...(provider === "mock" ? { mockFixtureSet: mockGiven ? (input["mockFixtureSet"] as string) : DEFAULT_MOCK_FIXTURE_SET_NAME } : {}),
      limits: Object.freeze(limits) as unknown as RunLimits,
      testApi: Object.freeze({ baseAddress: testApi.baseAddress }),
      mask: Object.freeze({ paths: Object.freeze([...mask.paths]) }),
      envNames: Object.freeze([...(input["envNames"] as string[])]),
    };
    const result: RunConfig = Object.freeze(config);
    validatedConfigs.add(result);
    return { ok: true, value: result };
  } catch {
    // A hostile input (for example a Proxy that throws) must not escape as an exception or leak its message.
    return { ok: false, error: finish([{ code: "wrong_type", path: "" }]) };
  }
}