// Loop_Orchestrator types and ports (task 4.4, unit U0, revised; R2.12, R2.14, R2.15, R2.16, R11.12, R12.13, R12.14, R15.6, R15.14, R15.15, R15.16, R19.3, R19.7, R24.15).
//
// Types and closed vocabularies only. The ports are STRUCTURAL: this package has no dependency on ai-client, verifier or analyzer, so each port
// names the real function it mirrors, and the composition root (task 4.9, tests: `test/support`) adapts the real function to it.
// Port methods use method syntax on purpose: method parameters are bivariant, so a real function with a narrower parameter type (for example
// `kind: RequestKind`) is assignable to a port that declares a wider one.
//
// Which ports map to an EXISTING API and which are NEW:
//   isolation      EXISTING  `IsolationDeps` of `src/isolation/types.ts`.
//   fs, runVolumeDir EXISTING `FileSystemPort` of `src/store/fileSystemPort.ts`; the directory is a plain string.
//   clock          EXISTING  shape of verifier `MonotonicClock` (`nowMs(): number`). `deadlineAtMs` and `notAfterMs` are monotonic milliseconds.
//   wallClock      NEW       no existing API. Used for the Run_Manifest `wallClock` field only (an excluded field), never for a limit or a lease.
//   timers         NEW       no existing API. Only for the Run deadline (an `AbortController`); the orchestrator itself uses no timer function.
//   provider       EXISTING  structural copy of ai-client `AiProvider` (`identity`, `complete(req, { timeoutMs, signal })`); `req` is a type parameter.
//   audit          EXISTING  `auditPayload` of ai-client (`auditPayload(bytes, kind, cfg, ctx)`), with the context replaced by an opaque handle;
//                  NEW       `createContext` (see `AuditPort`).
//   responseGate   EXISTING  ai-client `gateProviderResult`, `gateResponse`, `resolveResponseLimits`.
//   policy         EXISTING  verifier `evaluateForRecord` and `createAcceptanceCheck`.
//   runnerFactory  NEW as a function; it builds the EXISTING verifier `ExperimentRunner` (`createRunner(RunnerDeps)`), see `RunnerFactoryInput`.
//   comparator     EXISTING  verifier `compare`.
//   analysisFs     EXISTING  structural copy of analyzer `FileSystemPort`, the RAW file system for the Source_Bundler (supplied by the composition root).
//   repoRoot       a plain string, the first argument of the analyzer `buildSourceBundle`.
//   analysis       EXISTING  analyzer `buildSourceBundle`, `verifyCitations`, `validateDeclarations`, `validateExpr`.
//   storeFactory   NEW       a factory over the EXISTING `RunRecordStore.open(fs, dir, options)`; the options are closed over by the composition root.
//   manifest.build NEW       no existing API. The real Run_Manifest assembly is task 4.6.
import type { AccessDenialResult, IsolationDeps } from "../isolation/types.js";
import type { Json, Result } from "../schema/types.js";
import type { FileSystemPort } from "../store/fileSystemPort.js";
import type { OpenError, RunRecordStore } from "../store/runRecordStore.js";

export type JsonObject = { [k: string]: Json };
export type Sha256 = string;

// ---------------------------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------------------------
/** Shape of ai-client `ProviderIdentity`. */
export interface ProviderIdentityView {
  readonly id: string;
  readonly version: string;
  readonly model: string;
}
/** A provider failure as the orchestrator may read it. The real `ProviderError` has more members; they are not needed here. */
export interface ProviderFailureView {
  readonly reason: string;
  readonly detail: string;
}
/** Structural copy of ai-client `AiProvider`. `TRequest` stands for `AuditedRequest`, which only `auditPayload` may create. */
export interface ProviderPort<TRequest> {
  readonly identity: ProviderIdentityView;
  complete(req: TRequest, opts: { readonly timeoutMs: number; readonly signal: AbortSignal }): Promise<Result<Uint8Array, ProviderFailureView>>;
}

