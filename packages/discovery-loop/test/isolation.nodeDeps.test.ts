// Task 4.2: the real node:fs adapter, exercised on a temporary directory (tmpfs in the toolchain container). Nothing here touches / or /run/out.
// Permission-based tests need a non-root user that honors file modes; as root (or without geteuid) the whole describe block is SKIPPED, which
// the test report shows as NOT RUN. A skipped block is never counted as a pass.
// A pass here says nothing about a real runtime container: that is UNVERIFIED until tasks 4.9, 4.11 and 4.14.
// **Validates: Requirements 15.2, 15.3, 15.11, 15.13**
import { chmodSync, mkdirSync, mkdtempSync, promises as fsp, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CLEANUP_WAIT_MS, createNodeIsolationDeps } from "../src/isolation/nodeDeps.js";
import { composeAllowedEnvNames, verifyGroundTruthAccessDenial } from "../src/isolation/verify.js";
import type { IsolationDeps } from "../src/isolation/types.js";
import { RUN_ID, goodAttestation } from "./support/isolationFakes.js";

const canPermissionTest = typeof process.geteuid === "function" && process.geteuid() !== 0;
let base: string;
beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "phoenix-nodedeps-"));
});
afterAll(() => {
  try {
    for (const d of readdirSync(base, { recursive: true, withFileTypes: false }) as string[]) if (d.endsWith("denied")) chmodSync(join(base, d), 0o700);
  } catch {
    /* best effort */
  }
  rmSync(base, { recursive: true, force: true });
});

let n = 0;
function fresh(extra: { files?: Record<string, string | Buffer> } = {}) {
  const dir = join(base, `case-${n++}`);
  const dist = join(dir, "dist");
  const rootfs = join(dir, "rootfs");
  const scratch = join(dir, "scratch");
  mkdirSync(dist, { recursive: true });
  mkdirSync(rootfs);
  mkdirSync(scratch);
  for (const [rel, content] of Object.entries(extra.files ?? { "a.js": 'import { b } from "./b.js";\nexport const a = b;\n', "b.js": "export const b = 1;\n" })) {
    mkdirSync(join(dist, rel, ".."), { recursive: true });
    writeFileSync(join(dist, rel), content);
  }
  const attestationPath = join(dir, "isolation-attestation.json");
  writeFileSync(attestationPath, JSON.stringify(goodAttestation()));
  const r = createNodeIsolationDeps({ runId: RUN_ID, bundleRoots: [{ label: "dist", dir: dist }], scratchRoot: scratch, rootfsDir: rootfs, attestationPath });
  if (!r.ok) throw new Error("setup");
  return { deps: r.value, dir, dist, rootfs, scratch, attestationPath };
}

