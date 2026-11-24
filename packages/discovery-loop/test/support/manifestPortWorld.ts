// Test support for task 4.6 W5 (the ManifestPort): ONE synthetic Run world. Every value below is SYNTHETIC: the lease facts, the launcher facts
// (version 2, kind `fixture`), the runtime version facts and the start-state identity are made up, and the read ports answer from memory.
// No file is read, no real lease or launcher file exists, and nothing here is evidence of a real Run, of a real audit configuration, or of
// a mutual exclusion that held in a real environment.
import { createHash } from "node:crypto";
import { verifyGroundTruthAccessDenial } from "../../src/isolation/index.js";
import { createManifestPort, createStartStateCell, type ManifestPortContext, type StartStateCell } from "../../src/orchestrator/manifestPort.js";
import type { ManifestCore } from "../../src/orchestrator/types.js";
import { createLauncherFactsSnapshot } from "../../src/runtimeFacts/launcherFacts.js";
import { createLeaseFactsSnapshot } from "../../src/runtimeFacts/leaseFacts.js";
import { collectRuntimeVersionFacts, type PackageJsonReadAnswer, type RuntimeVersionReadPort } from "../../src/runtimeFacts/versionFacts.js";
import { ALLOWED, RUN_ID, makeDeps } from "./isolationFakes.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;
export const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
export const H = (c: string): string => c.repeat(64);
export { RUN_ID };
export const OTHER_RUN_ID = "run-20261114T024339Z-000000000000";
export const NONCE = "synthetic-nonce-w5";
export const AUDIT_SHA = sha("synthetic-audit-config-w5");
export const IMAGE_ID = `sha256:${sha("synthetic-image-w5")}`;
export const IDENTITY = sha("synthetic-start-state-w5");
export const HB = 1000;
export const STALE = 4000;
export const PID = 4242;

export const leaseText = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({ heartbeat_interval_ms: HB, issued_by: "launcher", launcher_pid: PID, launcher_start_ticks: "630000000000000000", nonce_sha256: sha(NONCE), run_id: RUN_ID, stale_after_ms: STALE, ...o });
export const launcherText = (o: Record<string, unknown> = {}): string =>
  JSON.stringify({ schema_version: 2, issued_by: "launcher", run_id: RUN_ID, runtime_image_id: IMAGE_ID, audit_config_sha256: AUDIT_SHA, audit_config_kind: "fixture", ...o });
const pkg = (o: Record<string, unknown>): string => JSON.stringify(o);

/** What the fake read ports answer. A test changes it after the start-up snapshots were taken, to simulate a change before the seal. */
export interface Files {
  lease: string;
  launcher: string;
  node: string;
  npm: string;
  declared: string;
  installed: Record<string, string>;
}

export interface World {
  readonly files: Files;
  readonly cell: StartStateCell;
  readonly accessDenial: Any;
  readonly leasePort: { readLeaseJson(): { kind: "ok"; text: string } };
  readonly launcherPort: { readLauncherFacts(): { kind: "ok"; text: string } };
  readonly versionPort: RuntimeVersionReadPort;
  /** A fresh context object for `createManifestPort`. */
  ctx(over?: Partial<Record<keyof ManifestPortContext, unknown>>): Any;
  /** The core fields that `createTerminator` takes as `base` (everything but runId, terminationReason, limitsUsed and wallClock). */
  base(over?: Record<string, unknown>): Any;
  /** A whole ManifestCore, as `terminate()` builds it. */
  core(over?: Record<string, unknown>): ManifestCore;
  /** The port of this world, built from `ctx()`; throws if the context is refused. */
  port(): ReturnType<typeof createManifestPort> extends { ok: true; value: infer P } ? P : never;
}

