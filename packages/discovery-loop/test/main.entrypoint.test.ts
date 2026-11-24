// Task 4.9-B: the runtime entry point `runMain` end to end in one process. REAL: the fixed-path readers, stage A, stage B with the production
// ports, the real lease port over a temporary lease directory, `composeRun` with the real facts readers, the Loop_Orchestrator, the audit
// adapter, the Mock_Provider, the verifier Runner, the RunRecordStore on a temporary Run_Volume, the Run_Manifest, `verifyRunDirectory`.
// INJECTED (external ports only): the directories, the environment, a fake monotonic clock whose sleeper writes the heartbeat, the verifier
// FAKE http port (no network), the access-denial measurement ports (the isolation fakes), the timer backend and the output line.
// SYNTHETIC: the lease and launcher facts, the version facts tree, the audit configuration, the source file, the Legacy_App answers.
// Nothing here is evidence of a real container, a real image, a real Launcher or a real audit configuration (task 4.9 and later).
//
// PROVIDER OBSERVATION. `createProvider` of `@phoenix/ai-client` is wrapped for this file only (vi.mock with the real module behind it): the
// wrapper counts every `complete` call that reaches the provider port, and passes the request on unchanged to the REAL guarded Mock_Provider.
// Only the test `tampered request` changes what is passed: one request is handed on as a plain copy, which the REAL provider guard refuses as
// not audited (an `audit_violation`). Stage A, stage B, composeRun, the start gate and the orchestrator are not replaced.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const providerSpy = vi.hoisted(() => ({ created: 0, calls: 0, kinds: [] as string[], tamperCall: 0 }));
vi.mock("@phoenix/ai-client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@phoenix/ai-client")>();
  return {
    ...real,
    createProvider: (cfg: Parameters<typeof real.createProvider>[0], factories?: Parameters<typeof real.createProvider>[1]) => {
      const inner = factories === undefined ? real.createProvider(cfg) : real.createProvider(cfg, factories);
      providerSpy.created += 1;
      return Object.freeze({
        identity: inner.identity,
        complete(req: Parameters<typeof inner.complete>[0], opts: Parameters<typeof inner.complete>[1]) {
          providerSpy.calls += 1;
          providerSpy.kinds.push(req.kind);
          // a copy is not a request that the Payload_Auditor issued: the real guard refuses it
          return inner.complete(providerSpy.calls === providerSpy.tamperCall ? ({ ...req } as typeof req) : req, opts);
        },
      });
    },
  };
});
import { isEntryPoint, runMain, TEMPLATE_IDS, type MainOptions, type RuntimePaths } from "../src/main.js";
import { createNodeFileSystem, verifyRunDirectory } from "../src/index.js";
import { failingIsolation, passingIsolation } from "./support/orchestratorFakes.js";
import { FakeTime, syntheticAuditConfig, toBytes } from "./support/startupAdapters.js";
import { SYNTHETIC_RUN_ID, OTHER_SYNTHETIC_RUN_ID } from "./support/syntheticRunId.js";
import { allowlistJson, allowlistMd } from "../../analyzer/test/helpers/bundleFixtures.js";
import { FakeHttp, FakeLease } from "../../verifier/test/helpers/runnerFixtures.js";
import { FakeTime as VerifierFakeTime } from "../../verifier/test/helpers/leaseFixtures.js";

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any
const sha = (s: string | Uint8Array): string => createHash("sha256").update(s).digest("hex");
const NONCE = "synthetic-nonce-entrypoint-7c2f";
const IMAGE_ID = `sha256:${sha("synthetic-image-entrypoint")}`;
const SOURCE_PATH = "legacy/src/utils.php";
const SOURCE_TEXT = "<?php\n// synthetic helper of the mock run\n";
const AUDIT_CANARY = "SYNTHETIC-CANARY-0001";
const TEMPLATES = fileURLToPath(new URL("../data/templates", import.meta.url));
const VERIFIER_DATA = fileURLToPath(new URL("../../verifier/data", import.meta.url));
/** The identity of the start state, computed here independently of the Runner (as in the W6 test): canonical JSON of status, kind, body. */
const PRODUCTS_BODY = { success: true, data: [{ id: 1, name: "Widget A", unit_price: 100, stock_quantity: 7 }] };
const EXPECTED_IDENTITY = sha('{"body":{"data":[{"id":1,"name":"Widget A","stock_quantity":7,"unit_price":100}],"success":true},"bodyKind":"json","status":200}');

