// Task 4.4, unit U1: the termination latch (`src/orchestrator/terminationLatch.ts`). Pure, deterministic, offline; fixed seed.
// Every expectation below is written by hand and does NOT derive from the constant under test (`TERMINATION_PRIORITY`).
// **Validates: Requirements 11.9, 11.12, 11.16, 11.17, 15.6, 24.12, 24.15**
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SYMPTOMS, TERMINATION_PRIORITY, createTerminationLatch, rankOf, type Symptom } from "../src/orchestrator/terminationLatch.js";
import { TERMINATION_REASONS, type TerminationReason } from "../src/orchestrator/types.js";

const FC = { seed: 44_004, numRuns: 300 };

// Hard-coded priority, highest first. Index = rank. The last two share a rank.
const NAMES = [
  "isolation_violation", // 0
  "launcher_killed", // 1
  "lease_unavailable", // 2
  "error", // 3
  "time_limit_reached", // 4
  "payload_audit_blocked", // 5
  "provider_failure", // 6
  "policy_rejection_limit", // 7
  "no_further_experiments", // 8
  "experiment_limit_reached", // 9
  "iteration_limit_reached", // 9 (same rank)
] as const satisfies readonly TerminationReason[];
const RANK_LITERAL: Readonly<Record<string, number>> = {
  isolation_violation: 0,
  launcher_killed: 1,
  lease_unavailable: 2,
  error: 3,
  time_limit_reached: 4,
  payload_audit_blocked: 5,
  provider_failure: 6,
  policy_rejection_limit: 7,
  no_further_experiments: 8,
  experiment_limit_reached: 9,
  iteration_limit_reached: 9,
};
const GROUPS_LITERAL: readonly (readonly string[])[] = [
  ["isolation_violation"],
  ["launcher_killed"],
  ["lease_unavailable"],
  ["error"],
  ["time_limit_reached"],
  ["payload_audit_blocked"],
  ["provider_failure"],
  ["policy_rejection_limit"],
  ["no_further_experiments"],
  ["experiment_limit_reached", "iteration_limit_reached"],
];
// MATRIX[a][b] = index (into NAMES) of the final reason when NAMES[a] is raised first and NAMES[b] second.
// Different ranks: the smaller index wins. Same rank (only 9 and 10): the first raised stays.
const MATRIX: readonly (readonly number[])[] = [
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  [0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [0, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2],
  [0, 1, 2, 3, 3, 3, 3, 3, 3, 3, 3],
  [0, 1, 2, 3, 4, 4, 4, 4, 4, 4, 4],
  [0, 1, 2, 3, 4, 5, 5, 5, 5, 5, 5],
  [0, 1, 2, 3, 4, 5, 6, 6, 6, 6, 6],
  [0, 1, 2, 3, 4, 5, 6, 7, 7, 7, 7],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 8, 8],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9],
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 10],
];

const finalOf = (seq: readonly TerminationReason[]): TerminationReason | undefined => {
  const l = createTerminationLatch();
  for (const r of seq) l.raise(r);
  const s = l.status();
  return s.state === "none" ? undefined : s.reason;
};
/** The pairs `a>b` whose final reason differs from the hard-coded matrix. */
function matrixDiffs(winner: (a: string, b: string) => string | undefined): string[] {
  const out: string[] = [];
  for (let a = 0; a < NAMES.length; a++) {
    for (let b = 0; b < NAMES.length; b++) {
      const expected = NAMES[MATRIX[a]?.[b] as number];
      if (winner(NAMES[a] as string, NAMES[b] as string) !== expected) out.push(`${NAMES[a]}>${NAMES[b]}`);
    }
  }
  return out;
}
/** A copy of the algorithm over a rank table: a strictly higher rank replaces, otherwise the first stays. */
const algorithmOver =
  (groups: readonly (readonly string[])[]) =>
  (a: string, b: string): string => {
    const rank = (x: string): number => groups.findIndex((g) => g.includes(x));
    return rank(b) < rank(a) ? b : a;
  };

