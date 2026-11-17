// Task 4.2 review fixes A and B: late or never-settling scratch preparation and root-file-system creation, with fake ports and vi fake timers.
// Every wait of the module is finite: PORT_TIMEOUT_MS per port call, plus SETTLE_GRACE_MS for a pending call that timed out.
// These tests prove the logic of verify.ts only. They prove NOTHING about a real container (UNVERIFIED until tasks 4.9, 4.11 and 4.14).
// Source change guarded by each test group is named in its describe title. No evaluation/ access; synthetic data only.
// **Validates: Requirements 15.2, 15.3, 15.11, 15.13**
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AccessDenialResult, CheckId, IsolationCheck, IsolationDeps, ProbeOutcome, ScratchPaths } from "../src/isolation/types.js";
import { PORT_TIMEOUT_MS, SETTLE_GRACE_MS, verifyGroundTruthAccessDenial } from "../src/isolation/verify.js";
import { ALLOWED, E, OK, SCRATCH, defaultFsOutcome, makeDeps } from "./support/isolationFakes.js";

const EXPECTED = { allowedEnvNames: ALLOWED };
const chk = (r: AccessDenialResult, id: CheckId): IsolationCheck => r.checks.find((c) => c.id === id) as IsolationCheck;
const meas = (r: AccessDenialResult, id: CheckId): Record<string, unknown> => chk(r, id).measured as Record<string, unknown>;
const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const after = <T>(ms: number, v: () => T): Promise<T> => new Promise<T>((resolve) => setTimeout(() => resolve(v()), ms));

type ScratchPort = IsolationDeps["scratch"];
type RootfsPort = IsolationDeps["rootfs"];
function withPorts(over: { scratch?: Partial<ScratchPort>; rootfs?: Partial<RootfsPort>; fsSeen?: string[] }): IsolationDeps {
  const { deps } = makeDeps();
  const fs = over.fsSeen
    ? {
        stat: async (p: string) => (over.fsSeen?.push(p), defaultFsOutcome("stat", p)),
        list: async (p: string) => (over.fsSeen?.push(p), defaultFsOutcome("list", p)),
        read: async (p: string) => (over.fsSeen?.push(p), defaultFsOutcome("read", p)),
      }
    : deps.fs;
  return { ...deps, fs, scratch: { ...deps.scratch, ...over.scratch }, rootfs: { ...deps.rootfs, ...over.rootfs } };
}

/** Starts the verification under fake timers and advances fake time by `ms` (generous: timers are processed as they appear). */
async function runFake(deps: IsolationDeps, ms: number): Promise<AccessDenialResult> {
  vi.useFakeTimers();
  const p = verifyGroundTruthAccessDenial(deps, EXPECTED);
  await vi.advanceTimersByTimeAsync(ms);
  return p;
}
const ALL_WAITS = 3 * (PORT_TIMEOUT_MS + SETTLE_GRACE_MS);

afterEach(() => vi.useRealTimers());

describe("SETTLE_GRACE_MS", () => {
  it("is 3000 and below the port timeout", () => {
    expect(SETTLE_GRACE_MS).toBe(3000);
    expect(SETTLE_GRACE_MS).toBeLessThan(PORT_TIMEOUT_MS);
  });
});

