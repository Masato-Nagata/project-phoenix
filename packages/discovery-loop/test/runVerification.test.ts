// Evidence_Store verification, Run_Manifest sealing and reader acceptance (task 1.12).
// Example-based. The tamper property (Property 15) is task 1.13.
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPLETION_MARKER_FILE,
  MemoryFileSystem,
  REASON_FILE,
  RunRecordStore,
  acceptRun,
  canonicalJson,
  createNodeFileSystem,
  isIncomingPath,
  verifyRunDirectory,
  type RunAcceptance,
} from "../src/index.js";
import { RUN_DIR, SpyFileSystem, buildSealedRun, bytes, manifestInput, openStore, sha256, text, writeCompletionMarker } from "./helpers/runFixtures.js";

const rec = (dir = RUN_DIR): string => `${dir}/records.jsonl`;
const mf = (dir = RUN_DIR): string => `${dir}/manifest.json`;

function rejected(a: RunAcceptance): string {
  if (a.accepted) throw new Error("expected a rejection");
  return a.reason;
}

describe("Run_Manifest sealing (R12.8, R12.16)", () => {
  it("writes one manifest.json that lists records.jsonl and every blob by path and hash, sorted, without itself", async () => {
    const { fs, blobHash } = await buildSealedRun();
    const m = JSON.parse(text(fs.peek(mf()))) as { schemaVersion: number; chain: { records: number; lastHash: string }; artifacts: { path: string; sha256: string }[] };
    expect(m.schemaVersion).toBe(1);
    expect(m.artifacts.map((a) => a.path)).toEqual([`blobs/${blobHash}`, "records.jsonl"]);
    expect(m.artifacts[1]?.sha256).toBe(sha256(fs.peek(rec()) as Uint8Array));
    expect(m.artifacts[0]?.sha256).toBe(blobHash);
    const lines = text(fs.peek(rec())).trim().split("\n");
    expect(m.chain).toEqual({ records: 3, lastHash: (JSON.parse(lines[2] as string) as { hash: string }).hash });
    expect(m.artifacts.some((a) => a.path === "manifest.json")).toBe(false);
  });

  it("returns the SHA-256 of the exact manifest bytes", async () => {
    const fs = new MemoryFileSystem();
    const store = await openStore(fs);
    await store.append("run_started", {});
    const r = await store.seal(manifestInput());
    expect(r.ok && r.value.sha256).toBe(sha256(fs.peek(mf()) as Uint8Array));
  });

  it("seals an empty Run: no records.jsonl artifact, genesis last hash", async () => {
    const fs = new MemoryFileSystem();
    const store = await openStore(fs);
    const r = await store.seal(manifestInput());
    expect(r.ok).toBe(true);
    const m = JSON.parse(text(fs.peek(mf()))) as { chain: unknown; artifacts: unknown[] };
    expect(m.chain).toEqual({ records: 0, lastHash: "0".repeat(64) });
    expect(m.artifacts).toEqual([]);
    expect((await verifyRunDirectory(fs, RUN_DIR)).result).toBe("success");
  });

  it("seals exactly once and accepts no write afterwards", async () => {
    const fs = new MemoryFileSystem();
    const store = await openStore(fs);
    await store.append("run_started", {});
    expect((await store.seal(manifestInput())).ok).toBe(true);
    const before = text(fs.peek(mf()));
    const second = await store.seal(manifestInput({ runId: "other" }));
    expect(!second.ok && second.error.kind).toBe("store_failed");
    const append = await store.append("error", {});
    expect(!append.ok && append.error.kind).toBe("store_failed");
    const blob = await store.putBlob(bytes("x"));
    expect(!blob.ok && blob.error.kind).toBe("store_failed");
    expect(text(fs.peek(mf()))).toBe(before);
  });

  it("refuses to overwrite an existing manifest.json", async () => {
    const fs = new MemoryFileSystem();
    const store = await openStore(fs);
    fs.poke(mf(), bytes("{}"));
    const r = await store.seal(manifestInput());
    expect(!r.ok && r.error.kind).toBe("store_failed");
    expect(text(fs.peek(mf()))).toBe("{}");
  });

  it.each(["schemaVersion", "chain", "artifacts"])("rejects input that sets %s", async (key) => {
    const fs = new MemoryFileSystem();
    const store = await openStore(fs);
    const r = await store.seal(manifestInput({ [key]: key === "schemaVersion" ? 1 : [] }));
    expect(!r.ok && r.error.kind).toBe("invalid_record");
    expect(fs.peek(mf())).toBeUndefined();
  });

  it("rejects input that fails the run-manifest schema, including an approvals field", async () => {
    const fs = new MemoryFileSystem();
    const store = await openStore(fs);
    const bad = await store.seal(manifestInput({ terminationReason: "done" }));
    expect(!bad.ok && bad.error.kind).toBe("invalid_record");
    const approvals = await store.seal(manifestInput({ approvals: [] }));
    expect(!approvals.ok && approvals.error.kind).toBe("invalid_record");
    expect(fs.peek(mf())).toBeUndefined();
    // Neither failure sealed the store: a valid input still works.
    expect((await store.seal(manifestInput())).ok).toBe(true);
  });

  it("does not seal when the input holds a secret: appends a rejection naming the pattern only", async () => {
    const fs = new MemoryFileSystem();
    fs.addDir(RUN_DIR);
    const opened = await RunRecordStore.open(fs, RUN_DIR, { secrets: { envValues: [{ name: "MY_KEY", value: "s3cr3t-value-9f8e7d" }] } });
    if (!opened.ok) throw new Error("open");
    const r = await opened.value.seal(manifestInput({ config: { token: "s3cr3t-value-9f8e7d" } }));
    expect(!r.ok && r.error.kind === "secret_rejected" && r.error.patternId).toBe("env:MY_KEY");
    expect(fs.peek(mf())).toBeUndefined();
    expect(text(fs.peek(rec()))).not.toContain("s3cr3t-value-9f8e7d");
    expect((await opened.value.seal(manifestInput())).ok).toBe(true);
  });

  it("an Approval_Record-like file placed in the Run directory is not listed and is reported unlisted", async () => {
    const { fs } = await buildSealedRun();
    const m = text(fs.peek(mf()));
    expect(m).not.toMatch(/approval/i);
    fs.poke(`${RUN_DIR}/approvals.jsonl`, bytes("{\"type\":\"approval\"}\n"));
    const r = await verifyRunDirectory(fs, RUN_DIR);
    expect(r.mismatches).toEqual([{ where: "approvals.jsonl", kind: "unlisted" }]);
  });
});

