// The lease watcher (a pure state function over a view and a monotonic clock) and the Run_Lease gate: every lease state, the
// read-result table, the counter rules, the start-up proof, the hold, and the mapping to termination reasons.
// Tasks 2.15 and 2.17; design "Run_Lease", "Lease timing"; R9.4, R9.5, R24.9, R24.12, R24.15.
import { describe, expect, it } from "vitest";
import { LeaseCheckInterrupted, LeaseWatcher, RunLease, terminationReasonOf, type LeaseReason, type LeaseState } from "../src/index.js";
import { ABSENT, ERROR, FakeLeaseDir, FakeTime, NONCE, RUN_ID, leaseJsonOf, ok, sha256Hex, timingOf } from "./helpers/leaseFixtures.js";

// H = 1000, S = 4000, D = 100: P = 500 and U = 2000.
const timing = timingOf(1000, 4000, 100);

function watcherOf(init: ConstructorParameters<typeof FakeLeaseDir>[1] = {}, runId = RUN_ID, nonce = NONCE) {
  const time = new FakeTime();
  const dir = new FakeLeaseDir(time, init);
  const watcher = new LeaseWatcher({ view: dir, clock: time, runId, nonce, timing });
  return { time, dir, watcher };
}

const invalidOf = (state: LeaseState): { reason: LeaseReason; cause?: string } => {
  if (state.valid) throw new Error("expected an invalid state");
  return { reason: state.reason, ...(state.cause !== undefined ? { cause: state.cause } : {}) };
};
const stateOf = (r: ReturnType<LeaseWatcher["poll"]>): LeaseState => {
  if (r.kind !== "determinate") throw new Error("expected a determinate reading");
  return r.state;
};

describe("the states of the lease (design table)", () => {
  it("a good lease is valid; the first counter is the baseline and later increases are changes", () => {
    const { time, dir, watcher } = watcherOf();
    expect(watcher.poll()).toEqual({ kind: "determinate", state: { valid: true }, changed: false });
    expect(watcher.lastCounter).toBe(1);
    dir.heartbeat = ok("2");
    time.t = 900;
    expect(watcher.poll()).toEqual({ kind: "determinate", state: { valid: true }, changed: true });
    expect(watcher.poll()).toEqual({ kind: "determinate", state: { valid: true }, changed: false });
  });

  it("missing: lease.json does not exist", () => {
    const { watcher } = watcherOf({ leaseJson: ABSENT });
    expect(invalidOf(stateOf(watcher.poll()))).toEqual({ reason: "missing", cause: "lease_json_absent" });
  });

  it("malformed: lease.json does not parse or lacks a required field", () => {
    const bad = [
      "not json", "[]", "null", "{}", "",
      leaseJsonOf({ run_id: "" }), leaseJsonOf({ issued_by: "someone" }), leaseJsonOf({ nonce_sha256: "ABC" }),
      leaseJsonOf({ nonce_sha256: "a".repeat(63) }), leaseJsonOf({ heartbeat_interval_ms: 1000.5 }),
      leaseJsonOf({ stale_after_ms: "4000" as unknown as number }),
    ];
    for (const text of bad) {
      const { watcher } = watcherOf({ leaseJson: ok(text) });
      expect(invalidOf(stateOf(watcher.poll())), text).toEqual({ reason: "malformed", cause: "lease_json_invalid" });
    }
  });

  it("run_mismatch and nonce_mismatch: bound to another Run, or to another nonce (a copied or old directory)", () => {
    expect(invalidOf(stateOf(watcherOf({ leaseJson: ok(leaseJsonOf({ run_id: "run-other" })) }).watcher.poll()))).toEqual({ reason: "run_mismatch", cause: "run_id_differs" });
    expect(invalidOf(stateOf(watcherOf({ leaseJson: ok(leaseJsonOf({ nonce_sha256: sha256Hex("another nonce") })) }).watcher.poll()))).toEqual({ reason: "nonce_mismatch", cause: "nonce_differs" });
    expect(invalidOf(stateOf(watcherOf({}, RUN_ID, "the container has another nonce").watcher.poll()))).toEqual({ reason: "nonce_mismatch", cause: "nonce_differs" });
  });

  it("malformed (timing_differs): lease.json carries other H or S than the run configuration", () => {
    expect(invalidOf(stateOf(watcherOf({ leaseJson: ok(leaseJsonOf({}, 1500, 4000)) }).watcher.poll()))).toEqual({ reason: "malformed", cause: "timing_differs" });
    expect(invalidOf(stateOf(watcherOf({ leaseJson: ok(leaseJsonOf({}, 1000, 5000)) }).watcher.poll()))).toEqual({ reason: "malformed", cause: "timing_differs" });
  });

  it("revoked: the file exists", () => {
    const { watcher } = watcherOf({ revoked: ok("") });
    expect(invalidOf(stateOf(watcher.poll()))).toEqual({ reason: "revoked", cause: "revoked_file" });
  });

  it("heartbeat_stale: no change of the counter for S", () => {
    const { time, watcher } = watcherOf();
    watcher.poll();
    time.t = 3999;
    expect(stateOf(watcher.poll())).toEqual({ valid: true });
    time.t = 4000;
    expect(invalidOf(stateOf(watcher.poll()))).toEqual({ reason: "heartbeat_stale", cause: "no_counter_change" });
  });
});

