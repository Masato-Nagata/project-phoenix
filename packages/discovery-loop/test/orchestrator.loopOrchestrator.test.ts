// Task 4.4, unit U7: the order and the guarantees of the composition root (`src/orchestrator/loopOrchestrator.ts`). Deterministic and offline. REAL startup
// tickets (stage B with in-memory fake ports), the REAL start gate, start sequence, RecordWriter, RunSession, Terminator and RunRecordStore on a
// MemoryFileSystem; scripted lease, clock, timers, Runner, Source_Bundler and manifest port. `runIterations` is wrapped by a spy that calls the real function
// unless a test replaces it for one call.
// **Validates: Requirements 2.12, 11.15, 12.13, 12.14, 15.6, 19.7**
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFileSystem, RunRecordStore, type FileSystemPort } from "../src/index.js";
import { EvidenceStore } from "../src/model/evidenceStore.js";
import { runIterations } from "../src/orchestrator/iteration.js";
import { createLoopOrchestrator, type LoopExtras } from "../src/orchestrator/loopOrchestrator.js";
import type { LoopDeps, RunResult } from "../src/orchestrator/types.js";
import { manifestInput } from "./helpers/runFixtures.js";
import { AUDIT_CANARY, failingIsolation, issueStartup, passingIsolation, type Any } from "./support/orchestratorFakes.js";

vi.mock("../src/orchestrator/iteration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/orchestrator/iteration.js")>();
  return { ...actual, runIterations: vi.fn(actual.runIterations) };
});
const spy = vi.mocked(runIterations);

// A refusal the writer does not count (admission closed, a thrown or rejected append) cannot be produced by the real store: this wrapper makes the
// public writer answer it for the `error` record only. Everything else is the real RecordWriter.
const writerFault: { mode?: "admission_closed" | "closed_after_termination" | "termination_reserved" | "rejects" | "throws" } = {};
vi.mock("../src/orchestrator/recordWriter.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/orchestrator/recordWriter.js")>();
  return {
    ...actual,
    createRecordWriter: (store: never) => {
      const parts = actual.createRecordWriter(store);
      const append: typeof parts.writer.append = (kind, payload, component) => {
        const m = writerFault.mode;
        if (kind !== "error" || m === undefined) return parts.writer.append(kind, payload, component);
        if (m === "rejects") return Promise.reject(new Error("PATH_TEXT_/secret/dir"));
        if (m === "throws") throw new Error("PATH_TEXT_/secret/dir");
        return Promise.resolve({ ok: false as const, error: { code: m } });
      };
      return { ...parts, writer: { ...parts.writer, append } };
    },
  };
});

const DIR = "/run/out";
const H64 = (c: string): string => c.repeat(64);
const MAX_WAIT_TURNS = 200;
/** Waits (bounded, macrotask turns) until the predicate holds; fails with a clear error otherwise. */
const waitFor = async (what: string, predicate: () => boolean): Promise<void> => {
  for (let i = 0; i < MAX_WAIT_TURNS; i += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`waitFor: "${what}" not reached within ${MAX_WAIT_TURNS} macrotask turns`);
};
/** A few extra macrotask turns, so that an unwanted progress after the awaited state would show. */
const settleTurns = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

const BUNDLE = { manifest: [{ path: "legacy/src/a.php", sha256Lf: H64("a") }], files: [{ path: "legacy/src/a.php", text: "SOURCE_TEXT_MARKER" }] };

interface Opts {
  readonly health?: () => unknown;
  /** The Source_Bundler: receives the WRAPPED file system. */
  readonly build?: (fs: Any) => Promise<unknown>;
  /** The raw analysis file system: `readFile` and `lstat`. */
  readonly rawFs?: Any;
  readonly isolation?: "pass" | "fail";
  readonly holdErrorAppend?: Promise<void>;
  /** The store answers `io_failure` for the `error` record. */
  readonly failErrorAppend?: boolean;
  /** The store refuses the `error` record with this kind (nothing is written; the store stays healthy). */
  readonly refuseErrorAppend?: "invalid_record" | "secret_rejected";
}

