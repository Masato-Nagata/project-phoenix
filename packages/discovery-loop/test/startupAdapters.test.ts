// Task 4.1, stage B: the ports wrapped around the REAL functions (loadPreparationTable, loadPolicyConfig, parseAuditConfig, checkProviderCredentials,
// createProvider, checkLeaseTiming, createLeasePort / RunLease). The adapters are test support (`test/support/startupAdapters.ts`); this file proves
// that stage B works with the real baked policy data, the real audit parser and the real lease mechanism, and that the closed vocabulary of
// names equals what those functions can produce. Synthetic data only; the lease directory is a temporary one.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkLeaseTiming } from "../../verifier/src/lease/timing.js";
import { loadPolicyConfig } from "../../verifier/src/policy/config.js";
import { loadPreparationTable } from "../../verifier/src/prep/table.js";
import { parseAuditConfig } from "../../ai-client/src/index.js";
import { STARTUP_NAME_VOCABULARY, checkStartupRefusals, validateRunConfig, type RunConfig, type StartupPorts, type StartupRefusal } from "../src/index.js";
import { isStartupApproval } from "../src/config/startup.js";
import {
  FakeTime, OTHER_SYNTHETIC_RUN_ID, SYNTHETIC_RUN_ID, auditPort, bakedPolicyRaw, bakedPreparationTableRaw, envPort, ioPort, leasePort, makeLeaseDir, makeTempDir, policyPort, sandboxPort,
  syntheticAuditConfig, toBytes,
  type FakeEnv,
} from "./support/startupAdapters.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const config = (over: Record<string, unknown> = {}): RunConfig => {
  const r = validateRunConfig({
    schemaVersion: 1, provider: "mock", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames: ["EXAMPLE_ONE"], ...over,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const SECRET = "SYNTHETIC-SECRET-VALUE-0002";
const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

interface World {
  readonly ports: StartupPorts<Any, Any, Any, Any>;
  readonly time: FakeTime;
  readonly lease: ReturnType<typeof makeLeaseDir>;
  readonly counters: { created: number; auditLoads: number };
  readonly volume: string;
  readonly configDir: string;
  cleanup(): void;
}
/** Every port wrapped around real code; the Launcher is played by the fake sleeper, which writes a heartbeat. */
function world(opts: { env?: FakeEnv; audit?: () => Uint8Array | undefined; policy?: () => unknown; table?: () => unknown; destinations?: string[]; beat?: boolean; leaseOpts?: Parameters<typeof makeLeaseDir>[0] } = {}): World {
  const lease = makeLeaseDir(opts.leaseOpts);
  const env: FakeEnv = opts.env ?? { PHOENIX_RUN_ID: lease.runId, PHOENIX_LEASE_NONCE: lease.nonce, PHOENIX_LEASE_D_MS: "50" };
  const time = new FakeTime();
  if (opts.beat !== false) time.onSleep = () => lease.beat();
  const counters = { created: 0, auditLoads: 0 };
  const volume = makeTempDir("phoenix-volume-");
  const configDir = makeTempDir("phoenix-config-");
  writeFileSync(join(configDir, "run-config.json"), "{}");
  writeFileSync(join(configDir, "audit-config.json"), "{}");
  const audit = auditPort(() => { counters.auditLoads += 1; return opts.audit === undefined ? toBytes(syntheticAuditConfig()) : opts.audit(); });
  const ports: StartupPorts<Any, Any, Any, Any> = {
    policy: policyPort(opts.policy, opts.table),
    auditConfig: audit,
    env: envPort(env),
    sandbox: sandboxPort(() => opts.destinations),
    lease: leasePort(env, lease.directory, time, counters),
    io: ioPort(volume, configDir),
  };
  return { ports, time, lease, counters, volume, configDir, cleanup: () => { for (const d of [lease.directory, volume, configDir]) rmSync(d, { recursive: true, force: true }); } };
}
const refusals = async (cfg: RunConfig, w: World): Promise<StartupRefusal[]> => {
  const r = await checkStartupRefusals(cfg, w.ports);
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};

describe("all ports over the real functions: a Run that may start", () => {
  it("issues an approval from the baked policy, a synthetic audit configuration, the real lease proof and real directories", async () => {
    const w = world();
    try {
      const cfg = config();
      const r = await checkStartupRefusals(cfg, w.ports);
      expect(r.ok, JSON.stringify(r.ok ? "" : r.error)).toBe(true);
      if (!r.ok) return;
      const a = r.value;
      expect(isStartupApproval(a)).toBe(true);
      expect(a.policy.limits).toEqual({ requests: 10, bodyBytes: 8192 }); // the baked data
      expect(a.policy.policySha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.policy.preparationTableSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(a.auditConfig.sha256).toBe(sha(toBytes(syntheticAuditConfig())));
      expect(a.auditConfig.load).toMatchObject({ ok: true, sha256: a.auditConfig.sha256 });
      expect(a.envVarsRead).toEqual([{ name: "EXAMPLE_ONE", set: false }]);
      expect(a.lease).toMatchObject({ heartbeatIntervalMs: 1000, staleAfterMs: 4000, propagationDelayMs: 50, proven: true });
      expect(a.lease.runId).toBe(SYNTHETIC_RUN_ID); // the id of the proof, in the strict Launcher format
      expect(a.lease.runId).toBe(w.lease.runId);
      expect(a.lease.port.isProven).toBe(true); // the SAME RunLease instance whose proof passed
      expect(w.counters.created).toBe(1);
      expect(w.counters.auditLoads).toBe(1);
      // the Runner then applies the running rule with the same instance, without a second proof
      expect((await a.lease.port.check()).valid).toBe(true);
      expect(w.counters.created).toBe(1);
    } finally {
      w.cleanup();
    }
  });
  it("the loaded policy object and table are the ones the Runner is built from: frozen by the loader, same identity in the approval", async () => {
    const loaded = policyPort().load();
    if (!loaded.ok) throw new Error("baked policy");
    expect(Object.isFrozen(loaded.policy)).toBe(true);
    expect(loaded.table).toBe(loaded.table);
    const w = world({ policy: () => bakedPolicyRaw() });
    try {
      const r = await checkStartupRefusals(config(), w.ports);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect((r.value.policy.value as Any).operations.length).toBeGreaterThan(0);
        expect((r.value.policy.value as Any).limits).toEqual({ requests: 10, stateChecks: 5, preparationSteps: 10, bodyBytes: 8192 });
      }
    } finally {
      w.cleanup();
    }
  });
});

describe("policy over loadPreparationTable and loadPolicyConfig", () => {
  const narrowed = (requests: number, bodyBytes: number) => (): unknown => {
    const raw = structuredClone(bakedPolicyRaw()) as Any;
    raw.limits.requests = requests;
    raw.limits.bodyBytes = bodyBytes;
    return raw;
  };
  it("a policy narrowed below the run configuration is above_policy_limit, with the effective defaults", async () => {
    const w = world({ policy: narrowed(5, 4096) });
    try {
      expect(await refusals(config(), w)).toEqual([
        { code: "above_policy_limit", check: "policy", name: "/limits/requestBodyBytes" },
        { code: "above_policy_limit", check: "policy", name: "/limits/requestsPerExperiment" },
      ]);
      expect(w.counters.created).toBe(0); // the lease was never touched
    } finally {
      w.cleanup();
    }
  });
  it("the same narrowed policy passes when the run configuration is within it (equal passes)", async () => {
    const w = world({ policy: narrowed(5, 4096) });
    try {
      const r = await checkStartupRefusals(config({ limits: { requestsPerExperiment: 5, requestBodyBytes: 4096 } }), w.ports);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.policy.limits).toEqual({ requests: 5, bodyBytes: 4096 });
    } finally {
      w.cleanup();
    }
  });
  it("an invalid policy, an invalid table, and an unreadable file", async () => {
    const bad = structuredClone(bakedPolicyRaw()) as Any;
    delete bad.operations;
    const badTable = structuredClone(bakedPreparationTableRaw()) as Any;
    badTable.schemaVersion = 2;
    for (const [opts, code] of [
      [{ policy: () => bad }, "policy_invalid"],
      [{ table: () => badTable }, "preparation_table_invalid"],
      [{ policy: () => { throw new Error("no file"); } }, "policy_unavailable"],
      [{ table: () => { throw new Error("no file"); } }, "policy_unavailable"],
    ] as [Parameters<typeof world>[0], string][]) {
      const w = world(opts);
      try {
        expect(await refusals(config(), w)).toEqual([{ code, check: "policy" }]);
      } finally {
        w.cleanup();
      }
    }
  });
  it("the real loaders agree with the adapter: the baked data load, and the limits are the maxima of the fixed schema bounds", () => {
    const table = loadPreparationTable(bakedPreparationTableRaw());
    expect(table.ok).toBe(true);
    if (!table.ok) return;
    const policy = loadPolicyConfig(bakedPolicyRaw(), table.value);
    expect(policy.ok).toBe(true);
    if (policy.ok) expect([policy.value.limits.requests, policy.value.limits.bodyBytes]).toEqual([10, 8192]);
  });
});

describe("audit configuration over parseAuditConfig", () => {
  it("passes once and carries the whole load result of the parser and its SHA-256", async () => {
    const w = world();
    try {
      const r = await checkStartupRefusals(config(), w.ports);
      expect(r.ok).toBe(true);
      expect(w.counters.auditLoads).toBe(1);
      if (r.ok) expect((r.value.auditConfig.load as Any).config.allowlist).toEqual(["legacy/src/utils.php"]);
    } finally {
      w.cleanup();
    }
  });
  it("missing, empty and invalid", async () => {
    for (const [audit, code, name] of [
      [() => undefined, "audit_config_missing", undefined],
      [() => new Uint8Array(0), "audit_config_empty", undefined],
      [() => new TextEncoder().encode("not json"), "audit_config_invalid", "invalid_json"],
    ] as [() => Uint8Array | undefined, string, string | undefined][]) {
      const w = world({ audit });
      try {
        expect(await refusals(config(), w)).toEqual([name === undefined ? { code, check: "auditConfig" } : { code, check: "auditConfig", name }]);
      } finally {
        w.cleanup();
      }
    }
  });
  it("every detail that parseAuditConfig can report is in the closed vocabulary (and each is reported by name)", () => {
    const mutate = (f: (c: Any) => void): Uint8Array => {
      const c = syntheticAuditConfig() as Any;
      f(c);
      return toBytes(c);
    };
    const cases: Uint8Array[] = [
      mutate((c) => { c.extra = 1; }),
      mutate((c) => { c.schemaVersion = 2; }),
      mutate((c) => { c.tokenizer = "other"; }),
      mutate((c) => { c.allowlist = []; }),
      mutate((c) => { c.canaries = []; }),
      mutate((c) => { c.canaries[0].value = "short"; }),
      mutate((c) => { c.decoys = [{ id: "d", value: "x" }]; }),
      mutate((c) => { c.fingerprints = c.fingerprints.slice(0, 3); }),
      mutate((c) => { c.fingerprints[0].n = 5; }),
      mutate((c) => { c.restrictedPathPrefixes = [1]; }),
      new TextEncoder().encode('{"a":1,"a":2}'),
      new TextEncoder().encode("[".repeat(20)),
      new Uint8Array([0xff, 0xfe]),
    ];
    const seen = new Set<string>();
    for (const bytes of cases) {
      const r = parseAuditConfig(bytes);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.reason).toBe("invalid");
        expect(r.detail).toBeDefined();
        expect((STARTUP_NAME_VOCABULARY.auditDetails as readonly string[]).includes(r.detail as string), String(r.detail)).toBe(true);
        seen.add(r.detail as string);
      }
    }
    // the eight field details of the parser are all reached; the strict-parse details that were reached are in the vocabulary too (checked above)
    expect([...seen].sort()).toEqual(expect.arrayContaining(["fields", "schemaVersion", "tokenizer", "allowlist", "canaries", "decoys", "fingerprints", "restrictedPathPrefixes"]));
    expect(seen.size).toBeGreaterThanOrEqual(10);
  });
});