describe("lease.json that was changed is told apart from lease.json that is bad from the start", () => {
  it("a content that differs from the content checked first is malformed (lease_json_changed), even if it is valid on its own", () => {
    const { dir, watcher } = watcherOf();
    expect(stateOf(watcher.poll())).toEqual({ valid: true });
    dir.leaseJson = ok(leaseJsonOf({ launcher_pid: 1 })); // still a valid lease.json, but not the one checked at start
    expect(invalidOf(stateOf(watcher.poll()))).toEqual({ reason: "malformed", cause: "lease_json_changed" });
  });

  it("a change in whitespace is a change (compared by hash)", () => {
    const { dir, watcher } = watcherOf();
    watcher.poll();
    dir.leaseJson = ok(`${leaseJsonOf()}\n`);
    expect(invalidOf(stateOf(watcher.poll())).cause).toBe("lease_json_changed");
  });

  it("lease.json that disappears later is missing", () => {
    const { dir, watcher } = watcherOf();
    watcher.poll();
    dir.leaseJson = ABSENT;
    expect(invalidOf(stateOf(watcher.poll()))).toEqual({ reason: "missing", cause: "lease_json_absent" });
  });
});

describe("the counter", () => {
  it("a lower value is malformed (counter_decreased); an equal value is no change; a higher value is a change", () => {
    const { time, dir, watcher } = watcherOf({ heartbeat: ok("5") });
    watcher.poll();
    time.t = 100;
    dir.heartbeat = ok("5");
    expect(watcher.poll()).toEqual({ kind: "determinate", state: { valid: true }, changed: false });
    dir.heartbeat = ok("9");
    expect(watcher.poll()).toEqual({ kind: "determinate", state: { valid: true }, changed: true });
    dir.heartbeat = ok("8");
    expect(invalidOf(stateOf(watcher.poll()))).toEqual({ reason: "malformed", cause: "counter_decreased" });
  });

  it("an unparsable counter is no observation, not a decrease and not a change; the staleness time keeps running", () => {
    for (const text of ["", "abc", "0", "-1", "01", "1.5", "1e3", " ", "99999999999999999999"]) {
      const { time, dir, watcher } = watcherOf({ heartbeat: ok("3") });
      watcher.poll();
      dir.heartbeat = ok(text);
      time.t = 1000;
      expect(stateOf(watcher.poll()), text).toEqual({ valid: true });
      time.t = 4000;
      expect(invalidOf(stateOf(watcher.poll())).reason, text).toBe("heartbeat_stale");
    }
  });

  it("surrounding whitespace and a trailing newline are accepted", () => {
    const { time, dir, watcher } = watcherOf({ heartbeat: ok("1\n") });
    watcher.poll();
    dir.heartbeat = ok(" 2\r\n");
    time.t = 10;
    expect(watcher.poll()).toMatchObject({ changed: true });
  });

  it("a counter that changes just inside the staleness window keeps the lease; just outside, it is too late", () => {
    const inside = watcherOf();
    inside.watcher.poll();
    inside.time.t = 3999;
    inside.dir.heartbeat = ok("2");
    expect(inside.watcher.poll()).toMatchObject({ state: { valid: true }, changed: true });
    inside.time.t = 7998; // 3999 after the change
    expect(stateOf(inside.watcher.poll())).toEqual({ valid: true });
    inside.time.t = 7999; // 4000 after the change
    expect(invalidOf(stateOf(inside.watcher.poll())).reason).toBe("heartbeat_stale");

    const outside = watcherOf();
    outside.watcher.poll();
    outside.time.t = 4000;
    outside.dir.heartbeat = ok("2"); // the change comes at the boundary: the stale rule is applied in the same poll, after the counter is read
    expect(outside.watcher.poll()).toMatchObject({ state: { valid: true }, changed: true });
    const late = watcherOf();
    late.watcher.poll();
    late.time.t = 4001;
    expect(invalidOf(stateOf(late.watcher.poll())).reason).toBe("heartbeat_stale");
  });

  it("a clock that does not move never makes the lease stale (staleness is measured only by the monotonic clock)", () => {
    const { dir, watcher } = watcherOf();
    for (let i = 0; i < 200; i += 1) expect(stateOf(watcher.poll())).toEqual({ valid: true });
    expect(dir.reads.heartbeat).toBe(200);
  });
});

