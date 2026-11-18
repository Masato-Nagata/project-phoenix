// Task 4.4, stage 2: the exact ORDER of the start gate, and the brand check of the access-denial result.
// Three modules are wrapped with pass-through spies that write to one shared log (consume, the isolation verification, mayStartRun); the lease check
// writes to the same log. A test can replace the verification's answer to present a plain object, a copy, or a result of another run.
// Synthetic data only. Nothing starts a process or a network.
// **Validates: Requirements 2.14, 2.15, 2.16, 15.14, 15.15, 15.16, 24.15**
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  log: [] as string[],
  expected: [] as unknown[],
  override: undefined as undefined | ((deps: unknown, expected: unknown) => unknown),
  /** While true, the wrapper is a silent pass-through (the test itself asks for a real result). */
  quiet: false,
}));

vi.mock("../src/isolation/index.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/isolation/index.js")>();
  return {
    ...orig,
    verifyGroundTruthAccessDenial: async (deps: never, expected: never): Promise<unknown> => {
      if (h.quiet) return orig.verifyGroundTruthAccessDenial(deps, expected);
      h.log.push("verify");
      h.expected.push(expected);
      return h.override === undefined ? orig.verifyGroundTruthAccessDenial(deps, expected) : h.override(deps, expected);
    },
  };
});
vi.mock("../src/orchestrator/consume.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/orchestrator/consume.js")>();
  return {
    ...orig,
    consumeStartup: (x: unknown) => {
      const r = orig.consumeStartup(x);
      h.log.push(`consume:${r}`);
      return r;
    },
  };
});
vi.mock("../src/gate/mayStartRun.js", async (importOriginal) => {
  const orig = await importOriginal<typeof import("../src/gate/mayStartRun.js")>();
  return {
    ...orig,
    mayStartRun: (a: "pass" | "blocked", b: "verified" | "failed") => {
      const r = orig.mayStartRun(a, b);
      h.log.push(`mayStartRun:${a}:${b}:${r}`);
      return r;
    },
  };
});

import { composeAllowedEnvNames, isAccessDenialResult, verifyGroundTruthAccessDenial } from "../src/isolation/index.js";
import { startGate } from "../src/orchestrator/startGate.js";
import type { IsolationDeps } from "../src/isolation/types.js";
import {
  CREDENTIAL_NAME,
  ERROR_CANARY,
  OTHER_SYNTHETIC_RUN_ID,
  SYNTHETIC_RUN_ID,
  failingIsolation,
  issueStartup,
  lookAlikes,
  passingIsolation,
  strictLoopDeps,
  type Any,
} from "./support/orchestratorFakes.js";

/** A REAL branded result, produced without a log entry and without the override. */
const realVerify = async (deps: IsolationDeps): Promise<Any> => {
  h.quiet = true;
  try {
    return await verifyGroundTruthAccessDenial(deps, { allowedEnvNames: composeAllowedEnvNames([]) });
  } finally {
    h.quiet = false;
  }
};
const REAL_VERIFY = (runId: string): Promise<Any> => realVerify(passingIsolation(runId).deps);

beforeEach(() => {
  h.log.length = 0;
  h.expected.length = 0;
  h.override = undefined;
  h.quiet = false;
});

describe("the order of the gate", () => {
  for (const provider of ["mock", "kiro-cli"] as const) {
    it(`a normal start (${provider}) is: consume, verify, mayStartRun (pass, verified), lease check; each exactly once, the same path for both providers`, async () => {
      const { approval } = await issueStartup({ provider, envNames: ["EXAMPLE_ONE"], behave: () => { h.log.push("lease.check"); return { valid: true }; } });
      const r = await startGate(strictLoopDeps(passingIsolation().deps).deps, approval);
      expect(r.ok).toBe(true);
      // the real verification inside `verify` makes no log entry of its own, so the sequence below is complete
      expect(h.log).toEqual(["consume:ok", "verify", "mayStartRun:pass:verified:true", "lease.check"]);
    });
  }

  it("an invalid ticket stops after the consume step: nothing else is called", async () => {
    const { approval } = await issueStartup();
    for (const value of Object.values(lookAlikes(approval))) {
      h.log.length = 0;
      expect((await startGate(strictLoopDeps(passingIsolation().deps).deps, value as Any)).ok).toBe(false);
      expect(h.log).toEqual(["consume:not_a_startup"]);
    }
  });

  it("a consumed ticket stops after the consume step", async () => {
    const { approval } = await issueStartup();
    await startGate(strictLoopDeps(passingIsolation().deps).deps, approval);
    h.log.length = 0;
    expect((await startGate(strictLoopDeps(passingIsolation().deps).deps, approval)).ok).toBe(false);
    expect(h.log).toEqual(["consume:already_consumed"]);
  });

  it("the consume step runs before the first await: two calls in one tick log consume, verify (of the first), consume (of the second)", async () => {
    const { approval } = await issueStartup();
    const p1 = startGate(strictLoopDeps(passingIsolation().deps).deps, approval);
    const p2 = startGate(strictLoopDeps(passingIsolation().deps).deps, approval);
    // nothing has been awaited yet: both calls ran synchronously up to their first await
    expect(h.log).toEqual(["consume:ok", "verify", "consume:already_consumed"]);
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(true);
    expect(r2).toEqual({ ok: false, error: { code: "startup_already_consumed" } });
  });

  it("a failed verification calls mayStartRun with (pass, failed), gets false, and never reaches the lease", async () => {
    const { approval, lease } = await issueStartup();
    // a REAL branded result of the same run with the status failed (a root user)
    const failed = await realVerify(failingIsolation().deps);
    expect(failed.status).toBe("failed");
    expect(failed.runId).toBe(SYNTHETIC_RUN_ID);
    h.override = async () => failed;
    h.log.length = 0;
    const r = await startGate(strictLoopDeps(passingIsolation().deps).deps, approval);
    expect(r).toEqual({ ok: false, error: { code: "start_gate_closed" } });
    expect(h.log).toContain("mayStartRun:pass:failed:false");
    expect(lease.checks).toBe(0);
  });
});

