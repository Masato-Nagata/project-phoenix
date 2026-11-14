// The probe of task 2.20 (OD-12 option (a)) and its data files: offline, with a fake HTTP port and a fake lease. No real Legacy_App.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PROBE_STATEMENT, evaluateForRecord, loadPolicyConfig, loadPreparationTable, runProbe, validateMaskConfig,
  type Experiment, type HttpRequest, type LeaseState, type ProbeInputs,
} from "../src/index.js";
import { FakeTime } from "./helpers/leaseFixtures.js";
import { FakeHttp, FakeLease, json } from "./helpers/runnerFixtures.js";

const data = (name: string): unknown => JSON.parse(readFileSync(fileURLToPath(new URL(`../data/${name}`, import.meta.url)), "utf8")) as unknown;
const MARKER = "BODY-MARKER-NOT-TO-BE-RECORDED";

function inputs(over: Partial<ProbeInputs> = {}): ProbeInputs {
  return {
    runId: "run-20260101T000000Z-0123456789ab", propagationDelayMs: 100, config: data("probe-config.json"), policy: data("policy-config.json"),
    table: data("preparation-table.json"), mask: data("mask-config.json"), experiments: data("probe-experiments.json"), ...over,
  };
}

function ports(lease = new FakeLease()) {
  const time = new FakeTime();
  const http = new FakeHttp(time, lease);
  http.on((r: HttpRequest) => r.method === "GET" && (r.path === "/products" || r.path === "/orders"), json(200, { success: true, data: [{ name: MARKER, created_at: "x" }] }));
  return { time, http, lease, ports: { http, lease: () => lease, clock: time } };
}

describe("the data files of task 2.20", () => {
  const table = loadPreparationTable(data("preparation-table.json"));
  it("the policy configuration loads with the preparation table and is the design example (R8.1, R8.6)", () => {
    expect(table.ok).toBe(true);
    if (!table.ok) return;
    const policy = loadPolicyConfig(data("policy-config.json"), table.value);
    expect(policy.ok).toBe(true);
    if (!policy.ok) return;
    expect(policy.value.operations.map((o) => `${o.method} ${o.path}`)).toEqual([
      "GET /products", "GET /products/{id}", "GET /orders", "GET /orders/{id}", "POST /orders", "POST /orders/{id}/cancel",
    ]);
    expect(policy.value.limits).toEqual({ requests: 10, stateChecks: 5, preparationSteps: 10, bodyBytes: 8192 });
  });

  it("the mask configuration is valid and names the created_at field of an order and of a list of orders", () => {
    expect(validateMaskConfig(data("mask-config.json"))).toEqual({ ok: true, value: { paths: ["data.created_at", "data[*].created_at"] } });
  });

  it("every accepted probe Experiment is accepted, and every rejected one is rejected with the rule it names", () => {
    if (!table.ok) throw new Error("table");
    const policy = loadPolicyConfig(data("policy-config.json"), table.value);
    if (!policy.ok) throw new Error("policy");
    const ex = data("probe-experiments.json") as { accepted: Experiment[]; rejected: { rule: string; experiment: Experiment }[] };
    for (const e of ex.accepted) expect(evaluateForRecord(e, policy.value), e.experimentId).toMatchObject({ decision: "accept", ruleIds: [] });
    for (const r of ex.rejected) {
      const p = evaluateForRecord(r.experiment, policy.value);
      expect(p.decision, r.experiment.experimentId).toBe("reject");
      expect(p.ruleIds, r.experiment.experimentId).toContain(r.rule);
    }
    expect(new Set(ex.rejected.map((r) => r.rule)).size).toBe(ex.rejected.length);
  });

  it("the probe configuration uses the internal address and the lease settings of the Launcher (H 1000, S 4000)", () => {
    expect(data("probe-config.json")).toMatchObject({ baseAddress: "http://reverse-proxy:8080", lease: { heartbeatIntervalMs: 1000, staleAfterMs: 4000 } });
  });
});

