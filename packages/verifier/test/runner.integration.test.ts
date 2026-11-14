// Integration of the Runner with the acceptance check, the policy, the preparation table, a fake Evidence_Store, a fake lease, and a fake
// HTTP port (task 2.17 follow-up; OD-17, OD-18; R9.2, R9.3, R9.7, R11.12, R11.15). No real Legacy_App is reached; no record is written to disk.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  RunnerStartRefused, createAcceptanceCheck, evaluateForRecord, executionIdentity, loadPolicyConfig, loadPreparationTable,
  type AcceptanceRefusal, type Experiment, type PolicyConfig, type RecordView, type RunnerDeps,
} from "../src/index.js";
import { rawPolicyConfig } from "./helpers/policyFixtures.js";
import { rawTable } from "./helpers/prepFixtures.js";
import { experiment, fullExperiment, json, makeEnv, stop, type Env } from "./helpers/runnerFixtures.js";

const SEED = 340037;

class Store {
  readonly records: RecordView[] = [];
  append(kind: string, payload: unknown): string {
    const id = `rec-${String(this.records.length + 1).padStart(6, "0")}`;
    this.records.push({ id, kind, payload });
    return id;
  }
}

function setup(over: Partial<RunnerDeps> = {}): { store: Store; env: Env } {
  const store = new Store();
  const env = makeEnv({ isAccepted: createAcceptanceCheck(() => store.records), ...over });
  return { store, env };
}
async function readyEnv(over: Partial<RunnerDeps> = {}) {
  const s = setup(over);
  expect(await s.env.runner.health()).toEqual({ ok: true });
  return s;
}
/** What the Loop_Orchestrator does: decide, and append the policy_decision record. */
const decideAndRecord = (store: Store, env: Env, e: Experiment): string => store.append("policy_decision", evaluateForRecord(e, env.deps.policy));
const exec = (env: Env, e: Experiment, record: string) => env.runner.execute(e, record, stop());
const notExecuted = (o: Awaited<ReturnType<typeof exec>>) => {
  if (o.status !== "not_executed") throw new Error(`expected not_executed, got ${o.status}`);
  return o;
};

function configWith(edit: (policy: Record<string, any>, table: Record<string, any>) => void): { policy: PolicyConfig } {
  const p = rawPolicyConfig();
  const t = rawTable() as Record<string, any>;
  edit(p, t);
  const table = loadPreparationTable(t);
  if (!table.ok) throw new Error(table.error.join("; "));
  const policy = loadPolicyConfig(p, table.value);
  if (!policy.ok) throw new Error(policy.error.join("; "));
  return { policy: policy.value };
}

