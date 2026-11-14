// Experiment_Runner (design: "Runner behavior summary (R9)", "Runner-owned preparation table", "Lease timing"; R9; task 2.15).
//
// The runner executes one accepted Experiment at a time. Everything it sends goes through one function, `send`, which checks, in this
// order, before each request (the health check, reset, preparation, request sequence, and state checks alike):
//   1. the time limit of the Experiment (R9.14) and the stop signal;
//   2. the Run_Lease (`LeasePort.check`, which never answers `valid` before the start-up proof passed);
//   3. that the operation is one the runner may send (the policy allowlist or the internal operations of the table);
//   4. that the target resolves to the configured origin (R9.16).
// Only then is `HttpPort.send` called. No lock is taken per Experiment (R9.4). No SQL, no fixture, no direct database access (R9.11).
import { MASK_TOKEN, maskConfigHash, maskJson, validateMaskConfig } from "../compare/mask.js";
import type { Json, MaskConfig, ObservedResponse } from "../compare/types.js";
import { LeaseCheckInterrupted, terminationReasonOf, type LeaseState } from "../lease/index.js";
import { experimentSha256, policyConfigSha256, preparationTableSha256, type ExecutionIdentity } from "../identity/hash.js";
import { decide } from "../policy/decide.js";
import { canonicalJsonText } from "../policy/guards.js";
import type { Experiment, PolicyRequest, Result } from "../policy/types.js";
import { buildStepBody, normalizeOperationPath, validatePreparationStep } from "../prep/index.js";
import type { PrepOperation, ValidatedStep } from "../prep/index.js";
import { checkTestApiAddress, resolveRequestTarget, validateAddressPolicy } from "./address.js";
import {
  AddressNotAllowedError,
  EXPERIMENT_TIMEOUT_RANGE_MS,
  HEALTH_TIMEOUT_MS,
  HttpAbortedError,
  HttpTimeoutError,
  REQUEST_TIMEOUT_RANGE_MS,
  type ExecutionObservation,
  type ExecuteOptions,
  type ExecutionOutcome,
  type ExperimentRunner,
  type InterruptedOutcome,
  type HttpRequest,
  type HttpResponse,
  type LeaseCauseInfo,
  type NotExecutedReason,
  type PrepLogEntry,
  type RunnerDeps,
  type RunnerLimits,
  type RunStopCause,
} from "./types.js";

export interface RunnerStartRefusal {
  readonly code: "limits_invalid" | "address_not_allowed" | "address_policy_invalid" | "mask_config_invalid" | "identity_hash_failed" | "preparation_table_mismatch";
  /** The configured value that was refused, to be recorded in the Evidence_Store (R9.17). */
  readonly address?: string;
  readonly detail?: string;
}

/** The runner refused to start: it sends no request and executes no Experiment. */
export class RunnerStartRefused extends Error {
  readonly refusals: readonly RunnerStartRefusal[];
  constructor(refusals: readonly RunnerStartRefusal[]) {
    super(`runner start refused: ${refusals.map((r) => r.code).join(", ")}`);
    this.name = "RunnerStartRefused";
    this.refusals = refusals;
  }
}

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);

/** R9.14: the request limit is 1 to 60 seconds, the Experiment limit 1 to 600 seconds, and the Experiment limit is not smaller. */
export function validateRunnerLimits(limits: RunnerLimits): string[] {
  const errors: string[] = [];
  const r = limits?.requestTimeoutMs;
  const e = limits?.experimentTimeoutMs;
  if (!isInt(r) || r < REQUEST_TIMEOUT_RANGE_MS.min || r > REQUEST_TIMEOUT_RANGE_MS.max) errors.push("request_timeout_out_of_range");
  if (!isInt(e) || e < EXPERIMENT_TIMEOUT_RANGE_MS.min || e > EXPERIMENT_TIMEOUT_RANGE_MS.max) errors.push("experiment_timeout_out_of_range");
  if (isInt(r) && isInt(e) && e < r) errors.push("experiment_timeout_below_request_timeout");
  return errors;
}

export interface ValidatedRunnerStart {
  readonly origin: string;
  readonly mask: MaskConfig;
  readonly maskSha256: string;
  /** Hash of the policy configuration and of the preparation table that this Runner works with (OD-17). */
  readonly policySha256: string;
  readonly tableSha256: string;
}

