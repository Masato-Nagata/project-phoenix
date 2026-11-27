// import_analysis with the `snapshot` port (G2-C, design.md item 7a): what is recorded, the failure codes, the timeout and the abort.
// Fake ports and the real adapter on a temporary tree. A pass says nothing about a real container (rebuilt and measured later).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { createNodeIsolationDeps } from "../src/isolation/nodeDeps.js";
import type { AccessDenialResult, BundleSnapshot, IsolationCheck, IsolationDeps } from "../src/isolation/types.js";
import { PORT_TIMEOUT_MS, SETTLE_GRACE_MS, verifyGroundTruthAccessDenial } from "../src/isolation/verify.js";
import { ALLOWED, GOOD_BUNDLE, RUN_ID, goodAttestation, makeDeps } from "./support/isolationFakes.js";

const EXPECTED = { allowedEnvNames: ALLOWED };
const HASH = "ab".repeat(32);
const imp = (r: AccessDenialResult): IsolationCheck => r.checks.find((c) => c.id === "import_analysis") as IsolationCheck;
const meas = (r: AccessDenialResult): Record<string, unknown> => imp(r).measured as Record<string, unknown>;
function withSnapshot(snapshot: (signal: AbortSignal) => Promise<BundleSnapshot> | unknown): IsolationDeps {
  const { deps } = makeDeps();
  return { ...deps, bundle: { files: deps.bundle.files, snapshot: snapshot as never } };
}
const good: BundleSnapshot = { ok: true, files: GOOD_BUNDLE, bundleSha256: HASH };

afterEach(() => vi.useRealTimers());

