// Experiment_Runner unit tests with a fake HTTP port and a fake lease port (task 2.17; R9.1 to R9.17, R18.3, R24.9, R24.15).
// No real Legacy_App is reached and no network is used. Neutral values only.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  executionIdentity,
  AddressNotAllowedError, HttpAbortedError, HttpTimeoutError, HttpTransportError, LeaseCheckInterrupted, RunnerStartRefused, checkRunnerStart, compare, maskConfigHash,
  type ExecutionOutcome, type HttpResponse, type LeaseReason, type LeaseState, type NotExecutedReason,
} from "../src/index.js";
import { scan, violations } from "./helpers/importGraph.js";
import { FakeLease, experiment, fullExperiment, json, makeEnv, makeParts, stop, type Env } from "./helpers/runnerFixtures.js";
import { FakeTime } from "./helpers/leaseFixtures.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

async function ready(over: Parameters<typeof makeEnv>[0] = {}): Promise<Env> {
  const env = makeEnv(over);
  expect(await env.runner.health()).toEqual({ ok: true });
  return env;
}
const run = (env: Env, e = experiment(), record = "dec-1"): Promise<ExecutionOutcome> => env.runner.execute(e, record, stop());
const notExecuted = (o: ExecutionOutcome): Extract<ExecutionOutcome, { status: "not_executed" }> => {
  if (o.status !== "not_executed") throw new Error(`expected not_executed, got ${o.status}`);
  return o;
};