describe("runProbe", () => {
  it("executes the accepted Experiments with a reset first, sends nothing for the rejected ones, and records no response body", async () => {
    const { http, ports: p } = ports();
    const { result, exitCode } = await runProbe(inputs(), p);
    expect(exitCode).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.statement).toBe(PROBE_STATEMENT);
    const accepted = result.experiments.filter((e) => e.expected === "accept");
    expect(accepted.map((e) => [e.experimentId, e.outcome])).toEqual([["probe-read-products", "executed"], ["probe-read-orders", "executed"]]);
    const rejected = result.experiments.filter((e) => e.expected === "reject");
    expect(rejected.length).toBe(9);
    for (const r of rejected) expect(r, r.experimentId).toMatchObject({ decision: "reject", outcome: "not_executed", reason: "policy_not_accepted", requestsSent: 0, expectationMet: true });
    expect(http.seen).toEqual(["GET /health", "POST /reset", "GET /products", "POST /reset", "GET /orders", "GET /products"]);
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(result.totalRequests).toBe(6);
  });

  it("refuses before any request when the measured delay is missing or breaks a rule", async () => {
    for (const d of [undefined, 5000]) {
      const { http, ports: p } = ports();
      const { result, exitCode } = await runProbe(inputs({ propagationDelayMs: d }), p);
      expect(exitCode).toBe(2);
      expect(result.stoppedAt).toMatch(/^lease_timing_invalid/);
      expect(http.calls).toEqual([]);
    }
  });

  it("refuses before any request for invalid data", async () => {
    for (const over of [{ config: {} }, { experiments: [] }, { policy: { schemaVersion: 2 } }, { table: {} }, { mask: { paths: ["$status"] } }, { config: { ...(data("probe-config.json") as object), baseAddress: "http://127.0.0.1:9" } }] as Partial<ProbeInputs>[]) {
      const { http, ports: p } = ports();
      const { exitCode } = await runProbe(inputs(over), p);
      expect(exitCode, JSON.stringify(over).slice(0, 80)).toBe(2);
      expect(http.calls).toEqual([]);
    }
  });

  it("a lease that is not valid at the start sends nothing (the start-up proof comes first)", async () => {
    const lease = new FakeLease();
    lease.script = () => ({ valid: false, reason: "heartbeat_stale" } as LeaseState);
    const { http, ports: p } = ports(lease);
    const { result, exitCode } = await runProbe(inputs(), p);
    expect(exitCode).toBe(2);
    expect(result.stoppedAt).toBe("health");
    expect(http.calls).toEqual([]);
  });

  it("a lease that becomes invalid stops the probe; nothing is sent after it", async () => {
    const lease = new FakeLease();
    const { http, ports: p } = ports(lease);
    lease.script = () => (http.calls.length >= 3 ? { valid: false, reason: "revoked" } : { valid: true });
    const { result, exitCode } = await runProbe(inputs(), p);
    expect(exitCode).toBe(1);
    expect(result.ok).toBe(false);
    // The lease is still valid when GET /products is sent (the third call), so that Experiment completes; the lease check before the
    // next request (the reset of probe-read-orders) fails, and nothing more is sent.
    expect(result.experiments.map((e) => [e.experimentId, e.outcome])).toEqual([["probe-read-products", "executed"], ["probe-read-orders", "not_executed"]]);
    expect(result.stoppedAt).toBe("experiment:probe-read-orders:lease_unavailable");
    expect(http.calls.length).toBe(3);
  });

  it("an unhealthy Legacy_App executes nothing", async () => {
    const { http, ports: p } = ports();
    http.on((r) => r.path === "/health", json(503, { success: true, data: { db: "error" } }));
    http.overrides.unshift(http.overrides.pop() as never);
    const { result, exitCode } = await runProbe(inputs(), p);
    expect(exitCode).toBe(1);
    expect(result.stoppedAt).toBe("health");
    expect(http.seen).toEqual(["GET /health"]);
  });
});