// Task 4.1, stage B: `checkStartupRefusals` with FAKE ports (design: "Stage B contract"). Synthetic data only. Assertions compare codes, check ids,
// names, call counts and object identity; the canary of every test is a string that must never appear in a result.
import { describe, expect, it } from "vitest";
import {
  STARTUP_CHECK_ORDER,
  STARTUP_NAME_VOCABULARY,
  STARTUP_REFUSAL_CODES,
  checkStartupRefusals,
  isValidatedRunConfig,
  validateRunConfig,
  type RunConfig,
  type StartupRefusal,
} from "../src/index.js";
import { isStartupApproval } from "../src/config/startup.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const CANARY = "CANARY_5e2a_SECRET";
const H64 = (c: string): string => c.repeat(64);

const config = (over: Record<string, unknown> = {}): RunConfig => {
  const r = validateRunConfig({
    schemaVersion: 1, provider: "mock", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames: ["EXAMPLE_ONE", "EXAMPLE_TWO"], ...over,
  });
  if (!r.ok) throw new Error(`the test configuration is invalid: ${JSON.stringify(r.error)}`);
  return r.value;
};
const kiro = (over: Record<string, unknown> = {}): RunConfig => config({ provider: "kiro-cli", ...over });

type Impl = (...args: Any[]) => unknown;
class LeaseInstance {
  checks = 0;
}
function fake(over: Record<string, Impl> = {}) {
  const calls = { order: [] as string[], n: {} as Record<string, number> };
  const objects = {
    policy: { kind: "policy", nested: { a: [1, 2] } },
    table: { kind: "table" },
    audit: { ok: true, config: { kind: "audit", list: ["x"] }, sha256: H64("c") },
    lease: new LeaseInstance(),
    limits: { requests: 10, bodyBytes: 8192 },
    referenced: [] as { name: string; set: boolean }[],
    destinations: ["relay.example.invalid"],
  };
  const impl: Record<string, Impl> = {
    "policy.load": () => ({ ok: true, policy: objects.policy, table: objects.table, limits: objects.limits, policySha256: H64("a"), preparationTableSha256: H64("b") }),
    "auditConfig.load": () => ({ ok: true, load: objects.audit, sha256: H64("c") }),
    "env.credentials": () => ({ ok: true, referenced: objects.referenced }),
    "env.isSet": () => true,
    "sandbox.providerAvailable": () => true,
    "sandbox.destinations": () => objects.destinations,
    "lease.variables": () => ({ runId: true, nonce: true }),
    "lease.timing": () => ({ ok: true, heartbeatIntervalMs: 1000, staleAfterMs: 4000, propagationDelayMs: 123 }),
    "lease.port": () => objects.lease,
    "lease.check": () => Promise.resolve({ valid: true }),
    "io.runVolume": () => ({ exists: true, writable: true, empty: true }),
    "io.configFiles": () => ["run-config.json", "audit-config.json"],
  };
  const call = (key: string, ...args: Any[]): unknown => {
    calls.order.push(key);
    calls.n[key] = (calls.n[key] ?? 0) + 1;
    return (over[key] ?? impl[key] as Impl)(...args);
  };
  const ports: Any = {
    policy: { load: () => call("policy.load") },
    auditConfig: { load: () => call("auditConfig.load") },
    env: { isSet: (n: string) => call("env.isSet", n), credentials: (p: string) => call("env.credentials", p) },
    sandbox: { providerAvailable: (p: string) => call("sandbox.providerAvailable", p), destinations: () => call("sandbox.destinations") },
    lease: { variables: () => call("lease.variables"), timing: () => call("lease.timing"), port: () => call("lease.port"), check: () => call("lease.check") },
    io: { runVolume: () => call("io.runVolume"), configFiles: () => call("io.configFiles") },
  };
  return { ports, calls, objects };
}

const refusalsOf = async (cfg: RunConfig, ports: Any): Promise<StartupRefusal[]> => {
  const r = await checkStartupRefusals(cfg, ports);
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};
const approvalOf = async (cfg: RunConfig, ports: Any): Promise<Any> => {
  const r = await checkStartupRefusals(cfg, ports);
  if (!r.ok) throw new Error(`expected an approval, got ${JSON.stringify(r.error)}`);
  return r.value;
};
/** One refusal exactly. `proofCalls` is how often the lease proof ran: 0 for every refusal before it, 1 when the proof itself is what refused. */
const one = async (over: Record<string, Impl>, code: string, check: string, name?: string, cfg: RunConfig = config(), proofCalls = 0): Promise<void> => {
  const f = fake(over);
  expect(await refusalsOf(cfg, f.ports)).toEqual([name === undefined ? { code, check } : { code, check, name }]);
  expect(f.calls.n["lease.check"] ?? 0).toBe(proofCalls); // a refused Run never waits for the lease proof
};
const delayed = <T>(v: T, ms: number): Promise<T> => new Promise((resolve) => setTimeout(() => resolve(v), ms));

