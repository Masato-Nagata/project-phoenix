// Property 8 (task 1.20): Evidence is append-only, written only by its owners, and contradictions are never hidden.
// Validates: Requirements 6.3, 6.12, 6.13, 6.15
// In-memory EvidenceStore; fixed seed, bounded run count.
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ApprovalReader, type TargetResolver } from "../src/approval/index.js";
import { buildChain } from "../src/approval/tooling.js";
import { CITATION_VERIFIER, EvidenceStore, experimentRuleComponent, type EvidenceRecord } from "../src/model/index.js";
import { createFactsQuery, renderEntry, renderReportText } from "../src/report/index.js";

const SEED = 8_008;
const NUM_RUNS = 100;
const TIMEOUT_MS = 120_000;
const RUN = "run-0001";
const REVS = ["clm-1", "clm-2", "clm-3"];
const anyTarget: TargetResolver = { resolves: () => true };

function approvalsFor(revs: readonly string[]): ApprovalReader {
  const cands = revs.map((rev) => ({
    approver: "Alice Example",
    timestamp: "2025-03-04T05:06:07.000+09:00",
    target: { kind: "claim_revision", run_id: RUN, claim_revision_id: rev },
    decision: "approved",
    rationale: "Reviewed.",
    recorded_by: "human",
  }));
  const built = buildChain(cands, anyTarget);
  if (!built.ok) throw new Error(JSON.stringify(built.error));
  return ApprovalReader.fromBytes(built.value.text, anyTarget);
}

function newStore(): { store: EvidenceStore; revIds: string[] } {
  const store = new EvidenceStore();
  const revIds = REVS.map((claimId) => {
    const r = store.createClaimRevision({ claimId, reason: "initial", aiClaim: { effect: "x" }, aiOutputRecordId: "rec-000005" });
    if (!r.ok) throw new Error("setup");
    return r.value.claimRevisionId;
  });
  return { store, revIds };
}

type Outcome = "supports" | "contradicts" | "inconclusive";
const RULE_FOR: Record<Outcome, "match" | "mismatch" | "not_comparable"> = {
  supports: "match",
  contradicts: "mismatch",
  inconclusive: "not_comparable",
};

const sourceRecord = (id: string, rev: string, results: boolean[]) => ({
  evidenceId: id,
  kind: "source",
  claimRevisionId: rev,
  citationRecordId: "rec-000010",
  citations: results.map((ok, index) => (ok ? { index, result: "verified" } : { index, result: "failed", reason: "quote_not_found" })),
});
const experimentRecord = (id: string, rev: string, outcome: Outcome) => ({
  evidenceId: id,
  kind: "experiment",
  claimRevisionId: rev,
  outcome,
  experimentId: "exp-1",
  comparisonRecordId: "rec-000020",
  observationRecordId: "rec-000021",
  predictionRecordId: "rec-000022",
});

interface Attempt {
  component: string;
  kind: "source" | "experiment" | "bogus";
  outcome: Outcome;
  results: boolean[];
  rev: number;
}

const OTHER_COMPONENTS = ["ai_client", "orchestrator", "experiment_rule", "experiment_rule:bogus", "citation_verifier2", "Citation_Verifier"];
const componentArb = fc.constantFrom(
  CITATION_VERIFIER,
  experimentRuleComponent("match"),
  experimentRuleComponent("mismatch"),
  experimentRuleComponent("not_comparable"),
  ...OTHER_COMPONENTS,
);
const outcomeArb = fc.constantFrom<Outcome>("supports", "contradicts", "inconclusive");
const attemptArb: fc.Arbitrary<Attempt> = fc.record({
  component: componentArb,
  kind: fc.constantFrom("source" as const, "experiment" as const, "bogus" as const),
  outcome: outcomeArb,
  results: fc.array(fc.boolean(), { minLength: 1, maxLength: 5 }),
  rev: fc.nat(REVS.length - 1),
});

