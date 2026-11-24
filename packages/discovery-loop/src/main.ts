// Entry point of the `discovery-runtime` container (task 4.9-B): `node /app/packages/discovery-loop/dist/main.js`, started only by the
// Launcher. This module is the composition root of ONE Run. It re-implements no check and no business rule: it reads its fixed inputs, runs
// stage A and stage B, builds the production ports, hands them to `composeRun`, runs the Loop_Orchestrator once, and maps the result to a
// closed exit code and ONE line of closed codes on standard error. It is not exported from the package entry.
//
// ORDER (fixed; a failure skips everything after it):
//    1. the timer port (so that the `finally` below can always clear it);
//    2. the environment, read once: PHOENIX_RUN_ID, PHOENIX_LEASE_NONCE, PHOENIX_LEASE_D_MS;
//    3. the fixed inputs: run-config.json (then stage A), audit-config.json, the baked policy and preparation table;
//    4. stage B (`checkStartupRefusals`) with the production ports; its last step is the single start-up proof of the Run_Lease;
//    5. the production ports: isolation, the facts readers, the Source_Bundler file system, the allowlist, the instruction templates, the
//       audit adapter (one per Run), the Mock_Provider, the response limits, the Runner factory, the store factory;
//    6. `composeRun` (it reads the lease facts, the launcher facts version 2 and the runtime version facts, once each);
//    7. `createLoopOrchestrator(...).run(startup)`: the start gate (access-denial verification, `mayStartRun`, the lease re-check), then
//       the start records, then the FIRST request to the Legacy_App (the health check), the start-state measurement, the phases, the seal.
// Nothing before step 7 contacts the Legacy_App or calls a provider: creating the Runner factory, the HTTP port or the provider sends nothing.
//
// EXIT CODES: 0 the Run_Manifest is sealed (this says nothing about the purpose of the Run: the termination reason is in the line and in the
// manifest); 1 not sealed (a refusal of the start gate, a failure after the start, an unexpected exception); 2 refused before the Run:
// stage A, stage B, a fixed input that cannot be read, a failed assembly, or a refusal of `composeRun`.
//
// SECRETS: the raw lease nonce goes to the lease port (stage B), to `composeRun` (which compares its hash), and to two detectors only: the
// secret scan of the Run store and the secret values of the payload audit. It is never written, printed or returned.
//
// The options of `runMain` exist for tests only (fixed paths, the environment, the clocks, the HTTP port, the isolation measurement, the timer
// backend, the output line). The command-line start calls `runMain()` with no argument, so a production start uses the fixed values.
import { accessSync, constants, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createProvider, gateProviderResult, gateResponse, resolveResponseLimits, sha256Hex } from "@phoenix/ai-client";
import type { AuditConfigLoadResult, AuditedRequest } from "@phoenix/ai-client";
import { buildSourceBundle, parseAllowlistJson, validateDeclarations, validateExpr, verifyCitations } from "@phoenix/analyzer";
import { compare, createAcceptanceCheck, createSystemClock, createSystemSleeper, evaluateForRecord } from "@phoenix/verifier";
import type { HttpPort, MonotonicClock, PolicyConfig, PrepTable, RunLease, Sleeper } from "@phoenix/verifier";
import { STARTUP_CHECK_ORDER, STARTUP_REFUSAL_CODES, checkStartupRefusals, validateRunConfig } from "./config/index.js";
import type { ConfigIssueCode } from "./config/index.js";
import { createNodeIsolationDeps } from "./isolation/nodeDeps.js";
import { createLoopOrchestrator, type LoopExtras } from "./orchestrator/loopOrchestrator.js";
import { composeRun, type ComposeRunErrorCode, type ComposeRunInput } from "./orchestrator/runComposition.js";
import { createAnalysisFs } from "./runtime/analysisFs.js";
import { createAuditAdapter } from "./runtime/auditAdapter.js";
import { createTimerPort, createWallClock, type ManagedTimerPort, type TimerBackend } from "./runtime/clocks.js";
import { createRunnerFactory } from "./runtime/runnerFactory.js";
import { semanticSha256Of } from "./runtime/semanticHash.js";
import {
  ALLOWLIST_JSON_FILE, AUDIT_CONFIG_FILE, POLICY_CONFIG_FILE, PREPARATION_TABLE_FILE, RUN_CONFIG_FILE, createFixedInputReader, decodeUtf8Strict,
} from "./runtime/startupInputs.js";
import { createStartupPorts, type BakedPolicyInput, type RunVolumeState } from "./runtime/startupPorts.js";
import { createLauncherFactsReadAdapter, createLeaseJsonReadAdapter, createRuntimeVersionReadAdapter } from "./runtimeFacts/fsReadAdapters.js";
import { DEFAULT_PARSE_LIMITS, createSchemaValidator, strictParse } from "./schema/index.js";
import { RunRecordStore, createNodeFileSystem } from "./store/index.js";