/**
 * The checks made before the first request (R9.14, R9.17, R18.3). The preparation table of the Runner must be the one that the policy
 * configuration carries (task 2.26: one definition); a difference refuses the start.
 */
export function checkRunnerStart(deps: Pick<RunnerDeps, "baseAddress" | "addressPolicy" | "limits" | "mask" | "policy" | "prepTable">): Result<ValidatedRunnerStart, RunnerStartRefusal[]> {
  const refusals: RunnerStartRefusal[] = [];
  const limitErrors = validateRunnerLimits(deps.limits);
  if (limitErrors.length > 0) refusals.push({ code: "limits_invalid", detail: limitErrors.join(",") });
  let origin = "";
  if (!validateAddressPolicy(deps.addressPolicy).ok) refusals.push({ code: "address_policy_invalid", address: String(deps.baseAddress) });
  else {
    const checked = checkTestApiAddress(deps.baseAddress, deps.addressPolicy);
    if (!checked.ok) refusals.push({ code: "address_not_allowed", address: String(deps.baseAddress) });
    else origin = checked.value;
  }
  const mask = validateMaskConfig(deps.mask);
  if (!mask.ok) refusals.push({ code: "mask_config_invalid", detail: mask.error.join("; ").slice(0, 200) });
  let policySha256 = "";
  let tableSha256 = "";
  try {
    policySha256 = policyConfigSha256(deps.policy);
    tableSha256 = preparationTableSha256(deps.prepTable);
    if (preparationTableSha256(deps.policy.preparationTable) !== tableSha256) refusals.push({ code: "preparation_table_mismatch" });
  } catch {
    refusals.push({ code: "identity_hash_failed" });
  }
  if (refusals.length > 0 || !mask.ok) return { ok: false, error: refusals };
  return { ok: true, value: { origin, mask: mask.value, maskSha256: maskConfigHash(mask.value), policySha256, tableSha256 } };
}

type Phase = "reset" | "prep" | "boundary" | "seq" | "state";

/** An early end of an Experiment, raised inside the runner and turned into an outcome at the top. */
class Halt extends Error {
  readonly kind: "lease" | "address" | "timeout" | "abort" | "transport" | "operation";
  readonly lease: { readonly valid: false; readonly reason: import("../lease/types.js").LeaseReason } | undefined;
  readonly detail: string | undefined;
  constructor(kind: Halt["kind"], detail?: string, lease?: Halt["lease"]) {
    super(kind);
    this.kind = kind;
    this.detail = detail;
    this.lease = lease;
  }
}

interface Ctx {
  readonly id: string;
  readonly signal: AbortSignal;
  /** On the monotonic clock. The smaller of the Experiment limit and `notAfterMs`. */
  deadlineAt: number;
  /** True when the deadline is the Run time limit (`notAfterMs`) and not the limit of the Experiment. */
  runLimited: boolean;
  phase: Phase;
  step: number | undefined;
  seqSent: number;
  readonly responses: ObservedResponse[];
  readonly stateChecks: ObservedResponse[];
  readonly prep: PrepLogEntry[];
  readonly binds: Map<string, number>;
}

interface PlannedRequest {
  readonly spec: PolicyRequest;
  readonly bodyText: string | undefined;
}

/** A preparation step failed: the Experiment is `not_executed` with `preparation_failed`, the step, and the recorded status or `none` (R9.12). The phase decides the reason. */
const prepFailure = (detail: string): Halt => new Halt("transport", detail);

const PLACEHOLDER = /\{([^{}]*)\}/g;
const ID_MAX = 2147483647;