async function harness(o: Opts = {}) {
  const log: string[] = [];
  const { approval, lease } = await issueStartup({
    behave: () => {
      log.push("leaseCheck");
      return { valid: true };
    },
  });
  const mem = new MemoryFileSystem();
  mem.addDir(DIR);
  const cores: Any[] = [];
  const timerEntries: { cancelled: number }[] = [];
  let store: RunRecordStore | undefined;
  const bundle = BUNDLE;
  const deps = {
    isolation: (o.isolation === "fail" ? failingIsolation() : passingIsolation()).deps,
    fs: mem as FileSystemPort,
    runVolumeDir: DIR,
    clock: { nowMs: (): number => 1_000 },
    wallClock: { nowIso: (): string => "2025-01-01T00:00:00Z" },
    timers: {
      schedule: () => {
        log.push("schedule");
        const e = { cancelled: 0 };
        timerEntries.push(e);
        return { cancel: () => { e.cancelled += 1; log.push("cancel"); } };
      },
    },
    provider: { identity: { id: "mock", version: "1", model: "not_applicable" }, complete: async () => { throw new Error("not called"); } },
    audit: { prepareAudit: () => ({ ok: false, error: { code: "prepare_failed" } }), auditPayload: () => ({}) },
    responseGate: {},
    policy: { createAcceptanceCheck: () => () => ({ accepted: true }), evaluateForRecord: () => undefined },
    runnerFactory: () => {
      log.push("runnerFactory");
      return {
        health: async () => {
          log.push("health");
          return o.health === undefined ? { ok: true } : o.health();
        },
        execute: async () => { throw new Error("not called"); },
      };
    },
    comparator: { compare: () => undefined },
    analysisFs: o.rawFs ?? { readFile: async () => new Uint8Array(1), lstat: async () => ({ kind: "file", nlink: 1 }) },
    repoRoot: "/repo",
    analysis: {
      buildSourceBundle: async (fs: Any) => {
        log.push("buildSourceBundle");
        if (o.build !== undefined) return o.build(fs);
        return { ok: true, value: bundle };
      },
      verifyCitations: () => [],
      validateDeclarations: () => ({ ok: true, value: {} }),
      validateExpr: () => ({ ok: true, value: {} }),
    },
    storeFactory: {
      open: async (fs: FileSystemPort, dir: string) => {
        log.push("storeOpen");
        const r = await RunRecordStore.open(fs, dir);
        if (!r.ok) return r;
        store = r.value;
        const real = r.value.append.bind(r.value);
        (r.value as Any).append = async (kind: string, payload: Any, options: Any): Promise<Any> => {
          log.push(`append:${kind}`);
          if (kind === "error" && o.holdErrorAppend !== undefined) await o.holdErrorAppend;
          if (kind === "error" && o.failErrorAppend === true) return { ok: false, error: { kind: "io_failure", message: "injected" } };
          if (kind === "error" && o.refuseErrorAppend !== undefined) return { ok: false, error: { kind: o.refuseErrorAppend, message: "injected" } };
          const res = await real(kind as never, payload, options);
          log.push(`append:${kind}:end`);
          return res;
        };
        return r;
      },
    },
    manifest: {
      build: (core: Any) => {
        cores.push(core);
        return manifestInput({
          runId: core.runId,
          wallClock: core.wallClock,
          terminationReason: core.terminationReason,
          finalHypothesisRevision: core.finalHypothesisRevision,
          limitsUsed: core.limitsUsed,
          sourceBundle: { schemaVersion: 1, hashRule: "sha256 over UTF-8 bytes after CRLF and lone CR are replaced by LF", files: core.sourceBundleManifest?.files ?? [] },
        });
      },
    },
  } as unknown as LoopDeps<Any, Any, Any, Any, Any>;
  const extras: LoopExtras = {
    validator: { tag: "validator" },
    semanticSha256Of: () => ({ ok: true, value: H64("e") }),
    templateIds: { hypothesisGeneration: "tg", experimentGeneration: "te", hypothesisRevision: "tr" },
    responseLimits: { hypothesisGeneration: { tag: "g" }, experimentGeneration: { tag: "e" }, hypothesisRevision: { tag: "r" } },
  };
  const orchestrator = createLoopOrchestrator(deps, extras);
  return { log, approval, lease, mem, cores, timerEntries, store: () => store, orchestrator, extras, bundle, run: (): Promise<RunResult> => orchestrator.run(approval) };
}

/** A `runIterations` replacement that records its place in the log and ends the Run with the iteration limit. */
const endingLoop = (log: string[], gate?: Promise<void>) => async (input: Any) => {
  log.push("runIterations");
  if (gate !== undefined) await gate;
  log.push("runIterations:end");
  input.session.raise("iteration_limit_reached");
  return { finalHypothesisRevision: "hyp-9", iterationsUsed: 1, ended: "iteration_limit" as const };
};
const at = (log: string[], label: string): number => {
  const i = log.indexOf(label);
  expect(i, label).toBeGreaterThanOrEqual(0);
  return i;
};

