import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as runtime from "../src/index.js";
import { ApprovalReader, type TargetResolver } from "../src/approval/index.js";
import { buildChain } from "../src/approval/tooling.js";
import { EvidenceStore, type EvidenceRecord } from "../src/index.js";
import * as report from "../src/report/index.js";
import { createFactsQuery, escapeText, renderEntry, renderReportText } from "../src/report/index.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const RUN = "run-0001";
const anyTarget: TargetResolver = { resolves: () => true };

function approvalsFor(...decisions: { rev: string; decision: "approved" | "rejected" | "needs_changes"; supersedes?: number }[]): ApprovalReader {
  const cands = decisions.map((d) => ({
    approver: "Alice Example",
    timestamp: "2025-03-04T05:06:07.000+09:00",
    target: { kind: "claim_revision", run_id: RUN, claim_revision_id: d.rev },
    decision: d.decision,
    rationale: "Reviewed.",
    recorded_by: "human",
    ...(d.supersedes === undefined ? {} : { supersedes: d.supersedes }),
  }));
  const built = buildChain(cands, anyTarget);
  if (!built.ok) throw new Error(JSON.stringify(built.error));
  return ApprovalReader.fromBytes(built.value.text, anyTarget);
}

function setup() {
  const store = new EvidenceStore();
  const mk = (claimId: string) => {
    const r = store.createClaimRevision({ claimId, reason: "initial", aiClaim: { effect: "x" }, aiOutputRecordId: "rec-000005" });
    if (!r.ok) throw new Error("setup");
    return r.value.claimRevisionId;
  };
  const add = (record: unknown, component: string) => {
    const r = store.appendEvidence({ component, record } as never);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return (r.value as EvidenceRecord).evidenceId;
  };
  return { store, mk, add };
}
const exp = (rev: string, id: string, outcome: string) => ({
  evidenceId: id, kind: "experiment", claimRevisionId: rev, outcome, experimentId: "exp-1",
  comparisonRecordId: "rec-000020", observationRecordId: "rec-000021", predictionRecordId: "rec-000022",
});
const rule = { supports: "match", contradicts: "mismatch", inconclusive: "not_comparable" } as const;
const src = (rev: string, id: string, results: ("verified" | "failed")[]) => ({
  evidenceId: id, kind: "source", claimRevisionId: rev, citationRecordId: "rec-000010",
  citations: results.map((result, index) => (result === "failed" ? { index, result, reason: "quote_not_found" } : { index, result })),
});

describe("four-facts query (R6.10, R6.19)", () => {
  it("returns four separate fields and nothing combined", () => {
    const { store, mk } = setup();
    const rev = mk("clm-1");
    const q = createFactsQuery(store, RUN, approvalsFor());
    const r = q.facts(rev);
    expect(r).toEqual({
      ok: true,
      value: { claimRevisionId: rev, origin: "ai-inferred", sourceEvidenceStatus: "absent", experimentEvidenceStatus: "absent", approvalStatus: "none" },
    });
    expect(Object.keys((r as { value: object }).value).sort()).toEqual(
      ["approvalStatus", "claimRevisionId", "experimentEvidenceStatus", "origin", "sourceEvidenceStatus"],
    );
  });

  it("unknown id is an error naming the id, never a default", () => {
    const { store } = setup();
    const q = createFactsQuery(store, RUN, approvalsFor());
    for (const r of [q.facts("clm-nope-r9"), q.contradictingEvidence("clm-nope-r9"), q.entry("clm-nope-r9")]) {
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error.kind).toBe("unknown_id");
        expect(r.error.message).toContain("clm-nope-r9");
      }
    }
  });

  it("approval comes from the Approval_Store; the four facts stay independent", () => {
    const { store, mk, add } = setup();
    const rev = mk("clm-1");
    add(exp(rev, "ev-1", "contradicts"), `experiment_rule:${rule.contradicts}`);
    const q = createFactsQuery(store, RUN, approvalsFor({ rev, decision: "approved" }));
    const f = q.facts(rev);
    expect(f.ok && f.value.approvalStatus).toBe("approved");
    expect(f.ok && f.value.experimentEvidenceStatus).toBe("contradicted");
    expect(f.ok && f.value.sourceEvidenceStatus).toBe("absent");
  });

  it("an Approval_Store that does not verify is an error, not `none`", () => {
    const { store, mk } = setup();
    const rev = mk("clm-1");
    const bad = ApprovalReader.fromBytes("not json\n", anyTarget);
    const r = createFactsQuery(store, RUN, bad).facts(rev);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe("approval_unavailable");
  });

  it("allFacts is ordered by claim id, then revision", () => {
    const { store, mk } = setup();
    const b1 = mk("clm-b");
    const a1 = mk("clm-a");
    const a2 = mk("clm-a");
    const r = createFactsQuery(store, RUN, approvalsFor()).allFacts();
    expect(r.ok && r.value.map((f) => f.claimRevisionId)).toEqual([a1, a2, b1]);
  });

  it("contradictingEvidence lists every contradicting record, with no cap", () => {
    const { store, mk, add } = setup();
    const rev = mk("clm-1");
    const ids: string[] = [];
    for (let i = 0; i < 25; i += 1) ids.push(add(exp(rev, `ev-${i}`, "contradicts"), `experiment_rule:${rule.contradicts}`));
    add(exp(rev, "ev-s", "supports"), `experiment_rule:${rule.supports}`);
    const r = createFactsQuery(store, RUN, approvalsFor()).contradictingEvidence(rev);
    expect(r).toEqual({ ok: true, value: ids });
  });
});

