// Hypothesis phase of the Loop_Orchestrator: generation and revision (task 4.4, unit U6a; R4.8, R4.9, R4.10, R4.11, R4.12, R5.6, R6.4, R6.5, R6.14,
// R11.10, R11.12, R12.14, R22.2).
//
// `runHypothesisPhase` makes ONE logical phase call for the kind `hypothesis_generation` or `hypothesis_revision`. It takes its ports explicitly (no
// `LoopDeps`), receives the public `RecordWriter` only, and raises causes on the `RunSession`. It never writes a termination record, never closes
// admission and never touches the termination capability.
//
// ORDER of one call:
//    1. `checkLeaseBoundary` (latch, abort, deadline, one lease check on the same instance); a stop returns `stopped`;
//    2. the provider call LOOP over `callProvider` (U5). The total number of provider ATTEMPTS of this phase call is `providerRetries + 1`:
//         remaining = providerRetries + 1 - used      (`used` is the sum of the `attempt` numbers that U5 reported for the accepted answers)
//         remaining <= 0  ->  `provider_failure`;  otherwise U5 is called with `providerRetries: remaining - 1`.
//       RETRY ACCOUNTING. U5 calls `session.noteProviderRetry()` for its own internal retries. This phase calls it exactly ONCE for each re-call it
//       makes after a static-check failure (a retry that U5 never saw): never for the first call, never for an attempt of U5. So over the whole
//       phase `noteProviderRetry` is called (total provider attempts - 1) times. A re-call that U5 then refuses (a cause latched in between) has
//       already been counted; that is a residual, and the Run is stopping then.
//    3. the accepted result is read defensively; `ai_content_discarded` records (at most 100 fields each) from the report of the gate;
//    4. the static check: declarations, every expression of every claim, and the mapping of the claims (`localKey`, `revises`). Any issue rejects
//       the whole hypothesis: ONE `ai_rejected` record with closed codes and sanitized pointers (no message, no AI string), then the loop goes on;
//    5. one `semanticSha256` per claim (the injected function; a failure is `error`, nothing is written);
//    6. one claim revision per claim from `EvidenceStore.createClaimRevision` (new claims get `clm-<nnnn>` in order of appearance, a revised claim
//       keeps its `claimId`); the discard log of that store is NOT persisted here (the gate already removed the authority-like fields);
//    7. the `hypothesis_revision` record (a `StoredHypothesis`), written once, before the records of the claims;
//    8. per claim revision: `citation_verification`, then 9. the `source` Evidence (`EvidenceStore.appendEvidence` as the CITATION_VERIFIER, and
//       the same record as an `evidence` record). Exactly one source Evidence per claim revision.
// `claim` of a stored claim revision follows the design literally: `Omit<Claim, "localKey" | "revises">`, so `confidence` and `openQuestions` stay
// inside `claim` AND are copied to `aiStated`. The stored `claim` is the content that the EvidenceStore returned for the revision.
//
// THE ONE THROW. The only exception that leaves this function is the sanctioned throw of `callProvider` (unreadable records), passed on unchanged.
// Every other failure raises `error` and returns `stopped`. No secret, approval, path, provider text or message of a port goes into a record.
import { CITATION_VERIFIER, type EvidenceStore } from "../model/evidenceStore.js";
import type { Json, Result } from "../schema/types.js";
import { deadlineCheckpoint } from "./deadline.js";
import type { IdCounters } from "./ids.js";
import { checkLeaseBoundary } from "./leaseBoundary.js";
import { callProvider } from "./providerCall.js";
import type { RecordWriter } from "./recordWriter.js";
import type { RunSession } from "./session.js";
import type { AnalysisPort, AuditPort, MonotonicClockPort, ProviderPort, ResponseGatePort, StoredPartRef, TimerPort } from "./types.js";