describe("verifyRunDirectory (R12.9, R12.10, R12.11)", () => {
  it("succeeds on an untouched sealed Run, without a marker unless one is required", async () => {
    const { fs } = await buildSealedRun();
    expect(await verifyRunDirectory(fs, RUN_DIR)).toMatchObject({ result: "success", incomplete: false, mismatches: [] });
    const need = await verifyRunDirectory(fs, RUN_DIR, { requireMarker: true });
    expect(need).toMatchObject({ result: "failure", incomplete: true, incompleteReason: "no_completion_marker" });
  });

  it("reports incomplete when there is no Run_Manifest", async () => {
    const fs = new MemoryFileSystem();
    const store = await openStore(fs);
    await store.append("run_started", {});
    const r = await verifyRunDirectory(fs, RUN_DIR);
    expect(r).toMatchObject({ result: "failure", incomplete: true, incompleteReason: "no_manifest", mismatches: [] });
  });

  it("reports incomplete for a missing directory and for an unusable manifest", async () => {
    const fs = new MemoryFileSystem();
    expect(await verifyRunDirectory(fs, "/nowhere")).toMatchObject({ incomplete: true, incompleteReason: "no_manifest" });
    const { fs: fs2 } = await buildSealedRun();
    fs2.poke(mf(), bytes("not json"));
    expect(await verifyRunDirectory(fs2, RUN_DIR)).toMatchObject({ incomplete: true, incompleteReason: "manifest_invalid" });
  });

  it("reports a modified blob", async () => {
    const { fs, blobHash } = await buildSealedRun();
    fs.poke(`${RUN_DIR}/blobs/${blobHash}`, bytes("changed"));
    const r = await verifyRunDirectory(fs, RUN_DIR);
    expect(r.result).toBe("failure");
    expect(r.mismatches).toEqual([{ where: `blobs/${blobHash}`, kind: "modified" }]);
  });

  it("reports a missing blob (listed and referenced) once per kind and path", async () => {
    const { fs, blobHash } = await buildSealedRun();
    await fs.removeFile(`${RUN_DIR}/blobs/${blobHash}`);
    const r = await verifyRunDirectory(fs, RUN_DIR);
    expect(r.mismatches).toEqual([{ where: `blobs/${blobHash}`, kind: "missing" }]);
  });

  it("reports a missing records.jsonl as missing plus a chain break against the manifest", async () => {
    const { fs } = await buildSealedRun();
    await fs.removeFile(rec());
    const r = await verifyRunDirectory(fs, RUN_DIR);
    expect(r.mismatches).toEqual([
      { where: "manifest.chain", kind: "chain_break" },
      { where: "records.jsonl", kind: "missing" },
    ]);
  });

  it("reports unlisted files, including a stale .tmp and a nested file", async () => {
    const { fs } = await buildSealedRun();
    fs.poke(`${rec()}.tmp`, bytes("x"));
    fs.poke(`${RUN_DIR}/blobs/extra`, bytes("x"));
    fs.poke(`${RUN_DIR}/notes.txt`, bytes("x"));
    const r = await verifyRunDirectory(fs, RUN_DIR);
    expect(r.mismatches).toEqual([
      { where: "blobs/extra", kind: "unlisted" },
      { where: "notes.txt", kind: "unlisted" },
      { where: "records.jsonl.tmp", kind: "unlisted" },
    ]);
  });

  it("does not count COMPLETE and REASON.json as unlisted, but only at the top level", async () => {
    const { fs } = await buildSealedRun();
    await writeCompletionMarker(fs, RUN_DIR);
    fs.poke(`${RUN_DIR}/${REASON_FILE}`, bytes("{}"));
    expect((await verifyRunDirectory(fs, RUN_DIR)).result).toBe("success");
    fs.poke(`${RUN_DIR}/blobs/${COMPLETION_MARKER_FILE}`, bytes("x"));
    expect((await verifyRunDirectory(fs, RUN_DIR)).mismatches).toEqual([{ where: `blobs/${COMPLETION_MARKER_FILE}`, kind: "unlisted" }]);
  });

  it("reports a record changed without fixing its hash as chain_break with the record id (and records.jsonl as modified)", async () => {
    const { fs } = await buildSealedRun();
    fs.poke(rec(), bytes(text(fs.peek(rec())).replace('"n":2', '"n":9')));
    const r = await verifyRunDirectory(fs, RUN_DIR);
    expect(r.mismatches).toEqual([
      { where: "rec-000003", kind: "chain_break" },
      { where: "records.jsonl", kind: "modified" },
    ]);
  });

  it("detects a deleted record, a reordered pair and a dropped last record", async () => {
    const base = await buildSealedRun();
    const lines = text(base.fs.peek(rec())).split("\n").filter((l) => l !== "");
    const cases: [string, string[]][] = [
      ["deleted middle", [lines[0] as string, lines[2] as string]],
      ["reordered", [lines[0] as string, lines[2] as string, lines[1] as string]],
      ["dropped last", [lines[0] as string, lines[1] as string]],
    ];
    for (const [name, kept] of cases) {
      const { fs } = await buildSealedRun(new MemoryFileSystem());
      fs.poke(rec(), bytes(`${kept.join("\n")}\n`));
      const r = await verifyRunDirectory(fs, RUN_DIR);
      expect(r.result, name).toBe("failure");
      expect(r.mismatches.some((m) => m.kind === "chain_break"), name).toBe(true);
    }
  });

  it("detects a record whose content and hash were both rewritten (the next link or the manifest breaks)", async () => {
    const { fs } = await buildSealedRun();
    const lines = text(fs.peek(rec())).split("\n").filter((l) => l !== "");
    const r3 = JSON.parse(lines[2] as string) as { hash: string; payload: { n: number } };
    r3.payload.n = 9;
    const { hash: _drop, ...head } = r3;
    const forged = { ...head, hash: sha256(canonicalJson(head)) };
    fs.poke(rec(), bytes(`${[lines[0], lines[1], JSON.stringify(forged)].join("\n")}\n`));
    const r = await verifyRunDirectory(fs, RUN_DIR);
    expect(r.mismatches.some((m) => m.kind === "chain_break")).toBe(true);
  });

  it("reports a blob reference that does not resolve to a listed blob", async () => {
    const fs = new MemoryFileSystem();
    const store = await openStore(fs);
    await store.append("ai_output", { output: { blob: "a".repeat(64), bytes: 3 } });
    await store.seal(manifestInput());
    const r = await verifyRunDirectory(fs, RUN_DIR);
    expect(r.mismatches).toEqual([{ where: `blobs/${"a".repeat(64)}`, kind: "missing" }]);
  });

  it("rejects a manifest that lists an unsafe path or names COMPLETE as incomplete (manifest_invalid)", async () => {
    for (const path of ["../outside", "/abs", "a//b", "COMPLETE"]) {
      const { fs } = await buildSealedRun(new MemoryFileSystem());
      const m = JSON.parse(text(fs.peek(mf()))) as { artifacts: { path: string; sha256: string }[] };
      m.artifacts.push({ path, sha256: "b".repeat(64) });
      fs.poke(mf(), bytes(JSON.stringify(m)));
      expect(await verifyRunDirectory(fs, RUN_DIR), path).toMatchObject({ incomplete: true, incompleteReason: "manifest_invalid" });
    }
  });

  it("writes nothing: no mutating port call, and the file set and bytes stay identical (memory adapter)", async () => {
    const spy = new SpyFileSystem();
    await buildSealedRun(spy);
    await writeCompletionMarker(spy, RUN_DIR);
    spy.poke(`${RUN_DIR}/stray.tmp`, bytes("x")); // verification must report it, not remove it
    const filesBefore = spy.allFiles();
    const bytesBefore = filesBefore.map((f) => text(spy.peek(f)));
    spy.reset();

    await verifyRunDirectory(spy, RUN_DIR);
    await verifyRunDirectory(spy, RUN_DIR, { requireMarker: true });
    await acceptRun(spy, RUN_DIR);

    expect(spy.writes).toEqual([]);
    expect(spy.reads.length).toBeGreaterThan(0);
    expect(spy.allFiles()).toEqual(filesBefore);
    expect(spy.allFiles().map((f) => text(spy.peek(f)))).toEqual(bytesBefore);
  });
});

