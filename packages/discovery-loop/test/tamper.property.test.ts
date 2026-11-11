// Property 15 (task 1.13): Tampering with a Run directory is always detected, and verification does not write.
// Validates: Requirements 12.4, 12.6, 12.8, 12.9, 12.10, 12.11
// Runs on the in-memory file system with a spy that records every mutating port call. Fixed seed, bounded run count.
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  COMPLETION_MARKER_FILE, GENESIS_HASH, MANIFEST_FILE, RECORDS_FILE, acceptRun, canonicalJson, joinPath, verifyRunDirectory,
  type Json, type MismatchKind, type RunAcceptance, type VerificationReport,
} from "../src/index.js";
import { RUN_DIR, SpyFileSystem, bytes, manifestInput, openStore, sha256, text, writeCompletionMarker } from "./helpers/runFixtures.js";

const SEED = 15_015;
const NUM_RUNS = 150;
const TIMEOUT_MS = 120_000;
const REC = joinPath(RUN_DIR, RECORDS_FILE);
const MANIFEST = joinPath(RUN_DIR, MANIFEST_FILE);
const MARKER = joinPath(RUN_DIR, COMPLETION_MARKER_FILE);

// ---------------------------------------------------------------------------------------------------------------
// Sealed Run generator

interface RunSpec {
  items: { kind: "run_started" | "error"; n: number; s: string }[];
  aiOutputs: string[];
  extraBlobs: string[];
}
const word = fc.stringMatching(/^[a-z0-9]{1,12}$/);
const runSpecArb: fc.Arbitrary<RunSpec> = fc.record({
  items: fc.array(
    fc.record({ kind: fc.constantFrom("run_started" as const, "error" as const), n: fc.nat(1000), s: word }),
    { minLength: 1, maxLength: 5 },
  ),
  aiOutputs: fc.array(word, { maxLength: 2 }),
  extraBlobs: fc.array(word, { maxLength: 2 }),
});

async function buildRun(spec: RunSpec): Promise<{ fs: SpyFileSystem; manifestSha256: string }> {
  const fs = new SpyFileSystem();
  const store = await openStore(fs);
  for (const it of spec.items) expect((await store.append(it.kind, { n: it.n, s: it.s })).ok).toBe(true);
  for (const o of spec.aiOutputs) expect((await store.putAiOutput(bytes(o))).ok).toBe(true);
  for (const b of spec.extraBlobs) expect((await store.putBlob(bytes(`blob-${b}`))).ok).toBe(true);
  const sealed = await store.seal(manifestInput());
  if (!sealed.ok) throw new Error("seal failed");
  await writeCompletionMarker(fs, RUN_DIR);
  return { fs, manifestSha256: sealed.value.sha256 };
}

// ---------------------------------------------------------------------------------------------------------------
// Tampering generator. Indices are reduced modulo the real size when applied.

type Tamper =
  | { t: "flip_records"; pos: number; mask: number }
  | { t: "flip_blob"; which: number; pos: number; mask: number }
  | { t: "flip_manifest"; pos: number; mask: number }
  | { t: "truncate_records"; at: number }
  | { t: "truncate_blob"; which: number; at: number }
  | { t: "delete_records" }
  | { t: "delete_blob"; which: number }
  | { t: "add_unlisted"; where: "root" | "blobs" | "nested"; name: string }
  | { t: "reorder_lines"; i: number }
  | { t: "drop_line"; i: number }
  | { t: "duplicate_line"; i: number }
  | { t: "change_seq"; i: number; seq: number; rehash: boolean }
  | { t: "change_prev_hash"; i: number; prev: string; rehash: boolean }
  | { t: "remove_manifest" }
  | { t: "remove_marker" }
  | { t: "change_marker"; content: string };

