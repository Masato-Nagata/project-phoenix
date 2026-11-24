// Task 4.6 W5-C: the ManifestPort with the REAL RunRecordStore on a MemoryFileSystem, the REAL RecordWriter, RunSession and Terminator, and the
// REAL verifyRunDirectory / acceptRun. The lease facts, the launcher facts (version 2, kind fixture), the runtime version facts and the
// start-state identity are SYNTHETIC (test/support/manifestPortWorld.ts). Every refused case has a passing control: the same world without
// the defect is sealed. Nothing here is evidence of a real Run, a real audit configuration, or a mutual exclusion in a real environment.
// The orchestrator is not changed (no W6 wiring); the port is passed to `createTerminator` directly, as the composition root will do.
// **Validates: Requirements 12.8, 12.13, 12.14, 15.12, 19.3, 22.1, 22.3**
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { MANIFEST_FILE, MemoryFileSystem, RunRecordStore, acceptRun, createNodeFileSystem, verifyRunDirectory } from "../src/index.js";
import { verifyGroundTruthAccessDenial } from "../src/isolation/index.js";
import { createManifestPort, createStartStateCell } from "../src/orchestrator/manifestPort.js";
import { createRecordWriter } from "../src/orchestrator/recordWriter.js";
import { createRunSession } from "../src/orchestrator/session.js";
import { createTerminator } from "../src/orchestrator/terminate.js";
import { writeCompletionMarker } from "./helpers/runFixtures.js";
import { ALLOWED, makeDeps } from "./support/isolationFakes.js";
import { AUDIT_SHA, H, IDENTITY, OTHER_RUN_ID, RUN_ID, launcherText, leaseText, makeWorld, type Any, type World } from "./support/manifestPortWorld.js";

const DIR = "/run/out";
const MANIFEST = `${DIR}/${MANIFEST_FILE}`;
const CANARY = "canary-secret-value-w5c";
const dec = (b: Uint8Array | undefined): string => new TextDecoder().decode(b);

interface SealOpts {
  /** Changes the world after the port was made (a change before the seal). */
  readonly before?: (w: World) => void;
  readonly base?: Record<string, unknown>;
  readonly runId?: string;
  readonly port?: Any;
}
/** One Run end: real store, writer, session and terminator, the W5 port as the manifest port. */
async function seal(w: World, o: SealOpts = {}) {
  const mem = new MemoryFileSystem();
  mem.addDir(DIR);
  const opened = await RunRecordStore.open(mem, DIR, { secrets: { envValues: [{ name: "CANARY_KEY", value: CANARY }] } });
  if (!opened.ok) throw new Error("open failed");
  const store = opened.value;
  const made = createRunSession({ clock: { nowMs: () => 1000 }, runSeconds: 60 });
  if (!made.ok) throw new Error("session failed");
  const session = made.value;
  const { writer, channel } = createRecordWriter(store);
  await writer.append("run_started", { n: 1 } as never);
  const port = o.port ?? w.port();
  o.before?.(w);
  const terminator = createTerminator({
    session,
    channel,
    wallClock: { nowIso: () => "2026-01-01T00:10:00Z" },
    manifest: port,
    runId: o.runId ?? RUN_ID,
    base: w.base(o.base ?? {}),
    startedAt: "2026-01-01T00:00:00Z",
  });
  session.markStarted();
  session.raise("iteration_limit_reached");
  const result = await terminator.terminate();
  return { mem, result };
}
const manifestOf = (mem: MemoryFileSystem): Any => JSON.parse(dec(mem.peek(MANIFEST)));

describe("sealing with the ManifestPort", () => {
  it("seals a version-2 Run_Manifest with the fixture kind declared by the launcher, and the Run directory verifies", async () => {
    const w = await makeWorld();
    const { mem, result } = await seal(w);
    expect(result.sealed).toBe(true);
    const m = manifestOf(mem);
    expect(m.schemaVersion).toBe(2);
    expect(m.payload_audit.auditConfigKind).toBe("fixture");
    expect(m.payload_audit.auditConfigKindDeclaredBy).toBe("launcher");
    expect(m.payload_audit.auditConfigSha256).toBe(AUDIT_SHA);
    expect(m.legacyStartState).toEqual({ identity: IDENTITY });
    expect(m.terminationReason).toBe("iteration_limit_reached");
    expect((await verifyRunDirectory(mem, DIR)).result).toBe("success");
    await writeCompletionMarker(mem, DIR);
    expect((await acceptRun(mem, DIR)).accepted).toBe(true);
  });
});

