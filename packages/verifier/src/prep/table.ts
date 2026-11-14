// Loader of the preparation table (task 2.15). Fail closed: any problem is an error and no table is returned.
import type { Result } from "../policy/types.js";
import { NUMBERED_LINES_MAX, STEP_PARAMS_MAX, type PrepInternalOperation, type PrepKind, type PrepNumbered, type PrepOperation, type PrepParamRule, type PrepTable } from "./types.js";

const LOCAL_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const BODY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const OP_PATH = /^\/[A-Za-z0-9_{}./-]*$/;
const DOTTED = /^[A-Za-z_][A-Za-z0-9_]{0,31}(?:\.[A-Za-z_][A-Za-z0-9_]{0,31}){0,3}$/;
const RESERVED_KIND = /^(?:reset|test)(?:_|$)/i;
const FORBIDDEN_NAME = /^(?:method|path|url|uri|header|headers|host)$/i;
const NUMBERED_SUFFIX = /_[0-9]+$/;
const BOUND = "{bound}";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function onlyKeys(o: Record<string, unknown>, allowed: readonly string[], where: string, errors: string[]): void {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) errors.push(`${where}: unknown field ${JSON.stringify(k)}`);
}

function parseRule(raw: unknown, where: string, errors: string[]): PrepParamRule | undefined {
  if (!isObj(raw)) {
    errors.push(`${where}: must be an object`);
    return undefined;
  }
  onlyKeys(raw, ["type", "optional", "min", "max", "maxLength", "enum", "body"], where, errors);
  const type = raw["type"];
  if (type !== "integer" && type !== "string" && type !== "boolean") {
    errors.push(`${where}.type: must be integer, string, or boolean`);
    return undefined;
  }
  const body = raw["body"];
  if (typeof body !== "string" || !BODY_NAME.test(body)) errors.push(`${where}.body: must be a field name`);
  const rule: { -readonly [K in keyof PrepParamRule]: PrepParamRule[K] } = { type, body: typeof body === "string" ? body : "" };
  if (raw["optional"] !== undefined) {
    if (typeof raw["optional"] !== "boolean") errors.push(`${where}.optional: must be a boolean`);
    else rule.optional = raw["optional"];
  }
  for (const key of ["min", "max"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (type !== "integer") errors.push(`${where}.${key}: allowed for integer only`);
    else if (typeof v !== "number" || !Number.isSafeInteger(v)) errors.push(`${where}.${key}: must be a safe integer`);
    else rule[key] = v;
  }
  if (rule.min !== undefined && rule.max !== undefined && rule.min > rule.max) errors.push(`${where}: min is above max`);
  if (raw["maxLength"] !== undefined) {
    const v = raw["maxLength"];
    if (type !== "string") errors.push(`${where}.maxLength: allowed for string only`);
    else if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1 || v > 1024) errors.push(`${where}.maxLength: must be an integer from 1 to 1024`);
    else rule.maxLength = v;
  }
  if (raw["enum"] !== undefined) {
    const v = raw["enum"];
    if (type !== "string") errors.push(`${where}.enum: allowed for string only`);
    else if (!Array.isArray(v) || v.length < 1 || v.length > 64 || !v.every((x) => typeof x === "string")) errors.push(`${where}.enum: must be 1 to 64 strings`);
    else rule.enum = Object.freeze([...(v as string[])]);
  }
  return Object.freeze(rule);
}

function checkName(name: string, where: string, errors: string[]): void {
  if (!LOCAL_KEY.test(name)) errors.push(`${where}: invalid name ${JSON.stringify(name)}`);
  if (FORBIDDEN_NAME.test(name)) errors.push(`${where}: ${JSON.stringify(name)} is a forbidden parameter name`);
}

/** `{bound}` is replaced by the `{id}` of the design tables, to compare an operation with the internal and the policy lists. */
export const normalizeOperationPath = (path: string): string => path.split(BOUND).join("{id}");

