// Task 4.4, stage 2: the start gate with the REAL access-denial verification (task 4.2 fakes) and REAL startup tickets (stage B).
// Every refusal has a passing control. Only `loopDeps.isolation` is usable; any other key that the gate reads is recorded and fails the test.
// Synthetic data only. Nothing starts a process, a container or a network.
// **Validates: Requirements 2.14, 2.15, 2.16, 15.14, 15.15, 15.16, 24.15**
import { describe, expect, it } from "vitest";
import { composeAllowedEnvNames, isAccessDenialResult } from "../src/isolation/index.js";
import { startGate } from "../src/orchestrator/startGate.js";
import { LEASE_REASONS } from "../src/orchestrator/types.js";
import {
  AUDIT_CANARY,
  CREDENTIAL_NAME,
  ERROR_CANARY,
  FakeLease,
  LeaseCheckInterrupted,
  OTHER_SYNTHETIC_RUN_ID,
  SYNTHETIC_RUN_ID,
  callsTotal,
  failingIsolation,
  fsSnapshot,
  issueStartup,
  lookAlikes,
  passingIsolation,
  strictLoopDeps,
  type Any,
} from "./support/orchestratorFakes.js";

const stateOf = (r: Any): string => JSON.stringify(r);

describe("a normal start", () => {
  it("passes all steps and returns the branded result and the run id; the lease instance of the ticket is checked exactly once", async () => {
    const { approval, lease } = await issueStartup();
    const iso = passingIsolation();
    const w = strictLoopDeps(iso.deps);
    const r = await startGate(w.deps, approval);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.runId).toBe(SYNTHETIC_RUN_ID);
    expect(isAccessDenialResult(r.value.accessDenial)).toBe(true);
    expect(r.value.accessDenial.status).toBe("verified");
    expect(Object.isFrozen(r.value.accessDenial)).toBe(true);
    expect(r.value.allowedEnvNames).toEqual(composeAllowedEnvNames(["EXAMPLE_ONE", "EXAMPLE_TWO"]));
    expect(Object.keys(r.value).sort()).toEqual(["accessDenial", "allowedEnvNames", "runId"]);
    expect(lease.checks).toBe(1);
    expect(lease.lastArgs).toEqual([]);
    expect(callsTotal(iso.calls)).toBeGreaterThan(0); // the verification ran
    expect(w.touched).toEqual([]);
  });

  it("the result holds no ticket, no lease port and no audit configuration", async () => {
    const { approval } = await issueStartup();
    const r = await startGate(strictLoopDeps(passingIsolation().deps).deps, approval);
    expect(r.ok).toBe(true);
    const text = stateOf(r);
    expect(text).not.toContain(AUDIT_CANARY);
    expect(text).not.toContain("auditConfig");
    expect(text).not.toContain("payloadAuditConfig");
    expect(text).not.toContain("heartbeatIntervalMs");
    if (r.ok) {
      expect(Object.values(r.value)).not.toContain(approval);
      expect(Object.values(r.value)).not.toContain(approval.lease);
      expect(Object.values(r.value)).not.toContain(approval.lease.port);
    }
  });

  it("a lease whose check answers synchronously is accepted", async () => {
    const { approval, lease } = await issueStartup({ behave: () => ({ valid: true }) });
    expect((await startGate(strictLoopDeps(passingIsolation().deps).deps, approval)).ok).toBe(true);
    expect(lease.checks).toBe(1);
  });

  it("a lease whose check answers with a promise is accepted", async () => {
    const { approval, lease } = await issueStartup({ behave: () => Promise.resolve({ valid: true }) });
    expect((await startGate(strictLoopDeps(passingIsolation().deps).deps, approval)).ok).toBe(true);
    expect(lease.checks).toBe(1);
  });
});

describe("an invalid ticket", () => {
  it("is refused as startup_invalid for every non-ticket, with no port called, and the real ticket is not consumed by them", async () => {
    const { approval, lease } = await issueStartup();
    const iso = passingIsolation();
    for (const [name, value] of Object.entries(lookAlikes(approval))) {
      const w = strictLoopDeps(iso.deps);
      const before = await fsSnapshot(w.mem);
      expect(await startGate(w.deps, value as Any), name).toEqual({ ok: false, error: { code: "startup_invalid" } });
      expect(callsTotal(iso.calls), name).toBe(0);
      expect(w.touched, name).toEqual([]);
      expect(await fsSnapshot(w.mem), name).toBe(before);
    }
    expect(lease.checks).toBe(0);
    // control: the real ticket still starts
    expect((await startGate(strictLoopDeps(iso.deps).deps, approval)).ok).toBe(true);
  });
});

