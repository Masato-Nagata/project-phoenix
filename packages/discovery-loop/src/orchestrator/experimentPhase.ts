// Experiment phase of the Loop_Orchestrator: generation, validation, policy, execution, comparison, Evidence (task 4.4, unit U6b; R6.7, R7.2, R7.4,
// R7.8, R8.11, R10.8, R11.7, R11.9, R11.14, R12.14, R22.2).
//
// `runExperimentPhase` makes ONE logical phase call for the kind `experiment_generation` and then works through the Experiments of the answer, one
// at a time. It takes its ports explicitly (no `LoopDeps`), receives the public `RecordWriter` only, and raises causes on the `RunSession`. It never
// writes a termination record, never closes admission and never touches the termination capability. It is NOT the Iteration loop and makes NO
// revision call (U6c); it does not build the Source_Bundle, the manifest or the end of the Run (U7).
//
// ORDER of one call:
//    1. `checkLeaseBoundary`; a stop returns `stopped`.
//    2. ONE `callProvider` (U5) for `experiment_generation`. A response that the gate accepted is read defensively. An Experiment that the gate
//       rejected one by one is an `experiment_invalid` record, NOT a failed provider call: no retry and no `noteProviderRetry` here.
//    3. VALIDATION PASS (before any policy work), in the order of the response: every gate-rejected Experiment, every accepted Experiment whose
//       `target` does not name the current hypothesis or one of its claims (`unknown_target`), and every accepted Experiment whose `localKey` repeats an
//       earlier accepted one of the same response (`duplicate_local_key`; the existing rules do not say what to do with a duplicate, so it is an
//       invalid Experiment; the first one stays). Each is ONE `experiment_invalid` record. None of them is executed or counted by the policy.
//       The target of a valid claim Experiment is resolved to the claim revision that is current in the accepted hypothesis (design, "Experiment
//       target"): `testedClaimRevisionId`. A `hypothesis` target must equal the current `hypothesisId` and gets no per-Claim Evidence (C6).
//    4. EXECUTION PASS, per valid Experiment, strictly in this order:
//         a. latch `none`, signal not aborted, one deadline checkpoint (else `stopped`);
//         b. Experiment limit (R11.9): `session.experimentCount >= limits.experiments` drops THIS and every remaining valid Experiment
//            (`experiment_dropped`, reason `experiment_limit`, NO `experimentId`: the design (Counters, "acceptedExperiments") is silent about an id, and an
//            id is taken only for an Experiment that reaches the `experiment` record), then raises `experiment_limit_reached`. No policy, no runner;
//         c. the `experiment` record; the normalized verifier Experiment is the AI Experiment WITHOUT `localKey`, plus `experimentId`
//            (`ids.nextExperimentId(iteration)`, taken only here);
//         d. `policy.evaluateForRecord(...)`, the `policy_decision` record with that payload, `writer.drain()`, and the append result checked. A
//            failure raises `error` and the Runner is NOT called;
//         e. reject: `noteRejectedExperiment`; the rejected-Experiment limit is reached when `policyRejectionCount >= limits.rejectedExperiments`
//            (R8.11): raise `policy_rejection_limit`; otherwise the next Experiment;
//         f. accept: `noteAcceptedExperiment`, then `runner.execute(e, decisionRecordId, session.signal, { notAfterMs: session.deadlineAtMs })`.
//    5. OUTCOMES (below). 6. END: no Experiment accepted by the policy in this call raises `no_further_experiments` (R7.8, R11.14).
//
// OUTCOMES. A record of a COMPLETED Experiment is written also when a cause was latched while it ran (it is a fact the Runner reported); no further
// Experiment is started after a latched cause.
//   executed                      observation, comparison (the comparator), and for a claim target one experiment Evidence (R6.7, C6).
//   timed_out / aborted / not_executed
//                                 observation, a `not_comparable` comparison (the comparator itself yields it for these outcomes, R10.8: the
//                                 reason equals the outcome; anything else is a fault and raises `error`), and for a claim target an `inconclusive`
//                                 experiment Evidence. Then, by the closed rules of `attribution`:
//                                   fatal: true                  -> `error` record, raise `error`, stop (design, "Runner decisions", item 3);
//                                   detail `run_time_limit`      -> raise `time_limit_reached`, stop (item 7, "Run time limit"), no error record;
//                                   a lease hint                 -> raise `launcher_killed` (heartbeat_stale) or `lease_unavailable`, stop (R24.15);
//                                   `address_not_allowed`        -> `error` record, raise `error`, stop (R9.16);
//                                   timed_out + `transport_error`-> `error` record; the Run goes on (design, item 5: "writes the real cause into an
//                                                                   error record"; only a failed write ends the Run with `error`, tasks.md 4.4);
//                                   anything else non-fatal      -> the Run goes on with the next Experiment.
//   interrupted                   NO observation, comparison or Evidence. An `error` record (`experiment_interrupted`), then `fatal_error` (or
//                                 `fatal: true`) raises `error`; `forced_stop` is attributed to the cause that is already latched
//                                 (`attributeSymptom("forced_stop")`; it never lowers a latched cause). No later Experiment.
// Priority between reasons is the latch's: nothing here lowers a latched cause.
//
// RECORD PAYLOADS (closed vocabularies; no AI free text, runner or provider message, secret, host path or approval object):
//   experiment          { experimentId, iteration, localKey, target, testedClaimRevisionId?, experiment }
//   experiment_invalid  { requestKind: "experiment_generation", aiOutputRecordId, index, issues: [{ code, path }] } (at most 20 issues)
//   experiment_dropped  { reason: "experiment_limit" }
//   policy_decision     the payload of `evaluateForRecord`, as a JSON copy
//   observation         the observation object of the Runner, as a JSON copy
//   comparison          the result of the comparator, as a JSON copy
//   evidence            the stored Evidence record, as a JSON copy
//   error               { code, experimentId, phase, cause }
//
// THE ONE THROW. The only exception that leaves this function is the sanctioned throw of `callProvider` (unreadable records), passed on unchanged.
// Every other failure raises `error` and returns `stopped`.
import { experimentRuleComponent, type EvidenceStore } from "../model/evidenceStore.js";
import type { Json } from "../schema/types.js";
import { deadlineCheckpoint } from "./deadline.js";
import type { AcceptedClaimRef } from "./hypothesisPhase.js";
import type { IdCounters } from "./ids.js";
import { checkLeaseBoundary } from "./leaseBoundary.js";
import { callProvider } from "./providerCall.js";
import type { RecordWriter } from "./recordWriter.js";
import type { RunSession } from "./session.js";
import type { AuditPort, ComparatorPort, ExperimentRunnerPort, MonotonicClockPort, PolicyPort, ProviderPort, ResponseGatePort, StoredPartRef, TerminationReason, TimerPort } from "./types.js";

