// Composition root of the Loop_Orchestrator (task 4.4, unit U7; R2.12, R11.15, R12.13, R12.14, R15.6, R19.3, R19.7, R24.15).
//
// `createLoopOrchestrator(loopDeps, extras)` returns `{ run }`. `run(startup)` is the ONE entry point of a Run. It takes the startup ticket only
// (single use: `startGate` consumes it), never throws, and answers a `RunResult`. ORDER (fixed):
//    1. `startGate` (a refusal is an unsealed result; no store is opened and no record is written);
//    2. `startRun` (a refusal is returned as it is);
//    3. the read observer: `createReadObserver` and `observeAnalysisReads` wrap `loopDeps.analysisFs`. The first denied read raises
//       `isolation_violation` SYNCHRONOUSLY and starts the write of ONE `error` record whose payload is the closed vocabulary
//       `{ code, op, errorCode, locationId }`. The promise of every such write is kept in a pending list; a failed write is never lost;
//    4. the Source_Bundle is built ONLY by `loopDeps.analysis.buildSourceBundle(wrappedFs, loopDeps.repoRoot)`;
//    5. the record `source_bundle_manifest` (path and hash of each file, no source text) is written and awaited. A failed build or write raises
//       `error`: no provider call is made, and the Run goes to the end;
//    6. only when `PhaseRun.proceed` is true and the latch is `none`: `runIterations`. A throw (the sanctioned records-unavailable throw or any
//       other) raises `error`;
//    7. `runIterations` AND every pending observer write are awaited before anything is terminated;
//    8. `PhaseRun.cancelDeadlineTimer()`, then 9. `createTerminator(...).terminate()`.
// The termination reason comes ONLY from the session latch. The termination capability of the writer goes ONLY to `createTerminator`.
// The startup ticket is never serialized, logged, stored or passed as a whole: only single fields are read (names, hashes, numbers, the
// validated configuration values, the lease instance for the Runner and the lease checks).
import type { StartupApproval } from "../config/startup.js";
import type { IsolationViolation } from "../isolation/index.js";
import { EvidenceStore } from "../model/evidenceStore.js";
import type { Json } from "../schema/types.js";
import type { SemanticSha256Of } from "./hypothesisPhase.js";
import { createIdCounters } from "./ids.js";
import { runIterations, type IterationLoopResult } from "./iteration.js";
import { createReadObserver, observeAnalysisReads } from "./observeReads.js";
import type { RecordWriter } from "./recordWriter.js";
import type { RunSession } from "./session.js";
import { startGate } from "./startGate.js";
import { startRun, type PhaseRun } from "./startRun.js";
import { createTerminator, type TerminationBase } from "./terminate.js";
import type { LoopDeps, ManifestEnvVarRead, ManifestPayloadAudit, RunResult, StartGateRefusal, UnsealedFailure } from "./types.js";

/** What the composition root adds to `LoopDeps` (which keeps its seventeen keys). */
export interface LoopExtras {
  /** The schema validator that the response gate uses (the ai-client `SchemaValidatorPort`); opaque here. */
  readonly validator: unknown;
  /** Canonical JSON and SHA-256 of the semantic part of a claim. */
  readonly semanticSha256Of: SemanticSha256Of;
  /** The ids of the fixed instruction templates, one per request kind. */
  readonly templateIds: {
    readonly hypothesisGeneration: string;
    readonly experimentGeneration: string;
    readonly hypothesisRevision: string;
  };
  /** The resolved response limits (ai-client `resolveResponseLimits`), one per request kind; opaque here. */
  readonly responseLimits: {
    readonly hypothesisGeneration: unknown;
    readonly experimentGeneration: unknown;
    readonly hypothesisRevision: unknown;
  };
}

export interface LoopOrchestrator<TLease, TAudit, TPolicy, TTable> {
  /** Never throws and never rejects. The ticket is consumed by the first call; a second call with it is refused and writes nothing. */
  run(startup: StartupApproval<TPolicy, TTable, TAudit, TLease>): Promise<RunResult>;
}

/** The result of a write of a required record: written, refused in a way the writer counts (terminate() will not seal), or neither. */
type WriteOutcome = "ok" | "managed" | "unmanaged";
/** Refusals that take the writer down or are counted in `invalidRecords` / `secretRejections`: the Terminator refuses a normal seal for them. */
const MANAGED_WRITE_REFUSALS: ReadonlySet<string> = new Set(["writer_down", "io_failure", "store_failed", "invalid_record", "secret_rejected"]);

const COMPONENT = "orchestrator";
const NO_REVISION = "none";

const unsealed = (failure: UnsealedFailure, started: boolean): RunResult => Object.freeze({ sealed: false as const, started, failure });

/** A refusal of the start gate has no Run content. Only a lease that is not valid has a code of its own; the rest is `internal_error`. */
function failureOfGate(refusal: StartGateRefusal): UnsealedFailure {
  return refusal.code === "lease_invalid" ? "lease_invalid_at_start" : "internal_error";
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

/** A plain JSON copy of validated values (numbers, strings, booleans, arrays and plain objects only). Throws for anything else. */
function jsonCopy(v: unknown, depth = 0): Json {
  if (depth > 32) throw new Error("too deep");
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (Array.isArray(v)) return v.map((x: unknown) => jsonCopy(x, depth + 1));
  if (isObj(v)) {
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(v)) out[k] = jsonCopy(v[k], depth + 1);
    return out;
  }
  throw new Error("not JSON");
}

