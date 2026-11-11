// Property 33 (task 1.23): Approval validation, supersession and derived status.
// Validates: Requirements 6.9, 23.1, 23.5, 23.7, 23.12
// Pure in-memory test of the validator, the tooling chain builder, ApprovalReader and a TargetResolver.
// Fixed seed, bounded run count. The API takes the timestamp as caller content (the host command fills it
// from the clock), so a missing or offset-less timestamp is checked as an invalid field, not as forbidden input.
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ApprovalReader,
  ApprovalStoreError,
  analyzeStore,
  toApprovalTarget,
  toStoredTarget,
  type ApprovalTarget,
  type StoredTarget,
  type TargetResolver,
} from "../src/approval/index.js";
import {
  appendApproval,
  appendStoreRejection,
  buildChain,
  fieldNames,
  loadVerifiedState,
  validateApprovalCandidate,
} from "../src/approval/tooling.js";

const SEED = 23_033;
const NUM_RUNS = 120;
const TIMEOUT_MS = 120_000;

const GATES = ["start-implementation", "container-runtime", "override-draft", "override-apply", "install-kiro-cli", "m6-start", "m7-start", "transmit-source"];
const RUNS = ["run-0001", "run-0002"];
const CLAIMS = [{ run_id: "run-0001", claim_revision_id: "clm-0001-r1" }];

const resolver: TargetResolver = {
  resolves(t: ApprovalTarget): boolean {
    switch (t.kind) {
      case "run":
        return RUNS.includes(t.runId);
      case "claim_revision":
        return CLAIMS.some((c) => c.run_id === t.runId && c.claim_revision_id === t.claimRevisionId);
      case "gate":
        return GATES.includes(t.gateId);
    }
  },
};

const POOL: StoredTarget[] = [
  { kind: "run", run_id: "run-0001" },
  { kind: "run", run_id: "run-0002" },
  { kind: "claim_revision", run_id: "run-0001", claim_revision_id: "clm-0001-r1" },
  { kind: "gate", gate_id: "m6-start" },
  { kind: "gate", gate_id: "transmit-source" },
];
const UNKNOWN: StoredTarget[] = [
  { kind: "run", run_id: "run-9999" },
  { kind: "claim_revision", run_id: "run-0001", claim_revision_id: "clm-9999-r1" },
];
const DECISIONS = ["approved", "rejected", "needs_changes"] as const;
const key = (t: StoredTarget): string => JSON.stringify(t);

// ---------------------------------------------------------------------------------------------------------------
// Generators

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
const timestampArb = fc
  .record({
    y: fc.integer({ min: 2000, max: 2099 }), mo: fc.integer({ min: 1, max: 12 }), d: fc.integer({ min: 1, max: 28 }),
    h: fc.integer({ min: 0, max: 23 }), mi: fc.integer({ min: 0, max: 59 }), s: fc.integer({ min: 0, max: 59 }),
    off: fc.constantFrom("Z", "+09:00", "-05:30", "+00:00"),
  })
  .map((p) => `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}${p.off}`);
const approverArb = fc.oneof(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .,_-]{0,99}$/), fc.constant("a".repeat(100)));
const rationaleArb = fc.oneof(fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9 .,]{0,300}$/), fc.constant("x".repeat(2000)), fc.constant(" \u00e9 ok \n"));
const actorArb = fc.constantFrom("human", "kiro-development-agent");
const decisionArb = fc.constantFrom(...DECISIONS);
const poolIdxArb = fc.nat(POOL.length - 1);

const contentArb = fc.record({ approver: approverArb, timestamp: timestampArb, rationale: rationaleArb, recorded_by: actorArb, decision: decisionArb });

function candidate(c: { approver: string; timestamp: string; rationale: string; recorded_by: string; decision: string }, target: StoredTarget, supersedes?: number): Record<string, unknown> {
  return { ...c, target, ...(supersedes === undefined ? {} : { supersedes }) };
}