export interface PredecessorClaimRef {
  readonly claimId: string;
  readonly revision: number;
  readonly claimRevisionId: string;
}
export interface PredecessorRef {
  readonly hypothesisId: string;
  readonly revision: number;
  readonly claims: readonly PredecessorClaimRef[];
}

/** What the semantic hash covers: condition, effect, citations, and the threshold only when the claim has one. */
export interface SemanticHashInput {
  readonly condition: Json;
  readonly effect: Json;
  readonly citations: Json;
  readonly threshold?: Json;
}
/** Implemented by the composition root (canonical JSON and SHA-256 of ai-client). */
export type SemanticSha256Of = (v: SemanticHashInput) => Result<string, { readonly code: string }>;

interface HypothesisPhaseCommon<TAudit, TRequest> {
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
  readonly analysis: Pick<AnalysisPort, "verifyCitations" | "validateDeclarations" | "validateExpr">;
  /** One per Run, created by the composition root. */
  readonly evidenceStore: EvidenceStore;
  readonly ids: IdCounters;
  /** The lease instance that stage B proved. */
  readonly leasePort: unknown;
  readonly bundle: unknown;
  readonly templateId: string;
  readonly stored: readonly StoredPartRef[];
  readonly limits: { readonly providerCallSeconds: number; readonly providerRetries: number };
  readonly semanticSha256Of: SemanticSha256Of;
}

export type HypothesisPhaseInput<TAudit, TRequest> = HypothesisPhaseCommon<TAudit, TRequest> &
  (
    | { readonly kind: "hypothesis_generation" }
    | {
        readonly kind: "hypothesis_revision";
        readonly predecessor: PredecessorRef;
        /** Evidence ids that prompted this revision. */
        readonly promptedByEvidence: readonly string[];
      }
  );

export interface AcceptedClaimRef {
  readonly claimId: string;
  readonly claimRevisionId: string;
  readonly revision: number;
}
export type HypothesisPhaseResult =
  | {
      readonly kind: "accepted";
      readonly hypothesisRevisionRecordId: string;
      readonly hypothesisId: string;
      readonly revision: number;
      readonly claims: readonly AcceptedClaimRef[];
      /** The sum of the provider attempts that this phase call used. */
      readonly attemptsUsed: number;
      /** true when every citation of every claim revision was verified. */
      readonly citationsAllVerified: boolean;
    }
  | { readonly kind: "stopped" };

// ---------------------------------------------------------------------------------------------
// Closed vocabularies
// ---------------------------------------------------------------------------------------------
/** The closed list of the analyzer `ExprIssueCode` (a copy: the orchestrator does not import the analyzer). */
const EXPR_ISSUE_CODES: readonly string[] = [
  "not_object", "missing_field", "unknown_field", "bad_type", "bad_value", "bad_path", "unknown_operator", "arity", "string_too_long", "node_limit",
  "depth_limit", "unknown_reference", "elem_outside_aggregate", "nested_aggregate", "too_many_declarations", "bad_name", "duplicate_name", "duplicate_key",
];
const MAPPING_CODES: readonly string[] = ["duplicate_local_key", "unknown_revises", "duplicate_revises"];
const ALLOWED_ISSUE_CODES: readonly string[] = [...EXPR_ISSUE_CODES, ...MAPPING_CODES];
const CITATION_REASONS: readonly string[] = ["malformed_citation", "file_not_in_bundle", "range_out_of_bounds", "quote_not_found", "source_unavailable"];
const CONFIDENCES: readonly string[] = ["low", "medium", "high"];

const COMPONENT = "orchestrator";
const MAX_ISSUES = 20;
const MAX_DISCARDED_PER_RECORD = 100;
const MAX_POINTER_CHARS = 2048;
const MAX_POINTER_TOKENS = 16;
const IDENT_TOKEN = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const INDEX_TOKEN = /^[0-9]{1,4}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

type Payload = Parameters<RecordWriter["append"]>[1];
const asPayload = (o: Record<string, Json>): Payload => o as unknown as Payload;

