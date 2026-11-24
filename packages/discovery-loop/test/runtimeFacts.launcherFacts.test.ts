// Task 4.6 W4-C part C2: the reading and the checking of launcher-facts.json (`src/runtimeFacts/launcherFacts.ts`). Deterministic and offline.
// Every value below (run id, image id, hashes) is SYNTHETIC. The pure tests use a fake port that answers from memory; the adapter tests
// read synthetic files in a temporary directory that the test creates and removes. No real lease, approval or evaluation file is read.
// **Validates: Requirements 22.3, 24.7, 15.12**
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RUN_ID_PATTERN } from "../src/isolation/attestation.js";
import { buildToolVersionsSection } from "../src/manifest/toolVersionsSection.js";
import { createLauncherFactsReadAdapter, createLeaseJsonReadAdapter } from "../src/runtimeFacts/fsReadAdapters.js";
import { LEASE_JSON_MAX_BYTES } from "../src/runtimeFacts/leaseFacts.js";
import {
  AUDIT_CONFIG_KINDS,
  LAUNCHER_FACTS_KEYS,
  LAUNCHER_FACTS_MAX_BYTES,
  LAUNCHER_FACTS_SCHEMA_VERSION,
  compareLauncherFactsSnapshots,
  confirmLauncherFactsUnchanged,
  createLauncherFactsSnapshot,
  isLauncherFactsSnapshot,
  parseLauncherFactsText,
  readLauncherFactsSnapshot,
  type LauncherFactsErrorCode,
  type LauncherFactsReadAnswer,
  type LauncherFactsReadPort,
} from "../src/runtimeFacts/launcherFacts.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const CANARY = "canary-secret-value-91x";
const RUN_ID = "run-20300101T000000Z-0123456789ab";
const IMAGE_ID = `sha256:${sha("synthetic-image")}`;
const AUDIT_SHA = sha("synthetic-audit-config-bytes");

const goodObject = (): Record<string, unknown> => ({
  schema_version: 2,
  issued_by: "launcher",
  run_id: RUN_ID,
  runtime_image_id: IMAGE_ID,
  audit_config_sha256: AUDIT_SHA,
  audit_config_kind: "fixture",
});
const textOf = (o: Record<string, unknown>): string => JSON.stringify(o);
const goodText = (): string => textOf(goodObject());
const withField = (k: string, v: unknown): string => textOf({ ...goodObject(), [k]: v });
const without = (k: string): string => {
  const o = goodObject();
  delete o[k];
  return textOf(o);
};
const expectation = (): Record<string, unknown> => ({ runId: RUN_ID, auditConfigSha256: AUDIT_SHA });
const codeOf = (r: { ok: boolean; error?: { code: string } }): string | undefined => (r.ok ? undefined : r.error?.code);
const snap = (text = goodText()) => {
  const r = createLauncherFactsSnapshot(text, expectation());
  if (!r.ok) throw new Error("test setup: " + r.error.code);
  return r.value;
};

/** A fake port: answers from a script, one answer per call (the last repeats), and counts the calls. */
function fakePort(...answers: Array<LauncherFactsReadAnswer | "throw" | unknown>): LauncherFactsReadPort & { calls: number } {
  const port = {
    calls: 0,
    readLauncherFacts(): LauncherFactsReadAnswer {
      const a = answers[Math.min(port.calls, answers.length - 1)];
      port.calls += 1;
      if (a === "throw") throw new Error(CANARY);
      return a as LauncherFactsReadAnswer;
    },
  };
  return port;
}
const ok = (text: string): LauncherFactsReadAnswer => ({ kind: "ok", text });

