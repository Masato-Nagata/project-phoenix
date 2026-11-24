// Task 4.6 W5-B: the Run_Manifest assembly port (`src/orchestrator/manifestPort.ts`) and the start-state cell. Deterministic and offline.
// SYNTHETIC inputs only (test/support/manifestPortWorld.ts): synthetic lease facts, launcher facts (version 2, kind fixture), runtime version
// facts and start-state identity, read from memory. A passing test says the assembly checks and composes its inputs; it is no evidence of a
// real Run, a real audit configuration, or a mutual exclusion that held in a real environment.
// **Validates: Requirements 12.13, 15.12, 19.3, 22.1, 22.3, 24.2, 24.16**
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createSchemaValidator } from "../src/schema/index.js";
import { RUN_ID_PATTERN } from "../src/isolation/attestation.js";
import { verifyGroundTruthAccessDenial } from "../src/isolation/index.js";
import { createManifestPort, createStartStateCell, isStartStateCell } from "../src/orchestrator/manifestPort.js";
import { createLauncherFactsSnapshot } from "../src/runtimeFacts/launcherFacts.js";
import { ALLOWED, makeDeps } from "./support/isolationFakes.js";
import { AUDIT_SHA, H, IDENTITY, IMAGE_ID, NONCE, OTHER_RUN_ID, PID, RUN_ID, buildError, launcherText, leaseText, makeWorld, sha, type Any } from "./support/manifestPortWorld.js";

const CANARY = "canary-secret-value-w5b";
const validator = createSchemaValidator();
const sealedForm = (m: Record<string, unknown>): Record<string, unknown> => ({ schemaVersion: 2, ...m, chain: { records: 1, lastHash: H("6") }, artifacts: [] });
const code = (port: Any, core: Any): string | undefined => buildError(port, core)?.replace(/^manifest_port:/, "");

describe("build: the normal case", () => {
  it("assembles a schema-valid version-2 Run_Manifest body from the core and the closure, without schemaVersion, chain or artifacts", async () => {
    const w = await makeWorld();
    const out = w.port().build(w.core()) as Record<string, Any>;
    for (const k of ["schemaVersion", "chain", "artifacts"]) expect(k in out, k).toBe(false);
    const r = validator.validate("run-manifest", sealedForm(out) as never);
    expect(r.ok ? [] : r.error).toEqual([]);
    expect(out["payload_audit"]).toEqual({ configCheck: "pass", audits: 2, passed: 2, blocked: 0, auditConfigSha256: AUDIT_SHA, auditConfigKind: "fixture", auditConfigKindDeclaredBy: "launcher" });
    expect(out["legacyStartState"]).toEqual({ identity: IDENTITY });
    expect(out["toolVersions"]).toEqual({ node: "1.2.3", npm: "9.8.7", dependencies: { "a-lib": "1.0.0" }, runtimeImageDigest: IMAGE_ID });
    expect(out["mutualExclusion"]).toEqual({ mode: "mechanical", lease: { nonceSha256: sha(NONCE), launcherPid: PID, heartbeatIntervalMs: 1000, staleAfterMs: 4000 } });
    expect(out["provider"]).toEqual({ id: "mock", version: "1", model: "not_applicable", isMock: true });
    expect(out["aiSandbox"]).toEqual({ safetyStatus: "not_applicable", permittedDestinations: [] });
    expect(out["envVarsRead"]).toEqual([{ name: "EXAMPLE_ONE", set: true }]);
    expect(out["sourceBundle"]).toMatchObject({ schemaVersion: 1, files: [{ path: "legacy/src/a.php", sha256Lf: H("b") }] });
    expect(out["runId"]).toBe(RUN_ID);
    expect((out["config"] as Any).policyConfigSha256).toBe(H("1"));
  });

  it("the kiro-cli form (sandbox applicable, UNVERIFIED) is assembled with its own provider identity", async () => {
    const w = await makeWorld();
    const ctx = w.ctx({ configuredProvider: "kiro-cli", sandbox: { applicable: true, destinations: ["relay.example.invalid"] } });
    const p = createManifestPort(ctx);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const out = p.value.build(
      w.core({ provider: { id: "kiro-cli", version: "1.2.3", model: "test-model", isMock: false }, effectiveConfig: { schemaVersion: 1, provider: "kiro-cli", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames: [] } }),
    ) as Record<string, Any>;
    expect(out["aiSandbox"]).toEqual({ safetyStatus: "UNVERIFIED", permittedDestinations: ["relay.example.invalid"] });
    expect(out["provider"].isMock).toBe(false);
    expect(validator.validate("run-manifest", sealedForm(out) as never).ok).toBe(true);
  });

  it("builds once: a second call is refused, also after a failure, and nothing is retried", async () => {
    const w = await makeWorld();
    const port = w.port();
    expect(code(port, w.core())).toBeUndefined();
    expect(code(port, w.core())).toBe("build_already_called");
    const failed = (await makeWorld()).port();
    const w2 = await makeWorld();
    expect(code(failed, w2.core({ sourceBundleManifest: undefined }))).toBeDefined();
    expect(code(failed, w2.core())).toBe("build_already_called");
  });
});

