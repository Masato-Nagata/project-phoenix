// AI-call helper of the Loop_Orchestrator (task 4.4, unit U5; R2.1, R2.3, R3.8, R3.9, R4.9, R11.10, R11.12, R11.15, R12.14, R17.8).
//
// `callProvider` makes ONE logical AI call: up to `providerRetries + 1` attempts. It takes its ports explicitly (no `LoopDeps`), builds nothing
// from a clock or a platform timer of its own (it uses the injected `TimerPort` and the monotonic clock port), and holds no termination
// capability: it receives the public `RecordWriter` only and raises causes on the `RunSession`.
//
// PER ATTEMPT, in this order (any failure of a MANDATORY write raises `error` and stops: no retry after a write failure):
//    1. pre-checks: latch still `none`, the Run signal not aborted, one deadline checkpoint (`deadlineCheckpoint`, the one deadline test);
//    2. `writer.drain()`;  3. ONE `writer.records()` snapshot (if it is unavailable: `error` is raised synchronously, then the one sanctioned
//       throw of this helper);  4. every stored reference must exist in the snapshot with the matching kind and a permitted type;
//    5. `audit.prepareAudit({ ..., records })` with the SAME snapshot array;  6. `audit.auditPayload`;
//    7. the audited bytes as a blob, only when the auditor returned them;  8. the `payload_audit` record;
//    9. a `blocked` audit raises `payload_audit_blocked` (not counted, not retried);
//   10. the per-call timer, then the synchronous pre-call check, then `provider.complete` with NO await in between;
//   11. classification of what happened (see below);  12. the response bytes through `putAiOutput`;  13. the `ai_call` record;
//   14. the gate;  15. an `ai_rejected` record for a failed call;  16. the next attempt, or `provider_failure`.
//
// WHAT `ai_call` MEANS. It records that the orchestrator called `complete()` and observed an outcome (`response`, `provider_error`, `timeout`,
// `interrupted`). It does NOT prove that the inner provider did any work. A missing `ai_call` means "not called" only when every mandatory write
// succeeded (hand-over for unit U7: the writer answers `invalid_record` without going down, and a seal is not blocked by it yet; this helper
// treats every write failure, `invalid_record` included, as `error`). An `ai_call` is not written when the guard refused the request
// (`audit_violation`) and not after a timer or clock fault (an `error` is latched instead; the call may or may not have happened).
//
// THE PER-CALL TIMER. Independent of the Run deadline. `timeoutMs` handed to the provider is always `providerCallSeconds * 1000`. The timer is
// built on the injected `TimerPort` with the same robustness rules as `deadline.ts`: no count of fires; an early fire needs strict progress of
// the monotonic clock since the reading taken right before the `schedule` call that produced the wait, else `error`; a fire inside `schedule`,
// a clock that throws or returns a non-finite number, or a `schedule` that fails or returns no handle is `error` (never a timeout). Run abort,
// per-call timeout and the provider result race; the first one wins; a later provider result is ignored and never stored, recorded or gated.
// A latched cause or an aborted Run signal wins over everything else: the outcome is `interrupted`, never a failed call, never retried.
//
// RETRY COUNTER. `session.noteProviderRetry()` is called only when a next attempt will really be made. The session counter is cumulative over the
// whole Run; the limit of THIS call uses the local attempt number.
//
// NOTHING OF THE PROVIDER LEAKS: no provider `detail`, response text, payload byte, path or secret goes into a record or into an error; the
// records carry closed codes, numbers and hashes only.
import type { Result } from "../schema/types.js";
import { MIN_REARM_MS, deadlineCheckpoint } from "./deadline.js";
import type { RecordWriter } from "./recordWriter.js";
import type { RunSession } from "./session.js";
import type { AuditContextHandle, AuditPort, MonotonicClockPort, ProviderFailureView, ProviderPort, ResponseGatePort, StoredPartRef, TimerPort } from "./types.js";

/** The text of the one sanctioned throw: the same text as `startRun.ts` uses for unreadable records. */
export const RECORDS_UNAVAILABLE_MESSAGE = "run records unavailable";

