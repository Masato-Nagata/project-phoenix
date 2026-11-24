// The Run_Manifest assembly port (task 4.6, work unit W5-B): `createManifestPort(ctx)` gives the `ManifestPort` of ONE Run, and
// `createStartStateCell(runId)` gives the one-time cell through which the Run's start-state measurement reaches it.
//
// Who knows what. `ManifestCore` (13 keys, unchanged) is what the orchestrator knows at the end of the Run. Everything else is held by the
// closure of the port, built for this Run by the composition root (W6) after stage B: the lease facts, the launcher facts and the runtime
// version facts (each with the port that re-reads them), the sandbox facts of stage B, the configured provider, and the start-state cell.
//
// `build(core)` is synchronous (the `ManifestPort` contract) and runs ONCE. In this fixed order it checks the core and its brand, the
// Source_Bundle, the run id of every source, re-reads the lease facts and the launcher facts and re-collects the runtime versions, checks the
// audit configuration hash, the lease timing and the provider, reads the start-state cell, and only then calls the section builders. The
// first failure throws an `Error` whose message is a closed code: `terminate()` then ends the Run unsealed with `manifest_build_failed`.
// Nothing is filled in (no `unknown`, no empty text, no fixed value), nothing is retried, and no value, path or file text leaves this module.
// The output has no `schemaVersion`, `chain` or `artifacts`: the store adds them when it seals (schema version 2).
//
// What this module does NOT claim:
//   - The start-state identity comes from the cell. That the value in the cell was measured by the Runner of THIS Run (and not written by
//     something else) depends on the wiring of the composition root (W6); this module checks the run id, the brand and the form only.
//   - `runtimeImageDigest` and `auditConfigKind` are Launcher declarations (`unverifiedByRuntime` of the launcher facts); the Manifest marks the
//     kind with `auditConfigKindDeclaredBy: "launcher"`. The runtime cannot verify either of them.
//   - `mutualExclusion` is the `mechanical` form only, from the lease facts the Launcher declared. A sealed Manifest, also one made in a test
//     with synthetic facts, is no proof that the mutual exclusion held in a real environment.
import { isAccessDenialResult } from "../isolation/index.js";
import { buildAiSandboxSection } from "../manifest/aiSandboxSection.js";
import { buildConfigSection, buildExcludedFields } from "../manifest/configSection.js";
import { buildEnvSection } from "../manifest/envSection.js";
import { buildGroundTruthAccessDenial, buildIsolationChecks } from "../manifest/isolationSection.js";
import { buildLegacyStartStateSection } from "../manifest/legacyStartStateSection.js";
import { buildMutualExclusionSection } from "../manifest/mutualExclusionSection.js";
import { buildProviderSection } from "../manifest/providerSection.js";
import { buildResidualRisks } from "../manifest/residualRisksSection.js";
import { buildSourceBundleSection } from "../manifest/sourceBundleSection.js";
import { buildToolVersionsSection } from "../manifest/toolVersionsSection.js";
import { confirmLauncherFactsUnchanged, isLauncherFactsSnapshot, type LauncherFactsReadPort } from "../runtimeFacts/launcherFacts.js";
import { confirmLeaseFactsUnchanged, isLeaseFactsSnapshot, type LeaseJsonReadPort } from "../runtimeFacts/leaseFacts.js";
import { collectRuntimeVersionFacts, type RuntimeVersionReadPort } from "../runtimeFacts/versionFacts.js";
import type { Result } from "../schema/types.js";
import type { JsonObject, ManifestCore, ManifestPort } from "./types.js";

