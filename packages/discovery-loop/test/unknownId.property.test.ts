// Feature: discovery-loop, Property 31: Querying an unknown Claim revision is an error
// **Validates: Requirements 6.19**
//
// Unknown ids (never stored, near misses, case/whitespace variants, empty) always give an `unknown_id` error that
// names the id and never a default (`absent` / `none`). Known ids give the four separate fields. Queries never
// modify the store. Reproducibility record: SEED = 3107, NUM_RUNS = 150 (fixed on purpose).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ApprovalReader, type TargetResolver } from "../src/approval/index.js";
import { buildChain } from "../src/approval/tooling.js";
import { EvidenceStore, readFacts, type ApprovalStatusReader } from "../src/model/index.js";
import { createSchemaValidator } from "../src/schema/index.js";
import { createFactsQuery } from "../src/report/index.js";

const SEED = 3107;
const NUM_RUNS = 100;
const anyTarget: TargetResolver = { resolves: () => true };
const VALIDATOR = createSchemaValidator();
const APPROVALS = emptyApprovalsOnce();
const RUN = "run-0001";

function emptyApprovalsOnce(): ApprovalReader {
  const built = buildChain([], anyTarget);
  if (!built.ok) throw new Error(JSON.stringify(built.error));
  return ApprovalReader.fromBytes(built.value.text, anyTarget);
}
const noneReader: ApprovalStatusReader = { approvalStatus: () => "none" };

type EvSpec = { kind: "exp"; outcome: "match" | "mismatch" | "not_comparable" } | { kind: "src"; failed: boolean };
interface Plan {
  claims: { name: string; revisions: EvSpec[][] }[];
}

const evSpec: fc.Arbitrary<EvSpec> = fc.oneof(
  fc.constantFrom("match", "mismatch", "not_comparable").map((outcome) => ({ kind: "exp", outcome }) as EvSpec),
  fc.boolean().map((failed) => ({ kind: "src", failed }) as EvSpec),
);
const planArb: fc.Arbitrary<Plan> = fc
  .uniqueArray(fc.constantFrom("clm-a", "clm-b", "clm-c", "clm-d"), { minLength: 0, maxLength: 4 })
  .chain((names) =>
    fc
      .tuple(...names.map(() => fc.array(fc.array(evSpec, { maxLength: 3 }), { minLength: 1, maxLength: 3 })))
      .map((revs) => ({ claims: names.map((name, i) => ({ name, revisions: revs[i] as EvSpec[][] })) })),
  );

const OUTCOME = { match: "supports", mismatch: "contradicts", not_comparable: "inconclusive" } as const;

function build(plan: Plan): { store: EvidenceStore; known: string[] } {
  const store = new EvidenceStore(VALIDATOR);
  const known: string[] = [];
  let n = 0;
  for (const c of plan.claims) {
    for (const evs of c.revisions) {
      const r = store.createClaimRevision({ claimId: c.name, reason: "initial", aiClaim: { effect: "x" }, aiOutputRecordId: "rec-000005" });
      if (!r.ok) throw new Error("setup");
      const rev = r.value.claimRevisionId;
      known.push(rev);
      for (const e of evs) {
        n += 1;
        const evidenceId = `ev-${n}`;
        const res =
          e.kind === "exp"
            ? store.appendEvidence({
                component: `experiment_rule:${e.outcome}`,
                record: {
                  evidenceId, kind: "experiment", claimRevisionId: rev, outcome: OUTCOME[e.outcome], experimentId: "exp-1",
                  comparisonRecordId: "rec-000020", observationRecordId: "rec-000021", predictionRecordId: "rec-000022",
                },
              })
            : store.appendEvidence({
                component: "citation_verifier",
                record: {
                  evidenceId, kind: "source", claimRevisionId: rev, citationRecordId: "rec-000010",
                  citations: [e.failed ? { index: 0, result: "failed", reason: "quote_not_found" } : { index: 0, result: "verified" }],
                },
              });
        if (!res.ok) throw new Error(JSON.stringify(res.error));
      }
    }
  }
  return { store, known };
}

