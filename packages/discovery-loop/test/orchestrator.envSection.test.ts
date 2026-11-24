// Task 4.6 W2: the `envVarsRead` section inside the real Loop_Orchestrator, and the end of a started Run. REAL startup tickets (stage B with in-memory
// fake ports), the real start gate, start sequence, writer, Terminator and RunRecordStore on a MemoryFileSystem; the loop of iterations is replaced by
// one that ends the Run at once (this file is about the start and the end of a Run, not about the loop). Synthetic names only.
// The start gate is not under test here and is not changed: both tickets below are issued by the real stage B and both Runs start.
// Runtime contracts: a contradiction of the names and flags is found BEFORE any read, build or provider call; every exit of a started Run cancels the
// deadline timer (the count of calls in the source is not the contract, the cancelled timers are).
// **Validates: Requirements 19.2, 19.3, 12.13, 11.15, 11.16**
import { describe, expect, it, vi } from "vitest";
import { MANIFEST_FILE, MemoryFileSystem, RunRecordStore, checkStartupRefusals, validateRunConfig, type FileSystemPort } from "../src/index.js";
import type { StartupApproval } from "../src/config/startup.js";
import { runIterations } from "../src/orchestrator/iteration.js";
import { createLoopOrchestrator, type LoopExtras } from "../src/orchestrator/loopOrchestrator.js";
import type { LoopDeps } from "../src/orchestrator/types.js";
import { manifestInput } from "./helpers/runFixtures.js";
import { AUDIT_CANARY, CREDENTIAL_NAME, FakeLease, passingIsolation, type Any } from "./support/orchestratorFakes.js";
import { SYNTHETIC_RUN_ID } from "./support/syntheticRunId.js";

vi.mock("../src/orchestrator/iteration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/orchestrator/iteration.js")>();
  return {
    ...actual,
    runIterations: vi.fn(async (input: { session: { raise(reason: string): void } }) => {
      input.session.raise("iteration_limit_reached");
      return { finalHypothesisRevision: "none", iterationsUsed: 0, ended: "iteration_limit" as const };
    }),
  };
});
const loopSpy = vi.mocked(runIterations);

const DIR = "/run/out";
const H64 = (c: string): string => c.repeat(64);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
/** A value that no port may ever return: it sits in the fake environment only. */
const VALUE_CANARY = "credential-value-canary-4d81";

/** A real kiro-cli-like ticket whose `envNames` also lists the credential. `credentialFlag` is what `isSet` answers for that name. */
async function issueTicket(credentialFlag: boolean): Promise<StartupApproval<Any, Any, Any, FakeLease>> {
  const v = validateRunConfig({
    schemaVersion: 1, provider: "kiro-cli", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames: ["EXAMPLE_ONE", CREDENTIAL_NAME],
  });
  if (!v.ok) throw new Error("the test configuration is invalid");
  const lease = new FakeLease();
  const fakeEnv: Record<string, string> = { EXAMPLE_ONE: "x", [CREDENTIAL_NAME]: VALUE_CANARY };
  const ports: Any = {
    policy: { load: () => ({ ok: true, policy: { kind: "policy" }, table: { kind: "table" }, limits: { requests: 10, bodyBytes: 8192 }, policySha256: H64("a"), preparationTableSha256: H64("b") }) },
    auditConfig: { load: () => ({ ok: true, load: { kind: "audit", canary: AUDIT_CANARY }, sha256: H64("c") }) },
    // names and flags only: the values of `fakeEnv` never cross a port
    env: {
      isSet: (name: string) => (name === CREDENTIAL_NAME ? credentialFlag : name in fakeEnv),
      credentials: () => ({ ok: true, referenced: [{ name: CREDENTIAL_NAME, set: true }] }),
    },
    sandbox: { providerAvailable: () => true, destinations: () => ["relay.example.invalid"] },
    lease: {
      variables: () => ({ runId: true, nonce: true }),
      timing: () => ({ ok: true, heartbeatIntervalMs: 1000, staleAfterMs: 4000, propagationDelayMs: 123 }),
      port: () => lease,
      check: () => Promise.resolve({ valid: true, runId: SYNTHETIC_RUN_ID }),
    },
    io: { runVolume: () => ({ exists: true, writable: true, empty: true }), configFiles: () => ["run-config.json", "audit-config.json"] },
  };
  const r = await checkStartupRefusals(v.value, ports);
  if (!r.ok) throw new Error("expected a ticket");
  return r.value as StartupApproval<Any, Any, Any, FakeLease>;
}