/** The current hypothesis: what a target is resolved against. Taken from the `accepted` result of the hypothesis phase. */
export interface CurrentHypothesisRef {
  readonly hypothesisId: string;
  readonly claims: readonly Pick<AcceptedClaimRef, "claimId" | "claimRevisionId">[];
}

export interface ExperimentPhaseInput<TAudit, TRequest, TPolicy> {
  readonly session: RunSession;
  readonly writer: RecordWriter;
  readonly clock: MonotonicClockPort;
  readonly timers: TimerPort;
  readonly provider: ProviderPort<TRequest>;
  readonly audit: AuditPort<TAudit, TRequest>;
  readonly auditConfig: TAudit;
  readonly responseGate: ResponseGatePort;
  readonly responseLimits: unknown;
  readonly validator: unknown;
  /** One per Run, created by the composition root. */
  readonly evidenceStore: EvidenceStore;
  readonly ids: IdCounters;
  /** The lease instance that stage B proved. */
  readonly leasePort: unknown;
  readonly bundle: unknown;
  readonly templateId: string;
  readonly stored: readonly StoredPartRef[];
  /** `experiments` and `rejectedExperiments` are the Run limits (counted by the session across the Run). */
  readonly limits: {
    readonly providerCallSeconds: number;
    readonly providerRetries: number;
    readonly experiments: number;
    readonly rejectedExperiments: number;
  };
  /** The number of the current Iteration (a non-negative safe integer); it goes into the Experiment identifiers. */
  readonly iteration: number;
  readonly hypothesis: CurrentHypothesisRef;
  readonly policy: Pick<PolicyPort<TPolicy>, "evaluateForRecord">;
  readonly policyConfig: TPolicy;
  readonly runner: Pick<ExperimentRunnerPort, "execute">;
  readonly comparator: ComparatorPort;
  /** The mask configuration of the comparator (the same one the Runner works with). */
  readonly mask: unknown;
}

export type ComparisonResultName = "match" | "mismatch" | "not_comparable";

