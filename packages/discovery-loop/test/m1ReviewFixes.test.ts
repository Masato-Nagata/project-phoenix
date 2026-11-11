// Tests of task 1.26 (M1 review resolutions 1, 4, 6 and 7).
// This test file is the only place that imports the analyzer's sources; packages/discovery-loop has no
// runtime dependency on packages/analyzer (resolution 4).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LOCAL_KEY_PATTERN, SCHEMAS, createSchemaValidator, deriveSourceStatus, type EvidenceRecord } from "../src/index.js";
import { ApprovalReader, analyzeStore, type TargetResolver } from "../src/approval/index.js";
import { EXPR_LIMITS, EXPR_OPERATORS } from "../../analyzer/src/expr/types.js";
import { NAME_RE } from "../../analyzer/src/expr/validate.js";
import { validateDeclarations, validateExpr } from "../../analyzer/src/expr/index.js";
import { FIXTURE_SETS } from "./fixtures/schemaFixtures.js";

const validator = createSchemaValidator();

describe("duplicated definitions of the two packages are equal (resolution 4)", () => {
  it("LocalKey pattern", () => {
    expect(LOCAL_KEY_PATTERN).toBe("^[a-z][a-z0-9_]{0,31}$");
    expect(NAME_RE.source).toBe(LOCAL_KEY_PATTERN);
    const common = SCHEMAS["common"]["$defs"] as Record<string, { pattern?: string }>;
    expect(common["LocalKey"]?.pattern).toBe(NAME_RE.source);
  });

  it("agree on accepted and rejected names, in the schema and in the analyzer", () => {
    const names = [
      "a", "z9", "a_b", "a".repeat(32), "a".repeat(33), "A", "Ab", "aB", "_a", "1a", "a-b", "a b", "", "base_cost",
      "d0", "Zed", "a.b", "é", "a".repeat(64),
    ];
    const proposal = FIXTURE_SETS.find((s) => s.schema === "hypothesis-proposal")?.valid.find((v) => v.id === "full proposal")?.value;
    expect(proposal).toBeDefined();
    for (const n of names) {
      const analyzerOk = validateDeclarations([{ name: n, expr: { op: "lit", value: 1 } }], []).ok;
      const copy = structuredClone(proposal) as { derived: { name: string }[] };
      copy.derived[0]!.name = n;
      expect(validator.validate("hypothesis-proposal", copy).ok, `derived name ${JSON.stringify(n)}`).toBe(analyzerOk);
      expect(NAME_RE.test(n), n).toBe(analyzerOk);
      const tableOk = validateDeclarations([], [{ name: n, entries: [{ key: 1, value: 1 }] }]).ok;
      expect(tableOk, `table name ${JSON.stringify(n)}`).toBe(analyzerOk);
    }
  });

  it("names referenced by derived and lookup are checked by both validators", () => {
    const widenedOnly = ["Base_cost", "_cost", "a".repeat(33)];
    for (const n of widenedOnly) {
      const shape = { derivedNames: [n], tableNames: [n] };
      expect(validateExpr({ op: "derived", name: n }, shape).ok, n).toBe(false);
      expect(validateExpr({ op: "lookup", table: n, key: { op: "lit", value: 1 } }, shape).ok, n).toBe(false);
      expect(validator.validate("rule-expression", { op: "derived", name: n }).ok, n).toBe(false);
      expect(validator.validate("rule-expression", { op: "lookup", table: n, key: { op: "lit", value: 1 } }).ok, n).toBe(false);
    }
    expect(validator.validate("rule-expression", { op: "derived", name: "a".repeat(32) }).ok).toBe(true);
  });

  it("Scalar range and string length", () => {
    const scalar = (SCHEMAS["common"]["$defs"] as Record<string, Record<string, unknown>>)["Scalar"]!;
    expect(scalar["maximum"]).toBe(EXPR_LIMITS.maxSafeInteger);
    expect(scalar["minimum"]).toBe(-EXPR_LIMITS.maxSafeInteger);
    expect(scalar["maxLength"]).toBe(EXPR_LIMITS.maxStringLength);
  });

  it("Expr operator set", () => {
    const defs = SCHEMAS["rule-expression"]["$defs"] as Record<string, { properties?: { op?: { const?: string; enum?: string[] } } }>;
    const schemaOps: string[] = [];
    for (const d of Object.values(defs)) {
      const op = d.properties?.op;
      if (op?.const !== undefined) schemaOps.push(op.const);
      if (op?.enum !== undefined) schemaOps.push(...op.enum);
    }
    expect(schemaOps.sort()).toEqual([...EXPR_OPERATORS].sort());
  });
});

