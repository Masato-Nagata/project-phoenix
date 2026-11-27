// Unit tests of the replay parts (task 4.7 step A2): the replay audit, the ReplayProvider, the recorded Runner, the restoration of a Runner
// value from an Observation, the replay-only ports and the classification. Synthetic data only; nothing here reaches a provider, the
// Legacy_App, a file or the network.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProvider, ProviderSelectionError } from "@phoenix/ai-client";
import { createRecordedRunner } from "../src/replay/recordedRunner.js";
import { createReplayAudit, type EnvelopeFunction } from "../src/replay/replayAudit.js";
import { restoreRunnerValue, type RecordedAudit, type RecordedCall, type RecordedExecution } from "../src/replay/replayInputs.js";
import { createReplayProvider } from "../src/replay/replayProvider.js";
import {
  REPLAY_GUARANTEES, classifyReplay, createDivergenceCell, createFixedClock, createReplayLeasePort, createSilentTimers, firstSequenceDifference,
} from "../src/replay/replaySupport.js";

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const signal = new AbortController().signal;
const opts = { timeoutMs: 1000, signal };

/** A fake envelope function: the bytes are the canonical text of the input kind and a counter field of the input. */
const envelope: EnvelopeFunction = (input) => {
  const i = input as { kind?: unknown; n?: unknown };
  if (typeof i.kind !== "string") return { ok: false };
  return { ok: true, value: { kind: i.kind, bytes: enc(`${i.kind}:${String(i.n)}`) } };
};
const audit = (id: string, kind: string, bytes: string, result: "pass" | "blocked" = "pass", attempt = 1): RecordedAudit => ({
  id, index: 0, requestKind: kind, attempt, result, payloadSha256: sha(bytes), bytesWithheld: false,
  checks: [{ id: "A01", outcome: result === "pass" ? "pass" : "fail" }], matches: [], hasBlob: true,
});
const call = (id: string, pa: RecordedAudit, answer: RecordedCall["answer"]): RecordedCall => ({
  id, index: 0, requestKind: pa.requestKind, attempt: pa.attempt, payloadAuditRecordId: pa.id, requestSha256: pa.payloadSha256, answer,
});
const IDENTITY = { id: "mock", version: "1", model: "none" };

function session(audits: RecordedAudit[], calls: RecordedCall[]) {
  const cell = createDivergenceCell();
  const a = createReplayAudit({ envelope, templates: new Map(), recorded: audits, cell });
  const p = createReplayProvider({ identity: IDENTITY, recorded: calls, registry: a.registry, cell });
  const request = (kind: string, n: number) => {
    const prep = a.prepareAudit({ kind, n });
    if (!prep.ok) throw new Error("prepare refused");
    return a.auditPayload(prep.value.bytes, kind, {}, prep.value.ctx);
  };
  return { cell, a, p, request };
}