describe("single use", () => {
  it("the same ticket twice in sequence: the second is startup_already_consumed and calls nothing", async () => {
    const { approval, lease } = await issueStartup();
    expect((await startGate(strictLoopDeps(passingIsolation().deps).deps, approval)).ok).toBe(true);
    const second = passingIsolation();
    const w = strictLoopDeps(second.deps);
    expect(await startGate(w.deps, approval)).toEqual({ ok: false, error: { code: "startup_already_consumed" } });
    expect(callsTotal(second.calls)).toBe(0);
    expect(w.touched).toEqual([]);
    expect(lease.checks).toBe(1);
  });

  it("the same ticket twice in the same tick (no await between the calls): exactly one passes", async () => {
    const { approval, lease } = await issueStartup();
    const a = passingIsolation();
    const b = passingIsolation();
    const p1 = startGate(strictLoopDeps(a.deps).deps, approval);
    const p2 = startGate(strictLoopDeps(b.deps).deps, approval);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2).toEqual({ ok: false, error: { code: "startup_already_consumed" } });
    expect(callsTotal(b.calls)).toBe(0);
    expect(lease.checks).toBe(1);
  });

  it("a real ticket that was refused at a later step is consumed and cannot be reused", async () => {
    const { approval, lease } = await issueStartup();
    const r1 = await startGate(strictLoopDeps(failingIsolation().deps).deps, approval);
    expect(r1).toEqual({ ok: false, error: { code: "start_gate_closed" } });
    const good = passingIsolation();
    expect(await startGate(strictLoopDeps(good.deps).deps, approval)).toEqual({ ok: false, error: { code: "startup_already_consumed" } });
    expect(callsTotal(good.calls)).toBe(0);
    expect(lease.checks).toBe(0);
  });
});

describe("access denial", () => {
  for (const provider of ["mock", "kiro-cli"] as const) {
    it(`a failed verification closes the gate (provider ${provider}: the same path, the verification always runs)`, async () => {
      const { approval, lease } = await issueStartup({ provider, envNames: ["EXAMPLE_ONE"] });
      const iso = failingIsolation();
      const w = strictLoopDeps(iso.deps);
      const before = await fsSnapshot(w.mem);
      const r = await startGate(w.deps, approval);
      expect(r).toEqual({ ok: false, error: { code: "start_gate_closed" } });
      expect(callsTotal(iso.calls)).toBeGreaterThan(0); // it ran
      expect(iso.calls["proc.ids"]).toBe(1);
      expect(lease.checks).toBe(0);
      expect(w.touched).toEqual([]);
      expect(await fsSnapshot(w.mem)).toBe(before);
    });
  }

  it("a passing verification passes for both providers (control)", async () => {
    for (const provider of ["mock", "kiro-cli"] as const) {
      const { approval } = await issueStartup({ provider, envNames: ["EXAMPLE_ONE"] });
      const iso = passingIsolation();
      expect((await startGate(strictLoopDeps(iso.deps).deps, approval)).ok, provider).toBe(true);
      expect(callsTotal(iso.calls), provider).toBeGreaterThan(0);
    }
  });

  it("a credential name in the runtime environment fails the check (the credential is never allowed), and without it the check passes", async () => {
    const { approval } = await issueStartup({ provider: "kiro-cli", envNames: ["EXAMPLE_ONE", CREDENTIAL_NAME] });
    const withCredential = passingIsolation(SYNTHETIC_RUN_ID, { envNames: () => ["HOME", "PHOENIX_RUN_ID", CREDENTIAL_NAME] });
    expect(await startGate(strictLoopDeps(withCredential.deps).deps, approval)).toEqual({ ok: false, error: { code: "start_gate_closed" } });
    const second = await issueStartup({ provider: "kiro-cli", envNames: ["EXAMPLE_ONE", CREDENTIAL_NAME] });
    const without = passingIsolation(SYNTHETIC_RUN_ID, { envNames: () => ["HOME", "PHOENIX_RUN_ID", "EXAMPLE_ONE"] });
    expect((await startGate(strictLoopDeps(without.deps).deps, second.approval)).ok).toBe(true);
  });

  it("a port of the isolation key that cannot be read is isolation_port_failed, and the ticket is consumed", async () => {
    const { approval } = await issueStartup();
    const broken = new Proxy({}, { get: () => { throw new Error(ERROR_CANARY); } });
    const r = await startGate(broken as Any, approval);
    expect(r).toEqual({ ok: false, error: { code: "isolation_port_failed" } });
    expect(stateOf(r)).not.toContain("CANARY");
    expect(await startGate(strictLoopDeps(passingIsolation().deps).deps, approval)).toEqual({ ok: false, error: { code: "startup_already_consumed" } });
    // a null loopDeps is the same refusal, never a throw
    const other = await issueStartup();
    expect(await startGate(null as Any, other.approval)).toEqual({ ok: false, error: { code: "isolation_port_failed" } });
  });
});