describe("the contract: six keys, version 2, the kind fixture only", () => {
  it("lists exactly the six keys of the contract, including the audit configuration kind", () => {
    expect([...LAUNCHER_FACTS_KEYS]).toEqual(Object.keys(goodObject()).sort());
    expect(LAUNCHER_FACTS_KEYS).toHaveLength(6);
    expect(LAUNCHER_FACTS_SCHEMA_VERSION).toBe(2);
    expect(LAUNCHER_FACTS_KEYS).toContain("audit_config_kind");
  });

  it("defines the kind fixture and no other kind", () => {
    expect([...AUDIT_CONFIG_KINDS]).toEqual(["fixture"]);
    expect(Object.isFrozen(AUDIT_CONFIG_KINDS)).toBe(true);
  });

  it("refuses a version-1 file (the five keys without the kind) and every unknown version: version 1 is never sealed", () => {
    const v1 = { schema_version: 1, issued_by: "launcher", run_id: RUN_ID, runtime_image_id: IMAGE_ID, audit_config_sha256: AUDIT_SHA };
    expect(codeOf(parseLauncherFactsText(textOf(v1)))).toBe("field_missing");
    expect(codeOf(parseLauncherFactsText(textOf({ ...v1, audit_config_kind: "fixture" })))).toBe("schema_version_invalid");
    expect(codeOf(createLauncherFactsSnapshot(textOf(v1), expectation()))).toBe("field_missing");
    for (const v of [1, 3, 99]) expect(codeOf(parseLauncherFactsText(withField("schema_version", v))), String(v)).toBe("schema_version_invalid");
  });

  it("refuses a missing kind and every kind other than fixture (no value for a real configuration is defined)", () => {
    expect(codeOf(parseLauncherFactsText(without("audit_config_kind")))).toBe("field_missing");
    for (const v of ["real", "production", "Fixture", "FIXTURE", " fixture", "fixture ", "", "fixture\n", null, 1, true, [], {}, ["fixture"]]) {
      expect(codeOf(parseLauncherFactsText(withField("audit_config_kind", v))), JSON.stringify(v)).toBe("audit_config_kind_invalid");
    }
  });

  it("uses the same size bound as lease.json (4 KiB)", () => {
    expect(LAUNCHER_FACTS_MAX_BYTES).toBe(4096);
    expect(LAUNCHER_FACTS_MAX_BYTES).toBe(LEASE_JSON_MAX_BYTES);
  });
});

