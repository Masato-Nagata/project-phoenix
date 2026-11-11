// Evidence_Store write path (task 1.9). Example-based; properties 15, 16, 17 are separate tasks.
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CITATION_VERIFIER,
  EvidenceStore,
  GENESIS_HASH,
  MemoryFileSystem,
  ModelEventPersister,
  RunRecordStore,
  canonicalJson,
  createNodeFileSystem,
  createSchemaValidator,
  type FileSystemPort,
  type Json,
  type RecordEnvelope,
} from "../src/index.js";

const DIR = "/run/out";
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const dec = (b: Uint8Array | undefined): string => new TextDecoder().decode(b);
const SECRET = "s3cr3t-value-9f8e7d";

async function openMem(secrets = {}): Promise<{ fs: MemoryFileSystem; store: RunRecordStore }> {
  const fs = new MemoryFileSystem();
  fs.addDir(DIR);
  const r = await RunRecordStore.open(fs, DIR, { secrets });
  if (!r.ok) throw new Error("open failed");
  return { fs, store: r.value };
}
const lines = (fs: MemoryFileSystem): RecordEnvelope[] =>
  dec(fs.peek(`${DIR}/records.jsonl`)).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as RecordEnvelope);

/** Delegates to a port and throws at the chosen operation. */
function failing(inner: FileSystemPort, op: "writeFileSynced" | "rename" | "syncDir"): FileSystemPort {
  return {
    listDir: (p) => inner.listDir(p),
    mkdir: (p) => inner.mkdir(p),
    writeFileSynced: (p, d) => (op === "writeFileSynced" ? Promise.reject(new Error("boom")) : inner.writeFileSynced(p, d)),
    rename: (a, b) => (op === "rename" ? Promise.reject(new Error("boom")) : inner.rename(a, b)),
    syncDir: (p) => (op === "syncDir" ? Promise.reject(new Error("boom")) : inner.syncDir(p)),
    readFile: (p) => inner.readFile(p),
    removeFile: (p) => inner.removeFile(p),
  };
}

describe("open (Run_Volume must be empty)", () => {
  it("accepts an existing empty directory", async () => {
    const fs = new MemoryFileSystem();
    fs.addDir(DIR);
    expect((await RunRecordStore.open(fs, DIR)).ok).toBe(true);
  });
  it("refuses a missing directory and creates nothing", async () => {
    const fs = new MemoryFileSystem();
    const r = await RunRecordStore.open(fs, DIR);
    expect(!r.ok && r.error.kind).toBe("run_volume_missing");
    expect(await fs.listDir(DIR)).toBeUndefined();
  });
  it("refuses a directory that holds any file or directory", async () => {
    for (const name of ["records.jsonl", "stray.tmp", "blobs"]) {
      const fs = new MemoryFileSystem();
      fs.addDir(DIR);
      fs.poke(`${DIR}/${name}`, new Uint8Array([1]));
      const r = await RunRecordStore.open(fs, DIR);
      expect(!r.ok && r.error.kind).toBe("run_volume_not_empty");
      expect(fs.peek(`${DIR}/${name}`)).toEqual(new Uint8Array([1]));
    }
  });
});

