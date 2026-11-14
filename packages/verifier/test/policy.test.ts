// Experiment_Policy unit tests (task 2.8; R8.1 to R8.9). Neutral fictitious API only.
import { describe, expect, it } from "vitest";
import {
  createPolicyEngine,
  decide,
  decideDetailed,
  foldPath,
  loadPolicyConfig,
  type Experiment,
  type PolicyRuleId,
} from "../src/index.js";
import { loadedPolicyConfig, rawPolicyConfig } from "./helpers/policyFixtures.js";
import { loadedTable, rawTable } from "./helpers/prepFixtures.js";

const cfg = loadedPolicyConfig();
const ids = (e: unknown): PolicyRuleId[] => decide(e as Experiment, cfg).ruleIds;
const one = (request: unknown, extra: Record<string, unknown> = {}): Experiment =>
  ({ experimentId: "exp-1", requests: [request], ...extra }) as unknown as Experiment;

const accepted: Experiment = {
  experimentId: "exp-1",
  preparation: [{ kind: "order_exists", bind: "w1", params: { customer_id: 1, product_1: 2, quantity_1: 3 } }],
  requests: [
    { method: "GET", path: "/products" },
    { method: "GET", path: "/orders/{id}", pathParams: { id: { $bind: "w1" } }, headers: { Accept: "application/json" } },
    { method: "POST", path: "/orders", body: { a: 1 }, headers: { "Content-Type": "application/json" } },
  ],
  stateChecks: [{ method: "GET", path: "/orders/{id}", pathParams: { id: 7 } }],
};

describe("decide: accept", () => {
  it("accepts an Experiment that passes every rule, with an empty rule list", () => {
    expect(decide(accepted, cfg)).toEqual({ experimentId: "exp-1", decision: "accept", ruleIds: [] });
  });
});

