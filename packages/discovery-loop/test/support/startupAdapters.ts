// Test support for task 4.1, stage B: adapters that wrap the REAL functions of the other packages as the ports of `checkStartupRefusals`.
// They are the model for the composition root of tasks 4.4 and 4.9 (where the dependency on those packages is decided). They are test-only: they
// import the sibling SOURCES as `aiClientJsonParity.test.ts` does, so `packages/discovery-loop/src` still has no runtime dependency on them.
// Everything here is synthetic: fictitious canaries, a temporary lease directory, no real configuration, no network.
import { createHash } from "node:crypto";
import { accessSync, constants, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderSelectionError, checkProviderCredentials, createProvider, parseAuditConfig } from "../../../ai-client/src/index.js";
import { policyConfigSha256, preparationTableSha256 } from "../../../verifier/src/identity/hash.js";
import { createLeasePort } from "../../../verifier/src/lease/fsLeaseView.js";
import { DEFAULT_LEASE_SETTINGS, checkLeaseTiming } from "../../../verifier/src/lease/timing.js";
import type { MonotonicClock, Sleeper } from "../../../verifier/src/lease/types.js";
import { loadPolicyConfig } from "../../../verifier/src/policy/config.js";
import { loadPreparationTable } from "../../../verifier/src/prep/table.js";
import type { AuditLoad, LeaseCheckView, LeaseTimingView, PolicyLoad, StartupPorts } from "../../src/index.js";