let base: string;
beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "phx-main-")));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});
let counter = 0;
const dir = (...parts: string[]): string => {
  const p = join(base, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};
const put = (p: string, text: string | Uint8Array): void => writeFileSync(p, text);

interface WorldEdit {
  runConfig?: unknown;
  runConfigText?: string;
  noRunConfig?: boolean;
  noAuditConfig?: boolean;
  env?: Record<string, string | undefined>;
  nonceInLease?: string;
  launcher?: (facts: Record<string, unknown>) => Record<string, unknown> | string;
  volumeNotEmpty?: boolean;
  isolationFails?: boolean;
  healthFails?: boolean;
  paths?: (p: RuntimePaths) => RuntimePaths;
}
interface World {
  readonly paths: RuntimePaths;
  readonly http: FakeHttp;
  readonly lines: string[];
  readonly timers: { active: Set<number>; started: number };
  readonly options: MainOptions;
  readonly auditBytes: Uint8Array;
}

function world(edit: WorldEdit = {}): World {
  counter += 1;
  providerSpy.created = 0;
  providerSpy.calls = 0;
  providerSpy.kinds = [];
  providerSpy.tamperCall = 0;
  const root = dir(`w${counter}`);
  const configDir = dir(`w${counter}`, "config");
  const leaseDir = dir(`w${counter}`, "lease");
  const runVolumeDir = dir(`w${counter}`, "out");
  const repoRoot = dir(`w${counter}`, "repo");
  mkdirSync(join(repoRoot, "legacy", "src"), { recursive: true });
  mkdirSync(join(repoRoot, "docs"), { recursive: true });
  put(join(repoRoot, SOURCE_PATH), SOURCE_TEXT);
  put(join(repoRoot, "docs", "ai-input-allowlist.json"), allowlistJson([SOURCE_PATH]));
  put(join(repoRoot, "docs", "ai-input-allowlist.md"), allowlistMd([SOURCE_PATH]));
  // the runtime version facts: a synthetic npm, a declaration and one installed package
  const npmPackageDir = dir(`w${counter}`, "npm");
  const declaredPackageDir = dir(`w${counter}`, "declared");
  const modulesDir = dir(`w${counter}`, "modules");
  put(join(npmPackageDir, "package.json"), JSON.stringify({ name: "npm", version: "11.20.0" }));
  put(join(declaredPackageDir, "package.json"), JSON.stringify({ name: "runner", dependencies: { "@phoenix/ai-client": "0.0.0", ajv: "8.20.0" } }));
  mkdirSync(join(modulesDir, "ajv"));
  put(join(modulesDir, "ajv", "package.json"), JSON.stringify({ name: "ajv", version: "8.20.0" }));
  if (edit.volumeNotEmpty === true) put(join(runVolumeDir, "leftover.txt"), "x");

  const runConfig = edit.runConfig ?? { schemaVersion: 1, provider: "mock", limits: { iterations: 2 }, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: ["data.created_at"] }, envNames: [] };
  if (edit.noRunConfig !== true) put(join(configDir, "run-config.json"), edit.runConfigText ?? JSON.stringify(runConfig));
  const auditBytes = toBytes(syntheticAuditConfig());
  if (edit.noAuditConfig !== true) put(join(configDir, "audit-config.json"), auditBytes);

  // the lease directory as the Launcher writes it, and the launcher facts (version 2)
  const leaseNonce = edit.nonceInLease ?? NONCE;
  put(join(leaseDir, "lease.json"), JSON.stringify({ heartbeat_interval_ms: 1000, issued_by: "launcher", launcher_pid: 4242, launcher_start_ticks: "630000000000000000", nonce_sha256: sha(leaseNonce), run_id: SYNTHETIC_RUN_ID, stale_after_ms: 4000 }));
  let beat = 1;
  put(join(leaseDir, "heartbeat"), String(beat));
  const facts: Record<string, unknown> = { schema_version: 2, issued_by: "launcher", run_id: SYNTHETIC_RUN_ID, runtime_image_id: IMAGE_ID, audit_config_sha256: sha(auditBytes), audit_config_kind: "fixture" };
  const edited = edit.launcher === undefined ? facts : edit.launcher(facts);
  put(join(leaseDir, "launcher-facts.json"), typeof edited === "string" ? edited : JSON.stringify(edited));

  const time = new FakeTime();
  time.now = 1_000;
  time.onSleep = () => {
    beat += 1;
    put(join(leaseDir, "heartbeat"), String(beat));
  };
  const http = new FakeHttp(new VerifierFakeTime(), new FakeLease());
  http.on((r) => r.method === "GET" && r.path === "/products", { status: 200, body: JSON.stringify(PRODUCTS_BODY) });
  if (edit.healthFails === true) http.on((r) => r.method === "GET" && r.path === "/health", { status: 503, body: JSON.stringify({ success: false, error: "down" }) });

  const timers = { active: new Set<number>(), started: 0 };
  let nextId = 0;
  const handles = new Map<number, ReturnType<typeof setTimeout>>();
  const backend = {
    set: (fire: () => void, delayMs: number): unknown => {
      nextId += 1;
      const id = nextId;
      timers.started += 1;
      timers.active.add(id);
      handles.set(id, setTimeout(() => { timers.active.delete(id); fire(); }, delayMs));
      return id;
    },
    clear: (h: unknown): void => {
      const id = h as number;
      clearTimeout(handles.get(id));
      timers.active.delete(id);
    },
  };
  const lines: string[] = [];
  let paths: RuntimePaths = {
    configDir,
    leaseDir,
    runVolumeDir,
    repoRoot,
    verifierDataDir: VERIFIER_DATA,
    templatesDir: TEMPLATES,
    npmPackageDir,
    declaredPackageDir,
    modulesDir,
    bundleRoots: [{ label: "dist", dir: root }],
  };
  if (edit.paths !== undefined) paths = edit.paths(paths);
  const options: MainOptions = {
    paths,
    env: edit.env ?? { PHOENIX_RUN_ID: SYNTHETIC_RUN_ID, PHOENIX_LEASE_NONCE: NONCE, PHOENIX_LEASE_D_MS: "123", HOME: "/nonexistent" },
    clock: time.clock,
    sleeper: time.sleeper,
    createHttp: () => http,
    isolation: (runId) => (edit.isolationFails === true ? failingIsolation().deps : passingIsolation(runId).deps),
    timerBackend: backend,
    writeLine: (l) => lines.push(l),
  };
  return { paths, http, lines, timers, options, auditBytes };
}

