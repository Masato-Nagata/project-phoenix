// In-memory Evidence_Store core: Claim revisions (Origin written once), append-only Evidence records,
// derived Evidence_Status values, and recorded rejections / discards.
//
// There is no Approval code here: Approval status is derived elsewhere from records handed in by a
// reader (facts.ts), is never stored with a revision (R6.9) and is never read while payloads are built
// (R6.11). Statuses are derived on demand, so no append can change any other fact (R6.17).
import { createSchemaValidator, type SchemaValidator } from "../schema/index.js";
import { deriveExperimentStatus, deriveSourceStatus } from "./derive.js";
import { discardAiAuthorityFields } from "./sanitize.js";
import type {
  EvidenceKind,
  EvidenceRecord,
  EvidenceStatus,
  JsonObject,
  Origin,
  StoredClaimRevisionRecord,
  StoreError,
  StoreEvent,
  StoreResult,
} from "./types.js";

/** The only component that may append `source` Evidence (R5.6, R6.15). */
export const CITATION_VERIFIER = "citation_verifier";

export type ComparatorResult = "match" | "mismatch" | "not_comparable";
const RULE_OUTCOME = { match: "supports", mismatch: "contradicts", not_comparable: "inconclusive" } as const;

/** Identity of the experiment rule of R6.6 / R6.7 for one Comparator result. These are the only `experiment` writers. */
export function experimentRuleComponent(result: ComparatorResult): string {
  return `experiment_rule:${result}`;
}

export interface CreateClaimRevisionInput {
  /** Stays the same across revisions of the same Claim (R4.10). */
  claimId: string;
  /** Why this revision exists. For a first revision, e.g. "initial". */
  reason: string;
  /** Evidence ids that prompted the revision. They must exist; they stay linked to their own revision. */
  promptedByEvidence?: readonly string[];
  /** The claim as supplied by the AI. Authority-like fields are discarded and recorded without the value. */
  aiClaim: JsonObject;
  /** Id of the stored `ai_output` record the claim came from (for the ai_content_discarded record). */
  aiOutputRecordId: string;
}

export interface AppendEvidenceRequest {
  /** Identity of the writer. Checked against the Evidence_Kind (R6.15). */
  component: string;
  record: unknown;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as object)) deepFreeze(v);
  }
  return value;
}
const frozenCopy = <T>(value: T): T => deepFreeze(structuredClone(value));

const fail = <T>(error: StoreError): StoreResult<T> => ({ ok: false, error });
const unknownId = <T>(id: string): StoreResult<T> =>
  fail({ kind: "unknown_id", id, message: `unknown Claim revision identifier: ${id}` });

export class EvidenceStore {
  private readonly validator: SchemaValidator;
  private readonly revisions = new Map<string, StoredClaimRevisionRecord>();
  private readonly byClaim = new Map<string, string[]>();
  private readonly evidence: EvidenceRecord[] = [];
  private readonly evidenceIds = new Set<string>();
  private readonly log: StoreEvent[] = [];

  constructor(validator: SchemaValidator = createSchemaValidator()) {
    this.validator = validator;
  }

  /**
   * Stores a new Claim revision. It always gets a new identifier, Origin `ai-inferred`, and no Evidence;
   * both statuses start `absent` and Approval starts `none`, even when the content equals an earlier
   * revision (R6.14). There is no parameter through which Origin or a status could be supplied (R6.2).
   */
  createClaimRevision(input: CreateClaimRevisionInput): StoreResult<StoredClaimRevisionRecord> {
    const prior = this.byClaim.get(input.claimId) ?? [];
    const revision = prior.length + 1;
    const claimRevisionId = `${input.claimId}-r${revision}`;
    const shape = this.validator.validate("facts", {
      claimRevisionId,
      origin: "ai-inferred",
      sourceEvidenceStatus: "absent",
      experimentEvidenceStatus: "absent",
      approvalStatus: "none",
    });
    if (!shape.ok) {
      return fail({ kind: "invalid_request", message: `claimId does not give a valid identifier: ${input.claimId}` });
    }
    if (input.reason.trim() === "") return fail({ kind: "invalid_request", message: "reason must not be empty" });
    const prompted = [...(input.promptedByEvidence ?? [])];
    for (const id of prompted) {
      if (!this.evidenceIds.has(id)) return fail({ kind: "unknown_id", id, message: `unknown Evidence identifier: ${id}` });
    }

    const { cleaned, discarded } = discardAiAuthorityFields(input.aiClaim);
    const predecessor = prior[prior.length - 1];
    const record: StoredClaimRevisionRecord = frozenCopy({
      claimId: input.claimId,
      claimRevisionId,
      revision,
      ...(predecessor === undefined ? {} : { predecessorRevisionId: predecessor }),
      reason: input.reason,
      linkedEvidenceIds: prompted,
      origin: "ai-inferred" as Origin,
      content: cleaned,
    });
    this.revisions.set(claimRevisionId, record);
    this.byClaim.set(input.claimId, [...prior, claimRevisionId]);
    if (discarded.length > 0) {
      this.log.push(frozenCopy({ type: "ai_content_discarded" as const, aiOutputRecordId: input.aiOutputRecordId, fields: discarded }));
    }
    this.log.push({ type: "claim_revision", claimRevisionId });
    return { ok: true, value: record };
  }

  /** Any request to change the Origin of a stored revision is refused and recorded with the component (R6.2). */
  requestOriginChange(claimRevisionId: string, _requested: Origin, component: string): StoreResult<never> {
    if (!this.revisions.has(claimRevisionId)) return unknownId(claimRevisionId);
    return this.reject("set_origin", component, "the Origin of a stored Claim revision is immutable");
  }

