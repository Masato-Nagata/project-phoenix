// Pure chain logic of the Approval_Store: line hashing, serialization and verification (R23.2, R23.9).
// No I/O and no writes. Used by the ApprovalReader (read side) and by the tooling path (validator,
// chain builder, golden vectors). See types.ts for the security distinction: this is tamper
// DETECTION only; write control is an OS/container matter; the actor field is a declaration.
import { createHash } from "node:crypto";
import { canonicalBytes, canonicalJson, parseCanonical } from "../canonical/index.js";
import { createSchemaValidator, type Json, type Result, type SchemaValidator } from "../schema/index.js";
import { deriveApprovalStatus } from "../model/derive.js";
import type { ApprovalStatus } from "../model/types.js";
import { GENESIS_HASH, type ApprovalLine, type StoreLine, type StoredTarget } from "./types.js";

export type MismatchKind = "modified" | "missing" | "chain_break";

/** One verification finding (R23.9): the record sequence number and the kind. `detail` is for humans. */
export interface Mismatch {
  seq: number;
  kind: MismatchKind;
  detail: string;
}

export type RuleName =
  | "supersedes_unknown"
  | "supersedes_not_approval"
  | "supersedes_target_differs"
  | "supersedes_already_superseded";

/** A stored line that is hash-correct but breaks a `supersedes` rule of R23.12 (for example a hand-built chain). */
export interface RuleViolation {
  seq: number;
  rule: RuleName;
  detail: string;
}

export interface VerifyReport {
  /** True when the lines that are present show no finding. It is NOT a claim that the store is complete. */
  ok: boolean;
  lineCount: number;
  mismatches: Mismatch[];
  ruleViolations: RuleViolation[];
  /**
   * Removal of trailing records is detectable only against an external anchor (M1 review resolution 7).
   * `excluded_by_anchor`: an anchor was supplied, the report is ok, and the anchored record is present with
   * its hash. `not_checked`: no anchor was supplied (or the report is not ok); nothing is claimed about the tail.
   */
  tailTruncation: "not_checked" | "excluded_by_anchor";
}

/** Position of the chain head that a verifier knows from elsewhere (for example a copy kept outside the file). */
export interface ChainAnchor {
  seq: number;
  hash: string;
}

export interface ChainState {
  /** Lines that parsed and passed the schema, in file order. */
  readonly lines: readonly StoreLine[];
  /** Sequence number the next line must carry. */
  readonly nextSeq: number;
  /** Hash the next line must carry as `prev_hash`. */
  readonly lastHash: string;
  readonly approvals: ReadonlyMap<number, ApprovalLine>;
  /** superseded seq -> seq of the superseding line */
  readonly supersededBy: ReadonlyMap<number, number>;
}

let sharedValidator: SchemaValidator | undefined;
export function approvalSchemaValidator(): SchemaValidator {
  sharedValidator ??= createSchemaValidator();
  return sharedValidator;
}

/** SHA-256 (lowercase hex) of the canonical JSON bytes of the record without its `hash` field (R23.2). */
export function hashInputBytes(record: { [k: string]: unknown }): Uint8Array {
  const rest: { [k: string]: unknown } = {};
  for (const k of Object.keys(record)) if (k !== "hash") rest[k] = record[k];
  return canonicalBytes(rest as Json);
}

export function computeLineHash(record: { [k: string]: unknown }): string {
  return createHash("sha256").update(hashInputBytes(record)).digest("hex");
}

/** The stored form of one line: canonical JSON followed by a single LF. */
export function serializeLine(line: StoreLine): string {
  return `${canonicalJson(line as unknown as Json)}\n`;
}

export function sameTarget(a: StoredTarget, b: StoredTarget): boolean {
  return canonicalJson(a as unknown as Json) === canonicalJson(b as unknown as Json);
}

function decode(input: string | Uint8Array): Result<string, string> {
  if (typeof input === "string") return { ok: true, value: input };
  try {
    return { ok: true, value: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input) };
  } catch {
    return { ok: false, error: "the store is not valid UTF-8" };
  }
}

/**
 * Recomputes every link of the store text and checks every line against the approval-record schema.
 * Writes nothing. Findings:
 *   modified    a line is not canonical JSON, violates the schema, is not newline-terminated, or its hash
 *               is not the hash of its content;
 *   missing     sequence numbers are absent (a gap), or the anchored head is not present;
 *   chain_break a line's `prev_hash` is not the hash of the line before it (genesis for the first line),
 *               or a sequence number repeats or goes backwards.
 * Without an `anchor`, removal of the last lines is not detectable (a chain cannot see its own tail).
 */
