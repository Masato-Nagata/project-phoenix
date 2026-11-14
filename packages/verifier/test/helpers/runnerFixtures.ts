// Fixtures for the Experiment_Runner tests (tasks 2.15 and 2.17): a fake HttpPort and a fake LeasePort. No real Legacy_App is reached.
import {
  DEFAULT_ADDRESS_POLICY, DEFAULT_RUNNER_LIMITS, HttpTimeoutError, createRunner,
  type Experiment, type ExperimentRunner, type HttpPort, type HttpRequest, type HttpResponse, type LeaseCheckOptions, type LeasePort, type LeaseState, type RunnerDeps,
} from "../../src/index.js";
import { FakeTime } from "./leaseFixtures.js";
import { loadedPolicyConfig } from "./policyFixtures.js";
import { loadedTable } from "./prepFixtures.js";

export const json = (status: number, body: unknown): HttpResponse => ({ status, body: JSON.stringify(body) });
export const CREATED_AT = "2000-01-01T00:00:00+00:00";

export interface Call {
  req: HttpRequest;
  timeoutMs: number;
  at: number;
  /** The result of the last lease check at the moment of the call. A send while this is false breaks the gate. */
  leaseValid: boolean;
}

export class FakeLease implements LeasePort {
  calls = 0;
  last: LeaseState = { valid: true };
  options: LeaseCheckOptions[] = [];
  script: (n: number, options: LeaseCheckOptions) => LeaseState | Promise<LeaseState> = () => ({ valid: true });
  check(options: LeaseCheckOptions = {}): LeaseState | Promise<LeaseState> {
    this.calls += 1;
    this.options.push(options);
    const r = this.script(this.calls, options);
    if (r instanceof Promise) return r.then((s) => (this.last = s));
    this.last = r;
    return r;
  }
  /** Valid until the n-th check, invalid from then on. */
  invalidFrom(n: number, state: LeaseState = { valid: false, reason: "revoked" }): void {
    this.script = (k) => (k >= n ? state : { valid: true });
  }
}

type Reply = HttpResponse | Error | ((signal: AbortSignal) => Promise<HttpResponse>);

export class FakeHttp implements HttpPort {
  calls: Call[] = [];
  sentWhileInvalid = 0;
  /** Time the fake spends on a call; a call longer than its time limit takes the limit and times out, as the adapter does. */
  cost: (req: HttpRequest, n: number) => number = () => 0;
  overrides: { match: (req: HttpRequest, n: number) => boolean; reply: Reply }[] = [];
  private orderId = 0;
  readonly time: FakeTime;
  readonly lease: FakeLease;
  constructor(time: FakeTime, lease: FakeLease) {
    this.time = time;
    this.lease = lease;
  }

  on(match: (req: HttpRequest, n: number) => boolean, reply: Reply): void {
    this.overrides.push({ match, reply });
  }
  /** The calls as `METHOD path`. */
  get seen(): string[] {
    return this.calls.map((c) => `${c.req.method} ${c.req.path}`);
  }

  async send(req: HttpRequest, timeoutMs: number, signal: AbortSignal): Promise<HttpResponse> {
    this.calls.push({ req, timeoutMs, at: this.time.t, leaseValid: this.lease.last.valid });
    if (!this.lease.last.valid) this.sentWhileInvalid += 1;
    const n = this.calls.length;
    const cost = this.cost(req, n);
    if (cost > timeoutMs) {
      this.time.t += timeoutMs;
      throw new HttpTimeoutError();
    }
    this.time.t += cost;
    for (const o of this.overrides) {
      if (!o.match(req, n)) continue;
      if (o.reply instanceof Error) throw o.reply;
      if (typeof o.reply === "function") return o.reply(signal);
      return o.reply;
    }
    return this.reply(req);
  }

  private reply(req: HttpRequest): HttpResponse {
    const { method, path } = req;
    if (method === "GET" && path === "/health") return json(200, { success: true, data: { app: "ok", db: "ok" } });
    if (method === "POST" && path === "/reset") return json(200, { success: true, data: {} });
    if (method === "POST" && path === "/orders") {
      this.orderId += 1;
      return json(201, { success: true, data: { order_id: this.orderId, created_at: CREATED_AT } });
    }
    if (method === "POST" && /^\/orders\/\d+\/cancel$/.test(path)) return json(200, { success: true, data: {} });
    if (method === "POST" && /^\/test\/orders\/\d+\/ship$/.test(path)) return json(200, { success: true, data: {} });
    const one = /^\/orders\/(\d+)$/.exec(path);
    if (method === "GET" && one !== null) return json(200, { success: true, data: { id: Number(one[1]), created_at: CREATED_AT } });
    if (method === "GET" && path === "/orders") return json(200, { success: true, data: [{ id: 1, created_at: CREATED_AT }] });
    return json(404, { success: false, error: "Not Found" });
  }
}

export interface Parts {
  time: FakeTime;
  lease: FakeLease;
  http: FakeHttp;
  accepted: Set<string>;
  deps: RunnerDeps;
}
export interface Env extends Parts {
  runner: ExperimentRunner;
}

/** The dependencies without the runner, so that a test can see that a refused start sends nothing. */
export function makeParts(over: Partial<RunnerDeps> = {}, accept: string[] = ["exp-1", "exp-2"]): Parts {
  const time = new FakeTime();
  const lease = new FakeLease();
  const http = new FakeHttp(time, lease);
  const accepted = new Set(accept);
  const deps: RunnerDeps = {
    http,
    lease,
    prepTable: loadedTable(),
    policy: loadedPolicyConfig(),
    mask: { paths: ["data.created_at"] },
    baseAddress: "http://127.0.0.1:8056",
    addressPolicy: DEFAULT_ADDRESS_POLICY,
    limits: DEFAULT_RUNNER_LIMITS,
    clock: time,
    isAccepted: (id) => (accepted.has(id) ? { accepted: true } : { accepted: false, code: "record_missing" }),
    ...over,
  };
  return { time, lease, http, accepted, deps };
}

export function makeEnv(over: Partial<RunnerDeps> = {}, accept: string[] = ["exp-1", "exp-2"]): Env {
  const parts = makeParts(over, accept);
  return { ...parts, runner: createRunner(parts.deps) };
}

export function experiment(over: Partial<Experiment> = {}): Experiment {
  return { experimentId: "exp-1", requests: [{ method: "GET", path: "/orders" }], prediction: {}, ...over };
}

/** One prepared order, two requests that read it, and one state check. */
export function fullExperiment(): Experiment {
  return experiment({
    preparation: [{ kind: "order_exists", bind: "o1", params: { customer_id: 1, product_1: 1, quantity_1: 2 } }],
    requests: [
      { method: "GET", path: "/orders/{id}", pathParams: { id: { $bind: "o1" } } },
      { method: "GET", path: "/orders" },
    ],
    stateChecks: [{ method: "GET", path: "/orders" }],
  });
}

export const stop = (): AbortSignal => new AbortController().signal;