// Validation of one preparation step against the table, and the request body built from it (task 2.15).
// `validatePreparationStep` is the single definition of a valid step: the policy (POL-011, wired in task 2.26) and the runner both call it.
import type { Json } from "../compare/types.js";
import type { Result } from "../policy/types.js";
import type { PrepKind, PrepNumbered, PrepParamRule, PrepScalar, PrepStepInput, PrepTable, ValidatedStep } from "./types.js";

const BIND_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/** True when the value breaks the rule: wrong type or outside the range. A scalar only; null and anything else break every rule. */
function breaks(value: unknown, rule: PrepParamRule): boolean {
  switch (rule.type) {
    case "integer":
      return typeof value !== "number" || !Number.isSafeInteger(value) || (rule.min !== undefined && value < rule.min) || (rule.max !== undefined && value > rule.max);
    case "string":
      return typeof value !== "string" || value.length > (rule.maxLength ?? 128) || (rule.enum !== undefined && !rule.enum.includes(value));
    case "boolean":
      return typeof value !== "boolean";
  }
}

/** Splits `<field>_<digits>` for one of the fields of the group. `digits` is returned as written. */
function splitNumbered(name: string, group: PrepNumbered): { field: string; digits: string } | undefined {
  for (const field of Object.keys(group.fields)) {
    if (name.startsWith(`${field}_`)) {
      const rest = name.slice(field.length + 1);
      if (/^[0-9]+$/.test(rest)) return { field, digits: rest };
    }
  }
  return undefined;
}

/**
 * Decides whether a step is valid. The issues, in the order they are found for sorted parameter names (stable and deterministic):
 *   kind_unknown, step_shape, bind_invalid, param_unknown:<name>, param_missing:<name>, value_invalid:<name>,
 *   numbered_index_invalid:<name> (0, a leading zero), numbered_over_max:<name>, numbered_incomplete:<n> (one field of an index only),
 *   numbered_gap (the indexes are not exactly 1 to k), numbered_under_min.
 * Never throws.
 */
export function validatePreparationStep(table: PrepTable, step: unknown): Result<ValidatedStep, string[]> {
  const issues: string[] = [];
  try {
    if (!isObj(step)) return { ok: false, error: ["step_shape"] };
    for (const k of Object.keys(step)) if (k !== "kind" && k !== "bind" && k !== "params") issues.push("step_shape");
    const kind: PrepKind | undefined = typeof step["kind"] === "string" ? table.steps.find((s) => s.kind === step["kind"]) : undefined;
    if (kind === undefined) return { ok: false, error: [...issues, "kind_unknown"] };
    const bind = step["bind"];
    if (bind !== undefined && (typeof bind !== "string" || !BIND_NAME.test(bind))) issues.push("bind_invalid");
    const params = step["params"];
    if (!isObj(params)) return { ok: false, error: [...issues, "step_shape"] };

    const fixed: Record<string, PrepScalar> = {};
    const values = new Map<number, Record<string, PrepScalar>>(); // valid values by line index
    const fieldsOf = new Map<number, Set<string>>(); // the fields present for each line index, valid or not
    for (const name of Object.keys(params).sort()) {
      const value = params[name];
      const rule = hasOwn(kind.params, name) ? kind.params[name] : undefined;
      if (rule !== undefined) {
        if (breaks(value, rule)) issues.push(`value_invalid:${name}`);
        else fixed[name] = value as PrepScalar;
        continue;
      }
      const split = kind.numbered === undefined ? undefined : splitNumbered(name, kind.numbered);
      if (kind.numbered === undefined || split === undefined) {
        issues.push(`param_unknown:${name}`);
        continue;
      }
      const { field, digits } = split;
      if (digits.startsWith("0")) {
        issues.push(`numbered_index_invalid:${name}`); // 0 or a leading zero
        continue;
      }
      if (digits.length > 3 || Number(digits) > kind.numbered.max) {
        issues.push(`numbered_over_max:${name}`);
        continue;
      }
      const n = Number(digits);
      fieldsOf.set(n, (fieldsOf.get(n) ?? new Set<string>()).add(field));
      if (breaks(value, kind.numbered.fields[field] as PrepParamRule)) issues.push(`value_invalid:${name}`);
      else values.set(n, { ...(values.get(n) ?? {}), [field]: value as PrepScalar });
    }
    for (const [name, rule] of Object.entries(kind.params)) {
      if (!hasOwn(params, name) && rule.optional !== true) issues.push(`param_missing:${name}`);
    }
    const lines: Record<string, PrepScalar>[] = [];
    if (kind.numbered !== undefined) {
      const group = kind.numbered;
      const indexes = [...fieldsOf.keys()].sort((x, y) => x - y);
      const largest = indexes.length === 0 ? 0 : (indexes[indexes.length - 1] as number);
      for (const n of indexes) {
        if ((fieldsOf.get(n) as Set<string>).size < Object.keys(group.fields).length) issues.push(`numbered_incomplete:${n}`);
      }
      if (indexes.length !== largest) issues.push("numbered_gap"); // the indexes are not exactly 1 to k
      else if (largest < group.min) issues.push("numbered_under_min");
      for (const n of indexes) {
        const line = values.get(n);
        if (line !== undefined) lines.push(line);
      }
    }    if (issues.length > 0) return { ok: false, error: issues };
    return { ok: true, value: Object.freeze({ kind, ...(typeof bind === "string" ? { bind } : {}), fixed: Object.freeze(fixed), lines: Object.freeze(lines.map((l) => Object.freeze(l))) }) };
  } catch {
    return { ok: false, error: ["step_shape"] };
  }
}

/** Validates the steps of an Experiment: each step, and that a `bind` name is used at most once (the policy rule for binds). */
export function validatePreparationSteps(table: PrepTable, steps: readonly unknown[]): Result<readonly ValidatedStep[], string[]> {
  const out: ValidatedStep[] = [];
  const issues: string[] = [];
  const binds = new Set<string>();
  steps.forEach((s, i) => {
    const r = validatePreparationStep(table, s);
    if (!r.ok) {
      for (const e of r.error) issues.push(`step[${i}]:${e}`);
      return;
    }
    if (r.value.bind !== undefined) {
      if (binds.has(r.value.bind)) issues.push(`step[${i}]:bind_duplicate`);
      binds.add(r.value.bind);
    }
    out.push(r.value);
  });
  return issues.length > 0 ? { ok: false, error: issues } : { ok: true, value: out };
}

/**
 * The request body of an `assembled` operation, built from the same definition: the fixed parameters under their body names, and the
 * list of lines in numeric order with exactly the given values. Fails for a step that is not valid.
 */
export function buildStepBody(table: PrepTable, step: unknown): Result<Json, string[]> {
  const v = validatePreparationStep(table, step);
  if (!v.ok) return v;
  const { kind, fixed, lines } = v.value;
  const body: { [k: string]: Json } = {};
  for (const [name, value] of Object.entries(fixed)) body[(kind.params[name] as PrepParamRule).body] = value;
  if (kind.numbered !== undefined) {
    const group = kind.numbered;
    body[group.bodyList] = lines.map((line) => {
      const o: { [k: string]: Json } = {};
      for (const [field, value] of Object.entries(line)) o[(group.fields[field] as PrepParamRule).body] = value;
      return o;
    });
  }
  return { ok: true, value: body };
}