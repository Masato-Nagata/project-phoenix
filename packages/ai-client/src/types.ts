// Shared types of the AI_Provider abstraction (discovery-loop spec, design `packages/ai-client`; R3.1, R3.5, R3.6, R3.7).
// Each package keeps its own local copy of Json and Result (same shape as in analyzer, verifier and discovery-loop).
import type { auditedBrand } from "./internal/brand.js";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Lowercase hexadecimal SHA-256, 64 characters. Plain string alias; use `isSha256Hex` to check a value from outside. */
export type Sha256 = string;

/** The three request kinds of R3.13. */
export const REQUEST_KINDS = ["hypothesis_generation", "experiment_generation", "hypothesis_revision"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** Recorded in the Evidence_Store and the Run_Manifest (R3.7). `model` is `not_applicable` when the provider has no model. */
export interface ProviderIdentity {
  readonly id: string;
  readonly version: string;
  readonly model: string | "not_applicable";
}

/**
 * The only request a provider accepts. By design, only the Payload_Auditor creates one, after a `pass` result (R2.1), and `bytes`
 * are the exact audited bytes that are transmitted (R2.3).
 *
 * The `auditedBrand` property is a compile-time label only. It has no runtime value, so it is NOT a runtime guarantee that an audit
 * took place: a cast can forge the type, and `checkRequestHash` only shows that `bytes` match `sha256`, not that anyone audited them.
 * The runtime guarantee is a task 3.4 item.
 */
export interface AuditedRequest {
  readonly kind: RequestKind;
  readonly bytes: Uint8Array;
  readonly sha256: Sha256;
  readonly [auditedBrand]: true;
}

/** Why a request was refused as an audit-integrity violation (R2.3). */
export type AuditViolationCode =
  | "not_audited" // the request is not one that this package's Payload_Auditor created (a cast, a copy, another module instance)
  | "already_used" // the audited request was already used by an earlier `complete()` call
  | "hash_mismatch" // the held audited bytes no longer hash to the audited SHA-256
  | "state_inconsistent"; // the public fields of the request disagree with the audited state

/**
 * What the Loop_Orchestrator records for an `audit_violation`. It holds kind and hashes only, never payload bytes or any part of them.
 * `claimedSha256` is what the request object said; `auditedSha256` is what the audit registered (absent for `not_audited`);
 * `recomputedSha256` is the hash the guard computed just before the call (present for `hash_mismatch`).
 */
export interface AuditViolation {
  readonly code: AuditViolationCode;
  readonly requestKind?: RequestKind;
  readonly claimedSha256?: Sha256;
  readonly auditedSha256?: Sha256;
  readonly recomputedSha256?: Sha256;
}

/**
 * `error` and `timeout` are the failure classes of R3.8. `audit_violation` is different in kind: the guard refused the call before any
 * provider code ran. It is NOT a provider failure, must NOT be retried, and must NOT be counted against the retry limit of R11.10.
 * The Loop_Orchestrator stops the Run with termination reason `error` (R11.15) and records the violation (see `isAuditViolation`).
 */
export type ProviderError =
  | {
      readonly reason: "error" | "timeout" | "unmatched_request" | "tool_call_detected" | "undeterminable";
      readonly detail: string;
    }
  | {
      readonly reason: "audit_violation";
      /** Fixed text per violation code. It never contains request content. */
      readonly detail: string;
      readonly violation: AuditViolation;
    };

export interface CompleteOptions {
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

/**
 * The AI_Provider interface (R3.1, R3.6). Bytes in, bytes out. It exposes no file-system, process, network, Docker or Git
 * operation: the only members are the identity and `complete`.
 *
 * The provider recomputes sha256(req.bytes) and fails with `reason: "error"` if it differs from `req.sha256` (R2.3);
 * `checkRequestHash` does that check. The returned bytes are an untrusted response; they are gated and parsed by the caller.
 */
export interface AiProvider {
  readonly identity: ProviderIdentity;
  complete(req: AuditedRequest, opts: CompleteOptions): Promise<Result<Uint8Array, ProviderError>>;
}