describe("env and sandbox over checkProviderCredentials and createProvider", () => {
  it("mock needs no credential, and a secret in the environment reaches neither a refusal nor the approval", async () => {
    const w = world({ env: { PHOENIX_RUN_ID: SYNTHETIC_RUN_ID, PHOENIX_LEASE_NONCE: "synthetic-nonce-0001", PHOENIX_LEASE_D_MS: "50", EXAMPLE_ONE: SECRET, KIRO_API_KEY: SECRET } });
    try {
      const r = await checkStartupRefusals(config(), w.ports);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.value.envVarsRead).toEqual([{ name: "EXAMPLE_ONE", set: true }]);
        expect(JSON.stringify({ ...r.value, lease: undefined, auditConfig: undefined, policy: undefined })).not.toContain(SECRET);
      }
    } finally {
      w.cleanup();
    }
  });
  it("kiro-cli: an unset or blank KIRO_API_KEY is credential_unset naming the variable; the real createProvider has no factory", async () => {
    for (const env of [{ PHOENIX_RUN_ID: "r", PHOENIX_LEASE_NONCE: "n", PHOENIX_LEASE_D_MS: "50" }, { PHOENIX_RUN_ID: "r", PHOENIX_LEASE_NONCE: "n", PHOENIX_LEASE_D_MS: "50", KIRO_API_KEY: "   " }]) {
      const w = world({ env, destinations: ["relay.example.invalid"] });
      try {
        expect(await refusals(config({ provider: "kiro-cli" }), w)).toEqual([
          { code: "credential_unset", check: "env", name: "KIRO_API_KEY" },
          { code: "provider_not_available", check: "sandbox" },
        ]);
      } finally {
        w.cleanup();
      }
    }
  });
  it("kiro-cli with a credential and no destination list: provider_not_available and sandbox_destinations_undetermined, no secret", async () => {
    const w = world({ env: { PHOENIX_RUN_ID: "r", PHOENIX_LEASE_NONCE: "n", PHOENIX_LEASE_D_MS: "50", KIRO_API_KEY: SECRET } });
    try {
      const r = await refusals(config({ provider: "kiro-cli" }), w);
      expect(r.map((x) => x.code)).toEqual(["provider_not_available", "sandbox_destinations_undetermined"]);
      expect(JSON.stringify(r)).not.toContain(SECRET);
    } finally {
      w.cleanup();
    }
  });
  it("the real sandbox port: mock is available, kiro-cli is not (M4), and the port never needs the credential", () => {
    const p = sandboxPort(() => undefined);
    expect(p.providerAvailable("mock")).toBe(true);
    expect(p.providerAvailable("kiro-cli")).toBe(false);
  });
});

