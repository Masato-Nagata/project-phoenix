// Feature: discovery-loop, Property 36: Preparation steps are validated and translated by one definition
// **Validates: Requirements 7.3, 8.2, 8.3, 9.10, 9.12**
//
// The preparation table is the only definition of the kinds and the parameters (task 2.26). For any preparation step:
//   - the policy (POL-011) reports the step if and only if `validatePreparationStep` rejects it, or its `bind` repeats an earlier one;
//   - a step that the table accepts is translated by the Runner into exactly the operations of the table, in the order of the table,
//     with the body that `buildStepBody` builds, and the lines in numeric order with the given values;
//   - a step that the table rejects sends nothing, not even the reset.
// Reproducibility record: SEED = 340038, NUM_RUNS = 300. Neutral values only.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildStepBody, canonicalIdentityText, decideDetailed, validatePreparationSteps, type Experiment } from "../src/index.js";
import { loadedPolicyConfig } from "./helpers/policyFixtures.js";
import { loadedTable } from "./helpers/prepFixtures.js";
import { experiment, makeEnv, stop } from "./helpers/runnerFixtures.js";

const SEED = 340038;
const NUM_RUNS = 300;
const TIMEOUT_MS = 120_000;
const table = loadedTable();
const cfg = loadedPolicyConfig();

const KINDS = ["order_exists", "order_shipped", "order_cancelled", "nope", "reset"] as const;
const value = fc.oneof({ weight: 8, arbitrary: fc.integer({ min: 1, max: 2147483647 }) }, { weight: 2, arbitrary: fc.constantFrom(0, -1, 2147483648, 1.5, "1", null, true) });
const stepArb: fc.Arbitrary<unknown> = fc.oneof(
  {
    weight: 9,
    arbitrary: fc
      .record({
        kind: fc.constantFrom(...KINDS),
        bind: fc.option(fc.constantFrom("a", "b", "Bad", "c_1"), { nil: undefined }),
        customer: fc.option(value, { nil: undefined }),
        lines: fc.array(fc.record({ n: fc.constantFrom(0, 1, 1, 2, 3, 4, 5, 6), product: fc.option(value, { nil: undefined }), quantity: fc.option(value, { nil: undefined }) }), { maxLength: 6 }),
        extra: fc.option(fc.constantFrom("sku", "product_01", "quantity_", "Product_1"), { nil: undefined }),
      })
      .map((s) => {
        const params: Record<string, unknown> = {};
        if (s.customer !== undefined) params["customer_id"] = s.customer;
        for (const [i, l] of s.lines.entries()) {
          const n = i < 2 ? i + 1 : l.n; // mostly consecutive indexes, sometimes not
          if (l.product !== undefined) params[`product_${n}`] = l.product;
          if (l.quantity !== undefined) params[`quantity_${n}`] = l.quantity;
        }
        if (s.extra !== undefined) params[s.extra] = 1;
        return { kind: s.kind, ...(s.bind !== undefined ? { bind: s.bind } : {}), params };
      }),
  },
  { weight: 1, arbitrary: fc.anything() },
);
/** A step that is valid by construction. */
const validStepArb = fc
  .record({
    kind: fc.constantFrom("order_exists", "order_shipped", "order_cancelled"),
    customer: fc.integer({ min: 1, max: 2147483647 }),
    lines: fc.array(fc.record({ product: fc.integer({ min: 1, max: 2147483647 }), quantity: fc.integer({ min: 1, max: 2147483647 }) }), { minLength: 1, maxLength: 5 }),
    order: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 11, maxLength: 11 }),
  })
  .map((s) => {
    const entries: [string, unknown][] = [["customer_id", s.customer]];
    s.lines.forEach((l, i) => entries.push([`product_${i + 1}`, l.product], [`quantity_${i + 1}`, l.quantity]));
    const shuffled = entries.map((e, i) => ({ e, k: s.order[i % s.order.length] as number })).sort((a, b) => a.k - b.k).map((x) => x.e);
    return { kind: s.kind, bind: "w1", params: Object.fromEntries(shuffled) };
  });

const polIds = (e: unknown) => decideDetailed(e as Experiment, cfg).ruleIds;
const wrap = (steps: unknown[]) => ({ experimentId: "exp-1", requests: [{ method: "GET", path: "/products" }], preparation: steps });

describe(`Property 36: Preparation steps are validated and translated by one definition (seed ${SEED}, numRuns ${NUM_RUNS})`, () => {
  it("the policy reports POL-011 if and only if the table rejects a step or a bind repeats", () => {
    fc.assert(
      fc.property(fc.array(stepArb, { maxLength: 3 }), (steps) => {
        const byTable = validatePreparationSteps(table, steps);
        const policy = polIds(wrap(steps));
        expect(policy.includes("POL-011")).toBe(!byTable.ok);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("a valid step is translated by the Runner into the operations of the table, with the body of buildStepBody", async () => {
    await fc.assert(
      fc.asyncProperty(validStepArb, async (step) => {
        const e = experiment({ preparation: [step] } as never);
        expect(polIds(e)).toEqual([]);
        const built = buildStepBody(table, step);
        expect(built.ok).toBe(true);
        const env = makeEnv();
        await env.runner.health();
        const o = await env.runner.execute(e, "dec-1", stop());
        expect(o.status).toBe("executed");
        const kind = table.steps.find((k) => k.kind === step.kind);
        const ops = (kind?.translate ?? []).map((op) => `${op.method} ${op.path.replace("{bound}", "1")}`);
        expect(env.http.seen.slice(1, 2 + ops.length)).toEqual(["POST /reset", ...ops]);
        const sent = env.http.calls[2]?.req;
        expect(sent?.method).toBe("POST");
        expect(sent?.path).toBe("/orders");
        expect(sent?.body).toBe(built.ok ? canonicalIdentityText(built.value) : "");
        // The lines come out in numeric order with exactly the given values.
        const lines = (JSON.parse(sent?.body ?? "{}") as { lines: { product_id: number; quantity: number }[] }).lines;
        const given = Object.entries(step.params).filter(([k]) => k.startsWith("product_")).length;
        expect(lines.length).toBe(given);
        lines.forEach((l, i) => {
          expect(l.product_id).toBe((step.params as Record<string, number>)[`product_${i + 1}`]);
          expect(l.quantity).toBe((step.params as Record<string, number>)[`quantity_${i + 1}`]);
        });
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("a step that the table rejects sends nothing, not even the reset: the policy rejects it, and so does the re-decision", async () => {
    await fc.assert(
      fc.asyncProperty(stepArb, async (step) => {
        fc.pre(!validatePreparationSteps(table, [step]).ok);
        const env = makeEnv();
        await env.runner.health();
        const o = await env.runner.execute(experiment({ preparation: [step] } as never), "dec-1", stop());
        expect(o.status).toBe("not_executed");
        expect(o.status === "not_executed" && o.detail).toMatch(/^(redecision_rejected:POL-011|experiment_not_hashable)$/); // the second only for a value that is not JSON
        expect(env.http.seen).toEqual(["GET /health"]);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);
});