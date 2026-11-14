// Experiment_Runner types (design: "packages/verifier" interfaces, "Runner behavior summary (R9)"; R9; task 2.15).
import type { MaskConfig, Observation, ObservedResponse } from "../compare/types.js";
import type { LeasePort, LeaseReason, MonotonicClock, Sleeper } from "../lease/types.js";
import type { PrepTable } from "../prep/types.js";
import type { AcceptanceVerdict } from "../identity/acceptance.js";
import type { ExecutionIdentity } from "../identity/hash.js";
import type { PolicyConfig } from "../policy/types.js";
import type { AddressPolicy } from "./address.js";

export interface HttpRequest {
  readonly method: "GET" | "POST";
  /** A relative path with the placeholders already replaced. The adapter and the runner add the origin; the AI never supplies one. */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** The canonical JSON text of the body. */
  readonly body?: string;
}

export interface HttpResponse {
  readonly status: number;
  /** The response body as text (UTF-8). */
  readonly body: string;
}

export interface HttpPort {
  /** Rejects with `HttpTimeoutError` when `timeoutMs` passes, with `HttpAbortedError` when the signal aborts, with `AddressNotAllowedError` for a target the address check refuses, and with `HttpTransportError` for any other failure. */
  send(req: HttpRequest, timeoutMs: number, signal: AbortSignal): Promise<HttpResponse>;
}

export class HttpTimeoutError extends Error {
  constructor() {
    super("request timed out");
    this.name = "HttpTimeoutError";
  }
}
export class HttpAbortedError extends Error {
  constructor() {
    super("request aborted");
    this.name = "HttpAbortedError";
  }
}
export class HttpTransportError extends Error {
  constructor(message = "transport error") {
    super(message);
    this.name = "HttpTransportError";
  }
}
export class AddressNotAllowedError extends Error {
  constructor() {
    super("address not allowed");
    this.name = "AddressNotAllowedError";
  }
}

/** Per-request and per-Experiment time limits (R9.14). */
export interface RunnerLimits {
  readonly requestTimeoutMs: number;
  readonly experimentTimeoutMs: number;
}
export const DEFAULT_RUNNER_LIMITS: RunnerLimits = Object.freeze({ requestTimeoutMs: 10_000, experimentTimeoutMs: 60_000 });
export const REQUEST_TIMEOUT_RANGE_MS = { min: 1_000, max: 60_000 } as const;
export const EXPERIMENT_TIMEOUT_RANGE_MS = { min: 1_000, max: 600_000 } as const;
/** The health check must succeed within 10 seconds (R9.1). */
export const HEALTH_TIMEOUT_MS = 10_000;

export type NotExecutedReason =
  | "policy_not_accepted"
  | "lease_unavailable"
  | "address_not_allowed"
  | "reset_failed"
  | "preparation_failed"
  | "preparation_untranslatable"
  | "timeout_before_requests"
  | "runner_not_healthy"
  | "runner_internal_error";

/**
 * Why a Run stops in the middle of an Experiment without an Observation: a forced stop (the signal, for example for `isolation_violation`),
 * or a fatal error of the Runner. The true reason of the Run is written by the Loop_Orchestrator to the `termination` record.
 */
export type RunStopCause = "forced_stop" | "fatal_error";

/** Options of one execution. */
export interface ExecuteOptions {
  /** A time on the monotonic clock after which nothing is started: the Run time limit (R11.12). The deadline of the Experiment is the smaller of this and its own limit. */
  readonly notAfterMs?: number;
}

/**
 * An Experiment that was stopped in the middle by a forced stop or a fatal error (OD-18, decision (a) of 2026-11-12). There is **no**
 * Observation: a record that claims what the Experiment did would be invented. The counts say how much was collected; the Observations
 * of Experiments that were finished earlier are not touched. `fatal` is present when the Run must end with the termination reason `error`.
 * After this outcome the Runner executes nothing more: every later call returns this outcome with the phase `not_started`.
 */
export interface InterruptedOutcome {
  readonly status: "interrupted";
  readonly cause: RunStopCause;
  readonly experimentId: string;
  readonly phase: "not_started" | "reset" | "prep" | "boundary" | "seq" | "state";
  readonly step?: number;
  readonly sentRequests: number;
  readonly collectedResponses: number;
  readonly collectedStateChecks: number;
  readonly fatal?: true;
  readonly detail?: string;
}

export interface PrepLogEntry {
  readonly stepIndex: number;
  /** `METHOD path-template`; the template keeps `{bound}`, so no created identifier is recorded in the operation text. */
  readonly operation: string;
  readonly status: number;
}

/** M1 schema `observation`, as the runner records it. The Comparator reads the parts of `Observation`. */
export interface ExecutionObservation extends Observation {
  readonly abortReason?: "lease_unavailable" | "address_not_allowed";
  readonly notExecuted?: { readonly reason: string; readonly step?: number; readonly detail?: string };
  readonly preparation: readonly PrepLogEntry[];
  readonly responses: readonly ObservedResponse[];
  readonly stateChecks: readonly ObservedResponse[];
}

/** Set when the outcome is caused by the lease: what the Run ends with (R11.16, R24.12, R24.15). */
export interface LeaseCauseInfo {
  readonly leaseReason: LeaseReason;
  readonly terminationReason: "lease_unavailable" | "launcher_killed";
}

export type ExecutionOutcome =
  | { readonly status: "executed"; readonly observation: ExecutionObservation; readonly preparationLog: readonly PrepLogEntry[] }
  | { readonly status: "timed_out"; readonly observation: ExecutionObservation; readonly detail?: string }
  | ({ readonly status: "aborted"; readonly reason: "lease_unavailable" | "address_not_allowed"; readonly observation: ExecutionObservation } & Partial<LeaseCauseInfo>)
  | ({
      readonly status: "not_executed";
      readonly reason: NotExecutedReason;
      readonly step?: number;
      readonly detail?: string;
      readonly observation: ExecutionObservation;
      /** Present for `runner_internal_error`: the Run must end with the termination reason `error`. Control information; not in the Observation. */
      readonly fatal?: true;
    } & Partial<LeaseCauseInfo>)
  | InterruptedOutcome;

export interface ExperimentRunner {
  /** The start-up proof of the lease, then the health check of the Legacy_App within 10 seconds (R9.1, R24.9). */
  health(): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }>;
  execute(e: import("../policy/types.js").Experiment, decisionRecordId: string, signal: AbortSignal, options?: ExecuteOptions): Promise<ExecutionOutcome>;
}

export interface RunnerDeps {
  readonly http: HttpPort;
  readonly lease: LeasePort;
  readonly prepTable: PrepTable;
  readonly policy: PolicyConfig;
  readonly mask: MaskConfig;
  /** The configured Test_API address (R18.3). */
  readonly baseAddress: string;
  readonly addressPolicy: AddressPolicy;
  readonly limits: RunnerLimits;
  readonly clock: MonotonicClock;
  /**
   * The decision check (R9.2, R9.3, OD-17): the Runner passes the identity of what it is about to execute, and the callback answers from the
   * Evidence_Store. `createAcceptanceCheck` of the identity module is the implementation. The Runner also re-runs the policy decision itself.
   */
  isAccepted(experimentId: string, decisionRecordId: string, identity: ExecutionIdentity): AcceptanceVerdict;
  /** With both set, the runner checks the lease every `intervalMs` while a request is in flight and aborts it when the lease is invalid (R24.15). */
  readonly inFlightWatch?: { readonly intervalMs: number; readonly sleeper: Sleeper };
}
