// Golden-vector generator for the Approval_Store (task 1.16). TOOLING PATH ONLY.
// The vectors are data files that the PowerShell writer of task 4.10 must reproduce byte for byte, and
// that the TypeScript reader must accept. Hashes and canonical bytes are computed by this reference;
// every EXPECTED validation and verification outcome below is written by hand, so a bug in the
// validator or the verifier is not copied into the expectation.
import { appendApproval, appendStoreRejection } from "./build.js";
import { computeLineHash, hashInputBytes, serializeLine } from "./chain.js";
import type { Json } from "../schema/index.js";
import { canonicalJson } from "../canonical/index.js";
import { GENESIS_HASH, type ApprovalCandidate, type ApprovalTarget, type StoreLine, type TargetResolver } from "./types.js";

export const VECTOR_FORMAT = "phoenix-approval-vectors/1";

const KNOWN_RUNS = ["run-0001"] as const;
const KNOWN_CLAIM_REVISIONS = [{ run_id: "run-0001", claim_revision_id: "clm-0001-r1" }] as const;

/** Resolver that the vectors describe: the listed Runs and Claim revisions exist; every defined Gate resolves via the schema. */
export function vectorResolver(): TargetResolver {
  return {
    resolves(t: ApprovalTarget): boolean {
      switch (t.kind) {
        case "run":
          return (KNOWN_RUNS as readonly string[]).includes(t.runId);
        case "claim_revision":
          return KNOWN_CLAIM_REVISIONS.some((c) => c.run_id === t.runId && c.claim_revision_id === t.claimRevisionId);
        case "gate":
          return true;
      }
    },
  };
}

const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(`vector generation failed: ${JSON.stringify(r.error)}`);
  return r.value;
};

const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  approver: "Alice Example",
  timestamp: "2025-03-04T05:06:07.000+09:00",
  target: { kind: "run", run_id: "run-0001" },
  decision: "approved",
  rationale: "Reviewed.",
  recorded_by: "human",
  ...over,
});
const without = (o: Record<string, unknown>, k: string): Record<string, unknown> => {
  const c = { ...o };
  delete c[k];
  return c;
};

// ------------------------------------------------------------------------------------------------
type Step = { approval: ApprovalCandidate } | { rejection: { reason: string; attempted_seq?: number } };

function chainCase(name: string, description: string, steps: Step[]): Record<string, Json> {
  let text = "";
  const lines: Json[] = [];
  for (const step of steps) {
    let line: StoreLine;
    if ("approval" in step) {
      const r = must(appendApproval(text, step.approval, vectorResolver()));
      line = r.line;
      text = r.text;
    } else {
      const r = must(appendStoreRejection(text, step.rejection.reason, step.rejection.attempted_seq));
      line = r.line;
      text = r.text;
    }
    const { hash: _h, ...rest } = line as unknown as Record<string, unknown>;
    void _h;
    lines.push({
      seq: line.seq,
      fields: rest as Json,
      hashInput: canonicalJson(rest as Json),
      hashInputHex: toHex(hashInputBytes(line as unknown as Record<string, unknown>)),
      hash: line.hash,
      line: serializeLine(line).slice(0, -1),
    });
  }
  return { name, description, lines, storeText: text, storeTextUtf8Hex: Buffer.from(text, "utf8").toString("hex") };
}

const tricky = 'Quote " backslash \\ slash / tab\t newline\n cr\r control \u0001\u001f del \u007f accents é 日本語 emoji 😀 angle <&> end';

const MIXED: Step[] = [
  { approval: { approver: "Alice Example", timestamp: "2025-01-01T12:00:00.000+09:00", target: { kind: "claim_revision", run_id: "run-0001", claim_revision_id: "clm-0001-r1" }, decision: "approved", rationale: "Matches observed behavior.", recorded_by: "human" } },
  { approval: { approver: "Bob Example", timestamp: "2025-01-02T03:04:05Z", target: { kind: "gate", gate_id: "container-runtime" }, decision: "approved", rationale: "Containers allowed for M1.", recorded_by: "kiro-development-agent" } },
  { approval: { approver: "Alice Example", timestamp: "2025-01-03T00:00:00.5-05:30", target: { kind: "claim_revision", run_id: "run-0001", claim_revision_id: "clm-0001-r1" }, decision: "rejected", rationale: tricky, recorded_by: "human", supersedes: 1 } },
  { rejection: { reason: "modify request refused", attempted_seq: 1 } },
  { approval: { approver: "Carol Example", timestamp: "2025-01-04T10:20:30+00:00", target: { kind: "run", run_id: "run-0001" }, decision: "needs_changes", rationale: "More Experiments needed.", recorded_by: "human" } },
];