const lineOf = (w: World): Any => {
  expect(w.lines).toHaveLength(1);
  return JSON.parse(w.lines[0] as string);
};
const volumeFiles = (w: World): string[] => (readdirSync(w.paths.runVolumeDir, { recursive: true, encoding: "utf8" }) as string[]).sort();
const volumeText = (w: World): string =>
  volumeFiles(w).map((f) => { try { return readFileSync(join(w.paths.runVolumeDir, f), "utf8"); } catch { return ""; } }).join("\n");
const records = (w: World): Any[] =>
  readFileSync(join(w.paths.runVolumeDir, "records.jsonl"), "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
/** Nothing was sent to the Legacy_App or to the provider (observed at both ports), no record was written, and the timers are clear. */
function expectNothingStarted(w: World): void {
  expect(w.http.seen).toEqual([]);
  expect(providerSpy.calls).toBe(0);
  expect(volumeFiles(w).filter((f) => f !== "leftover.txt")).toEqual([]);
  expect(w.timers.active.size).toBe(0);
}
function expectNoSecret(w: World): void {
  const all = `${w.lines.join("\n")}\n${volumeText(w)}`;
  expect(all).not.toContain(NONCE);
  expect(all).not.toContain(AUDIT_CANARY);
  expect(w.lines.join("\n")).not.toContain(base);
}

describe("runMain: a Mock Run end to end", () => {
  it("seals a version-2 Run_Manifest that verifies; the first request is the health check; exit code 0", async () => {
    const w = world();
    const code = await runMain(w.options);
    const line = lineOf(w);
    // sealed says that the Run_Manifest exists and verifies; the termination reason is a separate field. With `iterations: 2` and the default
    // fixture set, the Run ends at the Iteration limit (R11.11): no closing revision call, and that is not a success claim.
    expect(line).toEqual({ phase: "run", sealed: true, terminationReason: "iteration_limit_reached" });
    expect(code).toBe(0);
    // positive control of the provider observation: the provider port was reached, once per ai_call record, in the request-kind order
    expect(providerSpy.created).toBe(1);
    expect(providerSpy.calls).toBeGreaterThan(0);
    expect(records(w).filter((r) => r.kind === "ai_call")).toHaveLength(providerSpy.calls);
    expect(providerSpy.kinds).toEqual(["hypothesis_generation", "experiment_generation", "hypothesis_revision", "experiment_generation"]);
    expect(records(w).find((r) => r.kind === "termination")?.payload).toEqual({ terminationReason: "iteration_limit_reached" });
    expect(w.http.seen.slice(0, 3)).toEqual(["GET /health", "POST /reset", "GET /products"]);
    const m = JSON.parse(readFileSync(join(w.paths.runVolumeDir, "manifest.json"), "utf8"));
    expect(m.schemaVersion).toBe(2);
    expect(m.terminationReason).toBe("iteration_limit_reached");
    expect(m.legacyStartState).toEqual({ identity: EXPECTED_IDENTITY });
    expect(m.toolVersions.runtimeImageDigest).toBe(IMAGE_ID);
    expect(m.toolVersions.npm).toBe("11.20.0");
    expect(m.toolVersions.dependencies).toEqual({ ajv: "8.20.0" });
    expect(m.payload_audit.auditConfigKind).toBe("fixture");
    expect(m.payload_audit.auditConfigSha256).toBe(sha(w.auditBytes));
    expect(m.mutualExclusion.lease.nonceSha256).toBe(sha(NONCE));
    expect(m.provider.isMock).toBe(true);
    expect((await verifyRunDirectory(createNodeFileSystem(), w.paths.runVolumeDir)).result).toBe("success");
    expect(w.timers.started).toBeGreaterThan(0);
    expect(w.timers.active.size).toBe(0);
    expectNoSecret(w);
  });

  it("the audited bytes are the bytes of the request: blob, payload hash and ai_call request hash agree; the envelope carries the template id and the SHA-256 of the template file", async () => {
    const w = world();
    expect(await runMain(w.options)).toBe(0);
    const recs = records(w);
    const audits = recs.filter((r) => r.kind === "payload_audit");
    const calls = recs.filter((r) => r.kind === "ai_call");
    expect(audits.length).toBeGreaterThan(0);
    expect(calls.length).toBe(audits.length);
    const templateSha = new Map(Object.values(TEMPLATE_IDS).map((id) => [id, sha(readFileSync(join(TEMPLATES, `${id}.txt`)))]));
    for (const a of audits) {
      expect(a.payload.result).toBe("pass");
      const blob = readFileSync(join(w.paths.runVolumeDir, "blobs", a.payload.blob.blob));
      expect(sha(blob)).toBe(a.payload.payloadSha256);
      const call = calls.find((c) => c.payload.payloadAuditRecordId === a.id);
      expect(call?.payload.requestSha256).toBe(a.payload.payloadSha256);
      const envelope = JSON.parse(blob.toString("utf8"));
      expect(templateSha.get(envelope.instruction.templateId)).toBe(envelope.instruction.sha256);
      // the template text itself is never part of the payload
      const text = readFileSync(join(TEMPLATES, `${envelope.instruction.templateId}.txt`), "utf8");
      expect(blob.toString("utf8")).not.toContain(text.split("\n")[0]);
    }
    expect(new Set(audits.map((a) => JSON.parse(readFileSync(join(w.paths.runVolumeDir, "blobs", a.payload.blob.blob), "utf8")).kind)).size).toBeGreaterThan(1);
  });

  it("two Runs, one after the other: each has its own adapter and seals on its own", async () => {
    const a = world();
    const b = world();
    expect(await runMain(a.options)).toBe(0);
    expect(await runMain(b.options)).toBe(0);
    expect(lineOf(a).sealed).toBe(true);
    expect(lineOf(b).sealed).toBe(true);
  });

  it("sealed is not success: a request that the auditor did not issue reaches the provider after the start state was measured; the real guard refuses it (audit_violation), the Run ends with error, and it is sealed (exit 0)", async () => {
    const w = world();
    providerSpy.tamperCall = 2; // the experiment_generation call of the first Iteration
    const code = await runMain(w.options);
    expect(lineOf(w)).toEqual({ phase: "run", sealed: true, terminationReason: "error" });
    expect(code).toBe(0);
    // the start state was measured first, then the first provider call went through, then the second was refused by the guard
    expect(w.http.seen.slice(0, 3)).toEqual(["GET /health", "POST /reset", "GET /products"]);
    expect(providerSpy.calls).toBe(2);
    expect(providerSpy.kinds).toEqual(["hypothesis_generation", "experiment_generation"]);
    const recs = records(w);
    expect(recs.filter((r) => r.kind === "ai_call")).toHaveLength(1); // no ai_call for the refused request
    const errors = recs.filter((r) => r.kind === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].payload).toMatchObject({ code: "audit_violation", requestKind: "experiment_generation", attempt: 1, violation: { code: "not_audited" } });
    expect(recs.some((r) => r.kind === "experiment")).toBe(false); // nothing was executed after the refusal
    expect(recs.find((r) => r.kind === "termination")?.payload).toEqual({ terminationReason: "error" });
    const m = JSON.parse(readFileSync(join(w.paths.runVolumeDir, "manifest.json"), "utf8"));
    expect(m.schemaVersion).toBe(2);
    expect(m.terminationReason).toBe("error");
    expect(m.legacyStartState).toEqual({ identity: EXPECTED_IDENTITY });
    expect((await verifyRunDirectory(createNodeFileSystem(), w.paths.runVolumeDir)).result).toBe("success");
    expect(w.timers.active.size).toBe(0);
    expectNoSecret(w);
  });

  it("sealed is not success: an unsealed Run keeps its termination reason and exits 1 (a failed health check: no measurement, no manifest)", async () => {
    const w = world({ healthFails: true });
    const code = await runMain(w.options);
    expect(code).toBe(1);
    expect(lineOf(w)).toEqual({ phase: "run", sealed: false, started: true, failure: "manifest_build_failed", terminationReason: "error" });
    expect(w.http.seen).toEqual(["GET /health"]);
    expect(providerSpy.calls).toBe(0);
    expect(volumeFiles(w)).not.toContain("manifest.json");
    expect(records(w).some((r) => r.kind === "payload_audit" || r.kind === "ai_call")).toBe(false);
    expect(w.timers.active.size).toBe(0);
    expectNoSecret(w);
  });
});