describe("run id", () => {
  it("a verification that is verified for another run id than the ticket's is run_id_mismatch (control: the same id passes)", async () => {
    const { approval, lease } = await issueStartup({ runId: SYNTHETIC_RUN_ID });
    const foreign = passingIsolation(OTHER_SYNTHETIC_RUN_ID); // verified for ITS run id: the attestation names the same run
    const w = strictLoopDeps(foreign.deps);
    const r = await startGate(w.deps, approval);
    expect(r).toEqual({ ok: false, error: { code: "run_id_mismatch" } });
    expect(stateOf(r)).not.toContain(SYNTHETIC_RUN_ID);
    expect(stateOf(r)).not.toContain(OTHER_SYNTHETIC_RUN_ID);
    expect(callsTotal(foreign.calls)).toBeGreaterThan(0);
    expect(lease.checks).toBe(0);
    expect(w.touched).toEqual([]);
    const control = await issueStartup({ runId: OTHER_SYNTHETIC_RUN_ID });
    expect((await startGate(strictLoopDeps(passingIsolation(OTHER_SYNTHETIC_RUN_ID).deps).deps, control.approval)).ok).toBe(true);
  });
});

describe("lease", () => {
  for (const reason of LEASE_REASONS) {
    it(`invalid (${reason}) after the proof: lease_invalid with the reason name and the hint`, async () => {
      const { approval, lease } = await issueStartup({ behave: () => ({ valid: false, reason, cause: "x", detail: ERROR_CANARY }) });
      const r = await startGate(strictLoopDeps(passingIsolation().deps).deps, approval);
      expect(r).toEqual({
        ok: false,
        error: { code: "lease_invalid", leaseReason: reason, terminationReasonHint: reason === "heartbeat_stale" ? "launcher_killed" : "lease_unavailable" },
      });
      expect(stateOf(r)).not.toContain("CANARY");
      expect(lease.checks).toBe(1);
    });
  }

  it("an unknown reason gives lease_invalid without a name, and the hint lease_unavailable", async () => {
    const { approval } = await issueStartup({ behave: () => ({ valid: false, reason: ERROR_CANARY }) });
    const r = await startGate(strictLoopDeps(passingIsolation().deps).deps, approval);
    expect(r).toEqual({ ok: false, error: { code: "lease_invalid", terminationReasonHint: "lease_unavailable" } });
    expect(stateOf(r)).not.toContain("CANARY");
  });

  const failures: readonly (readonly [string, () => unknown])[] = [
    ["throws", () => { throw new Error(ERROR_CANARY); }],
    ["rejects", () => Promise.reject(new Error(ERROR_CANARY))],
    ["LeaseCheckInterrupted-like", () => { throw new LeaseCheckInterrupted(); }],
    ["rejects with LeaseCheckInterrupted-like", () => Promise.reject(new LeaseCheckInterrupted())],
    ["undefined", () => undefined],
    ["null", () => null],
    ["a string", () => "valid"],
    ["an empty object", () => ({})],
    ["valid is not a boolean", () => ({ valid: "yes" })],
    ["valid is 1", () => ({ valid: 1 })],
    ["a getter that throws", () => ({ get valid(): never { throw new Error(ERROR_CANARY); } })],
  ];
  for (const [name, behave] of failures) {
    it(`check ${name}: lease_check_failed, no message, check called once`, async () => {
      const { approval, lease } = await issueStartup({ behave });
      const r = await startGate(strictLoopDeps(passingIsolation().deps).deps, approval);
      expect(r).toEqual({ ok: false, error: { code: "lease_check_failed" } });
      expect(stateOf(r)).not.toContain("CANARY");
      expect(lease.checks).toBe(1);
    });
  }

  it("a lease port without a check function is lease_check_failed", async () => {
    for (const leaseInstance of [{}, { check: "no" }, 5]) {
      const { approval } = await issueStartup({ leaseInstance });
      expect(await startGate(strictLoopDeps(passingIsolation().deps).deps, approval), String(leaseInstance)).toEqual({ ok: false, error: { code: "lease_check_failed" } });
    }
  });

  it("the gate uses the instance of the ticket as it is: `check` is called on that very object, once, with no argument", async () => {
    const seen: unknown[] = [];
    const instance = {
      count: 0,
      check(this: unknown, ...args: unknown[]) {
        seen.push(this, args.length);
        (this as { count: number }).count++;
        return { valid: true };
      },
    };
    const { approval } = await issueStartup({ leaseInstance: instance });
    expect(approval.lease.port).toBe(instance);
    expect((await startGate(strictLoopDeps(passingIsolation().deps).deps, approval)).ok).toBe(true);
    expect(seen).toEqual([instance, 0]);
    expect(instance.count).toBe(1);
    expect(approval.lease.port).toBe(instance);
  });
});

