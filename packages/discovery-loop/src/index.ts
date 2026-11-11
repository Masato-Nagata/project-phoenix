// Public entry point of @phoenix/discovery-loop.
export const PACKAGE_NAME = "@phoenix/discovery-loop" as const;
// JSON schemas, strict parser and validator wrapper (M1 task 1.3).
export * from "./schema/index.js";
// Canonical JSON serialization and parsing (M1 task 1.4).
export * from "./canonical/index.js";
// Origin / Evidence data model (M1 task 1.14). The Approval read side (readFacts, ApprovalStatusReader) is
// not exported here: it belongs to the report entry point, and the runtime exports no Approval writer or reader.
export {
  CITATION_VERIFIER,
  EvidenceStore,
  deriveApprovalStatus,
  deriveExperimentStatus,
  deriveSourceStatus,
  discardAiAuthorityFields,
  experimentRuleComponent,
  isAuthorityLikeName,
} from "./model/index.js";
export type {
  AppendEvidenceRequest,
  ComparatorResult,
  CreateClaimRevisionInput,
  EvidenceKind,
  EvidenceRecord,
  EvidenceStatus,
  ExperimentOutcome,
  Origin,
  StoredClaimRevisionRecord,
  StoreError,
  StoreEvent,
  StoreResult,
} from "./model/index.js";
// Evidence_Store write path: record envelope, hash chain, atomic JSONL writes, secret rejection (M1 task 1.9).
export * from "./store/index.js";
