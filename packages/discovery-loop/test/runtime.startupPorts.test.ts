// Task 4.9-B: the fixed-path input reader, the production ports of stage B and the production Runner factory. Everything is synthetic or a
// file of this repository (the baked verifier data); files live in a temporary directory. No network, no container, no real lease.
import { linkSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createAcceptanceCheck, DEFAULT_RUNNER_LIMITS, loadPolicyConfig, loadPreparationTable, type HttpPort, type HttpRequest } from "@phoenix/verifier";
import { checkStartupRefusals, validateRunConfig, type RunConfig } from "../src/index.js";
import { createRunnerFactory } from "../src/runtime/runnerFactory.js";
import {
  AUDIT_CONFIG_FILE, POLICY_CONFIG_FILE, PREPARATION_TABLE_FILE, RUN_CONFIG_FILE, createFixedInputReader, decodeUtf8Strict, type InputRead,
} from "../src/runtime/startupInputs.js";
import { createStartupPorts, type BakedPolicyInput, type StartupPortInputs } from "../src/runtime/startupPorts.js";
import { DEFAULT_PARSE_LIMITS, strictParse } from "../src/schema/index.js";
import { FakeTime, makeLeaseDir, syntheticAuditConfig, toBytes } from "./support/startupAdapters.js";
import { SYNTHETIC_RUN_ID } from "./support/syntheticRunId.js";
import { FakeLease } from "../../verifier/test/helpers/runnerFixtures.js";

const VERIFIER_DATA = fileURLToPath(new URL("../../verifier/data", import.meta.url));
const CANARY = "CANARY-startup-ports-6d1e";
let base: string;
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "phx-sp-")));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});
let n = 0;
const fresh = (): string => {
  n += 1;
  const d = join(base, `d${n}`);
  mkdirSync(d);
  return d;
};

describe("createFixedInputReader", () => {
  it("returns the exact bytes of a listed file as a fresh copy", async () => {
    const root = fresh();
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0x0a]);
    writeFileSync(join(root, RUN_CONFIG_FILE), bytes);
    const r = createFixedInputReader(root, [RUN_CONFIG_FILE]);
    const a = await r.read(RUN_CONFIG_FILE);
    expect(a.kind).toBe("ok");
    if (a.kind !== "ok") return;
    expect([...a.bytes]).toEqual([...bytes]);
    a.bytes[0] = 0;
    const b = await r.read(RUN_CONFIG_FILE);
    expect(b.kind === "ok" && b.bytes[0]).toBe(0xef);
  });
  it.each([
    ["a missing listed file", "missing"],
    ["a name that is not listed (never read)", "unreadable"],
    ["a directory", "unreadable"],
    ["a symbolic link", "unreadable"],
    ["a second hard link", "unreadable"],
    ["a file above 1 MiB", "unreadable"],
  ] as const)("%s gives %s, with no content, path or code", async (label, kind) => {
    const root = fresh();
    const outside = join(fresh(), "secret.txt");
    writeFileSync(outside, CANARY);
    let name: string = RUN_CONFIG_FILE;
    if (label === "a name that is not listed (never read)") {
      writeFileSync(join(root, "other.json"), CANARY);
      name = "other.json";
    } else if (label === "a directory") mkdirSync(join(root, RUN_CONFIG_FILE));
    else if (label === "a symbolic link") symlinkSync(outside, join(root, RUN_CONFIG_FILE));
    else if (label === "a second hard link") {
      writeFileSync(join(root, RUN_CONFIG_FILE), CANARY);
      linkSync(join(root, RUN_CONFIG_FILE), join(root, "twin.json"));
    } else if (label === "a file above 1 MiB") writeFileSync(join(root, RUN_CONFIG_FILE), Buffer.alloc(1_048_577, 0x20));
    const r: InputRead = await createFixedInputReader(root, [RUN_CONFIG_FILE]).read(name);
    expect(r).toEqual({ kind });
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(JSON.stringify(r)).not.toContain(base);
  });
  it("a root that is not a real directory gives unreadable for every read", async () => {
    const root = fresh();
    const link = join(base, `link${n}`);
    symlinkSync(root, link);
    writeFileSync(join(root, RUN_CONFIG_FILE), "{}");
    for (const r of ["relative/dir", join(base, "absent"), link, join(root, RUN_CONFIG_FILE)]) {
      expect(await createFixedInputReader(r, [RUN_CONFIG_FILE]).read(RUN_CONFIG_FILE), r).toEqual({ kind: "unreadable" });
    }
  });
  it("decodeUtf8Strict accepts valid UTF-8 and refuses an invalid sequence", () => {
    expect(decodeUtf8Strict(new TextEncoder().encode("ok \u00e9"))).toBe("ok \u00e9");
    expect(decodeUtf8Strict(new Uint8Array([0x61, 0xff, 0x62]))).toBeUndefined();
  });
});