describe("priority (hard-coded)", () => {
  it("TERMINATION_PRIORITY is exactly the human-decided order, with the two limits in the last group", () => {
    expect(TERMINATION_PRIORITY.map((g) => [...g])).toEqual(GROUPS_LITERAL.map((g) => [...g]));
    expect(TERMINATION_PRIORITY).toHaveLength(10);
    expect(TERMINATION_PRIORITY[9]).toHaveLength(2);
  });
  it("rankOf returns the hard-coded rank of each of the 11 reasons (equal for the last two)", () => {
    for (const n of NAMES) expect(rankOf(n), n).toBe(RANK_LITERAL[n]);
    expect(rankOf("experiment_limit_reached")).toBe(rankOf("iteration_limit_reached"));
  });
  it("every ordered pair gives the hard-coded final reason (matrix of 121 pairs)", () => {
    expect(matrixDiffs((a, b) => finalOf([a as TerminationReason, b as TerminationReason]))).toEqual([]);
  });
  it("the matrix check detects a change of the priority order (mutation control)", () => {
    // the in-test algorithm over the correct table agrees with the matrix ...
    expect(matrixDiffs(algorithmOver(GROUPS_LITERAL))).toEqual([]);
    // ... and over a copy with two adjacent ranks swapped (error <-> time_limit_reached) it reports exactly the two pairs of that swap
    const swapped = GROUPS_LITERAL.map((g) => [...g]);
    [swapped[3], swapped[4]] = [swapped[4] as string[], swapped[3] as string[]];
    expect(matrixDiffs(algorithmOver(swapped)).sort()).toEqual(["error>time_limit_reached", "time_limit_reached>error"]);
    // moving the two limits above no_further_experiments (ranks 8 and 9 swapped) is detected as well
    const mergedWrongly = GROUPS_LITERAL.map((g) => [...g]);
    [mergedWrongly[8], mergedWrongly[9]] = [mergedWrongly[9] as string[], mergedWrongly[8] as string[]];
    expect(matrixDiffs(algorithmOver(mergedWrongly)).length).toBeGreaterThan(0);
  });
  it("property: the final reason has the best rank raised, and among equals the first raised wins", () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...NAMES), { minLength: 1, maxLength: 14 }), (seq) => {
        const best = Math.min(...seq.map((r) => RANK_LITERAL[r] as number));
        const expected = seq.find((r) => RANK_LITERAL[r] === best);
        expect(finalOf(seq)).toBe(expected);
      }),
      FC,
    );
  });
});