describe("the list of codes and checks", () => {
  it("has 23 distinct codes and the 7 checks in the fixed order", () => {
    expect(STARTUP_REFUSAL_CODES).toHaveLength(23);
    expect(new Set(STARTUP_REFUSAL_CODES).size).toBe(23);
    expect([...STARTUP_CHECK_ORDER]).toEqual(["config", "policy", "auditConfig", "env", "sandbox", "lease", "io"]);
    expect([...STARTUP_REFUSAL_CODES]).toEqual([
      "config_not_validated", "policy_unavailable", "policy_invalid", "preparation_table_invalid", "above_policy_limit", "audit_config_missing", "audit_config_empty",
      "audit_config_unreadable", "audit_config_invalid", "credential_unset", "provider_unknown", "provider_not_available", "sandbox_destinations_undetermined",
      "lease_env_missing", "lease_timing_invalid", "lease_invalid", "lease_check_failed", "run_volume_missing", "run_volume_not_writable", "run_volume_not_empty",
      "config_files_unexpected", "io_unreadable", "port_failed",
    ]);
  });
});

describe("group 10: a configuration that stage A did not return is refused", () => {
  it("accepts the object that validateRunConfig returned", async () => {
    const cfg = config();
    expect(isValidatedRunConfig(cfg)).toBe(true);
    const f = fake();
    expect((await checkStartupRefusals(cfg, f.ports)).ok).toBe(true);
  });
  it("refuses the input, a copy, a JSON round trip, a structured clone, a look-alike, a prototype child and a Proxy, and calls no port", async () => {
    const input = { schemaVersion: 1, provider: "mock", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames: [] };
    const valid = config();
    const fakes: Any[] = [
      input, { ...valid }, JSON.parse(JSON.stringify(valid)), structuredClone(valid), Object.freeze({ ...valid }), Object.create(valid), new Proxy(valid, {}),
      Object.freeze({ ...valid, limits: Object.freeze({ ...valid.limits }) }), null, undefined, 42, "x", [], {},
    ];
    for (const bad of fakes) {
      expect(isValidatedRunConfig(bad)).toBe(false);
      const f = fake();
      expect(await refusalsOf(bad, f.ports)).toEqual([{ code: "config_not_validated", check: "config" }]);
      expect(f.calls.order).toEqual([]);
    }
  });
  it("stage A registers every returned configuration, and a refused input is never registered", () => {
    const r1 = validateRunConfig({ schemaVersion: 1, provider: "mock", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames: [] });
    const r2 = validateRunConfig({ schemaVersion: 1 });
    expect(r1.ok && isValidatedRunConfig(r1.value)).toBe(true);
    expect(r2.ok).toBe(false);
    expect(isValidatedRunConfig(r2.ok ? r2.value : r2.error)).toBe(false);
  });
});

