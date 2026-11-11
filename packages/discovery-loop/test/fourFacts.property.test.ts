// Feature: discovery-loop, Property 6: The four facts are independent
// **Validates: Requirements 6.5, 6.6, 6.9, 6.17**
//
// Over generated sequences of single updates (source Evidence, experiment Evidence, Approval_Record built by the
// test-only chain builder), the canonical serialization of each of the four facts of every Claim revision is
// compared before and after each update: only the updated fact of the targeted revision may change.
// Reproducibility record: SEED = 6006, NUM_RUNS = 50 (fixed on purpose).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ApprovalReader, type TargetResolver } from "../src/approval/index.js";
import { appendApproval } from "../src/approval/tooling.js";
import { canonicalJson } from "../src/canonical/index.js";
import { EvidenceStore } from "../src/index.js";
import { createFactsQuery } from "../src/report/index.js";

const SEED = 6006;
const NUM_RUNS = 50;
const RUN = "run-0001";
const anyTarget: TargetResolver = { resolves: () => true };

type Fact = "origin" | "sourceEvidenceStatus" | "experimentEvidenceStatus" | "approvalStatus";
const FACTS: Fact[] = ["origin", "sourceEvidenceStatus", "experimentEvidenceStatus", "approvalStatus"];

type Update =
  | { kind: "source"; rev: number; results: ("verified" | "failed")[] }
  | { kind: "experiment"; rev: number; outcome: "supports" | "contradicts" | "inconclusive" }
  | { kind: "approval"; rev: number; decision: "approved" | "rejected" | "needs_changes" };

const REVISIONS = ["clm-1-r1", "clm-1-r2", "clm-2-r1"];
const rule = { supports: "match", contradicts: "mismatch", inconclusive: "not_comparable" } as const;

const updateArb: fc.Arbitrary<Update> = fc.oneof(
  fc.record({
    kind: fc.constant("source" as const),
    rev: fc.nat(REVISIONS.length - 1),
    results: fc.array(fc.constantFrom("verified" as const, "failed" as const), { minLength: 1, maxLength: 3 }),
  }),
  fc.record({
    kind: fc.constant("experiment" as const),
    rev: fc.nat(REVISIONS.length - 1),
    outcome: fc.constantFrom("supports" as const, "contradicts" as const, "inconclusive" as const),
  }),
  fc.record({
    kind: fc.constant("approval" as const),
    rev: fc.nat(REVISIONS.length - 1),
    decision: fc.constantFrom("approved" as const, "rejected" as const, "needs_changes" as const),
  }),
);

describe("Property 6: the four facts are independent", () => {
  it("a single update changes only the updated fact of the targeted revision", () => {
    fc.assert(
      fc.property(fc.array(updateArb, { minLength: 1, maxLength: 8 }), (updates) => {
        const store = new EvidenceStore();
        for (const claimId of ["clm-1", "clm-1", "clm-2"]) {
          const r = store.createClaimRevision({ claimId, reason: "initial", aiClaim: { effect: "x" }, aiOutputRecordId: "rec-000005" });
          expect(r.ok).toBe(true);
        }
        let approvalText = "";
        let lastSeqByRev = new Map<string, number>();
        let counter = 0;

        const snapshot = (): Map<string, Record<Fact, string>> => {
          const reader = ApprovalReader.fromBytes(approvalText, anyTarget);
          const q = createFactsQuery(store, RUN, reader);
          const out = new Map<string, Record<Fact, string>>();
          for (const id of REVISIONS) {
            const f = q.facts(id);
            if (!f.ok) throw new Error(`facts failed for ${id}`);
            const row = {} as Record<Fact, string>;
            for (const k of FACTS) row[k] = canonicalJson(f.value[k]);
            out.set(id, row);
          }
          return out;
        };

        for (const u of updates) {
          const before = snapshot();
          const rev = REVISIONS[u.rev] as string;
          counter += 1;
          let changed: Fact;
          if (u.kind === "source") {
            changed = "sourceEvidenceStatus";
            const res = store.appendEvidence({
              component: "citation_verifier",
              record: {
                evidenceId: `ev-${counter}`, kind: "source", claimRevisionId: rev, citationRecordId: "rec-000010",
                citations: u.results.map((result, index) => (result === "failed" ? { index, result, reason: "quote_not_found" } : { index, result })),
              },
            } as never);
            expect(res.ok).toBe(true);
          } else if (u.kind === "experiment") {
            changed = "experimentEvidenceStatus";
            const res = store.appendEvidence({
              component: `experiment_rule:${Object.entries(rule).find(([o]) => o === u.outcome)?.[1]}`,
              record: {
                evidenceId: `ev-${counter}`, kind: "experiment", claimRevisionId: rev, outcome: u.outcome, experimentId: "exp-1",
                comparisonRecordId: "rec-000020", observationRecordId: "rec-000021", predictionRecordId: "rec-000022",
              },
            } as never);
            expect(res.ok).toBe(true);
          } else {
            changed = "approvalStatus";
            const prior = lastSeqByRev.get(rev);
            const res = appendApproval(
              approvalText,
              {
                approver: "Alice Example",
                timestamp: "2025-03-04T05:06:07.000+09:00",
                target: { kind: "claim_revision", run_id: RUN, claim_revision_id: rev },
                decision: u.decision,
                rationale: "Reviewed.",
                recorded_by: "human",
                ...(prior === undefined ? {} : { supersedes: prior }),
              },
              anyTarget,
            );
            if (!res.ok) throw new Error(JSON.stringify(res.error));
            approvalText = res.value.text;
            lastSeqByRev = new Map(lastSeqByRev).set(rev, res.value.line.seq);
          }
          const after = snapshot();

          for (const id of REVISIONS) {
            const b = before.get(id) as Record<Fact, string>;
            const a = after.get(id) as Record<Fact, string>;
            for (const k of FACTS) {
              if (id === rev && k === changed) continue; // the only fact allowed to change
              expect(a[k], `${id}.${k} after ${u.kind} update on ${rev}`).toBe(b[k]);
            }
          }
        }
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, 120_000);
});