describe("parseLauncherFactsText", () => {
  it("accepts the six keys and returns frozen declared values", () => {
    const r = parseLauncherFactsText(goodText());
    expect(r).toEqual({ ok: true, value: { runId: RUN_ID, runtimeImageId: IMAGE_ID, auditConfigSha256: AUDIT_SHA, auditConfigKind: "fixture" } });
    if (r.ok) expect(Object.isFrozen(r.value)).toBe(true);
  });

  it("accepts any key order and insignificant white space", () => {
    const o = goodObject();
    const reversed = Object.fromEntries(Object.entries(o).reverse());
    expect(parseLauncherFactsText(`  ${JSON.stringify(reversed, null, 2)}\n`).ok).toBe(true);
  });

  it("refuses a missing key, one by one, and an extra key (including a kind)", () => {
    for (const k of Object.keys(goodObject())) expect(codeOf(parseLauncherFactsText(without(k))), k).toBe("field_missing");
    for (const extra of ["kind", "audit_config_kind_declared_by", "container_id", "x"]) {
      expect(codeOf(parseLauncherFactsText(textOf({ ...goodObject(), [extra]: "fixture" }))), extra).toBe("field_unknown");
    }
    expect(codeOf(parseLauncherFactsText(textOf({ ...goodObject(), __proto__x: 1 })))).toBe("field_unknown");
  });

  it("refuses a wrong schema version, issuer, run id, image id and audit hash", () => {
    for (const v of [0, 1, 3, "2", 2.5, null, true, [], {}]) expect(codeOf(parseLauncherFactsText(withField("schema_version", v))), String(v)).toBe("schema_version_invalid");
    for (const v of ["Launcher", "kiro", "", null, 1]) expect(codeOf(parseLauncherFactsText(withField("issued_by", v))), String(v)).toBe("issued_by_invalid");
    for (const v of ["", "run-1", `${RUN_ID}x`, ` ${RUN_ID}`, RUN_ID.toUpperCase(), "run-20300101T000000Z-0123456789AB", 1, null]) {
      expect(codeOf(parseLauncherFactsText(withField("run_id", v))), String(v)).toBe("run_id_invalid");
    }
    const hex = sha("x");
    for (const v of [hex, `sha256:${hex.slice(1)}`, `sha256:${hex}0`, `sha256:${hex.toUpperCase()}`, `SHA256:${hex}`, `sha256:${hex}\n`, `sha256:${"0".repeat(64)}`, "", 1, null]) {
      expect(codeOf(parseLauncherFactsText(withField("runtime_image_id", v))), String(v)).toBe("runtime_image_id_invalid");
    }
    for (const v of [hex.slice(1), `${hex}0`, hex.toUpperCase(), `${hex}\n`, "0".repeat(64), `sha256:${hex}`, "", 1, null]) {
      expect(codeOf(parseLauncherFactsText(withField("audit_config_sha256", v))), String(v)).toBe("audit_config_sha256_invalid");
    }
  });

  it("refuses text that is not strict JSON: a duplicate key, a BOM, trailing text, a non-object root, a non-string", () => {
    const dup = '{"schema_version":2,"schema_version":2,"issued_by":"launcher","run_id":"' + RUN_ID + '","runtime_image_id":"' + IMAGE_ID + '","audit_config_sha256":"' + AUDIT_SHA + '","audit_config_kind":"fixture"}';
    expect(codeOf(parseLauncherFactsText(dup))).toBe("facts_invalid_json");
    for (const bad of ["", "{", "not json", "\ufeff" + goodText(), goodText() + "x"]) expect(codeOf(parseLauncherFactsText(bad)), bad).toBe("facts_invalid_json");
    for (const bad of ["[]", "null", "1", '"x"']) expect(codeOf(parseLauncherFactsText(bad)), bad).toBe("facts_not_object");
    for (const bad of [undefined, null, 1, {}, Buffer.from(goodText())]) expect(codeOf(parseLauncherFactsText(bad))).toBe("facts_not_string");
  });

  it("applies the 4 KiB bound to the text", () => {
    const base = goodObject();
    const pad = (n: number): string => {
      const body = textOf({ ...base, schema_version: 2 });
      return body.slice(0, -1) + " ".repeat(n - Buffer.byteLength(body, "utf8")) + "}";
    };
    expect(Buffer.byteLength(pad(LAUNCHER_FACTS_MAX_BYTES), "utf8")).toBe(LAUNCHER_FACTS_MAX_BYTES);
    expect(parseLauncherFactsText(pad(LAUNCHER_FACTS_MAX_BYTES)).ok).toBe(true);
    expect(codeOf(parseLauncherFactsText(pad(LAUNCHER_FACTS_MAX_BYTES + 1)))).toBe("facts_too_large");
  });
});

