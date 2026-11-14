// The preparation table, the validation of a step, and the request body built from it (task 2.15 and 2.17; design "Runner-owned
// preparation table", "Numbered line parameters and the single definition"; R7.3, R9.10, R9.12).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildStepBody, loadPreparationTable, validatePreparationStep, validatePreparationSteps } from "../src/index.js";
import { deepFreeze } from "./helpers/compareFixtures.js";
import { loadedTable, rawTable, stepOf } from "./helpers/prepFixtures.js";

const table = loadedTable();
type Raw = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const mutated = (fn: (t: Raw) => void): ReturnType<typeof loadPreparationTable> => {
  const t = rawTable() as Raw;
  fn(t);
  return loadPreparationTable(t);
};
const errorsOf = (r: ReturnType<typeof loadPreparationTable> | ReturnType<typeof validatePreparationStep>): string[] => (r.ok ? [] : r.error);

describe("the data file", () => {
  it("loads, and defines the three kinds of the design with at most 3 operations each", () => {
    expect(table.steps.map((s) => s.kind)).toEqual(["order_exists", "order_shipped", "order_cancelled"]);
    for (const s of table.steps) {
      expect(s.translate.length).toBeGreaterThanOrEqual(1);
      expect(s.translate.length).toBeLessThanOrEqual(3);
      expect(s.numbered).toMatchObject({ name: "lines", min: 1, max: 5 });
      expect(Object.keys(s.params).length + Object.keys(s.numbered?.fields ?? {}).length * 5).toBeLessThanOrEqual(16);
    }
  });

  it("the ship operation is reachable only through order_shipped, and the internal operations are the three of the design", () => {
    const users = table.steps.filter((s) => s.translate.some((o) => o.path.startsWith("/test/")));
    expect(users.map((s) => s.kind)).toEqual(["order_shipped"]);
    expect(table.internalOperations).toEqual([
      { method: "GET", path: "/health" },
      { method: "POST", path: "/reset" },
      { method: "POST", path: "/test/orders/{id}/ship" },
    ]);
  });

  it("holds HTTP shapes and expected statuses only: no value other than structural limits and statuses", () => {
    const numbers = new Set<number>();
    JSON.stringify(rawTable(), (_k, v: unknown) => {
      if (typeof v === "number") numbers.add(v);
      return v;
    });
    expect([...numbers].sort((a, b) => a - b)).toEqual([1, 5, 200, 201, 2147483647]);
  });

  it("is frozen after loading", () => {
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(table.steps[0])).toBe(true);
  });
});

