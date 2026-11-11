// Read side that joins the four facts. Approval is derived only from records that a reader hands in;
// the Evidence_Store never holds an Approval. This module has no write path to the Approval_Store,
// and the payload builders do not import it (R6.11).
import type { EvidenceStore } from "./evidenceStore.js";
import type { ApprovalStatus, Facts, StoreResult } from "./types.js";

export interface ClaimRevisionApprovalTarget {
  kind: "claim_revision";
  runId: string;
  claimRevisionId: string;
}

/** Read-only view of the Approval_Store (the ApprovalReader of task 1.16 satisfies it). No write method. */
export interface ApprovalStatusReader {
  approvalStatus(target: ClaimRevisionApprovalTarget): ApprovalStatus;
}

/** Four separate values for one Claim revision, never merged. Unknown identifier is an error, never a default. */
export function readFacts(
  store: EvidenceStore,
  runId: string,
  claimRevisionId: string,
  approvals: ApprovalStatusReader,
): StoreResult<Facts> {
  const origin = store.originOf(claimRevisionId);
  if (!origin.ok) return origin;
  const source = store.sourceStatusOf(claimRevisionId);
  const experiment = store.experimentStatusOf(claimRevisionId);
  if (!source.ok) return source;
  if (!experiment.ok) return experiment;
  return {
    ok: true,
    value: {
      claimRevisionId,
      origin: origin.value,
      sourceEvidenceStatus: source.value,
      experimentEvidenceStatus: experiment.value,
      approvalStatus: approvals.approvalStatus({ kind: "claim_revision", runId, claimRevisionId }),
    },
  };
}
