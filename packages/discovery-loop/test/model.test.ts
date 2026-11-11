import { describe, expect, it } from "vitest";
import * as runtime from "../src/index.js";
import {
  CITATION_VERIFIER,
  EvidenceStore,
  deriveExperimentStatus,
  deriveSourceStatus,
  experimentRuleComponent,
  type EvidenceRecord,
} from "../src/index.js";
import { readFacts } from "../src/model/index.js";
import { SCHEMAS } from "../src/schema/index.js";

const sourceRec = (id: string, rev: string, results: ("verified" | "failed")[]): EvidenceRecord => ({
  evidenceId: id,
  kind: "source",
  claimRevisionId: rev,
  citationRecordId: "rec-000010",
  citations: results.map((result, index) =>
    result === "failed" ? { index, result, reason: "quote_not_found" as const } : { index, result },
  ),
});
const expRec = (id: string, rev: string, outcome: "supports" | "contradicts" | "inconclusive"): EvidenceRecord => ({
  evidenceId: id,
  kind: "experiment",
  claimRevisionId: rev,
  outcome,
  experimentId: "exp-1",
  comparisonRecordId: "rec-000020",
  observationRecordId: "rec-000021",
  predictionRecordId: "rec-000022",
});
const ruleFor = { supports: "match", contradicts: "mismatch", inconclusive: "not_comparable" } as const;

function newStore(): { store: EvidenceStore; rev1: string } {
  const store = new EvidenceStore();
  const r = store.createClaimRevision({ claimId: "clm-1", reason: "initial", aiClaim: { effect: "x" }, aiOutputRecordId: "rec-000005" });
  if (!r.ok) throw new Error("setup");
  return { store, rev1: r.value.claimRevisionId };
}

describe("status derivation", () => {
  it("source: absent, supported, contradicted, mixed; other kinds ignored", () => {
    expect(deriveSourceStatus([])).toBe("absent");
    expect(deriveSourceStatus([sourceRec("e1", "r", ["verified", "verified"])])).toBe("supported");
    expect(deriveSourceStatus([sourceRec("e1", "r", ["failed", "failed"])])).toBe("contradicted");
    expect(deriveSourceStatus([sourceRec("e1", "r", ["verified", "failed"])])).toBe("mixed");
    expect(deriveSourceStatus([expRec("e2", "r", "contradicts")])).toBe("absent");
  });

  it("experiment: all outcome combinations, inconclusive counts as neither", () => {
    const o = ["supports", "contradicts", "inconclusive"] as const;
    const mk = (xs: readonly (typeof o)[number][]) => xs.map((x, i) => expRec(`e${i}`, "r", x));
    expect(deriveExperimentStatus([])).toBe("absent");
    expect(deriveExperimentStatus(mk(["inconclusive", "inconclusive"]))).toBe("absent");
    expect(deriveExperimentStatus(mk(["supports", "inconclusive"]))).toBe("supported");
    expect(deriveExperimentStatus(mk(["contradicts", "inconclusive"]))).toBe("contradicted");
    expect(deriveExperimentStatus(mk(["supports", "contradicts"]))).toBe("mixed");
    expect(deriveExperimentStatus(mk(["supports", "contradicts", "inconclusive"]))).toBe("mixed");
    expect(deriveExperimentStatus([sourceRec("s", "r", ["verified"])])).toBe("absent");
  });

  it("is independent of record order", () => {
    const a = [expRec("a", "r", "supports"), expRec("b", "r", "contradicts"), expRec("c", "r", "inconclusive")];
    expect(deriveExperimentStatus([...a].reverse())).toBe(deriveExperimentStatus(a));
    const s = [sourceRec("a", "r", ["verified"]), sourceRec("b", "r", ["failed"])];
    expect(deriveSourceStatus([...s].reverse())).toBe(deriveSourceStatus(s));
  });
});

