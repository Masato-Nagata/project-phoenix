// Feature: discovery-loop, Property 17: A failed write leaves only a complete, valid prefix
// **Validates: Requirements 12.14**
//
// A FileSystemPort wrapper fails at one chosen step (write temp, fsync, rename, dir sync, read) of one chosen
// append or of the seal. Reproducibility record: SEED = 1712, NUM_RUNS = 200 (fixed on purpose).
import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical/index.js";
import {
  COMPLETION_MARKER_FILE, GENESIS_HASH, MANIFEST_FILE, MemoryFileSystem, RECORDS_FILE, RunRecordStore, acceptRun, joinPath,
  verifyRunDirectory,
} from "../src/index.js";
import { RUN_DIR, bytes, manifestInput, openStore, text } from "./helpers/runFixtures.js";

const SEED = 1712;
const NUM_RUNS = 200;

type Step = "write" | "fsync" | "rename" | "syncDir" | "read";
const STEPS: Step[] = ["write", "fsync", "rename", "syncDir", "read"];

/** Fails the first call of the armed step on a store-owned target (records.jsonl[.tmp] or manifest.json[.tmp]). */
class FaultFs extends MemoryFileSystem {
  armed: Step | undefined;
  cleanupFails = false;
  fired = false;
  private hit(step: Step, path: string): boolean {
    if (this.armed !== step || this.fired || !/(records\.jsonl|manifest\.json)(\.tmp)?$/.test(path)) return false;
    this.fired = true;
    return true;
  }
  override async writeFileSynced(path: string, data: Uint8Array): Promise<void> {
    if (this.hit("write", path)) {
      await super.writeFileSynced(path, data.slice(0, Math.floor(data.length / 2))); // torn temp file
      throw Object.assign(new Error("injected write failure"), { code: "EIO" });
    }
    await super.writeFileSynced(path, data);
    if (this.hit("fsync", path)) throw Object.assign(new Error("injected fsync failure"), { code: "EIO" });
  }
  override async rename(from: string, to: string): Promise<void> {
    if (this.hit("rename", from)) throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
    await super.rename(from, to);
  }
  override async syncDir(path: string): Promise<void> {
    if (this.armed === "syncDir" && !this.fired) {
      this.fired = true;
      throw Object.assign(new Error("injected dir sync failure"), { code: "EIO" });
    }
    await super.syncDir(path);
  }
  override async readFile(path: string): Promise<Uint8Array | undefined> {
    if (this.hit("read", path)) throw Object.assign(new Error("injected read failure"), { code: "EIO" });
    return super.readFile(path);
  }
  override async removeFile(path: string): Promise<void> {
    if (this.cleanupFails) throw new Error("injected cleanup failure");
    await super.removeFile(path);
  }
}

const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

/** Independent chain check of a records.jsonl byte string; returns the parsed records. */
function assertCompleteValidChain(data: Uint8Array | undefined): { id: string; hash: string }[] {
  if (data === undefined) return [];
  const t = text(data);
  if (t === "") return [];
  expect(t.endsWith("\n")).toBe(true); // no partial last line
  const lines = t.slice(0, -1).split("\n");
  let prev = GENESIS_HASH;
  return lines.map((line, i) => {
    const rec = JSON.parse(line) as Record<string, unknown> & { hash: string; prevHash: string; id: string };
    const { hash, ...head } = rec;
    expect(rec.seq).toBe(i + 1);
    expect(rec.prevHash).toBe(prev);
    expect(hash).toBe(sha(canonicalJson(head as never)));
    prev = hash;
    return { id: rec.id, hash };
  });
}

const caseArb = fc.record({
  payloads: fc.array(fc.integer({ min: 0, max: 999 }), { minLength: 1, maxLength: 6 }),
  failAt: fc.nat(),
  step: fc.constantFrom(...STEPS),
  cleanupFails: fc.boolean(),
});

