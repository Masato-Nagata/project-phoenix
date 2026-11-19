// RecordWriter of the Loop_Orchestrator (task 4.4, unit U2; R12.5, R12.13, R12.14, R12.11, R11.15, R11.16).
//
// One writer wraps ONE `RunRecordStore`. It adds no schema and no behaviour to the store. It adds these things:
//   1. ORDER. Every operation goes through one internal promise chain, so the store sees the calls in the order they were made, also when the
//      caller does not await. Each queued operation checks the writer state when ITS turn comes, not when it was queued.
//   2. A FAILURE LATCH (R12.14). After the store reports `io_failure` or `store_failed`, or throws, or rejects, the writer is `down` for good:
//      every later operation answers `writer_down` and the store is NOT called again. There is no retry, and a failure never becomes a success.
//   3. The termination rules: at most one `termination` record, nothing but `seal` after it, and `seal` only after it (a sealed Manifest names a
//      termination reason, so the record that carries the reason must exist first; the store computes `chain` at seal time, so the termination
//      record is part of the chain).
//   4. AN ADMISSION GATE. Ordinary writes (`append`, `putBlob`, `putAiOutput`) are admitted while admission is open. `closeAdmission()` is
//      synchronous and permanent. The check happens at ACCEPT time, inside the call and before the job is queued: a write accepted after the
//      closing answers `admission_closed` (or `closed_after_termination` when the termination record was already written) at once, without a
//      store call, without queuing, and without counting anything. Jobs accepted BEFORE the closing are not cancelled; they still run in order.
//   5. A DRAIN. `drain()` resolves when every job accepted up to the moment of the call has completed. It never rejects, never calls the store
//      and hides nothing: the caller reads `state()` afterwards.
//   6. QUEUE-TIME GATES. A secret rejection of ANY write (also one that completed after `terminate()` started) blocks a normal seal: the internal
//      termination append and the internal seal check `secretRejections > 0` at THEIR turn (after every earlier job has completed) and then
//      answer `evidence_rejected` without a store call.
//
// CAPABILITY SEPARATION. `createRecordWriter(store)` returns TWO frozen objects that share one private closure and nothing else:
//   `writer`   the public RecordWriter: `append` (never kind `termination`: that is `termination_reserved`), `putBlob`, `putAiOutput`, `drain`,
//              `state`, and (unit U4) the read-only snapshot `records`. It has no `seal`, no way to write the termination record and no way to
//              close admission.
//   `channel`  the TerminationChannel: `closeAdmission`, `drain`, `state`, `appendTermination`, `seal`.
// There is no exported function, registry, map, symbol or property that leads from `writer` to `channel`; only the store reference inside the
// closure writes. COMPOSITION RULE (unit U7): hand `writer` to the phases and callers, and hand `channel` ONLY to `createTerminator`.
//
// Results carry a CLOSED code only. A message of the store, the pattern id of a secret hit (which may be `env:NAME`), a path, a payload byte, a
// component name or a provider text is never copied into a result or into the state (R12.13, R19.7).
// A `secret_rejected` answer means the store wrote its own rejection record and stays healthy: the writer counts it and goes on.
// An `invalid_record` answer is a defect of the caller: nothing was written, the writer stays up.
//
// Store types are derived by indexing the real class (`ReturnType`, `Parameters`), so the store stays the single source.
import type { Result } from "../schema/types.js";
import type { RunRecordStore } from "../store/runRecordStore.js";

type StoreResultOf<K extends "append" | "putBlob" | "putAiOutput" | "seal"> = Awaited<ReturnType<RunRecordStore[K]>>;
type OkOf<R> = Extract<R, { ok: true; value: unknown }>["value"];
type StoreRecordKind = Parameters<RunRecordStore["append"]>[0];
type StoreJsonObject = Parameters<RunRecordStore["append"]>[1];
type AppendOk = OkOf<StoreResultOf<"append">>;
type BlobOk = OkOf<StoreResultOf<"putBlob">>;
type AiOutputOk = OkOf<StoreResultOf<"putAiOutput">>;
type SealOk = OkOf<StoreResultOf<"seal">>;
type StoreEnvelope = ReturnType<RunRecordStore["list"]>[number];

/**
 * A COMMITTED record as the phases may read it (task 4.4 unit U4): its id, its kind and its payload, nothing else (no sequence number, no
 * hashes, no store object). It is structurally assignable to the verifier `RecordView` (`{ id, kind, payload }`) that `createAcceptanceCheck`
 * reads. Every level is frozen.
 */
export interface WriterRecordView {
  readonly id: string;
  readonly kind: string;
  readonly payload: StoreEnvelope["payload"];
}