describe("record envelope and hash chain", () => {
  it("numbers records from 1 without gaps, starts at the 64-zero genesis and chains hashes over canonical bytes", async () => {
    const { fs, store } = await openMem();
    for (let i = 0; i < 4; i++) {
      const r = await store.append("run_started", { n: i, text: "é\n" });
      expect(r.ok).toBe(true);
    }
    const recs = lines(fs);
    expect(recs.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(recs.map((r) => r.id)).toEqual(["rec-000001", "rec-000002", "rec-000003", "rec-000004"]);
    expect(recs[0]?.prevHash).toBe(GENESIS_HASH);
    const validator = createSchemaValidator();
    recs.forEach((r, i) => {
      const { hash, ...rest } = r;
      expect(hash).toBe(sha(canonicalJson(rest as unknown as Json)));
      if (i > 0) expect(r.prevHash).toBe(recs[i - 1]?.hash);
      expect(validator.validate("record-envelope", r).ok).toBe(true);
    });
    expect(store.lastRecordHash).toBe(recs[3]?.hash);
    // every stored line is itself canonical JSON
    const raw = dec(fs.peek(`${DIR}/records.jsonl`));
    expect(raw).toBe(recs.map((r) => `${canonicalJson(r as unknown as Json)}\n`).join(""));
    expect(fs.allFiles()).toEqual([`${DIR}/records.jsonl`]); // no temp file left behind
  });
  it("keeps the sequence when appends are issued concurrently", async () => {
    const { fs, store } = await openMem();
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.append("error", { n })));
    expect(lines(fs).map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);
  });
  it("rejects values that are not canonical JSON and writes nothing", async () => {
    const { fs, store } = await openMem();
    const r = await store.append("error", { n: Number.NaN });
    expect(!r.ok && r.error.kind).toBe("invalid_record");
    expect(store.count).toBe(0);
    expect(fs.allFiles()).toEqual([]);
  });
  it("rejects a payload that breaks a kind-specific schema (ai_content_discarded with a value field)", async () => {
    const { store } = await openMem();
    const r = await store.append("ai_content_discarded", { aiOutputRecordId: "rec-000001", fields: [{ path: "", name: "approval", value: "x" }] });
    expect(!r.ok && r.error.kind).toBe("invalid_record");
    expect(store.count).toBe(0);
  });
});

describe("atomic write", () => {
  it.each(["writeFileSynced", "rename"] as const)("a failure at %s leaves the old records.jsonl and stops the store", async (op) => {
    const fs2 = new MemoryFileSystem();
    fs2.addDir(DIR);
    let armed = false;
    const wrapped: FileSystemPort = {
      ...failing(fs2, op),
      writeFileSynced: (p, d) => (armed && op === "writeFileSynced" ? Promise.reject(new Error("boom")) : fs2.writeFileSynced(p, d)),
      rename: (a, b) => (armed && op === "rename" ? Promise.reject(new Error("boom")) : fs2.rename(a, b)),
    };
    const s = await RunRecordStore.open(wrapped, DIR);
    if (!s.ok) throw new Error("open");
    await s.value.append("run_started", {});
    const good = fs2.peek(`${DIR}/records.jsonl`);
    armed = true;
    const r = await s.value.append("error", { n: 1 });
    expect(!r.ok && r.error.kind).toBe("io_failure");
    expect(fs2.peek(`${DIR}/records.jsonl`)).toEqual(good);
    expect(fs2.allFiles()).toEqual([`${DIR}/records.jsonl`]);
    expect(s.value.count).toBe(1);
    armed = false;
    const again = await s.value.append("error", { n: 2 });
    expect(!again.ok && again.error.kind).toBe("store_failed");
    expect(fs2.peek(`${DIR}/records.jsonl`)).toEqual(good);
  });
  it("a failed first write leaves no records.jsonl", async () => {
    const fs = new MemoryFileSystem();
    fs.addDir(DIR);
    const s = await RunRecordStore.open(failing(fs, "rename"), DIR);
    if (!s.ok) throw new Error("open");
    const r = await s.value.append("run_started", {});
    expect(!r.ok && r.error.kind).toBe("io_failure");
    expect(fs.allFiles()).toEqual([]);
  });
});

describe("append-only: modify and delete requests", () => {
  it("are rejected, recorded, and leave earlier records byte-identical", async () => {
    const { fs, store } = await openMem();
    await store.append("run_started", { a: 1 });
    await store.append("error", { b: 2 });
    const before = dec(fs.peek(`${DIR}/records.jsonl`));
    const m = await store.requestModify("rec-000001", "orchestrator");
    const d = await store.requestDelete("rec-000002", "orchestrator");
    expect(!m.ok && m.error.kind === "rejected" && m.error.attempt).toBe("modify_record");
    expect(!d.ok && d.error.kind === "rejected" && d.error.attempt).toBe("delete_record");
    const after = dec(fs.peek(`${DIR}/records.jsonl`));
    expect(after.startsWith(before)).toBe(true);
    const recs = lines(fs);
    expect(recs).toHaveLength(4);
    expect(recs[2]).toMatchObject({
      kind: "store_rejection",
      payload: { attempt: "modify_record", component: "orchestrator", targetRecordId: "rec-000001" },
    });
    expect(recs[3]?.payload).toMatchObject({ attempt: "delete_record", targetRecordId: "rec-000002" });
  });
  it("names an unknown or malformed target without inventing a reference", async () => {
    const { fs, store } = await openMem();
    await store.requestDelete("../etc/passwd", "  ");
    expect(lines(fs)[0]?.payload).toEqual({
      attempt: "delete_record",
      component: "unknown",
      reason: "stored records cannot be deleted",
    });
  });
});

