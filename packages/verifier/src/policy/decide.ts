// Experiment_Policy decision (design: "Experiment_Policy", "Matching rules", "Rules and fixed order"; R8; task 2.8).
//
// Pure: the decision depends only on the Experiment content and the configuration. No AI call, no network, no clock,
// no random value (R8.2). It never throws: any internal failure becomes the single rule id POL-099 (R8.9).
//
// Order of the rule ids in a decision: by rule order (POL-001 ... POL-013), then by location. Locations are ordered as
// follows: the Experiment itself, then the requests by index, then the state checks by index, then the preparation
// steps by index. The same rule id appears once per violating location.
import type { PrepTable } from "../prep/types.js";
import { canonicalJsonText, isPlainObject } from "./guards.js";
import { decodedForms, foldPath, isDeniedFolded } from "./fold.js";
import { validatePreparationStep } from "../prep/step.js";
import { loadPolicyConfig } from "./config.js";
import {
  POLICY_RULE_IDS,
  type DetailedPolicyDecision,
  type Experiment,
  type PolicyConfig,
  type PolicyDecision,
  type PolicyRuleId,
  type PolicyViolation,
  type ViolationGroup,
} from "./types.js";

const GROUP_ORDER: Record<ViolationGroup, number> = { experiment: 0, requests: 1, stateChecks: 2, preparation: 3 };
/** A decision never inspects more than this many items of one list; the count rules reject such an Experiment anyway. */
const MAX_ITEMS_EXAMINED = 100;
const BIND_NAME = /^[a-z][a-z0-9_]{0,31}$/;
const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const PLACEHOLDER = /\{([^{}]*)\}/g;
const textEncoder = new TextEncoder();

type Add = (ruleId: PolicyRuleId, group: ViolationGroup, index: number) => void;

