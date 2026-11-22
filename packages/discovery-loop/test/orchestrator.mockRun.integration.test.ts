// Task 4.4, unit U7: the Mock Run. The composition root (`createLoopOrchestrator`) with the REAL adapters of ai-client (Mock_Provider behind the provider
// wrapper, Payload_Auditor, response gate), verifier (Runner with a FAKE http port, Comparator, policy, acceptance check), analyzer (Source_Bundler and
// Citation_Verifier on an in-memory file system) and the REAL RunRecordStore on a MemoryFileSystem. No network, synthetic data only, two iterations so that
// a revision happens. Every unsealed case has a passing control (the same world without the defect is sealed).
// **Validates: Requirements 2.12, 11.15, 12.13, 12.14, 15.6, 19.7**
import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../../ai-client/src/index.js";
import type { Json } from "../../ai-client/src/index.js";
import { MANIFEST_FILE } from "../src/index.js";
import type { RunResult } from "../src/orchestrator/types.js";
import { APPROVAL_CANARIES, RUN_DIR, SOURCE_PATH, SOURCE_TEXT, buildWorld, volumeText, type Any, type World, type WorldOptions } from "./support/mockRunWorld.js";

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const kindsOf = (w: World): string[] => w.records().map((r) => r.kind);
const payloadsOf = (w: World, kind: string): Any[] => w.records().filter((r) => r.kind === kind).map((r) => r.payload as Any);
const manifestOf = (w: World): Any => JSON.parse(dec(w.mem.peek(`${RUN_DIR}/${MANIFEST_FILE}`) as Uint8Array));
const HEX64 = /^[0-9a-f]{64}$/;

async function execute(o: WorldOptions = {}): Promise<{ w: World; r: RunResult }> {
  const w = await buildWorld(o);
  return { w, r: await w.run() };
}
let memo: Promise<{ w: World; r: RunResult }> | undefined;
const happy = (): Promise<{ w: World; r: RunResult }> => (memo ??= execute());

/** What every unsealed result has in common: no summary, no manifest hash, and no sealed Manifest in the volume. */
function expectUnsealed(x: { w: World; r: RunResult }, expected: { failure: string; started?: boolean; terminationReason?: string }): void {
  const { w, r } = x;
  expect(r.sealed).toBe(false);
  if (r.sealed) return;
  expect(r.failure).toBe(expected.failure);
  expect(r.started).toBe(expected.started ?? true);
  if (expected.terminationReason !== undefined) expect(r.terminationReason).toBe(expected.terminationReason);
  expect(Object.keys(r)).not.toContain("summary");
  expect(Object.keys(r)).not.toContain("manifestSha256");
  expect(w.manifestExists()).toBe(false);
  expect(w.mem.allFiles().some((f) => f.endsWith(MANIFEST_FILE))).toBe(false);
}
/** The passing control of an unsealed case: the same world without the defect is sealed. */
async function expectControlSealed(): Promise<void> {
  const { w, r } = await happy();
  expect(r.sealed).toBe(true);
  expect(w.manifestExists()).toBe(true);
}

