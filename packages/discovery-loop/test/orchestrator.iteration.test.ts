// Iteration control (task 4.4, unit U6c). The two phases are replaced by scripted fakes (their own behavior is tested in the U6a and U6b files); the
// REAL run session (counters, latch, deadline, signal) and a fixed monotonic clock are used. Nothing waits on real time; all data is synthetic.
// **Validates: Requirements 4.8, 11.7, 11.9, 11.11, 11.18**
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";

const phases = vi.hoisted(() => ({ hyp: vi.fn(), exp: vi.fn() }));
vi.mock("../src/orchestrator/hypothesisPhase.js", () => ({ runHypothesisPhase: phases.hyp }));
vi.mock("../src/orchestrator/experimentPhase.js", () => ({ runExperimentPhase: phases.exp }));

import { runIterations, type IterationLoopInput } from "../src/orchestrator/iteration.js";
import { createRunSession, type RunSession } from "../src/orchestrator/session.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const START = 1_000;
const RUN_MS = 3_600_000;

interface World {
  readonly clock: { t: number; nowMs(): number };
  readonly session: RunSession;
  readonly log: string[];
  readonly hypInputs: Loose[];
  readonly expInputs: Loose[];
  hypCount: number;
  expCount: number;
  inFlight: number;
  maxInFlight: number;
  /** Per call of the Experiment fake (0-based): what to do. */
  expScript: (call: number, w: World) => Loose;
  hypScript: (call: number, w: World) => Loose;
}

function accepted(n: number, over: Loose = {}): Loose {
  return {
    kind: "accepted",
    hypothesisRevisionRecordId: `rec-h${n}`,
    hypothesisId: `hyp-${n}`,
    revision: n,
    claims: [{ claimId: "clm-0001", claimRevisionId: `clm-0001-r${n}`, revision: n }],
    attemptsUsed: 1,
    citationsAllVerified: true,
    ...over,
  };
}
const completed = (n: number, over: Loose = {}): Loose => ({
  kind: "completed",
  acceptedInPhase: 0,
  rejectedInPhase: 0,
  executed: [],
  evidenceIdsForRevision: [`evd-${n}`],
  storedRefsForRevision: [{ partId: `exp-${n}-1-experiment`, type: "experiment", recordId: `rec-e${n}` }],
  ...over,
});

function world(): World {
  const clock = { t: START, nowMs(): number { return this.t; } };
  const made = createRunSession({ clock, runSeconds: 3600 });
  if (!made.ok) throw new Error("setup failed");
  const w: World = {
    clock,
    session: made.value,
    log: [],
    hypInputs: [],
    expInputs: [],
    hypCount: 0,
    expCount: 0,
    inFlight: 0,
    maxInFlight: 0,
    hypScript: (call) => accepted(call + 1),
    expScript: (call) => completed(call + 1),
  };
  const enter = (): void => {
    w.inFlight += 1;
    w.maxInFlight = Math.max(w.maxInFlight, w.inFlight);
  };
  phases.hyp.mockImplementation(async (i: Loose) => {
    enter();
    try {
      await Promise.resolve();
      w.log.push(`hyp:${i.kind}`);
      w.hypInputs.push(i);
      const call = w.hypCount;
      w.hypCount += 1;
      return w.hypScript(call, w);
    } finally {
      w.inFlight -= 1;
    }
  });
  phases.exp.mockImplementation(async (i: Loose) => {
    enter();
    try {
      await Promise.resolve();
      w.log.push(`exp:${i.iteration}`);
      w.expInputs.push(i);
      const call = w.expCount;
      w.expCount += 1;
      return w.expScript(call, w);
    } finally {
      w.inFlight -= 1;
    }
  });
  return w;
}

const LIMITS = { providerCallSeconds: 30, providerRetries: 2, iterations: 3, experiments: 100, rejectedExperiments: 5 };
function input(w: World, limits: Partial<typeof LIMITS> = {}, session: RunSession = w.session): IterationLoopInput<unknown, unknown, unknown> {
  const cfg = (n: string): Loose => ({ responseLimits: `rl-${n}`, validator: `v-${n}`, templateId: `t-${n}` });
  return {
    session,
    writer: {} as Loose,
    clock: w.clock,
    timers: {} as Loose,
    provider: {} as Loose,
    audit: {} as Loose,
    auditConfig: {},
    responseGate: {} as Loose,
    evidenceStore: {} as Loose,
    ids: {} as Loose,
    leasePort: {},
    bundle: {},
    limits: { ...LIMITS, ...limits },
    hypothesis: {
      generation: cfg("gen"),
      revision: cfg("rev"),
      generationStored: [{ partId: "g1", type: "source_file", recordId: "rec-g" }],
      analysis: {} as Loose,
      semanticSha256Of: (() => ({ ok: true, value: "a".repeat(64) })) as Loose,
    },
    experiment: { ...cfg("exp"), policy: {} as Loose, policyConfig: {}, runner: {} as Loose, comparator: {} as Loose, mask: {} },
  };
}
const reasonOf = (s: RunSession): string | undefined => {
  const st = s.terminationStatus();
  return st.state === "none" ? undefined : st.reason;
};

