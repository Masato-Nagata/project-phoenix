// replayRun end to end (task 4.7 step A2; R12.23, R22.4, R22.5, R22.8; human decisions D1 to D5 of 2026-11-27). Every recorded Run is made by
// the real stack (test/helpers/replayFixtures.ts) and is synthetic. Every refused or different case has a passing control (the same Run
// without the defect replays `identical`).
import { describe, expect, it } from "vitest";
import { canonicalJson, type Json } from "../src/index.js";
import type { EnvelopeFunction } from "../src/replay/replayAudit.js";
import { replayRun, type ReplayFacts, type ReplayRunInput } from "../src/replayMain.js";
import { buildRequestEnvelope } from "../src/runtime/auditAdapter.js";
import { semanticSha256Of } from "../src/runtime/semanticHash.js";
import {
  EXPERIMENT, POLICY_BYTES, RUN_DIR, TABLE_BYTES, dec, enc, indexOf, manifestOf, memoryPort, ok, recordRun, recordsOf, rewriteRun, setTermination, sha, snapshotOf,
  type Rec, type Recorded, type RecordOptions,
} from "./helpers/replayFixtures.js";

type Hooks = NonNullable<ReplayRunInput["testHooks"]>;
async function replay(r: Recorded, o: { hooks?: Hooks; policy?: ReplayRunInput["policyConfig"]; table?: ReplayRunInput["preparationTable"]; port?: ReturnType<typeof memoryPort> } = {}) {
  let facts: ReplayFacts | undefined;
  const port = o.port ?? memoryPort(r.mem);
  const result = await replayRun({
    port,
    runDir: r.dir,
    policyConfig: o.policy ?? ok(POLICY_BYTES()),
    preparationTable: o.table ?? ok(TABLE_BYTES()),
    testHooks: { ...(o.hooks ?? {}), onFinished: (f) => (facts = f) },
  });
  return { result, facts, port };
}
const kindsOf = (r: Recorded): string[] => recordsOf(r.mem).map((x) => x["kind"] as string);
const idAt = (i: number): string => `rec-${String(i + 1).padStart(6, "0")}`;
/** The index of the LAST record of a kind. */
const lastIndexOf = (records: readonly Rec[], kind: string): number => {
  for (let i = records.length - 1; i >= 0; i -= 1) if (records[i]?.["kind"] === kind) return i;
  throw new Error(`no ${kind}`);
};
/** The record ids that the recorded request envelopes (the `payload_audit` blobs) name as stored parts: read from the Run, not assumed. */
const referencedIds = (r: Recorded): Set<string> => {
  const ids = new Set<string>();
  for (const x of recordsOf(r.mem)) {
    if (x["kind"] !== "payload_audit") continue;
    const blob = (x["payload"] as Rec)["blob"] as Rec | undefined;
    if (blob === undefined) continue;
    const env = JSON.parse(dec(r.mem.peek(`${RUN_DIR}/blobs/${blob["blob"] as string}`))) as Rec;
    for (const p of env["parts"] as Rec[]) if (typeof p["recordId"] === "string") ids.add(p["recordId"]);
  }
  return ids;
};
/** The last record of a kind, checked to be named by NO recorded request envelope (so editing it keeps the Run internally consistent). */
const unreferencedLast = (r: Recorded, kind: string): number => {
  const i = lastIndexOf(recordsOf(r.mem), kind);
  expect(referencedIds(r).has(idAt(i)), `${kind} ${idAt(i)} must not be a stored part of a later request`).toBe(false);
  return i;
};