/** One Experiment that was handed to the Runner and came back with an Observation. */
export interface ExecutedExperiment {
  readonly experimentId: string;
  readonly experimentRecordId: string;
  readonly observationRecordId: string;
  readonly comparisonRecordId: string;
  /** The ids of the experiment Evidence of this Experiment: one for a claim target, none for a hypothesis target. */
  readonly evidenceIds: readonly string[];
  readonly comparisonResult: ComparisonResultName;
}

export interface ExperimentPhaseSummary {
  /** Experiments that the policy accepted in this call. */
  readonly acceptedInPhase: number;
  /** Experiments that the policy rejected in this call. */
  readonly rejectedInPhase: number;
  readonly executed: readonly ExecutedExperiment[];
  /** The experiment Evidence ids of this call, in order: `promptedByEvidence` of the next revision (U6c). */
  readonly evidenceIdsForRevision: readonly string[];
  /** The experiment, observation and comparison records of this call, as parts of the revision request (U6c). `partId` is unique per record. */
  readonly storedRefsForRevision: readonly StoredPartRef[];
}

export type ExperimentLimitReason = "experiment_limit_reached" | "policy_rejection_limit" | "no_further_experiments";

export type ExperimentPhaseResult =
  | ({ readonly kind: "completed" } & ExperimentPhaseSummary)
  | ({ readonly kind: "limit"; readonly reason: ExperimentLimitReason } & ExperimentPhaseSummary)
  | { readonly kind: "stopped" };

// ---------------------------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------------------------
/** The codes of an `experiment_invalid` issue: the gate (`IssueCode` of `schema/types.ts`) plus the two codes of this phase. `invalid` is the fallback. */
export const EXPERIMENT_INVALID_CODES: readonly string[] = Object.freeze([
  "size_exceeded", "invalid_utf8", "invalid_json", "depth_exceeded", "duplicate_key", "unsafe_number", "undefined_field", "missing_field", "bad_type",
  "bad_value", "schema_violation", "unknown_target", "duplicate_local_key", "invalid",
]);
/** `code` of an `error` record. `transport_error`: design "Runner decisions" item 5. `experiment_interrupted`: tasks.md 4.4. `address_not_allowed`: R9.16. `fatal`: item 3. `runner_refused`: the Runner refused an Experiment that the Policy accepted (`policy_not_accepted`, `runner_not_healthy`). */
export const EXPERIMENT_ERROR_CODES: readonly string[] = Object.freeze(["transport_error", "experiment_interrupted", "address_not_allowed", "fatal", "runner_refused"]);
/** `phase` of an `error` record: the `phase` list of the verifier `InterruptedOutcome`, `execute` for an outcome with an Observation, `unknown` otherwise. */
export const EXPERIMENT_ERROR_PHASES: readonly string[] = Object.freeze(["not_started", "reset", "prep", "boundary", "seq", "state", "execute", "unknown"]);
/**
 * `cause` of an `error` record. `forced_stop`, `fatal_error`: verifier `RunStopCause`. `transport_error`: the detail of a `timed_out` outcome.
 * `address_not_allowed`: the abort reason (R9.16). `runner_internal_error`: the `not_executed` reason that carries `fatal`. `unknown`: anything else.
 */
export const EXPERIMENT_ERROR_CAUSES: readonly string[] = Object.freeze(["forced_stop", "fatal_error", "transport_error", "address_not_allowed", "runner_internal_error", "policy_not_accepted", "runner_not_healthy", "unknown"]);

const INTERRUPT_CAUSES: readonly string[] = ["forced_stop", "fatal_error"];
const COMPARISON_RESULTS: readonly string[] = ["match", "mismatch", "not_comparable"];
const COMPARISON_REASONS: readonly string[] = ["not_executed", "timed_out", "aborted", "prediction_missing", "observation_unparseable", "mask_config_invalid"];
const STATUSES: readonly string[] = ["executed", "timed_out", "aborted", "not_executed", "interrupted"];
const EVIDENCE_OUTCOME = { match: "supports", mismatch: "contradicts", not_comparable: "inconclusive" } as const;

const COMPONENT = "orchestrator";
const MAX_ISSUES = 20;
const MAX_POINTER_CHARS = 2048;
const MAX_POINTER_TOKENS = 16;
const IDENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const INDEX_TOKEN = /^[0-9]{1,4}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type Payload = Parameters<RecordWriter["append"]>[1];
const asPayload = (o: Record<string, Json>): Payload => o as unknown as Payload;

const STOPPED: ExperimentPhaseResult = Object.freeze({ kind: "stopped" as const });