function readDotted(value: unknown, path: string): unknown {
  let cur: unknown = value;
  for (const key of path.split(".")) {
    if (typeof cur !== "object" || cur === null || Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

export function createRunner(deps: RunnerDeps): ExperimentRunner {
  const start = checkRunnerStart(deps);
  if (!start.ok) throw new RunnerStartRefused(start.error);
  return new Runner(deps, start.value);
}

class Runner implements ExperimentRunner {
  private readonly deps: RunnerDeps;
  private readonly origin: string;
  private readonly mask: MaskConfig;
  private readonly maskSha256: string;
  private readonly policySha256: string;
  private readonly tableSha256: string;
  private healthy = false;
  /** Set when the Run was stopped in the middle of an Experiment; nothing more is executed after it. */
  private stopped: { readonly cause: RunStopCause; readonly detail: string } | undefined;
  private tail: Promise<void> = Promise.resolve();

  constructor(deps: RunnerDeps, start: ValidatedRunnerStart) {
    this.deps = deps;
    this.origin = start.origin;
    this.mask = start.mask;
    this.maskSha256 = start.maskSha256;
    this.policySha256 = start.policySha256;
    this.tableSha256 = start.tableSha256;
  }

  // ------------------------------------------------------------------------------------------------ health (R9.1)

  async health(): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
    this.healthy = false;
    const ctx = this.newCtx("health", new AbortController().signal, this.deps.clock.nowMs() + HEALTH_TIMEOUT_MS);
    try {
      const resp = await this.send(ctx, { method: "GET", path: "/health" }, "/health", HEALTH_TIMEOUT_MS);
      if (resp.status < 200 || resp.status > 299) return { ok: false, error: `unhealthy:status_${resp.status}` };
      this.healthy = true;
      return { ok: true };
    } catch (error) {
      if (error instanceof Halt) {
        if (error.kind === "lease") return { ok: false, error: `lease_unavailable:${error.lease?.reason ?? "unreadable"}` };
        if (error.kind === "address") return { ok: false, error: "address_not_allowed" };
        if (error.kind === "timeout") return { ok: false, error: "unhealthy:timeout" };
        return { ok: false, error: `unhealthy:${error.kind}` };
      }
      return { ok: false, error: "unhealthy:internal_error" };
    }
  }

  // ---------------------------------------------------------------------------------------------- execute (R9.2 to R9.16)

  /** At most one Experiment at a time, in the order submitted (R9.7): a call made while another runs waits for it. */
  execute(e: Experiment, decisionRecordId: string, signal: AbortSignal, options: ExecuteOptions = {}): Promise<ExecutionOutcome> {
    const result = this.tail.then(() => this.executeOne(e, decisionRecordId, signal, options));
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async executeOne(e: Experiment, decisionRecordId: string, signal: AbortSignal, options: ExecuteOptions): Promise<ExecutionOutcome> {
    const id = typeof (e as { experimentId?: unknown } | null | undefined)?.experimentId === "string" ? e.experimentId : "";
    const ctx = this.newCtx(id, signal, this.deps.clock.nowMs() + this.deps.limits.experimentTimeoutMs);
    // After a forced stop or a fatal error nothing more is executed (OD-18): the Run is over.
    if (this.stopped !== undefined) return this.interrupted(ctx, this.stopped.cause, "not_started", this.stopped.detail);
    if (signal.aborted) return this.stop(ctx, "forced_stop", "run_aborted", "not_started");
    try {
      const notAfter = options.notAfterMs;
      if (notAfter !== undefined) {
        if (typeof notAfter !== "number" || !Number.isFinite(notAfter)) throw new TypeError("notAfterMs is not a finite number");
        if (notAfter <= ctx.deadlineAt) {
          ctx.deadlineAt = notAfter;
          ctx.runLimited = true;
        }
      }
      return await this.run(ctx, e, decisionRecordId);
    } catch (error) {
      if (error instanceof Halt) return this.fromHalt(ctx, error);
      // A bug must not escape as an exception, and must not be presented as a result of the Experiment. The Run ends with `error`.
      if (ctx.seqSent > 0) return this.stop(ctx, "fatal_error", "internal_error", ctx.phase);
      this.stopped = { cause: "fatal_error", detail: "internal_error" };
      return this.notExecuted(ctx, "runner_internal_error", undefined, undefined, true);
    }
  }

  private newCtx(id: string, signal: AbortSignal, deadlineAt: number): Ctx {
    return { id, signal, deadlineAt, runLimited: false, phase: "reset", step: undefined, seqSent: 0, responses: [], stateChecks: [], prep: [], binds: new Map() };
  }

  /** The detail of a deadline: which limit it was. */
  private deadlineDetail(ctx: Ctx): string {
    return ctx.runLimited ? "run_time_limit" : "experiment_time_limit";
  }
  private async run(ctx: Ctx, e: Experiment, decisionRecordId: string): Promise<ExecutionOutcome> {
    if (!this.healthy) return this.notExecuted(ctx, "runner_not_healthy");
    // R9.2, R9.3, OD-17: only an Experiment with a recorded accept decision about this content, this policy configuration, and this
    // preparation table. No request is sent for any other.
    if (typeof decisionRecordId !== "string" || decisionRecordId === "") return this.notExecuted(ctx, "policy_not_accepted", undefined, "not_accepted:record_missing");
    let identity: ExecutionIdentity;
    try {
      identity = { experimentSha256: experimentSha256(e), policyConfigSha256: this.policySha256, preparationTableSha256: this.tableSha256 };
    } catch {
      return this.notExecuted(ctx, "policy_not_accepted", undefined, "experiment_not_hashable");
    }
    const verdict = this.deps.isAccepted(ctx.id, decisionRecordId, identity);
    if (verdict?.accepted !== true) {
      return this.notExecuted(ctx, "policy_not_accepted", undefined, `not_accepted:${verdict?.accepted === false ? verdict.code : "invalid_verdict"}`);
    }
    // The policy decides again immediately before the execution (OD-17, P2): the same pure function, the same configuration and table.
    const again = decide(e, this.deps.policy);
    if (again.decision !== "accept" || again.experimentId !== ctx.id) {
      return this.notExecuted(ctx, "policy_not_accepted", undefined, `redecision_rejected:${again.ruleIds.join(",")}`.slice(0, 300));
    }
    const plan = this.plan(e);
    if (!plan.ok) return this.notExecuted(ctx, "policy_not_accepted", undefined, plan.error);
    // The Run time limit has already passed: nothing is started (R11.12).
    if (this.deps.clock.nowMs() >= ctx.deadlineAt) return this.notExecuted(ctx, "timeout_before_requests", undefined, this.deadlineDetail(ctx));

    // The lease before the Experiment starts (R9.5).
    ctx.phase = "reset";
    await this.leaseGate(ctx);

    // R9.8, R9.9: reset first, confirmed.
    const reset = await this.send(ctx, { method: "POST", path: "/reset" }, "/reset");
    if (reset.status !== 200 || !this.isSuccess(reset.body)) return this.notExecuted(ctx, "reset_failed", undefined, `status:${reset.status}`);

    // R9.10, R9.12: preparation steps, in order, from the runner-owned table.
    ctx.phase = "prep";
    const steps = Array.isArray(e.preparation) ? e.preparation : [];
    for (let i = 0; i < steps.length; i += 1) {
      ctx.step = i;
      await this.prepare(ctx, steps[i], i);
    }
    ctx.step = undefined;

    // The paths of all requests are resolved before the first one is sent, so an unresolved bind sends nothing.
    ctx.phase = "boundary";
    const requests = plan.value.requests.map((r) => this.resolve(ctx, r));
    const checks = plan.value.stateChecks.map((r) => this.resolve(ctx, r));
    if (requests.some((r) => r === undefined) || checks.some((r) => r === undefined)) return this.notExecuted(ctx, "preparation_failed", undefined, "unresolved_bind");
    if (this.deps.clock.nowMs() >= ctx.deadlineAt) throw new Halt("timeout", this.deadlineDetail(ctx));
    if (ctx.signal.aborted) throw new Halt("abort", "run_aborted");

    // R9.13: the requests, one at a time, in declared order; then the state checks.
    ctx.phase = "seq";
    for (const r of requests as PlannedResolved[]) {
      const resp = await this.send(ctx, r.request, r.template, undefined, true);
      ctx.responses.push(this.observed(resp));
    }
    ctx.phase = "state";
    for (const r of checks as PlannedResolved[]) {
      const resp = await this.send(ctx, r.request, r.template);
      ctx.stateChecks.push(this.observed(resp));
    }
    return { status: "executed", observation: this.observation(ctx, "executed"), preparationLog: [...ctx.prep] };
  }

  // ------------------------------------------------------------------------------------------------------ planning

  /** Checks the shape of the Experiment and that every request is an operation of the policy allowlist (a defense in depth; the policy decided already). */
  private plan(e: Experiment): Result<{ requests: PlannedRequest[]; stateChecks: PlannedRequest[] }, string> {
    try {
      if (typeof e !== "object" || e === null || !Array.isArray(e.requests) || e.requests.length === 0) return { ok: false, error: "experiment_shape" };
      const stateChecks = Array.isArray(e.stateChecks) ? e.stateChecks : [];
      const one = (r: PolicyRequest): PlannedRequest | undefined => {
        if (typeof r !== "object" || r === null || (r.method !== "GET" && r.method !== "POST") || typeof r.path !== "string") return undefined;
        if (!this.deps.policy.operations.some((o) => o.method === r.method && o.path === r.path)) return undefined;
        return { spec: r, bodyText: r.body === undefined ? undefined : canonicalJsonText(r.body) };
      };
      const requests = e.requests.map(one);
      const checks = stateChecks.map(one);
      if (requests.some((r) => r === undefined) || checks.some((r) => r === undefined)) return { ok: false, error: "operation_not_allowed" };
      return { ok: true, value: { requests: requests as PlannedRequest[], stateChecks: checks as PlannedRequest[] } };
    } catch {
      return { ok: false, error: "experiment_shape" };
    }
  }

  /** Replaces the placeholders of a request path by the path parameters and the captured values. Undefined if one cannot be resolved. */
  private resolve(ctx: Ctx, planned: PlannedRequest): PlannedResolved | undefined {
    const { spec } = planned;
    const params = (spec.pathParams ?? {}) as Record<string, unknown>;
    let ok = true;
    const path = spec.path.replace(PLACEHOLDER, (_m, name: string) => {
      const v = Object.prototype.hasOwnProperty.call(params, name) ? params[name] : undefined;
      let n: number | undefined;
      if (typeof v === "number") n = v;
      else if (typeof v === "object" && v !== null && typeof (v as { $bind?: unknown }).$bind === "string") n = ctx.binds.get((v as { $bind: string }).$bind);
      if (n === undefined || !Number.isSafeInteger(n) || n < 1 || n > ID_MAX) {
        ok = false;
        return "";
      }
      return String(n);
    });
    if (!ok) return undefined;
    const headers: Record<string, string> = {};
    if (spec.headers !== undefined) for (const [k, v] of Object.entries(spec.headers)) if (typeof v === "string") headers[k] = v;
    const request: HttpRequest = {
      method: spec.method as "GET" | "POST",
      path,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(planned.bodyText !== undefined ? { body: planned.bodyText } : {}),
    };
    return { request, template: spec.path };
  }

  // -------------------------------------------------------------------------------------------------- preparation

  private async prepare(ctx: Ctx, raw: unknown, index: number): Promise<void> {
    const checked = validatePreparationStep(this.deps.prepTable, raw);
    if (!checked.ok) throw prepFailure(`untranslatable:${checked.error.slice(0, 5).join(",")}`);
    const step: ValidatedStep = checked.value;
    let captured: number | undefined;
    for (const op of step.kind.translate) {
      const built = this.buildOperation(op, raw, captured);
      if (built === undefined) throw prepFailure("untranslatable:operation");
      let resp: HttpResponse;
      try {
        resp = await this.send(ctx, built.request, built.template);
      } catch (error) {
        if (error instanceof Halt && error.kind === "transport") throw prepFailure("status:none");
        throw error;
      }
      ctx.prep.push({ stepIndex: index, operation: `${op.method} ${op.path}`, status: resp.status });
      if (resp.status !== op.expect) throw prepFailure(`status:${resp.status}`);
      if (op.capture !== undefined) {
        const parsed = parseJson(resp.body);
        const value = parsed.ok ? readDotted(parsed.value, op.capture.fromResponse) : undefined;
        if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > ID_MAX) throw prepFailure(`status:${resp.status};capture_missing`);
        captured = value;
        if (step.bind !== undefined) ctx.binds.set(step.bind, value);
      }
    }
  }

  private buildOperation(op: PrepOperation, raw: unknown, captured: number | undefined): PlannedResolved | undefined {
    let path = op.path;
    if (path.includes("{bound}")) {
      if (captured === undefined) return undefined;
      path = path.split("{bound}").join(String(captured));
    }
    let body: string | undefined;
    if (op.body === "assembled") {
      const b = buildStepBody(this.deps.prepTable, raw);
      if (!b.ok) return undefined;
      body = canonicalJsonText(b.value);
    }
    return { request: { method: op.method, path, ...(body !== undefined ? { body } : {}) }, template: op.path };
  }

  // -------------------------------------------------------------------------------------------------------- sending

  private async leaseGate(ctx: Ctx): Promise<void> {
    let state: LeaseState;
    try {
      state = await this.deps.lease.check({ signal: ctx.signal, deadlineAtMs: ctx.deadlineAt });
    } catch (error) {
      if (error instanceof LeaseCheckInterrupted) throw new Halt(error.why === "deadline" ? "timeout" : "abort", error.why === "deadline" ? this.deadlineDetail(ctx) : "run_aborted");
      // A failure of the lease check itself is never a reason to send: fail closed.
      throw new Halt("lease", undefined, { valid: false, reason: "unreadable" });
    }
    if (!state.valid) throw new Halt("lease", undefined, state);
  }

  private operationAllowed(method: string, template: string): boolean {
    const folded = normalizeOperationPath(template);
    if (this.deps.prepTable.internalOperations.some((o) => o.method === method && o.path === folded)) return true;
    return this.deps.policy.operations.some((o) => o.method === method && o.path === folded);
  }

  /** The only place that calls `HttpPort.send`. */
  private async send(ctx: Ctx, request: HttpRequest, template: string, timeoutOverrideMs?: number, countsAsSequence = false): Promise<HttpResponse> {
    const { clock, http, limits } = this.deps;
    if (clock.nowMs() >= ctx.deadlineAt) throw new Halt("timeout", this.deadlineDetail(ctx));
    if (ctx.signal.aborted) throw new Halt("abort", "run_aborted");
    await this.leaseGate(ctx);
    if (!this.operationAllowed(request.method, template)) throw new Halt("operation", "operation_not_allowed");
    if (!resolveRequestTarget(this.origin, request.path).ok) throw new Halt("address", "target_not_allowed");

    const remaining = ctx.deadlineAt - clock.nowMs();
    if (remaining <= 0) throw new Halt("timeout", this.deadlineDetail(ctx));
    const timeoutMs = Math.min(timeoutOverrideMs ?? limits.requestTimeoutMs, remaining);

    const controller = new AbortController();
    const onStop = (): void => controller.abort();
    ctx.signal.addEventListener("abort", onStop, { once: true });
    const stopWatch = new AbortController();
    const flagged: { lease?: NonNullable<Halt["lease"]> } = {};
    const watching = this.deps.inFlightWatch === undefined ? Promise.resolve() : this.watch(controller, stopWatch.signal, (s) => { flagged.lease = s; });
    if (countsAsSequence) ctx.seqSent += 1;
    try {
      return await http.send(request, timeoutMs, controller.signal);
    } catch (error) {
      if (flagged.lease !== undefined) throw new Halt("lease", undefined, flagged.lease);
      if (error instanceof AddressNotAllowedError) {
        if (countsAsSequence) ctx.seqSent -= 1; // the adapter refused the target before sending: nothing of the sequence was sent
        throw new Halt("address", "target_not_allowed");
      }
      if (error instanceof HttpTimeoutError) throw new Halt("timeout", clock.nowMs() >= ctx.deadlineAt - 1 ? this.deadlineDetail(ctx) : "request_time_limit");
      if (error instanceof HttpAbortedError && ctx.signal.aborted) throw new Halt("abort", "run_aborted");
      throw new Halt("transport", "transport_error");
    } finally {
      stopWatch.abort();
      await watching;
      ctx.signal.removeEventListener("abort", onStop);
    }
  }

  /** While a request is in flight: check the lease every interval and abort the request when it is invalid (R24.15). */
  private async watch(controller: AbortController, stop: AbortSignal, onInvalid: (s: { readonly valid: false; readonly reason: import("../lease/types.js").LeaseReason }) => void): Promise<void> {
    const { intervalMs, sleeper } = this.deps.inFlightWatch as NonNullable<RunnerDeps["inFlightWatch"]>;
    while (!stop.aborted) {
      try {
        await sleeper.sleep(intervalMs, stop);
      } catch {
        return;
      }
      if (stop.aborted) return;
      let state: LeaseState;
      try {
        state = await this.deps.lease.check({ signal: stop });
      } catch {
        return;
      }
      if (!state.valid) {
        onInvalid(state);
        controller.abort();
        return;
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------- results

  private isSuccess(body: string): boolean {
    const p = parseJson(body);
    return p.ok && typeof p.value === "object" && p.value !== null && (p.value as { success?: unknown }).success === true;
  }

  /** The recorded form of a response: parsed JSON is masked (C2); text and empty bodies are kept as they are. */
  private observed(resp: HttpResponse): ObservedResponse {
    if (resp.body === "") return { status: resp.status, bodyKind: "empty" };
    const parsed = parseJson(resp.body);
    if (!parsed.ok) return { status: resp.status, bodyKind: "text", body: resp.body };
    try {
      return { status: resp.status, bodyKind: "json", body: maskJson(parsed.value as Json, this.mask) };
    } catch {
      // Too deeply nested to mask: the whole body is the masked node.
      return { status: resp.status, bodyKind: "text", body: MASK_TOKEN };
    }
  }

  private observation(ctx: Ctx, outcome: ExecutionObservation["outcome"], extra: Partial<Pick<ExecutionObservation, "abortReason" | "notExecuted">> = {}): ExecutionObservation {
    return {
      experimentId: ctx.id,
      outcome,
      ...extra,
      preparation: [...ctx.prep],
      responses: [...ctx.responses],
      stateChecks: [...ctx.stateChecks],
      maskSha256: this.maskSha256,
    };
  }

  private notExecuted(ctx: Ctx, reason: NotExecutedReason, info?: LeaseCauseInfo, detail?: string, fatal = false): ExecutionOutcome {
    const step = ctx.step;
    return {
      status: "not_executed",
      reason,
      ...(fatal ? { fatal: true as const } : {}),
      ...(step !== undefined ? { step } : {}),
      ...(detail !== undefined ? { detail } : {}),
      ...(info ?? {}),
      observation: this.observation(ctx, "not_executed", { notExecuted: { reason, ...(step !== undefined ? { step } : {}), ...(detail !== undefined ? { detail } : {}) } }),
    };
  }

  private interrupted(ctx: Ctx, cause: RunStopCause, phase: InterruptedOutcome["phase"], detail: string): ExecutionOutcome {
    const step = ctx.step;
    return {
      status: "interrupted",
      cause,
      experimentId: ctx.id,
      phase,
      ...(step !== undefined ? { step } : {}),
      sentRequests: ctx.seqSent,
      collectedResponses: ctx.responses.length,
      collectedStateChecks: ctx.stateChecks.length,
      ...(cause === "fatal_error" ? { fatal: true as const } : {}),
      detail,
    };
  }

  /** Stops the Run in the middle of an Experiment and remembers it, so that nothing more is executed. */
  private stop(ctx: Ctx, cause: RunStopCause, detail: string, phase: InterruptedOutcome["phase"]): ExecutionOutcome {
    this.stopped ??= { cause, detail };
    return this.interrupted(ctx, cause, phase, detail);
  }

  private timedOut(ctx: Ctx, detail?: string): ExecutionOutcome {
    return { status: "timed_out", ...(detail !== undefined ? { detail } : {}), observation: this.observation(ctx, "timed_out") };
  }

  private fromHalt(ctx: Ctx, h: Halt): ExecutionOutcome {
    const sent = ctx.seqSent > 0;
    switch (h.kind) {
      case "lease": {
        const reason = h.lease?.reason ?? "unreadable";
        const info: LeaseCauseInfo = { leaseReason: reason, terminationReason: terminationReasonOf({ reason }) };
        if (sent) return { status: "aborted", reason: "lease_unavailable", ...info, observation: this.observation(ctx, "aborted", { abortReason: "lease_unavailable" }) };
        return this.notExecuted(ctx, "lease_unavailable", info, `lease:${reason}`);
      }
      case "address":
        if (sent) return { status: "aborted", reason: "address_not_allowed", observation: this.observation(ctx, "aborted", { abortReason: "address_not_allowed" }) };
        return this.notExecuted(ctx, "address_not_allowed");
      case "operation":
        return this.notExecuted(ctx, "policy_not_accepted", undefined, h.detail);
      case "abort":
        // A forced stop is not a time limit and is not turned into `timed_out` or into a failure of the reset or the preparation (OD-18).
        return this.stop(ctx, "forced_stop", h.detail ?? "run_aborted", ctx.phase);
      case "timeout":
      case "transport":
        switch (ctx.phase) {
          case "reset":
            return this.notExecuted(ctx, "reset_failed", undefined, h.detail ?? h.kind);
          case "prep":
            return this.notExecuted(ctx, "preparation_failed", undefined, h.detail ?? h.kind);
          case "boundary":
            return this.notExecuted(ctx, "timeout_before_requests", undefined, h.detail ?? h.kind);
          default:
            return this.timedOut(ctx, h.detail ?? h.kind);
        }
    }
  }
}

interface PlannedResolved {
  readonly request: HttpRequest;
  /** The path template, with the placeholders; it is what the operation check and the log use. */
  readonly template: string;
}