function asList(value: unknown, name: string): readonly unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${name} is not a list`);
  return value as readonly unknown[];
}

function hasUrlForm(raw: string): boolean {
  return decodedForms(raw).some((f) => SCHEME.test(f) || f.startsWith("//") || f.includes("://"));
}

function hasTraversal(raw: string): boolean {
  return decodedForms(raw).some((f) => f.includes(".."));
}

function placeholdersOf(path: string): string[] {
  const names = new Set<string>();
  for (const m of path.matchAll(PLACEHOLDER)) names.add(m[1] ?? "");
  return [...names];
}

function checkRequest(
  req: unknown,
  group: "requests" | "stateChecks",
  index: number,
  cfg: PolicyConfig,
  binds: ReadonlySet<string>,
  add: Add,
): void {
  if (!isPlainObject(req)) {
    add("POL-003", group, index);
    return;
  }
  const { method, path } = req;
  const operation =
    typeof method === "string" && typeof path === "string"
      ? cfg.operations.find((o) => o.method === method && o.path === path)
      : undefined;

  // POL-003: exact operation match, no normalization (R8.1).
  if (operation === undefined) add("POL-003", group, index);

  if (typeof path === "string") {
    // POL-004 / POL-005: deny after folding, whatever the allowlist says (R8.4, R8.5).
    const denied = isDeniedFolded(foldPath(path), cfg.denyFolded);
    if (denied.reset) add("POL-004", group, index);
    if (denied.namespace) add("POL-005", group, index);
    // POL-006: absolute URL, scheme, authority (R8.7).
    if (hasUrlForm(path)) add("POL-006", group, index);
    // POL-007: path traversal, raw or percent-encoded (R8.7).
    if (hasTraversal(path)) add("POL-007", group, index);
  }

  // POL-008: header allowlist (R8.7).
  const headers = req["headers"];
  if (headers !== undefined) {
    let bad = false;
    if (!isPlainObject(headers)) bad = true;
    else {
      const seen = new Set<string>();
      for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();
        const allowed = cfg.headers.find((h) => h.name === lower);
        if (allowed === undefined || value !== allowed.value || seen.has(lower)) bad = true;
        seen.add(lower);
      }
    }
    if (bad) add("POL-008", group, index);
  }

  // POL-009: canonical body size (R8.8). A body that is not JSON makes the decision uncomputable (throws -> POL-099).
  const body = req["body"];
  if (body !== undefined) {
    if (textEncoder.encode(canonicalJsonText(body)).length > cfg.limits.bodyBytes) add("POL-009", group, index);
  }

  // POL-010: path parameters (design: "Path parameters").
  if (typeof path === "string") {
    const names = placeholdersOf(path);
    const given = req["pathParams"];
    let bad = false;
    if (given !== undefined && !isPlainObject(given)) bad = true;
    else {
      const params: Record<string, unknown> = given === undefined ? {} : (given as Record<string, unknown>);
      const keys = Object.keys(params);
      if (names.some((n) => !keys.includes(n)) || keys.some((k) => !names.includes(k))) bad = true;
      for (const k of keys) {
        const v = params[k];
        if (typeof v === "number") {
          if (!Number.isSafeInteger(v) || v < cfg.pathParam.min || v > cfg.pathParam.max) bad = true;
        } else if (isPlainObject(v)) {
          const bindKeys = Object.keys(v);
          const target = v["$bind"];
          if (bindKeys.length !== 1 || typeof target !== "string" || !binds.has(target)) bad = true;
        } else bad = true;
      }
    }
    if (bad) add("POL-010", group, index);
  }

  // POL-012: a body on a GET request.
  if (method === "GET" && body !== undefined) add("POL-012", group, index);

  // POL-013: a state check must be a known read-only operation.
  if (group === "stateChecks" && (operation === undefined || !operation.readOnly)) add("POL-013", group, index);
}

/**
 * POL-011 (task 2.26): the step is valid if and only if `validatePreparationStep` of the loaded preparation table accepts it, so the
 * policy and the runner use one definition. A `bind` name may be used by one step only; a name is counted even when the rest of the
 * step is not valid.
 */
function checkPreparationStep(step: unknown, index: number, cfg: PolicyConfig, seenBinds: Set<string>, add: Add): void {
  let bad = !validatePreparationStep(cfg.preparationTable, step).ok;
  const bind = isPlainObject(step) ? step["bind"] : undefined;
  if (typeof bind === "string" && BIND_NAME.test(bind)) {
    if (seenBinds.has(bind)) bad = true;
    else seenBinds.add(bind);
  }
  if (bad) add("POL-011", "preparation", index);
}
function collect(e: Experiment, cfg: PolicyConfig): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  const add: Add = (ruleId, group, index) => out.push({ ruleId, group, index });

  // The Experiment itself must be an object with a request list; anything else cannot be decided (R8.9).
  if (!isPlainObject(e)) throw new Error("Experiment is not an object");
  if (!Array.isArray(e.requests)) throw new Error("requests is not a list");
  const requests = asList(e.requests, "requests");
  const stateChecks = asList(e.stateChecks, "stateChecks");
  const preparation = asList(e.preparation, "preparation");

  // POL-001, POL-002: counts (R8.8).
  if (requests.length > cfg.limits.requests) add("POL-001", "experiment", 0);
  if (preparation.length > cfg.limits.preparationSteps) add("POL-002", "experiment", 0);
  if (stateChecks.length > cfg.limits.stateChecks) add("POL-002", "experiment", 1);

  // Names a request may bind: those declared by the preparation steps, collected in step order.
  const binds = new Set<string>();
  for (const step of preparation.slice(0, MAX_ITEMS_EXAMINED)) {
    if (isPlainObject(step) && typeof step["bind"] === "string") binds.add(step["bind"]);
  }

  requests.slice(0, MAX_ITEMS_EXAMINED).forEach((r, i) => checkRequest(r, "requests", i, cfg, binds, add));
  stateChecks.slice(0, MAX_ITEMS_EXAMINED).forEach((r, i) => checkRequest(r, "stateChecks", i, cfg, binds, add));
  const seenBinds = new Set<string>();
  preparation.slice(0, MAX_ITEMS_EXAMINED).forEach((s, i) => checkPreparationStep(s, i, cfg, seenBinds, add));
  return out;
}

const RULE_ORDER = new Map<PolicyRuleId, number>(POLICY_RULE_IDS.map((id, i) => [id, i]));

function safeExperimentId(e: unknown): string {
  try {
    const id = (e as { experimentId?: unknown } | null | undefined)?.experimentId;
    return typeof id === "string" ? id : "";
  } catch {
    return "";
  }
}

/** The decision with the location of every violation. Never throws. */
export function decideDetailed(e: Experiment, cfg: PolicyConfig): DetailedPolicyDecision {
  const experimentId = safeExperimentId(e);
  try {
    const violations = collect(e, cfg).sort(
      (a, b) =>
        (RULE_ORDER.get(a.ruleId) ?? 0) - (RULE_ORDER.get(b.ruleId) ?? 0) ||
        GROUP_ORDER[a.group] - GROUP_ORDER[b.group] ||
        a.index - b.index,
    );
    return {
      experimentId,
      decision: violations.length === 0 ? "accept" : "reject",
      ruleIds: violations.map((v) => v.ruleId),
      violations,
    };
  } catch {
    // R8.9: a decision that cannot be computed is a reject with an evaluation-failure reason.
    return {
      experimentId,
      decision: "reject",
      ruleIds: ["POL-099"],
      violations: [{ ruleId: "POL-099", group: "experiment", index: 0 }],
    };
  }
}

/** The decision record content (R8.2): Experiment id, decision, and the ordered rule ids. Pure; never throws. */
export function decide(e: Experiment, cfg: PolicyConfig): PolicyDecision {
  const { experimentId, decision, ruleIds } = decideDetailed(e, cfg);
  return { experimentId, decision, ruleIds };
}

/** An engine bound to one configuration. When the configuration does not load, every Experiment is rejected (R8.6). */
export interface PolicyEngine {
  /** False when the configuration is missing, malformed, or widened. The Loop_Orchestrator refuses to start the Run then. */
  readonly ready: boolean;
  readonly errors: readonly string[];
  decide(e: Experiment): PolicyDecision;
}

export function createPolicyEngine(rawConfig: unknown, table: PrepTable): PolicyEngine {
  const loaded = loadPolicyConfig(rawConfig, table);
  if (!loaded.ok) {
    return {
      ready: false,
      errors: loaded.error,
      decide: (e) => ({ experimentId: safeExperimentId(e), decision: "reject", ruleIds: ["POL-099"] }),
    };
  }
  const cfg = loaded.value;
  return { ready: true, errors: [], decide: (e) => decide(e, cfg) };
}