describe("decide: one violation per rule (design table)", () => {
  it("POL-001 and POL-002: counts", () => {
    const many = Array.from({ length: 11 }, () => ({ method: "GET", path: "/products" }));
    expect(ids({ experimentId: "e", requests: many })).toEqual(["POL-001"]);
    expect(ids(one({ method: "GET", path: "/products" }, { stateChecks: many.slice(0, 6) }))).toEqual(["POL-002"]);
    const steps = Array.from({ length: 11 }, () => ({ kind: "order_exists", params: { customer_id: 1, product_1: 1, quantity_1: 1 } }));
    expect(ids(one({ method: "GET", path: "/products" }, { preparation: steps }))).toEqual(["POL-002"]);
    expect(ids(one({ method: "GET", path: "/products" }, { preparation: steps.slice(0, 10) }))).toEqual([]);
  });

  it("POL-003: the method and path must equal an allowlist entry exactly", () => {
    for (const request of [
      { method: "GET", path: "/products/1" },
      { method: "get", path: "/products" },
      { method: "PUT", path: "/products" },
      { method: "GET", path: "/Products" },
      { method: "GET", path: "/products/" },
      { method: "GET", path: "/products?x=1" },
      { method: "GET", path: "/%70roducts" },
      { method: 5, path: "/products" },
      { method: "GET", path: 5 },
    ]) {
      expect(ids(one(request))).toContain("POL-003");
    }
    expect(ids(one("not an object"))).toEqual(["POL-003"]);
  });

  it("POL-004 and POL-005: reset and the test namespace, after folding (R8.4, R8.5)", () => {
    for (const path of ["/reset", "/RESET", "/reset/", "/reset?x=1", "/reset#f", "/%72eset", "/%2572eset", "//reset", "\\reset", "/%5Creset", "/reset%3Fa=b"]) {
      expect(ids(one({ method: "POST", path }))).toContain("POL-004");
    }
    for (const path of ["/test/orders/{id}/ship", "/TEST/orders/1/ship", "/test", "/test/", "/%74est/orders/{id}/ship", "/te%73t/x", "/test?x"]) {
      expect(ids(one({ method: "POST", path, pathParams: { id: 1 } }))).toContain("POL-005");
    }
  });

  it("POL-004 and POL-005 win even when the allowlist (wrongly) contains the operation", () => {
    const forged = loadedPolicyConfig();
    const widened = {
      ...forged,
      operations: [
        ...forged.operations,
        { method: "POST", path: "/reset", readOnly: false },
        { method: "POST", path: "/test/orders/{id}/ship", readOnly: false },
      ],
    };
    expect(decide(one({ method: "POST", path: "/reset" }), widened).ruleIds).toEqual(["POL-004"]);
    expect(decide(one({ method: "POST", path: "/test/orders/{id}/ship", pathParams: { id: 1 } }), widened).ruleIds).toEqual(["POL-005"]);
  });

  it("POL-006: absolute URL, scheme, authority", () => {
    for (const path of ["http://host/products", "HTTPS://host/", "//host/products", "\\\\host\\products", "/%2F/host", "javascript:x"]) {
      expect(ids(one({ method: "GET", path }))).toContain("POL-006");
    }
  });

  it("POL-007: path traversal, raw and percent-encoded", () => {
    for (const path of ["/products/../orders", "/products/%2e%2e/orders", "/products/%252e%252e", "/products/..%2forders", "/orders/{id}.."]) {
      expect(ids(one({ method: "GET", path }))).toContain("POL-007");
    }
  });

  it("POL-008: headers", () => {
    const get = (headers: unknown) => ids(one({ method: "GET", path: "/products", headers }));
    expect(get({ Host: "x" })).toEqual(["POL-008"]);
    expect(get({ accept: "text/html" })).toEqual(["POL-008"]);
    expect(get({ accept: "application/json", Accept: "application/json" })).toEqual(["POL-008"]);
    expect(get(["accept"])).toEqual(["POL-008"]);
    expect(get({ ACCEPT: "application/json" })).toEqual([]);
  });

  it("POL-009: canonical body size", () => {
    const post = (body: unknown) => ids(one({ method: "POST", path: "/orders", body }));
    expect(post({ s: "x".repeat(8200) })).toEqual(["POL-009"]);
    // {"s":"..."} is 8 bytes of structure around the text: 8184 characters fit exactly.
    expect(post({ s: "x".repeat(8184) })).toEqual([]);
    expect(post({ s: "x".repeat(8185) })).toEqual(["POL-009"]);
    // Key order does not change the size.
    expect(post({ b: 1, a: 2 })).toEqual(post({ a: 2, b: 1 }));
  });

  it("POL-010: path parameters", () => {
    const get = (pathParams?: unknown) => ids(one({ method: "GET", path: "/orders/{id}", ...(pathParams === undefined ? {} : { pathParams }) }));
    expect(get()).toEqual(["POL-010"]);
    expect(get({ id: 1, other: 2 })).toEqual(["POL-010"]);
    expect(get({ id: 0 })).toEqual(["POL-010"]);
    expect(get({ id: 2147483648 })).toEqual(["POL-010"]);
    expect(get({ id: 1.5 })).toEqual(["POL-010"]);
    expect(get({ id: "1" })).toEqual(["POL-010"]);
    expect(get({ id: null })).toEqual(["POL-010"]);
    expect(get({ id: { $bind: "nope" } })).toEqual(["POL-010"]);
    expect(get({ id: { $bind: "w1", extra: 1 } })).toEqual(["POL-010"]);
    expect(get({ id: 1 })).toEqual([]);
    expect(get({ id: 2147483647 })).toEqual([]);
    // A path without a placeholder takes no parameter.
    expect(ids(one({ method: "GET", path: "/products", pathParams: { id: 1 } }))).toEqual(["POL-010"]);
  });

  it("POL-011: a preparation step is valid if and only if the preparation table accepts it (task 2.26)", () => {
    const prep = (step: unknown) => ids(one({ method: "GET", path: "/products" }, { preparation: [step] }));
    const line = (n: number) => ({ [`product_${n}`]: n, [`quantity_${n}`]: n + 1 });
    const step = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ kind: "order_exists", params: { customer_id: 1, ...params }, ...extra });
    // Accepted: 1 line, and the maximum number of lines.
    expect(prep(step(line(1)))).toEqual([]);
    expect(prep(step({ ...line(1), ...line(2), ...line(3), ...line(4), ...line(5) }, { bind: "w1" }))).toEqual([]);
    // One case for each rejection.
    const bad: [string, unknown][] = [
      ["a pair given by one field only", step({ ...line(1), product_2: 3 })],
      ["a gap in the numbering", step({ ...line(1), ...line(3) })],
      ["an index above the maximum", step({ ...line(1), ...line(6) })],
      ["an index 0", step({ ...line(1), product_0: 1, quantity_0: 1 })],
      ["an index with a leading zero", step({ ...line(1), product_01: 1 })],
      ["fewer lines than the minimum", step({})],
      ["a wrong type", step({ ...line(1), quantity_1: "2" })],
      ["a value out of range", step({ ...line(1), product_1: 0 })],
      ["an undefined parameter", step({ ...line(1), sku: 1 })],
      ["a missing fixed parameter", { kind: "order_exists", params: line(1) }],
      ["an unknown kind", { kind: "nope", params: {} }],
      ["a reserved kind", { kind: "reset", params: {} }],
      ["a field that names a method", step(line(1), { method: "POST" })],
      ["a bind that is not a local key", step(line(1), { bind: "Bad" })],
      ["a step that is not an object", "text"],
    ];
    for (const [name, s] of bad) expect(prep(s), name).toEqual(["POL-011"]);
    // A duplicate bind.
    const twice = [step(line(1), { bind: "w1" }), step(line(1), { bind: "w1" })];
    expect(ids(one({ method: "GET", path: "/products" }, { preparation: twice }))).toEqual(["POL-011"]);
    // The old scalar form of task 2.8 (`count`) is no longer a form of any kind.
    expect(prep({ kind: "order_exists", params: { count: 1 } })).toEqual(["POL-011"]);
  });
  it("POL-012: a body on a GET request, including null", () => {
    expect(ids(one({ method: "GET", path: "/products", body: {} }))).toEqual(["POL-012"]);
    expect(ids(one({ method: "GET", path: "/products", body: null }))).toEqual(["POL-012"]);
  });

  it("POL-013: a state check must be a known read-only operation", () => {
    expect(ids(one({ method: "GET", path: "/products" }, { stateChecks: [{ method: "POST", path: "/orders" }] }))).toEqual(["POL-013"]);
    expect(ids(one({ method: "GET", path: "/products" }, { stateChecks: [{ method: "GET", path: "/nope" }] }))).toEqual(["POL-003", "POL-013"]);
  });
});