const idx = fc.nat(100_000);
const tamperArb: fc.Arbitrary<Tamper> = fc.oneof(
  fc.record({ t: fc.constant("flip_records" as const), pos: idx, mask: fc.integer({ min: 1, max: 255 }) }),
  fc.record({ t: fc.constant("flip_blob" as const), which: idx, pos: idx, mask: fc.integer({ min: 1, max: 255 }) }),
  fc.record({ t: fc.constant("flip_manifest" as const), pos: idx, mask: fc.integer({ min: 1, max: 255 }) }),
  fc.record({ t: fc.constant("truncate_records" as const), at: idx }),
  fc.record({ t: fc.constant("truncate_blob" as const), which: idx, at: idx }),
  fc.record({ t: fc.constant("delete_records" as const) }),
  fc.record({ t: fc.constant("delete_blob" as const), which: idx }),
  fc.record({ t: fc.constant("add_unlisted" as const), where: fc.constantFrom("root" as const, "blobs" as const, "nested" as const), name: word }),
  fc.record({ t: fc.constant("reorder_lines" as const), i: idx }),
  fc.record({ t: fc.constant("drop_line" as const), i: idx }),
  fc.record({ t: fc.constant("duplicate_line" as const), i: idx }),
  fc.record({ t: fc.constant("change_seq" as const), i: idx, seq: fc.nat(50), rehash: fc.boolean() }),
  fc.record({ t: fc.constant("change_prev_hash" as const), i: idx, prev: fc.stringMatching(/^[0-9a-f]{64}$/), rehash: fc.boolean() }),
  fc.record({ t: fc.constant("remove_manifest" as const) }),
  fc.record({ t: fc.constant("remove_marker" as const) }),
  fc.record({ t: fc.constant("change_marker" as const), content: fc.string({ maxLength: 80 }) }),
);

const blobPaths = (fs: SpyFileSystem): string[] => fs.allFiles().filter((p) => p.startsWith(`${RUN_DIR}/blobs/`));
const flipByte = (b: Uint8Array, pos: number, mask: number): Uint8Array => {
  const out = new Uint8Array(b);
  out[pos % out.length] = (out[pos % out.length] as number) ^ mask;
  return out;
};
const linesOf = (fs: SpyFileSystem): string[] => text(fs.peek(REC)).split("\n").filter((l) => l !== "");
const putLines = (fs: SpyFileSystem, lines: string[]): void => fs.poke(REC, bytes(lines.map((l) => `${l}\n`).join("")));
const rehashed = (rec: Record<string, Json>): string => {
  const { hash: _drop, ...head } = rec;
  return JSON.stringify({ ...head, hash: sha256(canonicalJson(head as Json)) });
};

interface Expect {
  /** Mismatches that must be present in the plain verification report (no marker requirement). */
  mismatches?: { where: string; kind: MismatchKind }[];
  /** Some chain_break must be present (the exact record id depends on the edit). */
  anyChainBreak?: boolean;
  incompleteReason?: string;
  acceptReason?: string;
  manifestChanged?: boolean;
  /** Verification (without marker requirement) still succeeds; only acceptance must refuse. */
  verifyStillSucceeds?: boolean;
}

