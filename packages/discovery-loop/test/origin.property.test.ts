// Feature: discovery-loop, Property 7: Origin is immutable and Claim revisions inherit nothing
// **Validates: Requirements 4.10, 4.11, 4.13, 6.1, 6.2, 6.4, 6.14, 6.16, 11.5, 12.7**
//
// Generated operation sequences run against a real EvidenceStore: revisions (also with identical content, and
// with AI-supplied authority-like fields in case/separator variants), evidence appends, and Origin-change
// requests. Reproducibility record: SEED = 7007, NUM_RUNS = 100 (fixed on purpose).
//
// Scope note (design C1): authority-like names are removed at the Claim level only; nested occurrences are not
// discarded by this function (the strict gate rejects such responses). Nested values are generated so that they
// are tested to never become Origin/status/approval facts, but they are not expected to be removed or recorded.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CITATION_VERIFIER,
  EvidenceStore,
  discardAiAuthorityFields,
  experimentRuleComponent,
  readFacts,
  type EvidenceRecord,
  type JsonObject,
  type StoredClaimRevisionRecord,
} from "../src/model/index.js";

const SEED = 7007;
const NUM_RUNS = 100;

// ---------- generators ----------

const BASE_NAMES = [
  "origin", "evidence", "evidence_status", "evidenceStatus", "evidence-status", "source_evidence_status",
  "experimentEvidenceStatus", "approval", "approved", "approval_status", "approvedBy", "approval-record",
];

/** A reserved/authority-like name with arbitrary letter case (separators kept). */
const authorityName = fc
  .tuple(fc.constantFrom(...BASE_NAMES), fc.array(fc.boolean(), { minLength: 40, maxLength: 40 }))
  .map(([base, flips]) => [...base].map((ch, i) => (flips[i] ? ch.toUpperCase() : ch)).join(""));

/** Marker leaves are unique-looking strings that the event scan searches for. */
const markerLeaf = fc.nat({ max: 99999 }).map((n) => `qv~${n}~`);
type Tree = string | number | boolean | null | Tree[] | { [k: string]: Tree };
const tree: fc.Arbitrary<Tree> = fc.letrec<{ t: Tree }>((tie) => ({
  t: fc.oneof(
    { depthSize: "small", maxDepth: 4 },
    markerLeaf,
    fc.boolean(),
    fc.constant(null),
    fc.integer(),
    fc.array(tie("t"), { maxLength: 3 }),
    fc.dictionary(fc.oneof(authorityName, fc.constantFrom("a", "b", "c")), tie("t"), { maxKeys: 3 }),
  ),
})).t;

/** Benign top-level fields: names never match the reserved list. Their values may nest authority-like keys. */
const benignContent = fc.dictionary(fc.constantFrom("f_effect", "f_cause", "f_note", "f_list", "f_conf"), tree, { maxKeys: 4 });
const authorityFields = fc.dictionary(authorityName, tree, { maxKeys: 5 });

interface RevOp { t: "rev"; claim: number; benign: JsonObject; authority: JsonObject; reuseContent: boolean; prompted: number[]; reason: string }
interface EvOp { t: "src" | "exp"; target: number; pick: number }
interface OriginOp { t: "origin"; target: number; requested: "ai-inferred" | "human-authored"; component: string }
type Op = RevOp | EvOp | OriginOp;

const reason = fc.constantFrom("initial", "refined", "re-submitted", "contradiction seen");
const opArb: fc.Arbitrary<Op> = fc.oneof(
  { weight: 4, arbitrary: fc.record({
      t: fc.constant("rev" as const), claim: fc.nat({ max: 2 }), benign: benignContent, authority: authorityFields,
      reuseContent: fc.boolean(), prompted: fc.array(fc.nat({ max: 50 }), { maxLength: 3 }), reason }) },
  { weight: 3, arbitrary: fc.record({ t: fc.constantFrom("src" as const, "exp" as const), target: fc.nat({ max: 50 }), pick: fc.nat({ max: 2 }) }) },
  { weight: 2, arbitrary: fc.record({
      t: fc.constant("origin" as const), target: fc.nat({ max: 50 }), requested: fc.constantFrom("ai-inferred" as const, "human-authored" as const),
      component: fc.oneof(fc.constantFrom("", "   ", "loop_orchestrator", "ai_provider"), fc.string({ maxLength: 100 })) }) },
);

// ---------- helpers ----------

function markersOf(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === "string" && value.startsWith("qv~")) out.add(value);
  else if (Array.isArray(value)) value.forEach((v) => markersOf(v, out));
  else if (value !== null && typeof value === "object") Object.values(value).forEach((v) => markersOf(v, out));
  return out;
}
const snap = (x: unknown): string => JSON.stringify(x);
const byName = (a: { name: string }, b: { name: string }): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(`unexpected error: ${snap(r.error)}`);
  return r.value;
}

const emptyApprovals = { approvalStatus: () => "none" as const };

// ---------- the property ----------

