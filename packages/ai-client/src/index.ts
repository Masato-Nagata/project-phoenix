export const PACKAGE_NAME = "@phoenix/ai-client" as const;

// Public entry point. It exports no raw provider and no way to create an AuditedRequest except `auditPayload`:
// the Mock_Provider class, the provider factories, the audited-request registry and the Audit_Config_Builder (task 3.7) stay inside the package.
export type {
  AiProvider,
  AuditViolation,
  AuditViolationCode,
  AuditedRequest,
  CompleteOptions,
  Json,
  ProviderError,
  ProviderIdentity,
  RequestKind,
  Result,
  Sha256,
} from "./types.js";
export { REQUEST_KINDS } from "./types.js";
export { isAuditViolation } from "./providerError.js";
export type { AuditViolationError } from "./providerError.js";
export { checkRequestHash, isSha256Hex, sha256Hex } from "./hash.js";
export { DEFAULT_NGRAM_SIZE, FINGERPRINT_HEX_LENGTH, TOKENIZER_ID, ngramHashes, tokenize } from "./tokenizer.js";
export type { ProviderConfig, ProviderFactories, ProviderFactory, ProviderName, ProviderSelectionErrorCode } from "./provider.js";
export { PROVIDER_NAMES, ProviderSelectionError, createProvider } from "./provider.js";
export type { MockFixture } from "./mock/mockProvider.js";
export { DEFAULT_MOCK_FIXTURES, DEFAULT_MOCK_FIXTURE_SET_NAME, MOCK_FIXTURE_SETS } from "./mock/defaultFixtures.js";

// Payload_Auditor (task 3.4)
export { AUDIT_CHECK_IDS, STORED_PART_TYPES } from "./audit/types.js";
export type {
  AuditCheck,
  AuditCheckId,
  AuditConfig,
  AuditConfigLoadResult,
  AuditContext,
  AuditFingerprintSet,
  AuditLimits,
  AuditMatch,
  AuditResult,
  AuditSecretEntry,
  AuditSourceBundle,
  PayloadEnvelope,
  SourceFilePart,
  StoredPart,
  StoredPartType,
  StoredRecordView,
  UnknownPart,
} from "./audit/types.js";
export { AUDIT_LIMITS_CEILING, DEFAULT_AUDIT_LIMITS, auditPayload, effectiveAuditLimits } from "./audit/payloadAuditor.js";
export { parseAuditConfig } from "./audit/auditConfig.js";
export { canonicalJson, tryCanonicalJson } from "./json/canonicalJson.js";
export type { CanonicalIssue, CanonicalIssueCode } from "./json/canonicalJson.js";
export { strictJsonParse } from "./json/strictJsonParse.js";
export type { JsonParseIssue, JsonParseIssueCode } from "./json/strictJsonParse.js";
// Untrusted AI response gate (task 3.8)
export { DEFAULT_RESPONSE_LIMITS, RESPONSE_MAX_DEPTH, authorityRuleOf, gateProviderResult, gateResponse, isAuthorityLikeName, looksLikeToolCall, resolveResponseLimits, toInertText } from "./responseGate.js";
export type {
  AuthorityRule,
  CallOutcome,
  DiscardedAuthorityField,
  FailedCallReason,
  GateAccepted,
  GateAcceptedExperiments,
  GateAcceptedHypothesis,
  GateLimitHit,
  GateRejection,
  GateRejectionReason,
  GateResult,
  RejectedExperiment,
  ResponseLimits,
  ResponseLimitsError,
  SafeIssue,
  SchemaIssue,
  SchemaValidatorPort,
} from "./responseGate.js";
// Credential check at the start of a Run (task 3.11)
export { PROVIDER_CREDENTIALS, checkProviderCredentials } from "./credentials.js";
export type { CredentialCheck, CredentialReference, EnvironmentLike } from "./credentials.js";