describe("Property 17: A failed write leaves only a complete, valid prefix", () => {
  it("one injected failure leaves the complete prefix, a failed store, and an incomplete Run", async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async ({ payloads, failAt, step: rawStep, cleanupFails }) => {
        const n = payloads.length;
        const failIdx = failAt % (n + 1); // failIdx === n injects into the seal
        const isSeal = failIdx === n;
        const step: Step = !isSeal && rawStep === "read" ? "write" : rawStep; // appends never read

        // Reference run without a fault: exact bytes after every append.
        const refFs = new MemoryFileSystem();
        const ref = await openStore(refFs);
        const refBytes: (Uint8Array | undefined)[] = [undefined];
        for (const p of payloads) {
          expect((await ref.append("error", { n: p })).ok).toBe(true);
          refBytes.push(refFs.peek(joinPath(RUN_DIR, RECORDS_FILE)));
        }

        const fs = new FaultFs();
        const store: RunRecordStore = await openStore(fs);
        for (let i = 0; i < failIdx; i++) expect((await store.append("error", { n: payloads[i] as number })).ok).toBe(true);

        fs.armed = step;
        fs.cleanupFails = cleanupFails;
        const outcome = await (isSeal
          ? store.seal(manifestInput())
          : store.append("error", { n: payloads[failIdx] as number })
        ).catch((e: unknown) => ({ thrown: e }));
        expect(outcome, "the failed operation must return an error result, not throw").not.toHaveProperty("thrown");
        const result = outcome as { ok: boolean; error?: { kind: string } };
        expect(fs.fired).toBe(true);
        expect(result.ok).toBe(false);
        expect(result.error?.kind).toBe("io_failure");

        // The store is store_failed and accepts no further write; nothing on disk changes.
        const before = fs.allFiles().map((f) => [f, text(fs.peek(f))]);
        for (const again of [
          await store.append("error", { n: 1 }),
          await store.putBlob(bytes("x")),
          await store.seal(manifestInput()),
        ]) {
          expect(again.ok).toBe(false);
          expect((again as { error: { kind: string } }).error.kind).toBe("store_failed");
        }
        expect(fs.allFiles().map((f) => [f, text(fs.peek(f))])).toEqual(before);

        // records.jsonl is exactly the complete prefix (after a dir-sync failure the renamed state may be visible).
        const onDisk = fs.peek(joinPath(RUN_DIR, RECORDS_FILE));
        const accepted = [refBytes[failIdx]];
        if (!isSeal && step === "syncDir") accepted.push(refBytes[failIdx + 1]);
        expect(accepted.map((b) => text(b))).toContain(text(onDisk));
        if (!(step === "syncDir" && !isSeal)) expect(text(onDisk)).toBe(text(refBytes[failIdx]));
        const chain = assertCompleteValidChain(onDisk);
        expect(chain.length).toBeGreaterThanOrEqual(failIdx);
        // In memory the store holds exactly the records before the failed append.
        expect(store.count).toBe(failIdx);
        expect(store.lastRecordHash).toBe(failIdx === 0 ? GENESIS_HASH : (chain[failIdx - 1] as { hash: string }).hash);

        // No temp file is a record: only the real files, and a leftover .tmp only when its cleanup was made to fail.
        for (const f of fs.allFiles()) {
          const name = f.slice(RUN_DIR.length + 1);
          if (name.endsWith(".tmp")) expect(cleanupFails).toBe(true);
          else expect([RECORDS_FILE, MANIFEST_FILE]).toContain(name);
        }
        if (!isSeal || step !== "syncDir") expect(fs.peek(joinPath(RUN_DIR, MANIFEST_FILE))).toBeUndefined();

        // Neither acceptance nor verification reports the Run as complete.
        expect(fs.peek(joinPath(RUN_DIR, COMPLETION_MARKER_FILE))).toBeUndefined();
        const acc = await acceptRun(fs, RUN_DIR);
        expect(acc.accepted).toBe(false);
        const rep = await verifyRunDirectory(fs, RUN_DIR, { requireMarker: true });
        expect(rep.incomplete).toBe(true);
        expect(rep.result).toBe("failure");
        if (fs.peek(joinPath(RUN_DIR, MANIFEST_FILE)) === undefined) {
          expect((await verifyRunDirectory(fs, RUN_DIR)).incomplete).toBe(true);
        }
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, 120_000);
});
