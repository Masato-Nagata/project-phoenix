// Task 4.6 W6-C: one Mock Run through the WHOLE path with the real Run_Manifest: real stage B ticket, `composeRun`, the real
// Loop_Orchestrator (start gate, startRun with the start-state measurement, the phases, terminate), the REAL verifier Runner (`createRunner`)
// over the verifier FAKE http port, the real Mock_Provider, the real ManifestPort (`createManifestPort`), the real RunRecordStore on a
// MemoryFileSystem, and the real `verifyRunDirectory` / `acceptRun`.
// The lease facts, the launcher facts (version 2, kind fixture), the runtime version facts and the Legacy_App answers are SYNTHETIC; nothing
// here is evidence of a real container, a real audit configuration, or a mutual exclusion that held in a real environment (task 4.9).
// Every refused case has a passing control: the same world without the defect is sealed.
// **Validates: Requirements 12.8, 12.13, 15.12, 19.3, 22.1, 22.3, 24.9**
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE, acceptRun, checkStartupRefusals, validateRunConfig, verifyRunDirectory } from "../src/index.js";
import { createLoopOrchestrator } from "../src/orchestrator/loopOrchestrator.js";
import { composeRun } from "../src/orchestrator/runComposition.js";
import type { RunResult } from "../src/orchestrator/types.js";
import { writeCompletionMarker } from "./helpers/runFixtures.js";
import { RUN_DIR, buildWorld, type Any, type World, type WorldOptions } from "./support/mockRunWorld.js";
import { SYNTHETIC_RUN_ID } from "./support/syntheticRunId.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array | undefined): string => new TextDecoder().decode(b);
const CANARY = "canary-secret-value-w6c";
const NONCE = "synthetic-nonce-w6c";
const IMAGE_ID = `sha256:${sha("synthetic-image-w6c")}`;
const MANIFEST = `${RUN_DIR}/${MANIFEST_FILE}`;

/** The product list of the fake Legacy_App (the default of mockRunWorld), and the identity computed HERE, independently of the Runner:
 *  SHA-256 of the canonical JSON (keys sorted, no white space) of { status, bodyKind, body } after masking. The mask path of the ticket
 *  (`data.created_at`) names no node of this body, so the masked body is the body itself. */
const EXPECTED_BODY_TEXT = '{"data":[{"id":1,"name":"Widget A","stock_quantity":7,"unit_price":100}],"success":true}';
const EXPECTED_IDENTITY = sha(`{"body":${EXPECTED_BODY_TEXT},"bodyKind":"json","status":200}`);

interface Facts {
  lease: string;
  launcher: string;
  npm: string;
  reads: string[];
}
function factsFor(w: World): Facts {
  return {
    lease: JSON.stringify({ heartbeat_interval_ms: 1000, issued_by: "launcher", launcher_pid: 4242, launcher_start_ticks: "630000000000000000", nonce_sha256: sha(NONCE), run_id: SYNTHETIC_RUN_ID, stale_after_ms: 4000 }),
    launcher: JSON.stringify({ schema_version: 2, issued_by: "launcher", run_id: SYNTHETIC_RUN_ID, runtime_image_id: IMAGE_ID, audit_config_sha256: w.approval.auditConfig.sha256, audit_config_kind: "fixture" }),
    npm: JSON.stringify({ name: "npm", version: "9.8.7" }),
    reads: [],
  };
}
function portsOf(f: Facts): Any {
  const ok = (t: string) => ({ kind: "ok" as const, text: t });
  return {
    lease: { readLeaseJson: () => (f.reads.push("lease"), ok(f.lease)) },
    launcher: { readLauncherFacts: () => (f.reads.push("launcher"), ok(f.launcher)) },
    versions: {
      readNodeVersion: () => (f.reads.push("node"), "1.2.3"),
      readNpmPackageJson: () => (f.reads.push("npm"), ok(f.npm)),
      readDeclaredPackageJson: () => (f.reads.push("declared"), ok(JSON.stringify({ dependencies: { ajv: "8.20.0" } }))),
      readInstalledPackageJson: (n: string) => (f.reads.push(`installed:${n}`), ok(JSON.stringify({ name: n, version: "8.20.0" }))),
    },
  };
}

