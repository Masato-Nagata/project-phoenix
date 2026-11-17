// Task 4.2 review fixes C, D and E: "mutation checks" and control tests for the Ground_Truth access-denial verification.
// There is no mutation framework in this package (no earlier test uses one). A mutation check here is a test that runs the REAL verification
// against a deliberately defective fake port, or runs an assertion against a deliberately defective variant of a small piece of logic, and
// asserts that the defect is caught. Each group names the source change it guards.
// Fakes only; no Docker. These tests prove the logic of the module and of the test support only. Real-container isolation is UNVERIFIED
// until tasks 4.9, 4.11 and 4.14. No access to evaluation/; synthetic data only.
// **Validates: Requirements 2.14, 15.2, 15.3, 15.8, 15.11, 15.13, 15.14**
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { classifyCode } from "../src/isolation/classify.js";
import { PROBE_LOCATIONS, PROBE_OPS, PROBE_SET_SHA256 } from "../src/isolation/probeSet.js";
import { MOUNT_NOT_MEASURED } from "../src/isolation/types.js";
import type { AccessDenialResult, CheckId, IsolationCheck, ProbeOutcome } from "../src/isolation/types.js";
import { MODULE_ENV_NAMES, composeAllowedEnvNames, isAccessDenialResult, verifyGroundTruthAccessDenial } from "../src/isolation/verify.js";
import { assertDenialWithControl, type ProbeRunRecord } from "./support/assertDenialWithControl.js";
import { ALLOWED, E, GOOD_BUNDLE, OK, SCRATCH, defaultFsOutcome, makeDeps, type Behavior } from "./support/isolationFakes.js";

const run = (over: Partial<Behavior> = {}) => {
  const d = makeDeps(over);
  return { ...d, result: verifyGroundTruthAccessDenial(d.deps, { allowedEnvNames: ALLOWED }) };
};
const chk = (r: AccessDenialResult, id: CheckId): IsolationCheck => r.checks.find((c) => c.id === id) as IsolationCheck;
const meas = (r: AccessDenialResult, id: CheckId): Record<string, unknown> => chk(r, id).measured as Record<string, unknown>;

// Guards: the denied sensitivity control in verify.ts controlsHold (`denied` must classify as denied for stat, list and read).
describe("mutation check (1): a port that reports ok for a denied-control path", () => {
  it("fails the control and the whole verification, for each operation", async () => {
    for (const [op, path] of [["stat", SCRATCH.deniedChild], ["read", SCRATCH.deniedChild], ["list", SCRATCH.deniedDir]] as const) {
      const r = await run({ fsOutcome: (o, p) => (o === op && p === path ? OK : defaultFsOutcome(o, p)) }).result;
      expect(chk(r, "read_denial").status, op).toBe("failed");
      expect(meas(r, "read_denial")["reason"], op).toBe("control_failed");
      expect(r.status, op).toBe("failed");
    }
  });
  it("a port that says ok for every path is never verified", async () => {
    const r = await run({ fsOutcome: () => OK }).result;
    expect(chk(r, "read_denial").status).toBe("failed");
    expect(r.status).toBe("failed");
  });
});