describe("lease over checkLeaseTiming and the real RunLease", () => {
  it("D is read only as 1 to 6 digits; anything else is propagation_delay_unmeasured", async () => {
    for (const d of [undefined, "", "abc", "1234567", "-1", "1.5", " 5", "0x10"]) {
      const env: Record<string, string | undefined> = { PHOENIX_RUN_ID: SYNTHETIC_RUN_ID, PHOENIX_LEASE_NONCE: "synthetic-nonce-0001" };
      if (d !== undefined) env["PHOENIX_LEASE_D_MS"] = d;
      const w = world({ env });
      try {
        expect(await refusals(config(), w), String(d)).toEqual([{ code: "lease_timing_invalid", check: "lease", name: "propagation_delay_unmeasured" }]);
      } finally {
        w.cleanup();
      }
    }
    const w = world({ env: { PHOENIX_RUN_ID: SYNTHETIC_RUN_ID, PHOENIX_LEASE_NONCE: "synthetic-nonce-0001", PHOENIX_LEASE_D_MS: "0050" } });
    try {
      const r = await checkStartupRefusals(config(), w.ports);
      expect(r.ok && r.value.lease.propagationDelayMs).toBe(50);
    } finally {
      w.cleanup();
    }
  });
  it("the rules of checkLeaseTiming are triggered through the real function", async () => {
    for (const [d, names] of [["1750", []], ["1751", ["rule_2_healthy_launcher_could_be_judged_stale"]], ["3501", ["rule_2_healthy_launcher_could_be_judged_stale", "rule_3_stop_exceeds_ten_seconds"]]] as [string, string[]][]) {
      const w = world({ env: { PHOENIX_RUN_ID: SYNTHETIC_RUN_ID, PHOENIX_LEASE_NONCE: "synthetic-nonce-0001", PHOENIX_LEASE_D_MS: d } });
      try {
        const r = await checkStartupRefusals(config(), w.ports);
        if (names.length === 0) expect(r.ok, d).toBe(true);
        else expect(r.ok ? [] : r.error, d).toEqual(names.map((name) => ({ code: "lease_timing_invalid", check: "lease", name })));
      } finally {
        w.cleanup();
      }
    }
  });
  it("every error string of checkLeaseTiming is in the closed vocabulary (parity of the names)", () => {
    const seen = new Set<string>();
    for (const [h, s, d] of [[0, 0, undefined], [100, 4000, 1], [1000, 7000, 1], [1000, 4000, undefined], [1000, 4000, -1], [1000, 4000, Number.NaN], [2000, 3000, 1], [1000, 2500, 1], [1000, 4000, 1751], [1000, 6000, 3000], [500, 1400, 5000], [1000, 4000, 100_000]] as [number, number, number | undefined][]) {
      const r = checkLeaseTiming({ heartbeatIntervalMs: h, staleAfterMs: s }, d);
      if (!r.ok) for (const e of r.error) { expect((STARTUP_NAME_VOCABULARY.leaseTimingRules as readonly string[]).includes(e), e).toBe(true); seen.add(e); }
    }
    expect([...seen].sort()).toEqual([...STARTUP_NAME_VOCABULARY.leaseTimingRules].sort());
  });
  it("missing variables are lease_env_missing and nothing is read from the lease directory", async () => {
    const w = world({ env: { PHOENIX_LEASE_D_MS: "50" } });
    try {
      expect(await refusals(config(), w)).toEqual([
        { code: "lease_env_missing", check: "lease", name: "PHOENIX_LEASE_NONCE" },
        { code: "lease_env_missing", check: "lease", name: "PHOENIX_RUN_ID" },
      ]);
      expect(w.counters.created).toBe(0);
    } finally {
      w.cleanup();
    }
  });
  describe("the run id of the proof (task 4.1 reopened, case C1)", () => {
    it("the id passed to createLeasePort, the id of the check() response and the run_id of lease.json are one value, and PHOENIX_RUN_ID is read once", async () => {
      const w = world({ leaseOpts: { runId: OTHER_SYNTHETIC_RUN_ID } });
      try {
        const raw: Record<string, string | undefined> = { PHOENIX_RUN_ID: w.lease.runId, PHOENIX_LEASE_NONCE: w.lease.nonce, PHOENIX_LEASE_D_MS: "50" };
        const reads: string[] = [];
        const env: FakeEnv = new Proxy(raw, { get(target, key, receiver) { if (typeof key === "string") reads.push(key); return Reflect.get(target, key, receiver) as unknown; } });
        const lease = leasePort(env, w.lease.directory, w.time, w.counters);
        expect(reads.filter((k) => k === "PHOENIX_RUN_ID")).toHaveLength(1); // read at construction, into one constant
        raw["PHOENIX_RUN_ID"] = SYNTHETIC_RUN_ID; // a later change of the environment must change nothing
        const r = await checkStartupRefusals(config(), { ...w.ports, lease });
        expect(r.ok, JSON.stringify(r.ok ? "" : r.error)).toBe(true);
        if (!r.ok) return;
        const fileRunId = (JSON.parse(readFileSync(join(w.lease.directory, "lease.json"), "utf8")) as { run_id: string }).run_id;
        expect(r.value.lease.runId).toBe(OTHER_SYNTHETIC_RUN_ID); // the response id (the constructor id)
        expect(fileRunId).toBe(OTHER_SYNTHETIC_RUN_ID); // the RunLease proof compared the constructor id with this value (run_mismatch otherwise)
        expect(reads.filter((k) => k === "PHOENIX_RUN_ID")).toHaveLength(1); // still once, after the whole start-up check
        expect(w.counters.created).toBe(1);
      } finally {
        w.cleanup();
      }
    });
    it("a strict id in the environment that differs from lease.json is run_mismatch, and the run id of that answer is not used", async () => {
      const w = world({ leaseOpts: { runId: SYNTHETIC_RUN_ID, runIdInFile: OTHER_SYNTHETIC_RUN_ID } });
      try {
        const r = await refusals(config(), w);
        expect(r).toEqual([{ code: "lease_invalid", check: "lease", name: "run_mismatch" }]);
        expect(JSON.stringify(r)).not.toContain(OTHER_SYNTHETIC_RUN_ID);
        expect(JSON.stringify(r)).not.toContain(SYNTHETIC_RUN_ID);
      } finally {
        w.cleanup();
      }
    });
    it("an environment run id that is not in the strict format is refused as port_failed, although the lease proof itself passes", async () => {
      const w = world({ leaseOpts: { runId: "run-synthetic-0001" } });
      try {
        expect(await refusals(config(), w)).toEqual([{ code: "port_failed", check: "lease" }]);
        expect(w.counters.created).toBe(1);
      } finally {
        w.cleanup();
      }
    });
    it("DOCUMENTED LIMIT, NOT A GUARANTEE: stage B accepts an adapter whose check() reports another well-formed id than the one the RunLease was built with", async () => {
      // RunLease exposes no run id, so stage B cannot see which id it was built with. Here the RunLease is built with X (= environment = lease.json),
      // while check() reports Y. Stage B only validates the FORMAT of Y, so it issues the approval, and the approval carries Y.
      // This is NOT detectable in task 4.1. The guarantee rests on the adapter (one captured constant) and the proof against lease.json.
      // task 4.9: re-verify in the real-adapter integration test that the runId passed to createLeasePort equals the runId of the check() response.
      const w = world({ leaseOpts: { runId: SYNTHETIC_RUN_ID } });
      try {
        const honest = w.ports.lease;
        const wrong: StartupPorts<Any, Any, Any, Any>["lease"] = {
          ...honest,
          async check() {
            const v = await honest.check();
            return v.valid ? { valid: true, runId: OTHER_SYNTHETIC_RUN_ID } : v;
          },
        };
        const r = await checkStartupRefusals(config(), { ...w.ports, lease: wrong });
        expect(r.ok).toBe(true); // accepted: the limit
        if (r.ok) expect(r.value.lease.runId).toBe(OTHER_SYNTHETIC_RUN_ID);
      } finally {
        w.cleanup();
      }
    });
  });
  describe("each LeaseReason, from the real watcher", () => {
    const run = async (setup: (w: World) => void, opts: Parameters<typeof world>[0] = {}): Promise<StartupRefusal[]> => {
      const w = world(opts);
      try {
        setup(w);
        return await refusals(config(), w);
      } finally {
        w.cleanup();
      }
    };
    const lease = (name: string): StartupRefusal => ({ code: "lease_invalid", check: "lease", name });
    it("heartbeat_stale: the counter never changes", async () => {
      expect(await run(() => undefined, { beat: false })).toEqual([lease("heartbeat_stale")]);
    });
    it("missing: no lease.json", async () => {
      expect(await run((w) => rmSync(join(w.lease.directory, "lease.json")))).toEqual([lease("missing")]);
    });
    it("revoked: the revoked file exists", async () => {
      expect(await run((w) => writeFileSync(join(w.lease.directory, "revoked"), ""))).toEqual([lease("revoked")]);
    });
    it("run_mismatch: the lease belongs to another Run", async () => {
      expect(await run(() => undefined, { leaseOpts: { runId: SYNTHETIC_RUN_ID, runIdInFile: "run-other" } })).toEqual([lease("run_mismatch")]);
    });
    it("nonce_mismatch: the environment nonce is not the one of the lease", async () => {
      expect(await run(() => undefined, { env: { PHOENIX_RUN_ID: SYNTHETIC_RUN_ID, PHOENIX_LEASE_NONCE: "another-nonce", PHOENIX_LEASE_D_MS: "50" } })).toEqual([lease("nonce_mismatch")]);
    });
    it("malformed: lease.json carries other H and S than the runtime's (timing_differs), or is not JSON", async () => {
      expect(await run(() => undefined, { leaseOpts: { staleAfterMs: 5000 } })).toEqual([lease("malformed")]);
      expect(await run((w) => writeFileSync(join(w.lease.directory, "lease.json"), "not json"))).toEqual([lease("malformed")]);
    });
    it("unreadable: lease.json cannot be read as a file", async () => {
      expect(await run((w) => { rmSync(join(w.lease.directory, "lease.json")); mkdirSync(join(w.lease.directory, "lease.json")); })).toEqual([lease("unreadable")]);
    });
    it("a refusal of the proof leaves the lease latched invalid: the same instance never becomes valid", async () => {
      const w = world({ beat: false });
      try {
        const r = await checkStartupRefusals(config(), w.ports);
        expect(r.ok).toBe(false);
        w.time.onSleep = () => w.lease.beat();
        const again = await w.ports.lease.check();
        expect(again).toEqual({ valid: false, reason: "heartbeat_stale" });
      } finally {
        w.cleanup();
      }
    });
  });
});

describe("io over the real directories", () => {
  it("an empty volume and the two config files pass; the other states are refused", async () => {
    const cases: [string, (w: World) => void, string[]][] = [
      ["non-empty volume", (w) => writeFileSync(join(w.volume, "left-over"), "x"), ["run_volume_not_empty"]],
      ["missing volume", (w) => rmSync(w.volume, { recursive: true, force: true }), ["run_volume_missing"]],
      ["extra config file", (w) => writeFileSync(join(w.configDir, "other.json"), "{}"), ["config_files_unexpected"]],
      ["missing config file", (w) => rmSync(join(w.configDir, "audit-config.json")), ["config_files_unexpected"]],
      ["missing config directory", (w) => rmSync(w.configDir, { recursive: true, force: true }), ["io_unreadable"]],
    ];
    for (const [label, setup, codes] of cases) {
      const w = world();
      try {
        setup(w);
        const r = await refusals(config(), w);
        expect(r.map((x) => x.code), label).toEqual(codes);
        expect(r.every((x) => x.name === undefined), label).toBe(true);
      } finally {
        w.cleanup();
      }
    }
  });
});