// Corruptions: field name -> list of ways to make it missing or invalid.
const CORRUPTIONS: Record<string, ((r: Record<string, unknown>) => void)[]> = {
  approver: [(r) => delete r["approver"], (r) => (r["approver"] = ""), (r) => (r["approver"] = "a".repeat(101)), (r) => (r["approver"] = 7)],
  timestamp: [
    (r) => delete r["timestamp"],
    (r) => (r["timestamp"] = String(r["timestamp"]).replace(/(Z|[+-]\d\d:\d\d)$/, "")),
    (r) => (r["timestamp"] = "not a time"),
  ],
  decision: [(r) => delete r["decision"], (r) => (r["decision"] = "maybe"), (r) => (r["decision"] = "APPROVED")],
  rationale: [(r) => delete r["rationale"], (r) => (r["rationale"] = " \t\n "), (r) => (r["rationale"] = "x".repeat(2001)), (r) => (r["rationale"] = "")],
  recorded_by: [(r) => delete r["recorded_by"], (r) => (r["recorded_by"] = "robot"), (r) => (r["recorded_by"] = "Human"), (r) => (r["recorded_by"] = "ai")],
  target: [
    (r) => delete r["target"],
    (r) => (r["target"] = { kind: "run", run_id: "run-9999" }),
    (r) => (r["target"] = { kind: "claim_revision", run_id: "run-0001", claim_revision_id: "clm-9999-r1" }),
    (r) => (r["target"] = { kind: "gate", gate_id: "no-such-gate" }),
    (r) => (r["target"] = { kind: "bogus" }),
  ],
  seq: [(r) => (r["seq"] = 99)],
  hash: [(r) => (r["hash"] = "0".repeat(64))],
  prev_hash: [(r) => (r["prev_hash"] = "1".repeat(64))],
};
const CORRUPT_FIELDS = Object.keys(CORRUPTIONS);

const prefixArb = fc.array(fc.record({ c: contentArb, t: poolIdxArb }), { maxLength: 4 });

function prefixText(prefix: { c: Parameters<typeof candidate>[0]; t: number }[]): string {
  const r = buildChain(prefix.map((p) => candidate(p.c, POOL[p.t]!)), resolver);
  if (!r.ok) throw new Error(`prefix failed: ${JSON.stringify(r.error)}`);
  return r.value.text;
}

