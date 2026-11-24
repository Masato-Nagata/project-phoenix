// The Run-level start-state measurement of the Experiment_Runner (`measureStartState`; Run_Manifest `legacyStartState.identity`).
// A fake HttpPort, a fake lease and a fake monotonic clock only; no Legacy_App is reached. Every product, value and canary is SYNTHETIC.
// **Validates: Requirements 22.1, 22.3, 9.5, 9.8, 9.16, 24.9**
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MASK_TOKEN, START_STATE_TIMEOUT_MS, canonicalIdentityText, type HttpRequest, type HttpResponse } from "../src/index.js";
import { json, makeEnv, experiment, stop, type Env } from "./helpers/runnerFixtures.js";

const CANARY = "canary-secret-value-91x";
const MASK = { paths: ["data[*].stock_quantity"] };
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const isProducts = (r: HttpRequest): boolean => r.method === "GET" && r.path === "/products";
const isReset = (r: HttpRequest): boolean => r.method === "POST" && r.path === "/reset";
const products = (data: unknown, extra: Record<string, unknown> = {}): HttpResponse => json(200, { success: true, data, ...extra });
const SAMPLE = [
  { id: 1, name: "Widget A", unit_price: 100, stock_quantity: 7 },
  { id: 2, name: "Widget B", unit_price: 250, stock_quantity: 3 },
];

/** A runner whose fake answers `GET /products` with `reply`; the health check is already passed unless `healthy` is false. */
async function envWith(reply: HttpResponse | Error | ((signal: AbortSignal) => Promise<HttpResponse>), healthy = true): Promise<Env> {
  const env = makeEnv({ mask: MASK });
  env.http.on((r) => isProducts(r), reply);
  if (healthy) {
    const h = await env.runner.health();
    if (!h.ok) throw new Error("test setup: health");
  }
  return env;
}
const identityOf = async (reply: HttpResponse): Promise<string> => {
  const env = await envWith(reply);
  const r = await env.runner.measureStartState(stop());
  if (!r.ok) throw new Error(`expected an identity, got ${r.code}`);
  return r.identity;
};
const codeOf = (r: { ok: boolean; code?: string }): string | undefined => (r.ok ? undefined : r.code);

