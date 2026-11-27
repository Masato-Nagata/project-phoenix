// The replay composition root and the replay command (task 4.7, step A2; R12.23, R22.4, R22.5, R22.8; human decisions D1 to D5 of
// 2026-11-27). It is the ONLY replay file that imports the orchestrator, the runtime adapters and the sibling packages, and only the exact
// names that a replay needs (pinned by the static tests). It is not imported by any file and not exported by the package entry; the
// composition root of a Run (`main.ts`) cannot reach it.
//
//   node dist/replayMain.js --run <run-dir> --policy-config <path>/policy-config.json --preparation-table <path>/preparation-table.json
//
// WHAT A REPLAY IS (decision D1, O2 "record-derived"). The original Run is accepted with the unchanged `acceptRun` (through a size-bounded,
// capturing read port; 64 MiB). The leading three records (`run_started`, `isolation_checks`, `source_bundle_manifest`) are COPIED into an
// in-memory RunRecordStore with their original payloads and must get the original ids, seq and hashes (`context: copied_inputs`; they are
// not new measurements). Then the iteration control of the Loop_Orchestrator (`runIterations`) is driven DIRECTLY in a replay session: a fixed
// monotonic clock, timers that never fire, a lease port that answers `valid` and measures nothing (`lease: not_measured`). The REAL code
// regenerates everything from record 4 on: the requests (the C2 envelope function, then their hash is compared with the recorded hash), the
// response gate, the hypothesis checks and the Citation verification, the experiment records, the Experiment_Policy decisions (re-evaluated),
// the comparisons (the Comparator re-executed) and the Evidence. Only the provider answers (the ReplayProvider), the Runner values (the
// recorded Runner, from the Observations) and the audit verdicts (reused after the hash comparison) come from the records. The Source_Bundler
// and the allowlist check are NOT re-executed (the bundle is restored from the recorded envelopes).
//
// WHAT A REPLAY NEVER DOES. No start gate, no `startRun`, no `mayStartRun`, no `composeRun`, no `terminate`: no termination record, no seal,
// no Run_Manifest, no Completion_Marker, no Launcher record, no isolation attestation, no persistent Run directory, no write to the original
// Run (its port has no write operation). No provider of ai-client, no HTTP port, no lease file, no Legacy_App, no database, no network.
//
// RESULT (one canonical JSON line; no path, no credential, no request or response text, no exception message):
//   identical 0 | different 1 | diverged 1 | incomplete 2 (standard output); usage_error 2 | error 2 (standard error).
import { constants, type Stats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gateProviderResult, gateResponse, resolveResponseLimits } from "@phoenix/ai-client";
import { validateDeclarations, validateExpr, verifyCitations } from "@phoenix/analyzer";
import {
  compare, createAcceptanceCheck, evaluateForRecord, executionIdentity, loadPolicyConfig, loadPreparationTable, policyConfigSha256, preparationTableSha256,
} from "@phoenix/verifier";
import type { PolicyConfig, PrepTable } from "@phoenix/verifier";
import { canonicalJson } from "./canonical/index.js";
import { EvidenceStore } from "./model/evidenceStore.js";
import { createIdCounters } from "./orchestrator/ids.js";
import { runIterations } from "./orchestrator/iteration.js";
import { createRecordWriter } from "./orchestrator/recordWriter.js";
import { createRunSession } from "./orchestrator/session.js";
import { createRecordedRunner } from "./replay/recordedRunner.js";
import { createReplayAudit, type EnvelopeFunction } from "./replay/replayAudit.js";
import {
  EXTERNAL_INPUT_MAX_BYTES, REPLAY_CACHE_LIMIT_BYTES, acceptForReplay, buildReplayPlan, parseRecords, verifyExternalInputs, type BoundedRead,
  type BoundedReadPort, type PolicyLoader, type ReplayPlan,
} from "./replay/replayInputs.js";
import { createReplayProvider } from "./replay/replayProvider.js";
import {
  classifyReplay, createDivergenceCell, createFixedClock, createReplayLeasePort, createSilentTimers, recordIdOf, REPLAY_GUARANTEES, type ReplayIncompleteReason,
  type ReplayRunResult,
} from "./replay/replaySupport.js";
import { buildRequestEnvelope } from "./runtime/auditAdapter.js";
import { semanticSha256Of } from "./runtime/semanticHash.js";
import { createSchemaValidator, type Json, type SchemaValidator } from "./schema/index.js";
import { MemoryFileSystem } from "./store/memoryFileSystem.js";
import { RunRecordStore } from "./store/runRecordStore.js";