describe("the replay audit", () => {
  it("reuses the recorded verdict only after the regenerated hash equals the recorded one; a pass returns a replay request", () => {
    const pa = audit("rec-000004", "hypothesis_generation", "hypothesis_generation:1");
    const s = session([pa], []);
    const out = s.request("hypothesis_generation", 1);
    expect((out.audit as { result: string }).result).toBe("pass");
    expect((out.audit as { payloadSha256: string }).payloadSha256).toBe(pa.payloadSha256);
    expect(out.request?.payloadAuditRecordId).toBe("rec-000004");
    expect(s.a.registry.owns(out.request)).toBe(true);
    expect(s.a.reused()).toBe(1);
    expect(s.a.unconsumed()).toBe(0);
    expect(s.cell.first()).toBeUndefined();
  });
  it("a blocked verdict stays blocked and returns no request (blocked never becomes pass)", () => {
    const pa = audit("rec-000004", "hypothesis_generation", "hypothesis_generation:1", "blocked");
    const s = session([pa], []);
    const out = s.request("hypothesis_generation", 1);
    expect((out.audit as { result: string }).result).toBe("blocked");
    expect(out.request).toBeUndefined();
  });
  it("a hash mismatch is noted (request_hash_mismatch, recorded id) and refused with a throw before any provider call", () => {
    const pa = audit("rec-000004", "hypothesis_generation", "hypothesis_generation:1");
    const s = session([pa], []);
    expect(() => s.request("hypothesis_generation", 2)).toThrow();
    expect(s.cell.first()).toEqual({ side: "request", code: "request_hash_mismatch", recordedRecordId: "rec-000004" });
    expect(s.a.unconsumed()).toBe(1);
  });
  it("a wrong kind, an unexpected extra request and a request that cannot be built are request-side mismatches", () => {
    const pa = audit("rec-000004", "hypothesis_generation", "experiment_generation:1");
    const s1 = session([pa], []);
    expect(() => s1.request("experiment_generation", 1)).toThrow();
    expect(s1.cell.first()?.code).toBe("request_kind_mismatch");
    const s2 = session([], []);
    expect(() => s2.request("hypothesis_generation", 1)).toThrow();
    expect(s2.cell.first()?.code).toBe("request_unexpected");
    const s3 = session([pa], []);
    expect(s3.a.prepareAudit({ n: 1 }).ok).toBe(false);
    expect(s3.cell.first()?.code).toBe("request_not_buildable");
  });
  it("refuses an unknown handle, a kind other than the prepared one and changed bytes (closed errors, nothing noted)", () => {
    const pa = audit("rec-000004", "hypothesis_generation", "hypothesis_generation:1");
    const s = session([pa], []);
    const prep = s.a.prepareAudit({ kind: "hypothesis_generation", n: 1 });
    if (!prep.ok) throw new Error("refused");
    expect(() => s.a.auditPayload(prep.value.bytes, "hypothesis_generation", {}, {})).toThrow();
    expect(() => s.a.auditPayload(prep.value.bytes, "experiment_generation", {}, prep.value.ctx)).toThrow();
    expect(() => s.a.auditPayload(enc("other"), "hypothesis_generation", {}, prep.value.ctx)).toThrow();
    expect(s.cell.count()).toBe(0);
  });
});