function parseOperation(raw: unknown, where: string, hasCapture: boolean, errors: string[]): PrepOperation | undefined {
  if (!isObj(raw)) {
    errors.push(`${where}: must be an object`);
    return undefined;
  }
  onlyKeys(raw, ["method", "path", "body", "expect", "capture"], where, errors);
  const { method, path, body, expect, capture } = raw;
  if (method !== "GET" && method !== "POST") errors.push(`${where}.method: must be GET or POST`);
  if (typeof path !== "string" || !OP_PATH.test(path) || path.includes("..") || path.includes("//")) errors.push(`${where}.path: must be a plain path template`);
  else {
    const placeholders = path.match(/\{[^{}]*\}/g) ?? [];
    if (placeholders.some((p) => p !== BOUND)) errors.push(`${where}.path: the only placeholder is {bound}`);
    if (path.includes(BOUND) && !hasCapture) errors.push(`${where}.path: {bound} needs an earlier operation that captures a value`);
    const folded = normalizeOperationPath(path);
    if (folded === "/reset" || folded === "/health") errors.push(`${where}.path: a preparation operation cannot be reset or health`);
  }
  if (body !== undefined && (body !== "assembled" || method !== "POST")) errors.push(`${where}.body: only "assembled", and only for POST`);
  if (typeof expect !== "number" || !Number.isSafeInteger(expect) || expect < 100 || expect > 599) errors.push(`${where}.expect: must be an HTTP status`);
  let cap: PrepOperation["capture"];
  if (capture !== undefined) {
    if (!isObj(capture)) errors.push(`${where}.capture: must be an object`);
    else {
      onlyKeys(capture, ["bindTo", "fromResponse"], `${where}.capture`, errors);
      if (capture["bindTo"] !== "step.bind") errors.push(`${where}.capture.bindTo: must be "step.bind"`);
      const from = capture["fromResponse"];
      if (typeof from !== "string" || !DOTTED.test(from)) errors.push(`${where}.capture.fromResponse: must be a dotted field path`);
      else cap = Object.freeze({ bindTo: "step.bind" as const, fromResponse: from });
    }
  }
  if (method !== "GET" && method !== "POST") return undefined;
  if (typeof path !== "string" || typeof expect !== "number") return undefined;
  return Object.freeze({ method, path, expect, ...(body === "assembled" ? { body: "assembled" as const } : {}), ...(cap !== undefined ? { capture: cap } : {}) });
}

function parseKind(raw: unknown, where: string, errors: string[]): PrepKind | undefined {
  if (!isObj(raw)) {
    errors.push(`${where}: must be an object`);
    return undefined;
  }
  onlyKeys(raw, ["kind", "params", "numbered", "translate"], where, errors);
  const kind = raw["kind"];
  if (typeof kind !== "string" || !LOCAL_KEY.test(kind) || RESERVED_KIND.test(kind)) {
    errors.push(`${where}.kind: must be a local key that is not reset or test`);
    return undefined;
  }

  const numbered = parseNumbered(raw["numbered"], `${where}.numbered`, errors);
  const params: Record<string, PrepParamRule> = {};
  const rawParams = raw["params"];
  if (!isObj(rawParams)) errors.push(`${where}.params: must be an object`);
  else {
    for (const [name, rule] of Object.entries(rawParams)) {
      checkName(name, `${where}.params`, errors);
      if (numbered !== undefined) {
        for (const f of Object.keys(numbered.fields)) {
          if (new RegExp(`^${f}_[0-9]+$`).test(name)) errors.push(`${where}.params: ${JSON.stringify(name)} collides with a numbered parameter`);
        }
      }
      const parsed = parseRule(rule, `${where}.params.${name}`, errors);
      if (parsed !== undefined) params[name] = parsed;
    }
  }
  if (numbered !== undefined) {
    const total = Object.keys(params).length + Object.keys(numbered.fields).length * numbered.max;
    if (total > STEP_PARAMS_MAX) errors.push(`${where}: ${total} parameters, above the limit ${STEP_PARAMS_MAX}`);
  } else if (Object.keys(params).length > STEP_PARAMS_MAX) errors.push(`${where}.params: above the limit ${STEP_PARAMS_MAX}`);

  const ops: PrepOperation[] = [];
  const rawOps = raw["translate"];
  if (!Array.isArray(rawOps) || rawOps.length < 1 || rawOps.length > 3) errors.push(`${where}.translate: must be 1 to 3 operations`);
  else {
    let captured = false;
    rawOps.forEach((o: unknown, i) => {
      const op = parseOperation(o, `${where}.translate[${i}]`, captured, errors);
      if (op === undefined) return;
      if (op.capture !== undefined) {
        if (captured) errors.push(`${where}.translate[${i}]: more than one capture`);
        captured = true;
      }
      ops.push(op);
    });
  }
  return Object.freeze({ kind, params: Object.freeze(params), ...(numbered !== undefined ? { numbered } : {}), translate: Object.freeze(ops) });
}

