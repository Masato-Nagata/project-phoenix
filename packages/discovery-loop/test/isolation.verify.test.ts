// Task 4.2: Ground_Truth access-denial verification, unit and property tests with fake ports.
// These tests prove the logic of the module only. They prove NOTHING about a real container: the real isolation is UNVERIFIED until tasks
// 4.9, 4.11 and 4.14. No access to evaluation/, the Approval Store or the Override; synthetic data only.
// **Validates: Requirements 2.14, 2.15, 15.2, 15.3, 15.6, 15.11, 15.12, 15.13, 15.14, 15.16**
import { createHash } from "node:crypto";
import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";

import { classifyCode, classifyOutcome } from "../src/isolation/classify.js";
import { PROBE_LOCATIONS, PROBE_SET_SHA256 } from "../src/isolation/probeSet.js";
import type { AccessDenialResult, CheckId, IsolationCheck } from "../src/isolation/types.js";
import { CHECK_ORDER } from "../src/isolation/types.js";
import { detectIsolationViolation } from "../src/isolation/violation.js";
import { PORT_TIMEOUT_MS, composeAllowedEnvNames, isAccessDenialResult, verifyGroundTruthAccessDenial } from "../src/isolation/verify.js";
import { ALLOWED, E, GOOD_BUNDLE, OK, RUN_ID, SCRATCH, defaultFsOutcome, goodAttestation, makeDeps, type Behavior } from "./support/isolationFakes.js";

const EXPECTED = { allowedEnvNames: ALLOWED };
const run = (over: Partial<Behavior> = {}, allowed: readonly string[] = ALLOWED) => {
  const d = makeDeps(over);
  return { ...d, result: verifyGroundTruthAccessDenial(d.deps, { allowedEnvNames: allowed }) };
};
const chk = (r: AccessDenialResult, id: CheckId): IsolationCheck => r.checks.find((c) => c.id === id) as IsolationCheck;
const meas = (r: AccessDenialResult, id: CheckId): Record<string, unknown> => chk(r, id).measured as Record<string, unknown>;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

afterEach(() => vi.useRealTimers());

describe("classification", () => {
  it("keeps denied and absent apart and maps everything else to unexpected", () => {
    expect(["EACCES", "EPERM"].map(classifyCode)).toEqual(["denied", "denied"]);
    expect(["ENOENT", "ENOTDIR"].map(classifyCode)).toEqual(["absent", "absent"]);
    for (const c of ["EIO", "EROFS", "timeout", "port_failed", "", "eacces"]) expect(classifyCode(c)).toBe("unexpected");
    expect(classifyOutcome(OK)).toBe("readable");
    expect(classifyOutcome(E("EACCES"))).toBe("denied");
    for (const bad of [undefined, null, 1, "ok", {}, { kind: "error" }, { kind: "error", code: 5 }]) expect(classifyOutcome(bad)).toBe("unexpected");
  });
});

describe("overall result", () => {
  it("verifies when all six checks pass, in the fixed order, and calls every port operation", async () => {
    const { result, calls } = run();
    const r = await result;
    expect(r.status).toBe("verified");
    expect(r.runId).toBe(RUN_ID);
    expect(r.checks.map((c) => c.id)).toEqual([...CHECK_ORDER]);
    expect(r.checks.every((c) => c.status === "verified")).toBe(true);
    expect(r.checks.map((c) => c.measuredBy)).toEqual(["runtime", "runtime", "launcher", "runtime", "runtime", "runtime"]);
    for (const k of ["fs.stat", "fs.list", "fs.read", "scratch.prepare", "scratch.cleanup", "proc.ids", "rootfs.tryCreate", "env.names", "attestation.read", "bundle.files"]) {
      expect(calls[k], k).toBeGreaterThan(0);
    }
    expect(calls["rootfs.removeCreated"]).toBeUndefined();
    expect(Object.isFrozen(r)).toBe(true);
  });

  it("passing control: every single-check defect makes the overall status failed and the other five checks are still reported", async () => {
    const cases: [CheckId, Partial<Behavior>][] = [
      ["import_analysis", { bundle: () => [{ rel: "dist/x.js", text: 'import x from "../../evaluation/y.js";' }] }],
      ["read_denial", { fsOutcome: (op, p) => (p === PROBE_LOCATIONS[0]?.path && op === "stat" ? OK : defaultFsOutcome(op, p)) }],
      ["mount_inspection", { attestation: () => ({ kind: "missing" }) }],
      ["uid", { ids: () => ({ uid: 0, euid: 0, gid: 0 }) }],
      ["rootfs_readonly", { tryCreate: () => E("EACCES") }],
      ["env_names", { envNames: () => [...ALLOWED, "SURPRISE"] }],
    ];
    for (const [id, over] of cases) {
      const r = await run(over).result;
      expect(r.status, id).toBe("failed");
      expect(r.checks).toHaveLength(6);
      expect(chk(r, id).status, id).toBe("failed");
      if (id === "uid") continue; // root also breaks the read_denial controls by design
      expect(r.checks.filter((c) => c.status === "failed").map((c) => c.id), id).toEqual([id]);
    }
  });
});

