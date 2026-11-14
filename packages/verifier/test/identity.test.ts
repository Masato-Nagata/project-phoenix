// Identity hashes and the acceptance check (OD-17; tasks 2.15 and 2.26). R8.2, R8.3, R9.2, R9.3.
// Neutral values only.
import { tryCanonicalJson } from "@phoenix/discovery-loop";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  canonicalIdentityText, createAcceptanceCheck, evaluateForRecord, executionIdentity, experimentSha256, loadPolicyConfig, loadPreparationTable, policyConfigSha256,
  preparationTableSha256, verifyAcceptance, type AcceptanceRefusal, type Experiment, type PolicyConfig, type RecordView,
} from "../src/index.js";
import { deepFreeze } from "./helpers/compareFixtures.js";
import { loadedPolicyConfig, rawPolicyConfig } from "./helpers/policyFixtures.js";
import { loadedTable, rawTable } from "./helpers/prepFixtures.js";

const SEED = 340036;
const cfg = loadedPolicyConfig();
const table = loadedTable();

const exp = (over: Record<string, unknown> = {}): Experiment =>
  ({
    experimentId: "exp-1",
    preparation: [{ kind: "order_exists", bind: "w1", params: { customer_id: 1, product_1: 2, quantity_1: 3 } }],
    requests: [{ method: "GET", path: "/orders/{id}", pathParams: { id: { $bind: "w1" } } }, { method: "POST", path: "/orders", body: { b: 1, a: [1, 2] } }],
    stateChecks: [{ method: "GET", path: "/orders" }],
    prediction: { status: 200 },
    ...over,
  }) as unknown as Experiment;

const rec = (id: string, kind: string, payload: unknown): RecordView => ({ id, kind, payload });
const decision = (e: Experiment, c: PolicyConfig = cfg, id = "rec-000001"): RecordView => rec(id, "policy_decision", evaluateForRecord(e, c));
const identityOf = (e: Experiment, c: PolicyConfig = cfg) => executionIdentity(e, c, c.preparationTable);

