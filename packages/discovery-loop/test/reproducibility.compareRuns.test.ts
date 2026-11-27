// Task 4.7, step A1: `compareRuns` (R22.1, R22.7, R22.8, R22.9, R12.23, R12.24). Deterministic and offline: synthetic Runs sealed by the real
// RunRecordStore on a MemoryFileSystem. Every `different` case uses two Runs that are BOTH accepted (asserted with `acceptRun`); a tampered
// Run is never expected to be `different`.
// **Validates: Requirements 22.1, 22.7, 22.8, 22.9, 12.23, 12.24**
import { describe, expect, it } from "vitest";
import {
  COMPLETION_MARKER_FILE, MANIFEST_FILE, MemoryFileSystem, RECORDS_FILE, REQUIRED_EXCLUDED_FIELDS, acceptRun, compareRuns, createSchemaValidator, joinPath, verifyRunDirectory,
  type CompareRunsResult, type JsonObject, type SchemaValidator,
} from "../src/index.js";
import { BASE_STEPS, appendStep, dirOf, reformatRecordsRaw, rewriteSealedManifest, sealRun, type Step } from "./helpers/compareFixtures.js";
import { SpyFileSystem, bytes, sha256, text } from "./helpers/runFixtures.js";

async function pair(a: readonly Step[], b: readonly Step[], manifestA: JsonObject = {}, manifestB: JsonObject = {}): Promise<{ fs: MemoryFileSystem; a: string; b: string }> {
  const fs = new MemoryFileSystem();
  const sa = await sealRun(fs, "run-a", a, manifestA);
  const sb = await sealRun(fs, "run-b", b, manifestB);
  expect((await acceptRun(fs, sa.dir)).accepted, "precondition: run-a accepted").toBe(true);
  expect((await acceptRun(fs, sb.dir)).accepted, "precondition: run-b accepted").toBe(true);
  return { fs, a: sa.dir, b: sb.dir };
}
const withN = (n: number): Step[] => [...BASE_STEPS.slice(0, 2), appendStep("error", { n })];

describe("identical", () => {
  it("two accepted Runs with the same records are identical, and a Run is identical to itself", async () => {
    const { fs, a, b } = await pair(BASE_STEPS, BASE_STEPS);
    expect(await compareRuns(fs, a, b)).toEqual({ result: "identical", records: 3 });
    expect(await compareRuns(fs, a, a)).toEqual({ result: "identical", records: 3 });
  });

  it("Run-specific manifest information (run id, wall-clock values) does not matter (R22.1, excluded fields)", async () => {
    const { fs, a, b } = await pair(BASE_STEPS, BASE_STEPS, {}, { wallClock: { startedAt: "2031-05-05T05:05:05Z", finishedAt: "2031-05-05T09:09:09Z" } });
    expect(JSON.parse(text(fs.peek(joinPath(a, MANIFEST_FILE)))).runId).not.toBe(JSON.parse(text(fs.peek(joinPath(b, MANIFEST_FILE)))).runId);
    expect(JSON.parse(text(fs.peek(joinPath(a, MANIFEST_FILE)))).wallClock).not.toEqual(JSON.parse(text(fs.peek(joinPath(b, MANIFEST_FILE)))).wallClock);
    expect(await compareRuns(fs, a, b)).toEqual({ result: "identical", records: 3 });
  });

  it("the manifest as a whole is not compared: another non-excluded manifest field does not change the verdict (human decision D1)", async () => {
    const { fs, a, b } = await pair(BASE_STEPS, BASE_STEPS, {}, { terminationReason: "no_further_experiments", limitsUsed: { iterations: 9, acceptedExperiments: 8, rejectedExperiments: 7 } });
    expect(await compareRuns(fs, a, b)).toEqual({ result: "identical", records: 3 });
  });

  it("the Completion_Marker form (one trailing line break) and a Reason_File are not compared (R22.9)", async () => {
    const { fs, a, b } = await pair(BASE_STEPS, BASE_STEPS);
    fs.poke(joinPath(b, COMPLETION_MARKER_FILE), bytes(`${sha256(fs.peek(joinPath(b, MANIFEST_FILE)) as Uint8Array)}\n`));
    fs.poke(joinPath(b, "REASON.json"), bytes("{\"step\":\"none\"}"));
    expect((await acceptRun(fs, b)).accepted).toBe(true);
    expect(await compareRuns(fs, a, b)).toEqual({ result: "identical", records: 3 });
  });

  it("two empty accepted Runs (no records.jsonl) are identical with zero records", async () => {
    const { fs, a, b } = await pair([], []);
    expect(fs.peek(joinPath(a, RECORDS_FILE))).toBeUndefined();
    expect(await compareRuns(fs, a, b)).toEqual({ result: "identical", records: 0 });
  });

  it("canonical, not raw, comparison: a Run whose records.jsonl differs byte for byte but not in canonical form is identical (R22.1)", async () => {
    const { fs, a, b } = await pair(BASE_STEPS, BASE_STEPS);
    await reformatRecordsRaw(fs, b);
    // the Run is still accepted, and its records.jsonl differs from the original in raw bytes
    expect((await acceptRun(fs, b)).accepted).toBe(true);
    expect(sha256(fs.peek(joinPath(b, RECORDS_FILE)) as Uint8Array)).not.toBe(sha256(fs.peek(joinPath(a, RECORDS_FILE)) as Uint8Array));
    expect(await compareRuns(fs, a, b)).toEqual({ result: "identical", records: 3 });
  });
});