describe("the read-result table (design 'Read results')", () => {
  it("an error reading revoked or lease.json is indeterminate: neither valid nor invalid", () => {
    expect(watcherOf({ revoked: ERROR }).watcher.poll()).toEqual({ kind: "indeterminate", changed: false });
    expect(watcherOf({ leaseJson: ERROR }).watcher.poll()).toEqual({ kind: "indeterminate", changed: false });
  });

  it("absent revoked means not revoked; absent lease.json means missing", () => {
    expect(stateOf(watcherOf({ revoked: ABSENT }).watcher.poll())).toEqual({ valid: true });
    expect(invalidOf(stateOf(watcherOf({ leaseJson: ABSENT }).watcher.poll())).reason).toBe("missing");
  });

  it("an error or an absent heartbeat is only 'no observation': the lease stays valid until S has passed", () => {
    for (const hb of [ERROR, ABSENT]) {
      const { time, dir, watcher } = watcherOf();
      watcher.poll();
      dir.heartbeat = hb;
      time.t = 3999;
      expect(stateOf(watcher.poll())).toEqual({ valid: true });
      time.t = 4000;
      expect(invalidOf(stateOf(watcher.poll())).reason).toBe("heartbeat_stale");
    }
  });

  it("a determinate invalid finding wins over an indeterminate reading", () => {
    expect(invalidOf(stateOf(watcherOf({ leaseJson: ABSENT, revoked: ERROR }).watcher.poll())).reason).toBe("missing");
    expect(invalidOf(stateOf(watcherOf({ leaseJson: ERROR, revoked: ok("") }).watcher.poll())).reason).toBe("revoked");
    const { time, watcher } = watcherOf({ revoked: ERROR });
    expect(watcher.poll()).toEqual({ kind: "indeterminate", changed: false });
    time.t = 4000;
    expect(invalidOf(stateOf(watcher.poll())).reason).toBe("heartbeat_stale");
  });

  it("a view that throws is read as an error", () => {
    const time = new FakeTime();
    const view = { readLeaseJson: () => { throw new Error("boom"); }, readHeartbeat: () => ({ kind: "ok" as const, text: "1" }), readRevoked: () => ({ kind: "absent" as const }) };
    expect(new LeaseWatcher({ view, clock: time, runId: RUN_ID, nonce: NONCE, timing }).poll()).toEqual({ kind: "indeterminate", changed: false });
  });

  it("precedence of the invalid findings: revoked, missing, lease.json problems, counter, stale", () => {
    expect(invalidOf(stateOf(watcherOf({ revoked: ok(""), leaseJson: ABSENT }).watcher.poll())).reason).toBe("revoked");
    const bad = watcherOf({ leaseJson: ok(leaseJsonOf({ run_id: "x" })), heartbeat: ok("1") });
    expect(invalidOf(stateOf(bad.watcher.poll())).reason).toBe("run_mismatch");
  });
});

describe("an invalid lease stays invalid (latched)", () => {
  it("restoring the files does not make the lease valid again", () => {
    const { dir, watcher } = watcherOf({ revoked: ok("") });
    expect(invalidOf(stateOf(watcher.poll())).reason).toBe("revoked");
    dir.revoked = ABSENT;
    expect(invalidOf(stateOf(watcher.poll())).reason).toBe("revoked");
    const reads = { ...dir.reads };
    watcher.poll();
    expect(dir.reads).toEqual(reads); // a latched lease reads nothing
  });
});

describe("mapping to the termination reason (R11.16, R24.12, R24.15)", () => {
  it("heartbeat_stale is launcher_killed; every other reason, unreadable included, is lease_unavailable", () => {
    const reasons: LeaseReason[] = ["missing", "malformed", "run_mismatch", "nonce_mismatch", "revoked", "heartbeat_stale", "unreadable"];
    for (const reason of reasons) expect(terminationReasonOf({ reason }), reason).toBe(reason === "heartbeat_stale" ? "launcher_killed" : "lease_unavailable");
  });
});

