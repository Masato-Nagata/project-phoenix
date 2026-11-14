// The container side of the lease timing measurement (task 2.27), offline with a fake lease directory and a fake clock.
import { describe, expect, it } from "vitest";
import { killTrial, observePropagation, startupTrial, type AckWriter } from "../src/leaseMeasure/harness.js";
import { ABSENT, FakeLeaseDir, FakeTime, NONCE, RUN_ID, ok, timingOf } from "./helpers/leaseFixtures.js";

const timing = timingOf(1000, 4000, 0);
class Acks implements AckWriter {
  readonly files = new Map<string, string>();
  readonly order: string[] = [];
  write(name: string, text: string): void {
    this.files.set(name, text);
    this.order.push(name);
  }
}
const healthy = (t: number) => ok(String(Math.floor(t / 1000) + 1));

describe("observePropagation", () => {
  it("acknowledges every new counter value once, in order, and records the gaps between observed changes", async () => {
    const time = new FakeTime();
    const dir = new FakeLeaseDir(time, { heartbeat: healthy, revoked: (t) => (t >= 5000 ? ok("") : ABSENT) });
    const ack = new Acks();
    const r = await observePropagation({ view: dir, clock: time, sleeper: time, ack, runId: RUN_ID, nonce: NONCE, timing, observePollMs: 10 });
    expect(ack.order.filter((n) => n.startsWith("beat-"))).toEqual(["beat-1", "beat-2", "beat-3", "beat-4", "beat-5"]);
    expect(r.gaps).toEqual([1000, 1000, 1000, 1000]);
    expect(JSON.parse(ack.files.get("observer.json") as string)).toEqual({ beats: 5, gaps: [1000, 1000, 1000, 1000] });
  });

  it("ignores a value that does not increase, and ends at the time limit", async () => {
    const time = new FakeTime();
    const dir = new FakeLeaseDir(time, { heartbeat: (t) => ok(t < 500 ? "4" : "2") });
    const ack = new Acks();
    await observePropagation({ view: dir, clock: time, sleeper: time, ack, runId: RUN_ID, nonce: NONCE, timing, observePollMs: 10, maxObserveMs: 2000 });
    expect(ack.order.filter((n) => n.startsWith("beat-"))).toEqual(["beat-4"]);
  });
});

describe("startupTrial", () => {
  it("a healthy writer passes the proof; the one request would follow it", async () => {
    const time = new FakeTime();
    const ack = new Acks();
    const r = await startupTrial({ view: new FakeLeaseDir(time, { heartbeat: healthy }), clock: time, sleeper: time, ack, runId: RUN_ID, nonce: NONCE, timing });
    expect(r).toEqual({ result: "passed", requests: 1 });
    expect(JSON.parse(ack.files.get("startup.json") as string)).toEqual(r);
  });

  it("a stopped writer is refused as heartbeat_stale and no request is counted", async () => {
    const time = new FakeTime();
    const ack = new Acks();
    const r = await startupTrial({ view: new FakeLeaseDir(time, { heartbeat: ok("1") }), clock: time, sleeper: time, ack, runId: RUN_ID, nonce: NONCE, timing });
    expect(r).toEqual({ result: "refused", reason: "heartbeat_stale", requests: 0 });
  });
});

describe("killTrial", () => {
  it("passes the proof, acknowledges it, and exits with 3 within S + P after the writer stops", async () => {
    const time = new FakeTime();
    const stopAt = 3000;
    const dir = new FakeLeaseDir(time, { heartbeat: (t) => ok(String(Math.floor(Math.min(t, stopAt) / 1000) + 1)) });
    const ack = new Acks();
    const code = await killTrial({ view: dir, clock: time, sleeper: time, ack, runId: RUN_ID, nonce: NONCE, timing });
    expect(code).toBe(3);
    expect(ack.files.has("proof-passed")).toBe(true);
    expect(time.t - stopAt).toBeGreaterThanOrEqual(4000);
    expect(time.t - stopAt).toBeLessThanOrEqual(4000 + timing.watchIntervalMs);
  });

  it("a writer that was already stopped is refused at the proof (exit 2)", async () => {
    const time = new FakeTime();
    const ack = new Acks();
    expect(await killTrial({ view: new FakeLeaseDir(time, { heartbeat: ok("1") }), clock: time, sleeper: time, ack, runId: RUN_ID, nonce: NONCE, timing })).toBe(2);
    expect(ack.files.get("proof-refused")).toBe("heartbeat_stale");
  });
});