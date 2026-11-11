// Origin / Evidence / Approval data model (task 1.14). Deliberately exports no Approval writer (R6.11).
export { deriveApprovalStatus, deriveExperimentStatus, deriveSourceStatus } from "./derive.js";
export { CITATION_VERIFIER, EvidenceStore, experimentRuleComponent } from "./evidenceStore.js";
export type { AppendEvidenceRequest, ComparatorResult, CreateClaimRevisionInput } from "./evidenceStore.js";
export { readFacts } from "./facts.js";
export type { ApprovalStatusReader, ClaimRevisionApprovalTarget } from "./facts.js";
export { discardAiAuthorityFields, isAuthorityLikeName } from "./sanitize.js";
export type { DiscardedField } from "./sanitize.js";
export type * from "./types.js";
