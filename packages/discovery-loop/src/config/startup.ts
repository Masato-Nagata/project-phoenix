// Run configuration validation, stage B (task 4.1; design: "Stage B contract"; R2.9, R8.6, R11.8, R15.11, R17.2, R18.9, R19.6, R24.9).
//
// `checkStartupRefusals` orchestrates injected, read-only PORTS and imports nothing from the other packages (verifier, ai-client, analyzer):
// the port types are structural, and the adapters that wrap the real functions live in the composition root (tests: `test/support`).
// It never throws and never rejects. The ports answer in a fixed order, one call each, so the result does not depend on timing.
//
// Order: config, policy, auditConfig, env, sandbox, lease (static part), io. Every independent refusal is collected and sorted (check order,
// code, name). The start-up proof of the Run_Lease runs LAST, exactly once, and only when no other refusal exists. A `StartupApproval` exists only
// when every check ran and passed; it carries VALIDATED data only, and it cannot be forged: `isStartupApproval` is true for exactly the objects
// that this module issued (a module-private WeakSet that nothing exports).
//
// A refusal is `{ code, check, name? }`. `name` comes from a CLOSED vocabulary of constants (a setting pointer, a variable name that the
// package defines, a fixed detail code). A refusal never carries a secret value, a raw exception message, or a key name of an input.
import type { Result } from "../schema/types.js";
import type { RunConfigProvider } from "./limits.js";
import { isValidatedRunConfig, type RunConfig } from "./runConfig.js";

type Maybe<T> = T | Promise<T>;

// ---------------------------------------------------------------------------------------------
// Checks, codes, and the closed vocabulary of names
// ---------------------------------------------------------------------------------------------
export type StartupCheckId = "config" | "policy" | "auditConfig" | "env" | "sandbox" | "lease" | "io";
/** The fixed order of the checks; refusals are sorted by it. */
export const STARTUP_CHECK_ORDER: readonly StartupCheckId[] = Object.freeze(["config", "policy", "auditConfig", "env", "sandbox", "lease", "io"] as const);

export const STARTUP_REFUSAL_CODES = Object.freeze([
  "config_not_validated",
  "policy_unavailable",
  "policy_invalid",
  "preparation_table_invalid",
  "above_policy_limit",
  "audit_config_missing",
  "audit_config_empty",
  "audit_config_unreadable",
  "audit_config_invalid",
  "credential_unset",
  "provider_unknown",
  "provider_not_available",
  "sandbox_destinations_undetermined",
  "lease_env_missing",
  "lease_timing_invalid",
  "lease_invalid",
  "lease_check_failed",
  "run_volume_missing",
  "run_volume_not_writable",
  "run_volume_not_empty",
  "config_files_unexpected",
  "io_unreadable",
  "port_failed",
] as const);
export type StartupRefusalCode = (typeof STARTUP_REFUSAL_CODES)[number];

export interface StartupRefusal {
  readonly code: StartupRefusalCode;
  readonly check: StartupCheckId;
  readonly name?: string;
}

/** The names that a refusal may carry. They are constants of this package; a value from a port is used only when it is one of them. */
export const STARTUP_NAME_VOCABULARY = Object.freeze({
  policyLimits: Object.freeze(["/limits/requestsPerExperiment", "/limits/requestBodyBytes"] as const),
  auditDetails: Object.freeze([
    "fields", "schemaVersion", "tokenizer", "allowlist", "canaries", "decoys", "fingerprints", "restrictedPathPrefixes",
    "size_exceeded", "invalid_utf8", "invalid_json", "depth_exceeded", "duplicate_key", "unsafe_number",
  ] as const),
  leaseEnvNames: Object.freeze(["PHOENIX_RUN_ID", "PHOENIX_LEASE_NONCE"] as const),
  leaseTimingRules: Object.freeze([
    "heartbeat_interval_out_of_range", "stale_after_out_of_range", "propagation_delay_unmeasured",
    "rule_1_stale_below_three_heartbeats", "rule_2_healthy_launcher_could_be_judged_stale", "rule_3_stop_exceeds_ten_seconds",
  ] as const),
  leaseReasons: Object.freeze(["missing", "malformed", "run_mismatch", "nonce_mismatch", "revoked", "heartbeat_stale", "unreadable"] as const),
});
/** The two files that `/run/config` holds, and nothing else (design: mount table). */
export const EXPECTED_CONFIG_FILES: readonly string[] = Object.freeze(["audit-config.json", "run-config.json"]);