// ---------------------------------------------------------------------------------------------
// Fixed values
// ---------------------------------------------------------------------------------------------
export interface RuntimePaths {
  /** `/run/config`: run-config.json and audit-config.json (read-only mounts). */
  readonly configDir: string;
  /** `/run/lease`: lease.json, heartbeat, revoked, launcher-facts.json, isolation-attestation.json (read-only). */
  readonly leaseDir: string;
  /** `/run/out`: the Run_Volume, the only writable location of Run records. */
  readonly runVolumeDir: string;
  /** `/repo`: the allowlisted source files and the two allowlist documents (read-only, per file). */
  readonly repoRoot: string;
  /** The baked policy-config.json and preparation-table.json. */
  readonly verifierDataDir: string;
  /** The fixed instruction templates `<templateId>.txt`. */
  readonly templatesDir: string;
  /** The directory of the `package.json` of the installed npm. */
  readonly npmPackageDir: string;
  /** The directory of the `package.json` whose `dependencies` are the declaration. */
  readonly declaredPackageDir: string;
  readonly modulesDir: string;
  /** The compiled first-party trees that the import analysis scans. */
  readonly bundleRoots: readonly { readonly label: string; readonly dir: string }[];
}

/**
 * The paths of the runtime image. `/run/*` and `/repo` are the mount table of the design. The `/app` paths follow
 * `infra/discovery/runtime.Dockerfile` (WORKDIR /app, COPY of packages/ and node_modules); `npmPackageDir` is the npm of the pinned Node.js base
 * image. The `/app` and npm paths are PROVISIONAL until they are measured in the built image (task 4.9): there is no search and no fallback.
 */
export const PRODUCTION_PATHS: RuntimePaths = Object.freeze({
  configDir: "/run/config",
  leaseDir: "/run/lease",
  runVolumeDir: "/run/out",
  repoRoot: "/repo",
  verifierDataDir: "/app/packages/verifier/data",
  templatesDir: "/app/packages/discovery-loop/data/templates",
  npmPackageDir: "/usr/local/lib/node_modules/npm",
  declaredPackageDir: "/app/packages/discovery-loop",
  modulesDir: "/app/node_modules",
  bundleRoots: Object.freeze(
    ["analyzer", "ai-client", "verifier", "discovery-loop"].map((p) => Object.freeze({ label: `packages/${p}/dist`, dir: `/app/packages/${p}/dist` })),
  ),
});

/** The fixed instruction templates, one per request kind. The file of each is `<templatesDir>/<templateId>.txt`. */
export const TEMPLATE_IDS = Object.freeze({
  hypothesisGeneration: "hypothesis-generation-v1",
  experimentGeneration: "experiment-generation-v1",
  hypothesisRevision: "hypothesis-revision-v1",
} as const);
const TEMPLATE_FILES: readonly string[] = Object.freeze(Object.values(TEMPLATE_IDS).map((id) => `${id}.txt`));

const NONCE_NAME = "PHOENIX_LEASE_NONCE";
const D_PATTERN = /^[0-9]{1,6}$/;

// ---------------------------------------------------------------------------------------------
// Closed vocabulary of the output line
// ---------------------------------------------------------------------------------------------
type Phase = "input" | "stage_a" | "stage_b" | "assembly" | "compose" | "run" | "internal";
type Line = { [k: string]: string | number | boolean | Line | readonly (string | Line)[] };