beforeEach(() => {
  phases.hyp.mockReset();
  phases.exp.mockReset();
});

describe("order and Iteration numbers", () => {
  it("generates first, then runs the Experiment phase of Iteration 1 (one Iteration permitted)", async () => {
    const w = world();
    const r = await runIterations(input(w, { iterations: 1 }));
    expect(w.log).toEqual(["hyp:hypothesis_generation", "exp:1"]);
    expect(r).toEqual({ finalHypothesisRevision: "hyp-1", iterationsUsed: 1, ended: "iteration_limit" });
    expect(reasonOf(w.session)).toBe("iteration_limit_reached");
    expect(w.session.iterationCount).toBe(1);
  });

  it("alternates generation, Experiment, revision, Experiment, ... and makes no revision after the last Iteration", async () => {
    const w = world();
    const r = await runIterations(input(w, { iterations: 3 }));
    expect(w.log).toEqual(["hyp:hypothesis_generation", "exp:1", "hyp:hypothesis_revision", "exp:2", "hyp:hypothesis_revision", "exp:3"]);
    expect(r).toEqual({ finalHypothesisRevision: "hyp-3", iterationsUsed: 3, ended: "iteration_limit" });
    expect(w.session.iterationCount).toBe(3);
    expect(reasonOf(w.session)).toBe("iteration_limit_reached");
  });

  it("calls noteIteration once per Experiment phase, before it starts, with the counter equal to the Iteration number", async () => {
    const w = world();
    const seen: number[] = [];
    w.expScript = (call, ww) => {
      seen.push(ww.session.iterationCount);
      return completed(call + 1);
    };
    await runIterations(input(w, { iterations: 3 }));
    expect(seen).toEqual([1, 2, 3]);
    expect(w.expInputs.map((i) => i.iteration)).toEqual([1, 2, 3]);
  });

  it("never runs two phases at the same time", async () => {
    const w = world();
    await runIterations(input(w, { iterations: 4 }));
    expect(w.maxInFlight).toBe(1);
  });

  it("passes the hypothesis of the latest accepted revision to each Experiment phase, with the hypothesis record as a stored part", async () => {
    const w = world();
    await runIterations(input(w, { iterations: 2 }));
    expect(w.expInputs[0].hypothesis).toEqual({ hypothesisId: "hyp-1", claims: [{ claimId: "clm-0001", claimRevisionId: "clm-0001-r1" }] });
    expect(w.expInputs[1].hypothesis.hypothesisId).toBe("hyp-2");
    expect(w.expInputs[1].stored).toEqual([{ partId: "hyp-2-hypothesis-revision", type: "hypothesis_revision", recordId: "rec-h2" }]);
    expect(w.expInputs[0].templateId).toBe("t-exp");
    expect(w.expInputs[0].limits).toEqual({ providerCallSeconds: 30, providerRetries: 2, experiments: 100, rejectedExperiments: 5 });
  });
});