describe("secret rejection", () => {
  const secrets = { patterns: [{ id: "api-key", source: "sk-[A-Za-z0-9]{10,}" }], envValues: [{ name: "MY_KEY", value: SECRET }, { name: "SHORT", value: "abc" }] };

  it("rejects the whole record on a pattern hit, names the pattern id and omits the value", async () => {
    const { fs, store } = await openMem(secrets);
    await store.append("run_started", {});
    const r = await store.append("ai_call", { note: "token sk-ABCDEFGHIJKL1234 here", other: 1 }, { component: "orchestrator" });
    expect(!r.ok && r.error.kind === "secret_rejected" && r.error.patternId).toBe("api-key");
    const recs = lines(fs);
    expect(recs).toHaveLength(2);
    expect(recs[1]).toMatchObject({ kind: "store_rejection", payload: { attempt: "secret_pattern", patternId: "api-key", component: "orchestrator" } });
    const raw = dec(fs.peek(`${DIR}/records.jsonl`));
    expect(raw).not.toContain("sk-ABCDEFGHIJKL1234");
    expect(raw).not.toContain("ai_call");
    expect(createSchemaValidator().validate("record-envelope", recs[1]).ok).toBe(true);
  });
  it("detects a configured env value in a key, a nested string and a JSON-escaped form", async () => {
    const { fs, store } = await openMem(secrets);
    for (const payload of [{ [SECRET]: 1 }, { deep: [{ x: `a"${SECRET}` }] }, { text: `line\n${SECRET}` }]) {
      const r = await store.append("error", payload);
      expect(!r.ok && r.error.kind === "secret_rejected" && r.error.patternId).toBe("env:MY_KEY");
    }
    expect(dec(fs.peek(`${DIR}/records.jsonl`))).not.toContain(SECRET);
    expect(lines(fs)).toHaveLength(3);
  });
  it("ignores env values shorter than 8 characters", async () => {
    const { store } = await openMem(secrets);
    expect((await store.append("error", { text: "abc" })).ok).toBe(true);
  });
  it("does not leak a secret placed in the component name", async () => {
    const { fs, store } = await openMem(secrets);
    await store.append("error", { v: SECRET }, { component: `who-${SECRET}` });
    expect(dec(fs.peek(`${DIR}/records.jsonl`))).not.toContain(SECRET);
    expect(lines(fs)[0]?.payload).toMatchObject({ component: "redacted" });
  });
  it("rejects a blob that contains a secret and writes no blob file", async () => {
    const { fs, store } = await openMem(secrets);
    const r = await store.putAiOutput(new TextEncoder().encode(`reply ${SECRET}`));
    expect(!r.ok && r.error.kind).toBe("secret_rejected");
    expect(fs.allFiles()).toEqual([`${DIR}/records.jsonl`]);
    expect(dec(fs.peek(`${DIR}/records.jsonl`))).not.toContain(SECRET);
  });
});

