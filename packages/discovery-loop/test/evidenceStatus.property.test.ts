// Property 5 (task 1.17): Evidence statuses are derived per kind, from counts, and independent of order.
// Validates: Requirements 5.8, 6.4, 6.5, 6.6, 6.7, 6.18
// Pure derivation plus the in-memory EvidenceStore. Fixed seed, bounded run count.
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CITATION_VERIFIER,
  EvidenceStore,
  deriveExperimentStatus,
  deriveSourceStatus,
  experimentRuleComponent,
  type EvidenceRecord,
  type EvidenceStatus,
} from "../src/index.js";
import { createSchemaValidator } from "../src/schema/index.js";

const SEED = 5_017;
const NUM_RUNS = 200;
const PARAMS = { seed: SEED, numRuns: NUM_RUNS };

type Outcome = "supports" | "contradicts" | "inconclusive";
type CitationOutcome = "verified" | "failed";
const RULE = { supports: "match", contradicts: "mismatch", inconclusive: "not_comparable" } as const;

/** Reference model: a status from the two counts only. */
function reference(positive: number, negative: number): EvidenceStatus {
  if (positive > 0 && negative > 0) return "mixed";
  if (positive > 0) return "supported";
  if (negative > 0) return "contradicted";
  return "absent";
}
const count = <T>(xs: readonly T[], x: T): number => xs.filter((v) => v === x).length;
const expectedExperiment = (os: readonly Outcome[]): EvidenceStatus => reference(count(os, "supports"), count(os, "contradicts"));
const expectedSource = (cs: readonly CitationOutcome[]): EvidenceStatus => reference(count(cs, "verified"), count(cs, "failed"));

const REV = "clm-1-r1";
const expRec = (id: string, outcome: Outcome, rev = REV): EvidenceRecord => ({
  evidenceId: id,
  kind: "experiment",
  claimRevisionId: rev,
  outcome,
  experimentId: "exp-1",
  comparisonRecordId: "rec-000020",
  observationRecordId: "rec-000021",
  predictionRecordId: "rec-000022",
});
const srcRec = (id: string, results: readonly CitationOutcome[], rev = REV): EvidenceRecord => ({
  evidenceId: id,
  kind: "source",
  claimRevisionId: rev,
  citationRecordId: "rec-000010",
  citations: results.map((result, index) =>
    result === "failed" ? { index, result, reason: "quote_not_found" as const } : { index, result },
  ),
});

const outcomeArb = fc.constantFrom<Outcome>("supports", "contradicts", "inconclusive");
const outcomesArb = fc.array(outcomeArb, { maxLength: 12 }); // includes the empty multiset
const citationArb = fc.constantFrom<CitationOutcome>("verified", "failed");
const citationSetArb = fc.array(citationArb, { minLength: 1, maxLength: 5 }); // one source record per verification; evidence schema allows 1..5 Citations
const sourceRecordsArb = fc.array(citationSetArb, { maxLength: 4 });

/** An arbitrary permutation, as sort keys paired with the items. */
function permuted<T>(items: readonly T[], keys: readonly number[]): T[] {
  return items
    .map((item, i) => ({ item, key: keys[i] ?? 0, i }))
    .sort((a, b) => a.key - b.key || a.i - b.i)
    .map((x) => x.item);
}
const keysArb = fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 40, maxLength: 40 });

