// Lease timing settings and the three rules (task 2.15 to 2.17; design "Lease timing"; R24.12).
import { describe, expect, it } from "vitest";
import { ABORT_BUDGET_MS, DEFAULT_LEASE_SETTINGS, JITTER_ALLOWANCE_MS, checkLeaseTiming, holdLimitOf, watchIntervalOf } from "../src/index.js";

const check = (h: number, s: number, d: number | undefined) => checkLeaseTiming({ heartbeatIntervalMs: h, staleAfterMs: s }, d);

describe("derived values", () => {
  it("P is min(500, H / 2) and U is S / 2", () => {
    expect(watchIntervalOf(1000)).toBe(500);
    expect(watchIntervalOf(500)).toBe(250);
    expect(watchIntervalOf(2000)).toBe(500);
    expect(holdLimitOf(4000)).toBe(2000);
    expect(ABORT_BUDGET_MS).toBe(2000);
    expect(JITTER_ALLOWANCE_MS).toBe(250);
  });
  it("the defaults with a small D are valid and carry every derived value", () => {
    const r = check(DEFAULT_LEASE_SETTINGS.heartbeatIntervalMs, DEFAULT_LEASE_SETTINGS.staleAfterMs, 100);
    expect(r).toEqual({ ok: true, value: { heartbeatIntervalMs: 1000, staleAfterMs: 4000, watchIntervalMs: 500, propagationDelayMs: 100, holdLimitMs: 2000 } });
  });
});

describe("ranges", () => {
  it("H must be 500 to 2000 and S at most 6000", () => {
    expect(check(499, 4000, 0)).toEqual({ ok: false, error: ["heartbeat_interval_out_of_range"] });
    expect(check(2001, 6000, 0)).toEqual({ ok: false, error: ["heartbeat_interval_out_of_range"] });
    expect(check(1000, 6001, 0)).toEqual({ ok: false, error: ["stale_after_out_of_range"] });
    expect(check(500, 1500, 0).ok).toBe(true);
    expect(check(2000, 6000, 0).ok).toBe(true);
  });
  it("refuses values that are not positive safe integers, and a missing or invalid D", () => {
    for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1000" as unknown as number]) {
      expect(check(bad, 4000, 0).ok, String(bad)).toBe(false);
      expect(check(1000, bad, 0).ok, String(bad)).toBe(false);
    }
    expect(check(1000, 4000, undefined)).toEqual({ ok: false, error: ["propagation_delay_unmeasured"] });
    expect(check(1000, 4000, -1).ok).toBe(false);
    expect(check(1000, 4000, Number.NaN).ok).toBe(false);
    expect(checkLeaseTiming(undefined as never, 0).ok).toBe(false);
  });
});

describe("the three rules, with the measured D", () => {
  it("rule 1: S >= 3 H", () => {
    expect(check(1000, 2999, 0)).toEqual({ ok: false, error: ["rule_1_stale_below_three_heartbeats"] });
    expect(check(1000, 3000, 0).ok).toBe(true);
  });
  it("rule 2: S >= H + 2P + D + J, so with the defaults D <= 1750", () => {
    expect(check(1000, 4000, 1750).ok).toBe(true);
    expect(check(1000, 4000, 1751)).toEqual({ ok: false, error: ["rule_2_healthy_launcher_could_be_judged_stale"] });
  });
  it("rule 3: S + P + D + A <= 10000, so with S = 6000 and P = 500, D <= 1500", () => {
    expect(check(2000, 6000, 1500).ok).toBe(true); // 6000 + 500 + 1500 + 2000 = 10000
    expect(check(2000, 6000, 1501)).toEqual({ ok: false, error: ["rule_3_stop_exceeds_ten_seconds"] });
  });
  it("rule 3 boundary", () => {
    // H = 1000, S = 6000, P = 500: rule 3 allows D up to 10000 - 6000 - 500 - 2000 = 1500; rule 2 allows up to 6000 - 1000 - 1000 - 250 = 3750.
    expect(check(1000, 6000, 1500).ok).toBe(true);
    expect(check(1000, 6000, 1501)).toEqual({ ok: false, error: ["rule_3_stop_exceeds_ten_seconds"] });
  });
  it("reports every failed rule", () => {
    const r = check(1000, 3000, 7000);
    expect(r).toEqual({ ok: false, error: ["rule_2_healthy_launcher_could_be_judged_stale", "rule_3_stop_exceeds_ten_seconds"] });
  });
  it("a larger D needs a larger S, and no S can serve a D above the limits (the Launcher then starts no Run)", () => {
    expect(check(1000, 4000, 2000).ok).toBe(false);
    expect(check(1000, 5000, 2000).ok).toBe(true);
    expect(check(1000, 6000, 4000).ok).toBe(false);
  });
});