/** The template id handed to the loop for a request kind that the original Run never made: it is in no template table, so such a request
 *  cannot be built and the replay reports `diverged` (nothing is filled in from the current templates). */
const NOT_RECORDED_TEMPLATE_ID = "not-recorded-in-the-original-run";
/** Opaque audit configuration of a replay session: the replay audit reads none (the verdict is reused, never re-executed). */
const NO_AUDIT_CONFIGURATION = Object.freeze({});
const REPLAY_DIR = "/replay/out";
const COMPONENT = "orchestrator";

/** The C2 function, as the replay audit sees it. */
const envelopeOf: EnvelopeFunction = (input, templates) => {
  const r = buildRequestEnvelope(input, templates);
  return r.ok ? { ok: true, value: { kind: r.value.kind, bytes: r.value.bytes } } : { ok: false };
};

/** The verifier loader of stage B (runtime/startupPorts.ts): table, policy, then the two hashes of OD-17. */
const loadPolicy: PolicyLoader<PolicyConfig, PrepTable> = (policyRaw, tableRaw) => {
  const table = loadPreparationTable(tableRaw);
  if (!table.ok) return { ok: false };
  const policy = loadPolicyConfig(policyRaw, table.value);
  if (!policy.ok) return { ok: false };
  return { ok: true, policy: policy.value, table: table.value, policySha256: policyConfigSha256(policy.value), tableSha256: preparationTableSha256(table.value) };
};

/** What a test may observe of a finished replay. Counts and the regenerated records only. */
export interface ReplayFacts {
  readonly regenerated: readonly string[];
  readonly providerAnswers: number;
  readonly runnerCalls: number;
  readonly auditsReused: number;
  readonly timersScheduled: number;
  readonly leaseChecks: number;
}

export interface ReplayRunInput {
  readonly port: BoundedReadPort;
  readonly runDir: string;
  /** The two inputs a human named, each read ONCE by the caller (bounded). */
  readonly policyConfig: BoundedRead;
  readonly preparationTable: BoundedRead;
  /** Tests only. */
  readonly testHooks?: {
    readonly cacheLimitBytes?: number;
    readonly semanticSha256Of?: typeof semanticSha256Of;
    readonly envelope?: EnvelopeFunction;
    readonly onFinished?: (facts: ReplayFacts) => void;
  };
}

/** Thrown for a state that the preparation rules out. The command reports it as `error`, never as a replay verdict. */
export class ReplayInternalError extends Error {
  constructor(readonly code: "store_open_failed" | "session_failed") {
    super(`replay internal error: ${code}`);
    this.name = "ReplayInternalError";
  }
}

const freezeIncomplete = (r: { readonly reason: ReplayIncompleteReason; readonly detail?: string }): ReplayRunResult =>
  Object.freeze(r.detail === undefined ? { result: "incomplete" as const, reason: r.reason } : { result: "incomplete" as const, reason: r.reason, detail: r.detail });