function raiseError(session: RunSession): void {
  try {
    session.raise("error");
  } catch {
    // the session never throws
  }
}

/** The manifest of the Source_Bundle: the path and the hash of each file, read defensively. No source text. */
function manifestFilesOf(bundle: unknown): { path: string; sha256Lf: string }[] | undefined {
  if (!isObj(bundle) || !Array.isArray(bundle.manifest) || bundle.manifest.length === 0) return undefined;
  const files: { path: string; sha256Lf: string }[] = [];
  for (const m of bundle.manifest as unknown[]) {
    if (!isObj(m) || !isStr(m.path) || !isStr(m.sha256Lf)) return undefined;
    files.push({ path: m.path, sha256Lf: m.sha256Lf });
  }
  return files;
}

/** The counts of `payload_audit` records, read from the committed snapshot. `undefined` when the snapshot is unavailable. */
function auditCounts(writer: RecordWriter): { audits: number; passed: number; blocked: number } | undefined {
  const snap = writer.records();
  if (!snap.ok) return undefined;
  let audits = 0;
  let passed = 0;
  let blocked = 0;
  for (const rec of snap.value) {
    if (rec.kind !== "payload_audit") continue;
    audits += 1;
    const result = (rec.payload as { result?: unknown }).result;
    if (result === "pass") passed += 1;
    else if (result === "blocked") blocked += 1;
  }
  return { audits, passed, blocked };
}

