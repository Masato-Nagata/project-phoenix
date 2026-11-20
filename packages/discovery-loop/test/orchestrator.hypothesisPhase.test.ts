// Task 4.4, unit U6a: the hypothesis phase (`src/orchestrator/hypothesisPhase.ts`). Deterministic and offline: the REAL RunSession, the REAL
// `callProvider` (U5), the REAL EvidenceStore and the REAL id counters, on a fixed monotonic clock, with in-memory fakes of the writer, the audit port,
// the provider, the response gate, the analysis functions and the lease. Nothing waits on real time; all data is synthetic.
// **Validates: Requirements 4.8, 4.9, 4.10, 4.11, 4.12, 5.6, 6.4, 6.5, 6.14, 11.10, 11.12, 12.14, 22.2**
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CITATION_VERIFIER, EvidenceStore } from "../src/model/evidenceStore.js";
import * as phaseModule from "../src/orchestrator/hypothesisPhase.js";
import { runHypothesisPhase } from "../src/orchestrator/hypothesisPhase.js";
import { createIdCounters, type IdCounters } from "../src/orchestrator/ids.js";
import { RECORDS_UNAVAILABLE_MESSAGE } from "../src/orchestrator/providerCall.js";
import type { RecordWriter } from "../src/orchestrator/recordWriter.js";
import { createRunSession } from "../src/orchestrator/session.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const SHA = "a".repeat(64);
const MSG_SECRET = "MSG_SECRET_sk-live-0123456789";
const PATH_SECRET = "/home/SECRET_PATH_user/project/file.txt";
const APPROVAL_MARKER = "APPROVAL_MARKER_xyz";
const AI_MARKER = "AI_STRING_MARKER_" + "z".repeat(40);

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

