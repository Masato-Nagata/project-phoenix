import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as runtime from "../src/index.js";
import { EvidenceStore } from "../src/index.js";
import { readFacts } from "../src/model/index.js";
import {
  ApprovalReader,
  ApprovalStoreError,
  GENESIS_HASH,
  analyzeStore,
  asApprovalStatusReader,
  toApprovalTarget,
  type ApprovalTarget,
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
import { generateApprovalVectors, vectorResolver } from "../src/approval/vectors.js";

const VECTOR_DIR = fileURLToPath(new URL("../test-vectors/approval/", import.meta.url));
const readVector = (name: string): any => JSON.parse(readFileSync(join(VECTOR_DIR, name), "utf8"));

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  approver: "Alice Example",
  timestamp: "2025-03-04T05:06:07.000+09:00",
  target: { kind: "run", run_id: "run-0001" },
  decision: "approved",
  rationale: "Reviewed.",
  recorded_by: "human",
  ...over,
});
const claim = { kind: "claim_revision", run_id: "run-0001", claim_revision_id: "clm-0001-r1" } as const;
const claimTarget: ApprovalTarget = { kind: "claim_revision", runId: "run-0001", claimRevisionId: "clm-0001-r1" };
const resolver = vectorResolver();

function store(...candidates: Record<string, unknown>[]): string {
  const r = buildChain(candidates, resolver);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value.text;
}

describe("runtime entry point", () => {
  it("exports no approval reader, validator or builder (R6.11, R23.4)", () => {
    const names = Object.keys(runtime).join(",");
    expect(names).not.toMatch(/ApprovalReader|ApprovalStore|validateApproval|appendApproval|buildChain|buildApproval|asApprovalStatusReader/);
  });
  it("the reader has no write-like method", () => {
    const proto = Object.getOwnPropertyNames(ApprovalReader.prototype).join(",");
    expect(proto).not.toMatch(/append|write|add|delete|remove|modify|supersede/i);
  });
});

describe("chain format (R23.2)", () => {
  it("starts at seq 1 with the genesis predecessor, +1 each, hash over the record without `hash`", () => {
    const text = store(base(), base({ decision: "rejected", supersedes: 1 }));
    const lines = text.split("\n").slice(0, -1).map((l) => JSON.parse(l));
    expect(lines.map((l) => l.seq)).toEqual([1, 2]);
    expect(lines[0].prev_hash).toBe(GENESIS_HASH);
    expect(lines[1].prev_hash).toBe(lines[0].hash);
    const { hash, ...rest } = lines[0];
    const canonical = JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => (a < b ? -1 : 1))));
    expect(createHash("sha256").update(canonical, "utf8").digest("hex")).toBe(hash);
  });
  it("serializes, stores, loads and parses to an equal record (R23.11)", () => {
    const r = buildChain([base(), base({ target: claim, rationale: 'q" \\ \n é 😀' })], resolver);
    if (!r.ok) throw new Error("setup");
    const again = analyzeStore(r.value.text);
    expect(again.report.ok).toBe(true);
    expect(again.state.lines).toEqual(r.value.lines);
  });
  it("store_rejection lines take a sequence number and are ignored by status derivation", () => {
    const a = appendApproval("", base(), resolver);
    if (!a.ok) throw new Error("setup");
    const b = appendStoreRejection(a.value.text, "delete request refused", 1);
    if (!b.ok) throw new Error("setup");
    expect(b.value.line.seq).toBe(2);
    expect(b.value.line.prev_hash).toBe(a.value.line.hash);
    const reader = ApprovalReader.fromBytes(b.value.text, resolver);
    expect(reader.verify().ok).toBe(true);
    expect(reader.approvals().length).toBe(1);
    expect(reader.approvalStatus({ kind: "run", runId: "run-0001" })).toBe("approved");
  });
  it("rejects an oversize store_rejection reason", () => {
    const r = appendStoreRejection("", "x".repeat(501));
    expect(r.ok).toBe(false);
  });
});