describe("read_denial", () => {
  it("counts absent and denied apart and records the fixed non-assurance", async () => {
    const r = await run().result;
    const m = meas(r, "read_denial");
    expect(m["absentCount"]).toBe(PROBE_LOCATIONS.length * 3);
    expect(m["deniedCount"]).toBe(0);
    expect(m["assurance"]).toBe("not_visible_only");
    expect(m["independentDenialAssurance"]).toBe("unverified");
    expect(m["probeSetSha256"]).toBe(PROBE_SET_SHA256);
    expect(m["cleanup"]).toBe("ok");
    const denied = await run({ fsOutcome: (op, p) => (PROBE_LOCATIONS.some((l) => l.path === p) ? E("EACCES") : defaultFsOutcome(op, p)) }).result;
    expect(denied.status).toBe("verified");
    expect(meas(denied, "read_denial")["deniedCount"]).toBe(12);
    expect(meas(denied, "read_denial")["assurance"]).toBe("denied_observed");
    expect(meas(denied, "read_denial")["absentCount"]).toBe(0);
  });

  it("pins probeSetSha256 so that a change of the probe set is visible", () => {
    expect(PROBE_SET_SHA256).toBe("dc6ffc796485f0dd898f266da562be8681271ecd8c6037b921e991f0e3e486d4");
    expect(PROBE_LOCATIONS.map((l) => l.path)).toEqual(["/repo/evaluation", "/evaluation", "/repo/evaluation/ground-truth", "/repo/evaluation/ground-truth/ground-truth.json"]);
  });

  it("matrix: class x operation x location", async () => {
    const classes: [string, ReturnType<typeof E>, boolean][] = [
      ["ENOENT", E("ENOENT"), true],
      ["ENOTDIR", E("ENOTDIR"), true],
      ["EACCES", E("EACCES"), true],
      ["EPERM", E("EPERM"), true],
      ["ok", OK, false],
      ["EIO", E("EIO"), false],
      ["EISDIR", E("EISDIR"), false],
      ["timeout", E("timeout"), false],
    ];
    for (const op of ["stat", "list", "read"] as const) {
      for (const loc of PROBE_LOCATIONS) {
        for (const [name, outcome, passes] of classes) {
          const r = await run({ fsOutcome: (o, p) => (o === op && p === loc.path ? outcome : defaultFsOutcome(o, p)) }).result;
          expect(chk(r, "read_denial").status, `${op} ${loc.id} ${name}`).toBe(passes ? "verified" : "failed");
        }
      }
    }
  });

  it("reports readable and unexpected reasons separately", async () => {
    const readable = await run({ fsOutcome: (o, p) => (p === "/evaluation" ? OK : defaultFsOutcome(o, p)) }).result;
    expect(meas(readable, "read_denial")["reason"]).toBe("readable");
    const odd = await run({ fsOutcome: (o, p) => (p === "/evaluation" ? E("EIO") : defaultFsOutcome(o, p)) }).result;
    expect(meas(odd, "read_denial")["reason"]).toBe("unexpected_errno");
  });

  it("sensitivity controls: each of the nine control operations must behave as expected, else control_failed (never skipped)", async () => {
    const paths: Record<string, [string, "stat" | "list" | "read", ReturnType<typeof E>][]> = {
      readable: [
        [SCRATCH.readableFile, "stat", E("ENOENT")],
        [SCRATCH.readableFile, "read", E("EACCES")],
        [SCRATCH.readableDir, "list", E("EIO")],
      ],
      denied: [
        [SCRATCH.deniedChild, "stat", OK],
        [SCRATCH.deniedChild, "read", OK],
        [SCRATCH.deniedDir, "list", OK],
        [SCRATCH.deniedChild, "stat", E("ENOENT")],
      ],
      absent: [
        [SCRATCH.absent, "stat", E("EACCES")],
        [SCRATCH.absent, "read", OK],
        [SCRATCH.absent, "list", E("EIO")],
      ],
    };
    for (const [ctl, list] of Object.entries(paths)) {
      for (const [path, op, outcome] of list) {
        const r = await run({ fsOutcome: (o, p) => (o === op && p === path ? outcome : defaultFsOutcome(o, p)) }).result;
        expect(chk(r, "read_denial").status, `${ctl} ${op}`).toBe("failed");
        expect(meas(r, "read_denial")["reason"], `${ctl} ${op}`).toBe("control_failed");
        expect((meas(r, "read_denial")["controls"] as Record<string, boolean>)[ctl], `${ctl} ${op}`).toBe(false);
      }
    }
  });

  it("root, a failed or throwing prepare, and an unknown euid give control_failed", async () => {
    for (const over of [
      { ids: () => ({ uid: 0, euid: 0, gid: 0 }) },
      { prepare: () => ({ kind: "error" as const, code: "EACCES" }) },
      { prepare: () => "throw" as const },
      { prepare: () => ({ kind: "ok" as const }) as never },
      { ids: () => "throw" as const },
    ]) {
      const r = await run(over).result;
      expect(chk(r, "read_denial").status).toBe("failed");
      expect(meas(r, "read_denial")["reason"]).toBe("control_failed");
    }
  });

  it("a failed scratch cleanup fails read_denial and the overall status; cleanup is attempted after earlier failures", async () => {
    for (const cleanup of [() => E("EBUSY"), () => "throw" as const]) {
      const { result, calls } = run({ cleanup });
      const r = await result;
      expect(chk(r, "read_denial").status).toBe("failed");
      expect(meas(r, "read_denial")["reason"]).toBe("cleanup_failed");
      expect(meas(r, "read_denial")["cleanup"]).toBe("failed");
      expect(r.status).toBe("failed");
      expect(calls["scratch.cleanup"]).toBe(1);
    }
    const { result, calls } = run({ prepare: () => ({ kind: "error", code: "ENOSPC" }) });
    await result;
    expect(calls["scratch.cleanup"]).toBe(1);
  });
});

