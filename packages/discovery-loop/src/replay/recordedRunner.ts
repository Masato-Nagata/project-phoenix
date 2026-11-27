// The recorded Experiment_Runner of a replay (task 4.7, step A2; R22.4; human decisions D1 and D5 of 2026-11-27).
//
// It does NOT contact the Legacy_App: it has no HTTP port, no lease, no clock (pinned by the static test). For every `execute` call it takes the
// NEXT recorded execution (an accepted `policy_decision` of the original Run, in order) and checks, before it answers:
//   1. the Experiment id equals the recorded one;
//   2. the canonical JSON of the normalized Experiment it received equals the recorded one (the AI Experiment without `localKey`, plus
//      `experimentId`: the existing normalization of the experiment phase, the only transformation that is allowed);
//   3. the decision record id equals the recorded `policy_decision` id;
//   4. the acceptance check of the verifier, over the REGENERATED records (the injected `isAccepted`, the same check the real Runner runs):
//      the regenerated decision exists, is unique, accepts, and its three hashes equal the identity computed now;
//   5. the original Run wrote an Observation for it.
// Only then it answers the Runner value RESTORED from the recorded Observation (`restoreRunnerValue`, a fresh deep copy). Any mismatch is noted
// in the divergence cell and answered as a fatal `interrupted` outcome, which makes the experiment phase write an `error` record and stop the
// replay. A policy rejection never reaches this Runner (the experiment phase does not call it then); a call that the original did not make
// is a mismatch.
import { canonicalJson } from "../canonical/index.js";
import type { Json } from "../schema/index.js";
import type { RecordedExecution } from "./replayInputs.js";
import type { DivergenceCell } from "./replaySupport.js";

export type AcceptanceVerdictView = { readonly accepted: true } | { readonly accepted: false; readonly code: string };
export interface RecordedRunner {
  /** The only Runner method the experiment phase calls. There is no `health` and no `measureStartState`: a replay measures nothing. */
  execute(e: unknown, decisionRecordId: string, signal: AbortSignal, options?: { readonly notAfterMs?: number }): Promise<unknown>;
  /** Recorded executions not yet answered. */
  unconsumed(): number;
  calls(): number;
}

const deepCopy = (v: unknown): Json => JSON.parse(JSON.stringify(v)) as Json;

export function createRecordedRunner(options: {
  readonly recorded: readonly RecordedExecution[];
  readonly isAccepted: (experimentId: string, decisionRecordId: string, e: unknown) => AcceptanceVerdictView;
  readonly cell: DivergenceCell;
}): RecordedRunner {
  const { isAccepted, cell } = options;
  const recorded = [...options.recorded];
  let cursor = 0;
  let calls = 0;

  const refuse = (experimentId: string, code: Parameters<DivergenceCell["noteRunner"]>[0], recordId?: string): unknown => {
    cell.noteRunner(code, recordId);
    return Object.freeze({
      status: "interrupted" as const,
      cause: "fatal_error" as const,
      experimentId,
      phase: "not_started" as const,
      sentRequests: 0,
      collectedResponses: 0,
      collectedStateChecks: 0,
      fatal: true as const,
    });
  };

  const execute = async (e: unknown, decisionRecordId: string): Promise<unknown> => {
    calls += 1;
    const experimentId = typeof e === "object" && e !== null && typeof (e as { experimentId?: unknown }).experimentId === "string" ? (e as { experimentId: string }).experimentId : "";
    const next = recorded[cursor];
    if (next === undefined) return refuse(experimentId, "runner_unexpected_call");
    cursor += 1;
    let received: string;
    try {
      received = canonicalJson(deepCopy(e));
    } catch {
      return refuse(experimentId, "runner_experiment_mismatch", next.decisionRecordId);
    }
    if (experimentId !== next.experimentId || received !== next.normalizedCanonical) return refuse(experimentId, "runner_experiment_mismatch", next.decisionRecordId);
    if (decisionRecordId !== next.decisionRecordId) return refuse(experimentId, "runner_decision_mismatch", next.decisionRecordId);
    let verdict: AcceptanceVerdictView;
    try {
      verdict = isAccepted(experimentId, decisionRecordId, e);
    } catch {
      verdict = { accepted: false, code: "check_failed" };
    }
    if (verdict.accepted !== true) return refuse(experimentId, "runner_not_accepted", next.decisionRecordId);
    const value = next.value;
    if (value === undefined) return refuse(experimentId, "runner_observation_missing", next.decisionRecordId);
    return deepCopy(value);
  };

  return Object.freeze({
    execute,
    unconsumed: (): number => recorded.length - cursor,
    calls: (): number => calls,
  });
}
