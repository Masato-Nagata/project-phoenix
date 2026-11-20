// Terminator of the Loop_Orchestrator (task 4.4, unit U2; R12.5, R12.13, R12.14, R12.11, R11.15, R11.16).
//
// `terminate()` ends a Run. The order is fixed:
//   1. close ADMISSION of the writer (synchronous, the very first action, no `await` before it): an ordinary write accepted from now on is
//      refused with `admission_closed`,
//   2. DRAIN: wait until every job accepted before the closing has completed (a queued write may still be rejected for a secret meanwhile),
//   3. read the writer state once; if a write was rejected for a secret (`secretRejections > 0`) or refused as `invalid_record`
//      (`invalidRecords > 0`), raise `error` (U1 priority rules: a pending reason of higher priority is NOT overwritten, a lower pending one is
//      upgraded to `error`),
//   4. finalize the termination latch (the reason is frozen from here on; a later `raise` is ignored by the latch, U1),
//   5. re-read the state, in this order: the writer is `down` -> unsealed `store_failed`; a secret rejection -> unsealed `secret_rejected`; an
//      invalid ordinary write -> unsealed `internal_error` (a mandatory record is missing; a caller defect). In all three cases NOTHING is
//      written: no termination record, no manifest build, no seal, no wall clock read,
//   6. write the single `termination` record through the termination channel (`evidence_rejected` is mapped to `secret_rejected`),
//   7. read the wall clock ONCE (the end time of the Run), and let the manifest port build the Run_Manifest from the core,
//   8. seal through the channel (`evidence_rejected` is mapped to `secret_rejected`). `sealed: true` is produced in exactly one place: after
//      the store's seal succeeded.
// A secret rejection or an `invalid_record` of ANY ordinary write of the Run blocks a normal seal: a Run with a rejected or missing record is
// never sealed as a normal Run. The writer double-checks the secret case at the turn of the termination record and of the seal
// (`evidence_rejected`); it has NO gate for `invalid_record`: that refusal is made here, in `terminate()` (approved decision).
// What `sealed: true` guarantees: no ordinary write the writer accepted failed (not down, no secret rejection, no invalid_record); the
// termination record is in the chain; the Manifest is valid; the store's seal succeeded. It does NOT guarantee that callers issued every record
// they needed, nor that writes refused at accept time after admission closed (`admission_closed`) were not lost: the composition (U7) must call
// `terminate()` only after the in-flight callProvider and Runner calls have settled.
// Residual: a secret hit whose own rejection record fails validation reaches the writer as `invalid_record` (the writer reads no message), so the
// Run ends unsealed with `internal_error`, not `secret_rejected`.
// The record comes BEFORE the seal: the store computes `chain.records` and `chain.lastHash` at seal time, so the termination record is part of
// the sealed chain, and the Manifest never names a reason without its record. If the record cannot be written, nothing is sealed.
//
// Behaviour change (documented): a `session.raise(...)` made after `terminate()` was called but before the drain completed is still accepted,
// because the latch is finalized only at step 4. A raise after step 4 is ignored (U1 rule).
//
// Authority: this module receives the TerminationChannel (the only object that can close admission, write the termination record and seal).
// The public RecordWriter given to the phases has none of these.
//
// Interplay with the callers (U3, U5, U6): the `error` and `isolation_violation` DETAIL records (the cause of a termination) are written by the
// callers BEFORE they call `terminate()`. This module writes only the one `termination` record, with the payload `{ terminationReason }`
// (the U2 choice: the same key as the Manifest field; the payload schema of `termination` is a free object, and nothing else goes in: no
// message, no path, no text of a provider). A cause raised after the latch was finalized is ignored (U1 rule).
//
// Fallback (a defect, documented): if the Run reaches its end with NO cause in the latch (`finalize()` answers `no_cause`), no reason is
// invented from nothing; the safe side `error` is raised, and the latch is finalized again. Together with the raise of step 3 these are the
// only `raise` calls of this module.
//
// `terminate()` is idempotent and memoized: the first call starts the work, every later or concurrent call returns the SAME promise. There is
// no second termination record and no second seal. The promise never rejects. An unsealed result carries a closed failure code only, the
// finalized reason when there is one, and no `manifestSha256`; it never looks like a success. The hash of a sealed result is the one the store
// returned; this module never computes or changes a hash. It does not abort, call a provider or a runner, use a timer, or read the monotonic clock.
import type { TerminationChannel, WriterErrorCode } from "./recordWriter.js";
import type { RunSession } from "./session.js";
import type { ManifestCore, ManifestPort, RunResult, TerminationReason, UnsealedFailure, WallClockPort } from "./types.js";

