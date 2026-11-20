// Task 4.4, unit U6a: the lease check at a phase boundary (`src/orchestrator/leaseBoundary.ts`). Deterministic and offline: the REAL RunSession on a
// scripted monotonic clock and a fake lease port; nothing waits on real time.
// **Validates: Requirements 11.16, 24.12, 24.15**
import { describe, expect, it } from "vitest";
import { checkLeaseBoundary } from "../src/orchestrator/leaseBoundary.js";
import { createRunSession } from "../src/orchestrator/session.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

function setup(check: (self: unknown, opts: Loose) => Loose, extra: Loose = {}) {
  const clock = { t: 1_000, nowMs(): number { return this.t; } };
  const made = createRunSession({ clock, runSeconds: 100 });
  if (!made.ok) throw new Error("setup failed");
  const session = made.value;
  const calls: { self: unknown; opts: Loose }[] = [];
  const port: Loose = {
    ...extra,
    check(this: unknown, opts: Loose): Loose {
      calls.push({ self: this, opts });
      return check(this, opts);
    },
  };
  return { clock, session, port, calls, status: () => session.terminationStatus() };
}

describe("a valid lease", () => {
  it("continues, with one check on the SAME instance, the session deadline and the session signal", async () => {
    const h = setup(() => ({ valid: true }));
    await expect(checkLeaseBoundary(h.port, h.session)).resolves.toBe("continue");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.self).toBe(h.port);
    expect(h.calls[0]?.opts.deadlineAtMs).toBe(h.session.deadlineAtMs);
    expect(h.calls[0]?.opts.signal).toBe(h.session.signal);
    expect(h.status()).toEqual({ state: "none" });
  });
  it("an asynchronous answer is awaited", async () => {
    const h = setup(async () => ({ valid: true }));
    await expect(checkLeaseBoundary(h.port, h.session)).resolves.toBe("continue");
  });
  it("stops when a cause was latched while the check was awaited", async () => {
    const h = setup(() => {
      h.session.raise("provider_failure");
      return { valid: true };
    });
    await expect(checkLeaseBoundary(h.port, h.session)).resolves.toBe("stop");
    expect(h.status()).toEqual({ state: "pending", reason: "provider_failure" });
  });
});

describe("an invalid lease", () => {
  it("heartbeat_stale raises launcher_killed", async () => {
    const h = setup(() => ({ valid: false, reason: "heartbeat_stale" }));
    await expect(checkLeaseBoundary(h.port, h.session)).resolves.toBe("stop");
    expect(h.status()).toEqual({ state: "pending", reason: "launcher_killed" });
    expect(h.session.signal.aborted).toBe(true);
  });
  it.each(["missing", "malformed", "run_mismatch", "nonce_mismatch", "revoked", "unreadable", "something_else"])("%s raises lease_unavailable", async (reason) => {
    const h = setup(() => ({ valid: false, reason }));
    await expect(checkLeaseBoundary(h.port, h.session)).resolves.toBe("stop");
    expect(h.status()).toEqual({ state: "pending", reason: "lease_unavailable" });
  });
  it("a higher cause that was latched first stays (isolation_violation beats launcher_killed)", async () => {
    const h = setup(() => {
      h.session.raise("isolation_violation");
      return { valid: false, reason: "heartbeat_stale" };
    });
    await expect(checkLeaseBoundary(h.port, h.session)).resolves.toBe("stop");
    expect(h.status()).toEqual({ state: "pending", reason: "isolation_violation" });
  });
});

describe("a failed or odd check is attributed, never a pass", () => {
  const SECRET = "SECRET_LEASE_MESSAGE";
  const cases: [string, () => Loose][] = [
    ["throws", () => { throw new Error(SECRET); }],
    ["rejects", () => Promise.reject(new Error(SECRET))],
    ["undefined", () => undefined],
    ["null", () => null],
    ["a number", () => 7],
    ["no valid field", () => ({})],
    ["valid is a string", () => ({ valid: "yes" })],
  ];
  it.each(cases)("%s: stop, and the unexplained symptom falls back to error", async (_n, check) => {
    const h = setup(check);
    await expect(checkLeaseBoundary(h.port, h.session)).resolves.toBe("stop");
    expect(h.status()).toEqual({ state: "pending", reason: "error" });
    expect(JSON.stringify(h.status())).not.toContain(SECRET);
  });
  it("a port without a check function, and a non-object port", async () => {
    for (const port of [{}, null, undefined, 5, { check: "no" }]) {
      const h = setup(() => ({ valid: true }));
      await expect(checkLeaseBoundary(port, h.session), String(port)).resolves.toBe("stop");
      expect(h.status()).toEqual({ state: "pending", reason: "error" });
    }
  });
  it("an existing cause is kept when the check throws", async () => {
    const h = setup(() => {
      h.session.raise("time_limit_reached");
      throw new Error(SECRET);
    });
    await expect(checkLeaseBoundary(h.port, h.session)).resolves.toBe("stop");
    expect(h.status()).toEqual({ state: "pending", reason: "time_limit_reached" });
  });
});

describe("nothing is called when the Run must already stop", () => {
  it("a latched cause: stop, no check, no new raise (isolation_violation stays)", async () => {
    const h = setup(() => ({ valid: false, reason: "heartbeat_stale" }));
    h.session.raise("isolation_violation");
    await expect(checkLeaseBoundary(h.port, h.session)).resolves.toBe("stop");
    expect(h.calls).toHaveLength(0);
    expect(h.status()).toEqual({ state: "pending", reason: "isolation_violation" });
  });
  it("a finalized latch: stop, no check", async () => {
    const h = setup(() => ({ valid: true }));
    h.session.raise("provider_failure");
    h.session.finalize();
    await expect(checkLeaseBoundary(h.port, h.session)).resolves.toBe("stop");
    expect(h.calls).toHaveLength(0);
  });
  it("a deadline that was reached: stop with time_limit_reached, no check", async () => {
    const h = setup(() => ({ valid: true }));
    h.clock.t = 1_000 + 100 * 1000;
    await expect(checkLeaseBoundary(h.port, h.session)).resolves.toBe("stop");
    expect(h.calls).toHaveLength(0);
    expect(h.status()).toEqual({ state: "pending", reason: "time_limit_reached" });
  });
  it("a clock fault: stop with error, no check", async () => {
    const h = setup(() => ({ valid: true }));
    h.clock.nowMs = (): number => {
      throw new Error("clock failed");
    };
    await expect(checkLeaseBoundary(h.port, h.session)).resolves.toBe("stop");
    expect(h.calls).toHaveLength(0);
    expect(h.status()).toEqual({ state: "pending", reason: "error" });
  });
});