/** The replay of one recorded Run (R22.4, R22.5). Reads only; writes nothing but an in-memory store that is dropped at the end. */
export async function replayRun(input: ReplayRunInput): Promise<ReplayRunResult> {
  const validator: SchemaValidator = createSchemaValidator();
  const hooks: NonNullable<ReplayRunInput["testHooks"]> = input.testHooks ?? {};

  // 1. acceptance (R12.23, R22.8), 2. records, 3. plan, 4. external inputs: all before anything is regenerated
  const accepted = await acceptForReplay(input.port, input.runDir, validator, hooks.cacheLimitBytes ?? REPLAY_CACHE_LIMIT_BYTES);
  if (!accepted.ok) return freezeIncomplete(accepted);
  const parsed = parseRecords(accepted.recordsBytes, validator, accepted.manifest["chain"]);
  if (!parsed.ok) return freezeIncomplete(parsed);
  let planned: ReturnType<typeof buildReplayPlan>;
  try {
    planned = buildReplayPlan(parsed.records, accepted.manifest, accepted.blobs, validator);
  } catch {
    return freezeIncomplete({ reason: "records_invalid", detail: "plan" });
  }
  if (!planned.ok) return freezeIncomplete(planned);
  const plan: ReplayPlan = planned.plan;
  const external = verifyExternalInputs(input.policyConfig, input.preparationTable, loadPolicy, plan);
  if (!external.ok) return freezeIncomplete(external);
  const limits = plan.config.limits;
  const responseLimits = resolveResponseLimits({ maxResponseBytes: limits.responseBytes, maxExperiments: limits.experimentsPerResponse });
  if (!responseLimits.ok) return freezeIncomplete({ reason: "manifest_invalid", detail: "response_limits" });

  // the in-memory store and the copied input context (D5)
  const mem = new MemoryFileSystem();
  mem.addDir(REPLAY_DIR);
  const opened = await RunRecordStore.open(mem, REPLAY_DIR);
  if (!opened.ok) throw new ReplayInternalError("store_open_failed");
  const store = opened.value;
  const { writer } = createRecordWriter(store);
  for (let i = 0; i < plan.copied; i += 1) {
    const original = plan.records[i];
    if (original === undefined) throw new ReplayInternalError("store_open_failed");
    const written = await writer.append(original.kind as Parameters<typeof writer.append>[0], original.payload as Parameters<typeof writer.append>[1], COMPONENT);
    const copy = store.list()[i];
    if (!written.ok || copy === undefined || canonicalJson(copy as unknown as Json) !== original.canonical) {
      return Object.freeze({ result: "different" as const, firstDifferingRecord: recordIdOf(i), difference: "content" as const, cause: "context_record_mismatch" as const, guarantees: REPLAY_GUARANTEES });
    }
  }

  // the replay session: replay-only ports, never injected into a Run
  const clock = createFixedClock();
  const timers = createSilentTimers();
  const leasePort = createReplayLeasePort();
  const made = createRunSession({ clock, runSeconds: limits.runSeconds });
  if (!made.ok) throw new ReplayInternalError("session_failed");
  const session = made.value;
  session.markStarted();

  const cell = createDivergenceCell();
  const audit = createReplayAudit({ envelope: hooks.envelope ?? envelopeOf, templates: plan.templates, recorded: plan.audits, cell });
  const provider = createReplayProvider({ identity: plan.identity, recorded: plan.calls, registry: audit.registry, cell });
  const policy = external.policy;
  const table = external.table;
  const acceptance = createAcceptanceCheck(() => {
    const r = writer.records();
    return r.ok ? r.value : [];
  });
  const runner = createRecordedRunner({
    recorded: plan.executions,
    isAccepted: (experimentId, decisionRecordId, e) => acceptance(experimentId, decisionRecordId, executionIdentity(e, policy, table)),
    cell,
  });
  const templateOf = (kind: "hypothesis_generation" | "experiment_generation" | "hypothesis_revision"): string => plan.templateIds[kind] ?? NOT_RECORDED_TEMPLATE_ID;

  const loopInput = {
    session,
    writer,
    clock,
    timers,
    provider,
    audit,
    auditConfig: NO_AUDIT_CONFIGURATION,
    responseGate: { gateProviderResult, gateResponse, resolveResponseLimits },
    evidenceStore: new EvidenceStore(),
    ids: createIdCounters(),
    leasePort,
    bundle: plan.bundle,
    limits: {
      iterations: limits.iterations,
      experiments: limits.experiments,
      rejectedExperiments: limits.rejectedExperiments,
      providerCallSeconds: limits.providerCallSeconds,
      providerRetries: limits.providerRetries,
    },
    hypothesis: {
      generation: { responseLimits: responseLimits.value, validator, templateId: templateOf("hypothesis_generation") },
      revision: { responseLimits: responseLimits.value, validator, templateId: templateOf("hypothesis_revision") },
      generationStored: [],
      analysis: { verifyCitations, validateDeclarations, validateExpr },
      semanticSha256Of: hooks.semanticSha256Of ?? semanticSha256Of,
    },
    experiment: {
      templateId: templateOf("experiment_generation"),
      policy: { evaluateForRecord },
      policyConfig: policy,
      runner,
      comparator: { compare },
      mask: plan.config.mask,
      responseLimits: responseLimits.value,
      validator,
    },
  };
  try {
    await runIterations(loopInput as unknown as Parameters<typeof runIterations>[0]);
  } catch {
    session.raise("error"); // the sanctioned throw of the provider helper (records unavailable) or any other failure
  }

  // the end, as terminate() decides the reason (without writing the termination record and without sealing)
  await writer.drain();
  const state = writer.state();
  if (state.down || state.secretRejections > 0 || state.invalidRecords > 0) session.raise("error");
  let fin = session.finalize();
  if (!fin.ok) {
    session.raise("error");
    fin = session.finalize();
  }
  const replayTermination = fin.ok ? fin.value.reason : "error";
  const regenerated = store.list().map((r) => canonicalJson(r as unknown as Json));

  hooks.onFinished?.(
    Object.freeze({
      regenerated: Object.freeze([...regenerated]),
      providerAnswers: provider.answered(),
      runnerCalls: runner.calls(),
      auditsReused: audit.reused(),
      timersScheduled: timers.scheduled(),
      leaseChecks: leasePort.checks(),
    }),
  );
  return classifyReplay({
    original: plan.originalCanonical,
    regenerated,
    copied: plan.copied,
    originalTermination: plan.termination,
    replayTermination,
    mismatch: cell.first(),
    unconsumed: { audits: audit.unconsumed(), responses: provider.unconsumed(), observations: runner.unconsumed() },
  });
}

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------
export const REPLAY_EXIT_CODES = Object.freeze({ identical: 0, different: 1, diverged: 1, incomplete: 2, usage_error: 2, error: 2 } as const);
export const REPLAY_USAGE = "replay-run --run <run-dir> --policy-config <path>/policy-config.json --preparation-table <path>/preparation-table.json";
const OPTIONS = Object.freeze({ "--run": "run", "--policy-config": "policyConfig", "--preparation-table": "preparationTable" } as const);
const INPUT_NAMES = Object.freeze({ policyConfig: "policy-config.json", preparationTable: "preparation-table.json" } as const);
/** Path segments a replay never reads: the incoming exports, the evaluation data, the Approval_Store; and no parent segment. */
const FORBIDDEN_SEGMENTS: readonly string[] = Object.freeze(["..", ".incoming", "evaluation", "approvals"]);

