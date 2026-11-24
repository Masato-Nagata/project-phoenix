// Task 4.4, unit U4: the start sequence (`src/orchestrator/startRun.ts`). Deterministic and offline. REAL startup tickets (stage B), the REAL
// start gate on the task 4.2 fakes, the REAL RunRecordStore on a MemoryFileSystem behind a fault injector, the REAL RecordWriter, RunSession and
// Terminator; a scripted monotonic clock, a scripted wall clock, a scripted TimerPort and a scripted Runner. Every refusal has a passing control.
// **Validates: Requirements 11.12, 11.17, 12.14, 15.12, 15.14, 24.9, 24.15**
import { describe, expect, it, vi } from "vitest";
import { MemoryFileSystem, RunRecordStore, type FileSystemPort, type JsonObject } from "../src/index.js";
import { WRITER_ERROR_CODES } from "../src/orchestrator/recordWriter.js";
import { startGate } from "../src/orchestrator/startGate.js";
import { mapRunStartedFailure, startRun, type StartRunResult } from "../src/orchestrator/startRun.js";
import { createTerminator, type TerminationBase } from "../src/orchestrator/terminate.js";
import { UNSEALED_FAILURE_CODES, type LoopDeps, type ManifestCore, type StartGateSuccess, type TimerPort } from "../src/orchestrator/types.js";
import { createAcceptanceCheck } from "../../verifier/src/identity/acceptance.js";
import { createRunner } from "../../verifier/src/runner/runner.js";
import { experiment, makeParts, type Parts } from "../../verifier/test/helpers/runnerFixtures.js";
import { manifestInput } from "./helpers/runFixtures.js";
import {
  AUDIT_CANARY,
  LeaseCheckInterrupted,
  OTHER_SYNTHETIC_RUN_ID,
  SYNTHETIC_RUN_ID,
  issueStartup,
  passingIsolation,
  strictLoopDeps,
  type Any,
} from "./support/orchestratorFakes.js";

const DIR = "/run/out";
const WALL = "2025-01-01T00:00:00Z";
const HEALTH_CANARY = "HEALTH_CANARY_63";
const H64 = (c: string): string => c.repeat(64);
const has = (v: unknown, s: string): boolean => JSON.stringify(v).includes(s);
const flush = async (): Promise<void> => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};

