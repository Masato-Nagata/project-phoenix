// Fixtures for the Run_Lease tests (task 2.15 to 2.17): a fake monotonic clock that doubles as the sleeper, a scripted lease
// directory view, and the lease.json text. Neutral names only.
import { createHash } from "node:crypto";
import { checkLeaseTiming, type LeaseDirView, type LeaseTiming, type MonotonicClock, type ReadResult, type Sleeper } from "../../src/index.js";

export const RUN_ID = "run-0001";
export const NONCE = "nonce-for-tests";
export const sha256Hex = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Time moves only when something sleeps (or the test sets it). */
export class FakeTime implements MonotonicClock, Sleeper {
  t = 0;
  readonly sleeps: number[] = [];
  /** When false, `sleep` returns without moving the clock (a clock that does not move). */
  moves = true;
  nowMs(): number {
    return this.t;
  }
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) throw new Error("aborted");
    this.sleeps.push(ms);
    if (this.moves) this.t += ms;
  }
}

export interface LeaseJsonFields {
  run_id: string;
  launcher_pid: number;
  launcher_start_ticks: string;
  nonce_sha256: string;
  issued_by: string;
  heartbeat_interval_ms: number;
  stale_after_ms: number;
}

export function leaseJsonOf(over: Partial<LeaseJsonFields> = {}, h = 1000, s = 4000): string {
  const base: LeaseJsonFields = {
    run_id: RUN_ID,
    launcher_pid: 4242,
    launcher_start_ticks: "638000000000000000",
    nonce_sha256: sha256Hex(NONCE),
    issued_by: "launcher",
    heartbeat_interval_ms: h,
    stale_after_ms: s,
  };
  return JSON.stringify({ ...base, ...over });
}

export function timingOf(h = 1000, s = 4000, d = 100): LeaseTiming {
  const r = checkLeaseTiming({ heartbeatIntervalMs: h, staleAfterMs: s }, d);
  if (!r.ok) throw new Error(`bad timing: ${r.error.join(",")}`);
  return r.value;
}

export const ok = (text: string): ReadResult => ({ kind: "ok", text });
export const ABSENT: ReadResult = { kind: "absent" };
export const ERROR: ReadResult = { kind: "error" };

export type Source = ReadResult | ((t: number) => ReadResult);

/** A lease directory whose files are scripted, possibly as a function of the fake time. Counts the reads; it has no way to write. */
export class FakeLeaseDir implements LeaseDirView {
  leaseJson: Source;
  heartbeat: Source;
  revoked: Source;
  reads = { leaseJson: 0, heartbeat: 0, revoked: 0 };
  private readonly time: FakeTime;

  constructor(time: FakeTime, init: Partial<{ leaseJson: Source; heartbeat: Source; revoked: Source }> = {}) {
    this.time = time;
    this.leaseJson = init.leaseJson ?? ok(leaseJsonOf());
    this.heartbeat = init.heartbeat ?? ok("1");
    this.revoked = init.revoked ?? ABSENT;
  }

  private pick(s: Source): ReadResult {
    return typeof s === "function" ? s(this.time.t) : s;
  }
  readLeaseJson(): ReadResult {
    this.reads.leaseJson += 1;
    return this.pick(this.leaseJson);
  }
  readHeartbeat(): ReadResult {
    this.reads.heartbeat += 1;
    return this.pick(this.heartbeat);
  }
  readRevoked(): ReadResult {
    this.reads.revoked += 1;
    return this.pick(this.revoked);
  }
}