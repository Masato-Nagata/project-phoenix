// Task 4.6 W4-C part C1: the read-only file adapters (`src/runtimeFacts/fsReadAdapters.ts`). Deterministic and offline.
// Every file below is a SYNTHETIC file in a temporary directory created by the test and removed afterwards. No real lease, approval,
// evaluation or container path is read. The Node.js version is an injected object; the host value is never consulted.
// **Validates: Requirements 22.3, 24.7, 24.9**
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LEASE_JSON_MAX_BYTES, readLeaseFactsSnapshot, type LeaseJsonReadPort } from "../src/runtimeFacts/leaseFacts.js";
import { PACKAGE_JSON_MAX_BYTES, collectRuntimeVersionFacts, type RuntimeVersionReadPort } from "../src/runtimeFacts/versionFacts.js";
import { createLeaseJsonReadAdapter, createRuntimeVersionReadAdapter, readFixedRootFileInternal } from "../src/runtimeFacts/fsReadAdapters.js";

const CANARY = "canary-secret-value-91x";
let base = "";
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "w4c-")));
});
afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const dir = (...parts: string[]): string => {
  const p = join(base, ...parts);
  mkdirSync(p, { recursive: true });
  return p;
};
const put = (path: string, text: string): void => writeFileSync(path, text, "utf8");
const pkg = (o: Record<string, unknown>): string => JSON.stringify(o);
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const codeOf = (r: { ok: boolean; error?: { code: string } }): string | undefined => (r.ok ? undefined : r.error?.code);
const get = <T>(r: { ok: true; value: T } | { ok: false; error: { code: string } }): T => {
  if (!r.ok) throw new Error("test setup: " + r.error.code);
  return r.value;
};

/** A synthetic runtime tree: npm, the declared package, and the installed packages. */
function makeTree(): { npm: string; declared: string; modules: string } {
  const npm = dir("npm");
  const declared = dir("app", "packages", "runner");
  const modules = dir("app", "node_modules");
  put(join(npm, "package.json"), pkg({ name: "npm", version: "9.8.7" }));
  put(join(declared, "package.json"), pkg({ name: "runner", dependencies: { "a-lib": "1.2.3", "@scope/b-lib": "2.0.0", "@phoenix/inner": "*" } }));
  mkdirSync(join(modules, "a-lib"), { recursive: true });
  put(join(modules, "a-lib", "package.json"), pkg({ name: "a-lib", version: "1.2.3" }));
  mkdirSync(join(modules, "@scope", "b-lib"), { recursive: true });
  put(join(modules, "@scope", "b-lib", "package.json"), pkg({ name: "@scope/b-lib", version: "2.0.0" }));
  return { npm, declared, modules };
}
const versionAdapter = (t: { npm: string; declared: string; modules: string }, ...rest: [unknown?]): RuntimeVersionReadPort => {
  const versions = rest.length === 0 ? { node: "7.8.9" } : rest[0];
  return get(createRuntimeVersionReadAdapter({ versions, npmPackageDir: t.npm, declaredPackageDir: t.declared, modulesDir: t.modules }));
};