describe("measureStartState: the identity", () => {
  it("is computed from a confirmed reset and one GET /products, as 64 lowercase hex characters without a prefix", async () => {
    const env = await envWith(products(SAMPLE));
    const r = await env.runner.measureStartState(stop());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.identity).toMatch(/^[0-9a-f]{64}$/);
    expect(env.http.seen).toEqual(["GET /health", "POST /reset", "GET /products"]);
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("equals the SHA-256 of the canonical JSON of the masked { status, bodyKind, body }", async () => {
    const masked = { success: true, data: SAMPLE.map((p) => ({ ...p, stock_quantity: MASK_TOKEN })) };
    const expected = sha(canonicalIdentityText({ status: 200, bodyKind: "json", body: masked }));
    expect(await identityOf(products(SAMPLE))).toBe(expected);
  });

  it("is the same for the same response, and for the same response with another key order", async () => {
    const a = await identityOf(products(SAMPLE));
    const b = await identityOf(products(SAMPLE));
    const reordered: HttpResponse = {
      status: 200,
      body: JSON.stringify({ data: SAMPLE.map((p) => ({ stock_quantity: p.stock_quantity, unit_price: p.unit_price, name: p.name, id: p.id })), success: true }),
    };
    expect(b).toBe(a);
    expect(await identityOf(reordered)).toBe(a);
  });

  it("does not depend on a masked value, and changes with any value that is not masked", async () => {
    const base = await identityOf(products(SAMPLE));
    const otherStock = SAMPLE.map((p) => ({ ...p, stock_quantity: p.stock_quantity + 100 }));
    expect(await identityOf(products(otherStock))).toBe(base);
    const otherPrice = SAMPLE.map((p, i) => (i === 1 ? { ...p, unit_price: 251 } : p));
    expect(await identityOf(products(otherPrice))).not.toBe(base);
    expect(await identityOf(products([...SAMPLE].reverse()))).not.toBe(base);
    expect(await identityOf(products(SAMPLE, { extra: 1 }))).not.toBe(base);
  });

  it("accepts an empty product list, and fixes no product field layout", async () => {
    expect(await identityOf(products([]))).toMatch(/^[0-9a-f]{64}$/);
    expect(await identityOf(products([{ anything: "goes" }, 5, null]))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is measurable without any Experiment being executed, and an Experiment still runs normally afterwards", async () => {
    const env = await envWith(products(SAMPLE));
    expect((await env.runner.measureStartState(stop())).ok).toBe(true);
    const out = await env.runner.execute(experiment(), "rec-000001", stop());
    expect(out.status).toBe("executed");
    // the Experiment keeps its own reset (unchanged behavior)
    expect(env.http.seen).toEqual(["GET /health", "POST /reset", "GET /products", "POST /reset", "GET /orders"]);
  });
});

describe("measureStartState: the response contract (checked on the unmasked response)", () => {
  it("refuses a status other than 200", async () => {
    for (const status of [201, 204, 400, 404, 500, 503]) {
      const env = await envWith({ status, body: JSON.stringify({ success: true, data: [] }) });
      expect(codeOf(await env.runner.measureStartState(stop())), String(status)).toBe("response_invalid");
    }
  });

  it("refuses a body that is not JSON, empty, or not an object", async () => {
    for (const body of ["", "not json", "<html></html>", "[]", "null", "1", '"x"']) {
      const env = await envWith({ status: 200, body });
      expect(codeOf(await env.runner.measureStartState(stop())), body).toBe("response_invalid");
    }
  });

  it("refuses success that is not exactly true", async () => {
    for (const success of [false, "true", 1, null, undefined]) {
      const body = success === undefined ? { data: [] } : { success, data: [] };
      const env = await envWith(json(200, body));
      expect(codeOf(await env.runner.measureStartState(stop())), String(success)).toBe("response_invalid");
    }
  });

  it("refuses data that is not an array", async () => {
    for (const data of [{}, { items: [] }, "[]", 0, null, undefined]) {
      const body = data === undefined ? { success: true } : { success: true, data };
      const env = await envWith(json(200, body));
      expect(codeOf(await env.runner.measureStartState(stop())), JSON.stringify(data)).toBe("response_invalid");
    }
  });

  it("refuses a body too deep to mask (the masked form would not be JSON)", async () => {
    let deep: unknown = 1;
    for (let i = 0; i < 80; i += 1) deep = [deep];
    const env = await envWith(json(200, { success: true, data: [deep] }));
    expect(codeOf(await env.runner.measureStartState(stop()))).toBe("response_invalid");
  });
});

describe("measureStartState: order, lease and gates", () => {
  it("never sends the GET when the reset fails (status, body, or transport)", async () => {
    const cases: Array<HttpResponse | Error> = [json(500, { success: false, error: "Reset failed" }), json(200, { success: false }), { status: 200, body: "x" }, new Error("boom")];
    for (const reply of cases) {
      const env = makeEnv({ mask: MASK });
      env.http.on((r) => isReset(r), reply);
      await env.runner.health();
      const r = await env.runner.measureStartState(stop());
      expect(r.ok).toBe(false);
      expect(codeOf(r)).toMatch(/^(reset_failed|transport_error)$/);
      expect(env.http.seen.filter((s) => s === "GET /products")).toEqual([]);
    }
  });

  it("sends nothing while the lease is invalid, and names the closed lease reason", async () => {
    const env = makeEnv({ mask: MASK });
    await env.runner.health();
    const before = env.http.calls.length;
    env.lease.invalidFrom(env.lease.calls + 1, { valid: false, reason: "heartbeat_stale" });
    const r = await env.runner.measureStartState(stop());
    expect(r).toEqual({ ok: false, code: "lease_unavailable", leaseReason: "heartbeat_stale" });
    expect(env.http.calls.length).toBe(before);
    expect(env.http.sentWhileInvalid).toBe(0);
  });

  it("stops before the GET when the lease becomes invalid after the reset", async () => {
    const env = makeEnv({ mask: MASK });
    await env.runner.health();
    env.lease.invalidFrom(env.lease.calls + 2, { valid: false, reason: "revoked" });
    const r = await env.runner.measureStartState(stop());
    expect(codeOf(r)).toBe("lease_unavailable");
    expect(env.http.seen).toEqual(["GET /health", "POST /reset"]);
    expect(env.http.sentWhileInvalid).toBe(0);
  });

  it("never sends the GET before the reset, and checks the lease before each of the two requests", async () => {
    const env = await envWith(products(SAMPLE));
    const leaseBefore = env.lease.calls;
    await env.runner.measureStartState(stop());
    const i = env.http.seen.indexOf("POST /reset");
    const j = env.http.seen.indexOf("GET /products");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(j).toBeGreaterThan(i);
    expect(env.lease.calls - leaseBefore).toBeGreaterThanOrEqual(2);
  });

  it("is refused without sending before a passed health check", async () => {
    const env = await envWith(products(SAMPLE), false);
    expect(await env.runner.measureStartState(stop())).toEqual({ ok: false, code: "runner_not_healthy" });
    expect(env.http.calls).toEqual([]);
  });

  it("is refused without sending when the signal is already aborted, or the options are invalid", async () => {
    const env = await envWith(products(SAMPLE));
    const c = new AbortController();
    c.abort();
    expect(await env.runner.measureStartState(c.signal)).toEqual({ ok: false, code: "aborted" });
    const env2 = await envWith(products(SAMPLE));
    expect(await env2.runner.measureStartState(stop(), { notAfterMs: Number.NaN })).toEqual({ ok: false, code: "options_invalid" });
    expect(env.http.seen).toEqual(["GET /health"]);
    expect(env2.http.seen).toEqual(["GET /health"]);
  });
});

describe("measureStartState: once per Runner", () => {
  it("answers already_measured for a second call, and sends nothing for it", async () => {
    const env = await envWith(products(SAMPLE));
    expect((await env.runner.measureStartState(stop())).ok).toBe(true);
    const n = env.http.calls.length;
    expect(await env.runner.measureStartState(stop())).toEqual({ ok: false, code: "already_measured" });
    expect(env.http.calls.length).toBe(n);
  });

  it("refuses a concurrent call at once, without sending, while the first one runs", async () => {
    let release: (r: HttpResponse) => void = () => undefined;
    const env = await envWith(() => new Promise<HttpResponse>((resolve) => (release = resolve)));
    const first = env.runner.measureStartState(stop());
    const second = await env.runner.measureStartState(stop());
    expect(second).toEqual({ ok: false, code: "already_measured" });
    await new Promise((r) => setTimeout(r, 0));
    release(products(SAMPLE));
    expect((await first).ok).toBe(true);
    expect(env.http.seen.filter((s) => s === "GET /products")).toHaveLength(1);
    expect(env.http.seen.filter((s) => s === "POST /reset")).toHaveLength(1);
  });

  it("does not retry after a failed first measurement", async () => {
    const env = await envWith(json(500, { success: false }));
    expect(codeOf(await env.runner.measureStartState(stop()))).toBe("response_invalid");
    expect(await env.runner.measureStartState(stop())).toEqual({ ok: false, code: "already_measured" });
    expect(env.http.seen.filter((s) => s === "GET /products")).toHaveLength(1);
  });

  it("two Runners (two Runs) measure independently and share nothing", async () => {
    const a = await envWith(products(SAMPLE));
    const b = await envWith(products([]));
    const ra = await a.runner.measureStartState(stop());
    const rb = await b.runner.measureStartState(stop());
    expect(ra.ok && rb.ok && ra.identity !== rb.identity).toBe(true);
  });
});

describe("measureStartState: one 10-second budget for the whole measurement", () => {
  it("the constant is 10 000 ms", () => {
    expect(START_STATE_TIMEOUT_MS).toBe(10_000);
  });

  it("shares one budget between the reset and the GET: the GET gets only what is left", async () => {
    const env = await envWith(products(SAMPLE));
    env.http.cost = (req) => (isReset(req) ? 6_000 : 0);
    const r = await env.runner.measureStartState(stop());
    expect(r.ok).toBe(true);
    const get = env.http.calls.find((c) => isProducts(c.req));
    expect(get?.timeoutMs).toBe(START_STATE_TIMEOUT_MS - 6_000);
  });

  it("times out when the two requests together exceed 10 s, and sends nothing after the budget", async () => {
    const env = await envWith(products(SAMPLE));
    env.http.cost = (req) => (isReset(req) ? 6_000 : isProducts(req) ? 5_000 : 0);
    const r = await env.runner.measureStartState(stop());
    expect(codeOf(r)).toBe("timeout");
    expect(env.http.seen.slice(-2)).toEqual(["POST /reset", "GET /products"]);
  });

  it("sends no GET when the reset itself uses up the budget", async () => {
    const env = await envWith(products(SAMPLE));
    env.http.cost = (req) => (isReset(req) ? 10_000 : 0);
    const r = await env.runner.measureStartState(stop());
    expect(codeOf(r)).toBe("timeout");
    expect(env.http.seen.filter((s) => s === "GET /products")).toEqual([]);
  });

  it("gives no identity for a late response that arrives after the budget", async () => {
    // The late reply is the ONLY registration for GET /products (FakeHttp uses the first matching registration).
    let lateCalls = 0;
    let startedAt = -1;
    let answeredAt = -1;
    let holder: Env | undefined;
    const env = await envWith(async () => {
      lateCalls += 1;
      const e = holder as Env;
      // the adapter answers although the clock has passed the whole-measurement budget (a late answer)
      e.time.t = startedAt + START_STATE_TIMEOUT_MS + 1;
      answeredAt = e.time.t;
      return products(SAMPLE);
    });
    holder = env;
    startedAt = env.time.t;
    const r = await env.runner.measureStartState(stop());
    expect(lateCalls).toBe(1);
    expect(answeredAt).toBeGreaterThan(startedAt + START_STATE_TIMEOUT_MS);
    expect(r).toEqual({ ok: false, code: "timeout" });
    expect("identity" in r).toBe(false);
  });

  it("the Run time limit (notAfterMs) wins when it is earlier", async () => {
    const env = await envWith(products(SAMPLE));
    env.http.cost = (req) => (isReset(req) ? 3_000 : 0);
    const r = await env.runner.measureStartState(stop(), { notAfterMs: env.time.t + 2_000 });
    expect(codeOf(r)).toBe("timeout");
    expect(env.http.seen.filter((s) => s === "GET /products")).toEqual([]);
  });

  it("a stop signal during the GET aborts it and gives no identity", async () => {
    const c = new AbortController();
    const env = await envWith(async (signal) => {
      c.abort();
      if (signal.aborted) throw new (await import("../src/index.js")).HttpAbortedError();
      return products(SAMPLE);
    });
    const r = await env.runner.measureStartState(c.signal);
    expect(codeOf(r)).toBe("aborted");
  });
});

describe("measureStartState: nothing secret in a result", () => {
  it("a failure carries a closed code (and a closed lease reason) only, never a body or a value", async () => {
    const replies: HttpResponse[] = [
      json(500, { success: false, error: CANARY }),
      json(200, { success: false, error: CANARY }),
      json(200, { success: true, data: CANARY }),
      { status: 200, body: CANARY },
    ];
    for (const reply of replies) {
      const env = await envWith(reply);
      const r = await env.runner.measureStartState(stop());
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(CANARY);
      expect(Object.keys(r).sort()).toEqual(["code", "ok"]);
    }
    const env = makeEnv({ mask: MASK });
    env.http.on((r) => isReset(r), json(500, { success: false, error: CANARY }));
    await env.runner.health();
    expect(JSON.stringify(await env.runner.measureStartState(stop()))).not.toContain(CANARY);
  });

  it("a masked secret value never reaches the identity input: it equals the identity of another masked value", async () => {
    const withSecret = SAMPLE.map((p) => ({ ...p, stock_quantity: CANARY }));
    expect(await identityOf(products(withSecret))).toBe(await identityOf(products(SAMPLE)));
  });
});
describe("measureStartState: the final guard after the masking, the canonical form and the hash", () => {
  // A test clock that follows the fake time, and from the moment the GET /products reply was produced counts its own readings. After the
  // reply the measurement reads the clock exactly twice: (A) the existing check right after the response, (B) the final guard before the
  // identity is issued. Nothing else reads the clock in between (the contract check, the masking, the canonical form and the hash do not).
  // The clock can make reading B late, or stop the Run while B is read, without any hook in the production code.
  type Plan = { lateAtB: boolean; abortAtB: boolean };
  async function guarded(plan: Plan) {
    const c = new AbortController();
    let armed = false;
    const afterReply: number[] = [];
    let deadlineAt = -1;
    let holder: Env | undefined;
    const clock = {
      nowMs(): number {
        const e = holder as Env;
        if (!armed) return e.time.t;
        afterReply.push(e.time.t);
        if (afterReply.length === 2) {
          if (plan.abortAtB) c.abort();
          if (plan.lateAtB) return deadlineAt + 1;
        }
        return e.time.t;
      },
    };
    const env = makeEnv({ mask: MASK, clock });
    holder = env;
    env.http.on((r) => isProducts(r), async () => {
      armed = true;
      return products(SAMPLE);
    });
    const h = await env.runner.health();
    if (!h.ok) throw new Error("test setup: health");
    deadlineAt = env.time.t + START_STATE_TIMEOUT_MS; // the measurement starts now; the fake time does not move by itself
    const r = await env.runner.measureStartState(c.signal);
    return { r, afterReply, deadlineAt, env };
  }

  it("control: without a late final reading the same measurement issues the identity (the clock is read twice after the reply)", async () => {
    const { r, afterReply, deadlineAt } = await guarded({ lateAtB: false, abortAtB: false });
    expect(r.ok).toBe(true);
    expect(afterReply).toHaveLength(2);
    expect(afterReply.every((t) => t < deadlineAt)).toBe(true);
  });

  it("a deadline that passes during the masking, canonical form and hash gives timeout and no identity (refused by the final guard)", async () => {
    const { r, afterReply, deadlineAt } = await guarded({ lateAtB: true, abortAtB: false });
    // reading A (right after the reply) was within the budget, so the existing check passed; reading B was the refusal
    expect(afterReply).toHaveLength(2);
    expect(afterReply[0]).toBeLessThan(deadlineAt);
    expect(r).toEqual({ ok: false, code: "timeout" });
    expect("identity" in r).toBe(false);
  });

  it("a stop that arrives at the final guard gives aborted and no identity", async () => {
    const { r, afterReply, env } = await guarded({ lateAtB: false, abortAtB: true });
    expect(afterReply).toHaveLength(2);
    expect(r).toEqual({ ok: false, code: "aborted" });
    expect("identity" in r).toBe(false);
    expect(env.http.seen.slice(-2)).toEqual(["POST /reset", "GET /products"]); // nothing was sent after the reply
  });

  it("when both hold at the final guard, timeout wins (the order of the existing checks)", async () => {
    const { r } = await guarded({ lateAtB: true, abortAtB: true });
    expect(r).toEqual({ ok: false, code: "timeout" });
  });

  it("the latch stays taken after a refusal by the final guard: no retry, nothing more is sent", async () => {
    const { env } = await guarded({ lateAtB: true, abortAtB: false });
    const n = env.http.calls.length;
    expect(await env.runner.measureStartState(stop())).toEqual({ ok: false, code: "already_measured" });
    expect(env.http.calls.length).toBe(n);
  });
});