type Op = "writeFileSynced" | "rename" | "syncDir" | "readFile";
const noopFn = (): void => undefined;
function faultFs(inner: MemoryFileSystem): { fs: FileSystemPort; arm(op: Op, nth?: number): void; hold(op: Op): () => void } {
  let plan: { op: Op; left: number } | undefined;
  let holdPlan: { op: Op; gate: Promise<void> } | undefined;
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

interface TimerEntry {
  readonly delay: number;
  readonly fire: () => void;
  cancelled: number;
}

interface WorldOpts {
  /** The answer of the lease re-check (the second `check` of the ticket's lease; the first one belongs to the start gate). */
  readonly recheck?: () => unknown;
  readonly storeOpen?: "fail" | "throw";
  readonly runnerFactory?: "throw" | "bad";
  /** Runs inside the Runner factory (to move the clock before the checkpoint of step 5). */
  readonly inRunnerFactory?: (w: World) => void;
  readonly scheduleThrows?: boolean;
  readonly wall?: () => unknown;
  readonly health?: (w: World) => unknown;
  /** The answer of the start-state measurement (task 4.6 W6; default: a successful identity). Receives the signal and the options passed. */
  readonly measure?: (w: World, signal: AbortSignal, options: unknown) => unknown;
  readonly secretPatterns?: readonly { id: string; source: string }[];
  readonly clockStart?: number;
  readonly firstClockReading?: number;
  /** Replaces the scripted Runner: the answer of the Runner factory, built from the very input that `startRun` passed (unit U4 fail-closed tests). */
  readonly build?: (input: Any) => unknown;
}

interface World {
  readonly log: string[];
  readonly mem: MemoryFileSystem;
  readonly arm: (op: Op, nth?: number) => void;
  readonly hold: (op: Op) => () => void;
  readonly clock: { set(v: number): void; value(): number };
  readonly timers: TimerEntry[];
  readonly deps: LoopDeps;
  readonly gate: StartGateSuccess;
  readonly approval: Any;
  readonly lease: Any;
  store(): RunRecordStore | undefined;
  readonly captured: { input?: Any };
  readonly healthCalls: { n: number };
  readonly measureCalls: { n: number; signal?: AbortSignal; options?: unknown };
}

async function world(o: WorldOpts = {}): Promise<World> {
  const log: string[] = [];
  let leaseCalls = 0;
  const { approval, lease } = await issueStartup({
    behave: () => {
      leaseCalls += 1;
      log.push("leaseCheck");
      if (leaseCalls === 1) return { valid: true }; // the start gate's running-rule check
      return o.recheck === undefined ? { valid: true } : o.recheck();
    },
  });
  const gateResult = await startGate(strictLoopDeps(passingIsolation().deps).deps, approval);
  if (!gateResult.ok) throw new Error(`the start gate refused: ${JSON.stringify(gateResult.error)}`);
  log.length = 0;

  const mem = new MemoryFileSystem();
  mem.addDir(DIR);
  const f = faultFs(mem);
  let t = o.clockStart ?? 1_000;
  let first = true;
  const clock = {
    nowMs: (): number => {
      log.push("clock");
      if (first) {
        first = false;
        if (o.firstClockReading !== undefined) return o.firstClockReading;
      }
      return t;
    },
  };
  const timers: TimerEntry[] = [];
  const timerPort: TimerPort = {
    schedule(delay, onFire) {
      log.push("schedule");
      if (o.scheduleThrows === true) throw new Error("schedule failed");
      const entry: TimerEntry = { delay, fire: onFire, cancelled: 0 };
      timers.push(entry);
      return {
        cancel: () => {
          entry.cancelled += 1;
        },
      };
    },
  };
  let store: RunRecordStore | undefined;
  const captured: { input?: Any } = {};
  const healthCalls = { n: 0 };
  const measureCalls: { n: number; signal?: AbortSignal; options?: unknown } = { n: 0 };
  // eslint-disable-next-line prefer-const
  let w: World;
  const deps = {
    clock,
    fs: f.fs,
    runVolumeDir: DIR,
    timers: timerPort,
    wallClock: {
      nowIso: (): string => {
        log.push("wallClock");
        return (o.wall === undefined ? WALL : o.wall()) as string;
      },
    },
    storeFactory: {
      open: async (fs: FileSystemPort, dir: string) => {
        log.push("storeOpen");
        if (o.storeOpen === "throw") throw new Error("open failed");
        if (o.storeOpen === "fail") return { ok: false, error: { kind: "run_volume_missing", message: "x" } };
        const r = await RunRecordStore.open(fs, dir, { secrets: { patterns: [...(o.secretPatterns ?? [])] } });
        if (r.ok) {
          store = r.value;
          const real = r.value.append.bind(r.value);
          vi.spyOn(r.value, "append").mockImplementation((kind, payload, options) => {
            log.push(`append:${kind}`);
            return real(kind, payload, options);
          });
        }
        return r;
      },
    },
    runnerFactory: (input: Any) => {
      log.push("runnerFactory");
      captured.input = input;
      o.inRunnerFactory?.(w);
      if (o.runnerFactory === "throw") throw Object.assign(new Error("RunnerStartRefused: limits_invalid"), { name: "RunnerStartRefused" });
      if (o.runnerFactory === "bad") return {};
      if (o.build !== undefined) return o.build(input);
      return {
        health: async () => {
          healthCalls.n += 1;
          log.push("health");
          return o.health === undefined ? { ok: true } : o.health(w);
        },
        execute: async () => {
          throw new Error("U4 never executes");
        },
        measureStartState: async (signal: AbortSignal, options: unknown) => {
          measureCalls.n += 1;
          measureCalls.signal = signal;
          measureCalls.options = options;
          log.push("measureStartState");
          return o.measure === undefined ? { ok: true, identity: "a".repeat(64) } : o.measure(w, signal, options);
        },
      };
    },
    policy: { createAcceptanceCheck: (records: () => readonly unknown[]) => createAcceptanceCheck(records as Any), evaluateForRecord: () => undefined },
  } as unknown as LoopDeps;
  w = {
    log,
    mem,
    arm: f.arm,
    hold: f.hold,
    clock: {
      set: (v: number) => {
        t = v;
      },
      value: () => t,
    },
    timers,
    deps,
    gate: gateResult.value,
    approval,
    lease,
    store: () => store,
    captured,
    healthCalls,
    measureCalls,
  };
  return w;
}
const run = (w: World, gate: StartGateSuccess = w.gate): Promise<StartRunResult> => startRun(w.deps as Any, w.approval, gate);
const started = (r: StartRunResult) => {
  if (r.kind !== "started") throw new Error(`expected a start, got ${JSON.stringify(r)}`);
  return r;
};
/** The default run time limit of the validated configuration (`runSeconds` 1800) after the clock start 1000. */
const DEADLINE = 1_000 + 1_800_000;

function expectRefusedClean(r: StartRunResult, w: World, failure: string): void {
  expect(r.kind).toBe("refused");
  if (r.kind !== "refused") return;
  expect(r.result).toEqual({ sealed: false, started: false, failure });
  expect(Object.keys(r.result).sort()).toEqual(["failure", "sealed", "started"]);
  expect(w.store()?.list() ?? []).toEqual([]);
  expect(w.mem.allFiles()).toEqual([]);
  for (const e of w.timers) expect(e.cancelled).toBe(1);
}

describe("the order of the start sequence", () => {
  it("clock, store open, Runner factory, checkpoint, lease re-check, timer, wall clock, run_started, isolation_checks, health", async () => {
    const w = await world();
    const r = started(await run(w));
    expect(r.run.proceed).toBe(true);
    const labels = ["clock", "storeOpen", "runnerFactory", "leaseCheck", "schedule", "wallClock", "append:run_started", "append:isolation_checks", "health", "measureStartState"];
    const at = labels.map((l) => w.log.indexOf(l));
    for (const [i, l] of labels.entries()) expect(at[i], l).toBeGreaterThanOrEqual(0);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    // the checkpoint of step 5 reads the clock between the Runner factory and the lease re-check
    expect(w.log.slice(w.log.indexOf("runnerFactory"), w.log.indexOf("leaseCheck"))).toContain("clock");
    expect(w.log.filter((l) => l === "leaseCheck")).toHaveLength(1);
    expect(w.log.filter((l) => l === "health")).toHaveLength(1);
    expect(w.log.filter((l) => l === "measureStartState")).toHaveLength(1);
  });
});

describe("refusals before the first write: no Run content, the timer cancelled when it was armed", () => {
  it("control: the same world starts", async () => {
    expect((await run(await world())).kind).toBe("started");
  });
  it("a clock that is not usable for the session", async () => {
    const w = await world({ firstClockReading: Number.NaN });
    expectRefusedClean(await run(w), w, "internal_error");
    expect(w.log).not.toContain("storeOpen");
  });
  it("store open answers not ok, or throws", async () => {
    for (const storeOpen of ["fail", "throw"] as const) {
      const w = await world({ storeOpen });
      expectRefusedClean(await run(w), w, "store_open_failed");
      expect(w.log).not.toContain("runnerFactory");
    }
  });
  it("the Runner factory throws, or returns no Runner", async () => {
    for (const runnerFactory of ["throw", "bad"] as const) {
      const w = await world({ runnerFactory });
      const r = await run(w);
      expectRefusedClean(r, w, "runner_start_refused");
      expect(has(r, "limits_invalid")).toBe(false);
      expect(w.log).not.toContain("leaseCheck");
    }
  });
  it("the checkpoint of step 5 stops: the deadline is reached, or the clock is faulty", async () => {
    const reached = await world({ inRunnerFactory: (x) => x.clock.set(DEADLINE) });
    expectRefusedClean(await run(reached), reached, "internal_error");
    expect(reached.log).not.toContain("leaseCheck");
    const faulty = await world({ inRunnerFactory: (x) => x.clock.set(Number.NaN) });
    expectRefusedClean(await run(faulty), faulty, "internal_error");
  });
  it("the lease re-check: invalid gives lease_invalid_at_start; a throw, a LeaseCheckInterrupted and an odd shape give internal_error", async () => {
    const invalid = await world({ recheck: () => ({ valid: false, reason: "revoked" }) });
    expectRefusedClean(await run(invalid), invalid, "lease_invalid_at_start");
    expect(invalid.log).not.toContain("schedule");
    for (const recheck of [
      () => {
        throw new Error("boom");
      },
      () => {
        throw new LeaseCheckInterrupted();
      },
      () => Promise.reject(new LeaseCheckInterrupted()),
      () => ({ valid: "yes" }),
      () => undefined,
    ]) {
      const w = await world({ recheck });
      expectRefusedClean(await run(w), w, "internal_error");
    }
  });
  it("the timer cannot be armed", async () => {
    const w = await world({ scheduleThrows: true });
    expectRefusedClean(await run(w), w, "internal_error");
    expect(w.log).not.toContain("wallClock");
  });
  it("the wall clock throws or gives no non-empty string: the armed timer is cancelled", async () => {
    for (const wall of [
      () => {
        throw new Error("wall");
      },
      () => "",
      () => 42,
    ]) {
      const w = await world({ wall });
      expectRefusedClean(await run(w), w, "internal_error");
      expect(w.timers).toHaveLength(1);
      expect(w.timers[0]?.cancelled).toBe(1);
    }
  });
  it("the timer fired before the first write (the deadline passed after the arm): refusal, nothing written, timer cancelled", async () => {
    const w = await world({
      wall: () => {
        w0.clock.set(DEADLINE);
        w0.timers[0]?.fire();
        return WALL;
      },
    });
    const w0 = w;
    expectRefusedClean(await run(w), w, "internal_error");
    expect(w.log).not.toContain("append:run_started");
  });
  it("the gate and the ticket name different runs: refusal before anything is opened", async () => {
    const w = await world();
    const r = await run(w, { ...w.gate, runId: OTHER_SYNTHETIC_RUN_ID });
    expectRefusedClean(r, w, "internal_error");
    expect(w.log).toEqual([]);
  });
});

describe("what the Runner and the lease receive", () => {
  it("the Runner gets the SAME lease instance, the mask, the address, millisecond limits, and an acceptance check over writer.records()", async () => {
    const w = await world();
    const r = started(await run(w));
    const input = w.captured.input;
    expect(input.lease).toBe(w.approval.lease.port);
    expect(input.lease).toBe(w.lease);
    expect(input.policy).toBe(w.approval.policy.value);
    expect(input.table).toBe(w.approval.policy.table);
    expect(input.mask).toEqual({ paths: [] });
    expect(input.baseAddress).toBe("http://reverse-proxy:8080");
    expect(input.limits).toEqual({ requestTimeoutMs: 10_000, experimentTimeoutMs: 60_000 });
    const identity = { experimentSha256: H64("a"), policyConfigSha256: H64("b"), preparationTableSha256: H64("c") };
    expect(input.isAccepted("exp-1", "rec-000003", identity)).toEqual({ accepted: false, code: "record_missing" });
    const d = await r.run.writer.append("policy_decision", { experimentId: "exp-1", decision: "accept", ruleIds: [], ...identity });
    expect(d.ok && d.value.id).toBe("rec-000003");
    expect(input.isAccepted("exp-1", "rec-000003", identity)).toEqual({ accepted: true });
  });
  it("the lease re-check is one call on the ticket's instance with the deadline and the very signal of the session", async () => {
    const w = await world();
    const r = started(await run(w));
    expect(w.lease.checks).toBe(2); // the start gate's check and this re-check
    expect(w.lease.lastArgs).toHaveLength(1);
    expect(w.lease.lastArgs[0]).toEqual({ deadlineAtMs: r.run.session.deadlineAtMs, signal: r.run.session.signal });
    expect(w.lease.lastArgs[0].signal).toBe(r.run.session.signal);
    expect(r.run.session.deadlineAtMs).toBe(DEADLINE);
  });
});

describe("the two first records", () => {
  it("run_started is exactly {}; isolation_checks holds exactly status and the six checks of the access-denial result", async () => {
    const w = await world();
    started(await run(w));
    const recs = w.store()?.list() ?? [];
    expect(recs.map((x) => x.kind)).toEqual(["run_started", "isolation_checks"]);
    expect(recs[0]?.payload).toEqual({});
    const p = recs[1]?.payload as Any;
    expect(Object.keys(p).sort()).toEqual(["checks", "status"]);
    expect(p.checks).toHaveLength(6);
    for (const c of p.checks) expect(Object.keys(c).sort()).toEqual(["id", "measured", "measuredBy", "status"]);
    expect(p).toEqual(JSON.parse(JSON.stringify({ status: w.gate.accessDenial.status, checks: w.gate.accessDenial.checks })));
  });
  it("no run id, no wall time and nothing of the ticket appears in any record or result", async () => {
    const w = await world();
    const r = started(await run(w));
    const all = JSON.stringify(w.store()?.list());
    for (const leak of [SYNTHETIC_RUN_ID, WALL, AUDIT_CANARY, '"kind":"table"', '"kind":"policy"']) expect(all, leak).not.toContain(leak);
    expect(has(r, AUDIT_CANARY)).toBe(false);
    expect(has(r, SYNTHETIC_RUN_ID)).toBe(false);
  });
});

describe("a failed run_started write is a refusal; a write WAS attempted", () => {
  for (const op of ["writeFileSynced", "rename", "syncDir"] as const) {
    it(`EIO at ${op}: store_failed, started false, timer cancelled, no termination record, no seal`, async () => {
      const w = await world();
      w.arm(op);
      const r = await run(w);
      expect(r).toEqual({ kind: "refused", result: { sealed: false, started: false, failure: "store_failed" } });
      expect(w.timers[0]?.cancelled).toBe(1);
      const store = w.store();
      expect(store?.list()).toEqual([]); // nothing is committed in the store's own state
      expect(w.log).not.toContain("append:isolation_checks");
      expect(w.log).not.toContain("health");
      if (op === "syncDir") {
        // the record file was renamed into place before the directory sync failed: the volume is NOT empty (partial write)
        expect(w.mem.allFiles()).toContain(`${DIR}/records.jsonl`);
      }
      expect(w.mem.allFiles().filter((p) => p.endsWith("manifest.json"))).toEqual([]);
    });
  }
  it("a secret rejection of run_started: secret_rejected, and the store's rejection record exists", async () => {
    const w = await world({ secretPatterns: [{ id: "pat-run", source: "run_started" }] });
    const r = await run(w);
    expect(r).toEqual({ kind: "refused", result: { sealed: false, started: false, failure: "secret_rejected" } });
    expect(w.store()?.list().map((x) => x.kind)).toEqual(["store_rejection"]);
    expect(has(r, "pat-run")).toBe(false);
    expect(w.timers[0]?.cancelled).toBe(1);
  });
  it("the mapping of every writer code", () => {
    const expected: Record<string, string> = {
      writer_down: "store_failed",
      io_failure: "store_failed",
      store_failed: "store_failed",
      secret_rejected: "secret_rejected",
      evidence_rejected: "secret_rejected",
    };
    for (const c of WRITER_ERROR_CODES) {
      const got = mapRunStartedFailure(c);
      expect(got, c).toBe(expected[c] ?? "internal_error");
      expect((UNSEALED_FAILURE_CODES as readonly string[]).includes(got)).toBe(true);
    }
  });
});

describe("after run_started: a start, possibly with proceed false", () => {
  it("a failed isolation_checks write: started, proceed false, error latched, no health; the real Terminator gives an unsealed result", async () => {
    const w = await world();
    w.arm("writeFileSynced", 2);
    const r = started(await run(w));
    expect(r.run.session.started).toBe(true);
    expect(r.run.proceed).toBe(false);
    expect(r.run.session.terminationStatus()).toEqual({ state: "pending", reason: "error" });
    expect(r.run.session.signal.aborted).toBe(true);
    expect(w.healthCalls.n).toBe(0);
    r.run.cancelDeadlineTimer();
    const base: TerminationBase = {
      finalHypothesisRevision: "none",
      provider: { id: "mock", version: "1", model: "none", isMock: true },
      envVarsRead: [],
      payloadAudit: { configCheck: "pass", audits: 0, passed: 0, blocked: 0, auditConfigSha256: H64("4") },
      accessDenial: w.gate.accessDenial,
      configHashes: { policyConfigSha256: H64("1"), preparationTableSha256: H64("2") },
      leaseFacts: { heartbeatIntervalMs: 1000, staleAfterMs: 4000, propagationDelayMs: 123 },
      effectiveConfig: {},
    };
    const build = vi.fn((core: ManifestCore): JsonObject => manifestInput({ terminationReason: core.terminationReason }));
    const result = await createTerminator({ session: r.run.session, channel: r.terminationChannel, wallClock: { nowIso: () => WALL }, manifest: { build }, runId: SYNTHETIC_RUN_ID, base, startedAt: r.run.startedAt }).terminate();
    expect(result).toEqual({ sealed: false, started: true, terminationReason: "error", failure: "store_failed" });
    expect(build).not.toHaveBeenCalled();
  });
  it("health ok: proceed true, nothing latched, the signal not aborted, the timer armed and not cancelled", async () => {
    const w = await world();
    const r = started(await run(w));
    expect(r.run.proceed).toBe(true);
    expect(r.run.startedAt).toBe(WALL);
    expect(r.run.session.terminationStatus()).toEqual({ state: "none" });
    expect(r.run.session.signal.aborted).toBe(false);
    expect(w.timers).toHaveLength(1);
    expect(w.timers[0]?.cancelled).toBe(0);
    r.run.cancelDeadlineTimer();
    r.run.cancelDeadlineTimer();
    expect(w.timers[0]?.cancelled).toBe(1);
  });
  it("health not ok, throwing or rejecting: proceed false, error latched, the signal aborted, and nothing of the health text is recorded", async () => {
    for (const health of [
      () => ({ ok: false, error: HEALTH_CANARY }),
      () => {
        throw new Error(HEALTH_CANARY);
      },
      () => Promise.reject(new Error(HEALTH_CANARY)),
      () => undefined,
    ]) {
      const w = await world({ health });
      const r = started(await run(w));
      expect(r.run.proceed).toBe(false);
      expect(r.run.session.terminationStatus()).toEqual({ state: "pending", reason: "error" });
      expect(r.run.session.signal.aborted).toBe(true);
      expect(w.store()?.list().map((x) => x.kind)).toEqual(["run_started", "isolation_checks"]);
      expect(has(w.store()?.list(), HEALTH_CANARY)).toBe(false);
      expect(has(r, HEALTH_CANARY)).toBe(false);
    }
  });
  it("the deadline passes during health: proceed false with time_limit_reached; a clock fault during health gives error", async () => {
    const late = await world({
      health: (x) => {
        x.clock.set(DEADLINE);
        return { ok: true };
      },
    });
    const r1 = started(await run(late));
    expect(r1.run.proceed).toBe(false);
    expect(r1.run.session.terminationStatus()).toEqual({ state: "pending", reason: "time_limit_reached" });
    const faulty = await world({
      health: (x) => {
        x.clock.set(Number.NaN);
        return { ok: true };
      },
    });
    const r2 = started(await run(faulty));
    expect(r2.run.proceed).toBe(false);
    expect(r2.run.session.terminationStatus()).toEqual({ state: "pending", reason: "error" });
  });
});

describe("the timer fires during the run_started write", () => {
  const waitFor = async (w: World, label: string): Promise<void> => {
    for (let i = 0; i < 200 && !w.log.includes(label); i++) await Promise.resolve();
    expect(w.log).toContain(label);
  };
  it("the write succeeds: a start with proceed false and time_limit_reached; isolation_checks is still written; no health", async () => {
    const w = await world();
    const release = w.hold("writeFileSynced");
    const pending = run(w);
    await waitFor(w, "append:run_started");
    w.clock.set(DEADLINE);
    w.timers[0]?.fire();
    release();
    const r = started(await pending);
    expect(r.run.proceed).toBe(false);
    expect(r.run.session.terminationStatus()).toEqual({ state: "pending", reason: "time_limit_reached" });
    expect(w.store()?.list().map((x) => x.kind)).toEqual(["run_started", "isolation_checks"]);
    expect(w.healthCalls.n).toBe(0);
  });
  it("the write fails: a refusal with the mapping, and the timer cancelled", async () => {
    const w = await world();
    const release = w.hold("writeFileSynced");
    w.arm("rename");
    const pending = run(w);
    await waitFor(w, "append:run_started");
    w.clock.set(DEADLINE);
    w.timers[0]?.fire();
    release();
    const r = await pending;
    expect(r).toEqual({ kind: "refused", result: { sealed: false, started: false, failure: "store_failed" } });
    expect(w.timers[0]?.cancelled).toBe(1);
  });
});

describe("separation of the termination capability", () => {
  it("terminationChannel is a separate field; run has no channel at any depth; the writer has exactly six members; the channel drives the Terminator", async () => {
    const w = await world();
    const r = started(await run(w));
    expect(Object.keys(r).sort()).toEqual(["kind", "run", "terminationChannel"]);
    expect(Object.keys(r.run).sort()).toEqual(["cancelDeadlineTimer", "proceed", "runner", "session", "startedAt", "writer"]);
    const seen = new Set<unknown>();
    const walk = (v: unknown, depth: number): void => {
      if (typeof v !== "object" || v === null || seen.has(v) || depth > 6) return;
      seen.add(v);
      for (const k of Object.keys(v)) {
        expect(k.toLowerCase().includes("channel"), k).toBe(false);
        const child = (v as Record<string, unknown>)[k];
        expect(child === r.terminationChannel, k).toBe(false);
        walk(child, depth + 1);
      }
    };
    walk(r.run, 0);
    expect(Object.keys(r.run.writer).sort()).toEqual(["append", "drain", "putAiOutput", "putBlob", "records", "state"]);
    for (const k of ["seal", "appendTermination", "closeAdmission"]) expect(k in r.run.writer, k).toBe(false);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.run)).toBe(true);
    r.run.session.raise("iteration_limit_reached");
    r.run.cancelDeadlineTimer();
    const result = await createTerminator({
      session: r.run.session,
      channel: r.terminationChannel,
      wallClock: { nowIso: () => WALL },
      manifest: { build: (core) => manifestInput({ terminationReason: core.terminationReason }) },
      runId: SYNTHETIC_RUN_ID,
      base: {} as unknown as TerminationBase,
      startedAt: r.run.startedAt,
    }).terminate();
    expect(result.sealed).toBe(true);
    expect(w.store()?.list().map((x) => x.kind)).toEqual(["run_started", "isolation_checks", "termination"]);
  });
  it("a refusal never terminates and never seals", async () => {
    for (const opts of [{ storeOpen: "fail" }, { recheck: () => ({ valid: false, reason: "revoked" }) }, { scheduleThrows: true }] as const) {
      const w = await world(opts as WorldOpts);
      const r = await run(w);
      expect(r.kind).toBe("refused");
      expect(w.mem.allFiles().filter((p) => p.endsWith("manifest.json"))).toEqual([]);
      expect((w.store()?.list() ?? []).filter((x) => x.kind === "termination")).toEqual([]);
    }
  });
});