describe("latch rules", () => {
  it("starts with no cause", () => {
    expect(createTerminationLatch().status()).toEqual({ state: "none" });
  });
  it("the first cause is latched", () => {
    const l = createTerminationLatch();
    expect(l.raise("provider_failure")).toBe("latched");
    expect(l.status()).toEqual({ state: "pending", reason: "provider_failure" });
  });
  it("a higher priority replaces a pending cause", () => {
    const l = createTerminationLatch();
    l.raise("no_further_experiments");
    expect(l.raise("time_limit_reached")).toBe("upgraded");
    expect(l.status()).toEqual({ state: "pending", reason: "time_limit_reached" });
    expect(l.raise("isolation_violation")).toBe("upgraded");
    expect(l.status()).toEqual({ state: "pending", reason: "isolation_violation" });
  });
  it("a lower priority is ignored, and so is the same reason twice", () => {
    const l = createTerminationLatch();
    l.raise("error");
    expect(l.raise("time_limit_reached")).toBe("ignored_not_higher");
    expect(l.raise("iteration_limit_reached")).toBe("ignored_not_higher");
    expect(l.raise("error")).toBe("ignored_not_higher");
    expect(l.status()).toEqual({ state: "pending", reason: "error" });
  });
  it("the same rank keeps the first detected, in both directions", () => {
    const a = createTerminationLatch();
    a.raise("experiment_limit_reached");
    expect(a.raise("iteration_limit_reached")).toBe("ignored_not_higher");
    expect(a.status()).toEqual({ state: "pending", reason: "experiment_limit_reached" });
    const b = createTerminationLatch();
    b.raise("iteration_limit_reached");
    expect(b.raise("experiment_limit_reached")).toBe("ignored_not_higher");
    expect(b.status()).toEqual({ state: "pending", reason: "iteration_limit_reached" });
  });
  it("finalize freezes the pending reason and reports it", () => {
    const l = createTerminationLatch();
    l.raise("policy_rejection_limit");
    expect(l.finalize()).toEqual({ ok: true, value: { reason: "policy_rejection_limit", alreadyFinalized: false } });
    expect(l.status()).toEqual({ state: "finalized", reason: "policy_rejection_limit" });
  });
  it("finalize is idempotent", () => {
    const l = createTerminationLatch();
    l.raise("provider_failure");
    l.finalize();
    expect(l.finalize()).toEqual({ ok: true, value: { reason: "provider_failure", alreadyFinalized: true } });
    expect(l.finalize()).toEqual({ ok: true, value: { reason: "provider_failure", alreadyFinalized: true } });
    expect(l.status()).toEqual({ state: "finalized", reason: "provider_failure" });
  });
  it("finalize with no cause fails with no_cause, keeps the state none and invents no reason", () => {
    const l = createTerminationLatch();
    expect(l.finalize()).toEqual({ ok: false, error: { code: "no_cause" } });
    expect(l.status()).toEqual({ state: "none" });
    expect(l.finalize()).toEqual({ ok: false, error: { code: "no_cause" } });
    expect(l.raise("error")).toBe("latched"); // still open for a cause
  });
  it("raise after finalize is ignored for every reason, including a higher priority one", () => {
    for (const first of ["no_further_experiments", "error"] as const) {
      const l = createTerminationLatch();
      l.raise(first);
      l.finalize();
      for (const r of NAMES) {
        expect(l.raise(r), `${first} then ${r}`).toBe("ignored_finalized");
        expect(l.status(), `${first} then ${r}`).toEqual({ state: "finalized", reason: first });
      }
    }
  });
  it("a failed termination-record write does not change a finalized reason (the status is identical before and after)", () => {
    const l = createTerminationLatch();
    l.raise("time_limit_reached");
    l.finalize();
    const before = l.status();
    // the writer reports its failure by raising `error` (and a defect by anything else); both are ignored
    expect(l.raise("error")).toBe("ignored_finalized");
    expect(l.raise("isolation_violation")).toBe("ignored_finalized");
    expect(l.raise("nope" as never)).toBe("ignored_finalized");
    expect(l.status()).toEqual(before);
    expect(l.status()).toEqual({ state: "finalized", reason: "time_limit_reached" });
  });
  it("returned objects are frozen, and the tables are frozen", () => {
    const l = createTerminationLatch();
    expect(Object.isFrozen(l)).toBe(true);
    expect(Object.isFrozen(l.status())).toBe(true);
    l.raise("error");
    expect(Object.isFrozen(l.status())).toBe(true);
    const f = l.finalize();
    expect(Object.isFrozen(f)).toBe(true);
    expect(f.ok && Object.isFrozen(f.value)).toBe(true);
    expect(Object.isFrozen(l.attributeSymptom("interrupted"))).toBe(true);
    const none = createTerminationLatch().finalize();
    expect(Object.isFrozen(none)).toBe(true);
    expect(!none.ok && Object.isFrozen(none.error)).toBe(true);
    expect(Object.isFrozen(TERMINATION_PRIORITY)).toBe(true);
    for (const g of TERMINATION_PRIORITY) expect(Object.isFrozen(g)).toBe(true);
  });
  it("two latches share nothing", () => {
    const a = createTerminationLatch();
    const b = createTerminationLatch();
    a.raise("error");
    a.finalize();
    expect(b.status()).toEqual({ state: "none" });
    expect(b.raise("provider_failure")).toBe("latched");
  });
});