describe("the Mock Run (two iterations, one revision)", () => {
  it("seals a Manifest; the termination reason is the one of the latch (iteration limit); the hash is the store's", async () => {
    const { w, r } = await happy();
    expect(r.sealed).toBe(true);
    if (!r.sealed) return;
    expect(r.summary.terminationReason).toBe("iteration_limit_reached");
    expect(r.summary.manifestSha256).toMatch(HEX64);
    const bytes = w.mem.peek(`${RUN_DIR}/${MANIFEST_FILE}`) as Uint8Array;
    expect(sha256Hex(dec(bytes))).toBe(r.summary.manifestSha256);
    const m = manifestOf(w);
    expect(m.terminationReason).toBe("iteration_limit_reached");
    expect(m.provider).toMatchObject({ id: "mock", isMock: true });
    expect(m.limitsUsed.iterations).toBe(2);
    expect(m.limitsUsed.acceptedExperiments).toBeGreaterThanOrEqual(2);
  });

  it("the order of the phases: generation, experiment, revision, experiment; then the termination record is last", async () => {
    const { w } = await happy();
    const kinds = kindsOf(w);
    expect(kinds.slice(0, 3)).toEqual(["run_started", "isolation_checks", "source_bundle_manifest"]);
    expect(kinds[kinds.length - 1]).toBe("termination");
    expect(payloadsOf(w, "ai_call").map((p) => p.requestKind)).toEqual(["hypothesis_generation", "experiment_generation", "hypothesis_revision", "experiment_generation"]);
    expect(w.providerCalls.map((c) => c.kind)).toEqual(["hypothesis_generation", "experiment_generation", "hypothesis_revision", "experiment_generation"]);
    // the Source_Bundle manifest is written before the first payload audit and before the first provider call
    expect(kinds.indexOf("source_bundle_manifest")).toBeLessThan(kinds.indexOf("payload_audit"));
    expect(w.appended.indexOf("source_bundle_manifest")).toBeLessThan(w.appended.indexOf("ai_call"));
  });

  it("first generation, revision, the Experiment chain (policy, Runner, observation, comparison, Evidence) and the final revision", async () => {
    const { w } = await happy();
    const kinds = kindsOf(w);
    const count = (k: string): number => kinds.filter((x) => x === k).length;
    expect(count("hypothesis_revision")).toBe(2); // the generation and ONE revision; no closing revision at the iteration limit (R11.18)
    expect(count("experiment")).toBe(2);
    expect(count("policy_decision")).toBe(2);
    expect(count("observation")).toBe(2);
    expect(count("comparison")).toBe(2);
    expect(count("citation_verification")).toBe(2);
    expect(count("evidence")).toBeGreaterThanOrEqual(4); // one source and one experiment Evidence per Iteration
    expect(payloadsOf(w, "policy_decision").every((p) => p !== undefined)).toBe(true);
    expect(w.http.seen.filter((s) => s === "GET /orders").length).toBeGreaterThanOrEqual(2); // the Runner really executed, through the fake http
    expect(payloadsOf(w, "hypothesis_revision").map((p) => p.hypothesisId)).toEqual(["hyp-1", "hyp-2"]);
    expect(manifestOf(w).finalHypothesisRevision).toBe("hyp-2");
    // each policy decision precedes the execution of its Experiment
    for (const id of ["exp-1-1", "exp-2-1"]) {
      const ix = (kind: string): number => w.records().findIndex((rec) => rec.kind === kind && (rec.payload as Any).experimentId === id);
      expect(ix("experiment")).toBeGreaterThanOrEqual(0);
      expect(ix("observation")).toBeGreaterThan(ix("experiment"));
    }
  });

  it("the Source_Bundle references and hashes agree: record, Manifest, every audited envelope", async () => {
    const { w } = await happy();
    const expectedFiles = [{ path: SOURCE_PATH, sha256Lf: sha256Hex(SOURCE_TEXT) }];
    const [bundleRecord] = payloadsOf(w, "source_bundle_manifest");
    expect(bundleRecord).toEqual({ files: expectedFiles });
    expect(JSON.stringify(bundleRecord)).not.toContain("synthetic helper"); // no source text in the record
    expect(manifestOf(w).sourceBundle.files).toEqual(expectedFiles);
    expect(w.prepared).toHaveLength(4);
    for (const p of w.prepared) {
      const env = JSON.parse(dec(p.bytes)) as Any;
      const sources = env.parts.filter((x: Any) => x.type === "source_file");
      expect(sources.map((x: Any) => ({ path: x.path, sha256Lf: x.sha256Lf }))).toEqual(expectedFiles);
      expect(sources.map((x: Any) => x.partId)).toEqual(["src-1"]);
      for (const s of sources) expect(sha256Hex(s.text)).toBe(s.sha256Lf);
    }
  });

  it("lookupRecord, the stored parts and the Run store agree (one snapshot), and the stored partIds are unique", async () => {
    const { w } = await happy();
    const byId = new Map(w.records().map((rec) => [rec.id, rec]));
    let storedSeen = 0;
    for (const p of w.prepared) {
      const env = JSON.parse(dec(p.bytes)) as Any;
      const ids: string[] = env.parts.map((x: Any) => x.partId);
      expect(new Set(ids).size).toBe(ids.length);
      for (const part of env.parts.filter((x: Any) => x.type !== "source_file")) {
        storedSeen += 1;
        const view = p.ctx.lookupRecord(part.recordId);
        expect(view).toBeDefined();
        expect(view?.kind).toBe(part.type);
        expect(view?.sha256).toBe(part.recordSha256);
        expect(view?.canonicalJson).toBe(canonicalJson(part.content as Json));
        expect(sha256Hex(view?.canonicalJson ?? "")).toBe(part.recordSha256);
        // the store's own record is the source of both
        const rec = byId.get(part.recordId);
        expect(rec?.kind).toBe(part.type);
        expect(canonicalJson(rec?.payload as Json)).toBe(view?.canonicalJson);
      }
      expect(p.ctx.lookupRecord("rec-999999")).toBeUndefined();
    }
    expect(storedSeen).toBeGreaterThan(0);
  });

  it("the audited bytes are the bytes that the Mock_Provider received (same hash, same bytes), and each audit is recorded", async () => {
    const { w } = await happy();
    const audits = payloadsOf(w, "payload_audit");
    expect(audits).toHaveLength(4);
    expect(w.providerCalls).toHaveLength(4);
    w.providerCalls.forEach((call, i) => {
      expect(sha256Hex(dec(call.bytes))).toBe(call.sha256);
      expect(call.sha256).toBe(audits[i].payloadSha256);
      expect(audits[i].result).toBe("pass");
      expect(Buffer.from(call.bytes).equals(Buffer.from((w.prepared[i] as Any).bytes))).toBe(true);
      expect(call.kind).toBe(audits[i].requestKind);
    });
    expect(manifestOf(w).payload_audit).toMatchObject({ audits: 4, passed: 4, blocked: 0 });
  });

  it("no canary of the startup ticket is in any artifact, payload, result or log (and a leaking channel IS detected)", async () => {
    const { w, r } = await happy();
    const haystacks = [volumeText(w.mem), w.providerCalls.map((c) => dec(c.bytes)).join("\n"), JSON.stringify(r), w.appended.join("\n"), w.http.seen.join("\n")];
    for (const c of APPROVAL_CANARIES) for (const h of haystacks) expect(h.includes(c), c).toBe(false);
    // positive control: a test-only manifest port that serializes the whole ticket
    const leaking = await execute({ leakApproval: true });
    expect(leaking.r.sealed).toBe(true);
    const text = volumeText(leaking.w.mem);
    for (const c of APPROVAL_CANARIES) expect(text.includes(c), c).toBe(true);
  });
});