describe("a recorded Run replays identical", () => {
  it("the default Mock Run (2 Iterations, a revision): identical; every regenerated record equals the original; nothing is written; no provider, no Legacy_App", async () => {
    const r = await recordRun();
    const before = snapshotOf(r.mem);
    const mock = r.mockCalls();
    const legacy = r.legacyRequests();
    const { result, facts } = await replay(r);
    expect(result).toMatchObject({ result: "identical", terminationReason: "iteration_limit_reached" });
    const records = recordsOf(r.mem);
    expect(result).toMatchObject({ records: records.length, regenerated: records.length - 1 - 3 });
    // D5: the regenerated records are the original records 1 .. n-1 (termination excluded), in canonical form with hash and prevHash
    expect(facts?.regenerated).toEqual(records.slice(0, -1).map((x) => canonicalJson(x as Json)));
    // the four kinds of R22.4 were regenerated (present in the regenerated range, not only copied)
    for (const k of ["experiment", "policy_decision", "observation", "comparison"]) expect(kindsOf(r).slice(3).includes(k), k).toBe(true);
    expect(facts?.providerAnswers).toBe(kindsOf(r).filter((k) => k === "ai_call").length);
    expect(facts?.runnerCalls).toBe(records.filter((x) => x["kind"] === "policy_decision" && (x["payload"] as Rec)["decision"] === "accept").length);
    expect(facts?.auditsReused).toBe(kindsOf(r).filter((k) => k === "payload_audit").length);
    expect(facts?.leaseChecks).toBeGreaterThan(0);
    expect(snapshotOf(r.mem)).toEqual(before); // no write to the original Run, no new file
    expect(r.mockCalls()).toBe(mock); // zero calls of the recording provider
    expect(r.legacyRequests()).toBe(legacy); // zero requests to the fake Legacy_App
    expect(result).toMatchObject({ guarantees: { audit: "reused_not_reexecuted", lease: "not_measured", sourceBundler: "not_reexecuted", allowlist: "not_reverified", realAi: "not_called", legacy: "no_new_experiment", context: "copied_inputs", policy: "reevaluated", comparator: "reexecuted" } });
  });
  it.each<[string, RecordOptions, string]>([
    ["a policy rejection next to an accepted Experiment (1 Iteration)", { world: { iterations: 1 }, script: { experiments: [EXPERIMENT.accepted("list_a"), EXPERIMENT.rejected("customers_b")] } }, "iteration_limit_reached"],
    ["only rejected Experiments: no_further_experiments", { world: { iterations: 2 }, script: { experiments: [EXPERIMENT.rejected("customers_a")] } }, "no_further_experiments"],
    ["the rejected-Experiment limit", { world: { iterations: 2, limits: { rejectedExperiments: 1 } }, script: { experiments: [EXPERIMENT.rejected("customers_a"), EXPERIMENT.accepted("list_b")] } }, "policy_rejection_limit"],
    ["the Experiment limit", { world: { iterations: 3, limits: { experiments: 1 } }, script: { experiments: [EXPERIMENT.accepted("list_a"), EXPERIMENT.accepted("list_b", "/products")] } }, "experiment_limit_reached"],
    ["an invalid Experiment (unknown target) next to a valid one", { world: { iterations: 1 }, script: { experiments: [EXPERIMENT.unknownTarget("bad_a"), EXPERIMENT.accepted("list_b")] } }, "iteration_limit_reached"],
    ["an unparseable generation answer, retried to provider_failure", { world: { iterations: 1 }, script: { generation: "unparseable" } }, "provider_failure"],
    ["no fixture for experiment_generation (provider_error unmatched_request), retried to provider_failure", { world: { iterations: 1 }, script: { experiments: "absent" } }, "provider_failure"],
    ["three Iterations with two revisions", { world: { iterations: 3 } }, "iteration_limit_reached"],
  ])("%s", async (_name, options, termination) => {
    const r = await recordRun(options);
    expect(r.result.sealed && r.result.summary.terminationReason).toBe(termination);
    const { result, facts } = await replay(r);
    expect(result).toMatchObject({ result: "identical", terminationReason: termination });
    const records = recordsOf(r.mem);
    expect(facts?.regenerated).toEqual(records.slice(0, -1).map((x) => canonicalJson(x as Json)));
    // a policy rejection never reaches the recorded Runner
    const accepted = records.filter((x) => x["kind"] === "policy_decision" && (x["payload"] as Rec)["decision"] === "accept").length;
    expect(facts?.runnerCalls).toBe(accepted);
  });
});