const INPUT_CODES = Object.freeze(["run_config_missing", "run_config_unreadable", "run_config_invalid"] as const);
const ASSEMBLY_CODES = Object.freeze([
  "isolation_unavailable", "facts_reader_invalid", "repo_root_invalid", "allowlist_unreadable", "allowlist_invalid", "template_unreadable",
  "audit_adapter_invalid", "provider_not_mock", "provider_unavailable", "response_limits_invalid",
] as const);
type AssemblyCode = (typeof ASSEMBLY_CODES)[number];
const CONFIG_ISSUE_CODES = Object.freeze([
  "required_missing", "unknown_key", "null_value", "wrong_type", "not_integer", "out_of_range", "enum_mismatch", "cross_field",
  "above_fixed_bound", "pattern_mismatch",
] as const satisfies readonly ConfigIssueCode[]);
const COMPOSE_CODES = Object.freeze([
  "input_invalid", "startup_invalid", "nonce_invalid", "deps_invalid", "lease_facts_refused", "launcher_facts_refused",
  "runtime_versions_refused", "start_state_cell_refused", "manifest_port_refused",
] as const satisfies readonly ComposeRunErrorCode[]);
/** Local copies of the orchestrator lists (a parity test keeps them equal; this module imports only two orchestrator modules). */
export const TERMINATION_REASON_NAMES = Object.freeze([
  "iteration_limit_reached", "experiment_limit_reached", "time_limit_reached", "no_further_experiments", "provider_failure", "payload_audit_blocked",
  "policy_rejection_limit", "isolation_violation", "lease_unavailable", "launcher_killed", "error",
] as const satisfies readonly SealedTermination[]);
export const UNSEALED_FAILURE_NAMES = Object.freeze([
  "runner_start_refused", "store_open_failed", "lease_invalid_at_start", "store_failed", "secret_rejected", "manifest_build_failed", "seal_failed",
  "internal_error",
] as const satisfies readonly UnsealedFailure[]);
const TIMER_NOTES = Object.freeze(["timers_left", "timers_not_cleared"] as const);

// Compile-time equality of the local lists with the types of the modules that produce the codes: every member of the type is listed
// (`AssertNever` fails otherwise), and every listed value is a member of the type (`satisfies` above and below fails otherwise).
type AssertNever<T extends never> = T;
type RunResultOf = Awaited<ReturnType<ReturnType<typeof createLoopOrchestrator>["run"]>>;
type SealedTermination = Extract<RunResultOf, { sealed: true }>["summary"]["terminationReason"];
type UnsealedFailure = Extract<RunResultOf, { sealed: false }>["failure"];
export type LocalListsComplete = [
  AssertNever<Exclude<ConfigIssueCode, (typeof CONFIG_ISSUE_CODES)[number]>>,
  AssertNever<Exclude<ComposeRunErrorCode, (typeof COMPOSE_CODES)[number]>>,
  AssertNever<Exclude<SealedTermination, (typeof TERMINATION_REASON_NAMES)[number]>>,
  AssertNever<Exclude<UnsealedFailure, (typeof UNSEALED_FAILURE_NAMES)[number]>>,
];

const closed = (value: unknown, list: readonly string[]): string => (typeof value === "string" && list.includes(value) ? value : "unlisted");

interface Outcome {
  readonly exitCode: 0 | 1 | 2;
  readonly line: Line;
}
const outcome = (exitCode: 0 | 1 | 2, phase: Phase, fields: Line = {}): Outcome => ({ exitCode, line: { phase, ...fields } });
const assemblyFailed = (code: AssemblyCode): Outcome => outcome(2, "assembly", { code: closed(code, ASSEMBLY_CODES) });

// ---------------------------------------------------------------------------------------------
// Options (tests only)
// ---------------------------------------------------------------------------------------------
type IsolationDeps = Extract<ReturnType<typeof createNodeIsolationDeps>, { ok: true }>["value"];
type ProductionDeps = ComposeRunInput<RunLease, AuditConfigLoadResult, PolicyConfig, PrepTable, AuditedRequest>["deps"];
type AuditHandle = Parameters<ProductionDeps["audit"]["auditPayload"]>[3];

export interface MainOptions {
  readonly paths?: RuntimePaths;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly clock?: MonotonicClock;
  readonly sleeper?: Sleeper;
  readonly createHttp?: (origin: string) => HttpPort;
  /** The access-denial measurement ports for the proven run id. Default: the real `node:fs` adapter. */
  readonly isolation?: (runId: string) => IsolationDeps;
  readonly timerBackend?: TimerBackend;
  readonly writeLine?: (line: string) => void;
}

