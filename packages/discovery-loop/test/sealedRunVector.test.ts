// Golden Run directories for the host-side verification of the Launcher (tasks 2.21 and 2.23) and for the readers.
//
// test-vectors/sealed-run/     The VERSION-1 Run_Manifest, sealed before the audit configuration kind existed. FROZEN: its bytes are never
//                              rewritten (pinned below by SHA-256), the PowerShell verification is tested against it, and it is read as a
//                              version-1 Manifest: no kind is filled in and none is assumed.
// test-vectors/sealed-run-v2/  The VERSION-2 Run_Manifest that the current store writes for the same standard fixture Run. It is a
//                              SYNTHETIC TEST FIXTURE: every value is made up, and its audit configuration kind `fixture` (declared by
//                              `launcher`) only says that the fixture Run used the synthetic audit configuration. It is no evidence of a
//                              real Run or of a real audit configuration.
// Regenerate the version-2 vector with PHOENIX_WRITE_VECTORS=1 (inside the toolchain container, the target directory empty); otherwise the
// test compares byte for byte. The version-1 vector has no regeneration path.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acceptRun, createNodeFileSystem, verifyRunDirectory } from "../src/index.js";
import { buildSealedRun } from "./helpers/runFixtures.js";

const VECTOR_V1 = fileURLToPath(new URL("../test-vectors/sealed-run/", import.meta.url));
const VECTOR = fileURLToPath(new URL("../test-vectors/sealed-run-v2/", import.meta.url));
/** The SHA-256 of every file of the frozen version-1 vector, as committed. */
const V1_FILES: Readonly<Record<string, string>> = Object.freeze({
  "blobs/d8c6799938e5f522ec575307e8004224c9c97b443d6a2f32bdd0385119965d6a": "d8c6799938e5f522ec575307e8004224c9c97b443d6a2f32bdd0385119965d6a",
  "manifest.json": "6e89c956402198a5de8fbb7b877dc84fb6234041d273ed7adfeb13e18f182f99",
  "records.jsonl": "0acd85b37487c1868a618d438de7b9fb42d50a2cf7fb27086c89221401e59706",
});
const fileSha = (p: string): string => createHash("sha256").update(readFileSync(p)).digest("hex");
const temps: string[] = [];
afterEach(() => { while (temps.length > 0) rmSync(temps.pop() as string, { recursive: true, force: true }); });
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "sealed-run-")); temps.push(d); return d; };

function listFiles(root: string, rel = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const r = rel === "" ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...listFiles(root, r));
    else out.push(r);
  }
  return out.sort();
}

describe("the sealed-run-v2 vector (the current store, a synthetic test fixture)", () => {
  it("is what the store writes for the standard fixture Run, byte for byte", async () => {
    const dir = join(temp(), "run-0001");
    mkdirSync(dir);
    await buildSealedRun(createNodeFileSystem() as never, dir);
    if (process.env["PHOENIX_WRITE_VECTORS"] === "1") {
      // the target directory is empty (it may be a mount point, so it is not removed)
      cpSync(dir, VECTOR, { recursive: true });
    }
    expect(existsSync(VECTOR)).toBe(true);
    expect(listFiles(VECTOR)).toEqual(listFiles(dir));
    for (const f of listFiles(dir)) expect(readFileSync(join(VECTOR, f)).equals(readFileSync(join(dir, f))), f).toBe(true);
  });

  it("verifies, is accepted with a Completion_Marker, and is incomplete without one", async () => {
    const dir = join(temp(), "run-0001");
    cpSync(VECTOR, dir, { recursive: true });
    const fs = createNodeFileSystem();
    expect((await verifyRunDirectory(fs, dir)).result).toBe("success");
    expect((await acceptRun(fs, dir)).accepted).toBe(false);
    writeFileSync(join(dir, "COMPLETE"), createHash("sha256").update(readFileSync(join(dir, "manifest.json"))).digest("hex"));
    expect((await acceptRun(fs, dir)).accepted).toBe(true);
    writeFileSync(join(dir, "COMPLETE"), "0".repeat(64));
    expect((await acceptRun(fs, dir)).accepted).toBe(false);
  });

  it("is a version-2 Run_Manifest whose audit configuration kind is the fixture, declared by the launcher", () => {
    const m = JSON.parse(readFileSync(join(VECTOR, "manifest.json"), "utf8")) as { schemaVersion: number; payload_audit: Record<string, unknown> };
    expect(m.schemaVersion).toBe(2);
    expect(m.payload_audit["auditConfigKind"]).toBe("fixture");
    expect(m.payload_audit["auditConfigKindDeclaredBy"]).toBe("launcher");
  });
});

describe("the frozen sealed-run vector (version 1)", () => {
  it("keeps its bytes: the same files with the same SHA-256 as committed", () => {
    expect(listFiles(VECTOR_V1)).toEqual(Object.keys(V1_FILES).sort());
    for (const [f, h] of Object.entries(V1_FILES)) expect(fileSha(join(VECTOR_V1, f)), f).toBe(h);
  });

  it("still verifies, is accepted with a Completion_Marker, and is incomplete without one", async () => {
    const dir = join(temp(), "run-0001");
    cpSync(VECTOR_V1, dir, { recursive: true });
    const fs = createNodeFileSystem();
    expect((await verifyRunDirectory(fs, dir)).result).toBe("success");
    expect((await acceptRun(fs, dir)).accepted).toBe(false);
    writeFileSync(join(dir, "COMPLETE"), createHash("sha256").update(readFileSync(join(dir, "manifest.json"))).digest("hex"));
    expect((await acceptRun(fs, dir)).accepted).toBe(true);
    writeFileSync(join(dir, "COMPLETE"), "0".repeat(64));
    expect((await acceptRun(fs, dir)).accepted).toBe(false);
  });

  it("is read as version 1: no audit configuration kind is filled in or assumed", () => {
    const m = JSON.parse(readFileSync(join(VECTOR_V1, "manifest.json"), "utf8")) as { schemaVersion: number; payload_audit: Record<string, unknown> };
    expect(m.schemaVersion).toBe(1);
    expect("auditConfigKind" in m.payload_audit).toBe(false);
    expect("auditConfigKindDeclaredBy" in m.payload_audit).toBe(false);
  });
});