describe("R12.23, R22.8: a Run that is not accepted is incomplete and nothing is replayed", () => {
  it("no Completion_Marker", async () => {
    const r = await recordRun({ marker: false });
    const { result, facts } = await replay(r);
    expect(result).toEqual({ result: "incomplete", reason: "run_not_accepted", detail: "no_completion_marker" });
    expect(facts).toBeUndefined();
  });
  it("a changed record without a matching chain (verification fails)", async () => {
    const r = await recordRun();
    const path = `${RUN_DIR}/records.jsonl`;
    r.mem.poke(path, enc(dec(r.mem.peek(path)).replace('"kind":"run_started"', '"kind":"run_started" ')));
    expect((await replay(r)).result).toMatchObject({ result: "incomplete", reason: "run_not_accepted" });
  });
});

describe("the structure of the records and their references", () => {
  it("an additional field in a RecordEnvelope (accepted by acceptRun, refused by the replay)", async () => {
    const r = await recordRun();
    await rewriteRun(r.mem, (recs) => recs.map((x, i) => (i === 3 ? { ...x, extra: 1 } : x)));
    expect((await replay(r)).result).toEqual({ result: "incomplete", reason: "records_invalid", detail: "record_envelope" });
  });
  it("an ai_call that names another ai_output record", async () => {
    const r = await recordRun();
    await rewriteRun(r.mem, (recs) => recs.map((x) => (x["kind"] === "ai_call" && (x["payload"] as Rec)["outcome"] === "response" ? { ...x, payload: { ...(x["payload"] as Rec), aiOutputRecordId: "rec-000001" } } : x)));
    expect((await replay(r)).result).toMatchObject({ result: "incomplete", reason: "references_invalid" });
  });
  it("a leading record of an unexpected kind", async () => {
    const r = await recordRun();
    await rewriteRun(r.mem, (recs) => recs.map((x, i) => (i === 1 ? { ...x, kind: "run_started" } : x)));
    expect((await replay(r)).result).toEqual({ result: "incomplete", reason: "leading_records_unexpected" });
  });
});

describe("the Source_Bundle restored from the recorded envelopes", () => {
  it("two envelopes with different source parts are refused", async () => {
    const r = await recordRun();
    const recs = recordsOf(r.mem);
    const second = indexOf(recs, "payload_audit", 1);
    const pa = recs[second]?.["payload"] as Rec;
    const env = JSON.parse(dec(r.mem.peek(`${RUN_DIR}/blobs/${pa["payloadSha256"] as string}`))) as Rec;
    const parts = env["parts"] as Rec[];
    const text = `${parts[0]?.["text"] as string}// changed\n`;
    (parts[0] as Rec)["text"] = text;
    (parts[0] as Rec)["sha256Lf"] = sha(text);
    const bytes = enc(canonicalJson(env as Json));
    const h = sha(bytes);
    await rewriteRun(
      r.mem,
      (all) =>
        all.map((x, i) => {
          if (i === second) return { ...x, payload: { ...(x["payload"] as Rec), payloadSha256: h, blob: { blob: h, bytes: bytes.byteLength } } };
          if (x["kind"] === "ai_call" && (x["payload"] as Rec)["payloadAuditRecordId"] === idAt(second)) return { ...x, payload: { ...(x["payload"] as Rec), requestSha256: h } };
          return x;
        }),
      { addBlobs: [bytes] },
    );
    expect((await replay(r)).result).toEqual({ result: "incomplete", reason: "source_bundle_inconsistent", detail: "envelopes" });
  });
  it("a source_bundle_manifest (and manifest.sourceBundle) that differs from the envelopes is refused", async () => {
    const r = await recordRun();
    const other = "b".repeat(64);
    await rewriteRun(r.mem, (recs) => recs.map((x, i) => (i === 2 ? { ...x, payload: { files: [{ path: "legacy/src/utils.php", sha256Lf: other }] } } : x)), {
      editManifest: (m) => {
        ((m["sourceBundle"] as Rec)["files"] as Rec[])[0] = { path: "legacy/src/utils.php", sha256Lf: other };
      },
    });
    expect((await replay(r)).result).toEqual({ result: "incomplete", reason: "source_bundle_inconsistent", detail: "source_bundle_manifest" });
  });
});

