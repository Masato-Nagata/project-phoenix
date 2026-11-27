// Task 4.7, step A1: the reproducibility comparison command (R22.7, R22.8; human decision D4). Deterministic and offline. The CLI function is
// called in-process with captured output; one case copies synthetic Runs to a temporary directory and uses the real node file system.
// Exit codes: 0 identical; 1 different; 2 incomplete, usage error, or internal error. The structured `result` tells the cases apart.
// **Validates: Requirements 22.7, 22.8**
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryFileSystem, createNodeFileSystem, type ReadOnlyFileSystemPort } from "../src/index.js";
import { COMPARE_EXIT_CODES, COMPARE_USAGE, runCompareRunsCli } from "../src/tools/compareRunsCli.js";
import { BASE_STEPS, appendStep, dirOf, sealRun, type Step } from "./helpers/compareFixtures.js";
import { SpyFileSystem } from "./helpers/runFixtures.js";

interface Captured {
  code: number;
  out: string[];
  err: string[];
}
async function run(fs: ReadOnlyFileSystemPort, argv: readonly string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCompareRunsCli(argv, { stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, fs);
  return { code, out, err };
}
const parse = (lines: string[]): Record<string, unknown> => JSON.parse(lines[0] as string) as Record<string, unknown>;
const withN = (n: number): Step[] => [...BASE_STEPS.slice(0, 2), appendStep("error", { n })];

describe("exit codes (D4)", () => {
  it("the table is 0 identical, 1 different, 2 incomplete, 2 usage error, 2 internal error", () => {
    expect({ ...COMPARE_EXIT_CODES }).toEqual({ identical: 0, different: 1, incomplete: 2, usage_error: 2, error: 2 });
  });
});

describe("verdicts", () => {
  it("identical: exit 0, one structured line on standard output, nothing on standard error", async () => {
    const fs = new MemoryFileSystem();
    await sealRun(fs, "run-a");
    await sealRun(fs, "run-b");
    const r = await run(fs, [dirOf("run-a"), dirOf("run-b")]);
    expect(r.code).toBe(0);
    expect(r.err).toEqual([]);
    expect(r.out).toEqual(['{"records":3,"result":"identical","schemaVersion":1,"tool":"compare-runs"}']);
  });

  it("different: exit 1, the first differing record id and the kind of difference are in the line", async () => {
    const fs = new MemoryFileSystem();
    await sealRun(fs, "run-a");
    await sealRun(fs, "run-b", withN(99));
    const r = await run(fs, [dirOf("run-a"), dirOf("run-b")]);
    expect(r.code).toBe(1);
    expect(r.err).toEqual([]);
    expect(parse(r.out)).toEqual({ tool: "compare-runs", schemaVersion: 1, result: "different", firstDifferingRecord: "rec-000003", difference: "content", recordsA: 3, recordsB: 3 });
  });

  it("different (extra record): exit 1", async () => {
    const fs = new MemoryFileSystem();
    await sealRun(fs, "run-a", [...BASE_STEPS, appendStep("error", { n: 3 })]);
    await sealRun(fs, "run-b");
    const r = await run(fs, [dirOf("run-a"), dirOf("run-b")]);
    expect(r.code).toBe(1);
    expect(parse(r.out)).toMatchObject({ result: "different", firstDifferingRecord: "rec-000004", difference: "only_in_a" });
  });

  it("incomplete (no Completion_Marker): exit 2, structured per side, on standard output", async () => {
    const fs = new MemoryFileSystem();
    await sealRun(fs, "run-a", BASE_STEPS, {}, false);
    await sealRun(fs, "run-b", withN(99));
    const r = await run(fs, [dirOf("run-a"), dirOf("run-b")]);
    expect(r.code).toBe(2);
    expect(r.err).toEqual([]);
    expect(parse(r.out)).toEqual({ tool: "compare-runs", schemaVersion: 1, result: "incomplete", a: { accepted: false, reason: "no_completion_marker" }, b: { accepted: true } });
  });

  it("incomplete (a Run under .incoming/): exit 2", async () => {
    const fs = new MemoryFileSystem();
    await sealRun(fs, "run-a");
    await sealRun(fs, ".incoming/run-b");
    const r = await run(fs, [dirOf("run-a"), dirOf(".incoming/run-b")]);
    expect(r.code).toBe(2);
    expect(parse(r.out)).toMatchObject({ result: "incomplete", b: { accepted: false, reason: "incoming_directory" } });
  });

  it("the output line is one line, has no path and no wall-clock value", async () => {
    const fs = new MemoryFileSystem();
    await sealRun(fs, "run-a", BASE_STEPS, {}, false);
    await sealRun(fs, "run-b");
    const r = await run(fs, [dirOf("run-a"), dirOf("run-b")]);
    for (const l of r.out) {
      expect(l).not.toContain("\n");
      expect(l).not.toContain("/discovery");
      expect(l).not.toMatch(/20\d\d-\d\d-\d\dT/);
    }
  });

  it("reads only", async () => {
    const spy = new SpyFileSystem();
    await sealRun(spy, "run-a");
    await sealRun(spy, "run-b", withN(5));
    spy.reset();
    await run(spy, [dirOf("run-a"), dirOf("run-b")]);
    expect(spy.writes).toEqual([]);
  });
});

describe("usage errors and internal errors: exit 2, structured line on standard error, nothing on standard output", () => {
  const fs = new MemoryFileSystem();
  const cases: [string, readonly string[], string][] = [
    ["no argument", [], "wrong_argument_count"],
    ["one argument", ["/x"], "wrong_argument_count"],
    ["three arguments", ["/x", "/y", "/z"], "wrong_argument_count"],
    ["an option", ["--help", "/y"], "unknown_option"],
    ["a dash path", ["/x", "-y"], "unknown_option"],
    ["an empty path", ["", "/y"], "empty_path"],
  ];
  for (const [name, argv, code] of cases) {
    it(`${name}`, async () => {
      const r = await run(fs, argv);
      expect(r.code).toBe(2);
      expect(r.out).toEqual([]);
      expect(parse(r.err)).toEqual({ tool: "compare-runs", schemaVersion: 1, result: "usage_error", code, usage: COMPARE_USAGE });
    });
  }

  it("a failed read is an internal error, never identical or different", async () => {
    const broken: ReadOnlyFileSystemPort = {
      listDir: async () => {
        throw new Error("EIO /secret/path");
      },
      readFile: async () => {
        throw new Error("EIO /secret/path");
      },
    };
    const r = await run(broken, ["/x", "/y"]);
    expect(r.code).toBe(2);
    expect(r.out).toEqual([]);
    expect(parse(r.err)).toEqual({ tool: "compare-runs", schemaVersion: 1, result: "error", code: "internal_error" });
    expect(r.err.join("")).not.toContain("secret");
  });

  it("a missing directory is incomplete (no_manifest), not an error", async () => {
    const r = await run(new MemoryFileSystem(), ["/missing-a", "/missing-b"]);
    expect(r.code).toBe(2);
    expect(parse(r.out)).toMatchObject({ result: "incomplete", a: { accepted: false, reason: "no_manifest" }, b: { accepted: false, reason: "no_manifest" } });
  });
});

describe("with the real node file system", () => {
  const root = mkdtempSync(join(tmpdir(), "phoenix-compare-cli-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function copyRun(mem: MemoryFileSystem, name: string, target: string): void {
    for (const f of mem.allFiles().filter((p) => p.startsWith(`${dirOf(name)}/`))) {
      const dest = join(target, f.slice(dirOf(name).length + 1));
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, mem.peek(f) as Uint8Array);
    }
  }

  it("identical Runs on disk give exit 0 and different Runs give exit 1", async () => {
    const mem = new MemoryFileSystem();
    const steps: Step[] = [appendStep("run_started"), { op: "blob", content: "{\"reply\":true}" }, appendStep("error", { n: 1 })];
    await sealRun(mem, "run-a", steps);
    await sealRun(mem, "run-b", steps);
    await sealRun(mem, "run-c", [...steps, appendStep("error", { n: 2 })]);
    const dirs = ["run-a", "run-b", "run-c"].map((n) => join(root, n));
    ["run-a", "run-b", "run-c"].forEach((n, i) => copyRun(mem, n, dirs[i] as string));
    const node = createNodeFileSystem();
    const ro: ReadOnlyFileSystemPort = { listDir: (p) => node.listDir(p), readFile: (p) => node.readFile(p) };
    const same = await run(ro, [dirs[0] as string, dirs[1] as string]);
    expect(same.code).toBe(0);
    expect(parse(same.out)).toMatchObject({ result: "identical", records: 3 });
    const diff = await run(ro, [dirs[0] as string, dirs[2] as string]);
    expect(diff.code).toBe(1);
    expect(parse(diff.out)).toMatchObject({ result: "different", firstDifferingRecord: "rec-000004", difference: "only_in_b" });
  });

  it("copying a Run under a .incoming directory makes it incomplete (exit 2)", async () => {
    const mem = new MemoryFileSystem();
    await sealRun(mem, "run-a");
    const good = join(root, "good");
    const incoming = join(root, ".incoming", "run-a");
    copyRun(mem, "run-a", good);
    cpSync(good, incoming, { recursive: true });
    const node = createNodeFileSystem();
    const r = await run({ listDir: (p) => node.listDir(p), readFile: (p) => node.readFile(p) }, [good, incoming]);
    expect(r.code).toBe(2);
    expect(parse(r.out)).toMatchObject({ result: "incomplete", a: { accepted: true }, b: { accepted: false, reason: "incoming_directory" } });
  });
});