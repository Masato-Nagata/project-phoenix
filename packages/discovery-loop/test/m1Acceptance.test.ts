// M1 acceptance (task 1.24): Evidence_Store, Origin and Approval_Store. One place to run the checkpoint items.
// Focused on the requirements named below; deeper coverage lives in runRecordStore, runVerification, approval and report tests.
// Requirements: 6.10, 6.11, 12.2, 12.5, 12.9, 21.2, 23.2, 23.7.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as runtime from "../src/index.js";
import { MemoryFileSystem, RunRecordStore, verifyRunDirectory } from "../src/index.js";
import { ApprovalReader, analyzeStore, type TargetResolver } from "../src/approval/index.js";
import { appendApproval, appendStoreRejection, buildChain, fieldNames, loadVerifiedState, validateApprovalCandidate } from "../src/approval/tooling.js";
import { RUN_DIR, buildSealedRun, bytes, text } from "./helpers/runFixtures.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const anyTarget: TargetResolver = { resolves: () => true };
const DIR = "/run/out";

const candidate = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  approver: "Alice Example",
  timestamp: "2025-03-04T05:06:07.000+09:00",
  target: { kind: "run", run_id: "run-0001" },
  decision: "approved",
  rationale: "Reviewed.",
  recorded_by: "human",
  ...over,
});
function approvalText(...c: Record<string, unknown>[]): string {
  const r = buildChain(c, anyTarget);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value.text;
}

describe("Evidence_Store: altered record is reported as the right mismatch kind (R12.5, R12.9)", () => {
  it("a record edited without fixing its hash is a chain_break at that record id (records.jsonl modified)", async () => {
    const { fs } = await buildSealedRun();
    const path = `${RUN_DIR}/records.jsonl`;
    fs.poke(path, bytes(text(fs.peek(path)).replace('"n":2', '"n":9')));
    const r = await verifyRunDirectory(fs, RUN_DIR);
    expect(r.result).toBe("failure");
    expect(r.mismatches).toEqual([
      { where: "rec-000003", kind: "chain_break" },
      { where: "records.jsonl", kind: "modified" },
    ]);
  });
  it("an altered blob is modified, a removed blob is missing, and an extra file is unlisted", async () => {
    const a = await buildSealedRun();
    a.fs.poke(`${RUN_DIR}/blobs/${a.blobHash}`, bytes("changed"));
    expect((await verifyRunDirectory(a.fs, RUN_DIR)).mismatches).toEqual([{ where: `blobs/${a.blobHash}`, kind: "modified" }]);
    const b = await buildSealedRun();
    await b.fs.removeFile(`${RUN_DIR}/blobs/${b.blobHash}`);
    expect((await verifyRunDirectory(b.fs, RUN_DIR)).mismatches).toEqual([{ where: `blobs/${b.blobHash}`, kind: "missing" }]);
    const c = await buildSealedRun();
    c.fs.poke(`${RUN_DIR}/notes.txt`, bytes("x"));
    expect((await verifyRunDirectory(c.fs, RUN_DIR)).mismatches).toEqual([{ where: "notes.txt", kind: "unlisted" }]);
  });
  it("an untouched sealed Run verifies as success", async () => {
    const { fs } = await buildSealedRun();
    expect((await verifyRunDirectory(fs, RUN_DIR)).result).toBe("success");
  });
});

describe("Evidence_Store: modify and delete requests (R12.2, R6.10)", () => {
  it("leave existing records byte-identical and append a store_rejection for each", async () => {
    const fs = new MemoryFileSystem();
    fs.addDir(DIR);
    const opened = await RunRecordStore.open(fs, DIR);
    if (!opened.ok) throw new Error("open");
    const store = opened.value;
    await store.append("run_started", { a: 1 });
    await store.append("error", { b: 2 });
    const before = text(fs.peek(`${DIR}/records.jsonl`));
    const m = await store.requestModify("rec-000001", "orchestrator");
    const d = await store.requestDelete("rec-000002", "orchestrator");
    expect(!m.ok && m.error.kind).toBe("rejected");
    expect(!d.ok && d.error.kind).toBe("rejected");
    const after = text(fs.peek(`${DIR}/records.jsonl`));
    expect(after.startsWith(before)).toBe(true); // earlier bytes unchanged
    const added = after.slice(before.length).split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(added.map((r) => r.kind)).toEqual(["store_rejection", "store_rejection"]);
    expect(added.map((r) => r.payload.attempt)).toEqual(["modify_record", "delete_record"]);
  });
});

describe("Evidence_Store: pre-existing Run directory is refused (R21.2)", () => {
  it("a non-empty directory is refused and left untouched", async () => {
    const fs = new MemoryFileSystem();
    fs.addDir(DIR);
    fs.poke(`${DIR}/records.jsonl`, new Uint8Array([1, 2, 3]));
    const r = await RunRecordStore.open(fs, DIR);
    expect(!r.ok && r.error.kind).toBe("run_volume_not_empty");
    expect(fs.peek(`${DIR}/records.jsonl`)).toEqual(new Uint8Array([1, 2, 3]));
    expect(fs.allFiles()).toEqual([`${DIR}/records.jsonl`]);
  });
  it("a directory holding a subdirectory is refused too", async () => {
    const fs = new MemoryFileSystem();
    fs.addDir(DIR);
    fs.poke(`${DIR}/blobs/x`, new Uint8Array([1]));
    const r = await RunRecordStore.open(fs, DIR);
    expect(!r.ok && r.error.kind).toBe("run_volume_not_empty");
  });
});

