// Test and tooling path of the Approval_Store: the pure validator and the chain builder (task 1.16).
// Used by unit tests and by golden-vector generation only. Deliberately NOT reachable from
// src/index.ts (the runtime entry point), which must offer no way to create an Approval_Record.
// The production writer is the host-side PowerShell command (task 4.10).
export { validateApprovalCandidate, fieldNames, CANDIDATE_FIELDS } from "./validate.js";
export type { FieldIssue, FieldIssueCode, ValidationContext } from "./validate.js";
export { appendApproval, appendStoreRejection, buildApprovalLine, buildChain, buildStoreRejectionLine } from "./build.js";
export type { AppendError } from "./build.js";
export { computeLineHash, hashInputBytes, loadVerifiedState, serializeLine, statusFromState } from "./chain.js";
export type { ChainState } from "./chain.js";