describe("readFixedRootFileInternal", () => {
  it("reads a regular file once and returns its text", () => {
    const d = dir("r");
    put(join(d, "f.txt"), "héllo");
    expect(readFixedRootFileInternal(d, ["f.txt"], 100)).toEqual({ kind: "ok", text: "héllo" });
    put(join(d, "empty.txt"), "");
    expect(readFixedRootFileInternal(d, ["empty.txt"], 100)).toEqual({ kind: "ok", text: "" });
  });

  it("answers absent for a missing file and for a missing or non-directory parent", () => {
    const d = dir("r");
    expect(readFixedRootFileInternal(d, ["nope.txt"], 100)).toEqual({ kind: "absent" });
    expect(readFixedRootFileInternal(d, ["nodir", "f.txt"], 100)).toEqual({ kind: "absent" });
    put(join(d, "plain"), "x");
    expect(readFixedRootFileInternal(d, ["plain", "f.txt"], 100)).toEqual({ kind: "absent" });
  });

  it("refuses a directory given as the file", () => {
    const d = dir("r");
    mkdirSync(join(d, "sub"));
    expect(readFixedRootFileInternal(d, ["sub"], 100)).toEqual({ kind: "error" });
  });

  it("refuses a symbolic link as the final file, even one that points to a good file", () => {
    const d = dir("r");
    put(join(d, "real.txt"), "ok");
    symlinkSync(join(d, "real.txt"), join(d, "link.txt"));
    expect(readFixedRootFileInternal(d, ["link.txt"], 100)).toEqual({ kind: "error" });
    expect(readFixedRootFileInternal(d, ["real.txt"], 100).kind).toBe("ok");
  });

  it("refuses a symbolic link in an intermediate directory", () => {
    const d = dir("r");
    mkdirSync(join(d, "real-dir"));
    put(join(d, "real-dir", "f.txt"), "ok");
    symlinkSync(join(d, "real-dir"), join(d, "link-dir"));
    expect(readFixedRootFileInternal(d, ["link-dir", "f.txt"], 100)).toEqual({ kind: "error" });
    expect(readFixedRootFileInternal(d, ["real-dir", "f.txt"], 100).kind).toBe("ok");
  });

  it("applies the size limit exactly: the limit is read, one byte more is refused", () => {
    const d = dir("r");
    put(join(d, "at.txt"), "x".repeat(50));
    put(join(d, "over.txt"), "x".repeat(51));
    expect(readFixedRootFileInternal(d, ["at.txt"], 50).kind).toBe("ok");
    expect(readFixedRootFileInternal(d, ["over.txt"], 50)).toEqual({ kind: "error" });
  });

  it("refuses bytes that are not valid UTF-8", () => {
    const d = dir("r");
    writeFileSync(join(d, "bad.bin"), Buffer.from([0xff, 0xfe, 0x41]));
    expect(readFixedRootFileInternal(d, ["bad.bin"], 100)).toEqual({ kind: "error" });
  });

  it("refuses a file that cannot be opened (read permission removed)", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return; // root ignores the mode bits
    const d = dir("r");
    put(join(d, "locked.txt"), "x");
    chmodSync(join(d, "locked.txt"), 0o000);
    expect(readFixedRootFileInternal(d, ["locked.txt"], 100)).toEqual({ kind: "error" });
  });

  it("refuses a file that was replaced after it was read (new inode on the same path)", () => {
    const d = dir("r");
    const target = join(d, "f.txt");
    put(target, "first");
    const r = readFixedRootFileInternal(d, ["f.txt"], 100, {
      afterRead: () => {
        put(join(d, "other.txt"), "second");
        renameSync(join(d, "other.txt"), target);
      },
    });
    expect(r).toEqual({ kind: "error" });
    expect(readFileSync(target, "utf8")).toBe("second");
  });

  it("refuses a file that was changed in place after it was read (size changed)", () => {
    const d = dir("r");
    const target = join(d, "f.txt");
    put(target, "first");
    expect(readFixedRootFileInternal(d, ["f.txt"], 100, { afterRead: () => put(target, "much longer text") })).toEqual({ kind: "error" });
  });

  it("refuses a path that turned into a symbolic link after it was read", () => {
    const d = dir("r");
    const target = join(d, "f.txt");
    put(target, "first");
    put(join(d, "elsewhere.txt"), "second");
    const r = readFixedRootFileInternal(d, ["f.txt"], 100, {
      afterRead: () => {
        rmSync(target);
        symlinkSync(join(d, "elsewhere.txt"), target);
      },
    });
    expect(r).toEqual({ kind: "error" });
  });

  it("does not retry: one read, one answer", () => {
    const d = dir("r");
    put(join(d, "f.txt"), "x");
    let calls = 0;
    const r = readFixedRootFileInternal(d, ["f.txt"], 100, { afterRead: () => void (calls += 1) });
    expect(r.kind).toBe("ok");
    expect(calls).toBe(1);
  });
});