describe("group 1: a passing run, and one case per refusal code", () => {
  it("issues an approval that carries only validated data", async () => {
    const cfg = config();
    const f = fake();
    const a = await approvalOf(cfg, f.ports);
    expect(isStartupApproval(a)).toBe(true);
    expect(a.config).toBe(cfg);
    expect(a.payloadAuditConfig).toBe("pass");
    expect(a.policy).toEqual({ value: f.objects.policy, table: f.objects.table, limits: { requests: 10, bodyBytes: 8192 }, policySha256: H64("a"), preparationTableSha256: H64("b") });
    expect(a.auditConfig).toEqual({ load: f.objects.audit, sha256: H64("c") });
    expect(a.envVarsRead).toEqual([{ name: "EXAMPLE_ONE", set: true }, { name: "EXAMPLE_TWO", set: true }]);
    expect(a.credentials).toEqual([]);
    expect(a.sandbox).toEqual({ applicable: false });
    expect(a.lease).toEqual({ port: f.objects.lease, heartbeatIntervalMs: 1000, staleAfterMs: 4000, propagationDelayMs: 123, proven: true });
    expect(Object.keys(a).sort()).toEqual(["auditConfig", "config", "credentials", "envVarsRead", "lease", "payloadAuditConfig", "policy", "sandbox"]);
  });

  describe("policy", () => {
    for (const [code, check] of [["unavailable", "policy_unavailable"], ["invalid", "policy_invalid"], ["table_invalid", "preparation_table_invalid"]] as const) {
      it(`${code} gives ${check}`, () => one({ "policy.load": () => ({ ok: false, code }) }, check, "policy"));
    }
    it("an equal limit passes; a larger one is above_policy_limit with the pointer as the name", async () => {
      const narrow = (requests: number, bodyBytes: number): Record<string, Impl> => ({
        "policy.load": () => ({ ok: true, policy: {}, table: {}, limits: { requests, bodyBytes }, policySha256: H64("a"), preparationTableSha256: H64("b") }),
      });
      const cfg = config({ limits: { requestsPerExperiment: 6, requestBodyBytes: 4096 } });
      expect((await checkStartupRefusals(cfg, fake(narrow(6, 4096)).ports)).ok).toBe(true);
      await one(narrow(5, 4096), "above_policy_limit", "policy", "/limits/requestsPerExperiment", cfg);
      await one(narrow(6, 4095), "above_policy_limit", "policy", "/limits/requestBodyBytes", cfg);
      expect(await refusalsOf(cfg, fake(narrow(5, 4095)).ports)).toEqual([
        { code: "above_policy_limit", check: "policy", name: "/limits/requestBodyBytes" },
        { code: "above_policy_limit", check: "policy", name: "/limits/requestsPerExperiment" },
      ]);
    });
    it("uses the EFFECTIVE values: a default above a narrowed policy is refused although the key was absent", async () => {
      await one({ "policy.load": () => ({ ok: true, policy: {}, table: {}, limits: { requests: 9, bodyBytes: 8192 }, policySha256: H64("a"), preparationTableSha256: H64("b") }) },
        "above_policy_limit", "policy", "/limits/requestsPerExperiment");
    });
  });

  describe("audit configuration", () => {
    for (const [reason, code] of [["missing", "audit_config_missing"], ["empty", "audit_config_empty"], ["unreadable", "audit_config_unreadable"]] as const) {
      it(`${reason} gives ${code}`, () => one({ "auditConfig.load": () => ({ ok: false, reason }) }, code, "auditConfig"));
    }
    for (const detail of STARTUP_NAME_VOCABULARY.auditDetails) {
      it(`invalid with the detail ${detail} names it`, () => one({ "auditConfig.load": () => ({ ok: false, reason: "invalid", detail }) }, "audit_config_invalid", "auditConfig", detail));
    }
    it("invalid with no detail or an unknown detail gives no name, and never the text of the detail", async () => {
      await one({ "auditConfig.load": () => ({ ok: false, reason: "invalid" }) }, "audit_config_invalid", "auditConfig");
      await one({ "auditConfig.load": () => ({ ok: false, reason: "invalid", detail: CANARY }) }, "audit_config_invalid", "auditConfig");
      const f = fake({ "auditConfig.load": () => ({ ok: false, reason: "invalid", detail: CANARY }) });
      expect(JSON.stringify(await refusalsOf(config(), f.ports))).not.toContain(CANARY);
    });
  });

  describe("env", () => {
    it("credential_unset names the variable and never a value; an invalid-looking name is dropped", async () => {
      await one({ "env.credentials": () => ({ ok: false, code: "credential_unset", variable: "KIRO_API_KEY" }) }, "credential_unset", "env", "KIRO_API_KEY", kiro());
      await one({ "env.credentials": () => ({ ok: false, code: "credential_unset", variable: CANARY.toLowerCase() }) }, "credential_unset", "env", undefined, kiro());
      await one({ "env.credentials": () => ({ ok: false, code: "credential_unset" }) }, "credential_unset", "env", undefined, kiro());
    });
    it("provider_unknown", () => one({ "env.credentials": () => ({ ok: false, code: "unknown_provider" }) }, "provider_unknown", "env"));
    it("records the set or unset flag of every distinct name, in the order of envNames, then the credentials", async () => {
      const f = fake({
        "env.isSet": (n: string) => n === "EXAMPLE_TWO",
        "env.credentials": () => ({ ok: true, referenced: [{ name: "KIRO_API_KEY", set: true }, { name: "EXAMPLE_ONE", set: true }] }),
      });
      const a = await approvalOf(config({ envNames: ["EXAMPLE_ONE", "EXAMPLE_TWO", "EXAMPLE_ONE"] }), f.ports);
      expect(a.envVarsRead).toEqual([{ name: "EXAMPLE_ONE", set: false }, { name: "EXAMPLE_TWO", set: true }, { name: "KIRO_API_KEY", set: true }]);
      expect(a.credentials).toEqual([{ name: "KIRO_API_KEY", set: true }, { name: "EXAMPLE_ONE", set: true }]);
      expect(f.calls.n["env.isSet"]).toBe(2); // once per distinct name
    });
  });

  describe("sandbox", () => {
    it("mock: the sandbox port is never called and the approval says not applicable", async () => {
      const f = fake({ "sandbox.providerAvailable": () => { throw new Error("must not be called"); }, "sandbox.destinations": () => { throw new Error("must not be called"); } });
      const a = await approvalOf(config(), f.ports);
      expect(a.sandbox).toEqual({ applicable: false });
      expect(f.calls.n["sandbox.providerAvailable"]).toBeUndefined();
      expect(f.calls.n["sandbox.destinations"]).toBeUndefined();
    });
    it("kiro-cli: a provider without a factory is provider_not_available", () =>
      one({ "sandbox.providerAvailable": () => false }, "provider_not_available", "sandbox", undefined, kiro()));
    it("kiro-cli: no destination list, or an empty one, is sandbox_destinations_undetermined (R18.9)", async () => {
      await one({ "sandbox.destinations": () => undefined }, "sandbox_destinations_undetermined", "sandbox", undefined, kiro());
      await one({ "sandbox.destinations": () => [] }, "sandbox_destinations_undetermined", "sandbox", undefined, kiro());
    });
    it("kiro-cli: both refusals are reported together, and a passing run records a frozen copy of the destinations", async () => {
      const both = fake({ "sandbox.providerAvailable": () => false, "sandbox.destinations": () => undefined });
      expect((await refusalsOf(kiro(), both.ports)).map((r) => r.code)).toEqual(["provider_not_available", "sandbox_destinations_undetermined"]);
      const f = fake();
      const a = await approvalOf(kiro(), f.ports);
      expect(a.sandbox).toEqual({ applicable: true, destinations: ["relay.example.invalid"] });
      expect(a.sandbox.destinations).not.toBe(f.objects.destinations);
      expect(Object.isFrozen(a.sandbox.destinations)).toBe(true);
    });
  });

  describe("lease (static part)", () => {
    it("lease_env_missing names each missing variable", async () => {
      await one({ "lease.variables": () => ({ runId: false, nonce: true }) }, "lease_env_missing", "lease", "PHOENIX_RUN_ID");
      await one({ "lease.variables": () => ({ runId: true, nonce: false }) }, "lease_env_missing", "lease", "PHOENIX_LEASE_NONCE");
      const both = fake({ "lease.variables": () => ({ runId: false, nonce: false }) });
      expect((await refusalsOf(config(), both.ports)).map((r) => r.name)).toEqual(["PHOENIX_LEASE_NONCE", "PHOENIX_RUN_ID"]);
    });
    for (const rule of STARTUP_NAME_VOCABULARY.leaseTimingRules) {
      it(`lease_timing_invalid names ${rule}`, () => one({ "lease.timing": () => ({ ok: false, errors: [rule] }) }, "lease_timing_invalid", "lease", rule));
    }
    it("an unknown or empty error list gives one refusal without a name, and never the text", async () => {
      await one({ "lease.timing": () => ({ ok: false, errors: [CANARY] }) }, "lease_timing_invalid", "lease");
      await one({ "lease.timing": () => ({ ok: false, errors: [] }) }, "lease_timing_invalid", "lease");
    });
  });

  describe("io", () => {
    it("run_volume_missing", () => one({ "io.runVolume": () => ({ exists: false, writable: false, empty: false }) }, "run_volume_missing", "io"));
    it("run_volume_not_writable and run_volume_not_empty, separately and together", async () => {
      await one({ "io.runVolume": () => ({ exists: true, writable: false, empty: true }) }, "run_volume_not_writable", "io");
      await one({ "io.runVolume": () => ({ exists: true, writable: true, empty: false }) }, "run_volume_not_empty", "io");
      const both = fake({ "io.runVolume": () => ({ exists: true, writable: false, empty: false }) });
      expect((await refusalsOf(config(), both.ports)).map((r) => r.code)).toEqual(["run_volume_not_empty", "run_volume_not_writable"]);
    });
    it("config_files_unexpected for a missing, an extra and a repeated file, and no file name is echoed", async () => {
      for (const files of [["run-config.json"], ["audit-config.json"], [], ["run-config.json", "audit-config.json", CANARY], ["run-config.json", "run-config.json", "audit-config.json"], [CANARY, "run-config.json"]]) {
        const f = fake({ "io.configFiles": () => files });
        const r = await refusalsOf(config(), f.ports);
        expect(r).toEqual([{ code: "config_files_unexpected", check: "io" }]);
        expect(JSON.stringify(r)).not.toContain(CANARY);
      }
    });
    it("io_unreadable when a location cannot be read", async () => {
      await one({ "io.runVolume": () => undefined }, "io_unreadable", "io");
      await one({ "io.configFiles": () => undefined }, "io_unreadable", "io");
    });
  });
});