/** Everything observable from the store, for before/after comparison. */
function snapshot(store: EvidenceStore, known: readonly string[]): string {
  return JSON.stringify({
    events: store.events(),
    revisions: known.map((id) => store.getRevision(id)),
    evidence: known.map((id) => store.evidenceOf(id)),
  });
}

const variantArb = (known: string[]): fc.Arbitrary<string> => {
  const base = known.length > 0 ? fc.constantFrom(...known) : fc.constant("clm-a-r1");
  return fc.oneof(
    fc.constant(""),
    fc.constantFrom(" ", "\t", "\n"),
    fc.string({ maxLength: 12 }),
    fc.constantFrom("clm-zz-r1", "clm-nope-r9", "clm-x-r1"), // other run / never stored
    base.map((id) => id.replace(/-r(\d+)$/, (_m, d: string) => `-r${Number(d) + 100}`)), // other revision number
    base.map((id) => id.replace(/-r(\d+)$/, "-r0")),
    base.map((id) => id.toUpperCase()),
    base.map((id) => ` ${id}`),
    base.map((id) => `${id} `),
    base.map((id) => `${id}\n`),
    base.map((id) => id.slice(0, -1)),
    base.map((id) => id.replace("clm-", "clm_")),
  );
};

describe("Property 31: Querying an unknown Claim revision is an error", () => {
  it("unknown ids always give an unknown_id error naming the id; known ids give four separate fields; the store is not modified", () => {
    fc.assert(
      fc.property(
        planArb.chain((plan) => {
          const known = plan.claims.flatMap((c) => c.revisions.map((_r, i) => `${c.name}-r${i + 1}`));
          return fc.tuple(fc.constant(plan), fc.array(variantArb(known), { minLength: 1, maxLength: 8 }));
        }),
        ([plan, queries]) => {
          const { store, known } = build(plan);
          const knownSet = new Set(known);
          const query = createFactsQuery(store, RUN, APPROVALS);
          const before = snapshot(store, known);

          const expectUnknown = (r: { ok: boolean; error?: unknown; value?: unknown }, id: string) => {
            expect(r.ok).toBe(false);
            expect(r).not.toHaveProperty("value");
            const err = r.error as { kind: string; id: string; message: string };
            expect(err.kind).toBe("unknown_id");
            expect(err.id).toBe(id);
            expect(err.message).toContain(id);
          };

          for (const id of queries) {
            if (knownSet.has(id)) continue;
            expectUnknown(store.originOf(id), id);
            expectUnknown(store.sourceStatusOf(id), id);
            expectUnknown(store.experimentStatusOf(id), id);
            expectUnknown(store.evidenceOf(id), id);
            expectUnknown(store.getRevision(id), id);
            expectUnknown(readFacts(store, RUN, id, noneReader), id);
            expectUnknown(query.facts(id), id);
            expectUnknown(query.entry(id), id);
            expectUnknown(query.contradictingEvidence(id), id);
          }

          for (const id of known) {
            const f = query.facts(id);
            expect(f.ok).toBe(true);
            if (!f.ok) continue;
            expect(Object.keys(f.value).sort()).toEqual(
              ["approvalStatus", "claimRevisionId", "experimentEvidenceStatus", "origin", "sourceEvidenceStatus"],
            );
            expect(f.value.claimRevisionId).toBe(id);
            expect(f.value.origin).toBe("ai-inferred");
            expect(f.value.approvalStatus).toBe("none");
            const s = store.sourceStatusOf(id);
            const x = store.experimentStatusOf(id);
            expect(s.ok && f.value.sourceEvidenceStatus === s.value).toBe(true);
            expect(x.ok && f.value.experimentEvidenceStatus === x.value).toBe(true);
            expect(readFacts(store, RUN, id, noneReader)).toEqual(f);
            const e = query.entry(id);
            expect(e.ok && e.value.facts).toEqual(f.value);
            expect(query.contradictingEvidence(id).ok).toBe(true);
          }

          expect(snapshot(store, known)).toBe(before);
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, 120_000);

  it("an empty store rejects every id, including the empty string", () => {
    const store = new EvidenceStore();
    const query = createFactsQuery(store, RUN, APPROVALS);
    for (const id of ["", " ", "clm-a-r1"]) {
      const r = query.facts(id);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatchObject({ kind: "unknown_id", id });
    }
  });
});
