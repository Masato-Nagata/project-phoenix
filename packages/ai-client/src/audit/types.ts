// Types of the Payload_Auditor (design "Payload_Auditor", `packages/ai-client`; R2).
import type { Json, Sha256 } from "../types.js";

export const AUDIT_CHECK_IDS = ["A01", "A02", "A03", "A04", "A05", "A06", "A07", "A08", "A09"] as const;
export type AuditCheckId = (typeof AUDIT_CHECK_IDS)[number];

/** `detail` is a fixed code, never payload content. `not_run`: the check could not run (R2.9), so the result is `blocked`. */
export interface AuditCheck {
  readonly id: AuditCheckId;
  readonly outcome: "pass" | "fail" | "not_run";
  readonly detail?: string;
}

/**
 * An identifier of what matched, never a value (R2.12): a canary or decoy id, a fingerprint set id, a secret variable name, a manifest or
 * allowlist path, `restricted_path_prefix:<index>`, or `part:<index>`.
 */
export interface AuditMatch {
  readonly checkId: AuditCheckId;
  readonly matchId: string;
}

export interface AuditResult {
  readonly result: "pass" | "blocked";
  /** SHA-256 of `auditedBytes`. On `pass` it is the hash that the audited request is bound to (R2.3). */
  readonly payloadSha256: Sha256;
  /**
   * A private copy of exactly the bytes that were audited, for the Evidence_Store (R2.2). Returned ONLY when A05, A06, A07 and A08 all
   * `pass`; this holds for a `pass` result and for a `blocked` result caused by other checks. If any of the four failed OR did not run
   * (`not_run`), the bytes are withheld (`undefined`, `bytesWithheld: true`): content that was not shown to be free of restricted paths,
   * canaries, restricted-content fingerprints and credentials must not be written into a Run artifact (R2.12, R19.2 take precedence over
   * the saving of the bytes in R2.2). The hash, the checks with their outcomes, and the reason codes are always present.
   */
  readonly auditedBytes?: Uint8Array;
  readonly bytesWithheld: boolean;
  /** Always the nine checks in the fixed order A01 to A09. */
  readonly checks: readonly AuditCheck[];
  readonly matches: readonly AuditMatch[];
}

// ---- audit configuration (prepared outside the runtime; design "Audit configuration") ----
export interface AuditSecretEntry {
  readonly id: string;
  readonly value: string;
}
export interface AuditFingerprintSet {
  readonly id: string;
  readonly fileId: string;
  readonly n: number;
  readonly hashes: readonly string[];
}
export interface AuditConfig {
  readonly schemaVersion: 1;
  readonly allowlist: readonly string[];
  readonly canaries: readonly AuditSecretEntry[];
  readonly decoys: readonly AuditSecretEntry[];
  readonly fingerprints: readonly AuditFingerprintSet[];
  readonly restrictedPathPrefixes: readonly string[];
  readonly tokenizer: "token-ngram-sha256-v1";
}
/** `reason` is the A01 detail. `unreadable` is produced by the host reader, which this package does not have. */
export type AuditConfigLoadResult =
  | { readonly ok: true; readonly config: AuditConfig; readonly sha256: Sha256 }
  | { readonly ok: false; readonly reason: "missing" | "unreadable" | "empty" | "invalid"; readonly detail?: string };

// ---- audit context ----
/** The part of the Source_Bundle of `packages/analyzer` that the auditor needs. The analyzer's `SourceBundle` is assignable to it. */
export interface AuditSourceBundle {
  readonly manifest: readonly { readonly path: string; readonly sha256Lf: Sha256 }[];
}
/**
 * What `lookupRecord` returns for a stored record of this Run. `kind` is the record kind of the Evidence_Store envelope (for example
 * `hypothesis_revision`); check A03 requires it to equal the type of the part. A record whose kind is missing, empty or not a string is
 * treated as "kind not verified" and blocks (fail closed).
 */
export interface StoredRecordView {
  readonly kind: string;
  readonly sha256: Sha256;
  readonly canonicalJson: string;
}
export interface AuditLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
}
export interface AuditContext {
  readonly bundle: AuditSourceBundle;
  /** `docs/ai-input-allowlist.json`. A source path must be listed here and in the audit configuration. */
  readonly allowlist: readonly string[];
  readonly lookupRecord: (recordId: string) => StoredRecordView | undefined;
  /** templateId -> SHA-256 of the fixed instruction text. */
  readonly instructionTemplates: ReadonlyMap<string, Sha256>;
  /** Variable names and values of the credentials; the values are searched for and never recorded (R19.7). */
  readonly secretValues: readonly { readonly name: string; readonly value: string }[];
  readonly limits?: AuditLimits;
}

// ---- envelope (design "What is audited") ----
export const STORED_PART_TYPES = ["hypothesis_revision", "experiment", "observation", "comparison"] as const;
export type StoredPartType = (typeof STORED_PART_TYPES)[number];
export interface SourceFilePart {
  readonly partId: string;
  readonly type: "source_file";
  readonly path: string;
  readonly sha256Lf: Sha256;
  readonly text: string;
}
export interface StoredPart {
  readonly partId: string;
  readonly type: StoredPartType;
  readonly recordId: string;
  readonly recordSha256: Sha256;
  readonly content: Json;
}
/** A part with a type outside the permitted kinds. Only `partId` and `type` are accepted, and check A03 blocks it. */
export interface UnknownPart {
  readonly partId: string;
  readonly type: string;
}
export interface PayloadEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "hypothesis_generation" | "experiment_generation" | "hypothesis_revision";
  readonly instruction: { readonly templateId: string; readonly sha256: Sha256 };
  readonly parts: readonly (SourceFilePart | StoredPart | UnknownPart)[];
}