// Run_Lease types (design: "Run_Lease", "Lease timing", "Runtime-side lease watcher and adapters"; R24.9, R24.12, R24.15; task 2.15).
//
// The runtime can only observe the lease; only the Launcher writes it. Nothing in this package writes the lease directory.

export type LeaseReason = "missing" | "malformed" | "run_mismatch" | "nonce_mismatch" | "revoked" | "heartbeat_stale" | "unreadable";

/**
 * Why a lease is invalid, more finely than the reason. The reason decides what the Run does (design table); the cause
 * keeps apart cases that share a reason, for example a counter that went down and a `lease.json` that was changed.
 */
export type LeaseCause =
  | "lease_json_absent"
  | "lease_json_invalid"
  | "lease_json_changed"
  | "run_id_differs"
  | "nonce_differs"
  | "timing_differs"
  | "revoked_file"
  | "counter_decreased"
  | "no_counter_change"
  | "read_hold_expired";

export type LeaseState =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: LeaseReason; readonly cause?: LeaseCause };

/** The termination reason of a Run whose lease became invalid: only a stale heartbeat means the Launcher was killed (R11.16, R24.12). */
export function terminationReasonOf(state: { readonly reason: LeaseReason }): "launcher_killed" | "lease_unavailable" {
  return state.reason === "heartbeat_stale" ? "launcher_killed" : "lease_unavailable";
}

/** A monotonic clock. The wall clock is never used for the lease (design: "Lease timing"). */
export interface MonotonicClock {
  nowMs(): number;
}

/** Waits. Injected so that tests move a fake clock instead of waiting. */
export interface Sleeper {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** Result of reading one file of the lease directory: ok, absent (the file does not exist), or error (anything else). */
export type ReadResult = { readonly kind: "ok"; readonly text: string } | { readonly kind: "absent" } | { readonly kind: "error" };

/** Read-only view of the lease directory (`lease.json`, `heartbeat`, `revoked`). For `revoked`, `ok` means that it exists. */
export interface LeaseDirView {
  readLeaseJson(): ReadResult;
  readHeartbeat(): ReadResult;
  readRevoked(): ReadResult;
}

/** Why a wait of `RunLease.check` ended early. The caller decides what that means (a time limit, or a stop of the Run). */
export class LeaseCheckInterrupted extends Error {
  readonly why: "aborted" | "deadline";
  constructor(why: "aborted" | "deadline") {
    super(`lease check interrupted: ${why}`);
    this.name = "LeaseCheckInterrupted";
    this.why = why;
  }
}

export interface LeaseCheckOptions {
  readonly signal?: AbortSignal;
  /** A time on the monotonic clock after which a hold on an indeterminate reading is given up (the Experiment time limit, R9.14). */
  readonly deadlineAtMs?: number;
}

/**
 * The runner's view of the Run_Lease. The design names `check(): LeaseState`; the result may be a Promise here because a hold on
 * an indeterminate reading cannot be synchronous. A fake may return the state directly.
 */
export interface LeasePort {
  /** Called before the Run starts and before every request, including reset and preparation. Never returns `valid` before the start-up proof passed. */
  check(options?: LeaseCheckOptions): LeaseState | Promise<LeaseState>;
}