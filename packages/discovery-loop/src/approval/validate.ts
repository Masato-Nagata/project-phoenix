// Pure validator for a NEW approval line (R23.7, R23.12). TOOLING PATH ONLY: tests and golden-vector
// generation. It is not exported through the runtime entry point (src/index.ts); the runtime has no
// way to create an Approval_Record (R6.11, R23.4). The only production writer is the host-side
// PowerShell command (task 4.10), which must agree with this reference through the golden vectors.
//
// Field limits come from the existing `approval-record` schema; this module adds the rules that need
// context (target resolution, `supersedes`). The `recorded_by` field carries the actor declaration
// (`-Actor` of the command). It is a declaration only; see types.ts.
import type { Issue, Result } from "../schema/index.js";
import { approvalSchemaValidator, sameTarget, type ChainState } from "./chain.js";
import { GENESIS_HASH, toApprovalTarget, type ApprovalCandidate, type StoredTarget, type TargetResolver } from "./types.js";

export type FieldIssueCode =
  | "missing_field"
  | "undefined_field"
  | "bad_type"
  | "bad_value"
  | "unresolved_target"
  | "supersedes_unknown"
  | "supersedes_not_approval"
  | "supersedes_target_differs"
  | "supersedes_already_superseded"
  | "not_an_object";

/** One missing or invalid field. `field` is the top-level field name; `path` is the dotted path inside it. */
export interface FieldIssue {
  field: string;
  path: string;
  code: FieldIssueCode;
  message: string;
}

export const CANDIDATE_FIELDS = ["approver", "timestamp", "target", "decision", "rationale", "recorded_by", "supersedes"] as const;

export interface ValidationContext {
  /** State of a store that verified cleanly (`loadVerifiedState`). */
  state: ChainState;
  resolver: TargetResolver;
}

function pointerSegments(path: string): string[] {
  return path
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
}

function toFieldIssue(i: Issue): FieldIssue {
  const segs = pointerSegments(i.path);
  const field = segs[0] ?? "(record)";
  const code: FieldIssueCode = i.code === "undefined_field" || i.code === "missing_field" || i.code === "bad_type" || i.code === "bad_value"
    ? i.code
    : "bad_value";
  return { field, path: segs.join("."), code, message: i.message };
}

/**
 * Validates candidate content against the approval-record schema and the store context.
 * Returns every missing or invalid field by name (sorted by field name); never stops at the first.
 * Does not mutate the candidate or the state, and writes nothing.
 */
export function validateApprovalCandidate(candidate: unknown, ctx: ValidationContext): Result<ApprovalCandidate, FieldIssue[]> {
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return { ok: false, error: [{ field: "(record)", path: "", code: "not_an_object", message: "the record must be an object" }] };
  }
  const input = candidate as Record<string, unknown>;
  const issues: FieldIssue[] = [];

  // Sequence, predecessor hash, hash and type belong to the store, never to the caller.
  const content: Record<string, unknown> = {};
  for (const key of Object.keys(input)) {
    if ((CANDIDATE_FIELDS as readonly string[]).includes(key)) {
      if (input[key] !== undefined) content[key] = input[key];
    } else {
      issues.push({ field: key, path: key, code: "undefined_field", message: "field is not caller-supplied or not defined" });
    }
  }

  const probe = {
    type: "approval",
    seq: ctx.state.nextSeq,
    prev_hash: ctx.state.lastHash,
    hash: GENESIS_HASH,
    ...content,
  };
  const checked = approvalSchemaValidator().validate("approval-record", probe);
  if (!checked.ok) {
    for (const i of checked.error) {
      const fi = toFieldIssue(i);
      if (fi.field === "type" || fi.field === "seq" || fi.field === "prev_hash" || fi.field === "hash") continue;
      issues.push(fi);
    }
  }
  const failed = new Set(issues.map((i) => i.field));

  if (!failed.has("target")) {
    const target = content["target"] as StoredTarget;
    if (!ctx.resolver.resolves(toApprovalTarget(target))) {
      issues.push({ field: "target", path: "target", code: "unresolved_target", message: "target does not resolve to an existing Claim revision, Run or defined Gate" });
    }
    if (content["supersedes"] !== undefined && !failed.has("supersedes")) {
      const s = content["supersedes"] as number;
      const earlier = ctx.state.approvals.get(s);
      if (earlier === undefined) {
        const isOther = ctx.state.lines.some((l) => l.seq === s);
        issues.push({
          field: "supersedes",
          path: "supersedes",
          code: isOther ? "supersedes_not_approval" : "supersedes_unknown",
          message: isOther ? `record ${s} is not an approval` : `no stored record ${s}`,
        });
      } else if (!sameTarget(earlier.target, target)) {
        issues.push({ field: "supersedes", path: "supersedes", code: "supersedes_target_differs", message: `record ${s} has a different target` });
      } else if (ctx.state.supersededBy.has(s)) {
        issues.push({ field: "supersedes", path: "supersedes", code: "supersedes_already_superseded", message: `record ${s} is already superseded` });
      }
    }
  } else if (content["supersedes"] !== undefined && !failed.has("supersedes")) {
    // The target is invalid, so the target comparison cannot be made; the schema accepted the number itself.
    const s = content["supersedes"] as number;
    if (!ctx.state.approvals.has(s)) {
      const isOther = ctx.state.lines.some((l) => l.seq === s);
      issues.push({
        field: "supersedes",
        path: "supersedes",
        code: isOther ? "supersedes_not_approval" : "supersedes_unknown",
        message: isOther ? `record ${s} is not an approval` : `no stored record ${s}`,
      });
    }
  }

  if (issues.length > 0) {
    const seen = new Set<string>();
    const unique = issues.filter((i) => {
      const k = `${i.field}\u0000${i.code}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    unique.sort((a, b) => (a.field < b.field ? -1 : a.field > b.field ? 1 : a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return { ok: false, error: unique };
  }
  return { ok: true, value: content as unknown as ApprovalCandidate };
}

/** Distinct field names of a failed validation, sorted. */
export function fieldNames(issues: readonly FieldIssue[]): string[] {
  return [...new Set(issues.map((i) => i.field))].sort();
}