export function validChainVectors(): Json {
  return {
    format: VECTOR_FORMAT,
    description:
      "Valid Approval_Store chains. Each line is canonical JSON (keys sorted by UTF-16 code unit, no whitespace, UTF-8, no BOM) followed by one LF. hash = lowercase hex SHA-256 of hashInput (the canonical JSON of the line without `hash`). The first prev_hash is genesisHash. Sequence numbers start at 1 without gaps; store_rejection lines take a sequence number too.",
    genesisHash: GENESIS_HASH,
    cases: [
      chainCase("mixed-chain", "approvals of all three target kinds, an actor declaration of each kind, a supersedes line with escapes and non-ASCII text, a store_rejection line", MIXED),
      chainCase("minimal-single-record", "one approval, genesis predecessor", [{ approval: base() as unknown as ApprovalCandidate }]),
      chainCase("limits-at-boundary", "approver of 100 characters, rationale of exactly 2000 code points made of non-BMP characters (4000 UTF-16 code units), offset timestamps", [
        { approval: base({ approver: "a".repeat(100), rationale: "\u{1F600}".repeat(2000), timestamp: "2024-12-31T23:59:59.999999+14:00" }) as unknown as ApprovalCandidate },
        { approval: base({ approver: "\u754c".repeat(100), rationale: " x ", timestamp: "2024-02-29T00:00:00-12:00", decision: "needs_changes" }) as unknown as ApprovalCandidate },
      ]),
      chainCase("only-store-rejection-line", "a store with only a store_rejection line (no approval): every target has status none", [
        { rejection: { reason: "delete request refused" } },
      ]),
    ],
  };
}

// ------------------------------------------------------------------------------------------------
const STATE_STEPS: Step[] = [
  { approval: base({ target: { kind: "gate", gate_id: "container-runtime" }, rationale: "Gate approved." }) as unknown as ApprovalCandidate },
  { approval: base({ decision: "needs_changes" }) as unknown as ApprovalCandidate },
  { approval: base({ decision: "approved", supersedes: 2 }) as unknown as ApprovalCandidate },
  { rejection: { reason: "modify request refused", attempted_seq: 1 } },
];

function stateText(): string {
  let text = "";
  for (const s of STATE_STEPS) {
    text = "approval" in s ? must(appendApproval(text, s.approval, vectorResolver())).text : must(appendStoreRejection(text, s.rejection.reason, s.rejection.attempted_seq)).text;
  }
  return text;
}

interface CandidateCase {
  name: string;
  candidate: Json;
  /** Hand-written: the distinct top-level field names that must be reported, sorted. Empty means accepted. */
  expectedFields: string[];
}
const cc = (name: string, candidate: unknown, expectedFields: string[]): CandidateCase => ({ name, candidate: candidate as Json, expectedFields });

