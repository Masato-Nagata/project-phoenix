// Task 4.9-B: the read-only, root-confined file system of the Source_Bundler. Everything happens in a temporary directory (tmpfs in the
// toolchain container). Nothing here touches /repo, /run or the host outside that directory. Synthetic data only.
// The one test that needs a file mode that denies reading is SKIPPED when the user is root (root ignores modes); a skipped test is NOT a pass.
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ANALYSIS_FILE_MAX_BYTES, AnalysisFsError, createAnalysisFs, type AnalysisFileSystem } from "../src/runtime/analysisFs.js";

const CANARY = "CANARY-analysis-fs-91c4";
let base: string;
let root: string;
let outside: string;

function make(seam?: Parameters<typeof createAnalysisFs>[1]): AnalysisFileSystem {
  const r = createAnalysisFs({ root }, seam);
  if (!r.ok) throw new Error("expected ok");
  return r.value;
}
const codeOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return "resolved";
  } catch (e) {
    return e instanceof AnalysisFsError ? e.code : `other:${String(e)}`;
  }
};

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "phx-afs-")));
  root = join(base, "repo");
  outside = join(base, "outside");
  mkdirSync(join(root, "legacy", "src"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(root, "legacy", "src", "a.php"), "<?php\n// a\n");
  writeFileSync(join(outside, "secret.txt"), CANARY);
  symlinkSync(join(outside, "secret.txt"), join(root, "escape.txt"));
  symlinkSync(outside, join(root, "escape-dir"));
});
afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe("createAnalysisFs", () => {
  it("accepts one existing real directory", () => {
    expect(createAnalysisFs({ root }).ok).toBe(true);
  });
  it("refuses everything else with a closed code", () => {
    const file = join(root, "legacy", "src", "a.php");
    const link = join(base, "link-to-repo");
    symlinkSync(root, link);
    const cases: [unknown, string][] = [
      [undefined, "options_invalid"],
      [null, "options_invalid"],
      [[], "options_invalid"],
      ["x", "options_invalid"],
      [{}, "options_invalid"],
      [{ root, extra: 1 }, "options_invalid"],
      [{ root: undefined }, "root_invalid"],
      [{ root: "relative/dir" }, "root_invalid"],
      [{ root: "/" }, "root_invalid"],
      [{ root: `${root}/` }, "root_invalid"],
      [{ root: `${root}/../repo` }, "root_invalid"],
      [{ root: `${root}\0` }, "root_invalid"],
      [{ root: join(base, "missing") }, "root_invalid"],
      [{ root: file }, "root_invalid"],
      [{ root: link }, "root_invalid"],
    ];
    for (const [options, code] of cases) {
      const r = createAnalysisFs(options);
      expect(r.ok, JSON.stringify(options)).toBe(false);
      if (!r.ok) expect(r.error.code, JSON.stringify(options)).toBe(code);
    }
  });
  it("refuses an accessor as the option", () => {
    const o = {};
    Object.defineProperty(o, "root", { enumerable: true, get: () => root });
    const r = createAnalysisFs(o);
    expect(r.ok).toBe(false);
  });
});