describe("new-record validation (R23.7)", () => {
  const ctx = () => {
    const loaded = loadVerifiedState(store(base({ decision: "needs_changes" })));
    if (!loaded.ok) throw new Error("setup");
    return { state: loaded.value, resolver };
  };
  it("names every missing field", () => {
    const r = validateApprovalCandidate({}, ctx());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(fieldNames(r.error)).toEqual(["approver", "decision", "rationale", "recorded_by", "target", "timestamp"]);
  });
  it("names both invalid fields, not only the first", () => {
    const r = validateApprovalCandidate(base({ approver: "", decision: "maybe" }), ctx());
    if (r.ok) throw new Error("expected rejection");
    expect(fieldNames(r.error)).toEqual(["approver", "decision"]);
  });
  it("rejects a missing or other actor declaration, naming recorded_by", () => {
    for (const v of [undefined, "robot", ""]) {
      const r = validateApprovalCandidate(base({ recorded_by: v }), ctx());
      if (r.ok) throw new Error("expected rejection");
      expect(fieldNames(r.error)).toEqual(["recorded_by"]);
    }
  });
  it("accepts both actor declarations", () => {
    for (const v of ["human", "kiro-development-agent"]) expect(validateApprovalCandidate(base({ recorded_by: v }), ctx()).ok).toBe(true);
  });
  it("rejects a timestamp without offset", () => {
    const r = validateApprovalCandidate(base({ timestamp: "2025-03-04T05:06:07" }), ctx());
    if (r.ok) throw new Error("expected rejection");
    expect(fieldNames(r.error)).toEqual(["timestamp"]);
  });
  it("counts rationale length in code points and rejects whitespace-only", () => {
    expect(validateApprovalCandidate(base({ rationale: "\u{1F600}".repeat(2000) }), ctx()).ok).toBe(true);
    expect(validateApprovalCandidate(base({ rationale: "\u{1F600}".repeat(2001) }), ctx()).ok).toBe(false);
    expect(validateApprovalCandidate(base({ rationale: " \n\t" }), ctx()).ok).toBe(false);
  });
  it("rejects a target that does not resolve, naming target", () => {
    const r = validateApprovalCandidate(base({ target: { kind: "run", run_id: "run-9999" } }), ctx());
    if (r.ok) throw new Error("expected rejection");
    expect(r.error.map((i) => i.code)).toEqual(["unresolved_target"]);
  });
  it("does not accept caller-supplied seq, prev_hash or hash", () => {
    const r = validateApprovalCandidate(base({ seq: 5, hash: GENESIS_HASH }), ctx());
    if (r.ok) throw new Error("expected rejection");
    expect(fieldNames(r.error)).toEqual(["hash", "seq"]);
  });
  it("leaves the store text unchanged on rejection (byte-identical)", () => {
    const before = store(base());
    const r = appendApproval(before, base({ approver: "" }), resolver);
    expect(r.ok).toBe(false);
    expect(before).toBe(store(base()));
  });
  it("refuses to append to a store that does not verify", () => {
    const text = store(base()).replace("Reviewed.", "Edited.");
    const r = appendApproval(text, base(), resolver);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("store_invalid");
  });
});

describe("supersedes (R23.12)", () => {
  const two = () => store(base({ decision: "needs_changes" }), base({ target: { kind: "gate", gate_id: "m6-start" } }));
  it("accepts an earlier approval of the same target and makes the superseding line the latest", () => {
    const next = appendApproval(two(), base({ decision: "approved", supersedes: 1 }), resolver);
    expect(next.ok).toBe(true);
    if (!next.ok) return;
    const reader = ApprovalReader.fromBytes(next.value.text, resolver);
    expect(reader.approvalStatus({ kind: "run", runId: "run-0001" })).toBe("approved");
    expect(reader.verify().ok).toBe(true);
  });
  it("rejects nonexistent, other-target and already-superseded records", () => {
    const text = appendApproval(two(), base({ decision: "approved", supersedes: 1 }), resolver);
    if (!text.ok) throw new Error("setup");
    const check = (s: unknown) => {
      const r = appendApproval(text.value.text, base({ supersedes: s }), resolver);
      return r.ok ? "ok" : r.error.kind === "invalid_record" ? fieldNames(r.error.issues) : r.error.kind;
    };
    expect(check(99)).toEqual(["supersedes"]);
    expect(check(2)).toEqual(["supersedes"]); // different target
    expect(check(1)).toEqual(["supersedes"]); // already superseded
    expect(check(3)).toBe("ok");
  });
  it("keeps the superseded line unchanged and readable in the chain", () => {
    const first = two();
    const next = appendApproval(first, base({ decision: "approved", supersedes: 1 }), resolver);
    if (!next.ok) throw new Error("setup");
    expect(next.value.text.startsWith(first)).toBe(true);
  });
  it("verify flags a hand-built chain with a supersedes rule violation", () => {
    const vec = readVector("tamper-cases.json").cases.find((c: any) => c.name === "supersedes-names-a-record-with-another-target");
    const report = analyzeStore(vec.storeText).report;
    expect(report.ok).toBe(false);
    expect(report.ruleViolations.map((v) => v.rule)).toEqual(["supersedes_target_differs"]);
  });
});