describe("lease.json adapter (LeaseJsonReadPort of W4-A)", () => {
  const RUN_ID = "run-20300101T000000Z-0123456789ab";
  const NONCE = "synthetic-nonce-91x";
  const leaseText = (): string =>
    JSON.stringify({ heartbeat_interval_ms: 1000, issued_by: "launcher", launcher_pid: 4242, launcher_start_ticks: "630000000000000000", nonce_sha256: sha(NONCE), run_id: RUN_ID, stale_after_ms: 4000 });

  it("reads <leaseDir>/lease.json and feeds the W4-A snapshot", () => {
    const leaseDir = dir("lease");
    put(join(leaseDir, "lease.json"), leaseText());
    const port: LeaseJsonReadPort = get(createLeaseJsonReadAdapter({ leaseDir }));
    const snap = readLeaseFactsSnapshot(port, { runId: RUN_ID, nonce: NONCE, heartbeatIntervalMs: 1000, staleAfterMs: 4000 });
    expect(snap.ok).toBe(true);
    expect(snap.ok && snap.value.facts.runId).toBe(RUN_ID);
  });

  it("answers absent, and error for a symbolic link, a directory and a file over 4 KiB", () => {
    const leaseDir = dir("lease");
    const port = get(createLeaseJsonReadAdapter({ leaseDir }));
    expect(port.readLeaseJson()).toEqual({ kind: "absent" });
    put(join(base, "outside.json"), leaseText());
    symlinkSync(join(base, "outside.json"), join(leaseDir, "lease.json"));
    expect(port.readLeaseJson()).toEqual({ kind: "error" });
    rmSync(join(leaseDir, "lease.json"));
    mkdirSync(join(leaseDir, "lease.json"));
    expect(port.readLeaseJson()).toEqual({ kind: "error" });
    rmSync(join(leaseDir, "lease.json"), { recursive: true });
    put(join(leaseDir, "lease.json"), "x".repeat(LEASE_JSON_MAX_BYTES));
    expect(port.readLeaseJson().kind).toBe("ok");
    put(join(leaseDir, "lease.json"), "x".repeat(LEASE_JSON_MAX_BYTES + 1));
    expect(port.readLeaseJson()).toEqual({ kind: "error" });
  });

  it("has a method that takes no argument and a frozen port", () => {
    const port = get(createLeaseJsonReadAdapter({ leaseDir: dir("lease") }));
    expect(port.readLeaseJson.length).toBe(0);
    expect(Object.isFrozen(port)).toBe(true);
    expect(Object.keys(port)).toEqual(["readLeaseJson"]);
  });

  it("is refused at creation for a bad option object or directory, with a closed code and no path", () => {
    const leaseDir = dir(`${CANARY}-dir`);
    put(join(base, "a-file"), "x");
    mkdirSync(join(base, "real"));
    symlinkSync(join(base, "real"), join(base, "linked"));
    const bad: Array<[unknown, string]> = [
      [undefined, "options_not_plain_object"],
      [null, "options_not_plain_object"],
      [[], "options_not_plain_object"],
      ["x", "options_not_plain_object"],
      [{}, "options_keys"],
      [{ leaseDir, extra: 1 }, "options_keys"],
      [{ leaseDir: undefined }, "lease_dir_invalid"],
      [{ leaseDir: "" }, "lease_dir_invalid"],
      [{ leaseDir: "relative/dir" }, "lease_dir_invalid"],
      [{ leaseDir: `${leaseDir}/..` }, "lease_dir_invalid"],
      [{ leaseDir: `${leaseDir}/` }, "lease_dir_invalid"],
      [{ leaseDir: `${leaseDir}/./x` }, "lease_dir_invalid"],
      [{ leaseDir: join(base, "missing") }, "lease_dir_invalid"],
      [{ leaseDir: join(base, "a-file") }, "lease_dir_invalid"],
      [{ leaseDir: join(base, "linked") }, "lease_dir_invalid"],
      [{ leaseDir: `${leaseDir}\0` }, "lease_dir_invalid"],
      [{ leaseDir: 5 }, "lease_dir_invalid"],
    ];
    for (const [options, code] of bad) {
      const r = createLeaseJsonReadAdapter(options);
      expect(codeOf(r), JSON.stringify(options)).toBe(code);
      expect(JSON.stringify(r)).not.toContain(CANARY);
      expect(JSON.stringify(r)).not.toContain(base);
    }
  });

  it("never runs a getter of the options and does not change them", () => {
    const leaseDir = dir("lease");
    let ran = false;
    const g = {};
    Object.defineProperty(g, "leaseDir", { enumerable: true, get: () => ((ran = true), leaseDir) });
    expect(codeOf(createLeaseJsonReadAdapter(g))).toBe("options_not_plain_object");
    expect(ran).toBe(false);
    const frozen = Object.freeze({ leaseDir });
    expect(createLeaseJsonReadAdapter(frozen).ok).toBe(true);
    expect(frozen).toEqual({ leaseDir });
  });
});