const writeStderr = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

// ---------------------------------------------------------------------------------------------
// The Run
// ---------------------------------------------------------------------------------------------
/** Runs one Run and answers its exit code. Never throws. Writes exactly one line. */
export async function runMain(options: MainOptions = {}): Promise<number> {
  let result: Outcome = outcome(1, "internal", { code: "internal_error" });
  let timers: ManagedTimerPort | undefined;
  const notes: string[] = [];
  let write: (line: string) => void = writeStderr;
  try {
    write = options.writeLine ?? writeStderr;
    timers = createTimerPort(options.timerBackend);
    result = await runChecked(options, timers);
  } catch {
    result = outcome(1, "internal", { code: "internal_error" });
  } finally {
    if (timers !== undefined) {
      try {
        if (timers.activeCount() > 0) notes.push("timers_left");
        timers.cancelAll();
        if (timers.activeCount() !== 0) notes.push("timers_not_cleared");
      } catch {
        notes.push("timers_not_cleared");
      }
    }
  }
  const line: Line = notes.length === 0 ? result.line : { ...result.line, timers: notes.map((n) => closed(n, TIMER_NOTES)) };
  try {
    write(JSON.stringify(line));
  } catch {
    // nothing more can be reported; the exit code still says what happened
  }
  return result.exitCode;
}