export function candidateValidationVectors(): Json {
  const b = base();
  const cases: CandidateCase[] = [
    cc("positive-run-target", b, []),
    cc("positive-claim-target", base({ target: { kind: "claim_revision", run_id: "run-0001", claim_revision_id: "clm-0001-r1" } }), []),
    cc("positive-gate-target", base({ target: { kind: "gate", gate_id: "m6-start" } }), []),
    cc("positive-supersedes-latest-of-target", base({ supersedes: 3, decision: "rejected" }), []),
    cc("positive-supersedes-gate-record", base({ target: { kind: "gate", gate_id: "container-runtime" }, decision: "rejected", supersedes: 1 }), []),
    cc("positive-actor-agent", base({ recorded_by: "kiro-development-agent" }), []),
    cc("positive-z-offset-and-fraction", base({ timestamp: "2025-03-04T05:06:07.123456Z" }), []),
    cc("missing-approver", without(b, "approver"), ["approver"]),
    cc("missing-timestamp", without(b, "timestamp"), ["timestamp"]),
    cc("missing-target", without(b, "target"), ["target"]),
    cc("missing-decision", without(b, "decision"), ["decision"]),
    cc("missing-rationale", without(b, "rationale"), ["rationale"]),
    cc("missing-recorded-by-actor-declaration", without(b, "recorded_by"), ["recorded_by"]),
    cc("missing-everything", {}, ["approver", "decision", "rationale", "recorded_by", "target", "timestamp"]),
    cc("two-invalid-fields-are-both-named", base({ approver: "", decision: "maybe" }), ["approver", "decision"]),
    cc("empty-approver", base({ approver: "" }), ["approver"]),
    cc("approver-101-characters", base({ approver: "a".repeat(101) }), ["approver"]),
    cc("approver-not-a-string", base({ approver: 7 }), ["approver"]),
    cc("empty-rationale", base({ rationale: "" }), ["rationale"]),
    cc("whitespace-only-rationale", base({ rationale: " \t\n " }), ["rationale"]),
    cc("rationale-2001-characters", base({ rationale: "x".repeat(2001) }), ["rationale"]),
    cc("rationale-2001-code-points-non-bmp", base({ rationale: "\u{1F600}".repeat(2001) }), ["rationale"]),
    cc("decision-outside-set", base({ decision: "maybe" }), ["decision"]),
    cc("decision-wrong-case", base({ decision: "APPROVED" }), ["decision"]),
    cc("timestamp-without-offset", base({ timestamp: "2025-03-04T05:06:07" }), ["timestamp"]),
    cc("timestamp-date-only", base({ timestamp: "2025-03-04" }), ["timestamp"]),
    cc("timestamp-impossible-date", base({ timestamp: "2025-13-45T05:06:07Z" }), ["timestamp"]),
    cc("timestamp-space-separator", base({ timestamp: "2025-03-04 05:06:07Z" }), ["timestamp"]),
    cc("actor-other-value", base({ recorded_by: "robot" }), ["recorded_by"]),
    cc("actor-empty", base({ recorded_by: "" }), ["recorded_by"]),
    cc("actor-wrong-case", base({ recorded_by: "Human" }), ["recorded_by"]),
    cc("target-run-does-not-exist", base({ target: { kind: "run", run_id: "run-9999" } }), ["target"]),
    cc("target-claim-revision-does-not-exist", base({ target: { kind: "claim_revision", run_id: "run-0001", claim_revision_id: "clm-0009-r9" } }), ["target"]),
    cc("target-claim-run-does-not-exist", base({ target: { kind: "claim_revision", run_id: "run-9999", claim_revision_id: "clm-0001-r1" } }), ["target"]),
    cc("target-undefined-gate", base({ target: { kind: "gate", gate_id: "no-such-gate" } }), ["target"]),
    cc("target-claim-without-revision-id", base({ target: { kind: "claim_revision", run_id: "run-0001" } }), ["target"]),
    cc("target-run-with-extra-key", base({ target: { kind: "run", run_id: "run-0001", gate_id: "m6-start" } }), ["target"]),
    cc("target-unknown-kind", base({ target: { kind: "file", path: "x" } }), ["target"]),
    cc("target-run-id-path-traversal", base({ target: { kind: "run", run_id: "../x" } }), ["target"]),
    cc("target-not-an-object", base({ target: "run:run-0001" }), ["target"]),
    cc("caller-supplied-seq", base({ seq: 9 }), ["seq"]),
    cc("caller-supplied-hash", base({ hash: "0".repeat(64) }), ["hash"]),
    cc("caller-supplied-prev-hash", base({ prev_hash: "0".repeat(64) }), ["prev_hash"]),
    cc("unknown-extra-field", base({ approval: "approved" }), ["approval"]),
    cc("supersedes-nonexistent-seq", base({ supersedes: 99 }), ["supersedes"]),
    cc("supersedes-zero", base({ supersedes: 0 }), ["supersedes"]),
    cc("supersedes-not-an-integer", base({ supersedes: "1" }), ["supersedes"]),
    cc("supersedes-different-target", base({ supersedes: 1 }), ["supersedes"]),
    cc("supersedes-already-superseded", base({ supersedes: 2 }), ["supersedes"]),
    cc("supersedes-a-store-rejection-line", base({ supersedes: 4 }), ["supersedes"]),
    cc("supersedes-and-invalid-decision", base({ supersedes: 99, decision: "maybe" }), ["decision", "supersedes"]),
    cc("candidate-is-null", null, ["(record)"]),
    cc("candidate-is-an-array", [], ["(record)"]),
  ];
  return {
    format: VECTOR_FORMAT,
    description:
      "Candidate approval records against a context. context.storeText is a valid store; context.knownRuns and knownClaimRevisions are the only Runs and Claim revisions that exist (every defined Gate identifier resolves). expectedFields is the sorted list of distinct top-level field names that a rejection must name; an empty list means the record is accepted. The writer must leave the store byte-identical on every rejection.",
    context: {
      storeText: stateText(),
      knownRuns: [...KNOWN_RUNS],
      knownClaimRevisions: KNOWN_CLAIM_REVISIONS.map((c) => ({ ...c })),
      stateDescription:
        "1 gate container-runtime approved; 2 run run-0001 needs_changes; 3 run run-0001 approved, supersedes 2; 4 store_rejection (attempted_seq 1)",
    },
    cases: cases as unknown as Json,
  };
}