describe("acceptRun (R12.23, R12.24)", () => {
  it("positive control: a complete Run is accepted", async () => {
    const { fs, manifestSha256 } = await buildSealedRun();
    await writeCompletionMarker(fs, RUN_DIR);
    const a = await acceptRun(fs, RUN_DIR);
    expect(a.accepted).toBe(true);
    if (a.accepted) {
      expect(a.manifestSha256).toBe(manifestSha256);
      expect(a.manifest["runId"]).toBe("run-0001");
    }
  });

  it("accepts a marker that ends with one line break", async () => {
    const { fs, manifestSha256 } = await buildSealedRun();
    await writeCompletionMarker(fs, RUN_DIR, `${manifestSha256}\n`);
    expect((await acceptRun(fs, RUN_DIR)).accepted).toBe(true);
  });

  it("rejects a Run without a Completion_Marker as incomplete", async () => {
    const { fs } = await buildSealedRun();
    const a = await acceptRun(fs, RUN_DIR);
    expect(a).toMatchObject({ accepted: false, status: "incomplete", reason: "no_completion_marker" });
  });

  it("rejects a Run without a Run_Manifest as incomplete, even with a marker", async () => {
    const fs = new MemoryFileSystem();
    const store = await openStore(fs);
    await store.append("run_started", {});
    await writeCompletionMarker(fs, RUN_DIR, "a".repeat(64));
    expect(rejected(await acceptRun(fs, RUN_DIR))).toBe("no_manifest");
  });

  it.each([
    ["different hash", "f".repeat(64)],
    ["empty", ""],
    ["upper case", "ABCDEF"],
    ["hash with a space", " x"],
  ])("rejects a marker that does not equal the manifest hash (%s)", async (_n, content) => {
    const { fs } = await buildSealedRun();
    await writeCompletionMarker(fs, RUN_DIR, content);
    expect(rejected(await acceptRun(fs, RUN_DIR))).toBe("marker_mismatch");
  });

  it("rejects an upper-case copy of the correct hash", async () => {
    const { fs, manifestSha256 } = await buildSealedRun();
    await writeCompletionMarker(fs, RUN_DIR, manifestSha256.toUpperCase());
    expect(rejected(await acceptRun(fs, RUN_DIR))).toBe("marker_mismatch");
  });

  it("rejects a Run whose verification fails and returns the mismatches", async () => {
    const { fs, blobHash } = await buildSealedRun();
    await writeCompletionMarker(fs, RUN_DIR);
    fs.poke(`${RUN_DIR}/blobs/${blobHash}`, bytes("changed"));
    const a = await acceptRun(fs, RUN_DIR);
    expect(rejected(a)).toBe("verification_failed");
    expect(!a.accepted && a.report?.mismatches).toEqual([{ where: `blobs/${blobHash}`, kind: "modified" }]);
  });

  it("rejects a tamper that also rewrites the artifact hash in the manifest (marker no longer matches)", async () => {
    const { fs } = await buildSealedRun();
    await writeCompletionMarker(fs, RUN_DIR);
    const changed = text(fs.peek(rec())).replace('"n":2', '"n":9');
    fs.poke(rec(), bytes(changed));
    const m = JSON.parse(text(fs.peek(mf()))) as { artifacts: { path: string; sha256: string }[] };
    for (const a of m.artifacts) if (a.path === "records.jsonl") a.sha256 = sha256(changed);
    fs.poke(mf(), bytes(JSON.stringify(m)));
    expect(rejected(await acceptRun(fs, RUN_DIR))).toBe("marker_mismatch");
  });

  it("never accepts, and never reads, a directory under discovery/runs/.incoming/", async () => {
    const spy = new SpyFileSystem();
    const dir = "/discovery/runs/.incoming/run-0001";
    await buildSealedRun(spy, dir);
    await writeCompletionMarker(spy, dir);
    // Positive control: the same tree outside .incoming is accepted.
    const ok = new SpyFileSystem();
    await buildSealedRun(ok);
    await writeCompletionMarker(ok, RUN_DIR);
    expect((await acceptRun(ok, RUN_DIR)).accepted).toBe(true);

    spy.reset();
    expect(rejected(await acceptRun(spy, dir))).toBe("incoming_directory");
    expect(spy.reads).toEqual([]);
    expect(rejected(await acceptRun(spy, `${dir}/`))).toBe("incoming_directory");
    expect(rejected(await acceptRun(spy, "discovery\\runs\\.incoming\\run-0001"))).toBe("incoming_directory");
  });

  it("recognises .incoming as a whole path segment only", () => {
    expect(isIncomingPath("/a/.incoming/b")).toBe(true);
    expect(isIncomingPath("/a/.incoming")).toBe(true);
    expect(isIncomingPath("C:\\a\\.incoming\\b")).toBe(true);
    expect(isIncomingPath("/a/x.incoming/b")).toBe(false);
    expect(isIncomingPath("/a/incoming/b")).toBe(false);
  });
});