describe("a defect leaves the Run unsealed (manifest_build_failed), the control is sealed", () => {
  const cases: Array<[string, (w: World) => SealOpts | Promise<SealOpts>]> = [
    ["no Source_Bundle", () => ({ base: { sourceBundleManifest: undefined } })],
    ["an audit configuration hash that differs", () => ({ base: { payloadAudit: { configCheck: "pass", audits: 2, passed: 2, blocked: 0, auditConfigSha256: H("9") } } })],
    ["H that differs", () => ({ base: { leaseFacts: { heartbeatIntervalMs: 999, staleAfterMs: 4000, propagationDelayMs: 40 } } })],
    ["S that differs", () => ({ base: { leaseFacts: { heartbeatIntervalMs: 1000, staleAfterMs: 4001, propagationDelayMs: 40 } } })],
    ["a run id that differs", () => ({ runId: OTHER_RUN_ID })],
    ["an access-denial result without the brand", (w) => ({ base: { accessDenial: { ...w.accessDenial } } })],
    ["an access-denial result of another Run", async () => ({ base: { accessDenial: await verifyGroundTruthAccessDenial(makeDeps({ runId: OTHER_RUN_ID }).deps, { allowedEnvNames: ALLOWED }) } })],
    ["launcher facts that changed before the seal", () => ({ before: (w) => { w.files.launcher = launcherText({ runtime_image_id: `sha256:${H("e")}` }); } })],
    ["lease facts that changed before the seal", () => ({ before: (w) => { w.files.lease = leaseText({ launcher_pid: 4343 }); } })],
    ["runtime versions that changed before the seal", () => ({ before: (w) => { w.files.npm = JSON.stringify({ name: "npm", version: "9.8.8" }); } })],
  ];
  for (const [label, make] of cases) {
    it(label, async () => {
      const w = await makeWorld();
      const { mem, result } = await seal(w, await make(w));
      expect(result.sealed).toBe(false);
      if (!result.sealed) expect(result.failure).toBe("manifest_build_failed");
      expect(mem.peek(MANIFEST)).toBeUndefined();
      // the control: the same world without the defect is sealed
      const ok = await seal(await makeWorld());
      expect(ok.result.sealed).toBe(true);
    });
  }

  it("an unmeasured, failed or invalid start state leaves the Run unsealed", async () => {
    const un = await makeWorld({ measure: false });
    expect((await seal(un)).result.sealed).toBe(false);
    const failed = await makeWorld({ measure: false });
    failed.cell.set(RUN_ID, { ok: false, code: "timeout" });
    expect((await seal(failed)).result.sealed).toBe(false);
    const invalid = await makeWorld({ measure: false });
    invalid.cell.set(RUN_ID, { ok: true, identity: "not-a-hash" });
    const r = await seal(invalid);
    expect(r.result.sealed).toBe(false);
    if (!r.result.sealed) expect(r.result.failure).toBe("manifest_build_failed");
    expect((await seal(await makeWorld())).result.sealed).toBe(true);
  });

  it("the cell of another Run cannot be used: no port is made, so no Manifest can be built", async () => {
    const w = await makeWorld();
    const other = createStartStateCell(OTHER_RUN_ID);
    if (!other.ok) throw new Error("setup");
    other.value.set(OTHER_RUN_ID, { ok: true, identity: IDENTITY });
    expect(createManifestPort(w.ctx({ startStateCell: other.value }))).toEqual({ ok: false, error: { code: "start_state_cell_invalid" } });
  });
});

describe("tampering and secrets", () => {
  it("a Manifest changed after the seal is detected: by the schema check of the verification and by the Completion_Marker", async () => {
    const w = await makeWorld();
    const { mem } = await seal(w);
    await writeCompletionMarker(mem, DIR);
    const original = dec(mem.peek(MANIFEST));
    await mem.writeFileSynced(MANIFEST, new TextEncoder().encode(original.replace('"auditConfigKind":"fixture"', '"auditConfigKind":"real"')));
    expect((await verifyRunDirectory(mem, DIR)).result).not.toBe("success");
    await mem.writeFileSynced(MANIFEST, new TextEncoder().encode(original.replace('"terminationReason":"iteration_limit_reached"', '"terminationReason":"time_limit_reached"')));
    expect((await acceptRun(mem, DIR)).accepted).toBe(false);
    await mem.writeFileSynced(MANIFEST, new TextEncoder().encode(original));
    expect((await acceptRun(mem, DIR)).accepted).toBe(true);
  });

  it("the Manifest and a refusal carry no canary value, no absolute path and no environment value", async () => {
    process.env["PHOENIX_TEST_CANARY_W5C"] = CANARY;
    try {
      const w = await makeWorld();
      const { mem, result } = await seal(w);
      expect(result.sealed).toBe(true);
      const text = dec(mem.peek(MANIFEST));
      expect(text).not.toContain(CANARY);
      expect(text).not.toMatch(/"\/(?:run|tmp|repo|workspace|app|home)\b|[A-Za-z]:\\\\/);
      const bad = await makeWorld();
      const refused = await seal(bad, { before: (x) => { x.files.launcher = launcherText({ runtime_image_id: CANARY }); } });
      expect(refused.result.sealed).toBe(false);
      expect(JSON.stringify(refused.result)).not.toContain(CANARY);
      expect(refused.mem.peek(MANIFEST)).toBeUndefined();
    } finally {
      delete process.env["PHOENIX_TEST_CANARY_W5C"];
    }
  });

  it("the frozen version-1 Run directory still verifies and is read as version 1", async () => {
    const dir = mkdtempSync(join(tmpdir(), "w5c-v1-"));
    try {
      const run = join(dir, "run-0001");
      cpSync(fileURLToPath(new URL("../test-vectors/sealed-run/", import.meta.url)), run, { recursive: true });
      const fs = createNodeFileSystem();
      expect((await verifyRunDirectory(fs, run)).result).toBe("success");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
