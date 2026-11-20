// Task 4.4, unit U2: the RecordWriter (`src/orchestrator/recordWriter.ts`). Deterministic and offline. It uses the REAL `RunRecordStore` on a
// `MemoryFileSystem`, a fault-injecting wrapper of the file-system port (the Nth call of an operation fails with an error whose code is EIO),
// and `vi.spyOn` counters on the store methods. Nothing is mocked to make a test pass: the store behaviour is the real one.
// **Validates: Requirements 12.5, 12.13, 12.14, 12.11, 11.15, 11.16**
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryFileSystem, RunRecordStore, type FileSystemPort, type JsonObject } from "../src/index.js";
import { WRITER_ERROR_CODES, createRecordWriter, type RecordWriter, type WriterRecordView } from "../src/orchestrator/recordWriter.js";
import { createAcceptanceCheck } from "../../verifier/src/identity/acceptance.js";
import { manifestInput } from "./helpers/runFixtures.js";

const DIR = "/run/out";
const CANARY = "canary-value-9f8e7d6c5b";
const SECRET_NAME = "CANARY_KEY";
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const data = (s: string): Uint8Array => new TextEncoder().encode(s);
const has = (v: unknown, s: string): boolean => JSON.stringify(v).includes(s);

type Op = "writeFileSynced" | "rename" | "syncDir" | "readFile";
/** Delegates to a MemoryFileSystem; `arm(op, n)` makes the n-th next call of `op` fail once with an error whose code is EIO. */
function faultFs(inner: MemoryFileSystem): { fs: FileSystemPort; arm(op: Op, nth?: number): void; hold(op: Op): () => void } {
  let plan: { op: Op; left: number } | undefined;
  let holdPlan: { op: Op; gate: Promise<void> } | undefined;
  /** The next call of the held operation waits for its gate (once); every other call is not delayed at all. */
  const takeHold = (op: Op): Promise<void> | undefined => {
    if (holdPlan === undefined || holdPlan.op !== op) return undefined;
    const g = holdPlan.gate;
    holdPlan = undefined;
    return g;
  };
  const hit = (op: Op): void => {
    if (plan === undefined || plan.op !== op) return;
    plan.left -= 1;
    if (plan.left === 0) {
      plan = undefined;
      throw Object.assign(new Error("EIO"), { code: "EIO" });
    }
  };
  const fs: FileSystemPort = {
    listDir: (p) => inner.listDir(p),
    mkdir: (p) => inner.mkdir(p),
    writeFileSynced: async (p, d) => {
      const held = takeHold("writeFileSynced");
      if (held !== undefined) await held;
      hit("writeFileSynced");
      await inner.writeFileSynced(p, d);
    },
    rename: async (a, b) => {
      hit("rename");
      await inner.rename(a, b);
    },
    syncDir: async (p) => {
      hit("syncDir");
      await inner.syncDir(p);
    },
    readFile: async (p) => {
      hit("readFile");
      return inner.readFile(p);
    },
    removeFile: (p) => inner.removeFile(p),
  };
  return {
    fs,
    arm: (op, nth = 1) => {
      plan = { op, left: nth };
    },
    hold: (op) => {
      let release: () => void = noopFn;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      holdPlan = { op, gate };
      return release;
    },
  };
}
const noopFn = (): void => undefined;
/** Lets every already-resolved promise continuation run (the fake file system never waits on real time). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

async function setup() {
  const mem = new MemoryFileSystem();
  mem.addDir(DIR);
  const f = faultFs(mem);
  const opened = await RunRecordStore.open(f.fs, DIR, { secrets: { envValues: [{ name: SECRET_NAME, value: CANARY }] } });
  if (!opened.ok) throw new Error("open failed");
  const store = opened.value;
  const spies = {
    append: vi.spyOn(store, "append"),
    putBlob: vi.spyOn(store, "putBlob"),
    putAiOutput: vi.spyOn(store, "putAiOutput"),
    seal: vi.spyOn(store, "seal"),
  };
  const calls = (): number[] => [spies.append, spies.putBlob, spies.putAiOutput, spies.seal].map((s) => s.mock.calls.length);
  const { writer, channel } = createRecordWriter(store);
  return { mem, arm: f.arm, hold: f.hold, store, writer, channel, spies, calls };
}
const manifestPath = `${DIR}/manifest.json`;
const code = (r: { ok: boolean; error?: { code: string } }): string | undefined => (r.ok ? undefined : r.error?.code);

describe("order", () => {
  it("runs operations strictly in call order, also when the caller does not await", async () => {
    const { writer, store } = await setup();
    const rs = await Promise.all([
      writer.append("run_started", { n: 1 }),
      writer.append("ai_call", { n: 2 }),
      writer.putBlob(data("blob-a")),
      writer.putAiOutput(data('{"reply":true}')),
      writer.append("error", { n: 5 }),
    ]);
    expect(rs.every((r) => r.ok)).toBe(true);
    const seqs = rs.map((r) => (r.ok && "seq" in r.value ? r.value.seq : r.ok && "record" in r.value ? r.value.record.seq : undefined));
    expect(seqs).toEqual([1, 2, undefined, 3, 4]);
    expect(store.list().map((r) => r.kind)).toEqual(["run_started", "ai_call", "ai_output", "error"]);
  });
  it("each queued operation checks the state at ITS turn: a failure in the middle makes the later ones writer_down", async () => {
    const { writer, store, arm, spies } = await setup();
    arm("writeFileSynced", 2); // the second record write fails
    const rs = await Promise.all([writer.append("error", { n: 1 }), writer.append("error", { n: 2 }), writer.append("error", { n: 3 }), writer.putBlob(data("x"))]);
    expect(rs.map(code)).toEqual([undefined, "io_failure", "writer_down", "writer_down"]);
    expect(store.count).toBe(1);
    expect(spies.append.mock.calls.length).toBe(2); // the third was never given to the store
    expect(spies.putBlob.mock.calls.length).toBe(0);
  });
});

describe("success shapes", () => {
  it("append returns the store envelope; putBlob returns the blob reference; putAiOutput returns the record and the blob", async () => {
    const { writer } = await setup();
    const a = await writer.append("run_started", { n: 1 });
    expect(a.ok && a.value).toMatchObject({ seq: 1, id: "rec-000001", kind: "run_started", payload: { n: 1 } });
    const b = await writer.putBlob(data("hello"));
    expect(b).toEqual({ ok: true, value: { blob: sha(data("hello")), bytes: 5 } });
    const out = data('{"x":1}');
    const c = await writer.putAiOutput(out);
    expect(c.ok && c.value.blob).toEqual({ blob: sha(out), bytes: out.length });
    expect(c.ok && c.value.record).toMatchObject({ kind: "ai_output", seq: 2, payload: { output: { blob: sha(out), bytes: out.length } } });
  });
  it("passes the component to the store option only, and never echoes it", async () => {
    const { writer, spies, store } = await setup();
    await writer.append("error", { n: 1 });
    await writer.append("error", { n: 2 }, "comp-x");
    expect(spies.append.mock.calls[0]?.[2]).toEqual({});
    expect(spies.append.mock.calls[1]?.[2]).toEqual({ component: "comp-x" });
    const r = await writer.append("ai_call", { note: CANARY }, "comp-x");
    expect(has(r, "comp-x")).toBe(false);
    expect(store.list().find((x) => x.kind === "store_rejection")?.payload).toMatchObject({ component: "comp-x" });
  });
});

describe("failure latch (R12.14)", () => {
  it("an EIO on any step of an append makes the writer down and the first failure is kept", async () => {
    for (const op of ["writeFileSynced", "rename", "syncDir"] as const) {
      const { writer, arm, mem } = await setup();
      arm(op);
      const r = await writer.append("error", { n: 1 });
      expect(r, op).toEqual({ ok: false, error: { code: "io_failure" } });
      expect(writer.state(), op).toEqual({ down: true, sealed: false, terminationWritten: false, secretRejections: 0, invalidRecords: 0, failure: "io_failure" });
      expect(has(r, "EIO") || has(r, "write failed"), op).toBe(false);
      expect(mem.allFiles().filter((f) => f.endsWith(".tmp")), op).toEqual([]);
    }
  });
  it("after down, append, putBlob, putAiOutput and seal each answer writer_down and the store is not called again", async () => {
    const { writer, channel, arm, spies, calls, mem } = await setup();
    arm("writeFileSynced");
    expect(code(await writer.append("error", { n: 1 }))).toBe("io_failure");
    const callsBefore = calls();
    const filesBefore = mem.allFiles();
    const rs = [await writer.append("error", { n: 2 }), await channel.appendTermination({ terminationReason: "error" }), await writer.putBlob(data("a")), await writer.putAiOutput(data("b")), await channel.seal(manifestInput())];
    expect(rs.map(code)).toEqual(["writer_down", "writer_down", "writer_down", "writer_down", "writer_down"]);
    expect(calls()).toEqual(callsBefore);
    expect(mem.allFiles()).toEqual(filesBefore);
    expect(spies.seal.mock.calls.length).toBe(0);
  });
  it("a failed blob write and a failed AI-output write take the writer down", async () => {
    const one = await setup();
    one.arm("writeFileSynced");
    expect(code(await one.writer.putBlob(data("blob")))).toBe("io_failure");
    expect(one.writer.state().down).toBe(true);
    const two = await setup();
    two.arm("writeFileSynced");
    expect(code(await two.writer.putAiOutput(data("out")))).toBe("io_failure");
    expect(two.writer.state()).toMatchObject({ down: true, failure: "io_failure" });
    expect(two.store.count).toBe(0);
    expect(code(await two.writer.append("error", { n: 1 }))).toBe("writer_down");
  });
  it("a failure never turns into a success on retry, even when the file system works again", async () => {
    const { writer, arm, store } = await setup();
    arm("rename");
    expect(code(await writer.append("error", { n: 1 }))).toBe("io_failure");
    for (let i = 0; i < 3; i++) expect(await writer.append("error", { n: 1 })).toEqual({ ok: false, error: { code: "writer_down" } });
    expect(store.count).toBe(0);
    expect(writer.state().failure).toBe("io_failure"); // the first failure is kept
  });
  it("a thrown exception or a rejected promise of the store is an io_failure, the message is dropped, and the writer is down", async () => {
    for (const mode of ["throw", "reject"] as const) {
      const { writer, spies } = await setup();
      if (mode === "throw") {
        spies.append.mockImplementation(() => {
          throw new Error("secret-ish message write failed: EIO");
        });
      } else {
        spies.append.mockRejectedValue(new Error("secret-ish message write failed: EIO"));
      }
      const r = await writer.append("error", { n: 1 });
      expect(r, mode).toEqual({ ok: false, error: { code: "io_failure" } });
      expect(writer.state().failure, mode).toBe("io_failure");
      expect(code(await writer.putBlob(data("x"))), mode).toBe("writer_down");
      expect(spies.append.mock.calls.length, mode).toBe(1);
      expect(spies.putBlob.mock.calls.length, mode).toBe(0);
    }
  });
  it("a store_failed answer takes the writer down with failure store_failed; no store message reaches any result, for all four operations", async () => {
    const msg = "write failed: EIO";
    const io = { ok: false as const, error: { kind: "io_failure" as const, message: msg } };
    const sf = { ok: false as const, error: { kind: "store_failed" as const, message: msg } };
    const names = ["append", "putBlob", "putAiOutput", "seal"] as const;
    for (const n of names) {
      for (const reply of [io, sf]) {
        const { writer, channel, spies } = await setup();
        spies[n].mockResolvedValue(reply as never);
        if (n === "seal") await channel.appendTermination({ terminationReason: "error" });
        const r =
          n === "append" ? await writer.append("error", { n: 1 })
          : n === "putBlob" ? await writer.putBlob(data("x"))
          : n === "putAiOutput" ? await writer.putAiOutput(data("x"))
          : await channel.seal(manifestInput());
        if (n === "seal") expect(spies.seal.mock.calls.length).toBe(1);
        expect(r, `${n} ${reply.error.kind}`).toEqual({ ok: false, error: { code: reply.error.kind } });
        expect(has(r, "EIO") || has(r, "write failed"), n).toBe(false);
        expect(writer.state().down, n).toBe(true);
        expect(has(writer.state(), "EIO"), n).toBe(false);
      }
    }
  });
});

describe("secret and invalid answers keep the writer up", () => {
  it("secret_rejected: a code only, counted, not down, later writes work, and neither the canary nor the pattern id appears in any result or state", async () => {
    const { writer, store } = await setup();
    const results = [
      await writer.append("ai_call", { note: CANARY }),
      await writer.putBlob(data(`prefix ${CANARY} suffix`)),
      await writer.putAiOutput(data(CANARY)),
    ];
    expect(results.map(code)).toEqual(["secret_rejected", "secret_rejected", "secret_rejected"]);
    for (const r of results) expect(r).toEqual({ ok: false, error: { code: "secret_rejected" } });
    expect(writer.state()).toEqual({ down: false, sealed: false, terminationWritten: false, secretRejections: 3, invalidRecords: 0 });
    const later = await writer.append("error", { n: 1 });
    expect(later.ok && later.value.seq).toBe(4); // three rejection records were written by the store
    // the test is meaningful: the store itself did name the pattern id in its own rejection record
    expect(JSON.stringify(store.list())).toContain(`env:${SECRET_NAME}`);
    for (const forbidden of [CANARY, SECRET_NAME, "env:"]) expect(has([results, writer.state()], forbidden), forbidden).toBe(false);
  });
  it("invalid_record (a payload that is not canonical JSON): a code only, nothing written, not down", async () => {
    const { writer, store } = await setup();
    const nan = await writer.append("error", { n: Number.NaN });
    const undef = await writer.append("error", { n: undefined } as unknown as JsonObject);
    expect(nan).toEqual({ ok: false, error: { code: "invalid_record" } });
    expect(undef).toEqual({ ok: false, error: { code: "invalid_record" } });
    expect(store.count).toBe(0);
    expect(writer.state()).toEqual({ down: false, sealed: false, terminationWritten: false, secretRejections: 0, invalidRecords: 2 });
    expect((await writer.append("error", { n: 1 })).ok).toBe(true);
  });
});

describe("termination and seal rules", () => {
  it("a second termination is refused without a store call; after a written termination only seal is allowed", async () => {
    const { writer, channel, spies, calls } = await setup();
    const first = await channel.appendTermination({ terminationReason: "error" });
    expect(first.ok).toBe(true);
    expect(writer.state().terminationWritten).toBe(true);
    const before = calls();
    expect(code(await channel.appendTermination({ terminationReason: "error" }))).toBe("duplicate_termination");
    expect(code(await writer.append("error", { n: 1 }))).toBe("closed_after_termination");
    expect(code(await writer.putBlob(data("a")))).toBe("closed_after_termination");
    expect(code(await writer.putAiOutput(data("a")))).toBe("closed_after_termination");
    expect(calls()).toEqual(before);
    expect(spies.append.mock.calls.length).toBe(1);
  });
  it("a termination write that FAILED does not count as written (invalid record, then secret hit)", async () => {
    const { writer, channel } = await setup();
    expect(code(await channel.appendTermination({ n: Number.NaN }))).toBe("invalid_record");
    expect(writer.state().terminationWritten).toBe(false);
    expect((await channel.appendTermination({ terminationReason: "error" })).ok).toBe(true); // an invalid record does not block the record
    expect(writer.state().terminationWritten).toBe(true);
    const secret = await setup();
    expect(code(await secret.channel.appendTermination({ terminationReason: CANARY }))).toBe("secret_rejected");
    expect(secret.writer.state().terminationWritten).toBe(false);
    // a rejected write blocks the normal termination record from now on (queue-time gate), and still nothing was written for it
    expect(code(await secret.channel.appendTermination({ terminationReason: "error" }))).toBe("evidence_rejected");
    expect(secret.writer.state().terminationWritten).toBe(false);
    expect(secret.spies.append.mock.calls.length).toBe(1);
  });
  it("seal before a termination record is refused without a store call", async () => {
    const { writer, channel, spies, mem } = await setup();
    expect(code(await channel.seal(manifestInput()))).toBe("termination_missing");
    expect(spies.seal.mock.calls.length).toBe(0);
    expect(mem.peek(manifestPath)).toBeUndefined();
  });
  it("seal succeeds after the termination record; the sha256 is the store's; a second seal is refused without a store call", async () => {
    const { writer, channel, spies, mem } = await setup();
    await channel.appendTermination({ terminationReason: "error" });
    const r = await channel.seal(manifestInput({ terminationReason: "error" }));
    expect(r.ok).toBe(true);
    const fromStore = (await spies.seal.mock.results[0]?.value) as unknown as { ok: true; value: { sha256: string } };
    expect(r.ok && r.value.sha256).toBe(fromStore.value.sha256);
    expect(r.ok && r.value.sha256).toBe(sha(mem.peek(manifestPath) as Uint8Array));
    expect(writer.state().sealed).toBe(true);
    expect(code(await channel.seal(manifestInput()))).toBe("already_sealed");
    expect(code(await writer.append("error", { n: 1 }))).toBe("closed_after_termination");
    expect(spies.seal.mock.calls.length).toBe(1);
  });
  it("seal answers: a forbidden key -> invalid_record (not counted); a valid seal works; a secret in the manifest -> secret_rejected (unsealed, no manifest.json, not down)", async () => {
    const { writer, channel, mem, spies } = await setup();
    await channel.appendTermination({ terminationReason: "error" });
    const bad = await channel.seal(manifestInput({ chain: { records: 1, lastHash: "0" } }));
    expect(bad).toEqual({ ok: false, error: { code: "invalid_record" } });
    expect(writer.state()).toEqual({ down: false, sealed: false, terminationWritten: true, secretRejections: 0, invalidRecords: 0 });
    const secret = await channel.seal(manifestInput({ config: { note: CANARY } }));
    expect(secret).toEqual({ ok: false, error: { code: "secret_rejected" } });
    expect(mem.peek(manifestPath)).toBeUndefined();
    expect(writer.state()).toEqual({ down: false, sealed: false, terminationWritten: true, secretRejections: 1, invalidRecords: 0 });
    // the rejection of the manifest is a rejected write: a normal seal is blocked from now on, and the store seal is not called for it
    const sealCalls = spies.seal.mock.calls.length;
    expect(await channel.seal(manifestInput({ terminationReason: "error" }))).toEqual({ ok: false, error: { code: "evidence_rejected" } });
    expect(spies.seal.mock.calls.length).toBe(sealCalls);
    expect(mem.peek(manifestPath)).toBeUndefined();
  });
  it("seal after a valid manifest works when nothing was rejected (an invalid_record before it does not matter)", async () => {
    const { channel, mem } = await setup();
    await channel.appendTermination({ terminationReason: "error" });
    expect((await channel.seal(manifestInput({ chain: { records: 1, lastHash: "0" } }))).ok).toBe(false);
    expect((await channel.seal(manifestInput({ terminationReason: "error" }))).ok).toBe(true);
    expect(mem.peek(manifestPath)).toBeDefined();
  });
  it("a seal failure (EIO on each step) takes the writer down; the later seal is writer_down", async () => {
    for (const op of ["readFile", "writeFileSynced", "rename", "syncDir"] as const) {
      const { writer, channel, arm, mem } = await setup();
      await channel.appendTermination({ terminationReason: "error" });
      arm(op);
      const r = await channel.seal(manifestInput({ terminationReason: "error" }));
      expect(r, op).toEqual({ ok: false, error: { code: "io_failure" } });
      expect(writer.state(), op).toMatchObject({ down: true, sealed: false, failure: "io_failure" });
      expect(code(await channel.seal(manifestInput())), op).toBe("writer_down");
      if (op !== "syncDir") expect(mem.peek(manifestPath), op).toBeUndefined(); // after a failed directory sync the renamed file may exist, but the Run is not sealed
    }
  });
});

describe("state and vocabulary", () => {
  it("the state is frozen and has exactly the pinned keys (failure only after a failure)", async () => {
    const { writer, arm } = await setup();
    const s = writer.state();
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.keys(s).sort()).toEqual(["down", "invalidRecords", "secretRejections", "sealed", "terminationWritten"].sort());
    arm("writeFileSynced");
    await writer.append("error", { n: 1 });
    const down = writer.state();
    expect(Object.isFrozen(down)).toBe(true);
    expect(Object.keys(down).sort()).toEqual(["down", "failure", "invalidRecords", "secretRejections", "sealed", "terminationWritten"].sort());
    expect(Object.isFrozen(writer)).toBe(true);
    expect(Object.keys(writer).sort()).toEqual(["append", "drain", "putAiOutput", "putBlob", "records", "state"]);
  });
  it("the closed codes are pinned, and every failure result is a frozen object with exactly one key `code`", async () => {
    expect([...WRITER_ERROR_CODES]).toEqual([
      "invalid_record", "secret_rejected", "io_failure", "store_failed", "writer_down", "duplicate_termination", "closed_after_termination", "termination_missing", "already_sealed",
      "evidence_rejected", "admission_closed", "termination_reserved",
    ]);
    expect(WRITER_ERROR_CODES).toHaveLength(12);
    expect(Object.isFrozen(WRITER_ERROR_CODES)).toBe(true);
    const { channel } = await setup();
    const r = await channel.seal(manifestInput());
    expect(Object.isFrozen(r)).toBe(true);
    expect(!r.ok && Object.keys(r.error)).toEqual(["code"]);
    expect(!r.ok && Object.isFrozen(r.error)).toBe(true);
  });
});

describe("admission gate", () => {
  it("jobs accepted before closeAdmission() are not cancelled: they complete in call order with normal results", async () => {
    const { writer, channel, store, hold } = await setup();
    const release = hold("writeFileSynced"); // the first job stays pending while admission is closed
    const p1 = writer.append("run_started", { n: 1 });
    const p2 = writer.append("ai_call", { n: 2 });
    const p3 = writer.putBlob(data("blob-a"));
    channel.closeAdmission();
    release();
    const rs = await Promise.all([p1, p2, p3]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(store.list().map((r) => r.kind)).toEqual(["run_started", "ai_call"]);
    expect(writer.state()).toEqual({ down: false, sealed: false, terminationWritten: false, secretRejections: 0, invalidRecords: 0 });
  });
  it("a normal write after closeAdmission() is refused with admission_closed at accept time: no store call, nothing queued, nothing counted", async () => {
    const { writer, channel, hold, spies, calls } = await setup();
    const release = hold("writeFileSynced");
    const pending = writer.append("error", { n: 1 }); // accepted before the closing, still pending
    await flush();
    const before = calls();
    channel.closeAdmission();
    channel.closeAdmission(); // idempotent
    // each answer arrives while the earlier job is still pending: the refusal is not in the queue
    const a = await writer.append("ai_call", { note: CANARY });
    const b = await writer.putBlob(data(CANARY));
    const c = await writer.putAiOutput(data(CANARY));
    for (const r of [a, b, c]) expect(r).toEqual({ ok: false, error: { code: "admission_closed" } });
    expect(calls()).toEqual(before);
    expect(spies.append.mock.calls.length).toBe(1);
    expect(writer.state().secretRejections).toBe(0);
    release();
    expect((await pending).ok).toBe(true);
    expect(writer.state()).toEqual({ down: false, sealed: false, terminationWritten: false, secretRejections: 0, invalidRecords: 0 });
  });
  it("closing admission is synchronous: the very next call in the same tick is refused", async () => {
    const { writer, channel } = await setup();
    channel.closeAdmission();
    const p = writer.append("error", { n: 1 });
    expect(await p).toEqual({ ok: false, error: { code: "admission_closed" } });
  });
  it("admission_closed becomes closed_after_termination once the termination record was written", async () => {
    const { writer, channel, store } = await setup();
    channel.closeAdmission();
    expect(code(await writer.append("error", { n: 1 }))).toBe("admission_closed");
    expect((await channel.appendTermination({ terminationReason: "error" })).ok).toBe(true); // closing does not block the termination record
    expect(code(await writer.append("error", { n: 2 }))).toBe("closed_after_termination");
    expect(code(await writer.putBlob(data("x")))).toBe("closed_after_termination");
    expect(code(await writer.putAiOutput(data("x")))).toBe("closed_after_termination");
    expect(code(await channel.appendTermination({ terminationReason: "error" }))).toBe("duplicate_termination");
    expect((await channel.seal(manifestInput({ terminationReason: "error" }))).ok).toBe(true); // nor does it block the seal
    expect(code(await channel.seal(manifestInput()))).toBe("already_sealed");
    expect(store.list().map((r) => r.kind)).toEqual(["termination"]);
  });
  it("a public append of kind termination is always termination_reserved: no store call, nothing queued, also when the writer is down or closed", async () => {
    const { writer, channel, arm, hold, calls } = await setup();
    const release = hold("writeFileSynced");
    const pending = writer.append("error", { n: 1 });
    await flush();
    const before = calls();
    expect(await writer.append("termination", { terminationReason: "error" })).toEqual({ ok: false, error: { code: "termination_reserved" } }); // answered while the job is pending
    channel.closeAdmission();
    expect(code(await writer.append("termination", { terminationReason: "error" }))).toBe("termination_reserved");
    expect(calls()).toEqual(before);
    release();
    await pending;
    const down = await setup();
    down.arm("writeFileSynced");
    await down.writer.append("error", { n: 1 });
    expect(down.writer.state().down).toBe(true);
    const callsDown = down.calls();
    expect(code(await down.writer.append("termination", { terminationReason: "error" }))).toBe("termination_reserved");
    expect(down.calls()).toEqual(callsDown);
    expect(down.writer.state().terminationWritten).toBe(false);
    void arm;
  });
});

describe("drain", () => {
  it("is safe when nothing is queued, and calls the store never", async () => {
    const { writer, channel, calls } = await setup();
    await expect(writer.drain()).resolves.toBeUndefined();
    await expect(channel.drain()).resolves.toBeUndefined();
    expect(calls()).toEqual([0, 0, 0, 0]);
  });
  it("is pending until the earlier jobs completed, and does not wait for jobs accepted after the call", async () => {
    const { writer, hold, store } = await setup();
    const release1 = hold("writeFileSynced");
    const p1 = writer.append("error", { n: 1 });
    await flush(); // job 1 has started and is waiting on the gate
    const release2 = hold("writeFileSynced");
    const p2 = writer.append("error", { n: 2 }); // accepted before the drain: it must be awaited
    let drained = false;
    const d = writer.drain().then(() => {
      drained = true;
    });
    const p3 = writer.append("error", { n: 3 }); // accepted AFTER the drain call: it must not be awaited
    let p3done = false;
    void p3.then(() => {
      p3done = true;
    });
    await flush();
    expect(drained).toBe(false);
    release1();
    await flush();
    expect(drained).toBe(false); // job 2 is held
    release2();
    await d;
    expect((await p1).ok && (await p2).ok).toBe(true);
    expect(drained).toBe(true);
    expect(store.count).toBeGreaterThanOrEqual(2);
    await p3;
    expect(p3done).toBe(true);
    expect(store.count).toBe(3);
  });
  it("does not hide a failure: after a failing job drain() resolves, and state() shows down and the failure", async () => {
    const { writer, channel, arm, calls } = await setup();
    arm("writeFileSynced");
    const p = writer.append("error", { n: 1 });
    const q = writer.putBlob(data("x"));
    const callsAtDrain = calls();
    await expect(channel.drain()).resolves.toBeUndefined();
    expect(writer.state()).toEqual({ down: true, sealed: false, terminationWritten: false, secretRejections: 0, invalidRecords: 0, failure: "io_failure" });
    expect(channel.state()).toEqual(writer.state());
    expect(code(await p)).toBe("io_failure");
    expect(code(await q)).toBe("writer_down");
    expect(callsAtDrain).toEqual([0, 0, 0, 0]); // the drain itself is not what called the store (the jobs run later)
  });
  it("a thrown store call does not make drain reject", async () => {
    const { writer, spies } = await setup();
    spies.append.mockImplementation(() => {
      throw new Error("boom");
    });
    void writer.append("error", { n: 1 });
    await expect(writer.drain()).resolves.toBeUndefined();
    expect(writer.state()).toMatchObject({ down: true, failure: "io_failure" });
  });
});

describe("queue-time gates (secret rejection that happens during the drain window)", () => {
  it("termination append and seal accepted behind a still-pending write that gets rejected are refused with evidence_rejected, without a store call", async () => {
    const { writer, channel, hold, spies, store } = await setup();
    const release = hold("writeFileSynced"); // the secret write is pending when the others are accepted
    const w = writer.append("ai_call", { note: CANARY });
    channel.closeAdmission();
    const t = channel.appendTermination({ terminationReason: "error" });
    const s = channel.seal(manifestInput({ terminationReason: "error" }));
    release();
    const [rw, rt, rs] = await Promise.all([w, t, s]);
    expect(rw).toEqual({ ok: false, error: { code: "secret_rejected" } });
    expect(rt).toEqual({ ok: false, error: { code: "evidence_rejected" } });
    expect(rs).toEqual({ ok: false, error: { code: "evidence_rejected" } });
    expect(spies.append.mock.calls.length).toBe(1); // only the secret write
    expect(spies.seal.mock.calls.length).toBe(0);
    expect(store.list().map((r) => r.kind)).toEqual(["store_rejection"]);
    expect(writer.state()).toEqual({ down: false, sealed: false, terminationWritten: false, secretRejections: 1, invalidRecords: 0 });
    for (const forbidden of [CANARY, SECRET_NAME, "env:"]) expect(has([rw, rt, rs, writer.state()], forbidden), forbidden).toBe(false);
  });
  it("a seal queued behind a rejected seal is evidence_rejected at its turn (the store seal is called once)", async () => {
    const { channel, spies } = await setup();
    const a = channel.appendTermination({ terminationReason: "error" });
    const b = channel.seal(manifestInput({ config: { note: CANARY } }));
    const c = channel.seal(manifestInput({ terminationReason: "error" }));
    expect((await a).ok).toBe(true);
    expect(code(await b)).toBe("secret_rejected");
    expect(code(await c)).toBe("evidence_rejected");
    expect(spies.seal.mock.calls.length).toBe(1);
  });
  it("the existing gates keep their codes at the queue turn: duplicate_termination, then io_failure and writer_down", async () => {
    const { channel, arm } = await setup();
    expect((await channel.appendTermination({ terminationReason: "error" })).ok).toBe(true);
    expect(code(await channel.appendTermination({ terminationReason: "error" }))).toBe("duplicate_termination");
    arm("writeFileSynced");
    expect(code(await channel.seal(manifestInput({ terminationReason: "error" })))).toBe("io_failure");
    expect(code(await channel.seal(manifestInput()))).toBe("writer_down");
    expect(code(await channel.appendTermination({ terminationReason: "error" }))).toBe("writer_down");
  });
});

describe("authority: two separate capabilities", () => {
  it("the public writer has exactly the pinned keys and none of the termination capabilities; both objects are frozen and distinct", async () => {
    const { writer, channel } = await setup();
    expect(Object.keys(writer).sort()).toEqual(["append", "drain", "putAiOutput", "putBlob", "records", "state"]);
    expect(Object.keys(channel).sort()).toEqual(["appendTermination", "closeAdmission", "drain", "seal", "state"]);
    for (const k of ["seal", "appendTermination", "closeAdmission", "channel"]) expect(k in writer, k).toBe(false);
    expect(writer as unknown).not.toBe(channel as unknown);
    expect(Object.values(writer).includes(channel as never)).toBe(false);
    expect(Object.getOwnPropertySymbols(writer)).toEqual([]);
    expect(Object.getPrototypeOf(writer)).toBe(Object.prototype);
    expect(Object.isFrozen(writer)).toBe(true);
    expect(Object.isFrozen(channel)).toBe(true);
  });
  it("what the public writer cannot do stays undone: no seal, no termination record, admission stays open", async () => {
    const { writer, store, spies } = await setup();
    expect((writer as unknown as Record<string, unknown>).seal).toBeUndefined();
    expect(code(await writer.append("termination", { terminationReason: "error" }))).toBe("termination_reserved");
    expect((await writer.append("error", { n: 1 })).ok).toBe(true);
    expect(store.list().map((r) => r.kind)).toEqual(["error"]);
    expect(spies.seal.mock.calls.length).toBe(0);
    expect(writer.state().terminationWritten).toBe(false);
  });
  it("two writers share nothing: closing one does not close the other", async () => {
    const a = await setup();
    const b = await setup();
    a.channel.closeAdmission();
    expect(code(await a.writer.append("error", { n: 1 }))).toBe("admission_closed");
    expect((await b.writer.append("error", { n: 1 })).ok).toBe(true);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;
const H64 = (c: string): string => c.repeat(64);

/** Unwraps an OK answer of `records()` (task 4.4 unit U4): the answer must be `{ ok: true, value }`; anything else fails the test. */
const snapOf = (writer: RecordWriter): readonly WriterRecordView[] => {
  const res = writer.records();
  expect(res.ok).toBe(true);
  if (!res.ok) throw new Error("records() was not ok");
  return res.value;
};