describe("Claim revisions", () => {
  it("creates ai-inferred revisions with absent statuses and approval none", () => {
    const { store, rev1 } = newStore();
    expect(store.originOf(rev1)).toEqual({ ok: true, value: "ai-inferred" });
    expect(store.sourceStatusOf(rev1)).toEqual({ ok: true, value: "absent" });
    expect(store.experimentStatusOf(rev1)).toEqual({ ok: true, value: "absent" });
    const f = readFacts(store, "run-1", rev1, { approvalStatus: () => "none" });
    expect(f).toEqual({
      ok: true,
      value: { claimRevisionId: rev1, origin: "ai-inferred", sourceEvidenceStatus: "absent", experimentEvidenceStatus: "absent", approvalStatus: "none" },
    });
  });

  it("a new revision with identical content inherits nothing", () => {
    const { store, rev1 } = newStore();
    expect(store.appendEvidence({ component: CITATION_VERIFIER, record: sourceRec("ev-1", rev1, ["verified"]) }).ok).toBe(true);
    expect(store.appendEvidence({ component: experimentRuleComponent("match"), record: expRec("ev-2", rev1, "supports") }).ok).toBe(true);
    const r2 = store.createClaimRevision({
      claimId: "clm-1", reason: "re-submitted", promptedByEvidence: ["ev-1"], aiClaim: { effect: "x" }, aiOutputRecordId: "rec-000030",
    });
    if (!r2.ok) throw new Error("r2");
    expect(r2.value.claimRevisionId).not.toBe(rev1);
    expect(r2.value.predecessorRevisionId).toBe(rev1);
    expect(r2.value.linkedEvidenceIds).toEqual(["ev-1"]);
    expect(store.sourceStatusOf(r2.value.claimRevisionId)).toEqual({ ok: true, value: "absent" });
    expect(store.experimentStatusOf(r2.value.claimRevisionId)).toEqual({ ok: true, value: "absent" });
    expect(store.evidenceOf(r2.value.claimRevisionId)).toEqual({ ok: true, value: [] });
    // The earlier revision keeps its own records and statuses.
    expect(store.sourceStatusOf(rev1)).toEqual({ ok: true, value: "supported" });
    const list = store.revisionsOf("clm-1");
    expect(list.ok && list.value.map((r) => r.claimRevisionId)).toEqual([rev1, r2.value.claimRevisionId]);
  });

  it("discards AI-supplied origin/status/approval values and records field names only", () => {
    const store = new EvidenceStore();
    const r = store.createClaimRevision({
      claimId: "clm-2", reason: "initial", aiOutputRecordId: "rec-000007",
      aiClaim: { effect: "x", origin: "human-authored", evidence_status: "supported", approval: "approved", approvalStatus: "approved" },
    });
    if (!r.ok) throw new Error("r");
    expect(r.value.origin).toBe("ai-inferred");
    expect(r.value.content).toEqual({ effect: "x" });
    const ev = store.events().find((e) => e.type === "ai_content_discarded");
    expect(ev).toMatchObject({ aiOutputRecordId: "rec-000007" });
    const text = JSON.stringify(ev);
    for (const v of ["human-authored", "supported", "approved"]) expect(text).not.toContain(v);
    expect(text).toContain("evidence_status");
  });

  it("refuses unknown ids, empty reasons, and an unknown prompting Evidence id", () => {
    const { store } = newStore();
    expect(store.createClaimRevision({ claimId: "Bad Id", reason: "x", aiClaim: {}, aiOutputRecordId: "rec-000001" }).ok).toBe(false);
    expect(store.createClaimRevision({ claimId: "clm-1", reason: " ", aiClaim: {}, aiOutputRecordId: "rec-000001" }).ok).toBe(false);
    const r = store.createClaimRevision({ claimId: "clm-1", reason: "x", promptedByEvidence: ["nope"], aiClaim: {}, aiOutputRecordId: "rec-000001" });
    expect(r.ok).toBe(false);
    expect(store.revisionsOf("clm-1")).toMatchObject({ ok: true });
  });
});

