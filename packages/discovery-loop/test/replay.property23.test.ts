// Feature: discovery-loop, Property 23: Runs with identical inputs produce identical records, and replay detects divergence
//
// For any configuration and Mock_Provider response script, two Runs against the same fake Legacy_App starting state produce the same records in
// the same order with byte-identical canonical serialization after the excluded fields are removed, with identical identifiers; `compareRuns`
// reports `identical`; and replaying a recorded Run reports `identical` unless a request hash differs, in which case it reports `diverged` with
// the first differing record and calls no provider other than the recorded Mock_Provider answers.
// **Validates: Requirements 22.1, 22.2, 22.4, 22.5, 22.7**
//
// Every Run is made by the real stack (test/helpers/replayFixtures.ts): the in-memory fake Legacy_App of the verifier with neutral data, the
// real Loop_Orchestrator, the real audit adapter, the Mock_Provider. The generator covers several Iterations, revisions, policy rejections,
// invalid Experiments, the Experiment limit, the rejected-Experiment limit, retries and provider failures. The policy of the spec applies:
// fast-check, at least 100 iterations (100 here), a fixed seed.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareRuns } from "../src/index.js";
import type { EnvelopeFunction } from "../src/replay/replayAudit.js";
import { replayRun, type ReplayFacts } from "../src/replayMain.js";
import { buildRequestEnvelope } from "../src/runtime/auditAdapter.js";
import { MemoryFileSystem } from "../src/store/memoryFileSystem.js";
import { EXPERIMENT, POLICY_BYTES, RUN_DIR, TABLE_BYTES, dec, enc, memoryPort, ok, recordRun, recordsOf, type Recorded, type Script } from "./helpers/replayFixtures.js";
import type { Json } from "../src/index.js";

const experimentArb = fc.constantFrom<"accepted" | "accepted2" | "rejected" | "unknownTarget">("accepted", "accepted2", "rejected", "unknownTarget");
const scriptArb: fc.Arbitrary<Script> = fc.record({
  generation: fc.constantFrom<"default" | "unparseable">("default", "default", "default", "default", "unparseable"),
  experiments: fc.oneof(
    { weight: 1, arbitrary: fc.constant<"absent">("absent") },
    {
      weight: 6,
      arbitrary: fc.array(experimentArb, { minLength: 0, maxLength: 3 }).map((kinds) =>
        kinds.map((k, i): Json => {
          const key = `e_${i}`;
          if (k === "accepted") return EXPERIMENT.accepted(key);
          if (k === "accepted2") return EXPERIMENT.accepted(key, "/products");
          if (k === "rejected") return EXPERIMENT.rejected(key);
          return EXPERIMENT.unknownTarget(key);
        }),
      ),
    },
  ),
  revision: fc.constantFrom<"default" | "absent">("default", "default", "default", "absent"),
});
const configArb = fc.record({
  iterations: fc.integer({ min: 1, max: 3 }),
  experiments: fc.integer({ min: 1, max: 4 }),
  rejectedExperiments: fc.integer({ min: 1, max: 3 }),
  providerRetries: fc.integer({ min: 0, max: 2 }),
});
const caseArb = fc.record({ script: scriptArb, config: configArb, divergeAt: fc.integer({ min: 1, max: 6 }) });