describe("Property 5: Evidence statuses are derived per kind, from counts, and independent of order", () => {
  it("deriveExperimentStatus equals the count-based reference model, inconclusive counting as neither", () => {
    fc.assert(
      fc.property(outcomesArb, (os) => {
        const records = os.map((o, i) => expRec(`e${i}`, o));
        expect(deriveExperimentStatus(records)).toBe(expectedExperiment(os));
        // Inconclusive records never change the status.
        const without = records.filter((r) => r.outcome !== "inconclusive");
        expect(deriveExperimentStatus(without)).toBe(deriveExperimentStatus(records));
      }),
      PARAMS,
    );
  });

  it("deriveSourceStatus: none -> absent, all verified -> supported, none verified -> contradicted, else mixed", () => {
    fc.assert(
      fc.property(sourceRecordsArb, (sets) => {
        const records = sets.map((s, i) => srcRec(`s${i}`, s));
        expect(deriveSourceStatus(records)).toBe(expectedSource(sets.flat()));
        if (sets.length === 0) expect(deriveSourceStatus(records)).toBe("absent");
        // One record per verification: the status equals that record's own rule.
        for (const s of sets) {
          const own = s.every((c) => c === "verified") ? "supported" : s.every((c) => c === "failed") ? "contradicted" : "mixed";
          expect(deriveSourceStatus([srcRec("one", s)])).toBe(own);
        }
      }),
      PARAMS,
    );
  });

  it("every permutation of the same records gives the same status, and repeated derivation is stable", () => {
    fc.assert(
      fc.property(outcomesArb, sourceRecordsArb, keysArb, (os, sets, keys) => {
        const exp = os.map((o, i) => expRec(`e${i}`, o));
        const src = sets.map((s, i) => srcRec(`s${i}`, s));
        const expStatus = deriveExperimentStatus(exp);
        const srcStatus = deriveSourceStatus(src);
        expect(deriveExperimentStatus(permuted(exp, keys))).toBe(expStatus);
        expect(deriveExperimentStatus([...exp].reverse())).toBe(expStatus);
        expect(deriveExperimentStatus(exp)).toBe(expStatus);
        expect(deriveSourceStatus(permuted(src, keys))).toBe(srcStatus);
        expect(deriveSourceStatus([...src].reverse())).toBe(srcStatus);
        expect(deriveSourceStatus(src)).toBe(srcStatus);
        // Order of the Citation results inside a record does not matter either.
        const flipped = sets.map((s, i) => srcRec(`s${i}`, permuted(s, keys)));
        expect(deriveSourceStatus(flipped)).toBe(srcStatus);
      }),
      PARAMS,
    );
  });

  it("records of the other kind never affect a status", () => {
    fc.assert(
      fc.property(outcomesArb, sourceRecordsArb, keysArb, (os, sets, keys) => {
        const exp = os.map((o, i) => expRec(`e${i}`, o));
        const src = sets.map((s, i) => srcRec(`s${i}`, s));
        const mixedAll = permuted([...exp, ...src], keys);
        expect(deriveExperimentStatus(mixedAll)).toBe(expectedExperiment(os));
        expect(deriveSourceStatus(mixedAll)).toBe(expectedSource(sets.flat()));
        expect(deriveExperimentStatus(src)).toBe("absent");
        expect(deriveSourceStatus(exp)).toBe("absent");
      }),
      PARAMS,
    );
  });

  it("EvidenceStore derives both statuses per revision from the appended records, in any append order", () => {
    const validator = createSchemaValidator(); // compiled once; the stores themselves stay independent
    fc.assert(
      fc.property(outcomesArb, sourceRecordsArb, keysArb, (os, sets, keys) => {
        type Item = { component: string; record: EvidenceRecord };
        const build = (rev: string): Item[] => [
          ...os.map((o, i) => ({ component: experimentRuleComponent(RULE[o]), record: expRec(`${rev}-e${i}`, o, rev) })),
          ...sets.map((s, i) => ({ component: CITATION_VERIFIER, record: srcRec(`${rev}-s${i}`, s, rev) })),
        ];
        const run = (items: readonly Item[]): { exp: unknown; src: unknown; other: unknown } => {
          const store = new EvidenceStore(validator);
          const make = (claimId: string) => {
            const r = store.createClaimRevision({ claimId, reason: "initial", aiClaim: { effect: "x" }, aiOutputRecordId: "rec-000005" });
            if (!r.ok) throw new Error("setup");
            return r.value.claimRevisionId;
          };
          const rev = make("clm-1");
          const otherRev = make("clm-2");
          for (const item of items) {
            const res = store.appendEvidence(item);
            if (!res.ok) throw new Error(`append failed: ${JSON.stringify(res.error)}`);
          }
          return {
            exp: store.experimentStatusOf(rev),
            src: store.sourceStatusOf(rev),
            // A second revision receives no records and stays absent (no cross-revision effect).
            other: [store.experimentStatusOf(otherRev), store.sourceStatusOf(otherRev)],
          };
        };
        const items = build("clm-1-r1");
        const a = run(items);
        const b = run(permuted(items, keys));
        expect(a.exp).toEqual({ ok: true, value: expectedExperiment(os) });
        expect(a.src).toEqual({ ok: true, value: expectedSource(sets.flat()) });
        expect(a.other).toEqual([{ ok: true, value: "absent" }, { ok: true, value: "absent" }]);
        expect(b).toEqual(a);
      }),
      PARAMS,
    );
  }, 120_000);
});