// Guards: classify.ts classifyCode. A table of expectations is run against the real function and against defective variants.
describe("mutation check (2): classification", () => {
  const TABLE: readonly (readonly [string, string])[] = [
    ["EACCES", "denied"], ["EPERM", "denied"], ["ENOENT", "absent"], ["ENOTDIR", "absent"],
    ["EIO", "unexpected"], ["EROFS", "unexpected"], ["timeout", "unexpected"], ["port_failed", "unexpected"], ["", "unexpected"],
  ];
  const violations = (f: (c: string) => string): string[] => TABLE.filter(([c, want]) => f(c) !== want).map(([c]) => c);
  it("the real classification meets the table", () => {
    expect(violations(classifyCode)).toEqual([]);
  });
  it("defective variants are caught (ENOENT as denied, ENOTDIR as denied, EIO as absent, EACCES as absent, EPERM as unexpected, unknown as absent)", () => {
    const mutants: Record<string, (c: string) => string> = {
      "ENOENT as denied": (c) => (c === "ENOENT" ? "denied" : classifyCode(c)),
      "ENOTDIR as denied": (c) => (c === "ENOTDIR" ? "denied" : classifyCode(c)),
      "EIO as absent": (c) => (c === "EIO" ? "absent" : classifyCode(c)),
      "EACCES as absent": (c) => (c === "EACCES" ? "absent" : classifyCode(c)),
      "EPERM as unexpected": (c) => (c === "EPERM" ? "unexpected" : classifyCode(c)),
      "unknown as absent": (c) => (classifyCode(c) === "unexpected" ? "absent" : classifyCode(c)),
    };
    for (const [name, f] of Object.entries(mutants)) expect(violations(f).length, name).toBeGreaterThan(0);
  });
  it("through the verification, ENOENT is counted as absent and never as denied", async () => {
    const m = meas(await run().result, "read_denial");
    expect(m["deniedCount"]).toBe(0);
    expect(m["absentCount"]).toBe(PROBE_LOCATIONS.length * PROBE_OPS.length);
  });
});

// Guards: verify.ts checkRootfs (only EROFS passes).
describe("mutation check (3): root-file-system probe", () => {
  it("only EROFS passes; ok, EACCES, EPERM, EEXIST and any other code never pass", async () => {
    const outcomes: [string, ProbeOutcome][] = [
      ["ok", OK], ["EACCES", E("EACCES")], ["EPERM", E("EPERM")], ["EEXIST", E("EEXIST")], ["EIO", E("EIO")], ["ENOENT", E("ENOENT")],
      ["EXDEV", E("EXDEV")], ["EBUSY", E("EBUSY")], ["timeout", E("timeout")], ["port_failed", E("port_failed")], ["empty", E("")], ["lowercase erofs", E("erofs")],
    ];
    for (const [name, outcome] of outcomes) {
      const r = await run({ tryCreate: () => outcome }).result;
      expect(chk(r, "rootfs_readonly").status, name).toBe("failed");
      expect(r.status, name).toBe("failed");
    }
    const ok = await run({ tryCreate: () => E("EROFS") }).result;
    expect(chk(ok, "rootfs_readonly").status).toBe("verified");
  });
  it("a malformed answer never passes", async () => {
    for (const bad of [undefined, null, {}, { kind: "error" }, "EROFS"]) {
      const r = await run({ tryCreate: () => bad as never }).result;
      expect(chk(r, "rootfs_readonly").status).toBe("failed");
    }
  });
});

// Guards: verify.ts checkReadDenial cleanup handling (a failed or malformed cleanup answer fails the check).
describe("mutation check (4): cleanup failure is never verified", () => {
  it("every failing or malformed cleanup answer fails read_denial and the overall status", async () => {
    const bad: (() => ProbeOutcome | "throw")[] = [
      () => E("EBUSY"), () => E("NOT_REMOVED"), () => E("PREPARE_UNSETTLED"), () => "throw", () => undefined as never, () => null as never, () => ({}) as never, () => ({ kind: "error" }) as never,
    ];
    for (const [i, cleanup] of bad.entries()) {
      const r = await run({ cleanup }).result;
      expect(chk(r, "read_denial").status, String(i)).toBe("failed");
      expect(meas(r, "read_denial")["reasons"], String(i)).toContain("cleanup_failed");
      expect(r.status, String(i)).toBe("failed");
    }
  });
});