describe("runMain: refusals before the Run (exit code 2) and of the start gate (exit code 1)", () => {
  it.each([
    ["no run-config.json", { noRunConfig: true }, { phase: "input", code: "run_config_missing" }],
    ["a run-config.json that is not strict JSON (duplicate key)", { runConfigText: '{"schemaVersion":1,"schemaVersion":1}' }, { phase: "input", code: "run_config_invalid" }],
    ["stage A: an unknown key", { runConfig: { schemaVersion: 1, provider: "mock", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames: [], extra: 1 } }, { phase: "stage_a", codes: ["unknown_key"] }],
  ] as const)("%s", async (_label, edit, expected) => {
    const w = world(edit as WorldEdit);
    expect(await runMain(w.options)).toBe(2);
    expect(lineOf(w)).toEqual(expected);
    expectNothingStarted(w);
    expectNoSecret(w);
  });

  it.each([
    ["no audit-config.json", { noAuditConfig: true }, "auditConfig:audit_config_missing"],
    ["a Run_Volume that is not empty", { volumeNotEmpty: true }, "io:run_volume_not_empty"],
    ["no lease nonce", { env: { PHOENIX_RUN_ID: SYNTHETIC_RUN_ID, PHOENIX_LEASE_D_MS: "123" } }, "lease:lease_env_missing"],
    ["no propagation delay", { env: { PHOENIX_RUN_ID: SYNTHETIC_RUN_ID, PHOENIX_LEASE_NONCE: NONCE } }, "lease:lease_timing_invalid"],
    ["a nonce that does not match lease.json", { nonceInLease: "a-different-nonce-0002" }, "lease:lease_invalid"],
  ] as const)("stage B: %s", async (_label, edit, refusal) => {
    const w = world(edit as WorldEdit);
    expect(await runMain(w.options)).toBe(2);
    const line = lineOf(w);
    expect(line.phase).toBe("stage_b");
    expect(line.refusals.map((r: Any) => `${r.check}:${r.code}`)).toContain(refusal);
    expectNothingStarted(w);
    expectNoSecret(w);
  });

  it.each([
    ["launcher facts of another Run", (f: Record<string, unknown>) => ({ ...f, run_id: OTHER_SYNTHETIC_RUN_ID })],
    ["launcher facts with another audit configuration hash", (f: Record<string, unknown>) => ({ ...f, audit_config_sha256: sha("another") })],
    ["launcher facts of version 1 (no kind)", (f: Record<string, unknown>) => { const { audit_config_kind: _k, ...rest } = f; void _k; return { ...rest, schema_version: 1 }; }],
    ["launcher facts that are not JSON", () => "{"],
    ["launcher facts whose kind is a canary-like word", (f: Record<string, unknown>) => ({ ...f, audit_config_kind: "canary_secret_word" })],
    ["launcher facts whose run id is a path", (f: Record<string, unknown>) => ({ ...f, run_id: "/run/lease/../../etc/passwd" })],
  ] as const)("composeRun refuses %s: the line is the closed code only, with no detail", async (_label, launcher) => {
    const w = world({ launcher: launcher as WorldEdit["launcher"] });
    expect(await runMain(w.options)).toBe(2);
    expect(lineOf(w)).toEqual({ phase: "compose", code: "launcher_facts_refused" });
    expect(w.lines[0]).not.toMatch(/canary|passwd|\/run\/|mismatch/);
    expectNothingStarted(w);
    expectNoSecret(w);
  });

  it("a version facts tree without the npm package.json: composeRun refuses the runtime versions, nothing is sent", async () => {
    const w = world({ paths: (p) => ({ ...p, npmPackageDir: dir(`no-npm-${counter}`) }) });
    expect(await runMain(w.options)).toBe(2);
    expect(lineOf(w)).toMatchObject({ phase: "compose", code: "runtime_versions_refused" });
    expectNothingStarted(w);
  });

  it("assembly: a missing template, an unreadable allowlist, or a facts directory that is a link: exit 2, nothing sent", async () => {
    const noTemplates = world({ paths: (p) => ({ ...p, templatesDir: dir(`empty${counter}`) }) });
    expect(await runMain(noTemplates.options)).toBe(2);
    expect(lineOf(noTemplates)).toEqual({ phase: "assembly", code: "template_unreadable" });
    expectNothingStarted(noTemplates);

    const noAllowlist = world();
    rmSync(join(noAllowlist.paths.repoRoot, "docs", "ai-input-allowlist.json"));
    expect(await runMain(noAllowlist.options)).toBe(2);
    expect(lineOf(noAllowlist)).toEqual({ phase: "assembly", code: "allowlist_unreadable" });
    expectNothingStarted(noAllowlist);

    // the lease directory given through a symbolic link: the lease proof of stage B reads through it, the facts readers refuse it
    const linked = world();
    const link = join(base, `lease-link-${counter}`);
    symlinkSync(linked.paths.leaseDir, link);
    const viaLink = { ...linked, options: { ...linked.options, paths: { ...linked.paths, leaseDir: link } } };
    expect(await runMain(viaLink.options)).toBe(2);
    expect(lineOf(viaLink)).toEqual({ phase: "assembly", code: "facts_reader_invalid" });
    expectNothingStarted(viaLink);
  });

  it("the start gate refuses (the access-denial verification fails): no Legacy_App request, no provider call, no record; exit 1", async () => {
    const w = world({ isolationFails: true });
    expect(await runMain(w.options)).toBe(1);
    expect(lineOf(w)).toEqual({ phase: "run", sealed: false, started: false, failure: "internal_error" });
    expectNothingStarted(w);
    expectNoSecret(w);
  });

  it("an unexpected exception: exit 1, the closed code internal_error, the timers cleared, nothing sent", async () => {
    const w = world();
    const hostile = { ...w.options };
    Object.defineProperty(hostile, "paths", { enumerable: true, get: () => { throw new Error(`CANARY ${NONCE} ${base}`); } });
    expect(await runMain(hostile)).toBe(1);
    expect(lineOf(w)).toEqual({ phase: "internal", code: "internal_error" });
    expectNothingStarted(w);
    expectNoSecret(w);
  });
});