beforeEach(() => {
  spy.mockClear();
});

describe("the order of a Run", () => {
  it("startGate, startRun, bundle, bundle record, runIterations, timer cancel, termination record", async () => {
    const h = await harness();
    spy.mockImplementationOnce(endingLoop(h.log) as Any);
    const r = await h.run();
    expect(r).toMatchObject({ sealed: true, summary: { terminationReason: "iteration_limit_reached" } });
    const labels = ["leaseCheck", "storeOpen", "runnerFactory", "append:run_started", "append:isolation_checks", "health", "buildSourceBundle", "append:source_bundle_manifest", "runIterations", "cancel", "append:termination"];
    const idx = labels.map((l) => at(h.log, l));
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(h.log.filter((l) => l === "storeOpen")).toHaveLength(1);
    expect(h.timerEntries.map((e) => e.cancelled)).toEqual([1]);
  });

  it("the timer is cancelled before the termination record is written", async () => {
    const h = await harness();
    spy.mockImplementationOnce(endingLoop(h.log) as Any);
    await h.run();
    expect(at(h.log, "cancel")).toBeLessThan(at(h.log, "append:termination"));
  });

  it("runIterations gets the ports of the Run, the limits of the ticket, a fresh Evidence_Store, and a writer without termination authority", async () => {
    const h = await harness();
    spy.mockImplementationOnce(endingLoop(h.log) as Any);
    await h.run();
    const input = spy.mock.calls[0]?.[0] as Any;
    const limits = h.approval.config.limits;
    expect(input.leasePort).toBe(h.lease);
    expect(input.auditConfig).toBe(h.approval.auditConfig.load);
    expect(input.limits).toEqual({
      iterations: limits.iterations, experiments: limits.experiments, rejectedExperiments: limits.rejectedExperiments, providerCallSeconds: limits.providerCallSeconds, providerRetries: limits.providerRetries,
    });
    expect(input.experiment.mask).toBe(h.approval.config.mask);
    expect(input.experiment.policyConfig).toBe(h.approval.policy.value);
    expect(input.hypothesis.generationStored).toEqual([]);
    expect(input.evidenceStore).toBeInstanceOf(EvidenceStore);
    expect(input.hypothesis.generation).toMatchObject({ templateId: "tg", responseLimits: { tag: "g" }, validator: { tag: "validator" } });
    expect(input.hypothesis.revision).toMatchObject({ templateId: "tr", responseLimits: { tag: "r" } });
    expect(input.experiment).toMatchObject({ templateId: "te", responseLimits: { tag: "e" } });
    for (const k of ["seal", "appendTermination", "closeAdmission"]) expect(k in input.writer, k).toBe(false);
    expect(input.bundle).toBe(h.bundle);
  });

  it("runIterations is NOT called when the start sequence says proceed: false (the Runner health check fails)", async () => {
    const h = await harness({ health: () => ({ ok: false, error: "unhealthy" }) });
    const r = await h.run();
    expect(spy).not.toHaveBeenCalled();
    expect(r).toMatchObject({ sealed: true, summary: { terminationReason: "error" } });
    expect(h.log).toContain("append:termination");
  });

  it("runIterations is settled before anything is terminated (nothing is written while it is still running)", async () => {
    const h = await harness();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    spy.mockImplementationOnce(endingLoop(h.log, gate) as Any);
    const pending = h.run();
    await waitFor("runIterations started", () => h.log.includes("runIterations"));
    await settleTurns();
    expect(h.log).toContain("runIterations");
    expect(h.log).not.toContain("runIterations:end");
    expect(h.log).not.toContain("append:termination");
    expect(h.log).not.toContain("cancel");
    release();
    const r = await pending;
    expect(r.sealed).toBe(true);
    expect(at(h.log, "runIterations:end")).toBeLessThan(at(h.log, "cancel"));
    expect(at(h.log, "cancel")).toBeLessThan(at(h.log, "append:termination"));
  });

  it("a throw of runIterations raises `error`, and the Run still ends through the Terminator", async () => {
    const h = await harness();
    spy.mockImplementationOnce((async () => { throw new Error("run records unavailable"); }) as Any);
    const r = await h.run();
    expect(r).toMatchObject({ sealed: true, summary: { terminationReason: "error" } });
    expect(h.log).toContain("append:termination");
    expect(h.cores[0].finalHypothesisRevision).toBe("none");
  });
});

