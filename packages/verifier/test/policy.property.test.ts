// Experiment_Policy property tests (tasks 2.9, 2.10, 2.11).
//
//   Feature: discovery-loop, Property 9: Experiment_Policy decisions are deterministic
//   **Validates: Requirements 8.2, 8.3, 8.9**
//   Feature: discovery-loop, Property 10: Reset and the test namespace are rejected under all encodings
//   **Validates: Requirements 7.3, 7.5, 8.4, 8.5**
//   Feature: discovery-loop, Property 11: Accepted Experiments contain only allowlisted, in-limit content
//   **Validates: Requirements 8.1, 8.7, 8.8**
//
// Reproducibility record: SEED = 330009, NUM_RUNS = 300 (at least 100 as required). All generated values are neutral
// (fictitious widget API, short strings, small integers).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  POLICY_RULE_IDS,
  decide,
  decideDetailed,
  loadPolicyConfig,
  type Experiment,
  type PolicyConfig,
  type PolicyRuleId,
} from "../src/index.js";
import { ALLOWED_GET_PATHS, ALLOWED_POST_PATHS, loadedPolicyConfig, rawPolicyConfig } from "./helpers/policyFixtures.js";
import { loadedTable } from "./helpers/prepFixtures.js";

const SEED = 330009;
const NUM_RUNS = 300;
const TIMEOUT_MS = 120_000;
const cfg: PolicyConfig = loadedPolicyConfig();
const RULE_INDEX = new Map<string, number>(POLICY_RULE_IDS.map((id, i) => [id, i]));
const textBytes = (s: string): number => new TextEncoder().encode(s).length;

// ------------------------------------------------------------------------------------------ hostile generators

const FRAGMENTS = ["/", "reset", "RESET", "test", "orders", "products", "{id}", "%2F", "%72", "%25", "..", "?", "#", "\\", "//", ":", "http:", "ship", "%2e", " "];
const methodArb: fc.Arbitrary<unknown> = fc.oneof(fc.constantFrom("GET", "POST", "get", "PUT"), fc.anything());
const pathArb: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 4, arbitrary: fc.constantFrom<string>(...ALLOWED_GET_PATHS, ...ALLOWED_POST_PATHS) },
  { weight: 4, arbitrary: fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 6 }).map((a) => a.join("")) },
  { weight: 1, arbitrary: fc.anything() },
);
const pathParamsArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.dictionary(
    fc.constantFrom("id", "other"),
    fc.oneof(fc.integer({ min: -2, max: 3_000_000_000 }), fc.constantFrom<unknown>("1", null), fc.record({ $bind: fc.constantFrom("w1", "nope") })),
  ),
  fc.anything(),
);
const headersArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.dictionary(fc.constantFrom("accept", "Accept", "content-type", "host", "x-a"), fc.constantFrom("application/json", "text/html")),
  fc.anything(),
);
const bodyArb: fc.Arbitrary<unknown> = fc.oneof(fc.jsonValue(), fc.anything());

const requestArb: fc.Arbitrary<unknown> = fc.oneof(
  {
    weight: 9,
    arbitrary: fc.record(
      { method: methodArb, path: pathArb, pathParams: pathParamsArb, headers: headersArb, body: bodyArb },
      { requiredKeys: ["method", "path"] },
    ),
  },
  { weight: 1, arbitrary: fc.anything() },
);
const PARAM_NAMES = ["customer_id", "product_1", "quantity_1", "product_2", "quantity_2", "product_6", "quantity_6", "product_0", "product_01", "sku", "count"];
const stepParamsArb: fc.Arbitrary<unknown> = fc.oneof(
  fc.dictionary(fc.constantFrom(...PARAM_NAMES), fc.oneof(fc.integer({ min: -1, max: 3 }), fc.constant("1"), fc.constant(2147483648)), { maxKeys: 8 }),
  fc.record({ customer_id: fc.constant(1), product_1: fc.constant(1), quantity_1: fc.integer({ min: 0, max: 2 }) }),
  fc.anything(),
);
const stepArb: fc.Arbitrary<unknown> = fc.oneof(
  {
    weight: 9,
    arbitrary: fc.record(
      {
        kind: fc.constantFrom("order_exists", "order_shipped", "order_cancelled", "reset", "nope"),
        params: stepParamsArb,
        bind: fc.constantFrom("w1", "W", "w2"),
      },
      { requiredKeys: ["kind", "params"] },
    ),
  },
  { weight: 1, arbitrary: fc.anything() },
);const hostileExperimentArb: fc.Arbitrary<unknown> = fc.record(
  {
    experimentId: fc.oneof(fc.constant("exp-1"), fc.anything()),
    requests: fc.oneof({ weight: 9, arbitrary: fc.array(requestArb, { maxLength: 12 }) }, { weight: 1, arbitrary: fc.anything() }),
    stateChecks: fc.array(requestArb, { maxLength: 7 }),
    preparation: fc.array(stepArb, { maxLength: 12 }),
  },
  { requiredKeys: ["experimentId", "requests"] },
);