describe("runtime version adapter (RuntimeVersionReadPort of W4-B)", () => {
  it("serves the whole W4-B collection from a synthetic tree, with the injected Node.js version", () => {
    const t = makeTree();
    const r = collectRuntimeVersionFacts(versionAdapter(t, { node: "7.8.9" }));
    expect(r).toEqual({ ok: true, value: { node: "7.8.9", npm: "9.8.7", dependencies: { "@scope/b-lib": "2.0.0", "a-lib": "1.2.3" } } });
    expect(r.ok && r.value.node).not.toBe(process.versions.node);
  });

  it("has no implicit fallback to process.versions: the option is required and an undefined value is refused as a Node.js version", () => {
    const t = makeTree();
    expect(codeOf(createRuntimeVersionReadAdapter({ npmPackageDir: t.npm, declaredPackageDir: t.declared, modulesDir: t.modules }))).toBe("options_keys");
    const port = versionAdapter(t, undefined);
    expect(port.readNodeVersion()).toBeUndefined();
    expect(codeOf(collectRuntimeVersionFacts(port))).toBe("node_invalid");
    expect(codeOf(collectRuntimeVersionFacts(versionAdapter(t, { node: "" })))).toBe("node_invalid");
    expect(codeOf(collectRuntimeVersionFacts(versionAdapter(t, {})))).toBe("node_invalid");
  });

  it("never runs a getter of the injected versions object", () => {
    const t = makeTree();
    let ran = false;
    const g = {};
    Object.defineProperty(g, "node", { enumerable: true, get: () => ((ran = true), "7.8.9") });
    const port = versionAdapter(t, g);
    expect(port.readNodeVersion()).toBeUndefined();
    expect(ran).toBe(false);
  });

  it("reads the three kinds of package.json with the 64 KiB limit, which is not the 4 KiB limit of lease.json", () => {
    const t = makeTree();
    const port = versionAdapter(t);
    const size = (s: string): number => Buffer.byteLength(s, "utf8");
    const exact = (total: number): string => {
      const body = pkg({ name: "npm", version: "9.8.7", pad: "" });
      return pkg({ name: "npm", version: "9.8.7", pad: "x".repeat(total - size(body)) });
    };
    expect(size(exact(5000))).toBe(5000);
    expect(5000).toBeGreaterThan(LEASE_JSON_MAX_BYTES);
    put(join(t.npm, "package.json"), exact(5000));
    expect(port.readNpmPackageJson().kind).toBe("ok");
    put(join(t.npm, "package.json"), exact(PACKAGE_JSON_MAX_BYTES));
    expect(port.readNpmPackageJson().kind).toBe("ok");
    put(join(t.npm, "package.json"), exact(PACKAGE_JSON_MAX_BYTES + 1));
    expect(port.readNpmPackageJson()).toEqual({ kind: "error" });
    put(join(t.declared, "package.json"), "x".repeat(PACKAGE_JSON_MAX_BYTES + 1));
    expect(port.readDeclaredPackageJson()).toEqual({ kind: "error" });
    put(join(t.modules, "a-lib", "package.json"), "x".repeat(PACKAGE_JSON_MAX_BYTES + 1));
    expect(port.readInstalledPackageJson("a-lib")).toEqual({ kind: "error" });
  });

  it("answers absent for npm, the declared file and a package that are not there", () => {
    const t = makeTree();
    const port = versionAdapter(t);
    rmSync(join(t.npm, "package.json"));
    rmSync(join(t.declared, "package.json"));
    expect(port.readNpmPackageJson()).toEqual({ kind: "absent" });
    expect(port.readDeclaredPackageJson()).toEqual({ kind: "absent" });
    expect(port.readInstalledPackageJson("missing-lib")).toEqual({ kind: "absent" });
    expect(port.readInstalledPackageJson("@scope/missing")).toEqual({ kind: "absent" });
  });

  it("refuses symbolic links: the final file, an intermediate package directory, and a scope directory", () => {
    const t = makeTree();
    const port = versionAdapter(t);
    // final file
    rmSync(join(t.npm, "package.json"));
    put(join(base, "fake-npm.json"), pkg({ name: "npm", version: "1.1.1" }));
    symlinkSync(join(base, "fake-npm.json"), join(t.npm, "package.json"));
    expect(port.readNpmPackageJson()).toEqual({ kind: "error" });
    // intermediate: the package directory is a link
    mkdirSync(join(base, "elsewhere", "x-lib"), { recursive: true });
    put(join(base, "elsewhere", "x-lib", "package.json"), pkg({ name: "x-lib", version: "1.0.0" }));
    symlinkSync(join(base, "elsewhere", "x-lib"), join(t.modules, "x-lib"));
    expect(port.readInstalledPackageJson("x-lib")).toEqual({ kind: "error" });
    // intermediate: the scope directory is a link
    mkdirSync(join(base, "elsewhere", "scope-real", "y-lib"), { recursive: true });
    put(join(base, "elsewhere", "scope-real", "y-lib", "package.json"), pkg({ name: "@lnk/y-lib", version: "1.0.0" }));
    symlinkSync(join(base, "elsewhere", "scope-real"), join(t.modules, "@lnk"));
    expect(port.readInstalledPackageJson("@lnk/y-lib")).toEqual({ kind: "error" });
    // the same collection refuses the whole set
    expect(codeOf(collectRuntimeVersionFacts(port))).toBe("npm_read_failed");
  });

  it("refuses a package name that escapes the root, is empty, is malformed, or is a workspace package, and never reads a file for it", () => {
    const t = makeTree();
    mkdirSync(join(base, "outside"), { recursive: true });
    put(join(base, "outside", "package.json"), pkg({ name: "outside", version: "1.0.0" }));
    mkdirSync(join(base, "app", "outside"), { recursive: true });
    put(join(base, "app", "outside", "package.json"), pkg({ name: "outside", version: "1.0.0" }));
    mkdirSync(join(t.modules, "@phoenix", "inner"), { recursive: true });
    put(join(t.modules, "@phoenix", "inner", "package.json"), pkg({ name: "@phoenix/inner", version: "0.0.0" }));
    const port = versionAdapter(t);
    const bad: unknown[] = [
      "../outside", "../../outside", "a-lib/../../outside", "a-lib/..", "..", ".", "", "/", "/abs", "a//b", "a-lib/", "/a-lib", "@scope", "@scope/", "@/x",
      "@phoenix/inner", "@phoenix/", "A-Upper", "has space", "a\0b", "a-lib\n", "x".repeat(215), "a-lib/extra/deeper", "a\\b", "..\\outside",
      5, null, undefined, {}, ["a-lib"],
    ];
    for (const name of bad) expect(port.readInstalledPackageJson(name as string), JSON.stringify(name)).toEqual({ kind: "error" });
    expect(port.readInstalledPackageJson("a-lib").kind).toBe("ok");
  });

  it("is refused at creation for bad options, with a closed code and no path", () => {
    const t = makeTree();
    const good = { versions: { node: "1.2.3" }, npmPackageDir: t.npm, declaredPackageDir: t.declared, modulesDir: t.modules };
    const cases: Array<[unknown, string]> = [
      [undefined, "options_not_plain_object"],
      [{ ...good, extra: 1 }, "options_keys"],
      [{ ...good, npmPackageDir: "relative" }, "npm_dir_invalid"],
      [{ ...good, declaredPackageDir: join(base, "missing") }, "declared_dir_invalid"],
      [{ ...good, modulesDir: `${t.modules}/..` }, "modules_dir_invalid"],
      [{ ...good, npmPackageDir: undefined }, "npm_dir_invalid"],
    ];
    for (const [options, code] of cases) {
      const r = createRuntimeVersionReadAdapter(options);
      expect(codeOf(r), JSON.stringify(options)).toBe(code);
      expect(JSON.stringify(r)).not.toContain(base);
    }
    expect(createRuntimeVersionReadAdapter(good).ok).toBe(true);
  });

  it("does not change its options and a getter in them is refused without being run", () => {
    const t = makeTree();
    const options = Object.freeze({ versions: Object.freeze({ node: "1.2.3" }), npmPackageDir: t.npm, declaredPackageDir: t.declared, modulesDir: t.modules });
    const before = JSON.stringify(options);
    expect(createRuntimeVersionReadAdapter(options).ok).toBe(true);
    expect(JSON.stringify(options)).toBe(before);
    let ran = false;
    const g = { versions: {}, npmPackageDir: t.npm, declaredPackageDir: t.declared };
    Object.defineProperty(g, "modulesDir", { enumerable: true, get: () => ((ran = true), t.modules) });
    expect(codeOf(createRuntimeVersionReadAdapter(g))).toBe("options_not_plain_object");
    expect(ran).toBe(false);
  });

  it("has a port that is frozen, exposes only the four read operations, and takes no path", () => {
    const port = versionAdapter(makeTree());
    expect(Object.isFrozen(port)).toBe(true);
    expect(Object.keys(port).sort()).toEqual(["readDeclaredPackageJson", "readInstalledPackageJson", "readNodeVersion", "readNpmPackageJson"]);
    expect(port.readNodeVersion.length).toBe(0);
    expect(port.readNpmPackageJson.length).toBe(0);
    expect(port.readDeclaredPackageJson.length).toBe(0);
    expect(port.readInstalledPackageJson.length).toBe(1);
  });
});