describe("mount_inspection", () => {
  const withAtt = (mutate: (a: Record<string, unknown>) => unknown) => ({ attestation: () => ({ kind: "ok" as const, json: mutate(goodAttestation()) }) });
  const reasonOf = async (over: Partial<Behavior>): Promise<unknown> => meas(await run(over).result, "mount_inspection")["reason"];

  it("passes a valid attestation and reports what is not measured", async () => {
    const r = await run().result;
    const c = chk(r, "mount_inspection");
    expect(c.status).toBe("verified");
    expect(c.measuredBy).toBe("launcher");
    expect(meas(r, "mount_inspection")["notMeasured"]).toEqual(["mount_source_kind", "mount_type", "container_environment", "user", "read_only_root_flag", "capability_drop", "image_digest"]);
  });

  it("defect matrix", async () => {
    expect(await reasonOf({ attestation: () => ({ kind: "missing" }) })).toBe("attestation_invalid");
    expect(await reasonOf({ attestation: () => ({ kind: "unreadable" }) })).toBe("attestation_invalid");
    expect(await reasonOf({ attestation: () => ({ kind: "unparsable" }) })).toBe("attestation_invalid");
    expect(await reasonOf({ attestation: () => ({ kind: "weird" }) })).toBe("attestation_invalid");
    for (const j of [null, [], "x", 5]) expect(await reasonOf(withAtt(() => j))).toBe("attestation_invalid");
    expect(await reasonOf(withAtt((a) => ({ ...a, extra: 1 })))).toBe("attestation_invalid");
    expect(await reasonOf(withAtt((a) => { const { problems: _p, ...rest } = a; return rest; }))).toBe("attestation_invalid");
    expect(await reasonOf(withAtt((a) => ({ ...a, check: "other" })))).toBe("attestation_invalid");
    expect(await reasonOf(withAtt((a) => ({ ...a, ok: "true" })))).toBe("attestation_invalid");
    expect(await reasonOf(withAtt((a) => ({ ...a, mounts: "x" })))).toBe("attestation_invalid");
    expect(await reasonOf(withAtt((a) => ({ ...a, profile: "probe" })))).toBe("profile_mismatch");
    expect(await reasonOf(withAtt((a) => ({ ...a, ok: false, problems: ["mounts_differ"] })))).toBe("launcher_not_ok");
    expect(await reasonOf(withAtt((a) => ({ ...a, problems: ["x"] })))).toBe("launcher_not_ok");
    expect(await reasonOf(withAtt((a) => ({ ...a, networks: ["phoenix-discovery-lab", "bridge"] })))).toBe("networks_differ");
    expect(await reasonOf(withAtt((a) => ({ ...a, networks: [] })))).toBe("networks_differ");
    expect(await reasonOf(withAtt((a) => ({ ...a, container: "phoenix-discovery-run-20260101T000000Z-aaaaaaaaaaaa" })))).toBe("container_mismatch");
    expect(await reasonOf({ ...withAtt((a) => a), runId: "not-a-run-id" })).toBe("container_mismatch");
  });

  it("ok:true with differing mounts fails (the runtime does not trust ok alone)", async () => {
    const base = goodAttestation();
    const mounts = base["mounts"] as string[];
    for (const m of [[...mounts, "/extra"], mounts.slice(1), [...mounts.slice(1), "/run/channel"], [...mounts, mounts[0] as string]]) {
      const r = await run(withAtt((a) => ({ ...a, ok: true, problems: [], mounts: m }))).result;
      expect(chk(r, "mount_inspection").status).toBe("failed");
      expect(meas(r, "mount_inspection")["reason"]).toBe("mounts_differ");
    }
    const reordered = await run(withAtt((a) => ({ ...a, mounts: [...(a["mounts"] as string[])].reverse() }))).result;
    expect(chk(reordered, "mount_inspection").status).toBe("verified");
  });

  it("never echoes attestation content", async () => {
    const r = await run(withAtt((a) => ({ ...a, container: "CANARY-container", mounts: ["CANARY-mount"] }))).result;
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });
});

