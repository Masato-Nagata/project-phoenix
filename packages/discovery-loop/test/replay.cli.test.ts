// The replay command (task 4.7 step A2): arguments, exit codes, the output stream, one canonical line without a path, a credential, request
// or response text or an exception message; each external input read once. Synthetic recorded Runs only (test/helpers/replayFixtures.ts).
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPLAY_EXIT_CODES, REPLAY_USAGE, createNodeBoundedReadPort, pathRefusal, runReplayCli } from "../src/replayMain.js";
import { POLICY_BYTES, RUN_DIR, TABLE_BYTES, enc, memoryPort, recordRun, rewriteRun, setTermination, type Recorded } from "./helpers/replayFixtures.js";

const POLICY = "/inputs/policy-config.json";
const TABLE = "/inputs/preparation-table.json";
const args = (run = RUN_DIR, policy = POLICY, table = TABLE): string[] => ["--run", run, "--policy-config", policy, "--preparation-table", table];

async function cli(r: Recorded, argv: string[], port = memoryPort(r.mem)) {
  r.mem.poke(POLICY, POLICY_BYTES());
  r.mem.poke(TABLE, TABLE_BYTES());
  const out: string[] = [];
  const err: string[] = [];
  const code = await runReplayCli(argv, { stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, port);
  return { code, out, err, port };
}
const parsed = (l: string | undefined): Record<string, unknown> => JSON.parse(l ?? "null") as Record<string, unknown>;

describe("the replay command", () => {
  it("identical: exit 0, one canonical line on standard output, nothing on standard error; each input read once", async () => {
    const r = await recordRun();
    const { code, out, err, port } = await cli(r, args());
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    const line = parsed(out[0]);
    expect(line).toMatchObject({ tool: "replay-run", schemaVersion: 1, result: "identical", guarantees: { audit: "reused_not_reexecuted", lease: "not_measured", realAi: "not_called" } });
    expect(JSON.stringify(JSON.parse(out[0] as string))).toBe(out[0]); // canonical: no white space (keys are sorted by the canonical writer)
    expect(port.reads.filter((p) => p === POLICY)).toHaveLength(1);
    expect(port.reads.filter((p) => p === TABLE)).toHaveLength(1);
    expect(out[0]).not.toContain("/run/out");
    expect(out[0]).not.toContain("/inputs");
  });
  it("different: exit 1 on standard output (a termination reason the replay does not reach)", async () => {
    const r = await recordRun();
    const t = setTermination("experiment_limit_reached");
    await rewriteRun(r.mem, t.edit, { editManifest: t.editManifest });
    const { code, out, err } = await cli(r, args());
    expect(code).toBe(REPLAY_EXIT_CODES.different);
    expect(code).toBe(1);
    expect(err).toEqual([]);
    expect(parsed(out[0])).toMatchObject({ result: "different", difference: "termination_reason" });
  });
  it("incomplete: exit 2 on standard output (not accepted; a not replayable termination; a missing input)", async () => {
    const r1 = await recordRun({ marker: false });
    const a = await cli(r1, args());
    expect([a.code, parsed(a.out[0])["result"], a.err]).toEqual([2, "incomplete", []]);
    const r2 = await recordRun();
    const t = setTermination("time_limit_reached");
    await rewriteRun(r2.mem, t.edit, { editManifest: t.editManifest });
    const b = await cli(r2, args());
    expect([b.code, parsed(b.out[0])["reason"]]).toEqual([2, "termination_not_replayable"]);
    const r3 = await recordRun();
    const c = await cli(r3, args(RUN_DIR, "/nowhere/policy-config.json"));
    expect([c.code, parsed(c.out[0])["reason"]]).toEqual([2, "external_input_missing"]);
    expect(c.out[0]).not.toContain("nowhere");
  });
  it.each<[string, string[], string]>([
    ["no argument", [], "wrong_argument_count"],
    ["a positional argument", ["/run/out", "a", "b", "c", "d", "e"], "unknown_option"],
    ["an unknown option", ["--run", RUN_DIR, "--policy", POLICY, "--preparation-table", TABLE], "unknown_option"],
    ["a duplicate option", ["--run", RUN_DIR, "--run", RUN_DIR, "--preparation-table", TABLE], "duplicate_option"],
    ["an empty path", args(""), "empty_path"],
    ["a parent segment", args("/discovery/runs/../runs/x"), "unsafe_path"],
    ["an incoming export", args("/discovery/runs/.incoming/run-x"), "unsafe_path"],
    ["the evaluation folder", args(RUN_DIR, "/repo/evaluation/policy-config.json"), "unsafe_path"],
    ["the Approval_Store folder", args(RUN_DIR, POLICY, "/repo/discovery/approvals/preparation-table.json"), "unsafe_path"],
    ["another file name for an input", args(RUN_DIR, "/inputs/audit-config.json"), "input_name"],
    ["an option-like path", args("-x"), "unsafe_path"],
  ])("usage error (%s): exit 2 on standard error, nothing read", async (_n, argv, codeName) => {
    const r = await recordRun();
    const { code, out, err, port } = await cli(r, argv);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(parsed(err[0])).toEqual({ tool: "replay-run", schemaVersion: 1, result: "usage_error", code: codeName, usage: REPLAY_USAGE });
    expect(port.reads).toEqual([]);
  });
  it("an internal error: exit 2 on standard error, no exception text", async () => {
    const r = await recordRun();
    const failing = { ...memoryPort(r.mem), readBounded: async (): Promise<never> => { throw new Error("SYNTHETIC-SECRET-0001 /secret/path"); } };
    const { code, out, err } = await cli(r, args(), failing as never);
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(parsed(err[0])).toEqual({ tool: "replay-run", schemaVersion: 1, result: "error", code: "internal_error" });
    expect(err[0]).not.toContain("SYNTHETIC");
    expect(err[0]).not.toContain("/secret");
  });
  it("the exit codes are the closed table: 0 identical, 1 different and diverged, 2 incomplete, usage and internal errors", () => {
    expect(REPLAY_EXIT_CODES).toEqual({ identical: 0, different: 1, diverged: 1, incomplete: 2, usage_error: 2, error: 2 });
  });
  it("pathRefusal looks at the string only", () => {
    expect(pathRefusal("/a/b/policy-config.json", "policy-config.json")).toBeUndefined();
    expect(pathRefusal("C:\\runs\\Evaluation\\x")).toBe("unsafe_path");
    expect(pathRefusal("/a/\0b")).toBe("unsafe_path");
    expect(pathRefusal("/a/b")).toBeUndefined();
  });
});

describe("the bounded read port over node:fs (temporary directory, synthetic files)", () => {
  const port = createNodeBoundedReadPort();
  it("reads a file within the limit, refuses a larger one, answers missing for a missing path and a directory, lists a directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phoenix-replay-"));
    try {
      writeFileSync(join(dir, "a.json"), enc("12345"));
      mkdirSync(join(dir, "sub"));
      expect(await port.readBounded(join(dir, "a.json"), 5)).toEqual({ kind: "ok", bytes: enc("12345") });
      expect(await port.readBounded(join(dir, "a.json"), 4)).toEqual({ kind: "too_large" });
      expect(await port.readBounded(join(dir, "none.json"), 5)).toEqual({ kind: "missing" });
      expect(await port.readBounded(join(dir, "sub"), 5)).toEqual({ kind: "missing" });
      expect(await port.listDir(dir)).toEqual(["a.json", "sub"]);
      expect(await port.listDir(join(dir, "a.json"))).toBeUndefined();
      expect(await port.listDir(join(dir, "none"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("refuses a symbolic link (where the platform allows creating one)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "phoenix-replay-"));
    try {
      writeFileSync(join(dir, "target.json"), enc("{}"));
      let linked = true;
      try {
        symlinkSync(join(dir, "target.json"), join(dir, "link.json"));
      } catch {
        linked = false;
      }
      if (linked) await expect(port.readBounded(join(dir, "link.json"), 10)).rejects.toThrow();
      expect(await port.readBounded(join(dir, "target.json"), 10)).toEqual({ kind: "ok", bytes: enc("{}") });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