export function createLoopOrchestrator<TLease, TAudit, TPolicy, TTable, TRequest>(
  loopDeps: LoopDeps<TLease, TAudit, TPolicy, TTable, TRequest>,
  extras: LoopExtras,
): LoopOrchestrator<TLease, TAudit, TPolicy, TTable> {
  async function runChecked(startup: StartupApproval<TPolicy, TTable, TAudit, TLease>, progress: { started: boolean }): Promise<RunResult> {
    // 1.
    const gate = await startGate(loopDeps, startup);
    if (!gate.ok) return unsealed(failureOfGate(gate.error), false);

    // 2.
    const begun = await startRun(loopDeps, startup, gate.value);
    if (begun.kind === "refused") return begun.result;
    progress.started = true;
    const run: PhaseRun = begun.run;
    const { session, writer } = run;

    // 3. The first violation raises the cause at once and starts the write of its record; the promise is kept.
    const pending: Promise<WriteOutcome>[] = [];
    const onViolation = (v: IsolationViolation): void => {
      session.raise("isolation_violation");
      let write: Promise<WriteOutcome>;
      try {
        write = writer.append("error", { code: v.code, op: v.op, errorCode: v.errorCode, locationId: v.locationId }, COMPONENT).then(
          (r): WriteOutcome => (r.ok === true ? "ok" : MANAGED_WRITE_REFUSALS.has(r.error.code) ? "managed" : "unmanaged"),
          (): WriteOutcome => "unmanaged",
        );
      } catch {
        write = Promise.resolve<WriteOutcome>("unmanaged");
      }
      pending.push(write);
    };
    const observer = createReadObserver({ onFirstViolation: onViolation });
    const wrappedFs = observeAnalysisReads(loopDeps.analysisFs, observer);
    const settlePending = async (): Promise<WriteOutcome> => {
      let worst: WriteOutcome = "ok";
      for (let i = 0; i < pending.length; i += 1) {
        const o = await (pending[i] as Promise<WriteOutcome>);
        if (o === "unmanaged" || (o === "managed" && worst === "ok")) worst = o;
      }
      return worst;
    };

    // 4. and 5.
    let bundle: unknown;
    let bundleFiles: { path: string; sha256Lf: string }[] | undefined;
    try {
      const built = await loopDeps.analysis.buildSourceBundle(wrappedFs, loopDeps.repoRoot);
      if (isObj(built) && built.ok === true) {
        bundle = built.value;
        bundleFiles = manifestFilesOf(bundle);
      }
    } catch {
      bundleFiles = undefined;
    }
    let bundleReady = false;
    if (bundleFiles === undefined) {
      raiseError(session);
    } else {
      try {
        const written = await writer.append("source_bundle_manifest", { files: bundleFiles }, COMPONENT);
        bundleReady = written.ok === true;
      } catch {
        bundleReady = false;
      }
      if (!bundleReady) raiseError(session);
    }

    // 6.
    let loop: IterationLoopResult | undefined;
    let loopPromise: Promise<IterationLoopResult> | undefined;
    if (bundleReady && run.proceed && session.terminationStatus().state === "none") {
      const limits = startup.config.limits;
      try {
        loopPromise = runIterations({
          session,
          writer,
          clock: loopDeps.clock,
          timers: loopDeps.timers,
          provider: loopDeps.provider,
          audit: loopDeps.audit,
          auditConfig: startup.auditConfig.load,
          responseGate: loopDeps.responseGate,
          evidenceStore: new EvidenceStore(),
          ids: createIdCounters(),
          leasePort: startup.lease.port,
          bundle,
          limits: {
            iterations: limits.iterations,
            experiments: limits.experiments,
            rejectedExperiments: limits.rejectedExperiments,
            providerCallSeconds: limits.providerCallSeconds,
            providerRetries: limits.providerRetries,
          },
          hypothesis: {
            generation: { responseLimits: extras.responseLimits.hypothesisGeneration, validator: extras.validator, templateId: extras.templateIds.hypothesisGeneration },
            revision: { responseLimits: extras.responseLimits.hypothesisRevision, validator: extras.validator, templateId: extras.templateIds.hypothesisRevision },
            generationStored: [],
            analysis: loopDeps.analysis,
            semanticSha256Of: extras.semanticSha256Of,
          },
          experiment: {
            templateId: extras.templateIds.experimentGeneration,
            policy: loopDeps.policy,
            policyConfig: startup.policy.value,
            runner: run.runner,
            comparator: loopDeps.comparator,
            mask: startup.config.mask,
            responseLimits: extras.responseLimits.experimentGeneration,
            validator: extras.validator,
          },
        });
      } catch {
        loopPromise = undefined;
        raiseError(session);
      }
    }

    // 7. Everything that is in flight settles BEFORE the Run is terminated.
    if (loopPromise !== undefined) {
      try {
        loop = await loopPromise;
      } catch {
        raiseError(session); // the sanctioned throw of the provider helper (records unavailable) or any other failure
      }
    }
    let writes: WriteOutcome = "ok";
    try {
      writes = await settlePending();
    } catch {
      writes = "unmanaged";
    }
    if (writes !== "ok") raiseError(session);
    // A required violation record that was refused for a reason the writer does not count (it neither takes the writer down nor raises
    // `invalidRecords` or `secretRejections`) must never end in a sealed Run: terminate() would not see it. The Run ends unsealed, nothing
    // is terminated or sealed, and the latched cause is reported.
    if (writes === "unmanaged") {
      try {
        run.cancelDeadlineTimer();
      } catch {
        // cancel never throws
      }
      const st = session.terminationStatus();
      return Object.freeze({ sealed: false as const, started: true, ...(st.state === "none" ? {} : { terminationReason: st.reason }), failure: "internal_error" as const });
    }

    // The base of the Manifest: names, flags, hashes and numbers. Nothing of the ticket as a whole.
    let base: TerminationBase | undefined;
    try {
      const counts = auditCounts(writer);
      if (counts === undefined) raiseError(session);
      const identity: unknown = loopDeps.provider.identity;
      const named = (k: "id" | "version" | "model"): string => (isObj(identity) && isStr(identity[k]) ? (identity[k] as string) : "unknown");
      const envVars: ManifestEnvVarRead[] = startup.envVarsRead.map((e) => ({ name: e.name, set: e.set }));
      for (const c of startup.credentials) if (!envVars.some((e) => e.name === c.name)) envVars.push({ name: c.name, set: c.set });
      const payloadAudit: ManifestPayloadAudit = {
        configCheck: startup.payloadAuditConfig,
        audits: counts?.audits ?? 0,
        passed: counts?.passed ?? 0,
        blocked: counts?.blocked ?? 0,
        auditConfigSha256: startup.auditConfig.sha256,
      };
      base = {
        finalHypothesisRevision: loop?.finalHypothesisRevision ?? NO_REVISION,
        provider: { id: named("id"), version: named("version"), model: named("model"), isMock: startup.config.provider === "mock" },
        envVarsRead: envVars,
        payloadAudit,
        accessDenial: gate.value.accessDenial,
        configHashes: { policyConfigSha256: startup.policy.policySha256, preparationTableSha256: startup.policy.preparationTableSha256 },
        leaseFacts: {
          heartbeatIntervalMs: startup.lease.heartbeatIntervalMs,
          staleAfterMs: startup.lease.staleAfterMs,
          propagationDelayMs: startup.lease.propagationDelayMs,
        },
        ...(bundleFiles === undefined ? {} : { sourceBundleManifest: { files: bundleFiles } }),
        effectiveConfig: jsonCopy(startup.config),
      };
    } catch {
      raiseError(session);
    }
    if (base === undefined) return unsealed("internal_error", true);

    // 8. and 9.
    try {
      run.cancelDeadlineTimer();
    } catch {
      // cancel never throws
    }
    return createTerminator({
      session,
      channel: begun.terminationChannel,
      wallClock: loopDeps.wallClock,
      manifest: loopDeps.manifest,
      runId: gate.value.runId,
      base,
      startedAt: run.startedAt,
    }).terminate();
  }

  return Object.freeze({
    async run(startup: StartupApproval<TPolicy, TTable, TAudit, TLease>): Promise<RunResult> {
      const progress = { started: false };
      try {
        return await runChecked(startup, progress);
      } catch {
        return unsealed("internal_error", progress.started);
      }
    },
  });
}
