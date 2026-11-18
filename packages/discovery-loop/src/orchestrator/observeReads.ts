// Read observer of the Source_Bundler file system (task 4.4, unit U3; R15.6, R15.13, R19.7).
//
// WHAT IS OBSERVED. Only the reads of the ANALYZER side: a denied `readFile` or `lstat` of the Source_Bundler's file system
// (`LoopDeps.analysisFs`, wrapped by `observeAnalysisReads`). A denied read there (errno `EACCES` or `EPERM`, as classified by
// `detectIsolationViolation`) is an isolation violation (R15.6), whatever the path.
//
// WHAT IS NOT OBSERVED. (1) A denied read of the Run_Volume by the Run record store is NOT an isolation violation: it ends the Run as an
// ordinary store failure (`error`). So there is deliberately no decorator for the discovery-loop `FileSystemPort`, and the store is untouched.
// (2) The start-up probes of the access-denial verification, whose denied outcomes are expected controls, are not connected to this module.
// (3) Successful reads, absent paths (`ENOENT`, `ENOTDIR`) and every other failure are not violations and leave no trace here.
//
// WHAT IS KEPT. No read log: no list of paths, no counter, no content. The observer holds at most ONE frozen violation record
// `{ code, op, errorCode, locationId }`, the first one. The record has no path: `locationId` is a fixed probe id or `unlisted`.
//
// WHO ACTS. This module only latches and notifies. It does not touch the run session, the termination latch, the termination channel or the
// store. The caller (unit U7) wires `onFirstViolation` to the session and writes the detail record.
//
// PATHS. No normalization, no dedupe, no cache: the path goes unchanged to `detectIsolationViolation`, whose location match is exact. A denied
// read of ANY path is a violation. A differently spelled path to a probe location (for example with `..` or a trailing slash) therefore still
// ends the Run with `isolation_violation`, only with `locationId: "unlisted"`.
import { detectIsolationViolation } from "../isolation/index.js";
import type { IsolationViolation } from "../isolation/index.js";
import type { AnalysisFsPort } from "./types.js";

/** What the decorator reports for a failed read. Nothing else about the read is passed on. */
export interface ReadAccess {
  readonly op: "stat" | "list" | "read";
  readonly path: string;
  readonly errorCode: string;
}

export interface ReadObserver {
  /** Never throws. Latches the first violation only; any other report leaves no trace. */
  report(a: ReadAccess): void;
  firstViolation(): IsolationViolation | undefined;
}

type LstatResult = Awaited<ReturnType<AnalysisFsPort["lstat"]>>;

/**
 * `onFirstViolation` is called at most once, synchronously, at the moment the first violation is latched. It must be synchronous. If it throws,
 * the exception is swallowed and the violation stays latched: a throwing callback cannot hide a violation.
 */
export function createReadObserver(opts?: { readonly onFirstViolation?: (v: IsolationViolation) => void }): ReadObserver {
  let latched: IsolationViolation | undefined;
  let onFirst: ((v: IsolationViolation) => void) | undefined;
  try {
    const cb: unknown = opts?.onFirstViolation;
    if (typeof cb === "function") onFirst = cb as (v: IsolationViolation) => void;
  } catch {
    onFirst = undefined;
  }

  const report = (a: ReadAccess): void => {
    try {
      if (latched !== undefined) return;
      const v = detectIsolationViolation(a);
      if (v === undefined) return;
      const record: IsolationViolation = Object.freeze({ code: v.code, op: v.op, errorCode: v.errorCode, locationId: v.locationId });
      latched = record;
      if (onFirst !== undefined) {
        try {
          onFirst(record);
        } catch {
          // swallowed on purpose: the latch above already holds the violation
        }
      }
    } catch {
      // report never throws
    }
  };
  const firstViolation = (): IsolationViolation | undefined => latched;
  return Object.freeze({ report, firstViolation });
}

/** The error code of a rejection, only when it is a string. A throwing getter or any other shape gives `undefined`. */
function errorCodeOf(e: unknown): string | undefined {
  try {
    if (typeof e !== "object" || e === null) return undefined;
    const c: unknown = (e as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  } catch {
    return undefined;
  }
}

/** Reports a failed read when the rejection has a string code. A failing observer cannot change the outcome of the read. */
function noteFailure(observer: ReadObserver, op: "stat" | "read", path: unknown, e: unknown): void {
  try {
    const errorCode = errorCodeOf(e);
    if (errorCode === undefined) return;
    observer.report({ op, path: typeof path === "string" ? path : "", errorCode });
  } catch {
    // an observer failure never changes the result of the read
  }
}

/**
 * A new frozen file system with exactly `readFile` and `lstat`. Each call makes exactly one call of the original method with the same argument
 * and returns its value unchanged (the same object, never inspected). A rejection is reported (only when it has a string code) and then the
 * ORIGINAL error value is rethrown. Nothing is swallowed, retried, wrapped, cached or reordered, and the decorator reads no file itself.
 */
export function observeAnalysisReads(fs: AnalysisFsPort, observer: ReadObserver): AnalysisFsPort {
  return Object.freeze({
    async readFile(path: string): Promise<Uint8Array> {
      try {
        return await fs.readFile(path);
      } catch (e) {
        noteFailure(observer, "read", path, e);
        throw e;
      }
    },
    async lstat(path: string): Promise<LstatResult> {
      try {
        return await fs.lstat(path);
      } catch (e) {
        noteFailure(observer, "stat", path, e);
        throw e;
      }
    },
  });
}
