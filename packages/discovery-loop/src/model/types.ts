// Types of the Origin / Evidence / Approval model (design: "Stored forms", "Evidence record").
// The value sets mirror the enumerations of common.schema.json (Origin, EvidenceKind, EvidenceStatus,
// ApprovalStatus, ApprovalDecision); the test suite checks that they stay in step with the schema.
// Provenance, evidence and approval are three separate concepts and never share a field (R6.1, R6.9).
import type { Result } from "../schema/index.js";

export type Origin = "ai-inferred" | "human-authored";
export type EvidenceKind = "source" | "experiment";
export type EvidenceStatus = "absent" | "supported" | "contradicted" | "mixed";
export type ApprovalDecision = "approved" | "rejected" | "needs_changes";
export type ApprovalStatus = "none" | ApprovalDecision;
export type ExperimentOutcome = "supports" | "contradicts" | "inconclusive";
export type CitationFailureReason =
  | "malformed_citation"
  | "file_not_in_bundle"
  | "range_out_of_bounds"
  | "quote_not_found"
  | "source_unavailable";

export interface CitationResult {
  index: number;
  result: "verified" | "failed";
  reason?: CitationFailureReason;
}

/** An Evidence record as validated by evidence.schema.json. Evidence never carries an Origin or an Approval. */
export interface EvidenceRecord {
  evidenceId: string;
  kind: EvidenceKind;
  claimRevisionId: string;
  outcome?: ExperimentOutcome;
  citationRecordId?: string;
  citations?: CitationResult[];
  experimentId?: string;
  comparisonRecordId?: string;
  observationRecordId?: string;
  predictionRecordId?: string;
}

export type JsonObject = { [k: string]: unknown };

/**
 * One stored Claim revision. Origin is written once at creation. Evidence and Approval are NOT fields
 * of this record (R6.9, R6.14); they are separate records that are linked by `claimRevisionId`.
 */
export interface StoredClaimRevisionRecord {
  readonly claimId: string;
  readonly claimRevisionId: string;
  readonly revision: number;
  readonly predecessorRevisionId?: string;
  readonly reason: string;
  /** Evidence ids that prompted this revision. They stay linked to their own earlier revision (R6.14). */
  readonly linkedEvidenceIds: readonly string[];
  readonly origin: Origin;
  /** The claim content with every AI-supplied authority-like field removed. */
  readonly content: JsonObject;
}

export type StoreAttempt =
  | "set_origin"
  | "append_evidence_disallowed_kind"
  | "append_evidence_disallowed_actor";

/** Recorded refusal. Names the component, never a rejected value (shape of StoreRejectionPayload). */
export interface StoreRejectionEvent {
  readonly type: "store_rejection";
  readonly attempt: StoreAttempt;
  readonly component: string;
  readonly reason: string;
  readonly targetRecordId?: string;
}

/** Names the discarded field and where it was, never its value (R6.16, R23.6). */
export interface AiContentDiscardedEvent {
  readonly type: "ai_content_discarded";
  readonly aiOutputRecordId: string;
  readonly fields: readonly { path: string; name: string }[];
}

export interface ClaimRevisionEvent {
  readonly type: "claim_revision";
  readonly claimRevisionId: string;
}
export interface EvidenceEvent {
  readonly type: "evidence";
  readonly evidenceId: string;
}
export type StoreEvent = StoreRejectionEvent | AiContentDiscardedEvent | ClaimRevisionEvent | EvidenceEvent;

export interface UnknownIdError {
  readonly kind: "unknown_id";
  readonly id: string;
  readonly message: string;
}
export interface InvalidRequestError {
  readonly kind: "invalid_request";
  readonly message: string;
}
export interface RejectedError {
  readonly kind: "rejected";
  readonly attempt: StoreAttempt;
  readonly component: string;
  readonly message: string;
}
export type StoreError = UnknownIdError | InvalidRequestError | RejectedError;
export type StoreResult<T> = Result<T, StoreError>;

/** The four facts of one Claim revision, as four separate values (R6.10; shape of common Facts). */
export interface Facts {
  claimRevisionId: string;
  origin: Origin;
  sourceEvidenceStatus: EvidenceStatus;
  experimentEvidenceStatus: EvidenceStatus;
  approvalStatus: ApprovalStatus;
}