describe("what a revision receives", () => {
  it("uses the previous accepted revision as predecessor, the Evidence ids of the Experiment phase, and the stored parts joined in order", async () => {
    const w = world();
    await runIterations(input(w, { iterations: 3 }));
    const gen = w.hypInputs[0];
    expect(gen.kind).toBe("hypothesis_generation");
    expect(gen.stored).toEqual([{ partId: "g1", type: "source_file", recordId: "rec-g" }]);
    expect(gen.templateId).toBe("t-gen");
    expect("predecessor" in gen).toBe(false);
    const rev1 = w.hypInputs[1];
    expect(rev1.kind).toBe("hypothesis_revision");
    expect(rev1.templateId).toBe("t-rev");
    expect(rev1.validator).toBe("v-rev");
    expect(rev1.predecessor).toEqual({ hypothesisId: "hyp-1", revision: 1, claims: [{ claimId: "clm-0001", revision: 1, claimRevisionId: "clm-0001-r1" }] });
    expect(rev1.promptedByEvidence).toEqual(["evd-1"]);
    expect(rev1.stored).toEqual([
      { partId: "hyp-1-hypothesis-revision", type: "hypothesis_revision", recordId: "rec-h1" },
      { partId: "exp-1-1-experiment", type: "experiment", recordId: "rec-e1" },
    ]);
    const rev2 = w.hypInputs[2];
    expect(rev2.predecessor.hypothesisId).toBe("hyp-2");
    expect(rev2.predecessor.revision).toBe(2);
    expect(rev2.promptedByEvidence).toEqual(["evd-2"]);
    expect(rev2.stored[0].recordId).toBe("rec-h2");
    expect(rev2.stored[1].recordId).toBe("rec-e2");
  });

  it("revises with empty Evidence and no Experiment refs when the Experiment phase produced none", async () => {
    const w = world();
    w.expScript = () => completed(1, { evidenceIdsForRevision: [], storedRefsForRevision: [] });
    await runIterations(input(w, { iterations: 2 }));
    const rev = w.hypInputs[1];
    expect(rev.promptedByEvidence).toEqual([]);
    expect(rev.stored).toEqual([{ partId: "hyp-1-hypothesis-revision", type: "hypothesis_revision", recordId: "rec-h1" }]);
  });

  it("does not let a later change of the phase result arrays reach the revision input", async () => {
    const w = world();
    const evidence = ["evd-1"];
    w.expScript = () => completed(1, { evidenceIdsForRevision: evidence });
    await runIterations(input(w, { iterations: 2 }));
    expect(w.hypInputs[1].promptedByEvidence).not.toBe(evidence);
  });
});

describe("limits and the end of the phases", () => {
  it("does not revise when the accepted Experiment count equals the limit exactly, and raises experiment_limit_reached", async () => {
    const w = world();
    w.expScript = (call, ww) => {
      ww.session.noteAcceptedExperiment();
      ww.session.noteAcceptedExperiment();
      return completed(call + 1, { acceptedInPhase: 2 });
    };
    const r = await runIterations(input(w, { iterations: 5, experiments: 2 }));
    expect(w.log).toEqual(["hyp:hypothesis_generation", "exp:1"]);
    expect(r).toEqual({ finalHypothesisRevision: "hyp-1", iterationsUsed: 1, ended: "experiment_limit" });
    expect(reasonOf(w.session)).toBe("experiment_limit_reached");
  });

  it("revises while the count is below the limit, and stops at the limit on a later Iteration", async () => {
    const w = world();
    w.expScript = (call, ww) => {
      ww.session.noteAcceptedExperiment();
      return completed(call + 1, { acceptedInPhase: 1 });
    };
    const r = await runIterations(input(w, { iterations: 5, experiments: 2 }));
    expect(w.log).toEqual(["hyp:hypothesis_generation", "exp:1", "hyp:hypothesis_revision", "exp:2"]);
    expect(r.ended).toBe("experiment_limit");
    expect(r.iterationsUsed).toBe(2);
    expect(reasonOf(w.session)).toBe("experiment_limit_reached");
  });

  it("makes no revision after a `limit` result and keeps the cause the phase raised", async () => {
    for (const reason of ["policy_rejection_limit", "no_further_experiments", "experiment_limit_reached"] as const) {
      const w = world();
      w.expScript = (_c, ww) => {
        ww.session.raise(reason);
        return { ...completed(1), kind: "limit", reason };
      };
      const r = await runIterations(input(w));
      expect(w.log, reason).toEqual(["hyp:hypothesis_generation", "exp:1"]);
      expect(r, reason).toEqual({ finalHypothesisRevision: "hyp-1", iterationsUsed: 1, ended: "phase_limit" });
      expect(reasonOf(w.session), reason).toBe(reason);
    }
  });

  it("makes no revision after a `stopped` Experiment phase and raises nothing of its own", async () => {
    const w = world();
    w.expScript = (_c, ww) => {
      ww.session.raise("provider_failure");
      return { kind: "stopped" };
    };
    const r = await runIterations(input(w));
    expect(w.log).toEqual(["hyp:hypothesis_generation", "exp:1"]);
    expect(r).toEqual({ finalHypothesisRevision: "hyp-1", iterationsUsed: 1, ended: "stopped" });
    expect(reasonOf(w.session)).toBe("provider_failure");
  });

  it("does not raise a second reason when the Experiment phase latched a cause but still returned `completed`", async () => {
    const w = world();
    w.expScript = (_c, ww) => {
      ww.session.raise("provider_failure");
      return completed(1);
    };
    const r = await runIterations(input(w));
    expect(w.log).toEqual(["hyp:hypothesis_generation", "exp:1"]);
    expect(r.ended).toBe("stopped");
    expect(reasonOf(w.session)).toBe("provider_failure");
  });
});