describe("the recorded audit verdicts", () => {
  it("a blocked verdict with a provider call after it is inconsistent", async () => {
    const r = await recordRun();
    await rewriteRun(r.mem, (recs) => recs.map((x, i) => (i === 3 ? { ...x, payload: { ...(x["payload"] as Rec), result: "blocked" } } : x)));
    expect((await replay(r)).result).toEqual({ result: "incomplete", reason: "audit_records_inconsistent", detail: "blocked_with_call" });
  });
  it("counts of the Run_Manifest that differ from the records are inconsistent", async () => {
    const r = await recordRun();
    await rewriteRun(r.mem, (recs) => recs, { editManifest: (m) => ((m["payload_audit"] as Rec)["passed"] = ((m["payload_audit"] as Rec)["passed"] as number) + 1) });
    expect((await replay(r)).result).toEqual({ result: "incomplete", reason: "audit_records_inconsistent", detail: "manifest_counts" });
  });
  it("blocked stays blocked: a Run that ended with payload_audit_blocked replays identical, with no provider answer", async () => {
    const r = await recordRun();
    await rewriteRun(
      r.mem,
      (recs) => [
        ...recs.slice(0, 3),
        { ...(recs[3] as Rec), payload: { ...((recs[3] as Rec)["payload"] as Rec), result: "blocked", checks: [{ id: "A07", outcome: "fail" }] } },
        { ...(recs[recs.length - 1] as Rec), payload: { terminationReason: "payload_audit_blocked" } },
      ],
      {
        editManifest: (m) => {
          m["terminationReason"] = "payload_audit_blocked";
          m["payload_audit"] = { ...(m["payload_audit"] as Rec), audits: 1, passed: 0, blocked: 1 };
        },
      },
    );
    const { result, facts } = await replay(r);
    expect(result).toMatchObject({ result: "identical", terminationReason: "payload_audit_blocked" });
    expect(facts?.providerAnswers).toBe(0);
    expect(facts?.regenerated.length).toBe(4);
  });
  it("withheld request bytes are refused before the replay", async () => {
    const r = await recordRun();
    await rewriteRun(r.mem, (recs) => recs.map((x, i) => {
      if (i !== 3) return x;
      const { blob: _b, ...rest } = x["payload"] as Rec;
      void _b;
      return { ...x, payload: { ...rest, bytesWithheld: true } };
    }));
    expect((await replay(r)).result).toEqual({ result: "incomplete", reason: "request_bytes_withheld" });
  });
});

