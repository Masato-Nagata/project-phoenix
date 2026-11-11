// Four-facts query of the `report` entry point (R6.10, R6.19). Runs after the Run, never in the runtime.
// It reuses readFacts (model) and the Approval read side (approval); it adds no derivation of its own.
import { ApprovalStoreError, asApprovalStatusReader, type ApprovalReader } from "../approval/index.js";
import type { EvidenceStore } from "../model/evidenceStore.js";
import { readFacts } from "../model/facts.js";
import type { EvidenceRecord, Facts, StoreError, StoreResult } from "../model/types.js";
import type { Result } from "../schema/index.js";

/** The Approval_Store could not answer. Never turned into a default such as `none`. */
export interface ApprovalUnavailableError {
  readonly kind: "approval_unavailable";
  readonly message: string;
}
export type ReportError = StoreError | ApprovalUnavailableError;
export type ReportResult<T> = Result<T, ReportError>;

/** One Claim revision in a report: the four separate facts plus the Evidence ids behind them. */
export interface ReportEntry {
  readonly facts: Facts;
  readonly evidenceIds: readonly string[];
  /** Every contradicting Evidence id, no cap (R6.13). */
  readonly contradictingEvidenceIds: readonly string[];
}

export interface FactsQuery {
  /** Four separate fields. Unknown identifier: an error naming it, never a default (R6.19). */
  facts(claimRevisionId: string): ReportResult<Facts>;
  /** All Claim revisions of the Run, ordered by Claim id, then revision number. */
  allFacts(): ReportResult<readonly Facts[]>;
  /** Evidence ids that contradict this revision, in append order, no cap. */
  contradictingEvidence(claimRevisionId: string): StoreResult<readonly string[]>;
  entry(claimRevisionId: string): ReportResult<ReportEntry>;
  entries(): ReportResult<readonly ReportEntry[]>;
}

/** An `experiment` record with outcome `contradicts`, or a `source` record with at least one failed Citation. */
export function isContradicting(r: EvidenceRecord): boolean {
  if (r.kind === "experiment") return r.outcome === "contradicts";
  return (r.citations ?? []).some((c) => c.result === "failed");
}

export function createFactsQuery(store: EvidenceStore, runId: string, approvals: ApprovalReader): FactsQuery {
  const reader = asApprovalStatusReader(approvals);

  const facts = (id: string): ReportResult<Facts> => {
    try {
      return readFacts(store, runId, id, reader);
    } catch (e) {
      if (e instanceof ApprovalStoreError) {
        return { ok: false, error: { kind: "approval_unavailable", message: e.message } };
      }
      throw e;
    }
  };

  const contradictingEvidence = (id: string): StoreResult<readonly string[]> => {
    const records = store.evidenceOf(id);
    if (!records.ok) return records;
    return { ok: true, value: records.value.filter(isContradicting).map((r) => r.evidenceId) };
  };

  const entry = (id: string): ReportResult<ReportEntry> => {
    const f = facts(id);
    if (!f.ok) return f;
    const records = store.evidenceOf(id);
    if (!records.ok) return records;
    return {
      ok: true,
      value: {
        facts: f.value,
        evidenceIds: records.value.map((r) => r.evidenceId),
        contradictingEvidenceIds: records.value.filter(isContradicting).map((r) => r.evidenceId),
      },
    };
  };

  const orderedIds = (): string[] => {
    const rows: { claimId: string; revision: number; id: string }[] = [];
    for (const ev of store.events()) {
      if (ev.type !== "claim_revision") continue;
      const rev = store.getRevision(ev.claimRevisionId);
      if (rev.ok) rows.push({ claimId: rev.value.claimId, revision: rev.value.revision, id: rev.value.claimRevisionId });
    }
    rows.sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : a.revision - b.revision));
    return rows.map((r) => r.id);
  };

  const collect = <T>(one: (id: string) => ReportResult<T>): ReportResult<readonly T[]> => {
    const out: T[] = [];
    for (const id of orderedIds()) {
      const r = one(id);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return { ok: true, value: out };
  };

  return {
    facts,
    allFacts: () => collect(facts),
    contradictingEvidence,
    entry,
    entries: () => collect(entry),
  };
}