describe("uid", () => {
  it("passes a non-root uid; fails root, a root uid with a non-root euid, and bad shapes", async () => {
    expect(chk(await run().result, "uid").status).toBe("verified");
    expect(meas(await run({ ids: () => ({ uid: 0, euid: 5, gid: 5 }) }).result, "uid")["reason"]).toBe("root_user");
    expect(meas(await run({ ids: () => ({ uid: 5, euid: 0, gid: 5 }) }).result, "uid")["reason"]).toBe("root_user");
    for (const bad of [{ uid: -1, euid: -1, gid: -1 }, { uid: 1.5, euid: 1, gid: 1 }, { uid: 1, euid: 1 }, null, "x"]) {
      expect(meas(await run({ ids: () => bad }).result, "uid")["reason"]).toBe("port_failed");
    }
  });
});

describe("rootfs_readonly", () => {
  const rf = async (over: Partial<Behavior>) => {
    const d = run(over);
    const r = await d.result;
    return { check: chk(r, "rootfs_readonly"), m: meas(r, "rootfs_readonly"), calls: d.calls };
  };
  it("only EROFS passes", async () => {
    const x = await rf({});
    expect(x.check.status).toBe("verified");
    expect(x.calls["rootfs.removeCreated"]).toBeUndefined();
  });
  it("EACCES and EPERM are inconclusive", async () => {
    for (const code of ["EACCES", "EPERM"]) {
      const x = await rf({ tryCreate: () => E(code) });
      expect(x.check.status).toBe("failed");
      expect(x.m["reason"]).toBe("rootfs_inconclusive");
    }
  });
  it("EEXIST is a stale probe and the existing file is never touched", async () => {
    const x = await rf({ tryCreate: () => E("EEXIST") });
    expect(x.m["reason"]).toBe("rootfs_stale_probe");
    expect(x.calls["rootfs.removeCreated"]).toBeUndefined();
  });
  it("success is rootfs_writable with exactly one removal attempt; a failed removal adds cleanup_failed", async () => {
    const ok = await rf({ tryCreate: () => OK });
    expect(ok.m["reason"]).toBe("rootfs_writable");
    expect(ok.m["removal"]).toBe("ok");
    expect(ok.calls["rootfs.removeCreated"]).toBe(1);
    for (const removeCreated of [() => E("EBUSY"), () => "throw" as const]) {
      const bad = await rf({ tryCreate: () => OK, removeCreated });
      expect(bad.m["reasons"]).toEqual(["rootfs_writable", "cleanup_failed"]);
      expect(bad.m["removal"]).toBe("failed");
      expect(bad.calls["rootfs.removeCreated"]).toBe(1);
    }
  });
  it("other codes, a throwing port and a /tmp control failure fail", async () => {
    expect((await rf({ tryCreate: () => E("EIO") })).m["reason"]).toBe("unexpected_errno");
    expect((await rf({ tryCreate: () => "throw" })).m["reason"]).toBe("port_failed");
    expect((await rf({ prepare: () => ({ kind: "error", code: "ENOSPC" }) })).m["reason"]).toBe("control_failed");
  });
});