describe("AI output as exact bytes", () => {
  it("stores the received bytes unchanged under their SHA-256 and references them from an ai_output record", async () => {
    const { fs, store } = await openMem();
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x0d, 0x0a, 0xff, 0xfe, 0x00, 0x7d]); // BOM, CRLF, invalid UTF-8, NUL
    const r = await store.putAiOutput(bytes, { component: "ai_client" });
    if (!r.ok) throw new Error("put");
    expect(r.value.blob).toEqual({ blob: sha(bytes), bytes: bytes.length });
    expect(fs.peek(`${DIR}/blobs/${sha(bytes)}`)).toEqual(bytes);
    expect(r.value.record.kind).toBe("ai_output");
    expect(r.value.record.payload).toEqual({ output: { blob: sha(bytes), bytes: bytes.length } });
    expect(fs.allFiles()).toEqual([`${DIR}/blobs/${sha(bytes)}`, `${DIR}/records.jsonl`]);
  });
  it("writes identical content once", async () => {
    const { store } = await openMem();
    const a = await store.putBlob(new Uint8Array([1, 2, 3]));
    const b = await store.putBlob(new Uint8Array([1, 2, 3]));
    expect(a).toEqual(b);
  });
  it("a failed blob write leaves no temp file and no reference", async () => {
    const fs = new MemoryFileSystem();
    fs.addDir(DIR);
    const s = await RunRecordStore.open(failing(fs, "rename"), DIR);
    if (!s.ok) throw new Error("open");
    const r = await s.value.putAiOutput(new Uint8Array([9]));
    expect(!r.ok && r.error.kind).toBe("io_failure");
    expect(fs.allFiles()).toEqual([]);
  });
});

describe("model events become envelopes", () => {
  it("writes ai_content_discarded, evidence and store_rejection records in order, without values", async () => {
    const { fs, store } = await openMem();
    const model = new EvidenceStore();
    const ai = await store.putAiOutput(new TextEncoder().encode("{}"));
    if (!ai.ok) throw new Error("put");
    const rev = model.createClaimRevision({
      claimId: "clm-1",
      reason: "initial",
      aiClaim: { effect: "x", approval: "approved-by-ai-9z" },
      aiOutputRecordId: ai.value.record.id,
    });
    if (!rev.ok) throw new Error("claim");
    const ev = model.appendEvidence({
      component: CITATION_VERIFIER,
      record: { evidenceId: "ev-1", kind: "source", claimRevisionId: rev.value.claimRevisionId, citationRecordId: "rec-000010", citations: [{ index: 0, result: "verified" }] },
    });
    expect(ev.ok).toBe(true);
    model.requestOriginChange(rev.value.claimRevisionId, "human-authored", "orchestrator");

    const persister = new ModelEventPersister(model, store);
    const flushed = await persister.flush();
    if (!flushed.ok) throw new Error(JSON.stringify(flushed.error));
    expect(flushed.value.map((r) => r.kind)).toEqual(["ai_content_discarded", "evidence", "store_rejection"]);
    const raw = dec(fs.peek(`${DIR}/records.jsonl`));
    expect(raw).not.toContain("approved-by-ai-9z");
    expect(lines(fs)[1]?.payload).toEqual({ aiOutputRecordId: ai.value.record.id, fields: [{ path: "", name: "approval" }] });
    expect(lines(fs)[2]?.payload).toMatchObject({ evidenceId: "ev-1", kind: "source" });
    expect(lines(fs)[3]?.payload).toMatchObject({ attempt: "set_origin", component: "orchestrator" });
    // a second flush writes nothing new
    const again = await persister.flush();
    expect(again.ok && again.value).toEqual([]);
    expect(store.count).toBe(4);
  });
});

describe("real Node adapter on a Linux temp directory", () => {
  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });
  it("writes records.jsonl and blobs, leaves no temp file, and refuses a non-empty directory", async () => {
    tmp = await mkdtemp(join(tmpdir(), "run-vol-"));
    const fs = createNodeFileSystem();
    const s = await RunRecordStore.open(fs, tmp);
    if (!s.ok) throw new Error("open");
    await s.value.append("run_started", { a: 1 });
    const out = new Uint8Array([0xff, 0x00, 0x41]);
    const ai = await s.value.putAiOutput(out);
    if (!ai.ok) throw new Error("put");
    await s.value.requestDelete("rec-000001", "x");
    expect((await readdir(tmp)).sort()).toEqual(["blobs", "records.jsonl"]);
    expect((await readdir(join(tmp, "blobs")))).toEqual([sha(out)]);
    expect(new Uint8Array(await readFile(join(tmp, "blobs", sha(out))))).toEqual(out);
    const text = await readFile(join(tmp, "records.jsonl"), "utf8");
    expect(text.split("\n").filter(Boolean)).toHaveLength(3);
    expect((await RunRecordStore.open(fs, tmp)).ok).toBe(false);
  });
});
