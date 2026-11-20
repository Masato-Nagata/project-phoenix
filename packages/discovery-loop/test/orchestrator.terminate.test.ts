// Task 4.4, unit U2: the Terminator (`src/orchestrator/terminate.ts`). Deterministic and offline. The REAL `RunRecordStore` on a `MemoryFileSystem`,
// the REAL RecordWriter and the REAL RunSession are used; the file system is wrapped by a fault injector (an error whose code is EIO), and the
// store methods, the wall clock and the manifest port are counted with spies. The manifest port is a small fake that builds a schema-valid
// Run_Manifest (the real assembly is task 4.6). The expected hashes are computed here with node crypto, independent of the code under test.
// **Validates: Requirements 12.5, 12.13, 12.14, 12.11, 11.15, 11.16**
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { MemoryFileSystem, RunRecordStore, type FileSystemPort, type JsonObject } from "../src/index.js";
import { createRecordWriter, type TerminationChannel, type WriterResult } from "../src/orchestrator/recordWriter.js";
import { createRunSession } from "../src/orchestrator/session.js";
import { createTerminator, type TerminationBase } from "../src/orchestrator/terminate.js";
import { TERMINATION_REASONS, UNSEALED_FAILURE_CODES, type ManifestCore, type RunResult, type TerminationReason, type UnsealedFailure } from "../src/orchestrator/types.js";
import { manifestInput } from "./helpers/runFixtures.js";

const DIR = "/run/out";
const CANARY = "canary-value-9f8e7d6c5b";
const STARTED = "2025-01-01T00:00:00Z";
const FINISHED = "2025-01-01T00:10:00Z";
const MANIFEST = `${DIR}/manifest.json`;
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const has = (v: unknown, s: string): boolean => JSON.stringify(v).includes(s);
/** What the composition root will do (task 4.9): only a sealed result is a success. */
const exitCodeOf = (r: RunResult): number => (r.sealed ? 0 : 1);

type Op = "writeFileSynced" | "rename" | "syncDir" | "readFile";
const noopFn = (): void => undefined;
/** Lets every already-resolved promise continuation run (the fake file system never waits on real time). */
const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
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

const BASE: TerminationBase = {
  finalHypothesisRevision: "none",
  provider: { id: "mock", version: "1", model: "none", isMock: true },
  envVarsRead: [{ name: "EXAMPLE_NAME", set: false }],
  payloadAudit: { configCheck: "pass", audits: 1, passed: 1, blocked: 0, auditConfigSha256: "4".repeat(64) },
  accessDenial: {} as unknown as TerminationBase["accessDenial"],
  configHashes: { policyConfigSha256: "1".repeat(64), preparationTableSha256: "2".repeat(64) },
  leaseFacts: { heartbeatIntervalMs: 1000, staleAfterMs: 5000, propagationDelayMs: 100 },
  effectiveConfig: {},
};

const defaultManifest = (core: ManifestCore): JsonObject =>
  manifestInput({
    runId: core.runId,
    terminationReason: core.terminationReason,
    limitsUsed: { iterations: core.limitsUsed.iterations, acceptedExperiments: core.limitsUsed.acceptedExperiments, rejectedExperiments: core.limitsUsed.rejectedExperiments },
    wallClock: { startedAt: core.wallClock.startedAt, finishedAt: core.wallClock.finishedAt },
  });

interface Opts {
  readonly secrets?: readonly { name: string; value: string }[];
  /** Builds the value the manifest port returns. `arm` arms a fault of the file system for the next call of an operation. */
  readonly build?: (core: ManifestCore, arm: (op: Op, nth?: number) => void) => unknown;
  readonly wallThrows?: boolean;
}
async function harness(o: Opts = {}) {
  const mem = new MemoryFileSystem();
  mem.addDir(DIR);
  const f = faultFs(mem);
  const opened = await RunRecordStore.open(f.fs, DIR, { secrets: { envValues: [...(o.secrets ?? [{ name: "CANARY_KEY", value: CANARY }])] } });
  if (!opened.ok) throw new Error("open failed");
  const store = opened.value;
  const spies = { append: vi.spyOn(store, "append"), seal: vi.spyOn(store, "seal"), putBlob: vi.spyOn(store, "putBlob"), putAiOutput: vi.spyOn(store, "putAiOutput") };
  const made = createRunSession({ clock: { nowMs: () => 1000 }, runSeconds: 60 });
  if (!made.ok) throw new Error("session failed");
  const session = made.value;
  const { writer, channel } = createRecordWriter(store);
  const wall = {
    nowIso: vi.fn((): string => {
      if (o.wallThrows === true) throw new Error("wall clock failed");
      return FINISHED;
    }),
  };
  const build = vi.fn((core: ManifestCore): unknown => (o.build === undefined ? defaultManifest(core) : o.build(core, f.arm)));
  const h = {
    mem,
    arm: f.arm,
    hold: f.hold,
    store,
    spies,
    session,
    writer,
    channel,
    wall,
    build,
    terminator: createTerminator({ session, channel, wallClock: wall, manifest: { build: (core) => build(core) as JsonObject }, runId: "run-0001", base: BASE, startedAt: STARTED }),
  };
  return h;
}
type Harness = Awaited<ReturnType<typeof harness>>;
const terminationRecords = (h: Harness) => h.store.list().filter((r) => r.kind === "termination");
const manifestOf = (h: Harness): { terminationReason: string; chain: { records: number; lastHash: string } } =>
  JSON.parse(new TextDecoder().decode(h.mem.peek(MANIFEST))) as { terminationReason: string; chain: { records: number; lastHash: string } };