export type ReplayUsageCode = "wrong_argument_count" | "unknown_option" | "duplicate_option" | "missing_option" | "empty_path" | "unsafe_path" | "input_name";

export interface ReplayCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const line = (v: object): string => canonicalJson({ tool: "replay-run", schemaVersion: 1, ...v } as Json);

/** The closed refusal of one path argument, or `undefined` when it may be used. Only the string is looked at; nothing is read. */
export function pathRefusal(p: string, expectedName?: string): "empty_path" | "unsafe_path" | "input_name" | undefined {
  if (p === "") return "empty_path";
  if (p.includes("\0") || p.startsWith("-")) return "unsafe_path";
  const segments = p.split(/[\\/]+/).filter((s) => s !== "");
  if (segments.length === 0 || segments.some((s) => FORBIDDEN_SEGMENTS.includes(s.toLowerCase()))) return "unsafe_path";
  if (expectedName !== undefined && segments[segments.length - 1] !== expectedName) return "input_name";
  return undefined;
}

/** Runs the command over `argv` (without the node and script entries). Never throws. Writes exactly one line. */
export async function runReplayCli(argv: readonly string[], io: ReplayCliIo, port: BoundedReadPort): Promise<number> {
  const usage = (code: ReplayUsageCode): number => {
    io.stderr(line({ result: "usage_error", code, usage: REPLAY_USAGE }));
    return REPLAY_EXIT_CODES.usage_error;
  };
  if (argv.length !== 6) return usage("wrong_argument_count");
  const given: { run?: string; policyConfig?: string; preparationTable?: string } = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i] as string;
    const value = argv[i + 1] as string;
    if (!Object.hasOwn(OPTIONS, name)) return usage("unknown_option");
    const key = OPTIONS[name as keyof typeof OPTIONS];
    if (given[key] !== undefined) return usage("duplicate_option");
    given[key] = value;
  }
  if (given.run === undefined || given.policyConfig === undefined || given.preparationTable === undefined) return usage("missing_option");
  const refusals = [pathRefusal(given.run), pathRefusal(given.policyConfig, INPUT_NAMES.policyConfig), pathRefusal(given.preparationTable, INPUT_NAMES.preparationTable)];
  const refused = refusals.find((r) => r !== undefined);
  if (refused !== undefined) return usage(refused);

  let result: ReplayRunResult;
  try {
    // each input is read ONCE, bounded; the same bytes are verified and used
    const policyConfig = await port.readBounded(given.policyConfig, EXTERNAL_INPUT_MAX_BYTES);
    const preparationTable = await port.readBounded(given.preparationTable, EXTERNAL_INPUT_MAX_BYTES);
    result = await replayRun({ port, runDir: given.run, policyConfig, preparationTable });
  } catch (e) {
    io.stderr(line({ result: "error", code: "internal_error", ...(e instanceof ReplayInternalError ? { detail: e.code } : {}) }));
    return REPLAY_EXIT_CODES.error;
  }
  io.stdout(line(result));
  return REPLAY_EXIT_CODES[result.result];
}