// Guards: verify.ts waits for the pending prepare (settle(..., SETTLE_GRACE_MS)) before it calls cleanup. Removing that wait makes the
// order assertion below fail (cleanup would run before prepare-end).
describe("scratch prepare that times out (verify.ts settle wait)", () => {
  it("a prepare that completes late within the grace is awaited, then cleanup runs once: order prepare-end, cleanup; no residue; value ignored", async () => {
    const events: string[] = [];
    const fsSeen: string[] = [];
    let cleanups = 0;
    const deps = withPorts({
      fsSeen,
      scratch: {
        prepare: () => after<ScratchPaths>(PORT_TIMEOUT_MS + 1000, () => (events.push("prepare-end"), SCRATCH)),
        cleanup: async () => (cleanups++, events.push("cleanup"), OK),
      },
    });
    const r = await runFake(deps, ALL_WAITS);
    expect(events).toEqual(["prepare-end", "cleanup"]);
    expect(cleanups).toBe(1);
    const m = meas(r, "read_denial");
    expect(chk(r, "read_denial").status).toBe("failed");
    expect(m["reasons"]).toEqual(["timeout", "control_failed"]);
    expect(m["cleanup"]).toBe("ok"); // removal confirmed: the late prepare settled before cleanup
    expect(m["scratchSettled"]).toBe(true);
    expect(m["residuePossible"]).toBeUndefined();
    expect(m["controls"]).toEqual({ readable: false, denied: false, absent: false }); // the late value was never used
    expect(fsSeen.filter((p) => p.startsWith("/tmp/fake"))).toEqual([]);
    expect(r.status).toBe("failed");
  });

  it("a prepare that never settles: resolves after PORT_TIMEOUT_MS + SETTLE_GRACE_MS of fake time, cleanup called once, timeout + cleanup_failed, never verified", async () => {
    let cleanups = 0;
    const deps = withPorts({ scratch: { prepare: () => never<ScratchPaths>(), cleanup: async () => (cleanups++, OK) } });
    vi.useFakeTimers();
    let finished = false;
    const p = verifyGroundTruthAccessDenial(deps, EXPECTED).then((r) => ((finished = true), r));
    await vi.advanceTimersByTimeAsync(PORT_TIMEOUT_MS + SETTLE_GRACE_MS - 1);
    expect(finished).toBe(false); // the grace is really waited for
    expect(cleanups).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(cleanups).toBe(1);
    const m = meas(r, "read_denial");
    expect(chk(r, "read_denial").status).toBe("failed");
    expect(m["reasons"]).toEqual(expect.arrayContaining(["timeout", "cleanup_failed", "control_failed"]));
    expect(m["cleanup"]).toBe("unconfirmed");
    expect(m["scratchSettled"]).toBe(false);
    expect(m["residuePossible"]).toBe(true);
    expect(r.status).toBe("failed");
  });

  it("a prepare that rejects late does not cause an unhandled rejection and is treated as settled", async () => {
    const seen: unknown[] = [];
    const onRej = (e: unknown): void => void seen.push(e);
    process.on("unhandledRejection", onRej);
    try {
      const deps = withPorts({ scratch: { prepare: () => new Promise<ScratchPaths>((_, rej) => setTimeout(() => rej(new Error("CANARY-late-reject")), PORT_TIMEOUT_MS + 500)) } });
      const r = await runFake(deps, ALL_WAITS);
      vi.useRealTimers();
      await new Promise((resolve) => setImmediate(resolve));
      expect(seen).toEqual([]);
      expect(meas(r, "read_denial")["scratchSettled"]).toBe(true);
      expect(JSON.stringify(r)).not.toContain("CANARY");
    } finally {
      process.off("unhandledRejection", onRej);
    }
  });

  it("a cleanup that times out is unconfirmed and fails with timeout + cleanup_failed; it is never reported as completed", async () => {
    let cleanups = 0;
    const deps = withPorts({ scratch: { cleanup: () => (cleanups++, never<ProbeOutcome>()) } });
    const r = await runFake(deps, ALL_WAITS);
    const m = meas(r, "read_denial");
    expect(cleanups).toBe(1);
    expect(chk(r, "read_denial").status).toBe("failed");
    expect(m["reasons"]).toEqual(["timeout", "cleanup_failed"]);
    expect(m["cleanup"]).toBe("unconfirmed");
    expect(m["residuePossible"]).toBe(true);
    expect(r.status).toBe("failed");
  });

  it("a prepare timeout yields timeout and control_failed (not only control_failed)", async () => {
    const deps = withPorts({ scratch: { prepare: () => never<ScratchPaths>() } });
    const r = await runFake(deps, ALL_WAITS);
    expect((meas(r, "read_denial")["reasons"] as string[]).slice(0, 2)).toEqual(["timeout", "control_failed"]);
  });
});