describe("build: every refusal is a closed code and nothing is filled in", () => {
  const cases: Array<[string, string, (w: Any) => { port?: Any; core: Any }]> = [
    ["an extra core key", "core_invalid", (w) => ({ core: { ...w.core(), legacyStartState: {} } })],
    ["a missing core key", "core_invalid", (w) => {
      const c = { ...w.core() };
      delete c.payloadAudit;
      return { core: c };
    }],
    ["a copied access-denial result (no brand)", "access_denial_not_issued", (w) => ({ core: w.core({ accessDenial: { ...w.accessDenial } }) })],
    ["no Source_Bundle", "source_bundle_missing", (w) => {
      const c = { ...w.core() };
      delete c.sourceBundleManifest;
      return { core: c };
    }],
    ["an invalid Source_Bundle", "source_bundle_invalid", (w) => ({ core: w.core({ sourceBundleManifest: { files: [] } }) })],
    ["another run id in the core", "run_id_mismatch", (w) => ({ core: w.core({ runId: OTHER_RUN_ID }) })],
    ["an audit configuration hash that is not the one the runtime measured", "audit_config_sha256_mismatch", (w) => ({ core: w.core({ payloadAudit: { configCheck: "pass", audits: 2, passed: 2, blocked: 0, auditConfigSha256: H("9") } }) })],
    ["a heartbeat interval that is not the lease's", "lease_timing_mismatch", (w) => ({ core: w.core({ leaseFacts: { heartbeatIntervalMs: 999, staleAfterMs: 4000, propagationDelayMs: 40 } }) })],
    ["a stale limit that is not the lease's", "lease_timing_mismatch", (w) => ({ core: w.core({ leaseFacts: { heartbeatIntervalMs: 1000, staleAfterMs: 5000, propagationDelayMs: 40 } }) })],
    ["an isMock flag that disagrees with the configured provider", "provider_mock_flag_mismatch", (w) => ({ core: w.core({ provider: { id: "mock", version: "1", model: "not_applicable", isMock: false } }) })],
    ["a provider identity filled with unknown", "provider_invalid:identity_unknown", (w) => ({ core: w.core({ provider: { id: "mock", version: "unknown", model: "not_applicable", isMock: true } }) })],
    ["a configured provider that is not the effective one", "configured_provider_mismatch", (w) => ({ core: w.core({ effectiveConfig: { ...w.core().effectiveConfig, provider: "kiro-cli" } }) })],
    ["an envVarsRead entry that the existing builder refuses", "env_vars_read_invalid:name_invalid", (w) => ({ core: w.core({ envVarsRead: [{ name: "bad name", set: true }] }) })],
    ["an invalid payload audit", "payload_audit_invalid", (w) => ({ core: w.core({ payloadAudit: { configCheck: "maybe", audits: 2, passed: 2, blocked: 0, auditConfigSha256: AUDIT_SHA } }) })],
  ];
  for (const [label, expected, make] of cases) {
    it(`${label}: ${expected}`, async () => {
      const w = await makeWorld();
      const { core } = make(w);
      const msg = buildError(w.port(), core);
      expect(msg).toBe(`manifest_port:${expected}`);
    });
  }

  it("an access-denial result of another Run (branded, other run id) is refused", async () => {
    const w = await makeWorld();
    const other = await verifyGroundTruthAccessDenial(makeDeps({ runId: OTHER_RUN_ID }).deps, { allowedEnvNames: ALLOWED });
    expect(code(w.port(), w.core({ accessDenial: other }))).toBe("run_id_mismatch");
  });

  it("a lease.json that changed before the seal is refused (re-read)", async () => {
    const w = await makeWorld();
    const port = w.port();
    w.files.lease = leaseText({ launcher_pid: 4343 });
    expect(code(port, w.core())).toBe("lease_facts_unconfirmed:lease_json_changed");
  });

  it("launcher facts that changed before the seal are refused (re-read)", async () => {
    const w = await makeWorld();
    const port = w.port();
    w.files.launcher = launcherText({ runtime_image_id: `sha256:${sha("another-image")}` });
    expect(code(port, w.core())).toBe("launcher_facts_unconfirmed:facts_changed");
  });

  it("launcher facts that became unreadable or version 1 before the seal are refused", async () => {
    const w = await makeWorld();
    const port = w.port();
    w.files.launcher = JSON.stringify({ schema_version: 1, issued_by: "launcher", run_id: RUN_ID, runtime_image_id: IMAGE_ID, audit_config_sha256: AUDIT_SHA });
    expect(code(port, w.core())).toBe("launcher_facts_unconfirmed:facts_changed");
  });

  it("runtime versions that changed before the seal are refused (re-collected and compared)", async () => {
    const w = await makeWorld();
    const port = w.port();
    w.files.node = "1.2.4";
    expect(code(port, w.core())).toBe("runtime_versions_changed");
    const w2 = await makeWorld();
    const port2 = w2.port();
    w2.files.declared = JSON.stringify({ dependencies: { "a-lib": "1.0.1" } });
    w2.files.installed["a-lib"] = JSON.stringify({ name: "a-lib", version: "1.0.1" });
    expect(code(port2, w2.core())).toBe("runtime_versions_changed");
    const w3 = await makeWorld();
    const port3 = w3.port();
    delete w3.files.installed["a-lib"];
    expect(code(port3, w3.core())).toBe("runtime_versions_unavailable:installed_read_absent");
  });

  it("an unmeasured, failed or invalid start state is refused", async () => {
    const un = await makeWorld({ measure: false });
    expect(code(un.port(), un.core())).toBe("start_state_unmeasured");
    const failed = await makeWorld({ measure: false });
    expect(failed.cell.set(RUN_ID, { ok: false, code: "timeout" }).ok).toBe(true);
    expect(code(failed.port(), failed.core())).toBe("start_state_failed");
    const bad = await makeWorld({ measure: false });
    expect(bad.cell.set(RUN_ID, { ok: true, identity: "x" })).toEqual({ ok: false, error: { code: "result_invalid" } });
    expect(code(bad.port(), bad.core())).toBe("start_state_invalid");
    const wrongRun = await makeWorld({ measure: false });
    expect(wrongRun.cell.set(OTHER_RUN_ID, { ok: true, identity: IDENTITY })).toEqual({ ok: false, error: { code: "run_id_mismatch" } });
    expect(code(wrongRun.port(), wrongRun.core())).toBe("start_state_invalid");
  });

  it("never runs a getter of the core, and a core with an accessor is refused", async () => {
    const w = await makeWorld();
    let ran = false;
    const c: Any = { ...w.core() };
    delete c.runId;
    Object.defineProperty(c, "runId", { enumerable: true, get: () => ((ran = true), RUN_ID) });
    expect(code(w.port(), c)).toBe("core_invalid");
    expect(ran).toBe(false);
  });

  it("does not change the core", async () => {
    const w = await makeWorld();
    const core = w.core();
    const before = JSON.stringify(core);
    w.port().build(core);
    expect(JSON.stringify(core)).toBe(before);
  });

  it("an error carries no value, path or text: only the closed code", async () => {
    process.env["PHOENIX_TEST_CANARY_W5B"] = CANARY;
    try {
      const w = await makeWorld();
      const port = w.port();
      w.files.launcher = launcherText({ runtime_image_id: CANARY });
      const msg = buildError(port, w.core({ envVarsRead: [{ name: CANARY, set: true }] })) as string;
      expect(msg).toMatch(/^manifest_port:[a-z_:]+$/);
      expect(msg).not.toContain(CANARY);
    } finally {
      delete process.env["PHOENIX_TEST_CANARY_W5B"];
    }
  });
});