// ---- stage B with the production ports ---------------------------------------------------------
async function bakedPolicy(): Promise<BakedPolicyInput> {
  const reader = createFixedInputReader(VERIFIER_DATA, [POLICY_CONFIG_FILE, PREPARATION_TABLE_FILE]);
  const p = await reader.read(POLICY_CONFIG_FILE);
  const t = await reader.read(PREPARATION_TABLE_FILE);
  if (p.kind !== "ok" || t.kind !== "ok") throw new Error("the baked data must be readable");
  const pj = strictParse(p.bytes, DEFAULT_PARSE_LIMITS);
  const tj = strictParse(t.bytes, DEFAULT_PARSE_LIMITS);
  if (!pj.ok || !tj.ok) throw new Error("the baked data must parse");
  return { kind: "ok", policyRaw: pj.value, tableRaw: tj.value };
}
function config(over: Record<string, unknown> = {}): RunConfig {
  const v = validateRunConfig({ schemaVersion: 1, provider: "mock", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames: ["EXAMPLE_ONE"], ...over });
  if (!v.ok) throw new Error("setup");
  return v.value;
}
async function inputs(over: Partial<StartupPortInputs> & { nonceInFile?: string } = {}): Promise<StartupPortInputs> {
  const time = new FakeTime();
  const ld = makeLeaseDir(over.nonceInFile === undefined ? { nonce: "synthetic-nonce-0001" } : { nonce: over.nonceInFile });
  time.onSleep = () => ld.beat();
  return {
    policy: await bakedPolicy(),
    auditConfig: { kind: "ok", bytes: toBytes(syntheticAuditConfig()) },
    env: { EXAMPLE_ONE: "synthetic" },
    lease: { directory: ld.directory, runId: SYNTHETIC_RUN_ID, nonce: "synthetic-nonce-0001", propagationDelayMs: 123, clock: time.clock, sleeper: time.sleeper },
    io: { runVolume: () => ({ exists: true, writable: true, empty: true }), configFiles: () => [RUN_CONFIG_FILE, AUDIT_CONFIG_FILE] },
    ...over,
  };
}
const codesOf = (r: Awaited<ReturnType<typeof checkStartupRefusals>>): string[] => (r.ok ? [] : r.error.map((e) => `${e.check}:${e.code}`));