describe("invalid reason values (fail closed)", () => {
  const CANARY = "CANARY-7f3a91-not-a-reason";
  const BAD: readonly unknown[] = [undefined, null, 42, "", "nope", {}, Symbol("s"), CANARY, { toString: () => { throw new Error("must not be called"); } }, ["error"], "ERROR", " error"];
  it("latches error, never throws, and never stores or echoes the bad value", () => {
    for (const bad of BAD) {
      const l = createTerminationLatch();
      let outcome: unknown;
      expect(() => {
        outcome = l.raise(bad as never);
      }).not.toThrow();
      expect(outcome).toBe("latched_invalid_reason");
      expect(l.status()).toEqual({ state: "pending", reason: "error" });
      expect(JSON.stringify([outcome, l.status(), l.finalize()])).not.toContain(CANARY);
    }
  });
  it("upgrades a lower pending cause to error, and is ignored when the pending cause is already at least as high", () => {
    const low = createTerminationLatch();
    low.raise("provider_failure");
    expect(low.raise(CANARY as never)).toBe("upgraded_invalid_reason");
    expect(low.status()).toEqual({ state: "pending", reason: "error" });
    expect(JSON.stringify(low.status())).not.toContain(CANARY);
    const high = createTerminationLatch();
    high.raise("isolation_violation");
    expect(high.raise(CANARY as never)).toBe("ignored_not_higher");
    expect(high.status()).toEqual({ state: "pending", reason: "isolation_violation" });
    const same = createTerminationLatch();
    same.raise("error");
    expect(same.raise(undefined as never)).toBe("ignored_not_higher");
  });
  it("is ignored after finalize", () => {
    const l = createTerminationLatch();
    l.raise("no_further_experiments");
    l.finalize();
    expect(l.raise(CANARY as never)).toBe("ignored_finalized");
    expect(l.status()).toEqual({ state: "finalized", reason: "no_further_experiments" });
  });
  it("property: any string that is not one of the 11 reasons latches error", () => {
    fc.assert(
      fc.property(fc.string().filter((s) => !(TERMINATION_REASONS as readonly string[]).includes(s)), (s) => {
        const l = createTerminationLatch();
        expect(l.raise(s as never)).toBe("latched_invalid_reason");
        expect(l.status()).toEqual({ state: "pending", reason: "error" });
      }),
      FC,
    );
  });
});

describe("symptoms (not reasons)", () => {
  const SYMPTOM_LITERAL: readonly string[] = ["interrupted", "forced_stop", "timeout", "lease_check_interrupted"];
  it("the closed list is the four symptoms, and none of them is a termination reason", () => {
    expect([...SYMPTOMS]).toEqual(SYMPTOM_LITERAL);
    for (const s of SYMPTOM_LITERAL) expect((TERMINATION_REASONS as readonly string[]).includes(s), s).toBe(false);
  });
  it("with a pending cause every symptom returns that cause and changes nothing", () => {
    for (const cause of NAMES) {
      for (const s of SYMPTOMS) {
        const l = createTerminationLatch();
        l.raise(cause);
        expect(l.attributeSymptom(s), `${cause}/${s}`).toEqual({ reason: cause, classified: true });
        expect(l.status(), `${cause}/${s}`).toEqual({ state: "pending", reason: cause });
      }
    }
  });
  it("with a finalized cause every symptom returns that cause and changes nothing", () => {
    for (const s of SYMPTOMS) {
      const l = createTerminationLatch();
      l.raise("launcher_killed");
      l.finalize();
      expect(l.attributeSymptom(s)).toEqual({ reason: "launcher_killed", classified: true });
      expect(l.status()).toEqual({ state: "finalized", reason: "launcher_killed" });
    }
  });
  it("with no cause every symptom raises error and reports classified: false", () => {
    for (const s of SYMPTOMS) {
      const l = createTerminationLatch();
      expect(l.attributeSymptom(s), s).toEqual({ reason: "error", classified: false });
      expect(l.status(), s).toEqual({ state: "pending", reason: "error" });
    }
  });
  it("a symptom never appears as a reason, whatever the sequence", () => {
    const l = createTerminationLatch();
    for (const s of SYMPTOMS) l.attributeSymptom(s);
    expect(JSON.stringify(l.status())).not.toMatch(/interrupted|forced_stop|timeout|lease_check/);
  });
  it("an unexplained symptom stays unclassified on every call, with different symptoms, and the status stays pending error", () => {
    const l = createTerminationLatch();
    expect(l.attributeSymptom("interrupted")).toEqual({ reason: "error", classified: false });
    expect(l.status()).toEqual({ state: "pending", reason: "error" });
    expect(l.attributeSymptom("forced_stop")).toEqual({ reason: "error", classified: false });
    expect(l.attributeSymptom("timeout")).toEqual({ reason: "error", classified: false });
    expect(l.attributeSymptom("lease_check_interrupted")).toEqual({ reason: "error", classified: false });
    expect(l.status()).toEqual({ state: "pending", reason: "error" });
  });
});