describe("createNodeIsolationDeps", () => {
  it("refuses a run id that is not of the Launcher format (no path is built from it)", () => {
    for (const id of ["", "x", "../etc", "run-1", `${RUN_ID}/../x`, 5 as never]) {
      const r = createNodeIsolationDeps({ runId: id, bundleRoots: [] });
      expect(r.ok, String(id)).toBe(false);
    }
    expect(createNodeIsolationDeps({ runId: RUN_ID, bundleRoots: [] }).ok).toBe(true);
  });

  it("an environment answer holds names only, never a value", () => {
    process.env["PHOENIX_TEST_NAME_ONLY"] = "CANARY-value-must-not-appear";
    try {
      const { deps } = fresh();
      const names = deps.env.names();
      expect(names).toContain("PHOENIX_TEST_NAME_ONLY");
      expect(JSON.stringify(names)).not.toContain("CANARY");
    } finally {
      delete process.env["PHOENIX_TEST_NAME_ONLY"];
    }
  });

  it("the attestation port distinguishes missing, unreadable (too large), unparsable and ok", async () => {
    const f = fresh();
    expect((await f.deps.attestation.read()).kind).toBe("ok");
    writeFileSync(f.attestationPath, "{not json");
    expect((await f.deps.attestation.read()).kind).toBe("unparsable");
    writeFileSync(f.attestationPath, " ".repeat(70000));
    expect((await f.deps.attestation.read()).kind).toBe("unreadable");
    rmSync(f.attestationPath);
    expect((await f.deps.attestation.read()).kind).toBe("missing");
  });

  it("the bundle port lists first-party files in a fixed order, skips node_modules, marks binaries, and flags invalid UTF-8", async () => {
    const f = fresh({ files: { "z.js": "export {};", "a/b.js": "export {};", "x.node": Buffer.from([0, 1, 2]), "node_modules/m/i.js": "eval(1)", "bad.js": Buffer.from([0x63, 0xff, 0xfe]), "d.json": "{}" } });
    const files = await f.deps.bundle.files();
    expect(files?.map((x) => x.rel)).toEqual(["dist/a/b.js", "dist/bad.js", "dist/d.json", "dist/x.node", "dist/z.js"]);
    expect(files?.find((x) => x.rel === "dist/x.node")?.text).toBe("");
    expect(files?.find((x) => x.rel === "dist/bad.js")?.text).toContain("\uFFFD");
  });

  it("the bundle port is undefined for a missing root or a symbolic link", async () => {
    const f = fresh();
    const gone = createNodeIsolationDeps({ runId: RUN_ID, bundleRoots: [{ label: "dist", dir: join(f.dir, "nope") }] });
    expect(gone.ok && (await gone.value.bundle.files())).toBeUndefined();
    try {
      symlinkSync(join(f.dist, "a.js"), join(f.dist, "link.js"));
    } catch {
      return; // links not permitted here: the first case above already covers the missing-root path
    }
    expect(await f.deps.bundle.files()).toBeUndefined();
  });

  it("the root-file-system port creates exclusively, removes only what it created, and tries once", async () => {
    const f = fresh();
    expect((await f.deps.rootfs.removeCreated()).kind).toBe("error"); // nothing created yet
    expect((await f.deps.rootfs.tryCreate()).kind).toBe("ok");
    const probe = join(f.rootfs, `.phoenix-rootfs-probe-${RUN_ID}`);
    expect(existsSync(probe)).toBe(true);
    const again = await f.deps.rootfs.tryCreate();
    expect(again).toEqual({ kind: "error", code: "EEXIST" });
    expect((await f.deps.rootfs.removeCreated()).kind).toBe("ok");
    expect(existsSync(probe)).toBe(false);
    expect((await f.deps.rootfs.removeCreated()).kind).toBe("error"); // one attempt only
  });

  it("a stale probe file that this adapter did not create is never removed", async () => {
    const f = fresh();
    const probe = join(f.rootfs, `.phoenix-rootfs-probe-${RUN_ID}`);
    writeFileSync(probe, "stale");
    expect(await f.deps.rootfs.tryCreate()).toEqual({ kind: "error", code: "EEXIST" });
    expect((await f.deps.rootfs.removeCreated()).kind).toBe("error");
    expect(existsSync(probe)).toBe(true);
  });

  it("a port answer never carries a message or a path", async () => {
    const f = fresh();
    const out = await f.deps.fs.stat(join(f.dir, "CANARY-missing-name"));
    expect(out).toEqual({ kind: "error", code: "ENOENT" });
  });

  it("cleanup without a prior prepare is ok; prepare twice reports EEXIST; cleanup removes everything; the adapter is single-use (prepare after cleanup is CLOSED)", async () => {
    const solo = fresh();
    expect((await solo.deps.scratch.cleanup()).kind).toBe("ok");
    const f = fresh();
    const p = await f.deps.scratch.prepare();
    expect(p.kind).toBe("ok");
    expect(await f.deps.scratch.prepare()).toEqual({ kind: "error", code: "EEXIST" });
    expect((await f.deps.scratch.cleanup()).kind).toBe("ok");
    expect(readdirSync(f.scratch)).toEqual([]);
    expect(await f.deps.scratch.prepare()).toEqual({ kind: "error", code: "CLOSED" });
    expect(readdirSync(f.scratch)).toEqual([]); // nothing is created after the latch
    expect((await f.deps.scratch.cleanup()).kind).toBe("ok"); // serialized: the same answer again
  });
});

