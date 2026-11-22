// Task 4.6 W3-A: the Run_Manifest `ground_truth_access_denial` and `isolationChecks` sections (`src/manifest/isolationSection.ts`).
// The positive cases use REAL results of `verifyGroundTruthAccessDenial` over fake ports (test-only fixed values, no measurement).
// **Validates: Requirements 12.8, 15.12, 15.14**
import { describe, expect, it } from "vitest";
import { CHECK_ORDER, isAccessDenialResult, verifyGroundTruthAccessDenial } from "../src/isolation/index.js";
import { ISOLATION_CHECK_IDS, buildGroundTruthAccessDenial, buildIsolationChecks } from "../src/manifest/isolationSection.js";
import { ALLOWED, E, makeDeps } from "./support/isolationFakes.js";

const CANARY = "canary-secret-value-91x";
const verified = async () => {
  const r = await verifyGroundTruthAccessDenial(makeDeps().deps, { allowedEnvNames: ALLOWED });
  expect(r.status).toBe("verified");
  expect(isAccessDenialResult(r)).toBe(true);
  return r;
};
const failedResult = async () => verifyGroundTruthAccessDenial(makeDeps({ tryCreate: () => ({ kind: "ok" }) }).deps, { allowedEnvNames: ALLOWED });
const clone = (v: unknown): any => JSON.parse(JSON.stringify(v)); // eslint-disable-line @typescript-eslint/no-explicit-any
const codeOf = (r: { ok: boolean; error?: { code: string } }): string | undefined => (r.ok ? undefined : r.error?.code);

describe("agreement with the isolation module", () => {
  it("the six check ids and their order equal CHECK_ORDER", () => {
    expect([...ISOLATION_CHECK_IDS]).toEqual([...CHECK_ORDER]);
  });
});

describe("ground_truth_access_denial", () => {
  it("is verified, executed in this Run, and lists the two named checks, for a real verified result", async () => {
    const r = buildGroundTruthAccessDenial(await verified());
    expect(r).toEqual({ ok: true, value: { status: "verified", executedInThisRun: true, checks: ["read_denial", "mount_inspection"] } });
  });

  it("refuses a result that is not verified (a real failed result), and the check list of the failed one is still six", async () => {
    const f = await failedResult();
    expect(f.status).toBe("failed");
    expect(codeOf(buildGroundTruthAccessDenial(f))).toBe("status_not_verified");
    expect(codeOf(buildIsolationChecks(f))).toBe("status_not_verified");
    expect(f.checks).toHaveLength(6);
  });

  it("a fresh array of constants on every call", async () => {
    const v = await verified();
    const a = buildGroundTruthAccessDenial(v);
    const b = buildGroundTruthAccessDenial(v);
    expect(a.ok && b.ok && a.value.checks !== b.value.checks).toBe(true);
  });
});

describe("isolationChecks", () => {
  it("lists the six checks in the fixed order with id, status, measuredBy and a copy of measured", async () => {
    const v = await verified();
    const r = buildIsolationChecks(v);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.map((c) => c.id)).toEqual([...CHECK_ORDER]);
    for (let i = 0; i < 6; i += 1) {
      const src = v.checks[i]!;
      const out = r.value[i]!;
      expect(out).toEqual({ id: src.id, status: "verified", measuredBy: src.measuredBy, measured: src.measured });
      expect(out).not.toBe(src);
      expect(out.measured).not.toBe(src.measured);
      expect(Object.keys(out).sort()).toEqual(["id", "measured", "measuredBy", "status"]);
    }
  });

  it("does not change a frozen input and the copy is independent of it", async () => {
    const v = await verified();
    const before = JSON.stringify(v);
    const r = buildIsolationChecks(v);
    expect(JSON.stringify(v)).toBe(before);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    (r.value[0]!.measured as { [k: string]: unknown })["x"] = 1;
    expect(JSON.stringify(v)).toBe(before);
  });

  it("refuses malformed data with a closed code and a position (each with the passing control above)", async () => {
    const base = clone(await verified());
    const mut = (f: (x: any) => void): unknown => { const x = clone(base); f(x); return x; }; // eslint-disable-line @typescript-eslint/no-explicit-any
    const cases: [unknown, string, number | undefined][] = [
      [undefined, "input_not_plain_object", undefined],
      [[], "input_not_plain_object", undefined],
      [mut((x) => { x.extra = 1; }), "input_keys", undefined],
      [mut((x) => { delete x.runId; }), "input_keys", undefined],
      [mut((x) => { x.status = "failed"; }), "status_not_verified", undefined],
      [mut((x) => { x.checks = "no"; }), "checks_not_array", undefined],
      [mut((x) => { x.checks.pop(); }), "checks_count", undefined],
      [mut((x) => { x.checks.push(x.checks[0]); }), "checks_count", undefined],
      [mut((x) => { x.checks[2] = 1; }), "entry_not_plain_object", 2],
      [mut((x) => { x.checks[1].extra = 1; }), "entry_keys", 1],
      [mut((x) => { delete x.checks[3].measured; }), "entry_keys", 3],
      [mut((x) => { [x.checks[0], x.checks[1]] = [x.checks[1], x.checks[0]]; }), "entry_id", 0],
      [mut((x) => { x.checks[4].id = "other"; }), "entry_id", 4],
      [mut((x) => { x.checks[5].status = "failed"; }), "entry_status_not_verified", 5],
      [mut((x) => { x.checks[0].measuredBy = "human"; }), "entry_measured_by", 0],
    ];
    for (const [input, code, index] of cases) {
      const r = buildIsolationChecks(input);
      expect(r.ok, code).toBe(false);
      if (r.ok) continue;
      expect(r.error.code).toBe(code);
      expect(r.error.index).toBe(index);
      expect(codeOf(buildGroundTruthAccessDenial(input))).toBe(code);
    }
  });

  it("refuses a measured value that is not plain JSON, and never runs a getter", async () => {
    const base = clone(await verified());
    base.checks[2].measured = { a: undefined };
    expect(buildIsolationChecks(base)).toEqual({ ok: false, error: { code: "entry_measured_not_json", index: 2 } });
    let ran = false;
    const g = clone(await verified());
    Object.defineProperty(g.checks[1], "measured", { enumerable: true, get: () => ((ran = true), {}) });
    expect(codeOf(buildIsolationChecks(g))).toBe("entry_not_plain_object"); // an accessor makes the entry not plain data
    expect(ran).toBe(false);
    const withSymbol = clone(await verified());
    withSymbol.checks[0][Symbol("s")] = 1;
    expect(codeOf(buildIsolationChecks(withSymbol))).toBe("entry_not_plain_object");
  });

  it("does not echo a value of the input in an error", async () => {
    const base = clone(await verified());
    base.checks[0].id = CANARY;
    base.checks[1].measured = { note: CANARY };
    expect(JSON.stringify(buildIsolationChecks(base))).not.toContain(CANARY);
  });

  it("a real result with a failed check is refused as not verified (the failed check is not listed as verified)", async () => {
    const f = await verifyGroundTruthAccessDenial(makeDeps({ attestation: () => ({ kind: "missing" }), tryCreate: () => E("EROFS") }).deps, { allowedEnvNames: ALLOWED });
    expect(f.status).toBe("failed");
    expect(codeOf(buildIsolationChecks(f))).toBe("status_not_verified");
  });
});