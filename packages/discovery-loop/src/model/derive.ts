// Pure status derivation (R6.4 to R6.7, R6.18). No clock, no other Evidence kind, no record order.
import type { ApprovalDecision, ApprovalStatus, EvidenceRecord, EvidenceStatus, ExperimentOutcome } from "./types.js";

function fromCounts(supporting: number, contradicting: number): EvidenceStatus {
  if (supporting === 0 && contradicting === 0) return "absent";
  if (contradicting === 0) return "supported";
  if (supporting === 0) return "contradicted";
  return "mixed";
}

/**
 * `source` status of one Claim revision from its `source` records. Records of another kind are ignored.
 * The Citation results of all given `source` records are pooled, which makes the result independent of
 * record order. With the one record per verification of the design this equals that record's rule:
 * no record -> absent; all verified -> supported; none verified -> contradicted; some -> mixed.
 */
export function deriveSourceStatus(records: readonly EvidenceRecord[]): EvidenceStatus {
  let verified = 0;
  let failed = 0;
  for (const r of records) {
    if (r.kind !== "source") continue;
    for (const c of r.citations ?? []) {
      if (c.result === "verified") verified += 1;
      else failed += 1;
    }
  }
  return fromCounts(verified, failed);
}

/** `experiment` status from the outcomes of `experiment` records; `inconclusive` counts as neither. */
export function deriveExperimentStatus(records: readonly Pick<EvidenceRecord, "kind" | "outcome">[]): EvidenceStatus {
  let supports = 0;
  let contradicts = 0;
  for (const r of records) {
    if (r.kind !== "experiment") continue;
    const o: ExperimentOutcome | undefined = r.outcome;
    if (o === "supports") supports += 1;
    else if (o === "contradicts") contradicts += 1;
  }
  return fromCounts(supports, contradicts);
}

/**
 * Approval status from the Approval_Records that target one Claim revision (R6.9): `none` without a
 * record, otherwise the decision of the record with the highest chain position (`seq`).
 */
export function deriveApprovalStatus(records: readonly { seq: number; decision: ApprovalDecision }[]): ApprovalStatus {
  let best: { seq: number; decision: ApprovalDecision } | undefined;
  for (const r of records) if (best === undefined || r.seq > best.seq) best = r;
  return best === undefined ? "none" : best.decision;
}