describe("different", () => {
  it("a record with another payload is different, and the first differing record is named", async () => {
    const { fs, a, b } = await pair(BASE_STEPS, withN(99));
    expect(await compareRuns(fs, a, b)).toEqual({ result: "different", firstDifferingRecord: "rec-000003", difference: "content", recordsA: 3, recordsB: 3 });
  });

  it("the FIRST of several differing records is named (not the last, not a count)", async () => {
    const b: Step[] = [appendStep("run_started"), appendStep("error", { n: 7 }), appendStep("error", { n: 8 })];
    const { fs, a, b: dirB } = await pair(BASE_STEPS, b);
    expect(await compareRuns(fs, a, dirB)).toMatchObject({ result: "different", firstDifferingRecord: "rec-000002", difference: "content" });
  });

  it("a difference in the first record is named rec-000001", async () => {
    const b: Step[] = [appendStep("run_started", { first: true }), ...BASE_STEPS.slice(1)];
    const { fs, a, b: dirB } = await pair(BASE_STEPS, b);
    expect(await compareRuns(fs, a, dirB)).toMatchObject({ result: "different", firstDifferingRecord: "rec-000001" });
  });

  it("the record kind alone is enough to differ (same payload, same position)", async () => {
    const a: Step[] = [appendStep("run_started"), appendStep("error", {})];
    const b: Step[] = [appendStep("run_started"), appendStep("run_started", {})];
    const p = await pair(a, b);
    expect(await compareRuns(p.fs, p.a, p.b)).toMatchObject({ result: "different", firstDifferingRecord: "rec-000002", difference: "content" });
  });

  it("the same content in the other order is different (order is part of the comparison)", async () => {
    const a: Step[] = [appendStep("run_started"), appendStep("error", { n: 1 }), appendStep("error", { n: 2 })];
    const b: Step[] = [appendStep("run_started"), appendStep("error", { n: 2 }), appendStep("error", { n: 1 })];
    const p = await pair(a, b);
    expect(await compareRuns(p.fs, p.a, p.b)).toMatchObject({ result: "different", firstDifferingRecord: "rec-000002" });
  });

  it("run A has an extra record: different at the first record only A has", async () => {
    const { fs, a, b } = await pair([...BASE_STEPS, appendStep("error", { n: 3 })], BASE_STEPS);
    expect(await compareRuns(fs, a, b)).toEqual({ result: "different", firstDifferingRecord: "rec-000004", difference: "only_in_a", recordsA: 4, recordsB: 3 });
  });

  it("run B has an extra record, and A is a prefix of B: different at the first record only B has", async () => {
    const { fs, a, b } = await pair(BASE_STEPS, [...BASE_STEPS, appendStep("error", { n: 3 }), appendStep("error", { n: 4 })]);
    expect(await compareRuns(fs, a, b)).toEqual({ result: "different", firstDifferingRecord: "rec-000004", difference: "only_in_b", recordsA: 3, recordsB: 5 });
  });

  it("an empty Run against a Run with records is different at rec-000001", async () => {
    const { fs, a, b } = await pair([], BASE_STEPS);
    expect(await compareRuns(fs, a, b)).toEqual({ result: "different", firstDifferingRecord: "rec-000001", difference: "only_in_b", recordsA: 0, recordsB: 3 });
  });

  it("legitimately sealed Runs that reference different blobs are different at the referencing record", async () => {
    const mk = (content: string): Step[] => [appendStep("run_started"), { op: "blob", content }, appendStep("error", { n: 1 })];
    const { fs, a, b } = await pair(mk("{\"reply\":1}"), mk("{\"reply\":2}"));
    const blobsA = fs.allFiles().filter((f) => f.startsWith(`${a}/blobs/`));
    const blobsB = fs.allFiles().filter((f) => f.startsWith(`${b}/blobs/`));
    expect(blobsA.map((f) => f.split("/").pop())).not.toEqual(blobsB.map((f) => f.split("/").pop()));
    expect(await compareRuns(fs, a, b)).toMatchObject({ result: "different", firstDifferingRecord: "rec-000002", difference: "content" });
  });

  it("the same blob content in both Runs is identical", async () => {
    const mk: Step[] = [appendStep("run_started"), { op: "blob", content: "{\"reply\":1}" }, appendStep("error", { n: 1 })];
    const { fs, a, b } = await pair(mk, mk);
    expect(await compareRuns(fs, a, b)).toEqual({ result: "identical", records: 3 });
  });
});

