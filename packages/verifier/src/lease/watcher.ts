// The lease watcher: a state function over a view of the lease directory and a monotonic clock (design: "Runtime-side lease
// watcher and adapters", "Run_Lease", "Lease timing"; R24.9, R24.15; task 2.15). It performs no I/O of its own: the view and the
// clock are injected, and it writes nothing.
//
// One `poll()` reads the three files once and applies the rules:
//   - `revoked` exists                                          -> revoked
//   - `lease.json` is absent                                    -> missing
//   - `lease.json` is not what was checked first (by hash)      -> malformed (lease_json_changed)
//   - `lease.json` does not parse, or lacks a field             -> malformed (lease_json_invalid)
//   - `run_id` / the nonce hash / H and S differ                -> run_mismatch / nonce_mismatch / malformed (timing_differs)
//   - the counter is lower than the last value seen             -> malformed (counter_decreased)
//   - the counter has not changed for S (monotonic clock)       -> heartbeat_stale
// An error when reading `revoked` or `lease.json` is an indeterminate reading: it is neither valid nor invalid. An error (or an
// unparsable value) in `heartbeat` is "no observation": the staleness time keeps running. An invalid state is latched: once a
// poll found it, every later poll returns it, so a lease never becomes valid again.
import { createHash } from "node:crypto";
import type { LeaseCause, LeaseDirView, LeaseReason, LeaseState, MonotonicClock, ReadResult } from "./types.js";
import type { LeaseTiming } from "./timing.js";

export interface LeaseWatcherDeps {
  readonly view: LeaseDirView;
  readonly clock: MonotonicClock;
  /** `PHOENIX_RUN_ID` */
  readonly runId: string;
  /** `PHOENIX_LEASE_NONCE`; only its SHA-256 is compared with `nonce_sha256`. */
  readonly nonce: string;
  readonly timing: LeaseTiming;
}

export type WatchReading =
  | { readonly kind: "determinate"; readonly state: LeaseState; /** The counter increased since the last poll that saw a value. */ readonly changed: boolean }
  | { readonly kind: "indeterminate"; /** The counter increased in this poll, even though the files could not all be judged. */ readonly changed: boolean };

const HEX64 = /^[0-9a-f]{64}$/;
const COUNTER = /^[1-9][0-9]{0,14}$/;

const sha256Hex = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const invalid = (reason: LeaseReason, cause: LeaseCause): LeaseState => Object.freeze({ valid: false as const, reason, cause });
const VALID: LeaseState = Object.freeze({ valid: true as const });

interface LeaseJson {
  readonly runId: string;
  readonly nonceSha256: string;
  readonly heartbeatIntervalMs: number;
  readonly staleAfterMs: number;
}

/** The fields the runtime checks. `launcher_pid` and `launcher_start_ticks` are for diagnosis only and are not checked. */
export function parseLeaseJson(text: string): LeaseJson | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const { run_id: runId, nonce_sha256: nonce, issued_by: by, heartbeat_interval_ms: h, stale_after_ms: s } = o;
  if (typeof runId !== "string" || runId.length === 0) return undefined;
  if (typeof nonce !== "string" || !HEX64.test(nonce)) return undefined;
  if (by !== "launcher") return undefined;
  if (typeof h !== "number" || !Number.isSafeInteger(h) || typeof s !== "number" || !Number.isSafeInteger(s)) return undefined;
  return { runId, nonceSha256: nonce, heartbeatIntervalMs: h, staleAfterMs: s };
}

/** The counter as a number, or undefined when the text is not a counter (the read then counts as "no observation"). */
export function parseCounter(text: string): number | undefined {
  const t = text.trim();
  return COUNTER.test(t) ? Number(t) : undefined;
}

export class LeaseWatcher {
  private readonly deps: LeaseWatcherDeps;
  private readonly nonceHash: string;
  private pinnedHash: string | undefined;
  private counter: number | undefined;
  private changedAt = 0;
  private latched: LeaseState | undefined;

  constructor(deps: LeaseWatcherDeps) {
    this.deps = deps;
    this.nonceHash = sha256Hex(deps.nonce);
  }

  /** The last counter value seen, for diagnosis and tests. */
  get lastCounter(): number | undefined {
    return this.counter;
  }

  private read(f: () => ReadResult): ReadResult {
    try {
      return f();
    } catch {
      return { kind: "error" };
    }
  }

  private judgeLeaseJson(text: string): LeaseState | undefined {
    const hash = sha256Hex(text);
    if (this.pinnedHash !== undefined && hash !== this.pinnedHash) return invalid("malformed", "lease_json_changed");
    const parsed = parseLeaseJson(text);
    if (parsed === undefined) return invalid("malformed", "lease_json_invalid");
    if (parsed.runId !== this.deps.runId) return invalid("run_mismatch", "run_id_differs");
    if (parsed.nonceSha256 !== this.nonceHash) return invalid("nonce_mismatch", "nonce_differs");
    if (parsed.heartbeatIntervalMs !== this.deps.timing.heartbeatIntervalMs || parsed.staleAfterMs !== this.deps.timing.staleAfterMs) {
      return invalid("malformed", "timing_differs");
    }
    if (this.pinnedHash === undefined) this.pinnedHash = hash; // the content checked at start
    return undefined;
  }

  poll(): WatchReading {
    if (this.latched !== undefined) return { kind: "determinate", state: this.latched, changed: false };
    const now = this.deps.clock.nowMs();
    const revoked = this.read(() => this.deps.view.readRevoked());
    const leaseJson = this.read(() => this.deps.view.readLeaseJson());
    const heartbeat = this.read(() => this.deps.view.readHeartbeat());

    // The first invalid finding wins; the order below is the order of precedence.
    let found: LeaseState | undefined;
    if (revoked.kind === "ok") found = invalid("revoked", "revoked_file");
    if (leaseJson.kind === "absent") found ??= invalid("missing", "lease_json_absent");
    else if (leaseJson.kind === "ok") found ??= this.judgeLeaseJson(leaseJson.text);

    let changed = false;
    if (heartbeat.kind === "ok") {
      const value = parseCounter(heartbeat.text);
      if (value !== undefined) {
        if (this.counter === undefined) {
          this.counter = value;
          this.changedAt = now;
        } else if (value < this.counter) {
          found ??= invalid("malformed", "counter_decreased");
        } else if (value > this.counter) {
          this.counter = value;
          this.changedAt = now;
          changed = true;
        }
      }
    }
    if (this.counter !== undefined && now - this.changedAt >= this.deps.timing.staleAfterMs) {
      found ??= invalid("heartbeat_stale", "no_counter_change");
    }

    if (found !== undefined) {
      this.latched = found;
      return { kind: "determinate", state: found, changed: false };
    }
    if (revoked.kind === "error" || leaseJson.kind === "error") return { kind: "indeterminate", changed };
    return { kind: "determinate", state: VALID, changed };
  }
}