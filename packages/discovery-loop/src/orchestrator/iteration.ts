// Iteration control of the Loop_Orchestrator (task 4.4, unit U6c; R4.8, R11.7, R11.9, R11.11, R11.18).
//
// `runIterations` drives the phases in sequence and never in parallel:
//    generation (`hypothesis_generation`)  ->  Iteration 1: Experiment phase  ->  revision (`hypothesis_revision`)  ->  Iteration 2: Experiment phase  -> ...
// Before EVERY phase (including the first generation) the same three checks run, in this order: the latch is `none`, the Run signal is not aborted,
// and one `deadlineCheckpoint` says `continue`. If one fails, no phase and no AI call starts, and the existing cause is never overwritten. An aborted signal
// with an empty latch is attributed as the symptom `interrupted` (as the hypothesis phase does); every other stop is already latched by whoever stopped.
//
// ITERATIONS. The number starts at 1. `session.noteIteration()` is called once, right before each Experiment phase starts (after the checks above).
// After a `completed` Experiment phase:
//    - `session.experimentCount >= limits.experiments`  ->  raise `experiment_limit_reached`, no revision (also when the count equals the limit exactly);
//    - this was the last permitted Iteration            ->  raise `iteration_limit_reached`, no revision (no closing revision, R11.18);
//    - otherwise one revision is requested. An accepted revision is the hypothesis of the next Iteration.
// A `limit` or `stopped` result of the Experiment phase ends the loop; the phase has already raised its cause (`policy_rejection_limit`,
// `no_further_experiments`, ...). Those causes are NOT decided again here.
//
// FINAL REVISION. `finalHypothesisRevision` is the `hypothesisId` of the last revision for which `runHypothesisPhase` returned `accepted` (schema, static
// check, Citation verification and its records all completed), or the text `none`. `hypothesisId` is unique per revision: the phase takes a new
// `hyp-<n>` from the id counters for the generation AND for every revision (`revision` is the number within the chain). A citation result `failed`
// (contradicted source Evidence) does not disqualify a revision.
//
// This file does not end the Run: no termination record, no seal, no manifest. The result only reports what happened; the caller (U7) terminates.
// The sanctioned throw of `callProvider` (unreadable records) passes through the phases and through this function unchanged.
import { deadlineCheckpoint } from "./deadline.js";
import { runExperimentPhase, type ExperimentPhaseInput, type ExperimentPhaseResult } from "./experimentPhase.js";
import { runHypothesisPhase, type AcceptedClaimRef, type HypothesisPhaseInput, type HypothesisPhaseResult, type SemanticSha256Of } from "./hypothesisPhase.js";
import type { RunSession } from "./session.js";
import type { AnalysisPort, StoredPartRef } from "./types.js";

/** What differs between the two hypothesis request kinds. */
export interface HypothesisRequestConfig {
  readonly responseLimits: unknown;
  readonly validator: unknown;
  readonly templateId: string;
}

type Shared<TAudit, TRequest, TPolicy> = Pick<
  ExperimentPhaseInput<TAudit, TRequest, TPolicy>,
  "session" | "writer" | "clock" | "timers" | "provider" | "audit" | "auditConfig" | "responseGate" | "evidenceStore" | "ids" | "leasePort" | "bundle"
>;

export interface IterationLoopInput<TAudit, TRequest, TPolicy> extends Shared<TAudit, TRequest, TPolicy> {
  readonly limits: {
    readonly providerCallSeconds: number;
    readonly providerRetries: number;
    /** The Iteration limit (a safe integer, at least 1). */
    readonly iterations: number;
    readonly experiments: number;
    readonly rejectedExperiments: number;
  };
  readonly hypothesis: {
    readonly generation: HypothesisRequestConfig;
    readonly revision: HypothesisRequestConfig;
    /** `stored` of the generation request (a first request has no earlier records of the Run). */
    readonly generationStored: readonly StoredPartRef[];
    readonly analysis: Pick<AnalysisPort, "verifyCitations" | "validateDeclarations" | "validateExpr">;
    readonly semanticSha256Of: SemanticSha256Of;
  };
  readonly experiment: Pick<ExperimentPhaseInput<TAudit, TRequest, TPolicy>, "templateId" | "policy" | "policyConfig" | "runner" | "comparator" | "mask"> & {
    readonly responseLimits: unknown;
    readonly validator: unknown;
  };
}