export interface ProviderCallInput<TAudit, TRequest> {
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
  readonly bundle: unknown;
  readonly kind: "hypothesis_generation" | "experiment_generation" | "hypothesis_revision";
  readonly templateId: string;
  readonly stored: readonly StoredPartRef[];
  /** From `startup.config.limits`. `providerCallSeconds`: 1..600; `providerRetries`: 0..10. Anything else raises `error` and no call is made. */
  readonly limits: { readonly providerCallSeconds: number; readonly providerRetries: number };
}

/** `accepted`: the gate accepted the response (the result as it is). `stopped`: a cause is latched in the session. */
export type ProviderCallResult =
  | { readonly kind: "accepted"; readonly result: unknown; readonly aiOutputRecordId: string; readonly attempt: number }
  | { readonly kind: "stopped" };

type Payload = Parameters<RecordWriter["append"]>[1];
type Step = ProviderCallResult | { readonly kind: "retry" } | { readonly kind: "unavailable" };

const STOPPED: ProviderCallResult = Object.freeze({ kind: "stopped" as const });
const RETRY: Step = Object.freeze({ kind: "retry" as const });
const UNAVAILABLE: Step = Object.freeze({ kind: "unavailable" as const });

const REQUEST_KINDS: readonly string[] = ["hypothesis_generation", "experiment_generation", "hypothesis_revision"];
const STORED_TYPES: readonly string[] = ["hypothesis_revision", "experiment", "observation", "comparison"];
const PROVIDER_REASONS: readonly string[] = ["error", "timeout", "unmatched_request", "tool_call_detected", "undeterminable"];
const FAILED_CALL_REASONS: readonly string[] = ["error", "unparseable", "timeout"];
const VIOLATION_CODES: readonly string[] = ["not_audited", "already_used", "hash_mismatch", "state_inconsistent"];
const CLOSED_AFTER_TERMINATION: readonly string[] = ["admission_closed", "closed_after_termination"];
const MAX_ISSUES = 20;

const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const inList = (list: readonly string[], v: unknown): v is string => typeof v === "string" && list.includes(v);
const intIn = (v: unknown, lo: number, hi: number): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi;

function raiseError(session: RunSession): void {
  try {
    session.raise("error");
  } catch {
    // the session never throws; nothing more can be done
  }
}
const latchNone = (session: RunSession): boolean => session.terminationStatus().state === "none";
const failStep = (session: RunSession): Step => {
  raiseError(session);
  return STOPPED;
};

/** Before any new work: latch `none`, Run signal not aborted, one deadline checkpoint. */
function mayGo(session: RunSession): boolean {
  if (!latchNone(session)) return false;
  if (session.signal.aborted) {
    session.attributeSymptom("interrupted");
    return false;
  }
  return deadlineCheckpoint(session) === "continue";
}

type Written = { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly code: string };
/** One write of the writer, read defensively. A throw or a malformed answer is a failure; no message is copied. */
async function write(call: () => Promise<unknown>): Promise<Written> {
  try {
    const r: unknown = await call();
    if (isObj(r)) {
      if (r.ok === true) return { ok: true, value: r.value };
      if (r.ok === false) return { ok: false, code: isObj(r.error) && isStr(r.error.code) ? r.error.code : "unknown" };
    }
  } catch {
    // dropped
  }
  return { ok: false, code: "unknown" };
}
const idOf = (v: unknown): string | undefined => (isObj(v) && isStr(v.id) && v.id !== "" ? v.id : undefined);

interface AuditView {
  readonly result: "pass" | "blocked";
  readonly payloadSha256: string;
  readonly bytesWithheld: boolean;
  readonly checks: readonly { readonly id: string; readonly outcome: string; readonly detail?: string }[];
  readonly matches: readonly { readonly checkId: string; readonly matchId: string }[];
  readonly auditedBytes?: Uint8Array;
}