describe("report renderer (R6.12, R6.13)", () => {
  it("shows a contradicted/mixed status and every contradicting id next to supported and approved", () => {
    const { store, mk, add } = setup();
    const rev = mk("clm-1");
    add(src(rev, "ev-src", ["verified", "verified"]), "citation_verifier");
    add(exp(rev, "ev-ok", "supports"), `experiment_rule:${rule.supports}`);
    const bad: string[] = [];
    for (let i = 0; i < 12; i += 1) bad.push(add(exp(rev, `ev-bad-${i}`, "contradicts"), `experiment_rule:${rule.contradicts}`));
    const q = createFactsQuery(store, RUN, approvalsFor({ rev, decision: "approved" }));
    const entries = q.entries();
    expect(entries.ok).toBe(true);
    if (!entries.ok) return;
    const text = renderReportText(entries.value);
    expect(text).toContain("Source evidence status: supported");
    expect(text).toContain("Experiment evidence status: mixed");
    expect(text).toContain("Approval status: approved");
    expect(text).toContain(`Contradicting evidence (12): ${bad.join(", ")}`);
    // Same entry: one block only, containing all of the above.
    expect(text.split("\n\n")).toHaveLength(1);
  });

  it("shows `contradicted` for a source record with failed Citations, in the entry of an approved revision", () => {
    const { store, mk, add } = setup();
    const rev = mk("clm-1");
    add(src(rev, "ev-src", ["failed"]), "citation_verifier");
    const e = createFactsQuery(store, RUN, approvalsFor({ rev, decision: "approved" })).entry(rev);
    expect(e.ok).toBe(true);
    if (!e.ok) return;
    const block = renderEntry(e.value);
    expect(block).toContain("Source evidence status: contradicted");
    expect(block).toContain("Approval status: approved");
    expect(block).toContain("Contradicting evidence (1): ev-src");
  });

  it("renders four labelled lines and no combined value; empty contradiction list is explicit", () => {
    const { store, mk } = setup();
    const rev = mk("clm-1");
    const e = createFactsQuery(store, RUN, approvalsFor()).entry(rev);
    if (!e.ok) throw new Error("setup");
    const block = renderEntry(e.value);
    expect(block).toContain("Origin: ai-inferred");
    expect(block).toContain("Contradicting evidence (0): none");
    expect(block).not.toMatch(/score|rank|overall|verified claim/i);
  });

  it("escapes markup, markdown, control and non-ASCII characters", () => {
    const hostile = "<script>alert(1)</script>\n[x](http://e)\u001b[31m `a` *b* | é 😀";
    const out = escapeText(hostile);
    expect(out).not.toMatch(/[<>\[\]`*|\n\u001b]/);
    expect(out).toContain("\\u003c");
    expect(out).toContain("\\u{1f600}");
    const entry = {
      facts: { claimRevisionId: hostile, origin: "ai-inferred", sourceEvidenceStatus: "absent", experimentEvidenceStatus: "absent", approvalStatus: "none" },
      evidenceIds: [hostile],
      contradictingEvidenceIds: [hostile],
    } as const;
    const text = renderEntry(entry as never);
    expect(text).not.toMatch(/[<>\[\]`*|\u001b]/);
  });
});

// --- static dependency check: the runtime entry point does not reach the report or the Approval reader ---

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["'](\.[^"']*)["']/g;

function resolveModule(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ""));
  for (const c of [`${base}.ts`, resolve(base, "index.ts")]) if (existsSync(c)) return c;
  return undefined;
}

/** All files reachable from `entry` through relative import/export statements. */
function reachable(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];
  while (stack.length > 0) {
    const f = stack.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(f, "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const target = resolveModule(f, m[1] as string);
      if (target !== undefined) stack.push(target);
    }
  }
  return [...seen];
}

const forbidden = (f: string): boolean => {
  const rel = f.startsWith(SRC) ? f.slice(SRC.length) : f;
  return rel.startsWith(`approval${sep}`) || rel.startsWith(`report${sep}`);
};

describe("runtime entry point isolation (R6.11, design report entry point)", () => {
  it("does not import (transitively) the report or the Approval reader/validator", () => {
    const files = reachable(resolve(SRC, "index.ts"));
    expect(files.length).toBeGreaterThan(5);
    expect(files.filter(forbidden)).toEqual([]);
  });

  it("positive control: a fixture entry that re-exports the reader is detected", () => {
    const fixture = fileURLToPath(new URL("./fixtures/runtimeLeak/entry.ts", import.meta.url));
    const files = reachable(fixture);
    expect(files.filter(forbidden).map((f) => f.slice(SRC.length))).toContain(`approval${sep}reader.ts`);
  });

  it("does not export the report or approval names", () => {
    const names = Object.keys(runtime).join(",");
    expect(names).not.toMatch(/createFactsQuery|renderReportText|renderEntry|readFacts|ApprovalReader|asApprovalStatusReader/);
    expect(Object.keys(report)).toEqual(expect.arrayContaining(["createFactsQuery", "renderReportText"]));
  });
});