describe("incomplete (R22.8): both Runs are accepted first; nothing is compared otherwise", () => {
  it("Run A without a Completion_Marker is incomplete, even though the records differ from Run B", async () => {
    const fs = new MemoryFileSystem();
    const a = await sealRun(fs, "run-a", BASE_STEPS, {}, false);
    const b = await sealRun(fs, "run-b", withN(99));
    const r = await compareRuns(fs, a.dir, b.dir);
    expect(r).toEqual({ result: "incomplete", a: { accepted: false, reason: "no_completion_marker" }, b: { accepted: true } });
  });

  it("Run B incomplete is reported on side b", async () => {
    const fs = new MemoryFileSystem();
    const a = await sealRun(fs, "run-a");
    const b = await sealRun(fs, "run-b", BASE_STEPS, {}, false);
    expect(await compareRuns(fs, a.dir, b.dir)).toEqual({ result: "incomplete", a: { accepted: true }, b: { accepted: false, reason: "no_completion_marker" } });
  });

  it("both Runs incomplete: both sides are reported", async () => {
    const fs = new MemoryFileSystem();
    const a = await sealRun(fs, "run-a", BASE_STEPS, {}, false);
    const b = await sealRun(fs, "run-b", BASE_STEPS, {}, false);
    expect(await compareRuns(fs, a.dir, b.dir)).toEqual({
      result: "incomplete",
      a: { accepted: false, reason: "no_completion_marker" },
      b: { accepted: false, reason: "no_completion_marker" },
    });
  });

  it("a missing Run_Manifest is incomplete (no_manifest)", async () => {
    const fs = new MemoryFileSystem();
    const a = await sealRun(fs, "run-a");
    fs.addDir(dirOf("run-empty"));
    expect(await compareRuns(fs, a.dir, dirOf("run-empty"))).toMatchObject({ result: "incomplete", a: { accepted: true }, b: { accepted: false, reason: "no_manifest" } });
  });

  it("a Run under .incoming/ is incomplete and nothing in it is read, even when it is otherwise complete", async () => {
    const spy = new SpyFileSystem();
    const good = await sealRun(spy, "run-a");
    const incoming = await sealRun(spy, ".incoming/run-b");
    // positive control: apart from its location, the Run is complete (marker present, verification succeeds)
    expect((await verifyRunDirectory(spy, incoming.dir, { requireMarker: true })).result).toBe("success");
    spy.reset();
    const r = await compareRuns(spy, good.dir, incoming.dir);
    expect(r).toEqual({ result: "incomplete", a: { accepted: true }, b: { accepted: false, reason: "incoming_directory" } });
    expect(spy.reads.filter((p) => p.includes("/.incoming/"))).toEqual([]);
  });

  it("a Completion_Marker that differs from the SHA-256 of the manifest is incomplete (marker_mismatch)", async () => {
    const { fs, a, b } = await pair(BASE_STEPS, BASE_STEPS);
    fs.poke(joinPath(b, COMPLETION_MARKER_FILE), bytes("0".repeat(64)));
    expect(await compareRuns(fs, a, b)).toMatchObject({ result: "incomplete", a: { accepted: true }, b: { accepted: false, reason: "marker_mismatch" } });
  });

  it("a broken record chain is incomplete with the chain break, never different", async () => {
    const { fs, a, b } = await pair(BASE_STEPS, BASE_STEPS);
    const path = joinPath(b, RECORDS_FILE);
    fs.poke(path, bytes(text(fs.peek(path)).replace("\"n\":1", "\"n\":5"))); // alter a stored record without recomputing its hash
    const r = await compareRuns(fs, a, b);
    expect(r).toMatchObject({ result: "incomplete", a: { accepted: true }, b: { accepted: false, reason: "verification_failed" } });
    const side = r.result === "incomplete" ? r.b : undefined;
    expect(side && !side.accepted ? side.mismatches : []).toEqual(expect.arrayContaining([{ where: "rec-000002", kind: "chain_break" }, { where: "records.jsonl", kind: "modified" }]));
  });

  it("a tampered blob is incomplete (the blob no longer matches the manifest)", async () => {
    const steps: Step[] = [appendStep("run_started"), { op: "blob", content: "{\"reply\":1}" }];
    const { fs, a, b } = await pair(steps, steps);
    const blob = fs.allFiles().find((f) => f.startsWith(`${b}/blobs/`)) as string;
    fs.poke(blob, bytes("{\"reply\":2}"));
    const r = await compareRuns(fs, a, b);
    expect(r).toMatchObject({ result: "incomplete", b: { accepted: false, reason: "verification_failed", mismatches: [{ kind: "modified" }] } });
  });

  it("a stray unlisted file is incomplete", async () => {
    const { fs, a, b } = await pair(BASE_STEPS, BASE_STEPS);
    fs.poke(joinPath(b, "extra.txt"), bytes("x"));
    expect(await compareRuns(fs, a, b)).toMatchObject({ result: "incomplete", b: { accepted: false, reason: "verification_failed", mismatches: [{ where: "extra.txt", kind: "unlisted" }] } });
  });
});

