// Identity hashes of an Experiment, of the policy configuration, and of the preparation table (OD-17, decided 2026-11-12; tasks 2.15, 2.26).
//
// The decision (`policy_decision` record) and the execution must be about the same thing: the same Experiment content, the same policy
// configuration, and the same preparation table. Each is identified by the SHA-256 of its canonical JSON text. The canonical form is the
// one of the policy module (`canonicalJsonText`: keys sorted by UTF-16 code unit, no white space); `canonicalIdentityText` adds the
// refusals of the Evidence_Store's canonical JSON (non-finite numbers, integers outside the safe range, lone surrogates), so that for every
// value it accepts the text is byte-identical to the one of the Evidence_Store. A test compares the two on generated values.
//
// The hash is computed by the process that is checked. It detects a different Experiment or a different configuration (a mistake, a
// reload, a mix-up); it does not defend against a runtime that is itself compromised.
import { createHash } from "node:crypto";
import { canonicalJsonText } from "../policy/guards.js";
import type { PolicyConfig } from "../policy/types.js";
import type { PrepTable } from "../prep/types.js";

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function assertWritable(v: unknown, depth: number): void {
  if (depth > 64) throw new Error("nesting too deep");
  if (typeof v === "string") {
    if (LONE_SURROGATE.test(v)) throw new Error("lone surrogate");
  } else if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    if (Number.isInteger(v) && Math.abs(v) > Number.MAX_SAFE_INTEGER) throw new Error("unsafe integer");
  } else if (Array.isArray(v)) {
    for (const x of v) assertWritable(x, depth + 1);
  } else if (typeof v === "object" && v !== null) {
    for (const k of Object.keys(v)) {
      if (LONE_SURROGATE.test(k)) throw new Error("lone surrogate in a key");
      assertWritable((v as Record<string, unknown>)[k], depth + 1);
    }
  }
}

/** Canonical JSON text of a value, or a throw if the value cannot be written canonically. */
export function canonicalIdentityText(v: unknown): string {
  assertWritable(v, 0);
  return canonicalJsonText(v);
}

export const sha256OfText = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The hash of an Experiment: the whole object that the Runner is asked to execute. Throws if it is not JSON. */
export function experimentSha256(e: unknown): string {
  return sha256OfText(canonicalIdentityText(e));
}

/** The hash of the policy configuration: everything except the preparation table, which has its own hash. */
export function policyConfigSha256(cfg: PolicyConfig): string {
  const { preparationTable: _table, ...rest } = cfg;
  void _table;
  return sha256OfText(canonicalIdentityText(rest));
}

export function preparationTableSha256(table: PrepTable): string {
  return sha256OfText(canonicalIdentityText(table));
}

/** What a decision must have been made about, to be valid for an execution. */
export interface ExecutionIdentity {
  readonly experimentSha256: string;
  readonly policyConfigSha256: string;
  readonly preparationTableSha256: string;
}

export function executionIdentity(e: unknown, cfg: PolicyConfig, table: PrepTable): ExecutionIdentity {
  return { experimentSha256: experimentSha256(e), policyConfigSha256: policyConfigSha256(cfg), preparationTableSha256: preparationTableSha256(table) };
}