describe("createLauncherFactsSnapshot: declared versus observed", () => {
  it("keeps the declared values, the values confirmed by the runtime, and the one value the runtime cannot verify apart", () => {
    const s = snap();
    expect(s.declaredBy).toBe("launcher");
    expect(s.declared).toEqual({ runId: RUN_ID, runtimeImageId: IMAGE_ID, auditConfigSha256: AUDIT_SHA, auditConfigKind: "fixture" });
    expect(s.confirmedByRuntime).toEqual({ runId: RUN_ID, auditConfigSha256: AUDIT_SHA });
    expect(s.unverifiedByRuntime).toEqual(["audit_config_kind", "runtime_image_id"]);
    expect(Object.keys(s.confirmedByRuntime)).not.toContain("runtimeImageId");
    expect(Object.keys(s.confirmedByRuntime)).not.toContain("auditConfigKind");
    expect(s.textSha256).toBe(sha(goodText()));
    expect(isLauncherFactsSnapshot(s)).toBe(true);
    for (const o of [s, s.declared, s.confirmedByRuntime, s.unverifiedByRuntime]) expect(Object.isFrozen(o)).toBe(true);
  });

  it("refuses a run id that differs from the one the runtime holds", () => {
    const other = "run-20300101T000000Z-ffffffffffff";
    expect(RUN_ID_PATTERN.test(other)).toBe(true);
    expect(createLauncherFactsSnapshot(goodText(), { runId: other, auditConfigSha256: AUDIT_SHA })).toEqual({ ok: false, error: { code: "run_id_mismatch" } });
  });

  it("refuses an audit configuration hash that differs from the one the runtime measured, and an image id change changes nothing there", () => {
    expect(createLauncherFactsSnapshot(goodText(), { runId: RUN_ID, auditConfigSha256: sha("another") })).toEqual({ ok: false, error: { code: "audit_config_sha256_mismatch" } });
    // the image id is not cross-checked: another valid image id is accepted as a declaration
    const other = withField("runtime_image_id", `sha256:${sha("another-image")}`);
    const s = createLauncherFactsSnapshot(other, expectation());
    expect(s.ok && s.value.declared.runtimeImageId).toBe(`sha256:${sha("another-image")}`);
  });

  it("refuses a bad expectation first, with its own codes", () => {
    const cases: Array<[unknown, string]> = [
      [undefined, "expectation_not_plain_object"],
      [[], "expectation_not_plain_object"],
      [{}, "expectation_keys"],
      [{ ...expectation(), extra: 1 }, "expectation_keys"],
      [{ runId: "run-1", auditConfigSha256: AUDIT_SHA }, "expectation_run_id_invalid"],
      [{ runId: RUN_ID, auditConfigSha256: "0".repeat(64) }, "expectation_audit_sha256_invalid"],
      [{ runId: RUN_ID, auditConfigSha256: AUDIT_SHA.toUpperCase() }, "expectation_audit_sha256_invalid"],
    ];
    for (const [e, code] of cases) expect(codeOf(createLauncherFactsSnapshot("not even json", e)), JSON.stringify(e)).toBe(code);
  });

  it("is not forgeable: a copy or a look-alike is not a snapshot", () => {
    const s = snap();
    for (const fake of [{ ...s }, JSON.parse(JSON.stringify(s)), Object.create(s), null, undefined, 1, "x"]) expect(isLauncherFactsSnapshot(fake)).toBe(false);
    expect(compareLauncherFactsSnapshots(s, { ...s })).toEqual({ ok: false, error: { code: "snapshot_not_issued" } });
  });

  it("compares snapshots: equal text is equal, any other text is facts_changed", () => {
    expect(compareLauncherFactsSnapshots(snap(), snap())).toEqual({ ok: true, value: true });
    const reordered = textOf(Object.fromEntries(Object.entries(goodObject()).reverse()));
    expect(codeOf(compareLauncherFactsSnapshots(snap(), snap(reordered)))).toBe("facts_changed"); // same values, different text
    const otherImage = snap(withField("runtime_image_id", `sha256:${sha("another-image")}`));
    expect(codeOf(compareLauncherFactsSnapshots(snap(), otherImage))).toBe("facts_changed");
  });

  it("the comparison covers the kind: the comparison source names auditConfigKind", () => {
    const src = readFileSync(new URL("../src/runtimeFacts/launcherFacts.ts", import.meta.url), "utf8");
    expect(src).toMatch(/a\.auditConfigKind === b\.auditConfigKind/);
  });
});