// ---------------------------------------------------------------------------------------------
// Ports (structural; read-only; no method writes)
// ---------------------------------------------------------------------------------------------
export type PolicyLoad<TPolicy, TTable> =
  | {
      readonly ok: true;
      readonly policy: TPolicy;
      readonly table: TTable;
      readonly limits: { readonly requests: number; readonly bodyBytes: number };
      readonly policySha256: string;
      readonly preparationTableSha256: string;
    }
  | { readonly ok: false; readonly code: "unavailable" | "invalid" | "table_invalid" };

/** The shape of `AuditConfigLoadResult` of ai-client; `load` is the whole result with `ok: true`, which `auditPayload` takes as its `cfg`. */
export type AuditLoad<TAudit> =
  | { readonly ok: true; readonly load: TAudit; readonly sha256: string }
  | { readonly ok: false; readonly reason: "missing" | "unreadable" | "empty" | "invalid"; readonly detail?: string };

export type CredentialView =
  | { readonly ok: true; readonly referenced: readonly { readonly name: string; readonly set: boolean }[] }
  | { readonly ok: false; readonly code: "credential_unset" | "unknown_provider"; readonly variable?: string };

export type LeaseTimingView =
  | { readonly ok: true; readonly heartbeatIntervalMs: number; readonly staleAfterMs: number; readonly propagationDelayMs: number }
  | { readonly ok: false; readonly errors: readonly string[] };

export type LeaseCheckView = { readonly valid: true } | { readonly valid: false; readonly reason: string };

export interface StartupPorts<TPolicy = unknown, TTable = unknown, TAudit = unknown, TLease = unknown> {
  readonly policy: { load(): Maybe<PolicyLoad<TPolicy, TTable>> };
  readonly auditConfig: { load(): Maybe<AuditLoad<TAudit>> };
  /** No method returns the value of a variable. */
  readonly env: { isSet(name: string): Maybe<boolean>; credentials(provider: RunConfigProvider): Maybe<CredentialView> };
  readonly sandbox: { providerAvailable(provider: RunConfigProvider): Maybe<boolean>; destinations(): Maybe<readonly string[] | undefined> };
  readonly lease: {
    variables(): Maybe<{ readonly runId: boolean; readonly nonce: boolean }>;
    timing(): Maybe<LeaseTimingView>;
    /** The RunLease instance that `check()` proves; the Runner later uses the SAME instance. */
    port(): Maybe<TLease>;
    check(): Promise<LeaseCheckView>;
  };
  readonly io: {
    runVolume(): Maybe<{ readonly exists: boolean; readonly writable: boolean; readonly empty: boolean } | undefined>;
    configFiles(): Maybe<readonly string[] | undefined>;
  };
}

// ---------------------------------------------------------------------------------------------
// The approval
// ---------------------------------------------------------------------------------------------
export interface StartupApproval<TPolicy = unknown, TTable = unknown, TAudit = unknown, TLease = unknown> {
  readonly config: RunConfig;
  readonly policy: {
    readonly value: TPolicy;
    readonly table: TTable;
    readonly limits: { readonly requests: number; readonly bodyBytes: number };
    readonly policySha256: string;
    readonly preparationTableSha256: string;
  };
  readonly auditConfig: { readonly load: TAudit; readonly sha256: string };
  /** The first argument of `mayStartRun`. It is `pass` because stage B refuses otherwise. */
  readonly payloadAuditConfig: "pass";
  /** The names of `envNames` and of the credentials, set or unset only (R19.3). */
  readonly envVarsRead: readonly { readonly name: string; readonly set: boolean }[];
  readonly credentials: readonly { readonly name: string; readonly set: boolean }[];
  readonly sandbox: { readonly applicable: false } | { readonly applicable: true; readonly destinations: readonly string[] };
  readonly lease: {
    readonly port: TLease;
    readonly heartbeatIntervalMs: number;
    readonly staleAfterMs: number;
    readonly propagationDelayMs: number;
    readonly proven: true;
  };
}

