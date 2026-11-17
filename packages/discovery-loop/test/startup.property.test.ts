// Feature: discovery-loop, Property: RunConfig stage B (task 4.1)
// **Validates: Requirements 2.9, 8.6, 11.8, 15.11, 16.9, 17.2, 19.6, 24.9**
// Fixed seeds and bounded run counts. Synthetic data only. The model below says which refusals a set of failing fake ports must produce.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { STARTUP_CHECK_ORDER, checkStartupRefusals, validateRunConfig, type RunConfig, type StartupRefusal } from "../src/index.js";
import { isStartupApproval } from "../src/config/startup.js";
import { SYNTHETIC_RUN_ID } from "./support/syntheticRunId.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const H64 = (c: string): string => c.repeat(64);
const cfgOf = (provider: "mock" | "kiro-cli"): RunConfig => {
  const r = validateRunConfig({ schemaVersion: 1, provider, limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames: ["EXAMPLE_ONE"] });
  if (!r.ok) throw new Error("test configuration");
  return r.value;
};

/** Which fake port fails: each has exactly one refusal in the model. */
const FAILS = ["policy", "audit", "env", "sandbox", "leaseVars", "leaseTiming", "io", "leaseCheck"] as const;
type Fail = (typeof FAILS)[number];
const EXPECT: Record<Fail, StartupRefusal> = {
  policy: { code: "policy_invalid", check: "policy" },
  audit: { code: "audit_config_missing", check: "auditConfig" },
  env: { code: "credential_unset", check: "env", name: "KIRO_API_KEY" },
  sandbox: { code: "provider_not_available", check: "sandbox" },
  leaseVars: { code: "lease_env_missing", check: "lease", name: "PHOENIX_RUN_ID" },
  leaseTiming: { code: "lease_timing_invalid", check: "lease", name: "propagation_delay_unmeasured" },
  io: { code: "run_volume_missing", check: "io" },
  leaseCheck: { code: "lease_invalid", check: "lease", name: "heartbeat_stale" },
};

function build(failing: ReadonlySet<Fail>, delays: readonly number[]) {
  const calls: string[] = [];
  let i = 0;
  const wait = <T>(v: T): Promise<T> => {
    const ms = delays[i++ % delays.length] ?? 0;
    return ms < 0 ? Promise.resolve(v) : new Promise((resolve) => setTimeout(() => resolve(v), ms));
  };
  const lease = { instance: true };
  const ports: Any = {
    policy: { load: () => { calls.push("policy"); return wait(failing.has("policy") ? { ok: false, code: "invalid" } : { ok: true, policy: {}, table: {}, limits: { requests: 10, bodyBytes: 8192 }, policySha256: H64("a"), preparationTableSha256: H64("b") }); } },
    auditConfig: { load: () => { calls.push("audit"); return wait(failing.has("audit") ? { ok: false, reason: "missing" } : { ok: true, load: {}, sha256: H64("c") }); } },
    env: {
      isSet: () => wait(true),
      credentials: () => { calls.push("env"); return wait(failing.has("env") ? { ok: false, code: "credential_unset", variable: "KIRO_API_KEY" } : { ok: true, referenced: [] }); },
    },
    sandbox: { providerAvailable: () => { calls.push("sandbox"); return wait(!failing.has("sandbox")); }, destinations: () => wait(["relay.example.invalid"]) },
    lease: {
      variables: () => { calls.push("leaseVars"); return wait({ runId: !failing.has("leaseVars"), nonce: true }); },
      timing: () => { calls.push("leaseTiming"); return wait(failing.has("leaseTiming") ? { ok: false, errors: ["propagation_delay_unmeasured"] } : { ok: true, heartbeatIntervalMs: 1000, staleAfterMs: 4000, propagationDelayMs: 1 }); },
      port: () => { calls.push("leasePort"); return lease; },
      check: () => { calls.push("leaseCheck"); return wait(failing.has("leaseCheck") ? { valid: false, reason: "heartbeat_stale" } : { valid: true, runId: SYNTHETIC_RUN_ID }); },
    },
    io: { runVolume: () => { calls.push("io"); return wait(failing.has("io") ? { exists: false, writable: false, empty: false } : { exists: true, writable: true, empty: true }); }, configFiles: () => wait(["audit-config.json", "run-config.json"]) },
  };
  return { ports, calls, lease };
}

const rank = (c: string): number => (STARTUP_CHECK_ORDER as readonly string[]).indexOf(c);

