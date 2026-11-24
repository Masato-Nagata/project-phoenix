// Task 4.6 W6-A: the per-Run composition (`src/orchestrator/runComposition.ts`). Deterministic and offline. A REAL stage B ticket
// (support/orchestratorFakes.ts), SYNTHETIC lease facts, launcher facts (version 2, kind fixture) and runtime version facts answered from memory,
// and trap dependencies that count every use (the store factory, the Runner factory). No file, no network, no Legacy_App.
// **Validates: Requirements 12.13, 15.12, 22.3, 24.7, 24.9**
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { composeRun } from "../src/orchestrator/runComposition.js";
import { issueStartup, SYNTHETIC_RUN_ID, type Any } from "./support/orchestratorFakes.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const H = (c: string): string => c.repeat(64);
const CANARY = "canary-secret-value-w6a";
const NONCE = "synthetic-nonce-w6a";
const AUDIT_SHA = H("c"); // the audit configuration hash of the stage B ticket of orchestratorFakes
const IDENTITY = sha("synthetic-start-state-w6a");

const leaseText = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({ heartbeat_interval_ms: 1000, issued_by: "launcher", launcher_pid: 4242, launcher_start_ticks: "630000000000000000", nonce_sha256: sha(NONCE), run_id: SYNTHETIC_RUN_ID, stale_after_ms: 4000, ...o });
const launcherText = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({ schema_version: 2, issued_by: "launcher", run_id: SYNTHETIC_RUN_ID, runtime_image_id: `sha256:${H("e")}`, audit_config_sha256: AUDIT_SHA, audit_config_kind: "fixture", ...o });

interface Scene {
  files: { lease: string; launcher: string; npm: string };
  reads: string[];
  store: { opens: number };
  factory: { calls: number };
  runner: Any;
  input(over?: Record<string, unknown>): Any;
}

/** A Runner whose methods need `this` (the delegation must keep the binding). */
class ScriptedRunner {
  calls: string[] = [];
  measureAnswer: () => unknown = () => ({ ok: true, identity: IDENTITY });
  async health(this: ScriptedRunner) {
    this.calls.push("health");
    return { ok: true as const };
  }
  async execute(this: ScriptedRunner, _e: unknown, id: string, _s: AbortSignal, options?: unknown) {
    this.calls.push(`execute:${id}:${options === undefined ? "none" : JSON.stringify(options)}`);
    return { status: "executed", observation: { experimentId: "exp-1", outcome: "executed" } } as Any;
  }
  async measureStartState(this: ScriptedRunner, _signal: AbortSignal, options?: unknown) {
    this.calls.push(`measure:${JSON.stringify(options)}`);
    return this.measureAnswer() as Any;
  }
}

async function scene(): Promise<Scene> {
  const { approval } = await issueStartup();
  const files = { lease: leaseText(), launcher: launcherText(), npm: JSON.stringify({ name: "npm", version: "9.8.7" }) };
  const reads: string[] = [];
  const store = { opens: 0 };
  const factory = { calls: 0 };
  const runner = new ScriptedRunner();
  const ok = (t: string) => ({ kind: "ok" as const, text: t });
  const facts = {
    lease: { readLeaseJson: () => (reads.push("lease"), ok(files.lease)) },
    launcher: { readLauncherFacts: () => (reads.push("launcher"), ok(files.launcher)) },
    versions: {
      readNodeVersion: () => (reads.push("node"), "1.2.3"),
      readNpmPackageJson: () => (reads.push("npm"), ok(files.npm)),
      readDeclaredPackageJson: () => (reads.push("declared"), ok(JSON.stringify({ dependencies: { "a-lib": "1.0.0" } }))),
      readInstalledPackageJson: (n: string) => (reads.push(`installed:${n}`), ok(JSON.stringify({ name: n, version: "1.0.0" }))),
    },
  };
  const trap = (name: string): Any => ({ [name]: () => { throw new Error(`${name} must not be used by composeRun`); } });
  const deps = {
    isolation: trap("isolation"), fs: trap("fs"), runVolumeDir: "/run/out", clock: trap("clock"), wallClock: trap("wallClock"), timers: trap("timers"),
    provider: trap("provider"), audit: trap("audit"), responseGate: trap("responseGate"), policy: trap("policy"),
    runnerFactory: () => {
      factory.calls += 1;
      return runner;
    },
    comparator: trap("comparator"), analysisFs: trap("analysisFs"), repoRoot: "/repo", analysis: trap("analysis"),
    storeFactory: { open: async () => { store.opens += 1; throw new Error("the store must not be opened"); } },
  };
  return { files, reads, store, factory, runner, input: (over = {}) => ({ startup: approval, nonce: NONCE, facts, deps, ...over }) };
}
const codeOf = (r: Any): string | undefined => (r.ok ? undefined : r.error.code);
const FACTORY_INPUT: Any = { lease: {}, policy: {}, table: {}, mask: {}, baseAddress: "http://reverse-proxy:8080", limits: { requestTimeoutMs: 1, experimentTimeoutMs: 1 }, isAccepted: () => ({}) };
const signal = (): AbortSignal => new AbortController().signal;