describe("ApprovalReader (R6.9, R23.9)", () => {
  it("returns none when no record targets it", () => {
    const reader = ApprovalReader.fromBytes(store(base()), resolver);
    expect(reader.approvalStatus(claimTarget)).toBe("none");
    expect(reader.approvalStatus({ kind: "gate", gateId: "m7-start" })).toBe("none");
  });
  it("returns none for an empty store", () => {
    expect(ApprovalReader.fromBytes("", resolver).approvalStatus({ kind: "run", runId: "run-0001" })).toBe("none");
  });
  it("derives the decision of the highest-seq line of the target, not of other targets", () => {
    const text = store(base({ target: claim, decision: "approved" }), base({ decision: "rejected" }), base({ target: claim, decision: "needs_changes", supersedes: 1 }));
    const reader = ApprovalReader.fromBytes(text, resolver);
    expect(reader.approvalStatus(claimTarget)).toBe("needs_changes");
    expect(reader.approvalStatus({ kind: "run", runId: "run-0001" })).toBe("rejected");
  });
  it("an unknown target is an error, never none", () => {
    const reader = ApprovalReader.fromBytes(store(base()), resolver);
    const r = reader.statusOf({ kind: "run", runId: "run-9999" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("unknown_target");
    expect(() => reader.approvalStatus({ kind: "run", runId: "run-9999" })).toThrow(ApprovalStoreError);
  });
  it("derives no status from a store that does not verify", () => {
    const reader = ApprovalReader.fromBytes(store(base()).replace("Reviewed.", "Edited."), resolver);
    expect(reader.verify().mismatches.map((m) => m.kind)).toEqual(["modified"]);
    const r = reader.statusOf({ kind: "run", runId: "run-0001" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("store_invalid");
  });
  it("verify reports modified, missing and chain_break with the sequence number and writes nothing", () => {
    const text = store(base(), base({ decision: "rejected", supersedes: 1 }), base({ target: claim }));
    const lines = text.split("\n").slice(0, -1);
    const input = `${lines[0]}\n${lines[2]}\n`;
    const bytes = new TextEncoder().encode(input);
    const copy = bytes.slice();
    const report = ApprovalReader.fromBytes(bytes, resolver).verify();
    expect(report.mismatches.map((m) => `${m.seq}:${m.kind}`)).toEqual(["2:missing", "3:chain_break"]);
    expect(bytes).toEqual(copy);
  });
  it("the adapter satisfies ApprovalStatusReader and feeds readFacts", () => {
    const evidence = new EvidenceStore();
    const created = evidence.createClaimRevision({ claimId: "clm-0001", reason: "initial", aiClaim: { effect: "x" }, aiOutputRecordId: "rec-000001" });
    if (!created.ok) throw new Error("setup");
    const rev = created.value.claimRevisionId;
    const target = { kind: "claim_revision", run_id: "run-0001", claim_revision_id: rev } as const;
    const reader = ApprovalReader.fromBytes(store(), { resolves: () => true });
    const none = readFacts(evidence, "run-0001", rev, asApprovalStatusReader(reader));
    expect(none.ok && none.value.approvalStatus).toBe("none");
    const approved = ApprovalReader.fromBytes(
      (() => {
        const r = appendApproval("", base({ target }), { resolves: () => true });
        if (!r.ok) throw new Error("setup");
        return r.value.text;
      })(),
      { resolves: () => true },
    );
    const facts = readFacts(evidence, "run-0001", rev, asApprovalStatusReader(approved));
    expect(facts.ok && facts.value.approvalStatus).toBe("approved");
    expect(facts.ok && facts.value.origin).toBe("ai-inferred");
    expect(Object.keys(asApprovalStatusReader(approved))).toEqual(["approvalStatus"]);
  });
  it("fromFile reads read-only, reports a stale .tmp, and treats a missing file as unreadable unless allowed", () => {
    const dir = mkdtempSync(join(tmpdir(), "approvals-"));
    try {
      const file = join(dir, "approvals.jsonl");
      const text = store(base());
      writeFileSync(file, text);
      const ok = ApprovalReader.fromFile(file, resolver);
      expect(ok.ok && ok.value.verify().ok).toBe(true);
      expect(readFileSync(file, "utf8")).toBe(text);
      writeFileSync(`${file}.tmp`, "partial");
      const stale = ApprovalReader.fromFile(file, resolver);
      expect(stale.ok && stale.value.verify().ok).toBe(false);
      const missing = ApprovalReader.fromFile(join(dir, "nope.jsonl"), resolver);
      expect(!missing.ok && missing.error.kind).toBe("unreadable");
      const allowed = ApprovalReader.fromFile(join(dir, "nope.jsonl"), resolver, { allowMissing: true });
      expect(allowed.ok && allowed.value.approvalStatus({ kind: "run", runId: "run-0001" })).toBe("none");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("golden vectors (data files for the PowerShell writer)", () => {
  it("the committed files equal what the reference generates", () => {
    for (const [name, content] of Object.entries(generateApprovalVectors())) {
      expect(readVector(name), name).toEqual(JSON.parse(JSON.stringify(content)));
    }
  });
  it("valid chains: canonical bytes and hashes recompute independently, and the reader accepts them", () => {
    const v = readVector("valid-chains.json");
    expect(v.genesisHash).toBe("0".repeat(64));
    for (const c of v.cases) {
      let prev = GENESIS_HASH;
      c.lines.forEach((l: any, i: number) => {
        expect(l.seq).toBe(i + 1);
        expect(l.fields.prev_hash).toBe(prev);
        expect(Buffer.from(l.hashInput, "utf8").toString("hex")).toBe(l.hashInputHex);
        expect(createHash("sha256").update(Buffer.from(l.hashInputHex, "hex")).digest("hex")).toBe(l.hash);
        expect(l.line).toContain(`"hash":"${l.hash}"`);
        expect(JSON.parse(l.line)).toEqual({ ...l.fields, hash: l.hash });
        prev = l.hash;
      });
      expect(c.storeText).toBe(c.lines.map((l: any) => `${l.line}\n`).join(""));
      expect(Buffer.from(c.storeText, "utf8").toString("hex")).toBe(c.storeTextUtf8Hex);
      const report = analyzeStore(c.storeText).report;
      expect(report.ok, c.name).toBe(true);
      expect(report.lineCount).toBe(c.lines.length);
    }
  });
  it("candidate validation: every case yields exactly the hand-written field list, and a rejection changes nothing", () => {
    const v = readVector("candidate-validation.json");
    const known = new Set<string>(v.context.knownRuns);
    const claims: { run_id: string; claim_revision_id: string }[] = v.context.knownClaimRevisions;
    const r: TargetResolver = {
      resolves: (t) =>
        t.kind === "gate" || (t.kind === "run" ? known.has(t.runId) : claims.some((c) => c.run_id === t.runId && c.claim_revision_id === t.claimRevisionId)),
    };
    const loaded = loadVerifiedState(v.context.storeText);
    if (!loaded.ok) throw new Error("context store must verify");
    for (const c of v.cases) {
      const res = validateApprovalCandidate(c.candidate, { state: loaded.value, resolver: r });
      expect(res.ok ? [] : fieldNames(res.error), c.name).toEqual(c.expectedFields);
      const appended = appendApproval(v.context.storeText, c.candidate, r);
      expect(appended.ok, c.name).toBe(c.expectedFields.length === 0);
    }
    expect(toApprovalTarget({ kind: "gate", gate_id: "m6-start" })).toEqual({ kind: "gate", gateId: "m6-start" });
  });
  it("tamper cases: verification matches the hand-written findings", () => {
    const v = readVector("tamper-cases.json");
    for (const c of v.cases) {
      const { report } = analyzeStore(c.storeText, c.anchor === undefined ? {} : { anchor: c.anchor });
      expect(report.ok, c.name).toBe(c.expectedOk);
      expect(report.mismatches.map((m) => ({ seq: m.seq, kind: m.kind })), c.name).toEqual(c.expectedMismatches);
      expect(report.ruleViolations.map((x) => ({ seq: x.seq, rule: x.rule })), c.name).toEqual(c.expectedRuleViolations);
    }
  });
});