describe("import_analysis records bundleSha256 only when it is verified", () => {
  it("a good snapshot: verified, with bundleSha256 and the unchanged textSha256, filesScanned and finding fields", async () => {
    const r = await verifyGroundTruthAccessDenial(withSnapshot(async () => good), EXPECTED);
    expect(imp(r).status).toBe("verified");
    expect(meas(r)["bundleSha256"]).toBe(HASH);
    expect(meas(r)["textSha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(meas(r)["findingCount"]).toBe(0);
    expect(meas(r)["filesScanned"]).toBeGreaterThan(0);
    expect(r.status).toBe("verified");
  });

  it("a port without snapshot (the text list only) is still measured and records no bundleSha256", async () => {
    const { deps } = makeDeps();
    const r = await verifyGroundTruthAccessDenial(deps, EXPECTED);
    expect(imp(r).status).toBe("verified");
    expect("bundleSha256" in meas(r)).toBe(false);
    expect(meas(r)["textSha256"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the same textSha256 with and without the snapshot port for the same files (the text hash is not changed)", async () => {
    const a = await verifyGroundTruthAccessDenial(withSnapshot(async () => good), EXPECTED);
    const b = await verifyGroundTruthAccessDenial(makeDeps().deps, EXPECTED);
    expect(meas(a)["textSha256"]).toBe(meas(b)["textSha256"]);
  });

  it.each(["bundle_path_invalid", "bundle_duplicate", "bundle_changed", "bundle_limit_exceeded", "bundle_empty_root", "bundle_read_failed", "bundle_unsupported_entry", "timeout"] as const)(
    "a refused walk (%s) fails the check with that reason, and no hash, file list or text hash is recorded",
    async (code) => {
      const r = await verifyGroundTruthAccessDenial(withSnapshot(async () => ({ ok: false, code })), EXPECTED);
      expect(imp(r).status).toBe("failed");
      expect(meas(r)).toEqual({ reason: code });
      expect(r.status).toBe("failed");
      expect(JSON.stringify(r)).not.toContain("bundleSha256");
    },
  );

  it("an import that the scanner forbids fails the check and records NO bundleSha256 (the scan power is kept)", async () => {
    const bad: BundleSnapshot = { ok: true, files: [...GOOD_BUNDLE, { rel: "dist/e.js", text: 'import "../evaluation/x.js";' }], bundleSha256: HASH };
    const r = await verifyGroundTruthAccessDenial(withSnapshot(async () => bad), EXPECTED);
    expect(imp(r).status).toBe("failed");
    expect(meas(r)["reason"]).toBe("forbidden_import");
    expect("bundleSha256" in meas(r)).toBe(false);
    const syntax: BundleSnapshot = { ok: true, files: [...GOOD_BUNDLE, { rel: "dist/e.js", text: "eval('1');" }], bundleSha256: HASH };
    const r2 = await verifyGroundTruthAccessDenial(withSnapshot(async () => syntax), EXPECTED);
    expect(meas(r2)["reason"]).toBe("unclassified_syntax");
    expect("bundleSha256" in meas(r2)).toBe(false);
    const none: BundleSnapshot = { ok: true, files: [{ rel: "dist/a.json", text: "{}" }], bundleSha256: HASH };
    const r3 = await verifyGroundTruthAccessDenial(withSnapshot(async () => none), EXPECTED);
    expect(meas(r3)["reason"]).toBe("not_measured");
    expect("bundleSha256" in meas(r3)).toBe(false);
  });

  it("an answer that is not the closed shape is not_measured; an unknown failure code is not_measured; a throwing or rejecting port is port_failed", async () => {
    const shapes: unknown[] = [undefined, null, 5, "x", {}, { ok: true }, { ok: true, files: GOOD_BUNDLE }, { ok: true, files: GOOD_BUNDLE, bundleSha256: "ABC" }, { ok: true, files: GOOD_BUNDLE, bundleSha256: "A".repeat(64) }, { ok: true, files: "x", bundleSha256: HASH }, { ok: true, files: [{ rel: 1, text: "x" }], bundleSha256: HASH }, { ok: false }, { ok: false, code: "CANARY-text" }, { ok: false, code: 5 }];
    for (const s of shapes) {
      const r = await verifyGroundTruthAccessDenial(withSnapshot(async () => s), EXPECTED);
      expect(meas(r)["reason"], JSON.stringify(s)).toBe("not_measured");
      expect(JSON.stringify(r)).not.toContain("CANARY");
    }
    const t = await verifyGroundTruthAccessDenial(withSnapshot(() => { throw new Error("CANARY-throw"); }), EXPECTED);
    const rj = await verifyGroundTruthAccessDenial(withSnapshot(() => Promise.reject(new Error("CANARY-reject"))), EXPECTED);
    expect(meas(t)["reason"]).toBe("port_failed");
    expect(meas(rj)["reason"]).toBe("port_failed");
    expect(JSON.stringify([t, rj])).not.toContain("CANARY");
  });
});

describe("timeout and abort", () => {
  it("a walk that is still running at the timeout is told to stop (the signal is aborted), the check fails with timeout, and a late success never replaces it", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let finish: ((s: BundleSnapshot) => void) | undefined;
    const deps = withSnapshot((s: AbortSignal) => {
      signal = s;
      return new Promise<BundleSnapshot>((resolve) => {
        finish = resolve;
        s.addEventListener("abort", () => resolve({ ok: false, code: "timeout" }));
      });
    });
    const p = verifyGroundTruthAccessDenial(deps, EXPECTED);
    await vi.advanceTimersByTimeAsync(PORT_TIMEOUT_MS - 1);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signal?.aborted).toBe(true);
    const r = await p;
    expect(meas(r)).toEqual({ reason: "timeout" });
    finish?.(good); // too late: no effect on the result that was returned
    expect(meas(r)).toEqual({ reason: "timeout" });
    expect(imp(r).status).toBe("failed");
  });

  it("a walk that ignores the signal is waited for only a bounded time after the timeout, and the check still fails with timeout", async () => {
    vi.useFakeTimers();
    const deps = withSnapshot(() => new Promise<never>(() => undefined));
    const p = verifyGroundTruthAccessDenial(deps, EXPECTED);
    await vi.advanceTimersByTimeAsync(PORT_TIMEOUT_MS + SETTLE_GRACE_MS + 2000);
    const r = await p;
    expect(meas(r)).toEqual({ reason: "timeout" });
    expect(r.checks).toHaveLength(6);
  });

  it("a walk that answers in time is not aborted", async () => {
    let signal: AbortSignal | undefined;
    const r = await verifyGroundTruthAccessDenial(withSnapshot(async (s: AbortSignal) => { signal = s; return good; }), EXPECTED);
    expect(imp(r).status).toBe("verified");
    expect(signal?.aborted).toBe(false);
  });
});

describe("the real adapter on a temporary tree", () => {
  const base = mkdtempSync(join(tmpdir(), "phoenix-bundleverify-"));
  afterAll(() => rmSync(base, { recursive: true, force: true }));
  let n = 0;
  function adapter(files: Record<string, string>, label = "packages/x/dist"): IsolationDeps {
    const dir = join(base, `c${n++}`);
    const dist = join(dir, "dist");
    mkdirSync(dist, { recursive: true });
    for (const [rel, c] of Object.entries(files)) {
      mkdirSync(dirname(join(dist, rel)), { recursive: true });
      writeFileSync(join(dist, rel), c);
    }
    const attestationPath = join(dir, "isolation-attestation.json");
    writeFileSync(attestationPath, JSON.stringify(goodAttestation()));
    const r = createNodeIsolationDeps({ runId: RUN_ID, bundleRoots: [{ label, dir: dist }], scratchRoot: join(dir, "scratch"), rootfsDir: join(dir, "rootfs"), attestationPath });
    if (!r.ok) throw new Error("setup");
    const { deps } = makeDeps();
    return { ...deps, bundle: r.value.bundle };
  }

  it("a clean tree: verified, with a 64-hex bundleSha256 that the port itself gives", async () => {
    const deps = adapter({ "a.js": 'import { b } from "./b.js";\nexport const a = b;\n', "b.js": "export const b = 1;\n" });
    const snap = await deps.bundle.snapshot?.(new AbortController().signal);
    const r = await verifyGroundTruthAccessDenial(deps, EXPECTED);
    expect(imp(r).status).toBe("verified");
    expect(snap?.ok && meas(r)["bundleSha256"] === snap.bundleSha256).toBe(true);
    expect(meas(r)["bundleSha256"]).toMatch(/^[0-9a-f]{64}$/);
    expect(meas(r)["filesTotal"]).toBe(2);
  });

  it("a forbidden import and an unclassified syntax in a real file are still found, and no bundleSha256 is recorded", async () => {
    const forbidden = await verifyGroundTruthAccessDenial(adapter({ "a.js": 'import "../evaluation/x.js";\n' }), EXPECTED);
    expect(meas(forbidden)["reason"]).toBe("forbidden_import");
    expect("bundleSha256" in meas(forbidden)).toBe(false);
    const syntax = await verifyGroundTruthAccessDenial(adapter({ "a.js": "eval('1');\n" }), EXPECTED);
    expect(meas(syntax)["reason"]).toBe("unclassified_syntax");
    expect("bundleSha256" in meas(syntax)).toBe(false);
  });

  it("a refused tree (a name outside the grammar) fails the check with the code and no hash", async () => {
    const r = await verifyGroundTruthAccessDenial(adapter({ "a.js": "export {};\n", "bad name.js": "x" }), EXPECTED);
    expect(meas(r)).toEqual({ reason: "bundle_path_invalid" });
    expect(JSON.stringify(r)).not.toContain("bad name");
  });

  // Being part of the HASH is not being ALLOWED by the import analysis: a .node or .wasm file is walked and hashed (its raw bytes are in the
  // bundleSha256; see isolation.bundleHash.test.ts), and the existing scanner still refuses it as an executable artifact.
  it.each([["x.node", Buffer.from([0x7f, 0x45, 0x4c, 0x46])], ["x.wasm", Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])]] as const)(
    "a %s file next to clean scripts is walked, and the import analysis refuses it as unclassified_syntax with no bundleSha256",
    async (name, bytes) => {
      const dir = join(base, `exe${n++}`);
      const dist = join(dir, "dist");
      mkdirSync(dist, { recursive: true });
      writeFileSync(join(dist, "a.js"), "export const a = 1;\n");
      writeFileSync(join(dist, name), bytes);
      const attestationPath = join(dir, "isolation-attestation.json");
      writeFileSync(attestationPath, JSON.stringify(goodAttestation()));
      const made = createNodeIsolationDeps({ runId: RUN_ID, bundleRoots: [{ label: "packages/x/dist", dir: dist }], scratchRoot: join(dir, "scratch"), rootfsDir: join(dir, "rootfs"), attestationPath });
      if (!made.ok) throw new Error("setup");
      const snap = await made.value.bundle.snapshot?.(new AbortController().signal);
      expect(snap?.ok).toBe(true); // the walk itself succeeds: the file is in the scanned set and in the hash
      expect(snap?.ok && snap.files.map((f) => f.rel)).toEqual(["packages/x/dist/a.js", `packages/x/dist/${name}`]);
      expect(snap?.ok && snap.files.find((f) => f.rel.endsWith(name))?.text).toBe("");
      const { deps } = makeDeps();
      const r = await verifyGroundTruthAccessDenial({ ...deps, bundle: made.value.bundle }, EXPECTED);
      expect(imp(r).status).toBe("failed");
      expect(meas(r)["reason"]).toBe("unclassified_syntax");
      expect(meas(r)["findingCount"]).toBe(1);
      expect(JSON.stringify(meas(r)["findings"])).toContain("executable_artifact");
      expect(meas(r)["filesTotal"]).toBe(2);
      expect("bundleSha256" in meas(r)).toBe(false);
      expect(JSON.stringify(r)).not.toContain("bundleSha256");
      expect(r.status).toBe("failed");
    },
  );

  it("a root without a file is bundle_empty_root", async () => {
    const r = await verifyGroundTruthAccessDenial(adapter({ "node_modules/p/i.js": "x" }), EXPECTED);
    expect(meas(r)).toEqual({ reason: "bundle_empty_root" });
  });
});