describe("readFile", () => {
  it("returns the exact bytes (a BOM and invalid UTF-8 are kept) as a fresh copy", async () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x41, 0xff, 0xfe, 0x0d, 0x0a, 0x00]);
    writeFileSync(join(root, "legacy", "src", "bytes.bin"), bytes);
    const fs = make();
    const a = await fs.readFile(join(root, "legacy", "src", "bytes.bin"));
    expect([...a]).toEqual([...bytes]);
    a[0] = 0;
    const b = await fs.readFile(join(root, "legacy", "src", "bytes.bin"));
    expect(b[0]).toBe(0xef);
  });

  it("reads an empty file and a file of exactly the size limit, and refuses one byte more", async () => {
    writeFileSync(join(root, "empty.txt"), "");
    writeFileSync(join(root, "max.bin"), Buffer.alloc(ANALYSIS_FILE_MAX_BYTES, 0x61));
    writeFileSync(join(root, "over.bin"), Buffer.alloc(ANALYSIS_FILE_MAX_BYTES + 1, 0x61));
    const fs = make();
    expect((await fs.readFile(join(root, "empty.txt"))).byteLength).toBe(0);
    expect((await fs.readFile(join(root, "max.bin"))).byteLength).toBe(ANALYSIS_FILE_MAX_BYTES);
    expect(await codeOf(fs.readFile(join(root, "over.bin")))).toBe("EIO");
  });

  it("maps a missing file to ENOENT and a path below a file to ENOTDIR", async () => {
    const fs = make();
    expect(await codeOf(fs.readFile(join(root, "legacy", "src", "missing.php")))).toBe("ENOENT");
    expect(await codeOf(fs.readFile(join(root, "legacy", "src", "a.php", "below")))).toBe("ENOTDIR");
  });

  it("refuses a directory with EIO", async () => {
    const fs = make();
    expect(await codeOf(fs.readFile(join(root, "legacy", "src")))).toBe("EIO");
  });

  it("refuses a symbolic link as the file, as a directory of the path, and a link that leaves the root", async () => {
    writeFileSync(join(root, "real.txt"), "real");
    symlinkSync(join(root, "real.txt"), join(root, "file-link.txt"));
    symlinkSync(join(root, "legacy"), join(root, "dir-link"));
    const fs = make();
    expect(await codeOf(fs.readFile(join(root, "file-link.txt")))).toBe("EIO");
    expect(await codeOf(fs.readFile(join(root, "dir-link", "src", "a.php")))).toBe("EIO");
    expect(await codeOf(fs.readFile(join(root, "escape.txt")))).toBe("EIO");
    expect(await codeOf(fs.readFile(join(root, "escape-dir", "secret.txt")))).toBe("EIO");
  });

  it("refuses every path outside the root or in a form that is not <root>/<segment>/...", async () => {
    const fs = make();
    const bad = [
      root,
      `${root}/`,
      `${root}x/a.php`,
      `${root}/../outside/secret.txt`,
      `${root}/legacy/../../outside/secret.txt`,
      `${root}/./legacy/src/a.php`,
      `${root}//legacy/src/a.php`,
      `${root}/legacy/src/a.php/`,
      `${root}/legacy\\src\\a.php`,
      `${root}/legacy/src/a.php\0`,
      join(outside, "secret.txt"),
      "legacy/src/a.php",
      "",
      "/",
      "/etc/passwd",
    ];
    for (const p of bad) {
      expect(await codeOf(fs.readFile(p)), JSON.stringify(p)).toBe("EIO");
      expect(await codeOf(fs.lstat(p)), JSON.stringify(p)).toBe("EIO");
    }
    for (const p of [undefined, null, 1, {}, []]) {
      expect(await codeOf(fs.readFile(p as unknown as string))).toBe("EIO");
      expect(await codeOf(fs.lstat(p as unknown as string))).toBe("EIO");
    }
  });

  it("refuses a file that is replaced or grows between the read and the check", async () => {
    const p = join(root, "swap.txt");
    writeFileSync(p, "original");
    writeFileSync(join(root, "swap-new.txt"), "replacement");
    const replaced = make({ afterRead: () => renameSync(join(root, "swap-new.txt"), p) });
    expect(await codeOf(replaced.readFile(p))).toBe("EIO");

    const g = join(root, "grow.txt");
    writeFileSync(g, "short");
    const grown = make({ afterRead: () => appendFileSync(g, " and longer") });
    expect(await codeOf(grown.readFile(g))).toBe("EIO");
  });

  it("denied read gives EACCES (skipped as root)", async (ctx) => {
    if (process.getuid?.() === 0 || process.geteuid?.() === 0 || process.getuid === undefined) {
      ctx.skip();
      return;
    }
    const p = join(root, "denied.txt");
    writeFileSync(p, "x");
    chmodSync(p, 0o000);
    try {
      expect(await codeOf(make().readFile(p))).toBe("EACCES");
    } finally {
      chmodSync(p, 0o600);
    }
  });
});

describe("lstat", () => {
  it("tells file, directory, symbolic link, and the link count", async () => {
    writeFileSync(join(root, "one.txt"), "1");
    writeFileSync(join(root, "two.txt"), "2");
    linkSync(join(root, "two.txt"), join(root, "two-hard.txt"));
    symlinkSync(join(root, "one.txt"), join(root, "one-link"));
    const fs = make();
    expect(await fs.lstat(join(root, "one.txt"))).toEqual({ kind: "file", nlink: 1 });
    expect(await fs.lstat(join(root, "legacy"))).toEqual({ kind: "dir", nlink: expect.any(Number) as number });
    expect(await fs.lstat(join(root, "one-link"))).toMatchObject({ kind: "symlink" });
    expect(await fs.lstat(join(root, "two.txt"))).toEqual({ kind: "file", nlink: 2 });
    expect(await fs.lstat(join(root, "two-hard.txt"))).toEqual({ kind: "file", nlink: 2 });
  });
  it("does not follow a link that leaves the root: it reports the link itself", async () => {
    expect(await make().lstat(join(root, "escape.txt"))).toMatchObject({ kind: "symlink" });
  });
  it("maps a missing path to ENOENT", async () => {
    expect(await codeOf(make().lstat(join(root, "nothing-here")))).toBe("ENOENT");
  });
});

