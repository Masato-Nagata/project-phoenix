// Experiment_Policy types (design: "Experiment_Policy"; R8; task 2.8, amended by task 2.26).
import type { PrepTable } from "../prep/types.js";

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Rule ids in their fixed order (design table). The order of this array is the order used in a decision. */
export const POLICY_RULE_IDS = [
  "POL-001", "POL-002", "POL-003", "POL-004", "POL-005", "POL-006", "POL-007",
  "POL-008", "POL-009", "POL-010", "POL-011", "POL-012", "POL-013", "POL-099",
] as const;
export type PolicyRuleId = (typeof POLICY_RULE_IDS)[number];

export interface PolicyOperation {
  readonly method: string;
  readonly path: string;
  readonly readOnly: boolean;
}

export interface PolicyHeader {
  readonly name: string;
  readonly value: string;
}

export interface PolicyConfig {
  readonly schemaVersion: 1;
  readonly operations: readonly PolicyOperation[];
  readonly denyFolded: { readonly equals: readonly string[]; readonly prefixes: readonly string[] };
  readonly headers: readonly PolicyHeader[];
  readonly limits: {
    readonly requests: number;
    readonly stateChecks: number;
    readonly preparationSteps: number;
    readonly bodyBytes: number;
  };
  readonly pathParam: { readonly min: number; readonly max: number };
  /**
   * The loaded runner-owned preparation table: the single definition of the kinds and the parameters (task 2.26). POL-011 calls
   * `validatePreparationStep` with it, so the policy and the runner cannot disagree. It is given to `loadPolicyConfig`, never read from the file.
   */
  readonly preparationTable: PrepTable;
}

/** Shape the policy reads from an Experiment. Content is untrusted; `decide` re-checks it at run time. */
export interface PolicyRequest {
  readonly method: string;
  readonly path: string;
  readonly pathParams?: Readonly<Record<string, unknown>>;
  readonly headers?: Readonly<Record<string, unknown>>;
  readonly body?: unknown;
}

export interface PolicyPreparationStep {
  readonly kind: string;
  readonly bind?: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface Experiment {
  readonly experimentId: string;
  readonly target?: unknown;
  readonly preparation?: readonly PolicyPreparationStep[];
  readonly requests: readonly PolicyRequest[];
  readonly stateChecks?: readonly PolicyRequest[];
  readonly prediction?: unknown;
}

/** The decision record content (design: experiment id, decision, ordered rule ids). */
export interface PolicyDecision {
  readonly experimentId: string;
  readonly decision: "accept" | "reject";
  readonly ruleIds: PolicyRuleId[];
}

export type ViolationGroup = "experiment" | "requests" | "stateChecks" | "preparation";

/** Location of one violation. Diagnostic only; the decision record carries just the rule ids. */
export interface PolicyViolation {
  readonly ruleId: PolicyRuleId;
  readonly group: ViolationGroup;
  readonly index: number;
}

export interface DetailedPolicyDecision extends PolicyDecision {
  readonly violations: PolicyViolation[];
}