// Source change guarded: the `scratchClosed` latch and the awaited in-flight prepare in nodeDeps.ts scratch.prepare / scratch.cleanup.
// No permission assertions here, so these run (and count) also as root.
describe("scratch prepare and cleanup racing (closed latch)", () => {
  it("cleanup called right after prepare: prepare stops and undoes its work, no scratch directory is left", async () => {
    const f = fresh();
    const p = f.deps.scratch.prepare();
    const c = f.deps.scratch.cleanup(); // sets the latch synchronously, before the first mkdir completes
    const [pr, cr] = await Promise.all([p, c]);
    expect(pr).toEqual({ kind: "error", code: "CLOSED" });
    expect(cr.kind).toBe("ok");
    expect(readdirSync(f.scratch)).toEqual([]);
    expect(await f.deps.scratch.prepare()).toEqual({ kind: "error", code: "CLOSED" });
    expect(readdirSync(f.scratch)).toEqual([]);
  });

  it("cleanup started after any number of event-loop turns of prepare always leaves no residue", async () => {
    for (let turns = 0; turns < 8; turns++) {
      const f = fresh();
      const p = f.deps.scratch.prepare();
      for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve));
      const c = await f.deps.scratch.cleanup();
      const pr = await p;
      expect(c.kind, `turns=${turns}`).toBe("ok");
      expect(["ok", "error"]).toContain(pr.kind);
      if (pr.kind === "error") expect(pr.code).toBe("CLOSED");
      expect(readdirSync(f.scratch), `turns=${turns}`).toEqual([]);
    }
  });

  it("a prepare that never settles: cleanup waits a finite time, then returns an error (never ok)", async () => {
    const f = fresh();
    const spy = vi.spyOn(fsp, "mkdir").mockImplementation(() => new Promise(() => undefined) as never);
    try {
      vi.useFakeTimers();
      void f.deps.scratch.prepare();
      const c = f.deps.scratch.cleanup();
      await vi.advanceTimersByTimeAsync(CLEANUP_WAIT_MS + 1);
      vi.useRealTimers();
      expect(await c).toEqual({ kind: "error", code: "PREPARE_UNSETTLED" });
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
  });
});

// Source change guarded: `created = true` right after open() and the `rootfsClosed` latch in nodeDeps.ts rootfs.tryCreate / removeCreated.
describe("root-file-system probe: close failure and late creation", () => {
  it("a failing close() after creation still answers ok (the file exists) and removeCreated removes it exactly once", async () => {
    const f = fresh();
    const real = fsp.open.bind(fsp);
    const spy = vi.spyOn(fsp, "open").mockImplementation((async (...a: Parameters<typeof fsp.open>) => {
      const h = await real(...a);
      const realClose = h.close.bind(h);
      (h as { close: () => Promise<void> }).close = async () => {
        await realClose();
        throw Object.assign(new Error("CANARY-close"), { code: "EIO" });
      };
      return h;
    }) as never);
    try {
      const probe = join(f.rootfs, `.phoenix-rootfs-probe-${RUN_ID}`);
      expect(await f.deps.rootfs.tryCreate()).toEqual({ kind: "ok" });
      expect(existsSync(probe)).toBe(true);
      expect((await f.deps.rootfs.removeCreated()).kind).toBe("ok");
      expect(existsSync(probe)).toBe(false);
      expect((await f.deps.rootfs.removeCreated()).kind).toBe("error"); // no second attempt
    } finally {
      spy.mockRestore();
    }
  });

  it("a creation that completes after removeCreated was told it is pending is unlinked by the adapter itself, once", async () => {
    const f = fresh();
    const real = fsp.open.bind(fsp);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const spy = vi.spyOn(fsp, "open").mockImplementation((async (...a: Parameters<typeof fsp.open>) => {
      await gate;
      return real(...a);
    }) as never);
    try {
      const probe = join(f.rootfs, `.phoenix-rootfs-probe-${RUN_ID}`);
      const creating = f.deps.rootfs.tryCreate();
      expect(await f.deps.rootfs.removeCreated()).toEqual({ kind: "error", code: "PENDING" });
      release();
      expect(await creating).toEqual({ kind: "ok" }); // a late answer, ignored by the verification
      expect(existsSync(probe)).toBe(false); // removed by the adapter, no residue
      expect(await f.deps.rootfs.tryCreate()).toEqual({ kind: "error", code: "CLOSED" });
      expect((await f.deps.rootfs.removeCreated()).kind).toBe("error"); // the single attempt was used
    } finally {
      spy.mockRestore();
    }
  });
});