/** Closed list of the writer answers (the store's own messages are never passed on). */
export const WRITER_ERROR_CODES = Object.freeze([
  "invalid_record",
  "secret_rejected",
  "io_failure",
  "store_failed",
  "writer_down",
  "duplicate_termination",
  "closed_after_termination",
  "termination_missing",
  "already_sealed",
  "evidence_rejected",
  "admission_closed",
  "termination_reserved",
] as const);
export type WriterErrorCode = (typeof WRITER_ERROR_CODES)[number];

export type WriterResult<T> = Result<T, { readonly code: WriterErrorCode }>;

export interface WriterState {
  /** true after the first `io_failure`, `store_failed`, thrown exception or rejected promise of the store. Never reset. */
  readonly down: boolean;
  /** true after a successful `seal`. */
  readonly sealed: boolean;
  /** true after a `termination` record was written successfully. A failed write does not count. */
  readonly terminationWritten: boolean;
  /** How many writes the store rejected because of a secret hit. */
  readonly secretRejections: number;
  /** The FIRST failure that took the writer down. Absent while the writer is up. */
  readonly failure?: "io_failure" | "store_failed";
}

/** The public writer: for the phases and callers. It cannot seal, cannot write the termination record and cannot close admission. */
export interface RecordWriter {
  /** A `termination` kind is always `termination_reserved` (no store call). */
  append(kind: StoreRecordKind, payload: StoreJsonObject, component?: string): Promise<WriterResult<AppendOk>>;
  putBlob(data: Uint8Array, component?: string): Promise<WriterResult<BlobOk>>;
  putAiOutput(data: Uint8Array, component?: string): Promise<WriterResult<AiOutputOk>>;
  /** Resolves when every job accepted before this call has completed. Never rejects, never calls the store. */
  drain(): Promise<void>;
  state(): WriterState;
  /**
   * A deeply frozen snapshot of the records the store has COMMITTED, oldest first (unit U4; R12.14, R24.15). Synchronous: it does not wait for
   * the queue, so a job that is still pending, or that failed, is not visible. A caller that relies on a record must `await` its `append` and
   * check `ok` first. It never throws. The answer is a frozen `Result`: `{ ok: true, value }` with the snapshot, or, if the store cannot be read
   * (or the snapshot cannot be frozen), `{ ok: false, error: { code: "records_unavailable" } }`; in that case the writer also goes `down` with
   * failure `store_failed` (the first failure is kept). A failure is never an empty array, so an empty `value` always means "no committed
   * record". It stays readable after `down` and after the admission was closed.
   */
  records(): Result<readonly WriterRecordView[], { readonly code: "records_unavailable" }>;
}

/** The termination capability: only `createTerminator` receives it. */
export interface TerminationChannel {
  /** Synchronous, idempotent and permanent: later ordinary writes answer `admission_closed`. */
  closeAdmission(): void;
  drain(): Promise<void>;
  state(): WriterState;
  /** Writes the one `termination` record. Allowed while admission is closed. */
  appendTermination(payload: StoreJsonObject, component?: string): Promise<WriterResult<AppendOk>>;
  /** The `sha256` of the result comes ONLY from the store's seal result. */
  seal(input: StoreJsonObject): Promise<WriterResult<SealOk>>;
}

export interface RecordWriterParts {
  readonly writer: RecordWriter;
  readonly channel: TerminationChannel;
}

const noop = (): void => undefined;
const withComponent = (component: string | undefined): { component?: string } => (component === undefined ? {} : { component });

/** Deeper than any record the store accepts; a deeper value is a defect and makes `records()` fail closed. */
const MAX_FREEZE_DEPTH = 256;
/** Freezes a JSON value in place, every level. The value is the store's own fresh clone, so nothing shared is frozen. */
function deepFreeze<T>(v: T, depth: number): T {
  if (typeof v !== "object" || v === null) return v;
  if (depth > MAX_FREEZE_DEPTH) throw new Error("too deep");
  for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k], depth + 1);
  Object.freeze(v as object);
  return v;
}