describe("group 4: the lease start-up proof", () => {
  it("runs exactly once, last, and only when nothing else was refused", async () => {
    const f = fake();
    await approvalOf(config(), f.ports);
    expect(f.calls.n["lease.check"]).toBe(1);
    expect(f.calls.n["lease.port"]).toBe(1);
    expect(f.calls.order.slice(-2)).toEqual(["lease.port", "lease.check"]);
    expect(f.calls.order.indexOf("io.configFiles")).toBeLessThan(f.calls.order.indexOf("lease.check"));
  });
  it("is not started, and the lease instance is not even fetched, for any other refusal (spy count 0)", async () => {
    const refusing: Record<string, Impl>[] = [
      { "policy.load": () => ({ ok: false, code: "invalid" }) },
      { "auditConfig.load": () => ({ ok: false, reason: "missing" }) },
      { "env.credentials": () => ({ ok: false, code: "credential_unset", variable: "KIRO_API_KEY" }) },
      { "lease.variables": () => ({ runId: false, nonce: true }) },
      { "lease.timing": () => ({ ok: false, errors: ["propagation_delay_unmeasured"] }) },
      { "io.runVolume": () => ({ exists: true, writable: true, empty: false }) },
      { "io.configFiles": () => [] },
      { "policy.load": () => { throw new Error("x"); } },
    ];
    for (const over of refusing) {
      const f = fake(over);
      await refusalsOf(config(), f.ports);
      expect(f.calls.n["lease.check"] ?? 0).toBe(0);
      expect(f.calls.n["lease.port"] ?? 0).toBe(0);
    }
    const k = fake({ "sandbox.providerAvailable": () => false });
    await refusalsOf(kiro(), k.ports);
    expect(k.calls.n["lease.check"] ?? 0).toBe(0);
  });
  it("maps every LeaseReason to lease_invalid with the reason as the name", async () => {
    for (const reason of STARTUP_NAME_VOCABULARY.leaseReasons) {
      await one({ "lease.check": () => Promise.resolve({ valid: false, reason }) }, "lease_invalid", "lease", reason, config(), 1);
    }
  });
  it("an unknown reason gives lease_invalid without a name", () => one({ "lease.check": () => Promise.resolve({ valid: false, reason: CANARY }) }, "lease_invalid", "lease", undefined, config(), 1));
  it("a thrown error or a rejection of check() is lease_check_failed (including LeaseCheckInterrupted), and the message is dropped", async () => {
    class Interrupted extends Error { readonly why = "deadline"; }
    for (const throwing of [() => { throw new Interrupted(CANARY); }, () => Promise.reject(new Interrupted(CANARY)), () => { throw CANARY; }, () => Promise.reject(CANARY)]) {
      const f = fake({ "lease.check": throwing });
      const r = await refusalsOf(config(), f.ports);
      expect(r).toEqual([{ code: "lease_check_failed", check: "lease" }]);
      expect(JSON.stringify(r)).not.toContain(CANARY);
      expect(f.calls.n["lease.check"]).toBe(1);
    }
  });
  it("an unexpected answer of check() is port_failed; a failing port() means check() is never called", async () => {
    for (const bad of [undefined, null, 42, "x", {}, { valid: "yes" }]) {
      const f = fake({ "lease.check": () => Promise.resolve(bad) });
      expect(await refusalsOf(config(), f.ports)).toEqual([{ code: "port_failed", check: "lease" }]);
    }
    for (const portAnswer of [() => { throw new Error(CANARY); }, () => undefined, () => null]) {
      const f = fake({ "lease.port": portAnswer });
      expect(await refusalsOf(config(), f.ports)).toEqual([{ code: "port_failed", check: "lease" }]);
      expect(f.calls.n["lease.check"] ?? 0).toBe(0);
    }
  });
  it("the approval carries the very lease instance whose proof passed (identity, not a copy) and does not freeze it", async () => {
    const f = fake();
    const a = await approvalOf(config(), f.ports);
    expect(a.lease.port).toBe(f.objects.lease);
    expect(Object.isFrozen(f.objects.lease)).toBe(false);
    expect(a.lease.proven).toBe(true);
    f.objects.lease.checks += 1; // the Runner may keep using the instance
    expect(f.objects.lease.checks).toBe(1);
  });
});