export type IterationLoopEnd = "iteration_limit" | "experiment_limit" | "phase_limit" | "stopped";

export interface IterationLoopResult {
  /** The `hypothesisId` of the last accepted revision, or the text `none`. */
  readonly finalHypothesisRevision: string;
  /** The number of Experiment phases that were started (the value of `session.noteIteration()` calls made here). */
  readonly iterationsUsed: number;
  /**
   * Why the loop ended. `iteration_limit` and `experiment_limit`: raised here. `phase_limit`: the Experiment phase returned `limit` (it raised its
   * own cause). `stopped`: a phase stopped, a check before a phase failed, or an input was invalid; the cause is on the session.
   */
  readonly ended: IterationLoopEnd;
}

const NONE = "none";
const isStr = (v: unknown): v is string => typeof v === "string" && v !== "";
const isInt = (v: unknown, lo: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= lo;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function raiseError(session: RunSession): void {
  try {
    session.raise("error");
  } catch {
    // the session never throws; nothing more can be done
  }
}

/** The latch is `none`, the Run signal is not aborted, and one deadline checkpoint continues. */
function mayStartPhase(session: RunSession): boolean {
  if (session.terminationStatus().state !== "none") return false;
  if (session.signal.aborted) {
    session.attributeSymptom("interrupted");
    return false;
  }
  return deadlineCheckpoint(session) === "continue";
}

/** A usable `accepted` result, read defensively. */
interface Accepted {
  readonly recordId: string;
  readonly hypothesisId: string;
  readonly revision: number;
  readonly claims: readonly AcceptedClaimRef[];
}
function readAccepted(r: unknown): Accepted | undefined {
  if (!isObj(r) || r.kind !== "accepted") return undefined;
  const { hypothesisRevisionRecordId, hypothesisId, revision, claims } = r;
  if (!isStr(hypothesisRevisionRecordId) || !isStr(hypothesisId) || !isInt(revision, 1) || !Array.isArray(claims)) return undefined;
  const out: AcceptedClaimRef[] = [];
  for (const c of claims as unknown[]) {
    if (!isObj(c) || !isStr(c.claimId) || !isStr(c.claimRevisionId) || !isInt(c.revision, 1)) return undefined;
    out.push({ claimId: c.claimId, claimRevisionId: c.claimRevisionId, revision: c.revision });
  }
  return { recordId: hypothesisRevisionRecordId, hypothesisId, revision, claims: out };
}

const hypothesisRef = (a: Accepted): StoredPartRef => ({ partId: `${a.hypothesisId}-hypothesis-revision`, type: "hypothesis_revision", recordId: a.recordId });

export async function runIterations<TAudit, TRequest, TPolicy>(input: IterationLoopInput<TAudit, TRequest, TPolicy>): Promise<IterationLoopResult> {
  const { session } = input;
  let final = NONE;
  let iterationsUsed = 0;
  const done = (ended: IterationLoopEnd): IterationLoopResult => Object.freeze({ finalHypothesisRevision: final, iterationsUsed, ended });

  const lim = input.limits;
  if (!isInt(lim.iterations, 1) || !isInt(lim.experiments, 0)) {
    raiseError(session);
    return done("stopped");
  }

  const hypothesisCommon = {
    session,
    writer: input.writer,
    clock: input.clock,
    timers: input.timers,
    provider: input.provider,
    audit: input.audit,
    auditConfig: input.auditConfig,
    responseGate: input.responseGate,
    evidenceStore: input.evidenceStore,
    ids: input.ids,
    leasePort: input.leasePort,
    bundle: input.bundle,
    analysis: input.hypothesis.analysis,
    semanticSha256Of: input.hypothesis.semanticSha256Of,
    limits: { providerCallSeconds: lim.providerCallSeconds, providerRetries: lim.providerRetries },
  };

  // generation
  if (!mayStartPhase(session)) return done("stopped");
  const g = input.hypothesis.generation;
  const generated: HypothesisPhaseResult = await runHypothesisPhase<TAudit, TRequest>({
    ...hypothesisCommon,
    kind: "hypothesis_generation",
    responseLimits: g.responseLimits,
    validator: g.validator,
    templateId: g.templateId,
    stored: input.hypothesis.generationStored,
  } as HypothesisPhaseInput<TAudit, TRequest>);
  let current = readAccepted(generated);
  if (current === undefined) {
    if (generated.kind !== "stopped") raiseError(session); // an `accepted` that cannot be read, or an unknown kind
    return done("stopped");
  }
  final = current.hypothesisId;

  for (let iteration = 1; iteration <= lim.iterations; iteration += 1) {
    if (!mayStartPhase(session)) return done("stopped");
    session.noteIteration();
    iterationsUsed = iteration;
    const e = input.experiment;
    const experimentResult: ExperimentPhaseResult = await runExperimentPhase<TAudit, TRequest, TPolicy>({
      session,
      writer: input.writer,
      clock: input.clock,
      timers: input.timers,
      provider: input.provider,
      audit: input.audit,
      auditConfig: input.auditConfig,
      responseGate: input.responseGate,
      responseLimits: e.responseLimits,
      validator: e.validator,
      evidenceStore: input.evidenceStore,
      ids: input.ids,
      leasePort: input.leasePort,
      bundle: input.bundle,
      templateId: e.templateId,
      stored: [hypothesisRef(current)],
      limits: {
        providerCallSeconds: lim.providerCallSeconds,
        providerRetries: lim.providerRetries,
        experiments: lim.experiments,
        rejectedExperiments: lim.rejectedExperiments,
      },
      iteration,
      hypothesis: { hypothesisId: current.hypothesisId, claims: current.claims.map((c) => ({ claimId: c.claimId, claimRevisionId: c.claimRevisionId })) },
      policy: e.policy,
      policyConfig: e.policyConfig,
      runner: e.runner,
      comparator: e.comparator,
      mask: e.mask,
    });
    if (experimentResult.kind === "stopped") return done("stopped");
    if (experimentResult.kind === "limit") return done("phase_limit");
    if (experimentResult.kind !== "completed") {
      raiseError(session);
      return done("stopped");
    }
    if (session.terminationStatus().state !== "none") return done("stopped"); // a cause latched during the phase is never overwritten
    if (session.experimentCount >= lim.experiments) {
      session.raise("experiment_limit_reached");
      return done("experiment_limit");
    }
    if (iteration >= lim.iterations) {
      session.raise("iteration_limit_reached");
      return done("iteration_limit");
    }

    // revision
    if (!mayStartPhase(session)) return done("stopped");
    const r = input.hypothesis.revision;
    const revised: HypothesisPhaseResult = await runHypothesisPhase<TAudit, TRequest>({
      ...hypothesisCommon,
      kind: "hypothesis_revision",
      responseLimits: r.responseLimits,
      validator: r.validator,
      templateId: r.templateId,
      stored: [hypothesisRef(current), ...experimentResult.storedRefsForRevision],
      predecessor: {
        hypothesisId: current.hypothesisId,
        revision: current.revision,
        claims: current.claims.map((c) => ({ claimId: c.claimId, revision: c.revision, claimRevisionId: c.claimRevisionId })),
      },
      promptedByEvidence: [...experimentResult.evidenceIdsForRevision],
    } as HypothesisPhaseInput<TAudit, TRequest>);
    const next = readAccepted(revised);
    if (next === undefined) {
      if (revised.kind !== "stopped") raiseError(session);
      return done("stopped");
    }
    current = next;
    final = next.hypothesisId;
  }
  // unreachable: the last Iteration returns above
  raiseError(session);
  return done("stopped");
}
