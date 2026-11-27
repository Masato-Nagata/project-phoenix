// Task 4.7 step A3 (human decision of 2026-11-27; R24.16, R24.19): the Run_Manifest `residualRisks` lists the single-session scope of the
// mutual exclusion as the seventh residual risk `mutual_exclusion_single_session_scope`, always `unresolved`. The six existing risks, the
// Manifest schema and `schemaVersion` are unchanged, a Run sealed with the six old entries stays accepted, and `compareRuns` and `replayRun`
// treat old and new Runs by their existing contracts. Deterministic and offline: synthetic Runs on a MemoryFileSystem and Runs recorded by
// the real stack (test/helpers/replayFixtures.ts). Nothing here measures the mutex or a logon session.
// **Validates: Requirements 24.16, 24.19, 22.1, 22.4, 12.23**
import { describe, expect, it } from "vitest";
import { MANIFEST_FILE, MemoryFileSystem, acceptRun, compareRuns, joinPath, type Json } from "../src/index.js";
import { RESIDUAL_RISK_IDS } from "../src/isolation/types.js";
import { RESIDUAL_RISK_ID_LIST, buildResidualRisks } from "../src/manifest/residualRisksSection.js";
import { replayRun } from "../src/replayMain.js";
import { BASE_STEPS, appendStep, rewriteSealedManifest, sealRun } from "./helpers/compareFixtures.js";
import { POLICY_BYTES, TABLE_BYTES, manifestOf, memoryPort, ok, recordRun, rewriteRun, snapshotOf, type Recorded } from "./helpers/replayFixtures.js";
import { text } from "./helpers/runFixtures.js";

const SIX = [
  "read_denial_positive_control_unverified",
  "mount_inspection_source_kind_unmeasured",
  "mount_inspection_run_binding_weak",
  "mount_inspection_pre_start_snapshot",
  "import_analysis_self_attestation",
  "env_values_not_inspected",
] as const;
const NEW_ID = "mutual_exclusion_single_session_scope";
const OLD_ENTRIES = SIX.map((id) => ({ id, status: "unresolved" }));
const NEW_ENTRIES = [...OLD_ENTRIES, { id: NEW_ID, status: "unresolved" }];

const asJson = (v: unknown): Json => v as Json;
async function sealed(fs: MemoryFileSystem, name: string, residualRisks: readonly { id: string; status: string }[], steps = BASE_STEPS): Promise<string> {
  const { dir } = await sealRun(fs, name, steps, { residualRisks: asJson(residualRisks) });
  return dir;
}
async function replayOf(r: Recorded) {
  return replayRun({ port: memoryPort(r.mem), runDir: r.dir, policyConfig: ok(POLICY_BYTES()), preparationTable: ok(TABLE_BYTES()) });
}

