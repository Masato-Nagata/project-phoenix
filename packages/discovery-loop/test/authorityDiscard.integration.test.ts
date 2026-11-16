// Task 3.10 with the real schemas, the real Evidence_Store of this package and its record store. The gate is the one of `packages/ai-client`.
// Properties use a fixed seed. Synthetic data only; assertions compare names, counts and booleans, never the removed values.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { DEFAULT_MOCK_FIXTURES, DEFAULT_RESPONSE_LIMITS, authorityRuleOf, gateProviderResult, gateResponse, isAuthorityLikeName, tryCanonicalJson } from "../../ai-client/src/index.js";
import type { GateAcceptedHypothesis, GateRejection, Json, SchemaValidatorPort } from "../../ai-client/src/index.js";
import { EvidenceStore, MemoryFileSystem, RunRecordStore, SCHEMAS, createSchemaValidator, discardAiAuthorityFields, isAuthorityLikeName as m1IsAuthorityLikeName } from "../src/index.js";

const FC = { seed: 3_010_001, numRuns: 100 };
const validator = createSchemaValidator() as unknown as SchemaValidatorPort;
const L = DEFAULT_RESPONSE_LIMITS;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const FIXTURE = JSON.parse(new TextDecoder().decode((DEFAULT_MOCK_FIXTURES.find((f) => f.requestKind === "hypothesis_generation") as { response: Uint8Array }).response));
const VALUE_MARK = "VALUE-MARK-3310";

const gate = (tree: unknown) => gateResponse("hypothesis_generation", enc(JSON.stringify(tree)), L, validator);
const accepted = (r: ReturnType<typeof gateResponse>): GateAcceptedHypothesis => {
  if (!r.ok || r.kind === "experiment_generation") throw new Error("expected an accepted Hypothesis");
  return r;
};
const rejected = (r: ReturnType<typeof gateResponse>): GateRejection => {
  if (r.ok) throw new Error("expected a rejection");
  return r;
};
const withClaim0 = (extra: Record<string, unknown>): any => ({ ...structuredClone(FIXTURE), claims: [{ ...structuredClone(FIXTURE.claims[0]), ...extra }] });

describe("a legitimate Claim and the removal, with the real schema", () => {
  it("the Mock_Provider fixture is accepted unchanged, with nothing removed", () => {
    const a = accepted(gate(FIXTURE));
    expect(a.proposal).toEqual(FIXTURE);
    expect(a.discarded).toEqual([]);
  });

  it("each reserved name at the top level of a Claim is removed, the remainder is validated, and the proposal equals the fixture", () => {
    for (const n of ["origin", "evidence", "evidence_status", "approval", "approved"]) {
      const a = accepted(gate(withClaim0({ [n]: { who: VALUE_MARK } })));
      expect(a.proposal, n).toEqual(FIXTURE);
      expect(a.discarded.map((d) => d.name)).toEqual([n]);
      expect(JSON.stringify(a.discarded).includes(VALUE_MARK)).toBe(false);
    }
  });

  it("approval-like text and spellings of the reserved names are removed too (the broad matcher of design item 10)", () => {
    const names = ["Origin", "ORIGIN", "evidenceStatus", "Evidence-Status", "APPROVAL", "Approved", "approvedBy", "approver", "evidenceNote", "source_evidence_status"];
    const extra = Object.fromEntries(names.map((n) => [n, `x ${VALUE_MARK}`]));
    const a = accepted(gate(withClaim0(extra)));
    expect(a.proposal).toEqual(FIXTURE);
    expect(a.discarded.map((d) => d.name).sort()).toEqual([...names].sort());
  });

  it("a value that cannot be written as canonical JSON rejects the whole response even inside a property that would be removed (the stricter reading)", () => {
    for (const v of ["1e300", "-1e999", "9007199254740993"]) {
      const text = JSON.stringify(withClaim0({ origin: "x" })).replace(`"origin":"x"`, `"origin":${v}`);
      expect(rejected(gateResponse("hypothesis_generation", enc(text), L, validator)).reason, v).toMatch(/not_canonicalizable|unsafe_number/);
    }
  });

  it("a Claim that is invalid for another reason stays rejected, and an ordinary undefined field still rejects the whole response", () => {
    const noConfidence = withClaim0({ origin: "x" });
    delete noConfidence.claims[0].confidence;
    expect(rejected(gate(noConfidence)).reason).toBe("schema_violation");
    const unknown = rejected(gate(withClaim0({ origin: "x", approval: "y", notes: "z" })));
    expect([unknown.reason, unknown.issues]).toEqual(["undefined_field", [{ code: "undefined_field", path: "/claims/0/notes" }]]);
    for (const n of ["originator", "my_origin", "original", "disapproved", "proof", "evidenc"]) expect(rejected(gate(withClaim0({ [n]: 1 }))).reason, n).toBe("undefined_field");
  });

  it("an authority-like name nested in a Claim, or at the top of the Hypothesis or the response, rejects the whole response", () => {
    for (const n of ["origin", "evidence", "evidence_status", "approval", "approved"]) {
      const nested = structuredClone(FIXTURE);
      nested.claims[0].condition[n] = "x";
      expect(rejected(gate(nested)).reason, `condition ${n}`).toBe("undefined_field");
      const cit = structuredClone(FIXTURE);
      cit.claims[0].citations[0][n] = "x";
      expect(rejected(gate(cit)).reason, `citation ${n}`).toBe("undefined_field");
      expect(rejected(gate({ ...structuredClone(FIXTURE), [n]: "x" })).reason, `top ${n}`).toBe("undefined_field");
    }
  });

  it("no property of a Claim in the schema is authority-like (a guard: the removal can never take away a defined field)", () => {
    const claimProps = Object.keys(((SCHEMAS["hypothesis-proposal"] as any).$defs.Claim as any).properties);
    expect(claimProps.length).toBeGreaterThan(5);
    for (const k of claimProps) expect(isAuthorityLikeName(k), k).toBe(false);
    for (const top of Object.keys((SCHEMAS["hypothesis-proposal"] as any).properties)) expect(isAuthorityLikeName(top), top).toBe(false);
  });
});