async function runChecked(options: MainOptions, timers: ManagedTimerPort): Promise<Outcome> {
  const paths = options.paths ?? PRODUCTION_PATHS;
  const environment = options.env ?? process.env;
  const clock = options.clock ?? createSystemClock();
  const sleeper = options.sleeper ?? createSystemSleeper();

  // 2. The environment, read once each.
  const runId = environment["PHOENIX_RUN_ID"] ?? "";
  const leaseNonce = environment[NONCE_NAME] ?? "";
  const dText = environment["PHOENIX_LEASE_D_MS"] ?? "";
  const propagationDelayMs = D_PATTERN.test(dText) ? Number(dText) : undefined;

  // 3. The run configuration, then stage A.
  const configReader = createFixedInputReader(paths.configDir, [RUN_CONFIG_FILE, AUDIT_CONFIG_FILE]);
  const runConfigRead = await configReader.read(RUN_CONFIG_FILE);
  if (runConfigRead.kind === "missing") return outcome(2, "input", { code: closed("run_config_missing", INPUT_CODES) });
  if (runConfigRead.kind !== "ok") return outcome(2, "input", { code: closed("run_config_unreadable", INPUT_CODES) });
  const parsed = strictParse(runConfigRead.bytes, DEFAULT_PARSE_LIMITS);
  if (!parsed.ok) return outcome(2, "input", { code: closed("run_config_invalid", INPUT_CODES) });
  const stageA = validateRunConfig(parsed.value);
  if (!stageA.ok) return outcome(2, "stage_a", { codes: [...new Set(stageA.error.map((i) => closed(i.code, CONFIG_ISSUE_CODES)))] });
  const cfg = stageA.value;

  // The other fixed inputs of stage B.
  const auditConfigRead = await configReader.read(AUDIT_CONFIG_FILE);
  const dataReader = createFixedInputReader(paths.verifierDataDir, [POLICY_CONFIG_FILE, PREPARATION_TABLE_FILE]);
  const policyInput = await readBakedPolicy(dataReader);

  // 4. Stage B.
  const ports = createStartupPorts({
    policy: policyInput,
    auditConfig: auditConfigRead,
    env: environment,
    lease: { directory: paths.leaseDir, runId, nonce: leaseNonce, propagationDelayMs, clock, sleeper },
    io: { runVolume: () => runVolumeState(paths.runVolumeDir), configFiles: () => listNames(paths.configDir) },
  });
  const stageB = await checkStartupRefusals(cfg, ports);
  if (!stageB.ok) {
    const refusals = stageB.error.map((r): Line => ({ check: closed(r.check, STARTUP_CHECK_ORDER), code: closed(r.code, STARTUP_REFUSAL_CODES) }));
    return outcome(2, "stage_b", { refusals });
  }
  const startup = stageB.value;
  const provenRunId = startup.lease.runId;

  // 5. The production ports. Nothing here contacts the Legacy_App or a provider.
  let isolation: IsolationDeps;
  if (options.isolation !== undefined) {
    isolation = options.isolation(provenRunId);
  } else {
    const made = createNodeIsolationDeps({ runId: provenRunId, bundleRoots: paths.bundleRoots, attestationPath: `${paths.leaseDir}/isolation-attestation.json` });
    if (!made.ok) return assemblyFailed("isolation_unavailable");
    isolation = made.value;
  }

  const leaseFacts = createLeaseJsonReadAdapter({ leaseDir: paths.leaseDir });
  const launcherFacts = createLauncherFactsReadAdapter({ leaseDir: paths.leaseDir });
  const versionFacts = createRuntimeVersionReadAdapter({
    versions: process.versions,
    npmPackageDir: paths.npmPackageDir,
    declaredPackageDir: paths.declaredPackageDir,
    modulesDir: paths.modulesDir,
  });
  if (!leaseFacts.ok || !launcherFacts.ok || !versionFacts.ok) return assemblyFailed("facts_reader_invalid");

  const analysisFs = createAnalysisFs({ root: paths.repoRoot });
  if (!analysisFs.ok) return assemblyFailed("repo_root_invalid");

  const allowlistRead = await createFixedInputReader(paths.repoRoot, [ALLOWLIST_JSON_FILE]).read(ALLOWLIST_JSON_FILE);
  if (allowlistRead.kind !== "ok") return assemblyFailed("allowlist_unreadable");
  const allowlistText = decodeUtf8Strict(allowlistRead.bytes);
  const allowlist = allowlistText === undefined ? undefined : parseAllowlistJson(allowlistText);
  if (allowlist === undefined || !allowlist.ok) return assemblyFailed("allowlist_invalid");

  const templateReader = createFixedInputReader(paths.templatesDir, TEMPLATE_FILES);
  const instructionTemplates = new Map<string, string>();
  for (const id of Object.values(TEMPLATE_IDS)) {
    const read = await templateReader.read(`${id}.txt`);
    // the hash is taken of the exact bytes of the file; the text is only checked to be UTF-8, never normalized
    if (read.kind !== "ok" || read.bytes.byteLength === 0 || decodeUtf8Strict(read.bytes) === undefined) return assemblyFailed("template_unreadable");
    instructionTemplates.set(id, sha256Hex(read.bytes));
  }

  // One audit adapter per Run: its audit contexts belong to this Run only.
  const audit = createAuditAdapter<AuditHandle>({ allowlist: allowlist.value, instructionTemplates, secretValues: [{ name: NONCE_NAME, value: leaseNonce }] });
  if (!audit.ok) return assemblyFailed("audit_adapter_invalid");
  const auditAdapter = audit.value;

  if (cfg.provider !== "mock") return assemblyFailed("provider_not_mock");
  let provider: ReturnType<typeof createProvider>;
  try {
    provider = createProvider(cfg.mockFixtureSet === undefined ? { provider: "mock" } : { provider: "mock", mockFixtureSet: cfg.mockFixtureSet });
  } catch {
    return assemblyFailed("provider_unavailable");
  }

  const limits = resolveResponseLimits({ maxResponseBytes: cfg.limits.responseBytes, maxExperiments: cfg.limits.experimentsPerResponse });
  if (!limits.ok) return assemblyFailed("response_limits_invalid");

  const runnerFactory = createRunnerFactory({
    clock,
    sleeper,
    heartbeatIntervalMs: startup.lease.heartbeatIntervalMs,
    ...(options.createHttp === undefined ? {} : { createHttp: options.createHttp }),
  });
  const storeFactory = {
    open: (fs: Parameters<typeof RunRecordStore.open>[0], dir: string) =>
      RunRecordStore.open(fs, dir, { secrets: { envValues: [{ name: NONCE_NAME, value: leaseNonce }] } }),
  };

  // The orchestrator's port types are structural copies of the sibling packages' types; the composition root joins the two here.
  const deps = {
    isolation,
    fs: createNodeFileSystem(),
    runVolumeDir: paths.runVolumeDir,
    clock,
    wallClock: createWallClock(),
    timers,
    provider,
    audit: {
      prepareAudit: (input: unknown) => auditAdapter.prepareAudit(input),
      auditPayload: (bytes: Uint8Array, kind: string, cfgLoad: AuditConfigLoadResult, ctx: AuditHandle) => auditAdapter.auditPayload(bytes, kind, cfgLoad, ctx),
    },
    responseGate: { gateProviderResult, gateResponse, resolveResponseLimits },
    policy: { evaluateForRecord, createAcceptanceCheck },
    runnerFactory,
    comparator: { compare },
    analysisFs: analysisFs.value,
    repoRoot: paths.repoRoot,
    analysis: { buildSourceBundle, verifyCitations, validateDeclarations, validateExpr },
    storeFactory,
  } as unknown as ProductionDeps;

  // 6.
  const composed = composeRun({
    startup,
    nonce: leaseNonce,
    facts: { lease: leaseFacts.value, launcher: launcherFacts.value, versions: versionFacts.value },
    deps,
  });
  // Only the closed code of composeRun is reported. The code of the sub-module that refused (`error.detail`) is not part of the line: its
  // vocabulary belongs to the facts modules and is not checked here against a closed list.
  if (!composed.ok) return outcome(2, "compose", { code: closed(composed.error.code, COMPOSE_CODES) });

  const extras: LoopExtras = {
    validator: createSchemaValidator(),
    semanticSha256Of,
    templateIds: TEMPLATE_IDS,
    responseLimits: { hypothesisGeneration: limits.value, experimentGeneration: limits.value, hypothesisRevision: limits.value },
  };

  // 7.
  const run = await createLoopOrchestrator(composed.value, extras).run(startup);
  if (run.sealed) {
    return outcome(0, "run", { sealed: true, terminationReason: closed(run.summary.terminationReason, TERMINATION_REASON_NAMES) });
  }
  return outcome(1, "run", {
    sealed: false,
    started: run.started === true,
    failure: closed(run.failure, UNSEALED_FAILURE_NAMES),
    ...(run.terminationReason === undefined ? {} : { terminationReason: closed(run.terminationReason, TERMINATION_REASON_NAMES) }),
  });
}