describe("decide: POL-099 and order", () => {
  it("returns POL-099 and never throws when the decision cannot be computed (R8.9)", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(ids({ experimentId: "e", requests: "not a list" })).toEqual(["POL-099"]);
    expect(ids(one({ method: "POST", path: "/orders", body: { f: () => 1 } }))).toEqual(["POL-099"]);
    expect(ids(one({ method: "POST", path: "/orders", body: { n: Number.NaN } }))).toEqual(["POL-099"]);
    expect(ids(one({ method: "POST", path: "/orders", body: { u: undefined } }))).toEqual(["POL-099"]);
    expect(ids(one({ method: "POST", path: "/orders", body: cyclic }))).toEqual(["POL-099"]);
    expect(ids(null)).toEqual(["POL-099"]);
    expect(decide(null as unknown as Experiment, cfg).experimentId).toBe("");
    const hostile = { experimentId: "h", get requests(): never { throw new Error("boom"); } };
    expect(decide(hostile as unknown as Experiment, cfg)).toEqual({ experimentId: "h", decision: "reject", ruleIds: ["POL-099"] });
  });

  it("lists every violated rule once per location, ordered by rule, then requests, state checks, preparation steps", () => {
    const mixed = {
      experimentId: "m",
      requests: [{ method: "GET", path: "/nope", body: {} }, { method: "GET", path: "/zzz" }],
      stateChecks: [{ method: "POST", path: "/orders" }],
      preparation: [{ kind: "nope", params: {} }],
    };
    const detailed = decideDetailed(mixed as unknown as Experiment, cfg);
    expect(detailed.violations.map((v) => `${v.ruleId}:${v.group}:${v.index}`)).toEqual([
      "POL-003:requests:0",
      "POL-003:requests:1",
      "POL-011:preparation:0",
      "POL-012:requests:0",
      "POL-013:stateChecks:0",
    ]);
    expect(detailed.ruleIds).toEqual(detailed.violations.map((v) => v.ruleId));
  });
});

describe("foldPath (design: deny after folding)", () => {
  it("folds the documented transformations", () => {
    expect(foldPath("/RESET/")).toBe("/reset");
    expect(foldPath("/reset?x=1")).toBe("/reset");
    expect(foldPath("/%252572eset")).toBe("/reset");
    expect(foldPath("\\\\reset")).toBe("/reset");
    expect(foldPath("/a//b///")).toBe("/a/b");
    expect(foldPath("/")).toBe("/");
    // Only three decode rounds are applied.
    expect(foldPath("/%25252572eset")).toBe("/%72eset");
  });
});

