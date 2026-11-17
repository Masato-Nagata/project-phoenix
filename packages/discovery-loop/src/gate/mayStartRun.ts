// Start gate (task 4.3; R2.14, R2.15, R2.16, R15.14, R15.15, R15.16).
// A Run may start only when the Payload_Audit configuration check is `pass` AND the Ground_Truth access-denial status is `verified`.
// The two inputs are produced by different modules in that Run, and neither is evidence for the other.
//
// This module has no import. It defines its own literal types, so it does not depend on the access-denial module, the Payload_Auditor
// or `config/startup.ts`, and none of them depends on it. The brand and the `runId` of the access-denial result are checked by the
// orchestrator (task 4.4) BEFORE it passes `result.status` here; this function sees only the two literals.
//
// Fail closed: only strict equality with the two expected literals can give `true`. Any other value (undefined, another case, an object,
// a wrapper object, a missing argument) gives `false`. There is no third parameter, no Mock exception, and no configuration read (R15.14).

/** The Payload_Audit configuration check. At stage B of start-up (task 4.1) it is `pass`; `blocked` exists for a failing audit configuration. */
export type PayloadAuditConfigCheck = "pass" | "blocked";

/** The status of the Ground_Truth access-denial verification of this Run. */
export type AccessDenialStatus = "verified" | "failed";

export function mayStartRun(payloadAuditConfig: PayloadAuditConfigCheck, accessDenial: AccessDenialStatus): boolean {
  return payloadAuditConfig === "pass" && accessDenial === "verified";
}