describe("no path, content or secret in an answer or an error", () => {
  it("answers of a failed read are the closed values only", () => {
    const secretDir = dir(`${CANARY}-root`);
    put(join(secretDir, "package.json"), CANARY.repeat(5000));
    const t = { npm: secretDir, declared: dir("d"), modules: dir("m") };
    const port = versionAdapter(t);
    const answers = [port.readNpmPackageJson(), port.readDeclaredPackageJson(), port.readInstalledPackageJson("a-lib"), port.readInstalledPackageJson("../x")];
    for (const a of answers) {
      expect(Object.keys(a)).toEqual(["kind"]);
      expect(JSON.stringify(a)).not.toContain(CANARY);
      expect(JSON.stringify(a)).not.toContain(base);
    }
    const collected = collectRuntimeVersionFacts(port);
    expect(collected.ok).toBe(false);
    expect(JSON.stringify(collected)).not.toContain(CANARY);
    expect(JSON.stringify(collected)).not.toContain(base);
  });

  it("an environment variable value never reaches an answer", () => {
    process.env["PHOENIX_TEST_CANARY_W4C"] = CANARY;
    try {
      const t = makeTree();
      rmSync(join(t.npm, "package.json"));
      const collected = collectRuntimeVersionFacts(versionAdapter(t));
      expect(JSON.stringify(collected)).not.toContain(CANARY);
    } finally {
      delete process.env["PHOENIX_TEST_CANARY_W4C"];
    }
  });
});