describe("createManifestPort: the context of one Run", () => {
  it("refuses a context that is not a plain object or has other keys", async () => {
    const w = await makeWorld();
    for (const bad of [undefined, null, [], "x"]) expect(createManifestPort(bad)).toEqual({ ok: false, error: { code: "context_not_plain_object" } });
    expect(createManifestPort({ ...w.ctx(), extra: 1 })).toEqual({ ok: false, error: { code: "context_keys" } });
    const c = w.ctx();
    delete c.sandbox;
    expect(createManifestPort(c)).toEqual({ ok: false, error: { code: "context_keys" } });
  });

  it("refuses a bad run id, a cell of another Run or a forged cell", async () => {
    const w = await makeWorld();
    expect(createManifestPort(w.ctx({ runId: "run-1" }))).toEqual({ ok: false, error: { code: "run_id_invalid" } });
    const other = createStartStateCell(OTHER_RUN_ID);
    if (!other.ok) throw new Error("setup");
    expect(createManifestPort(w.ctx({ startStateCell: other.value }))).toEqual({ ok: false, error: { code: "start_state_cell_invalid" } });
    expect(createManifestPort(w.ctx({ startStateCell: { ...w.cell } }))).toEqual({ ok: false, error: { code: "start_state_cell_invalid" } });
    expect(createManifestPort(w.ctx({ startStateCell: { runId: RUN_ID, set: () => ({ ok: true, value: true }) } }))).toEqual({ ok: false, error: { code: "start_state_cell_invalid" } });
  });

  it("refuses lease or launcher facts that are not issued snapshots of this Run", async () => {
    const w = await makeWorld();
    const c = w.ctx();
    expect(createManifestPort(w.ctx({ lease: { ...c.lease, start: { ...c.lease.start } } }))).toEqual({ ok: false, error: { code: "lease_context_invalid" } });
    expect(createManifestPort(w.ctx({ lease: { ...c.lease, expectation: { ...c.lease.expectation, runId: OTHER_RUN_ID } } }))).toEqual({ ok: false, error: { code: "lease_context_invalid" } });
    const foreign = createLauncherFactsSnapshot(launcherText({ run_id: OTHER_RUN_ID }), { runId: OTHER_RUN_ID, auditConfigSha256: AUDIT_SHA });
    if (!foreign.ok) throw new Error("setup");
    expect(createManifestPort(w.ctx({ launcher: { ...c.launcher, start: foreign.value } }))).toEqual({ ok: false, error: { code: "launcher_context_invalid" } });
    expect(createManifestPort(w.ctx({ launcher: { ...c.launcher, port: {} } }))).toEqual({ ok: false, error: { code: "launcher_context_invalid" } });
  });

  it("refuses bad version facts, an unknown configured provider and sandbox facts that disagree with the provider", async () => {
    const w = await makeWorld();
    const c = w.ctx();
    expect(createManifestPort(w.ctx({ versions: { ...c.versions, start: { node: "1.2.3" } } }))).toEqual({ ok: false, error: { code: "versions_context_invalid" } });
    expect(createManifestPort(w.ctx({ configuredProvider: "other" }))).toEqual({ ok: false, error: { code: "configured_provider_invalid" } });
    expect(createManifestPort(w.ctx({ sandbox: { applicable: true, destinations: ["x.invalid"] } }))).toEqual({ ok: false, error: { code: "sandbox_invalid" } });
  });
});