describe("Property 7: Origin is immutable and Claim revisions inherit nothing", () => {
  it("holds over generated revision chains, AI proposals, evidence appends and Origin-change requests", () => {
    fc.assert(
      fc.property(fc.array(opArb, { minLength: 1, maxLength: 16 }), (ops) => {
        const store = new EvidenceStore();
        const created: StoredClaimRevisionRecord[] = []; // all revisions in creation order
        const snapshots = new Map<string, string>(); // revision id -> serialized record at creation
        const evidenceSnap = new Map<string, string>(); // evidence id -> serialized record at append
        const evidenceIds: string[] = [];
        const lastContent = new Map<number, JsonObject>();
        const perClaimCount = new Map<number, number>();
        let evCounter = 0;
        let recCounter = 0;

        for (const op of ops) {
          if (op.t === "rev") {
            const claimId = `clm-${op.claim}`;
            const benign = op.reuseContent && lastContent.has(op.claim) ? (lastContent.get(op.claim) as JsonObject) : op.benign;
            const aiClaim: JsonObject = { ...benign, ...op.authority };
            const aiBefore = snap(aiClaim);
            const prompted = [...new Set(op.prompted.map((i) => evidenceIds[i % Math.max(evidenceIds.length, 1)]))].filter(
              (x): x is string => x !== undefined,
            );
            const eventsBefore = store.events().length;
            const evSnapBefore = new Map(evidenceSnap);
            const aiOutputRecordId = `rec-${String(++recCounter).padStart(6, "0")}`;

            const rev = unwrap(store.createClaimRevision({ claimId, reason: op.reason, promptedByEvidence: prompted, aiClaim, aiOutputRecordId }));
            expect(snap(aiClaim)).toBe(aiBefore); // input not mutated

            const n = (perClaimCount.get(op.claim) ?? 0) + 1;
            perClaimCount.set(op.claim, n);
            const prevOfClaim = created.filter((c) => c.claimId === claimId).at(-1);

            // R6.14, R4.10: shape of the new revision
            expect(rev.origin).toBe("ai-inferred");
            expect(rev.claimId).toBe(claimId);
            expect(rev.revision).toBe(n);
            expect(created.some((c) => c.claimRevisionId === rev.claimRevisionId)).toBe(false); // new unique id
            expect(rev.predecessorRevisionId).toBe(prevOfClaim?.claimRevisionId);
            expect(prevOfClaim === undefined ? rev.revision : rev.revision - prevOfClaim.revision).toBe(prevOfClaim === undefined ? 1 : 1);
            expect([...rev.linkedEvidenceIds]).toEqual(prompted);

            // both statuses absent, approval none, and no Evidence carried over (even for identical content)
            expect(unwrap(store.evidenceOf(rev.claimRevisionId))).toEqual([]);
            expect(unwrap(store.sourceStatusOf(rev.claimRevisionId))).toBe("absent");
            expect(unwrap(store.experimentStatusOf(rev.claimRevisionId))).toBe("absent");
            expect(unwrap(store.originOf(rev.claimRevisionId))).toBe("ai-inferred");
            expect(unwrap(readFacts(store, "run-1", rev.claimRevisionId, emptyApprovals))).toEqual({
              claimRevisionId: rev.claimRevisionId, origin: "ai-inferred",
              sourceEvidenceStatus: "absent", experimentEvidenceStatus: "absent", approvalStatus: "none",
            });
            // Evidence of earlier revisions was not re-linked or changed
            for (const [id, s] of evSnapBefore) expect(snap(unwrap(store.getEvidence(id)))).toBe(s);

            // R4.11, R6.16: authority-like Claim-level fields are discarded and recorded by name/path, never by value
            const authorityNames = Object.keys(op.authority);
            for (const k of authorityNames) expect(Object.hasOwn(rev.content, k)).toBe(false);
            for (const k of Object.keys(benign)) expect(snap(rev.content[k])).toBe(snap(benign[k]));
            expect(Object.keys(rev.content).sort()).toEqual(Object.keys(benign).sort());
            const newEvents = store.events().slice(eventsBefore);
            const discards = newEvents.filter((e) => e.type === "ai_content_discarded");
            if (authorityNames.length === 0) expect(discards).toEqual([]);
            else {
              expect(discards).toHaveLength(1);
              const d = discards[0] as unknown as { aiOutputRecordId: string; fields: { path: string; name: string }[] };
              expect(d.aiOutputRecordId).toBe(aiOutputRecordId);
              expect(d.fields).toEqual(authorityNames.map((name) => ({ path: "", name })).sort(byName));
              expect(Object.keys(d).sort()).toEqual(["aiOutputRecordId", "fields", "type"]);
            }
            // no discarded value appears anywhere in the recorded events
            const discardedMarkers = markersOf(op.authority);
            const eventsText = snap(store.events());
            for (const m of discardedMarkers) expect(eventsText.includes(m)).toBe(false);

            created.push(rev);
            snapshots.set(rev.claimRevisionId, snap(rev));
            lastContent.set(op.claim, benign);
          } else if (op.t === "src" || op.t === "exp") {
            if (created.length === 0) continue;
            const target = created[op.target % created.length] as StoredClaimRevisionRecord;
            const evidenceId = `ev-${++evCounter}`;
            const outcome = (["supports", "contradicts", "inconclusive"] as const)[op.pick] ?? "inconclusive";
            const rule = (["match", "mismatch", "not_comparable"] as const)[op.pick] ?? "not_comparable";
            const record: EvidenceRecord =
              op.t === "src"
                ? { evidenceId, kind: "source", claimRevisionId: target.claimRevisionId, citationRecordId: "rec-000010",
                    citations: [op.pick === 0 ? { index: 0, result: "verified" } : { index: 0, result: "failed", reason: "quote_not_found" }] }
                : { evidenceId, kind: "experiment", claimRevisionId: target.claimRevisionId, outcome, experimentId: "exp-1",
                    comparisonRecordId: "rec-000020", observationRecordId: "rec-000021", predictionRecordId: "rec-000022" };
            const component = op.t === "src" ? CITATION_VERIFIER : experimentRuleComponent(rule);
            const stored = unwrap(store.appendEvidence({ component, record }));
            evidenceIds.push(evidenceId);
            evidenceSnap.set(evidenceId, snap(stored));
          } else if (op.t === "origin") {
            if (created.length === 0) continue;
            const target = created[op.target % created.length] as StoredClaimRevisionRecord;
            const before = snap(unwrap(store.getRevision(target.claimRevisionId)));
            const evBefore = snap(unwrap(store.evidenceOf(target.claimRevisionId)));
            const eventsBefore = store.events().length;

            const res = store.requestOriginChange(target.claimRevisionId, op.requested, op.component);
            expect(res.ok).toBe(false);
            if (res.ok) throw new Error("unreachable");
            expect(res.error.kind).toBe("rejected");
            const expectedComponent = op.component.trim() === "" ? "unknown" : op.component.slice(0, 64);
            if (res.error.kind === "rejected") {
              expect(res.error.attempt).toBe("set_origin");
              expect(res.error.component).toBe(expectedComponent);
            }
            // recorded with the component identity, exactly one new event
            const added = store.events().slice(eventsBefore);
            expect(added).toHaveLength(1);
            expect(added[0]).toMatchObject({ type: "store_rejection", attempt: "set_origin", component: expectedComponent });
            // Origin byte-identical afterwards; nothing else changed
            expect(snap(unwrap(store.getRevision(target.claimRevisionId)))).toBe(before);
            expect(unwrap(store.originOf(target.claimRevisionId))).toBe("ai-inferred");
            expect(snap(unwrap(store.evidenceOf(target.claimRevisionId)))).toBe(evBefore);
          }
        }

        // Unknown identifiers never get a default and are not recorded as rejections of a stored revision.
        const eventsBeforeUnknown = store.events().length;
        const unknown = store.requestOriginChange("no-such-revision", "human-authored", "x");
        expect(unknown.ok === false && unknown.error.kind === "unknown_id").toBe(true);
        expect(store.events().length).toBe(eventsBeforeUnknown);

        // Earlier revisions stay readable and unchanged; stored records are immutable.
        for (const rev of created) {
          expect(snap(unwrap(store.getRevision(rev.claimRevisionId)))).toBe(snapshots.get(rev.claimRevisionId));
          expect(() => {
            (rev as { origin: string }).origin = "human-authored";
          }).toThrow(TypeError);
          expect(rev.origin).toBe("ai-inferred");
        }
        // The chain per Claim is ordered with revision numbers 1..n and every id unique.
        const ids = created.map((c) => c.claimRevisionId);
        expect(new Set(ids).size).toBe(ids.length);
        for (const claimId of new Set(created.map((c) => c.claimId))) {
          const chain = unwrap(store.revisionsOf(claimId));
          chain.forEach((r, i) => {
            expect(r.revision).toBe(i + 1);
            expect(r.predecessorRevisionId).toBe(i === 0 ? undefined : chain[i - 1]?.claimRevisionId);
          });
        }
        // Evidence counted for a revision is exactly what was appended to that revision.
        for (const id of evidenceIds) {
          const e = unwrap(store.getEvidence(id));
          expect(unwrap(store.evidenceOf(e.claimRevisionId)).some((x) => x.evidenceId === id)).toBe(true);
          expect(snap(e)).toBe(evidenceSnap.get(id));
        }
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, 120_000);

  it("discardAiAuthorityFields reports names and paths only, never values, and leaves its input untouched", () => {
    fc.assert(
      fc.property(benignContent, authorityFields, (benign, authority) => {
        const input: JsonObject = { ...benign, ...authority };
        const before = snap(input);
        const { cleaned, discarded } = discardAiAuthorityFields(input);
        expect(snap(input)).toBe(before);
        expect(discarded).toEqual(Object.keys(authority).map((name) => ({ path: "", name })).sort(byName));
        expect(Object.keys(cleaned).sort()).toEqual(Object.keys(benign).sort());
        const reported = snap(discarded);
        for (const m of markersOf(authority)) expect(reported.includes(m)).toBe(false);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });
});