describe("the hashes", () => {
  it("are SHA-256 of the canonical JSON: the same content in another key order has the same hash", () => {
    const a = exp();
    const b = { requests: (a as unknown as { requests: unknown }).requests, experimentId: "exp-1", stateChecks: a.stateChecks, prediction: { status: 200 }, preparation: a.preparation };
    expect(experimentSha256(a)).toBe(experimentSha256(b));
    expect(experimentSha256(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalIdentityText({ b: 1, a: [true, null, "x"] })).toBe('{"a":[true,null,"x"],"b":1}');
  });

  it("change with any change of the content", () => {
    const base = experimentSha256(exp());
    const changed = [
      exp({ experimentId: "exp-2" }), exp({ requests: [{ method: "GET", path: "/orders" }] }), exp({ stateChecks: [] }), exp({ prediction: { status: 201 } }),
      exp({ preparation: [{ kind: "order_exists", bind: "w1", params: { customer_id: 1, product_1: 2, quantity_1: 4 } }] }),
      exp({ preparation: [{ kind: "order_exists", bind: "w2", params: { customer_id: 1, product_1: 2, quantity_1: 3 } }] }),
      exp({ requests: [{ method: "GET", path: "/orders/{id}", pathParams: { id: { $bind: "w1" } } }, { method: "POST", path: "/orders", body: { b: 1, a: [2, 1] } }] }),
    ];
    for (const e of changed) expect(experimentSha256(e)).not.toBe(base);
    expect(new Set(changed.map(experimentSha256)).size).toBe(changed.length);
  });

  it("refuse a value that is not JSON, as the Evidence_Store does", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    for (const bad of [undefined, () => 1, Symbol("x"), 1n, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60, { a: undefined }, "\uD800", { "\uDC00": 1 }, cyclic, new Date(), new Map()]) {
      expect(() => experimentSha256(bad), String(bad)).toThrow();
    }
    expect(experimentSha256(-0)).toBe(experimentSha256(0));
  });

  it("agree with the canonical JSON of the Evidence_Store on every value that both accept, and both refuse the same values", () => {
    const anyString = fc.array(fc.integer({ min: 0, max: 0xffff }), { maxLength: 6 }).map((codes) => String.fromCharCode(...codes));
    const value: fc.Arbitrary<unknown> = fc.letrec((tie) => ({
      v: fc.oneof(
        { depthSize: "small", withCrossShrink: true },
        fc.constant(null), fc.boolean(), fc.double({ noNaN: false }), fc.integer({ min: -(2 ** 60), max: 2 ** 60 }), anyString,
        fc.array(tie("v"), { maxLength: 4 }),
        fc.dictionary(anyString, tie("v"), { maxKeys: 4 }),
      ),
    })).v;
    fc.assert(
      fc.property(value, (v) => {
        const m1 = tryCanonicalJson(v);
        let ours: string | undefined;
        try {
          ours = canonicalIdentityText(v);
        } catch {
          ours = undefined;
        }
        expect(ours !== undefined).toBe(m1.ok);
        if (m1.ok) expect(ours).toBe(m1.value);
      }),
      { seed: SEED, numRuns: 500 },
    );
  });

  it("of the policy configuration leave out the preparation table, which has its own hash", () => {
    const base = policyConfigSha256(cfg);
    const smaller = rawPolicyConfig();
    smaller["limits"].requests = 9;
    const other = loadPolicyConfig(smaller, table);
    expect(other.ok).toBe(true);
    if (!other.ok) return;
    expect(policyConfigSha256(other.value)).not.toBe(base);
    expect(preparationTableSha256(other.value.preparationTable)).toBe(preparationTableSha256(table));

    const t = rawTable() as Record<string, any>;
    t["steps"][0]["numbered"]["max"] = 4;
    const changedTable = loadPreparationTable(t);
    expect(changedTable.ok).toBe(true);
    if (!changedTable.ok) return;
    const withTable = loadPolicyConfig(rawPolicyConfig(), changedTable.value);
    expect(withTable.ok).toBe(true);
    if (!withTable.ok) return;
    expect(policyConfigSha256(withTable.value)).toBe(base);
    expect(preparationTableSha256(changedTable.value)).not.toBe(preparationTableSha256(table));
  });

  it("do not depend on the order of the keys of the raw files", () => {
    const reversed = Object.fromEntries(Object.entries(rawPolicyConfig()).reverse());
    const loaded = loadPolicyConfig(reversed, loadedTable());
    expect(loaded.ok && policyConfigSha256(loaded.value)).toBe(policyConfigSha256(cfg));
    const rt = Object.fromEntries(Object.entries(rawTable()).reverse());
    const t2 = loadPreparationTable(rt);
    expect(t2.ok && preparationTableSha256(t2.value)).toBe(preparationTableSha256(table));
  });
});

describe("evaluateForRecord", () => {
  it("builds the payload of a policy_decision: the decision of R8.2 and the three hashes", () => {
    const e = exp();
    expect(evaluateForRecord(e, cfg)).toEqual({ experimentId: "exp-1", decision: "accept", ruleIds: [], ...identityOf(e) });
  });
  it("records a reject with its rule ids and the same identity", () => {
    const e = exp({ requests: [{ method: "POST", path: "/reset" }] });
    const p = evaluateForRecord(e, cfg);
    expect(p.decision).toBe("reject");
    expect(p.ruleIds).toContain("POL-004");
    expect(p.experimentSha256).toBe(experimentSha256(e));
  });
  it("records an Experiment that cannot be hashed as a reject (POL-099)", () => {
    const p = evaluateForRecord({ experimentId: "exp-1", requests: [{ method: "GET", path: "/orders", body: undefined }], x: 2 ** 70 } as unknown as Experiment, cfg);
    expect(p.decision).toBe("reject");
  });
});