/** Copies only the known fields of an `AuditResult` shape; anything malformed is `undefined`. */
function readAudit(a: unknown): AuditView | undefined {
  if (!isObj(a)) return undefined;
  const rawResult = a.result;
  const result: "pass" | "blocked" | undefined = rawResult === "pass" ? "pass" : rawResult === "blocked" ? "blocked" : undefined;
  const payloadSha256 = a.payloadSha256;
  const bytesWithheld = a.bytesWithheld;
  if (result === undefined) return undefined;
  if (!isStr(payloadSha256) || typeof bytesWithheld !== "boolean") return undefined;
  if (!Array.isArray(a.checks) || !Array.isArray(a.matches)) return undefined;
  const checks: { id: string; outcome: string; detail?: string }[] = [];
  for (const c of a.checks as unknown[]) {
    if (!isObj(c) || !isStr(c.id) || !isStr(c.outcome)) return undefined;
    if (c.detail !== undefined && !isStr(c.detail)) return undefined;
    checks.push(c.detail === undefined ? { id: c.id, outcome: c.outcome } : { id: c.id, outcome: c.outcome, detail: c.detail });
  }
  const matches: { checkId: string; matchId: string }[] = [];
  for (const m of a.matches as unknown[]) {
    if (!isObj(m) || !isStr(m.checkId) || !isStr(m.matchId)) return undefined;
    matches.push({ checkId: m.checkId, matchId: m.matchId });
  }
  const base: Omit<AuditView, "auditedBytes"> = { result, payloadSha256, bytesWithheld, checks, matches };
  const bytes = a.auditedBytes;
  if (bytes === undefined) return Object.freeze(base);
  if (!(bytes instanceof Uint8Array) || bytesWithheld) return undefined;
  return Object.freeze({ ...base, auditedBytes: new Uint8Array(bytes) });
}

/** Only the closed code and the string hashes of a violation; `undefined` when the code is not on the closed list. */
function readViolation(v: unknown): { code: string; requestKind?: string; claimedSha256?: string; auditedSha256?: string; recomputedSha256?: string } | undefined {
  if (!isObj(v)) return undefined;
  const code = v.code;
  if (!inList(VIOLATION_CODES, code)) return undefined;
  return {
    code,
    ...(isStr(v.requestKind) ? { requestKind: v.requestKind } : {}),
    ...(isStr(v.claimedSha256) ? { claimedSha256: v.claimedSha256 } : {}),
    ...(isStr(v.auditedSha256) ? { auditedSha256: v.auditedSha256 } : {}),
    ...(isStr(v.recomputedSha256) ? { recomputedSha256: v.recomputedSha256 } : {}),
  };
}

type CallSettle =
  | { readonly kind: "result"; readonly result: unknown }
  | { readonly kind: "call_timeout" }
  | { readonly kind: "run_abort" }
  | { readonly kind: "fault" }
  | { readonly kind: "not_called" };

type Handle = { cancel(): void };
const isHandle = (h: unknown): h is Handle => {
  try {
    return typeof h === "object" && h !== null && typeof (h as { cancel?: unknown }).cancel === "function";
  } catch {
    return false;
  }
};

/**
 * Arms the per-call timer and the abort plumbing, runs the synchronous pre-call check, and calls the provider. NOT an `async` function: the
 * check and `provider.complete` are plain synchronous code, so no await can lie between them. Never rejects.
 */