describe("records(): a read-only snapshot of the committed records (unit U4)", () => {
  it("shows only committed records, in order, as exactly { id, kind, payload }; a pending write is not visible until it is committed", async () => {
    const { writer, hold } = await setup();
    expect(snapOf(writer)).toEqual([]);
    expect((await writer.append("run_started", {})).ok).toBe(true);
    const release = hold("writeFileSynced");
    const pending = writer.append("error", { n: 2 });
    await flush();
    expect(snapOf(writer).map((r) => r.kind)).toEqual(["run_started"]); // the held job is not committed yet
    release();
    expect((await pending).ok).toBe(true);
    const snap = snapOf(writer);
    expect(snap.map((r) => [r.id, r.kind])).toEqual([
      ["rec-000001", "run_started"],
      ["rec-000002", "error"],
    ]);
    for (const r of snap) expect(Object.keys(r).sort()).toEqual(["id", "kind", "payload"]);
    expect(snap[1]?.payload).toEqual({ n: 2 });
  });
  it("does not expose the envelope fields or the store", async () => {
    const { writer, store } = await setup();
    await writer.append("error", { n: 1 });
    const text = JSON.stringify(writer.records());
    const env = store.list()[0];
    expect(env).toBeDefined();
    for (const k of ["seq", "prevHash", "schemaVersion"]) expect(text).not.toContain(`"${k}"`);
    expect(text).not.toContain(env?.hash as string);
    expect(Object.values(snapOf(writer)[0] as object)).not.toContain(store as never);
  });
  it("is frozen at every level; a change attempt throws and changes neither the next snapshot nor the store", async () => {
    const { writer, store } = await setup();
    await writer.append("error", { a: { b: [1, { c: "x" }] } });
    const res = writer.records();
    expect(Object.keys(res).sort()).toEqual(["ok", "value"]);
    expect(Object.isFrozen(res)).toBe(true); // the result object itself is frozen
    const snap = snapOf(writer);
    const r = snap[0] as Loose;
    expect(Object.isFrozen(snap)).toBe(true);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.payload)).toBe(true);
    expect(Object.isFrozen(r.payload.a)).toBe(true);
    expect(Object.isFrozen(r.payload.a.b)).toBe(true);
    expect(Object.isFrozen(r.payload.a.b[1])).toBe(true);
    expect(() => {
      (snap as Loose).push({});
    }).toThrow(TypeError);
    expect(() => {
      r.kind = "termination";
    }).toThrow(TypeError);
    expect(() => {
      delete r.payload.a;
    }).toThrow(TypeError);
    expect(() => {
      r.payload.a.b.push(2);
    }).toThrow(TypeError);
    expect(() => {
      r.payload.a.b[1].c = "y";
    }).toThrow(TypeError);
    const expected = [{ id: "rec-000001", kind: "error", payload: { a: { b: [1, { c: "x" }] } } }];
    expect(snapOf(writer)).toEqual(expected);
    expect(store.list()[0]?.payload).toEqual(expected[0]?.payload);
  });
  it("every call returns new objects", async () => {
    const { writer } = await setup();
    await writer.append("error", { n: 1 });
    const a = snapOf(writer);
    const b = snapOf(writer);
    expect(a).not.toBe(b);
    expect(a[0]).not.toBe(b[0]);
    expect((a[0] as Loose).payload).not.toBe((b[0] as Loose).payload);
    expect(a).toEqual(b);
  });
  it("a failed write is not visible, and the snapshot stays readable after the writer went down and after closeAdmission", async () => {
    const { writer, channel, arm } = await setup();
    expect((await writer.append("run_started", {})).ok).toBe(true);
    arm("rename");
    expect((await writer.append("error", { n: 1 })).ok).toBe(false);
    expect(writer.state().down).toBe(true);
    expect(snapOf(writer).map((r) => r.kind)).toEqual(["run_started"]);
    channel.closeAdmission();
    expect(snapOf(writer).map((r) => r.kind)).toEqual(["run_started"]);
  });
  it("a store that cannot be read gives a frozen records_unavailable failure (never an empty array) and takes the writer down with store_failed", async () => {
    const { writer, store } = await setup();
    await writer.append("error", { n: 1 });
    vi.spyOn(store, "list").mockImplementation(() => {
      throw new Error(CANARY);
    });
    const res = writer.records();
    expect(res).toEqual({ ok: false, error: { code: "records_unavailable" } });
    expect(Object.keys(res).sort()).toEqual(["error", "ok"]);
    expect(Object.keys((res as Loose).error)).toEqual(["code"]);
    expect(Array.isArray(res)).toBe(false);
    expect(Object.isFrozen(res)).toBe(true);
    expect(Object.isFrozen((res as Loose).error)).toBe(true);
    expect(writer.state()).toMatchObject({ down: true, failure: "store_failed" });
    expect(code(await writer.append("error", { n: 2 }))).toBe("writer_down");
    expect(has(res, CANARY)).toBe(false);
    expect(has(writer.state(), CANARY)).toBe(false);
    expect(has(res, "boom")).toBe(false);
  });
  it("a records() failure keeps the first failure: a writer that was already down for io_failure stays io_failure", async () => {
    const { writer, store, arm } = await setup();
    expect((await writer.append("run_started", {})).ok).toBe(true);
    arm("rename");
    expect(code(await writer.append("error", { n: 1 }))).toBe("io_failure");
    expect(writer.state()).toMatchObject({ down: true, failure: "io_failure" });
    vi.spyOn(store, "list").mockImplementation(() => {
      throw new Error("boom");
    });
    expect(writer.records()).toEqual({ ok: false, error: { code: "records_unavailable" } });
    expect(writer.state()).toMatchObject({ down: true, failure: "io_failure" });
  });
  it("feeds the real verifier acceptance check: missing before the policy_decision record, accepted after it, refused for a changed hash", async () => {
    const { writer } = await setup();
    const identity = { experimentSha256: H64("a"), policyConfigSha256: H64("b"), preparationTableSha256: H64("c") };
    const check = createAcceptanceCheck(() => {
      const r = writer.records();
      if (!r.ok) throw new Error("x");
      return r.value;
    });
    expect(check("exp-1", "rec-000001", identity)).toEqual({ accepted: false, code: "record_missing" });
    const w = await writer.append("policy_decision", { experimentId: "exp-1", decision: "accept", ruleIds: [], ...identity });
    expect(w.ok && w.value.id).toBe("rec-000001");
    expect(check("exp-1", "rec-000001", identity)).toEqual({ accepted: true });
    expect(check("exp-1", "rec-000001", { ...identity, experimentSha256: H64("d") })).toEqual({ accepted: false, code: "experiment_content_changed" });
  });
  it("is a member of the public writer only, never of the channel", async () => {
    const { writer, channel } = await setup();
    expect(typeof writer.records).toBe("function");
    expect("records" in channel).toBe(false);
  });
});