// Guards: (a) nodeDeps.ts `scratchClosed` latch: real-file-system tests in isolation.nodeDeps.test.ts ("scratch prepare and cleanup racing");
// (b) verify.ts `settle(..., SETTLE_GRACE_MS)` before cleanup: isolation.race.test.ts (event order prepare-end, cleanup);
// (c) nodeDeps.ts `rootfsClosed` latch: isolation.nodeDeps.test.ts ("late creation"). The models below reproduce each defect with plain
// data, so that the invariants used by those tests are shown to detect it. They are models of the defect, not the source itself.
describe("mutation check (5): removing the settle wait or a closed latch is detected", () => {
  function scratchModel(opts: { latch: boolean; waitInflight: boolean }): boolean {
    const items = new Set<string>();
    let closed = false;
    let next = 0;
    let undone = false;
    const step = (): void => {
      if (next >= 3) return;
      if (opts.latch && closed) {
        if (!undone) items.clear();
        undone = true;
        next = 3;
        return;
      }
      items.add(`item${next++}`);
    };
    step(); // prepare did one step, then cleanup begins
    closed = true;
    if (opts.waitInflight) while (next < 3) step();
    items.clear(); // cleanup removes what exists now
    while (next < 3) step(); // a prepare that was not awaited keeps going after the cleanup
    return items.size > 0; // residue?
  }
  it("residue exists only when both protections are removed; each real protection alone leaves none", () => {
    expect(scratchModel({ latch: true, waitInflight: true })).toBe(false);
    expect(scratchModel({ latch: true, waitInflight: false })).toBe(false);
    expect(scratchModel({ latch: false, waitInflight: true })).toBe(false);
    expect(scratchModel({ latch: false, waitInflight: false })).toBe(true); // the defect is visible to the residue invariant
  });
  const cleanupAfterPrepareEnd = (events: readonly string[]): boolean => {
    const c = events.indexOf("cleanup");
    const p = events.indexOf("prepare-end");
    return c !== -1 && p !== -1 && p < c;
  };
  it("the order invariant of the race test rejects a trace in which cleanup ran before the late prepare ended", () => {
    expect(cleanupAfterPrepareEnd(["prepare-end", "cleanup"])).toBe(true);
    expect(cleanupAfterPrepareEnd(["cleanup", "prepare-end"])).toBe(false); // trace of a verification without the settle wait
    expect(cleanupAfterPrepareEnd(["cleanup"])).toBe(false);
  });
  it("rootfs: a creation that completes after the check ended leaves a file unless a latch makes the adapter remove it", () => {
    const lateCreation = (latch: boolean): boolean => {
      let exists = false;
      let closed = false;
      closed = true; // the verification gave up waiting
      exists = true; // the late open() completes
      if (latch && closed) exists = false; // the adapter unlinks once
      return exists;
    };
    expect(lateCreation(true)).toBe(false);
    expect(lateCreation(false)).toBe(true);
  });
});