function invokeProvider<TAudit, TRequest>(input: ProviderCallInput<TAudit, TRequest>, request: TRequest): Promise<CallSettle> {
  const { session, clock, timers, provider } = input;
  const timeoutMs = input.limits.providerCallSeconds * 1000;
  return new Promise<CallSettle>((resolve) => {
    let settled = false;
    let scheduling = false;
    let generation = 0;
    let lastReading = 0;
    let callDeadlineMs = 0;
    let handle: Handle | undefined;
    const callController = new AbortController();

    const readClock = (): number | undefined => {
      try {
        const t: unknown = clock.nowMs();
        return typeof t === "number" && Number.isFinite(t) ? t : undefined;
      } catch {
        return undefined;
      }
    };
    const abortCall = (): void => {
      try {
        callController.abort();
      } catch {
        // nothing to do
      }
    };
    const onRunAbort = (): void => {
      abortCall();
      finish({ kind: "run_abort" });
    };
    const finish = (s: CallSettle): void => {
      if (settled) return;
      settled = true;
      const h = handle;
      handle = undefined;
      if (h !== undefined) {
        try {
          h.cancel();
        } catch {
          // a throwing cancel changes nothing: `settled` makes every later fire inert
        }
      }
      try {
        session.signal.removeEventListener("abort", onRunAbort);
      } catch {
        // nothing to do
      }
      resolve(s);
    };
    const fault = (): void => {
      finish({ kind: "fault" }); // settle first: `settled` is set and the run-abort listener is removed before the raise below aborts the Run signal
      abortCall(); // the call signal is aborted as before (it used to be aborted through onRunAbort)
      raiseError(session);
    };
    const arm = (): boolean => {
      try {
        const t = readClock();
        if (t === undefined) return false;
        lastReading = t;
        generation += 1;
        const mine = generation;
        const wait = Math.max(MIN_REARM_MS, Math.ceil(callDeadlineMs - t));
        scheduling = true;
        let h: unknown;
        try {
          h = timers.schedule(wait, () => fire(mine));
        } finally {
          scheduling = false;
        }
        if (!isHandle(h)) return false;
        if (settled) {
          try {
            h.cancel();
          } catch {
            // nothing to do
          }
          return true;
        }
        if (generation === mine) handle = h;
        return true;
      } catch {
        return false;
      }
    };
    const fire = (mine: number): void => {
      try {
        if (settled || mine !== generation) return;
        if (scheduling) return fault(); // the timer fired inside `schedule`
        const t = readClock();
        if (t === undefined) return fault();
        if (t >= callDeadlineMs) {
          abortCall();
          finish({ kind: "call_timeout" });
          return;
        }
        if (!(t > lastReading)) return fault(); // an early fire without progress of the monotonic clock
        if (!arm() && !settled) fault();
      } catch {
        fault();
      }
    };

    try {
      const start = readClock();
      if (start === undefined) return fault();
      callDeadlineMs = start + timeoutMs;
      session.signal.addEventListener("abort", onRunAbort, { once: true });
      if (!arm()) return settled ? undefined : fault();
      if (settled) return undefined;
      // The synchronous pre-call check, directly followed by the call. No await, no async function, nothing in between.
      if (!latchNone(session) || session.signal.aborted || deadlineCheckpoint(session) !== "continue") {
        if (latchNone(session)) session.attributeSymptom("interrupted");
        return finish({ kind: "not_called" });
      }
      let pending: Promise<unknown>;
      try {
        pending = Promise.resolve(provider.complete(request, { timeoutMs, signal: callController.signal }));
      } catch {
        pending = Promise.resolve({ ok: false, error: { reason: "error", detail: "provider raised an exception" } });
      }
      pending.then(
        (r) => finish({ kind: "result", result: r }),
        () => finish({ kind: "result", result: { ok: false, error: { reason: "error", detail: "provider rejected" } } }),
      );
      return undefined;
    } catch {
      return fault();
    }
  });
}

type Normalized =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "failure"; readonly providerReason: string; readonly timeoutBy?: "provider" | "orchestrator"; readonly view: ProviderFailureView }
  | { readonly kind: "violation"; readonly violation: unknown };

function normalize(settle: CallSettle): Normalized {
  if (settle.kind === "call_timeout") {
    return { kind: "failure", providerReason: "timeout", timeoutBy: "orchestrator", view: { reason: "timeout", detail: "per-call limit reached" } };
  }
  const r = settle.kind === "result" ? settle.result : undefined;
  if (isObj(r) && r.ok === true && r.value instanceof Uint8Array) return { kind: "bytes", bytes: new Uint8Array(r.value) };
  if (isObj(r) && r.ok === false && isObj(r.error)) {
    if (r.error.reason === "audit_violation") return { kind: "violation", violation: r.error.violation };
    const reason = inList(PROVIDER_REASONS, r.error.reason) ? r.error.reason : "error";
    const view: ProviderFailureView = { reason, detail: isStr(r.error.detail) ? r.error.detail : "" };
    return reason === "timeout" ? { kind: "failure", providerReason: reason, timeoutBy: "provider", view } : { kind: "failure", providerReason: reason, view };
  }
  return { kind: "failure", providerReason: "undeterminable", view: { reason: "undeterminable", detail: "malformed provider result" } };
}