describe("source Evidence_Status pools all source outcomes (resolution 6)", () => {
  const rec = (id: string, results: ("verified" | "failed")[]): EvidenceRecord =>
    ({ evidenceId: id, kind: "source", citations: results.map((result) => ({ result })) }) as unknown as EvidenceRecord;

  it("depends on the multiset of outcomes across records, not on record boundaries or order", () => {
    expect(deriveSourceStatus([rec("a", ["verified"]), rec("b", ["failed"])])).toBe("mixed");
    expect(deriveSourceStatus([rec("b", ["failed"]), rec("a", ["verified"])])).toBe("mixed");
    expect(deriveSourceStatus([rec("a", ["verified", "failed"])])).toBe("mixed");
    expect(deriveSourceStatus([rec("a", ["verified"]), rec("b", ["verified"])])).toBe("supported");
    expect(deriveSourceStatus([rec("a", ["failed"]), rec("b", ["failed"])])).toBe("contradicted");
    expect(deriveSourceStatus([rec("a", [])])).toBe("absent");
    expect(deriveSourceStatus([])).toBe("absent");
  });
});

describe("Approval reader makes no completeness claim without an anchor (resolution 7)", () => {
  const vectors = JSON.parse(
    readFileSync(fileURLToPath(new URL("../test-vectors/approval/tamper-cases.json", import.meta.url)), "utf8"),
  ) as { cases: { name: string; storeText: string }[] };
  const text = (name: string): string => {
    const c = vectors.cases.find((x) => x.name === name);
    if (c === undefined) throw new Error(`missing vector ${name}`);
    return c.storeText;
  };
  const resolver: TargetResolver = { resolves: () => true };
  const full = text("positive-control-unmodified");
  const truncated = text("tail-truncated-without-anchor-is-not-detectable");
  const head = analyzeStore(full).state.lines.at(-1)!;
  const anchor = { seq: head.seq, hash: head.hash };

  it("without an anchor, a verified store reports tailTruncation not_checked", () => {
    expect(ApprovalReader.fromBytes(full, resolver).verify()).toMatchObject({ ok: true, tailTruncation: "not_checked" });
    expect(analyzeStore("").report).toMatchObject({ ok: true, tailTruncation: "not_checked" });
  });

  it("a truncated chain verifies without mismatch but is not reported as complete when no anchor is supplied", () => {
    const r = ApprovalReader.fromBytes(truncated, resolver).verify();
    expect(r.mismatches).toEqual([]);
    expect(r.tailTruncation).toBe("not_checked");
  });

  it("with a correct anchor the full store is reported as excluded, and the truncation is reported", () => {
    expect(ApprovalReader.fromBytes(full, resolver, { anchor }).verify()).toMatchObject({ ok: true, tailTruncation: "excluded_by_anchor" });
    const t = ApprovalReader.fromBytes(truncated, resolver, { anchor }).verify();
    expect(t.ok).toBe(false);
    expect(t.tailTruncation).toBe("not_checked");
    expect(t.mismatches.map((m) => ({ seq: m.seq, kind: m.kind }))).toEqual([{ seq: anchor.seq, kind: "missing" }]);
  });

  it("a wrong anchor hash is a mismatch and never an exclusion", () => {
    const r = ApprovalReader.fromBytes(full, resolver, { anchor: { seq: anchor.seq, hash: "f".repeat(64) } }).verify();
    expect(r.ok).toBe(false);
    expect(r.tailTruncation).toBe("not_checked");
  });
});
