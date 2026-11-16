// Helpers for the two kinds of provider failure (see `ProviderError`).
import type { ProviderError } from "./types.js";

export type AuditViolationError = Extract<ProviderError, { reason: "audit_violation" }>;

/** True for an audit-integrity violation. The Loop_Orchestrator must not retry it and must stop the Run (termination reason `error`, R11.15). */
export function isAuditViolation(e: ProviderError): e is AuditViolationError {
  return e.reason === "audit_violation";
}