async function readBakedPolicy(reader: ReturnType<typeof createFixedInputReader>): Promise<BakedPolicyInput> {
  const policy = await reader.read(POLICY_CONFIG_FILE);
  const table = await reader.read(PREPARATION_TABLE_FILE);
  if (policy.kind !== "ok" || table.kind !== "ok") return { kind: "unavailable" };
  const p = strictParse(policy.bytes, DEFAULT_PARSE_LIMITS);
  const t = strictParse(table.bytes, DEFAULT_PARSE_LIMITS);
  if (!p.ok || !t.ok) return { kind: "unavailable" };
  return { kind: "ok", policyRaw: p.value, tableRaw: t.value };
}

/** The Run_Volume state for stage B: exists, writable, empty. Anything that cannot be determined is `undefined` (stage B refuses it). */
function runVolumeState(dir: string): RunVolumeState | undefined {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (e) {
    return (e as { code?: unknown } | null)?.code === "ENOENT" ? { exists: false, writable: false, empty: false } : undefined;
  }
  let writable = true;
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    writable = false;
  }
  return { exists: true, writable, empty: entries.length === 0 };
}

function listNames(dir: string): readonly string[] | undefined {
  try {
    return readdirSync(dir);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Command-line start
// ---------------------------------------------------------------------------------------------
/**
 * True when `argvPath` (process.argv[1]) names the module at `moduleUrl`. The comparison is of file URLs (so spaces and `%` are escaped the
 * same way), and, when they differ, of the resolved real paths (a symbolic link or a relative path); on Windows the real paths are compared
 * without regard to case. Anything that cannot be resolved is false.
 */
export function isEntryPoint(argvPath: string | undefined, moduleUrl: string): boolean {
  if (typeof argvPath !== "string" || argvPath === "" || typeof moduleUrl !== "string") return false;
  try {
    if (pathToFileURL(resolve(argvPath)).href === moduleUrl) return true;
    const a = realpathSync(argvPath);
    const b = realpathSync(fileURLToPath(moduleUrl));
    return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  runMain().then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 1;
    },
  );
}