// Guards: verify.ts deepFreeze applied to the result before the brand is registered.
describe("mutation check (6) and control: the result is deeply immutable", () => {
  const isDeepFrozen = (v: unknown, seen = new WeakSet<object>()): boolean => {
    if (typeof v !== "object" || v === null) return true;
    if (seen.has(v)) return true;
    seen.add(v);
    return Object.isFrozen(v) && Reflect.ownKeys(v).every((k) => isDeepFrozen((v as Record<PropertyKey, unknown>)[k], seen));
  };
  const failedRun = () =>
    run({
      bundle: () => [...GOOD_BUNDLE, { rel: "dist/e.js", text: 'import "../evaluation/x.js";' }],
      prepare: () => ({ kind: "error", code: "EIO" }),
      cleanup: () => E("EBUSY"),
    }).result;

  it("every nesting level is frozen, including findings, notMeasured, controls and reasons", async () => {
    const r = await failedRun();
    expect(isDeepFrozen(r)).toBe(true);
    expect(Array.isArray(meas(r, "import_analysis")["findings"])).toBe(true);
    expect((meas(r, "import_analysis")["findings"] as unknown[]).length).toBeGreaterThan(0);
    expect(Array.isArray(meas(r, "read_denial")["reasons"])).toBe(true);
    expect(Array.isArray(meas(r, "mount_inspection")["notMeasured"])).toBe(true);
    expect(typeof meas(r, "read_denial")["controls"]).toBe("object");
    const verified = await run().result;
    expect(isDeepFrozen(verified)).toBe(true);
  });

  it("a mutation at every nesting level throws (ES modules are strict) and leaves the value unchanged", async () => {
    const r = await failedRun();
    const before = JSON.stringify(r);
    const asAny = (x: unknown): any => x; // eslint-disable-line @typescript-eslint/no-explicit-any
    const findings = meas(r, "import_analysis")["findings"] as unknown[];
    const attempts: [string, () => void][] = [
      ["result.status", () => { asAny(r).status = "verified"; }],
      ["result.runId", () => { asAny(r).runId = "x"; }],
      ["checks.push", () => { asAny(r.checks).push({}); }],
      ["checks[0]", () => { asAny(r.checks)[0] = {}; }],
      ["check.status", () => { asAny(r.checks[0]).status = "verified"; }],
      ["check.measured replace", () => { asAny(r.checks[0]).measured = {}; }],
      ["measured add", () => { asAny(r.checks[0]?.measured).extra = 1; }],
      ["measured change", () => { asAny(meas(r, "import_analysis"))["filesTotal"] = -1; }],
      ["findings.push", () => { asAny(findings).push(1); }],
      ["findings[0].code", () => { asAny(findings[0]).code = "x"; }],
      ["reasons.push", () => { asAny(meas(r, "read_denial")["reasons"]).push("x"); }],
      ["reasons[0]", () => { asAny(meas(r, "read_denial")["reasons"])[0] = "x"; }],
      ["controls.readable", () => { asAny(meas(r, "read_denial")["controls"]).readable = true; }],
      ["notMeasured.push", () => { asAny(meas(r, "mount_inspection")["notMeasured"]).push("x"); }],
      ["notMeasured.length", () => { asAny(meas(r, "mount_inspection")["notMeasured"]).length = 0; }],
      ["delete status", () => { delete asAny(r).status; }],
    ];
    for (const [name, f] of attempts) expect(f, name).toThrow(TypeError);
    expect(JSON.stringify(r)).toBe(before);
  });

  it("measured values are copies: the shared module constant is neither returned nor shared between runs", async () => {
    const a = await run().result;
    const b = await run().result;
    const na = meas(a, "mount_inspection")["notMeasured"];
    const nb = meas(b, "mount_inspection")["notMeasured"];
    expect(na).toEqual([...MOUNT_NOT_MEASURED]);
    expect(na).not.toBe(MOUNT_NOT_MEASURED);
    expect(na).not.toBe(nb);
  });

  it("control: the depth check detects a result whose nested levels are not frozen (deepFreeze removed)", async () => {
    const r = await run().result;
    const raw = structuredClone(r) as AccessDenialResult;
    const shallow = Object.freeze({
      ...raw,
      checks: Object.freeze(raw.checks.map((c) => Object.freeze({ ...c, measured: Object.freeze({ ...(c.measured as object) }) }))),
    });
    expect(isDeepFrozen(shallow)).toBe(false); // nested arrays such as notMeasured stay mutable
    expect(() => { (meas(shallow as AccessDenialResult, "mount_inspection")["notMeasured"] as string[]).push("x"); }).not.toThrow();
    expect(isDeepFrozen(raw)).toBe(false);
  });

  it("the brand is true for the returned value and false for every copy", async () => {
    const r = await run().result;
    expect(isAccessDenialResult(r)).toBe(true);
    expect(isAccessDenialResult(structuredClone(r))).toBe(false);
    expect(isAccessDenialResult({ ...r })).toBe(false);
    expect(isAccessDenialResult(JSON.parse(JSON.stringify(r)))).toBe(false);
  });
});