describe("the observer of the Source_Bundler reads", () => {
  const denied = (): Any => ({
    readFile: async () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); },
    lstat: async () => ({ kind: "file", nlink: 1 }),
  });
  /** A bundler that reads one file through the file system it receives, swallows the denial, and still answers with a bundle. */
  const readingBuild = (bundle: unknown) => async (fs: Any): Promise<unknown> => {
    try {
      await fs.readFile("legacy/src/a.php");
    } catch {
      // the denial is reported by the wrapper; the bundler goes on
    }
    return { ok: true, value: bundle };
  };

  it("pending observer writes are settled before the termination record; the cause is isolation_violation; no phase runs", async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const h = await harness({ rawFs: denied(), holdErrorAppend: hold, build: readingBuild(BUNDLE) });
    const pending = h.run();
    await waitFor("error append reached", () => h.log.includes("append:error"));
    await settleTurns();
    expect(h.log).toContain("append:error");
    expect(h.log).not.toContain("append:error:end");
    expect(h.log).not.toContain("append:termination"); // the Run waits for the write of the violation record
    release();
    const r = await pending;
    expect(r).toMatchObject({ sealed: true, summary: { terminationReason: "isolation_violation" } });
    expect(at(h.log, "append:error:end")).toBeLessThan(at(h.log, "append:termination"));
    expect(spy).not.toHaveBeenCalled(); // a latched cause: no phase
    const errors = h.store()?.list().filter((x) => x.kind === "error").map((x) => x.payload);
    expect(errors).toEqual([{ code: "isolation_violation", op: "read", errorCode: "EACCES", locationId: "unlisted" }]);
  });

  it("a failed write of the violation record is not lost: the Run ends unsealed, with the true cause", async () => {
    const h = await harness({ rawFs: denied(), failErrorAppend: true, build: readingBuild(BUNDLE) });
    const r = await h.run();
    expect(r).toMatchObject({ sealed: false, started: true, failure: "store_failed", terminationReason: "isolation_violation" });
    expect(h.log).not.toContain("append:termination");
    expect(spy).not.toHaveBeenCalled();
  });

  it("an invalid_record answer for the violation record ends unsealed (internal_error), cause isolation_violation", async () => {
    const h = await harness({ rawFs: denied(), refuseErrorAppend: "invalid_record", build: readingBuild(BUNDLE) });
    const r = await h.run();
    expect(r).toMatchObject({ sealed: false, started: true, failure: "internal_error", terminationReason: "isolation_violation" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("a secret-rejected answer for the violation record ends unsealed (secret_rejected), cause isolation_violation", async () => {
    const h = await harness({ rawFs: denied(), refuseErrorAppend: "secret_rejected", build: readingBuild(BUNDLE) });
    const r = await h.run();
    expect(r).toMatchObject({ sealed: false, started: true, failure: "secret_rejected", terminationReason: "isolation_violation" });
  });

  it("control: a successful violation record seals, with the closed vocabulary only and no message or path text", async () => {
    const h = await harness({ rawFs: denied(), build: readingBuild(BUNDLE) });
    const r = await h.run();
    expect(r).toMatchObject({ sealed: true, summary: { terminationReason: "isolation_violation" } });
    const errors = h.store()?.list().filter((x) => x.kind === "error").map((x) => x.payload);
    expect(errors).toEqual([{ code: "isolation_violation", op: "read", errorCode: "EACCES", locationId: "unlisted" }]);
    const text = JSON.stringify([r, errors]);
    for (const leak of [AUDIT_CANARY, "denied", "PATH_TEXT", "legacy/src/a.php"]) expect(text).not.toContain(leak);
  });

  describe.each(["admission_closed", "closed_after_termination", "termination_reserved", "rejects", "throws"] as const)("the writer refuses the violation record: %s", (mode) => {
    it("is never sealed: closed unsealed code, latched cause kept, nothing terminated, no provider call, no leak", async () => {
      writerFault.mode = mode;
      try {
        const h = await harness({ rawFs: denied(), build: readingBuild(BUNDLE) });
        const r = await h.run();
        expect(r).toEqual({ sealed: false, started: true, terminationReason: "isolation_violation", failure: "internal_error" });
        expect(h.log).not.toContain("append:termination");
        expect(h.store()?.list().some((x) => x.kind === "error")).toBe(false);
        expect(h.timerEntries.every((t) => t.cancelled >= 1)).toBe(true);
        expect(spy).not.toHaveBeenCalled();
        const text = JSON.stringify(r);
        for (const leak of [AUDIT_CANARY, "PATH_TEXT", "secret/dir"]) expect(text).not.toContain(leak);
      } finally {
        writerFault.mode = undefined;
      }
    });
  });
});

describe("a ticket is used once; a refusal writes nothing", () => {
  it("the second run with the same ticket is refused and writes no record and opens no store", async () => {
    const h = await harness();
    spy.mockImplementationOnce(endingLoop(h.log) as Any);
    const first = await h.run();
    expect(first.sealed).toBe(true);
    const records = h.store()?.list().length;
    const opens = h.log.filter((l) => l === "storeOpen").length;
    const logLength = h.log.length;
    const second = await h.run();
    expect(second).toEqual({ sealed: false, started: false, failure: "internal_error" });
    expect(h.store()?.list().length).toBe(records);
    expect(h.log.filter((l) => l === "storeOpen")).toHaveLength(opens);
    expect(h.log.length).toBe(logLength);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("a refusal of the start gate (the isolation verification fails) writes nothing, opens no store and builds no bundle", async () => {
    const h = await harness({ isolation: "fail" });
    const r = await h.run();
    expect(r.sealed).toBe(false);
    if (!r.sealed) expect(r.started).toBe(false);
    expect(h.log).not.toContain("storeOpen");
    expect(h.log).not.toContain("buildSourceBundle");
    expect(h.mem.allFiles()).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("what the Manifest core is made of", () => {
  it("only names, flags, hashes, numbers and the validated configuration; nothing of the ticket as a whole", async () => {
    const h = await harness();
    spy.mockImplementationOnce(endingLoop(h.log) as Any);
    await h.run();
    const core = h.cores[0];
    expect(Object.keys(core).sort()).toEqual([
      "accessDenial", "configHashes", "effectiveConfig", "envVarsRead", "finalHypothesisRevision", "leaseFacts", "limitsUsed", "payloadAudit", "provider", "runId", "sourceBundleManifest",
      "terminationReason", "wallClock",
    ]);
    expect(core.finalHypothesisRevision).toBe("hyp-9"); // from the result of runIterations
    expect(core.terminationReason).toBe("iteration_limit_reached"); // from the latch
    expect(core.provider).toEqual({ id: "mock", version: "1", model: "not_applicable", isMock: true });
    expect(core.configHashes).toEqual({ policyConfigSha256: h.approval.policy.policySha256, preparationTableSha256: h.approval.policy.preparationTableSha256 });
    expect(core.payloadAudit).toEqual({ configCheck: "pass", audits: 0, passed: 0, blocked: 0, auditConfigSha256: h.approval.auditConfig.sha256 });
    expect(core.leaseFacts).toEqual({ heartbeatIntervalMs: h.approval.lease.heartbeatIntervalMs, staleAfterMs: h.approval.lease.staleAfterMs, propagationDelayMs: h.approval.lease.propagationDelayMs });
    expect(core.sourceBundleManifest).toEqual({ files: [{ path: "legacy/src/a.php", sha256Lf: H64("a") }] });
    expect(core.effectiveConfig).toEqual(JSON.parse(JSON.stringify(h.approval.config)));
    for (const e of core.envVarsRead) expect(Object.keys(e).sort()).toEqual(["name", "set"]);
    const text = JSON.stringify(core);
    expect(text).not.toContain(AUDIT_CANARY);
    expect(text).not.toContain("SOURCE_TEXT_MARKER");
    // the bundle record carries paths and hashes only
    const rec = h.store()?.list().find((x) => x.kind === "source_bundle_manifest");
    expect(rec?.payload).toEqual({ files: [{ path: "legacy/src/a.php", sha256Lf: H64("a") }] });
    expect(JSON.stringify(h.store()?.list())).not.toContain("SOURCE_TEXT_MARKER");
  });

  it("a Source_Bundler that throws raises `error`: no phase, no bundle record", async () => {
    const h = await harness({ build: async () => { throw new Error("build failed"); } });
    const r = await h.run();
    expect(spy).not.toHaveBeenCalled();
    expect(h.store()?.list().some((x) => x.kind === "source_bundle_manifest")).toBe(false);
    expect(r).toMatchObject({ sealed: false, failure: "manifest_build_failed", terminationReason: "error" }); // the scripted manifest port needs the bundle
  });
});