describe("the start-state cell", () => {
  it("is issued per Run for a valid run id only, frozen, and recognized by its brand only", () => {
    expect(createStartStateCell("run-1")).toEqual({ ok: false, error: { code: "run_id_invalid" } });
    const a = createStartStateCell(RUN_ID);
    const b = createStartStateCell(RUN_ID);
    if (!a.ok || !b.ok) throw new Error("setup");
    expect(a.value).not.toBe(b.value);
    expect(Object.isFrozen(a.value)).toBe(true);
    expect(isStartStateCell(a.value)).toBe(true);
    for (const fake of [{ ...a.value }, Object.create(a.value), null, {}]) expect(isStartStateCell(fake)).toBe(false);
  });

  it("takes exactly one write, a success or a failure; a second write is refused", () => {
    const a = createStartStateCell(RUN_ID);
    if (!a.ok) throw new Error("setup");
    expect(a.value.set(RUN_ID, { ok: false, code: "lease_unavailable", leaseReason: "heartbeat_stale" })).toEqual({ ok: true, value: true });
    expect(a.value.set(RUN_ID, { ok: true, identity: IDENTITY })).toEqual({ ok: false, error: { code: "already_written" } });
  });

  it("refuses results of the wrong form, and a refused write closes the cell", () => {
    const bad: unknown[] = [
      undefined, null, "x", { ok: true }, { ok: true, identity: IDENTITY.toUpperCase() }, { ok: true, identity: `sha256:${IDENTITY}` },
      { ok: true, identity: IDENTITY, extra: 1 }, { ok: false }, { ok: false, code: "Has Space" }, { ok: false, code: "x", leaseReason: 1 }, { ok: "true", identity: IDENTITY },
    ];
    for (const r of bad) {
      const c = createStartStateCell(RUN_ID);
      if (!c.ok) throw new Error("setup");
      expect(c.value.set(RUN_ID, r), JSON.stringify(r)).toEqual({ ok: false, error: { code: "result_invalid" } });
      expect(c.value.set(RUN_ID, { ok: true, identity: IDENTITY })).toEqual({ ok: false, error: { code: "already_written" } });
    }
  });

  it("keeps its own copy: changing the written object later does not change what the port reads", async () => {
    const w = await makeWorld({ measure: false });
    const result: Any = { ok: true, identity: IDENTITY };
    expect(w.cell.set(RUN_ID, result).ok).toBe(true);
    result.identity = H("f");
    const out = w.port().build(w.core()) as Record<string, Any>;
    expect(out["legacyStartState"]).toEqual({ identity: IDENTITY });
  });

  it("never runs a getter of a result", () => {
    const c = createStartStateCell(RUN_ID);
    if (!c.ok) throw new Error("setup");
    let ran = false;
    const r = { ok: true };
    Object.defineProperty(r, "identity", { enumerable: true, get: () => ((ran = true), IDENTITY) });
    expect(c.value.set(RUN_ID, r)).toEqual({ ok: false, error: { code: "result_invalid" } });
    expect(ran).toBe(false);
  });
});

describe("pins and boundaries", () => {
  const src = readFileSync(new URL("../src/orchestrator/manifestPort.ts", import.meta.url), "utf8");
  it("the run id format equals the one of the isolation module", () => {
    expect(src).toContain(`const RUN_ID = /${RUN_ID_PATTERN.source}/;`);
  });
  it("the module is not exported from the package entry", () => {
    expect(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")).not.toMatch(/manifestPort/);
  });
  it("ManifestCore and ManifestPayloadAudit are not touched by W5 (no kind there)", () => {
    const types = readFileSync(new URL("../src/orchestrator/types.ts", import.meta.url), "utf8");
    expect(types).not.toMatch(/auditConfigKind|legacyStartState:|startState/);
  });
});