function owns(a: Attempt): boolean {
  if (a.kind === "source") return a.component === CITATION_VERIFIER;
  if (a.kind === "experiment") return a.component === experimentRuleComponent(RULE_FOR[a.outcome]);
  return false;
}

function snapshot(store: EvidenceStore, revIds: readonly string[]): { revisions: string; evidence: string[]; events: string[] } {
  return {
    revisions: JSON.stringify(revIds.map((id) => store.getRevision(id))),
    evidence: revIds.map((id) => JSON.stringify(store.evidenceOf(id))),
    events: store.events().map((e) => JSON.stringify(e)),
  };
}

function blockOf(text: string, revId: string): string {
  const block = text.trimEnd().split("\n\n").find((b) => b.startsWith(`Claim revision: ${revId}\n`));
  if (block === undefined) throw new Error(`no block for ${revId}`);
  return block;
}

describe("Property 8: Evidence is append-only, written only by its owners, and contradictions are never hidden", () => {
  it(
    "owner-only appends, byte-identical records on rejection, nothing changes or disappears, contradictions visible",
    () => {
      fc.assert(
        fc.property(fc.array(attemptArb, { minLength: 1, maxLength: 45 }), fc.subarray(REVS.map((_, i) => i)), (attempts, approvedIdx) => {
          const { store, revIds } = newStore();
          const accepted: { id: string; json: string }[] = [];

          attempts.forEach((a, n) => {
            const rev = revIds[a.rev] as string;
            const id = `ev-${n + 1}`;
            const record =
              a.kind === "source" ? sourceRecord(id, rev, a.results)
              : a.kind === "experiment" ? experimentRecord(id, rev, a.outcome)
              : { evidenceId: id, kind: "bogus", claimRevisionId: rev };
            const before = snapshot(store, revIds);
            const res = store.appendEvidence({ component: a.component, record } as never);
            const after = snapshot(store, revIds);

            if (owns(a)) {
              expect(res.ok).toBe(true);
              accepted.push({ id, json: JSON.stringify(record) });
              // earlier records are untouched: each revision's prior list is a prefix of the new one
              before.evidence.forEach((prev, i) => {
                const prevList = JSON.parse(prev).value as unknown[];
                const nowList = JSON.parse(after.evidence[i] as string).value as unknown[];
                expect(JSON.stringify(nowList.slice(0, prevList.length))).toBe(JSON.stringify(prevList));
              });
              expect(after.revisions).toBe(before.revisions);
              expect(after.events.slice(0, before.events.length)).toEqual(before.events);
            } else {
              // rejected: records byte-identical, one rejection recorded with the component identity
              expect(res.ok).toBe(false);
              if (!res.ok) expect(res.error.kind).toBe("rejected");
              expect(after.revisions).toBe(before.revisions);
              expect(after.evidence).toEqual(before.evidence);
              expect(after.events.slice(0, before.events.length)).toEqual(before.events);
              expect(after.events.length).toBe(before.events.length + 1);
              const last = JSON.parse(after.events[after.events.length - 1] as string) as { type: string; component: string; attempt: string };
              expect(last.type).toBe("store_rejection");
              expect(last.component).toBe(a.component);
              expect(last.attempt).toBe(a.kind === "bogus" ? "append_evidence_disallowed_kind" : "append_evidence_disallowed_actor");
            }
          });

          // only the owners wrote: every stored record has its owner's kind and nothing else is there
          const stored: EvidenceRecord[] = revIds.flatMap((id) => {
            const r = store.evidenceOf(id);
            return r.ok ? [...r.value] : [];
          });
          expect(stored.map((r) => r.evidenceId).sort()).toEqual(accepted.map((x) => x.id).sort());
          for (const a of accepted) {
            const rec = stored.find((r) => r.evidenceId === a.id) as EvidenceRecord;
            expect(JSON.stringify(rec)).toBe(a.json);
          }

          // contradictions are never hidden in the report
          const approvedRevs = approvedIdx.map((i) => revIds[i] as string);
          const q = createFactsQuery(store, RUN, approvalsFor(approvedRevs));
          const entries = q.entries();
          expect(entries.ok).toBe(true);
          if (!entries.ok) return;
          const text = renderReportText(entries.value);
          for (const e of entries.value) {
            const contradicting = stored.filter((r) => r.claimRevisionId === e.facts.claimRevisionId).filter((r) =>
              r.kind === "experiment" ? r.outcome === "contradicts" : (r.citations ?? []).some((c) => c.result === "failed"),
            ).map((r) => r.evidenceId);
            expect([...e.contradictingEvidenceIds]).toEqual(contradicting);
            const qc = q.contradictingEvidence(e.facts.claimRevisionId);
            expect(qc.ok && [...qc.value]).toEqual(contradicting);
            const block = blockOf(text, e.facts.claimRevisionId);
            expect(block).toBe(renderEntry(e));
            expect(block).toContain(`Contradicting evidence (${contradicting.length}): `);
            if (contradicting.length > 0) {
              expect(["contradicted", "mixed"]).toContain(
                e.facts.sourceEvidenceStatus === "contradicted" || e.facts.sourceEvidenceStatus === "mixed"
                  ? e.facts.sourceEvidenceStatus
                  : e.facts.experimentEvidenceStatus,
              );
              const shown = e.facts.sourceEvidenceStatus === "contradicted" || e.facts.sourceEvidenceStatus === "mixed"
                || e.facts.experimentEvidenceStatus === "contradicted" || e.facts.experimentEvidenceStatus === "mixed";
              expect(shown).toBe(true);
              // the status lines are printed as derived, next to any supported status or approval
              expect(block).toContain(`Source evidence status: ${e.facts.sourceEvidenceStatus}`);
              expect(block).toContain(`Experiment evidence status: ${e.facts.experimentEvidenceStatus}`);
              expect(block).toContain(`Approval status: ${e.facts.approvalStatus}`);
              const line = block.split("\n").find((l) => l.startsWith("  Contradicting evidence")) as string;
              const listed = line.slice(line.indexOf("): ") + 3).split(", ");
              expect(listed).toEqual(contradicting);
            }
          }
        }),
        { seed: SEED, numRuns: NUM_RUNS },
      );
    },
    TIMEOUT_MS,
  );

  it(
    "lists every contradicting Evidence id with no cap next to supported statuses and approval",
    () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 40 }), fc.boolean(), (count, supportedFirst) => {
          const { store, revIds } = newStore();
          const rev = revIds[0] as string;
          const ok = (rec: unknown, component: string) => expect(store.appendEvidence({ component, record: rec } as never).ok).toBe(true);
          if (supportedFirst) {
            ok(sourceRecord("ev-s0", rev, [true, true]), CITATION_VERIFIER);
            ok(experimentRecord("ev-x0", rev, "supports"), experimentRuleComponent("match"));
          }
          const ids: string[] = [];
          for (let i = 0; i < count; i++) {
            const id = `ev-c${i + 1}`;
            ids.push(id);
            if (i % 2 === 0) ok(experimentRecord(id, rev, "contradicts"), experimentRuleComponent("mismatch"));
            else ok(sourceRecord(id, rev, [true, false]), CITATION_VERIFIER);
          }
          if (!supportedFirst) ok(sourceRecord("ev-s9", rev, [true]), CITATION_VERIFIER);
          const q = createFactsQuery(store, RUN, approvalsFor([rev]));
          const e = q.entry(rev);
          expect(e.ok).toBe(true);
          if (!e.ok) return;
          const block = renderEntry(e.value);
          expect(e.value.contradictingEvidenceIds).toEqual(ids);
          expect(block).toContain(`Contradicting evidence (${count}): ${ids.join(", ")}`);
          expect(block).toContain("Approval status: approved");
          expect(block).toMatch(/(Source|Experiment) evidence status: (mixed|contradicted)/);
        }),
        { seed: SEED, numRuns: 40 },
      );
    },
    TIMEOUT_MS,
  );
});