declare const auditContextBrand: unique symbol;
/**
 * Opaque. A type-only brand: no object literal and no plain object can be a handle. The composition root fills the real ai-client `AuditContext`
 * (instruction templates, allowlist, limits, credential values) behind it; the orchestrator only hands the handle back to `auditPayload`. So no
 * credential value ever reaches the orchestrator (R19.7).
 */
export interface AuditContextHandle {
  readonly [auditContextBrand]: true;
}
/** Structural copy of ai-client `StoredRecordView`. */
export interface StoredRecordView {
  readonly kind: string;
  readonly sha256: Sha256;
  readonly canonicalJson: string;
}
/**
 * Over ai-client `auditPayload(bytes, kind, cfg, ctx)`. `cfg` is `startup.auditConfig.load` (typed by `TAudit`).
 * `ctx` is an `AuditContextHandle`; the composition root adapts the real function, which takes an `AuditContext`.
 * `createContext` is NEW. `lookupRecord` serves, for a stored record, the canonical JSON of the record PAYLOAD and the SHA-256 of that
 * payload, not the hash of the envelope (check A03 of `payloadAuditor.ts`). `bundle` is the Source_Bundle value that the analysis port built.
 */
export interface AuditPort<TAudit, TRequest> {
  createContext(input: { readonly bundle: unknown; lookupRecord(recordId: string): StoredRecordView | undefined }): AuditContextHandle;
  auditPayload(bytes: Uint8Array, kind: string, cfg: TAudit, ctx: AuditContextHandle): { readonly audit: unknown; readonly request?: TRequest };
}
/** Over ai-client `gateProviderResult`, `gateResponse` and `resolveResponseLimits`. Results are opaque in this unit (they belong to U5). */
export interface ResponseGatePort {
  gateProviderResult(kind: string, result: Result<Uint8Array, ProviderFailureView>, limits: unknown, validator: unknown): unknown;
  gateResponse(kind: string, bytes: Uint8Array, limits: unknown, validator: unknown): unknown;
  resolveResponseLimits(overrides?: Readonly<Record<string, unknown>>): Result<unknown, unknown>;
}
/** The `isAccepted` callback of the verifier Runner (`createAcceptanceCheck`). Declared through a method so that a narrower real parameter type is accepted. */
export type AcceptanceCheck = { bivarianceHack(experimentId: string, decisionRecordId: string, identity: unknown): unknown }["bivarianceHack"];
/** Over verifier `evaluateForRecord(e, policyConfig)` and `createAcceptanceCheck(records)`. */
export interface PolicyPort<TPolicy> {
  evaluateForRecord(e: unknown, policyConfig: TPolicy): unknown;
  createAcceptanceCheck(records: () => readonly unknown[]): AcceptanceCheck;
}

/**
 * The part of a verifier `ExecutionObservation` that the orchestrator reads. The object itself is handed on as it is (to the comparator and
 * to the record writer); nothing is copied or rebuilt from this view.
 */
export interface ObservationView {
  readonly experimentId: string;
  readonly outcome: "executed" | "timed_out" | "aborted" | "not_executed";
}
/**
 * A structural SUPERTYPE of the verifier `ExecutionOutcome` (R11.12, R24.15): every real outcome is assignable to it. The discriminant is
 * `status`. It carries what a termination decision needs: the reason and the lease cause of `aborted` and `not_executed`, `fatal`, and the
 * counts of `interrupted` (which has NO observation). The names of the closed vocabularies mirror verifier `NotExecutedReason` and `RunStopCause`
 * only as far as the orchestrator needs them; `not_executed.reason` stays a plain string.
 */
