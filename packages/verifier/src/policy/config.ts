// Experiment_Policy configuration loader (design: "Policy configuration"; R8.1, R8.6; task 2.8).
//
// Fail closed (R8.6): a missing, malformed, or widened configuration is an error, and the engine built from it rejects
// every Experiment. "Widened" means: the allowlist names the reset operation or anything in the test namespace (after
// folding), or the deny rules are weaker than the mandatory minimum (`/reset` and the prefix `/test/`), or a limit is
// above the default of R8.8 / the Experiment schema maximum.
import { foldPath, isDeniedFolded } from "./fold.js";
import { isPlainObject } from "./guards.js";
import { loadPreparationTable } from "../prep/table.js";
import type { PrepTable } from "../prep/types.js";
import type { PolicyConfig, PolicyOperation, Result } from "./types.js";

/** Mandatory minimum of the deny rules. A configuration may add entries but may not drop these. */
export const MANDATORY_DENY = {
  equals: ["/reset"],
  prefixes: ["/test/"],
} as const;

/** Upper bounds of the limits: the defaults of R8.8 and the maxima of the Experiment schema. */
export const LIMIT_MAXIMA = {
  requests: 10,
  stateChecks: 5,
  preparationSteps: 10,
  bodyBytes: 8192,
} as const;

// Same characters as the Experiment schema's RequestPath, so an allowlist path can only be a plain template.
const OPERATION_PATH = /^\/[A-Za-z0-9_{}./-]*$/;
const METHOD = /^[A-Z]{3,7}$/;
const HEADER_NAME = /^[a-z0-9-]{1,64}$/;
const SAFE_INT_MAX = 2147483647;

