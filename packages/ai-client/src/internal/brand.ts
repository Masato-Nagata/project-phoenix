// Type-level brand of AuditedRequest (design, `packages/ai-client`; R2.1).
// This module is deliberately NOT re-exported from `src/index.ts`. Only the Payload_Auditor (task 3.4) imports it, so
// code outside the package cannot construct an AuditedRequest without a cast. The brand has no runtime value: it is an ambient
// declaration, so it must only be used in type positions (`import type`).
export declare const auditedBrand: unique symbol;