describe("R22.5: a request hash that differs is diverged, with the first differing record, before any provider call", () => {
  const altered = (k: number): EnvelopeFunction => {
    let n = 0;
    return (input, templates) => {
      const r = buildRequestEnvelope(input, templates);
      if (!r.ok) return { ok: false };
      n += 1;
      return { ok: true, value: { kind: r.value.kind, bytes: n === k ? enc(`${dec(r.value.bytes)} `) : r.value.bytes } };
    };
  };
  it("the first request changed: diverged at its payload_audit, zero provider answers", async () => {
    const r = await recordRun();
    const { result, facts } = await replay(r, { hooks: { envelope: altered(1) } });
    expect(result).toMatchObject({ result: "diverged", firstDifferingRecord: "rec-000004", cause: "request_hash_mismatch", recordedRequestRecord: "rec-000004" });
    expect(facts?.providerAnswers).toBe(0);
  });
  it("the second request changed: diverged at the second payload_audit, one provider answer", async () => {
    const r = await recordRun();
    const second = indexOf(recordsOf(r.mem), "payload_audit", 1);
    const { result, facts } = await replay(r, { hooks: { envelope: altered(2) } });
    expect(result).toMatchObject({ result: "diverged", firstDifferingRecord: idAt(second), recordedRequestRecord: idAt(second) });
    expect(facts?.providerAnswers).toBe(1);
  });
  it("a regression of a deterministic module (another semantic hash): the first differing record is the hypothesis_revision, then the request diverges", async () => {
    const r = await recordRun();
    const recs = recordsOf(r.mem);
    const hyp = indexOf(recs, "hypothesis_revision", 0);
    const { result } = await replay(r, {
      hooks: { semanticSha256Of: (v) => { const s = semanticSha256Of(v); return s.ok ? { ok: true, value: sha(`changed ${s.value}`) } : s; } },
    });
    expect(result).toMatchObject({ result: "diverged", firstDifferingRecord: idAt(hyp), cause: "request_hash_mismatch", recordedRequestRecord: idAt(indexOf(recs, "payload_audit", 1)) });
  });
  it("control: the same hooks without a change give identical", async () => {
    const r = await recordRun();
    expect((await replay(r, { hooks: { envelope: altered(0), semanticSha256Of } })).result).toMatchObject({ result: "identical" });
  });
});

describe("recorded answers and Observations: missing, unconsumed, changed", () => {
  it("a regenerated Run that stops early leaves recorded answers unused: different (only in the original), never incomplete", async () => {
    const r = await recordRun();
    const { result } = await replay(r, { hooks: { semanticSha256Of: () => ({ ok: false, error: { code: "semantic_hash_failed" } }) } });
    expect(result).toMatchObject({ result: "different", difference: "only_in_original" });
  });
  it("the same Experiment id with a different content: the regenerated experiment differs and the recorded Runner refuses it", async () => {
    // (A2 correction, 2026-11-27) the edited experiment is the last one, which no later request envelope names (checked, not assumed)
    const r = await recordRun();
    const e = unreferencedLast(r, "experiment");
    await rewriteRun(r.mem, (all) => all.map((x, i) => {
      if (i !== e) return x;
      const p = JSON.parse(JSON.stringify(x["payload"])) as Rec;
      (((p["experiment"] as Rec)["requests"] as Rec[])[0] as Rec)["path"] = "/products";
      return { ...x, payload: p };
    }));
    const original = recordsOf(r.mem);
    const { result, facts } = await replay(r);
    expect(result).toMatchObject({ result: "different", firstDifferingRecord: idAt(e), difference: "content", cause: "runner_experiment_mismatch" });
    // the replay started and regenerated everything before the edited record identically
    expect(facts?.regenerated.slice(0, e)).toEqual(original.slice(0, e).map((x) => canonicalJson(x as Json)));
    // the refused Experiment ends the replay: its decision, then one error record, and nothing after it
    const regenerated = (facts?.regenerated ?? []).map((s) => JSON.parse(s) as Rec);
    expect(regenerated.map((x) => x["kind"]).slice(e)).toEqual(["experiment", "policy_decision", "error"]);
    expect(facts?.runnerCalls).toBe(original.filter((x) => x["kind"] === "policy_decision" && (x["payload"] as Rec)["decision"] === "accept").length);
  });
  it("the Comparator is re-executed: a changed recorded comparison is a difference at that record", async () => {
    // (A2 correction, 2026-11-27) the edited comparison is the last one, which no later request envelope names (checked, not assumed)
    const r = await recordRun();
    const c = unreferencedLast(r, "comparison");
    await rewriteRun(r.mem, (all) => all.map((x, i) => (i === c ? { ...x, payload: { ...(x["payload"] as Rec), differences: [{ path: "x", predicted: 1, observed: 2 }] } } : x)));
    const original = recordsOf(r.mem);
    const { result, facts } = await replay(r);
    expect(result).toMatchObject({ result: "different", firstDifferingRecord: idAt(c), difference: "content" });
    expect(facts?.regenerated.slice(0, c)).toEqual(original.slice(0, c).map((x) => canonicalJson(x as Json)));
    // the regenerated comparison is the Comparator's own result, not the recorded (edited) one
    expect(facts?.regenerated[c]).not.toBe(canonicalJson(original[c] as Json));
    expect((JSON.parse(facts?.regenerated[c] ?? "{}") as Rec)["kind"]).toBe("comparison");
  });
  it("the Experiment_Policy is re-evaluated: a changed recorded decision is a difference at that record", async () => {
    const r = await recordRun();
    const recs = recordsOf(r.mem);
    const d = indexOf(recs, "policy_decision", 0);
    await rewriteRun(r.mem, (all) => all.map((x, i) => (i === d ? { ...x, payload: { ...(x["payload"] as Rec), ruleIds: ["POL-001"] } } : x)));
    expect((await replay(r)).result).toMatchObject({ result: "different", firstDifferingRecord: idAt(d) });
  });
  it("a termination reason that the regenerated Run does not reach is different (termination_reason)", async () => {
    const r = await recordRun();
    const t = setTermination("experiment_limit_reached");
    await rewriteRun(r.mem, t.edit, { editManifest: t.editManifest });
    const recs = recordsOf(r.mem);
    expect((await replay(r)).result).toMatchObject({ result: "different", difference: "termination_reason", firstDifferingRecord: idAt(recs.length - 1) });
  });
});