const TOP_KEYS = ["schemaVersion", "operations", "denyFolded", "headers", "limits", "pathParam", "preparationKinds"];

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], where: string, errors: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${where}: unknown field ${JSON.stringify(k)}`);
}

/**
 * Validates the raw configuration and the loaded preparation table. Never throws. Returns the frozen configuration or every problem
 * found. The configuration carries no list of preparation kinds: the table is the single definition (task 2.26).
 */
export function loadPolicyConfig(raw: unknown, table: PrepTable): Result<PolicyConfig, string[]> {
  const errors: string[] = [];
  try {
    if (!isPlainObject(raw)) return { ok: false, error: ["configuration is missing or not an object"] };
    onlyKeys(raw, TOP_KEYS, "config", errors);
    if (raw["schemaVersion"] !== 1) errors.push("schemaVersion: must be 1");

    // ---- deny rules (parsed first: the allowlist is checked against them)
    const deny = raw["denyFolded"];
    let denyEquals: string[] = [];
    let denyPrefixes: string[] = [];
    if (!isPlainObject(deny)) errors.push("denyFolded: must be an object");
    else {
      onlyKeys(deny, ["equals", "prefixes"], "denyFolded", errors);
      const okList = (v: unknown): v is string[] =>
        Array.isArray(v) && v.length <= 32 && v.every((x) => typeof x === "string" && x.startsWith("/") && x === x.toLowerCase());
      if (!okList(deny["equals"])) errors.push("denyFolded.equals: must be lowercase strings that start with /");
      else denyEquals = [...deny["equals"]];
      if (!okList(deny["prefixes"])) errors.push("denyFolded.prefixes: must be lowercase strings that start with /");
      else denyPrefixes = [...deny["prefixes"]];
      for (const e of MANDATORY_DENY.equals) {
        if (!denyEquals.includes(e)) errors.push(`denyFolded.equals: must contain ${e}`);
      }
      for (const p of MANDATORY_DENY.prefixes) {
        if (!denyPrefixes.includes(p)) errors.push(`denyFolded.prefixes: must contain ${p}`);
      }
    }
    const denySet = { equals: [...denyEquals, ...MANDATORY_DENY.equals], prefixes: [...denyPrefixes, ...MANDATORY_DENY.prefixes] };

    // ---- allowlist
    const operations: PolicyOperation[] = [];
    const ops = raw["operations"];
    if (!Array.isArray(ops) || ops.length < 1 || ops.length > 64) errors.push("operations: must be 1 to 64 entries");
    else {
      const seen = new Set<string>();
      ops.forEach((op: unknown, i) => {
        const where = `operations[${i}]`;
        if (!isPlainObject(op)) {
          errors.push(`${where}: must be an object`);
          return;
        }
        onlyKeys(op, ["method", "path", "readOnly"], where, errors);
        const { method, path, readOnly } = op;
        if (typeof method !== "string" || !METHOD.test(method)) errors.push(`${where}.method: must be an uppercase HTTP method`);
        if (typeof path !== "string" || !OPERATION_PATH.test(path) || path.includes("..") || path.includes("//")) {
          errors.push(`${where}.path: must be a plain path template`);
        }
        if (typeof readOnly !== "boolean") errors.push(`${where}.readOnly: must be a boolean`);
        if (typeof method === "string" && typeof path === "string" && typeof readOnly === "boolean") {
          const denied = isDeniedFolded(foldPath(path), denySet);
          if (denied.reset || denied.namespace) errors.push(`${where}: names a denied operation (reset or the test namespace)`);
          const key = `${method} ${path}`;
          if (seen.has(key)) errors.push(`${where}: duplicate operation`);
          seen.add(key);
          operations.push(Object.freeze({ method, path, readOnly }));
        }
      });
    }

    // ---- headers
    const headers: { name: string; value: string }[] = [];
    const hs = raw["headers"];
    if (!Array.isArray(hs) || hs.length > 8) errors.push("headers: must be at most 8 entries");
    else {
      const names = new Set<string>();
      hs.forEach((h: unknown, i) => {
        const where = `headers[${i}]`;
        if (!isPlainObject(h)) {
          errors.push(`${where}: must be an object`);
          return;
        }
        onlyKeys(h, ["name", "value"], where, errors);
        const { name, value } = h;
        if (typeof name !== "string" || !HEADER_NAME.test(name)) errors.push(`${where}.name: must be a lowercase header name`);
        else if (names.has(name)) errors.push(`${where}.name: duplicate`);
        else names.add(name);
        if (typeof value !== "string" || value.length < 1 || value.length > 128) errors.push(`${where}.value: must be 1 to 128 characters`);
        if (typeof name === "string" && typeof value === "string") headers.push(Object.freeze({ name, value }));
      });
    }

    // ---- limits
    const limits = { requests: 0, stateChecks: 0, preparationSteps: 0, bodyBytes: 0 };
    const lim = raw["limits"];
    if (!isPlainObject(lim)) errors.push("limits: must be an object");
    else {
      onlyKeys(lim, Object.keys(LIMIT_MAXIMA), "limits", errors);
      for (const key of Object.keys(LIMIT_MAXIMA) as (keyof typeof LIMIT_MAXIMA)[]) {
        const v = lim[key];
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) errors.push(`limits.${key}: must be an integer of at least 1`);
        else if (v > LIMIT_MAXIMA[key]) errors.push(`limits.${key}: above the maximum ${LIMIT_MAXIMA[key]}`);
        else limits[key] = v;
      }
    }

    // ---- path parameters
    const pathParam = { min: 0, max: 0 };
    const pp = raw["pathParam"];
    if (!isPlainObject(pp)) errors.push("pathParam: must be an object");
    else {
      onlyKeys(pp, ["min", "max"], "pathParam", errors);
      const { min, max } = pp;
      if (typeof min !== "number" || typeof max !== "number" || !Number.isSafeInteger(min) || !Number.isSafeInteger(max) ||
          min < 1 || max > SAFE_INT_MAX || min > max) {
        errors.push(`pathParam: min and max must be integers with 1 <= min <= max <= ${SAFE_INT_MAX}`);
      } else {
        pathParam.min = min;
        pathParam.max = max;
      }
    }

    // ---- preparation kinds: the loaded preparation table is the only definition (task 2.26); an inline list is refused
    if (Object.prototype.hasOwnProperty.call(raw, "preparationKinds")) {
      errors.push("preparationKinds: refused; the preparation table is the single definition of the kinds and parameters");
    }
    const loadedTable = loadPreparationTable(table);
    if (!loadedTable.ok) errors.push(`preparationTable: ${loadedTable.error.slice(0, 3).join("; ")}`);
    const preparationTable = loadedTable.ok ? loadedTable.value : undefined;
    if (errors.length > 0) return { ok: false, error: errors };
    const config: PolicyConfig = Object.freeze({
      schemaVersion: 1 as const,
      operations: Object.freeze(operations),
      denyFolded: Object.freeze({ equals: Object.freeze(denyEquals), prefixes: Object.freeze(denyPrefixes) }),
      headers: Object.freeze(headers),
      limits: Object.freeze(limits),
      pathParam: Object.freeze(pathParam),
      preparationTable: preparationTable as PrepTable,
    });
    return { ok: true, value: config };
  } catch {
    return { ok: false, error: ["configuration could not be validated"] };
  }
}