  /**
   * Appends one Evidence record. Rejected, with all records unchanged and the rejection recorded, when
   * the kind is not `source` or `experiment`, when a `source` record comes from anything but the
   * Citation_Verifier, or when an `experiment` record comes from anything but the rule that matches its
   * outcome (R6.3, R6.6, R6.7, R6.15). Invalid shape or unknown revision is an error, not an append.
   */
  appendEvidence(request: AppendEvidenceRequest): StoreResult<EvidenceRecord> {
    const raw = request.record;
    const kind = typeof raw === "object" && raw !== null ? (raw as { kind?: unknown }).kind : undefined;
    if (kind !== "source" && kind !== "experiment") {
      return this.reject("append_evidence_disallowed_kind", request.component, "unknown Evidence kind");
    }
    if (kind === "source") {
      if (request.component !== CITATION_VERIFIER) {
        return this.reject("append_evidence_disallowed_actor", request.component, "only the Citation_Verifier appends `source` Evidence");
      }
    } else {
      const outcome = (raw as { outcome?: unknown }).outcome;
      const allowed = (Object.keys(RULE_OUTCOME) as ComparatorResult[]).find(
        (r) => experimentRuleComponent(r) === request.component,
      );
      if (allowed === undefined || RULE_OUTCOME[allowed] !== outcome) {
        return this.reject(
          "append_evidence_disallowed_actor",
          request.component,
          "`experiment` Evidence is appended only by the match, mismatch, or not_comparable rule with its own outcome",
        );
      }
    }
    const checked = this.validator.validate("evidence", raw);
    if (!checked.ok) {
      const first = checked.error[0];
      return fail({ kind: "invalid_request", message: `invalid Evidence record: ${first?.code ?? "?"} at ${first?.path ?? ""}` });
    }
    const record = raw as EvidenceRecord;
    if (!this.revisions.has(record.claimRevisionId)) return unknownId(record.claimRevisionId);
    if (this.evidenceIds.has(record.evidenceId)) {
      return fail({ kind: "invalid_request", message: `duplicate Evidence identifier: ${record.evidenceId}` });
    }
    const stored = frozenCopy(record);
    this.evidence.push(stored);
    this.evidenceIds.add(stored.evidenceId);
    this.log.push({ type: "evidence", evidenceId: stored.evidenceId });
    return { ok: true, value: stored };
  }

  getRevision(claimRevisionId: string): StoreResult<StoredClaimRevisionRecord> {
    const r = this.revisions.get(claimRevisionId);
    return r === undefined ? unknownId(claimRevisionId) : { ok: true, value: r };
  }

  /** One stored Evidence record by its identifier (used to write the `evidence` envelope). */
  getEvidence(evidenceId: string): StoreResult<EvidenceRecord> {
    const e = this.evidence.find((x) => x.evidenceId === evidenceId);
    return e === undefined
      ? fail({ kind: "unknown_id", id: evidenceId, message: `unknown Evidence identifier: ${evidenceId}` })
      : { ok: true, value: e };
  }

  /** Ordered revisions (oldest first) of one Claim, each with predecessor, reason, and linked Evidence ids. */
  revisionsOf(claimId: string): StoreResult<readonly StoredClaimRevisionRecord[]> {
    const ids = this.byClaim.get(claimId);
    if (ids === undefined) return unknownId(claimId);
    return { ok: true, value: ids.map((id) => this.revisions.get(id) as StoredClaimRevisionRecord) };
  }

  /** Evidence records linked to this revision only, in append order. Nothing is inherited from other revisions. */
  evidenceOf(claimRevisionId: string, kind?: EvidenceKind): StoreResult<readonly EvidenceRecord[]> {
    if (!this.revisions.has(claimRevisionId)) return unknownId(claimRevisionId);
    return {
      ok: true,
      value: this.evidence.filter((e) => e.claimRevisionId === claimRevisionId && (kind === undefined || e.kind === kind)),
    };
  }

  originOf(claimRevisionId: string): StoreResult<Origin> {
    const r = this.revisions.get(claimRevisionId);
    return r === undefined ? unknownId(claimRevisionId) : { ok: true, value: r.origin };
  }

  /** Never returns a default for an unknown identifier (R6.19). */
  sourceStatusOf(claimRevisionId: string): StoreResult<EvidenceStatus> {
    const e = this.evidenceOf(claimRevisionId, "source");
    return e.ok ? { ok: true, value: deriveSourceStatus(e.value) } : e;
  }

  experimentStatusOf(claimRevisionId: string): StoreResult<EvidenceStatus> {
    const e = this.evidenceOf(claimRevisionId, "experiment");
    return e.ok ? { ok: true, value: deriveExperimentStatus(e.value) } : e;
  }

  /** The recorded events in order: revisions, evidence, discards, rejections. */
  events(): readonly StoreEvent[] {
    return this.log.map((e) => frozenCopy(e));
  }

  private reject(
    attempt: "set_origin" | "append_evidence_disallowed_kind" | "append_evidence_disallowed_actor",
    rawComponent: string,
    reason: string,
  ): StoreResult<never> {
    const component = rawComponent.trim() === "" ? "unknown" : rawComponent.slice(0, 64);
    this.log.push(frozenCopy({ type: "store_rejection" as const, attempt, component, reason }));
    return fail({ kind: "rejected", attempt, component, message: `${attempt} by ${component}: ${reason}` });
  }
}