function parseNumbered(raw: unknown, where: string, errors: string[]): PrepNumbered | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) {
    errors.push(`${where}: must be an object`);
    return undefined;
  }
  onlyKeys(raw, ["name", "bodyList", "fields", "min", "max"], where, errors);
  const { name, bodyList, fields, min, max } = raw;
  if (typeof name !== "string" || !LOCAL_KEY.test(name)) errors.push(`${where}.name: must be a local key`);
  if (typeof bodyList !== "string" || !BODY_NAME.test(bodyList)) errors.push(`${where}.bodyList: must be a field name`);
  const lo = typeof min === "number" && Number.isSafeInteger(min) ? min : undefined;
  const hi = typeof max === "number" && Number.isSafeInteger(max) ? max : undefined;
  if (lo === undefined || hi === undefined || lo < 0 || lo > hi || hi < 1 || hi > NUMBERED_LINES_MAX) {
    errors.push(`${where}: min and max must be integers with 0 <= min <= max <= ${NUMBERED_LINES_MAX}`);
  }
  const rules: Record<string, PrepParamRule> = {};
  if (!isObj(fields) || Object.keys(fields).length < 1 || Object.keys(fields).length > 4) errors.push(`${where}.fields: must be 1 to 4 fields`);
  else {
    for (const [f, rule] of Object.entries(fields)) {
      checkName(f, `${where}.fields`, errors);
      if (NUMBERED_SUFFIX.test(f)) errors.push(`${where}.fields: ${JSON.stringify(f)} must not end with _<digits>`);
      if (hi !== undefined) {
        for (let n = 1; n <= hi; n += 1) if (FORBIDDEN_NAME.test(`${f}_${n}`)) errors.push(`${where}.fields: ${f}_${n} is a forbidden parameter name`);
      }
      const parsed = parseRule(rule, `${where}.fields.${f}`, errors);
      if (parsed !== undefined) {
        if (parsed.optional === true) errors.push(`${where}.fields.${f}: a numbered field cannot be optional`);
        rules[f] = parsed;
      }
    }
  }
  if (typeof name !== "string" || typeof bodyList !== "string" || lo === undefined || hi === undefined) return undefined;
  return Object.freeze({ name, bodyList, fields: Object.freeze(rules), min: lo, max: hi });
}

function parseInternal(raw: unknown, errors: string[]): PrepInternalOperation[] {
  const out: PrepInternalOperation[] = [];
  if (!Array.isArray(raw) || raw.length < 2 || raw.length > 16) {
    errors.push("internalOperations: must be 2 to 16 operations");
    return out;
  }
  raw.forEach((o: unknown, i) => {
    const where = `internalOperations[${i}]`;
    if (!isObj(o)) {
      errors.push(`${where}: must be an object`);
      return;
    }
    onlyKeys(o, ["method", "path"], where, errors);
    const { method, path } = o;
    if (method !== "GET" && method !== "POST") errors.push(`${where}.method: must be GET or POST`);
    if (typeof path !== "string" || !OP_PATH.test(path) || path.includes("..") || path.includes("//")) errors.push(`${where}.path: must be a plain path template`);
    if ((method === "GET" || method === "POST") && typeof path === "string") out.push(Object.freeze({ method, path }));
  });
  for (const need of [{ method: "GET", path: "/health" }, { method: "POST", path: "/reset" }]) {
    if (!out.some((o) => o.method === need.method && o.path === need.path)) errors.push(`internalOperations: must contain ${need.method} ${need.path}`);
  }
  return out;
}

/** Validates the table itself. Never throws. Returns the frozen table or every problem found. */
export function loadPreparationTable(raw: unknown): Result<PrepTable, string[]> {
  const errors: string[] = [];
  try {
    if (!isObj(raw)) return { ok: false, error: ["table is missing or not an object"] };
    onlyKeys(raw, ["schemaVersion", "internalOperations", "steps"], "table", errors);
    if (raw["schemaVersion"] !== 1) errors.push("schemaVersion: must be 1");
    const internalOperations = parseInternal(raw["internalOperations"], errors);
    const steps: PrepKind[] = [];
    const rawSteps = raw["steps"];
    if (!Array.isArray(rawSteps) || rawSteps.length < 1 || rawSteps.length > 32) errors.push("steps: must be 1 to 32 kinds");
    else {
      const seen = new Set<string>();
      rawSteps.forEach((s: unknown, i) => {
        const kind = parseKind(s, `steps[${i}]`, errors);
        if (kind === undefined) return;
        if (seen.has(kind.kind)) errors.push(`steps[${i}].kind: duplicate`);
        seen.add(kind.kind);
        steps.push(kind);
      });
    }
    if (errors.length > 0) return { ok: false, error: errors };
    return { ok: true, value: Object.freeze({ schemaVersion: 1 as const, internalOperations: Object.freeze(internalOperations), steps: Object.freeze(steps) }) };
  } catch {
    return { ok: false, error: ["table could not be validated"] };
  }
}