const errCode = (e: unknown): unknown => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined);

/**
 * The bounded read port over `node:fs`. A file is opened without following a symbolic link, its size is checked on the open handle BEFORE any
 * byte is read, and at most `maxBytes + 1` bytes are read (a file that grew meanwhile is `too_large`). A symbolic link is refused; a path that
 * is not a regular file is `missing`. It has no write, rename, mkdir or remove operation.
 */
export function createNodeBoundedReadPort(): BoundedReadPort {
  const noFollow = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  return Object.freeze({
    async listDir(path: string): Promise<string[] | undefined> {
      try {
        return (await readdir(path)).sort();
      } catch (e) {
        if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return undefined;
        throw e;
      }
    },
    async readBounded(path: string, maxBytes: number): Promise<BoundedRead> {
      let st: Stats;
      try {
        st = await lstat(path);
      } catch (e) {
        if (errCode(e) === "ENOENT" || errCode(e) === "ENOTDIR") return { kind: "missing" };
        throw e;
      }
      if (st.isSymbolicLink()) throw new Error("symbolic link refused");
      if (!st.isFile()) return { kind: "missing" };
      if (st.size > maxBytes) return { kind: "too_large" };
      const handle = await open(path, constants.O_RDONLY | noFollow);
      try {
        const fst = await handle.stat();
        if (!fst.isFile()) return { kind: "missing" };
        if (fst.size > maxBytes) return { kind: "too_large" };
        const buffer = new Uint8Array(fst.size + 1);
        let offset = 0;
        while (offset < buffer.length) {
          const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
          if (bytesRead === 0) break;
          offset += bytesRead;
        }
        if (offset > fst.size || offset > maxBytes) return { kind: "too_large" };
        return { kind: "ok", bytes: buffer.slice(0, offset) };
      } finally {
        await handle.close();
      }
    },
  });
}

function isEntryPoint(argvPath: string | undefined, moduleUrl: string): boolean {
  if (typeof argvPath !== "string" || argvPath === "") return false;
  try {
    return pathToFileURL(resolve(argvPath)).href === moduleUrl;
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  runReplayCli(process.argv.slice(2), { stdout: (l) => process.stdout.write(`${l}\n`), stderr: (l) => process.stderr.write(`${l}\n`) }, createNodeBoundedReadPort()).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 2;
    },
  );
}