describe("failures", () => {
  it("a failed first generation starts no Experiment phase: Iteration 0, final none", async () => {
    const w = world();
    w.hypScript = (_c, ww) => {
      ww.session.raise("provider_failure");
      return { kind: "stopped" };
    };
    const r = await runIterations(input(w));
    expect(w.log).toEqual(["hyp:hypothesis_generation"]);
    expect(r).toEqual({ finalHypothesisRevision: "none", iterationsUsed: 0, ended: "stopped" });
    expect(w.session.iterationCount).toBe(0);
    expect(reasonOf(w.session)).toBe("provider_failure");
  });

  it("a failed revision keeps the last accepted revision as final and starts no further phase", async () => {
    const w = world();
    w.hypScript = (call, ww) => {
      if (call === 0) return accepted(1);
      if (call === 1) return accepted(2);
      ww.session.raise("provider_failure");
      return { kind: "stopped" };
    };
    const r = await runIterations(input(w, { iterations: 5 }));
    expect(w.log).toEqual(["hyp:hypothesis_generation", "exp:1", "hyp:hypothesis_revision", "exp:2", "hyp:hypothesis_revision"]);
    expect(r).toEqual({ finalHypothesisRevision: "hyp-2", iterationsUsed: 2, ended: "stopped" });
    expect(reasonOf(w.session)).toBe("provider_failure");
  });

  it("a revision that is not accepted does not change the final revision", async () => {
    const w = world();
    w.hypScript = (call) => (call === 0 ? accepted(1) : { kind: "stopped" });
    const r = await runIterations(input(w));
    expect(r.finalHypothesisRevision).toBe("hyp-1");
  });

  it("an accepted result with failed citations still counts as the final revision", async () => {
    const w = world();
    w.hypScript = (call) => accepted(call + 1, { citationsAllVerified: false });
    const r = await runIterations(input(w, { iterations: 2 }));
    expect(r.finalHypothesisRevision).toBe("hyp-2");
  });

  it("raises error for a malformed accepted result and for an unknown Experiment result kind", async () => {
    const w1 = world();
    w1.hypScript = () => ({ kind: "accepted", hypothesisId: "hyp-1" });
    const r1 = await runIterations(input(w1));
    expect(r1.ended).toBe("stopped");
    expect(reasonOf(w1.session)).toBe("error");
    expect(w1.log).toEqual(["hyp:hypothesis_generation"]);

    const w2 = world();
    w2.expScript = () => ({ kind: "weird" });
    await runIterations(input(w2));
    expect(reasonOf(w2.session)).toBe("error");
    expect(w2.log).toEqual(["hyp:hypothesis_generation", "exp:1"]);
  });

  it("raises error and calls nothing for an invalid Iteration or Experiment limit", async () => {
    for (const bad of [{ iterations: 0 }, { iterations: 1.5 }, { experiments: -1 }]) {
      const w = world();
      const r = await runIterations(input(w, bad));
      expect(w.log).toEqual([]);
      expect(r).toEqual({ finalHypothesisRevision: "none", iterationsUsed: 0, ended: "stopped" });
      expect(reasonOf(w.session)).toBe("error");
    }
  });

  it("passes the sanctioned throw of a phase through unchanged and calls nothing afterwards", async () => {
    const w = world();
    const boom = new Error("run records unavailable");
    w.expScript = () => {
      throw boom;
    };
    await expect(runIterations(input(w))).rejects.toBe(boom);
    expect(w.log).toEqual(["hyp:hypothesis_generation", "exp:1"]);
  });
});