/** Everything this module issued, and nothing else. No function adds to it except `checkStartupRefusals` on success. */
const issuedApprovals = new WeakSet<object>();

/** True only for an approval that `checkStartupRefusals` issued. A copy, a frozen clone, or a look-alike with the same fields is not one. */
export function isStartupApproval(x: unknown): x is StartupApproval {
  return typeof x === "object" && x !== null && issuedApprovals.has(x);
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isPosInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
const isSha256 = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{64}$/.test(v);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
const CREDENTIAL_VARIABLE = /^[A-Z][A-Z0-9_]{0,63}$/;
const inList = (list: readonly string[], v: unknown): v is string => typeof v === "string" && list.includes(v);

/** An unexpected shape of a port answer. Never carries a message: the catch blocks drop every error anyway. */
class Shape extends Error {}
const shape = (): never => {
  throw new Shape("x");
};

/**
 * Freezes plain data (objects with the Object prototype or none, and arrays) in place and returns THE SAME reference: identity is kept, nothing
 * is copied. Other objects (a RunLease, a typed array, a class instance) are left alone. Getters are not run.
 */
function freezeData<T>(v: T, depth = 0, seen: WeakSet<object> = new WeakSet()): T {
  if (!isObj(v) || depth > 32 || seen.has(v)) return v;
  const proto: unknown = Object.getPrototypeOf(v);
  if (!Array.isArray(v) && proto !== Object.prototype && proto !== null) return v;
  seen.add(v);
  for (const key of Reflect.ownKeys(v)) {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (d !== undefined && "value" in d) freezeData(d.value, depth + 1, seen);
  }
  return Object.freeze(v);
}

interface Collected {
  readonly refusals: StartupRefusal[];
}
const add = (c: Collected, check: StartupCheckId, code: StartupRefusalCode, name?: string): void => {
  c.refusals.push(name === undefined ? { code, check } : { code, check, name });
};

/** Runs one step of a check. An exception, a rejection or an unexpected shape inside it gives `port_failed`; what the step added is dropped. */
async function step(c: Collected, check: StartupCheckId, body: () => Promise<void>): Promise<void> {
  const before = c.refusals.length;
  try {
    await body();
  } catch {
    c.refusals.length = before;
    add(c, check, "port_failed");
  }
}

function finish(refusals: readonly StartupRefusal[]): StartupRefusal[] {
  const seen = new Set<string>();
  const out: StartupRefusal[] = [];
  for (const r of refusals) {
    const key = `${r.check}\u0000${r.code}\u0000${r.name ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(Object.freeze(r.name === undefined ? { code: r.code, check: r.check } : { code: r.code, check: r.check, name: r.name }));
    }
  }
  const rank = (c: StartupCheckId): number => STARTUP_CHECK_ORDER.indexOf(c);
  return out.sort((a, b) => rank(a.check) - rank(b.check) || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0) || ((a.name ?? "") < (b.name ?? "") ? -1 : (a.name ?? "") > (b.name ?? "") ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------------------------
/**
 * Stage B of the start-up validation. Returns the approval, or every refusal in the fixed order. Never throws, never rejects. The ports are
 * called in a fixed order, each at most once (`env.isSet` once per distinct name); the lease check is called only when nothing else was refused.
 */
export async function checkStartupRefusals<TPolicy, TTable, TAudit, TLease>(
  cfg: RunConfig,
  ports: StartupPorts<TPolicy, TTable, TAudit, TLease>,
): Promise<Result<StartupApproval<TPolicy, TTable, TAudit, TLease>, StartupRefusal[]>> {
  try {
    // config: only a configuration that stage A returned is trusted; nothing else is meaningful without it, so no port is called.
    if (!isValidatedRunConfig(cfg)) return { ok: false, error: finish([{ code: "config_not_validated", check: "config" }]) };

    const c: Collected = { refusals: [] };
    const provider = cfg.provider;
    const wantRequests = cfg.limits.requestsPerExperiment;
    const wantBody = cfg.limits.requestBodyBytes;
    const envNames = [...new Set(cfg.envNames)];

    // What the checks found. A holder object (not several `let` variables) because the steps assign inside closures.
    const got: {
      policy?: StartupApproval<TPolicy, TTable, TAudit, TLease>["policy"];
      audit?: StartupApproval<TPolicy, TTable, TAudit, TLease>["auditConfig"];
      credentials?: { name: string; set: boolean }[];
      flags?: { name: string; set: boolean }[];
      sandbox?: StartupApproval["sandbox"];
      timing?: { heartbeatIntervalMs: number; staleAfterMs: number; propagationDelayMs: number };
      leaseEnvOk?: boolean;
      leasePort?: TLease;
      sandboxAvailable?: boolean;
      sandboxDestinations?: string[];
      sandboxAnswered: number;
    } = { sandboxAnswered: 0 };

    // policy ---------------------------------------------------------------------------------
    await step(c, "policy", async () => {
      const r: unknown = await ports.policy.load();
      if (!isObj(r)) return shape();
      const ok = r["ok"];
      if (ok === false) {
        const code = r["code"];
        if (code === "unavailable") add(c, "policy", "policy_unavailable");
        else if (code === "invalid") add(c, "policy", "policy_invalid");
        else if (code === "table_invalid") add(c, "policy", "preparation_table_invalid");
        else shape();
        return;
      }
      if (ok !== true) return shape();
      const value = r["policy"];
      const table = r["table"];
      const limits = r["limits"];
      const policySha256 = r["policySha256"];
      const tableSha256 = r["preparationTableSha256"];
      if (value === undefined || value === null || table === undefined || table === null || !isObj(limits)) return shape();
      const requests = limits["requests"];
      const bodyBytes = limits["bodyBytes"];
      if (!isPosInt(requests) || !isPosInt(bodyBytes) || !isSha256(policySha256) || !isSha256(tableSha256)) return shape();
      // The effective values of the run configuration against the loaded policy (equal passes). The policy is never changed.
      if (wantRequests > requests) add(c, "policy", "above_policy_limit", "/limits/requestsPerExperiment");
      if (wantBody > bodyBytes) add(c, "policy", "above_policy_limit", "/limits/requestBodyBytes");
      got.policy = Object.freeze({
        value: freezeData(value as TPolicy),
        table: freezeData(table as TTable),
        limits: Object.freeze({ requests, bodyBytes }),
        policySha256,
        preparationTableSha256: tableSha256,
      });
    });

    // auditConfig ----------------------------------------------------------------------------
    await step(c, "auditConfig", async () => {
      const r: unknown = await ports.auditConfig.load();
      if (!isObj(r)) return shape();
      const ok = r["ok"];
      if (ok === false) {
        const reason = r["reason"];
        if (reason === "missing") add(c, "auditConfig", "audit_config_missing");
        else if (reason === "empty") add(c, "auditConfig", "audit_config_empty");
        else if (reason === "unreadable") add(c, "auditConfig", "audit_config_unreadable");
        else if (reason === "invalid") {
          const detail = r["detail"];
          add(c, "auditConfig", "audit_config_invalid", inList(STARTUP_NAME_VOCABULARY.auditDetails, detail) ? detail : undefined);
        } else shape();
        return;
      }
      if (ok !== true) return shape();
      const load = r["load"];
      const sha256 = r["sha256"];
      if (!isObj(load) || !isSha256(sha256)) return shape();
      got.audit = Object.freeze({ load: freezeData(load as TAudit), sha256 });
    });

    // env ------------------------------------------------------------------------------------
    await step(c, "env", async () => {
      const r: unknown = await ports.env.credentials(provider);
      if (!isObj(r)) return shape();
      const ok = r["ok"];
      if (ok === false) {
        const code = r["code"];
        if (code === "credential_unset") {
          const variable = r["variable"];
          add(c, "env", "credential_unset", typeof variable === "string" && CREDENTIAL_VARIABLE.test(variable) ? variable : undefined);
        } else if (code === "unknown_provider") add(c, "env", "provider_unknown");
        else shape();
        return;
      }
      if (ok !== true) return shape();
      const referenced = r["referenced"];
      if (!Array.isArray(referenced)) return shape();
      const list: { name: string; set: boolean }[] = [];
      for (const e of referenced as unknown[]) {
        if (!isObj(e)) return shape();
        const name = e["name"];
        const set = e["set"];
        // `ok: true` with an unset credential contradicts itself: a port that says so is not trusted.
        if (typeof name !== "string" || !ENV_NAME.test(name) || set !== true) return shape();
        list.push({ name, set });
      }
      got.credentials = list;
    });
    await step(c, "env", async () => {
      const list: { name: string; set: boolean }[] = [];
      for (const name of envNames) {
        const set: unknown = await ports.env.isSet(name);
        if (!isBool(set)) return shape();
        list.push({ name, set });
      }
      got.flags = list;
    });

    // sandbox --------------------------------------------------------------------------------
    if (provider === "kiro-cli") {
      await step(c, "sandbox", async () => {
        const v: unknown = await ports.sandbox.providerAvailable(provider);
        if (!isBool(v)) return shape();
        got.sandboxAvailable = v;
        if (!v) add(c, "sandbox", "provider_not_available");
        got.sandboxAnswered += 1;
      });
      await step(c, "sandbox", async () => {
        const v: unknown = await ports.sandbox.destinations();
        if (v === undefined) {
          add(c, "sandbox", "sandbox_destinations_undetermined");
        } else {
          if (!Array.isArray(v)) return shape();
          const list: string[] = [];
          for (const e of v as unknown[]) {
            if (typeof e !== "string" || e.length < 1 || e.length > 255) return shape();
            list.push(e);
          }
          if (list.length === 0) add(c, "sandbox", "sandbox_destinations_undetermined");
          else got.sandboxDestinations = list;
        }
        got.sandboxAnswered += 1;
      });
      if (got.sandboxAnswered === 2 && got.sandboxAvailable === true && got.sandboxDestinations !== undefined) {
        got.sandbox = Object.freeze({ applicable: true as const, destinations: Object.freeze([...got.sandboxDestinations]) });
      }
    } else {
      got.sandbox = Object.freeze({ applicable: false as const });
    }

    // lease (static part) --------------------------------------------------------------------
    await step(c, "lease", async () => {
      const v: unknown = await ports.lease.variables();
      if (!isObj(v)) return shape();
      const runId = v["runId"];
      const nonce = v["nonce"];
      if (!isBool(runId) || !isBool(nonce)) return shape();
      if (!runId) add(c, "lease", "lease_env_missing", "PHOENIX_RUN_ID");
      if (!nonce) add(c, "lease", "lease_env_missing", "PHOENIX_LEASE_NONCE");
      got.leaseEnvOk = runId && nonce;
    });
    await step(c, "lease", async () => {
      const t: unknown = await ports.lease.timing();
      if (!isObj(t)) return shape();
      const ok = t["ok"];
      if (ok === false) {
        const errors = t["errors"];
        if (!Array.isArray(errors)) return shape();
        const names = (errors as unknown[]).filter((e): e is string => inList(STARTUP_NAME_VOCABULARY.leaseTimingRules, e));
        if (names.length === 0) add(c, "lease", "lease_timing_invalid");
        for (const n of names) add(c, "lease", "lease_timing_invalid", n);
        return;
      }
      if (ok !== true) return shape();
      const h = t["heartbeatIntervalMs"];
      const s = t["staleAfterMs"];
      const d = t["propagationDelayMs"];
      if (!isPosInt(h) || !isPosInt(s) || typeof d !== "number" || !Number.isFinite(d) || d < 0) return shape();
      got.timing = { heartbeatIntervalMs: h, staleAfterMs: s, propagationDelayMs: d };
    });

    // io -------------------------------------------------------------------------------------
    await step(c, "io", async () => {
      const v: unknown = await ports.io.runVolume();
      if (v === undefined) {
        add(c, "io", "io_unreadable");
        return;
      }
      if (!isObj(v)) return shape();
      const exists = v["exists"];
      const writable = v["writable"];
      const empty = v["empty"];
      if (!isBool(exists) || !isBool(writable) || !isBool(empty)) return shape();
      if (!exists) {
        add(c, "io", "run_volume_missing");
        return;
      }
      if (!writable) add(c, "io", "run_volume_not_writable");
      if (!empty) add(c, "io", "run_volume_not_empty");
    });
    await step(c, "io", async () => {
      const v: unknown = await ports.io.configFiles();
      if (v === undefined) {
        add(c, "io", "io_unreadable");
        return;
      }
      if (!Array.isArray(v)) return shape();
      const names: string[] = [];
      for (const e of v as unknown[]) {
        if (typeof e !== "string") return shape();
        names.push(e);
      }
      // exactly the two files, no other, none twice; a name is never echoed
      const same = names.length === EXPECTED_CONFIG_FILES.length && EXPECTED_CONFIG_FILES.every((f) => names.includes(f)) && new Set(names).size === names.length;
      if (!same) add(c, "io", "config_files_unexpected");
    });

    if (c.refusals.length > 0) return { ok: false, error: finish(c.refusals) };

    // lease: the start-up proof, LAST, once, and only when nothing else was refused ------------------
    await step(c, "lease", async () => {
      const p: unknown = await ports.lease.port();
      if (p === undefined || p === null) return shape();
      got.leasePort = p as TLease;
    });
    if (got.leasePort !== undefined) {
      let view: unknown;
      let threw = false;
      try {
        view = await ports.lease.check();
      } catch {
        threw = true; // the message is dropped; `LeaseCheckInterrupted` and any other failure are the same refusal
      }
      if (threw) add(c, "lease", "lease_check_failed");
      else if (!isObj(view) || !isBool(view["valid"])) add(c, "lease", "port_failed");
      else if (view["valid"] === false) {
        const reason = view["reason"];
        add(c, "lease", "lease_invalid", inList(STARTUP_NAME_VOCABULARY.leaseReasons, reason) ? reason : undefined);
      }
    }
    if (c.refusals.length > 0) return { ok: false, error: finish(c.refusals) };

    // issue: every check ran and passed (a missing piece here would be a defect, and it fails closed) ---
    const { policy, audit, credentials, flags, sandbox, timing, leasePort } = got;
    if (policy === undefined || audit === undefined || credentials === undefined || flags === undefined || sandbox === undefined || timing === undefined || got.leaseEnvOk !== true || leasePort === undefined) {
      return { ok: false, error: finish([{ code: "port_failed", check: "config" }]) };
    }
    const envVarsRead = [...flags];
    for (const cr of credentials) if (!envVarsRead.some((e) => e.name === cr.name)) envVarsRead.push({ name: cr.name, set: cr.set });
    const approval: StartupApproval<TPolicy, TTable, TAudit, TLease> = Object.freeze({
      config: cfg,
      policy,
      auditConfig: audit,
      payloadAuditConfig: "pass" as const,
      envVarsRead: Object.freeze(envVarsRead.map((e) => Object.freeze({ name: e.name, set: e.set }))),
      credentials: Object.freeze(credentials.map((e) => Object.freeze({ name: e.name, set: e.set }))),
      sandbox,
      lease: Object.freeze({
        port: leasePort,
        heartbeatIntervalMs: timing.heartbeatIntervalMs,
        staleAfterMs: timing.staleAfterMs,
        propagationDelayMs: timing.propagationDelayMs,
        proven: true as const,
      }),
    });
    issuedApprovals.add(approval);
    return { ok: true, value: approval };
  } catch {
    // Nothing above should throw; if something does, nothing is issued and nothing of the error is kept.
    return { ok: false, error: finish([{ code: "port_failed", check: "config" }]) };
  }
}