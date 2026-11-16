// Task 3.10: authority-like properties at the top level of a Claim are removed before the schema check (C1; R4.11, R4.16, R4.17, R6.16, R23.4, R23.6).
// Mechanics, with a stand-in validator that is closed on the Hypothesis and on a Claim and records what it is given. Synthetic data only.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_RESPONSE_LIMITS, authorityRuleOf, gateProviderResult, gateResponse, isAuthorityLikeName } from "../src/index.js";
import type { GateAcceptedHypothesis, GateRejection, Json, Result, SchemaIssue, SchemaValidatorPort } from "../src/index.js";

const MARK = "SECRET-AUTHORITY-VALUE-5521";
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const L = DEFAULT_RESPONSE_LIMITS;
const isObj = (v: unknown): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);
const CLAIM_KEYS = ["localKey", "condition", "effect", "confidence", "openQuestions", "citations", "revises", "threshold"];

/** Closed on the Hypothesis (claims, derived, tables) and on a Claim; remembers every value it was asked to validate. */
function closedValidator(): SchemaValidatorPort & { seen: Json[] } {
  const seen: Json[] = [];
  return {
    seen,
    validate(name: string, value: unknown): Result<Json, readonly SchemaIssue[]> {
      seen.push(structuredClone(value) as Json);
      const issues: SchemaIssue[] = [];
      if (name !== "hypothesis-proposal" || !isObj(value) || !Array.isArray(value["claims"])) return { ok: false, error: [{ code: "bad_type", path: "" }] };
      for (const k of Object.keys(value)) if (!["claims", "derived", "tables"].includes(k)) issues.push({ code: "undefined_field", path: `/${k}` });
      value["claims"].forEach((c, i) => {
        if (!isObj(c)) { issues.push({ code: "bad_type", path: `/claims/${i}` }); return; }
        for (const k of Object.keys(c)) if (!CLAIM_KEYS.includes(k)) issues.push({ code: "undefined_field", path: `/claims/${i}/${k}` });
        for (const k of ["localKey", "confidence"]) if (!(k in c)) issues.push({ code: "missing_field", path: `/claims/${i}/${k}` });
        for (const nested of ["condition", "effect"]) {
          const n = c[nested];
          if (isObj(n)) for (const k of Object.keys(n)) if (!["description", "expression", "response"].includes(k)) issues.push({ code: "undefined_field", path: `/claims/${i}/${nested}/${k}` });
        }
      });
      return issues.length > 0 ? { ok: false, error: issues } : { ok: true, value: value as Json };
    },
  };
}
const claim = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  localKey: "c1", condition: { description: "d", expression: { op: "lit", value: 1 } }, effect: { description: "e", response: {} }, confidence: "low", openQuestions: [], citations: [], ...over,
});
const run = (claims: unknown[], extra: Record<string, unknown> = {}, v = closedValidator()) => ({ r: gateResponse("hypothesis_generation", enc(JSON.stringify({ claims, ...extra })), L, v), v });
const accepted = (r: ReturnType<typeof gateResponse>): GateAcceptedHypothesis => {
  if (!r.ok || r.kind === "experiment_generation") throw new Error("expected an accepted Hypothesis");
  return r;
};
const rejected = (r: ReturnType<typeof gateResponse>): GateRejection => {
  if (r.ok) throw new Error("expected a rejection");
  return r;
};

describe("the matcher (R4.17)", () => {
  it("equals origin, starts with evidence, ends with evidencestatus, or starts with approv, after lower case and removal of _ and -", () => {
    for (const n of ["origin", "Origin", "ORIGIN", "or-igin", "o_r_i_g_i_n", "evidence", "evidences", "evidence status", "evidence.status", "evidenceNote", "evidence_status", "Evidence-Status", "EVIDENCE_STATUS",
      "source_evidence_status", "evidenceStatus", "approval", "approved", "approvedBy", "approver", "Approval_Status", "approv"]) {
      expect(isAuthorityLikeName(n), n).toBe(true);
    }
    for (const n of ["originator", "my_origin", "original", "disapproved", "proof", "evidenc", "localKey", "confidence", "citations", "threshold", "openQuestions",
      "revises", "effect", "condition", "claims", "derived", "tables", "xevidence status", "x.evidence", "approx"]) {
      expect(isAuthorityLikeName(n), n).toBe(false);
    }
  });
  it("does not remove spaces, dots, width forms or invisible characters, so such a notation is not authority-like", () => {
    for (const n of ["ｏｒｉｇｉｎ", "orig\u200bin", "origin\u0000".slice(0, 5) + "\u0307n", "ev idence", "my.origin", "ａpproval", "origin ".trimStart() + "\u00a0"]) {
      expect(isAuthorityLikeName(n), n).toBe(n === "origin\u00a0" ? false : false);
    }
    expect(authorityRuleOf("evidence_status")).toBe("evidence_prefix");
    expect(authorityRuleOf("source_evidence_status")).toBe("evidence_status_suffix");
    expect(authorityRuleOf("approved")).toBe("approval_prefix");
    expect(authorityRuleOf("Origin")).toBe("origin");
    expect(authorityRuleOf("proof")).toBeUndefined();
  });
  it("the Claim properties of the schema are none of them authority-like (a drift guard for the list above)", () => {
    for (const k of CLAIM_KEYS) expect(isAuthorityLikeName(k), k).toBe(false);
  });
});