describe("stops: deadline, abort, latch", () => {
  it("starts nothing when the deadline has passed before the first phase", async () => {
    const w = world();
    w.clock.t = START + RUN_MS;
    const r = await runIterations(input(w));
    expect(w.log).toEqual([]);
    expect(r).toEqual({ finalHypothesisRevision: "none", iterationsUsed: 0, ended: "stopped" });
    expect(reasonOf(w.session)).toBe("time_limit_reached");
  });

  it("starts no Experiment phase when the deadline passes during generation", async () => {
    const w = world();
    w.hypScript = (_c, ww) => {
      ww.clock.t = START + RUN_MS;
      return accepted(1);
    };
    const r = await runIterations(input(w));
    expect(w.log).toEqual(["hyp:hypothesis_generation"]);
    expect(r.finalHypothesisRevision).toBe("hyp-1");
    expect(r.iterationsUsed).toBe(0);
    expect(w.session.iterationCount).toBe(0);
    expect(reasonOf(w.session)).toBe("time_limit_reached");
  });

  it("starts no revision when the deadline passes during an Experiment phase", async () => {
    const w = world();
    w.expScript = (call, ww) => {
      ww.clock.t = START + RUN_MS;
      return completed(call + 1);
    };
    const r = await runIterations(input(w, { iterations: 4 }));
    expect(w.log).toEqual(["hyp:hypothesis_generation", "exp:1"]);
    expect(r).toEqual({ finalHypothesisRevision: "hyp-1", iterationsUsed: 1, ended: "stopped" });
    expect(reasonOf(w.session)).toBe("time_limit_reached");
  });

  it("does not raise iteration_limit_reached over a deadline cause that arrived during the last Experiment phase", async () => {
    const w = world();
    w.expScript = (call, ww) => {
      ww.session.raise("time_limit_reached");
      return completed(call + 1);
    };
    await runIterations(input(w, { iterations: 1 }));
    expect(reasonOf(w.session)).toBe("time_limit_reached");
  });

  it("starts nothing when the Run signal is aborted while the latch is empty", async () => {
    const w = world();
    const ac = new AbortController();
    ac.abort();
    const fake = Object.create(w.session) as RunSession;
    Object.defineProperty(fake, "signal", { value: ac.signal });
    const r = await runIterations(input(w, {}, fake));
    expect(w.log).toEqual([]);
    expect(r.ended).toBe("stopped");
    expect(r.iterationsUsed).toBe(0);
  });

  it("starts nothing and keeps the reason when a cause is already latched", async () => {
    for (const reason of ["provider_failure", "isolation_violation", "lease_unavailable", "error"] as const) {
      const w = world();
      w.session.raise(reason);
      const r = await runIterations(input(w));
      expect(w.log, reason).toEqual([]);
      expect(r.ended, reason).toBe("stopped");
      expect(reasonOf(w.session), reason).toBe(reason);
    }
  });

  it("starts no revision when a cause is latched during the Experiment phase, and the first reason stays", async () => {
    const w = world();
    w.expScript = (call, ww) => {
      ww.session.raise("lease_unavailable");
      return completed(call + 1);
    };
    await runIterations(input(w, { iterations: 3 }));
    expect(w.log).toEqual(["hyp:hypothesis_generation", "exp:1"]);
    expect(reasonOf(w.session)).toBe("lease_unavailable");
  });

  it("makes no further call after the stop (counts stay put)", async () => {
    const w = world();
    w.expScript = (call, ww) => {
      if (call === 1) ww.session.raise("provider_failure");
      return call === 1 ? { kind: "stopped" } : completed(call + 1);
    };
    await runIterations(input(w, { iterations: 6 }));
    expect(w.hypCount).toBe(2);
    expect(w.expCount).toBe(2);
    expect(phases.hyp).toHaveBeenCalledTimes(2);
    expect(phases.exp).toHaveBeenCalledTimes(2);
  });
});

describe("property: the control flow follows the limits", () => {
  it("for any limits and any per-Iteration accepted counts, phases alternate and the end reason is the first limit that applies", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 0, max: 8 }), fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 6, maxLength: 6 }), async (iterations, experiments, perIteration) => {
        const w = world();
        w.expScript = (call, ww) => {
          for (let k = 0; k < (perIteration[call] ?? 0); k += 1) ww.session.noteAcceptedExperiment();
          return completed(call + 1);
        };
        const r = await runIterations(input(w, { iterations, experiments }));
        // the expected walk
        let accepted = 0;
        const expected: string[] = ["hyp:hypothesis_generation"];
        let reason = "";
        for (let i = 1; i <= iterations; i += 1) {
          expected.push(`exp:${i}`);
          accepted += perIteration[i - 1] ?? 0;
          if (accepted >= experiments) {
            reason = "experiment_limit_reached";
            break;
          }
          if (i >= iterations) {
            reason = "iteration_limit_reached";
            break;
          }
          expected.push("hyp:hypothesis_revision");
        }
        expect(w.log).toEqual(expected);
        expect(reasonOf(w.session)).toBe(reason);
        expect(r.iterationsUsed).toBe(w.expCount);
        expect(w.session.iterationCount).toBe(w.expCount);
        expect(r.finalHypothesisRevision).toBe(`hyp-${w.hypCount}`);
        expect(w.maxInFlight).toBe(1);
        expect(w.hypCount).toBe(w.expCount); // one generation plus (Iterations - 1) revisions
      }),
      { numRuns: 100 },
    );
  });
});