// The value type of caseArb (type only; fast-check 4.10.2 RecordValue takes two type arguments, so it is read from the Arbitrary instead).
type ReplayCase = typeof caseArb extends fc.Arbitrary<infer T> ? T : never;
async function record(c: ReplayCase): Promise<Recorded> {
  const { iterations, ...limits } = c.config;
  return recordRun({ world: { iterations, limits }, script: c.script });
}
async function replayOf(r: Recorded, envelope?: EnvelopeFunction) {
  let facts: ReplayFacts | undefined;
  const result = await replayRun({
    port: memoryPort(r.mem),
    runDir: r.dir,
    policyConfig: ok(POLICY_BYTES()),
    preparationTable: ok(TABLE_BYTES()),
    testHooks: { ...(envelope === undefined ? {} : { envelope }), onFinished: (f) => (facts = f) },
  });
  return { result, facts };
}
/** The envelope function of the replay, with the bytes of the k-th request changed by one trailing space (a request hash that differs). */
const changeRequest = (k: number): EnvelopeFunction => {
  let n = 0;
  return (input, templates) => {
    const r = buildRequestEnvelope(input, templates);
    if (!r.ok) return { ok: false };
    n += 1;
    return { ok: true, value: { kind: r.value.kind, bytes: n === k ? enc(`${dec(r.value.bytes)} `) : r.value.bytes } };
  };
};
/** Both Run directories in one file system, for `compareRuns`. */
async function both(a: Recorded, b: Recorded): Promise<MemoryFileSystem> {
  const fs = new MemoryFileSystem();
  for (const [name, r] of [["a", a], ["b", b]] as const) {
    for (const f of r.mem.allFiles()) if (f.startsWith(`${RUN_DIR}/`)) fs.poke(`/runs/${name}${f.slice(RUN_DIR.length)}`, r.mem.peek(f) as Uint8Array);
    fs.addDir(`/runs/${name}/blobs`);
  }
  return fs;
}

describe("Property 23 (fast-check, fixed seed 23004001, 100 runs)", () => {
  it(
    "two Runs with identical inputs are identical; the replay is identical; a changed request hash is diverged at the first differing record without provider answers after it",
    async () => {
      const terminations = new Set<string>();
      const kinds = new Set<string>();
      await fc.assert(
        fc.asyncProperty(caseArb, async (c) => {
          const a = await record(c);
          const b = await record(c);
          // R22.1, R22.2: the same records in the same order, canonical, with the same identifiers
          const ra = recordsOf(a.mem);
          const rb = recordsOf(b.mem);
          expect(rb).toEqual(ra);
          // R22.7: compareRuns over the two accepted Runs
          expect(await compareRuns(await both(a, b), "/runs/a", "/runs/b")).toEqual({ result: "identical", records: ra.length });
          // R22.4: the replay is identical (never incomplete inside this domain), with no recording-provider call and no Legacy_App request
          const mock = a.mockCalls();
          const legacy = a.legacyRequests();
          const replayed = await replayOf(a);
          const termination = ra[ra.length - 1]?.["payload"] as { terminationReason: string };
          expect(replayed.result).toMatchObject({ result: "identical", records: ra.length, terminationReason: termination.terminationReason });
          expect(a.mockCalls()).toBe(mock);
          expect(a.legacyRequests()).toBe(legacy);
          terminations.add(termination.terminationReason);
          for (const r of ra) kinds.add(r["kind"] as string);
          // R22.5: the k-th request with another hash
          const requests = ra.filter((r) => r["kind"] === "payload_audit").length;
          const k = Math.min(c.divergeAt, requests);
          const diverged = await replayOf(a, changeRequest(k));
          const kth = ra.findIndex((r, i) => r["kind"] === "payload_audit" && ra.slice(0, i + 1).filter((x) => x["kind"] === "payload_audit").length === k);
          expect(diverged.result).toMatchObject({ result: "diverged", firstDifferingRecord: `rec-${String(kth + 1).padStart(6, "0")}`, cause: "request_hash_mismatch" });
          // no provider answer for the changed request or after it: exactly the answers of the earlier requests
          const answersBefore = ra.slice(0, kth).filter((r) => r["kind"] === "ai_call").length;
          expect(diverged.facts?.providerAnswers).toBe(answersBefore);
          expect(a.mockCalls()).toBe(mock);
        }),
        { numRuns: 100, seed: 23_004_001 },
      );
      // the generator reached the interesting parts of the domain (a fixed seed makes this deterministic)
      for (const t of ["iteration_limit_reached", "provider_failure", "no_further_experiments"]) expect(terminations.has(t), t).toBe(true);
      for (const k of ["hypothesis_revision", "experiment", "policy_decision", "observation", "comparison", "ai_rejected"]) expect(kinds.has(k), k).toBe(true);
    },
    900_000,
  );
});
