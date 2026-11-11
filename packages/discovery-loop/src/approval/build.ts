// Pure chain builder (R23.2). TOOLING PATH ONLY: tests and golden-vector generation. It returns new
// text and never touches a file. It is not exported through the runtime entry point (src/index.ts).
// A chain built here has valid hashes and links; it says nothing about who approved anything (see types.ts).
import { approvalSchemaValidator, computeLineHash, loadVerifiedState, serializeLine, type VerifyReport } from "./chain.js";
import { validateApprovalCandidate, type FieldIssue } from "./validate.js";
import type { ApprovalCandidate, ApprovalLine, StoreRejectionLine, TargetResolver } from "./types.js";
import type { Result } from "../schema/index.js";

/** Builds one approval line with its hash. Does not validate beyond what canonical serialization requires. */
export function buildApprovalLine(candidate: ApprovalCandidate, seq: number, prevHash: string): ApprovalLine {
  const body = { ...candidate, type: "approval" as const, seq, prev_hash: prevHash };
  return { ...body, hash: computeLineHash(body) };
}

export function buildStoreRejectionLine(args: { seq: number; prevHash: string; reason: string; attemptedSeq?: number }): StoreRejectionLine {
  const body: Omit<StoreRejectionLine, "hash"> = {
    type: "store_rejection",
    seq: args.seq,
    prev_hash: args.prevHash,
    reason: args.reason,
    ...(args.attemptedSeq === undefined ? {} : { attempted_seq: args.attemptedSeq }),
  };
  return { ...body, hash: computeLineHash(body) };
}

export type AppendError =
  | { kind: "store_invalid"; report: VerifyReport }
  | { kind: "invalid_record"; issues: FieldIssue[] };

/**
 * Appends a validated approval to the store text and returns the new text. On any error the input text is
 * unchanged (the caller still holds it), matching "leave the store byte-identical" of R23.7.
 */
export function appendApproval(
  storeText: string,
  candidate: unknown,
  resolver: TargetResolver,
): Result<{ text: string; line: ApprovalLine }, AppendError> {
  const loaded = loadVerifiedState(storeText);
  if (!loaded.ok) return { ok: false, error: { kind: "store_invalid", report: loaded.error } };
  const checked = validateApprovalCandidate(candidate, { state: loaded.value, resolver });
  if (!checked.ok) return { ok: false, error: { kind: "invalid_record", issues: checked.error } };
  const line = buildApprovalLine(checked.value, loaded.value.nextSeq, loaded.value.lastHash);
  return { ok: true, value: { text: storeText + serializeLine(line), line } };
}

/** Appends the record of a refused modify or delete request (R23.2). Carries no approval content. */
export function appendStoreRejection(
  storeText: string,
  reason: string,
  attemptedSeq?: number,
): Result<{ text: string; line: StoreRejectionLine }, AppendError> {
  const loaded = loadVerifiedState(storeText);
  if (!loaded.ok) return { ok: false, error: { kind: "store_invalid", report: loaded.error } };
  const line = buildStoreRejectionLine({
    seq: loaded.value.nextSeq,
    prevHash: loaded.value.lastHash,
    reason,
    ...(attemptedSeq === undefined ? {} : { attemptedSeq }),
  });
  const checked = approvalSchemaValidator().validate("approval-record", line);
  if (!checked.ok) {
    const issues: FieldIssue[] = checked.error.map((i) => ({
      field: i.path.split("/")[1] ?? "(record)",
      path: i.path.split("/").slice(1).join("."),
      code: i.code === "missing_field" || i.code === "undefined_field" || i.code === "bad_type" ? i.code : "bad_value",
      message: i.message,
    }));
    return { ok: false, error: { kind: "invalid_record", issues } };
  }
  return { ok: true, value: { text: storeText + serializeLine(line), line } };
}

/** Builds a whole chain from candidates (each validated in order against the growing store). */
export function buildChain(
  candidates: readonly unknown[],
  resolver: TargetResolver,
): Result<{ text: string; lines: ApprovalLine[] }, { index: number; error: AppendError }> {
  let text = "";
  const lines: ApprovalLine[] = [];
  for (let index = 0; index < candidates.length; index++) {
    const r = appendApproval(text, candidates[index], resolver);
    if (!r.ok) return { ok: false, error: { index, error: r.error } };
    text = r.value.text;
    lines.push(r.value.line);
  }
  return { ok: true, value: { text, lines } };
}