describe("the fallback error (unexplained symptom or invalid reason)", () => {
  const BAD_VALUE = "CANARY-9e1d-not-a-reason";
  it("an explicit raise(error) confirms the cause: the outcome is ignored_not_higher, then classified is true", () => {
    const l = createTerminationLatch();
    l.attributeSymptom("interrupted");
    expect(l.raise("error")).toBe("ignored_not_higher");
    expect(l.status()).toEqual({ state: "pending", reason: "error" });
    expect(l.attributeSymptom("forced_stop")).toEqual({ reason: "error", classified: true });
    expect(l.attributeSymptom("timeout")).toEqual({ reason: "error", classified: true });
  });
  it("an explicit raise(error) from state none latches a real error (flag not set)", () => {
    const l = createTerminationLatch();
    expect(l.raise("error")).toBe("latched");
    expect(l.attributeSymptom("interrupted")).toEqual({ reason: "error", classified: true });
    expect(l.attributeSymptom("interrupted")).toEqual({ reason: "error", classified: true });
  });
  it("each higher cause replaces the fallback error (upgraded) and then classifies", () => {
    for (const cause of ["isolation_violation", "launcher_killed", "lease_unavailable"] as const) {
      const l = createTerminationLatch();
      expect(l.attributeSymptom("interrupted"), cause).toEqual({ reason: "error", classified: false });
      expect(l.raise(cause), cause).toBe("upgraded");
      expect(l.status(), cause).toEqual({ state: "pending", reason: cause });
      expect(l.attributeSymptom("forced_stop"), cause).toEqual({ reason: cause, classified: true });
    }
  });
  it("a lower cause (time_limit_reached, or any other lower one) is ignored and does not confirm the fallback", () => {
    for (const lower of ["time_limit_reached", "payload_audit_blocked", "provider_failure", "iteration_limit_reached"] as const) {
      const l = createTerminationLatch();
      l.attributeSymptom("timeout");
      expect(l.raise(lower), lower).toBe("ignored_not_higher");
      expect(l.status(), lower).toEqual({ state: "pending", reason: "error" });
      expect(l.attributeSymptom("timeout"), lower).toEqual({ reason: "error", classified: false });
    }
  });
  it("an invalid reason value on state none latches a fallback error", () => {
    const l = createTerminationLatch();
    expect(l.raise(BAD_VALUE as never)).toBe("latched_invalid_reason");
    expect(l.attributeSymptom("interrupted")).toEqual({ reason: "error", classified: false });
  });
  it("an invalid reason value that upgrades a lower pending cause to error makes a fallback error", () => {
    const l = createTerminationLatch();
    l.raise("provider_failure");
    expect(l.raise(BAD_VALUE as never)).toBe("upgraded_invalid_reason");
    expect(l.attributeSymptom("interrupted")).toEqual({ reason: "error", classified: false });
  });
  it("an invalid reason value after a real error does not make it a fallback", () => {
    const l = createTerminationLatch();
    l.raise("error");
    expect(l.raise(BAD_VALUE as never)).toBe("ignored_not_higher");
    expect(l.attributeSymptom("interrupted")).toEqual({ reason: "error", classified: true });
  });
  it("an invalid reason value after a fallback error does not confirm it", () => {
    const l = createTerminationLatch();
    l.attributeSymptom("interrupted");
    expect(l.raise(BAD_VALUE as never)).toBe("ignored_not_higher");
    expect(l.attributeSymptom("interrupted")).toEqual({ reason: "error", classified: false });
  });
  it("an invalid reason value after a higher cause changes nothing", () => {
    const l = createTerminationLatch();
    l.raise("launcher_killed");
    expect(l.raise(BAD_VALUE as never)).toBe("ignored_not_higher");
    expect(l.attributeSymptom("interrupted")).toEqual({ reason: "launcher_killed", classified: true });
  });
  it("finalize with a fallback error: still unclassified; an explicit or invalid raise afterwards is ignored_finalized and does not confirm it", () => {
    const l = createTerminationLatch();
    l.attributeSymptom("interrupted");
    expect(l.finalize()).toEqual({ ok: true, value: { reason: "error", alreadyFinalized: false } });
    expect(l.attributeSymptom("forced_stop")).toEqual({ reason: "error", classified: false });
    expect(l.raise("error")).toBe("ignored_finalized");
    expect(l.raise(BAD_VALUE as never)).toBe("ignored_finalized");
    expect(l.raise("isolation_violation")).toBe("ignored_finalized");
    expect(l.attributeSymptom("timeout")).toEqual({ reason: "error", classified: false });
    expect(l.status()).toEqual({ state: "finalized", reason: "error" });
    expect(l.finalize()).toEqual({ ok: true, value: { reason: "error", alreadyFinalized: true } });
  });
  it("finalize with a real error (also one confirmed before finalize) stays classified", () => {
    const real = createTerminationLatch();
    real.raise("error");
    real.finalize();
    expect(real.attributeSymptom("interrupted")).toEqual({ reason: "error", classified: true });
    expect(real.status()).toEqual({ state: "finalized", reason: "error" });
    const confirmed = createTerminationLatch();
    confirmed.attributeSymptom("interrupted");
    confirmed.raise("error");
    confirmed.finalize();
    expect(confirmed.attributeSymptom("interrupted")).toEqual({ reason: "error", classified: true });
    expect(confirmed.status()).toEqual({ state: "finalized", reason: "error" });
  });
  it("a repeated unexplained symptom does not change the status or the reason, whatever the number of calls", () => {
    const l = createTerminationLatch();
    for (let i = 0; i < 5; i++) {
      expect(l.attributeSymptom("interrupted")).toEqual({ reason: "error", classified: false });
      expect(l.status()).toEqual({ state: "pending", reason: "error" });
    }
  });
  it("status and attribution objects are frozen, hold no extra key, and never contain a symptom or the bad value", () => {
    const l = createTerminationLatch();
    const a = l.attributeSymptom("lease_check_interrupted");
    const b = l.attributeSymptom("lease_check_interrupted");
    l.raise(BAD_VALUE as never);
    const s = l.status();
    for (const x of [a, b]) {
      expect(Object.isFrozen(x)).toBe(true);
      expect(Object.keys(x).sort()).toEqual(["classified", "reason"]);
    }
    expect(Object.isFrozen(s)).toBe(true);
    expect(Object.keys(s).sort()).toEqual(["reason", "state"]);
    expect(Object.keys(createTerminationLatch().status())).toEqual(["state"]);
    expect(Object.keys(l).sort()).toEqual(["attributeSymptom", "finalize", "raise", "status"]);
    expect(JSON.stringify([a, b, s, l.finalize()])).not.toMatch(/lease_check|CANARY/);
  });
});