describe("normal end", () => {
  it.each([...TERMINATION_REASONS])("%s: one termination record, the manifest names the same reason, the hash is the store's and the hash of the written bytes", async (reason) => {
    const h = await harness();
    h.session.markStarted();
    h.session.raise(reason);
    const result = await h.terminator.terminate();
    expect(result.sealed).toBe(true);
    if (!result.sealed) return;
    const recs = terminationRecords(h);
    expect(recs).toHaveLength(1);
    expect(recs[0]?.payload).toEqual({ terminationReason: reason });
    expect(h.store.list().at(-1)?.kind).toBe("termination");
    expect(manifestOf(h).terminationReason).toBe(reason);
    expect(manifestOf(h).chain).toEqual({ records: 1, lastHash: recs[0]?.hash });
    expect(Object.keys(result.summary).sort()).toEqual(["manifestSha256", "runId", "terminationReason"]);
    expect(result.summary).toEqual({ runId: "run-0001", terminationReason: reason, manifestSha256: sha(h.mem.peek(MANIFEST) as Uint8Array) });
    const fromStore = (await h.spies.seal.mock.results[0]?.value) as unknown as { ok: true; value: { sha256: string } };
    expect(result.summary.manifestSha256).toBe(fromStore.value.sha256);
    expect(exitCodeOf(result)).toBe(0);
    expect(h.session.terminationStatus()).toEqual({ state: "finalized", reason });
  });
  it("priority: the highest priority raised before terminating wins", async () => {
    const matrix: readonly { raised: readonly TerminationReason[]; expected: TerminationReason }[] = [
      { raised: ["experiment_limit_reached", "time_limit_reached", "error", "isolation_violation"], expected: "isolation_violation" },
      { raised: ["isolation_violation", "error", "time_limit_reached"], expected: "isolation_violation" },
      { raised: ["experiment_limit_reached", "time_limit_reached"], expected: "time_limit_reached" },
      { raised: ["time_limit_reached", "error", "experiment_limit_reached"], expected: "error" },
      { raised: ["experiment_limit_reached", "iteration_limit_reached"], expected: "experiment_limit_reached" },
      { raised: ["iteration_limit_reached", "experiment_limit_reached"], expected: "iteration_limit_reached" },
      { raised: ["no_further_experiments", "provider_failure", "payload_audit_blocked"], expected: "payload_audit_blocked" },
    ];
    for (const { raised, expected } of matrix) {
      const h = await harness();
      for (const r of raised) h.session.raise(r);
      const result = await h.terminator.terminate();
      expect(result.sealed, expected).toBe(true);
      expect(terminationRecords(h).map((r) => r.payload), expected).toEqual([{ terminationReason: expected }]);
      expect(manifestOf(h).terminationReason, expected).toBe(expected);
      expect(result.sealed && result.summary.terminationReason, expected).toBe(expected);
    }
  });
  it("no_cause fallback: a Run that ends with no cause ends with `error`", async () => {
    const h = await harness();
    expect(h.session.terminationStatus()).toEqual({ state: "none" });
    const result = await h.terminator.terminate();
    expect(result.sealed && result.summary.terminationReason).toBe("error");
    expect(terminationRecords(h).map((r) => r.payload)).toEqual([{ terminationReason: "error" }]);
    expect(h.session.terminationStatus()).toEqual({ state: "finalized", reason: "error" });
  });
  it("the manifest port receives the runId, the counters of the session, the wall times and the base unchanged; the wall clock is read once", async () => {
    const h = await harness();
    h.session.noteIteration();
    h.session.noteIteration();
    h.session.noteIteration();
    h.session.noteAcceptedExperiment();
    h.session.noteAcceptedExperiment();
    h.session.noteRejectedExperiment();
    h.session.raise("no_further_experiments");
    await h.terminator.terminate();
    expect(h.build).toHaveBeenCalledTimes(1);
    const core = h.build.mock.calls[0]?.[0] as ManifestCore;
    expect(core.runId).toBe("run-0001");
    expect(core.terminationReason).toBe("no_further_experiments");
    expect(core.limitsUsed).toEqual({ iterations: 3, acceptedExperiments: 2, rejectedExperiments: 1 });
    expect(core.wallClock).toEqual({ startedAt: STARTED, finishedAt: FINISHED });
    expect(core.provider).toEqual(BASE.provider);
    expect(core.finalHypothesisRevision).toBe("none");
    expect(h.wall.nowIso).toHaveBeenCalledTimes(1);
    expect(manifestOf(h).terminationReason).toBe("no_further_experiments");
  });
  it("a secret configured in the store but absent from the data never appears in a result", async () => {
    const h = await harness();
    h.session.raise("error");
    expect(has(await h.terminator.terminate(), CANARY)).toBe(false);
  });
});