describe("group 2: several refusals, in the fixed order, deterministically", () => {
  const everythingWrong = (): Record<string, Impl> => ({
    "policy.load": () => ({ ok: false, code: "invalid" }),
    "auditConfig.load": () => ({ ok: false, reason: "invalid", detail: "fingerprints" }),
    "env.credentials": () => ({ ok: false, code: "credential_unset", variable: "KIRO_API_KEY" }),
    "sandbox.providerAvailable": () => false,
    "sandbox.destinations": () => undefined,
    "lease.variables": () => ({ runId: false, nonce: false }),
    "lease.timing": () => ({ ok: false, errors: ["rule_3_stop_exceeds_ten_seconds", "heartbeat_interval_out_of_range"] }),
    "io.runVolume": () => ({ exists: true, writable: false, empty: false }),
    "io.configFiles": () => [],
  });
  const expected: StartupRefusal[] = [
    { code: "policy_invalid", check: "policy" },
    { code: "audit_config_invalid", check: "auditConfig", name: "fingerprints" },
    { code: "credential_unset", check: "env", name: "KIRO_API_KEY" },
    { code: "provider_not_available", check: "sandbox" },
    { code: "sandbox_destinations_undetermined", check: "sandbox" },
    { code: "lease_env_missing", check: "lease", name: "PHOENIX_LEASE_NONCE" },
    { code: "lease_env_missing", check: "lease", name: "PHOENIX_RUN_ID" },
    { code: "lease_timing_invalid", check: "lease", name: "heartbeat_interval_out_of_range" },
    { code: "lease_timing_invalid", check: "lease", name: "rule_3_stop_exceeds_ten_seconds" },
    { code: "config_files_unexpected", check: "io" },
    { code: "run_volume_not_empty", check: "io" },
    { code: "run_volume_not_writable", check: "io" },
  ];
  it("reports every independent refusal, sorted by check order, code and name", async () => {
    const f = fake(everythingWrong());
    expect(await refusalsOf(kiro(), f.ports)).toEqual(expected);
    expect(f.calls.n["lease.check"] ?? 0).toBe(0);
  });
  it("does not depend on the speed or the style (sync, async, delayed) of the ports", async () => {
    const wrap = (impls: Record<string, Impl>, style: "sync" | "async" | "random"): Record<string, Impl> => {
      let seed = 7;
      const rnd = (): number => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % 12; };
      return Object.fromEntries(Object.entries(impls).map(([k, fn]) => [k, (...a: Any[]) => {
        const v = fn(...a);
        return style === "sync" ? v : style === "async" ? Promise.resolve(v) : delayed(v, rnd());
      }]));
    };
    const results: string[] = [];
    for (const style of ["sync", "async", "random"] as const) {
      const f = fake(wrap(everythingWrong(), style));
      results.push(JSON.stringify(await refusalsOf(kiro(), f.ports)));
    }
    expect(new Set(results).size).toBe(1);
    expect(JSON.parse(results[0] as string)).toEqual(expected);
  });
  it("calls the ports in the fixed order, one call each (env.isSet once per distinct name)", async () => {
    const f = fake();
    await approvalOf(config(), f.ports);
    expect(f.calls.order).toEqual([
      "policy.load", "auditConfig.load", "env.credentials", "env.isSet", "env.isSet", "lease.variables", "lease.timing", "io.runVolume", "io.configFiles", "lease.port", "lease.check",
    ]);
    const k = fake();
    await approvalOf(kiro(), k.ports);
    expect(k.calls.order).toEqual([
      "policy.load", "auditConfig.load", "env.credentials", "env.isSet", "env.isSet", "sandbox.providerAvailable", "sandbox.destinations", "lease.variables", "lease.timing",
      "io.runVolume", "io.configFiles", "lease.port", "lease.check",
    ]);
  });
  it("skips a check whose precondition failed without a second refusal (no limit comparison without a policy)", async () => {
    const f = fake({ "policy.load": () => ({ ok: false, code: "unavailable" }) });
    expect(await refusalsOf(config({ limits: { requestsPerExperiment: 10 } }), f.ports)).toEqual([{ code: "policy_unavailable", check: "policy" }]);
  });
  it("a run that is refused twice gives the same list both times, and every refusal is frozen", async () => {
    const a = await refusalsOf(kiro(), fake(everythingWrong()).ports);
    const b = await refusalsOf(kiro(), fake(everythingWrong()).ports);
    expect(b).toEqual(a);
    for (const r of a) expect(Object.isFrozen(r)).toBe(true);
  });
});

