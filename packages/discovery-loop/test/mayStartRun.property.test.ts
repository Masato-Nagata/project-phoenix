// Task 4.3: property tests of the start gate `mayStartRun` over arbitrary inputs (fixed seed).
// **Validates: Requirements 2.16, 15.14, 15.15, 15.16**
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { mayStartRun } from "../src/gate/mayStartRun.js";
type Gate = (...args: unknown[]) => unknown;
const gate = mayStartRun as unknown as Gate;
const FC = { seed: 43_003, numRuns: 2000 };
const LITERALS = ["pass", "blocked", "verified", "failed"] as const;
/** Mostly arbitrary values, with the four real literals and near misses mixed in so that both branches are exercised. */
const anyValue: fc.Arbitrary<unknown> = fc.oneof(
  { weight: 3, arbitrary: fc.constantFrom<unknown>(...LITERALS) },
  { weight: 2, arbitrary: fc.string() },
  { weight: 2, arbitrary: fc.constantFrom<unknown>("PASS", " pass", "pass ", "Verified", "verified\0", "", undefined, null, 0, NaN, true, false) },
  { weight: 3, arbitrary: fc.anything() },
);
const spec = (a: unknown, b: unknown): boolean => a === "pass" && b === "verified";
describe("mayStartRun properties", () => {
  it("equals the specification for any two values and never throws", () => {
    fc.assert(
      fc.property(anyValue, anyValue, (a, b) => {
        expect(gate(a, b)).toBe(spec(a, b));
      }),
      FC,
    );
  });
  it("is deterministic: the same inputs always give the same result", () => {
    fc.assert(
      fc.property(anyValue, anyValue, (a, b) => {
        const r1 = gate(a, b);
        const r2 = gate(a, b);
        expect(r2).toBe(r1);
        expect(typeof r1).toBe("boolean");
      }),
      FC,
    );
  });
  it("is true only when BOTH inputs are the exact literals: replacing either one with another value gives false", () => {
    fc.assert(
      fc.property(anyValue, (other) => {
        if (other !== "pass") expect(gate(other, "verified")).toBe(false);
        if (other !== "verified") expect(gate("pass", other)).toBe(false);
      }),
      FC,
    );
  });
  it("ignores any extra argument, whatever it is", () => {
    fc.assert(
      fc.property(anyValue, anyValue, anyValue, (a, b, extra) => {
        expect(gate(a, b, extra)).toBe(spec(a, b));
      }),
      FC,
    );
  });
  it("is not symmetric: swapping the arguments of the one true combination gives false", () => {
    expect(gate("pass", "verified")).toBe(true);
    expect(gate("verified", "pass")).toBe(false);
  });
  it("a result true needs each input to be true on its own: the audit input alone or the denial input alone never starts a Run", () => {
    fc.assert(
      fc.property(anyValue, (v) => {
        expect(gate("pass", v)).toBe(v === "verified");
        expect(gate(v, "verified")).toBe(v === "pass");
      }),
      FC,
    );
  });
});