describe("the pre-replay judgement (from the original Run only)", () => {
  it.each(["time_limit_reached", "lease_unavailable", "launcher_killed", "isolation_violation", "error"])("termination %s is not replayable", async (reason) => {
    const r = await recordRun();
    const t = setTermination(reason);
    await rewriteRun(r.mem, t.edit, { editManifest: t.editManifest });
    expect((await replay(r)).result).toEqual({ result: "incomplete", reason: "termination_not_replayable", detail: reason });
  });
  it.each<[string, Rec]>([
    ["lease_event", { reason: "synthetic" }],
    ["store_rejection", { attempt: "secret_pattern", component: "orchestrator", patternId: "p", reason: "synthetic" }],
    ["error", { code: "transport_error", experimentId: "exp-1-1", phase: "execute", cause: "transport_error" }],
  ])("a %s record is not replayable", async (kind, payload) => {
    const r = await recordRun();
    await rewriteRun(r.mem, (recs) => [...recs.slice(0, -1), { ...(recs[0] as Rec), kind, payload }, recs[recs.length - 1] as Rec]);
    expect((await replay(r)).result).toEqual({ result: "incomplete", reason: "record_kind_not_replayable", detail: kind });
  });
  it.each<[string, Rec, string]>([
    ["interrupted", { outcome: "interrupted" }, "interrupted"],
    ["a timeout of the orchestrator", { outcome: "timeout", timeoutBy: "orchestrator" }, "timeout_by_orchestrator"],
  ])("an ai_call %s is not restorable", async (_n, change, detail) => {
    const r = await recordRun();
    await rewriteRun(r.mem, (recs) => recs.map((x) => {
      if (x["kind"] !== "ai_call") return x;
      const p = x["payload"] as Rec;
      return { ...x, payload: { requestKind: p["requestKind"], attempt: p["attempt"], payloadAuditRecordId: p["payloadAuditRecordId"], provider: p["provider"], requestSha256: p["requestSha256"], ...change } as Rec };
    }));
    expect((await replay(r)).result).toEqual({ result: "incomplete", reason: "provider_outcome_not_restorable", detail });
  });
  it.each<[string, Rec, string]>([
    ["timed_out", { outcome: "timed_out" }, "timed_out"],
    ["aborted by the lease", { outcome: "aborted", abortReason: "lease_unavailable" }, "aborted"],
    ["not_executed by the lease", { outcome: "not_executed", notExecuted: { reason: "lease_unavailable", detail: "lease:revoked" } }, "not_executed"],
    ["not_executed at the Run time limit", { outcome: "not_executed", notExecuted: { reason: "timeout_before_requests", detail: "run_time_limit" } }, "not_executed"],
    ["not_executed with a fatal Runner error", { outcome: "not_executed", notExecuted: { reason: "runner_internal_error" } }, "not_executed"],
  ])("an Observation %s is not restorable", async (_n, change, detail) => {
    // (A2 correction, 2026-11-27) the edited Observation is the last one, which no later request envelope names (checked, not assumed)
    const r = await recordRun();
    const o = unreferencedLast(r, "observation");
    await rewriteRun(r.mem, (recs) => recs.map((x, i) => (i === o ? { ...x, payload: { ...(x["payload"] as Rec), ...change } } : x)));
    const { result, facts } = await replay(r);
    expect(result).toEqual({ result: "incomplete", reason: "observation_not_restorable", detail });
    expect(facts).toBeUndefined(); // decided before the replay: nothing is regenerated
  });
  it("control: a restorable not_executed Observation is replayed (and the re-executed Comparator then differs from the recorded comparison)", async () => {
    // (A2 correction, 2026-11-27) the edited Observation is the last one, which no later request envelope names (checked, not assumed)
    const r = await recordRun();
    const o = unreferencedLast(r, "observation");
    await rewriteRun(r.mem, (all) => all.map((x, i) => (i === o ? { ...x, payload: { ...(x["payload"] as Rec), outcome: "not_executed", notExecuted: { reason: "reset_failed" } } } : x)));
    const original = recordsOf(r.mem);
    const { result, facts } = await replay(r);
    expect(result).toMatchObject({ result: "different", firstDifferingRecord: idAt(o + 1), difference: "content" });
    // the restored Observation was regenerated exactly as recorded; the comparison after it is the Comparator's own result
    expect(facts?.regenerated.slice(0, o + 1)).toEqual(original.slice(0, o + 1).map((x) => canonicalJson(x as Json)));
    expect((JSON.parse(facts?.regenerated[o + 1] ?? "{}") as Rec)["payload"]).toMatchObject({ result: "not_comparable", reason: "not_executed" });
  });
  it("negative control (an inconsistent ORIGINAL Run, not a regeneration mismatch): a record that a later request envelope names, changed, is references_invalid before the replay", async () => {
    const r = await recordRun();
    const recs = recordsOf(r.mem);
    const c = indexOf(recs, "comparison", 0);
    expect(referencedIds(r).has(idAt(c))).toBe(true); // the first comparison is a stored part of the revision request
    await rewriteRun(r.mem, (all) => all.map((x, i) => (i === c ? { ...x, payload: { ...(x["payload"] as Rec), differences: [{ path: "x", predicted: 1, observed: 2 }] } } : x))); // asserts acceptRun accepts it
    const before = snapshotOf(r.mem);
    const mock = r.mockCalls();
    const { result, facts } = await replay(r);
    expect(result).toEqual({ result: "incomplete", reason: "references_invalid", detail: "stored_part_hash" });
    expect(facts).toBeUndefined(); // no replay session: no provider answer consumed, no record regenerated
    expect(r.mockCalls()).toBe(mock);
    expect(snapshotOf(r.mem)).toEqual(before); // no write to the original Run
  });
});