describe("group 3: ports that fail, and the canary that must not leak", () => {
  const throwers: [string, () => unknown][] = [
    ["an Error with the canary as its message", () => { throw new Error(CANARY); }],
    ["a string", () => { throw CANARY; }],
    ["an object with a message", () => { throw { message: CANARY, stack: CANARY }; }],
    ["a rejected Error", () => Promise.reject(new Error(CANARY))],
    ["a rejected string", () => Promise.reject(CANARY)],
  ];
  // [method, check, config, shapes that are NOT valid answers]
  const methods: [string, string, () => RunConfig, unknown[]][] = [
    ["policy.load", "policy", config, [undefined, null, 42, "x", {}, { ok: true }, { ok: false }, { ok: false, code: "other" }, { ok: true, policy: {}, table: {}, limits: { requests: 0, bodyBytes: 1 }, policySha256: H64("a"), preparationTableSha256: H64("b") }, { ok: true, policy: {}, table: {}, limits: { requests: 1, bodyBytes: 1 }, policySha256: "x", preparationTableSha256: H64("b") }, { ok: true, policy: null, table: {}, limits: { requests: 1, bodyBytes: 1 }, policySha256: H64("a"), preparationTableSha256: H64("b") }]],
    ["auditConfig.load", "auditConfig", config, [undefined, null, 42, {}, { ok: true }, { ok: true, load: {}, sha256: "x" }, { ok: true, load: 1, sha256: H64("c") }, { ok: false, reason: "other" }, { ok: false }]],
    ["env.credentials", "env", config, [undefined, null, 42, {}, { ok: true }, { ok: true, referenced: [{ name: "A", set: false }] }, { ok: true, referenced: [1] }, { ok: true, referenced: [{ name: "bad name", set: true }] }, { ok: false, code: "other" }]],
    ["env.isSet", "env", config, ["yes", 1, undefined, null]],
    ["sandbox.providerAvailable", "sandbox", kiro, ["yes", 1, undefined, null]],
    ["sandbox.destinations", "sandbox", kiro, [42, "x", {}, null, [1], [""], ["a".repeat(256)]]],
    ["lease.variables", "lease", config, [undefined, null, 42, {}, { runId: "yes", nonce: true }]],
    ["lease.timing", "lease", config, [undefined, null, 42, {}, { ok: true }, { ok: true, heartbeatIntervalMs: 0, staleAfterMs: 4000, propagationDelayMs: 1 }, { ok: true, heartbeatIntervalMs: 1000, staleAfterMs: 4000, propagationDelayMs: -1 }, { ok: false, errors: "x" }]],
    ["io.runVolume", "io", config, [null, 42, "x", {}, { exists: "y", writable: true, empty: true }]],
    ["io.configFiles", "io", config, [null, 42, "x", {}, [1]]],
  ];
  for (const [method, check, cfgOf, shapes] of methods) {
    it(`${method}: every failure mode gives one port_failed for ${check} and nothing of the exception leaks`, async () => {
      for (const [, thrower] of throwers) {
        const f = fake({ [method]: thrower });
        const r = await refusalsOf(cfgOf(), f.ports);
        expect(r, method).toEqual([{ code: "port_failed", check }]);
        expect(JSON.stringify(r)).not.toContain(CANARY);
        expect(f.calls.n["lease.check"] ?? 0).toBe(0);
      }
      for (const bad of shapes) {
        const f = fake({ [method]: () => bad });
        const r = await refusalsOf(cfgOf(), f.ports);
        expect(r, `${method} ${JSON.stringify(bad)}`).toEqual([{ code: "port_failed", check }]);
        expect(f.calls.n["lease.check"] ?? 0).toBe(0);
      }
    });
  }
  it("a returned object whose property throws, or a Proxy that throws, is port_failed and its message is dropped", async () => {
    const evil = { get ok(): boolean { throw new Error(CANARY); } };
    const proxy = new Proxy({}, { get() { throw new Error(CANARY); }, has() { throw new Error(CANARY); } });
    for (const bad of [evil, proxy]) {
      const f = fake({ "policy.load": () => bad });
      const r = await refusalsOf(config(), f.ports);
      expect(r).toEqual([{ code: "port_failed", check: "policy" }]);
      expect(JSON.stringify(r)).not.toContain(CANARY);
    }
  });
  it("a missing port is port_failed for its check; a missing sandbox port matters only for kiro-cli", async () => {
    for (const [name, check] of [["policy", "policy"], ["auditConfig", "auditConfig"], ["env", "env"], ["lease", "lease"], ["io", "io"]] as const) {
      const f = fake();
      f.ports[name] = undefined;
      expect(await refusalsOf(config(), f.ports)).toEqual([{ code: "port_failed", check }]);
    }
    const noSandbox = fake();
    noSandbox.ports.sandbox = undefined;
    expect((await checkStartupRefusals(config(), noSandbox.ports)).ok).toBe(true);
    const k = fake();
    k.ports.sandbox = undefined;
    expect(await refusalsOf(kiro(), k.ports)).toEqual([{ code: "port_failed", check: "sandbox" }]);
  });
  it("never throws or rejects, whatever the ports object is", async () => {
    const hostile = new Proxy({}, { get() { throw new Error(CANARY); } });
    for (const ports of [undefined, null, 42, "x", {}, [], hostile]) {
      const r = await checkStartupRefusals(config(), ports as Any);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(CANARY);
    }
    expect((await checkStartupRefusals(undefined as Any, undefined as Any)).ok).toBe(false);
  });
  it("a credential secret in the environment never reaches a refusal or an approval", async () => {
    const SECRET = "SYNTHETIC-SECRET-VALUE-0001";
    const env: Record<string, string> = { KIRO_API_KEY: SECRET, EXAMPLE_ONE: SECRET };
    const f = fake({
      "env.isSet": (n: string) => Object.hasOwn(env, n),
      "env.credentials": () => ({ ok: true, referenced: [{ name: "KIRO_API_KEY", set: true }] }),
    });
    const a = await approvalOf(kiro(), f.ports);
    expect(JSON.stringify(a, (_k, v) => (typeof v === "object" && v !== null && "port" in v ? { ...v, port: "x" } : v))).not.toContain(SECRET);
    const g = fake({ "env.credentials": () => ({ ok: false, code: "credential_unset", variable: "KIRO_API_KEY" }) });
    expect(JSON.stringify(await refusalsOf(kiro(), g.ports))).not.toContain(SECRET);
  });
});