describe("what the verification receives", () => {
  it("is exactly { allowedEnvNames } with the config names minus the credentials, composed with the module constants", async () => {
    const { approval } = await issueStartup({ provider: "kiro-cli", envNames: ["EXAMPLE_ONE", CREDENTIAL_NAME] });
    await startGate(strictLoopDeps(passingIsolation().deps).deps, approval);
    expect(h.expected).toHaveLength(1);
    const expected = h.expected[0] as { allowedEnvNames: string[] };
    expect(Object.keys(expected)).toEqual(["allowedEnvNames"]);
    expect(expected.allowedEnvNames).toEqual(composeAllowedEnvNames(["EXAMPLE_ONE"]));
    expect(expected.allowedEnvNames).not.toContain(CREDENTIAL_NAME);
  });
});

describe("the brand of the access-denial result", () => {
  it("a result that the verification really issued passes the brand (control)", async () => {
    const real = await REAL_VERIFY(SYNTHETIC_RUN_ID);
    expect(isAccessDenialResult(real)).toBe(true);
    const { approval } = await issueStartup();
    h.override = async () => real;
    expect((await startGate(strictLoopDeps(passingIsolation().deps).deps, approval)).ok).toBe(true);
  });

  it("a plain object, a copy, a JSON round trip, a frozen clone and a non-object are access_denial_not_issued, with no mayStartRun and no lease check", async () => {
    const real = await REAL_VERIFY(SYNTHETIC_RUN_ID);
    const fakes: [string, unknown][] = [
      ["plain object", { status: "verified", runId: SYNTHETIC_RUN_ID, checks: [] }],
      ["copy", { ...real }],
      ["json round trip", JSON.parse(JSON.stringify(real))],
      ["frozen clone", Object.freeze({ ...real, checks: [...real.checks] })],
      ["prototype child", Object.create(real)],
      ["undefined", undefined],
      ["null", null],
      ["string", "verified"],
    ];
    for (const [name, value] of fakes) {
      const { approval, lease } = await issueStartup();
      h.override = async () => value;
      h.log.length = 0;
      const r = await startGate(strictLoopDeps(passingIsolation().deps).deps, approval);
      expect(r, name).toEqual({ ok: false, error: { code: "access_denial_not_issued" } });
      expect(h.log, name).toEqual(["consume:ok", "verify"]);
      expect(lease.checks, name).toBe(0);
    }
  });

  it("a branded result of ANOTHER run is run_id_mismatch, before mayStartRun is called", async () => {
    const other = await REAL_VERIFY(OTHER_SYNTHETIC_RUN_ID);
    expect(other.status).toBe("verified");
    const { approval, lease } = await issueStartup({ runId: SYNTHETIC_RUN_ID });
    h.override = async () => other;
    h.log.length = 0;
    const r = await startGate(strictLoopDeps(passingIsolation().deps).deps, approval);
    expect(r).toEqual({ ok: false, error: { code: "run_id_mismatch" } });
    expect(h.log).toEqual(["consume:ok", "verify"]);
    expect(lease.checks).toBe(0);
  });

  it("a verification that throws or rejects is isolation_port_failed with no message", async () => {
    for (const make of [
      () => { throw new Error(ERROR_CANARY); },
      () => Promise.reject(new Error(ERROR_CANARY)),
    ] as (() => unknown)[]) {
      const { approval, lease } = await issueStartup();
      h.override = make;
      h.log.length = 0;
      const r = await startGate(strictLoopDeps(passingIsolation().deps).deps, approval);
      expect(r).toEqual({ ok: false, error: { code: "isolation_port_failed" } });
      expect(JSON.stringify(r)).not.toContain("CANARY");
      expect(h.log).toEqual(["consume:ok", "verify"]);
      expect(lease.checks).toBe(0);
    }
  });
});