describe("excluded fields contract (R22.1)", () => {
  it("the required excluded fields are exactly the run identifier and the wall-clock fields", () => {
    expect(REQUIRED_EXCLUDED_FIELDS).toEqual(["runId", "wallClock"]);
  });

  it("a manifest that lists more or fewer excluded fields is not accepted by the schema: incomplete (manifest_invalid)", async () => {
    for (const bad of [["runId"], ["runId", "wallClock", "records"], ["wallClock", "runId"]]) {
      const { fs, a, b } = await pair(BASE_STEPS, BASE_STEPS);
      await rewriteSealedManifest(fs, b, (m) => {
        m["excludedFields"] = bad;
      });
      const r = await compareRuns(fs, a, b);
      expect(r, JSON.stringify(bad)).toMatchObject({ result: "incomplete", a: { accepted: true }, b: { accepted: false, reason: "manifest_invalid" } });
    }
  });

  it("defence in depth: even when a validator lets such a manifest through, compareRuns does not compare (excluded_fields_contract)", async () => {
    const real = createSchemaValidator();
    const lenient: SchemaValidator = {
      validate: (name, value) => real.validate(name, value),
      parseAndValidate: (name, input) => ({ ok: true, value: JSON.parse(typeof input === "string" ? input : text(input)) }),
    };
    const { fs, a, b } = await pair(BASE_STEPS, withN(99));
    await rewriteSealedManifest(fs, b, (m) => {
      m["excludedFields"] = ["runId", "wallClock", "records"];
    });
    expect((await acceptRun(fs, b, { validator: lenient })).accepted, "positive control: the lenient validator accepts it").toBe(true);
    const r: CompareRunsResult = await compareRuns(fs, a, b, { validator: lenient });
    expect(r).toEqual({ result: "incomplete", a: { accepted: true }, b: { accepted: false, reason: "excluded_fields_contract" } });
  });
});