describe("refusing to start (R9.14, R9.17, R18.3)", () => {
  it("refuses an address that is neither the loopback-published Reverse_Proxy address nor the configured internal address, records the value, and sends nothing", () => {
    for (const address of ["http://127.0.0.1:9", "http://example.com", "http://localhost:8056", "https://127.0.0.1:8056", "http://user@127.0.0.1:8056", "", "http://127.0.0.1:8056/x", "http://127.0.0.1:8056/", "http://0x7f.0.0.1:8056", "http://REVERSE-PROXY:8080"]) {
      const parts = makeParts({ baseAddress: address });
      let refused: RunnerStartRefused | undefined;
      try {
        makeEnv({ baseAddress: address });
      } catch (e) {
        refused = e as RunnerStartRefused;
      }
      expect(refused, address).toBeInstanceOf(RunnerStartRefused);
      expect(refused?.refusals, address).toEqual([{ code: "address_not_allowed", address }]);
      expect(parts.http.calls).toEqual([]);
    }
    expect(() => makeEnv({ baseAddress: "http://reverse-proxy:8080" })).not.toThrow();
  });

  it("refuses limits outside the ranges: request 1 to 60 s, Experiment 1 to 600 s, and the Experiment limit not smaller than the request limit", () => {
    const bad = [
      { requestTimeoutMs: 999, experimentTimeoutMs: 60000 }, { requestTimeoutMs: 60001, experimentTimeoutMs: 600000 }, { requestTimeoutMs: 1000, experimentTimeoutMs: 999 },
      { requestTimeoutMs: 1000, experimentTimeoutMs: 600001 }, { requestTimeoutMs: 20000, experimentTimeoutMs: 10000 }, { requestTimeoutMs: 1500.5, experimentTimeoutMs: 60000 },
      { requestTimeoutMs: Number.NaN, experimentTimeoutMs: 60000 }, { requestTimeoutMs: 10000, experimentTimeoutMs: "60000" as unknown as number },
    ];
    for (const limits of bad) {
      const r = checkRunnerStart({ ...makeParts().deps, limits });
      expect(r.ok, JSON.stringify(limits)).toBe(false);
      if (!r.ok) expect(r.error[0]?.code).toBe("limits_invalid");
    }
    for (const limits of [{ requestTimeoutMs: 1000, experimentTimeoutMs: 1000 }, { requestTimeoutMs: 60000, experimentTimeoutMs: 600000 }, { requestTimeoutMs: 10000, experimentTimeoutMs: 10000 }]) {
      expect(checkRunnerStart({ ...makeParts().deps, limits }).ok, JSON.stringify(limits)).toBe(true);
    }
  });

  it("refuses an invalid mask configuration or address policy, and reports every refusal", () => {
    const parts = makeParts();
    const r = checkRunnerStart({ ...parts.deps, mask: { paths: ["$status"] }, baseAddress: "http://nowhere", limits: { requestTimeoutMs: 1, experimentTimeoutMs: 1 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.map((x) => x.code)).toEqual(["limits_invalid", "address_not_allowed", "mask_config_invalid"]);
    const p = checkRunnerStart({ ...parts.deps, addressPolicy: { loopbackOrigin: "http://localhost:1", internalOrigin: "http://x:1" } });
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.error[0]?.code).toBe("address_policy_invalid");
  });
});

describe("health check (R9.1)", () => {
  it("passes the start-up proof of the lease first, then asks GET /health with the 10-second limit", async () => {
    const env = makeEnv();
    expect(await env.runner.health()).toEqual({ ok: true });
    expect(env.lease.calls).toBe(1);
    expect(env.http.seen).toEqual(["GET /health"]);
    expect(env.http.calls[0]?.timeoutMs).toBe(10_000);
  });

  it("an unhealthy Legacy_App executes nothing: status, timeout, or transport failure", async () => {
    const cases: [string, (env: Env) => void, string][] = [
      ["status 503", (e) => e.http.on(() => true, json(503, { success: true, data: { app: "ok", db: "error" } })), "unhealthy:status_503"],
      ["timeout", (e) => e.http.on(() => true, new HttpTimeoutError()), "unhealthy:timeout"],
      ["transport error", (e) => e.http.on(() => true, new HttpTransportError()), "unhealthy:transport"],
    ];
    for (const [name, arrange, error] of cases) {
      const env = makeEnv();
      arrange(env);
      expect(await env.runner.health(), name).toEqual({ ok: false, error });
      const o = notExecuted(await run(env));
      expect(o.reason, name).toBe("runner_not_healthy");
      expect(env.http.calls.length, name).toBe(1); // only the health check
    }
  });

  it("a lease that is not valid at the start stops the Run before any request, with the reason of the lease", async () => {
    for (const reason of ["missing", "malformed", "run_mismatch", "nonce_mismatch", "revoked", "heartbeat_stale", "unreadable"] as LeaseReason[]) {
      const env = makeEnv();
      env.lease.script = () => ({ valid: false, reason });
      expect(await env.runner.health()).toEqual({ ok: false, error: `lease_unavailable:${reason}` });
      expect(env.http.calls, reason).toEqual([]);
      expect(notExecuted(await run(env)).reason).toBe("runner_not_healthy");
      expect(env.http.calls, reason).toEqual([]);
    }
  });

  it("an Experiment is not executed before the health check was made", async () => {
    const env = makeEnv();
    expect(notExecuted(await run(env)).reason).toBe("runner_not_healthy");
    expect(env.http.calls).toEqual([]);
    expect(env.lease.calls).toBe(0);
  });

  it("is repeatable: a failed check makes the runner unhealthy until a check passes again", async () => {
    const env = await ready();
    env.http.on(() => true, json(500, {}));
    expect((await env.runner.health()).ok).toBe(false);
    expect(notExecuted(await run(env)).reason).toBe("runner_not_healthy");
    env.http.overrides = [];
    expect(await env.runner.health()).toEqual({ ok: true });
    expect((await run(env)).status).toBe("executed");
  });
});

describe("execute only an accepted Experiment (R9.2, R9.3)", () => {
  it("no accept decision: not_executed with policy_not_accepted, and no request for it", async () => {
    const env = await ready();
    const before = env.http.calls.length;
    for (const [e, record] of [[experiment({ experimentId: "exp-9" }), "dec-9"], [experiment(), ""], [experiment(), undefined as unknown as string]] as const) {
      const o = notExecuted(await env.runner.execute(e, record, stop()));
      expect(o.reason).toBe("policy_not_accepted");
      expect(o.observation).toMatchObject({ outcome: "not_executed", notExecuted: { reason: "policy_not_accepted" }, responses: [], stateChecks: [] });
    }
    expect(env.http.calls.length).toBe(before);
  });

  it("asks the Evidence_Store about this Experiment, decision record, and identity (content, policy configuration, preparation table)", async () => {
    const asked: [string, string, unknown][] = [];
    const env = await ready({ isAccepted: (id, rec, identity) => { asked.push([id, rec, identity]); return { accepted: true }; } });
    const e = experiment({ experimentId: "exp-7" });
    await run(env, e, "dec-7");
    expect(asked).toEqual([["exp-7", "dec-7", executionIdentity(e, env.deps.policy, env.deps.prepTable)]]);
  });

  it("refuses with the code of the verdict, and a verdict that is not a verdict is a refusal too", async () => {
    for (const verdict of [{ accepted: false, code: "reject_exists" }, { accepted: false, code: "experiment_content_changed" }, undefined, null, true, { accepted: "yes" }] as unknown[]) {
      const env = await ready({ isAccepted: () => verdict as never });
      const before = env.http.calls.length;
      const o = notExecuted(await run(env));
      expect(o.reason).toBe("policy_not_accepted");
      expect(o.detail).toBe(`not_accepted:${typeof verdict === "object" && verdict !== null && (verdict as { accepted?: unknown }).accepted === false ? (verdict as { code: string }).code : "invalid_verdict"}`);
      expect(env.http.calls.length).toBe(before);
    }
  });

  it("an operation that the policy allowlist does not name is not sent, whatever the decision record says: the policy decides again (OD-17)", async () => {
    const env = await ready();
    for (const requests of [
      [{ method: "POST", path: "/reset" }], [{ method: "GET", path: "/test/orders/1/ship" }], [{ method: "POST", path: "/test/orders/1/ship" }],
      [{ method: "GET", path: "/orders" }, { method: "GET", path: "/health" }], [{ method: "DELETE", path: "/orders" }], [{ method: "GET", path: "http://evil.example/x" }],
    ]) {
      const before = env.http.calls.length;
      const o = notExecuted(await run(env, experiment({ requests: requests as never })));
      expect(o.reason).toBe("policy_not_accepted");
      expect(o.detail).toMatch(/^redecision_rejected:POL-/); // the policy decides again before the execution
      expect(env.http.calls.length).toBe(before);
    }
  });

  it("a malformed Experiment is not executed and does not throw", async () => {
    const env = await ready();
    for (const bad of [null, undefined, {}, { experimentId: "exp-1" }, { experimentId: "exp-1", requests: [] }, { experimentId: "exp-1", requests: "x" }, { experimentId: "exp-1", requests: [null] }] as unknown[]) {
      const o = await env.runner.execute(bad as never, "dec-1", stop());
      expect(o.status, JSON.stringify(bad)).toBe("not_executed");
    }
    expect(env.http.calls.length).toBe(1); // the health check only
  });
});

describe("the order of the requests (R9.7, R9.8, R9.10, R9.13)", () => {
  it("reset first, then the preparation in order, then the requests in declared order, then the state checks", async () => {
    const env = await ready();
    const o = await run(env, fullExperiment());
    expect(o.status).toBe("executed");
    expect(env.http.seen).toEqual(["GET /health", "POST /reset", "POST /orders", "GET /orders/1", "GET /orders", "GET /orders"]);
    expect(env.http.sentWhileInvalid).toBe(0);
    if (o.status !== "executed") return;
    expect(o.preparationLog).toEqual([{ stepIndex: 0, operation: "POST /orders", status: 201 }]);
    expect(o.observation.responses.length).toBe(2);
    expect(o.observation.stateChecks.length).toBe(1);
    expect(o.observation).toMatchObject({ experimentId: "exp-1", outcome: "executed", preparation: o.preparationLog });
  });

  it("the preparation body is built by the table from the numbered parameters; the AI supplies no method, path, or URL", async () => {
    const env = await ready();
    await run(env, experiment({ preparation: [{ kind: "order_exists", params: { customer_id: 3, quantity_2: 5, product_2: 8, product_1: 7, quantity_1: 6 } }] }));
    const prep = env.http.calls[2]?.req;
    expect(prep).toEqual({ method: "POST", path: "/orders", body: '{"customer_id":3,"lines":[{"product_id":7,"quantity":6},{"product_id":8,"quantity":5}]}' });
  });

  it("several steps run in declared order; a kind with two operations sends both, with the captured identifier", async () => {
    const env = await ready();
    const e = experiment({
      preparation: [
        { kind: "order_shipped", bind: "a", params: { customer_id: 1, product_1: 1, quantity_1: 1 } },
        { kind: "order_cancelled", bind: "b", params: { customer_id: 1, product_1: 1, quantity_1: 1 } },
        { kind: "order_exists", params: { customer_id: 1, product_1: 1, quantity_1: 1 } },
      ],
      requests: [{ method: "GET", path: "/orders/{id}", pathParams: { id: { $bind: "b" } } }],
    });
    const o = await run(env, e);
    expect(env.http.seen).toEqual([
      "GET /health", "POST /reset", "POST /orders", "POST /test/orders/1/ship", "POST /orders", "POST /orders/2/cancel", "POST /orders", "GET /orders/2",
    ]);
    if (o.status !== "executed") throw new Error(o.status);
    expect(o.preparationLog).toEqual([
      { stepIndex: 0, operation: "POST /orders", status: 201 },
      { stepIndex: 0, operation: "POST /test/orders/{bound}/ship", status: 200 },
      { stepIndex: 1, operation: "POST /orders", status: 201 },
      { stepIndex: 1, operation: "POST /orders/{bound}/cancel", status: 200 },
      { stepIndex: 2, operation: "POST /orders", status: 201 },
    ]);
  });

  it("serializes Experiments: one at a time, in the order submitted, even when they are submitted together", async () => {
    const env = await ready();
    // Delay every reply by a few microtask turns, so that an interleaving of the two Experiments would show.
    const original = env.http.send.bind(env.http);
    env.http.send = async (...args) => {
      for (let i = 0; i < 5; i += 1) await Promise.resolve();
      return original(...args);
    };
    const a = env.runner.execute(fullExperiment(), "dec-1", stop());
    const b = env.runner.execute(experiment({ experimentId: "exp-2" }), "dec-2", stop());
    const [oa, ob] = await Promise.all([a, b]);
    expect(oa.status).toBe("executed");
    expect(ob.status).toBe("executed");
    expect(env.http.seen.slice(1)).toEqual(["POST /reset", "POST /orders", "GET /orders/1", "GET /orders", "GET /orders", "POST /reset", "GET /orders"]);
  });

  it("builds the path from the path parameters, the body in canonical form, and passes the allowed headers", async () => {
    const env = await ready();
    await run(env, experiment({ requests: [
      { method: "POST", path: "/orders/{id}/cancel", pathParams: { id: 12 }, headers: { "content-type": "application/json" }, body: { b: 1, a: { z: 1, y: [2] } } },
      { method: "GET", path: "/products/{id}", pathParams: { id: 2147483647 } },
    ] }));
    expect(env.http.calls[2]?.req).toEqual({ method: "POST", path: "/orders/12/cancel", headers: { "content-type": "application/json" }, body: '{"a":{"y":[2],"z":1},"b":1}' });
    expect(env.http.calls[3]?.req).toEqual({ method: "GET", path: "/products/2147483647" });
  });
});

describe("reset (R9.8, R9.9)", () => {
  it("a reset that fails sends nothing more: status other than 200, success false, a body that is not JSON, a timeout, a transport error", async () => {
    const cases: [string, Parameters<Env["http"]["on"]>[1]][] = [
      ["status 500", json(500, { success: false })], ["status 201", json(201, { success: true })], ["success false", json(200, { success: false })],
      ["success missing", json(200, {})], ["not JSON", { status: 200, body: "OK" }], ["empty", { status: 200, body: "" }],
      ["timeout", new HttpTimeoutError()], ["transport", new HttpTransportError()],
    ];
    for (const [name, reply] of cases) {
      const env = await ready();
      env.http.on((r) => r.path === "/reset", reply);
      const o = notExecuted(await run(env, fullExperiment()));
      expect(o.reason, name).toBe("reset_failed");
      expect(env.http.seen, name).toEqual(["GET /health", "POST /reset"]);
    }
  });
});

describe("preparation failures (R9.12)", () => {
  it("a step that does not return the expected status: preparation_failed with the step and the status, and no request sequence", async () => {
    const env = await ready();
    env.http.on((r, n) => r.path === "/orders" && n === 4, json(409, { success: false })); // the second step (calls: health, reset, step 0, step 1)
    const e = experiment({ preparation: [0, 1, 2].map(() => ({ kind: "order_exists", params: { customer_id: 1, product_1: 1, quantity_1: 1 } })) });
    const o = notExecuted(await run(env, e));
    expect(o).toMatchObject({ reason: "preparation_failed", step: 1, detail: "status:409" });
    expect(o.observation.notExecuted).toEqual({ reason: "preparation_failed", step: 1, detail: "status:409" });
    expect(o.observation.preparation).toEqual([{ stepIndex: 0, operation: "POST /orders", status: 201 }, { stepIndex: 1, operation: "POST /orders", status: 409 }]);
    expect(env.http.seen).toEqual(["GET /health", "POST /reset", "POST /orders", "POST /orders"]);
  });

  it("no response at all is recorded as status none", async () => {
    for (const reply of [new HttpTransportError(), new HttpTimeoutError()]) {
      const env = await ready();
      env.http.on((r) => r.path === "/orders", reply);
      const o = notExecuted(await run(env, fullExperiment()));
      expect(o.reason).toBe("preparation_failed");
      expect(o.step).toBe(0);
      expect(o.detail).toBe(reply instanceof HttpTransportError ? "status:none" : "request_time_limit");
      expect(env.http.seen).toEqual(["GET /health", "POST /reset", "POST /orders"]);
    }
  });

  it("a step that the table does not accept is refused by the re-decision before anything is sent, not even the reset (POL-011 and the table are one definition)", async () => {
    const bad = [
      { kind: "order_unknown", params: {} }, { kind: "reset", params: {} }, { kind: "order_exists", params: { customer_id: 1 } },
      { kind: "order_exists", params: { customer_id: "1", product_1: 1, quantity_1: 1 } }, { kind: "order_exists", params: { customer_id: 1, product_2: 1, quantity_2: 1 } },
    ];
    for (const step of bad) {
      const env = await ready();
      const o = notExecuted(await run(env, experiment({ preparation: [step] })));
      expect(o.reason, JSON.stringify(step)).toBe("policy_not_accepted");
      expect(o.detail).toBe("redecision_rejected:POL-011");
      expect(env.http.seen).toEqual(["GET /health"]);
    }
  });
  it("a created identifier that is missing from the response cannot be bound: preparation_failed", async () => {
    const env = await ready();
    env.http.on((r) => r.path === "/orders", json(201, { success: true, data: {} }));
    const o = notExecuted(await run(env, fullExperiment()));
    expect(o).toMatchObject({ reason: "preparation_failed", step: 0, detail: "status:201;capture_missing" });
  });

  it("a request that names a bind that no step declared is refused by the re-decision (POL-010) and sends nothing", async () => {
    const env = await ready();
    const e = experiment({ requests: [{ method: "GET", path: "/orders/{id}", pathParams: { id: { $bind: "nobody" } } }] });
    const o = notExecuted(await run(env, e));
    expect(o).toMatchObject({ reason: "policy_not_accepted", detail: "redecision_rejected:POL-010" });
    expect(env.http.seen).toEqual(["GET /health"]);
  });
});
describe("the recorded Observation (R9.13, C2)", () => {
  it("records the status and the masked body of every response; non-2xx statuses are responses, not failures", async () => {
    const env = await ready();
    env.http.on((r) => r.path === "/orders", json(404, { success: false, error: "Not Found" }));
    const o = await run(env, experiment({ requests: [{ method: "GET", path: "/orders" }, { method: "GET", path: "/orders/{id}", pathParams: { id: 5 } }] }));
    if (o.status !== "executed") throw new Error(o.status);
    expect(o.observation.responses).toEqual([
      { status: 404, bodyKind: "json", body: { success: false, error: "Not Found" } },
      { status: 200, bodyKind: "json", body: { success: true, data: { id: 5, created_at: "<masked>" } } },
    ]);
    expect(o.observation.maskSha256).toBe(maskConfigHash({ paths: ["data.created_at"] }));
  });

  it("tells JSON, text, and empty bodies apart, and masks a body that is too deeply nested as a whole", async () => {
    const env = await ready();
    let deep = "1";
    for (let i = 0; i < 70; i += 1) deep = `{"a":${deep}}`;
    const replies = [{ status: 200, body: "plain text" }, { status: 204, body: "" }, { status: 200, body: "5" }, { status: 200, body: deep }, { status: 200, body: "{bad" }];
    let k = 0;
    env.http.on((r) => r.path === "/orders", async () => replies[k++] as HttpResponse);    const e = experiment({ requests: replies.map(() => ({ method: "GET" as const, path: "/orders" })) });
    const o = await run(env, e);
    if (o.status !== "executed") throw new Error(o.status);
    expect(o.observation.responses).toEqual([
      { status: 200, bodyKind: "text", body: "plain text" },
      { status: 204, bodyKind: "empty" },
      { status: 200, bodyKind: "json", body: 5 },
      { status: 200, bodyKind: "text", body: "<masked>" },
      { status: 200, bodyKind: "text", body: "{bad" },
    ]);
  });

  it("the Observation is what the Comparator reads: a prediction of the observed values matches under the same mask configuration", async () => {
    const env = await ready();
    const o = await run(env, fullExperiment());
    if (o.status !== "executed") throw new Error(o.status);
    const cfg = { paths: ["data.created_at"] };
    const prediction = { target: { list: "requests" as const, index: 0 }, status: 200, fields: [{ path: "data.id", value: 1 }, { path: "data.created_at", value: "anything" }] };
    expect(compare(prediction, o.observation, cfg)).toMatchObject({ result: "match", differences: [] });
    expect(compare({ ...prediction, target: { list: "stateChecks", index: 0 }, status: 200, fields: [{ path: "success", value: true }] }, o.observation, cfg).result).toBe("match");
  });
});

describe("the Run_Lease gates every request (R9.4, R9.5, R24.9, R24.15)", () => {
  /** One prepared order, two requests, one state check: the checks are #1 health, #2 the Experiment, #3 reset, #4 preparation, #5 and #6 the requests, #7 the state check. */
  const table: [number, string, string[], number, number][] = [
    [2, "not_executed", ["GET /health"], 0, 0],
    [3, "not_executed", ["GET /health"], 0, 0],
    [4, "not_executed", ["GET /health", "POST /reset"], 0, 0],
    [5, "not_executed", ["GET /health", "POST /reset", "POST /orders"], 0, 0],
    [6, "aborted", ["GET /health", "POST /reset", "POST /orders", "GET /orders/1"], 1, 0],
    [7, "aborted", ["GET /health", "POST /reset", "POST /orders", "GET /orders/1", "GET /orders"], 2, 0],
    [8, "executed", ["GET /health", "POST /reset", "POST /orders", "GET /orders/1", "GET /orders", "GET /orders"], 2, 1],
  ];
  for (const [from, status, seen, responses, stateChecks] of table) {
    it(`a lease that is invalid from the check #${from}: ${status}, ${responses} response(s), and no request after it`, async () => {
      for (const reason of ["missing", "malformed", "run_mismatch", "nonce_mismatch", "revoked", "heartbeat_stale", "unreadable"] as LeaseReason[]) {
        const env = await ready();
        env.lease.invalidFrom(from, { valid: false, reason });
        const o = await run(env, fullExperiment());
        expect(o.status, reason).toBe(status);
        expect(env.http.seen, reason).toEqual(seen);
        expect(env.http.sentWhileInvalid, reason).toBe(0);
        if (o.status === "executed") continue;
        const expected = reason === "heartbeat_stale" ? "launcher_killed" : "lease_unavailable";
        if (o.status === "not_executed") expect(o).toMatchObject({ reason: "lease_unavailable", leaseReason: reason, terminationReason: expected });
        if (o.status === "aborted") expect(o).toMatchObject({ reason: "lease_unavailable", leaseReason: reason, terminationReason: expected });
        expect(o.observation.responses.length).toBe(responses);
        expect(o.observation.stateChecks.length).toBe(stateChecks);
        expect(o.observation.outcome).toBe(status);
        if (o.status === "aborted") expect(o.observation.abortReason).toBe("lease_unavailable");
      }
    });
  }

  it("the lease is checked before the Run (the proof), before each Experiment, and before every request including reset and preparation", async () => {
    const env = await ready();
    expect(env.lease.calls).toBe(1);
    await run(env, fullExperiment());
    expect(env.lease.calls).toBe(7);
    await run(env, experiment({ experimentId: "exp-2" }));
    expect(env.lease.calls).toBe(7 + 3); // the Experiment, the reset, the request
  });

  it("a lease that stays invalid stops every later Experiment too: nothing is sent", async () => {
    const env = await ready();
    env.lease.invalidFrom(2, { valid: false, reason: "heartbeat_stale" });
    for (let i = 0; i < 3; i += 1) {
      const o = notExecuted(await run(env, experiment({ experimentId: i % 2 === 0 ? "exp-1" : "exp-2" })));
      expect(o).toMatchObject({ reason: "lease_unavailable", terminationReason: "launcher_killed" });
    }
    expect(env.http.seen).toEqual(["GET /health"]);
  });

  it("a lease check that throws is never a reason to send: it counts as unreadable", async () => {
    const env = await ready();
    env.lease.script = (n) => {
      if (n >= 3) throw new Error("boom");
      return { valid: true };
    };
    const o = notExecuted(await run(env));
    expect(o).toMatchObject({ reason: "lease_unavailable", leaseReason: "unreadable", terminationReason: "lease_unavailable" });
    expect(env.http.seen).toEqual(["GET /health"]);
  });

  it("a lease port that answers directly, and one that answers with a Promise, are treated alike", async () => {
    const env = await ready();
    env.lease.script = () => Promise.resolve({ valid: true });
    expect((await run(env)).status).toBe("executed");
    env.lease.script = () => Promise.resolve({ valid: false, reason: "revoked" } as LeaseState);
    expect(notExecuted(await run(env)).reason).toBe("lease_unavailable");
  });

  it("passes the Experiment time limit and the stop signal to the lease check, so that a hold counts toward the limit (R9.14)", async () => {
    const env = await ready();
    const controller = new AbortController();
    await env.runner.execute(experiment(), "dec-1", controller.signal);
    const last = env.lease.options[env.lease.options.length - 1];
    expect(last?.signal).toBe(controller.signal);
    expect(last?.deadlineAtMs).toBe(env.time.t + 60_000);
  });

  it("a hold that runs into the Experiment time limit is a timeout, not a lease failure", async () => {
    const reset = await ready();
    reset.lease.script = (n) => {
      if (n === 3) throw new LeaseCheckInterrupted("deadline");
      return { valid: true };
    };
    expect(notExecuted(await run(reset))).toMatchObject({ reason: "reset_failed", detail: "experiment_time_limit" });

    const seq = await ready();
    seq.lease.script = (n) => {
      if (n === 6) throw new LeaseCheckInterrupted("deadline");
      return { valid: true };
    };
    const o = await run(seq, fullExperiment());
    expect(o.status).toBe("timed_out");
    expect(o.status === "timed_out" && o.observation.responses.length).toBe(1);
    expect(seq.http.sentWhileInvalid).toBe(0);

    // A stop of the Run during the hold is a forced stop, not a failure of the reset (OD-18).
    const aborted = await ready();
    aborted.lease.script = (n) => {
      if (n === 3) throw new LeaseCheckInterrupted("aborted");
      return { valid: true };
    };
    expect(await run(aborted)).toMatchObject({ status: "interrupted", cause: "forced_stop", phase: "reset", sentRequests: 0, detail: "run_aborted" });
  });

  it("aborts a request in flight when the lease becomes invalid (R24.15), and records it as aborted with the responses so far", async () => {
    const time = new FakeTime();
    const env = await ready({ inFlightWatch: { intervalMs: 500, sleeper: time } });
    env.http.on((r) => r.path === "/orders/{id}" || /^\/orders\/\d+$/.test(r.path), (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new HttpAbortedError()), { once: true });
    }));
    // Valid until the first request of the sequence (the fourth call) is in flight, invalid from then on.
    env.lease.script = () => (env.http.calls.length >= 4 ? { valid: false, reason: "heartbeat_stale" } : { valid: true });
    const o = await run(env, fullExperiment());
    expect(o.status).toBe("aborted");
    if (o.status !== "aborted") return;
    expect(o).toMatchObject({ reason: "lease_unavailable", leaseReason: "heartbeat_stale", terminationReason: "launcher_killed" });
    expect(o.observation.responses).toEqual([]);
    expect(env.http.seen).toEqual(["GET /health", "POST /reset", "POST /orders", "GET /orders/1"]);
  });

  it("a request that finishes while the lease stays valid is not disturbed by the watcher", async () => {
    const time = new FakeTime();
    const env = await ready({ inFlightWatch: { intervalMs: 500, sleeper: time } });
    expect((await run(env, fullExperiment())).status).toBe("executed");
  });
});

