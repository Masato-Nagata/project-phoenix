// Lease timing settings and the three rules (design: "Lease timing", C8-A to C8-E; R24.12; task 2.15).
import type { Result } from "../policy/types.js";

/** Budget to abort an in-flight request, record it, and exit (A), and allowance for the Launcher's timer jitter (J). Fixed by the design. */
export const ABORT_BUDGET_MS = 2000;
export const JITTER_ALLOWANCE_MS = 250;
export const HEARTBEAT_INTERVAL_RANGE_MS = { min: 500, max: 2000 } as const;
export const STALE_AFTER_MAX_MS = 6000;
export const STOP_LIMIT_MS = 10000;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 1000;
export const DEFAULT_STALE_AFTER_MS = 4000;

export interface LeaseSettings {
  /** H: the Launcher increments the counter at least this often. */
  readonly heartbeatIntervalMs: number;
  /** S: no change of the counter for this long makes the lease stale. */
  readonly staleAfterMs: number;
}

/** The settings with every derived value. Only `checkLeaseTiming` creates one. */
export interface LeaseTiming {
  readonly heartbeatIntervalMs: number;
  readonly staleAfterMs: number;
  /** P: the watch interval, min(500, H / 2). */
  readonly watchIntervalMs: number;
  /** D: the measured propagation delay (task 2.27). */
  readonly propagationDelayMs: number;
  /** U: the hold limit for an indeterminate reading, S / 2. */
  readonly holdLimitMs: number;
}

export const DEFAULT_LEASE_SETTINGS: LeaseSettings = Object.freeze({
  heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
  staleAfterMs: DEFAULT_STALE_AFTER_MS,
});

export const watchIntervalOf = (heartbeatIntervalMs: number): number => Math.min(500, heartbeatIntervalMs / 2);
export const holdLimitOf = (staleAfterMs: number): number => staleAfterMs / 2;

const isMs = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v > 0;

/**
 * Checks the ranges and the three rules with the measured D. A failure refuses the start (`lease_timing_invalid`): the runtime
 * sends no request and writes no Experiment record. The codes are stable and say which rule failed.
 *   1. S >= 3 H
 *   2. S >= H + 2 P + D + J
 *   3. S + P + D + A <= 10000
 */
export function checkLeaseTiming(settings: LeaseSettings, measuredDelayMs: number | undefined): Result<LeaseTiming, string[]> {
  const errors: string[] = [];
  const h = (settings as Partial<LeaseSettings> | undefined)?.heartbeatIntervalMs;
  const s = (settings as Partial<LeaseSettings> | undefined)?.staleAfterMs;
  if (!isMs(h) || h < HEARTBEAT_INTERVAL_RANGE_MS.min || h > HEARTBEAT_INTERVAL_RANGE_MS.max) errors.push("heartbeat_interval_out_of_range");
  if (!isMs(s) || s > STALE_AFTER_MAX_MS) errors.push("stale_after_out_of_range");
  const d = measuredDelayMs;
  if (typeof d !== "number" || !Number.isFinite(d) || d < 0) errors.push("propagation_delay_unmeasured");
  if (errors.length > 0 || !isMs(h) || !isMs(s) || typeof d !== "number") return { ok: false, error: errors };

  const p = watchIntervalOf(h);
  if (s < 3 * h) errors.push("rule_1_stale_below_three_heartbeats");
  if (s < h + 2 * p + d + JITTER_ALLOWANCE_MS) errors.push("rule_2_healthy_launcher_could_be_judged_stale");
  if (s + p + d + ABORT_BUDGET_MS > STOP_LIMIT_MS) errors.push("rule_3_stop_exceeds_ten_seconds");
  if (errors.length > 0) return { ok: false, error: errors };
  return {
    ok: true,
    value: Object.freeze({ heartbeatIntervalMs: h, staleAfterMs: s, watchIntervalMs: p, propagationDelayMs: d, holdLimitMs: holdLimitOf(s) }),
  };
}