interface Opts {
  /** The Manifest port throws (a Manifest that cannot be built). */
  readonly manifestThrows?: boolean;
}

async function harness(credentialFlag: boolean, o: Opts = {}) {
  const approval = await issueTicket(credentialFlag);
  const mem = new MemoryFileSystem();
  mem.addDir(DIR);
  const cores: Any[] = [];
  const timers: { cancelled: number }[] = [];
  const calls = { provider: 0, execute: 0, bundle: 0 };
  let store: RunRecordStore | undefined;
  const deps = {
    isolation: passingIsolation().deps,
    fs: mem as FileSystemPort,
    runVolumeDir: DIR,
    clock: { nowMs: (): number => 1_000 },
    wallClock: { nowIso: (): string => "2025-01-01T00:00:00Z" },
    timers: {
      schedule: () => {
        const e = { cancelled: 0 };
        timers.push(e);
        return { cancel: () => { e.cancelled += 1; } };
      },
    },
    provider: { identity: { id: "mock", version: "1", model: "none" }, complete: async () => { calls.provider += 1; throw new Error("not called"); } },
    audit: { prepareAudit: () => ({ ok: false, error: { code: "prepare_failed" } }), auditPayload: () => ({}) },
    responseGate: {},
    policy: { createAcceptanceCheck: () => () => ({ accepted: true }), evaluateForRecord: () => undefined },
    runnerFactory: () => ({
      health: async () => ({ ok: true }),
      execute: async () => { calls.execute += 1; throw new Error("not called"); },
      measureStartState: async () => ({ ok: true, identity: "a".repeat(64) }),
    }),
    comparator: { compare: () => undefined },
    analysisFs: { readFile: async () => new Uint8Array(1), lstat: async () => ({ kind: "file", nlink: 1 }) },
    repoRoot: "/repo",
    analysis: {
      buildSourceBundle: async () => {
        calls.bundle += 1;
        return { ok: true, value: { manifest: [{ path: "legacy/src/a.php", sha256Lf: H64("a") }], files: [{ path: "legacy/src/a.php", text: "x" }] } };
      },
      verifyCitations: () => [],
      validateDeclarations: () => ({ ok: true, value: {} }),
      validateExpr: () => ({ ok: true, value: {} }),
    },
    storeFactory: {
      open: async (fs: FileSystemPort, dir: string) => {
        const r = await RunRecordStore.open(fs, dir);
        if (r.ok) store = r.value;
        return r;
      },
    },
    manifest: {
      build: (core: Any) => {
        cores.push(core);
        if (o.manifestThrows === true) throw new Error("manifest cannot be built");
        return manifestInput({
          runId: core.runId,
          wallClock: core.wallClock,
          terminationReason: core.terminationReason,
          finalHypothesisRevision: core.finalHypothesisRevision,
          limitsUsed: core.limitsUsed,
          sourceBundle: { schemaVersion: 1, hashRule: "sha256 over UTF-8 bytes after CRLF and lone CR are replaced by LF", files: core.sourceBundleManifest?.files ?? [] },
          envVarsRead: core.envVarsRead,
        });
      },
    },
  } as unknown as LoopDeps<Any, Any, Any, Any, Any>;
  const extras: LoopExtras = {
    validator: {},
    semanticSha256Of: () => ({ ok: true, value: H64("e") }),
    templateIds: { hypothesisGeneration: "tg", experimentGeneration: "te", hypothesisRevision: "tr" },
    responseLimits: { hypothesisGeneration: {}, experimentGeneration: {}, hypothesisRevision: {} },
  };
  const orchestrator = createLoopOrchestrator(deps, extras);
  const kinds = (): string[] => (store?.list() ?? []).map((x) => x.kind);
  const volumeText = (): string => [JSON.stringify(store?.list() ?? []), ...mem.allFiles().map((f) => dec(mem.peek(f) ?? new Uint8Array(0)))].join("\n");
  return { approval, mem, cores, timers, calls, kinds, volumeText, run: () => orchestrator.run(approval) };
}