// ------------------------------------------------------------------------------------------------
interface TamperCase {
  name: string;
  storeText: string;
  anchor?: { seq: number; hash: string };
  expectedOk: boolean;
  /** Hand-written, sorted by seq, then modified < missing < chain_break. */
  expectedMismatches: { seq: number; kind: "modified" | "missing" | "chain_break" }[];
  expectedRuleViolations: { seq: number; rule: string }[];
}

export function tamperVectors(): Json {
  const text = (chainCase("m", "", MIXED).storeText as string);
  const lines = text.split("\n").slice(0, -1); // 5 lines
  const join = (ls: string[], end = "\n"): string => ls.join("\n") + end;
  const parse = (l: string): Record<string, unknown> => JSON.parse(l) as Record<string, unknown>;
  const rehash = (o: Record<string, unknown>): string => {
    const { hash: _h, ...rest } = o;
    void _h;
    return canonicalJson({ ...rest, hash: computeLineHash(rest) } as Json);
  };
  const l1 = lines[0] as string;
  const l2 = lines[1] as string;
  const l3 = lines[2] as string;
  const l4 = lines[3] as string;
  const l5 = lines[4] as string;
  const head = parse(l5);

  const rl2 = parse(l2);
  const modifiedAndRehashed = rehash({ ...rl2, rationale: "Edited after the fact." });
  const withNewPrev = rehash({ ...parse(l1), prev_hash: "1".repeat(64) });
  const badSupersedes = rehash(
    (() => {
      const { hash: _h, ...rest } = parse(l5);
      void _h;
      return { ...rest, seq: 5, supersedes: 2 }; // line 2 is a gate approval; line 5 targets a run
    })(),
  );

  const cases: TamperCase[] = [
    { name: "positive-control-unmodified", storeText: text, expectedOk: true, expectedMismatches: [], expectedRuleViolations: [] },
    { name: "empty-store", storeText: "", expectedOk: true, expectedMismatches: [], expectedRuleViolations: [] },
    { name: "content-modified-without-rehash", storeText: join([l1, l2.replace("Containers allowed for M1.", "Containers allowed for M9."), l3, l4, l5]), expectedOk: false, expectedMismatches: [{ seq: 2, kind: "modified" }], expectedRuleViolations: [] },
    { name: "content-modified-and-rehashed", storeText: join([l1, modifiedAndRehashed, l3, l4, l5]), expectedOk: false, expectedMismatches: [{ seq: 3, kind: "chain_break" }], expectedRuleViolations: [] },
    { name: "record-deleted-from-the-middle", storeText: join([l1, l3, l4, l5]), expectedOk: false, expectedMismatches: [{ seq: 2, kind: "missing" }, { seq: 3, kind: "chain_break" }], expectedRuleViolations: [] },
    { name: "first-record-deleted", storeText: join([l2, l3, l4, l5]), expectedOk: false, expectedMismatches: [{ seq: 1, kind: "missing" }, { seq: 2, kind: "chain_break" }], expectedRuleViolations: [{ seq: 3, rule: "supersedes_unknown" }] }, // line 3 supersedes the deleted record 1
    { name: "record-duplicated", storeText: join([l1, l2, l2, l3, l4, l5]), expectedOk: false, expectedMismatches: [{ seq: 2, kind: "chain_break" }], expectedRuleViolations: [] },
    { name: "two-records-swapped", storeText: join([l1, l3, l2, l4, l5]), expectedOk: false, expectedMismatches: [{ seq: 2, kind: "missing" }, { seq: 2, kind: "chain_break" }, { seq: 3, kind: "chain_break" }, { seq: 4, kind: "chain_break" }], expectedRuleViolations: [] },
    { name: "first-prev-hash-not-genesis-rehashed", storeText: join([withNewPrev, l2, l3, l4, l5]), expectedOk: false, expectedMismatches: [{ seq: 1, kind: "chain_break" }, { seq: 2, kind: "chain_break" }], expectedRuleViolations: [] },
    { name: "tail-truncated-without-anchor-is-not-detectable", storeText: join([l1, l2, l3, l4]), expectedOk: true, expectedMismatches: [], expectedRuleViolations: [] },
    { name: "tail-truncated-with-anchor", storeText: join([l1, l2, l3, l4]), anchor: { seq: 5, hash: head["hash"] as string }, expectedOk: false, expectedMismatches: [{ seq: 5, kind: "missing" }], expectedRuleViolations: [] },
    { name: "last-line-not-newline-terminated", storeText: join([l1, l2, l3, l4, l5], ""), expectedOk: false, expectedMismatches: [{ seq: 5, kind: "modified" }], expectedRuleViolations: [] },
    { name: "line-replaced-by-garbage", storeText: join([l1, l2, "not json", l4, l5]), expectedOk: false, expectedMismatches: [{ seq: 3, kind: "modified" }], expectedRuleViolations: [] },
    { name: "blank-line-inserted", storeText: join([l1, "", l2, l3, l4, l5]), expectedOk: false, expectedMismatches: [{ seq: 2, kind: "modified" }, { seq: 2, kind: "chain_break" }], expectedRuleViolations: [] },
    { name: "non-canonical-whitespace-with-valid-hash", storeText: join([l1, l2.replace('"approver":', '"approver": '), l3, l4, l5]), expectedOk: false, expectedMismatches: [{ seq: 2, kind: "modified" }], expectedRuleViolations: [] },
    { name: "crlf-line-endings", storeText: text.replace(/\n/g, "\r\n"), expectedOk: false, expectedMismatches: [1, 2, 3, 4, 5].map((seq) => ({ seq, kind: "modified" as const })), expectedRuleViolations: [] },
    { name: "supersedes-names-a-record-with-another-target", storeText: join([l1, l2, l3, l4, badSupersedes]), expectedOk: false, expectedMismatches: [], expectedRuleViolations: [{ seq: 5, rule: "supersedes_target_differs" }] },
  ];
  return {
    format: VECTOR_FORMAT,
    description:
      "Store texts that a verifier must accept or reject. Mismatch kinds: modified (line not canonical or not valid, or hash does not match content), missing (absent sequence numbers or absent anchored head), chain_break (prev_hash mismatch, or sequence number repeats or goes backwards). Findings are listed once per (seq, kind), sorted by seq, then modified < missing < chain_break. Truncation of the tail is detected only with an anchor.",
    cases: cases as unknown as Json,
  };
}

/** All vector files by file name. */
export function generateApprovalVectors(): Record<string, Json> {
  return {
    "valid-chains.json": validChainVectors(),
    "candidate-validation.json": candidateValidationVectors(),
    "tamper-cases.json": tamperVectors(),
  };
}