const STOPPED: HypothesisPhaseResult = Object.freeze({ kind: "stopped" as const });

const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isInt = (v: unknown, lo: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= lo;

function raiseError(session: RunSession): void {
  try {
    session.raise("error");
  } catch {
    // the session never throws; nothing more can be done
  }
}
const latchNone = (session: RunSession): boolean => session.terminationStatus().state === "none";

/** Before a re-call of the provider: latch `none`, Run signal not aborted, one deadline checkpoint. */
function mayCall(session: RunSession): boolean {
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

/**
 * One mandatory record. A latched cause means no further write and no new raise (`stop`); a failed write raises `error`. Never throws.
 */
async function emit(session: RunSession, writer: RecordWriter, kind: Parameters<RecordWriter["append"]>[0], payload: Payload): Promise<{ readonly ok: true; readonly id: string } | { readonly ok: false }> {
  if (!latchNone(session)) return { ok: false };
  const w = await write(() => writer.append(kind, payload, COMPONENT));
  const id = w.ok ? idOf(w.value) : undefined;
  if (id === undefined) {
    raiseError(session);
    return { ok: false };
  }
  return { ok: true, id };
}

// ---------------------------------------------------------------------------------------------
// Reading the accepted proposal
// ---------------------------------------------------------------------------------------------
interface ClaimView {
  readonly raw: Readonly<Record<string, unknown>>;
  readonly localKey: string;
  readonly revises: string | undefined;
  readonly citations: readonly unknown[];
  readonly confidence: string;
  readonly openQuestions: readonly unknown[];
  readonly expressions: readonly { readonly at: string; readonly expr: unknown }[];
}
interface ProposalView {
  readonly derived: readonly unknown[];
  readonly tables: readonly unknown[];
  readonly claims: readonly ClaimView[];
}

function readClaim(raw: unknown, index: number): ClaimView | undefined {
  if (!isObj(raw)) return undefined;
  const localKey: unknown = raw.localKey;
  const revises: unknown = raw.revises;
  const condition: unknown = raw.condition;
  const effect: unknown = raw.effect;
  const citations: unknown = raw.citations;
  const openQuestions: unknown = raw.openQuestions;
  const confidence: unknown = raw.confidence;
  if (!isStr(localKey) || (revises !== undefined && !isStr(revises))) return undefined;
  if (!isObj(condition) || !isObj(effect)) return undefined;
  const response: unknown = effect.response;
  if (!isObj(response)) return undefined;
  const fields: unknown = response.fields;
  if (!Array.isArray(citations) || !Array.isArray(openQuestions) || !Array.isArray(fields) || !isStr(confidence)) return undefined;
  if (!CONFIDENCES.includes(confidence)) return undefined;
  const expressions: { at: string; expr: unknown }[] = [
    { at: `/claims/${index}/condition/expression`, expr: condition.expression },
    { at: `/claims/${index}/effect/response/status`, expr: response.status },
  ];
  for (let j = 0; j < fields.length; j += 1) {
    const f: unknown = fields[j];
    if (!isObj(f)) return undefined;
    expressions.push({ at: `/claims/${index}/effect/response/fields/${j}/value`, expr: f.value });
  }
  return { raw, localKey, revises: revises as string | undefined, citations, confidence, openQuestions, expressions };
}

function readProposal(p: unknown): ProposalView | undefined {
  if (!isObj(p)) return undefined;
  const rawClaims: unknown = p.claims;
  const derived: unknown = p.derived === undefined ? [] : p.derived;
  const tables: unknown = p.tables === undefined ? [] : p.tables;
  if (!Array.isArray(rawClaims) || rawClaims.length === 0 || !Array.isArray(derived) || !Array.isArray(tables)) return undefined;
  const claims: ClaimView[] = [];
  for (let i = 0; i < rawClaims.length; i += 1) {
    const c = readClaim(rawClaims[i] as unknown, i);
    if (c === undefined) return undefined;
    claims.push(c);
  }
  return { derived, tables, claims };
}

// ---------------------------------------------------------------------------------------------
// Static check
// ---------------------------------------------------------------------------------------------
interface IssueFlag {
  readonly code: string;
  readonly at: string;
}

/**
 * A pointer that is safe to record: only array indices and short identifier tokens are kept, every other token becomes `<key>`, and the number of
 * tokens and the length are bounded. Nothing of an AI string longer than 32 characters or with other characters survives.
 */
function safeAt(raw: unknown): string {
  if (!isStr(raw) || raw === "") return "";
  if (!raw.startsWith("/")) return "<key>";
  const tokens = raw.slice(0, MAX_POINTER_CHARS).split("/").slice(1, 1 + MAX_POINTER_TOKENS);
  return `/${tokens.map((t) => (INDEX_TOKEN.test(t) || IDENT_TOKEN.test(t) ? t : "<key>")).join("/")}`;
}

/** An analyzer issue as `{ code, at }`; never the message. A code that is not on the closed list is `invalid`. */
function fromAnalysis(issue: unknown, prefix: string): IssueFlag {
  const code = isObj(issue) && isStr(issue.code) && EXPR_ISSUE_CODES.includes(issue.code) ? issue.code : "invalid";
  const at = isObj(issue) ? issue.at : "";
  return { code, at: safeAt(`${prefix}${isStr(at) ? at : ""}`) };
}

type Checked = { readonly kind: "valid" } | { readonly kind: "invalid"; readonly issues: readonly IssueFlag[] } | { readonly kind: "fault" };

function namesOf(list: unknown): string[] | undefined {
  if (!Array.isArray(list)) return undefined;
  const out: string[] = [];
  for (const item of list as unknown[]) {
    if (!isObj(item) || !isStr(item.name)) return undefined;
    out.push(item.name);
  }
  return out;
}

function staticCheck(
  proposal: ProposalView,
  predecessorClaimIds: ReadonlySet<string>,
  analysis: HypothesisPhaseCommon<unknown, unknown>["analysis"],
): Checked {
  const issues: IssueFlag[] = [];
  const full = (): boolean => issues.length >= MAX_ISSUES;
  const push = (f: IssueFlag): void => {
    if (!full()) issues.push(f);
  };

  // declarations
  let decl: unknown;
  try {
    decl = analysis.validateDeclarations(proposal.derived, proposal.tables);
  } catch {
    return { kind: "fault" };
  }
  let names: { derivedNames: string[]; tableNames: string[] } | undefined;
  if (!isObj(decl)) return { kind: "fault" };
  if (decl.ok === true) {
    const value = decl.value;
    const derivedNames = isObj(value) ? namesOf(value.derived) : undefined;
    const tableNames = isObj(value) ? namesOf(value.tables) : undefined;
    if (derivedNames === undefined || tableNames === undefined) return { kind: "fault" };
    names = { derivedNames, tableNames };
  } else if (decl.ok === false && Array.isArray(decl.error)) {
    for (const e of decl.error as unknown[]) push(fromAnalysis(e, ""));
  } else {
    return { kind: "fault" };
  }

  // claims
  const seenKeys = new Set<string>();
  const seenRevises = new Set<string>();
  for (let i = 0; i < proposal.claims.length && !full(); i += 1) {
    const claim = proposal.claims[i];
    if (claim === undefined) return { kind: "fault" };
    if (seenKeys.has(claim.localKey)) push({ code: "duplicate_local_key", at: safeAt(`/claims/${i}/localKey`) });
    seenKeys.add(claim.localKey);
    if (claim.revises !== undefined) {
      if (!predecessorClaimIds.has(claim.revises)) push({ code: "unknown_revises", at: safeAt(`/claims/${i}/revises`) });
      else if (seenRevises.has(claim.revises)) push({ code: "duplicate_revises", at: safeAt(`/claims/${i}/revises`) });
      seenRevises.add(claim.revises);
    }
    if (names === undefined) continue; // the declared names are unknown, so an expression cannot be checked
    for (const e of claim.expressions) {
      if (full()) break;
      let res: unknown;
      try {
        res = analysis.validateExpr(e.expr, { derivedNames: names.derivedNames, tableNames: names.tableNames });
      } catch {
        return { kind: "fault" };
      }
      if (!isObj(res)) return { kind: "fault" };
      if (res.ok === true) continue;
      if (res.ok !== false || !Array.isArray(res.error)) return { kind: "fault" };
      for (const issue of res.error as unknown[]) push(fromAnalysis(issue, e.at));
    }
  }
  return issues.length === 0 ? { kind: "valid" } : { kind: "invalid", issues };
}

// ---------------------------------------------------------------------------------------------
// The phase
// ---------------------------------------------------------------------------------------------
interface ThrowState {
  has: boolean;
  thrown: unknown;
}

interface ClaimPlan {
  readonly view: ClaimView;
  readonly claimId: string;
  readonly predecessorRevision: number | undefined;
  readonly semanticSha256: string;
}

export async function runHypothesisPhase<TAudit, TRequest>(input: HypothesisPhaseInput<TAudit, TRequest>): Promise<HypothesisPhaseResult> {
  const state: ThrowState = { has: false, thrown: undefined };
  try {
    return await runPhase(input, state);
  } catch {
    if (state.has) throw state.thrown; // the sanctioned throw of `callProvider`, unchanged
    try {
      input.session.raise("error");
    } catch {
      // nothing more can be done
    }
    return STOPPED;
  }
}

async function runPhase<TAudit, TRequest>(input: HypothesisPhaseInput<TAudit, TRequest>, state: ThrowState): Promise<HypothesisPhaseResult> {
  const { session, writer, ids, evidenceStore } = input;
  const predecessor: PredecessorRef | undefined = input.kind === "hypothesis_revision" ? input.predecessor : undefined;
  const promptedByEvidence: readonly string[] = input.kind === "hypothesis_revision" ? input.promptedByEvidence : [];
  const retries = input.limits.providerRetries;
  if (!isInt(retries, 0) || retries > 10) {
    raiseError(session);
    return STOPPED;
  }
  const predecessorClaims = new Map<string, PredecessorClaimRef>();
  for (const c of predecessor?.claims ?? []) predecessorClaims.set(c.claimId, c);

  // 1
  if ((await checkLeaseBoundary(input.leasePort, session)) === "stop") return STOPPED;

  // 2 to 4: the provider call loop
  let used = 0;
  let firstCall = true;
  let proposal: ProposalView | undefined;
  let aiOutputRecordId = "";
  for (;;) {
    const remaining = retries + 1 - used;
    if (remaining <= 0) {
      session.raise("provider_failure");
      return STOPPED;
    }
    if (!firstCall) {
      if (!mayCall(session)) return STOPPED;
      session.noteProviderRetry(); // a re-call that U5 never saw
    }
    firstCall = false;
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
        kind: input.kind,
        templateId: input.templateId,
        stored: input.stored,
        limits: { providerCallSeconds: input.limits.providerCallSeconds, providerRetries: remaining - 1 },
      });
    } catch (e) {
      state.has = true;
      state.thrown = e;
      throw e;
    }
    if (called.kind !== "accepted") return STOPPED;
    if (!isInt(called.attempt, 1) || !isStr(called.aiOutputRecordId) || called.aiOutputRecordId === "") {
      raiseError(session);
      return STOPPED;
    }
    used += called.attempt;
    if (!latchNone(session)) return STOPPED;

    // 3
    const res: unknown = called.result;
    if (!isObj(res) || res.ok !== true || res.kind !== input.kind || !Array.isArray(res.discarded)) {
      raiseError(session);
      return STOPPED;
    }
    const fields: { path: string; name: string }[] = [];
    for (const d of res.discarded as unknown[]) {
      if (!isObj(d) || !isStr(d.path) || d.path.length > 256 || !isStr(d.name) || d.name.length < 1 || d.name.length > 128) {
        raiseError(session);
        return STOPPED;
      }
      fields.push({ path: d.path, name: d.name });
    }
    for (let at = 0; at < fields.length; at += MAX_DISCARDED_PER_RECORD) {
      const part = fields.slice(at, at + MAX_DISCARDED_PER_RECORD);
      const w = await emit(session, writer, "ai_content_discarded", asPayload({ aiOutputRecordId: called.aiOutputRecordId, fields: part.map((f) => ({ path: f.path, name: f.name })) }));
      if (!w.ok) return STOPPED;
    }

    // 4
    const view = readProposal(res.proposal);
    if (view === undefined) {
      raiseError(session);
      return STOPPED;
    }
    const checked = staticCheck(view, new Set(predecessorClaims.keys()), input.analysis);
    if (checked.kind === "fault") {
      raiseError(session);
      return STOPPED;
    }
    if (checked.kind === "valid") {
      proposal = view;
      aiOutputRecordId = called.aiOutputRecordId;
      break;
    }
    const rej = await emit(
      session,
      writer,
      "ai_rejected",
      asPayload({
        requestKind: input.kind,
        attempt: called.attempt,
        aiOutputRecordId: called.aiOutputRecordId,
        reason: "invalid_hypothesis",
        source: "hypothesis_check",
        issues: checked.issues.map((i) => ({ code: ALLOWED_ISSUE_CODES.includes(i.code) ? i.code : "invalid", at: i.at })),
      }),
    );
    if (!rej.ok) return STOPPED;
  }

  if (proposal === undefined) {
    raiseError(session); // unreachable: the loop ends only with a valid proposal
    return STOPPED;
  }

  // 5. One semantic hash per claim, before anything is created or written.
  const plans: ClaimPlan[] = [];
  for (const view of proposal.claims) {
    const threshold = view.raw.threshold;
    const hashInput: SemanticHashInput = {
      condition: cloneJson(view.raw.condition),
      effect: cloneJson(view.raw.effect),
      citations: cloneJson(view.raw.citations),
      ...(threshold === undefined ? {} : { threshold: cloneJson(threshold) }),
    };
    let hashed: unknown;
    try {
      hashed = input.semanticSha256Of(hashInput);
    } catch {
      raiseError(session);
      return STOPPED;
    }
    const sha = isObj(hashed) && hashed.ok === true ? hashed.value : undefined;
    if (!isStr(sha) || !SHA256_PATTERN.test(sha)) {
      raiseError(session);
      return STOPPED;
    }
    const revised = view.revises === undefined ? undefined : predecessorClaims.get(view.revises);
    // the id of a NEW claim is taken only now, after the static check and the hashes passed, in order of appearance
    plans.push({ view, claimId: revised === undefined ? "" : revised.claimId, predecessorRevision: revised?.revision, semanticSha256: sha });
  }

  // 6. The claim revisions of the EvidenceStore.
  if (!latchNone(session)) return STOPPED;
  const stored: { claimId: string; claimRevisionId: string; revision: number; predecessorRevision: number | undefined; semanticSha256: string; claim: Json; view: ClaimView }[] = [];
  for (const plan of plans) {
    const claimId = plan.claimId === "" ? ids.nextClaimId() : plan.claimId;
    const aiClaim: { [k: string]: unknown } = {};
    for (const k of Object.keys(plan.view.raw)) if (k !== "localKey" && k !== "revises") aiClaim[k] = plan.view.raw[k];
    const made = evidenceStore.createClaimRevision({
      claimId,
      reason: plan.predecessorRevision === undefined ? "initial" : "revised",
      promptedByEvidence,
      aiClaim,
      aiOutputRecordId,
    });
    if (!made.ok) {
      raiseError(session);
      return STOPPED;
    }
    stored.push({
      claimId,
      claimRevisionId: made.value.claimRevisionId,
      revision: made.value.revision,
      predecessorRevision: plan.predecessorRevision,
      semanticSha256: plan.semanticSha256,
      claim: cloneJson(made.value.content),
      view: plan.view,
    });
  }

  // 7. The hypothesis record, once, before the records of the claims.
  const hypothesisId = ids.nextHypothesisId();
  const revision = predecessor === undefined ? 1 : predecessor.revision + 1;
  const claimEntries: Json[] = stored.map((s) => ({
    claimId: s.claimId,
    claimRevisionId: s.claimRevisionId,
    revision: s.revision,
    ...(s.predecessorRevision === undefined ? {} : { predecessorRevision: s.predecessorRevision }),
    semanticSha256: s.semanticSha256,
    claim: s.claim,
    aiStated: { confidence: s.view.confidence, openQuestions: cloneJson(s.view.openQuestions) },
    origin: "ai-inferred",
  }));
  const hypothesis = await emit(
    session,
    writer,
    "hypothesis_revision",
    asPayload({
      hypothesisId,
      revision,
      ...(predecessor === undefined ? {} : { predecessor: predecessor.hypothesisId }),
      derived: cloneJson(proposal.derived),
      tables: cloneJson(proposal.tables),
      claims: claimEntries,
      promptedByEvidence: [...promptedByEvidence],
    }),
  );
  if (!hypothesis.ok) return STOPPED;

  // 8 and 9. Per claim revision: citation_verification, then the source Evidence.
  let allVerified = true;
  for (const s of stored) {
    if (!latchNone(session)) return STOPPED;
    let verified: unknown;
    try {
      verified = input.analysis.verifyCitations(s.view.citations, input.bundle);
    } catch {
      raiseError(session);
      return STOPPED;
    }
    if (!Array.isArray(verified) || verified.length !== s.view.citations.length || verified.length < 1) {
      raiseError(session);
      return STOPPED;
    }
    const citations: { index: number; result: "verified" | "failed"; reason?: string }[] = [];
    for (let index = 0; index < verified.length; index += 1) {
      const r: unknown = verified[index];
      if (isObj(r) && r.verified === true) {
        citations.push({ index, result: "verified" });
      } else if (isObj(r) && r.verified === false && isStr(r.reason) && CITATION_REASONS.includes(r.reason)) {
        allVerified = false;
        citations.push({ index, result: "failed", reason: r.reason });
      } else {
        raiseError(session);
        return STOPPED;
      }
    }
    const cv = await emit(session, writer, "citation_verification", asPayload({ claimRevisionId: s.claimRevisionId, citations: cloneJson(citations) }));
    if (!cv.ok) return STOPPED;

    const evidenceId = ids.nextEvidenceId();
    const appended = evidenceStore.appendEvidence({
      component: CITATION_VERIFIER,
      record: { evidenceId, kind: "source", claimRevisionId: s.claimRevisionId, citationRecordId: cv.id, citations: cloneJson(citations) },
    });
    if (!appended.ok) {
      raiseError(session);
      return STOPPED;
    }
    const ev = await emit(session, writer, "evidence", asPayload(cloneJson(appended.value) as Record<string, Json>));
    if (!ev.ok) return STOPPED;
  }

  return Object.freeze({
    kind: "accepted" as const,
    hypothesisRevisionRecordId: hypothesis.id,
    hypothesisId,
    revision,
    claims: Object.freeze(stored.map((s) => Object.freeze({ claimId: s.claimId, claimRevisionId: s.claimRevisionId, revision: s.revision }))),
    attemptsUsed: used,
    citationsAllVerified: allVerified,
  });
}