describe("the ReplayProvider", () => {
  it("answers the verified recorded response bytes for the matching request (kind, attempt, order, hash) and the recorded identity", async () => {
    const pa = audit("rec-000004", "hypothesis_generation", "hypothesis_generation:1");
    const body = enc('{"claims":[]}');
    const s = session([pa], [call("rec-000006", pa, { outcome: "response", bytes: body, responseSha256: sha(body) })]);
    const out = s.request("hypothesis_generation", 1);
    const answer = await s.p.complete(out.request, opts);
    expect(answer).toEqual({ ok: true, value: body });
    expect(s.p.identity).toEqual(IDENTITY);
    expect(s.p.unconsumed()).toBe(0);
    expect(s.p.answered()).toBe(1);
  });
  it("answers a recorded provider error and a provider-side timeout as they were recorded (no response bytes)", async () => {
    const pa1 = audit("rec-000004", "hypothesis_generation", "hypothesis_generation:1");
    const pa2 = audit("rec-000007", "hypothesis_generation", "hypothesis_generation:2", "pass", 2);
    const s = session([pa1, pa2], [call("rec-000005", pa1, { outcome: "provider_error", providerReason: "unmatched_request" }), call("rec-000008", pa2, { outcome: "timeout" })]);
    expect(await s.p.complete(s.request("hypothesis_generation", 1).request, opts)).toEqual({ ok: false, error: { reason: "unmatched_request", detail: "" } });
    expect(await s.p.complete(s.request("hypothesis_generation", 2).request, opts)).toEqual({ ok: false, error: { reason: "timeout", detail: "" } });
  });
  it("refuses a request that the replay audit did not create (even with the right hash) as not_audited", async () => {
    const pa = audit("rec-000004", "hypothesis_generation", "x");
    const s = session([pa], [call("rec-000005", pa, { outcome: "provider_error", providerReason: "error" })]);
    const forged = { kind: "hypothesis_generation", sha256: sha("x"), bytes: enc("x"), attempt: 1, payloadAuditRecordId: "rec-000004" };
    const answer = await s.p.complete(forged, opts);
    expect(answer).toEqual({ ok: false, error: { reason: "audit_violation", detail: "", violation: { code: "not_audited" } } });
    expect(s.cell.first()?.code).toBe("request_not_from_replay_audit");
  });
  it("missing recorded answer (more calls than recorded), wrong attempt and wrong order are request-side mismatches; unused answers are counted", async () => {
    const pa = audit("rec-000004", "hypothesis_generation", "hypothesis_generation:1");
    const s1 = session([pa], []);
    expect((await s1.p.complete(s1.request("hypothesis_generation", 1).request, opts)).ok).toBe(false);
    expect(s1.cell.first()?.code).toBe("request_unexpected");

    const paAttempt = audit("rec-000004", "hypothesis_generation", "hypothesis_generation:1", "pass", 1);
    const wrongAttempt = { ...call("rec-000005", paAttempt, { outcome: "timeout" }), attempt: 2 };
    const s2 = session([paAttempt], [wrongAttempt]);
    expect((await s2.p.complete(s2.request("hypothesis_generation", 1).request, opts)).ok).toBe(false);
    expect(s2.cell.first()?.code).toBe("request_attempt_mismatch");

    const other = { ...call("rec-000005", pa, { outcome: "timeout" }), payloadAuditRecordId: "rec-000009" };
    const s3 = session([pa], [other]);
    expect((await s3.p.complete(s3.request("hypothesis_generation", 1).request, opts)).ok).toBe(false);
    expect(s3.cell.first()?.code).toBe("request_order_mismatch");

    const pa2 = audit("rec-000006", "hypothesis_generation", "hypothesis_generation:2");
    const s4 = session([pa, pa2], [call("rec-000005", pa, { outcome: "timeout" }), call("rec-000007", pa2, { outcome: "timeout" })]);
    await s4.p.complete(s4.request("hypothesis_generation", 1).request, opts);
    expect(s4.p.unconsumed()).toBe(1);
    expect(s4.a.unconsumed()).toBe(1);
  });
  it("recorded response bytes that do not match the recorded hash are never handed out", async () => {
    const pa = audit("rec-000004", "hypothesis_generation", "hypothesis_generation:1");
    const s = session([pa], [call("rec-000006", pa, { outcome: "response", bytes: enc("tampered"), responseSha256: sha("original") })]);
    const answer = await s.p.complete(s.request("hypothesis_generation", 1).request, opts);
    expect(answer.ok).toBe(false);
    expect(s.cell.first()?.code).toBe("request_hash_mismatch");
  });
  it("is not an ai-client provider: createProvider keeps refusing the name replay (no factory registered)", () => {
    let error: unknown;
    try {
      createProvider({ provider: "replay" });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProviderSelectionError);
    expect((error as ProviderSelectionError).code).toBe("provider_not_available");
  });
});