// ---------------------------------------------------------------------------------------------------- the gate

function gateOf(init: ConstructorParameters<typeof FakeLeaseDir>[1] = {}) {
  const time = new FakeTime();
  const dir = new FakeLeaseDir(time, init);
  const watcher = new LeaseWatcher({ view: dir, clock: time, runId: RUN_ID, nonce: NONCE, timing });
  const lease = new RunLease({ watcher, clock: time, sleeper: time, timing });
  return { time, dir, lease };
}
/** A healthy writer: the counter goes up every H = 1000 ms. */
const healthyCounter = (t: number) => ok(String(Math.floor(t / 1000) + 1));

describe("the start-up liveness proof", () => {
  it("a healthy writer passes after the counter changes; nothing is valid before", async () => {
    const { time, lease } = gateOf({ heartbeat: healthyCounter });
    expect(lease.isProven).toBe(false);
    expect(await lease.check()).toEqual({ valid: true });
    expect(lease.isProven).toBe(true);
    expect(time.t).toBe(1000); // about H: the first change comes at t = 1000, seen by the poll at 1000
  });

  it("a stopped writer is refused as heartbeat_stale after S, never valid", async () => {
    const { time, lease } = gateOf({ heartbeat: ok("7") });
    const state = await lease.check();
    expect(invalidOf(state)).toEqual({ reason: "heartbeat_stale", cause: "no_counter_change" });
    expect(time.t).toBe(4000);
    expect(lease.isProven).toBe(false);
    expect(await lease.check()).toBe(state); // latched: still refused
  });

  it("a heartbeat that is absent, or unreadable, never lets the proof pass", async () => {
    for (const hb of [ABSENT, ERROR]) {
      const { time, lease } = gateOf({ heartbeat: hb });
      expect(invalidOf(await lease.check()).reason).toBe("heartbeat_stale");
      expect(time.t).toBe(4000);
    }
  });

  it("a missing, malformed, mismatched or revoked lease is refused at once, without waiting", async () => {
    const cases: [ConstructorParameters<typeof FakeLeaseDir>[1], LeaseReason][] = [
      [{ leaseJson: ABSENT }, "missing"],
      [{ leaseJson: ok("garbage") }, "malformed"],
      [{ leaseJson: ok(leaseJsonOf({ run_id: "other" })) }, "run_mismatch"],
      [{ leaseJson: ok(leaseJsonOf({ nonce_sha256: sha256Hex("x") })) }, "nonce_mismatch"],
      [{ revoked: ok("") }, "revoked"],
    ];
    for (const [init, reason] of cases) {
      const { time, lease } = gateOf({ heartbeat: healthyCounter, ...init });
      expect(invalidOf(await lease.check()).reason).toBe(reason);
      expect(time.t).toBe(0);
      expect(time.sleeps).toEqual([]);
    }
  });

  it("a clock that does not move cannot end the wait, so the proof is refused after a bounded number of polls", async () => {
    const { time, lease } = gateOf({ heartbeat: ok("7") });
    time.moves = false;
    expect(invalidOf(await lease.check()).reason).toBe("heartbeat_stale");
    expect(time.sleeps.length).toBeLessThan(100);
    expect(time.t).toBe(0);
  });

  it("an unreadable lease.json for U ends the proof as unreadable; a shorter failure does not", async () => {
    const forever = gateOf({ leaseJson: ERROR, heartbeat: healthyCounter });
    expect(invalidOf(await forever.lease.check())).toEqual({ reason: "unreadable", cause: "read_hold_expired" });
    expect(forever.time.t).toBe(2000); // U = S / 2

    const brief = gateOf({ leaseJson: (t) => (t < 800 ? ERROR : ok(leaseJsonOf())), heartbeat: healthyCounter });
    expect(await brief.lease.check()).toEqual({ valid: true });
  });

  it("a counter that goes down during the proof is malformed", async () => {
    const { lease } = gateOf({ heartbeat: (t) => ok(t < 500 ? "9" : "3") });
    expect(invalidOf(await lease.check())).toEqual({ reason: "malformed", cause: "counter_decreased" });
  });
});