describe("reason is final", () => {
  it("a raise after a successful terminate is ignored; the record and the manifest keep the first reason", async () => {
    const h = await harness();
    h.session.raise("iteration_limit_reached");
    const result = await h.terminator.terminate();
    expect(h.session.raise("isolation_violation")).toBe("ignored_finalized");
    expect(h.session.raise("error")).toBe("ignored_finalized");
    expect(h.session.terminationStatus()).toEqual({ state: "finalized", reason: "iteration_limit_reached" });
    expect(terminationRecords(h).map((r) => r.payload)).toEqual([{ terminationReason: "iteration_limit_reached" }]);
    expect(manifestOf(h).terminationReason).toBe("iteration_limit_reached");
    expect(result.sealed && result.summary.terminationReason).toBe("iteration_limit_reached");
  });
  it("a failing writer path that raises `error` afterwards changes nothing", async () => {
    const h = await harness();
    h.session.raise("iteration_limit_reached");
    h.arm("writeFileSynced");
    const result = await h.terminator.terminate();
    expect(result).toMatchObject({ sealed: false, failure: "store_failed", terminationReason: "iteration_limit_reached" });
    expect(h.session.raise("error")).toBe("ignored_finalized");
    expect(h.session.terminationStatus()).toEqual({ state: "finalized", reason: "iteration_limit_reached" });
    expect(await h.terminator.terminate()).toMatchObject({ sealed: false, terminationReason: "iteration_limit_reached" });
  });
});