describe("the recorded Runner", () => {
  const obs = (experimentId: string): Record<string, unknown> => ({ experimentId, outcome: "executed", preparation: [], responses: [{ status: 200, bodyKind: "empty" }], stateChecks: [], maskSha256: "a".repeat(64) });
  const normalized = (experimentId: string, path = "/orders"): Record<string, unknown> => ({ experimentId, target: { kind: "claim", id: "clm-0001" }, requests: [{ method: "GET", path }], prediction: { target: { list: "requests", index: 0 }, status: 200, fields: [] } });
  const canon = (v: unknown): string => {
    const sort = (x: unknown): unknown => (Array.isArray(x) ? x.map(sort) : typeof x === "object" && x !== null ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])])) : x);
    return JSON.stringify(sort(v));
  };
  const execution = (experimentId: string, decisionRecordId: string, withObservation = true): RecordedExecution => ({
    experimentId,
    experimentRecordId: "rec-000010",
    normalizedCanonical: canon(normalized(experimentId)),
    decisionRecordId,
    ...(withObservation ? { value: { status: "executed" as const, observation: obs(experimentId) as never, preparationLog: [] } } : {}),
  });
  const accepted = () => ({ accepted: true as const });
  it("answers the restored value for the recorded Experiment, decision and acceptance, as a fresh copy", async () => {
    const cell = createDivergenceCell();
    const seen: string[] = [];
    const r = createRecordedRunner({ recorded: [execution("exp-1-1", "rec-000011")], isAccepted: (id, d) => (seen.push(`${id} ${d}`), accepted()), cell });
    const v = (await r.execute(normalized("exp-1-1"), "rec-000011", signal)) as { status: string; observation: unknown };
    expect(v.status).toBe("executed");
    expect(v.observation).toEqual(obs("exp-1-1"));
    expect(seen).toEqual(["exp-1-1 rec-000011"]);
    expect(cell.first()).toBeUndefined();
    expect(r.unconsumed()).toBe(0);
  });
  it("the same Experiment id with a different content is a mismatch (it is not answered by id alone)", async () => {
    const cell = createDivergenceCell();
    const r = createRecordedRunner({ recorded: [execution("exp-1-1", "rec-000011")], isAccepted: accepted, cell });
    const v = (await r.execute(normalized("exp-1-1", "/products"), "rec-000011", signal)) as { status: string; fatal?: boolean };
    expect(v.status).toBe("interrupted");
    expect(v.fatal).toBe(true);
    expect(cell.first()).toEqual({ side: "runner", code: "runner_experiment_mismatch", recordedRecordId: "rec-000011" });
  });
  it("a wrong decision record id, a refused acceptance, a missing Observation and an extra call are mismatches", async () => {
    const c1 = createDivergenceCell();
    await createRecordedRunner({ recorded: [execution("exp-1-1", "rec-000011")], isAccepted: accepted, cell: c1 }).execute(normalized("exp-1-1"), "rec-000099", signal);
    expect(c1.first()?.code).toBe("runner_decision_mismatch");
    const c2 = createDivergenceCell();
    await createRecordedRunner({ recorded: [execution("exp-1-1", "rec-000011")], isAccepted: () => ({ accepted: false, code: "policy_config_changed" }), cell: c2 }).execute(normalized("exp-1-1"), "rec-000011", signal);
    expect(c2.first()?.code).toBe("runner_not_accepted");
    const c3 = createDivergenceCell();
    await createRecordedRunner({ recorded: [execution("exp-1-1", "rec-000011", false)], isAccepted: accepted, cell: c3 }).execute(normalized("exp-1-1"), "rec-000011", signal);
    expect(c3.first()?.code).toBe("runner_observation_missing");
    const c4 = createDivergenceCell();
    await createRecordedRunner({ recorded: [], isAccepted: accepted, cell: c4 }).execute(normalized("exp-1-1"), "rec-000011", signal);
    expect(c4.first()?.code).toBe("runner_unexpected_call");
  });
  it("unused recorded executions are counted (Observation not consumed)", async () => {
    const r = createRecordedRunner({ recorded: [execution("exp-1-1", "rec-000011"), execution("exp-1-2", "rec-000015")], isAccepted: accepted, cell: createDivergenceCell() });
    await r.execute(normalized("exp-1-1"), "rec-000011", signal);
    expect(r.unconsumed()).toBe(1);
    expect(r.calls()).toBe(1);
  });
});

describe("restoreRunnerValue: which recorded Observations give a faithful Runner value", () => {
  const base = { experimentId: "exp-1-1", preparation: [], responses: [], stateChecks: [], maskSha256: "a".repeat(64) };
  it.each([
    [{ ...base, outcome: "executed" }, "executed"],
    [{ ...base, outcome: "not_executed", notExecuted: { reason: "reset_failed" } }, "not_executed"],
    [{ ...base, outcome: "not_executed", notExecuted: { reason: "preparation_failed", step: 1, detail: "status" } }, "not_executed"],
    [{ ...base, outcome: "not_executed", notExecuted: { reason: "timeout_before_requests", detail: "experiment_time_limit" } }, "not_executed"],
    [{ ...base, outcome: "aborted", abortReason: "address_not_allowed" }, "aborted"],
  ])("restorable: %j", (o, status) => {
    expect(restoreRunnerValue(o as never)?.status).toBe(status);
  });
  it("not_executed keeps reason, step and detail exactly as the Observation mirrors them", () => {
    expect(restoreRunnerValue({ ...base, outcome: "not_executed", notExecuted: { reason: "preparation_failed", step: 2, detail: "x" } } as never)).toMatchObject({ status: "not_executed", reason: "preparation_failed", step: 2, detail: "x" });
  });
  it.each([
    [{ ...base, outcome: "timed_out" }],
    [{ ...base, outcome: "aborted", abortReason: "lease_unavailable" }],
    [{ ...base, outcome: "not_executed", notExecuted: { reason: "lease_unavailable", detail: "lease:revoked" } }],
    [{ ...base, outcome: "not_executed", notExecuted: { reason: "runner_internal_error" } }],
    [{ ...base, outcome: "not_executed", notExecuted: { reason: "timeout_before_requests", detail: "run_time_limit" } }],
    [{ ...base, outcome: "executed", notExecuted: { reason: "reset_failed" } }],
  ])("not restorable: %j", (o) => {
    expect(restoreRunnerValue(o as never)).toBeUndefined();
  });
});