describe("reading and the re-read before sealing", () => {
  it("reads once at start-up and returns a snapshot", () => {
    const port = fakePort(ok(goodText()));
    const r = readLauncherFactsSnapshot(port, expectation());
    expect(r.ok && r.value.declared.runtimeImageId).toBe(IMAGE_ID);
    expect(port.calls).toBe(1);
  });

  it("refuses an absent file, a read error, a throwing port and an answer of the wrong shape, with closed codes", () => {
    expect(codeOf(readLauncherFactsSnapshot(fakePort({ kind: "absent" }), expectation()))).toBe("facts_read_absent");
    expect(codeOf(readLauncherFactsSnapshot(fakePort({ kind: "error" }), expectation()))).toBe("facts_read_failed");
    const t = readLauncherFactsSnapshot(fakePort("throw"), expectation());
    expect(t).toEqual({ ok: false, error: { code: "facts_read_failed" } });
    expect(JSON.stringify(t)).not.toContain(CANARY);
    for (const bad of [undefined, null, "x", 1, [], { kind: "ok" }, { kind: "ok", text: 1 }, { kind: "ok", text: "{}", extra: 1 }, { kind: "absent", extra: 1 }, { kind: "other" }]) {
      expect(codeOf(readLauncherFactsSnapshot(fakePort(bad), expectation())), JSON.stringify(bad)).toBe("facts_read_answer_invalid");
    }
  });

  it("an equal re-read returns the start-up snapshot itself", () => {
    const start = snap();
    const port = fakePort(ok(goodText()));
    const r = confirmLauncherFactsUnchanged(port, expectation(), start);
    expect(r.ok && r.value).toBe(start);
    expect(port.calls).toBe(1);
  });

  it("detects a change of one byte, a vanished file, a read error and a changed run id before sealing", () => {
    const start = snap();
    expect(codeOf(confirmLauncherFactsUnchanged(fakePort(ok(goodText() + " ")), expectation(), start))).toBe("facts_changed");
    expect(codeOf(confirmLauncherFactsUnchanged(fakePort(ok(withField("runtime_image_id", `sha256:${sha("another-image")}`))), expectation(), start))).toBe("facts_changed");
    expect(codeOf(confirmLauncherFactsUnchanged(fakePort({ kind: "absent" }), expectation(), start))).toBe("facts_read_absent");
    expect(codeOf(confirmLauncherFactsUnchanged(fakePort({ kind: "error" }), expectation(), start))).toBe("facts_read_failed");
    expect(codeOf(confirmLauncherFactsUnchanged(fakePort("throw"), expectation(), start))).toBe("facts_read_failed");
    // a different expectation at sealing time is refused even for equal text
    expect(codeOf(confirmLauncherFactsUnchanged(fakePort(ok(goodText())), { runId: RUN_ID, auditConfigSha256: sha("another") }, start))).toBe("audit_config_sha256_mismatch");
  });

  it("refuses a start value that is not a snapshot of this module, without reading", () => {
    const port = fakePort(ok(goodText()));
    for (const fake of [undefined, null, {}, { ...snap() }]) expect(codeOf(confirmLauncherFactsUnchanged(port, expectation(), fake))).toBe("snapshot_not_issued");
    expect(port.calls).toBe(0);
  });

  it("never runs a getter of the expectation or of a port answer, and does not change them", () => {
    let ran = false;
    const g = { runId: RUN_ID };
    Object.defineProperty(g, "auditConfigSha256", { enumerable: true, get: () => ((ran = true), AUDIT_SHA) });
    expect(codeOf(createLauncherFactsSnapshot(goodText(), g))).toBe("expectation_not_plain_object");
    const answer = { kind: "ok" };
    Object.defineProperty(answer, "text", { enumerable: true, get: () => ((ran = true), goodText()) });
    expect(codeOf(readLauncherFactsSnapshot(fakePort(answer), expectation()))).toBe("facts_read_answer_invalid");
    expect(ran).toBe(false);
    const frozenExpectation = Object.freeze({ runId: RUN_ID, auditConfigSha256: AUDIT_SHA });
    const frozenAnswer = Object.freeze({ kind: "ok" as const, text: goodText() });
    const before = JSON.stringify([frozenExpectation, frozenAnswer]);
    expect(readLauncherFactsSnapshot(fakePort(frozenAnswer), frozenExpectation).ok).toBe(true);
    expect(JSON.stringify([frozenExpectation, frozenAnswer])).toBe(before);
  });
});

