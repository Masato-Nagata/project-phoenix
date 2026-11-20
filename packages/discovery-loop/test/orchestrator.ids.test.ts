// Task 4.4, unit U6a: the identifier counters (`src/orchestrator/ids.ts`). Pure, deterministic, offline.
// **Validates: Requirements 22.2**
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as idsModule from "../src/orchestrator/ids.js";
import { createIdCounters } from "../src/orchestrator/ids.js";

// The common Id pattern of the schema layer (`common.schema.json#/$defs/Id`).
const ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;

describe("identifier formats (R22.2)", () => {
  it("hypothesis ids have no padding, claim ids have 4 digits, evidence ids have no padding", () => {
    const c = createIdCounters();
    expect([c.nextHypothesisId(), c.nextHypothesisId()]).toEqual(["hyp-1", "hyp-2"]);
    expect([c.nextClaimId(), c.nextClaimId()]).toEqual(["clm-0001", "clm-0002"]);
    expect([c.nextEvidenceId(), c.nextEvidenceId()]).toEqual(["evd-1", "evd-2"]);
  });
  it("a claim id passes four digits and grows past them without breaking the pattern", () => {
    const c = createIdCounters();
    let last = "";
    for (let i = 0; i < 10_000; i += 1) last = c.nextClaimId();
    expect(last).toBe("clm-10000");
    expect(ID_PATTERN.test(last)).toBe(true);
  });
  it("experiment ids restart at 1 for each iteration and are independent per iteration", () => {
    const c = createIdCounters();
    expect(c.nextExperimentId(1)).toBe("exp-1-1");
    expect(c.nextExperimentId(1)).toBe("exp-1-2");
    expect(c.nextExperimentId(2)).toBe("exp-2-1");
    expect(c.nextExperimentId(1)).toBe("exp-1-3");
    expect(c.nextExperimentId(2)).toBe("exp-2-2");
  });
  it("the counters of the four kinds do not influence each other", () => {
    const c = createIdCounters();
    c.nextHypothesisId();
    c.nextClaimId();
    c.nextExperimentId(1);
    expect(c.nextEvidenceId()).toBe("evd-1");
    expect(c.nextClaimId()).toBe("clm-0002");
    expect(c.nextHypothesisId()).toBe("hyp-2");
  });
  it("an iteration that is not a non-negative safe integer is refused with a fixed text", () => {
    const c = createIdCounters();
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1" as unknown as number]) {
      expect(() => c.nextExperimentId(bad), String(bad)).toThrow(idsModule.INVALID_ITERATION_MESSAGE);
    }
    expect(c.nextExperimentId(0)).toBe("exp-0-1");
  });
});

describe("determinism and independence", () => {
  type Op = "h" | "c" | "e1" | "e2" | "v";
  const run = (c: ReturnType<typeof createIdCounters>, ops: readonly Op[]): string[] =>
    ops.map((o) => (o === "h" ? c.nextHypothesisId() : o === "c" ? c.nextClaimId() : o === "e1" ? c.nextExperimentId(1) : o === "e2" ? c.nextExperimentId(2) : c.nextEvidenceId()));
  it("the same call order gives the same sequence, every id matches the Id pattern, and two factories do not share state", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom<Op>("h", "c", "e1", "e2", "v"), { maxLength: 60 }), (ops) => {
        const a = createIdCounters();
        const b = createIdCounters();
        const first = run(a, ops);
        const second = run(b, ops); // `b` is untouched by the run on `a`
        expect(second).toEqual(first);
        expect(new Set(first).size).toBe(first.length); // unique within a Run
        for (const id of first) expect(ID_PATTERN.test(id), id).toBe(true);
      }),
      { seed: 44_061, numRuns: 100 },
    );
  });
  it("only the intended names are exported", () => {
    expect(Object.keys(idsModule).sort()).toEqual(["INVALID_ITERATION_MESSAGE", "createIdCounters"]);
  });
});