describe("composeRun: the normal case", () => {
  it("gives the 17 keys of LoopDeps, with the real manifest port and the wrapped Runner factory; reads each fact once, opens nothing", async () => {
    const s = await scene();
    const r = composeRun(s.input());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.value).sort()).toEqual([
      "analysis", "analysisFs", "audit", "clock", "comparator", "fs", "isolation", "manifest", "policy", "provider", "repoRoot", "responseGate", "runVolumeDir", "runnerFactory",
      "storeFactory", "timers", "wallClock",
    ]);
    expect(typeof r.value.manifest.build).toBe("function");
    expect(r.value.runnerFactory).not.toBe(s.input().deps.runnerFactory);
    expect(s.reads).toEqual(["lease", "launcher", "node", "npm", "declared", "installed:a-lib"]);
    expect(s.store.opens).toBe(0);
    expect(s.factory.calls).toBe(0); // the Runner is made later, by startRun
  });

  it("every call makes its own cell and port: the port of one composition never sees the measurement of another", async () => {
    const s = await scene();
    const a = composeRun(s.input());
    const b = composeRun(s.input());
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(a.value.manifest).not.toBe(b.value.manifest);
    expect(a.value.runnerFactory).not.toBe(b.value.runnerFactory);
    // measure in A only: B's cell stays unwritten (the B port would refuse to seal: W5 start_state_unmeasured)
    const ra = a.value.runnerFactory(FACTORY_INPUT);
    expect(await ra.measureStartState(signal())).toEqual({ ok: true, identity: IDENTITY });
  });
});

describe("composeRun: refusals with closed codes, before any store or Legacy_App access", () => {
  it("a ticket that is not the brand of stage B (a copy or a look-alike) is refused, and no fact is read", async () => {
    const s = await scene();
    for (const startup of [undefined, null, {}, { ...s.input().startup }, JSON.parse(JSON.stringify(s.input().startup))]) {
      expect(codeOf(composeRun(s.input({ startup })))).toBe("startup_invalid");
    }
    expect(s.reads).toEqual([]);
    expect(s.store.opens).toBe(0);
  });

  it("a missing nonce, bad dependencies (a manifest given, a key missing), and bad fact ports are refused", async () => {
    const s = await scene();
    for (const nonce of [undefined, "", 1, "x".repeat(1025)]) expect(codeOf(composeRun(s.input({ nonce })))).toBe("nonce_invalid");
    expect(codeOf(composeRun(s.input({ deps: { ...s.input().deps, manifest: { build: () => ({}) } } })))).toBe("deps_invalid");
    const missing = { ...s.input().deps };
    delete missing.storeFactory;
    expect(codeOf(composeRun(s.input({ deps: missing })))).toBe("deps_invalid");
    expect(codeOf(composeRun(s.input({ deps: { ...s.input().deps, runnerFactory: 1 } })))).toBe("deps_invalid");
    expect(codeOf(composeRun(s.input({ facts: { lease: null } })))).toBe("input_invalid");
    expect(codeOf(composeRun(undefined as Any))).toBe("input_invalid");
    expect(s.reads).toEqual([]);
  });

  it("a fact that cannot be read or that disagrees with the ticket is refused, with the closed code of the fact module", async () => {
    const cases: Array<[string, (s: Scene) => void, string, string]> = [
      ["lease.json of another Run", (s) => { s.files.lease = leaseText({ run_id: "run-20250202T010203Z-ba9876543210" }); }, "lease_facts_refused", "run_id_mismatch"],
      ["lease.json with another nonce", (s) => { s.files.lease = leaseText({ nonce_sha256: sha("another-nonce") }); }, "lease_facts_refused", "nonce_mismatch"],
      ["lease.json with another H", (s) => { s.files.lease = leaseText({ heartbeat_interval_ms: 900 }); }, "lease_facts_refused", "heartbeat_mismatch"],
      ["lease.json with another S", (s) => { s.files.lease = leaseText({ stale_after_ms: 5000 }); }, "lease_facts_refused", "stale_mismatch"],
      ["lease.json unreadable", (s) => { s.files.lease = "{"; }, "lease_facts_refused", "lease_json_invalid_json"],
      ["launcher facts of another Run", (s) => { s.files.launcher = launcherText({ run_id: "run-20250202T010203Z-ba9876543210" }); }, "launcher_facts_refused", "run_id_mismatch"],
      ["launcher facts with another audit hash", (s) => { s.files.launcher = launcherText({ audit_config_sha256: H("9") }); }, "launcher_facts_refused", "audit_config_sha256_mismatch"],
      ["launcher facts of version 1", (s) => { s.files.launcher = launcherText({ schema_version: 1 }); }, "launcher_facts_refused", "schema_version_invalid"],
      ["runtime versions that cannot be collected", (s) => { s.files.npm = "{"; }, "runtime_versions_refused", "npm_json_invalid"],
    ];
    for (const [label, spoil, code, detail] of cases) {
      const s = await scene();
      spoil(s);
      const r = composeRun(s.input());
      expect(r, label).toEqual({ ok: false, error: { code, detail } });
      expect(s.store.opens, label).toBe(0);
      expect(s.factory.calls, label).toBe(0);
      // the control: the same scene without the defect composes
      expect(composeRun((await scene()).input()).ok, label).toBe(true);
    }
  });

  it("no refusal carries a value, a path or the nonce", async () => {
    const s = await scene();
    s.files.lease = leaseText({ run_id: CANARY });
    const r = composeRun(s.input({ nonce: `${CANARY}-nonce` }));
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(Object.keys((r as Any).error).every((k) => k === "code" || k === "detail")).toBe(true);
  });
});