describe("removal at the top level of a Claim, before the schema check", () => {
  it("removes each reserved name and every other authority-like name, and accepts the rest", () => {
    const names = ["origin", "evidence", "evidence_status", "approval", "approved", "Origin", "EVIDENCE", "evidenceStatus", "Evidence-Status", "APPROVAL", "approvedBy", "evidenceNote", "source_evidence_status", "approver"];
    const claims = [claim({ [names[0] as string]: "human-authored" }), claim({ localKey: "c2" })];
    for (const n of names) (claims[1] as Record<string, unknown>)[n] = { status: "supported", by: MARK };
    const { r, v } = run(claims);
    const a = accepted(r);
    const out = (a.proposal as { claims: Record<string, unknown>[] }).claims;
    expect(out).toHaveLength(2);
    for (const c of out) for (const k of Object.keys(c)) expect(isAuthorityLikeName(k), `authority-like name ${k} was kept`).toBe(false);
    expect(Object.keys(out[1] as object).sort()).toEqual(Object.keys(claim({ localKey: "c2" })).sort());
    expect(a.discarded.map((d) => [d.claimIndex, d.path, d.name]).sort()).toEqual([[0, "/claims/0", "origin"], ...names.map((n) => [1, "/claims/1", n])].sort());
    // the validator saw the remainder only
    expect(JSON.stringify(v.seen).includes(MARK)).toBe(false);
    expect(v.seen).toHaveLength(1);
  });

  it("reports the removal by name and place only, and the exact received bytes are still the ones identified", () => {
    const text = JSON.stringify({ claims: [claim({ origin: MARK })] });
    const r = gateResponse("hypothesis_revision", enc(text), L, closedValidator());
    const a = accepted(r);
    expect(a.discarded).toEqual([{ claimIndex: 0, path: "/claims/0", name: "origin", rule: "origin" }]);
    expect(JSON.stringify(a.discarded).includes(MARK)).toBe(false);
    expect(a.byteLength).toBe(enc(text).length); // the received bytes (with the field) are what is stored (R17.8)
    expect(JSON.stringify(a.proposal).includes("origin")).toBe(false);
  });

  it("does not trust anything the AI said: the value of a removed field has no effect on the result", () => {
    const values: Json[] = ["human-authored", "ai-inferred", "supported", "approved", "contradicted", true, 1, null, [], { status: "supported" }, { origin: "human-authored" }, "x".repeat(5000)];
    const base = JSON.stringify(accepted(run([claim()]).r).proposal);
    for (const v of values) {
      const a = accepted(run([claim({ origin: v, evidence_status: v, approval: v, approved: v, evidence: v })]).r);
      expect(JSON.stringify(a.proposal), JSON.stringify(v).slice(0, 30)).toBe(base);
      expect(a.discarded.map((d) => d.name).sort()).toEqual(["approval", "approved", "evidence", "evidence_status", "origin"]);
    }
  });

  it("removes a name that differs only by case or separators, also when two such names are present", () => {
    const a = accepted(run([claim({ origin: 1, Origin: 2, "or-igin": 3, ORIGIN: 4 })]).r);
    expect(a.discarded).toHaveLength(4);
    expect(Object.keys((a.proposal as { claims: object[] }).claims[0] as object)).not.toContain("Origin");
  });

  it("writes an untrusted name into the report only if it is a short identifier-like name; otherwise as <key>, with the rule kept", () => {
    const hostile = `evidence ${MARK} with spaces`;
    const longName = `evidence_${"a".repeat(80)}`;
    const a = accepted(run([claim({ [hostile]: 1, [longName]: 2, "evidence_ok": 3 })]).r);
    expect(a.discarded.map((d) => d.name).sort()).toEqual(["<key>", "<key>", "evidence_ok"].sort());
    expect(a.discarded.every((d) => d.rule === "evidence_prefix")).toBe(true);
    expect(JSON.stringify(a).includes(MARK)).toBe(false);
  });

  it("the original response bytes and the parsed tree are not changed by the removal (it works on a copy)", () => {
    const bytes = enc(JSON.stringify({ claims: [claim({ origin: "x" })] }));
    const copy = bytes.slice();
    accepted(gateResponse("hypothesis_generation", bytes, L, closedValidator()));
    expect(bytes).toEqual(copy);
  });
});