export function analyzeStore(
  input: string | Uint8Array,
  opts: { anchor?: ChainAnchor } = {},
): { report: VerifyReport; state: ChainState } {
  const mismatches: Mismatch[] = [];
  const violations: RuleViolation[] = [];
  const lines: StoreLine[] = [];
  const approvals = new Map<number, ApprovalLine>();
  const supersededBy = new Map<number, number>();
  const seen = new Set<string>();
  const addMismatch = (seq: number, kind: MismatchKind, detail: string): void => {
    const key = `${seq}:${kind}`;
    if (seen.has(key)) return;
    seen.add(key);
    mismatches.push({ seq, kind, detail });
  };

  const decoded = decode(input);
  let lineTexts: string[] = [];
  let unterminated = false;
  if (!decoded.ok) {
    addMismatch(1, "modified", decoded.error);
  } else if (decoded.value.length > 0) {
    lineTexts = decoded.value.split("\n");
    const last = lineTexts.pop() ?? "";
    if (last !== "") {
      lineTexts.push(last);
      unterminated = true;
    }
  }

  const validator = approvalSchemaValidator();
  let expected = 1;
  let prevHash: string | undefined = GENESIS_HASH;
  for (let i = 0; i < lineTexts.length; i++) {
    const text = lineTexts[i] ?? "";
    const isUnterminated = unterminated && i === lineTexts.length - 1;
    const parsed = parseCanonical(text);
    const valid = parsed.ok ? validator.validate("approval-record", parsed.value) : undefined;
    if (!parsed.ok || valid === undefined || !valid.ok) {
      const why = !parsed.ok
        ? `${parsed.error.code}: ${parsed.error.message}`
        : `schema: ${(valid && !valid.ok ? valid.error : []).map((x) => `${x.path || "/"} ${x.code}`).join(", ")}`;
      addMismatch(expected, "modified", `line ${i + 1} is not a canonical, valid line (${why})`);
      prevHash = undefined;
      expected += 1;
      continue;
    }
    const rec = valid.value as unknown as StoreLine;
    if (rec.seq > expected) {
      addMismatch(
        expected,
        "missing",
        rec.seq - 1 === expected ? `record ${expected} is absent` : `records ${expected} to ${rec.seq - 1} are absent`,
      );
      expected = rec.seq;
    } else if (rec.seq < expected) {
      addMismatch(rec.seq, "chain_break", `sequence number ${rec.seq} repeats or goes backwards (expected ${expected})`);
    }
    if (computeLineHash(rec as unknown as { [k: string]: unknown }) !== rec.hash) {
      addMismatch(rec.seq, "modified", "hash is not the hash of the record content");
    }
    if (isUnterminated) addMismatch(rec.seq, "modified", "last line is not newline-terminated (partial write)");
    if (prevHash !== undefined && rec.prev_hash !== prevHash) {
      addMismatch(rec.seq, "chain_break", "prev_hash is not the hash of the preceding line");
    }
    prevHash = rec.hash;
    expected = Math.max(expected, rec.seq + 1);
    lines.push(rec);

    if (rec.type === "approval") {
      if (rec.supersedes !== undefined) {
        const target = approvals.get(rec.supersedes);
        const earlierLine = lines.find((l) => l !== rec && l.seq === rec.supersedes);
        if (target === undefined) {
          violations.push(
            earlierLine !== undefined
              ? { seq: rec.seq, rule: "supersedes_not_approval", detail: `record ${rec.supersedes} is not an approval` }
              : { seq: rec.seq, rule: "supersedes_unknown", detail: `no earlier record ${rec.supersedes}` },
          );
        } else if (!sameTarget(target.target, rec.target)) {
          violations.push({ seq: rec.seq, rule: "supersedes_target_differs", detail: `record ${rec.supersedes} has another target` });
        } else if (supersededBy.has(rec.supersedes)) {
          violations.push({
            seq: rec.seq,
            rule: "supersedes_already_superseded",
            detail: `record ${rec.supersedes} is already superseded by ${supersededBy.get(rec.supersedes)}`,
          });
        } else {
          supersededBy.set(rec.supersedes, rec.seq);
        }
      }
      approvals.set(rec.seq, rec);
    }
  }

  const anchor = opts.anchor;
  if (anchor !== undefined) {
    const at = lines.find((l) => l.seq === anchor.seq);
    if (at === undefined) addMismatch(anchor.seq, "missing", `anchored record ${anchor.seq} is not in the store`);
    else if (at.hash !== anchor.hash) addMismatch(anchor.seq, "modified", "hash differs from the anchored hash");
  }

  mismatches.sort((a, b) => a.seq - b.seq || kindOrder(a.kind) - kindOrder(b.kind));
  violations.sort((a, b) => a.seq - b.seq);
  const lastLine = lines[lines.length - 1];
  const reportOk = mismatches.length === 0 && violations.length === 0;
  return {
    report: {
      ok: reportOk,
      lineCount: lineTexts.length,
      mismatches,
      ruleViolations: violations,
      // Resolution 7: only a caller-supplied anchor that matched allows the claim that no tail was removed.
      tailTruncation: anchor !== undefined && reportOk ? "excluded_by_anchor" : "not_checked",
    },
    state: {
      lines,
      nextSeq: lastLine === undefined ? 1 : lastLine.seq + 1,
      lastHash: lastLine === undefined ? GENESIS_HASH : lastLine.hash,
      approvals,
      supersededBy,
    },
  };
}

function kindOrder(k: MismatchKind): number {
  return k === "modified" ? 0 : k === "missing" ? 1 : 2;
}

/** The state of a store that verified without any finding; otherwise the report. */
export function loadVerifiedState(input: string | Uint8Array, opts: { anchor?: ChainAnchor } = {}): Result<ChainState, VerifyReport> {
  const { report, state } = analyzeStore(input, opts);
  return report.ok ? { ok: true, value: state } : { ok: false, error: report };
}

/**
 * Approval status of one target (R6.9): `none` when no approval line targets it, otherwise the decision
 * of the line with the highest sequence number among them. store_rejection lines are ignored.
 */
export function statusFromState(state: ChainState, target: StoredTarget): ApprovalStatus {
  const matching: { seq: number; decision: ApprovalLine["decision"] }[] = [];
  for (const a of state.approvals.values()) if (sameTarget(a.target, target)) matching.push({ seq: a.seq, decision: a.decision });
  return deriveApprovalStatus(matching);
}