describe("with the real Node file system", () => {
  let tmp: string | undefined;
  afterEach(async () => {
    if (tmp !== undefined) await rm(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it("seals, verifies and accepts a Run on disk, and leaves the directory untouched", async () => {
    tmp = await mkdtemp(join(tmpdir(), "phoenix-verify-"));
    const dir = join(tmp, "run-0001").replace(/\\/g, "/");
    await mkdir(dir);
    const fs = createNodeFileSystem();
    const store = await openStore(fs, dir);
    await store.append("run_started", { n: 1 });
    await store.putAiOutput(bytes("{}"));
    const sealed = await store.seal(manifestInput());
    expect(sealed.ok).toBe(true);
    await writeCompletionMarker(fs, dir);

    const listing = async (): Promise<string[]> => (await readdir(dir, { recursive: true })).sort();
    const before = await listing();
    const recBefore = await readFile(join(dir, "records.jsonl"));
    expect((await acceptRun(fs, dir)).accepted).toBe(true);
    expect(await listing()).toEqual(before);
    expect((await readFile(join(dir, "records.jsonl"))).equals(recBefore)).toBe(true);

    await writeFile(join(dir, "stray.txt"), "x");
    const r = await verifyRunDirectory(fs, dir);
    expect(r.mismatches).toEqual([{ where: "stray.txt", kind: "unlisted" }]);
  });
});