describe("what is not removed, and so rejects the whole response", () => {
  it("an ordinary undefined field in a Claim, also next to an authority-like one", () => {
    const { r, v } = run([claim({ origin: "x", approval: "y", notes: "z" })]);
    const rej = rejected(r);
    expect([rej.reason, rej.issues]).toEqual(["undefined_field", [{ code: "undefined_field", path: "/claims/0/notes" }]]);
    expect("discarded" in rej).toBe(false);
    expect(JSON.stringify(v.seen).includes("origin")).toBe(false); // the check ran on the remainder
  });

  it("names that only look close: originator, my_origin, original, disapproved, proof, evidenc", () => {
    for (const n of ["originator", "my_origin", "original", "disapproved", "proof", "evidenc"]) {
      expect(rejected(run([claim({ [n]: "x" })]).r).reason, n).toBe("undefined_field");
    }
  });

  it("a notation that the matcher does not cover: fullwidth letters, an invisible character, a space or a dot", () => {
    for (const n of ["ｏｒｉｇｉｎ", "orig\u200bin", "ev idence", "my.origin", "ａpproval", "or igin"]) {
      expect(rejected(run([claim({ [n]: "x" })]).r).reason, n).toBe("undefined_field");
    }
  });

  it("an authority-like name nested anywhere in a Claim, at the top of the Hypothesis, or at the top of the response", () => {
    for (const n of ["origin", "evidence", "evidence_status", "approval", "approved", "Origin", "approvedBy"]) {
      const places: [string, () => ReturnType<typeof run>][] = [
        ["condition", () => run([claim({ condition: { description: "d", [n]: "x" } })])],
        ["effect", () => run([claim({ effect: { description: "e", [n]: "x" } })])],
        ["hypothesis top", () => run([claim()], { [n]: "x" })],
      ];
      for (const [where, f] of places) expect(rejected(f().r).reason, `${n} in ${where}`).toBe("undefined_field");
    }
    const arr = gateResponse("hypothesis_generation", enc(JSON.stringify([{ origin: 1 }])), L, closedValidator());
    expect(rejected(arr).reason).toBe("schema_violation");
  });

  it("a Claim that is not an object, or a response without a claims array, is left to the schema", () => {
    expect(rejected(run([7, "x", null]).r).reason).toBe("schema_violation");
    expect(rejected(gateResponse("hypothesis_generation", enc('{"origin":1}'), L, closedValidator())).reason).toBe("schema_violation");
  });

  it("removal does not make an invalid Claim valid: a Claim that lacks a required field stays rejected", () => {
    const c = claim({ origin: "x" }) as Record<string, unknown>;
    delete c["confidence"];
    expect(rejected(run([c]).r).reason).toBe("schema_violation");
  });

  it("Experiment responses are not touched: an authority-like name there is an undefined field", () => {
    const v = closedValidator();
    const r = gateResponse("experiment_generation", enc(JSON.stringify({ experiments: [{ localKey: "e", requests: [], origin: "x" }] })), L, {
      validate: (name, value) => (name === "experiment" && isObj(value) && "origin" in value ? { ok: false, error: [{ code: "undefined_field", path: "/origin" }] } : v.validate(name, value)),
    });
    expect(rejected(r).reason).toBe("undefined_field");
  });
});

describe("order, accounting and the absence of any store access", () => {
  it("the schema check comes after the removal, and the counts before it", () => {
    const many = Array.from({ length: L.maxClaims + 1 }, (_x, i) => claim({ localKey: `c${i}`, origin: "x" }));
    const { r, v } = run(many);
    expect(rejected(r).reason).toBe("count_exceeded");
    expect(v.seen).toHaveLength(0);
  });

  it("an accepted response with removed fields is one accepted call; a rejected one is one failed call without any report of removals", () => {
    const ok = gateProviderResult("hypothesis_generation", { ok: true, value: enc(JSON.stringify({ claims: [claim({ origin: "x" })] })) }, L, closedValidator());
    expect(ok.kind).toBe("accepted");
    const bad = gateProviderResult("hypothesis_generation", { ok: true, value: enc(JSON.stringify({ claims: [claim({ origin: "x", zz: 1 })] })) }, L, closedValidator());
    expect(bad).toMatchObject({ kind: "failed_call", reason: "unparseable", retryable: true });
    expect(JSON.stringify(bad).includes("origin")).toBe(false);
  });

  it("the gate has no interface to an approval store: no such import, path or call is in its source", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "src", "responseGate.ts"), "utf8");
    const imports = [...src.matchAll(/^import\s+(?:type\s+)?[^"']*from\s+["']([^"']+)["']/gm)].map((m) => m[1]).sort();
    expect([...new Set(imports)].sort()).toEqual(["./hash.js", "./json/canonicalJson.js", "./json/strictJsonParse.js", "./providerError.js", "./types.js"].sort());
    expect(src).not.toMatch(/approvals?[\\/]|ApprovalStore|Approval_Store|ApprovalRecord|Approval_Record|readFacts|appendApproval|addApproval/);
    expect(src).not.toMatch(/\b(fs|readFile|writeFile|appendFile|createWriteStream)\b/);
  });
});