describe("Property 33: Approval validation, supersession and derived status", () => {
  it(
    "rejects every record with missing or invalid fields, names every bad field, and leaves the store text identical",
    () => {
      fc.assert(
        fc.property(
          prefixArb,
          contentArb,
          poolIdxArb,
          fc.uniqueArray(fc.constantFrom(...CORRUPT_FIELDS), { minLength: 1, maxLength: CORRUPT_FIELDS.length }),
          fc.nat(10),
          (prefix, c, t, fields, variant) => {
            const text = prefixText(prefix);
            const before = text.slice();
            const rec = candidate(c, POOL[t]!);
            for (const f of fields) {
              const ways = CORRUPTIONS[f]!;
              ways[variant % ways.length]!(rec);
            }
            const snapshot = JSON.stringify(rec);

            const loaded = loadVerifiedState(text);
            expect(loaded.ok).toBe(true);
            if (!loaded.ok) return;
            const v = validateApprovalCandidate(rec, { state: loaded.value, resolver });
            expect(v.ok).toBe(false);
            if (v.ok) return;
            expect(fieldNames(v.error)).toEqual([...fields].sort());

            const a = appendApproval(text, rec, resolver);
            expect(a.ok).toBe(false);
            if (!a.ok) {
              expect(a.error.kind).toBe("invalid_record");
              if (a.error.kind === "invalid_record") expect(fieldNames(a.error.issues)).toEqual([...fields].sort());
            }
            expect(text).toBe(before);
            expect(JSON.stringify(rec)).toBe(snapshot);
            expect(analyzeStore(text).report.ok).toBe(true);
          },
        ),
        { seed: SEED, numRuns: NUM_RUNS },
      );
    },
    TIMEOUT_MS,
  );

  it(
    "accepts valid records, applies the supersedes rules, and derives status from the latest record per target",
    () => {
      const opArb = fc.record({
        t: poolIdxArb,
        c: contentArb,
        mode: fc.constantFrom("none", "valid", "nonexistent", "differentTarget", "alreadySuperseded", "rejectionSeq"),
        pick: fc.nat(50),
        rejectionBefore: fc.boolean(),
      });
      fc.assert(
        fc.property(fc.array(opArb, { minLength: 1, maxLength: 14 }), (ops) => {
          let text = "";
          let nextSeq = 1;
          const approvals: { seq: number; key: string; decision: string; superseded: boolean }[] = [];
          const rejections: number[] = [];

          const checkStatuses = (): void => {
            const reader = ApprovalReader.fromBytes(text, resolver);
            expect(reader.verify().ok).toBe(true);
            for (const t of POOL) {
              const mine = approvals.filter((a) => a.key === key(t));
              const latest = mine.reduce<(typeof mine)[number] | undefined>((m, a) => (m === undefined || a.seq > m.seq ? a : m), undefined);
              const expected = latest === undefined ? "none" : latest.decision;
              expect(reader.approvalStatus(toApprovalTarget(t))).toBe(expected);
            }
            for (const u of UNKNOWN) {
              const r = reader.statusOf(toApprovalTarget(u));
              expect(r.ok).toBe(false);
              if (!r.ok) expect(r.error.kind).toBe("unknown_target");
              expect(() => reader.approvalStatus(toApprovalTarget(u))).toThrow(ApprovalStoreError);
            }
          };

          for (const op of ops) {
            if (op.rejectionBefore) {
              const rj = appendStoreRejection(text, "refused modify request");
              expect(rj.ok).toBe(true);
              if (!rj.ok) return;
              text = rj.value.text;
              rejections.push(nextSeq);
              nextSeq++;
            }
            const target = POOL[op.t]!;
            const k = key(target);
            const pickFrom = <T>(xs: T[]): T | undefined => (xs.length === 0 ? undefined : xs[op.pick % xs.length]);
            let supersedes: number | undefined;
            let expectOk = true;
            switch (op.mode) {
              case "valid":
                supersedes = pickFrom(approvals.filter((a) => a.key === k && !a.superseded))?.seq;
                break;
              case "differentTarget":
                supersedes = pickFrom(approvals.filter((a) => a.key !== k))?.seq;
                expectOk = supersedes === undefined;
                break;
              case "alreadySuperseded":
                supersedes = pickFrom(approvals.filter((a) => a.key === k && a.superseded))?.seq;
                expectOk = supersedes === undefined;
                break;
              case "nonexistent":
                supersedes = nextSeq + 5;
                expectOk = false;
                break;
              case "rejectionSeq":
                supersedes = pickFrom(rejections);
                expectOk = supersedes === undefined;
                break;
              default:
                break;
            }
            const rec = candidate(op.c, target, supersedes);
            const snapshot = JSON.stringify(rec);
            const r = appendApproval(text, rec, resolver);
            expect(JSON.stringify(rec)).toBe(snapshot);
            expect(r.ok).toBe(expectOk);
            if (r.ok) {
              expect(r.value.text.startsWith(text)).toBe(true);
              expect(r.value.text.slice(text.length).split("\n").length).toBe(2); // exactly one new line
              expect(r.value.line.seq).toBe(nextSeq);
              expect(r.value.line.supersedes).toBe(supersedes);
              text = r.value.text;
              if (supersedes !== undefined) approvals.find((a) => a.seq === supersedes)!.superseded = true;
              approvals.push({ seq: nextSeq, key: k, decision: op.c.decision, superseded: false });
              nextSeq++;
              // A valid supersession (or any new approval) becomes the latest record for its target.
              const reader = ApprovalReader.fromBytes(text, resolver);
              expect(reader.approvalStatus(toApprovalTarget(target))).toBe(op.c.decision);
            } else {
              expect(r.error.kind).toBe("invalid_record");
              if (r.error.kind === "invalid_record") expect(fieldNames(r.error.issues)).toEqual(["supersedes"]);
              expect(analyzeStore(text).report.ok).toBe(true);
              expect(text.split("\n").length - 1).toBe(nextSeq - 1);
            }
            checkStatuses();
          }
          // Stored targets round-trip through the reader's camelCase form.
          for (const t of POOL) expect(toStoredTarget(toApprovalTarget(t))).toEqual(t);
        }),
        { seed: SEED + 1, numRuns: NUM_RUNS },
      );
    },
    TIMEOUT_MS,
  );

  it("an empty store gives none for every resolvable target and an error for an unknown one", () => {
    const reader = ApprovalReader.fromBytes("", resolver);
    for (const t of POOL) expect(reader.approvalStatus(toApprovalTarget(t))).toBe("none");
    expect(() => reader.approvalStatus(toApprovalTarget(UNKNOWN[0]!))).toThrow(ApprovalStoreError);
  });
});