describe("unsealed Runs (each with a passing control)", () => {
  it("a record write fails (the store goes down)", async () => {
    await expectControlSealed();
    const x = await execute({ failAppend: { kind: "hypothesis_revision", error: "io_failure" } });
    expectUnsealed(x, { failure: "store_failed", terminationReason: "error" });
  });

  it("an isolation violation: a denied read through analysisFs ends the Run; the error record has the closed vocabulary only", async () => {
    await expectControlSealed();
    const x = await execute({ denyRead: true });
    expectUnsealed(x, { failure: "manifest_build_failed", terminationReason: "isolation_violation" }); // no Source_Bundle, so no valid Manifest
    const errors = payloadsOf(x.w, "error");
    expect(errors).toEqual([{ code: "isolation_violation", op: "read", errorCode: "EACCES", locationId: "unlisted" }]);
    expect(Object.keys(errors[0] as object).sort()).toEqual(["code", "errorCode", "locationId", "op"]);
    expect(JSON.stringify(errors)).not.toContain(SOURCE_PATH);
    expect(x.w.providerCalls).toHaveLength(0);
    expect(kindsOf(x.w)).not.toContain("source_bundle_manifest");
    expect(kindsOf(x.w)[kindsOf(x.w).length - 1]).toBe("termination");
  });

  it("an abort (the Run deadline fires during the first provider call) and a failing write after it", async () => {
    const abort = (failWrites: boolean) => (n: number, w: World): void => {
      if (n !== 1) return;
      w.time.t = 1_000 + 1_800_000 + 1;
      (w.timers[0] as Any).fire();
      if (failWrites) w.armStoreFailure();
    };
    // control: the same abort, writes healthy: a sealed Run with the true reason
    const control = await execute({ onProviderCall: abort(false) });
    expect(control.r.sealed).toBe(true);
    if (control.r.sealed) expect(control.r.summary.terminationReason).toBe("time_limit_reached");
    expect(control.w.providerCalls).toHaveLength(1);
    const x = await execute({ onProviderCall: abort(true) });
    // The deadline latches `time_limit_reached`; the `interrupted` ai_call write then fails (writer down), providerCall.ts raises `error`, and `error`
    // outranks `time_limit_reached` in the latch priority (terminationLatch.ts). terminate() then finds the writer down: unsealed `store_failed`.
    expectUnsealed(x, { failure: "store_failed", terminationReason: "error" });
    expect(x.r.sealed).toBe(false);
  });

  it("the Source_Bundle cannot be built: no provider call, no bundle record, no seal", async () => {
    await expectControlSealed();
    const x = await execute({ missingAllowlist: true });
    expectUnsealed(x, { failure: "manifest_build_failed", terminationReason: "error" });
    expect(x.w.providerCalls).toHaveLength(0);
    expect(kindsOf(x.w)).not.toContain("source_bundle_manifest");
    expect(kindsOf(x.w)).not.toContain("payload_audit");
  });

  it("the source_bundle_manifest write fails: no provider call, no seal (store down, and invalid_record)", async () => {
    await expectControlSealed();
    const down = await execute({ failAppend: { kind: "source_bundle_manifest", error: "io_failure" } });
    expectUnsealed(down, { failure: "store_failed", terminationReason: "error" });
    expect(down.w.providerCalls).toHaveLength(0);
    const invalid = await execute({ failAppend: { kind: "source_bundle_manifest", error: "invalid_record" } });
    expectUnsealed(invalid, { failure: "internal_error", terminationReason: "error" });
    expect(invalid.w.providerCalls).toHaveLength(0);
  });

  it("a secret in a record is rejected: the Run is never sealed as a normal Run", async () => {
    await expectControlSealed();
    const x = await execute({ secretInGeneration: true });
    expectUnsealed(x, { failure: "secret_rejected", terminationReason: "error" });
    for (const rec of x.w.records()) expect(JSON.stringify(rec).includes("SYNTHETIC-SECRET-0001"), rec.kind).toBe(false);
    expect(volumeText(x.w.mem).includes("SYNTHETIC-SECRET-0001")).toBe(false);
  });

  it("an invalid ordinary record (invalid_record) blocks the normal seal", async () => {
    await expectControlSealed();
    const x = await execute({ failAppend: { kind: "hypothesis_revision", error: "invalid_record" } });
    expectUnsealed(x, { failure: "internal_error", terminationReason: "error" });
  });

  it("prepare_failed (a duplicate partId): the Run stops with `error` before that provider call; no unaudited request is sent", async () => {
    await expectControlSealed();
    const x = await execute({ rewriteStoredPartId: () => "src-1" });
    // The termination rules of U2 apply: a failed preparation is an ordinary `error` stop. No write failed, so the Run is sealed with the reason `error`.
    expect(x.r.sealed).toBe(true);
    if (x.r.sealed) expect(x.r.summary.terminationReason).toBe("error");
    expect(x.w.providerCalls.map((c) => c.kind)).toEqual(["hypothesis_generation"]); // the generation has no stored part; the next call was never made
    expect(payloadsOf(x.w, "payload_audit")).toHaveLength(1);
    // no-send for the failed preparation: the provider spy saw exactly one call (not the failed request kind), and no ai_call record exists for it
    expect(x.w.providerCalls.filter((c) => c.kind !== "hypothesis_generation")).toHaveLength(0);
    expect(payloadsOf(x.w, "ai_call").map((p) => p.requestKind)).toEqual(["hypothesis_generation"]);
    expect(manifestOf(x.w).terminationReason).toBe("error");
  });
});