// ---------------------------------------------------------------------------------------------
// Local helpers: own DATA properties only (an accessor is never run), nothing is changed.
// ---------------------------------------------------------------------------------------------
function isPlainObject(v: unknown): v is object {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key !== "string") return false;
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (d === undefined || !("value" in d) || d.enumerable !== true) return false;
  }
  return true;
}
function field(o: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d === undefined || !("value" in d) ? undefined : d.value;
}
function hasKeys(o: object, keys: readonly string[], optional: readonly string[] = []): boolean {
  const own = Object.keys(o);
  return keys.every((k) => own.includes(k)) && own.every((k) => keys.includes(k) || optional.includes(k));
}
const isFn = (o: unknown, name: string): boolean => typeof o === "object" && o !== null && typeof field(o, name) === "function";
const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** The run id format of the Launcher (a private copy; a test pins the parity with the isolation module). */
const RUN_ID = /^run-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/;
const IDENTITY = /^[0-9a-f]{64}$/;
const CLOSED_CODE = /^[a-z][a-z_]{0,63}$/;

// ---------------------------------------------------------------------------------------------
// The start-state cell
// ---------------------------------------------------------------------------------------------
/** What the cell holds: the result of the Runner's `measureStartState`, as data (structural; this package does not import the verifier). */
export type StartStateCellValue =
  | { readonly ok: true; readonly identity: string }
  | { readonly ok: false; readonly code: string; readonly leaseReason?: string };

export type StartStateCellErrorCode = "run_id_invalid" | "already_written" | "run_id_mismatch" | "result_invalid";
export interface StartStateCellError {
  readonly code: StartStateCellErrorCode;
}

/** One Run's cell. `set` takes the run id it writes for and the measurement result; the first call is the only one that counts. */
export interface StartStateCell {
  readonly runId: string;
  set(runId: string, result: unknown): Result<true, StartStateCellError>;
}

interface CellState {
  readonly runId: string;
  written: boolean;
  value: StartStateCellValue | "invalid" | undefined;
}
/** Every cell this module issued, and its state. A copy or a look-alike is not a cell; the state is not reachable from outside. */
const cellStates = new WeakMap<object, CellState>();

function readResult(v: unknown): StartStateCellValue | undefined {
  if (!isPlainObject(v)) return undefined;
  const ok = field(v, "ok");
  if (ok === true) {
    if (!hasKeys(v, ["ok", "identity"])) return undefined;
    const identity = field(v, "identity");
    return typeof identity === "string" && IDENTITY.test(identity) ? Object.freeze({ ok: true as const, identity }) : undefined;
  }
  if (ok === false) {
    if (!hasKeys(v, ["ok", "code"], ["leaseReason"])) return undefined;
    const code = field(v, "code");
    if (typeof code !== "string" || !CLOSED_CODE.test(code)) return undefined;
    const reason = field(v, "leaseReason");
    if (reason === undefined && !Object.keys(v).includes("leaseReason")) return Object.freeze({ ok: false as const, code });
    return typeof reason === "string" && CLOSED_CODE.test(reason) ? Object.freeze({ ok: false as const, code, leaseReason: reason }) : undefined;
  }
  return undefined;
}

/** A fresh cell for the Run `runId`. One cell per Run; a cell is never shared between Runs. */
export function createStartStateCell(runId: unknown): Result<StartStateCell, StartStateCellError> {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return { ok: false, error: { code: "run_id_invalid" } };
  const state: CellState = { runId, written: false, value: undefined };
  const cell: StartStateCell = Object.freeze({
    runId,
    set(forRunId: string, result: unknown): Result<true, StartStateCellError> {
      // the first write is the only one, whatever it is: a refused write also closes the cell (fail closed)
      if (state.written) return { ok: false, error: { code: "already_written" } };
      state.written = true;
      if (forRunId !== state.runId) {
        state.value = "invalid";
        return { ok: false, error: { code: "run_id_mismatch" } };
      }
      const value = readResult(result);
      if (value === undefined) {
        state.value = "invalid";
        return { ok: false, error: { code: "result_invalid" } };
      }
      state.value = value;
      return { ok: true, value: true };
    },
  });
  cellStates.set(cell, state);
  return { ok: true, value: cell };
}