describe("loadPreparationTable refuses a table that is not sound", () => {
  const cases: [string, (t: Raw) => void, string][] = [
    ["a table that is not an object", () => undefined, ""],
    ["an unknown field", (t) => { t["extra"] = 1; }, "unknown field"],
    ["a wrong schema version", (t) => { t["schemaVersion"] = 2; }, "schemaVersion"],
    ["no health operation", (t) => { t["internalOperations"] = t["internalOperations"].filter((o: Raw) => o["path"] !== "/health"); }, "GET /health"],
    ["no reset operation", (t) => { t["internalOperations"] = t["internalOperations"].filter((o: Raw) => o["path"] !== "/reset"); }, "POST /reset"],
    ["a kind named reset", (t) => { t["steps"][0]["kind"] = "reset_all"; }, "kind"],
    ["a kind named test", (t) => { t["steps"][0]["kind"] = "test"; }, "kind"],
    ["a duplicate kind", (t) => { t["steps"][1]["kind"] = "order_exists"; }, "duplicate"],
    ["a forbidden parameter name", (t) => { t["steps"][0]["params"]["host"] = { type: "integer", body: "host" }; }, "forbidden"],
    ["a numbered field that makes a forbidden name", (t) => { t["steps"][0]["numbered"]["fields"]["path"] = { type: "integer", body: "p" }; }, "forbidden"],
    ["a numbered field that ends with _<digits>", (t) => { t["steps"][0]["numbered"]["fields"]["x_1"] = { type: "integer", body: "x" }; }, "_<digits>"],
    ["a fixed parameter that collides with a numbered parameter", (t) => { t["steps"][0]["params"]["product_1"] = { type: "integer", body: "p" }; }, "collides"],
    ["more than 5 lines", (t) => { t["steps"][0]["numbered"]["max"] = 6; }, "max"],
    ["min above max", (t) => { t["steps"][0]["numbered"]["min"] = 4; t["steps"][0]["numbered"]["max"] = 2; }, "min and max"],
    ["more parameters than the M1 limit of 16", (t) => { const f = t["steps"][0]["numbered"]["fields"]; f["note"] = { type: "string", body: "n" }; f["tag"] = { type: "string", body: "t" }; }, "above the limit"],
    ["an optional numbered field", (t) => { t["steps"][0]["numbered"]["fields"]["quantity"]["optional"] = true; }, "optional"],
    ["a parameter without a body name", (t) => { delete t["steps"][0]["params"]["customer_id"]["body"]; }, "body"],
    ["a rule with min above max", (t) => { t["steps"][0]["params"]["customer_id"]["min"] = 9; t["steps"][0]["params"]["customer_id"]["max"] = 2; }, "min is above max"],
    ["no operation", (t) => { t["steps"][0]["translate"] = []; }, "1 to 3"],
    ["more than 3 operations", (t) => { t["steps"][1]["translate"].push(t["steps"][1]["translate"][1], t["steps"][1]["translate"][1]); }, "1 to 3"],
    ["a placeholder other than {bound}", (t) => { t["steps"][1]["translate"][1]["path"] = "/test/orders/{id}/ship"; }, "only placeholder"],
    ["{bound} without an earlier capture", (t) => { delete t["steps"][1]["translate"][0]["capture"]; }, "needs an earlier"],
    ["two captures in one kind", (t) => { t["steps"][1]["translate"][1]["capture"] = { bindTo: "step.bind", fromResponse: "data.x" }; }, "more than one capture"],
    ["a preparation operation that is the reset", (t) => { t["steps"][1]["translate"][1]["path"] = "/reset"; }, "reset or health"],
    ["a preparation operation that is the health check", (t) => { t["steps"][1]["translate"][1]["path"] = "/health"; }, "reset or health"],
    ["a path with a traversal", (t) => { t["steps"][1]["translate"][1]["path"] = "/a/../b"; }, "path template"],
    ["a path with an authority", (t) => { t["steps"][1]["translate"][1]["path"] = "//host/x"; }, "path template"],
    ["a body on a GET operation", (t) => { t["steps"][1]["translate"][1]["method"] = "GET"; t["steps"][1]["translate"][1]["body"] = "assembled"; }, "only"],
    ["a capture path that is not dotted names", (t) => { t["steps"][0]["translate"][0]["capture"]["fromResponse"] = "data[0].id"; }, "dotted"],
    ["a status that is not an HTTP status", (t) => { t["steps"][0]["translate"][0]["expect"] = 99; }, "HTTP status"],
    ["a capture target other than step.bind", (t) => { t["steps"][0]["translate"][0]["capture"]["bindTo"] = "elsewhere"; }, "bindTo"],
  ];
  for (const [name, change, needle] of cases) {
    it(name, () => {
      if (name === "a table that is not an object") {
        for (const bad of [undefined, null, 5, "x", []]) expect(loadPreparationTable(bad).ok).toBe(false);
        return;
      }
      const r = mutated(change);
      expect(r.ok, name).toBe(false);
      expect(errorsOf(r).join(" | ")).toContain(needle);
    });
  }
});