describe("the address check (R9.16)", () => {
  it("a target that the adapter refuses is not sent: not_executed before any request of the sequence, aborted after one", async () => {
    const early = await ready();
    early.http.on((r) => r.path === "/reset", new AddressNotAllowedError());
    expect(notExecuted(await run(early)).reason).toBe("address_not_allowed");

    const first = await ready();
    first.http.on((r) => r.path === "/orders", new AddressNotAllowedError());
    const f = await run(first);
    expect(f.status).toBe("not_executed");
    expect(f.status === "not_executed" && f.reason).toBe("address_not_allowed");

    const second = await ready();
    second.http.on((r, n) => r.path === "/orders" && n === 4, new AddressNotAllowedError());
    const o = await run(second, experiment({ requests: [{ method: "GET", path: "/orders" }, { method: "GET", path: "/orders" }] }));
    expect(o.status).toBe("aborted");
    expect(o).toMatchObject({ reason: "address_not_allowed" });
    expect(o.status === "aborted" && o.observation.abortReason).toBe("address_not_allowed");
    expect(o.status === "aborted" && o.observation.responses.length).toBe(1);
  });
});

describe("time limits (R9.14, R9.15)", () => {
  const limits = { requestTimeoutMs: 1000, experimentTimeoutMs: 5000 };

  it("a request gets the request limit, or what is left of the Experiment limit if that is less", async () => {
    const env = await ready({ limits: { requestTimeoutMs: 2000, experimentTimeoutMs: 5000 } });
    env.http.cost = (r) => (r.path === "/reset" || (r.method === "POST" && r.path === "/orders") ? 1900 : 0);
    const t0 = env.time.t;
    const o = await run(env, fullExperiment());
    expect(o.status).toBe("executed");
    expect(env.time.t - t0).toBe(3800);
    // The reset and the preparation get the request limit; the rest gets the 1200 ms that are left of the Experiment limit.
    expect(env.http.calls.slice(1).map((c) => c.timeoutMs)).toEqual([2000, 2000, 1200, 1200, 1200]);
  });

  it("a timeout during the reset is reset_failed; during the preparation it is preparation_failed", async () => {
    const reset = await ready({ limits });
    reset.http.cost = (r) => (r.path === "/reset" ? 1500 : 0);
    expect(notExecuted(await run(reset, fullExperiment()))).toMatchObject({ reason: "reset_failed", detail: "request_time_limit" });
    expect(reset.http.seen).toEqual(["GET /health", "POST /reset"]);

    const prep = await ready({ limits });
    prep.http.cost = (r) => (r.path === "/orders" ? 1500 : 0);
    expect(notExecuted(await run(prep, fullExperiment()))).toMatchObject({ reason: "preparation_failed", step: 0, detail: "request_time_limit" });
    expect(prep.http.seen).toEqual(["GET /health", "POST /reset", "POST /orders"]);
  });

  it("the Experiment limit ends the Experiment before the request sequence as not_executed (timeout_before_requests), and sends nothing more", async () => {
    const env = await ready({ limits: { requestTimeoutMs: 1000, experimentTimeoutMs: 2000 } });
    env.http.cost = (r) => (r.path === "/reset" || r.path === "/orders" ? 1000 : 0);
    const o = notExecuted(await run(env, fullExperiment()));
    expect(o).toMatchObject({ reason: "timeout_before_requests", detail: "experiment_time_limit" });
    expect(env.http.seen).toEqual(["GET /health", "POST /reset", "POST /orders"]);
  });

  it("a timeout during the request sequence is timed_out with the responses so far; no further request is sent", async () => {
    const env = await ready({ limits });
    env.http.on((r, n) => n === 5 && r.path === "/orders", new HttpTimeoutError());
    const o = await run(env, fullExperiment());
    expect(o.status).toBe("timed_out");
    if (o.status !== "timed_out") return;
    expect(o.observation).toMatchObject({ outcome: "timed_out" });
    expect(o.observation.responses.length).toBe(1);
    expect(o.observation.stateChecks).toEqual([]);
    expect(o.detail).toBe("request_time_limit");
    expect(env.http.seen).toEqual(["GET /health", "POST /reset", "POST /orders", "GET /orders/1", "GET /orders"]);
  });

  it("a timeout in a state check is timed_out with everything collected so far", async () => {
    const env = await ready({ limits });
    env.http.on((r, n) => n === 6 && r.path === "/orders", new HttpTimeoutError());
    const o = await run(env, fullExperiment());
    expect(o.status).toBe("timed_out");
    expect(o.status === "timed_out" && o.observation.responses.length).toBe(2);
  });

  it("the Experiment limit used up in the request sequence is timed_out (experiment_time_limit)", async () => {
    const env = await ready({ limits: { requestTimeoutMs: 1000, experimentTimeoutMs: 3000 } });
    env.http.cost = (r) => (r.path === "/orders" || r.path.startsWith("/orders/") ? 1000 : 0);
    const e = experiment({ requests: [0, 1, 2, 3].map(() => ({ method: "GET" as const, path: "/orders" })) });
    const o = await run(env, e);
    expect(o.status).toBe("timed_out");
    expect(o.status === "timed_out" && o.observation.responses.length).toBe(3);
    expect(o.status === "timed_out" && o.detail).toBe("experiment_time_limit");
    expect(env.http.seen.filter((s) => s === "GET /orders").length).toBe(3);
  });

  it("a forced stop is neither a time limit nor a failure of a phase: no Observation, the cause is kept, and nothing is sent after it (OD-18)", async () => {
    const early = await ready();
    const stopped = new AbortController();
    stopped.abort();
    expect(await early.runner.execute(experiment(), "dec-1", stopped.signal)).toEqual({
      status: "interrupted", cause: "forced_stop", experimentId: "exp-1", phase: "not_started", sentRequests: 0, collectedResponses: 0, collectedStateChecks: 0, detail: "run_aborted",
    });
    expect(early.http.seen).toEqual(["GET /health"]);

    const mid = await ready();
    const controller = new AbortController();
    mid.http.on((_r, n) => n === 3, async () => { controller.abort(); return json(200, { success: true }); }); // the first request of the sequence
    const e = experiment({ requests: [{ method: "GET", path: "/orders" }, { method: "GET", path: "/orders" }] });
    const o = await mid.runner.execute(e, "dec-1", controller.signal);
    expect(o).toMatchObject({ status: "interrupted", cause: "forced_stop", phase: "seq", sentRequests: 1, collectedResponses: 1, collectedStateChecks: 0, detail: "run_aborted" });
    expect(o).not.toHaveProperty("observation");
    expect(o).not.toHaveProperty("fatal");
    expect(mid.http.seen.length).toBe(3);
    // The Run is over: later Experiments are not executed, whatever their signal.
    const later = await mid.runner.execute(experiment({ experimentId: "exp-2" }), "dec-2", stop());
    expect(later).toMatchObject({ status: "interrupted", cause: "forced_stop", experimentId: "exp-2", phase: "not_started", sentRequests: 0 });
    expect(mid.http.seen.length).toBe(3);
  });

  it("a stop during the reset or the preparation is not turned into reset_failed or preparation_failed", async () => {
    for (const [at, phase] of [[2, "reset"], [3, "prep"]] as const) {
      const env = await ready();
      const controller = new AbortController();
      env.http.on((_r, n) => n === at, async () => { controller.abort(); return json(at === 2 ? 200 : 201, { success: true, data: { order_id: 1 } }); });
      const o = await env.runner.execute(fullExperiment(), "dec-1", controller.signal);
      expect(o, phase).toMatchObject({ status: "interrupted", cause: "forced_stop", sentRequests: 0 });
      expect(env.http.seen.length, phase).toBe(at);
    }
  });

  it("a request in flight is aborted by the stop, and the Experiment is interrupted with the request counted as sent", async () => {
    const env = await ready();
    const controller = new AbortController();
    env.http.on((r) => r.path === "/orders", (signal) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new HttpAbortedError()), { once: true });
      controller.abort();
    }));
    const o = await env.runner.execute(experiment(), "dec-1", controller.signal);
    expect(o).toMatchObject({ status: "interrupted", cause: "forced_stop", phase: "seq", sentRequests: 1, collectedResponses: 0 });
  });
  it("an HttpPort that is aborted while the signal is not aborted is a transport failure, not a stop", async () => {
    const env = await ready();
    env.http.on((r) => r.path === "/reset", new HttpAbortedError());
    expect(notExecuted(await run(env))).toMatchObject({ reason: "reset_failed", detail: "transport_error" });
  });
});