interface AttemptContext {
  readonly requestKind: string;
  readonly attempt: number;
  readonly payloadAuditRecordId: string;
  readonly requestSha256: string;
  readonly identity: { readonly id: string; readonly version: string; readonly model: string };
}

function aiCallBase(c: AttemptContext, outcome: string): Payload {
  return {
    requestKind: c.requestKind,
    attempt: c.attempt,
    payloadAuditRecordId: c.payloadAuditRecordId,
    provider: { id: c.identity.id, version: c.identity.version, model: c.identity.model },
    requestSha256: c.requestSha256,
    outcome,
  };
}

/** An audit violation: `error` is raised first (no window for another cause), then the `error` record is written best effort. */
async function stopOnViolation(session: RunSession, writer: RecordWriter, c: AttemptContext, violation: unknown): Promise<Step> {
  session.raise("error");
  const v = readViolation(violation);
  if (v !== undefined) {
    await write(() =>
      writer.append("error", { code: "audit_violation", requestKind: c.requestKind, attempt: c.attempt, payloadAuditRecordId: c.payloadAuditRecordId, violation: v }),
    );
  }
  return STOPPED;
}

async function runAttempt<TAudit, TRequest>(input: ProviderCallInput<TAudit, TRequest>, attempt: number, maxAttempts: number, identity: AttemptContext["identity"]): Promise<Step> {
  const { session, writer, audit, kind } = input;
  // 1 and 2
  if (!mayGo(session)) return STOPPED;
  await writer.drain();
  if (!mayGo(session)) return STOPPED;

  // 3. No await between the read of the snapshot and the raise.
  const snap = writer.records();
  if (snap.ok === false) {
    session.raise("error");
    return UNAVAILABLE;
  }
  const records = snap.value;
  const recordsShape: unknown = records;
  if (!Array.isArray(recordsShape)) return failStep(session);

  // 4
  for (const ref of input.stored) {
    if (!isObj(ref) || !isStr(ref.partId) || !isStr(ref.recordId) || !inList(STORED_TYPES, ref.type)) return failStep(session);
    const entry = records.find((r) => r.id === ref.recordId);
    if (entry === undefined || entry.kind !== ref.type) return failStep(session);
  }

  // 5. The SAME array reference goes to the port.
  let prepared: unknown;
  try {
    prepared = audit.prepareAudit({ bundle: input.bundle, kind, templateId: input.templateId, stored: input.stored, records });
  } catch {
    return failStep(session);
  }
  const pv = isObj(prepared) && prepared.ok === true && isObj(prepared.value) ? prepared.value : undefined;
  const auditedInput = pv === undefined ? undefined : pv.bytes;
  if (pv === undefined || !(auditedInput instanceof Uint8Array) || pv.ctx === undefined) return failStep(session);

  // 6
  let out: unknown;
  try {
    out = audit.auditPayload(auditedInput, kind, input.auditConfig, pv.ctx as AuditContextHandle);
  } catch {
    return failStep(session);
  }
  const auditView = isObj(out) ? readAudit(out.audit) : undefined;
  if (auditView === undefined) return failStep(session);
  const request = isObj(out) ? (out.request as TRequest | undefined) : undefined;
  if (auditView.result === "pass" && request === undefined) return failStep(session);

  // 7
  let blob: { blob: string; bytes: number } | undefined;
  if (auditView.auditedBytes !== undefined) {
    const b = auditView.auditedBytes;
    const w = await write(() => writer.putBlob(b));
    if (!w.ok || !isObj(w.value) || !isStr(w.value.blob) || typeof w.value.bytes !== "number") return failStep(session);
    blob = { blob: w.value.blob, bytes: w.value.bytes };
    if (!mayGo(session)) return STOPPED;
  }

  // 8
  const audited = auditView;
  const pa = await write(() =>
    writer.append("payload_audit", {
      requestKind: kind,
      attempt,
      result: audited.result,
      payloadSha256: audited.payloadSha256,
      bytesWithheld: audited.bytesWithheld,
      checks: audited.checks.map((c) => (c.detail === undefined ? { id: c.id, outcome: c.outcome } : { id: c.id, outcome: c.outcome, detail: c.detail })),
      matches: audited.matches.map((m) => ({ checkId: m.checkId, matchId: m.matchId })),
      ...(blob === undefined ? {} : { blob: { blob: blob.blob, bytes: blob.bytes } }),
    }),
  );
  const payloadAuditRecordId = pa.ok ? idOf(pa.value) : undefined;
  if (payloadAuditRecordId === undefined) return failStep(session);

  // 9
  if (auditView.result === "blocked") {
    session.raise("payload_audit_blocked");
    return STOPPED;
  }
  if (request === undefined) return failStep(session);
  const ctx: AttemptContext = { requestKind: kind, attempt, payloadAuditRecordId, requestSha256: auditView.payloadSha256, identity };

  // 10
  const settle = await invokeProvider(input, request);

  // 11
  if (settle.kind === "fault" || settle.kind === "not_called") return STOPPED;
  if (settle.kind === "run_abort" || !latchNone(session) || session.signal.aborted) {
    session.attributeSymptom("interrupted");
    const w = await write(() => writer.append("ai_call", aiCallBase(ctx, "interrupted")));
    if (!w.ok && !CLOSED_AFTER_TERMINATION.includes(w.code)) raiseError(session);
    return STOPPED;
  }
  const norm = normalize(settle);
  if (norm.kind === "violation") return stopOnViolation(session, writer, ctx, norm.violation);

  // 12
  let stored: { responseSha256: string; responseBytes: number; aiOutputRecordId: string } | undefined;
  if (norm.kind === "bytes") {
    const bytes = norm.bytes;
    const w = await write(() => writer.putAiOutput(bytes));
    const rid = w.ok && isObj(w.value) ? idOf(w.value.record) : undefined;
    const bl = w.ok && isObj(w.value) && isObj(w.value.blob) ? w.value.blob : undefined;
    if (rid === undefined || bl === undefined || !isStr(bl.blob) || typeof bl.bytes !== "number") return failStep(session);
    stored = { responseSha256: bl.blob, responseBytes: bl.bytes, aiOutputRecordId: rid };
  }

  // 13
  let callPayload: Payload;
  if (norm.kind === "bytes" && stored !== undefined) {
    callPayload = { ...aiCallBase(ctx, "response"), responseSha256: stored.responseSha256, responseBytes: stored.responseBytes, aiOutputRecordId: stored.aiOutputRecordId };
  } else if (norm.kind === "failure" && norm.timeoutBy !== undefined) {
    callPayload = { ...aiCallBase(ctx, "timeout"), timeoutBy: norm.timeoutBy };
  } else if (norm.kind === "failure") {
    callPayload = { ...aiCallBase(ctx, "provider_error"), providerReason: norm.providerReason };
  } else {
    return failStep(session);
  }
  const ac = await write(() => writer.append("ai_call", callPayload));
  const aiCallRecordId = ac.ok ? idOf(ac.value) : undefined;
  if (aiCallRecordId === undefined) return failStep(session);
  if (!mayGo(session)) return STOPPED;

  // 14
  let gated: unknown;
  try {
    const gateInput: Result<Uint8Array, ProviderFailureView> = norm.kind === "bytes" ? { ok: true, value: norm.bytes } : { ok: false, error: norm.view };
    gated = input.responseGate.gateProviderResult(kind, gateInput, input.responseLimits, input.validator);
  } catch {
    return failStep(session);
  }
  if (!isObj(gated)) return failStep(session);
  if (gated.kind === "accepted") {
    if (stored === undefined) return failStep(session);
    return Object.freeze({ kind: "accepted" as const, result: gated.result, aiOutputRecordId: stored.aiOutputRecordId, attempt });
  }
  if (gated.kind === "audit_violation") return stopOnViolation(session, writer, ctx, gated.violation);
  if (gated.kind !== "failed_call" || !inList(FAILED_CALL_REASONS, gated.reason) || !inList(["provider", "gate"], gated.source) || typeof gated.toolCall !== "boolean") {
    return failStep(session);
  }

  // 15
  const orchestratorTimeout = norm.kind === "failure" && norm.timeoutBy === "orchestrator";
  const g = isObj(gated.gate) ? gated.gate : undefined;
  let gateRec: Payload | undefined;
  if (g !== undefined) {
    if (!isStr(g.reason) || !Array.isArray(g.issues) || typeof g.toolCallLike !== "boolean" || !isStr(g.sha256) || typeof g.byteLength !== "number") return failStep(session);
    const issues: { code: string; path: string }[] = [];
    for (const i of (g.issues as unknown[]).slice(0, MAX_ISSUES)) {
      if (!isObj(i) || !isStr(i.code) || !isStr(i.path)) return failStep(session);
      issues.push({ code: i.code, path: i.path });
    }
    const lim = isObj(g.limit) && isStr(g.limit.name) && typeof g.limit.limit === "number" && typeof g.limit.observed === "number" ? g.limit : undefined;
    gateRec = {
      reason: String(g.reason),
      ...(lim === undefined ? {} : { limit: { name: String(lim.name), limit: Number(lim.limit), observed: Number(lim.observed) } }),
      issues,
      toolCallLike: g.toolCallLike === true,
      sha256: String(g.sha256),
      byteLength: Number(g.byteLength),
    };
  }
  const rejected: Payload = {
    requestKind: kind,
    attempt,
    aiCallRecordId,
    reason: gated.reason as string,
    source: orchestratorTimeout ? "orchestrator" : (gated.source as string),
    toolCall: gated.toolCall === true,
    ...(inList(PROVIDER_REASONS, gated.providerReason) ? { providerReason: String(gated.providerReason) } : {}),
    ...(gateRec === undefined ? {} : { gate: gateRec }),
  };
  const rj = await write(() => writer.append("ai_rejected", rejected));
  if (!rj.ok) return failStep(session);

  // 16
  if (!latchNone(session)) return STOPPED;
  if (attempt < maxAttempts) {
    session.noteProviderRetry();
    return RETRY;
  }
  session.raise("provider_failure");
  return STOPPED;
}