describe("the seventh residual risk of R24.19", () => {
  it("a new Run records seven entries: the six existing ones unchanged and in order, then the new one, each unresolved", () => {
    const risks = buildResidualRisks();
    expect(risks).toHaveLength(7);
    expect(risks.slice(0, 6)).toEqual(OLD_ENTRIES);
    expect(risks[6]).toEqual({ id: "mutual_exclusion_single_session_scope", status: "unresolved" });
    expect(risks.every((r) => r.status === "unresolved")).toBe(true);
  });

  it("the identifier is last and once in both identifier lists, and the two lists are equal", () => {
    for (const list of [[...RESIDUAL_RISK_ID_LIST], [...RESIDUAL_RISK_IDS]]) {
      expect(list.slice(0, 6)).toEqual([...SIX]);
      expect(list[6]).toBe(NEW_ID);
      expect(list.filter((id) => id === NEW_ID)).toHaveLength(1);
      expect(list).toHaveLength(7);
    }
    expect([...RESIDUAL_RISK_ID_LIST]).toEqual([...RESIDUAL_RISK_IDS]);
  });

  it("an entry holds exactly an id and the status unresolved, on every call, and a change of one result does not reach the next", () => {
    const a = buildResidualRisks();
    for (const entry of a) expect(Object.keys(entry).sort()).toEqual(["id", "status"]);
    (a[6] as { status: string }).status = "verified";
    a.pop();
    const b = buildResidualRisks();
    expect(b[6]).toEqual({ id: NEW_ID, status: "unresolved" });
    expect(b[6]).not.toBe(buildResidualRisks()[6]);
    expect(b.filter((r) => r.status !== "unresolved")).toEqual([]);
  });

  it("the Manifest schema and schemaVersion are unchanged: a Run sealed with the six old entries and a Run sealed with the seven new ones are both accepted", async () => {
    const fs = new MemoryFileSystem();
    const oldDir = await sealed(fs, "run-old", OLD_ENTRIES);
    const newDir = await sealed(fs, "run-new", NEW_ENTRIES);
    expect((await acceptRun(fs, oldDir)).accepted).toBe(true);
    expect((await acceptRun(fs, newDir)).accepted).toBe(true);
    const oldManifest = JSON.parse(text(fs.peek(joinPath(oldDir, MANIFEST_FILE)))) as { schemaVersion: number; residualRisks: unknown[] };
    const newManifest = JSON.parse(text(fs.peek(joinPath(newDir, MANIFEST_FILE)))) as { schemaVersion: number; residualRisks: unknown[] };
    expect(oldManifest.residualRisks).toHaveLength(6);
    expect(newManifest.residualRisks).toHaveLength(7);
    expect(oldManifest.schemaVersion).toBe(2);
    expect(newManifest.schemaVersion).toBe(2);
  });

  it("the new risk cannot be claimed as verified: a Manifest that does so is not accepted, while the unresolved one is (negative control)", async () => {
    const fs = new MemoryFileSystem();
    const good = await sealed(fs, "run-good", NEW_ENTRIES);
    const bad = await sealed(fs, "run-bad", NEW_ENTRIES);
    expect((await acceptRun(fs, good)).accepted).toBe(true);
    await rewriteSealedManifest(fs, bad, (m) => {
      (m["residualRisks"] as unknown as { id: string; status: string }[])[6]!.status = "verified";
    });
    const verdict = await acceptRun(fs, bad);
    expect(verdict.accepted).toBe(false);
    expect(verdict).toMatchObject({ accepted: false, reason: "manifest_invalid" });
  });

  it("compareRuns: a Run with six old entries and a Run with seven new entries and the same records are identical; other records stay different (control)", async () => {
    const fs = new MemoryFileSystem();
    const oldDir = await sealed(fs, "run-old", OLD_ENTRIES);
    const newDir = await sealed(fs, "run-new", NEW_ENTRIES);
    const otherDir = await sealed(fs, "run-other", NEW_ENTRIES, [...BASE_STEPS.slice(0, 2), appendStep("error", { n: 3 })]);
    for (const d of [oldDir, newDir, otherDir]) expect((await acceptRun(fs, d)).accepted, d).toBe(true);
    expect(await compareRuns(fs, oldDir, newDir)).toEqual({ result: "identical", records: 3 });
    expect(await compareRuns(fs, newDir, oldDir)).toEqual({ result: "identical", records: 3 });
    expect(await compareRuns(fs, oldDir, otherDir)).toMatchObject({ result: "different", firstDifferingRecord: "rec-000003", difference: "content" });
  });

  it("a Run recorded by the real stack carries the seven entries in its Manifest and is accepted", async () => {
    const r = await recordRun();
    expect(manifestOf(r.mem)["residualRisks"]).toEqual(NEW_ENTRIES);
    expect(manifestOf(r.mem)["schemaVersion"]).toBe(2);
    expect((await acceptRun(r.mem, r.dir)).accepted).toBe(true);
  });

  it("replayRun treats the new Run and the same Run rewritten with the six old entries alike: identical, equal results, no residual-risk or isolation claim, nothing written", async () => {
    const recorded = await recordRun();
    const seven = await replayOf(recorded);
    await rewriteRun(recorded.mem, (records) => records, {
      editManifest: (m) => {
        m["residualRisks"] = asJson(OLD_ENTRIES);
      },
    });
    expect(manifestOf(recorded.mem)["residualRisks"]).toEqual(OLD_ENTRIES);
    const before = snapshotOf(recorded.mem);
    const six = await replayOf(recorded);
    expect(seven).toMatchObject({ result: "identical", guarantees: { isolation: "not_measured" } });
    expect(six).toMatchObject({ result: "identical", guarantees: { isolation: "not_measured" } });
    expect(six).toEqual(seven);
    for (const result of [seven, six]) {
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(NEW_ID);
      expect(serialized).not.toContain("residualRisks");
    }
    expect(snapshotOf(recorded.mem)).toEqual(before);
  });
});