describe("no value, secret or path in an error", () => {
  it("never echoes a field value, the text, or an environment value", () => {
    process.env["PHOENIX_TEST_CANARY_W4C2"] = CANARY;
    try {
      const cases: Array<[string, unknown]> = [
        ["run id", withField("run_id", CANARY)],
        ["image id", withField("runtime_image_id", CANARY)],
        ["audit hash", withField("audit_config_sha256", CANARY)],
        ["version", withField("schema_version", CANARY)],
        ["issuer", withField("issued_by", CANARY)],
        ["kind", withField("audit_config_kind", CANARY)],
        ["extra key", textOf({ ...goodObject(), [CANARY]: 1 })],
        ["bad json", `{"run_id": ${CANARY}`],
        ["too large", CANARY.repeat(500)],
      ];
      for (const [label, text] of cases) {
        const r = createLauncherFactsSnapshot(text, expectation());
        expect(r.ok, label).toBe(false);
        expect(JSON.stringify(r), label).not.toContain(CANARY);
        expect(Object.keys((r as { error: object }).error), label).toEqual(["code"]);
      }
      const t = readLauncherFactsSnapshot(fakePort("throw"), expectation());
      expect(JSON.stringify(t)).not.toContain(CANARY);
    } finally {
      delete process.env["PHOENIX_TEST_CANARY_W4C2"];
    }
  });
});

describe("agreement with the W3-A toolVersions section and the run id format", () => {
  it("the declared image id is accepted by buildToolVersionsSection as the runtime image id", () => {
    const s = snap();
    const section = buildToolVersionsSection({ node: "1.2.3", npm: "1.2.3", dependencies: { "a-lib": "1.0.0" }, runtimeImageDigest: s.declared.runtimeImageId });
    expect(section.ok && section.value.runtimeImageDigest).toBe(IMAGE_ID);
  });

  it("the image id grammar agrees with W3-A: what this parser accepts W3-A accepts, and what W3-A refuses this parser refuses", () => {
    const hex = sha("y");
    const cases = [`sha256:${hex}`, hex, `sha256:${hex.slice(1)}`, `sha256:${hex.toUpperCase()}`, `SHA256:${hex}`, `sha256:${hex}\n`, "", "sha256:"];
    for (const v of cases) {
      const mine = parseLauncherFactsText(withField("runtime_image_id", v)).ok;
      const theirs = buildToolVersionsSection({ node: "1.2.3", npm: "1.2.3", dependencies: { "a-lib": "1.0.0" }, runtimeImageDigest: v }).ok;
      expect(mine, v).toBe(theirs);
    }
  });

  it("the run id grammar agrees with the Launcher pattern of the isolation module", () => {
    const samples = [RUN_ID, "run-20300101T000000Z-0123456789a", "run-20300101T000000Z-0123456789abc", "RUN-20300101T000000Z-0123456789ab", "run-2030-01-01", "", "run-20300101T000000Z-0123456789AB"];
    for (const v of samples) expect(parseLauncherFactsText(withField("run_id", v)).ok, v).toBe(RUN_ID_PATTERN.test(v));
  });
});