describe("the Run time limit: notAfterMs limits the deadline of the Experiment (R11.12; decided 2026-11-12)", () => {
  const limits = { requestTimeoutMs: 1000, experimentTimeoutMs: 60_000 };

  it("a Run limit that has passed starts nothing: timeout_before_requests with the detail run_time_limit", async () => {
    const env = await ready({ limits });
    for (const notAfterMs of [env.time.t, env.time.t - 5]) {
      const o = notExecuted(await env.runner.execute(experiment(), "dec-1", stop(), { notAfterMs }));
      expect(o).toMatchObject({ reason: "timeout_before_requests", detail: "run_time_limit" });
    }
    expect(env.http.seen).toEqual(["GET /health"]);
  });

  it("a Run limit that is nearer than the limit of the Experiment caps the time of each request and follows R9.15 literally, with the detail run_time_limit", async () => {
    // During the reset: reset_failed.
    const reset = await ready({ limits });
    reset.http.cost = (r) => (r.path === "/reset" ? 5000 : 0);
    const r1 = notExecuted(await reset.runner.execute(experiment(), "dec-1", stop(), { notAfterMs: reset.time.t + 800 }));
    expect(r1).toMatchObject({ reason: "reset_failed", detail: "run_time_limit" });
    expect(reset.http.calls[1]?.timeoutMs).toBe(800);

    // During the preparation: preparation_failed.
    const prep = await ready({ limits });
    prep.http.cost = (r) => (r.path === "/orders" ? 5000 : 0);
    const r2 = notExecuted(await prep.runner.execute(fullExperiment(), "dec-1", stop(), { notAfterMs: prep.time.t + 700 }));
    expect(r2).toMatchObject({ reason: "preparation_failed", step: 0, detail: "run_time_limit" });

    // During the request sequence: timed_out with the responses so far.
    const seq = await ready({ limits });
    seq.http.cost = (r, n) => (n === 4 ? 5000 : 0);
    const e = experiment({ requests: [{ method: "GET", path: "/orders" }, { method: "GET", path: "/orders" }] });
    const o = await seq.runner.execute(e, "dec-1", stop(), { notAfterMs: seq.time.t + 900 });
    expect(o.status).toBe("timed_out");
    expect(o.status === "timed_out" && o.observation.responses.length).toBe(1);
    expect(o.status === "timed_out" && o.detail).toBe("run_time_limit");
  });

  it("a Run limit that is further away than the limit of the Experiment changes nothing", async () => {
    const env = await ready({ limits: { requestTimeoutMs: 1000, experimentTimeoutMs: 3000 } });
    env.http.cost = (r) => (r.path === "/reset" ? 1000 : 0);
    const o = await env.runner.execute(fullExperiment(), "dec-1", stop(), { notAfterMs: env.time.t + 1_000_000 });
    expect(o.status).toBe("executed");
    expect(env.http.calls[2]?.timeoutMs).toBe(1000);
  });

  it("the lease check gets the capped deadline, so that a hold does not run past the Run limit", async () => {
    const env = await ready({ limits });
    const at = env.time.t + 400;
    await env.runner.execute(experiment(), "dec-1", stop(), { notAfterMs: at });
    expect(env.lease.options[env.lease.options.length - 1]?.deadlineAtMs).toBe(at);
  });

  it("a notAfterMs that is not a finite number is an internal error: fatal", async () => {
    for (const notAfterMs of [Number.NaN, Number.POSITIVE_INFINITY, "soon" as unknown as number]) {
      const env = await ready();
      const o = notExecuted(await env.runner.execute(experiment(), "dec-1", stop(), { notAfterMs }));
      expect(o).toMatchObject({ reason: "runner_internal_error", fatal: true });
      expect(env.http.seen).toEqual(["GET /health"]);
    }
  });
});
describe("fatal errors (OD-18, decided 2026-11-12)", () => {
  it("an internal error before any request of the sequence is runner_internal_error with the fatal flag, and the Run executes nothing more", async () => {
    const env = await ready({ isAccepted: () => { throw new Error("store down"); } });
    const o = notExecuted(await run(env));
    expect(o).toMatchObject({ reason: "runner_internal_error", fatal: true });
    expect(o.observation).toMatchObject({ outcome: "not_executed", notExecuted: { reason: "runner_internal_error" } });
    expect(o.observation).not.toHaveProperty("fatal"); // control information of the Runner, not part of the Observation
    expect(env.http.seen).toEqual(["GET /health"]);
    const later = await run(env, experiment({ experimentId: "exp-2" }), "dec-2");
    expect(later).toMatchObject({ status: "interrupted", cause: "fatal_error", fatal: true, phase: "not_started", sentRequests: 0 });
    expect(env.http.seen).toEqual(["GET /health"]);
  });

  it("an internal error after a request of the sequence was sent is interrupted, not timed_out: no Observation is invented", async () => {
    const env = await ready();
    const original = env.deps.clock.nowMs.bind(env.deps.clock);
    let broken = false;
    env.http.on((r, n) => r.path === "/orders" && n === 3, async () => { broken = true; return json(200, { success: true }); }); // the first request of the sequence
    (env.deps.clock as { nowMs: () => number }).nowMs = () => { if (broken) throw new Error("clock broke"); return original(); };
    const e = experiment({ requests: [{ method: "GET", path: "/orders" }, { method: "GET", path: "/orders" }] });
    const o = await run(env, e);
    expect(o).toMatchObject({ status: "interrupted", cause: "fatal_error", fatal: true, phase: "seq", sentRequests: 1, collectedResponses: 1 });
    expect(o).not.toHaveProperty("observation");
  });

  it("never throws, whatever the ports do", async () => {
    const cases: [string, (env: Env) => void][] = [
      ["a TypeError from the HttpPort", (e) => e.http.on((r) => r.path === "/orders", new TypeError("x"))],
      ["a rejection that is not an Error", (e) => e.http.on((r) => r.path === "/orders", (() => Promise.reject("x")) as never)],
      ["an Evidence_Store lookup that does not exist", (e) => { (e.deps as { isAccepted: unknown }).isAccepted = undefined; }],
    ];
    for (const [name, arrange] of cases) {
      const env = makeEnv();
      await env.runner.health();
      arrange(env);
      await expect(run(env), name).resolves.toBeDefined();
    }
  });
});
describe("the runner reaches nothing else", () => {
  it("imports no Ground_Truth, evaluation, or test location, and only node:crypto, node:fs (lease reading), node:path, and node:http", () => {
    const graph = scan(resolve(SRC, "runner/index.ts"));
    expect(violations(graph, SRC, ["node:crypto", "node:fs", "node:path", "node:http"])).toEqual([]);
  });
});