describe("the record of the removal, and the Evidence_Store", () => {
  it("the report of the gate is a valid ai_content_discarded record, without any value", async () => {
    const a = accepted(gate(withClaim0({ origin: VALUE_MARK, approval: VALUE_MARK, evidence_status: VALUE_MARK })));
    const fs = new MemoryFileSystem();
    fs.addDir("/run/out");
    const opened = await RunRecordStore.open(fs, "/run/out", { secrets: {} });
    if (!opened.ok) throw new Error("open");
    const r = await opened.value.append("ai_content_discarded", { aiOutputRecordId: "rec-000001", fields: a.discarded.map((d) => ({ path: d.path, name: d.name })) });
    expect(r.ok).toBe(true);
    const text = new TextDecoder().decode(fs.peek("/run/out/records.jsonl"));
    expect(text.includes(VALUE_MARK)).toBe(false);
    expect(text).toContain('"name":"approval"');
  });

  it("whatever the AI said about Origin, Evidence_Status or approval, the stored Claim revision carries the Origin of the orchestrator", () => {
    const store = new EvidenceStore();
    const a = accepted(gate(withClaim0({ origin: "human-authored", approval: "approved", evidence_status: "supported", evidence: [{ kind: "experiment" }] })));
    const claim = (a.proposal as any).claims[0] as Record<string, Json>;
    const created = store.createClaimRevision({ claimId: "clm-0001", reason: "initial", aiClaim: claim as never, aiOutputRecordId: "rec-000001" });
    if (!created.ok) throw new Error("store");
    expect(created.value.origin).toBe("ai-inferred");
    expect(Object.keys(created.value.content).some((k) => isAuthorityLikeName(k))).toBe(false);
    expect(store.events().filter((e) => e.type === "ai_content_discarded")).toHaveLength(0); // the gate already removed them: the report of the gate is the record to write
  });
});

describe("the matcher equals the one of the Evidence_Store (parity)", () => {
  const pool = ["origin", "evidence", "status", "approval", "approved", "approv", "x", "my", "original", "Origin", "EVIDENCE", "dis", "_", "-", "evidenc", "ｏrigin", " ", ".", "Status", "er", "proof"];
  const nameArb = fc.array(fc.constantFrom(...pool), { minLength: 1, maxLength: 4 }).map((p) => p.join(""));
  it("gives the same answer for any name", () => {
    fc.assert(
      fc.property(fc.oneof(nameArb, fc.string({ maxLength: 12 })), (n) => {
        expect(isAuthorityLikeName(n)).toBe(m1IsAuthorityLikeName(n));
      }),
      FC,
    );
  });
  it("removes the same properties of a Claim as discardAiAuthorityFields", () => {
    fc.assert(
      fc.property(fc.array(nameArb, { maxLength: 8 }), (names) => {
        const claim: Record<string, Json> = { localKey: "k" };
        for (const n of names) if (n !== "localKey") claim[n] = 1;
        const m1 = discardAiAuthorityFields(claim as never).discarded.map((d) => d.name).sort();
        const mine = Object.keys(claim).filter((n) => authorityRuleOf(n) !== undefined).sort();
        expect(mine).toEqual(m1);
      }),
      FC,
    );
  });
});

