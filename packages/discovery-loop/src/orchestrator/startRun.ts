// Start sequence of a Run, after the start gate (task 4.4, unit U4; R11.12, R11.17, R12.14, R15.12, R15.14, R24.9, R24.15).
//
// ORDER (fixed; after a refusal every later step is skipped):
//    1. the RunSession: its one reading of the monotonic clock STARTS the Run time limit, so the deadline includes everything below
//       (store open, Runner creation, lease re-check, `run_started`, `isolation_checks`, `health`). Stage A, stage B and the start gate run
//       before and are bounded by their own limits; the cap at the Launcher level is a task 4.9 item;
//    2. open the Run store (an EXISTING EMPTY Run_Volume; opening creates nothing);
//    3. the RecordWriter: the public `writer` for the phases, and the termination capability for the Terminator only;
//    4. the Runner, with the SAME lease instance that stage B proved and an acceptance check over the committed records of the writer. The check
//       FAILS CLOSED: if the records cannot be read, `error` is latched and the check throws (the Runner then stops fatally, R12.14, R24.15);
//    5. a deadline checkpoint;
//    6. the lease re-check on that same instance with the deadline and the signal of the session (the running rule, not a second proof);
//    7. the deadline timer;
//    8. the wall time of the start, read once (for the Run_Manifest only);
//    9. a last check that no cause was latched meanwhile (no `await` lies between this check and the write of step 10);
//   10. the record `run_started` (payload `{}`: the specs back no content for it; the provider identity is recorded per AI call and in the
//       Run_Manifest, R3.7, and runId and wall time are excluded fields of R22, so they never go into a record);
//   11. `markStarted`;
//   12. the record `isolation_checks`, whose ONLY source is the access-denial result of the start gate (status and the six checks; R15.12);
//   13. a deadline checkpoint; 14. `runner.health()` (not interruptible by the session signal: the Runner bounds it with 10 s); then a
//       checkpoint again (a timer that fired during `health` is seen here).
//
// REFUSAL OR START. Before `run_started` is confirmed, the answer is a REFUSAL: an unsealed result with `started: false`; nothing is terminated,
// sealed or written afterwards. What a refusal code says about the Run_Volume:
//   - `store_open_failed`, `runner_start_refused`, `lease_invalid_at_start`, `internal_error`: the orchestrator attempted no write (an
//     `invalid_record` answer of the store wrote nothing either);
//   - `store_failed`, `secret_rejected` (only from the `run_started` write): a write WAS attempted. The Run_Volume may hold a partial record
//     (for example a renamed record file whose directory sync failed) or the store's own rejection record. It is NOT known to be empty.
//   `started: false` therefore means "run_started is not confirmed written", never "the volume is empty".
// After `run_started`, the answer is a START. `proceed: false` means a cause is latched (or the writer is down): the caller (unit U7) runs no
// phase and goes straight to `terminate()`. Nothing about a failed `health` is recorded in U4 (no text of it, no `error` detail record).
//
// HAND-OVER (unit U7). `run` goes to the phases; `terminationChannel` goes ONLY to `createTerminator`; `PhaseRun` holds no reference to it.
// The deadline timer stays armed: it must be cancelled (`cancelDeadlineTimer`) BEFORE `terminate()`. The only cleanup that exists is that
// cancel: the store, the Runner and the writer have no close operation, and none is invented here. `session.signal` is aborted only by a
// `raise` of an aborting reason (U1); a refusal before the first write leaves it as it is.
import type { StartupApproval } from "../config/startup.js";
import type { Json } from "../schema/types.js";
import { armDeadlineTimer, deadlineCheckpoint, type DeadlineTimer } from "./deadline.js";
import { createRecordWriter, type RecordWriter, type TerminationChannel, type WriterErrorCode, type WriterRecordView } from "./recordWriter.js";
import { createRunSession, type RunSession } from "./session.js";
import type { ExperimentRunnerPort, LoopDeps, RunResult, StartGateSuccess, UnsealedFailure } from "./types.js";

/** What the phases receive. It carries no termination capability. */
export interface PhaseRun {
  readonly session: RunSession;
  readonly writer: RecordWriter;
  readonly runner: ExperimentRunnerPort;
  /** The wall time read once at the start, for the Run_Manifest `wallClock.startedAt` only. */
  readonly startedAt: string;
  /** false: a cause is latched or the writer is down; run no phase, go to `terminate()`. */
  readonly proceed: boolean;
  /** Idempotent. Must be called before `terminate()`. */
  cancelDeadlineTimer(): void;
}