/** Applies one tampering to the sealed Run and returns what verification must report. */
function apply(fs: SpyFileSystem, t: Tamper): Expect {
  switch (t.t) {
    case "flip_records":
      fs.poke(REC, flipByte(fs.peek(REC) as Uint8Array, t.pos, t.mask));
      return { mismatches: [{ where: RECORDS_FILE, kind: "modified" }] };
    case "flip_blob": {
      const ps = blobPaths(fs);
      const p = ps[t.which % ps.length];
      if (p === undefined) return apply(fs, { t: "flip_records", pos: t.pos, mask: t.mask });
      fs.poke(p, flipByte(fs.peek(p) as Uint8Array, t.pos, t.mask));
      return { mismatches: [{ where: p.slice(RUN_DIR.length + 1), kind: "modified" }] };
    }
    case "flip_manifest":
      fs.poke(MANIFEST, flipByte(fs.peek(MANIFEST) as Uint8Array, t.pos, t.mask));
      return { manifestChanged: true };
    case "truncate_records": {
      const b = fs.peek(REC) as Uint8Array;
      fs.poke(REC, b.slice(0, t.at % b.length));
      return { mismatches: [{ where: RECORDS_FILE, kind: "modified" }], anyChainBreak: true };
    }
    case "truncate_blob": {
      const ps = blobPaths(fs);
      const p = ps[t.which % ps.length];
      if (p === undefined) return apply(fs, { t: "truncate_records", at: t.at });
      const b = fs.peek(p) as Uint8Array;
      fs.poke(p, b.slice(0, t.at % b.length));
      return { mismatches: [{ where: p.slice(RUN_DIR.length + 1), kind: "modified" }] };
    }
    case "delete_records":
      void fs.removeFile(REC);
      return { mismatches: [{ where: RECORDS_FILE, kind: "missing" }], anyChainBreak: true };
    case "delete_blob": {
      const ps = blobPaths(fs);
      const p = ps[t.which % ps.length];
      if (p === undefined) return apply(fs, { t: "delete_records" });
      void fs.removeFile(p);
      return { mismatches: [{ where: p.slice(RUN_DIR.length + 1), kind: "missing" }] };
    }
    case "add_unlisted": {
      const rel = t.where === "root" ? `extra-${t.name}.txt` : t.where === "blobs" ? `blobs/stray-${t.name}` : `sub/${t.name}/deep.bin`;
      const abs = joinPath(RUN_DIR, rel);
      fs.addDir(abs.slice(0, abs.lastIndexOf("/")));
      fs.poke(abs, bytes("not listed"));
      return { mismatches: [{ where: rel, kind: "unlisted" }] };
    }
    case "reorder_lines": {
      const lines = linesOf(fs);
      if (lines.length < 2) return apply(fs, { t: "duplicate_line", i: t.i });
      const i = t.i % (lines.length - 1);
      [lines[i], lines[i + 1]] = [lines[i + 1] as string, lines[i] as string];
      putLines(fs, lines);
      return { mismatches: [{ where: RECORDS_FILE, kind: "modified" }], anyChainBreak: true };
    }
    case "drop_line": {
      const lines = linesOf(fs);
      lines.splice(t.i % lines.length, 1);
      putLines(fs, lines);
      return { mismatches: [{ where: RECORDS_FILE, kind: "modified" }], anyChainBreak: true };
    }
    case "duplicate_line": {
      const lines = linesOf(fs);
      const i = t.i % lines.length;
      lines.splice(i, 0, lines[i] as string);
      putLines(fs, lines);
      return { mismatches: [{ where: RECORDS_FILE, kind: "modified" }], anyChainBreak: true };
    }
    case "change_seq":
    case "change_prev_hash": {
      const lines = linesOf(fs);
      const i = t.i % lines.length;
      const rec = JSON.parse(lines[i] as string) as Record<string, Json>;
      if (t.t === "change_seq") rec["seq"] = t.seq === rec["seq"] ? t.seq + 1 : t.seq;
      else rec["prevHash"] = t.prev === rec["prevHash"] ? GENESIS_HASH.replace(/0$/, "1") : t.prev;
      lines[i] = t.rehash ? rehashed(rec) : JSON.stringify(rec);
      putLines(fs, lines);
      return { mismatches: [{ where: RECORDS_FILE, kind: "modified" }], anyChainBreak: true };
    }
    case "remove_manifest":
      void fs.removeFile(MANIFEST);
      return { incompleteReason: "no_manifest", acceptReason: "no_manifest" };
    case "remove_marker":
      void fs.removeFile(MARKER);
      return { verifyStillSucceeds: true, acceptReason: "no_completion_marker" };
    case "change_marker": {
      const real = sha256(fs.peek(MANIFEST) as Uint8Array);
      const content = t.content.replace(/\r?\n$/, "") === real ? `${t.content}x` : t.content;
      fs.poke(MARKER, bytes(content));
      return { verifyStillSucceeds: true, acceptReason: "marker_mismatch" };
    }
  }
}

const has = (r: VerificationReport, m: { where: string; kind: MismatchKind }): boolean =>
  r.mismatches.some((x) => x.where === m.where && x.kind === m.kind);