// Guards: verify.ts checkEnvNames and composeAllowedEnvNames (decision 2 of 2026-11-17: no credential name is added by the module).
describe("mutation check (7): environment allowlist", () => {
  it("an unexpected name fails env_names and the overall status (also near-misses of allowed names)", async () => {
    for (const extra of ["PATH", "KIRO_API_KEY", "home", "HOME ", "", "PHOENIX_RUN_ID2", "X"]) {
      const r = await run({ envNames: () => [...ALLOWED, extra] }).result;
      expect(chk(r, "env_names").status, JSON.stringify(extra)).toBe("failed");
      expect(meas(r, "env_names")["reason"], JSON.stringify(extra)).toBe("env_unexpected");
      expect(r.status).toBe("failed");
    }
    expect(chk(await run().result, "env_names").status).toBe("verified");
  });
  it("the module constants are exactly the four Launcher names", () => {
    expect([...MODULE_ENV_NAMES]).toEqual(["HOME", "PHOENIX_LEASE_D_MS", "PHOENIX_LEASE_NONCE", "PHOENIX_RUN_ID"]);
  });
  it("composeAllowedEnvNames is a pure function of its argument and the four constants and adds nothing else", () => {
    expect(composeAllowedEnvNames.length).toBe(1);
    fc.assert(
      fc.property(fc.array(fc.string({ maxLength: 12 }), { maxLength: 10 }), (names) => {
        const out = composeAllowedEnvNames(names);
        expect(new Set(out)).toEqual(new Set([...names, ...MODULE_ENV_NAMES]));
        expect(out).toEqual([...new Set(out)].sort());
        expect(composeAllowedEnvNames(names)).toEqual(out); // deterministic
      }),
      { numRuns: 100, seed: 4203 },
    );
    expect(composeAllowedEnvNames(["A"])).not.toContain("KIRO_API_KEY"); // a credential name is never added by the module
  });
});

// Support helper: design item 3 (UNVERIFIED with a real container; task 4.11 does the independent verification).
describe("assertDenialWithControl (test support, fakes only)", () => {
  const record = (sha: string, outcome: ProbeOutcome, only?: number): ProbeRunRecord => ({
    probeSetSha256: sha,
    probes: PROBE_LOCATIONS.slice(0, only).flatMap((l) => PROBE_OPS.map((op) => ({ locationId: l.id, op, outcome }))),
  });
  const control = record(PROBE_SET_SHA256, OK);

  it("counts a denial only with a control of the same probe set where every probe was readable", () => {
    const r = assertDenialWithControl(record(PROBE_SET_SHA256, E("EACCES")), control);
    expect(r).toEqual({ counts: true, deniedCount: PROBE_LOCATIONS.length * PROBE_OPS.length, reasons: [] });
  });
  it("an absent path is not a denial: it counts as consistent but with zero denials", () => {
    const r = assertDenialWithControl(record(PROBE_SET_SHA256, E("ENOENT")), control);
    expect(r.counts).toBe(true);
    expect(r.deniedCount).toBe(0);
  });
  it("rejects a control with a different probeSetSha256", () => {
    const r = assertDenialWithControl(record(PROBE_SET_SHA256, E("EACCES")), record("0".repeat(64), OK));
    expect(r.counts).toBe(false);
    expect(r.reasons).toContain("probe_set_differs");
  });
  it("rejects a control in which any probe was not readable", () => {
    const weak: ProbeRunRecord = { ...control, probes: control.probes.map((p, i) => (i === 3 ? { ...p, outcome: E("ENOENT") } : p)) };
    const r = assertDenialWithControl(record(PROBE_SET_SHA256, E("EACCES")), weak);
    expect(r.counts).toBe(false);
    expect(r.reasons).toContain("control_not_readable");
  });
  it("rejects a control that does not cover every runtime probe, and empty runs", () => {
    expect(assertDenialWithControl(record(PROBE_SET_SHA256, E("EACCES")), record(PROBE_SET_SHA256, OK, 2)).reasons).toContain("control_does_not_cover_probes");
    expect(assertDenialWithControl(record(PROBE_SET_SHA256, E("EACCES")), { probeSetSha256: PROBE_SET_SHA256, probes: [] }).counts).toBe(false);
    expect(assertDenialWithControl({ probeSetSha256: PROBE_SET_SHA256, probes: [] }, control).counts).toBe(false);
  });
  it("rejects a runtime run with a readable or unexpected probe, and malformed input", () => {
    expect(assertDenialWithControl(record(PROBE_SET_SHA256, OK), control).reasons).toContain("runtime_probe_readable");
    expect(assertDenialWithControl(record(PROBE_SET_SHA256, E("EIO")), control).reasons).toContain("runtime_probe_unexpected");
    for (const bad of [null, undefined, {}, { probeSetSha256: 1, probes: [] }]) {
      expect(assertDenialWithControl(bad as never, control).counts).toBe(false);
      expect(assertDenialWithControl(control, bad as never).counts).toBe(false);
    }
  });
});