describe("Property: the refusals are exactly the failing ports, in the fixed order, whatever the timing", () => {
  const failSet = fc.subarray([...FAILS], { minLength: 0, maxLength: FAILS.length });
  const delays = fc.array(fc.integer({ min: -1, max: 4 }), { minLength: 1, maxLength: 8 });

  it("an approval exists iff no port fails; the lease proof runs once iff no static check failed", async () => {
    await fc.assert(
      fc.asyncProperty(failSet, delays, fc.constantFrom<"mock" | "kiro-cli">("mock", "kiro-cli"), async (failList, d, provider) => {
        // a failure of the sandbox port exists only for kiro-cli
        const failing = new Set<Fail>(failList.filter((f) => f !== "sandbox" || provider === "kiro-cli"));
        const b = build(failing, d);
        const r = await checkStartupRefusals(cfgOf(provider), b.ports);
        const staticFailures = [...failing].filter((f) => f !== "leaseCheck");
        const proofCalls = b.calls.filter((c) => c === "leaseCheck").length;
        if (failing.size === 0) {
          expect(r.ok).toBe(true);
          expect(r.ok && isStartupApproval(r.value)).toBe(true);
          expect(proofCalls).toBe(1);
          expect(r.ok && r.value.lease.port).toBe(b.lease);
          expect(r.ok && r.value.lease.runId).toBe(SYNTHETIC_RUN_ID);
          return;
        }
        expect(r.ok).toBe(false);
        if (r.ok) return;
        const expected = (staticFailures.length > 0 ? staticFailures : (["leaseCheck"] as Fail[]))
          .map((f) => EXPECT[f])
          .sort((a, c) => rank(a.check) - rank(c.check) || (a.code < c.code ? -1 : a.code > c.code ? 1 : 0) || ((a.name ?? "") < (c.name ?? "") ? -1 : 1));
        expect(r.error).toEqual(expected);
        expect(proofCalls).toBe(staticFailures.length > 0 ? 0 : 1);
        expect(b.calls.filter((c) => c === "leasePort").length).toBe(staticFailures.length > 0 ? 0 : 1);
      }),
      { seed: 410_301, numRuns: 150 },
    );
  });

  it("the result does not depend on the delays of the ports", async () => {
    await fc.assert(
      fc.asyncProperty(failSet, delays, delays, async (failList, d1, d2) => {
        const failing = new Set<Fail>(failList);
        const a = await checkStartupRefusals(cfgOf("kiro-cli"), build(failing, d1).ports);
        const b = await checkStartupRefusals(cfgOf("kiro-cli"), build(failing, d2).ports);
        expect(JSON.stringify(a.ok ? "approval" : a.error)).toBe(JSON.stringify(b.ok ? "approval" : b.error));
      }),
      { seed: 410_302, numRuns: 120 },
    );
  });

  it("every ports method is called at most once per run (env.isSet once per distinct name), whatever fails", async () => {
    await fc.assert(
      fc.asyncProperty(failSet, async (failList) => {
        const b = build(new Set<Fail>(failList), [-1]);
        await checkStartupRefusals(cfgOf("kiro-cli"), b.ports);
        const seen = new Map<string, number>();
        for (const c of b.calls) seen.set(c, (seen.get(c) ?? 0) + 1);
        for (const [name, n] of seen) expect(n, name).toBe(1);
      }),
      { seed: 410_303, numRuns: 100 },
    );
  });

  it("a thrown error of any port never escapes and never leaks its message", async () => {
    const CANARY = "CANARY_1f7b_SECRET";
    const methods = ["policy", "auditConfig", "env", "sandbox", "lease", "io"] as const;
    await fc.assert(
      fc.asyncProperty(fc.subarray([...methods], { minLength: 1 }), fc.constantFrom("throw", "reject", "garbage"), async (broken, how) => {
        const b = build(new Set(), [-1]);
        for (const m of broken) {
          const port = b.ports[m] as Record<string, unknown>;
          for (const k of Object.keys(port)) {
            port[k] = how === "throw" ? () => { throw new Error(CANARY); } : how === "reject" ? () => Promise.reject(new Error(CANARY)) : () => ({ [CANARY]: CANARY });
          }
        }
        const r = await checkStartupRefusals(cfgOf("kiro-cli"), b.ports);
        expect(r.ok).toBe(false);
        expect(JSON.stringify(r)).not.toContain(CANARY);
        if (!r.ok) expect(new Set(r.error.map((e) => e.check))).toEqual(new Set(broken));
      }),
      { seed: 410_304, numRuns: 150 },
    );
  });
});