export type StartRunResult =
  | { readonly kind: "refused"; readonly result: RunResult }
  | { readonly kind: "started"; readonly run: PhaseRun; readonly terminationChannel: TerminationChannel };

const refused = (failure: UnsealedFailure): StartRunResult =>
  Object.freeze({ kind: "refused" as const, result: Object.freeze({ sealed: false as const, started: false, failure }) });

/** The failure of the `run_started` write. `store_failed` and `secret_rejected` mean that a write was attempted (see the header). */
export function mapRunStartedFailure(code: WriterErrorCode): UnsealedFailure {
  if (code === "writer_down" || code === "io_failure" || code === "store_failed") return "store_failed";
  if (code === "secret_rejected" || code === "evidence_rejected") return "secret_rejected";
  return "internal_error";
}

/** Fixed text of the failure of the acceptance check: no store message, path or secret is ever copied into it. */
const RECORDS_UNAVAILABLE_MESSAGE = "run records unavailable";

/**
 * The records the acceptance check reads, FAIL CLOSED (task 4.4 unit U4; R12.14, R24.15). If the writer cannot read its records, an empty list
 * must never be taken for "no decision recorded": the session latches `error` (which aborts its signal) FIRST, and then the check throws a
 * fixed-text error. The Runner turns a throw of `isAccepted` into `runner_internal_error` with `fatal: true` and executes nothing more.
 */
function committedRecordsOrStop(writer: RecordWriter, session: RunSession): readonly WriterRecordView[] {
  const r = writer.records();
  if (r.ok) return r.value;
  session.raise("error");
  throw new Error(RECORDS_UNAVAILABLE_MESSAGE);
}

type LeaseAnswer = "valid" | "invalid" | "failed";

/** One `check` on the given lease instance, with the deadline and the signal of the session. A throw, a rejection or an odd shape is `failed`. */
async function recheckLease(port: unknown, session: RunSession): Promise<LeaseAnswer> {
  try {
    if (typeof port !== "object" || port === null) return "failed";
    const check = (port as { check?: unknown }).check;
    if (typeof check !== "function") return "failed";
    const state: unknown = await (check as (o: unknown) => unknown).call(port, { deadlineAtMs: session.deadlineAtMs, signal: session.signal });
    if (typeof state !== "object" || state === null) return "failed";
    const valid = (state as { valid?: unknown }).valid;
    return valid === true ? "valid" : valid === false ? "invalid" : "failed";
  } catch {
    return "failed"; // `LeaseCheckInterrupted` (deadline or abort) and any other failure: the message is dropped
  }
}

const isRunner = (r: unknown): r is ExperimentRunnerPort =>
  typeof r === "object" && r !== null && typeof (r as { health?: unknown }).health === "function" && typeof (r as { execute?: unknown }).execute === "function";

/** A plain JSON copy (the branded, frozen result objects themselves never go into a record). */
function jsonCopy(v: unknown, depth = 0): Json {
  if (depth > 64) throw new Error("too deep");
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return v.map((x) => jsonCopy(x, depth + 1));
  if (typeof v === "object") {
    const out: { [k: string]: Json } = {};
    for (const k of Object.keys(v)) out[k] = jsonCopy((v as Record<string, unknown>)[k], depth + 1);
    return out;
  }
  throw new Error("not JSON");
}

/** The payload of `isolation_checks`: status and the six checks of the access-denial result, nothing else. */
function isolationChecksPayload(gate: StartGateSuccess): { [k: string]: Json } {
  return {
    status: gate.accessDenial.status,
    checks: gate.accessDenial.checks.map((c) => ({ id: c.id, status: c.status, measuredBy: c.measuredBy, measured: jsonCopy(c.measured) })),
  };
}