describe("idempotent and memoized", () => {
  it("two sequential and two concurrent calls: one termination record, one append, one seal, the same promise and the same result object", async () => {
    const h = await harness();
    h.session.raise("time_limit_reached");
    const p1 = h.terminator.terminate();
    const p2 = h.terminator.terminate();
    expect(p2).toBe(p1);
    const [a, b] = await Promise.all([p1, p2]);
    const c = await h.terminator.terminate();
    const d = await h.terminator.terminate();
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(d).toBe(a);
    expect(terminationRecords(h)).toHaveLength(1);
    expect(h.spies.append).toHaveBeenCalledTimes(1);
    expect(h.spies.seal).toHaveBeenCalledTimes(1);
    expect(h.build).toHaveBeenCalledTimes(1);
    expect(h.wall.nowIso).toHaveBeenCalledTimes(1);
  });
  it("a failed first call is memoized too: no second attempt", async () => {
    const h = await harness();
    h.arm("rename");
    const a = await h.terminator.terminate();
    const b = await h.terminator.terminate();
    expect(b).toBe(a);
    expect(h.spies.append).toHaveBeenCalledTimes(1);
    expect(h.spies.seal).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Every way a Run ends without a seal
// ---------------------------------------------------------------------------------------------------------------------------------
interface Failing {
  readonly name: string;
  readonly expected: UnsealedFailure;
  readonly opts?: Opts;
  readonly prepare?: (h: Harness) => Promise<void> | void;
  /** After a failed directory sync the renamed manifest.json can exist, but the Run is still reported as not sealed. */
  readonly manifestMayExist?: boolean;
}
const armInBuild = (op: Op): Opts["build"] => (core, arm) => {
  arm(op);
  return defaultManifest(core);
};
const FAILING: readonly Failing[] = [
  ...(["writeFileSynced", "rename", "syncDir"] as const).map((op): Failing => ({ name: `termination record write fails (${op})`, expected: "store_failed", prepare: (h) => h.arm(op), manifestMayExist: false })),
  {
    name: "writer is already down at entry",
    expected: "store_failed",
    prepare: async (h) => {
      h.arm("writeFileSynced");
      await h.writer.append("error", { n: 1 });
    },
  },
  {
    name: "secret hit on the termination record",
    expected: "secret_rejected",
    opts: { secrets: [{ name: "REASON_ENV", value: "iteration_limit_reached" }] },
    prepare: (h) => void h.session.raise("iteration_limit_reached"),
  },
  { name: "build throws", expected: "manifest_build_failed", opts: { build: () => { throw new Error("build failed with message"); } } },
  { name: "build rejects", expected: "manifest_build_failed", opts: { build: () => Promise.reject(new Error("build rejected")) } },
  ...([["null", null], ["array", []], ["string", "text"], ["number", 42], ["Map", new Map()]] as const).map(
    ([n, v]): Failing => ({ name: `build returns ${n}`, expected: "manifest_build_failed", opts: { build: () => v } }),
  ),
  { name: "built manifest is not schema-valid", expected: "manifest_build_failed", opts: { build: (core) => ({ ...defaultManifest(core), terminationReason: "bogus" }) } },
  { name: "built manifest sets a field only the store may set", expected: "manifest_build_failed", opts: { build: (core) => ({ ...defaultManifest(core), chain: { records: 1, lastHash: "0" } }) } },
  ...(["readFile", "writeFileSynced", "rename", "syncDir"] as const).map(
    (op): Failing => ({ name: `seal fails (${op})`, expected: "store_failed", opts: { build: armInBuild(op) }, manifestMayExist: op === "syncDir" }),
  ),
  { name: "secret in the manifest", expected: "secret_rejected", opts: { build: (core) => ({ ...defaultManifest(core), config: { note: CANARY } }) } },
  { name: "wall clock throws", expected: "internal_error", opts: { wallThrows: true } },
];

describe("a Run that ends without a seal", () => {
  it.each(FAILING.map((f) => [f.name, f] as const))("%s", async (_name, f) => {
    const h = await harness(f.opts);
    h.session.markStarted();
    if (f.prepare === undefined) h.session.raise("provider_failure");
    else await f.prepare(h);
    if (h.session.terminationStatus().state === "none") h.session.raise("provider_failure");
    const result = await h.terminator.terminate();
    expect(result.sealed).toBe(false);
    if (result.sealed) return;
    expect(result.failure).toBe(f.expected);
    expect((UNSEALED_FAILURE_CODES as readonly string[]).includes(result.failure)).toBe(true);
    expect(result.started).toBe(true);
    const status = h.session.terminationStatus();
    expect(status.state).toBe("finalized");
    expect(result.terminationReason).toBe(status.state === "none" ? undefined : status.reason);
    expect(result.terminationReason).toBeDefined();
    expect("summary" in result).toBe(false);
    expect("manifestSha256" in result).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["failure", "sealed", "started", "terminationReason"]);
    expect(exitCodeOf(result)).not.toBe(0);
    for (const leak of [CANARY, "env:", "CANARY_KEY", "REASON_ENV", "EIO", "write failed", "message"]) expect(has(result, leak), leak).toBe(false);
    if (f.manifestMayExist !== true) expect(h.mem.allFiles().filter((p) => p.endsWith("manifest.json")), "no fabricated manifest").toEqual([]);
    expect(terminationRecords(h).length).toBeLessThanOrEqual(1);
  });
  it("termination write failure: no build, no seal, no wall clock; a secret hit: the same", async () => {
    const down = await harness();
    down.session.raise("error");
    down.arm("writeFileSynced");
    await down.terminator.terminate();
    expect(down.build).not.toHaveBeenCalled();
    expect(down.spies.seal).not.toHaveBeenCalled();
    expect(down.wall.nowIso).not.toHaveBeenCalled();
    const secret = await harness({ secrets: [{ name: "REASON_ENV", value: "iteration_limit_reached" }] });
    secret.session.raise("iteration_limit_reached");
    expect(await secret.terminator.terminate()).toMatchObject({ sealed: false, failure: "secret_rejected" });
    expect(secret.build).not.toHaveBeenCalled();
    expect(secret.spies.seal).not.toHaveBeenCalled();
    expect(secret.wall.nowIso).not.toHaveBeenCalled();
    expect(secret.writer.state().down).toBe(false);
  });
  it("writer already down at entry: the store is not called again, nothing is written, built or read from the wall clock", async () => {
    const h = await harness();
    h.session.raise("lease_unavailable");
    h.arm("rename");
    expect((await h.writer.append("error", { n: 1 })).ok).toBe(false);
    const appendCalls = h.spies.append.mock.calls.length;
    const files = h.mem.allFiles();
    const result = await h.terminator.terminate();
    expect(result).toEqual({ sealed: false, started: false, terminationReason: "lease_unavailable", failure: "store_failed" });
    expect(h.spies.append.mock.calls.length).toBe(appendCalls);
    expect(h.spies.seal).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();
    expect(h.wall.nowIso).not.toHaveBeenCalled();
    expect(h.mem.allFiles()).toEqual(files);
  });
  it("a build that fails still leaves exactly the termination record, and the seal is never called", async () => {
    const h = await harness({ build: () => null });
    h.session.raise("error");
    const result = await h.terminator.terminate();
    expect(result).toMatchObject({ sealed: false, failure: "manifest_build_failed", terminationReason: "error" });
    expect(terminationRecords(h)).toHaveLength(1);
    expect(h.spies.seal).not.toHaveBeenCalled();
    expect(h.wall.nowIso).toHaveBeenCalledTimes(1);
    expect(h.build).toHaveBeenCalledTimes(1);
  });
  it("a seal that fails because of a schema-invalid manifest calls the store seal once and leaves the store unsealed", async () => {
    const h = await harness({ build: (core) => ({ ...defaultManifest(core), terminationReason: "bogus" }) });
    h.session.raise("error");
    await h.terminator.terminate();
    expect(h.spies.seal).toHaveBeenCalledTimes(1);
    expect(h.writer.state()).toMatchObject({ down: false, sealed: false });
    expect(h.mem.peek(MANIFEST)).toBeUndefined();
  });
  it("`started` comes from the session", async () => {
    const a = await harness();
    a.session.raise("error");
    a.arm("writeFileSynced");
    expect(await a.terminator.terminate()).toMatchObject({ sealed: false, started: false });
    const b = await harness();
    b.session.raise("error");
    b.session.markStarted();
    b.arm("writeFileSynced");
    expect(await b.terminator.terminate()).toMatchObject({ sealed: false, started: true });
  });
});

describe("mapping of writer answers (a stub writer, the real session)", () => {
  const stub = (append: WriterResult<unknown>, seal: WriterResult<unknown>, down = false, secretRejections = 0, invalidRecords = 0): TerminationChannel => ({
    closeAdmission: () => undefined,
    drain: async () => undefined,
    appendTermination: async () => append as never,
    seal: async () => seal as never,
    state: () => ({ down, sealed: false, terminationWritten: false, secretRejections, invalidRecords }),
  });
  const fail = (c: string): WriterResult<unknown> => ({ ok: false, error: { code: c as never } });
  const ok: WriterResult<unknown> = { ok: true, value: { manifest: {}, sha256: "a".repeat(64) } };
  const run = async (channel: TerminationChannel): Promise<RunResult> => {
    const made = createRunSession({ clock: { nowMs: () => 1 }, runSeconds: 10 });
    if (!made.ok) throw new Error("session");
    made.value.raise("error");
    return createTerminator({ session: made.value, channel, wallClock: { nowIso: () => FINISHED }, manifest: { build: (core) => defaultManifest(core) }, runId: "run-0001", base: BASE, startedAt: STARTED }).terminate();
  };
  it("termination record: down codes -> store_failed; secret_rejected and evidence_rejected -> secret_rejected; anything else -> internal_error", async () => {
    const expected: Record<string, UnsealedFailure> = {
      writer_down: "store_failed", store_failed: "store_failed", io_failure: "store_failed", secret_rejected: "secret_rejected", evidence_rejected: "secret_rejected",
      invalid_record: "internal_error", duplicate_termination: "internal_error", closed_after_termination: "internal_error", termination_missing: "internal_error", already_sealed: "internal_error",
      admission_closed: "internal_error", termination_reserved: "internal_error",
    };
    for (const [c, f] of Object.entries(expected)) expect(await run(stub(fail(c), ok)), c).toMatchObject({ sealed: false, failure: f, terminationReason: "error" });
  });
  it("seal: secret_rejected and evidence_rejected -> secret_rejected; invalid_record -> manifest_build_failed; down codes -> store_failed; anything else -> seal_failed", async () => {
    const expected: Record<string, UnsealedFailure> = {
      secret_rejected: "secret_rejected", evidence_rejected: "secret_rejected", invalid_record: "manifest_build_failed", writer_down: "store_failed", store_failed: "store_failed", io_failure: "store_failed",
      already_sealed: "seal_failed", termination_missing: "seal_failed", duplicate_termination: "seal_failed", closed_after_termination: "seal_failed",
      admission_closed: "seal_failed", termination_reserved: "seal_failed",
    };
    for (const [c, f] of Object.entries(expected)) expect(await run(stub(ok, fail(c))), c).toMatchObject({ sealed: false, failure: f });
  });
  it("an evidence_rejected answer of the termination record or of the seal carries no summary, no hash, and exactly the unsealed keys", async () => {
    for (const r of [await run(stub(fail("evidence_rejected"), ok)), await run(stub(ok, fail("evidence_rejected")))]) {
      expect(r).toEqual({ sealed: false, started: false, terminationReason: "error", failure: "secret_rejected" });
      expect(Object.keys(r).sort()).toEqual(["failure", "sealed", "started", "terminationReason"]);
    }
  });
  it("sealed: true comes only from a successful seal, and the hash is the one returned, unchanged", async () => {
    const r = await run(stub(ok, ok));
    expect(r).toEqual({ sealed: true, summary: { runId: "run-0001", terminationReason: "error", manifestSha256: "a".repeat(64) } });
    expect(await run(stub(ok, fail("already_sealed")))).toMatchObject({ sealed: false });
    expect(await run(stub(ok, ok, true))).toMatchObject({ sealed: false, failure: "store_failed" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The race: a write accepted before terminate() that is rejected for a secret while the drain is waiting
// ---------------------------------------------------------------------------------------------------------------------------------
const HIGHER_THAN_ERROR: readonly TerminationReason[] = ["isolation_violation", "launcher_killed", "lease_unavailable"];
async function raceRun(reason: TerminationReason) {
  const h = await harness();
  h.session.markStarted();
  h.session.raise(reason);
  const release = h.hold("writeFileSynced"); // the first store write (the store's own rejection record) stays pending
  const write = h.writer.append("ai_call", { note: CANARY });
  await flush(); // the write job has started and waits on the gate
  const t = h.terminator.terminate();
  let settled = false;
  void t.then(() => {
    settled = true;
  });
  await flush();
  const pendingDuring = !settled;
  const statusDuring = h.session.terminationStatus();
  release();
  const result = await t;
  return { h, write: await write, result, pendingDuring, statusDuring };
}

describe("a write rejected for a secret while terminate() is draining", () => {
  it.each([...TERMINATION_REASONS])("pending %s: the Run is detected as unsealed secret_rejected; nothing is written after the drain; the reason is error unless a higher one is pending", async (reason) => {
    const { h, write, result, pendingDuring, statusDuring } = await raceRun(reason);
    const expected: TerminationReason = HIGHER_THAN_ERROR.includes(reason) ? reason : "error";
    expect(pendingDuring).toBe(true); // terminate() waits for the queued write
    expect(statusDuring).toEqual({ state: "pending", reason }); // not finalized while draining
    expect(write).toEqual({ ok: false, error: { code: "secret_rejected" } });
    expect(result).toEqual({ sealed: false, started: true, terminationReason: expected, failure: "secret_rejected" });
    expect(Object.keys(result).sort()).toEqual(["failure", "sealed", "started", "terminationReason"]);
    expect(h.session.terminationStatus()).toEqual({ state: "finalized", reason: expected });
    expect(terminationRecords(h)).toHaveLength(0);
    expect(h.store.list().map((r) => r.kind)).toEqual(["store_rejection"]);
    expect(h.spies.append).toHaveBeenCalledTimes(1); // only the rejected write: no termination record
    expect(h.spies.seal).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();
    expect(h.wall.nowIso).not.toHaveBeenCalled();
    expect(h.mem.peek(MANIFEST)).toBeUndefined();
    expect(h.writer.state()).toEqual({ down: false, sealed: false, terminationWritten: false, secretRejections: 1, invalidRecords: 0 });
    expect(exitCodeOf(result)).not.toBe(0);
    for (const leak of [CANARY, "CANARY_KEY", "env:"]) expect(has([result, write, h.writer.state()], leak), leak).toBe(false);
  });
  it("a raise of a higher reason during the drain is still accepted (the latch is finalized only after the drain); a raise after that is ignored", async () => {
    const h = await harness();
    h.session.raise("provider_failure");
    const release = h.hold("writeFileSynced");
    const write = h.writer.append("ai_call", { n: 1 }); // an ordinary write that is slow, no secret
    await flush();
    const t = h.terminator.terminate();
    await flush();
    expect(h.session.raise("lease_unavailable")).toBe("upgraded");
    release();
    const result = await t;
    expect((await write).ok).toBe(true);
    expect(result.sealed && result.summary.terminationReason).toBe("lease_unavailable");
    expect(terminationRecords(h).map((r) => r.payload)).toEqual([{ terminationReason: "lease_unavailable" }]);
    expect(h.session.raise("isolation_violation")).toBe("ignored_finalized");
  });
  it("raising error is not applied over a higher pending reason: the state stays", async () => {
    const h = await harness();
    h.session.raise("isolation_violation");
    expect(h.session.raise("error")).toBe("ignored_not_higher");
    expect(h.session.terminationStatus()).toEqual({ state: "pending", reason: "isolation_violation" });
    const lower = await harness();
    lower.session.raise("provider_failure");
    expect(lower.session.raise("error")).toBe("upgraded");
    expect(lower.session.terminationStatus()).toEqual({ state: "pending", reason: "error" });
  });
  it("no cause at all and a rejected write: the reason is error (raised by the secret check), and the result is secret_rejected", async () => {
    const h = await harness();
    expect(h.session.terminationStatus()).toEqual({ state: "none" });
    expect(code((await h.writer.append("ai_call", { note: CANARY })))).toBe("secret_rejected");
    const result = await h.terminator.terminate();
    expect(result).toEqual({ sealed: false, started: false, terminationReason: "error", failure: "secret_rejected" });
    expect(terminationRecords(h)).toHaveLength(0);
    expect(h.spies.seal).not.toHaveBeenCalled();
  });
});

describe("admission and authority around terminate()", () => {
  it("closeAdmission() is the first synchronous effect: a normal append issued in the same tick is admission_closed", async () => {
    const h = await harness();
    h.session.raise("error");
    const t = h.terminator.terminate();
    const refused = await h.writer.append("error", { n: 1 }); // no await between terminate() and this call
    expect(refused).toEqual({ ok: false, error: { code: "admission_closed" } });
    expect(await h.writer.putBlob(new TextEncoder().encode(CANARY))).toEqual({ ok: false, error: { code: "admission_closed" } });
    const result = await t;
    expect(result.sealed).toBe(true);
    expect(terminationRecords(h)).toHaveLength(1);
    expect(h.store.list().map((r) => r.kind)).toEqual(["termination"]); // the refused append wrote nothing
    expect(h.writer.state().secretRejections).toBe(0);
    expect(has([refused, result], CANARY)).toBe(false);
  });
  it("one closeAdmission, one drain, one termination record and one seal for two sequential and two concurrent calls", async () => {
    const h = await harness();
    h.session.raise("time_limit_reached");
    const counted = {
      closeAdmission: vi.fn(() => h.channel.closeAdmission()),
      drain: vi.fn(() => h.channel.drain()),
      state: () => h.channel.state(),
      appendTermination: vi.fn((payload: JsonObject, component?: string) => h.channel.appendTermination(payload, component)),
      seal: vi.fn((input: JsonObject) => h.channel.seal(input)),
    } satisfies TerminationChannel;
    const t = createTerminator({ session: h.session, channel: counted, wallClock: h.wall, manifest: { build: (core) => h.build(core) as JsonObject }, runId: "run-0001", base: BASE, startedAt: STARTED });
    const p1 = t.terminate();
    const p2 = t.terminate();
    expect(p2).toBe(p1);
    const [a, b] = await Promise.all([p1, p2]);
    expect(await t.terminate()).toBe(a);
    expect(b).toBe(a);
    expect(counted.closeAdmission).toHaveBeenCalledTimes(1);
    expect(counted.drain).toHaveBeenCalledTimes(1);
    expect(counted.appendTermination).toHaveBeenCalledTimes(1);
    expect(counted.seal).toHaveBeenCalledTimes(1);
    expect(terminationRecords(h)).toHaveLength(1);
    expect(h.spies.append).toHaveBeenCalledTimes(1);
    expect(h.spies.seal).toHaveBeenCalledTimes(1);
  });
  it("after the normal end the public writer is closed (closed_after_termination) and can neither seal nor write a termination record", async () => {
    const h = await harness();
    h.session.raise("error");
    expect((await h.terminator.terminate()).sealed).toBe(true);
    expect(code(await h.writer.append("error", { n: 1 }))).toBe("closed_after_termination");
    expect(code(await h.writer.append("termination", { terminationReason: "error" }))).toBe("termination_reserved");
    expect(code(await h.writer.putBlob(new Uint8Array([1])))).toBe("closed_after_termination");
    expect((h.writer as unknown as Record<string, unknown>).seal).toBeUndefined();
    expect(h.writer.state()).toMatchObject({ terminationWritten: true, sealed: true });
  });
  it("the writer goes down during the drain: unsealed store_failed, the finalized reason, and nothing is written, built, sealed or read from the wall clock afterwards", async () => {
    const h = await harness();
    h.session.markStarted();
    h.session.raise("provider_failure");
    h.arm("writeFileSynced");
    const release = h.hold("writeFileSynced");
    const write = h.writer.append("error", { n: 1 });
    await flush();
    const t = h.terminator.terminate();
    await flush();
    release();
    const result = await t;
    expect(code(await write)).toBe("io_failure");
    expect(result).toEqual({ sealed: false, started: true, terminationReason: "provider_failure", failure: "store_failed" });
    expect(h.spies.append).toHaveBeenCalledTimes(1);
    expect(h.spies.seal).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();
    expect(h.wall.nowIso).not.toHaveBeenCalled();
    expect(terminationRecords(h)).toHaveLength(0);
    for (const leak of ["EIO", "write failed"]) expect(has(result, leak), leak).toBe(false);
  });
});

function code(r: { ok: boolean; error?: { code: string } }): string | undefined {
  return r.ok ? undefined : r.error?.code;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// U2 repair: a missing mandatory record (`invalid_record` of an ordinary write) never gives `sealed: true`
// ---------------------------------------------------------------------------------------------------------------------------------
describe("an invalid_record of an ordinary write blocks the normal seal", () => {
  const bad = (h: Harness) => h.writer.append("error", { n: Number.NaN });
  it("positive control: a Run without any invalid_record still seals", async () => {
    const h = await harness();
    h.session.raise("error");
    expect((await h.writer.append("error", { n: 1 })).ok).toBe(true);
    const result = await h.terminator.terminate();
    expect(result.sealed).toBe(true);
    expect(h.writer.state().invalidRecords).toBe(0);
  });
  it("one invalid_record: unsealed internal_error with reason error; nothing written, built, read from the clock or sealed", async () => {
    const h = await harness();
    h.session.markStarted();
    expect(code(await bad(h))).toBe("invalid_record");
    const result = await h.terminator.terminate();
    expect(result).toEqual({ sealed: false, started: true, terminationReason: "error", failure: "internal_error" });
    expect(Object.keys(result).sort()).toEqual(["failure", "sealed", "started", "terminationReason"]);
    expect(terminationRecords(h)).toHaveLength(0);
    expect(h.store.list()).toEqual([]);
    expect(h.mem.peek(MANIFEST)).toBeUndefined();
    expect(h.spies.append).toHaveBeenCalledTimes(1); // only the invalid write: no termination record was attempted
    expect(h.spies.seal).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();
    expect(h.wall.nowIso).not.toHaveBeenCalled();
    expect(h.session.terminationStatus()).toEqual({ state: "finalized", reason: "error" });
    expect(exitCodeOf(result)).not.toBe(0);
  });
  it("a higher cause latched before stays the reason (not lowered to error), still unsealed internal_error", async () => {
    const h = await harness();
    h.session.raise("isolation_violation");
    await bad(h);
    const result = await h.terminator.terminate();
    expect(result).toEqual({ sealed: false, started: false, terminationReason: "isolation_violation", failure: "internal_error" });
    expect(h.session.terminationStatus()).toEqual({ state: "finalized", reason: "isolation_violation" });
    expect(h.spies.seal).not.toHaveBeenCalled();
    expect(h.build).not.toHaveBeenCalled();
  });
  it("an invalid write that is still queued when terminate() starts is drained and counted", async () => {
    const h = await harness();
    h.session.raise("provider_failure");
    const release = h.hold("writeFileSynced");
    const first = h.writer.append("error", { n: 1 });
    const second = bad(h); // accepted before terminate(): runs during the drain
    await flush();
    const t = h.terminator.terminate();
    release();
    const result = await t;
    expect((await first).ok).toBe(true);
    expect(code(await second)).toBe("invalid_record");
    expect(result).toEqual({ sealed: false, started: false, terminationReason: "error", failure: "internal_error" });
    expect(terminationRecords(h)).toHaveLength(0);
  });
  it("a write refused at accept time (admission_closed) does not count: the Run still seals", async () => {
    const h = await harness();
    h.session.raise("error");
    const t = h.terminator.terminate();
    expect(code(await bad(h))).toBe("admission_closed");
    const result = await t;
    expect(result.sealed).toBe(true);
    expect(h.writer.state().invalidRecords).toBe(0);
  });
  it("an invalid_record of the termination record or of the seal does not count as an invalid ordinary write (their own mapping applies)", async () => {
    const t = await harness({ build: (core) => ({ ...defaultManifest(core), terminationReason: "bogus" }) });
    t.session.raise("error");
    expect(await t.terminator.terminate()).toMatchObject({ sealed: false, failure: "manifest_build_failed" });
    expect(t.writer.state().invalidRecords).toBe(0);
  });
  it("priority with the real writer: secret + invalid -> secret_rejected; down + invalid -> store_failed", async () => {
    const s = await harness();
    s.session.markStarted();
    expect(code(await s.writer.append("ai_call", { note: CANARY }))).toBe("secret_rejected");
    expect(code(await bad(s))).toBe("invalid_record");
    expect(await s.terminator.terminate()).toEqual({ sealed: false, started: true, terminationReason: "error", failure: "secret_rejected" });
    expect(s.spies.seal).not.toHaveBeenCalled();
    expect(terminationRecords(s)).toHaveLength(0);
    const d = await harness();
    expect(code(await bad(d))).toBe("invalid_record");
    d.arm("writeFileSynced");
    expect(code(await d.writer.append("error", { n: 1 }))).toBe("io_failure");
    expect(d.writer.state()).toMatchObject({ down: true, invalidRecords: 1 });
    expect(await d.terminator.terminate()).toEqual({ sealed: false, started: false, terminationReason: "error", failure: "store_failed" });
    expect(d.wall.nowIso).not.toHaveBeenCalled();
    expect(d.build).not.toHaveBeenCalled();
  });
  it("RESIDUAL: a secret whose rejection record is invalid (store answer injected) ends unsealed internal_error, not secret_rejected", async () => {
    const h = await harness();
    h.spies.append.mockResolvedValueOnce({ ok: false, error: { kind: "invalid_record", message: "rejection record invalid" } } as never);
    expect(code(await h.writer.append("ai_call", { note: CANARY }))).toBe("invalid_record");
    expect(h.writer.state()).toMatchObject({ secretRejections: 0, invalidRecords: 1 });
    expect(await h.terminator.terminate()).toMatchObject({ sealed: false, terminationReason: "error", failure: "internal_error" });
  });
  it("stub channel: the decision order is down > secret > invalid, and channel.appendTermination / channel.seal / the manifest port / the wall clock are not called for invalid", async () => {
    const calls = { appendTermination: vi.fn(), seal: vi.fn(), build: vi.fn(), nowIso: vi.fn(() => FINISHED) };
    const make = (down: boolean, secret: number, invalid: number): TerminationChannel => ({
      closeAdmission: () => undefined,
      drain: async () => undefined,
      appendTermination: async () => (calls.appendTermination(), { ok: true, value: {} } as never),
      seal: async () => (calls.seal(), { ok: true, value: { sha256: "a".repeat(64) } } as never),
      state: () => ({ down, sealed: false, terminationWritten: false, secretRejections: secret, invalidRecords: invalid }),
    });
    const run = async (channel: TerminationChannel): Promise<RunResult> => {
      const made = createRunSession({ clock: { nowMs: () => 1 }, runSeconds: 10 });
      if (!made.ok) throw new Error("session");
      return createTerminator({ session: made.value, channel, wallClock: { nowIso: calls.nowIso }, manifest: { build: (core) => (calls.build(), defaultManifest(core)) }, runId: "run-0001", base: BASE, startedAt: STARTED }).terminate();
    };
    expect(await run(make(false, 0, 1))).toMatchObject({ sealed: false, failure: "internal_error", terminationReason: "error" });
    expect(calls.appendTermination).not.toHaveBeenCalled();
    expect(calls.seal).not.toHaveBeenCalled();
    expect(calls.build).not.toHaveBeenCalled();
    expect(calls.nowIso).not.toHaveBeenCalled();
    expect(await run(make(false, 1, 1))).toMatchObject({ sealed: false, failure: "secret_rejected" });
    expect(await run(make(true, 1, 1))).toMatchObject({ sealed: false, failure: "store_failed" });
    expect(await run(make(true, 0, 1))).toMatchObject({ sealed: false, failure: "store_failed" });
    expect(await run(make(false, 0, 0))).toMatchObject({ sealed: true });
    expect(calls.seal).toHaveBeenCalledTimes(1);
  });
});