function snapshot(fs: SpyFileSystem): Map<string, string> {
  return new Map(fs.allFiles().map((p) => [p, Buffer.from(fs.peek(p) as Uint8Array).toString("base64")]));
}

// ---------------------------------------------------------------------------------------------------------------

describe(`Property 15: tamper detection and read-only verification (seed ${SEED}, numRuns ${NUM_RUNS})`, () => {
  it("accepts every untampered sealed Run, with seq from 1 without gaps and a genesis predecessor", async () => {
    await fc.assert(
      fc.asyncProperty(runSpecArb, async (spec) => {
        const { fs, manifestSha256 } = await buildRun(spec);
        fs.reset();
        const before = snapshot(fs);
        const verified = await verifyRunDirectory(fs, RUN_DIR, { requireMarker: true });
        const accepted = await acceptRun(fs, RUN_DIR);
        expect(verified).toMatchObject({ result: "success", incomplete: false, mismatches: [], manifestSha256 });
        expect(accepted.accepted).toBe(true);
        const recs = linesOf(fs).map((l) => JSON.parse(l) as { seq: number; prevHash: string; hash: string });
        expect(recs.map((r) => r.seq)).toEqual(recs.map((_, i) => i + 1));
        expect(recs[0]?.prevHash).toBe(GENESIS_HASH);
        recs.slice(1).forEach((r, i) => expect(r.prevHash).toBe((recs[i] as { hash: string }).hash));
        expect(fs.writes).toEqual([]);
        expect(snapshot(fs)).toEqual(before);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("detects any single tampering with the matching kind (or refuses acceptance), and never writes", async () => {
    await fc.assert(
      fc.asyncProperty(runSpecArb, tamperArb, async (spec, tamper) => {
        const { fs, manifestSha256 } = await buildRun(spec);
        const expected = apply(fs, tamper);
        await Promise.resolve(); // removeFile on the memory port settles in a microtask
        fs.reset();
        const before = snapshot(fs);

        const report = await verifyRunDirectory(fs, RUN_DIR);
        const again = await verifyRunDirectory(fs, RUN_DIR, { requireMarker: true });
        const accepted: RunAcceptance = await acceptRun(fs, RUN_DIR);

        // Never accepted, always reported as incomplete.
        expect(accepted.accepted).toBe(false);
        if (!accepted.accepted) {
          expect(accepted.status).toBe("incomplete");
          if (expected.acceptReason !== undefined) expect(accepted.reason).toBe(expected.acceptReason);
        }
        // Verification is deterministic.
        expect(await verifyRunDirectory(fs, RUN_DIR)).toEqual(report);

        if (expected.incompleteReason !== undefined) {
          expect(report).toMatchObject({ result: "failure", incomplete: true, incompleteReason: expected.incompleteReason });
        }
        if (expected.verifyStillSucceeds === true) {
          expect(report).toMatchObject({ result: "success", incomplete: false });
          expect(again).toMatchObject({ result: expected.acceptReason === "no_completion_marker" ? "failure" : "success" });
        }
        if (expected.mismatches !== undefined) {
          expect(report.result).toBe("failure");
          expect(report.incomplete).toBe(false);
          for (const m of expected.mismatches) expect(has(report, m), `${tamper.t}: ${JSON.stringify(m)} in ${JSON.stringify(report.mismatches)}`).toBe(true);
        }
        if (expected.anyChainBreak === true) {
          expect(report.mismatches.some((m) => m.kind === "chain_break"), `${tamper.t}: chain_break`).toBe(true);
        }
        if (expected.manifestChanged === true) {
          expect(report.manifestSha256).not.toBe(manifestSha256);
          // A changed manifest is incomplete, a failure, or (if still valid) refused by the marker comparison.
          expect(report.incomplete || report.result === "failure" || (!accepted.accepted && accepted.reason === "marker_mismatch")).toBe(true);
        }

        // Verification and acceptance never call a mutating port method and leave every byte as it was.
        expect(fs.writes).toEqual([]);
        expect(snapshot(fs)).toEqual(before);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);
});
