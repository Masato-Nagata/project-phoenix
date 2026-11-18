// Loop_Orchestrator foundation types (task 4.4, stage 2: foundation and start gate; R2.14, R2.15, R2.16, R15.14, R15.15, R15.16, R24.15).
//
// Types and closed vocabularies only. The ports are STRUCTURAL: this package has no dependency on ai-client, verifier or analyzer, so each port
// names the real function it mirrors, and the composition root (task 4.9, tests: `test/support`) adapts the real function to it.
// Port methods use method syntax on purpose: method parameters are bivariant, so a real function with a narrower parameter type (for example
// `kind: RequestKind`) is assignable to a port that declares a wider one.
//
// Which ports map to an EXISTING API and which are NEW:
//   isolation      EXISTING  `IsolationDeps` of `src/isolation/types.ts`.
//   fs, runVolumeDir EXISTING `FileSystemPort` of `src/store/fileSystemPort.ts`; the directory is a plain string. (Not touched in this stage.)
//   clock          EXISTING  shape of verifier `MonotonicClock` (`nowMs(): number`).
//   wallClock      NEW       no existing API. Used for the Run_Manifest `wallClock` field only (an excluded field), never for a limit or a lease.
//   provider       EXISTING  structural copy of ai-client `AiProvider` (`identity`, `complete(req, { timeoutMs, signal })`); `req` is a type parameter.
//   audit          EXISTING  ai-client `auditPayload(bytes, kind, cfg, ctx)`.
//   responseGate   EXISTING  ai-client `gateProviderResult`, `gateResponse`, `resolveResponseLimits`.
//   policy         EXISTING  verifier `evaluateForRecord` and `createAcceptanceCheck`.
//   runnerFactory  NEW as a function; it builds the EXISTING verifier `ExperimentRunner` (`createRunner(RunnerDeps)`), see `RunnerFactoryInput`.
//   comparator     EXISTING  verifier `compare`.
//   analysis       EXISTING  analyzer `verifyCitations`, `validateDeclarations`, `validateExpr`, plus the source bundle value.
//   manifest.build NEW       no existing API. The real Run_Manifest assembly is task 4.6.
import type { AccessDenialResult, IsolationDeps } from "../isolation/types.js";
import type { Json, Result } from "../schema/types.js";
import type { FileSystemPort } from "../store/fileSystemPort.js";

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
/** Over ai-client `auditPayload`. `cfg` is `startup.auditConfig.load` (typed by `TAudit`). */
export interface AuditPort<TAudit, TRequest> {
  auditPayload(bytes: Uint8Array, kind: string, cfg: TAudit, ctx: unknown): { readonly audit: unknown; readonly request?: TRequest };
}
/** Over ai-client `gateProviderResult`, `gateResponse` and `resolveResponseLimits`. Results are opaque in this stage. */
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
/** A minimal structural subset of the verifier `ExecutionOutcome`; the real type has more members per status. */
export interface ExecutionOutcomeView {
  readonly status: "executed" | "timed_out" | "aborted" | "not_executed" | "interrupted";
}
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
/** Over analyzer `verifyCitations`, `validateDeclarations`, `validateExpr`, and the source bundle. */
export interface AnalysisPort {
  verifyCitations(cs: readonly unknown[], bundle: unknown): readonly unknown[];
  validateDeclarations(derived: unknown, tables: unknown): Result<unknown, readonly unknown[]>;
  validateExpr(e: unknown, ctx: unknown): Result<unknown, readonly unknown[]>;
  readonly sourceBundle: unknown;
}
export interface MonotonicClockPort {
  nowMs(): number;
}
/** NEW. The wall clock; Run_Manifest `wallClock` only. */
export interface WallClockPort {
  nowIso(): string;
}
/** NEW. The assembly of the Run_Manifest (task 4.6). `core` is opaque here. */
export interface ManifestPort {
  build(core: unknown): JsonObject;
}

/** The thirteen ports of the Loop_Orchestrator. The start gate reads `isolation` and nothing else. */
export interface LoopDeps<TLease = unknown, TAudit = unknown, TPolicy = unknown, TTable = unknown, TRequest = unknown> {
  readonly isolation: IsolationDeps;
  readonly fs: FileSystemPort;
  readonly runVolumeDir: string;
  readonly clock: MonotonicClockPort;
  readonly wallClock: WallClockPort;
  readonly provider: ProviderPort<TRequest>;
  readonly audit: AuditPort<TAudit, TRequest>;
  readonly responseGate: ResponseGatePort;
  readonly policy: PolicyPort<TPolicy>;
  readonly runnerFactory: RunnerFactory<TLease, TPolicy, TTable>;
  readonly comparator: ComparatorPort;
  readonly analysis: AnalysisPort;
  readonly manifest: ManifestPort;
}

// ---------------------------------------------------------------------------------------------
// Run summary
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
  readonly manifestSha256: Sha256;
}

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
