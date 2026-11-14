// The check that an execution is allowed by a recorded decision (OD-17, R9.2, R9.3; decided 2026-11-12).
//
// `verifyAcceptance` is a pure function over a view of the records of the Evidence_Store. It accepts only if:
//   - the decision record exists and is a `policy_decision`;
//   - its Experiment identifier equals the one to execute;
//   - the store holds exactly one `policy_decision` for that identifier, and none of them is a `reject`;
//   - that decision is `accept`, with an empty rule list;
//   - the three hashes of the record equal the hashes computed now: the Experiment content, the policy configuration, and the preparation table.
// Anything else is a refusal with a code. The function never throws.
import { isPlainObject } from "../policy/guards.js";
import type { PolicyConfig, PolicyDecision } from "../policy/types.js";
import { decide } from "../policy/decide.js";
import type { PrepTable } from "../prep/types.js";
import { executionIdentity, type ExecutionIdentity } from "./hash.js";

/** The part of an Evidence_Store record that the check reads. */
export interface RecordView {
  readonly id: string;
  readonly kind: string;
  readonly payload: unknown;
}

export type AcceptanceRefusal =
  | "record_missing"
  | "record_not_policy_decision"
  | "payload_malformed"
  | "experiment_id_mismatch"
  | "reject_exists"
  | "decision_not_unique"
  | "decision_not_accept"
  | "experiment_content_changed"
  | "policy_config_changed"
  | "preparation_table_changed";

export type AcceptanceVerdict = { readonly accepted: true } | { readonly accepted: false; readonly code: AcceptanceRefusal };

/** The payload of a `policy_decision` record: the decision of R8.2 and the identity that it was made about. */
export interface PolicyDecisionPayload extends PolicyDecision, ExecutionIdentity {}

/**
 * Evaluates an Experiment and builds the payload of the `policy_decision` record: Experiment identifier, decision, ordered rule ids,
 * and the three hashes. The Loop_Orchestrator appends it as a record of the kind `policy_decision` (the payload of that kind is a free object).
 */
export function evaluateForRecord(e: import("../policy/types.js").Experiment, cfg: PolicyConfig): PolicyDecisionPayload {
  const decision = decide(e, cfg);
  let identity: ExecutionIdentity;
  try {
    identity = executionIdentity(e, cfg, cfg.preparationTable);
  } catch {
    // An Experiment that cannot be hashed is not JSON; it cannot be accepted.
    const zero = "0".repeat(64);
    return { experimentId: decision.experimentId, decision: "reject", ruleIds: ["POL-099"], experimentSha256: zero, policyConfigSha256: zero, preparationTableSha256: zero };
  }
  return { ...decision, ...identity };
}

const HEX64 = /^[0-9a-f]{64}$/;

function payloadOf(r: RecordView): Record<string, unknown> | undefined {
  return isPlainObject(r.payload) ? r.payload : undefined;
}

export function verifyAcceptance(
  records: readonly RecordView[],
  experimentId: string,
  decisionRecordId: string,
  identity: ExecutionIdentity,
): AcceptanceVerdict {
  const refuse = (code: AcceptanceRefusal): AcceptanceVerdict => ({ accepted: false, code });
  try {
    if (typeof experimentId !== "string" || typeof decisionRecordId !== "string" || decisionRecordId === "") return refuse("record_missing");
    const record = records.find((r) => r.id === decisionRecordId);
    if (record === undefined) return refuse("record_missing");
    if (record.kind !== "policy_decision") return refuse("record_not_policy_decision");
    const payload = payloadOf(record);
    if (payload === undefined || typeof payload["experimentId"] !== "string") return refuse("payload_malformed");
    if (payload["experimentId"] !== experimentId) return refuse("experiment_id_mismatch");

    const same = records.filter((r) => r.kind === "policy_decision" && payloadOf(r)?.["experimentId"] === experimentId);
    if (same.some((r) => payloadOf(r)?.["decision"] === "reject")) return refuse("reject_exists");
    if (same.length !== 1) return refuse("decision_not_unique");
    if (payload["decision"] !== "accept") return refuse("decision_not_accept");
    const ruleIds = payload["ruleIds"];
    if (!Array.isArray(ruleIds) || ruleIds.length !== 0) return refuse("payload_malformed");

    const recorded = {
      experiment: payload["experimentSha256"],
      policy: payload["policyConfigSha256"],
      table: payload["preparationTableSha256"],
    };
    for (const h of [recorded.experiment, recorded.policy, recorded.table]) if (typeof h !== "string" || !HEX64.test(h)) return refuse("payload_malformed");
    if (recorded.experiment !== identity.experimentSha256) return refuse("experiment_content_changed");
    if (recorded.policy !== identity.policyConfigSha256) return refuse("policy_config_changed");
    if (recorded.table !== identity.preparationTableSha256) return refuse("preparation_table_changed");
    return { accepted: true };
  } catch {
    return refuse("payload_malformed");
  }
}

/** The `isAccepted` callback of the Runner, over a live view of the records. */
export function createAcceptanceCheck(records: () => readonly RecordView[]): (experimentId: string, decisionRecordId: string, identity: ExecutionIdentity) => AcceptanceVerdict {
  return (experimentId, decisionRecordId, identity) => verifyAcceptance(records(), experimentId, decisionRecordId, identity);
}