/** Never rejects, except for the one sanctioned throw: unreadable records (`error` is raised first, synchronously). */
export async function callProvider<TAudit, TRequest>(input: ProviderCallInput<TAudit, TRequest>): Promise<ProviderCallResult> {
  let outcome: ProviderCallResult | "unavailable";
  try {
    const valid =
      isObj(input) &&
      isObj(input.session) &&
      isObj(input.writer) &&
      isObj(input.clock) &&
      isObj(input.timers) &&
      isObj(input.provider) &&
      isObj(input.audit) &&
      isObj(input.responseGate) &&
      inList(REQUEST_KINDS, input.kind) &&
      isStr(input.templateId) &&
      Array.isArray(input.stored) &&
      isObj(input.limits) &&
      intIn(input.limits.providerCallSeconds, 1, 600) &&
      intIn(input.limits.providerRetries, 0, 10);
    const id: unknown = valid ? input.provider.identity : undefined;
    if (!valid || !isObj(id) || !isStr(id.id) || !isStr(id.version) || !isStr(id.model)) {
      raiseError(input.session);
      return STOPPED;
    }
    const identity = { id: id.id, version: id.version, model: id.model };
    const maxAttempts = input.limits.providerRetries + 1;
    outcome = STOPPED;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const step = await runAttempt(input, attempt, maxAttempts, identity);
      if (step.kind === "retry") continue;
      outcome = step.kind === "unavailable" ? "unavailable" : step;
      break;
    }
  } catch {
    try {
      raiseError(input.session);
    } catch {
      // nothing more can be done
    }
    outcome = STOPPED;
  }
  if (outcome === "unavailable") throw new Error(RECORDS_UNAVAILABLE_MESSAGE);
  return outcome;
}
