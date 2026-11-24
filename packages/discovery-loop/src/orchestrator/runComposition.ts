// The per-Run composition of the Loop_Orchestrator's dependencies (task 4.6, work unit W6-A): `composeRun(input)` turns the dependencies of
// ONE Run into the 17-key `LoopDeps`, with the real Run_Manifest port (W5) and a Runner factory that routes the start-state measurement of
// THIS Run into THIS Run's start-state cell.
//
// When. Only after stage B: the input holds a startup ticket issued by `checkStartupRefusals` (checked by its brand here; consumed later by the
// start gate, never here). The facts are read only now, once each: the lease facts (`lease.json`), the launcher facts (`launcher-facts.json`,
// version 2) and the runtime version facts. Nothing here opens the store, contacts the Legacy_App, writes, or runs a check of the start gate.
//
// One Run. Every call makes a NEW start-state cell, NEW start-up snapshots and a NEW ManifestPort; nothing is shared between Runs or between
// calls. The wrapped Runner factory can be called ONCE: a second call throws, which `startRun` turns into `runner_start_refused`. The Runner it
// returns delegates `health` and `execute` to the Runner of the original factory, and runs `measureStartState` on that SAME Runner, at most once;
// the result (or, for a throw or an answer of the wrong shape, a fixed failure) is written into the cell, which takes one write only, so a
// failed measurement can never be retried and no other value can be put into the cell through this module.
//
// Failures are closed codes (with, for a refused fact, the closed code of the fact module); no value, path or text is returned. This module
// has no `node:` import and reads no environment: the read ports (the C1 adapters in the runtime, task 4.9) and the nonce are given.
import { isStartupApproval, type StartupApproval } from "../config/startup.js";
import { readLauncherFactsSnapshot, type LauncherFactsReadPort } from "../runtimeFacts/launcherFacts.js";
import { readLeaseFactsSnapshot, type LeaseJsonReadPort } from "../runtimeFacts/leaseFacts.js";
import { collectRuntimeVersionFacts, type RuntimeVersionReadPort } from "../runtimeFacts/versionFacts.js";
import type { Result } from "../schema/types.js";
import { createManifestPort, createStartStateCell } from "./manifestPort.js";
import type { ExperimentRunnerPort, LoopDeps, RunnerFactoryInput, StartStateView } from "./types.js";

export type ComposeRunErrorCode =
  | "input_invalid"
  | "startup_invalid"
  | "nonce_invalid"
  | "deps_invalid"
  | "lease_facts_refused"
  | "launcher_facts_refused"
  | "runtime_versions_refused"
  | "start_state_cell_refused"
  | "manifest_port_refused";
export interface ComposeRunError {
  readonly code: ComposeRunErrorCode;
  /** For a refused fact or port: the closed code of the module that refused it. */
  readonly detail?: string;
}

/** The dependencies of one Run. `deps` is every key of `LoopDeps` except `manifest`, which this module builds. */
export interface ComposeRunInput<TLease, TAudit, TPolicy, TTable, TRequest> {
  readonly startup: StartupApproval<TPolicy, TTable, TAudit, TLease>;
  /** `PHOENIX_LEASE_NONCE` as the runtime holds it; only its hash is compared, it is never kept. */
  readonly nonce: string;
  readonly facts: { readonly lease: LeaseJsonReadPort; readonly launcher: LauncherFactsReadPort; readonly versions: RuntimeVersionReadPort };
  readonly deps: Omit<LoopDeps<TLease, TAudit, TPolicy, TTable, TRequest>, "manifest">;
}

/** The 16 keys of `deps` (the 17 of `LoopDeps` without `manifest`). */
const DEPS_KEYS: readonly string[] = [
  "isolation", "fs", "runVolumeDir", "clock", "wallClock", "timers", "provider", "audit", "responseGate", "policy", "runnerFactory", "comparator",
  "analysisFs", "repoRoot", "analysis", "storeFactory",
];
const MAX_NONCE_LENGTH = 1024;
/** The fixed text of the second call of the wrapped factory (startRun drops the message). */
const FACTORY_ALREADY_USED = "the Runner factory of this Run was already used";
const MEASUREMENT_FAILED: StartStateView = Object.freeze({ ok: false as const, code: "internal_error" });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const own = (o: object, k: string): unknown => {
  const d = Object.getOwnPropertyDescriptor(o, k);
  return d === undefined || !("value" in d) ? undefined : d.value;
};
const refuse = (code: ComposeRunErrorCode, detail?: string): Result<never, ComposeRunError> =>
  ({ ok: false, error: detail === undefined ? { code } : { code, detail } });
const hasMethods = (r: unknown): r is ExperimentRunnerPort =>
  isObj(r) && typeof r["health"] === "function" && typeof r["execute"] === "function" && typeof r["measureStartState"] === "function";