describe("the check before a request (running rule and hold)", () => {
  async function proven(init: ConstructorParameters<typeof FakeLeaseDir>[1] = {}) {
    const g = gateOf({ heartbeat: healthyCounter, ...init });
    expect(await g.lease.check()).toEqual({ valid: true });
    return g;
  }

  it("a healthy lease answers at once, without waiting", async () => {
    const { time, lease } = await proven();
    const before = time.t;
    expect(await lease.check()).toEqual({ valid: true });
    expect(time.t).toBe(before);
  });

  it("a reading error shorter than the retries is repeated up to 3 times, 100 ms apart, and then answers", async () => {
    const { time, dir, lease } = await proven();
    const T = time.t;
    dir.leaseJson = (t) => (t < T + 250 ? ERROR : ok(leaseJsonOf()));
    expect(await lease.check()).toEqual({ valid: true });
    expect(time.t).toBe(T + 300);
    expect(time.sleeps.slice(-3)).toEqual([100, 100, 100]);
  });

  it("a longer error is held (nothing answers valid) until the reading is determinate, if that is before U", async () => {
    const { time, dir, lease } = await proven();
    const T = time.t;
    dir.leaseJson = (t) => (t < T + 1500 ? ERROR : ok(leaseJsonOf()));
    expect(await lease.check()).toEqual({ valid: true });
    expect(time.t).toBeGreaterThanOrEqual(T + 1500); // never answered while the reading was indeterminate
    expect(time.t).toBe(T + 1800);
  });

  it("an error on revoked is held the same way", async () => {
    const { time, dir, lease } = await proven();
    const T = time.t;
    dir.revoked = (t) => (t < T + 700 ? ERROR : ABSENT);
    expect(await lease.check()).toEqual({ valid: true });
    expect(time.t).toBeGreaterThanOrEqual(T + 700);
  });

  it("an indeterminate reading for U ends the lease as unreadable (lease_unavailable), exactly at U", async () => {
    const { time, dir, lease } = await proven();
    const T = time.t;
    dir.leaseJson = ERROR;
    const state = await lease.check();
    expect(invalidOf(state)).toEqual({ reason: "unreadable", cause: "read_hold_expired" });
    expect(time.t).toBe(T + 2000);
    expect(terminationReasonOf(state as { reason: LeaseReason })).toBe("lease_unavailable");
    expect(await lease.check()).toBe(state);
  });

  it("an error window that ends just inside U still answers valid; one that lasts to U does not", async () => {
    const inside = await proven();
    const T1 = inside.time.t;
    inside.dir.leaseJson = (t) => (t < T1 + 1999 ? ERROR : ok(leaseJsonOf()));
    expect(await inside.lease.check()).toEqual({ valid: true });

    const edge = await proven();
    const T2 = edge.time.t;
    edge.dir.leaseJson = (t) => (t < T2 + 2001 ? ERROR : ok(leaseJsonOf()));
    expect(invalidOf(await edge.lease.check()).reason).toBe("unreadable");
  });

  it("lease.json that was changed, a decreasing counter, revoked, and a stopped writer each end the lease with their own cause", async () => {
    const changed = await proven();
    changed.dir.leaseJson = ok(leaseJsonOf({ launcher_pid: 5 }));
    expect(invalidOf(await changed.lease.check())).toEqual({ reason: "malformed", cause: "lease_json_changed" });

    const decreased = await proven();
    decreased.dir.heartbeat = (t) => ok(String(Math.max(1, Math.floor(t / 1000) + 1 - 5)));
    expect(invalidOf(await decreased.lease.check())).toEqual({ reason: "malformed", cause: "counter_decreased" });

    const revoked = await proven();
    revoked.dir.revoked = ok("");
    expect(invalidOf(await revoked.lease.check()).reason).toBe("revoked");

    const stopped = await proven();
    const last = Math.floor(stopped.time.t / 1000) + 1;
    stopped.dir.heartbeat = ok(String(last));
    stopped.time.t += 4000;
    expect(invalidOf(await stopped.lease.check()).reason).toBe("heartbeat_stale");
  });

  it("stops waiting at a deadline or when the signal aborts, by throwing LeaseCheckInterrupted", async () => {
    const a = await proven();
    a.dir.leaseJson = ERROR;
    const T = a.time.t;
    await expect(a.lease.check({ deadlineAtMs: T + 250 })).rejects.toMatchObject({ name: "LeaseCheckInterrupted", why: "deadline" });
    expect(a.time.t).toBe(T + 250);

    const b = await proven();
    b.dir.leaseJson = ERROR;
    const controller = new AbortController();
    controller.abort();
    await expect(b.lease.check({ signal: controller.signal })).rejects.toBeInstanceOf(LeaseCheckInterrupted);
    await expect(b.lease.check({ signal: controller.signal })).rejects.toMatchObject({ why: "aborted" });
  });
});