// Golden Run directory for the host-side verification of the Launcher (tasks 2.21 and 2.23). The TypeScript store writes a sealed Run;
// its files are kept in test-vectors/sealed-run/ so that the PowerShell verification of the export is tested against the same bytes,
// and every reader is checked to accept the vector with a Completion_Marker and to refuse it without one.
// Regenerate with PHOENIX_WRITE_VECTORS=1 (inside the toolchain container); otherwise the test compares byte for byte.
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { acceptRun, createNodeFileSystem, verifyRunDirectory } from "../src/index.js";
import { buildSealedRun } from "./helpers/runFixtures.js";

const VECTOR = fileURLToPath(new URL("../test-vectors/sealed-run/", import.meta.url));
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

describe("the sealed-run vector", () => {
  it("is what the store writes for the standard fixture Run, byte for byte", async () => {
    const dir = join(temp(), "run-0001");
    mkdirSync(dir);
    await buildSealedRun(createNodeFileSystem() as never, dir);
    if (process.env["PHOENIX_WRITE_VECTORS"] === "1") {
      rmSync(VECTOR, { recursive: true, force: true });
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
});