describe("env_names", () => {
  it("names only: counts, hash of the allowlist, and an unexpected name is never written", async () => {
    const r = await run().result;
    expect(meas(r, "env_names")).toEqual({ nameCount: 4, unexpectedCount: 0, allowlistSha256: sha([...ALLOWED].sort().join("\n")) });
    const bad = await run({ envNames: () => [...ALLOWED, "CANARY_NAME_X", "CANARY_NAME_Y"] }).result;
    expect(chk(bad, "env_names").status).toBe("failed");
    expect(meas(bad, "env_names")["unexpectedCount"]).toBe(2);
    expect(JSON.stringify(bad)).not.toContain("CANARY");
  });
  it("fails closed on a bad expectation or a bad port answer", async () => {
    for (const exp of [undefined, null, {}, { allowedEnvNames: "x" }, { allowedEnvNames: [1] }]) {
      const d = makeDeps();
      const r = await verifyGroundTruthAccessDenial(d.deps, exp as never);
      expect(meas(r, "env_names")["reason"]).toBe("not_measured");
    }
    expect(meas(await run({ envNames: () => "throw" }).result, "env_names")["reason"]).toBe("port_failed");
    expect(meas(await run({ envNames: () => "HOME" }).result, "env_names")["reason"]).toBe("port_failed");
    expect(meas(await run({ envNames: () => [1] }).result, "env_names")["reason"]).toBe("port_failed");
  });
  it("composeAllowedEnvNames adds only the module constants to what the caller passes (no credential is added by itself)", () => {
    expect(composeAllowedEnvNames([])).toEqual(["HOME", "PHOENIX_LEASE_D_MS", "PHOENIX_LEASE_NONCE", "PHOENIX_RUN_ID"]);
    expect(composeAllowedEnvNames(["B", "A", "HOME"])).toEqual(["A", "B", "HOME", "PHOENIX_LEASE_D_MS", "PHOENIX_LEASE_NONCE", "PHOENIX_RUN_ID"]);
    expect(composeAllowedEnvNames([])).not.toContain("KIRO_API_KEY");
  });
});