/** True only for a cell that this module issued. */
export function isStartStateCell(x: unknown): x is StartStateCell {
  return typeof x === "object" && x !== null && cellStates.has(x);
}

// ---------------------------------------------------------------------------------------------
// The port
// ---------------------------------------------------------------------------------------------
export type ManifestPortErrorCode =
  | "context_not_plain_object"
  | "context_keys"
  | "run_id_invalid"
  | "start_state_cell_invalid"
  | "lease_context_invalid"
  | "launcher_context_invalid"
  | "versions_context_invalid"
  | "configured_provider_invalid"
  | "sandbox_invalid";
export interface ManifestPortError {
  readonly code: ManifestPortErrorCode;
}

/** The closure of one Run's port. Built by the composition root after stage B (W6). */
export interface ManifestPortContext {
  readonly runId: string;
  readonly startStateCell: StartStateCell;
  /** The lease facts: the read port, the expectation of `leaseFacts.ts` (run id, nonce, H, S), and the start-up snapshot. */
  readonly lease: { readonly port: LeaseJsonReadPort; readonly expectation: unknown; readonly start: unknown };
  /** The launcher facts: the read port, the expectation (run id, the audit configuration hash the runtime measured), the start-up snapshot. */
  readonly launcher: { readonly port: LauncherFactsReadPort; readonly expectation: unknown; readonly start: unknown };
  /** The runtime version facts: the read port and the facts collected at start-up. */
  readonly versions: { readonly port: RuntimeVersionReadPort; readonly start: unknown };
  /** The sandbox facts of stage B (`{ applicable: false }` or `{ applicable: true, destinations }`). */
  readonly sandbox: unknown;
  readonly configuredProvider: "mock" | "kiro-cli";
}

const refuse = (code: ManifestPortErrorCode): Result<never, ManifestPortError> => ({ ok: false, error: { code } });
/** The one way `build` fails: an `Error` whose message is a closed code. */
const stop = (code: string): never => {
  throw new Error(`manifest_port:${code}`);
};

interface VersionFactsView {
  readonly node: string;
  readonly npm: string;
  readonly dependencies: { readonly [name: string]: string };
}
function versionFacts(v: unknown): VersionFactsView | undefined {
  if (!isPlainObject(v) || !hasKeys(v, ["node", "npm", "dependencies"])) return undefined;
  const node = field(v, "node");
  const npm = field(v, "npm");
  const deps = field(v, "dependencies");
  if (!isText(node) || !isText(npm) || !isPlainObject(deps)) return undefined;
  const out: { [name: string]: string } = {};
  for (const name of Object.keys(deps)) {
    const version = field(deps, name);
    if (!isText(version)) return undefined;
    out[name] = version;
  }
  return { node, npm, dependencies: out };
}
const sameVersions = (a: VersionFactsView, b: VersionFactsView): boolean => {
  const ka = Object.keys(a.dependencies);
  const kb = Object.keys(b.dependencies);
  return a.node === b.node && a.npm === b.npm && ka.length === kb.length && ka.every((k, i) => k === kb[i] && a.dependencies[k] === b.dependencies[k]);
};

const CORE_KEYS: readonly string[] = [
  "runId", "wallClock", "terminationReason", "finalHypothesisRevision", "limitsUsed", "provider", "envVarsRead", "payloadAudit", "accessDenial",
  "configHashes", "leaseFacts", "effectiveConfig",
];

