// ApprovalReader: the read side of the Approval_Store (R6.9, R23.9). It verifies and answers status
// queries and has NO write method; the runtime has no writer and no reader (R6.11). It belongs to the
// `report` / evaluator side, not to the runtime entry point.
//
// Security distinction (see types.ts): the chain this reader checks gives tamper DETECTION only. Write
// control is the OS/container permission set (the runtime has no mount and no write access). The
// `recorded_by` actor is a declaration; the chain does not prove who ran the host-side command.
import { existsSync, readFileSync } from "node:fs";
import type { Result } from "../schema/index.js";
import type { ApprovalStatusReader, ClaimRevisionApprovalTarget } from "../model/facts.js";
import type { ApprovalStatus } from "../model/types.js";
import { analyzeStore, statusFromState, type ChainAnchor, type ChainState, type VerifyReport } from "./chain.js";
import { toStoredTarget, type ApprovalLine, type ApprovalTarget, type TargetResolver } from "./types.js";

export type ApprovalReadError =
  | { kind: "unknown_target"; message: string }
  | { kind: "store_invalid"; message: string; report: VerifyReport }
  | { kind: "unreadable"; message: string };

export class ApprovalStoreError extends Error {
  constructor(readonly error: ApprovalReadError) {
    super(`${error.kind}: ${error.message}`);
    this.name = "ApprovalStoreError";
  }
}

export interface ReaderOptions {
  anchor?: ChainAnchor;
}

export class ApprovalReader implements ApprovalStatusReader {
  private constructor(
    private readonly report: VerifyReport,
    private readonly state: ChainState,
    private readonly resolver: TargetResolver,
    private readonly staleTemp: boolean,
  ) {}

  /** Reader over store content already in memory. Never throws; a damaged store shows in `verify()`. */
  static fromBytes(input: string | Uint8Array, resolver: TargetResolver, opts: ReaderOptions = {}): ApprovalReader {
    const { report, state } = analyzeStore(input, opts.anchor === undefined ? {} : { anchor: opts.anchor });
    return new ApprovalReader(report, state, resolver, false);
  }

  /**
   * Reader over `approvals.jsonl`. Opens the file for reading only. A leftover `<file>.tmp` (an
   * interrupted write of the host command) makes `verify()` fail. A missing file is `unreadable` unless
   * `allowMissing` is set, in which case it is an empty store.
   */
  static fromFile(
    path: string,
    resolver: TargetResolver,
    opts: ReaderOptions & { allowMissing?: boolean } = {},
  ): Result<ApprovalReader, ApprovalReadError> {
    let bytes: Uint8Array;
    if (!existsSync(path) && opts.allowMissing === true) {
      bytes = new Uint8Array(0);
    } else {
      try {
        bytes = readFileSync(path);
      } catch (e) {
        return { ok: false, error: { kind: "unreadable", message: `cannot read the Approval_Store: ${(e as Error).message}` } };
      }
    }
    const { report, state } = analyzeStore(bytes, opts.anchor === undefined ? {} : { anchor: opts.anchor });
    return { ok: true, value: new ApprovalReader(report, state, resolver, existsSync(`${path}.tmp`)) };
  }

  /** Recomputes every link and writes nothing (R23.9). `ok` is false for any mismatch, rule violation or stale temp file. */
  verify(): VerifyReport {
    return this.staleTemp ? { ...this.report, ok: false, tailTruncation: "not_checked" } : this.report;
  }

  /** True when a stale temporary file was found next to the store (fromFile only). */
  hasStaleTempFile(): boolean {
    return this.staleTemp;
  }

  /** Approval lines in chain order (store_rejection lines are not approvals). */
  approvals(): readonly ApprovalLine[] {
    return [...this.state.approvals.values()].sort((a, b) => a.seq - b.seq);
  }

  /**
   * `none` when no approval targets it, otherwise the decision of the highest-`seq` line for the target
   * (R6.9). An unknown target and an unverifiable store are errors, never `none`.
   */
  statusOf(target: ApprovalTarget): Result<ApprovalStatus, ApprovalReadError> {
    if (!this.resolver.resolves(target)) {
      return { ok: false, error: { kind: "unknown_target", message: `target does not resolve: ${JSON.stringify(toStoredTarget(target))}` } };
    }
    const v = this.verify();
    if (!v.ok) {
      return { ok: false, error: { kind: "store_invalid", message: "the Approval_Store does not verify; no status is derived from it", report: v } };
    }
    return { ok: true, value: statusFromState(this.state, toStoredTarget(target)) };
  }

  /** `ApprovalStatusReader` form (facts.ts). Throws `ApprovalStoreError` instead of returning a default. */
  approvalStatus(target: ApprovalTarget): ApprovalStatus {
    const r = this.statusOf(target);
    if (!r.ok) throw new ApprovalStoreError(r.error);
    return r.value;
  }
}

/** Adapter that exposes only the `ApprovalStatusReader` surface of facts.ts (no verify, no record access). */
export function asApprovalStatusReader(reader: ApprovalReader): ApprovalStatusReader {
  return { approvalStatus: (target: ClaimRevisionApprovalTarget) => reader.approvalStatus(target) };
}