describe("a recorded decision allows exactly what it was made about", () => {
  it("executes an Experiment whose decision is recorded, and the same content in another key order", async () => {
    const { store, env } = await readyEnv();
    const e = fullExperiment();
    const record = decideAndRecord(store, env, e);
    const reordered = { stateChecks: e.stateChecks, requests: e.requests, prediction: e.prediction, preparation: e.preparation, experimentId: e.experimentId } as unknown as Experiment;
    expect((await exec(env, reordered, record)).status).toBe("executed");
  });

  it("refuses a decision record that is missing, belongs to another Experiment, or is not a decision", async () => {
    const { store, env } = await readyEnv();
    const e = experiment();
    const other = decideAndRecord(store, env, experiment({ experimentId: "exp-2" }));
    const notDecision = store.append("observation", { experimentId: "exp-1" });
    for (const record of ["rec-000099", other, notDecision, ""]) {
      expect(notExecuted(await exec(env, e, record)).reason).toBe("policy_not_accepted");
    }
    expect(env.http.seen).toEqual(["GET /health"]);
  });

  it("refuses an Experiment whose recorded decision is a reject, and one that has both a reject and an accept", async () => {
    const { store, env } = await readyEnv();
    const bad = experiment({ requests: [{ method: "POST", path: "/reset" }] });
    const rejected = decideAndRecord(store, env, bad);
    expect(notExecuted(await exec(env, bad, rejected)).detail).toBe("not_accepted:reject_exists");

    const e = experiment({ experimentId: "exp-2" });
    const accept = decideAndRecord(store, env, e);
    store.append("policy_decision", { ...evaluateForRecord(bad, env.deps.policy), experimentId: "exp-2" });
    expect(notExecuted(await exec(env, e, accept)).detail).toBe("not_accepted:reject_exists");
    expect(env.http.seen).toEqual(["GET /health"]);
  });

  it("refuses an Experiment that has two accept decisions", async () => {
    const { store, env } = await readyEnv();
    const e = experiment();
    const first = decideAndRecord(store, env, e);
    const second = decideAndRecord(store, env, e);
    for (const record of [first, second]) expect(notExecuted(await exec(env, e, record)).detail).toBe("not_accepted:decision_not_unique");
    expect(env.http.seen).toEqual(["GET /health"]);
  });

  it("refuses an Experiment whose content changed after the decision", async () => {
    const { store, env } = await readyEnv();
    const e = fullExperiment();
    const record = decideAndRecord(store, env, e);
    const changes: Experiment[] = [
      { ...e, stateChecks: [] },
      { ...e, requests: [...e.requests, { method: "GET", path: "/orders" }] },
      { ...e, preparation: [{ kind: "order_exists", bind: "o1", params: { customer_id: 1, product_1: 1, quantity_1: 3 } }] },
      { ...e, preparation: [{ kind: "order_exists", bind: "o1", params: { customer_id: 1, product_1: 1, quantity_1: 2, product_2: 1, quantity_2: 1 } }] },
      { ...e, prediction: { status: 404 } },
      { ...e, requests: [{ method: "GET", path: "/orders/{id}", pathParams: { id: 5 } }, e.requests[1] as never] },
    ];
    for (const changed of changes) {
      const o = notExecuted(await exec(env, changed, record));
      expect(o.detail).toBe("not_accepted:experiment_content_changed");
    }
    expect(env.http.seen).toEqual(["GET /health"]);
  });

  it("refuses when the policy configuration differs from the one of the decision", async () => {
    const first = setup();
    const e = experiment();
    const record = decideAndRecord(first.store, first.env, e);
    const { policy } = configWith((p) => { p["limits"].requests = 9; });
    const second = makeEnv({ policy, isAccepted: createAcceptanceCheck(() => first.store.records) });
    await second.runner.health();
    expect(notExecuted(await exec(second, e, record)).detail).toBe("not_accepted:policy_config_changed");
    expect(second.http.seen).toEqual(["GET /health"]);
  });

  it("refuses when the preparation table differs from the one of the decision", async () => {
    const first = setup();
    const e = experiment();
    const record = decideAndRecord(first.store, first.env, e);
    const { policy } = configWith((_p, t) => { t["steps"][0]["numbered"]["max"] = 4; });
    const second = makeEnv({ policy, prepTable: policy.preparationTable, isAccepted: createAcceptanceCheck(() => first.store.records) });
    await second.runner.health();
    expect(notExecuted(await exec(second, e, record)).detail).toBe("not_accepted:preparation_table_changed");
    expect(second.http.seen).toEqual(["GET /health"]);
  });

  it("the Runner does not start with a preparation table other than the one of the policy configuration", () => {
    const { policy } = configWith((_p, t) => { t["steps"][0]["numbered"]["max"] = 4; });
    let refused: RunnerStartRefused | undefined;
    try {
      makeEnv({ policy });
    } catch (error) {
      refused = error as RunnerStartRefused;
    }
    expect(refused).toBeInstanceOf(RunnerStartRefused);
    expect(refused?.refusals.map((r) => r.code)).toEqual(["preparation_table_mismatch"]);
  });

  it("the policy decides again before the execution: a forged accept record for an Experiment that the policy rejects sends nothing", async () => {
    const { store, env } = await readyEnv();
    const bad = experiment({ requests: [{ method: "GET", path: "/orders/" }] }); // not an allowlisted path (POL-003)
    expect(evaluateForRecord(bad, env.deps.policy).decision).toBe("reject");
    const forged = store.append("policy_decision", { experimentId: "exp-1", decision: "accept", ruleIds: [], ...executionIdentity(bad, env.deps.policy, env.deps.prepTable) });
    const o = notExecuted(await exec(env, bad, forged));
    expect(o.reason).toBe("policy_not_accepted");
    expect(o.detail).toBe("redecision_rejected:POL-003");
    expect(env.http.seen).toEqual(["GET /health"]);
  });
});

