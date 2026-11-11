// Property 32 (task 1.22): Approval_Store records round-trip and the chain detects tampering.
// Validates: Requirements 23.2, 23.9, 23.11
//
// SCOPE NOTE: the hash chain is tamper DETECTION only. It is not write control (that is the OS/container
// permission set) and it is not authenticity of the approver (`recorded_by` is a declaration). It also cannot see
// removal of the file tail, or a full rewrite with recomputed hashes, without an external anchor. This test asserts
// exactly that: tail truncation is detected WITH an anchor and is documented as undetected WITHOUT one.
// Fixed seed, bounded run counts. Verification is pure: it takes text/bytes and has no write path.
import * as fc from "fast-check";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalBytes, parseCanonical } from "../src/canonical/index.js";
import { ApprovalReader, GENESIS_HASH, analyzeStore } from "../src/approval/index.js";
import type { ChainAnchor, MismatchKind, StoreLine, VerifyReport } from "../src/approval/index.js";
import { appendApproval, appendStoreRejection, computeLineHash, serializeLine } from "../src/approval/tooling.js";
import { vectorResolver } from "../src/approval/vectors.js";

const SEED = 32_032;
const NUM_RUNS = 100;
const TIMEOUT_MS = 120_000;
const resolver = vectorResolver();
const KINDS: readonly MismatchKind[] = ["modified", "missing", "chain_break"];

// ---------------------------------------------------------------------------------------------------------------
// Valid sequence generator. Abstract steps are turned into real lines by the chain builder (appendApproval /
// appendStoreRejection), so every generated sequence is valid by construction (including `supersedes` rules).

type Step =
  | { t: "approval"; target: number; decision: number; approver: string; rationale: string; ts: number; actor: number; sup: number | null }
  | { t: "rejection"; reason: string; attempted: number | null };

const word = (re: RegExp): fc.Arbitrary<string> => fc.stringMatching(re);
const stepArb: fc.Arbitrary<Step> = fc.oneof(
  { weight: 4, arbitrary: fc.record({
    t: fc.constant("approval" as const),
    target: fc.nat(4),
    decision: fc.nat(2),
    approver: word(/^[A-Za-z][A-Za-z ]{0,20}$/),
    rationale: word(/^[A-Za-z0-9][A-Za-z0-9 .,]{0,60}$/),
    ts: fc.nat(2),
    actor: fc.nat(1),
    sup: fc.option(fc.nat(50), { nil: null }),
  }) },
  { weight: 1, arbitrary: fc.record({
    t: fc.constant("rejection" as const),
    reason: word(/^[a-z]{1,30}$/),
    attempted: fc.option(fc.integer({ min: 1, max: 99 }), { nil: null }),
  }) },
);
const stepsArb = (minLength: number): fc.Arbitrary<Step[]> => fc.array(stepArb, { minLength, maxLength: 8 });

const TARGETS = [
  { kind: "run", run_id: "run-0001" },
  { kind: "claim_revision", run_id: "run-0001", claim_revision_id: "clm-0001-r1" },
  { kind: "gate", gate_id: "start-implementation" },
  { kind: "gate", gate_id: "m6-start" },
  { kind: "gate", gate_id: "transmit-source" },
] as const;
const DECISIONS = ["approved", "rejected", "needs_changes"] as const;
const STAMPS = ["2025-03-04T05:06:07.000+09:00", "2025-03-04T05:06:07Z", "2026-12-31T23:59:59.123-05:30"] as const;
const ACTORS = ["human", "kiro-development-agent"] as const;

interface Built {
  text: string;
  lines: StoreLine[];
}