describe("Evidence ownership and append-only behavior", () => {
  it("rejects an Origin change, leaves the Origin and records the component", () => {
    const { store, rev1 } = newStore();
    const before = JSON.stringify(store.getRevision(rev1));
    const r = store.requestOriginChange(rev1, "human-authored", "spec_restorer");
    expect(r).toMatchObject({ ok: false, error: { kind: "rejected", attempt: "set_origin", component: "spec_restorer" } });
    expect(JSON.stringify(store.getRevision(rev1))).toBe(before);
    expect(store.events().at(-1)).toMatchObject({ type: "store_rejection", attempt: "set_origin", component: "spec_restorer" });
  });

  it("rejects `source` from any component except the Citation_Verifier", () => {
    const { store, rev1 } = newStore();
    const r = store.appendEvidence({ component: "loop_orchestrator", record: sourceRec("ev-1", rev1, ["verified"]) });
    expect(r).toMatchObject({ ok: false, error: { kind: "rejected", attempt: "append_evidence_disallowed_actor", component: "loop_orchestrator" } });
    expect(store.evidenceOf(rev1)).toEqual({ ok: true, value: [] });
    expect(store.sourceStatusOf(rev1)).toEqual({ ok: true, value: "absent" });
  });

  it("rejects `experiment` outside the match, mismatch, and not_comparable rules, or with a wrong outcome", () => {
    const { store, rev1 } = newStore();
    expect(store.appendEvidence({ component: CITATION_VERIFIER, record: expRec("e1", rev1, "supports") }).ok).toBe(false);
    expect(store.appendEvidence({ component: "other", record: expRec("e2", rev1, "supports") }).ok).toBe(false);
    expect(store.appendEvidence({ component: experimentRuleComponent("match"), record: expRec("e3", rev1, "contradicts") }).ok).toBe(false);
    expect(store.evidenceOf(rev1)).toEqual({ ok: true, value: [] });
    expect(store.events().filter((e) => e.type === "store_rejection")).toHaveLength(3);
  });

  it("accepts each rule with its outcome and derives the status (not_comparable keeps absent)", () => {
    const { store, rev1 } = newStore();
    for (const [i, o] of (["inconclusive", "supports", "contradicts"] as const).entries()) {
      const r = store.appendEvidence({ component: experimentRuleComponent(ruleFor[o]), record: expRec(`e${i}`, rev1, o) });
      expect(r.ok).toBe(true);
      if (i === 0) expect(store.experimentStatusOf(rev1)).toEqual({ ok: true, value: "absent" });
    }
    expect(store.experimentStatusOf(rev1)).toEqual({ ok: true, value: "mixed" });
  });

  it("rejects an unknown kind with a recorded rejection and no change", () => {
    const { store, rev1 } = newStore();
    const r = store.appendEvidence({ component: "x", record: { evidenceId: "e1", kind: "approval", claimRevisionId: rev1 } });
    expect(r).toMatchObject({ ok: false, error: { attempt: "append_evidence_disallowed_kind" } });
    expect(store.appendEvidence({ component: "x", record: "nope" }).ok).toBe(false);
    expect(store.evidenceOf(rev1)).toEqual({ ok: true, value: [] });
  });

  it("reports invalid shape, unknown revision, and duplicate id as errors without appending", () => {
    const { store, rev1 } = newStore();
    const bad = { ...sourceRec("e1", rev1, ["verified"]), extra: 1 };
    expect(store.appendEvidence({ component: CITATION_VERIFIER, record: bad })).toMatchObject({ ok: false, error: { kind: "invalid_request" } });
    expect(store.appendEvidence({ component: CITATION_VERIFIER, record: sourceRec("e1", "clm-9-r1", ["verified"]) })).toMatchObject({
      ok: false, error: { kind: "unknown_id", id: "clm-9-r1" },
    });
    expect(store.appendEvidence({ component: CITATION_VERIFIER, record: sourceRec("e1", rev1, ["verified"]) }).ok).toBe(true);
    expect(store.appendEvidence({ component: CITATION_VERIFIER, record: sourceRec("e1", rev1, ["failed"]) }).ok).toBe(false);
    expect(store.sourceStatusOf(rev1)).toEqual({ ok: true, value: "supported" });
  });

  it("returned records are frozen", () => {
    const { store, rev1 } = newStore();
    const r = store.getRevision(rev1);
    if (!r.ok) throw new Error("r");
    expect(() => {
      (r.value as { origin: string }).origin = "human-authored";
    }).toThrow();
  });

  it("an append changes no other fact of this or any other revision", () => {
    const { store, rev1 } = newStore();
    const other = store.createClaimRevision({ claimId: "clm-3", reason: "initial", aiClaim: {}, aiOutputRecordId: "rec-000002" });
    if (!other.ok) throw new Error("other");
    const snap = () => JSON.stringify([store.getRevision(rev1), store.getRevision(other.value.claimRevisionId), store.experimentStatusOf(rev1), store.sourceStatusOf(other.value.claimRevisionId), store.experimentStatusOf(other.value.claimRevisionId)]);
    const before = snap();
    store.appendEvidence({ component: CITATION_VERIFIER, record: sourceRec("e1", rev1, ["verified"]) });
    expect(snap()).toBe(before);
  });
});