export type ExecutionOutcomeView =
  | { readonly status: "executed"; readonly observation: ObservationView; readonly preparationLog?: readonly unknown[] }
  | { readonly status: "timed_out"; readonly observation: ObservationView; readonly detail?: string }
  | {
      readonly status: "aborted";
      readonly reason: "lease_unavailable" | "address_not_allowed";
      readonly observation: ObservationView;
      readonly leaseReason?: LeaseReasonName;
      readonly terminationReason?: LeaseTerminationHint;
    }
  | {
      readonly status: "not_executed";
      readonly reason: string;
      readonly step?: number;
      readonly detail?: string;
      readonly observation: ObservationView;
      readonly leaseReason?: LeaseReasonName;
      readonly terminationReason?: LeaseTerminationHint;
      readonly fatal?: true;
    }
  | {
      readonly status: "interrupted";
      readonly cause: "forced_stop" | "fatal_error";
      readonly experimentId: string;
      readonly phase: "not_started" | "reset" | "prep" | "boundary" | "seq" | "state";
      readonly step?: number;
      readonly sentRequests: number;
      readonly collectedResponses: number;
      readonly collectedStateChecks: number;
      readonly fatal?: true;
      readonly detail?: string;
    };
/** Structural copy of the verifier `ExperimentRunner`. */
export interface ExperimentRunnerPort {
  health(): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  execute(e: unknown, decisionRecordId: string, signal: AbortSignal, options?: { readonly notAfterMs?: number }): Promise<ExecutionOutcomeView>;
}
/**
 * What the composition root needs to call verifier `createRunner(RunnerDeps)`. `RunnerDeps` also holds `http`, `addressPolicy`, the lease
 * `inFlightWatch` and the clock; the factory closes over those. `lease` is the SAME instance that stage B proved (`startup.lease.port`).
 */
export interface RunnerFactoryInput<TLease, TPolicy, TTable> {
  readonly lease: TLease;
  readonly policy: TPolicy;
  readonly table: TTable;
  readonly mask: unknown;
  readonly baseAddress: string;
  readonly limits: { readonly requestTimeoutMs: number; readonly experimentTimeoutMs: number };
  isAccepted(experimentId: string, decisionRecordId: string, identity: unknown): unknown;
}
export type RunnerFactory<TLease, TPolicy, TTable> = (input: RunnerFactoryInput<TLease, TPolicy, TTable>) => ExperimentRunnerPort;
/** Over verifier `compare(prediction | undefined, observation, mask)`. */
export interface ComparatorPort {
  compare(prediction: unknown, observation: unknown, mask: unknown): unknown;
}

/** Structural copy of analyzer `FileSystemPort` (`bundle/types.ts`). Both methods reject when the operation fails. */
export interface AnalysisFsPort {
  readFile(path: string): Promise<Uint8Array>;
  lstat(path: string): Promise<{ kind: "file" | "dir" | "symlink" | "other"; nlink: number }>;
}
/**
 * Over analyzer `buildSourceBundle`, `verifyCitations`, `validateDeclarations`, `validateExpr`.
 * There is NO source bundle VALUE on this port (it would bypass the read observation, R2.12). The orchestrator (U3) wraps `LoopDeps.analysisFs`
 * with the read observer and passes ONLY the wrapped object to `buildSourceBundle`; no port accepts a pre-built bundle or a raw file system
 * from anywhere else.
 */
export interface AnalysisPort {
  buildSourceBundle(fs: AnalysisFsPort, repoRoot: string, allowlistJsonPath?: string, allowlistMdPath?: string): Promise<Result<unknown, unknown>>;
  verifyCitations(cs: readonly unknown[], bundle: unknown): readonly unknown[];
  validateDeclarations(derived: unknown, tables: unknown): Result<unknown, readonly unknown[]>;
  validateExpr(e: unknown, ctx: unknown): Result<unknown, readonly unknown[]>;
}
export interface MonotonicClockPort {
  nowMs(): number;
}
/** NEW. The wall clock; Run_Manifest `wallClock` only. */
export interface WallClockPort {
  nowIso(): string;
}
/** NEW. Only for the Run deadline. `delayMs` is a duration on the monotonic clock. */
export interface TimerPort {
  schedule(delayMs: number, onFire: () => void): { cancel(): void };
}
/**
 * NEW. Opens the Run store. The composition root closes over `RunRecordStoreOptions` (including the secret configuration), so the orchestrator
 * never holds or reads secret values or the options (R19.7). `RunRecordStore.open` stays a requirement of an EXISTING EMPTY directory and
 * creates nothing.
 */