describe("the external inputs (policy-config.json and preparation-table.json)", () => {
  const changedPolicy = (): Uint8Array => {
    const p = JSON.parse(dec(POLICY_BYTES())) as Rec;
    (p["limits"] as Rec)["bodyBytes"] = 4096;
    return enc(JSON.stringify(p));
  };
  it.each<[string, () => Partial<{ policy: ReplayRunInput["policyConfig"]; table: ReplayRunInput["preparationTable"] }>, string]>([
    ["missing", () => ({ policy: { kind: "missing" } }), "external_input_missing"],
    ["too large", () => ({ table: { kind: "too_large" } }), "external_input_too_large"],
    ["not JSON", () => ({ policy: ok(enc("{ nope")) }), "external_input_invalid"],
    ["swapped (the table given as the policy)", () => ({ policy: ok(TABLE_BYTES()), table: ok(POLICY_BYTES()) }), "external_input_invalid"],
    ["a valid policy with another hash", () => ({ policy: ok(changedPolicy()) }), "external_input_hash_mismatch"],
  ])("%s is refused before the replay", async (_n, inputs, reason) => {
    const r = await recordRun();
    const { result, facts } = await replay(r, inputs());
    expect(result).toMatchObject({ result: "incomplete", reason });
    expect(facts).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("operations"); // no content of an input in the result
  });
  it("a policy_decision whose hash differs from the inputs is refused", async () => {
    const r = await recordRun();
    const d = indexOf(recordsOf(r.mem), "policy_decision", 0);
    await rewriteRun(r.mem, (recs) => recs.map((x, i) => (i === d ? { ...x, payload: { ...(x["payload"] as Rec), policyConfigSha256: "c".repeat(64) } } : x)));
    expect((await replay(r)).result).toEqual({ result: "incomplete", reason: "policy_decision_hash_mismatch" });
  });
  it("manifest.config with another policy hash is refused (the inputs are compared with the Run_Manifest)", async () => {
    const r = await recordRun();
    await rewriteRun(r.mem, (recs) => recs, { editManifest: (m) => ((m["config"] as Rec)["policyConfigSha256"] = "d".repeat(64)) });
    expect((await replay(r)).result).toEqual({ result: "incomplete", reason: "external_input_hash_mismatch" });
  });
});