describe("unknown identifiers and the Approval boundary", () => {
  it("returns an error naming the unknown id, never a default", () => {
    const { store } = newStore();
    for (const r of [store.originOf("zzz"), store.sourceStatusOf("zzz"), store.experimentStatusOf("zzz"), store.getRevision("zzz")]) {
      expect(r).toMatchObject({ ok: false, error: { kind: "unknown_id", id: "zzz" } });
    }
    expect(readFacts(store, "run-1", "zzz", { approvalStatus: () => "none" })).toMatchObject({ ok: false });
  });

  it("Approval comes only from the reader and is never stored with the revision", () => {
    const { store, rev1 } = newStore();
    const seen: unknown[] = [];
    const reader = { approvalStatus: (t: unknown) => (seen.push(t), "approved" as const) };
    const f = readFacts(store, "run-1", rev1, reader);
    expect(f).toMatchObject({ ok: true, value: { approvalStatus: "approved", origin: "ai-inferred", sourceEvidenceStatus: "absent" } });
    expect(seen).toEqual([{ kind: "claim_revision", runId: "run-1", claimRevisionId: rev1 }]);
    expect(JSON.stringify(store.getRevision(rev1))).not.toMatch(/approv/i);
    expect(runtime.deriveApprovalStatus([])).toBe("none");
    expect(runtime.deriveApprovalStatus([{ seq: 2, decision: "rejected" }, { seq: 5, decision: "approved" }, { seq: 3, decision: "needs_changes" }])).toBe("approved");
  });

  it("the runtime entry point exports no Approval writer or reader", () => {
    const names = Object.keys(runtime);
    expect(names.filter((n) => /approval/i.test(n))).toEqual(["deriveApprovalStatus"]);
    expect(names.filter((n) => /(write|append).*approv|approv.*(write|append|record)/i.test(n))).toEqual([]);
    expect(names).not.toContain("readFacts");
  });

  it("value sets stay in step with the schema enumerations", () => {
    const defs = (SCHEMAS.common as { $defs: Record<string, { enum?: string[] }> }).$defs;
    expect(defs["Origin"]?.enum).toEqual(["ai-inferred", "human-authored"]);
    expect(defs["EvidenceKind"]?.enum).toEqual(["source", "experiment"]);
    expect(defs["EvidenceStatus"]?.enum).toEqual(["absent", "supported", "contradicted", "mixed"]);
    expect(defs["ApprovalStatus"]?.enum).toEqual(["none", "approved", "rejected", "needs_changes"]);
  });
});