// ---------------------------------------------------------------------------------------------------------------------------------
// Proposal builders
// ---------------------------------------------------------------------------------------------------------------------------------
const lit = (value: number | string | boolean | null): Loose => ({ op: "lit", value });
function claim(key: string, over: Loose = {}): Loose {
  return {
    localKey: key,
    condition: { description: "condition text", expression: lit(true) },
    effect: { description: "effect text", response: { status: lit(200), fields: [{ path: "a", value: lit(1) }] } },
    confidence: "low",
    openQuestions: ["q1"],
    citations: [{ file: "f.php", startLine: 1, endLine: 2, quote: "x" }],
    ...over,
  };
}
const proposalOf = (claims: Loose[], extra: Loose = {}): Loose => ({ claims, ...extra });
const OK: Loose = { proposal: proposalOf([claim("alpha")]) };
const badExpr = (issues: Loose[]): Loose => ({ op: "bad", issues });
const INVALID = (issues: Loose[] = [{ code: "unknown_reference", at: "/args/0", message: MSG_SECRET }]): Loose => ({
  proposal: proposalOf([claim("alpha", { condition: { description: "d", expression: badExpr(issues) } })]),
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------------------------------------------------------------
interface Opts {
  readonly retries?: number;
  readonly script?: Loose[]; // per gate call: "fail" or { proposal, discarded? }
  readonly kind?: "hypothesis_generation" | "hypothesis_revision";
  readonly predecessor?: Loose;
  readonly promptedByEvidence?: string[];
  readonly setup?: (ctx: { ids: IdCounters; store: EvidenceStore }) => void;
  readonly failAt?: (key: string, nth: number) => string | undefined;
  readonly onAppend?: (kind: string) => void;
  readonly lease?: () => Loose;
  readonly semantic?: (v: Loose, n: number) => Loose;
  readonly verify?: (cs: Loose[], bundle: Loose) => Loose;
  readonly audit?: (n: number) => Loose;
  readonly recordsUnavailable?: boolean;
  readonly bundle?: Loose;
}

function harness(o: Opts = {}) {
  const log: string[] = [];
  const clock = { t: 1_000, nowMs(): number { return this.t; } };
  const made = createRunSession({ clock, runSeconds: 3600 });
  if (!made.ok) throw new Error("setup failed");
  const session = made.value;
  const store = new EvidenceStore();
  const ids = createIdCounters();
  o.setup?.({ ids, store });

  const recs: { id: string; kind: string; payload: Loose }[] = [];
  const counts = new Map<string, number>();
  let seq = 0;
  const nextId = (): string => `rec-${String(++seq).padStart(6, "0")}`;
  const failFor = (key: string): string | undefined => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return o.failAt?.(key, n);
  };
  const writer = {
    append: async (kind: string, payload: Loose): Promise<Loose> => {
      log.push(`append:${kind}`);
      o.onAppend?.(kind);
      const c = failFor(`append:${kind}`);
      if (c !== undefined) return { ok: false, error: { code: c } };
      const r = { id: nextId(), kind, payload: JSON.parse(JSON.stringify(payload)) };
      recs.push(r);
      return { ok: true, value: { id: r.id, kind } };
    },
    putBlob: async (data: Uint8Array): Promise<Loose> => ({ ok: true, value: { blob: "blob-1", bytes: data.length } }),
    putAiOutput: async (data: Uint8Array): Promise<Loose> => {
      const r = { id: nextId(), kind: "ai_output", payload: {} };
      recs.push(r);
      return { ok: true, value: { record: { id: r.id }, blob: { blob: `out-${recs.length}`, bytes: data.length } } };
    },
    drain: async (): Promise<void> => undefined,
    state: () => ({ down: false, sealed: false, terminationWritten: false, secretRejections: 0 }),
    records: (): Loose => {
      if (o.recordsUnavailable === true) return { ok: false, error: { code: "records_unavailable" } };
      return { ok: true, value: Object.freeze(recs.map((r) => Object.freeze({ id: r.id, kind: r.kind, payload: r.payload }))) };
    },
  } as Loose as RecordWriter;

  const audit = {
    prepareAudit: (): Loose => ({ ok: true, value: { bytes: new Uint8Array([1, 2, 3]), ctx: { handle: true } } }),
    auditPayload: (): Loose => {
      const n = completeCalls.length + 1;
      if (o.audit !== undefined) return o.audit(n);
      return {
        audit: { result: "pass", payloadSha256: SHA, bytesWithheld: false, auditedBytes: new Uint8Array([1, 2, 3]), checks: [{ id: "A01", outcome: "pass" }], matches: [] },
        request: { req: n },
      };
    },
  };
  const completeCalls: Loose[] = [];
  const provider = {
    identity: { id: "mock", version: "1", model: "not_applicable" },
    complete(req: Loose): Loose {
      log.push("complete");
      completeCalls.push(req);
      return Promise.resolve({ ok: true, value: enc("{}") });
    },
  };
  const script = o.script ?? [OK];
  let gateN = 0;
  const kind = o.kind ?? "hypothesis_generation";
  const responseGate = {
    gateProviderResult(k: string): Loose {
      gateN += 1;
      const step = script[gateN - 1] ?? script[script.length - 1];
      if (step === "fail") {
        return {
          kind: "failed_call",
          reason: "unparseable",
          retryable: true,
          source: "gate",
          gate: { reason: "invalid_json", issues: [{ code: "invalid_json", path: "" }], toolCallLike: false, sha256: SHA, byteLength: 7 },
          toolCall: false,
        };
      }
      return { kind: "accepted", result: { ok: true, kind: k, sha256: SHA, byteLength: 7, proposal: step.proposal, discarded: step.discarded ?? [] } };
    },
    gateResponse: (): Loose => undefined,
    resolveResponseLimits: (): Loose => ({ ok: true, value: {} }),
  };

  const analysisCalls = { decl: [] as Loose[], expr: [] as Loose[], cit: [] as Loose[] };
  const analysis = {
    buildSourceBundle: async (): Promise<Loose> => ({ ok: true, value: {} }),
    validateDeclarations(derived: Loose, tables: Loose): Loose {
      analysisCalls.decl.push({ derived, tables });
      if (derived.some((d: Loose) => d.bad === true)) return { ok: false, error: [{ code: "bad_name", at: "/derived/0/name", message: MSG_SECRET }] };
      return { ok: true, value: { derived: derived.map((d: Loose) => ({ name: d.name, expr: d.expr })), tables } };
    },
    validateExpr(e: Loose, ctx: Loose): Loose {
      analysisCalls.expr.push({ e, ctx });
      if (isObj(e) && Array.isArray(e.issues)) return { ok: false, error: e.issues };
      return { ok: true, value: e };
    },
    verifyCitations(cs: Loose[], bundle: Loose): Loose {
      analysisCalls.cit.push({ cs, bundle });
      if (o.verify !== undefined) return o.verify(cs, bundle);
      return cs.map((c: Loose) => (c.quote === "missing" ? { verified: false, reason: "quote_not_found" } : { verified: true }));
    },
  };

  const semanticCalls: Loose[] = [];
  const semanticSha256Of = (v: Loose): Loose => {
    semanticCalls.push(v);
    if (o.semantic !== undefined) return o.semantic(v, semanticCalls.length);
    return { ok: true, value: createHash("sha256").update(JSON.stringify(v)).digest("hex") };
  };

  let leaseCalls = 0;
  const leasePort = {
    approvalLike: { approved: true, token: APPROVAL_MARKER },
    check: async (): Promise<Loose> => {
      leaseCalls += 1;
      log.push("lease");
      return o.lease !== undefined ? o.lease() : { valid: true };
    },
  };
  const timers = { schedule: (): Loose => ({ cancel: (): void => undefined }) };

  const input = {
    session,
    writer,
    clock,
    timers,
    provider,
    audit,
    auditConfig: { cfg: true },
    responseGate,
    responseLimits: { lim: 1 },
    validator: { v: 1 },
    analysis,
    evidenceStore: store,
    ids,
    leasePort,
    bundle: o.bundle ?? { b: 1 },
    templateId: "tpl-1",
    stored: [],
    limits: { providerCallSeconds: 30, providerRetries: o.retries ?? 0 },
    semanticSha256Of,
    kind,
    ...(kind === "hypothesis_revision" ? { predecessor: o.predecessor, promptedByEvidence: o.promptedByEvidence ?? [] } : {}),
  } as Loose;

  return {
    session,
    clock,
    store,
    ids,
    log,
    recs,
    completeCalls,
    analysisCalls,
    semanticCalls,
    leaseCalls: () => leaseCalls,
    run: (): Promise<Loose> => runHypothesisPhase(input),
    of: (k: string) => recs.filter((r) => r.kind === k),
    kinds: () => recs.map((r) => r.kind),
    status: () => session.terminationStatus(),
  };
}

/** A predecessor with one claim revision `clm-0001-r1` and one source Evidence `evd-1`, in the SAME store and counters the phase uses. */
function withPredecessor(ctx: { ids: IdCounters; store: EvidenceStore }): void {
  const claimId = ctx.ids.nextClaimId();
  ctx.ids.nextHypothesisId();
  const made = ctx.store.createClaimRevision({ claimId, reason: "initial", aiClaim: { confidence: "low" }, aiOutputRecordId: "rec-000900" });
  if (!made.ok) throw new Error("setup failed");
  const evidenceId = ctx.ids.nextEvidenceId();
  const ev = ctx.store.appendEvidence({
    component: CITATION_VERIFIER,
    record: { evidenceId, kind: "source", claimRevisionId: made.value.claimRevisionId, citationRecordId: "rec-000901", citations: [{ index: 0, result: "verified" }] },
  });
  if (!ev.ok) throw new Error("setup failed");
}
const PRED = { hypothesisId: "hyp-1", revision: 1, claims: [{ claimId: "clm-0001", revision: 1, claimRevisionId: "clm-0001-r1" }] };
const revisionOpts = (extra: Opts = {}): Opts => ({ kind: "hypothesis_revision", predecessor: PRED, promptedByEvidence: ["evd-1"], setup: withPredecessor, ...extra });

const TAIL_OK = ["hypothesis_revision", "citation_verification", "evidence"];
const afterCall = (h: ReturnType<typeof harness>): string[] => {
  const kinds = h.kinds();
  return kinds.slice(kinds.lastIndexOf("ai_call") + 1);
};

// ---------------------------------------------------------------------------------------------------------------------------------
describe("generation: the happy path", () => {
  it("writes the records in the fixed order and returns the accepted result", async () => {
    const h = harness({ script: [{ proposal: proposalOf([claim("alpha"), claim("beta")]) }] });
    const r = await h.run();
    expect(h.kinds()).toEqual([
      "payload_audit", "ai_output", "ai_call", "hypothesis_revision", "citation_verification", "evidence", "citation_verification", "evidence",
    ]);
    expect(r).toEqual({
      kind: "accepted",
      hypothesisRevisionRecordId: h.of("hypothesis_revision")[0]?.id,
      hypothesisId: "hyp-1",
      revision: 1,
      claims: [
        { claimId: "clm-0001", claimRevisionId: "clm-0001-r1", revision: 1 },
        { claimId: "clm-0002", claimRevisionId: "clm-0002-r1", revision: 1 },
      ],
      attemptsUsed: 1,
      citationsAllVerified: true,
    });
    expect(h.status()).toEqual({ state: "none" });
    expect(h.session.providerRetryCount).toBe(0);
  });

  it("does the lease check before the first provider call", async () => {
    const h = harness();
    await h.run();
    expect(h.leaseCalls()).toBe(1);
    expect(h.log.indexOf("lease")).toBeLessThan(h.log.indexOf("complete"));
  });

  it("the hypothesis_revision record is a StoredHypothesis; confidence and openQuestions stay in `claim` and are copied to `aiStated`", async () => {
    const c = claim("alpha", { threshold: "at least 3" });
    const h = harness({ script: [{ proposal: proposalOf([c], { derived: [{ name: "d1", expr: lit(1) }], tables: [{ name: "t1", entries: [{ key: 1, value: 2 }] }] }) }] });
    const r = await h.run();
    const { localKey: _k, ...withoutKey } = c;
    void _k;
    const rec = h.of("hypothesis_revision")[0]?.payload;
    expect(rec).toEqual({
      hypothesisId: "hyp-1",
      revision: 1,
      derived: [{ name: "d1", expr: lit(1) }],
      tables: [{ name: "t1", entries: [{ key: 1, value: 2 }] }],
      claims: [
        {
          claimId: "clm-0001",
          claimRevisionId: "clm-0001-r1",
          revision: 1,
          semanticSha256: h.semanticCalls.length === 1 ? createHash("sha256").update(JSON.stringify(h.semanticCalls[0])).digest("hex") : "",
          claim: withoutKey,
          aiStated: { confidence: "low", openQuestions: ["q1"] },
          origin: "ai-inferred",
        },
      ],
      promptedByEvidence: [],
    });
    expect("predecessor" in (rec as object)).toBe(false);
    expect("predecessorRevision" in (rec as Loose).claims[0]).toBe(false);
    expect(r.kind).toBe("accepted");
  });

  it("calls validateDeclarations with the declared arrays (empty when absent) and validateExpr on every expression with the declared names", async () => {
    const c = claim("alpha", { effect: { description: "e", response: { status: lit(200), fields: [{ path: "a", value: lit(1) }, { path: "b", value: lit(2) }] } } });
    const h = harness({ script: [{ proposal: proposalOf([c], { derived: [{ name: "d1", expr: lit(1) }], tables: [{ name: "t1", entries: [{ key: 1, value: 2 }] }] }) }] });
    await h.run();
    expect(h.analysisCalls.decl).toEqual([{ derived: [{ name: "d1", expr: lit(1) }], tables: [{ name: "t1", entries: [{ key: 1, value: 2 }] }] }]);
    expect(h.analysisCalls.expr).toHaveLength(4); // condition, status, two field values
    for (const call of h.analysisCalls.expr) expect(call.ctx).toEqual({ derivedNames: ["d1"], tableNames: ["t1"] });
    const bare = harness();
    await bare.run();
    expect(bare.analysisCalls.decl).toEqual([{ derived: [], tables: [] }]);
  });

  it("the EvidenceStore holds one ai-inferred claim revision with exactly one source Evidence; both statuses behave as designed", async () => {
    const h = harness();
    await h.run();
    expect(h.store.originOf("clm-0001-r1")).toEqual({ ok: true, value: "ai-inferred" });
    const ev = h.store.evidenceOf("clm-0001-r1", "source");
    expect(ev.ok && ev.value.length).toBe(1);
    expect(h.store.sourceStatusOf("clm-0001-r1")).toEqual({ ok: true, value: "supported" });
    expect(h.store.experimentStatusOf("clm-0001-r1")).toEqual({ ok: true, value: "absent" });
  });
});

describe("citations and source Evidence", () => {
  it("a failed citation gives failed + reason in the record and the Evidence, and citationsAllVerified is false", async () => {
    const c = claim("alpha", { citations: [{ file: "f.php", startLine: 1, endLine: 1, quote: "x" }, { file: "g.php", startLine: 1, endLine: 1, quote: "missing" }] });
    const h = harness({ script: [{ proposal: proposalOf([c]) }] });
    const r = await h.run();
    const expected = [{ index: 0, result: "verified" }, { index: 1, result: "failed", reason: "quote_not_found" }];
    expect(h.of("citation_verification")[0]?.payload).toEqual({ claimRevisionId: "clm-0001-r1", citations: expected });
    expect(h.of("evidence")[0]?.payload.citations).toEqual(expected);
    expect(r.citationsAllVerified).toBe(false);
    expect(h.store.sourceStatusOf("clm-0001-r1")).toEqual({ ok: true, value: "mixed" });
    expect(h.analysisCalls.cit[0]?.bundle).toEqual({ b: 1 });
  });

  it("the evidence record is the exact stored Evidence; it names the stored revision and the citation_verification record", async () => {
    const h = harness({ script: [{ proposal: proposalOf([claim("alpha"), claim("beta")]) }] });
    await h.run();
    const cvs = h.of("citation_verification");
    const evs = h.of("evidence");
    expect(cvs).toHaveLength(2);
    expect(evs).toHaveLength(2);
    ["clm-0001-r1", "clm-0002-r1"].forEach((id, i) => {
      expect(evs[i]?.payload).toEqual({ evidenceId: `evd-${i + 1}`, kind: "source", claimRevisionId: id, citationRecordId: cvs[i]?.id, citations: [{ index: 0, result: "verified" }] });
      const stored = h.store.evidenceOf(id, "source");
      expect(stored.ok && JSON.parse(JSON.stringify(stored.value[0]))).toEqual(evs[i]?.payload);
    });
  });

  it("a verifyCitations that throws, returns a wrong length, or an unknown reason is an error and writes no verification", async () => {
    for (const verify of [
      () => { throw new Error(MSG_SECRET); },
      () => [],
      () => "nope",
      () => [{ verified: false, reason: "made_up" }],
      () => [{ verified: "yes" }],
    ]) {
      const h = harness({ verify });
      expect((await h.run()).kind).toBe("stopped");
      expect(h.status()).toEqual({ state: "pending", reason: "error" });
      expect(afterCall(h)).toEqual(["hypothesis_revision"]);
      expect(JSON.stringify(h.recs)).not.toContain(MSG_SECRET);
    }
  });
});

describe("revision", () => {
  it("keeps the claimId through revises, numbers the revision, and keeps promptedByEvidence", async () => {
    const script = [{ proposal: proposalOf([claim("alpha", { revises: "clm-0001" }), claim("beta")]) }];
    const h = harness({ ...revisionOpts(), script });
    const r = await h.run();
    expect(r).toMatchObject({
      kind: "accepted",
      hypothesisId: "hyp-2",
      revision: 2,
      claims: [
        { claimId: "clm-0001", claimRevisionId: "clm-0001-r2", revision: 2 },
        { claimId: "clm-0002", claimRevisionId: "clm-0002-r1", revision: 1 },
      ],
    });
    const rec = h.of("hypothesis_revision")[0]?.payload;
    expect(rec).toMatchObject({ hypothesisId: "hyp-2", revision: 2, predecessor: "hyp-1", promptedByEvidence: ["evd-1"] });
    expect(rec.claims[0]).toMatchObject({ claimId: "clm-0001", claimRevisionId: "clm-0001-r2", revision: 2, predecessorRevision: 1 });
    expect("predecessorRevision" in rec.claims[1]).toBe(false);
    expect(h.of("evidence").map((e) => e.payload.evidenceId)).toEqual(["evd-2", "evd-3"]);
    const revs = h.store.revisionsOf("clm-0001");
    expect(revs.ok && revs.value.map((x) => x.claimRevisionId)).toEqual(["clm-0001-r1", "clm-0001-r2"]);
    const second = h.store.getRevision("clm-0001-r2");
    expect(second.ok && second.value.linkedEvidenceIds).toEqual(["evd-1"]);
    // nothing of the earlier revision is carried over (R6.14)
    expect(h.store.sourceStatusOf("clm-0001-r2")).toEqual({ ok: true, value: "supported" });
    const earlier = h.store.evidenceOf("clm-0001-r1", "source");
    expect(earlier.ok && earlier.value.length).toBe(1);
  });

  it("uses the request kind hypothesis_revision for the provider call and the gate", async () => {
    const h = harness({ ...revisionOpts(), script: [{ proposal: proposalOf([claim("alpha", { revises: "clm-0001" })]) }] });
    await h.run();
    expect(h.of("payload_audit")[0]?.payload.requestKind).toBe("hypothesis_revision");
  });

  it("an unknown evidence id in promptedByEvidence is an error and no hypothesis_revision is written", async () => {
    const h = harness({ ...revisionOpts({ promptedByEvidence: ["evd-77"] }), script: [{ proposal: proposalOf([claim("alpha", { revises: "clm-0001" })]) }] });
    expect((await h.run()).kind).toBe("stopped");
    expect(h.status()).toEqual({ state: "pending", reason: "error" });
    expect(h.of("hypothesis_revision")).toHaveLength(0);
  });
});

describe("static check: the whole hypothesis is rejected", () => {
  const rejectedPayload = (h: ReturnType<typeof harness>): Loose => h.of("ai_rejected")[0]?.payload;

  it("an invalid expression writes ai_rejected with exactly the fixed shape and no message", async () => {
    const h = harness({ script: [INVALID()] });
    const r = await h.run();
    expect(r.kind).toBe("stopped"); // retries 0: no re-call is allowed
    expect(h.status()).toEqual({ state: "pending", reason: "provider_failure" });
    const aiOutputId = h.of("ai_output")[0]?.id;
    expect(rejectedPayload(h)).toEqual({
      requestKind: "hypothesis_generation",
      attempt: 1,
      aiOutputRecordId: aiOutputId,
      reason: "invalid_hypothesis",
      source: "hypothesis_check",
      issues: [{ code: "unknown_reference", at: "/claims/0/condition/expression/args/0" }],
    });
    expect(JSON.stringify(h.recs)).not.toContain(MSG_SECRET);
    expect(h.of("hypothesis_revision")).toHaveLength(0);
    expect(h.of("citation_verification")).toHaveLength(0);
    expect(h.semanticCalls).toHaveLength(0);
    expect(h.store.events()).toEqual([]); // no claim revision for a rejected hypothesis
  });

  it("checks the expressions of the status and of every response field too, with their own pointers", async () => {
    const c = claim("alpha", { effect: { description: "e", response: { status: badExpr([{ code: "bad_type", at: "", message: "m" }]), fields: [{ path: "a", value: lit(1) }, { path: "b", value: badExpr([{ code: "arity", at: "/args", message: "m" }]) }] } } });
    const h = harness({ script: [{ proposal: proposalOf([c]) }] });
    await h.run();
    expect(rejectedPayload(h).issues).toEqual([
      { code: "bad_type", at: "/claims/0/effect/response/status" },
      { code: "arity", at: "/claims/0/effect/response/fields/1/value/args" },
    ]);
  });

  it("declaration issues are recorded with their own pointers; a code off the closed list is `invalid`", async () => {
    const h = harness({ script: [{ proposal: proposalOf([claim("alpha")], { derived: [{ name: "x", bad: true }] }) }] });
    await h.run();
    expect(rejectedPayload(h).issues).toEqual([{ code: "bad_name", at: "/derived/0/name" }]);
    const odd = harness({ script: [INVALID([{ code: "not_a_code " + MSG_SECRET, at: "/x", message: "m" }, "not an object"])] });
    await odd.run();
    expect(rejectedPayload(odd).issues).toEqual([
      { code: "invalid", at: "/claims/0/condition/expression/x" },
      { code: "invalid", at: "/claims/0/condition/expression" },
    ]);
    expect(JSON.stringify(odd.recs)).not.toContain(MSG_SECRET);
  });

  it("keeps at most 20 issues and sanitizes the pointer: indices and short identifiers stay, every other token becomes <key>", async () => {
    const many = Array.from({ length: 30 }, (_v, i) => ({ code: "bad_value", at: `/args/${i}`, message: MSG_SECRET }));
    const h = harness({ script: [INVALID(many)] });
    await h.run();
    expect(rejectedPayload(h).issues).toHaveLength(20);
    const odd = harness({ script: [INVALID([{ code: "bad_path", at: `/args/0/${AI_MARKER}/with space/ünï/name_1/0123456`, message: "m" }])] });
    await odd.run();
    expect(rejectedPayload(odd).issues).toEqual([{ code: "bad_path", at: "/claims/0/condition/expression/args/0/<key>/<key>/<key>/name_1/<key>" }]);
    expect(JSON.stringify(odd.recs)).not.toContain(AI_MARKER);
  });

  it("generation: any `revises` is unknown; duplicate localKey is reported; each is a rejection of the whole hypothesis", async () => {
    const h = harness({ script: [{ proposal: proposalOf([claim("alpha", { revises: "clm-0001" }), claim("alpha")]) }] });
    await h.run();
    expect(rejectedPayload(h).issues).toEqual([
      { code: "unknown_revises", at: "/claims/0/revises" },
      { code: "duplicate_local_key", at: "/claims/1/localKey" },
    ]);
    expect(h.of("hypothesis_revision")).toHaveLength(0);
  });

  it("revision: an unknown revises and a duplicate revises are reported", async () => {
    const script = [{ proposal: proposalOf([claim("a1", { revises: "clm-0009" }), claim("a2", { revises: "clm-0001" }), claim("a3", { revises: "clm-0001" })]) }];
    const h = harness({ ...revisionOpts(), script });
    await h.run();
    expect(rejectedPayload(h).issues).toEqual([
      { code: "unknown_revises", at: "/claims/0/revises" },
      { code: "duplicate_revises", at: "/claims/2/revises" },
    ]);
    expect(h.of("hypothesis_revision")).toHaveLength(0);
  });

  it("a revised claim that is valid passes the same check (control)", async () => {
    const h = harness({ ...revisionOpts(), script: [{ proposal: proposalOf([claim("a1", { revises: "clm-0001" })]) }] });
    expect((await h.run()).kind).toBe("accepted");
    expect(h.of("ai_rejected")).toHaveLength(0);
  });

  it("a rejected hypothesis consumes no claim, hypothesis or evidence id: the next valid answer gets clm-0001, hyp-1 and evd-1", async () => {
    const h = harness({ retries: 1, script: [INVALID(), OK] });
    const r = await h.run();
    expect(r).toMatchObject({ kind: "accepted", hypothesisId: "hyp-1", claims: [{ claimId: "clm-0001" }], attemptsUsed: 2 });
    expect(h.of("evidence")[0]?.payload.evidenceId).toBe("evd-1");
    expect(h.kinds()).toEqual([
      "payload_audit", "ai_output", "ai_call", "ai_rejected", "payload_audit", "ai_output", "ai_call", ...TAIL_OK,
    ]);
    expect(h.of("ai_rejected")[0]?.payload.attempt).toBe(1);
  });
});

describe("retry accounting", () => {
  it("static failure with retries 0: provider_failure after exactly one provider call", async () => {
    const h = harness({ retries: 0, script: [INVALID()] });
    expect((await h.run()).kind).toBe("stopped");
    expect(h.completeCalls).toHaveLength(1);
    expect(h.status()).toEqual({ state: "pending", reason: "provider_failure" });
    expect(h.session.providerRetryCount).toBe(0);
  });

  it("repeated static failures exhaust providerRetries + 1 provider calls, then provider_failure", async () => {
    const h = harness({ retries: 2, script: [INVALID()] });
    expect((await h.run()).kind).toBe("stopped");
    expect(h.completeCalls).toHaveLength(3);
    expect(h.of("ai_rejected")).toHaveLength(3);
    expect(h.status()).toEqual({ state: "pending", reason: "provider_failure" });
    expect(h.session.providerRetryCount).toBe(2);
  });

  it("a mix of failed calls inside U5 and static failures never uses more than providerRetries + 1 calls; noteProviderRetry == attempts - 1", async () => {
    // retries 3 (4 attempts). Gate: fail, invalid | fail, invalid. Call A uses 2 attempts (one U5 retry), call B the other 2 (one U5 retry).
    const h = harness({ retries: 3, script: ["fail", INVALID(), "fail", INVALID()] });
    expect((await h.run()).kind).toBe("stopped");
    expect(h.completeCalls).toHaveLength(4);
    expect(h.session.providerRetryCount).toBe(h.completeCalls.length - 1);
    expect(h.status()).toEqual({ state: "pending", reason: "provider_failure" });
    expect(h.of("ai_rejected").filter((r) => r.payload.source === "hypothesis_check")).toHaveLength(2);
    expect(h.of("ai_rejected").filter((r) => r.payload.source === "gate")).toHaveLength(2);
  });

  it("a failed call inside U5 followed by a valid answer: attemptsUsed is the sum, noteProviderRetry counts the U5 retry once", async () => {
    const h = harness({ retries: 1, script: ["fail", OK] });
    const r = await h.run();
    expect(r).toMatchObject({ kind: "accepted", attemptsUsed: 2 });
    expect(h.session.providerRetryCount).toBe(1);
  });

  it("U5 internal failure, then a static failure, then success: attempts 3, retries counted 2", async () => {
    const h = harness({ retries: 3, script: ["fail", INVALID(), OK] });
    const r = await h.run();
    expect(r).toMatchObject({ kind: "accepted", attemptsUsed: 3 });
    expect(h.completeCalls).toHaveLength(3);
    expect(h.session.providerRetryCount).toBe(2);
  });

  it("U5 exhausting its own attempts ends with provider_failure and no further call from the phase", async () => {
    const h = harness({ retries: 1, script: ["fail", "fail"] });
    expect((await h.run()).kind).toBe("stopped");
    expect(h.completeCalls).toHaveLength(2);
    expect(h.status()).toEqual({ state: "pending", reason: "provider_failure" });
    expect(h.session.providerRetryCount).toBe(1);
  });

  it("a stopped callProvider (blocked audit) ends the phase at once: no further call and no hypothesis record", async () => {
    const blocked = (): Loose => ({
      audit: { result: "blocked", payloadSha256: SHA, bytesWithheld: true, checks: [{ id: "A05", outcome: "fail" }], matches: [] },
    });
    const h = harness({ retries: 3, audit: blocked });
    expect((await h.run()).kind).toBe("stopped");
    expect(h.completeCalls).toHaveLength(0);
    expect(h.status()).toEqual({ state: "pending", reason: "payload_audit_blocked" });
    expect(h.kinds()).toEqual(["payload_audit"]);
  });

  it("a cause latched while the rejection is written stops the phase: no new provider call and no retry is counted", async () => {
    const h: ReturnType<typeof harness> = harness({
      retries: 3,
      script: [INVALID()],
      onAppend: (kind) => {
        if (kind === "ai_rejected") h.session.raise("time_limit_reached");
      },
    });
    expect((await h.run()).kind).toBe("stopped");
    expect(h.completeCalls).toHaveLength(1);
    expect(h.session.providerRetryCount).toBe(0);
    expect(h.status()).toEqual({ state: "pending", reason: "time_limit_reached" });
    expect(h.of("ai_rejected")).toHaveLength(1);
  });
});

describe("semanticSha256", () => {
  it("is called once per claim with exactly {condition, effect, citations} and the threshold only when present", async () => {
    const h = harness({ script: [{ proposal: proposalOf([claim("alpha"), claim("beta", { threshold: "t1" })]) }] });
    await h.run();
    expect(h.semanticCalls).toHaveLength(2);
    expect(Object.keys(h.semanticCalls[0]).sort()).toEqual(["citations", "condition", "effect"]);
    expect(Object.keys(h.semanticCalls[1]).sort()).toEqual(["citations", "condition", "effect", "threshold"]);
    expect(h.semanticCalls[1].threshold).toBe("t1");
    expect(h.semanticCalls[0].condition).toEqual({ description: "condition text", expression: lit(true) });
    const rec = h.of("hypothesis_revision")[0]?.payload;
    expect(rec.claims.map((c: Loose) => c.semanticSha256)).toEqual(h.semanticCalls.map((v) => createHash("sha256").update(JSON.stringify(v)).digest("hex")));
  });

  it.each([
    ["a failed result", () => ({ ok: false, error: { code: "x" } })],
    ["a throw", () => { throw new Error(MSG_SECRET); }],
    ["a value that is not 64 lowercase hex digits", () => ({ ok: true, value: "ABC" })],
    ["an uppercase digest", () => ({ ok: true, value: "A".repeat(64) })],
    ["a non-string value", () => ({ ok: true, value: 5 })],
    ["no result", () => undefined],
  ])("%s: error, no claim revision, no hypothesis_revision, nothing after the provider call", async (_n, semantic) => {
    const h = harness({ semantic });
    expect((await h.run()).kind).toBe("stopped");
    expect(h.status()).toEqual({ state: "pending", reason: "error" });
    expect(afterCall(h)).toEqual([]);
    expect(h.store.events()).toEqual([]);
    expect(JSON.stringify(h.recs)).not.toContain(MSG_SECRET);
  });

  it("a failure of the second claim creates no claim revision at all", async () => {
    const h = harness({ script: [{ proposal: proposalOf([claim("alpha"), claim("beta")]) }], semantic: (_v, n) => (n === 2 ? { ok: false, error: { code: "x" } } : { ok: true, value: SHA }) });
    expect((await h.run()).kind).toBe("stopped");
    expect(h.store.events()).toEqual([]);
    expect(h.of("hypothesis_revision")).toHaveLength(0);
  });
});

describe("ai_content_discarded", () => {
  const field = (i: number): Loose => ({ claimIndex: 0, path: "/claims/0", name: `f${i}`, rule: "origin" });
  it("is written once per at most 100 fields, with exactly {aiOutputRecordId, fields:[{path,name}]}, before the hypothesis", async () => {
    const h = harness({ script: [{ proposal: OK.proposal, discarded: Array.from({ length: 101 }, (_v, i) => field(i)) }] });
    await h.run();
    const recs = h.of("ai_content_discarded");
    expect(recs).toHaveLength(2);
    expect(recs[0]?.payload.fields).toHaveLength(100);
    expect(recs[1]?.payload.fields).toEqual([{ path: "/claims/0", name: "f100" }]);
    for (const r of recs) {
      expect(Object.keys(r.payload).sort()).toEqual(["aiOutputRecordId", "fields"]);
      expect(r.payload.aiOutputRecordId).toBe(h.of("ai_output")[0]?.id);
    }
    expect(afterCall(h)).toEqual(["ai_content_discarded", "ai_content_discarded", ...TAIL_OK]);
  });

  it("exactly 100 fields give one record; none give no record", async () => {
    const h = harness({ script: [{ proposal: OK.proposal, discarded: Array.from({ length: 100 }, (_v, i) => field(i)) }] });
    await h.run();
    expect(h.of("ai_content_discarded")).toHaveLength(1);
    const none = harness();
    await none.run();
    expect(none.of("ai_content_discarded")).toHaveLength(0);
  });

  it("is written before the static check, so a rejected response keeps its discard record", async () => {
    const h = harness({ script: [{ proposal: INVALID().proposal, discarded: [field(1)] }] });
    await h.run();
    expect(h.kinds().slice(-2)).toEqual(["ai_content_discarded", "ai_rejected"]);
  });

  it("a malformed report is an error", async () => {
    const h = harness({ script: [{ proposal: OK.proposal, discarded: [{ path: 5, name: "x" }] }] });
    expect((await h.run()).kind).toBe("stopped");
    expect(h.status()).toEqual({ state: "pending", reason: "error" });
    expect(afterCall(h)).toEqual([]);
  });
});

describe("a failing write stops the phase", () => {
  const cases: [string, Opts, string[]][] = [
    ["ai_content_discarded", { script: [{ proposal: OK.proposal, discarded: [{ claimIndex: 0, path: "/claims/0", name: "origin", rule: "origin" }] }] }, []],
    ["ai_rejected", { retries: 3, script: [INVALID()] }, []],
    ["hypothesis_revision", {}, []],
    ["citation_verification", {}, ["hypothesis_revision"]],
    ["evidence", {}, ["hypothesis_revision", "citation_verification"]],
  ];
  it.each(cases)("%s: error, no later record, no further provider call", async (kind, opts, expectedAfter) => {
    const h = harness({ ...opts, failAt: (key) => (key === `append:${kind}` ? "io_failure" : undefined) });
    expect((await h.run()).kind).toBe("stopped");
    expect(h.status()).toEqual({ state: "pending", reason: "error" });
    expect(afterCall(h)).toEqual(expectedAfter);
    expect(h.completeCalls).toHaveLength(1);
  });

  it("a second claim whose citation_verification fails: the first claim's records exist, nothing for the second", async () => {
    const h = harness({ script: [{ proposal: proposalOf([claim("alpha"), claim("beta")]) }], failAt: (key, nth) => (key === "append:citation_verification" && nth === 2 ? "invalid_record" : undefined) });
    expect((await h.run()).kind).toBe("stopped");
    expect(afterCall(h)).toEqual(["hypothesis_revision", "citation_verification", "evidence"]);
    expect(h.status()).toEqual({ state: "pending", reason: "error" });
  });
});

describe("nothing happens when the Run must already stop", () => {
  it("an invalid lease: no provider call and no record, with the designed reason", async () => {
    const h = harness({ lease: () => ({ valid: false, reason: "heartbeat_stale" }) });
    expect((await h.run()).kind).toBe("stopped");
    expect(h.completeCalls).toHaveLength(0);
    expect(h.recs).toHaveLength(0);
    expect(h.status()).toEqual({ state: "pending", reason: "launcher_killed" });
  });
  it("a latched cause: no lease check, no provider call, no record", async () => {
    const h = harness();
    h.session.raise("provider_failure");
    expect((await h.run()).kind).toBe("stopped");
    expect(h.leaseCalls()).toBe(0);
    expect(h.completeCalls).toHaveLength(0);
    expect(h.recs).toHaveLength(0);
  });
  it("a reached deadline: time_limit_reached, no lease check, no provider call", async () => {
    const h = harness();
    h.clock.t = 1_000 + 3600 * 1000;
    expect((await h.run()).kind).toBe("stopped");
    expect(h.leaseCalls()).toBe(0);
    expect(h.completeCalls).toHaveLength(0);
    expect(h.status()).toEqual({ state: "pending", reason: "time_limit_reached" });
  });
  it("an aborted Run signal (a raised aborting cause) stops without a call", async () => {
    const h = harness();
    h.session.raise("error");
    expect(h.session.signal.aborted).toBe(true);
    expect((await h.run()).kind).toBe("stopped");
    expect(h.completeCalls).toHaveLength(0);
  });
  it("a lease check that throws is attributed: stopped, error, no call", async () => {
    const h = harness({ lease: () => { throw new Error(MSG_SECRET); } });
    expect((await h.run()).kind).toBe("stopped");
    expect(h.completeCalls).toHaveLength(0);
    expect(h.status()).toEqual({ state: "pending", reason: "error" });
  });
  it("a limit that is not an integer from 0 to 10 raises error and calls nothing", async () => {
    const h = harness({ retries: 11 });
    expect((await h.run()).kind).toBe("stopped");
    expect(h.leaseCalls()).toBe(0);
    expect(h.status()).toEqual({ state: "pending", reason: "error" });
  });
  it("unreadable records: the sanctioned throw of callProvider passes through unchanged, after error was raised", async () => {
    const h = harness({ recordsUnavailable: true });
    await expect(h.run()).rejects.toThrow(RECORDS_UNAVAILABLE_MESSAGE);
    expect(h.status()).toEqual({ state: "pending", reason: "error" });
  });
});

describe("what a record or a result may carry", () => {
  it("no secret, approval-like object or absolute path of a port reaches any record or the result, in any scenario", async () => {
    const throwing = (): never => {
      throw new Error(MSG_SECRET + PATH_SECRET);
    };
    const scenarios: Opts[] = [
      { script: [INVALID()], retries: 1, bundle: { path: PATH_SECRET } },
      { semantic: throwing },
      { verify: throwing },
      { lease: throwing },
      { script: [{ proposal: OK.proposal, discarded: [{ claimIndex: 0, path: "/claims/0", name: "origin", rule: "origin" }] }], bundle: { path: PATH_SECRET } },
      revisionOpts({ script: [{ proposal: proposalOf([claim("alpha", { revises: "clm-0001" })]) }], bundle: { path: PATH_SECRET } }),
    ];
    for (const s of scenarios) {
      const h = harness(s);
      const r = await h.run();
      const text = JSON.stringify({ recs: h.recs, r, events: h.store.events() });
      for (const marker of [MSG_SECRET, PATH_SECRET, APPROVAL_MARKER, "approvalLike", "SECRET_PATH"]) expect(text, marker).not.toContain(marker);
    }
  });

  it("every record payload of a full run is plain JSON data (no function, no frozen port object)", async () => {
    const h = harness({ script: [{ proposal: proposalOf([claim("alpha"), claim("beta")]) }] });
    await h.run();
    expect(JSON.parse(JSON.stringify(h.recs))).toEqual(h.recs);
  });
});

describe("module surface", () => {
  it("exports exactly runHypothesisPhase at runtime", () => {
    expect(Object.keys(phaseModule)).toEqual(["runHypothesisPhase"]);
  });
});
