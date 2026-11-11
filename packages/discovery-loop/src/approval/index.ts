// Read side of the Approval_Store (task 1.16) for the `report` entry point and the Independent_Evaluator.
// NOT re-exported from src/index.ts: the runtime exports no Approval writer or reader (R6.11).
// The pure validator and chain builder are in ./tooling.ts and are for tests and golden vectors only.
export { ApprovalReader, ApprovalStoreError, asApprovalStatusReader } from "./reader.js";
export type { ApprovalReadError, ReaderOptions } from "./reader.js";
export { analyzeStore } from "./chain.js";
export type { ChainAnchor, Mismatch, MismatchKind, RuleViolation, VerifyReport } from "./chain.js";
export { ACTORS, GENESIS_HASH, toApprovalTarget, toStoredTarget } from "./types.js";
export type {
  Actor,
  ApprovalCandidate,
  ApprovalLine,
  ApprovalTarget,
  StoreLine,
  StoreRejectionLine,
  StoredTarget,
  TargetResolver,
} from "./types.js";