describe("zero side effects and no leak on every refusal", () => {
  interface Scenario {
    readonly name: string;
    readonly code: string;
    readonly run: () => Promise<{ result: Any; world: ReturnType<typeof strictLoopDeps>; lease: FakeLease }>;
  }
  const scenario = (name: string, code: string, opts: Parameters<typeof issueStartup>[0], iso: () => ReturnType<typeof passingIsolation>, wrap: (a: Any) => Any = (a) => a): Scenario => ({
    name,
    code,
    run: async () => {
      const { approval, lease } = await issueStartup(opts);
      const world = strictLoopDeps(iso().deps);
      return { result: await startGate(world.deps, wrap(approval)), world, lease };
    },
  });
  const SCENARIOS: readonly Scenario[] = [
    scenario("invalid ticket", "startup_invalid", {}, () => passingIsolation(), (a) => ({ ...a })),
    scenario("failed verification", "start_gate_closed", {}, () => failingIsolation()),
    scenario("foreign run id", "run_id_mismatch", {}, () => passingIsolation(OTHER_SYNTHETIC_RUN_ID)),
    scenario("lease invalid", "lease_invalid", { behave: () => ({ valid: false, reason: "revoked" }) }, () => passingIsolation()),
    scenario("lease check throws", "lease_check_failed", { behave: () => { throw new Error(ERROR_CANARY); } }, () => passingIsolation()),
    scenario("lease check wrong shape", "lease_check_failed", { behave: () => ({ valid: "x" }) }, () => passingIsolation()),
  ];
  for (const s of SCENARIOS) {
    it(`${s.name}: ${s.code}, nothing but isolation touched, the file system unchanged, no canary`, async () => {
      const probe = strictLoopDeps(passingIsolation().deps);
      const before = await fsSnapshot(probe.mem);
      const { result, world } = await s.run();
      expect(result.ok).toBe(false);
      expect(result.error.code).toBe(s.code);
      expect(world.touched).toEqual([]);
      expect(await fsSnapshot(world.mem)).toBe(before);
      const text = stateOf(result);
      expect(text).not.toContain("CANARY");
      expect(text).not.toContain(AUDIT_CANARY);
      expect(text).not.toContain(SYNTHETIC_RUN_ID);
      expect(text).not.toContain(OTHER_SYNTHETIC_RUN_ID);
      expect(Object.keys(result.error).every((k) => ["code", "leaseReason", "terminationReasonHint"].includes(k))).toBe(true);
    });
  }

  it("control (success): nothing but isolation touched and the file system unchanged", async () => {
    const { approval } = await issueStartup();
    const world = strictLoopDeps(passingIsolation().deps);
    const before = await fsSnapshot(world.mem);
    expect((await startGate(world.deps, approval)).ok).toBe(true);
    expect(world.touched).toEqual([]);
    expect(await fsSnapshot(world.mem)).toBe(before);
  });

  it("positive control: the strict world records a read of another port and a write to the file system", async () => {
    const world = strictLoopDeps(passingIsolation().deps);
    const deps = world.deps as Any;
    void deps.provider;
    void deps.clock;
    await deps.fs.writeFileSynced("/run/out/new.bin", new Uint8Array([9]));
    expect(world.touched).toEqual(["provider", "clock", "fs"]);
    expect(await fsSnapshot(world.mem)).not.toBe(await fsSnapshot(strictLoopDeps(passingIsolation().deps).mem));
  });
});