describe("symptoms (continued)", () => {
  it("a higher cause raised after an unclassified error upgrades it while pending", () => {
    const l = createTerminationLatch();
    l.attributeSymptom("lease_check_interrupted");
    expect(l.raise("lease_unavailable")).toBe("upgraded");
    expect(l.status()).toEqual({ state: "pending", reason: "lease_unavailable" });
    expect(l.attributeSymptom("lease_check_interrupted")).toEqual({ reason: "lease_unavailable", classified: true });
    // a lower cause does not
    const m = createTerminationLatch();
    m.attributeSymptom("timeout");
    expect(m.raise("time_limit_reached")).toBe("ignored_not_higher");
    expect(m.status()).toEqual({ state: "pending", reason: "error" });
  });
  it("a finalized unclassified error is not changed by a higher cause", () => {
    const l = createTerminationLatch();
    l.attributeSymptom("interrupted");
    l.finalize();
    expect(l.raise("isolation_violation")).toBe("ignored_finalized");
    expect(l.status()).toEqual({ state: "finalized", reason: "error" });
  });
  it("an explicit fatal error is raised by the caller before attributing, and then it is classified", () => {
    const l = createTerminationLatch();
    l.raise("error"); // what the caller does for an `interrupted` outcome with fatal: true
    expect(l.attributeSymptom("interrupted" satisfies Symptom)).toEqual({ reason: "error", classified: true });
  });
});