// Task 4.4, unit U4 FINAL FIX (R12.14, R24.15): the acceptance check over the writer FAILS CLOSED. If the committed records cannot be read, an
// empty list must never be read as "no decision recorded": the check latches `error` and throws a fixed-text error, which the REAL verifier
// Runner turns into a fatal stop (`runner_internal_error`, `fatal: true`, nothing sent for the Experiment).
describe("the acceptance check fails closed when the records cannot be read", () => {
  const LIST_CANARY = "LIST_CANARY_81";
  const FIXED_MESSAGE = "run records unavailable";
  const identity = { experimentSha256: H64("a"), policyConfigSha256: H64("b"), preparationTableSha256: H64("c") };
  const breakList = (w: World): void => {
    const store = w.store();
    expect(store).toBeDefined();
    vi.spyOn(store as RunRecordStore, "list").mockImplementation(() => {
      throw new Error(LIST_CANARY);
    });
  };

  it("control: with readable records the check answers record_missing, then accepted; nothing is latched", async () => {
    const w = await world();
    const r = started(await run(w));
    const input = w.captured.input;
    expect(input.isAccepted("exp-1", "rec-000003", identity)).toEqual({ accepted: false, code: "record_missing" });
    const d = await r.run.writer.append("policy_decision", { experimentId: "exp-1", decision: "accept", ruleIds: [], ...identity });
    expect(d.ok && d.value.id).toBe("rec-000003");
    expect(input.isAccepted("exp-1", "rec-000003", identity)).toEqual({ accepted: true });
    expect(r.run.session.terminationStatus()).toEqual({ state: "none" });
    expect(r.run.session.signal.aborted).toBe(false);
    expect(r.run.writer.state().down).toBe(false);
  });

  it("an unreadable store: the check throws the fixed message only, error is latched, the signal is aborted, the writer is down with store_failed", async () => {
    const w = await world();
    const r = started(await run(w));
    breakList(w);
    let thrown: unknown;
    try {
      w.captured.input.isAccepted("exp-1", "rec-000003", identity);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(FIXED_MESSAGE);
    expect((thrown as Error).message).not.toContain(LIST_CANARY);
    expect(has(String(thrown), LIST_CANARY)).toBe(false);
    expect(r.run.session.terminationStatus()).toEqual({ state: "pending", reason: "error" });
    expect(r.run.session.signal.aborted).toBe(true);
    expect(r.run.session.signal.reason).toBe("error");
    expect(r.run.writer.state()).toMatchObject({ down: true, failure: "store_failed" });
    expect(has(r.run.writer.state(), LIST_CANARY)).toBe(false);
    // a later call fails the same way (the writer is down, the store is still unreadable): never an answer
    expect(() => w.captured.input.isAccepted("exp-1", "rec-000003", identity)).toThrow(FIXED_MESSAGE);
  });

  // The REAL verifier Runner (`createRunner`), built from the very input that `startRun` passes to the Runner factory (its `isAccepted` is the
  // adapter under test). Everything else comes from the verifier's own fixtures (`makeParts`), because this input carries opaque fakes for it:
  // the HTTP port (counts every send), the lease (always valid), the loaded policy configuration, the loaded preparation table (a data file of
  // the verifier package), the mask, the limits, the address (`http://127.0.0.1:8056`, which the default address policy allows) and the clock.
  // No network is touched.
  const realRunnerWorld = async (): Promise<{ w: World; held: { parts?: Parts } }> => {
    const held: { parts?: Parts } = {};
    const w = await world({
      build: (input) => {
        held.parts = makeParts({ isAccepted: input.isAccepted });
        // the Legacy_App answer of the start-state measurement (task 4.6 W6); the verifier fake answers 404 for it otherwise
        held.parts.http.on((r) => r.method === "GET" && r.path === "/products", { status: 200, body: JSON.stringify({ success: true, data: [] }) });
        return createRunner(held.parts.deps);
      },
    });
    return { w, held };
  };

  it("REAL Runner, control: health passes through the fake HTTP; an Experiment without a decision record is policy_not_accepted (not fatal) and sends nothing", async () => {
    const { w, held } = await realRunnerWorld();
    const r = started(await run(w));
    const parts = held.parts as Parts;
    expect(r.run.proceed).toBe(true);
    expect(parts.http.seen).toEqual(["GET /health", "POST /reset", "GET /products"]);
    const out = await r.run.runner.execute(experiment(), "rec-000003", r.run.session.signal);
    expect(out).toMatchObject({ status: "not_executed", reason: "policy_not_accepted", detail: "not_accepted:record_missing" });
    expect("fatal" in out).toBe(false);
    expect(parts.http.seen).toEqual(["GET /health", "POST /reset", "GET /products"]);
    expect(r.run.session.terminationStatus()).toEqual({ state: "none" });
  });

  it("REAL Runner: unreadable records give not_executed / runner_internal_error / fatal with zero sends; the next execute is interrupted; error is latched", async () => {
    const { w, held } = await realRunnerWorld();
    const r = started(await run(w));
    const parts = held.parts as Parts;
    expect(r.run.proceed).toBe(true);
    expect(parts.http.seen).toEqual(["GET /health", "POST /reset", "GET /products"]);
    breakList(w);
    const first = await r.run.runner.execute(experiment(), "rec-000003", r.run.session.signal);
    expect(first).toMatchObject({ status: "not_executed", reason: "runner_internal_error", fatal: true });
    expect(parts.http.seen).toEqual(["GET /health", "POST /reset", "GET /products"]); // nothing was sent for the Experiment
    expect(has(first, LIST_CANARY)).toBe(false);
    const second = await r.run.runner.execute(experiment({ experimentId: "exp-2" }), "rec-000004", r.run.session.signal);
    expect(second).toMatchObject({ status: "interrupted", cause: "fatal_error", phase: "not_started", sentRequests: 0, fatal: true });
    expect(parts.http.seen).toEqual(["GET /health", "POST /reset", "GET /products"]); // still nothing
    expect(r.run.session.terminationStatus()).toEqual({ state: "pending", reason: "error" });
    expect(r.run.session.signal.aborted).toBe(true);
    expect(r.run.writer.state()).toMatchObject({ down: true, failure: "store_failed" });
  });
});