const dataFile = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../../verifier/data/${name}`, import.meta.url), "utf8")) as unknown;

/** The baked data of the runtime image, exactly as `probe/main.ts` reads it. */
export const bakedPolicyRaw = (): unknown => dataFile("policy-config.json");
export const bakedPreparationTableRaw = (): unknown => dataFile("preparation-table.json");

// ---- policy ----------------------------------------------------------------------------------
type RealPolicy = ReturnType<typeof loadPolicyConfig> extends { ok: true; value: infer V } | { ok: false; error: unknown } ? V : never;
type RealTable = ReturnType<typeof loadPreparationTable> extends { ok: true; value: infer V } | { ok: false; error: unknown } ? V : never;

/** `loadPreparationTable`, then `loadPolicyConfig(raw, table)` (as `probe.ts` does), then the two hashes of OD-17. */
export function policyPort(rawPolicy: () => unknown = bakedPolicyRaw, rawTable: () => unknown = bakedPreparationTableRaw): StartupPorts<RealPolicy, RealTable>["policy"] {
  return {
    load(): PolicyLoad<RealPolicy, RealTable> {
      let policyRaw: unknown;
      let tableRaw: unknown;
      try {
        policyRaw = rawPolicy();
        tableRaw = rawTable();
      } catch {
        return { ok: false, code: "unavailable" };
      }
      const table = loadPreparationTable(tableRaw);
      if (!table.ok) return { ok: false, code: "table_invalid" };
      const policy = loadPolicyConfig(policyRaw, table.value);
      if (!policy.ok) return { ok: false, code: "invalid" };
      return {
        ok: true,
        policy: policy.value as RealPolicy,
        table: table.value as RealTable,
        limits: { requests: policy.value.limits.requests, bodyBytes: policy.value.limits.bodyBytes },
        policySha256: policyConfigSha256(policy.value),
        preparationTableSha256: preparationTableSha256(table.value),
      };
    },
  };
}

// ---- audit configuration ----------------------------------------------------------------------
/** A synthetic audit configuration that `parseAuditConfig` accepts: fictitious values, no restricted content. */
export const syntheticAuditConfig = (): Record<string, unknown> => ({
  schemaVersion: 1,
  allowlist: ["legacy/src/utils.php"],
  canaries: [{ id: "canary-1", value: "SYNTHETIC-CANARY-0001" }],
  decoys: [{ id: "decoy-1", value: "SYNTHETIC-DECOY-0001" }],
  fingerprints: [1, 2, 3, 4].map((i) => ({ id: `fp-${i}`, fileId: `file-${i}`, n: 12, hashes: ["0123456789ab", "ba9876543210"] })),
  restrictedPathPrefixes: ["synthetic-restricted/"],
  tokenizer: "token-ngram-sha256-v1",
});
export const toBytes = (v: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(v));

type RealAuditLoad = ReturnType<typeof parseAuditConfig>;
/** `parseAuditConfig` once; `load` is the whole result, which `auditPayload` takes as its `cfg`. */
export function auditPort(bytes: () => Uint8Array | undefined): StartupPorts<RealAuditLoad>["auditConfig"] {
  return {
    load(): AuditLoad<RealAuditLoad> {
      const r = parseAuditConfig(bytes());
      if (r.ok) return { ok: true, load: r, sha256: r.sha256 };
      return r.detail === undefined ? { ok: false, reason: r.reason } : { ok: false, reason: r.reason, detail: r.detail };
    },
  };
}

// ---- environment and sandbox --------------------------------------------------------------------
export type FakeEnv = Readonly<Record<string, string | undefined>>;
const isSetValue = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

/** `checkProviderCredentials`; only names and set flags cross the port. */
export function envPort(env: FakeEnv): StartupPorts["env"] {
  return {
    isSet: (name) => Object.hasOwn(env, name) && isSetValue(env[name]),
    credentials(provider) {
      const r = checkProviderCredentials(provider, env);
      if (r.ok) return { ok: true, referenced: r.referenced.map((x) => ({ name: x.name, set: x.set })) };
      return r.error.variable === undefined ? { ok: false, code: r.error.code } : { ok: false, code: r.error.code, variable: r.error.variable };
    },
  };
}

/** `createProvider` decides whether a provider has a registered factory (M4: `mock` yes, `kiro-cli` no). */
export function sandboxPort(destinations: () => readonly string[] | undefined): StartupPorts["sandbox"] {
  return {
    providerAvailable(provider) {
      try {
        createProvider({ provider });
        return true;
      } catch (error) {
        if (error instanceof ProviderSelectionError && error.code === "provider_not_available") return false;
        throw error;
      }
    },
    destinations,
  };
}

// ---- lease --------------------------------------------------------------------------------------
/** A fake monotonic clock whose sleeper advances it; `onSleep` plays the Launcher (it may write a heartbeat). */
export class FakeTime {
  now = 0;
  onSleep: (() => void) | undefined;
  readonly clock: MonotonicClock = { nowMs: () => this.now };
  readonly sleeper: Sleeper = {
    sleep: (ms) => {
      this.now += Math.max(0, ms);
      this.onSleep?.();
      return Promise.resolve();
    },
  };
}

export interface FakeLeaseDir {
  readonly directory: string;
  readonly runId: string;
  readonly nonce: string;
  beat(): void;
}
/** A lease directory as the Launcher writes it (`lease.json`, `heartbeat`), in a temporary directory. */
export function makeLeaseDir(opts: { runId?: string; nonce?: string; heartbeatIntervalMs?: number; staleAfterMs?: number; runIdInFile?: string } = {}): FakeLeaseDir {
  const directory = mkdtempSync(join(tmpdir(), "phoenix-lease-"));
  const runId = opts.runId ?? "run-synthetic-0001";
  const nonce = opts.nonce ?? "synthetic-nonce-0001";
  const leaseJson = {
    heartbeat_interval_ms: opts.heartbeatIntervalMs ?? DEFAULT_LEASE_SETTINGS.heartbeatIntervalMs,
    issued_by: "launcher",
    launcher_pid: 1,
    launcher_start_ticks: "1",
    nonce_sha256: createHash("sha256").update(nonce, "utf8").digest("hex"),
    run_id: opts.runIdInFile ?? runId,
    stale_after_ms: opts.staleAfterMs ?? DEFAULT_LEASE_SETTINGS.staleAfterMs,
  };
  writeFileSync(join(directory, "lease.json"), JSON.stringify(leaseJson));
  let counter = 1;
  writeFileSync(join(directory, "heartbeat"), String(counter));
  return {
    directory,
    runId,
    nonce,
    beat: () => {
      counter += 1;
      writeFileSync(join(directory, "heartbeat"), String(counter));
    },
  };
}

export type RealLeasePort = ReturnType<typeof createLeasePort>;
/**
 * The lease port as the composition root builds it: H and S are DEFAULT_LEASE_SETTINGS, D is the environment variable PHOENIX_LEASE_D_MS
 * (only `^[0-9]{1,6}$`), the timing is `checkLeaseTiming`, and ONE `RunLease` (`createLeasePort`) is created and reused by `port()` and `check()`.
 */
export function leasePort(env: FakeEnv, directory: string, time: FakeTime, counters?: { created: number }): StartupPorts<unknown, unknown, unknown, RealLeasePort>["lease"] {
  const nonEmpty = (v: string | undefined): boolean => typeof v === "string" && v.length > 0;
  const dText = env["PHOENIX_LEASE_D_MS"] ?? "";
  const d = /^[0-9]{1,6}$/.test(dText) ? Number(dText) : undefined;
  let instance: RealLeasePort | undefined;
  const build = (): RealLeasePort => {
    if (instance !== undefined) return instance;
    const timing = checkLeaseTiming(DEFAULT_LEASE_SETTINGS, d);
    if (!timing.ok) throw new Error("timing");
    if (counters !== undefined) counters.created += 1;
    instance = createLeasePort({ directory, runId: env["PHOENIX_RUN_ID"] ?? "", nonce: env["PHOENIX_LEASE_NONCE"] ?? "", timing: timing.value, clock: time.clock, sleeper: time.sleeper });
    return instance;
  };
  return {
    variables: () => ({ runId: nonEmpty(env["PHOENIX_RUN_ID"]), nonce: nonEmpty(env["PHOENIX_LEASE_NONCE"]) }),
    timing(): LeaseTimingView {
      const t = checkLeaseTiming(DEFAULT_LEASE_SETTINGS, d);
      return t.ok
        ? { ok: true, heartbeatIntervalMs: t.value.heartbeatIntervalMs, staleAfterMs: t.value.staleAfterMs, propagationDelayMs: t.value.propagationDelayMs }
        : { ok: false, errors: t.error };
    },
    port: build,
    async check(): Promise<LeaseCheckView> {
      const state = await build().check();
      return state.valid ? { valid: true } : { valid: false, reason: state.reason };
    },
  };
}

// ---- io -----------------------------------------------------------------------------------------
/** The fixed locations, read with `node:fs` from two directories (in the runtime: `/run/out` and `/run/config`). */
export function ioPort(volumeDir: string | undefined, configDir: string | undefined): StartupPorts["io"] {
  return {
    runVolume() {
      if (volumeDir === undefined) return undefined;
      try {
        const entries = readdirSync(volumeDir);
        let writable = true;
        try {
          accessSync(volumeDir, constants.W_OK);
        } catch {
          writable = false;
        }
        return { exists: true, writable, empty: entries.length === 0 };
      } catch (error) {
        return (error as { code?: string }).code === "ENOENT" ? { exists: false, writable: false, empty: false } : undefined;
      }
    },
    configFiles() {
      if (configDir === undefined) return undefined;
      try {
        return readdirSync(configDir);
      } catch {
        return undefined;
      }
    },
  };
}
export const makeTempDir = (prefix: string): string => mkdtempSync(join(tmpdir(), prefix));
export { mkdirSync, writeFileSync };