describe("import_analysis through the verification", () => {
  it("fails on a forbidden import, unclassified syntax, an empty tree and an undeterminable tree", async () => {
    const reason = async (b: Partial<Behavior>) => meas(await run(b).result, "import_analysis")["reason"];
    expect(await reason({ bundle: () => [...GOOD_BUNDLE, { rel: "dist/e.js", text: 'import "../evaluation/x.js";' }] })).toBe("forbidden_import");
    expect(await reason({ bundle: () => [...GOOD_BUNDLE, { rel: "dist/e.js", text: "eval('1');" }] })).toBe("unclassified_syntax");
    expect(await reason({ bundle: () => [{ rel: "dist/a.json", text: "{}" }] })).toBe("not_measured");
    expect(await reason({ bundle: () => undefined })).toBe("not_measured");
    expect(await reason({ bundle: () => [{ rel: 1, text: "x" }] })).toBe("not_measured");
    expect(await reason({ bundle: () => "throw" })).toBe("port_failed");
  });
});

describe("fail-closed ports", () => {
  it("a throwing, rejecting or wrong-shaped port fails its check, discards the message, and the function never throws", async () => {
    const all: Partial<Behavior> = {
      fsOutcome: () => "throw",
      prepare: () => "throw",
      cleanup: () => "throw",
      ids: () => "throw",
      tryCreate: () => "throw",
      removeCreated: () => "throw",
      envNames: () => "throw",
      attestation: () => "throw",
      bundle: () => "throw",
    };
    const r = await run(all).result;
    expect(r.status).toBe("failed");
    expect(r.checks).toHaveLength(6);
    expect(r.checks.every((c) => c.status === "failed")).toBe(true);
    expect(JSON.stringify(r)).not.toContain("CANARY");
    // wrong shapes
    const shapes: Partial<Behavior> = {
      fsOutcome: () => ({ nope: 1 }) as never,
      prepare: () => 5 as never,
      cleanup: () => undefined as never,
      ids: () => 7,
      tryCreate: () => null as never,
      envNames: () => 3,
      attestation: () => null,
      bundle: () => 9,
    };
    const s = await run(shapes).result;
    expect(s.checks).toHaveLength(6);
    expect(s.checks.every((c) => c.status === "failed")).toBe(true);
  });

  it("a rejecting port (not a synchronous throw) is also contained", async () => {
    const { deps } = makeDeps();
    const rejecting = { ...deps, bundle: { files: () => Promise.reject(new Error("CANARY-reject")) }, env: { names: () => { throw new Error("CANARY-sync"); } } };
    const r = await verifyGroundTruthAccessDenial(rejecting as never, EXPECTED);
    expect(chk(r, "import_analysis").status).toBe("failed");
    expect(chk(r, "env_names").status).toBe("failed");
    expect(JSON.stringify(r)).not.toContain("CANARY");
  });

  it("a port that never answers fails its check with timeout", async () => {
    vi.useFakeTimers();
    const { deps } = makeDeps();
    const hanging = { ...deps, bundle: { files: () => new Promise<never>(() => undefined) } };
    const p = verifyGroundTruthAccessDenial(hanging as never, EXPECTED);
    await vi.advanceTimersByTimeAsync(PORT_TIMEOUT_MS + 1);
    const r = await p;
    expect(meas(r, "import_analysis")["reason"]).toBe("timeout");
    expect(r.checks).toHaveLength(6);
    expect(r.status).toBe("failed");
  });

  it("a missing deps object or ports still returns six failed checks", async () => {
    for (const d of [undefined, null, {}, { runId: RUN_ID }]) {
      const r = await verifyGroundTruthAccessDenial(d as never, EXPECTED);
      expect(r.status).toBe("failed");
      expect(r.checks).toHaveLength(6);
      expect(r.checks.map((c) => c.id)).toEqual([...CHECK_ORDER]);
    }
  });
});

describe("module never touches /run/out", () => {
  it("no port is ever asked about /run/out in a full run, including the failure paths", async () => {
    const seen: string[] = [];
    const rec = (op: "stat" | "list" | "read", p: string) => {
      seen.push(p);
      return defaultFsOutcome(op, p);
    };
    await run({ fsOutcome: rec }).result;
    await run({ fsOutcome: rec, tryCreate: () => OK, prepare: () => ({ kind: "error", code: "EIO" }) }).result;
    expect(seen.length).toBeGreaterThan(20);
    expect(seen.filter((p) => p.startsWith("/run/out"))).toEqual([]);
  });
});