export function composeRun<TLease, TAudit, TPolicy, TTable, TRequest>(
  input: ComposeRunInput<TLease, TAudit, TPolicy, TTable, TRequest>,
): Result<LoopDeps<TLease, TAudit, TPolicy, TTable, TRequest>, ComposeRunError> {
  if (!isObj(input)) return refuse("input_invalid");
  // 1. the startup ticket of stage B (brand only; the start gate consumes it)
  const startup = own(input, "startup");
  if (!isStartupApproval(startup)) return refuse("startup_invalid");
  const nonce = own(input, "nonce");
  if (typeof nonce !== "string" || nonce.length === 0 || nonce.length > MAX_NONCE_LENGTH) return refuse("nonce_invalid");
  const deps = own(input, "deps");
  if (!isObj(deps)) return refuse("deps_invalid");
  const keys = Object.keys(deps);
  if (keys.length !== DEPS_KEYS.length || !DEPS_KEYS.every((k) => keys.includes(k))) return refuse("deps_invalid");
  const originalFactory = own(deps, "runnerFactory");
  if (typeof originalFactory !== "function") return refuse("deps_invalid");
  const facts = own(input, "facts");
  if (!isObj(facts)) return refuse("input_invalid");
  const leasePort = own(facts, "lease") as LeaseJsonReadPort;
  const launcherPort = own(facts, "launcher") as LauncherFactsReadPort;
  const versionPort = own(facts, "versions") as RuntimeVersionReadPort;
  if (!isObj(leasePort) || !isObj(launcherPort) || !isObj(versionPort)) return refuse("input_invalid");

  const runId = startup.lease.runId;
  // 2. the lease facts, against the run id, the nonce and the lease timing of the ticket
  const leaseExpectation = { runId, nonce, heartbeatIntervalMs: startup.lease.heartbeatIntervalMs, staleAfterMs: startup.lease.staleAfterMs };
  const leaseStart = readLeaseFactsSnapshot(leasePort, leaseExpectation);
  if (!leaseStart.ok) return refuse("lease_facts_refused", leaseStart.error.code);
  // 3. the launcher facts (version 2), against the run id and the audit configuration hash that stage B measured
  const launcherExpectation = { runId, auditConfigSha256: startup.auditConfig.sha256 };
  const launcherStart = readLauncherFactsSnapshot(launcherPort, launcherExpectation);
  if (!launcherStart.ok) return refuse("launcher_facts_refused", launcherStart.error.code);
  // 4. the runtime version facts
  const versionStart = collectRuntimeVersionFacts(versionPort);
  if (!versionStart.ok) return refuse("runtime_versions_refused", versionStart.error.code);
  // 5. the start-state cell of this Run
  const cellMade = createStartStateCell(runId);
  if (!cellMade.ok) return refuse("start_state_cell_refused", cellMade.error.code);
  const cell = cellMade.value;
  // 6. the Run_Manifest port of this Run
  const port = createManifestPort({
    runId,
    startStateCell: cell,
    lease: { port: leasePort, expectation: leaseExpectation, start: leaseStart.value },
    launcher: { port: launcherPort, expectation: launcherExpectation, start: launcherStart.value },
    versions: { port: versionPort, start: versionStart.value },
    sandbox: startup.sandbox,
    configuredProvider: startup.config.provider,
  });
  if (!port.ok) return refuse("manifest_port_refused", port.error.code);

  // 7. the Runner factory of this Run: one call, one Runner, one measurement into the cell
  let factoryUsed = false;
  const runnerFactory = (factoryInput: RunnerFactoryInput<TLease, TPolicy, TTable>): ExperimentRunnerPort => {
    if (factoryUsed) throw new Error(FACTORY_ALREADY_USED);
    factoryUsed = true;
    const inner: unknown = (originalFactory as (i: RunnerFactoryInput<TLease, TPolicy, TTable>) => unknown)(factoryInput);
    // a Runner without the three methods is handed back as it is: startRun refuses it (runner_start_refused)
    if (!hasMethods(inner)) return inner as ExperimentRunnerPort;
    const runner = inner;
    let measured = false;
    return Object.freeze({
      health: () => runner.health(),
      execute: (e: unknown, decisionRecordId: string, signal: AbortSignal, options?: { readonly notAfterMs?: number }) =>
        options === undefined ? runner.execute(e, decisionRecordId, signal) : runner.execute(e, decisionRecordId, signal, options),
      measureStartState: async (signal: AbortSignal, options?: { readonly notAfterMs?: number }): Promise<StartStateView> => {
        if (measured) return MEASUREMENT_FAILED; // the cell is written once; a second measurement never reaches the Runner
        measured = true;
        let result: unknown;
        try {
          result = await (options === undefined ? runner.measureStartState(signal) : runner.measureStartState(signal, options));
        } catch {
          result = MEASUREMENT_FAILED;
        }
        const written = cell.set(runId, result);
        if (!written.ok) {
          // the cell is closed by the refused write: the Run_Manifest cannot be sealed, and nothing can be written into it later
          return MEASUREMENT_FAILED;
        }
        return result as StartStateView;
      },
    });
  };

  // 8. the 17 keys of LoopDeps
  const out = { ...(deps as Omit<LoopDeps<TLease, TAudit, TPolicy, TTable, TRequest>, "manifest">), runnerFactory, manifest: port.value };
  return { ok: true, value: out as LoopDeps<TLease, TAudit, TPolicy, TTable, TRequest> };
}