/** One Run world. `measure: true` (the default) writes the successful start-state measurement into the cell. */
export async function makeWorld(o: { measure?: boolean } = {}): Promise<World> {
  const files: Files = {
    lease: leaseText(),
    launcher: launcherText(),
    node: "1.2.3",
    npm: pkg({ name: "npm", version: "9.8.7" }),
    declared: pkg({ name: "runner", dependencies: { "a-lib": "1.0.0", "@phoenix/inner": "*" } }),
    installed: { "a-lib": pkg({ name: "a-lib", version: "1.0.0" }) },
  };
  const ok = (text: string): { kind: "ok"; text: string } => ({ kind: "ok", text });
  const leasePort = { readLeaseJson: () => ok(files.lease) };
  const launcherPort = { readLauncherFacts: () => ok(files.launcher) };
  const versionPort: RuntimeVersionReadPort = {
    readNodeVersion: () => files.node,
    readNpmPackageJson: (): PackageJsonReadAnswer => ok(files.npm),
    readDeclaredPackageJson: (): PackageJsonReadAnswer => ok(files.declared),
    readInstalledPackageJson: (name: string): PackageJsonReadAnswer => (files.installed[name] === undefined ? { kind: "absent" } : ok(files.installed[name] as string)),
  };
  const leaseExpectation = { runId: RUN_ID, nonce: NONCE, heartbeatIntervalMs: HB, staleAfterMs: STALE };
  const leaseStart = createLeaseFactsSnapshot(files.lease, leaseExpectation);
  const launcherExpectation = { runId: RUN_ID, auditConfigSha256: AUDIT_SHA };
  const launcherStart = createLauncherFactsSnapshot(files.launcher, launcherExpectation);
  const versionStart = collectRuntimeVersionFacts(versionPort);
  const cellMade = createStartStateCell(RUN_ID);
  if (!leaseStart.ok || !launcherStart.ok || !versionStart.ok || !cellMade.ok) throw new Error("test setup: world");
  const cell = cellMade.value;
  if (o.measure !== false) {
    const w = cell.set(RUN_ID, { ok: true, identity: IDENTITY });
    if (!w.ok) throw new Error("test setup: cell");
  }
  const accessDenial = await verifyGroundTruthAccessDenial(makeDeps().deps, { allowedEnvNames: ALLOWED });

  const ctx = (over: Partial<Record<keyof ManifestPortContext, unknown>> = {}): Any => ({
    runId: RUN_ID,
    startStateCell: cell,
    lease: { port: leasePort, expectation: leaseExpectation, start: leaseStart.value },
    launcher: { port: launcherPort, expectation: launcherExpectation, start: launcherStart.value },
    versions: { port: versionPort, start: versionStart.value },
    sandbox: { applicable: false },
    configuredProvider: "mock",
    ...over,
  });
  const base = (over: Record<string, unknown> = {}): Any => ({
    finalHypothesisRevision: "none",
    provider: { id: "mock", version: "1", model: "not_applicable", isMock: true },
    envVarsRead: [{ name: "EXAMPLE_ONE", set: true }],
    payloadAudit: { configCheck: "pass", audits: 2, passed: 2, blocked: 0, auditConfigSha256: AUDIT_SHA },
    accessDenial,
    configHashes: { policyConfigSha256: H("1"), preparationTableSha256: H("2") },
    leaseFacts: { heartbeatIntervalMs: HB, staleAfterMs: STALE, propagationDelayMs: 40 },
    sourceBundleManifest: { files: [{ path: "legacy/src/a.php", sha256Lf: H("b") }] },
    effectiveConfig: {
      schemaVersion: 1,
      provider: "mock",
      mockFixtureSet: "default-widget-v1",
      limits: { iterations: 1 },
      testApi: { baseAddress: "http://reverse-proxy:8080" },
      mask: { paths: [] },
      envNames: ["EXAMPLE_ONE"],
    },
    ...over,
  });
  const core = (over: Record<string, unknown> = {}): ManifestCore =>
    ({
      runId: RUN_ID,
      wallClock: { startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:10:00Z" },
      terminationReason: "iteration_limit_reached",
      limitsUsed: { iterations: 1, acceptedExperiments: 0, rejectedExperiments: 0 },
      ...base(),
      ...over,
    }) as ManifestCore;
  const port = (): Any => {
    const r = createManifestPort(ctx());
    if (!r.ok) throw new Error("test setup: port " + r.error.code);
    return r.value;
  };
  return { files, cell, accessDenial, leasePort, launcherPort, versionPort, ctx, base, core, port };
}

/** The error code of a `build` that threw, or `undefined` if it returned. */
export function buildError(port: { build(core: ManifestCore): unknown }, core: ManifestCore): string | undefined {
  try {
    port.build(core);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : "not an Error";
  }
}