describe("loadPolicyConfig and createPolicyEngine (R8.6)", () => {
  it("accepts the fixture, which carries no list of kinds, and keeps the loaded table", () => {
    const loaded = loadPolicyConfig(rawPolicyConfig(), loadedTable());
    expect(loaded.ok).toBe(true);
    if (loaded.ok) expect(loaded.value.preparationTable.steps.map((s) => s.kind)).toEqual(["order_exists", "order_shipped", "order_cancelled"]);
  });

  it("refuses a configuration that carries its own list of kinds: the table is the single definition (task 2.26)", () => {
    for (const kinds of [[], [{ kind: "widget_exists", params: {} }], [{ kind: "reset", params: {} }]]) {
      const raw = rawPolicyConfig();
      raw["preparationKinds"] = kinds;
      const loaded = loadPolicyConfig(raw, loadedTable());
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.error.join(" ")).toContain("preparationKinds");
    }
  });

  it("refuses a preparation table that is missing or not sound: more than 16 parameters, a reserved kind name, a forbidden field name", () => {
    for (const bad of [undefined, null, 5, {}, { schemaVersion: 1, internalOperations: [], steps: [] }]) {
      expect(loadPolicyConfig(rawPolicyConfig(), bad as never).ok).toBe(false);
    }
    const tooMany = rawTable() as Record<string, any>;
    tooMany["steps"][0]["numbered"]["fields"]["note"] = { type: "string", body: "n" };
    tooMany["steps"][0]["numbered"]["fields"]["tag"] = { type: "string", body: "t" };
    const reserved = rawTable() as Record<string, any>;
    reserved["steps"][0]["kind"] = "reset_all";
    const forbidden = rawTable() as Record<string, any>;
    forbidden["steps"][0]["params"]["host"] = { type: "integer", body: "h" };
    for (const table of [tooMany, reserved, forbidden]) {
      const loaded = loadPolicyConfig(rawPolicyConfig(), table as never);
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) expect(loaded.error.join(" ")).toContain("preparationTable");
    }
  });
  it("rejects a missing, malformed, or widened configuration", () => {
    const mutations: ((c: Record<string, any>) => void)[] = [
      (c) => c["operations"].push({ method: "POST", path: "/reset", readOnly: false }),
      (c) => c["operations"].push({ method: "POST", path: "/test/orders/{id}/ship", readOnly: false }),
      (c) => c["operations"].push({ method: "POST", path: "/RESET/", readOnly: false }),
      (c) => c["operations"].push({ method: "post", path: "/x", readOnly: false }),
      (c) => c["operations"].push({ method: "GET", path: "/products", readOnly: true }),
      (c) => { c["denyFolded"].equals = []; },
      (c) => { c["denyFolded"].prefixes = []; },
      (c) => { c["limits"].requests = 11; },
      (c) => { c["limits"].bodyBytes = 8193; },
      (c) => { delete c["limits"]; },
      (c) => { c["extra"] = 1; },
      (c) => { c["operations"] = []; },
      (c) => { c["schemaVersion"] = 2; },
      (c) => { c["pathParam"] = { min: 5, max: 1 }; },
      (c) => { c["headers"].push({ name: "accept", value: "x" }); },
    ];
    for (const mutate of mutations) {
      const raw = rawPolicyConfig();
      mutate(raw);
      expect(loadPolicyConfig(raw, loadedTable()).ok, JSON.stringify(raw).slice(0, 120)).toBe(false);
    }
    for (const bad of [undefined, null, 5, "x", [], {}]) expect(loadPolicyConfig(bad, loadedTable()).ok).toBe(false);
  });

  it("names a denied operation in the error", () => {
    const raw = rawPolicyConfig();
    raw["operations"].push({ method: "POST", path: "/Test/orders/{id}/ship", readOnly: false });
    const loaded = loadPolicyConfig(raw, loadedTable());
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) expect(loaded.error.join(" ")).toContain("denied operation");
  });

  it("rejects every Experiment when the configuration does not load, and reports it as not ready", () => {
    const raw = rawPolicyConfig();
    raw["denyFolded"] = { equals: [], prefixes: [] };
    const engine = createPolicyEngine(raw, loadedTable());
    expect(engine.ready).toBe(false);
    expect(engine.errors.length).toBeGreaterThan(0);
    expect(engine.decide(accepted)).toEqual({ experimentId: "exp-1", decision: "reject", ruleIds: ["POL-099"] });
    expect(createPolicyEngine(undefined, loadedTable()).ready).toBe(false);
    const good = createPolicyEngine(rawPolicyConfig(), loadedTable());
    expect(good.ready).toBe(true);
    expect(good.decide(accepted).decision).toBe("accept");
  });

  it("returns a frozen configuration", () => {
    expect(Object.isFrozen(cfg)).toBe(true);
    expect(Object.isFrozen(cfg.operations)).toBe(true);
  });
});