describe("what an error carries", () => {
  it("is an AnalysisFsError whose message is the code; no path, no system text, no content", async () => {
    const fs = make();
    const cases: (() => Promise<unknown>)[] = [
      () => fs.readFile(join(root, "escape.txt")),
      () => fs.readFile(join(root, "missing", "x.php")),
      () => fs.readFile(join(outside, "secret.txt")),
      () => fs.lstat(join(outside, "secret.txt")),
    ];
    for (const c of cases) {
      let caught: unknown;
      try {
        await c();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(AnalysisFsError);
      const e = caught as AnalysisFsError;
      expect(["ENOENT", "ENOTDIR", "EACCES", "EPERM", "EIO"]).toContain(e.code);
      expect(e.message).toBe(e.code);
      const shown = `${String(e)}\n${e.stack ?? ""}\n${JSON.stringify(e)}`;
      expect(shown).not.toContain(base);
      expect(shown).not.toContain(CANARY);
      expect(Object.keys(e).sort()).toEqual(["code", "name"]);
    }
  });
});

describe("the adapter has no other capability", () => {
  it("offers only readFile and lstat, frozen", () => {
    const fs = make();
    expect(Object.keys(fs).sort()).toEqual(["lstat", "readFile"]);
    expect(Object.isFrozen(fs)).toBe(true);
  });
});

describe("readFile: the link count of the opened file (task 4.9-A follow-up)", () => {
  it("reads a file whose descriptor has a link count of 1", async () => {
    const p = join(root, "nl-one.txt");
    writeFileSync(p, "single");
    expect(new TextDecoder().decode(await make().readFile(p))).toBe("single");
  });

  it("refuses a file that already has a second hard link, by either name, and returns no content", async () => {
    const a = join(root, "nl-a.txt");
    const b = join(root, "nl-b.txt");
    writeFileSync(a, CANARY);
    linkSync(a, b);
    const fs = make();
    expect(await codeOf(fs.readFile(a))).toBe("EIO");
    expect(await codeOf(fs.readFile(b))).toBe("EIO");
    // the count is the count of the file, not of the name: after the second name is removed, the file reads again
    rmSync(b);
    expect(new TextDecoder().decode(await fs.readFile(a))).toBe(CANARY);
  });

  it("a hard link made after lstat showed a link count of 1 is refused by the next readFile", async () => {
    const p = join(root, "nl-late.txt");
    const q = join(root, "nl-late-link.txt");
    writeFileSync(p, "late");
    const fs = make();
    expect(await fs.lstat(p)).toEqual({ kind: "file", nlink: 1 });
    linkSync(p, q);
    expect(await codeOf(fs.readFile(p))).toBe("EIO");
  });

  it("a hard link made between the read and the second check is refused (the link count must still be 1)", async () => {
    const p = join(root, "nl-during.txt");
    const q = join(root, "nl-during-link.txt");
    writeFileSync(p, "during");
    const fs = make({ afterRead: () => linkSync(p, q) });
    expect(await codeOf(fs.readFile(p))).toBe("EIO");
  });

  it("the refusal is the closed code and carries no content and no path", async () => {
    const a = join(root, "nl-err-a.txt");
    writeFileSync(a, CANARY);
    linkSync(a, join(root, "nl-err-b.txt"));
    let caught: unknown;
    try {
      await make().readFile(a);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(AnalysisFsError);
    const e = caught as AnalysisFsError;
    expect(e.code).toBe("EIO");
    expect(`${String(e)}\n${e.stack ?? ""}\n${JSON.stringify(e)}`).not.toContain(CANARY);
    expect(`${String(e)}\n${e.stack ?? ""}`).not.toContain(base);
  });

  it("the other boundaries still hold next to the link count: a path outside the root and a missing file", async () => {
    const fs = make();
    expect(await codeOf(fs.readFile(join(outside, "secret.txt")))).toBe("EIO");
    expect(await codeOf(fs.readFile(join(root, "nl-missing.txt")))).toBe("ENOENT");
  });
});