export interface StoreFactoryPort {
  open(fs: FileSystemPort, dir: string): Promise<Result<RunRecordStore, OpenError>>;
}

// ---------------------------------------------------------------------------------------------
// Run_Manifest input
// ---------------------------------------------------------------------------------------------
// `ManifestCore` is ONLY what the orchestrator knows at the end of a Run (R12.13, R12.14, R15.6, R19.3). The tool versions, the mutual-exclusion
// result, the AI sandbox facts, the legacy start state, the assembly and its validation belong to tasks 4.6 and 4.8, and must not be added here.
// `RunRecordStore.seal` refuses `schemaVersion`, `chain` and `artifacts` in its input, so `build` must not produce them either.
// Nothing here can carry a secret value, the audit configuration load result, a lease port, an approval object, a path, or a payload.
export interface ManifestWallClock {
  readonly startedAt: string;
  readonly finishedAt: string;
}
export interface ManifestLimitsUsed {
  readonly iterations: number;
  readonly acceptedExperiments: number;
  readonly rejectedExperiments: number;
}
export interface ManifestProvider {
  readonly id: string;
  readonly version: string;
  readonly model: string;
  readonly isMock: boolean;
}
/** A variable NAME and whether it was set. Never a value. */
export interface ManifestEnvVarRead {
  readonly name: string;
  readonly set: boolean;
}
export interface ManifestPayloadAudit {
  readonly configCheck: "pass" | "blocked";
  readonly audits: number;
  readonly passed: number;
  readonly blocked: number;
  readonly auditConfigSha256: Sha256;
}
export interface ManifestConfigHashes {
  readonly policyConfigSha256: Sha256;
  readonly preparationTableSha256: Sha256;
}
export interface ManifestLeaseFacts {
  readonly heartbeatIntervalMs: number;
  readonly staleAfterMs: number;
  readonly propagationDelayMs: number;
}
export interface ManifestCore {
  readonly runId: string;
  readonly wallClock: ManifestWallClock;
  readonly terminationReason: TerminationReason;
  /** The id of the last hypothesis revision, or the text "none". */
  readonly finalHypothesisRevision: string;
  readonly limitsUsed: ManifestLimitsUsed;
  readonly provider: ManifestProvider;
  readonly envVarsRead: readonly ManifestEnvVarRead[];
  readonly payloadAudit: ManifestPayloadAudit;
  /** The branded result of the start gate. `build` derives the access-denial fact and the isolation checks from this one source. */
  readonly accessDenial: AccessDenialResult;
  readonly configHashes: ManifestConfigHashes;
  readonly leaseFacts: ManifestLeaseFacts;
  /** Opaque: the manifest of the Source_Bundle as the bundler produced it. */
  readonly sourceBundleManifest?: Json;
  /** The validated run configuration values only. It contains no secret (names of variables are not secrets; values are never in the configuration). */
  readonly effectiveConfig: Json;
}
/** NEW. The assembly of the Run_Manifest (task 4.6). */
export interface ManifestPort {
  build(core: ManifestCore): JsonObject;
}

/** The seventeen ports of the Loop_Orchestrator. The start gate reads `isolation` and nothing else. */
export interface LoopDeps<TLease = unknown, TAudit = unknown, TPolicy = unknown, TTable = unknown, TRequest = unknown> {
  readonly isolation: IsolationDeps;
  readonly fs: FileSystemPort;
  readonly runVolumeDir: string;
  readonly clock: MonotonicClockPort;
  readonly wallClock: WallClockPort;
  readonly timers: TimerPort;
  readonly provider: ProviderPort<TRequest>;
  readonly audit: AuditPort<TAudit, TRequest>;
  readonly responseGate: ResponseGatePort;
  readonly policy: PolicyPort<TPolicy>;
  readonly runnerFactory: RunnerFactory<TLease, TPolicy, TTable>;
  readonly comparator: ComparatorPort;
  /** The RAW file system for the Source_Bundler. The orchestrator wraps it with the read observer (U3) before any use. */
  readonly analysisFs: AnalysisFsPort;
  readonly repoRoot: string;
  readonly analysis: AnalysisPort;
  readonly storeFactory: StoreFactoryPort;
  readonly manifest: ManifestPort;
}