describe("verifyAcceptance (R9.2, R9.3, OD-17)", () => {
  const e = exp();
  const id = identityOf(e);
  const good = decision(e);
  const refused = (records: RecordView[], code: AcceptanceRefusal, over: { experiment?: string; record?: string; identity?: typeof id } = {}) =>
    expect(verifyAcceptance(records, over.experiment ?? "exp-1", over.record ?? "rec-000001", over.identity ?? id)).toEqual({ accepted: false, code });

  it("accepts a unique accept decision whose three hashes equal the ones computed now", () => {
    expect(verifyAcceptance([good], "exp-1", "rec-000001", id)).toEqual({ accepted: true });
    const others = [rec("rec-000002", "experiment", { experimentId: "exp-1" }), decision(exp({ experimentId: "exp-2" }), cfg, "rec-000003"), rec("rec-000004", "observation", null)];
    expect(verifyAcceptance([...others, good], "exp-1", "rec-000001", id)).toEqual({ accepted: true });
  });

  it("refuses a decision record that is missing, of another kind, or of another Experiment", () => {
    refused([], "record_missing");
    refused([good], "record_missing", { record: "rec-000009" });
    refused([good], "record_missing", { record: "" });
    refused([{ ...good, kind: "experiment" }], "record_not_policy_decision");
    refused([good], "experiment_id_mismatch", { experiment: "exp-2" });
    for (const payload of [null, undefined, 5, "x", [], {}, { experimentId: 5 }]) refused([rec("rec-000001", "policy_decision", payload)], "payload_malformed");
  });

  it("refuses when a reject exists for the Experiment, also next to an accept (R9.3)", () => {
    const reject = rec("rec-000002", "policy_decision", evaluateForRecord(exp({ requests: [{ method: "POST", path: "/reset" }] }), cfg));
    refused([reject], "reject_exists", { record: "rec-000002" });
    refused([good, reject], "reject_exists");
    refused([reject, good], "reject_exists");
  });

  it("refuses when the accept decision is not unique (R9.2)", () => {
    refused([good, { ...good, id: "rec-000002" }], "decision_not_unique");
    refused([good, { ...good, id: "rec-000002" }], "decision_not_unique", { record: "rec-000002" });
  });

  it("refuses an accept whose rule list is not empty, whose decision is not accept, or whose hashes are not hashes", () => {
    const p = evaluateForRecord(e, cfg) as unknown as Record<string, unknown>;
    refused([rec("rec-000001", "policy_decision", { ...p, ruleIds: ["POL-001"] })], "payload_malformed");
    refused([rec("rec-000001", "policy_decision", { ...p, ruleIds: "none" })], "payload_malformed");
    refused([rec("rec-000001", "policy_decision", { ...p, decision: "maybe" })], "decision_not_accept");
    for (const key of ["experimentSha256", "policyConfigSha256", "preparationTableSha256"]) {
      for (const bad of [undefined, 5, "", "abc", "A".repeat(64), "g".repeat(64), "0".repeat(63)]) {
        refused([rec("rec-000001", "policy_decision", { ...p, [key]: bad })], "payload_malformed");
      }
    }
  });

  it("refuses a changed Experiment, a changed policy configuration, and a changed preparation table (OD-17)", () => {
    refused([good], "experiment_content_changed", { identity: identityOf(exp({ requests: [{ method: "GET", path: "/orders" }] })) });
    refused([good], "experiment_content_changed", { identity: { ...id, experimentSha256: "f".repeat(64) } });
    refused([good], "policy_config_changed", { identity: { ...id, policyConfigSha256: "f".repeat(64) } });
    refused([good], "preparation_table_changed", { identity: { ...id, preparationTableSha256: "f".repeat(64) } });
    // The first difference is reported, in the order content, configuration, table.
    refused([good], "experiment_content_changed", { identity: { experimentSha256: "1".repeat(64), policyConfigSha256: "2".repeat(64), preparationTableSha256: "3".repeat(64) } });
    refused([good], "policy_config_changed", { identity: { ...id, policyConfigSha256: "2".repeat(64), preparationTableSha256: "3".repeat(64) } });
  });

  it("is a pure function: it does not modify the records and never throws", () => {
    const records = deepFreeze([good, rec("rec-000002", "observation", { a: 1 })]);
    expect(verifyAcceptance(records, "exp-1", "rec-000001", id)).toEqual({ accepted: true });
    const hostile = [null, undefined, 5, { id: {}, kind: [] }, { id: "rec-000001", kind: "policy_decision", get payload(): never { throw new Error("boom"); } }] as unknown as RecordView[];
    expect(() => verifyAcceptance(hostile, "exp-1", "rec-000001", id)).not.toThrow();
    expect(verifyAcceptance(hostile, "exp-1", "rec-000001", id).accepted).toBe(false);
    expect(verifyAcceptance(records, 5 as never, 7 as never, id).accepted).toBe(false);
  });

  it("createAcceptanceCheck reads the records at the time of the call", () => {
    const store: RecordView[] = [];
    const check = createAcceptanceCheck(() => store);
    expect(check("exp-1", "rec-000001", id)).toEqual({ accepted: false, code: "record_missing" });
    store.push(good);
    expect(check("exp-1", "rec-000001", id)).toEqual({ accepted: true });
    store.push({ ...good, id: "rec-000002" });
    expect(check("exp-1", "rec-000001", id)).toEqual({ accepted: false, code: "decision_not_unique" });
  });
});