describe("static properties of the adapter source", () => {
  const source = readFileSync(new URL("../src/runtimeFacts/fsReadAdapters.ts", import.meta.url), "utf8");
  const code = source
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"))
    .join("\n");

  it("imports node:fs read functions only, starts no process, and has no write, network or environment access", () => {
    const fsImport = /import \{([^}]*)\} from "node:fs";/.exec(code);
    expect(fsImport).not.toBeNull();
    const names = (fsImport?.[1] ?? "").split(",").map((s) => s.trim()).filter(Boolean).sort();
    expect(names).toEqual(["closeSync", "constants", "fstatSync", "lstatSync", "openSync", "readSync", "realpathSync"]);
    expect(code).not.toMatch(/child_process|node:net|node:http|node:os|node:crypto|spawn|fetch\(/);
    expect(code).not.toMatch(/writeFile|appendFile|unlink|rmSync|renameSync|mkdirSync|chmod|symlinkSync|copyFile|truncate/);
    expect(code).not.toMatch(/process\.env|process\.versions|process\.cwd|process\.execPath/);
  });

  it("holds no fixed container path and no fixed version", () => {
    expect(code).not.toMatch(/["'`]\/(run|app|usr|repo|workspace|etc|proc|tmp)[/"'`]/);
    expect(code).not.toMatch(/["'`]\d+\.\d+\.\d+["'`]/);
  });

  it("imports only node:fs, node:path, the result type, and the two sibling modules", () => {
    const imports = [...code.matchAll(/from "([^"]+)";/g)].map((m) => m[1]);
    expect(imports.sort()).toEqual(["../schema/types.js", "./leaseFacts.js", "./versionFacts.js", "node:fs", "node:path"]);
  });

  it("the other runtimeFacts modules still import no node:fs", () => {
    for (const f of ["leaseFacts.ts", "versionFacts.ts"]) {
      const text = readFileSync(new URL(`../src/runtimeFacts/${f}`, import.meta.url), "utf8");
      expect(text, f).not.toMatch(/from "node:fs/);
    }
  });
});