describe.skipIf(!canPermissionTest)("real permission behavior (non-root, modes honored)", () => {
  it("the sensitivity controls observe readable, denied and absent per operation", async () => {
    const f = fresh();
    const p = await f.deps.scratch.prepare();
    if (p.kind !== "ok") throw new Error("prepare failed");
    expect((await f.deps.fs.stat(p.readableFile)).kind).toBe("ok");
    expect((await f.deps.fs.read(p.readableFile)).kind).toBe("ok");
    expect((await f.deps.fs.list(p.readableDir)).kind).toBe("ok");
    expect(await f.deps.fs.stat(p.deniedChild)).toEqual({ kind: "error", code: "EACCES" });
    expect(await f.deps.fs.read(p.deniedChild)).toEqual({ kind: "error", code: "EACCES" });
    expect(await f.deps.fs.list(p.deniedDir)).toEqual({ kind: "error", code: "EACCES" });
    for (const op of ["stat", "read", "list"] as const) expect(await f.deps.fs[op](p.absent)).toEqual({ kind: "error", code: "ENOENT" });
    expect((await f.deps.scratch.cleanup()).kind).toBe("ok");
    expect(existsSync(join(f.scratch, `phoenix-isolation-${RUN_ID}`))).toBe(false);
  });

  it("the whole verification on a temporary world: everything verifies except rootfs_readonly, because a temporary directory is writable", async () => {
    const f = fresh();
    const allowed = composeAllowedEnvNames(Object.keys(process.env));
    const r = await verifyGroundTruthAccessDenial(f.deps, { allowedEnvNames: allowed });
    expect(r.checks.map((c) => `${c.id}:${c.status}`)).toEqual([
      "import_analysis:verified",
      "read_denial:verified",
      "mount_inspection:verified",
      "uid:verified",
      "rootfs_readonly:failed",
      "env_names:verified",
    ]);
    expect(r.status).toBe("failed");
    expect((r.checks[4]?.measured as Record<string, unknown>)["reason"]).toBe("rootfs_writable");
    expect((r.checks[4]?.measured as Record<string, unknown>)["removal"]).toBe("ok");
    expect(readdirSync(f.rootfs)).toEqual([]);
    expect(readdirSync(f.scratch)).toEqual([]);
    expect((r.checks[1]?.measured as Record<string, unknown>)["assurance"]).toBe("not_visible_only");
  });

  it("a real cleanup that cannot remove the directory reports an error (the verification then fails read_denial with cleanup_failed)", async () => {
    const f = fresh();
    const stuck = join(f.scratch, `phoenix-isolation-${RUN_ID}`);
    // the scratch parent is made read-only after prepare so that removal fails
    const d: IsolationDeps = f.deps;
    const p = await d.scratch.prepare();
    if (p.kind !== "ok") throw new Error("prepare failed");
    chmodSync(f.scratch, 0o500);
    try {
      const out = await d.scratch.cleanup();
      expect(out.kind).toBe("error");
      expect(statSync(stuck).isDirectory()).toBe(true);
    } finally {
      chmodSync(f.scratch, 0o700);
      rmSync(stuck, { recursive: true, force: true }); // hygiene only: the adapter's cleanup is single-use
    }
  });
});
