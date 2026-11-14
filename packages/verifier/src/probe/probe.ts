// The probe of task 2.20 (OD-12, decided 2026-11-12: option (a), a toolchain-image probe started by the Launcher).
//
// The probe is NOT a Run. It executes the neutral accepted Experiments of `data/probe-experiments.json` through the real Runner, with a
// reset beforehand, and checks that every Experiment that the policy rejects is refused without a request. It writes one result file and
// no Run_Manifest. Its result is evidence for R9.1, R9.2, R9.7, R9.12, R18.2, R18.3, R24.4, and R24.9 only, never for an M4 isolation
// requirement (task 2.20, "What this task proves, and what it does not"). The result holds statuses and counts, no response body, so no
// business value of the Legacy_App is written (task 2.20: "log no business-rule values").
import { createAcceptanceCheck, evaluateForRecord, type RecordView } from "../identity/acceptance.js";
import { checkLeaseTiming, type LeaseSettings } from "../lease/timing.js";
import type { LeasePort } from "../lease/types.js";
import { loadPolicyConfig } from "../policy/config.js";
import type { Experiment } from "../policy/types.js";
import { loadPreparationTable } from "../prep/table.js";
import { DEFAULT_ADDRESS_POLICY } from "../runner/address.js";
import { RunnerStartRefused, createRunner } from "../runner/runner.js";
import type { ExecutionOutcome, HttpPort, HttpRequest, HttpResponse, RunnerLimits } from "../runner/types.js";
import type { MonotonicClock } from "../lease/types.js";
import type { MaskConfig } from "../compare/types.js";

export const PROBE_STATEMENT =
  "Probe of task 2.20, not a Run: no Run_Manifest, no Evidence_Store records, and no evidence for any M4 isolation requirement (R15.2, R15.3, R15.12 to R15.16, R18.13, R18.14, R18.26, R24.7).";

export interface ProbeConfig {
  readonly schemaVersion: 1;
  readonly baseAddress: string;
  readonly limits: RunnerLimits;
  readonly lease: LeaseSettings;
}

export interface ProbeExperiments {
  readonly accepted: readonly Experiment[];
  readonly rejected: readonly { readonly rule: string; readonly experiment: Experiment }[];
}

export interface ProbeInputs {
  readonly runId: string;
  readonly propagationDelayMs: number | undefined;
  readonly config: unknown;
  readonly policy: unknown;
  readonly table: unknown;
  readonly mask: unknown;
  readonly experiments: unknown;
}

export interface ProbePorts {
  readonly http: HttpPort;
  /** Built from the validated timing; the real one reads `/run/lease/`. */
  lease(timing: ReturnType<typeof checkLeaseTiming> & { ok: true }): LeasePort;
  readonly clock: MonotonicClock;
}

export interface ProbeExperimentResult {
  readonly experimentId: string;
  readonly expected: "accept" | "reject";
  readonly decision: "accept" | "reject";
  readonly ruleIds: readonly string[];
  readonly outcome: string;
  readonly reason?: string;
  readonly responses: number;
  readonly stateChecks: number;
  readonly requestsSent: number;
  readonly expectationMet: boolean;
}

export interface ProbeResult {
  readonly kind: "probe-result";
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly statement: string;
  readonly ok: boolean;
  /** Why the probe stopped early, if it did. */
  readonly stoppedAt?: string;
  readonly health?: string;
  readonly experiments: readonly ProbeExperimentResult[];
  readonly totalRequests: number;
}