describe("the output line", () => {
  it("is one line of JSON whose every string is a closed code word", async () => {
    const cases = [world(), world({ noRunConfig: true }), world({ noAuditConfig: true }), world({ isolationFails: true }), world({ launcher: (f) => ({ ...f, run_id: OTHER_SYNTHETIC_RUN_ID }) })];
    for (const w of cases) {
      await runMain(w.options);
      expect(w.lines).toHaveLength(1);
      expect(w.lines[0]).not.toContain("\n");
      const strings: string[] = [];
      const walk = (v: unknown): void => {
        if (typeof v === "string") strings.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (typeof v === "object" && v !== null) Object.values(v).forEach(walk);
      };
      walk(JSON.parse(w.lines[0] as string));
      for (const s of strings) expect(s, s).toMatch(/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/);
    }
  });
});

describe("isEntryPoint (command-line start versus import)", () => {
  it("is false in a test: importing the module did not start a Run", () => {
    expect(isEntryPoint(process.argv[1], new URL("../src/main.ts", import.meta.url).href)).toBe(false);
  });
  it("is true for the same file given as a path with spaces and %, as a relative path, and through a symbolic link", () => {
    const d = dir("entry dir %20 x");
    const file = join(d, "main 100%.js");
    put(file, "");
    const url = pathToFileURL(file).href;
    expect(isEntryPoint(file, url)).toBe(true);
    const link = join(d, "link.js");
    symlinkSync(file, link);
    expect(isEntryPoint(link, url)).toBe(true);
    expect(isEntryPoint(relative(process.cwd(), file), url)).toBe(true);
  });
  it("is false for another file, a missing file, an empty or missing argument, and a URL that is not a file URL", () => {
    const d = dir("entry-other");
    const a = join(d, "a.js");
    const b = join(d, "b.js");
    put(a, "");
    put(b, "");
    expect(isEntryPoint(b, pathToFileURL(a).href)).toBe(false);
    expect(isEntryPoint(join(d, "missing.js"), pathToFileURL(a).href)).toBe(false);
    expect(isEntryPoint(undefined, pathToFileURL(a).href)).toBe(false);
    expect(isEntryPoint("", pathToFileURL(a).href)).toBe(false);
    expect(isEntryPoint(a, "https://example.invalid/a.js")).toBe(false);
  });
});