describe("control: the same state in both lists", () => {
  it("is sealed; one entry per name; the bundle is built and recorded; the loop runs; the timer is cancelled once", async () => {
    loopSpy.mockClear();
    const h = await harness(true);
    expect(h.approval.credentials).toEqual([{ name: CREDENTIAL_NAME, set: true }]);
    const r = await h.run();
    expect(r).toMatchObject({ sealed: true, summary: { terminationReason: "iteration_limit_reached" } });
    expect(h.cores).toHaveLength(1);
    expect(h.cores[0].envVarsRead).toEqual([{ name: "EXAMPLE_ONE", set: true }, { name: CREDENTIAL_NAME, set: true }]);
    const manifest = JSON.parse(dec(h.mem.peek(`${DIR}/${MANIFEST_FILE}`) as Uint8Array)) as Any;
    expect(manifest.envVarsRead).toEqual([{ name: "EXAMPLE_ONE", set: true }, { name: CREDENTIAL_NAME, set: true }]);
    expect(h.calls.bundle).toBe(1);
    expect(loopSpy).toHaveBeenCalledTimes(1);
    expect(h.kinds()).toEqual(["run_started", "isolation_checks", "source_bundle_manifest", "termination"]);
    expect(h.timers.map((t) => t.cancelled)).toEqual([1]);
  });
});

describe("a contradiction of the names and flags is found before anything is read, built or sent", () => {
  // the credential name is in envNames as unset but referenced as set; the same stage B issued this ticket, and the start gate passes
  async function mismatch() {
    loopSpy.mockClear();
    const h = await harness(false);
    expect(h.approval.credentials).toEqual([{ name: CREDENTIAL_NAME, set: true }]); // the gate is unchanged: the ticket exists
    expect(h.approval.envVarsRead.find((x) => x.name === CREDENTIAL_NAME)).toEqual({ name: CREDENTIAL_NAME, set: false });
    const r = await h.run();
    return { h, r };
  }

  it("the Run ends unsealed; the cause is `error`, taken from the latch; no Manifest is built or sealed", async () => {
    const { h, r } = await mismatch();
    expect(r).toEqual({ sealed: false, started: true, terminationReason: "error", failure: "internal_error" });
    expect(h.cores).toHaveLength(0); // the Manifest port was never called
    expect(h.mem.allFiles().some((f) => f.endsWith(MANIFEST_FILE))).toBe(false);
  });

  it("no provider call, no Experiment executed, no phase, no Source_Bundle built, no source_bundle_manifest record, no termination record", async () => {
    const { h } = await mismatch();
    expect(h.calls).toEqual({ provider: 0, execute: 0, bundle: 0 });
    expect(loopSpy).not.toHaveBeenCalled();
    expect(h.kinds()).toEqual(["run_started", "isolation_checks"]); // the Run did start (the gate passed); nothing else was written
  });

  it("the deadline timer that the start armed is cancelled exactly once", async () => {
    const { h } = await mismatch();
    expect(h.timers).toHaveLength(1);
    expect(h.timers.map((t) => t.cancelled)).toEqual([1]);
  });

  it("no variable name, credential value or audit canary in the result or anywhere in the Run_Volume (positive control: the detector sees a planted value)", async () => {
    const { h, r } = await mismatch();
    const everything = `${JSON.stringify(r)}\n${h.volumeText()}`;
    for (const leak of [CREDENTIAL_NAME, VALUE_CANARY, AUDIT_CANARY]) expect(everything, leak).not.toContain(leak);
    expect(`${everything}\n${VALUE_CANARY}`).toContain(VALUE_CANARY);
  });

});

describe("every exit of a started Run cancels the deadline timer (runtime, not a count of calls in the source)", () => {
  it("a Manifest that cannot be built: manifest_build_failed with the latched cause, the timer cancelled once", async () => {
    loopSpy.mockClear();
    const h = await harness(true, { manifestThrows: true });
    const r = await h.run();
    expect(r).toMatchObject({ sealed: false, started: true, failure: "manifest_build_failed", terminationReason: "iteration_limit_reached" });
    expect(h.cores).toHaveLength(1);
    expect(h.timers.map((t) => t.cancelled)).toEqual([1]);
  });

  it("the normal end and the contradiction end differ only in what was built: both cancel exactly once (the unmanaged end is in orchestrator.loopOrchestrator.test.ts)", async () => {
    const ok = await harness(true);
    await ok.run();
    const bad = await harness(false);
    await bad.run();
    expect(ok.timers.map((t) => t.cancelled)).toEqual([1]);
    expect(bad.timers.map((t) => t.cancelled)).toEqual([1]);
  });
});