describe("a Run of several Experiments with a forced stop or a fatal error (OD-18)", () => {
  it("keeps the Observation of the Experiment that finished, interrupts the one that was stopped without inventing an Observation, and executes no later one", async () => {
    const { store, env } = await readyEnv();
    const e1 = fullExperiment();
    const e2 = experiment({ experimentId: "exp-2", requests: [{ method: "GET", path: "/orders" }, { method: "GET", path: "/orders" }] });
    const e3 = experiment({ experimentId: "exp-3" });
    const records = [e1, e2, e3].map((e) => decideAndRecord(store, env, e));
    const stopSignal = new AbortController();

    const o1 = await env.runner.execute(e1, records[0] as string, stopSignal.signal);
    expect(o1.status).toBe("executed");
    const kept = JSON.stringify(o1);

    // The stop comes while the first request of e2 is answered.
    const startCalls = env.http.calls.length;
    env.http.on((_r, n) => n === startCalls + 2, async () => { stopSignal.abort(); return json(200, { success: true, data: [] }); }); // calls: reset, first request
    const o2 = await env.runner.execute(e2, records[1] as string, stopSignal.signal);
    expect(o2).toMatchObject({ status: "interrupted", cause: "forced_stop", experimentId: "exp-2", phase: "seq", sentRequests: 1, collectedResponses: 1 });
    expect(o2).not.toHaveProperty("observation");

    const callsAfterStop = env.http.calls.length;
    const o3 = await env.runner.execute(e3, records[2] as string, new AbortController().signal);
    expect(o3).toMatchObject({ status: "interrupted", cause: "forced_stop", experimentId: "exp-3", phase: "not_started", sentRequests: 0 });
    expect(env.http.calls.length).toBe(callsAfterStop);
    expect(JSON.stringify(o1)).toBe(kept); // the Observation that was finished is untouched
  });

  it("a fatal error ends the Run: the Experiment that hit it is not executed, and no later one is", async () => {
    let broken = false;
    const { store, env } = await readyEnv({
      isAccepted: (id, rec, identity) => {
        if (broken) throw new Error("store failed");
        return createAcceptanceCheck(() => store.records)(id, rec, identity);
      },
    });
    const e1 = experiment();
    const e2 = experiment({ experimentId: "exp-2" });
    const r1 = decideAndRecord(store, env, e1);
    const r2 = decideAndRecord(store, env, e2);
    expect((await exec(env, e1, r1)).status).toBe("executed");
    broken = true;
    expect(await exec(env, e2, r2)).toMatchObject({ status: "not_executed", reason: "runner_internal_error", fatal: true });
    broken = false;
    const calls = env.http.calls.length;
    expect(await exec(env, e1, r1)).toMatchObject({ status: "interrupted", cause: "fatal_error", fatal: true, phase: "not_started" });
    expect(env.http.calls.length).toBe(calls);
  });
});

describe(`nothing is sent unless a decision about exactly this content is recorded (seed ${SEED})`, () => {
  /** Every leaf of a JSON value, as a path. */
  function leaves(v: unknown, path: (string | number)[] = []): (string | number)[][] {
    if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, [...path, i]));
    if (typeof v === "object" && v !== null) return Object.entries(v).flatMap(([k, x]) => leaves(x, [...path, k]));
    return [path];
  }

  it("any change of any leaf of a recorded Experiment is refused, and only the health check was sent", async () => {
    const base = fullExperiment();
    const paths = leaves(base).filter((p) => p.length > 0);
    await fc.assert(
      fc.asyncProperty(fc.nat(), fc.constantFrom("mutated", 0, -1, true, null), async (pick, value) => {
        const { store, env } = await readyEnv();
        const record = decideAndRecord(store, env, base);
        const changed = structuredClone(base) as unknown as Record<string, any>;
        const path = paths[pick % paths.length] as (string | number)[];
        let cur: any = changed;
        for (const k of path.slice(0, -1)) cur = cur[k];
        const last = path[path.length - 1] as string | number;
        if (cur[last] === value) return; // not a change
        cur[last] = value;
        const o = await exec(env, changed as unknown as Experiment, record);
        expect(o.status).toBe("not_executed");
        // A changed experimentId is a record of another Experiment; any other change is a change of the content.
        expect(o.status === "not_executed" && o.detail).toMatch(/^not_accepted:(experiment_content_changed|experiment_id_mismatch)$/);
        expect(env.http.seen).toEqual(["GET /health"]);
      }),
      { seed: SEED, numRuns: 150 },
    );
  });

  it("every refusal of the acceptance check, whatever its code, sends nothing", async () => {
    const codes: AcceptanceRefusal[] = [
      "record_missing", "record_not_policy_decision", "payload_malformed", "experiment_id_mismatch", "reject_exists", "decision_not_unique",
      "decision_not_accept", "experiment_content_changed", "policy_config_changed", "preparation_table_changed",
    ];
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...codes), async (code) => {
        const env = makeEnv({ isAccepted: () => ({ accepted: false, code }) });
        await env.runner.health();
        const o = notExecuted(await exec(env, fullExperiment(), "rec-000001"));
        expect(o.detail).toBe(`not_accepted:${code}`);
        expect(env.http.seen).toEqual(["GET /health"]);
      }),
      { seed: SEED, numRuns: 30 },
    );
  });
});