/** The port of ONE Run. The context is checked here; everything that can change before the seal is checked again by `build`. */
export function createManifestPort(ctx: unknown): Result<ManifestPort, ManifestPortError> {
  if (!isPlainObject(ctx)) return refuse("context_not_plain_object");
  if (!hasKeys(ctx, ["runId", "startStateCell", "lease", "launcher", "versions", "sandbox", "configuredProvider"])) return refuse("context_keys");
  const runId = field(ctx, "runId");
  if (typeof runId !== "string" || !RUN_ID.test(runId)) return refuse("run_id_invalid");

  const cell = field(ctx, "startStateCell");
  const cellState = isStartStateCell(cell) ? cellStates.get(cell) : undefined;
  if (cellState === undefined || cellState.runId !== runId) return refuse("start_state_cell_invalid");

  const lease = field(ctx, "lease");
  if (!isPlainObject(lease) || !hasKeys(lease, ["port", "expectation", "start"])) return refuse("lease_context_invalid");
  const leasePort = field(lease, "port") as LeaseJsonReadPort;
  const leaseExpectation = field(lease, "expectation");
  const leaseStart = field(lease, "start");
  if (!isFn(leasePort, "readLeaseJson") || !isLeaseFactsSnapshot(leaseStart) || leaseStart.facts.runId !== runId) return refuse("lease_context_invalid");
  if (!isPlainObject(leaseExpectation) || field(leaseExpectation, "runId") !== runId) return refuse("lease_context_invalid");

  const launcher = field(ctx, "launcher");
  if (!isPlainObject(launcher) || !hasKeys(launcher, ["port", "expectation", "start"])) return refuse("launcher_context_invalid");
  const launcherPort = field(launcher, "port") as LauncherFactsReadPort;
  const launcherExpectation = field(launcher, "expectation");
  const launcherStart = field(launcher, "start");
  if (!isFn(launcherPort, "readLauncherFacts") || !isLauncherFactsSnapshot(launcherStart) || launcherStart.declared.runId !== runId) return refuse("launcher_context_invalid");
  if (!isPlainObject(launcherExpectation) || field(launcherExpectation, "runId") !== runId) return refuse("launcher_context_invalid");

  const versions = field(ctx, "versions");
  if (!isPlainObject(versions) || !hasKeys(versions, ["port", "start"])) return refuse("versions_context_invalid");
  const versionPort = field(versions, "port") as RuntimeVersionReadPort;
  const versionStart = versionFacts(field(versions, "start"));
  const portOk = ["readNodeVersion", "readNpmPackageJson", "readDeclaredPackageJson", "readInstalledPackageJson"].every((m) => isFn(versionPort, m));
  if (!portOk || versionStart === undefined) return refuse("versions_context_invalid");

  const configuredProvider = field(ctx, "configuredProvider");
  if (configuredProvider !== "mock" && configuredProvider !== "kiro-cli") return refuse("configured_provider_invalid");
  const sandbox = field(ctx, "sandbox");
  if (!buildAiSandboxSection({ provider: configuredProvider, sandbox }).ok) return refuse("sandbox_invalid");

  let used = false;
  const build = (core: ManifestCore): JsonObject => {
    // one build per Run; a second call (also after a failure) is refused, nothing is retried
    if (used) return stop("build_already_called");
    used = true;

    // 1. the core: its keys (the 13 of ManifestCore) and the brand of the access-denial result
    if (!isPlainObject(core) || !hasKeys(core, CORE_KEYS, ["sourceBundleManifest"])) return stop("core_invalid");
    const accessDenial = field(core, "accessDenial");
    if (!isAccessDenialResult(accessDenial)) return stop("access_denial_not_issued");

    // 2. the Source_Bundle: no bundle, no Manifest
    const bundle = field(core, "sourceBundleManifest");
    if (bundle === undefined) return stop("source_bundle_missing");
    if (!isPlainObject(bundle) || !hasKeys(bundle, ["files"])) return stop("source_bundle_invalid");
    const sourceBundle = buildSourceBundleSection(field(bundle, "files"));
    if (!sourceBundle.ok) return stop("source_bundle_invalid");

    // 3. one run id: the core, the access-denial result, the lease, the launcher facts and the start-state cell
    if (field(core, "runId") !== runId || accessDenial.runId !== runId) return stop("run_id_mismatch");
    if (leaseStart.facts.runId !== runId || launcherStart.declared.runId !== runId || cellState.runId !== runId) return stop("run_id_mismatch");

    // 4. what can change before the seal is read again: the lease facts, the launcher facts, the runtime versions
    const leaseNow = confirmLeaseFactsUnchanged(leasePort, leaseExpectation, leaseStart);
    if (!leaseNow.ok) return stop(`lease_facts_unconfirmed:${leaseNow.error.code}`);
    const launcherNow = confirmLauncherFactsUnchanged(launcherPort, launcherExpectation, launcherStart);
    if (!launcherNow.ok) return stop(`launcher_facts_unconfirmed:${launcherNow.error.code}`);
    const versionsNow = collectRuntimeVersionFacts(versionPort);
    if (!versionsNow.ok) return stop(`runtime_versions_unavailable:${versionsNow.error.code}`);
    const versionsView = versionFacts(versionsNow.value);
    if (versionsView === undefined || !sameVersions(versionStart, versionsView)) return stop("runtime_versions_changed");

    // 5. agreement: the audit configuration hash, the lease timing, the provider
    const payloadAudit = field(core, "payloadAudit");
    if (!isPlainObject(payloadAudit) || !hasKeys(payloadAudit, ["configCheck", "audits", "passed", "blocked", "auditConfigSha256"])) return stop("payload_audit_invalid");
    const configCheck = field(payloadAudit, "configCheck");
    const audits = field(payloadAudit, "audits");
    const passed = field(payloadAudit, "passed");
    const blocked = field(payloadAudit, "blocked");
    const auditSha = field(payloadAudit, "auditConfigSha256");
    if ((configCheck !== "pass" && configCheck !== "blocked") || !isCount(audits) || !isCount(passed) || !isCount(blocked)) return stop("payload_audit_invalid");
    if (auditSha !== launcherStart.confirmedByRuntime.auditConfigSha256) return stop("audit_config_sha256_mismatch");

    const leaseFacts = field(core, "leaseFacts");
    if (!isPlainObject(leaseFacts) || !hasKeys(leaseFacts, ["heartbeatIntervalMs", "staleAfterMs", "propagationDelayMs"])) return stop("lease_facts_invalid");
    const facts = leaseStart.facts;
    if (field(leaseFacts, "heartbeatIntervalMs") !== facts.heartbeatIntervalMs || field(leaseFacts, "staleAfterMs") !== facts.staleAfterMs) return stop("lease_timing_mismatch");

    const effectiveConfig = field(core, "effectiveConfig");
    if (!isPlainObject(effectiveConfig) || field(effectiveConfig, "provider") !== configuredProvider) return stop("configured_provider_mismatch");
    const coreProvider = field(core, "provider");
    if (!isPlainObject(coreProvider) || !hasKeys(coreProvider, ["id", "version", "model", "isMock"])) return stop("provider_invalid");
    const provider = buildProviderSection({
      configuredProvider,
      identity: { id: field(coreProvider, "id"), version: field(coreProvider, "version"), model: field(coreProvider, "model") },
    });
    if (!provider.ok) return stop(`provider_invalid:${provider.error.code}`);
    if (provider.value.isMock !== field(coreProvider, "isMock")) return stop("provider_mock_flag_mismatch");

    // 6. the start-state identity of this Run: measured, successful and well formed
    const measured = cellState.value;
    if (!cellState.written || measured === undefined) return stop("start_state_unmeasured");
    if (measured === "invalid") return stop("start_state_invalid");
    if (!measured.ok) return stop("start_state_failed");
    const legacyStartState = buildLegacyStartStateSection({ identity: measured.identity });
    if (!legacyStartState.ok || !IDENTITY.test(measured.identity)) return stop("start_state_invalid");

    // 7. the sections, by the existing builders
    const configHashes = field(core, "configHashes");
    if (!isPlainObject(configHashes)) return stop("config_hashes_invalid");
    const config = buildConfigSection({
      effectiveConfig,
      policyConfigSha256: field(configHashes, "policyConfigSha256"),
      preparationTableSha256: field(configHashes, "preparationTableSha256"),
      leasePropagationDelayMs: field(leaseFacts, "propagationDelayMs"),
    });
    if (!config.ok) return stop(`config_invalid:${config.error.code}`);
    const toolVersions = buildToolVersionsSection({
      node: versionsView.node,
      npm: versionsView.npm,
      dependencies: { ...versionsView.dependencies },
      runtimeImageDigest: launcherStart.declared.runtimeImageId,
    });
    if (!toolVersions.ok) return stop(`tool_versions_invalid:${toolVersions.error.code}`);
    const envVarsRead = buildEnvSection(field(core, "envVarsRead"), []);
    if (!envVarsRead.ok) return stop(`env_vars_read_invalid:${envVarsRead.error.code}`);
    const groundTruth = buildGroundTruthAccessDenial(accessDenial);
    const isolationChecks = buildIsolationChecks(accessDenial);
    if (!groundTruth.ok || !isolationChecks.ok) return stop("access_denial_invalid");
    const mutualExclusion = buildMutualExclusionSection({
      mode: "mechanical",
      lease: { nonceSha256: facts.nonceSha256, launcherPid: facts.launcherPid, heartbeatIntervalMs: facts.heartbeatIntervalMs, staleAfterMs: facts.staleAfterMs },
    });
    if (!mutualExclusion.ok) return stop(`mutual_exclusion_invalid:${mutualExclusion.error.code}`);
    const aiSandbox = buildAiSandboxSection({ provider: configuredProvider, sandbox });
    if (!aiSandbox.ok) return stop("sandbox_invalid");

    const wallClock = field(core, "wallClock");
    const limitsUsed = field(core, "limitsUsed");
    if (!isPlainObject(wallClock) || !isText(field(wallClock, "startedAt")) || !isText(field(wallClock, "finishedAt"))) return stop("wall_clock_invalid");
    if (!isPlainObject(limitsUsed) || !isCount(field(limitsUsed, "iterations")) || !isCount(field(limitsUsed, "acceptedExperiments")) || !isCount(field(limitsUsed, "rejectedExperiments"))) {
      return stop("limits_used_invalid");
    }
    const terminationReason = field(core, "terminationReason");
    const finalHypothesisRevision = field(core, "finalHypothesisRevision");
    if (!isText(terminationReason) || !isText(finalHypothesisRevision)) return stop("termination_invalid");

    const manifest = {
      runId,
      wallClock: { startedAt: field(wallClock, "startedAt"), finishedAt: field(wallClock, "finishedAt") },
      excludedFields: buildExcludedFields(),
      terminationReason,
      finalHypothesisRevision,
      config: config.value,
      limitsUsed: {
        iterations: field(limitsUsed, "iterations"),
        acceptedExperiments: field(limitsUsed, "acceptedExperiments"),
        rejectedExperiments: field(limitsUsed, "rejectedExperiments"),
      },
      provider: provider.value,
      toolVersions: toolVersions.value,
      sourceBundle: sourceBundle.value,
      legacyStartState: legacyStartState.value,
      envVarsRead: envVarsRead.value,
      payload_audit: {
        configCheck,
        audits,
        passed,
        blocked,
        auditConfigSha256: auditSha,
        // a Launcher declaration (the runtime cannot verify it), marked as such in the Manifest
        auditConfigKind: launcherStart.declared.auditConfigKind,
        auditConfigKindDeclaredBy: "launcher",
      },
      ground_truth_access_denial: groundTruth.value,
      isolationChecks: isolationChecks.value,
      mutualExclusion: mutualExclusion.value,
      aiSandbox: aiSandbox.value,
      residualRisks: buildResidualRisks(),
    };
    return manifest as unknown as JsonObject;
  };
  return { ok: true, value: Object.freeze({ build }) };
}