describe("the wrapped Runner factory and the cell", () => {
  it("is called once; a second call is refused (startRun maps the throw to runner_start_refused)", async () => {
    const s = await scene();
    const r = composeRun(s.input());
    if (!r.ok) throw new Error("setup");
    r.value.runnerFactory(FACTORY_INPUT);
    expect(() => r.value.runnerFactory(FACTORY_INPUT)).toThrow();
    expect(s.factory.calls).toBe(1);
  });

  it("delegates health and execute to the same Runner, keeping `this` and the arguments", async () => {
    const s = await scene();
    const r = composeRun(s.input());
    if (!r.ok) throw new Error("setup");
    const runner = r.value.runnerFactory(FACTORY_INPUT);
    expect(await runner.health()).toEqual({ ok: true });
    await runner.execute({}, "rec-000003", signal());
    await runner.execute({}, "rec-000004", signal(), { notAfterMs: 5 });
    expect(s.runner.calls).toEqual(["health", "execute:rec-000003:none", 'execute:rec-000004:{"notAfterMs":5}']);
  });

  it("measures on the same Runner once and writes the result into the cell; the port can then seal (control of W5)", async () => {
    const s = await scene();
    const r = composeRun(s.input());
    if (!r.ok) throw new Error("setup");
    const runner = r.value.runnerFactory(FACTORY_INPUT);
    expect(await runner.measureStartState(signal(), { notAfterMs: 9 })).toEqual({ ok: true, identity: IDENTITY });
    expect(s.runner.calls).toEqual(['measure:{"notAfterMs":9}']);
    // a second measurement never reaches the Runner
    expect(await runner.measureStartState(signal())).toEqual({ ok: false, code: "internal_error" });
    expect(s.runner.calls).toHaveLength(1);
  });

  it("a Runner that throws, or answers with the wrong shape, gives a failure and closes the cell: no retry is possible", async () => {
    for (const answer of [() => { throw new Error(CANARY); }, () => ({ ok: true, identity: "not-a-hash" }), () => ({ weird: 1 })]) {
      const s = await scene();
      s.runner.measureAnswer = answer;
      const r = composeRun(s.input());
      if (!r.ok) throw new Error("setup");
      const runner = r.value.runnerFactory(FACTORY_INPUT);
      const first = await runner.measureStartState(signal());
      expect(first).toEqual({ ok: false, code: "internal_error" });
      expect(JSON.stringify(first)).not.toContain(CANARY);
      // a good answer now is never written: the measurement is not called again, and the cell stays closed
      s.runner.measureAnswer = () => ({ ok: true, identity: IDENTITY });
      expect(await runner.measureStartState(signal())).toEqual({ ok: false, code: "internal_error" });
      expect(s.runner.calls.filter((c) => c.startsWith("measure"))).toHaveLength(1);
    }
  });

  it("a Runner without the measurement is handed back unchanged (startRun refuses it)", async () => {
    const s = await scene();
    const plain = { health: async () => ({ ok: true }), execute: async () => ({}) };
    const r = composeRun(s.input({ deps: { ...s.input().deps, runnerFactory: () => plain } }));
    if (!r.ok) throw new Error("setup");
    expect(r.value.runnerFactory(FACTORY_INPUT)).toBe(plain);
  });
});

describe("the module", () => {
  it("is not exported from the package entry", async () => {
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")).not.toMatch(/runComposition|composeRun/);
  });
});
