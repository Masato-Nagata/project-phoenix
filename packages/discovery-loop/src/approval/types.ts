// Approval_Store data types (design: "Approval_Store (R23)").
//
// SECURITY DISTINCTION (read this before relying on anything in src/approval/):
//   1. The hash chain is tamper DETECTION only. It shows that stored lines were edited, removed,
//      inserted or reordered after they were written. It does not prevent any of that, it cannot
//      detect removal of the tail of the file without an external anchor, and it cannot detect
//      a complete rewrite of the file by someone who recomputes every hash.
//   2. Write CONTROL is an operating-system / container matter: the runtime container has no mount
//      of the Approval_Store and therefore no write access (R23.3). Nothing in this code base
//      enforces it; the isolation tests of M4 measure it.
//   3. Human AUTHENTICITY is not provided by the chain. `recorded_by` is a declaration made by the
//      caller of the host-side command (`human` or `kiro-development-agent`). Nothing here can
//      prove who ran the command or whether the declaration is true.
import type { ClaimRevisionApprovalTarget } from "../model/facts.js";
import type { ApprovalDecision } from "../model/types.js";

/** Predecessor hash of the first line (R23.2). */
export const GENESIS_HASH = "0".repeat(64);

/** Actor declaration (R23.5, R23.8). A declaration, not an authenticated identity. */
export type Actor = "human" | "kiro-development-agent";
export const ACTORS: readonly Actor[] = ["human", "kiro-development-agent"];

/** Target as stored (snake_case, as R23 names the fields). */
export type StoredTarget =
  | { kind: "claim_revision"; run_id: string; claim_revision_id: string }
  | { kind: "run"; run_id: string }
  | { kind: "gate"; gate_id: string };

/** Target as the read side uses it (camelCase, same shape as `ClaimRevisionApprovalTarget` of facts.ts). */
export type ApprovalTarget =
  | ClaimRevisionApprovalTarget
  | { kind: "run"; runId: string }
  | { kind: "gate"; gateId: string };

/** Content a caller supplies for a new approval line. Sequence, predecessor hash and hash are never caller-supplied. */
export interface ApprovalCandidate {
  approver: string;
  /** ISO 8601 with offset. The host-side command takes it from the host clock; the pure validator only checks its form. */
  timestamp: string;
  target: StoredTarget;
  decision: ApprovalDecision;
  rationale: string;
  recorded_by: Actor;
  /** Sequence number of the earlier approval line that this line corrects or withdraws (R23.12). */
  supersedes?: number;
}

export interface ApprovalLine extends ApprovalCandidate {
  type: "approval";
  seq: number;
  prev_hash: string;
  hash: string;
}

export interface StoreRejectionLine {
  type: "store_rejection";
  seq: number;
  prev_hash: string;
  reason: string;
  attempted_seq?: number;
  hash: string;
}

export type StoreLine = ApprovalLine | StoreRejectionLine;

export function toStoredTarget(t: ApprovalTarget): StoredTarget {
  switch (t.kind) {
    case "claim_revision":
      return { kind: "claim_revision", run_id: t.runId, claim_revision_id: t.claimRevisionId };
    case "run":
      return { kind: "run", run_id: t.runId };
    case "gate":
      return { kind: "gate", gate_id: t.gateId };
  }
}

export function toApprovalTarget(t: StoredTarget): ApprovalTarget {
  switch (t.kind) {
    case "claim_revision":
      return { kind: "claim_revision", runId: t.run_id, claimRevisionId: t.claim_revision_id };
    case "run":
      return { kind: "run", runId: t.run_id };
    case "gate":
      return { kind: "gate", gateId: t.gate_id };
  }
}

/**
 * Resolves a target to an existing Claim revision of an existing Run, an existing Run, or a defined
 * Gate identifier (R23.7). Injected: the host command resolves against `discovery/runs/`, tests use
 * a fixed set. The reader never reads Run directories itself.
 */
export interface TargetResolver {
  resolves(target: ApprovalTarget): boolean;
}