interface Composed {
  w: World;
  f: Facts;
  composition: ReturnType<typeof composeRun>;
  run(): Promise<RunResult>;
}
/** The world of mockRunWorld (its test-only manifest port is dropped), composed by `composeRun`, run by a fresh orchestrator. */
async function composed(o: WorldOptions = {}, edit?: { facts?: (f: Facts) => void; deps?: (deps: Any, w: World, f: Facts) => Any }): Promise<Composed> {
  const w = await buildWorld(o);
  const f = factsFor(w);
  edit?.facts?.(f);
  const { manifest: _testOnly, ...rest } = w.deps as Any;
  void _testOnly;
  const deps = edit?.deps === undefined ? rest : edit.deps(rest, w, f);
  const composition = composeRun({ startup: w.approval, nonce: NONCE, facts: portsOf(f), deps } as Any);
  return {
    w,
    f,
    composition,
    run: async () => {
      if (!composition.ok) throw new Error(`composition refused: ${composition.error.code}`);
      return createLoopOrchestrator(composition.value, w.extras).run(w.approval);
    },
  };
}
const manifestOf = (w: World): Any => JSON.parse(dec(w.mem.peek(MANIFEST)));
const count = (w: World, label: string): number => w.http.seen.filter((s) => s === label).length;
const terminationOf = (w: World): unknown => w.records().find((r) => r.kind === "termination")?.payload;

/** The provider answers `experiment_generation` with no Experiment (a Run with zero Experiments); other kinds get the real answer. */
const noExperiments = (deps: Any): Any => {
  const real = deps.provider;
  return {
    ...deps,
    provider: {
      identity: real.identity,
      complete: (req: Any, opts: Any) => (req.kind === "experiment_generation" ? Promise.resolve({ ok: true, value: enc('{"experiments":[]}') }) : real.complete(req, opts)),
    },
  };
};

async function expectControlSealed(): Promise<void> {
  const c = await composed();
  const r = await c.run();
  expect(r.sealed).toBe(true);
}

describe("the Mock Run with the real Run_Manifest", () => {
  it("composes, measures once after health, runs the loop, re-checks the facts and seals a version-2 Manifest that verifies and is accepted", async () => {
    const c = await composed();
    expect(c.composition.ok).toBe(true);
    expect(c.f.reads).toEqual(["lease", "launcher", "node", "npm", "declared", "installed:ajv"]);
    const r = await c.run();
    expect(r.sealed).toBe(true);
    if (r.sealed) expect(r.summary.terminationReason).toBe("iteration_limit_reached");
    // the measurement: one reset and one GET /products, after health and before the first Experiment's reset
    expect(c.w.http.seen.slice(0, 3)).toEqual(["GET /health", "POST /reset", "GET /products"]);
    expect(count(c.w, "GET /products")).toBe(1);
    expect(count(c.w, "GET /orders")).toBeGreaterThanOrEqual(2); // the Experiments ran through the real Runner
    // the re-check before the seal read the lease, the launcher facts and the versions again
    expect(c.f.reads.slice(6)).toEqual(["lease", "launcher", "node", "npm", "declared", "installed:ajv"]);
    const m = manifestOf(c.w);
    expect(m.schemaVersion).toBe(2);
    expect(m.payload_audit.auditConfigKind).toBe("fixture");
    expect(m.payload_audit.auditConfigKindDeclaredBy).toBe("launcher");
    expect(m.payload_audit.auditConfigSha256).toBe(c.w.approval.auditConfig.sha256);
    expect(m.legacyStartState).toEqual({ identity: EXPECTED_IDENTITY });
    expect(m.toolVersions).toEqual({ node: "1.2.3", npm: "9.8.7", dependencies: { ajv: "8.20.0" }, runtimeImageDigest: IMAGE_ID });
    expect(m.mutualExclusion).toEqual({ mode: "mechanical", lease: { nonceSha256: sha(NONCE), launcherPid: 4242, heartbeatIntervalMs: 1000, staleAfterMs: 4000 } });
    expect((await verifyRunDirectory(c.w.mem, RUN_DIR)).result).toBe("success");
    expect((await acceptRun(c.w.mem, RUN_DIR)).accepted).toBe(false);
    await writeCompletionMarker(c.w.mem, RUN_DIR);
    expect((await acceptRun(c.w.mem, RUN_DIR)).accepted).toBe(true);
  });

  it("a Run with zero Experiments is measured, sealed (no_further_experiments), verified and accepted", async () => {
    const c = await composed({ iterations: 1 }, { deps: noExperiments });
    const r = await c.run();
    expect(r.sealed).toBe(true);
    if (r.sealed) expect(r.summary.terminationReason).toBe("no_further_experiments");
    expect(c.w.records().some((x) => x.kind === "experiment")).toBe(false);
    expect(count(c.w, "POST /reset")).toBe(1); // the measurement's reset only: no Experiment ran
    expect(count(c.w, "GET /products")).toBe(1);
    expect(manifestOf(c.w).legacyStartState).toEqual({ identity: EXPECTED_IDENTITY });
    expect((await verifyRunDirectory(c.w.mem, RUN_DIR)).result).toBe("success");
    await writeCompletionMarker(c.w.mem, RUN_DIR);
    expect((await acceptRun(c.w.mem, RUN_DIR)).accepted).toBe(true);
  });
});