describe("the approval is unforgeable and its references are stable", () => {
  it("only the object that checkStartupRefusals issued is an approval", async () => {
    const f = fake();
    const a = await approvalOf(config(), f.ports);
    expect(isStartupApproval(a)).toBe(true);
    const copies: Any[] = [
      { ...a }, JSON.parse(JSON.stringify({ ...a, lease: { ...a.lease, port: null } })), Object.freeze({ ...a }), Object.create(a), new Proxy(a, {}),
      Object.freeze({ ...a, policy: { ...a.policy }, auditConfig: { ...a.auditConfig }, lease: { ...a.lease } }), Object.assign(Object.create(null), a),
      null, undefined, 42, "x", [], {}, { payloadAuditConfig: "pass", lease: { proven: true } },
    ];
    for (const c of copies) expect(isStartupApproval(c)).toBe(false);
  });
  it("every container of the approval is frozen, and the approval is a new object for every run", async () => {
    const f = fake();
    const a = await approvalOf(config(), f.ports);
    for (const o of [a, a.policy, a.policy.limits, a.auditConfig, a.envVarsRead, a.envVarsRead[0], a.credentials, a.sandbox, a.lease]) expect(Object.isFrozen(o)).toBe(true);
    expect(() => { (a as Any).payloadAuditConfig = "blocked"; }).toThrow(TypeError);
    const b = await approvalOf(config(), fake().ports);
    expect(b).not.toBe(a);
    expect(isStartupApproval(a) && isStartupApproval(b)).toBe(true);
  });
  it("a refusal never issues an approval, and a refused result carries no approval-like value", async () => {
    const r = await checkStartupRefusals(config(), fake({ "io.configFiles": () => [] }).ports);
    expect(r.ok).toBe(false);
    expect(isStartupApproval(r)).toBe(false);
    expect(isStartupApproval((r as Any).error)).toBe(false);
  });
  it("keeps the identity of the policy, the table and the audit load result (no deep copy) and freezes plain data in place", async () => {
    const f = fake();
    const a = await approvalOf(config(), f.ports);
    expect(a.policy.value).toBe(f.objects.policy);
    expect(a.policy.table).toBe(f.objects.table);
    expect(a.auditConfig.load).toBe(f.objects.audit);
    for (const o of [f.objects.policy, f.objects.policy.nested, f.objects.policy.nested.a, f.objects.audit, f.objects.audit.config, f.objects.audit.config.list]) expect(Object.isFrozen(o)).toBe(true);
    expect(() => { (f.objects.audit.config as Any).kind = "changed"; }).toThrow(TypeError);
  });
  it("leaves an object that is not plain data (a class instance, a typed array) alone: same identity, not frozen", async () => {
    class Handle { n = 0; }
    const handle = new Handle();
    const bytes = new Uint8Array([1, 2, 3]);
    const f = fake({
      "policy.load": () => ({ ok: true, policy: handle, table: bytes, limits: { requests: 10, bodyBytes: 8192 }, policySha256: H64("a"), preparationTableSha256: H64("b") }),
    });
    const a = await approvalOf(config(), f.ports);
    expect(a.policy.value).toBe(handle);
    expect(a.policy.table).toBe(bytes);
    expect(Object.isFrozen(handle)).toBe(false);
    handle.n += 1;
    expect(handle.n).toBe(1);
  });
  it("copies the primitives and the lists at the moment of issue: a later change of what a port returned does not change the approval", async () => {
    const f = fake({ "env.credentials": () => ({ ok: true, referenced: f.objects.referenced }) });
    f.objects.referenced.push({ name: "KIRO_API_KEY", set: true });
    const a = await approvalOf(kiro(), f.ports);
    f.objects.limits.requests = 1;
    f.objects.limits.bodyBytes = 1;
    f.objects.referenced.push({ name: "LATE", set: true });
    f.objects.referenced[0]!.set = false;
    f.objects.destinations.push("late.example.invalid");
    expect(a.policy.limits).toEqual({ requests: 10, bodyBytes: 8192 });
    expect(a.credentials).toEqual([{ name: "KIRO_API_KEY", set: true }]);
    expect(a.sandbox.destinations).toEqual(["relay.example.invalid"]);
  });
  it("a second run reads the ports again and issues another approval; the first one is not changed", async () => {
    const first = fake();
    const a = await approvalOf(config(), first.ports);
    const second = fake({ "policy.load": () => ({ ok: true, policy: { kind: "other" }, table: { kind: "other-table" }, limits: { requests: 10, bodyBytes: 8192 }, policySha256: H64("d"), preparationTableSha256: H64("e") }) });
    const b = await approvalOf(config(), second.ports);
    expect(a.policy.value).toBe(first.objects.policy);
    expect(a.policy.policySha256).toBe(H64("a"));
    expect(b.policy.policySha256).toBe(H64("d"));
    expect(first.calls.n["policy.load"]).toBe(1);
  });
  it("the approval holds the very validated configuration (identity), which is frozen", async () => {
    const cfg = config();
    const a = await approvalOf(cfg, fake().ports);
    expect(a.config).toBe(cfg);
    expect(Object.isFrozen(a.config)).toBe(true);
  });
});

describe("group 8: mock and kiro-cli take different paths", () => {
  it("mock needs no destinations and no sandbox; kiro-cli needs both and records the destinations", async () => {
    const m = await approvalOf(config(), fake().ports);
    const k = await approvalOf(kiro(), fake().ports);
    expect(m.sandbox).toEqual({ applicable: false });
    expect(k.sandbox.applicable).toBe(true);
    expect(m.config.provider).toBe("mock");
    expect(k.config.provider).toBe("kiro-cli");
  });
  it("the provider passed to the env port is the one of the configuration", async () => {
    const seen: unknown[] = [];
    const f = fake({ "env.credentials": (p: unknown) => { seen.push(p); return { ok: true, referenced: [] }; } });
    await approvalOf(config(), f.ports);
    await approvalOf(kiro(), fake({ "env.credentials": (p: unknown) => { seen.push(p); return { ok: true, referenced: [] }; } }).ports);
    expect(seen).toEqual(["mock", "kiro-cli"]);
  });
});