describe("the replay-only ports and the classification", () => {
  it("the fixed clock never advances, the timers never fire, the lease port always answers valid and counts", async () => {
    const clock = createFixedClock();
    expect([clock.nowMs(), clock.nowMs()]).toEqual([0, 0]);
    const timers = createSilentTimers();
    let fired = 0;
    timers.schedule(0, () => (fired += 1)).cancel();
    timers.schedule(1, () => (fired += 1));
    await new Promise((r) => setTimeout(r, 10));
    expect(fired).toBe(0);
    expect(timers.scheduled()).toBe(2);
    const lease = createReplayLeasePort();
    expect(await lease.check({})).toEqual({ valid: true });
    expect(lease.checks()).toBe(1);
  });
  it("firstSequenceDifference: content, only in the original, only in the replay, equal; the copied prefix is skipped", () => {
    expect(firstSequenceDifference(["a", "b", "c"], ["a", "b", "x"], 1)).toEqual({ index: 2, difference: "content" });
    expect(firstSequenceDifference(["a", "b", "c"], ["a", "b"], 1)).toEqual({ index: 2, difference: "only_in_original" });
    expect(firstSequenceDifference(["a", "b"], ["a", "b", "c"], 1)).toEqual({ index: 2, difference: "only_in_replay" });
    expect(firstSequenceDifference(["a", "b"], ["a", "b"], 1)).toBeUndefined();
    expect(firstSequenceDifference(["x", "b"], ["y", "b"], 1)).toBeUndefined();
  });
  const base = { original: ["a", "b", "c", "d"], regenerated: ["a", "b", "c", "d"], copied: 3, originalTermination: { index: 4, reason: "iteration_limit_reached" }, replayTermination: "iteration_limit_reached", mismatch: undefined, unconsumed: { audits: 0, responses: 0, observations: 0 } };
  it("identical only when records, termination, mismatches and unconsumed data all agree; the guarantees are attached", () => {
    expect(classifyReplay(base)).toEqual({ result: "identical", records: 5, regenerated: 1, terminationReason: "iteration_limit_reached", guarantees: REPLAY_GUARANTEES });
    expect(REPLAY_GUARANTEES).toMatchObject({ audit: "reused_not_reexecuted", lease: "not_measured", sourceBundler: "not_reexecuted", allowlist: "not_reverified", realAi: "not_called", context: "copied_inputs" });
  });
  it("a request-side mismatch is diverged with the first differing record; a runner-side one is different", () => {
    expect(classifyReplay({ ...base, regenerated: ["a", "b", "c"], mismatch: { side: "request", code: "request_hash_mismatch", recordedRecordId: "rec-000004" } })).toMatchObject({ result: "diverged", firstDifferingRecord: "rec-000004", cause: "request_hash_mismatch", recordedRequestRecord: "rec-000004" });
    expect(classifyReplay({ ...base, regenerated: ["a", "b", "c", "x"], mismatch: { side: "runner", code: "runner_experiment_mismatch" } })).toMatchObject({ result: "different", firstDifferingRecord: "rec-000004", cause: "runner_experiment_mismatch" });
  });
  it("a different termination reason and unconsumed recorded data are different, never identical and never incomplete", () => {
    expect(classifyReplay({ ...base, replayTermination: "experiment_limit_reached" })).toMatchObject({ result: "different", difference: "termination_reason", firstDifferingRecord: "rec-000005" });
    expect(classifyReplay({ ...base, unconsumed: { audits: 0, responses: 1, observations: 0 } })).toMatchObject({ result: "different", difference: "recorded_data_unconsumed", cause: "unconsumed_responses" });
    expect(classifyReplay({ ...base, unconsumed: { audits: 0, responses: 0, observations: 2 } })).toMatchObject({ cause: "unconsumed_observations" });
  });
});