describe("createStartupPorts with the real stage B", () => {
  it("issues a ticket: the baked policy, the audit configuration, the names and flags, and the single proof of the lease", async () => {
    const i = await inputs();
    const ports = createStartupPorts(i);
    const r = await checkStartupRefusals(config(), ports);
    expect(codesOf(r)).toEqual([]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.lease.runId).toBe(SYNTHETIC_RUN_ID);
    expect(r.value.envVarsRead).toEqual([{ name: "EXAMPLE_ONE", set: true }]);
    expect(r.value.policy.policySha256).toMatch(/^[0-9a-f]{64}$/);
    // one lease instance for port() and check()
    expect(ports.lease.port()).toBe(ports.lease.port());
    expect(r.value.lease.port).toBe(ports.lease.port());
  });
  it("the policy is the one that the verifier loader accepts from the same files", async () => {
    const p = await bakedPolicy();
    if (p.kind !== "ok") throw new Error("setup");
    const t = loadPreparationTable(p.tableRaw);
    expect(t.ok && loadPolicyConfig(p.policyRaw, t.value).ok).toBe(true);
  });
  it.each([
    ["unavailable baked data", { policy: { kind: "unavailable" } }, "policy:policy_unavailable"],
    ["a missing audit configuration", { auditConfig: { kind: "missing" } }, "auditConfig:audit_config_missing"],
    ["an unreadable audit configuration", { auditConfig: { kind: "unreadable" } }, "auditConfig:audit_config_unreadable"],
    ["an empty audit configuration", { auditConfig: { kind: "ok", bytes: new Uint8Array(0) } }, "auditConfig:audit_config_empty"],
    ["a Run_Volume that is not empty", { io: { runVolume: () => ({ exists: true, writable: true, empty: false }), configFiles: () => [RUN_CONFIG_FILE, AUDIT_CONFIG_FILE] } }, "io:run_volume_not_empty"],
    ["an extra file in the configuration directory", { io: { runVolume: () => ({ exists: true, writable: true, empty: true }), configFiles: () => [RUN_CONFIG_FILE, AUDIT_CONFIG_FILE, "x.json"] } }, "io:config_files_unexpected"],
  ] as const)("refuses %s", async (_label, over, code) => {
    const r = await checkStartupRefusals(config(), createStartupPorts(await inputs(over as Partial<StartupPortInputs>)));
    expect(codesOf(r)).toContain(code);
  });
  it("refuses a missing nonce or run id, and an unmeasured D, without the lease proof", async () => {
    const i = await inputs();
    const noNonce = await checkStartupRefusals(config(), createStartupPorts({ ...i, lease: { ...i.lease, nonce: "" } }));
    expect(codesOf(noNonce)).toContain("lease:lease_env_missing");
    const noD = await checkStartupRefusals(config(), createStartupPorts({ ...i, lease: { ...i.lease, propagationDelayMs: undefined } }));
    expect(codesOf(noD)).toContain("lease:lease_timing_invalid");
  });
  it("refuses a nonce that does not match the lease file (the proof is the last step)", async () => {
    const i = await inputs({ nonceInFile: "another-nonce-0002" });
    const r = await checkStartupRefusals(config(), createStartupPorts(i));
    expect(codesOf(r)).toEqual(["lease:lease_invalid"]);
    expect(JSON.stringify(r)).not.toContain("synthetic-nonce-0001");
  });
  it("the env port answers names and set flags only; an empty or blank value is not set", async () => {
    const ports = createStartupPorts(await inputs({ env: { A_ONE: "x", B_TWO: "", C_THREE: "  " } }));
    expect([ports.env.isSet("A_ONE"), ports.env.isSet("B_TWO"), ports.env.isSet("C_THREE"), ports.env.isSet("D_FOUR")]).toEqual([true, false, false, false]);
    expect(ports.env.credentials("mock")).toEqual({ ok: true, referenced: [] });
  });
  it("the sandbox port: kiro-cli has no registered provider in M4 and the destinations are undetermined", async () => {
    const ports = createStartupPorts(await inputs());
    expect(ports.sandbox.providerAvailable("kiro-cli")).toBe(false);
    expect(ports.sandbox.providerAvailable("mock")).toBe(true);
    expect(ports.sandbox.destinations()).toBeUndefined();
  });
});

// ---- the Runner factory --------------------------------------------------------------------------
class CountingHttp implements HttpPort {
  readonly seen: string[] = [];
  send(req: HttpRequest): Promise<{ status: number; body: string }> {
    this.seen.push(`${req.method} ${req.path}`);
    return Promise.resolve({ status: 200, body: JSON.stringify({ success: true, data: { app: "ok", db: "ok" } }) });
  }
}

describe("createRunnerFactory", () => {
  it("creating the factory and the Runner sends nothing; the first request is the health check, to the configured origin", async () => {
    const http = new CountingHttp();
    const origins: string[] = [];
    const time = new FakeTime();
    const factory = createRunnerFactory({ clock: time.clock, sleeper: time.sleeper, heartbeatIntervalMs: 1000, createHttp: (o) => (origins.push(o), http) });
    expect(http.seen).toEqual([]);
    const p = await bakedPolicy();
    if (p.kind !== "ok") throw new Error("setup");
    const table = loadPreparationTable(p.tableRaw);
    if (!table.ok) throw new Error("setup");
    const policy = loadPolicyConfig(p.policyRaw, table.value);
    if (!policy.ok) throw new Error("setup");
    const runner = factory({
      lease: new FakeLease(),
      policy: policy.value,
      table: table.value,
      mask: { paths: [] } as never,
      baseAddress: "http://reverse-proxy:8080",
      limits: DEFAULT_RUNNER_LIMITS,
      isAccepted: createAcceptanceCheck(() => []) as never,
    });
    expect(http.seen).toEqual([]);
    expect(origins).toEqual(["http://reverse-proxy:8080"]);
    const h = await runner.health();
    expect(h.ok).toBe(true);
    expect(http.seen).toEqual(["GET /health"]);
  });
});