describe("the read budget (64 MiB) and the verified bytes", () => {
  it("records.jsonl is read once; a change of the file after it was verified does not reach the replay", async () => {
    const r = await recordRun();
    const path = `${RUN_DIR}/records.jsonl`;
    const original = r.mem.peek(path) as Uint8Array;
    const port = memoryPort(r.mem, (p) => {
      if (p === path) r.mem.poke(path, enc(dec(original).replace("iteration_limit_reached", "experiment_limit_reached")));
    });
    const { result } = await replay(r, { port });
    expect(result).toMatchObject({ result: "identical" });
    expect(port.reads.filter((p) => p === path)).toHaveLength(1);
  });
  it("a budget of exactly the bytes read passes; one byte less is cache_limit_exceeded; no read ever returned more than its limit", async () => {
    const r = await recordRun();
    const first = await replay(r);
    expect(first.result).toMatchObject({ result: "identical" });
    const total = [...new Set(first.port.reads)].reduce((n, p) => n + (r.mem.peek(p)?.byteLength ?? 0), 0);
    expect((await replay(r, { hooks: { cacheLimitBytes: total } })).result).toMatchObject({ result: "identical" });
    const short = await replay(r, { hooks: { cacheLimitBytes: total - 1 } });
    expect(short.result).toEqual({ result: "incomplete", reason: "cache_limit_exceeded" });
    // the limit handed to each read is the rest of the budget: the read that would cross it is refused by the port before it returns bytes
    expect((await replay(r, { hooks: { cacheLimitBytes: 0 } })).result).toEqual({ result: "incomplete", reason: "cache_limit_exceeded" });
  });
});

describe("the copied input context (D5)", () => {
  it("the first three records are copied with their original ids, seq and hashes and are not counted as regenerated", async () => {
    const r = await recordRun();
    const { result, facts } = await replay(r);
    const recs = recordsOf(r.mem);
    expect(facts?.regenerated.slice(0, 3)).toEqual(recs.slice(0, 3).map((x) => canonicalJson(x as Json)));
    expect(recs.slice(0, 3).map((x) => x["kind"])).toEqual(["run_started", "isolation_checks", "source_bundle_manifest"]);
    expect(result).toMatchObject({ regenerated: recs.length - 4 });
    expect(manifestOf(r.mem)["excludedFields"]).toEqual(["runId", "wallClock"]);
  });
});