/** Counts what is handed to the transport, by Experiment. */
class CountingHttp implements HttpPort {
  count = 0;
  constructor(private readonly inner: HttpPort) {}
  send(req: HttpRequest, timeoutMs: number, signal: AbortSignal): Promise<HttpResponse> {
    this.count += 1;
    return this.inner.send(req, timeoutMs, signal);
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function validConfig(raw: unknown): ProbeConfig | undefined {
  if (!isObj(raw) || raw["schemaVersion"] !== 1 || typeof raw["baseAddress"] !== "string") return undefined;
  const limits = raw["limits"];
  const lease = raw["lease"];
  if (!isObj(limits) || !isObj(lease)) return undefined;
  return raw as unknown as ProbeConfig;
}

function validExperiments(raw: unknown): ProbeExperiments | undefined {
  if (!isObj(raw) || !Array.isArray(raw["accepted"]) || !Array.isArray(raw["rejected"])) return undefined;
  return raw as unknown as ProbeExperiments;
}

/** Runs the probe. Never throws; every early stop is in the result. The exit code: 0 all expectations met, 1 an expectation failed, 2 refused before any request. */
export async function runProbe(inputs: ProbeInputs, ports: ProbePorts): Promise<{ result: ProbeResult; exitCode: number }> {
  const results: ProbeExperimentResult[] = [];
  const counting = new CountingHttp(ports.http);
  const done = (ok: boolean, exitCode: number, extra: Partial<ProbeResult> = {}): { result: ProbeResult; exitCode: number } => ({
    result: { kind: "probe-result", schemaVersion: 1, runId: inputs.runId, statement: PROBE_STATEMENT, ok, experiments: results, totalRequests: counting.count, ...extra },
    exitCode,
  });
  try {
    const config = validConfig(inputs.config);
    const experiments = validExperiments(inputs.experiments);
    if (config === undefined || experiments === undefined) return done(false, 2, { stoppedAt: "probe_data_invalid" });
    const timing = checkLeaseTiming(config.lease, inputs.propagationDelayMs);
    if (!timing.ok) return done(false, 2, { stoppedAt: `lease_timing_invalid:${timing.error.join(",")}` });
    const table = loadPreparationTable(inputs.table);
    if (!table.ok) return done(false, 2, { stoppedAt: "preparation_table_invalid" });
    const policy = loadPolicyConfig(inputs.policy, table.value);
    if (!policy.ok) return done(false, 2, { stoppedAt: "policy_config_invalid" });

    const records: RecordView[] = [];
    let runner;
    try {
      runner = createRunner({
        http: counting,
        lease: ports.lease(timing),
        prepTable: table.value,
        policy: policy.value,
        mask: inputs.mask as MaskConfig,
        baseAddress: config.baseAddress,
        addressPolicy: DEFAULT_ADDRESS_POLICY,
        limits: config.limits,
        clock: ports.clock,
        isAccepted: createAcceptanceCheck(() => records),
      });
    } catch (error) {
      return done(false, 2, { stoppedAt: error instanceof RunnerStartRefused ? `runner_start_refused:${error.refusals.map((r) => r.code).join(",")}` : "runner_start_failed" });
    }

    const health = await runner.health();
    if (!health.ok) return done(false, counting.count === 0 ? 2 : 1, { stoppedAt: "health", health: health.error });

    const all: { expected: "accept" | "reject"; experiment: Experiment }[] = [
      ...experiments.accepted.map((e) => ({ expected: "accept" as const, experiment: e })),
      ...experiments.rejected.map((r) => ({ expected: "reject" as const, experiment: r.experiment })),
    ];
    let ok = true;
    for (const [i, item] of all.entries()) {
      const payload = evaluateForRecord(item.experiment, policy.value);
      const id = `rec-${String(i + 1).padStart(6, "0")}`;
      records.push({ id, kind: "policy_decision", payload });
      const before = counting.count;
      const outcome: ExecutionOutcome = await runner.execute(item.experiment, id, new AbortController().signal);
      const sent = counting.count - before;
      const status = outcome.status;
      const responses = "observation" in outcome ? outcome.observation.responses.length : 0;
      const stateChecks = "observation" in outcome ? outcome.observation.stateChecks.length : 0;
      const reason = outcome.status === "not_executed" || outcome.status === "aborted" ? outcome.reason : outcome.status === "interrupted" ? outcome.cause : undefined;
      const met =
        item.expected === "accept"
          ? payload.decision === "accept" && status === "executed"
          : payload.decision === "reject" && status === "not_executed" && reason === "policy_not_accepted" && sent === 0;
      if (!met) ok = false;
      results.push({
        experimentId: item.experiment.experimentId, expected: item.expected, decision: payload.decision, ruleIds: payload.ruleIds,
        outcome: status, ...(reason !== undefined ? { reason } : {}), responses, stateChecks, requestsSent: sent, expectationMet: met,
      });
      // A lease that became invalid, a forced stop, or a fatal error ends the probe: nothing more is sent.
      if (status === "interrupted" || (status === "not_executed" && (outcome.reason === "lease_unavailable" || outcome.reason === "runner_internal_error")) || (status === "aborted")) {
        return done(false, 1, { stoppedAt: `experiment:${item.experiment.experimentId}:${reason ?? status}` });
      }
    }
    return done(ok, ok ? 0 : 1);
  } catch {
    return done(false, 1, { stoppedAt: "internal_error" });
  }
}