function build(steps: readonly Step[]): Built {
  let text = "";
  const lines: StoreLine[] = [];
  const superseded = new Set<number>();
  for (const s of steps) {
    if (s.t === "approval") {
      const target = TARGETS[s.target % TARGETS.length]!;
      const eligible = lines.filter(
        (l) => l.type === "approval" && JSON.stringify(l.target) === JSON.stringify(target) && !superseded.has(l.seq),
      );
      const candidate: Record<string, unknown> = {
        approver: s.approver,
        timestamp: STAMPS[s.ts % STAMPS.length]!,
        target,
        decision: DECISIONS[s.decision % DECISIONS.length]!,
        rationale: s.rationale,
        recorded_by: ACTORS[s.actor % ACTORS.length]!,
      };
      if (s.sup !== null && eligible.length > 0) {
        const pick = eligible[s.sup % eligible.length]!;
        candidate["supersedes"] = pick.seq;
        superseded.add(pick.seq);
      }
      const r = appendApproval(text, candidate, resolver);
      if (!r.ok) throw new Error(`generator produced an invalid approval: ${JSON.stringify(r.error)}`);
      text = r.value.text;
      lines.push(r.value.line);
    } else {
      const r = appendStoreRejection(text, s.reason, s.attempted ?? undefined);
      if (!r.ok) throw new Error(`generator produced an invalid rejection: ${JSON.stringify(r.error)}`);
      text = r.value.text;
      lines.push(r.value.line);
    }
  }
  return { text, lines };
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

const textLines = (text: string): string[] => text.split("\n").slice(0, -1);
const joinLines = (ls: readonly string[]): string => ls.map((l) => `${l}\n`).join("");
const anchorOf = (lines: readonly StoreLine[]): ChainAnchor => {
  const last = lines[lines.length - 1]!;
  return { seq: last.seq, hash: last.hash };
};
const verify = (input: string | Uint8Array, anchor?: ChainAnchor): VerifyReport =>
  ApprovalReader.fromBytes(input, resolver, anchor === undefined ? {} : { anchor }).verify();
const has = (r: VerifyReport, seq: number, kind: MismatchKind): boolean => r.mismatches.some((m) => m.seq === seq && m.kind === kind);

/** Edits one line (as parsed JSON), optionally recomputing its own hash. Returns the new line text without LF. */
function editLine(lineText: string, edit: (o: Record<string, unknown>) => void, recompute: boolean): string {
  const o = JSON.parse(lineText) as Record<string, unknown>;
  edit(o);
  if (recompute) o["hash"] = computeLineHash(o);
  return serializeLine(o as unknown as StoreLine).slice(0, -1);
}

/** Content edit that always changes the line: approver/reason gets a suffix. */
const editContent = (o: Record<string, unknown>): void => {
  if (o["type"] === "approval") o["approver"] = `${String(o["approver"])}x`;
  else o["reason"] = `${String(o["reason"])}x`;
};

/** Reports must be well-formed: any non-ok report names at least one finding of a known kind with seq >= 1. */
function expectWellFormedFailure(r: VerifyReport): void {
  expect(r.ok).toBe(false);
  expect(r.mismatches.length + r.ruleViolations.length).toBeGreaterThan(0);
  for (const m of r.mismatches) {
    expect(KINDS).toContain(m.kind);
    expect(m.seq).toBeGreaterThanOrEqual(1);
  }
}

const run = (prop: fc.IPropertyWithHooks<any>): void =>
  fc.assert(prop, { seed: SEED, numRuns: NUM_RUNS, endOnFailure: false });

// ---------------------------------------------------------------------------------------------------------------

describe("Property 32: Approval_Store round trip and tamper detection (task 1.22)", () => {
  it("valid sequences round-trip: build -> parse -> identical canonical bytes and equal records; seq from 1; genesis; verify ok", () => {
    run(fc.property(stepsArb(1), (steps) => {
      const { text, lines } = build(steps);
      const texts = textLines(text);
      expect(texts.length).toBe(lines.length);
      let rebuilt = "";
      texts.forEach((t, i) => {
        const parsed = parseCanonical(t);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value).toEqual(lines[i]);
        expect(Buffer.from(canonicalBytes(parsed.value)).toString("utf8")).toBe(t);
        expect(serializeLine(parsed.value as unknown as StoreLine)).toBe(`${t}\n`);
        rebuilt += `${t}\n`;
      });
      expect(rebuilt).toBe(text);
      expect(lines.map((l) => l.seq)).toEqual(lines.map((_, i) => i + 1));
      expect(lines[0]!.prev_hash).toBe(GENESIS_HASH);
      lines.forEach((l, i) => {
        if (i > 0) expect(l.prev_hash).toBe(lines[i - 1]!.hash);
        expect(l.hash).toBe(computeLineHash(l as unknown as Record<string, unknown>));
      });
      const reader = ApprovalReader.fromBytes(new TextEncoder().encode(text), resolver);
      expect(reader.verify()).toEqual({ ok: true, lineCount: lines.length, mismatches: [], ruleViolations: [], tailTruncation: "not_checked" });
      expect(reader.approvals()).toEqual(lines.filter((l) => l.type === "approval"));
      expect(analyzeStore(text).state.lines).toEqual(lines);
      // An anchor at the true head does not disturb an intact store.
      expect(verify(text, anchorOf(lines)).ok).toBe(true);
    }));
  }, TIMEOUT_MS);

  it("a single byte flip is detected as modified/missing/chain_break near the affected record", () => {
    run(fc.property(stepsArb(2), fc.nat(), fc.integer({ min: 1, max: 127 }), (steps, posSeed, mask) => {
      const { text } = build(steps);
      const bytes = new TextEncoder().encode(text); // generated content is ASCII; mask <= 127 keeps it ASCII
      const pos = posSeed % bytes.length;
      const lineNo = text.slice(0, pos).split("\n").length; // 1-based line holding the flipped byte
      const mutated = Uint8Array.from(bytes);
      mutated[pos] = mutated[pos]! ^ mask;
      const r = verify(mutated);
      expectWellFormedFailure(r);
      // At least one finding names the damaged record (or its direct neighbour: a flipped LF merges two lines).
      expect(r.mismatches.some((m) => m.seq >= Math.max(1, lineNo - 1) && m.seq <= lineNo + 1)).toBe(true);
    }));
  }, TIMEOUT_MS);

  it("deleting a non-last line is reported as missing for that sequence number", () => {
    run(fc.property(stepsArb(2), fc.nat(), (steps, iSeed) => {
      const { text, lines } = build(steps);
      const ls = textLines(text);
      const i = iSeed % (lines.length - 1); // not the last line (tail removal is covered separately)
      const r = verify(joinLines(ls.filter((_, k) => k !== i)));
      expectWellFormedFailure(r);
      expect(has(r, i + 1, "missing")).toBe(true);
    }));
  }, TIMEOUT_MS);

  it("reordering (swapping any two lines) is detected at the first displaced sequence number", () => {
    run(fc.property(stepsArb(2), fc.nat(), fc.nat(), (steps, aSeed, bSeed) => {
      const { text, lines } = build(steps);
      const ls = textLines(text);
      const a = aSeed % lines.length;
      const b = (a + 1 + (bSeed % (lines.length - 1))) % lines.length;
      const [i, j] = a < b ? [a, b] : [b, a];
      const swapped = [...ls];
      swapped[i] = ls[j]!;
      swapped[j] = ls[i]!;
      const r = verify(joinLines(swapped));
      expectWellFormedFailure(r);
      expect(has(r, i + 1, "missing")).toBe(true);
      expect(r.mismatches.some((m) => m.kind === "chain_break")).toBe(true);
    }));
  }, TIMEOUT_MS);

  it("duplicating a line is detected as chain_break at the repeated sequence number", () => {
    run(fc.property(stepsArb(1), fc.nat(), (steps, iSeed) => {
      const { text, lines } = build(steps);
      const ls = textLines(text);
      const i = iSeed % lines.length;
      const dup = [...ls.slice(0, i + 1), ls[i]!, ...ls.slice(i + 1)];
      const r = verify(joinLines(dup));
      expectWellFormedFailure(r);
      expect(has(r, i + 1, "chain_break")).toBe(true);
    }));
  }, TIMEOUT_MS);

  it("seq change WITHOUT hash recompute is modified at the edited seq; WITH recompute it is missing/chain_break", () => {
    run(fc.property(stepsArb(1), fc.nat(), fc.integer({ min: 1, max: 5 }), fc.boolean(), (steps, iSeed, delta, up) => {
      const { text, lines } = build(steps);
      const ls = textLines(text);
      const i = iSeed % lines.length;
      const oldSeq = i + 1;
      const newSeq = up || oldSeq - delta < 1 ? oldSeq + delta : oldSeq - delta;

      const plain = [...ls];
      plain[i] = editLine(ls[i]!, (o) => { o["seq"] = newSeq; }, false);
      const r1 = verify(joinLines(plain));
      expectWellFormedFailure(r1);
      expect(has(r1, newSeq, "modified")).toBe(true);

      const rehashed = [...ls];
      rehashed[i] = editLine(ls[i]!, (o) => { o["seq"] = newSeq; }, true);
      const r2 = verify(joinLines(rehashed));
      expectWellFormedFailure(r2);
      expect(has(r2, newSeq > oldSeq ? oldSeq : newSeq, newSeq > oldSeq ? "missing" : "chain_break")).toBe(true);
    }));
  }, TIMEOUT_MS);

  it("prev_hash change WITHOUT hash recompute is modified + chain_break; WITH recompute it is chain_break", () => {
    const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/);
    run(fc.property(stepsArb(1), fc.nat(), hex64, (steps, iSeed, fresh) => {
      const { text, lines } = build(steps);
      const ls = textLines(text);
      const i = iSeed % lines.length;
      const seq = i + 1;
      const original = lines[i]!.prev_hash;
      const replacement = fresh === original ? "f".repeat(64) : fresh;

      const plain = [...ls];
      plain[i] = editLine(ls[i]!, (o) => { o["prev_hash"] = replacement; }, false);
      const r1 = verify(joinLines(plain));
      expectWellFormedFailure(r1);
      expect(has(r1, seq, "modified")).toBe(true);
      expect(has(r1, seq, "chain_break")).toBe(true);

      const rehashed = [...ls];
      rehashed[i] = editLine(ls[i]!, (o) => { o["prev_hash"] = replacement; }, true);
      const r2 = verify(joinLines(rehashed));
      expectWellFormedFailure(r2);
      expect(has(r2, seq, "chain_break")).toBe(true);
    }));
  }, TIMEOUT_MS);

  it("a field edit is modified at that seq without recompute; with recompute it breaks the next link (last line: only an anchor sees it)", () => {
    run(fc.property(stepsArb(1), fc.nat(), (steps, iSeed) => {
      const { text, lines } = build(steps);
      const ls = textLines(text);
      const i = iSeed % lines.length;
      const seq = i + 1;

      const plain = [...ls];
      plain[i] = editLine(ls[i]!, editContent, false);
      const r1 = verify(joinLines(plain));
      expectWellFormedFailure(r1);
      expect(has(r1, seq, "modified")).toBe(true);

      // Complete edit incl. its own hash: for a non-last line the successor's prev_hash no longer matches.
      const rehashed = [...ls];
      rehashed[i] = editLine(ls[i]!, editContent, true);
      const rehashedText = joinLines(rehashed);
      const r2 = verify(rehashedText);
      if (i < lines.length - 1) {
        expectWellFormedFailure(r2);
        expect(has(r2, seq + 1, "chain_break")).toBe(true);
      } else {
        // Documented limit: rewriting the head with a recomputed hash is invisible without an external anchor ...
        expect(r2.ok).toBe(true);
        // ... and visible with one.
        const r3 = verify(rehashedText, anchorOf(lines));
        expectWellFormedFailure(r3);
        expect(has(r3, seq, "modified")).toBe(true);
      }
    }));
  }, TIMEOUT_MS);

  it("tail truncation: detected WITH an external anchor (missing), documented as UNDETECTED without one", () => {
    run(fc.property(stepsArb(2), fc.integer({ min: 1, max: 7 }), (steps, cutSeed) => {
      const { text, lines } = build(steps);
      const ls = textLines(text);
      const cut = 1 + ((cutSeed - 1) % (lines.length - 1)); // 1..n-1 lines removed, at least one line kept
      const kept = ls.slice(0, ls.length - cut);
      expect(kept.length).toBeGreaterThanOrEqual(1);
      const truncated = joinLines(kept);
      const anchor = anchorOf(lines);

      // Without an anchor a chain cannot see its own tail: the prefix is a valid chain. This is the documented limit.
      expect(verify(truncated).ok).toBe(true);
      // With the anchor the removed head is reported as missing at the anchored sequence number.
      const r = verify(truncated, anchor);
      expectWellFormedFailure(r);
      expect(has(r, anchor.seq, "missing")).toBe(true);
      // Emptying the file entirely behaves the same way.
      expect(verify("").ok).toBe(true);
      expect(has(verify("", anchor), anchor.seq, "missing")).toBe(true);
    }));
  }, TIMEOUT_MS);

  it("verification never writes: file bytes, mtime and directory listing are unchanged, intact or tampered", () => {
    const dir = mkdtempSync(join(tmpdir(), "approval-chain-"));
    try {
      run(fc.property(stepsArb(2), fc.boolean(), (steps, tamper) => {
        const { text, lines } = build(steps);
        const content = tamper ? joinLines(textLines(text).slice(1)) : text;
        const file = join(dir, "approvals.jsonl");
        writeFileSync(file, content);
        const before = { bytes: readFileSync(file), mtime: statSync(file).mtimeMs, listing: readdirSync(dir).sort() };
        const reader = ApprovalReader.fromFile(file, resolver, { anchor: anchorOf(lines) });
        expect(reader.ok).toBe(true);
        if (!reader.ok) return;
        const report = reader.value.verify();
        expect(report.ok).toBe(!tamper);
        reader.value.verify();
        expect(readFileSync(file).equals(before.bytes)).toBe(true);
        expect(statSync(file).mtimeMs).toBe(before.mtime);
        expect(readdirSync(dir).sort()).toEqual(before.listing); // no temp or sidecar file appeared
      }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);
});