const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= lo;
const inList = (list: readonly string[], v: unknown): v is string => typeof v === "string" && list.includes(v);

function raiseError(session: RunSession): void {
  try {
    session.raise("error");
  } catch {
    // the session never throws; nothing more can be done
  }
}
function raiseReason(session: RunSession, reason: TerminationReason): void {
  try {
    session.raise(reason);
  } catch {
    raiseError(session);
  }
}
const latchNone = (session: RunSession): boolean => session.terminationStatus().state === "none";

/** Before a new Experiment: latch `none`, Run signal not aborted, one deadline checkpoint. */
function mayStart(session: RunSession): boolean {
  if (!latchNone(session)) return false;
  if (session.signal.aborted) {
    session.attributeSymptom("interrupted");
    return false;
  }
  return deadlineCheckpoint(session) === "continue";
}

/** A plain JSON copy. Throws for a value that is not JSON (the caller's outer handler raises `error`). */
function cloneJson(v: unknown): Json {
  const text = JSON.stringify(v);
  if (typeof text !== "string") throw new Error("not JSON");
  return JSON.parse(text) as Json;
}

type Written = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
/** One write of the writer, read defensively. A throw or a malformed answer is a failure; no message is copied. */
async function write(call: () => Promise<unknown>): Promise<Written> {
  try {
    const r: unknown = await call();
    if (isObj(r) && r.ok === true) return { ok: true, value: r.value };
  } catch {
    // dropped
  }
  return { ok: false };
}
const idOf = (v: unknown): string | undefined => (isObj(v) && isStr(v.id) && v.id !== "" ? v.id : undefined);

type Emitted = { readonly ok: true; readonly id: string } | { readonly ok: false };
/**
 * One mandatory record. `guarded`: a latched cause means no write and no new raise (no new work after a cause). Not guarded: the record is a fact that
 * has already happened (the outcome of an Experiment); it is written whatever the latch says. A failed write raises `error` in both cases.
 */
async function emit(session: RunSession, writer: RecordWriter, kind: Parameters<RecordWriter["append"]>[0], payload: Payload, guarded: boolean): Promise<Emitted> {
  if (guarded && !latchNone(session)) return { ok: false };
  const w = await write(() => writer.append(kind, payload, COMPONENT));
  const id = w.ok ? idOf(w.value) : undefined;
  if (id === undefined) {
    raiseError(session);
    return { ok: false };
  }
  return { ok: true, id };
}

/** A pointer that is safe to record: only array indices and short identifier tokens survive, every other token becomes `<key>`. Bounded. */
function safeAt(raw: unknown): string {
  if (!isStr(raw) || raw === "") return "";
  if (!raw.startsWith("/")) return "<key>";
  const tokens = raw.slice(0, MAX_POINTER_CHARS).split("/").slice(1, 1 + MAX_POINTER_TOKENS);
  return `/${tokens.map((t) => (INDEX_TOKEN.test(t) || IDENT_TOKEN.test(t) ? t : "<key>")).join("/")}`;
}

interface IssueFlag {
  readonly code: string;
  readonly path: string;
}
/** The issues of a gate-rejected Experiment as `{ code, path }`: a code that is not on the closed list is `invalid`, a path is sanitized, never a message. */
function gateIssues(raw: unknown): IssueFlag[] {
  const out: IssueFlag[] = [];
  if (Array.isArray(raw)) {
    for (const i of (raw as unknown[]).slice(0, MAX_ISSUES)) {
      out.push({ code: isObj(i) && inList(EXPERIMENT_INVALID_CODES, i.code) ? i.code : "invalid", path: safeAt(isObj(i) ? i.path : "") });
    }
  }
  return out.length === 0 ? [{ code: "invalid", path: "" }] : out;
}

// ---------------------------------------------------------------------------------------------
// The phase
// ---------------------------------------------------------------------------------------------
interface ThrowState {
  has: boolean;
  thrown: unknown;
}