describe("validatePreparationStep: the seven rules of the design", () => {
  it("accepts 1 to 5 lines, and returns the lines in numeric order", () => {
    for (let k = 1; k <= 5; k += 1) {
      const r = validatePreparationStep(table, stepOf("order_exists", k));
      expect(r.ok, `k = ${k}`).toBe(true);
      if (r.ok) {
        expect(r.value.lines.length).toBe(k);
        expect(r.value.lines.map((l) => l["product"])).toEqual(Array.from({ length: k }, (_, i) => i + 1));
        expect(r.value.fixed).toEqual({ customer_id: 1 });
      }
    }
  });

  it("rule 1: only one field of an index is present", () => {
    const s = stepOf("order_exists", 1);
    s.params["product_2"] = 3;
    expect(errorsOf(validatePreparationStep(table, s))).toContain("numbered_incomplete:2");
    const t = stepOf("order_exists", 1);
    delete t.params["quantity_1"];
    expect(errorsOf(validatePreparationStep(table, t))).toContain("numbered_incomplete:1");
  });

  it("rule 2: the indexes present are not exactly 1 to k (a gap)", () => {
    const s = stepOf("order_exists", 3);
    delete s.params["product_2"];
    delete s.params["quantity_2"];
    expect(errorsOf(validatePreparationStep(table, s))).toEqual(["numbered_gap"]);
    const t = stepOf("order_exists", 0);
    t.params["product_2"] = 1;
    t.params["quantity_2"] = 1;
    expect(errorsOf(validatePreparationStep(table, t))).toEqual(["numbered_gap"]);
  });

  it("rule 3: k or an index above the maximum", () => {
    const s = stepOf("order_exists", 5);
    s.params["product_6"] = 1;
    s.params["quantity_6"] = 1;
    expect(errorsOf(validatePreparationStep(table, s)).sort()).toEqual(["numbered_over_max:product_6", "numbered_over_max:quantity_6"]);
    const t = stepOf("order_exists", 1);
    t.params["product_999999999999"] = 1;
    expect(errorsOf(validatePreparationStep(table, t))).toContain("numbered_over_max:product_999999999999");
  });

  it("rule 4: an index that is 0, has a leading zero, or a name that is not exactly <field>_<n>", () => {
    for (const name of ["product_0", "product_01", "product_001"]) {
      const s = stepOf("order_exists", 1);
      s.params[name] = 1;
      expect(errorsOf(validatePreparationStep(table, s)), name).toContain(`numbered_index_invalid:${name}`);
    }
    for (const name of ["Product_1", "product_1x", "product__1", "product_", "product1", "product_-1", "product_1.5", " product_1"]) {
      const s = stepOf("order_exists", 1);
      s.params[name] = 1;
      expect(errorsOf(validatePreparationStep(table, s)), name).toContain(`param_unknown:${name}`);
    }
  });

  it("rule 5: k below the minimum", () => {
    expect(errorsOf(validatePreparationStep(table, stepOf("order_exists", 0)))).toEqual(["numbered_under_min"]);
  });

  it("rule 6: a value of the wrong type or outside its range", () => {
    for (const bad of ["1", 0, -1, 1.5, 2147483648, null, true, [], {}, Number.NaN, Number.POSITIVE_INFINITY, 9007199254740993]) {
      expect(errorsOf(validatePreparationStep(table, stepOf("order_exists", 1, { customer_id: bad }))), String(bad)).toEqual(["value_invalid:customer_id"]);
      const s = stepOf("order_exists", 1);
      s.params["quantity_1"] = bad;
      expect(errorsOf(validatePreparationStep(table, s)), String(bad)).toEqual(["value_invalid:quantity_1"]);
    }
    expect(validatePreparationStep(table, stepOf("order_exists", 1, { customer_id: 2147483647 })).ok).toBe(true);
  });

  it("rule 7: a parameter the table does not define, a missing fixed parameter, a bind that is not a local key", () => {
    expect(errorsOf(validatePreparationStep(table, stepOf("order_exists", 1, { sku: 1 })))).toEqual(["param_unknown:sku"]);
    const missing = stepOf("order_exists", 1);
    delete missing.params["customer_id"];
    expect(errorsOf(validatePreparationStep(table, missing))).toEqual(["param_missing:customer_id"]);
    for (const bind of ["Bad", "1x", "a-b", "", "x".repeat(33), 5 as unknown as string]) {
      expect(errorsOf(validatePreparationStep(table, stepOf("order_exists", 1, {}, bind))), String(bind)).toEqual(["bind_invalid"]);
    }
    expect(validatePreparationStep(table, stepOf("order_exists", 1, {}, "created_order")).ok).toBe(true);
  });

  it("a bind used twice is refused when the steps are validated together", () => {
    expect(validatePreparationSteps(table, [stepOf("order_exists", 1, {}, "a"), stepOf("order_cancelled", 2, {}, "a")])).toEqual({ ok: false, error: ["step[1]:bind_duplicate"] });
    expect(validatePreparationSteps(table, [stepOf("order_exists", 1, {}, "a"), stepOf("order_cancelled", 2, {}, "b")]).ok).toBe(true);
    expect(validatePreparationSteps(table, [stepOf("order_exists", 0)])).toEqual({ ok: false, error: ["step[0]:numbered_under_min"] });
  });

  it("an unknown kind, a kind that names the reset or the test namespace, and a step of the wrong shape", () => {
    for (const kind of ["nope", "reset", "reset_db", "test_ship", "ORDER_EXISTS", "", "constructor", "__proto__"]) {
      expect(errorsOf(validatePreparationStep(table, { kind, params: {} })), kind).toContain("kind_unknown");
    }
    for (const bad of [undefined, null, 5, "x", [], { kind: "order_exists" }, { kind: "order_exists", params: [] }, { kind: "order_exists", params: null }]) {
      expect(validatePreparationStep(table, bad).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(errorsOf(validatePreparationStep(table, { ...stepOf("order_exists", 1), method: "GET" }))).toContain("step_shape");
    expect(errorsOf(validatePreparationStep(table, { ...stepOf("order_exists", 1), path: "/reset" }))).toContain("step_shape");
  });

  it("a parameter named after Object.prototype is unknown, not inherited", () => {
    const raw = JSON.parse('{"kind":"order_exists","params":{"customer_id":1,"product_1":1,"quantity_1":1,"__proto__":1,"constructor":1}}') as unknown;
    expect(errorsOf(validatePreparationStep(table, raw)).sort()).toEqual(["param_unknown:__proto__", "param_unknown:constructor"]);
  });

  it("never throws, and does not modify its input", () => {
    const s = deepFreeze(stepOf("order_cancelled", 3, {}, "x"));
    expect(validatePreparationStep(table, s).ok).toBe(true);
    const evil = { kind: "order_exists", get params(): never { throw new Error("boom"); } };
    expect(validatePreparationStep(table, evil).ok).toBe(false);
  });
});

describe("buildStepBody: the body of the request, from the same definition", () => {
  it("has the fixed parameters under their body names and the lines in numeric order with exactly the given values", () => {
    const params: Record<string, unknown> = { quantity_3: 33, product_2: 22, customer_id: 7, quantity_1: 11, product_3: 3, quantity_2: 2, product_1: 1 };
    const r = buildStepBody(table, { kind: "order_exists", params });
    expect(r).toEqual({ ok: true, value: { customer_id: 7, lines: [{ product_id: 1, quantity: 11 }, { product_id: 22, quantity: 2 }, { product_id: 3, quantity: 33 }] } });
  });

  it("fails for a step that is not valid, and builds nothing", () => {
    expect(buildStepBody(table, stepOf("order_exists", 0)).ok).toBe(false);
    expect(buildStepBody(table, stepOf("order_exists", 2, { customer_id: "1" })).ok).toBe(false);
  });

  it("is deterministic, does not modify the step, and returns a new value each time", () => {
    const s = deepFreeze(stepOf("order_shipped", 2));
    const a = buildStepBody(table, s);
    const b = buildStepBody(table, s);
    expect(a).toEqual(b);
    expect(a.ok && b.ok && a.value !== b.value).toBe(true);
  });

  it("for any k in 1..5, any order of the keys, and any values: the lines come out in numeric order with the given values", () => {
    const valueArb = fc.integer({ min: 1, max: 2147483647 });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5 }),
        fc.array(valueArb, { minLength: 10, maxLength: 10 }),
        valueArb,
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 11, maxLength: 11 }),
        (k, vs, customer, order) => {
          const entries: [string, unknown][] = [["customer_id", customer]];
          for (let n = 1; n <= k; n += 1) entries.push([`product_${n}`, vs[2 * (n - 1)]], [`quantity_${n}`, vs[2 * (n - 1) + 1]]);
          const shuffled = entries.map((e, i) => ({ e, key: order[i % order.length] as number })).sort((x, y) => x.key - y.key).map((x) => x.e);
          const r = buildStepBody(table, { kind: "order_cancelled", params: Object.fromEntries(shuffled) });
          expect(r.ok).toBe(true);
          if (r.ok) {
            const expected = Array.from({ length: k }, (_, i) => ({ product_id: vs[2 * i], quantity: vs[2 * i + 1] }));
            expect(r.value).toEqual({ customer_id: customer, lines: expected });
          }
        },
      ),
      { seed: 340035, numRuns: 200 },
    );
  });
});