describe("with the real read-only adapter (synthetic files in a temporary directory)", () => {
  let base = "";
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "w4c2-")));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });
  const leaseDir = (): string => {
    const d = join(base, "lease");
    mkdirSync(d, { recursive: true });
    return d;
  };
  const adapter = (dir: string): LauncherFactsReadPort => {
    const r = createLauncherFactsReadAdapter({ leaseDir: dir });
    if (!r.ok) throw new Error("test setup: " + r.error.code);
    return r.value;
  };

  it("takes the adapter as the port: start-up snapshot, then an unchanged re-read", () => {
    const dir = leaseDir();
    writeFileSync(join(dir, "launcher-facts.json"), goodText(), "utf8");
    const port = adapter(dir);
    const start = readLauncherFactsSnapshot(port, expectation());
    expect(start.ok).toBe(true);
    if (!start.ok) return;
    expect(confirmLauncherFactsUnchanged(port, expectation(), start.value).ok).toBe(true);
  });

  it("detects a file that was rewritten between the start-up read and the re-read", () => {
    const dir = leaseDir();
    const file = join(dir, "launcher-facts.json");
    writeFileSync(file, goodText(), "utf8");
    const port = adapter(dir);
    const start = readLauncherFactsSnapshot(port, expectation());
    if (!start.ok) throw new Error("setup");
    writeFileSync(file, withField("runtime_image_id", `sha256:${sha("another-image")}`), "utf8");
    expect(codeOf(confirmLauncherFactsUnchanged(port, expectation(), start.value))).toBe("facts_changed");
    rmSync(file);
    expect(codeOf(confirmLauncherFactsUnchanged(port, expectation(), start.value))).toBe("facts_read_absent");
  });

  it("answers absent for a missing file, error for a symbolic link, a directory and a file over 4 KiB", () => {
    const dir = leaseDir();
    const port = adapter(dir);
    expect(codeOf(readLauncherFactsSnapshot(port, expectation()))).toBe("facts_read_absent");
    writeFileSync(join(base, "outside.json"), goodText(), "utf8");
    symlinkSync(join(base, "outside.json"), join(dir, "launcher-facts.json"));
    expect(codeOf(readLauncherFactsSnapshot(port, expectation()))).toBe("facts_read_failed");
    rmSync(join(dir, "launcher-facts.json"));
    mkdirSync(join(dir, "launcher-facts.json"));
    expect(codeOf(readLauncherFactsSnapshot(port, expectation()))).toBe("facts_read_failed");
    rmSync(join(dir, "launcher-facts.json"), { recursive: true });
    writeFileSync(join(dir, "launcher-facts.json"), "x".repeat(LAUNCHER_FACTS_MAX_BYTES + 1), "utf8");
    expect(codeOf(readLauncherFactsSnapshot(port, expectation()))).toBe("facts_read_failed");
  });

  it("reads only launcher-facts.json: the lease adapter and this one never see each other's file", () => {
    const dir = leaseDir();
    writeFileSync(join(dir, "launcher-facts.json"), goodText(), "utf8");
    const lease = createLeaseJsonReadAdapter({ leaseDir: dir });
    expect(lease.ok && lease.value.readLeaseJson()).toEqual({ kind: "absent" });
    writeFileSync(join(dir, "lease.json"), "{}", "utf8");
    expect(adapter(dir).readLauncherFacts()).toEqual({ kind: "ok", text: goodText() });
  });

  it("is a frozen port with one argument-free read method, and is refused at creation for a bad directory without echoing it", () => {
    const port = adapter(leaseDir());
    expect(Object.isFrozen(port)).toBe(true);
    expect(Object.keys(port)).toEqual(["readLauncherFacts"]);
    expect(port.readLauncherFacts.length).toBe(0);
    const bad = createLauncherFactsReadAdapter({ leaseDir: join(base, `${CANARY}-missing`) });
    expect(codeOf(bad)).toBe("lease_dir_invalid");
    expect(JSON.stringify(bad)).not.toContain(CANARY);
    expect(JSON.stringify(bad)).not.toContain(base);
    expect(codeOf(createLauncherFactsReadAdapter({}))).toBe("options_keys");
    expect(codeOf(createLauncherFactsReadAdapter(undefined))).toBe("options_not_plain_object");
  });
});

describe("static properties of launcherFacts.ts", () => {
  const source = readFileSync(new URL("../src/runtimeFacts/launcherFacts.ts", import.meta.url), "utf8");
  const code = source
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

  it("imports only node:crypto, the strict JSON parser and the result type: no file system, process or environment access", () => {
    const imports = [...code.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../schema/strictParse.js", "../schema/types.js", "node:crypto"]);
    expect(code).not.toMatch(/node:fs|child_process|node:net|node:http|node:os|spawn|fetch\(/);
    expect(code).not.toMatch(/process\.env|process\.versions|process\.cwd|readFileSync/);
  });

  it("holds no fixed run id, image id or hash", () => {
    expect(code).not.toMatch(/["'`]run-\d{8}T/);
    expect(code).not.toMatch(/["'`](sha256:)?[0-9a-f]{64}["'`]/);
  });
});