// ---------------------------------------------------------------------------------------------
// Run result
// ---------------------------------------------------------------------------------------------
/** The eleven values of design.md, "packages/discovery-loop". */
export const TERMINATION_REASONS = Object.freeze([
  "iteration_limit_reached",
  "experiment_limit_reached",
  "time_limit_reached",
  "no_further_experiments",
  "provider_failure",
  "payload_audit_blocked",
  "policy_rejection_limit",
  "isolation_violation",
  "lease_unavailable",
  "launcher_killed",
  "error",
] as const);
export type TerminationReason = (typeof TERMINATION_REASONS)[number];

export interface RunSummary {
  readonly runId: string;
  readonly terminationReason: TerminationReason;
  /** The SHA-256 of the `SealedManifest` of an actual, successful `RunRecordStore.seal`. */
  readonly manifestSha256: Sha256;
}

/** Closed list of the reasons why a Run has no sealed manifest. A failure never carries a message, a value, a path or a name from a port. */
export const UNSEALED_FAILURE_CODES = Object.freeze([
  "runner_start_refused",
  "store_open_failed",
  "lease_invalid_at_start",
  "store_failed",
  "secret_rejected",
  "manifest_build_failed",
  "seal_failed",
  "internal_error",
] as const);
export type UnsealedFailure = (typeof UNSEALED_FAILURE_CODES)[number];

/**
 * The final answer of a Run. `sealed: true` exists ONLY for an actual successful `RunRecordStore.seal`. An unsealed result must never be
 * reported as a success. The process exit code is the job of the composition root (task 4.9).
 * `started` is true only after the `run_started` record was written.
 */
export type RunResult =
  | { readonly sealed: true; readonly summary: RunSummary }
  | { readonly sealed: false; readonly started: boolean; readonly terminationReason?: TerminationReason; readonly failure: UnsealedFailure };

// ---------------------------------------------------------------------------------------------
// Start gate
// ---------------------------------------------------------------------------------------------
/** Closed list. A refusal never carries a message, a value, a path or a name from a port. */
export const START_GATE_REFUSAL_CODES = Object.freeze([
  "startup_invalid",
  "startup_already_consumed",
  "isolation_port_failed",
  "access_denial_not_issued",
  "run_id_mismatch",
  "start_gate_closed",
  "lease_invalid",
  "lease_check_failed",
  "internal_error",
] as const);
export type StartGateRefusalCode = (typeof START_GATE_REFUSAL_CODES)[number];

/** The reasons of verifier `LeaseReason`. A copy; a test pins it to `STARTUP_NAME_VOCABULARY.leaseReasons`. */
export const LEASE_REASONS = Object.freeze(["missing", "malformed", "run_mismatch", "nonce_mismatch", "revoked", "heartbeat_stale", "unreadable"] as const);
export type LeaseReasonName = (typeof LEASE_REASONS)[number];

/** For later stages. A refusal at the start gate has no Run content; only a stale heartbeat means that the Launcher was killed. */
export type LeaseTerminationHint = "launcher_killed" | "lease_unavailable";

export interface StartGateRefusal {
  readonly code: StartGateRefusalCode;
  readonly leaseReason?: LeaseReasonName;
  readonly terminationReasonHint?: LeaseTerminationHint;
}

/** What a passed gate hands on: the Run id, the branded verification result, and the env names that were checked. Nothing of the startup ticket else. */
export interface StartGateSuccess {
  readonly runId: string;
  readonly accessDenial: AccessDenialResult;
  readonly allowedEnvNames: readonly string[];
}

export type StartGateResult = Result<StartGateSuccess, StartGateRefusal>;