export function createRecordWriter(store: RunRecordStore): RecordWriterParts {
  let down = false;
  let failure: "io_failure" | "store_failed" | undefined;
  let sealed = false;
  let terminationWritten = false;
  let admissionClosed = false;
  let secretRejections = 0;
  let tail: Promise<unknown> = Promise.resolve();

  const refuse = <T>(code: WriterErrorCode): WriterResult<T> => Object.freeze({ ok: false as const, error: Object.freeze({ code }) });
  const refusedNow = <T>(code: WriterErrorCode): Promise<WriterResult<T>> => Promise.resolve(refuse<T>(code));
  const goDown = <T>(code: "io_failure" | "store_failed"): WriterResult<T> => {
    down = true;
    failure ??= code;
    return refuse<T>(code);
  };
  const fromStoreError = <T>(kind: string): WriterResult<T> => {
    if (kind === "secret_rejected") {
      secretRejections += 1;
      return refuse<T>("secret_rejected");
    }
    if (kind === "invalid_record") return refuse<T>("invalid_record");
    if (kind === "io_failure") return goDown<T>("io_failure");
    return goDown<T>("store_failed"); // `store_failed`, and any kind that is not known
  };
  // The job never rejects (it has its own try/catch); the second handler keeps the chain alive in any case.
  const enqueue = <T>(job: () => Promise<WriterResult<T>>): Promise<WriterResult<T>> => {
    const run = tail.then(job);
    tail = run.then(noop, noop);
    return run;
  };
  const exec = <T>(
    gate: () => WriterErrorCode | undefined,
    call: () => Promise<Result<T, { kind: string }>>,
    onOk: () => void,
  ): Promise<WriterResult<T>> =>
    enqueue(async (): Promise<WriterResult<T>> => {
      if (down) return refuse<T>("writer_down");
      const refused = gate();
      if (refused !== undefined) return refuse<T>(refused);
      try {
        const r = await call();
        if (r.ok) {
          onOk();
          return { ok: true, value: r.value };
        }
        return fromStoreError<T>(r.error.kind);
      } catch {
        return goDown<T>("io_failure"); // a thrown exception or a rejected promise is an I/O failure; the message is dropped
      }
    });
  // ACCEPT-time admission check of an ordinary write: nothing is queued and the store is not called when admission is closed.
  const admit = <T>(start: () => Promise<WriterResult<T>>): Promise<WriterResult<T>> =>
    admissionClosed ? refusedNow<T>(terminationWritten ? "closed_after_termination" : "admission_closed") : start();
  const afterTermination = (): WriterErrorCode | undefined => (terminationWritten ? "closed_after_termination" : undefined);
  // The tail never rejects, so neither does the drain. It takes the tail AT CALL TIME: later jobs are not awaited.
  const drain = (): Promise<void> => tail.then(noop, noop);
  const state = (): WriterState => Object.freeze({ down, sealed, terminationWritten, secretRejections, ...(failure === undefined ? {} : { failure }) });
  // `store.list()` returns a fresh structured clone of the committed records (a record is added to it only after a successful persist), so the
  // projection is built from that clone without a second copy and then frozen at every level. The store and its envelope fields stay hidden.
  // A failure (a throwing `list()`, or a value too deep to freeze) is a typed refusal, never an empty array (task 4.4 unit U4; R12.14, R24.15).
  const records = (): Result<readonly WriterRecordView[], { readonly code: "records_unavailable" }> => {
    try {
      const out: WriterRecordView[] = store.list().map((r) => Object.freeze({ id: r.id, kind: r.kind, payload: deepFreeze(r.payload, 0) }));
      return Object.freeze({ ok: true as const, value: Object.freeze(out) });
    } catch {
      down = true;
      failure ??= "store_failed";
      return Object.freeze({ ok: false as const, error: Object.freeze({ code: "records_unavailable" as const }) });
    }
  };

  const writer = Object.freeze({
    append: (kind, payload, component) =>
      kind === "termination"
        ? refusedNow<AppendOk>("termination_reserved")
        : admit(() =>
            exec<AppendOk>(
              afterTermination,
              () => store.append(kind, payload, withComponent(component)),
              noop,
            ),
          ),
    putBlob: (data, component) => admit(() => exec<BlobOk>(afterTermination, () => store.putBlob(data, withComponent(component)), noop)),
    putAiOutput: (data, component) => admit(() => exec<AiOutputOk>(afterTermination, () => store.putAiOutput(data, withComponent(component)), noop)),
    drain,
    state,
    records,
  } satisfies RecordWriter);

  const channel = Object.freeze({
    closeAdmission: (): void => {
      admissionClosed = true;
    },
    drain,
    state,
    appendTermination: (payload, component) =>
      exec<AppendOk>(
        () => (terminationWritten ? "duplicate_termination" : secretRejections > 0 ? "evidence_rejected" : undefined),
        () => store.append("termination", payload, withComponent(component)),
        () => {
          terminationWritten = true;
        },
      ),
    seal: (input) =>
      exec<SealOk>(
        // A rejected write is reported before a missing termination record: it is the more informative cause of a refused seal.
        () => (sealed ? "already_sealed" : secretRejections > 0 ? "evidence_rejected" : !terminationWritten ? "termination_missing" : undefined),
        () => store.seal(input),
        () => {
          sealed = true;
        },
      ),
  } satisfies TerminationChannel);

  return Object.freeze({ writer, channel });
}