export async function startRun<TLease, TAudit, TPolicy, TTable, TRequest>(
  deps: LoopDeps<TLease, TAudit, TPolicy, TTable, TRequest>,
  startup: StartupApproval<TPolicy, TTable, TAudit, TLease>,
  gate: StartGateSuccess,
): Promise<StartRunResult> {
  let timer: DeadlineTimer | undefined;
  const cancelTimer = (): void => {
    try {
      timer?.cancel();
    } catch {
      // cancel never throws; nothing more to do
    }
  };
  try {
    if (typeof gate.runId !== "string" || gate.runId === "" || gate.runId !== startup.lease.runId) return refused("internal_error");

    // 1. The Run time limit starts here.
    const made = createRunSession({ clock: deps.clock, runSeconds: startup.config.limits.runSeconds });
    if (!made.ok) return refused("internal_error");
    const session = made.value;

    // 2.
    let opened: Awaited<ReturnType<LoopDeps["storeFactory"]["open"]>>;
    try {
      opened = await deps.storeFactory.open(deps.fs, deps.runVolumeDir);
    } catch {
      return refused("store_open_failed");
    }
    if (typeof opened !== "object" || opened === null || opened.ok !== true) return refused("store_open_failed");

    // 3.
    const { writer, channel } = createRecordWriter(opened.value);

    // 4. The SAME lease instance; the acceptance check reads the committed records through the writer.
    let runner: unknown;
    try {
      const limits = startup.config.limits;
      runner = deps.runnerFactory({
        lease: startup.lease.port,
        policy: startup.policy.value,
        table: startup.policy.table,
        mask: startup.config.mask,
        baseAddress: startup.config.testApi.baseAddress,
        limits: { requestTimeoutMs: limits.perRequestSeconds * 1000, experimentTimeoutMs: limits.perExperimentSeconds * 1000 },
        isAccepted: deps.policy.createAcceptanceCheck(() => committedRecordsOrStop(writer, session)),
      });
    } catch {
      return refused("runner_start_refused");
    }
    if (!isRunner(runner)) return refused("runner_start_refused");
    const phaseRunner: ExperimentRunnerPort = runner;

    // 5.
    if (deadlineCheckpoint(session) === "stop") return refused("internal_error");

    // 6.
    const lease = await recheckLease(startup.lease.port, session);
    if (lease === "invalid") return refused("lease_invalid_at_start");
    if (lease !== "valid") return refused("internal_error");

    // 7.
    const armed = armDeadlineTimer(session, deps.timers);
    if (!armed.ok) return refused("internal_error");
    const deadlineTimer: DeadlineTimer = armed.value;
    timer = deadlineTimer;

    // 8.
    let startedAt: unknown;
    try {
      startedAt = deps.wallClock.nowIso();
    } catch {
      startedAt = undefined;
    }
    if (typeof startedAt !== "string" || startedAt === "") {
      cancelTimer();
      return refused("internal_error");
    }
    const startedAtIso: string = startedAt;

    // 9. and 10. No `await` between the check and the start of the write: a timer cannot fire in between.
    if (session.terminationStatus().state !== "none") {
      cancelTimer();
      return refused("internal_error");
    }
    const runStarted = await writer.append("run_started", {}, "orchestrator");
    if (!runStarted.ok) {
      cancelTimer();
      return refused(mapRunStartedFailure(runStarted.error.code));
    }

    // 11.
    session.markStarted();
    let proceed = true;

    // 12. Written also when a cause was latched meanwhile (a started Run carries its isolation checks), unless the writer is down.
    if (!writer.state().down) {
      let isolation: Awaited<ReturnType<RecordWriter["append"]>>;
      try {
        isolation = await writer.append("isolation_checks", isolationChecksPayload(gate), "orchestrator");
      } catch {
        isolation = { ok: false, error: { code: "invalid_record" } };
      }
      if (!isolation.ok) {
        session.raise("error");
        proceed = false;
      }
    } else {
      session.raise("error");
      proceed = false;
    }

    // 13. and 14.
    if (proceed && deadlineCheckpoint(session) === "stop") proceed = false;
    if (proceed) {
      let healthy = false;
      try {
        const h: unknown = await phaseRunner.health();
        healthy = typeof h === "object" && h !== null && (h as { ok?: unknown }).ok === true;
      } catch {
        healthy = false;
      }
      if (!healthy) {
        session.raise("error");
        proceed = false;
      }
      if (deadlineCheckpoint(session) === "stop") proceed = false;
    }
    if (writer.state().down) proceed = false;

    // 15.
    const run: PhaseRun = Object.freeze({
      session,
      writer,
      runner: phaseRunner,
      startedAt: startedAtIso,
      proceed,
      cancelDeadlineTimer: (): void => deadlineTimer.cancel(),
    });
    return Object.freeze({ kind: "started" as const, run, terminationChannel: channel });
  } catch {
    cancelTimer();
    return refused("internal_error");
  }
}