describe("brand", () => {
  it("accepts only the value that the function returned", async () => {
    const r = await run().result;
    expect(isAccessDenialResult(r)).toBe(true);
    expect(isAccessDenialResult(structuredClone(r))).toBe(false);
    expect(isAccessDenialResult({ ...r })).toBe(false);
    expect(isAccessDenialResult(Object.freeze({ status: "verified", runId: RUN_ID, checks: Object.freeze([...r.checks]) }))).toBe(false);
    expect(isAccessDenialResult(JSON.parse(JSON.stringify(r)))).toBe(false);
    for (const v of [null, undefined, 1, "x", {}]) expect(isAccessDenialResult(v)).toBe(false);
  });
});

describe("detectIsolationViolation (R15.6)", () => {
  it("reports a denied attempt with a fixed location id, never a free path", () => {
    const v = detectIsolationViolation({ op: "read", path: "/repo/evaluation/ground-truth", errorCode: "EACCES" });
    expect(v).toEqual({ code: "isolation_violation", op: "read", errorCode: "EACCES", locationId: "repo_ground_truth_dir" });
    const other = detectIsolationViolation({ op: "stat", path: "/somewhere/CANARY-free-path", errorCode: "EPERM" });
    expect(other?.locationId).toBe("unlisted");
    expect(JSON.stringify(other)).not.toContain("CANARY");
  });
  it("an absent path, success-like or unexpected codes are not violations; bad input never throws", () => {
    for (const code of ["ENOENT", "ENOTDIR", "EIO", "", "timeout"]) expect(detectIsolationViolation({ op: "read", path: "/evaluation", errorCode: code })).toBeUndefined();
    expect(detectIsolationViolation(null as never)).toBeUndefined();
    expect(detectIsolationViolation({ op: "read", path: 5, errorCode: "EACCES" } as never)?.locationId).toBe("unlisted");
  });
});

describe("property: random port behavior", () => {
  const pick = <T>(xs: readonly T[], i: number): T => xs[i % xs.length] as T;
  it("never throws, always six entries in order, and verified only if every port operation (but removeCreated) was called", async () => {
    const outcomes = [OK, E("ENOENT"), E("EACCES"), E("EIO"), E("ENOTDIR"), "throw", { x: 1 }] as const;
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.nat(50), { minLength: 1, maxLength: 12 }),
        fc.array(fc.nat(50), { minLength: 1, maxLength: 6 }),
        async (a, b) => {
          let n = 0;
          const over: Partial<Behavior> = {
            fsOutcome: (op, p) => (n++ % 3 === 0 ? (pick(outcomes, pick(a, n)) as never) : defaultFsOutcome(op, p)),
            prepare: () => pick([SCRATCH, SCRATCH, "throw" as const, { kind: "error" as const, code: "EIO" }], pick(b, 0)),
            cleanup: () => pick([OK, OK, E("EBUSY"), "throw" as const], pick(b, 1)),
            tryCreate: () => pick([E("EROFS"), E("EROFS"), OK, E("EEXIST"), "throw" as const], pick(b, 2)),
            envNames: () => pick([[...ALLOWED], [...ALLOWED], [...ALLOWED, "X"], "throw" as const], pick(b, 3)),
            attestation: () => pick([{ kind: "ok" as const, json: goodAttestation() }, { kind: "missing" as const }, "throw" as const], pick(b, 4)),
            bundle: () => pick([GOOD_BUNDLE, undefined, "throw" as const], pick(b, 5)),
          };
          const { deps, calls } = makeDeps(over);
          const r = await verifyGroundTruthAccessDenial(deps, EXPECTED);
          expect(r.checks.map((c) => c.id)).toEqual([...CHECK_ORDER]);
          expect(r.status === "verified").toBe(r.checks.every((c) => c.status === "verified"));
          if (r.status === "verified") {
            for (const k of ["fs.stat", "fs.list", "fs.read", "scratch.prepare", "scratch.cleanup", "proc.ids", "rootfs.tryCreate", "env.names", "attestation.read", "bundle.files"]) {
              expect(calls[k] ?? 0, k).toBeGreaterThan(0);
            }
          }
          expect(JSON.stringify(r)).not.toContain("CANARY");
        },
      ),
      { numRuns: 150, seed: 4202 },
    );
  });
});