interface ValidExperiment {
  readonly index: number;
  readonly localKey: string;
  readonly target: { readonly kind: "claim" | "hypothesis"; readonly id: string };
  readonly testedClaimRevisionId: string | undefined;
  /** The Experiment as the gate accepted it. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export async function runExperimentPhase<TAudit, TRequest, TPolicy>(input: ExperimentPhaseInput<TAudit, TRequest, TPolicy>): Promise<ExperimentPhaseResult> {
  const state: ThrowState = { has: false, thrown: undefined };
  try {
    return await runPhase(input, state);
  } catch {
    if (state.has) throw state.thrown; // the sanctioned throw of `callProvider`, unchanged
    raiseError(input.session);
    return STOPPED;
  }
}

/** Reads the current hypothesis defensively: claim id -> claim revision id. `undefined` when it is malformed. */
function readHypothesis(h: unknown): { readonly hypothesisId: string; readonly claims: ReadonlyMap<string, string> } | undefined {
  if (!isObj(h) || !isStr(h.hypothesisId) || h.hypothesisId === "" || !Array.isArray(h.claims)) return undefined;
  const claims = new Map<string, string>();
  for (const c of h.claims as unknown[]) {
    if (!isObj(c) || !isStr(c.claimId) || c.claimId === "" || !isStr(c.claimRevisionId) || c.claimRevisionId === "") return undefined;
    claims.set(c.claimId, c.claimRevisionId);
  }
  return { hypothesisId: h.hypothesisId, claims };
}

async function runPhase<TAudit, TRequest, TPolicy>(input: ExperimentPhaseInput<TAudit, TRequest, TPolicy>, state: ThrowState): Promise<ExperimentPhaseResult> {
  const { session, writer, ids } = input;
  const lim = input.limits;
  const hypothesis = readHypothesis(input.hypothesis);
  if (
    hypothesis === undefined ||
    !isInt(input.iteration, 0) ||
    !isInt(lim.providerRetries, 0) ||
    lim.providerRetries > 10 ||
    !isInt(lim.experiments, 1) ||
    !isInt(lim.rejectedExperiments, 1)
  ) {
    raiseError(session);
    return STOPPED;
  }

  // 1
  if ((await checkLeaseBoundary(input.leasePort, session)) === "stop") return STOPPED;

  // 2. One provider call. A failed call (including the exhausted retries) is handled inside `callProvider`.
  let called: Awaited<ReturnType<typeof callProvider>>;
  try {
    called = await callProvider<TAudit, TRequest>({
      session,
      writer,
      clock: input.clock,
      timers: input.timers,
      provider: input.provider,
      audit: input.audit,
      auditConfig: input.auditConfig,
      responseGate: input.responseGate,
      responseLimits: input.responseLimits,
      validator: input.validator,
      bundle: input.bundle,
      kind: "experiment_generation",
      templateId: input.templateId,
      stored: input.stored,
      limits: { providerCallSeconds: lim.providerCallSeconds, providerRetries: lim.providerRetries },
    });
  } catch (e) {
    state.has = true;
    state.thrown = e;
    throw e;
  }
  if (called.kind !== "accepted") return STOPPED;
  if (!isStr(called.aiOutputRecordId) || called.aiOutputRecordId === "") {
    raiseError(session);
    return STOPPED;
  }
  if (!latchNone(session)) return STOPPED;
  const aiOutputRecordId = called.aiOutputRecordId;

  const res: unknown = called.result;
  if (!isObj(res) || res.ok !== true || res.kind !== "experiment_generation" || !Array.isArray(res.experiments) || !Array.isArray(res.rejectedExperiments)) {
    raiseError(session);
    return STOPPED;
  }
  const accepted = res.experiments as unknown[];
  const rejected = res.rejectedExperiments as unknown[];

  // 3. Validation pass. Original positions: a gate-rejected Experiment keeps the `index` of the gate; the accepted ones fill the other positions in order.
  const total = accepted.length + rejected.length;
  const rejectedAt = new Map<number, unknown>();
  for (const r of rejected) {
    if (!isObj(r) || !isInt(r.index, 0) || r.index >= total || rejectedAt.has(r.index)) {
      raiseError(session);
      return STOPPED;
    }
    rejectedAt.set(r.index, r.issues);
  }
  const valid: ValidExperiment[] = [];
  const seenKeys = new Set<string>();
  let nextAccepted = 0;
  for (let index = 0; index < total; index += 1) {
    let issues: IssueFlag[] | undefined;
    if (rejectedAt.has(index)) {
      issues = gateIssues(rejectedAt.get(index));
    } else {
      const raw: unknown = accepted[nextAccepted];
      nextAccepted += 1;
      const target: unknown = isObj(raw) ? raw.target : undefined;
      const localKey: unknown = isObj(raw) ? raw.localKey : undefined;
      const kind: unknown = isObj(target) ? target.kind : undefined;
      const targetId: unknown = isObj(target) ? target.id : undefined;
      if (!isObj(raw) || !isStr(localKey) || (kind !== "claim" && kind !== "hypothesis") || !isStr(targetId)) {
        raiseError(session); // the gate accepted it, so this is a defect
        return STOPPED;
      }
      const found: IssueFlag[] = [];
      if (seenKeys.has(localKey)) found.push({ code: "duplicate_local_key", path: "/localKey" });
      seenKeys.add(localKey);
      const tested: string | undefined = kind === "claim" ? hypothesis.claims.get(targetId) : undefined;
      const known = kind === "claim" ? tested !== undefined : targetId === hypothesis.hypothesisId;
      if (!known) found.push({ code: "unknown_target", path: "/target/id" });
      if (found.length === 0) {
        valid.push({ index, localKey, target: { kind, id: targetId }, testedClaimRevisionId: tested, raw });
        continue;
      }
      issues = found;
    }
    const w = await emit(session, writer, "experiment_invalid", asPayload({ requestKind: "experiment_generation", aiOutputRecordId, index, issues: issues.map((i) => ({ code: i.code, path: i.path })) }), true);
    if (!w.ok) return STOPPED;
  }

  // 4. Execution pass.
  const executed: ExecutedExperiment[] = [];
  const evidenceIds: string[] = [];
  const refs: StoredPartRef[] = [];
  let acceptedInPhase = 0;
  let rejectedInPhase = 0;
  const summary = (): ExperimentPhaseSummary =>
    Object.freeze({
      acceptedInPhase,
      rejectedInPhase,
      executed: Object.freeze(executed.map((x) => Object.freeze({ ...x, evidenceIds: Object.freeze([...x.evidenceIds]) }))),
      evidenceIdsForRevision: Object.freeze([...evidenceIds]),
      storedRefsForRevision: Object.freeze(refs.map((r) => Object.freeze({ ...r }))),
    });

  for (let i = 0; i < valid.length; i += 1) {
    const v = valid[i] as ValidExperiment;
    // a
    if (!mayStart(session)) return STOPPED;

    // b
    if (session.experimentCount >= lim.experiments) {
      for (let j = i; j < valid.length; j += 1) {
        const d = await emit(session, writer, "experiment_dropped", asPayload({ reason: "experiment_limit" }), true);
        if (!d.ok) return STOPPED;
      }
      raiseReason(session, "experiment_limit_reached");
      return Object.freeze({ kind: "limit" as const, reason: "experiment_limit_reached" as const, ...summary() });
    }

    // c
    const experimentId = ids.nextExperimentId(input.iteration);
    const aiExperiment = cloneJson(v.raw);
    const exp = await emit(
      session,
      writer,
      "experiment",
      asPayload({
        experimentId,
        iteration: input.iteration,
        localKey: v.localKey,
        target: { kind: v.target.kind, id: v.target.id },
        ...(v.testedClaimRevisionId === undefined ? {} : { testedClaimRevisionId: v.testedClaimRevisionId }),
        experiment: aiExperiment,
      }),
      true,
    );
    if (!exp.ok) return STOPPED;
    const experimentRecordId = exp.id;
    if (!latchNone(session)) return STOPPED;

    // d
    const normalized: Record<string, Json> = { experimentId };
    for (const k of Object.keys(v.raw)) if (k !== "localKey") normalized[k] = cloneJson(v.raw[k]);
    let decisionPayload: unknown;
    try {
      decisionPayload = input.policy.evaluateForRecord(normalized, input.policyConfig);
    } catch {
      raiseError(session);
      return STOPPED;
    }
    if (!isObj(decisionPayload) || decisionPayload.experimentId !== experimentId || (decisionPayload.decision !== "accept" && decisionPayload.decision !== "reject")) {
      raiseError(session);
      return STOPPED;
    }
    const decision: "accept" | "reject" = decisionPayload.decision === "accept" ? "accept" : "reject";
    const pd = await emit(session, writer, "policy_decision", asPayload(cloneJson(decisionPayload) as Record<string, Json>), true);
    if (!pd.ok) return STOPPED;
    try {
      await writer.drain();
    } catch {
      raiseError(session);
      return STOPPED;
    }
    if (!latchNone(session)) return STOPPED;

    // e
    if (decision === "reject") {
      rejectedInPhase += 1;
      session.noteRejectedExperiment();
      if (session.policyRejectionCount >= lim.rejectedExperiments) {
        raiseReason(session, "policy_rejection_limit");
        return Object.freeze({ kind: "limit" as const, reason: "policy_rejection_limit" as const, ...summary() });
      }
      continue;
    }

    // f
    acceptedInPhase += 1;
    session.noteAcceptedExperiment();
    let outcome: unknown;
    try {
      outcome = await input.runner.execute(normalized, pd.id, session.signal, { notAfterMs: session.deadlineAtMs });
    } catch {
      raiseError(session);
      return STOPPED;
    }

    // 5
    const done = await recordOutcome(input, v, experimentId, experimentRecordId, normalized, outcome, evidenceIds, executed, refs);
    if (done === "stop") return STOPPED; // the records of that Experiment are already written; the latched cause carries the reason
  }

  // 6
  if (acceptedInPhase === 0) {
    raiseReason(session, "no_further_experiments");
    return Object.freeze({ kind: "limit" as const, reason: "no_further_experiments" as const, ...summary() });
  }
  return Object.freeze({ kind: "completed" as const, ...summary() });
}

// ---------------------------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------------------------
interface Attribution {
  /** The termination reason to raise, if any. */
  readonly raise?: TerminationReason;
  /** The `error` record to write, if any. */
  readonly errorRecord?: { readonly code: string; readonly phase: string; readonly cause: string };
  /** true: no further Experiment. */
  readonly stop: boolean;
}

const CONTINUE: Attribution = Object.freeze({ stop: false });

/** The lease hint of an outcome: the termination reason, from the closed hints only. */
function leaseHint(o: Record<string, unknown>): TerminationReason | undefined {
  if (o.terminationReason === "launcher_killed" || o.terminationReason === "lease_unavailable") return o.terminationReason;
  if (o.leaseReason === "heartbeat_stale") return "launcher_killed";
  if (isStr(o.leaseReason)) return "lease_unavailable";
  return undefined;
}

/** Decides what a `timed_out`, `aborted` or `not_executed` outcome means for the Run (see the header). Reads only closed values. */
function attribute(status: string, o: Record<string, unknown>): Attribution {
  const detail = isStr(o.detail) ? o.detail : undefined;
  const reason = isStr(o.reason) ? o.reason : undefined;
  if (status === "executed") return CONTINUE;
  if (status === "not_executed" && o.fatal === true) {
    return { raise: "error", stop: true, errorRecord: { code: "fatal", phase: "execute", cause: reason === "runner_internal_error" ? "runner_internal_error" : "fatal_error" } };
  }
  if ((status === "timed_out" || status === "not_executed") && detail === "run_time_limit") return { raise: "time_limit_reached", stop: true };
  const lease = leaseHint(o);
  if (lease !== undefined) return { raise: lease, stop: true };
  if (status === "aborted" && reason === "lease_unavailable") return { raise: "lease_unavailable", stop: true };
  if (status === "not_executed" && reason === "lease_unavailable") return { raise: "lease_unavailable", stop: true };
  if (reason === "address_not_allowed" && (status === "aborted" || status === "not_executed")) {
    return { raise: "error", stop: true, errorRecord: { code: "address_not_allowed", phase: "execute", cause: "address_not_allowed" } };
  }
  // A Policy decision was accepted, so a Runner that refuses it breaks the contract: error, no further Experiment.
  if (status === "not_executed" && (reason === "policy_not_accepted" || reason === "runner_not_healthy")) {
    return { raise: "error", stop: true, errorRecord: { code: "runner_refused", phase: "execute", cause: reason } };
  }
  if (status === "aborted") return { raise: "error", stop: true }; // an abort reason that is not known
  if (status === "timed_out" && detail === "transport_error") return { stop: false, errorRecord: { code: "transport_error", phase: "execute", cause: "transport_error" } };
  return CONTINUE;
}

async function recordOutcome<TAudit, TRequest, TPolicy>(
  input: ExperimentPhaseInput<TAudit, TRequest, TPolicy>,
  v: ValidExperiment,
  experimentId: string,
  experimentRecordId: string,
  normalized: Record<string, Json>,
  outcome: unknown,
  evidenceIds: string[],
  executed: ExecutedExperiment[],
  refs: StoredPartRef[],
): Promise<"continue" | "stop"> {
  const { session, writer, ids, evidenceStore } = input;
  if (!isObj(outcome) || !inList(STATUSES, outcome.status)) {
    raiseError(session);
    return "stop";
  }
  const status = outcome.status;

  // interrupted: no Observation, no comparison, no Evidence
  if (status === "interrupted") {
    const cause = inList(INTERRUPT_CAUSES, outcome.cause) && outcome.experimentId === experimentId ? outcome.cause : "unknown";
    const phase = inList(EXPERIMENT_ERROR_PHASES, outcome.phase) && outcome.phase !== "execute" ? outcome.phase : "unknown";
    const w = await emit(session, writer, "error", asPayload({ code: "experiment_interrupted", experimentId, phase, cause }), false);
    if (!w.ok) return "stop";
    if (cause === "forced_stop" && outcome.fatal !== true) session.attributeSymptom("forced_stop");
    else raiseError(session);
    return "stop";
  }

  const observation: unknown = outcome.observation;
  if (!isObj(observation) || observation.experimentId !== experimentId || observation.outcome !== status) {
    raiseError(session);
    return "stop";
  }
  const obs = await emit(session, writer, "observation", asPayload(cloneJson(observation) as Record<string, Json>), false);
  if (!obs.ok) return "stop";

  let compared: unknown;
  try {
    compared = input.comparator.compare(normalized.prediction, observation, input.mask);
  } catch {
    raiseError(session);
    return "stop";
  }
  const result = readComparison(compared, experimentId, status);
  if (result === undefined) {
    raiseError(session);
    return "stop";
  }
  const cmp = await emit(session, writer, "comparison", asPayload(cloneJson(compared) as Record<string, Json>), false);
  if (!cmp.ok) return "stop";

  const myEvidence: string[] = [];
  if (v.target.kind === "claim" && v.testedClaimRevisionId !== undefined) {
    const evidenceId = ids.nextEvidenceId();
    const appended = evidenceStore.appendEvidence({
      component: experimentRuleComponent(result),
      record: {
        evidenceId,
        kind: "experiment",
        claimRevisionId: v.testedClaimRevisionId,
        outcome: EVIDENCE_OUTCOME[result],
        experimentId,
        comparisonRecordId: cmp.id,
        observationRecordId: obs.id,
        predictionRecordId: experimentRecordId,
      },
    });
    if (!appended.ok) {
      raiseError(session);
      return "stop";
    }
    const ev = await emit(session, writer, "evidence", asPayload(cloneJson(appended.value) as Record<string, Json>), false);
    if (!ev.ok) return "stop";
    myEvidence.push(evidenceId);
  }
  evidenceIds.push(...myEvidence);
  executed.push({ experimentId, experimentRecordId, observationRecordId: obs.id, comparisonRecordId: cmp.id, evidenceIds: myEvidence, comparisonResult: result });
  refs.push(
    { partId: `${experimentId}-experiment`, type: "experiment", recordId: experimentRecordId },
    { partId: `${experimentId}-observation`, type: "observation", recordId: obs.id },
    { partId: `${experimentId}-comparison`, type: "comparison", recordId: cmp.id },
  );

  // what the outcome means for the Run
  const a = attribute(status, outcome);
  if (a.errorRecord !== undefined) {
    const w = await emit(
      session,
      writer,
      "error",
      asPayload({
        code: inList(EXPERIMENT_ERROR_CODES, a.errorRecord.code) ? a.errorRecord.code : "fatal",
        experimentId,
        phase: inList(EXPERIMENT_ERROR_PHASES, a.errorRecord.phase) ? a.errorRecord.phase : "unknown",
        cause: inList(EXPERIMENT_ERROR_CAUSES, a.errorRecord.cause) ? a.errorRecord.cause : "unknown",
      }),
      false,
    );
    if (!w.ok) return "stop";
  }
  if (a.raise !== undefined) raiseReason(session, a.raise);
  if (a.stop) return "stop";
  return latchNone(session) ? "continue" : "stop";
}

/**
 * The comparator result, read defensively. For `timed_out`, `aborted` and `not_executed` the comparator contract (R10.8) is `not_comparable` with the
 * reason equal to the outcome; anything else is a fault. Returns the result name, or `undefined` for a malformed result.
 */
function readComparison(c: unknown, experimentId: string, status: string): "match" | "mismatch" | "not_comparable" | undefined {
  if (!isObj(c) || c.experimentId !== experimentId || !inList(COMPARISON_RESULTS, c.result)) return undefined;
  if (!Array.isArray(c.differences) || !isStr(c.maskSha256) || !SHA256_PATTERN.test(c.maskSha256)) return undefined;
  if (c.reason !== undefined && !inList(COMPARISON_REASONS, c.reason)) return undefined;
  if (c.result === "not_comparable" && c.reason === undefined) return undefined;
  if (c.result !== "not_comparable" && c.reason !== undefined) return undefined;
  if (status !== "executed" && (c.result !== "not_comparable" || c.reason !== status)) return undefined;
  return c.result as "match" | "mismatch" | "not_comparable";
}