const asExperiment = (v: unknown): Experiment => v as Experiment;

/** Deep copy that reverses the key order of every object. The content is unchanged. */
function reverseKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (typeof v === "object" && v !== null) {
    return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)]));
  }
  return v;
}

// ------------------------------------------------------------------------------------------------- Property 9

describe(`Property 9: Experiment_Policy decisions are deterministic (seed ${SEED}, numRuns ${NUM_RUNS})`, () => {
  it("gives an identical decision for identical content, whatever the key order, and never changes its input", () => {
    fc.assert(
      fc.property(hostileExperimentArb, (raw) => {
        const before = structuredClone(raw);
        const first = decide(asExperiment(raw), cfg);
        expect(raw).toEqual(before);
        expect(decide(asExperiment(raw), cfg)).toEqual(first);
        expect(JSON.stringify(decide(asExperiment(structuredClone(raw)), cfg))).toBe(JSON.stringify(first));
        expect(decide(asExperiment(reverseKeys(raw)), cfg)).toEqual(first);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("returns a well-formed decision for any input and never throws (R8.9)", () => {
    fc.assert(
      fc.property(fc.oneof(hostileExperimentArb, fc.anything()), (raw) => {
        const detailed = decideDetailed(asExperiment(raw), cfg);
        expect(typeof detailed.experimentId).toBe("string");
        expect(detailed.decision === "accept").toBe(detailed.ruleIds.length === 0);
        // The ids are in rule order; POL-099 stands alone.
        const indexes = detailed.ruleIds.map((id) => RULE_INDEX.get(id) ?? -1);
        expect(indexes.every((i) => i >= 0)).toBe(true);
        expect([...indexes].sort((a, b) => a - b)).toEqual(indexes);
        if (detailed.ruleIds.includes("POL-099")) expect(detailed.ruleIds).toEqual(["POL-099"]);
        expect(detailed.violations.map((v) => v.ruleId)).toEqual(detailed.ruleIds);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);
});

// ------------------------------------------------------------------------------------------------ Property 10

type Family = "reset" | "test";
interface VariantSpec {
  family: Family;
  id: string;
  upper: boolean[];
  encodeAt: number[];
  lowerHex: boolean;
  doubleEncode: boolean;
  backslashAt: number[];
  lead: number;
  trailing: number;
  suffix: string;
}

const variantSpecArb: fc.Arbitrary<VariantSpec> = fc.record({
  family: fc.constantFrom<Family>("reset", "test"),
  id: fc.constantFrom("{id}", "1", "42", "999999"),
  upper: fc.array(fc.boolean(), { minLength: 32, maxLength: 32 }),
  encodeAt: fc.array(fc.nat(31), { maxLength: 4 }),
  lowerHex: fc.boolean(),
  doubleEncode: fc.boolean(),
  backslashAt: fc.array(fc.nat(31), { maxLength: 3 }),
  lead: fc.integer({ min: 0, max: 2 }),
  trailing: fc.integer({ min: 0, max: 2 }),
  suffix: fc.constantFrom("", "?", "?x=1", "#f", "?a=b#c"),
});

/** Builds a path variant: case, backslashes, percent-encoding (once or twice), leading and trailing slashes, query or fragment. */
function buildVariant(s: VariantSpec): string {
  const base = s.family === "reset" ? "/reset" : `/test/orders/${s.id}/ship`;
  let chars = [...base].map((ch, i) => (s.upper[i % s.upper.length] === true ? ch.toUpperCase() : ch));
  chars = chars.map((ch, i) => (ch === "/" && s.backslashAt.some((k) => k % chars.length === i) ? "\\" : ch));
  const hex = (ch: string): string => {
    const h = ch.charCodeAt(0).toString(16).padStart(2, "0");
    return `%${s.lowerHex ? h : h.toUpperCase()}`;
  };
  let out = chars
    .map((ch, i) => (s.encodeAt.some((k) => k % chars.length === i) && ch.charCodeAt(0) < 0x80 ? hex(ch) : ch))
    .join("");
  if (s.doubleEncode) out = out.replace(/%/g, "%25"); // a second round of encoding: at most two rounds in total
  return `${"/".repeat(s.lead)}${out}${"/".repeat(s.trailing)}${s.suffix}`;
}

const expectedRule = (family: Family): PolicyRuleId => (family === "reset" ? "POL-004" : "POL-005");

describe(`Property 10: Reset and the test namespace are rejected under all encodings (seed ${SEED}, numRuns ${NUM_RUNS})`, () => {
  it("rejects every variant with the deny rule, in the request list and in the state-check list", () => {
    fc.assert(
      fc.property(variantSpecArb, fc.constantFrom("POST", "GET", "PUT"), fc.constantFrom("requests", "stateChecks"), (spec, method, where) => {
        const path = buildVariant(spec);
        const request = { method, path, pathParams: { id: 1 } };
        const experiment = {
          experimentId: "exp-1",
          requests: where === "requests" ? [request] : [{ method: "GET", path: "/products" }],
          stateChecks: where === "stateChecks" ? [request] : [],
        };
        const decision = decide(experiment as unknown as Experiment, cfg);
        expect(decision.decision).toBe("reject");
        expect(decision.ruleIds).toContain(expectedRule(spec.family));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("rejects a variant even when the allowlist would otherwise match it (a forged configuration)", () => {
    fc.assert(
      fc.property(variantSpecArb, fc.constantFrom("POST", "GET"), (spec, method) => {
        const path = buildVariant(spec);
        const forged: PolicyConfig = { ...cfg, operations: [...cfg.operations, { method, path, readOnly: true }] };
        const experiment = { experimentId: "exp-1", requests: [{ method, path, pathParams: { id: 1 } }] };
        const ruleIds = decide(experiment as unknown as Experiment, forged).ruleIds;
        // The allowlist match is real (no POL-003), and the deny rule still rejects.
        expect(ruleIds).not.toContain("POL-003");
        expect(ruleIds).toContain(expectedRule(spec.family));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("refuses a configuration that lists such a path (R8.6), naming the denied operation for plain variants", () => {
    fc.assert(
      fc.property(variantSpecArb, fc.constantFrom("POST", "GET"), (spec, method) => {
        // Plain variants only: case and trailing slashes, which the path pattern of the allowlist accepts.
        const plain = buildVariant({ ...spec, encodeAt: [], doubleEncode: false, backslashAt: [], lead: 0, suffix: "" });
        const raw = rawPolicyConfig();
        raw["operations"].push({ method, path: plain, readOnly: false });
        const loaded = loadPolicyConfig(raw, loadedTable());
        expect(loaded.ok).toBe(false);
        if (!loaded.ok) expect(loaded.error.join(" ")).toContain("denied operation");
        // Any other variant is refused too, for this or another reason.
        const any = rawPolicyConfig();
        any["operations"].push({ method, path: buildVariant(spec), readOnly: false });
        expect(loadPolicyConfig(any, loadedTable()).ok).toBe(false);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);
});

// ------------------------------------------------------------------------------------------------ Property 11

/**
 * Independent predicate for a preparation step (written from the design, not from the code under test): one of the three kinds, a
 * `customer_id`, and lines numbered 1 to k (1 <= k <= 5) with both `product_<n>` and `quantity_<n>`; every value a positive integer
 * up to 2147483647; nothing else.
 */
function okPreparationStep(step: any): boolean {
  if (!["order_exists", "order_shipped", "order_cancelled"].includes(step.kind)) return false;
  const params = step.params;
  if (typeof params !== "object" || params === null || Array.isArray(params)) return false;
  const positive = (v: unknown): boolean => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 2147483647;
  const lines = new Map<number, Set<string>>();
  let sawCustomer = false;
  for (const [name, value] of Object.entries(params)) {
    if (name === "customer_id") {
      if (!positive(value)) return false;
      sawCustomer = true;
      continue;
    }
    const m = /^(product|quantity)_([1-5])$/.exec(name);
    if (m === null || !positive(value)) return false;
    const n = Number(m[2]);
    lines.set(n, (lines.get(n) ?? new Set<string>()).add(m[1] as string));
  }
  if (!sawCustomer || lines.size < 1) return false;
  for (let n = 1; n <= lines.size; n += 1) if ((lines.get(n)?.size ?? 0) !== 2) return false;
  return true;
}

/** Independent predicate: true only if the Experiment contains nothing but allowlisted, in-limit content. */
function satisfiesPolicy(e: any, c: PolicyConfig): boolean {
  try {
    const requests = e.requests;
    const stateChecks = e.stateChecks ?? [];
    const preparation = e.preparation ?? [];
    if (!Array.isArray(requests) || !Array.isArray(stateChecks) || !Array.isArray(preparation)) return false;
    if (requests.length > c.limits.requests || stateChecks.length > c.limits.stateChecks || preparation.length > c.limits.preparationSteps) return false;

    const binds = new Set<string>();
    const seenBind = new Set<string>();
    for (const step of preparation) {
      if (typeof step !== "object" || step === null || Array.isArray(step)) return false;
      if (Object.keys(step).some((k) => !["kind", "bind", "params"].includes(k))) return false;
      if (!okPreparationStep(step)) return false;
      if (step.bind !== undefined) {
        if (typeof step.bind !== "string" || !/^[a-z][a-z0-9_]{0,31}$/.test(step.bind) || seenBind.has(step.bind)) return false;
        seenBind.add(step.bind);
        binds.add(step.bind);
      }
    }
    const sortedJson = (v: unknown): string =>
      JSON.stringify(v, (_k, x) =>
        x !== null && typeof x === "object" && !Array.isArray(x)
          ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
          : x,
      );
    const okRequest = (r: any, readOnlyOnly: boolean): boolean => {
      if (typeof r !== "object" || r === null || Array.isArray(r)) return false;
      const op = c.operations.find((o) => o.method === r.method && o.path === r.path);
      if (op === undefined || (readOnlyOnly && !op.readOnly)) return false;
      const lower = String(r.path).toLowerCase();
      if (lower === "/reset" || lower.startsWith("/test") || lower.includes("..") || lower.includes("://") || lower.startsWith("//")) return false;
      if (r.headers !== undefined) {
        if (typeof r.headers !== "object" || r.headers === null || Array.isArray(r.headers)) return false;
        const names = Object.keys(r.headers).map((n) => n.toLowerCase());
        if (new Set(names).size !== names.length) return false;
        for (const [n, v] of Object.entries(r.headers)) {
          const allowed = c.headers.find((h) => h.name === n.toLowerCase());
          if (allowed === undefined || allowed.value !== v) return false;
        }
      }
      if (r.body !== undefined) {
        if (r.method === "GET") return false;
        if (textBytes(sortedJson(r.body)) > c.limits.bodyBytes) return false;
      }
      const placeholders = [...new Set([...String(r.path).matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] ?? ""))];
      const given = r.pathParams === undefined ? {} : r.pathParams;
      if (typeof given !== "object" || given === null || Array.isArray(given)) return false;
      const keys = Object.keys(given);
      if (keys.length !== placeholders.length || placeholders.some((p) => !keys.includes(p))) return false;
      for (const k of keys) {
        const v = (given as Record<string, any>)[k];
        const isInt = typeof v === "number" && Number.isSafeInteger(v) && v >= c.pathParam.min && v <= c.pathParam.max;
        const isBind = typeof v === "object" && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v["$bind"] === "string" && binds.has(v["$bind"]);
        if (!isInt && !isBind) return false;
      }
      return true;
    };
    return requests.every((r: unknown) => okRequest(r, false)) && stateChecks.every((r: unknown) => okRequest(r, true));
  } catch {
    return false;
  }
}

// ---- constructively valid Experiments (so that acceptance is exercised, not only rejection)
type Method = "GET" | "POST";
const OPERATIONS: readonly (readonly [Method, string])[] = [
  ["GET", "/products"],
  ["GET", "/products/{id}"],
  ["GET", "/orders"],
  ["GET", "/orders/{id}"],
  ["POST", "/orders"],
  ["POST", "/orders/{id}/cancel"],
];
const READ_ONLY_OPERATIONS = OPERATIONS.filter((o) => o[0] === "GET");

const jsonBodyArb = fc.jsonValue({ maxDepth: 2 }).filter((v) => textBytes(JSON.stringify(v)) <= 3000);
const okHeadersArb = fc.option(
  fc.record({ accept: fc.constant("application/json"), "Content-Type": fc.constant("application/json") }, { requiredKeys: [] }),
  { nil: undefined },
);
const requestSeedArb = fc.record({
  op: fc.constantFrom(...OPERATIONS),
  n: fc.integer({ min: 1, max: 2147483647 }),
  body: jsonBodyArb,
  headers: okHeadersArb,
  useBind: fc.boolean(),
});
const checkSeedArb = fc.record({
  op: fc.constantFrom(...READ_ONLY_OPERATIONS),
  n: fc.integer({ min: 1, max: 2147483647 }),
  headers: okHeadersArb,
});
const stepSeedArb = fc.record({
  kind: fc.constantFrom("order_exists", "order_shipped", "order_cancelled"),
  customer: fc.integer({ min: 1, max: 2147483647 }),
  lines: fc.array(fc.record({ product: fc.integer({ min: 1, max: 2147483647 }), quantity: fc.integer({ min: 1, max: 2147483647 }) }), { minLength: 1, maxLength: 5 }),
});
function buildRequest(
  op: readonly [Method, string],
  n: number,
  headers: unknown,
  body: unknown,
  bindName: string | undefined,
): Record<string, unknown> {
  const [method, path] = op;
  const names = [...path.matchAll(/\{([^{}]*)\}/g)].map((m) => m[1] ?? "");
  const value = bindName !== undefined ? { $bind: bindName } : n;
  return {
    method,
    path,
    ...(names.length > 0 ? { pathParams: Object.fromEntries(names.map((name) => [name, value])) } : {}),
    ...(headers !== undefined ? { headers } : {}),
    ...(method === "POST" ? { body } : {}),
  };
}

const validExperimentArb: fc.Arbitrary<Record<string, any>> = fc
  .record({
    steps: fc.array(stepSeedArb, { maxLength: 3 }),
    requests: fc.array(requestSeedArb, { minLength: 1, maxLength: 10 }),
    checks: fc.array(checkSeedArb, { maxLength: 5 }),
  })
  .map(({ steps, requests, checks }) => {
    const preparation = steps.map((s, i) => ({
      kind: s.kind,
      bind: `w${i + 1}`,
      params: {
        customer_id: s.customer,
        ...Object.fromEntries(s.lines.flatMap((l, n) => [[`product_${n + 1}`, l.product], [`quantity_${n + 1}`, l.quantity]])),
      },
    }));
    const first = preparation[0]?.bind;
    return {
      experimentId: "exp-1",
      preparation,
      requests: requests.map((r) => buildRequest(r.op, r.n, r.headers, r.body, r.useBind ? first : undefined)),
      stateChecks: checks.map((c) => buildRequest(c.op, c.n, c.headers, undefined, undefined)),
    };
  });

type Setter = (e: Record<string, any>, v: unknown) => void;
const SETTERS: readonly Setter[] = [
  (e, v) => { e["requests"][0].method = v; },
  (e, v) => { e["requests"][0].path = v; },
  (e, v) => { e["requests"][0].pathParams = v; },
  (e, v) => { e["requests"][0].headers = v; },
  (e, v) => { e["requests"][0].body = v; },
  (e, v) => { e["stateChecks"] = [v]; },
  (e, v) => { e["preparation"] = [v]; },
  (e, v) => { e["requests"] = v; },
];
/** A valid Experiment with one field replaced by an arbitrary value: close to valid, so some of them are still accepted. */
const perturbedArb: fc.Arbitrary<unknown> = fc
  .tuple(validExperimentArb, fc.constantFrom(...SETTERS), fc.oneof(fc.anything(), fc.jsonValue()))
  .map(([e, set, v]) => {
    const copy = structuredClone(e);
    set(copy, v);
    return copy;
  });

interface Mutation {
  rule: PolicyRuleId;
  apply(e: Record<string, any>): void;
}
const MUTATIONS: readonly Mutation[] = [
  { rule: "POL-001", apply: (e) => { while (e["requests"].length < 11) e["requests"].push({ method: "GET", path: "/products" }); } },
  { rule: "POL-002", apply: (e) => { while (e["stateChecks"].length < 6) e["stateChecks"].push({ method: "GET", path: "/products" }); } },
  { rule: "POL-003", apply: (e) => { e["requests"][0].path += "/"; } },
  { rule: "POL-004", apply: (e) => { e["requests"].push({ method: "POST", path: "/reset" }); } },
  { rule: "POL-005", apply: (e) => { e["requests"].push({ method: "POST", path: "/test/orders/1/ship" }); } },
  { rule: "POL-006", apply: (e) => { e["requests"][0].path = `http://host${e["requests"][0].path}`; } },
  { rule: "POL-007", apply: (e) => { e["requests"][0].path += "/.."; } },
  { rule: "POL-008", apply: (e) => { e["requests"][0].headers = { host: "x" }; } },
  { rule: "POL-009", apply: (e) => { e["requests"].push({ method: "POST", path: "/orders", body: { s: "x".repeat(9000) } }); } },
  { rule: "POL-010", apply: (e) => { e["requests"].push({ method: "GET", path: "/orders/{id}" }); } },
  { rule: "POL-011", apply: (e) => { e["preparation"].push({ kind: "nope", params: {} }); } },
  { rule: "POL-012", apply: (e) => { e["requests"].push({ method: "GET", path: "/products", body: {} }); } },
  { rule: "POL-013", apply: (e) => { e["stateChecks"].push({ method: "POST", path: "/orders" }); } },
];

describe(`Property 11: Accepted Experiments contain only allowlisted, in-limit content (seed ${SEED}, numRuns ${NUM_RUNS})`, () => {
  it("accepts every constructively valid Experiment, and the independent predicate agrees", () => {
    fc.assert(
      fc.property(validExperimentArb, (e) => {
        expect(satisfiesPolicy(e, cfg)).toBe(true);
        expect(decide(asExperiment(e), cfg)).toEqual({ experimentId: "exp-1", decision: "accept", ruleIds: [] });
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("accepts nothing but allowlisted, in-limit content, for hostile and for nearly valid Experiments", () => {
    fc.assert(
      fc.property(fc.oneof(hostileExperimentArb, perturbedArb), (e) => {
        const decision = decide(asExperiment(e), cfg);
        if (decision.decision === "accept") expect(satisfiesPolicy(e, cfg)).toBe(true);
      }),
      { seed: SEED, numRuns: NUM_RUNS * 2 },
    );
  }, TIMEOUT_MS);

  it("rejects a valid Experiment that is changed to break one rule, and reports that rule", () => {
    fc.assert(
      fc.property(validExperimentArb, fc.constantFrom(...MUTATIONS), (e, mutation) => {
        const copy = structuredClone(e);
        mutation.apply(copy);
        const decision = decide(asExperiment(copy), cfg);
        expect(decision.decision).toBe("reject");
        expect(decision.ruleIds).toContain(mutation.rule);
        expect(satisfiesPolicy(copy, cfg)).toBe(false);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);
});