describe("invalidRecords: a missing mandatory record is counted (task 4.4 unit U2 repair)", () => {
  const invalid = { ok: false as const, error: { kind: "invalid_record" as const, message: "x" } };
  it("writer.append invalid_record counts exactly 1 per failed write; the writer stays up and nothing is written", async () => {
    const { writer, store } = await setup();
    expect(writer.state().invalidRecords).toBe(0);
    expect(code(await writer.append("error", { n: Number.NaN }))).toBe("invalid_record");
    expect(writer.state().invalidRecords).toBe(1);
    expect(code(await writer.append("error", { n: Number.NaN }))).toBe("invalid_record");
    expect(writer.state()).toEqual({ down: false, sealed: false, terminationWritten: false, secretRejections: 0, invalidRecords: 2 });
    expect(store.count).toBe(0);
    expect((await writer.append("error", { n: 1 })).ok).toBe(true);
    expect(writer.state().invalidRecords).toBe(2); // a later success does not reset it
    expect(Object.isFrozen(writer.state())).toBe(true);
  });
  it("putBlob and putAiOutput invalid_record count too (the store answer is injected: no real input triggers it)", async () => {
    const { writer, spies } = await setup();
    spies.putBlob.mockResolvedValueOnce(invalid as never);
    spies.putAiOutput.mockResolvedValueOnce(invalid as never);
    expect(code(await writer.putBlob(data("a")))).toBe("invalid_record");
    expect(writer.state().invalidRecords).toBe(1);
    expect(code(await writer.putAiOutput(data("b")))).toBe("invalid_record");
    expect(writer.state()).toMatchObject({ down: false, invalidRecords: 2, secretRejections: 0 });
  });
  it("RESIDUAL: a secret whose rejection record fails validation reaches the writer as invalid_record: counted in invalidRecords, NOT in secretRejections", async () => {
    const { writer, spies } = await setup();
    spies.append.mockResolvedValueOnce({ ok: false, error: { kind: "invalid_record", message: "rejection record invalid" } } as never);
    expect(await writer.append("ai_call", { note: CANARY })).toEqual({ ok: false, error: { code: "invalid_record" } });
    expect(writer.state()).toMatchObject({ down: false, invalidRecords: 1, secretRejections: 0 });
  });
  it("channel.appendTermination and channel.seal invalid_record do NOT count; a later valid termination record and seal still work", async () => {
    const { writer, channel } = await setup();
    expect(code(await channel.appendTermination({ n: Number.NaN }))).toBe("invalid_record");
    expect(writer.state().invalidRecords).toBe(0);
    expect((await channel.appendTermination({ terminationReason: "error" })).ok).toBe(true);
    expect(code(await channel.seal(manifestInput({ chain: { records: 1, lastHash: "0" } })))).toBe("invalid_record");
    expect(writer.state().invalidRecords).toBe(0);
    expect((await channel.seal(manifestInput({ terminationReason: "error" }))).ok).toBe(true);
    expect(writer.state()).toMatchObject({ sealed: true, invalidRecords: 0 });
  });
  it("refusals that never reach the store do not count: admission_closed, closed_after_termination, termination_reserved, writer_down", async () => {
    const { writer, channel, spies } = await setup();
    expect(code(await writer.append("termination", { n: Number.NaN }))).toBe("termination_reserved");
    channel.closeAdmission();
    expect(code(await writer.append("error", { n: Number.NaN }))).toBe("admission_closed");
    expect(code(await writer.putBlob(data("a")))).toBe("admission_closed");
    expect((await channel.appendTermination({ terminationReason: "error" })).ok).toBe(true);
    expect(code(await writer.append("error", { n: Number.NaN }))).toBe("closed_after_termination");
    expect(spies.append.mock.calls.length).toBe(1);
    expect(writer.state().invalidRecords).toBe(0);
    const down = await setup();
    down.arm("writeFileSynced");
    await down.writer.append("error", { n: 1 });
    expect(code(await down.writer.append("error", { n: Number.NaN }))).toBe("writer_down");
    expect(down.writer.state().invalidRecords).toBe(0);
  });
});