// ---- property: the check equals an independent oracle over random stores
const HASHES = ["a".repeat(64), "b".repeat(64), "c".repeat(64)] as const;
const recordArb: fc.Arbitrary<RecordView> = fc.record({
  id: fc.constantFrom("rec-000001", "rec-000002", "rec-000003", "rec-000004"),
  kind: fc.constantFrom("policy_decision", "policy_decision", "policy_decision", "experiment"),
  payload: fc.oneof(
    { weight: 8, arbitrary: fc.record({
      experimentId: fc.constantFrom("exp-1", "exp-2"),
      decision: fc.constantFrom("accept", "accept", "reject", "maybe"),
      ruleIds: fc.constantFrom([], [], ["POL-001"]),
      experimentSha256: fc.constantFrom(...HASHES, "bad"),
      policyConfigSha256: fc.constantFrom(...HASHES, "bad"),
      preparationTableSha256: fc.constantFrom(...HASHES, "bad"),
    }) },
    { weight: 1, arbitrary: fc.anything() },
  ),
});

/** Written from the rules in the header of acceptance.ts, in another shape: a list of reasons for refusal, the first applies. */
function oracle(records: RecordView[], experimentId: string, recordId: string, identity: { experimentSha256: string; policyConfigSha256: string; preparationTableSha256: string }): string {
  const plain = (p: unknown): p is Record<string, unknown> => typeof p === "object" && p !== null && !Array.isArray(p);
  const target = records.filter((r) => r.id === recordId)[0];
  const forExperiment = records.filter((r) => r.kind === "policy_decision" && plain(r.payload) && r.payload["experimentId"] === experimentId);
  const checks: [boolean, string][] = [
    [target === undefined, "record_missing"],
    [target !== undefined && target.kind !== "policy_decision", "record_not_policy_decision"],
    [target !== undefined && !(plain(target.payload) && typeof target.payload["experimentId"] === "string"), "payload_malformed"],
    [target !== undefined && plain(target.payload) && target.payload["experimentId"] !== experimentId, "experiment_id_mismatch"],
    [forExperiment.some((r) => (r.payload as Record<string, unknown>)["decision"] === "reject"), "reject_exists"],
    [forExperiment.length !== 1, "decision_not_unique"],
  ];
  for (const [hit, code] of checks) if (hit) return code;
  const p = (target as RecordView).payload as Record<string, unknown>;
  const isHash = (h: unknown): boolean => typeof h === "string" && /^[0-9a-f]{64}$/.test(h);
  if (p["decision"] !== "accept") return "decision_not_accept";
  if (!Array.isArray(p["ruleIds"]) || p["ruleIds"].length !== 0) return "payload_malformed";
  if (![p["experimentSha256"], p["policyConfigSha256"], p["preparationTableSha256"]].every(isHash)) return "payload_malformed";
  if (p["experimentSha256"] !== identity.experimentSha256) return "experiment_content_changed";
  if (p["policyConfigSha256"] !== identity.policyConfigSha256) return "policy_config_changed";
  if (p["preparationTableSha256"] !== identity.preparationTableSha256) return "preparation_table_changed";
  return "accepted";
}

describe(`the acceptance check equals an independent oracle (seed ${SEED}, 400 runs)`, () => {
  it("accepts exactly when the oracle accepts, with the same first reason otherwise", () => {
    fc.assert(
      fc.property(
        fc.array(recordArb, { maxLength: 5 }), fc.constantFrom("exp-1", "exp-2"), fc.constantFrom("rec-000001", "rec-000002", "rec-000003", "rec-000009"),
        fc.record({ experimentSha256: fc.constantFrom(...HASHES), policyConfigSha256: fc.constantFrom(...HASHES), preparationTableSha256: fc.constantFrom(...HASHES) }),
        (records, experimentId, recordId, identity) => {
          const verdict = verifyAcceptance(records, experimentId, recordId, identity);
          const expected = oracle(records, experimentId, recordId, identity);
          expect(verdict.accepted ? "accepted" : verdict.code).toBe(expected);
        },
      ),
      { seed: SEED, numRuns: 400 },
    );
  });
});