/** Every ManifestCore field the orchestrator already knows at the end of a Run. Derived from U0, so that `ManifestCore` stays the single source. */
export type TerminationBase = Omit<ManifestCore, "runId" | "terminationReason" | "limitsUsed" | "wallClock">;

export interface TerminatorInput {
  readonly session: RunSession;
  /** The termination capability of the writer. Never the public writer. */
  readonly channel: TerminationChannel;
  readonly wallClock: WallClockPort;
  readonly manifest: ManifestPort;
  readonly runId: string;
  readonly base: TerminationBase;
  /** The wall time captured at the start of the Run (U4/U7). */
  readonly startedAt: string;
}

export interface Terminator {
  terminate(): Promise<RunResult>;
}

type SealInput = Parameters<TerminationChannel["seal"]>[0];

const WRITER_COMPONENT = "orchestrator";

const unsealed = (session: RunSession, failure: UnsealedFailure, reason: TerminationReason | undefined): RunResult =>
  Object.freeze(
    reason === undefined
      ? { sealed: false as const, started: session.started, failure }
      : { sealed: false as const, started: session.started, terminationReason: reason, failure },
  );

const isDownCode = (code: WriterErrorCode): boolean => code === "writer_down" || code === "store_failed" || code === "io_failure";
const isSecretCode = (code: WriterErrorCode): boolean => code === "secret_rejected" || code === "evidence_rejected";

// Failure of the `termination` record: the store is gone, a secret hit (now or earlier), or a defect of this module (anything else).
const mapRecordFailure = (code: WriterErrorCode): UnsealedFailure => (isDownCode(code) ? "store_failed" : isSecretCode(code) ? "secret_rejected" : "internal_error");

// Failure of the seal: a secret in the Manifest or an earlier rejected write, a Manifest that is not schema-valid, the store is gone, or any other refusal.
const mapSealFailure = (code: WriterErrorCode): UnsealedFailure =>
  isSecretCode(code) ? "secret_rejected" : code === "invalid_record" ? "manifest_build_failed" : isDownCode(code) ? "store_failed" : "seal_failed";

const isPlainObject = (v: unknown): boolean => {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

async function finish(input: TerminatorInput): Promise<RunResult> {
  const { session, channel } = input;
  let reason: TerminationReason | undefined;
  try {
    channel.closeAdmission(); // the first statement runs synchronously inside `terminate()`
    await channel.drain();
    const before = channel.state();
    if (before.secretRejections > 0 || before.invalidRecords > 0) session.raise("error"); // a rejected or invalid write: `error`, unless a higher cause is pending
    let fin = session.finalize();
    if (!fin.ok) {
      session.raise("error"); // defect fallback: a Run that ends without any cause ends with `error`
      fin = session.finalize();
    }
    if (!fin.ok) return unsealed(session, "internal_error", undefined);
    reason = fin.value.reason;

    const after = channel.state();
    if (after.down) return unsealed(session, "store_failed", reason); // nothing is written, nothing is built
    if (after.secretRejections > 0) return unsealed(session, "secret_rejected", reason); // a record is missing: never a normal seal
    if (after.invalidRecords > 0) return unsealed(session, "internal_error", reason); // a mandatory record is missing (a caller defect): never a normal seal

    const written = await channel.appendTermination({ terminationReason: reason }, WRITER_COMPONENT);
    if (!written.ok) return unsealed(session, mapRecordFailure(written.error.code), reason);

    const finishedAt = input.wallClock.nowIso();
    const core: ManifestCore = {
      ...input.base,
      runId: input.runId,
      terminationReason: reason,
      limitsUsed: session.limitsUsed(),
      wallClock: { startedAt: input.startedAt, finishedAt },
    };
    let built: unknown;
    try {
      const produced: unknown = input.manifest.build(core);
      built = await produced; // a port that returns a promise is awaited; a throw or a rejection ends here
    } catch {
      return unsealed(session, "manifest_build_failed", reason);
    }
    if (!isPlainObject(built)) return unsealed(session, "manifest_build_failed", reason);

    const sealed = await channel.seal(built as SealInput);
    if (!sealed.ok) return unsealed(session, mapSealFailure(sealed.error.code), reason);
    return { sealed: true, summary: Object.freeze({ runId: input.runId, terminationReason: reason, manifestSha256: sealed.value.sha256 }) };
  } catch {
    return unsealed(session, "internal_error", reason);
  }
}

export function createTerminator(input: TerminatorInput): Terminator {
  let memo: Promise<RunResult> | undefined;
  return Object.freeze({
    terminate(): Promise<RunResult> {
      memo ??= finish(input);
      return memo;
    },
  });
}