describe("refusals, each with its passing control", () => {
  it("stage B refuses: there is no ticket, composeRun refuses it and reads no fact", async () => {
    const w = await buildWorld();
    const v = validateRunConfig({ schemaVersion: 1, provider: "mock", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames: [] });
    if (!v.ok) throw new Error("setup");
    const refused = await checkStartupRefusals(v.value, { policy: { load: () => ({ ok: false, code: "invalid" }) } } as Any);
    expect(refused.ok).toBe(false);
    const f = factsFor(w);
    const { manifest: _m, ...rest } = w.deps as Any;
    void _m;
    expect(composeRun({ startup: refused as Any, nonce: NONCE, facts: portsOf(f), deps: rest } as Any)).toMatchObject({ ok: false, error: { code: "startup_invalid" } });
    expect(f.reads).toEqual([]);
    expect(w.store()).toBeUndefined();
    await expectControlSealed();
  });

  it("start-up facts that cannot be read or disagree: no composition, the store is never opened, nothing is sent", async () => {
    for (const spoil of [(f: Facts) => { f.lease = "{"; }, (f: Facts) => { f.launcher = f.launcher.replace('"schema_version":2', '"schema_version":1'); }, (f: Facts) => { f.npm = "{"; }]) {
      const c = await composed({}, { facts: spoil });
      expect(c.composition.ok).toBe(false);
      expect(c.w.store()).toBeUndefined();
      expect(c.w.http.seen).toEqual([]);
    }
    await expectControlSealed();
  });

  it("launcher facts of another Run are refused at composition", async () => {
    const c = await composed({}, { facts: (f) => { f.launcher = f.launcher.replace(SYNTHETIC_RUN_ID, "run-20250202T010203Z-ba9876543210"); } });
    expect(c.composition).toMatchObject({ ok: false, error: { code: "launcher_facts_refused", detail: "run_id_mismatch" } });
    await expectControlSealed();
  });

  it("a failed health check: no reset, no GET /products, no phase; the termination record names error; the Run is NOT sealed", async () => {
    const c = await composed({ healthFails: true });
    const r = await c.run();
    expect(count(c.w, "POST /reset")).toBe(0);
    expect(count(c.w, "GET /products")).toBe(0);
    expect(c.w.providerCalls).toHaveLength(0);
    expect(terminationOf(c.w)).toEqual({ terminationReason: "error" });
    expect(r).toMatchObject({ sealed: false, started: true, failure: "manifest_build_failed", terminationReason: "error" });
    expect(c.w.mem.peek(MANIFEST)).toBeUndefined();
    await expectControlSealed();
  });

  it("a failed measurement (500), a timeout and an abort: no Experiment, not sealed, the true reason kept in the record and the result", async () => {
    const cases: Array<[string, WorldOptions, string]> = [
      ["500", { productsReply: { status: 500, body: JSON.stringify({ success: false, error: "x" }) } }, "error"],
      ["timeout", { productsReply: async (_s, ww) => { ww.time.t += 10_001; return { status: 200, body: JSON.stringify({ success: true, data: [] }) }; } }, "error"],
      [
        "abort",
        {
          productsReply: async (_s, ww) => {
            ww.time.t = 1_000 + 1_800_000;
            for (const t of ww.timers) if (t.cancelled === 0) t.fire();
            return { status: 200, body: JSON.stringify({ success: true, data: [] }) };
          },
        },
        "time_limit_reached",
      ],
    ];
    for (const [label, o, reason] of cases) {
      const c = await composed(o);
      const r = await c.run();
      expect(c.w.providerCalls, label).toHaveLength(0);
      expect(c.w.records().some((x) => x.kind === "experiment"), label).toBe(false);
      expect(terminationOf(c.w), label).toEqual({ terminationReason: reason });
      expect(r, label).toMatchObject({ sealed: false, started: true, failure: "manifest_build_failed", terminationReason: reason });
      expect(c.w.mem.peek(MANIFEST), label).toBeUndefined();
    }
    await expectControlSealed();
  });

  it("facts that change before the seal: the Run is not sealed (the re-check refuses); the termination record stays", async () => {
    for (const change of [(f: Facts) => { f.launcher = f.launcher.replace(IMAGE_ID, `sha256:${sha("another")}`); }, (f: Facts) => { f.lease = f.lease.replace("4242", "4343"); }, (f: Facts) => { f.npm = JSON.stringify({ name: "npm", version: "9.8.8" }); }]) {
      let c: Composed | undefined;
      c = await composed({ onProviderCall: (n) => { if (n === 1 && c !== undefined) change(c.f); } });
      const r = await c.run();
      expect(r).toMatchObject({ sealed: false, started: true, failure: "manifest_build_failed", terminationReason: "iteration_limit_reached" });
      expect(terminationOf(c.w)).toEqual({ terminationReason: "iteration_limit_reached" });
      expect(c.w.mem.peek(MANIFEST)).toBeUndefined();
    }
    await expectControlSealed();
  });

  it("a Manifest that is not valid is refused at the seal (a core that the port refuses: an access-denial result without the brand)", async () => {
    // the core is built by the real orchestrator; a port wrapped to hand it a copy of the access-denial result must refuse to build
    const c = await composed();
    if (!c.composition.ok) throw new Error("setup");
    const real = c.composition.value.manifest;
    const tampered = { ...c.composition.value, manifest: { build: (core: Any) => real.build({ ...core, accessDenial: { ...core.accessDenial } }) } };
    const r = await createLoopOrchestrator(tampered as Any, c.w.extras).run(c.w.approval);
    expect(r).toMatchObject({ sealed: false, failure: "manifest_build_failed" });
    expect(c.w.mem.peek(MANIFEST)).toBeUndefined();
    await expectControlSealed();
  });

  it("the same ticket composed twice starts at most one Run: the start gate consumes it", async () => {
    const w = await buildWorld();
    const { manifest: _m, ...rest } = w.deps as Any;
    void _m;
    const a = composeRun({ startup: w.approval, nonce: NONCE, facts: portsOf(factsFor(w)), deps: rest } as Any);
    const b = composeRun({ startup: w.approval, nonce: NONCE, facts: portsOf(factsFor(w)), deps: rest } as Any);
    if (!a.ok || !b.ok) throw new Error("setup");
    const first = await createLoopOrchestrator(a.value, w.extras).run(w.approval);
    const second = await createLoopOrchestrator(b.value, w.extras).run(w.approval);
    expect(first.sealed).toBe(true);
    expect(second).toMatchObject({ sealed: false, started: false });
    expect(count(w, "GET /products")).toBe(1);
  });

  it("no canary, nonce or absolute path in the Manifest, the records or a refusal", async () => {
    process.env["PHOENIX_TEST_CANARY_W6C"] = CANARY;
    try {
      const c = await composed();
      await c.run();
      const text = c.w.mem.allFiles().map((p) => dec(c.w.mem.peek(p))).join("\n");
      expect(text).not.toContain(CANARY);
      expect(text).not.toContain(NONCE);
      expect(dec(c.w.mem.peek(MANIFEST))).not.toMatch(/"\/(?:repo|workspace|app|home|tmp)\b|[A-Za-z]:\\\\/);
      const bad = await composed({}, { facts: (f) => { f.lease = f.lease.replace(SYNTHETIC_RUN_ID, CANARY); } });
      expect(JSON.stringify(bad.composition)).not.toContain(CANARY);
    } finally {
      delete process.env["PHOENIX_TEST_CANARY_W6C"];
    }
  });
});