describe("Properties of the removal (seed 3010001)", () => {
  const word = fc.constantFrom("origin", "evidence", "evidence_status", "approval", "approved", "approvedBy", "evidenceNote", "source_evidence_status", "approver", "Evidence-Status", "ORIGIN");
  // Values that can be written as canonical JSON: a value that cannot is a reason to reject the whole response, also inside a property that would be removed.
  const valueArb: fc.Arbitrary<Json> = fc.jsonValue({ maxDepth: 2 }).filter((v) => tryCanonicalJson(v).ok) as fc.Arbitrary<Json>;
  const NEAR = ["originator", "my_origin", "original", "disapproved", "proof", "evidenc", "notes", "zzfield", "ｏｒｉｇｉｎ", "ev idence", "my.origin"];

  it("any set of authority-like names, with any values, is removed; the result is the same whatever the values are", () => {
    fc.assert(
      fc.property(fc.uniqueArray(word, { minLength: 1, maxLength: 8 }), fc.array(valueArb, { minLength: 8, maxLength: 8 }), fc.array(valueArb, { minLength: 8, maxLength: 8 }), (names, v1, v2) => {
        const a = accepted(gate(withClaim0(Object.fromEntries(names.map((n, i) => [n, v1[i]])))));
        const b = accepted(gate(withClaim0(Object.fromEntries(names.map((n, i) => [n, v2[i]])))));
        expect(a.proposal).toEqual(FIXTURE);
        expect(b.proposal).toEqual(a.proposal);
        expect(a.discarded).toEqual(b.discarded);
        expect(a.discarded.map((d) => d.name).sort()).toEqual([...names].sort());
      }),
      FC,
    );
  });

  it("one name outside the matcher rejects the whole response, with any authority-like names beside it, and reports no removal", () => {
    fc.assert(
      fc.property(fc.uniqueArray(word, { maxLength: 5 }), fc.constantFrom(...NEAR), (names, near) => {
        const r = rejected(gate(withClaim0({ ...Object.fromEntries(names.map((n) => [n, 1])), [near]: 1 })));
        expect(r.reason).toBe("undefined_field");
        expect("discarded" in r).toBe(false);
      }),
      FC,
    );
  });

  it("an authority-like name anywhere but the top level of a Claim rejects the whole response", () => {
    fc.assert(
      fc.property(word, fc.constantFrom("condition", "effect", "response", "citation", "hypothesis", "derived"), (name, where) => {
        const t = structuredClone(FIXTURE);
        const target = { condition: t.claims[0].condition, effect: t.claims[0].effect, response: t.claims[0].effect.response, citation: t.claims[0].citations[0], hypothesis: t, derived: t.derived[0] }[where];
        target[name] = 1;
        expect(rejected(gate(t)).reason, `${name} in ${where}`).toBe("undefined_field");
      }),
      FC,
    );
  });

  it("the removal depends on the name only: it equals an independent statement of R4.17 for any name", () => {
    const oracle = (name: string): boolean => {
      const n = [...name.toLowerCase()].filter((c) => c !== "_" && c !== "-").join("");
      return n === "origin" || n.startsWith("evidence") || n.endsWith("evidencestatus") || n.startsWith("approv");
    };
    const parts = ["origin", "Origin", "evidence", "Evidence", "status", "Status", "approval", "approved", "my", "dis", "er", "_", "-", "x", "ｏ", "\u200b", " ", "."];
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...parts), { minLength: 1, maxLength: 5 }).map((p) => p.join("")).filter((n) => !["localKey", "condition", "effect", "confidence", "openQuestions", "citations", "revises", "threshold"].includes(n)), (name) => {
        const r = gate(withClaim0({ [name]: 1 }));
        if (oracle(name)) {
          expect(accepted(r).discarded.length, `${name} was not removed`).toBe(1);
        } else {
          expect(rejected(r).reason, `${name} was not rejected`).toBe("undefined_field");
        }
      }),
      { ...FC, numRuns: 200 },
    );
  });

  it("a removed value never reaches a result, a report or a rejection", () => {
    fc.assert(
      fc.property(fc.uniqueArray(word, { minLength: 1, maxLength: 5 }), fc.boolean(), (names, breakIt) => {
        const extra: Record<string, unknown> = Object.fromEntries(names.map((n) => [n, VALUE_MARK]));
        if (breakIt) extra["zzfield"] = VALUE_MARK; // makes the whole response a rejection
        const out = gateProviderResult("hypothesis_generation", { ok: true, value: enc(JSON.stringify(withClaim0(extra))) }, L, validator);
        expect(JSON.stringify(out, (_k, v) => (v instanceof Uint8Array ? undefined : v)).includes(VALUE_MARK), "a removed value was carried on").toBe(false);
        expect(out.kind).toBe(breakIt ? "failed_call" : "accepted");
      }),
      FC,
    );
  });
});