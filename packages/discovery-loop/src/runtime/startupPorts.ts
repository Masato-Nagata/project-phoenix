// The production ports of stage B (`checkStartupRefusals`, task 4.9-B). Every port wraps an EXISTING function of a sibling package through
// its public root entry; nothing here re-implements a check, and stage B itself (order, refusal codes, the single lease proof) is unchanged.
//
//   policy       the baked policy data: `loadPreparationTable`, then `loadPolicyConfig(raw, table)`, then the two hashes of OD-17
//   auditConfig  the bytes of the mounted audit configuration: `parseAuditConfig` (a missing file is `undefined`, as the parser expects)
//   env          names and set flags only (`isSet`), and `checkProviderCredentials`; no method returns a value
//   sandbox      `createProvider` decides whether a provider has a registered factory; the destinations are undetermined in M4
//   lease        ONE `RunLease` (`createLeasePort`), created on first use and returned by `port()` and proven by `check()`; H and S are
//                `DEFAULT_LEASE_SETTINGS`, D is the measured propagation delay that the composition root read; timing is `checkLeaseTiming`
//   io           the answers of the composition root (the Run_Volume state and the names in the configuration directory)
//
// The raw lease nonce goes to `createLeasePort` and nowhere else in this module. The run id is the one constant the composition root read.
// No port reads the environment by itself: the composition root passes one read-only view of it.
import { ProviderSelectionError, checkProviderCredentials, createProvider, parseAuditConfig } from "@phoenix/ai-client";
import type { AuditConfigLoadResult, EnvironmentLike } from "@phoenix/ai-client";
import { DEFAULT_LEASE_SETTINGS, checkLeaseTiming, createLeasePort, loadPolicyConfig, loadPreparationTable, policyConfigSha256, preparationTableSha256 } from "@phoenix/verifier";
import type { MonotonicClock, PolicyConfig, PrepTable, RunLease, Sleeper } from "@phoenix/verifier";
import type { AuditLoad, CredentialView, LeaseCheckView, LeaseTimingView, PolicyLoad, StartupPorts } from "../config/index.js";
import type { InputRead } from "./startupInputs.js";

/** The parsed JSON of the two baked files, or `unavailable` when either could not be read or parsed. */
export type BakedPolicyInput = { readonly kind: "ok"; readonly policyRaw: unknown; readonly tableRaw: unknown } | { readonly kind: "unavailable" };

export interface RunVolumeState {
  readonly exists: boolean;
  readonly writable: boolean;
  readonly empty: boolean;
}

export interface StartupPortInputs {
  readonly policy: BakedPolicyInput;
  readonly auditConfig: InputRead;
  readonly env: EnvironmentLike;
  readonly lease: {
    readonly directory: string;
    readonly runId: string;
    readonly nonce: string;
    /** D, already restricted to `^[0-9]{1,6}$` by the composition root; `undefined` when unset or malformed. */
    readonly propagationDelayMs: number | undefined;
    readonly clock: MonotonicClock;
    readonly sleeper: Sleeper;
  };
  readonly io: {
    runVolume(): RunVolumeState | undefined;
    configFiles(): readonly string[] | undefined;
  };
}

export type ProductionStartupPorts = StartupPorts<PolicyConfig, PrepTable, AuditConfigLoadResult, RunLease>;

const isSetValue = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
const nonEmpty = (v: unknown): boolean => typeof v === "string" && v.length > 0;

export function createStartupPorts(inputs: StartupPortInputs): ProductionStartupPorts {
  const { env, lease, io } = inputs;

  const policy = {
    load(): PolicyLoad<PolicyConfig, PrepTable> {
      const p = inputs.policy;
      if (p.kind !== "ok") return { ok: false, code: "unavailable" };
      const table = loadPreparationTable(p.tableRaw);
      if (!table.ok) return { ok: false, code: "table_invalid" };
      const value = loadPolicyConfig(p.policyRaw, table.value);
      if (!value.ok) return { ok: false, code: "invalid" };
      return {
        ok: true,
        policy: value.value,
        table: table.value,
        limits: { requests: value.value.limits.requests, bodyBytes: value.value.limits.bodyBytes },
        policySha256: policyConfigSha256(value.value),
        preparationTableSha256: preparationTableSha256(table.value),
      };
    },
  };

  const auditConfig = {
    load(): AuditLoad<AuditConfigLoadResult> {
      const a = inputs.auditConfig;
      if (a.kind === "unreadable") return { ok: false, reason: "unreadable" };
      const r = parseAuditConfig(a.kind === "ok" ? a.bytes : undefined);
      if (r.ok) return { ok: true, load: r, sha256: r.sha256 };
      return r.detail === undefined ? { ok: false, reason: r.reason } : { ok: false, reason: r.reason, detail: r.detail };
    },
  };

  const envPort = {
    isSet: (name: string): boolean => Object.hasOwn(env, name) && isSetValue(env[name]),
    credentials(provider: "mock" | "kiro-cli"): CredentialView {
      const r = checkProviderCredentials(provider, env);
      if (r.ok) return { ok: true, referenced: r.referenced.map((x) => ({ name: x.name, set: x.set })) };
      return r.error.variable === undefined ? { ok: false, code: r.error.code } : { ok: false, code: r.error.code, variable: r.error.variable };
    },
  };

  const sandbox = {
    providerAvailable(provider: "mock" | "kiro-cli"): boolean {
      try {
        createProvider({ provider });
        return true;
      } catch (error) {
        if (error instanceof ProviderSelectionError && error.code === "provider_not_available") return false;
        throw error;
      }
    },
    /** M4 has no AI_Sandbox: the destinations are not determined (R18.9). */
    destinations: (): readonly string[] | undefined => undefined,
  };

  let instance: RunLease | undefined;
  const timing = (): ReturnType<typeof checkLeaseTiming> => checkLeaseTiming(DEFAULT_LEASE_SETTINGS, lease.propagationDelayMs);
  const build = (): RunLease => {
    if (instance !== undefined) return instance;
    const t = timing();
    if (!t.ok) throw new Error("lease timing invalid");
    instance = createLeasePort({ directory: lease.directory, runId: lease.runId, nonce: lease.nonce, timing: t.value, clock: lease.clock, sleeper: lease.sleeper });
    return instance;
  };
  const leasePort = {
    variables: () => ({ runId: nonEmpty(lease.runId), nonce: nonEmpty(lease.nonce) }),
    timing(): LeaseTimingView {
      const t = timing();
      return t.ok
        ? { ok: true, heartbeatIntervalMs: t.value.heartbeatIntervalMs, staleAfterMs: t.value.staleAfterMs, propagationDelayMs: t.value.propagationDelayMs }
        : { ok: false, errors: t.error };
    },
    port: build,
    async check(): Promise<LeaseCheckView> {
      const state = await build().check();
      return state.valid ? { valid: true, runId: lease.runId } : { valid: false, reason: state.reason };
    },
  };

  return Object.freeze({ policy, auditConfig, env: envPort, sandbox, lease: leasePort, io });
}