describe("Approval_Store: tamper, modify and delete (R23.2, R6.10)", () => {
  it("an altered line is reported as modified", () => {
    const edited = approvalText(candidate()).replace("Reviewed.", "Edited.");
    const report = analyzeStore(edited).report;
    expect(report.ok).toBe(false);
    expect(report.mismatches.map((m) => `${m.seq}:${m.kind}`)).toEqual(["1:modified"]);
  });
  it("a removed line is missing and breaks the chain of the next line", () => {
    const lines = approvalText(candidate(), candidate({ decision: "rejected", supersedes: 1 }), candidate({ rationale: "Third." })).split("\n").slice(0, -1);
    const report = analyzeStore(`${lines[0]}\n${lines[2]}\n`).report;
    expect(report.mismatches.map((m) => `${m.seq}:${m.kind}`)).toEqual(["2:missing", "3:chain_break"]);
  });
  it("a delete or modify request appends a store_rejection and leaves the earlier text byte-identical", () => {
    const first = appendApproval("", candidate(), anyTarget);
    if (!first.ok) throw new Error("setup");
    for (const reason of ["modify request refused", "delete request refused"]) {
      const before = first.value.text;
      const r = appendStoreRejection(before, reason, 1);
      if (!r.ok) throw new Error("setup");
      expect(r.value.text.startsWith(before)).toBe(true);
      expect(r.value.line.seq).toBe(2);
      expect(r.value.line).toMatchObject({ type: "store_rejection", reason });
      expect(ApprovalReader.fromBytes(r.value.text, anyTarget).verify().ok).toBe(true);
    }
  });
});

describe("Approval_Record validation (R23.7)", () => {
  const ctx = () => {
    const loaded = loadVerifiedState(approvalText(candidate({ decision: "needs_changes" })));
    if (!loaded.ok) throw new Error("setup");
    return { state: loaded.value, resolver: anyTarget };
  };
  it.each(["approver", "timestamp", "target", "decision", "rationale", "recorded_by"])("a record lacking %s is rejected naming that field", (field) => {
    const c = candidate();
    delete c[field];
    const r = validateApprovalCandidate(c, ctx());
    if (r.ok) throw new Error("expected rejection");
    expect(fieldNames(r.error)).toEqual([field]);
  });
  it.each(["robot", "ai", "", "Human", undefined])("a wrong actor declaration %j is rejected naming recorded_by", (actor) => {
    const r = validateApprovalCandidate(candidate({ recorded_by: actor }), ctx());
    if (r.ok) throw new Error("expected rejection");
    expect(fieldNames(r.error)).toEqual(["recorded_by"]);
  });
  it("a rejected append leaves the store text byte-identical", () => {
    const before = approvalText(candidate());
    const copy = `${before}`;
    const r = appendApproval(before, candidate({ approver: "" }), anyTarget);
    expect(r.ok).toBe(false);
    expect(before).toBe(copy);
  });
});

// --- static check: the runtime entry point has no Approval writer and does not reach the reader or report ---

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["'](\.[^"']*)["']/g;

function resolveModule(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const c of [`${base}.ts`, resolve(base, "index.ts")]) if (existsSync(c)) return c;
  return undefined;
}
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const m of readFileSync(f, "utf8").matchAll(IMPORT_RE)) {
      const t = resolveModule(f, m[1] as string);
      if (t !== undefined) stack.push(t);
    }
  }
  return [...seen];
}
const forbidden = (f: string): boolean => {
  const rel = f.startsWith(SRC) ? f.slice(SRC.length) : f;
  return rel.startsWith(`approval${sep}`) || rel.startsWith(`report${sep}`);
};

describe("runtime entry point isolation (R6.11)", () => {
  it("exports no Approval write function, reader or validator", () => {
    const names = Object.keys(runtime);
    expect(names.filter((n) => /approv/i.test(n) && !/^deriveApprovalStatus$/.test(n))).toEqual([]);
    expect(names.filter((n) => /^(append|write|build|validate)\w*(Approval|Chain)/i.test(n))).toEqual([]);
  });
  it("does not import (transitively) the Approval_Store reader or the report entry point", () => {
    const files = reachable(resolve(SRC, "index.ts"));
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter(forbidden)).toEqual([]);
  });
  it("positive control: a fixture entry that reaches the reader through one hop is detected", () => {
    const fixture = fileURLToPath(new URL("./fixtures/runtimeLeak/entry.ts", import.meta.url));
    expect(reachable(fixture).filter(forbidden).map((f) => f.slice(SRC.length))).toContain(`approval${sep}reader.ts`);
  });
});