describe("what is read, and when", () => {
  it("only reads: no write, mkdir, rename or remove", async () => {
    const spy = new SpyFileSystem();
    await sealRun(spy, "run-a");
    await sealRun(spy, "run-b", withN(9));
    spy.reset();
    await compareRuns(spy, dirOf("run-a"), dirOf("run-b"));
    expect(spy.writes).toEqual([]);
  });

  it("records.jsonl is read once per Run: the verified bytes are the compared bytes", async () => {
    const spy = new SpyFileSystem();
    await sealRun(spy, "run-a");
    await sealRun(spy, "run-b");
    spy.reset();
    await compareRuns(spy, dirOf("run-a"), dirOf("run-b"));
    expect(spy.reads.filter((p) => p.endsWith(`/${RECORDS_FILE}`)).sort()).toEqual([`${dirOf("run-a")}/${RECORDS_FILE}`, `${dirOf("run-b")}/${RECORDS_FILE}`]);
  });

  it("a records.jsonl that changes after verification is not seen: the verdict is about the verified bytes", async () => {
    const fs = new MemoryFileSystem();
    const a = await sealRun(fs, "run-a");
    const b = await sealRun(fs, "run-b");
    const other = await sealRun(fs, "run-other", withN(99));
    const otherBytes = fs.peek(joinPath(other.dir, RECORDS_FILE)) as Uint8Array;
    const recordsB = joinPath(b.dir, RECORDS_FILE);
    let readsOfB = 0;
    const flipping = {
      listDir: (p: string) => fs.listDir(p),
      async readFile(p: string): Promise<Uint8Array | undefined> {
        const content = await fs.readFile(p);
        if (p !== recordsB) return content;
        readsOfB += 1;
        return readsOfB === 1 ? content : otherBytes;
      },
    };
    expect(await compareRuns(flipping, a.dir, b.dir)).toEqual({ result: "identical", records: 3 });
    expect(readsOfB).toBe(1);
  });

  it("a rejected side makes the verdict incomplete in either argument order, whatever the other side holds", async () => {
    const fs = new MemoryFileSystem();
    const a = await sealRun(fs, "run-a", BASE_STEPS, {}, false);
    const b = await sealRun(fs, "run-b", withN(99));
    expect((await compareRuns(fs, a.dir, b.dir)).result).toBe("incomplete");
    expect((await compareRuns(fs, b.dir, a.dir)).result).toBe("incomplete");
  });
});