// Guards: verify.ts checkRootfs keeps the pending tryCreate, waits at most SETTLE_GRACE_MS, and calls removeCreated exactly once.
describe("root-file-system probe that times out (verify.ts settle wait and single removal)", () => {
  it("a creation that completes late within the grace is removed exactly once; the check fails with timeout", async () => {
    let removals = 0;
    const deps = withPorts({ rootfs: { tryCreate: () => after<ProbeOutcome>(PORT_TIMEOUT_MS + 1000, () => OK), removeCreated: async () => (removals++, OK) } });
    const r = await runFake(deps, ALL_WAITS);
    const m = meas(r, "rootfs_readonly");
    expect(removals).toBe(1);
    expect(chk(r, "rootfs_readonly").status).toBe("failed");
    expect(m["reasons"]).toEqual(["timeout"]);
    expect(m["removal"]).toBe("ok");
    expect(m["lateCreation"]).toBe("created");
  });

  it("a failed removal of a late-created file adds cleanup_failed", async () => {
    let removals = 0;
    const deps = withPorts({ rootfs: { tryCreate: () => after<ProbeOutcome>(PORT_TIMEOUT_MS + 1000, () => OK), removeCreated: async () => (removals++, E("EBUSY")) } });
    const r = await runFake(deps, ALL_WAITS);
    const m = meas(r, "rootfs_readonly");
    expect(removals).toBe(1);
    expect(m["reasons"]).toEqual(["timeout", "cleanup_failed"]);
    expect(m["removal"]).toBe("failed");
    expect(r.status).toBe("failed");
  });

  it("a creation that never settles: removeCreated is called once, the check fails with timeout and cleanup_failed, removal is unconfirmed", async () => {
    let removals = 0;
    const deps = withPorts({ rootfs: { tryCreate: () => never<ProbeOutcome>(), removeCreated: async () => (removals++, E("PENDING")) } });
    const r = await runFake(deps, ALL_WAITS);
    const m = meas(r, "rootfs_readonly");
    expect(removals).toBe(1);
    expect(m["reasons"]).toEqual(["timeout", "cleanup_failed"]);
    expect(m["removal"]).toBe("unconfirmed");
    expect(m["residuePossible"]).toBe(true);
    expect(chk(r, "rootfs_readonly").status).toBe("failed");
  });

  it("an unsettled creation is never reported as removed, even if a port claims ok", async () => {
    const deps = withPorts({ rootfs: { tryCreate: () => never<ProbeOutcome>(), removeCreated: async () => OK } });
    const r = await runFake(deps, ALL_WAITS);
    expect(meas(r, "rootfs_readonly")["removal"]).toBe("unconfirmed");
    expect(chk(r, "rootfs_readonly").status).toBe("failed");
  });

  it("a late non-creating answer (EROFS) still fails with timeout and removes nothing", async () => {
    let removals = 0;
    const deps = withPorts({ rootfs: { tryCreate: () => after<ProbeOutcome>(PORT_TIMEOUT_MS + 500, () => E("EROFS")), removeCreated: async () => (removals++, OK) } });
    const r = await runFake(deps, ALL_WAITS);
    expect(removals).toBe(0);
    expect(meas(r, "rootfs_readonly")["reasons"]).toEqual(["timeout"]);
    expect(meas(r, "rootfs_readonly")["lateCreation"]).toBe("not_created");
  });

  it("EROFS control: an immediate EROFS passes with no removal; EACCES, EPERM and EEXIST never touch the file", async () => {
    for (const [code, reason] of [["EROFS", undefined], ["EACCES", "rootfs_inconclusive"], ["EPERM", "rootfs_inconclusive"], ["EEXIST", "rootfs_stale_probe"]] as const) {
      let removals = 0;
      const deps = withPorts({ rootfs: { tryCreate: async () => E(code), removeCreated: async () => (removals++, OK) } });
      const r = await verifyGroundTruthAccessDenial(deps, EXPECTED);
      expect(removals, code).toBe(0);
      expect(meas(r, "rootfs_readonly")["reason"], code).toBe(reason);
      expect(chk(r, "rootfs_readonly").status, code).toBe(reason === undefined ? "verified" : "failed");
    }
  });
});
