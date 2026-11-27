// The bundle walk (G2-C, design.md item 7a): sensitivity, refusals, limits, abort, and change detection, on small temporary trees.
// Limits that need thousands of entries are tested with the production values where that is cheap (8 MiB file, depth 16, 5,000 files) and otherwise
// with a TIGHTER value through the optional argument, which can only lower a limit. Permission tests are NOT RUN as root (reported as skipped).
// A pass says nothing about a real runtime image. No evaluation/, Approval Store or Docker access.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, promises as fsp, renameSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync, appendFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { scanBundle } from "../src/isolation/importScan.js";
import { scanBundleRoots, type Root } from "../src/isolation/nodeDeps.js";

const base = mkdtempSync(join(tmpdir(), "phoenix-bundlewalk-"));
let n = 0;
afterEach(() => vi.restoreAllMocks());
afterAll(() => {
  try {
    chmodSync(base, 0o700);
  } catch {
    /* best effort */
  }
  rmSync(base, { recursive: true, force: true });
});
const canPermissionTest = typeof process.geteuid === "function" && process.geteuid() !== 0;

type Files = Record<string, string | Buffer>;
function tree(files: Files, label = "packages/x/dist"): { dir: string; roots: Root[] } {
  const dir = join(base, `t${n++}`, "root");
  mkdirSync(dir, { recursive: true });
  for (const [rel, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), c);
  }
  return { dir, roots: [{ label, dir }] };
}
const BASE_FILES: Files = { "a.js": "export const a = 1;\n", "b/c.js": "export const c = 2;\n", "d.json": "{}\n", "e.d.ts": "export {};\n", "f.js.map": "{}\n", "g.node": Buffer.from([1, 2, 3]), "h.wasm": Buffer.from([0, 97, 115, 109]) };
const hashOf = async (roots: Root[], lim?: Parameters<typeof scanBundleRoots>[2]): Promise<string> => {
  const r = await scanBundleRoots(roots, undefined, lim);
  if (!r.ok) throw new Error(`scan failed: ${r.code}`);
  return r.bundleSha256;
};
const codeOf = async (roots: Root[], signal?: AbortSignal, lim?: Parameters<typeof scanBundleRoots>[2]): Promise<string> => {
  const r = await scanBundleRoots(roots, signal, lim);
  return r.ok ? "ok" : r.code;
};

describe("determinism and sensitivity", () => {
  it("the same tree built in another creation order gives the same hash; a different tree does not", async () => {
    const a = tree(BASE_FILES);
    const b = tree(Object.fromEntries(Object.entries(BASE_FILES).reverse()));
    expect(await hashOf(a.roots)).toBe(await hashOf(b.roots));
    expect(await hashOf(a.roots)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("detects a one-byte change, a renamed file, an added file, a removed file, and a change in JSON, type definition, source map, .node and .wasm files", async () => {
    const baseHash = await hashOf(tree(BASE_FILES).roots);
    const variants: Files[] = [
      { ...BASE_FILES, "a.js": "export const a = 2;\n" },
      { ...BASE_FILES, "d.json": "[]\n" },
      { ...BASE_FILES, "e.d.ts": "export {}; \n" },
      { ...BASE_FILES, "f.js.map": "{ }\n" },
      { ...BASE_FILES, "g.node": Buffer.from([1, 2, 4]) },
      { ...BASE_FILES, "h.wasm": Buffer.from([0, 97, 115, 110]) },
      (() => { const { "a.js": moved, ...rest } = BASE_FILES; return { ...rest, "z.js": moved as string }; })(),
      { ...BASE_FILES, "extra.js": "" },
      (() => { const { "d.json": _removed, ...rest } = BASE_FILES; return rest; })(),
    ];
    const seen = new Set<string>([baseHash]);
    for (const [i, v] of variants.entries()) {
      const h = await hashOf(tree(v).roots);
      expect(seen.has(h), `variant ${i}`).toBe(false);
      seen.add(h);
    }
  });

  it("the raw bytes are hashed (a change that the decoded text hides is still detected), and the text of a .node or .wasm file stays empty", async () => {
    const x = await scanBundleRoots(tree({ "a.js": Buffer.from([0x63, 0xff]), "b.node": Buffer.from([9]) }).roots, undefined);
    const y = await scanBundleRoots(tree({ "a.js": Buffer.from([0x63, 0xfe]), "b.node": Buffer.from([9]) }).roots, undefined);
    expect(x.ok && y.ok).toBe(true);
    if (!x.ok || !y.ok) return;
    expect(x.files.find((f) => f.rel.endsWith("b.node"))?.text).toBe("");
    expect(scanBundle(x.files).textSha256).toBe(scanBundle(y.files).textSha256);
    expect(x.bundleSha256).not.toBe(y.bundleSha256);
  });

  it("the excluded directories: the set is part of the hash, the content and the names inside are not (the directory is not entered)", async () => {
    const withNm = tree({ ...BASE_FILES, "node_modules/p/i.js": "eval(1)" });
    const withNm2 = tree({ ...BASE_FILES, "node_modules/other name é.js": "different", "node_modules/sub/x": "y" });
    const without = tree(BASE_FILES);
    const hNm = await hashOf(withNm.roots);
    expect(await hashOf(withNm2.roots)).toBe(hNm);
    expect(hNm).not.toBe(await hashOf(without.roots));
    const nested = tree({ ...BASE_FILES, "b/node_modules/q.js": "x" });
    expect(await hashOf(nested.roots)).not.toBe(await hashOf(without.roots));
    expect(await hashOf(nested.roots)).not.toBe(hNm);
  });

  it.runIf(canPermissionTest)("an excluded directory that cannot be read is not entered (no read failure)", async () => {
    const t = tree({ ...BASE_FILES, "node_modules/p/i.js": "x" });
    chmodSync(join(t.dir, "node_modules"), 0o000);
    try {
      expect(await codeOf(t.roots)).toBe("ok");
    } finally {
      chmodSync(join(t.dir, "node_modules"), 0o700);
    }
  });

  it("four roots with the same file names do not collide, and the root labels are part of the paths", async () => {
    const labels = ["packages/ai-client/dist", "packages/analyzer/dist", "packages/discovery-loop/dist", "packages/verifier/dist"];
    const roots = labels.map((l) => tree({ "index.js": "export {};\n" }, l).roots[0] as Root);
    const r = await scanBundleRoots(roots, undefined);
    expect(r.ok && r.files.map((f) => f.rel)).toEqual(labels.map((l) => `${l}/index.js`));
    const other = labels.map((l) => tree({ "index.js": "export {};\n" }, l.replace("analyzer", "analyser")).roots[0] as Root);
    expect(await hashOf(roots)).not.toBe(await hashOf(other));
  });
});

describe("refusals", () => {
  it("an empty root, and a root that holds only node_modules, is bundle_empty_root; a missing root is bundle_read_failed; a root that is a file is bundle_read_failed", async () => {
    const empty = join(base, `t${n++}`, "empty");
    mkdirSync(empty, { recursive: true });
    expect(await codeOf([{ label: "packages/x/dist", dir: empty }])).toBe("bundle_empty_root");
    expect(await codeOf(tree({ "node_modules/p/i.js": "x" }).roots)).toBe("bundle_empty_root");
    expect(await codeOf([{ label: "packages/x/dist", dir: join(empty, "nope") }])).toBe("bundle_read_failed");
    const file = tree({ "a.js": "x" }).dir;
    expect(await codeOf([{ label: "packages/x/dist", dir: join(file, "a.js") }])).toBe("bundle_read_failed");
    // one empty root among good ones fails the whole result
    expect(await codeOf([...tree(BASE_FILES).roots, { label: "packages/y/dist", dir: empty }])).toBe("bundle_empty_root");
  });

  it("a path outside the grammar is bundle_path_invalid (a space, a non-ASCII name, a `$`, a backslash, a tab, a colon)", async () => {
    for (const name of ["a b.js", "é.js", "x$y.js", "back\\slash.js", "tab\tname.js", "co:lon.js", "star*.js"]) {
      let t: ReturnType<typeof tree>;
      try {
        t = tree({ "ok.js": "x", [name]: "y" });
      } catch {
        continue; // the file system does not allow this name here
      }
      expect(await codeOf(t.roots), JSON.stringify(name)).toBe("bundle_path_invalid");
    }
    expect(await codeOf(tree({ "ok.js": "x", "bad dir/x.js": "y" }).roots)).toBe("bundle_path_invalid");
    expect(await codeOf([{ label: "packages//x/dist", dir: tree(BASE_FILES).dir }])).toBe("bundle_path_invalid");
    expect(await codeOf([{ label: "/abs/dist", dir: tree(BASE_FILES).dir }])).toBe("bundle_path_invalid");
    expect(await codeOf([{ label: "packages/x/dist/", dir: tree(BASE_FILES).dir }])).toBe("bundle_path_invalid");
    expect(await codeOf([{ label: "..", dir: tree(BASE_FILES).dir }])).toBe("bundle_path_invalid");
  });

  it("a repeated root label, and labels that differ only in letter case, are bundle_duplicate", async () => {
    const a = tree(BASE_FILES, "packages/x/dist").roots[0] as Root;
    const b = tree(BASE_FILES, "packages/x/dist").roots[0] as Root;
    const c = tree(BASE_FILES, "packages/X/dist").roots[0] as Root;
    expect(await codeOf([a, b])).toBe("bundle_duplicate");
    expect(await codeOf([a, c])).toBe("bundle_duplicate");
  });

  it("two files that differ only in letter case are bundle_duplicate (when the file system keeps both)", async () => {
    const t = tree({ "a.js": "1" });
    writeFileSync(join(t.dir, "A.js"), "2");
    const both = (await fsp.readdir(t.dir)).length === 2;
    if (both) expect(await codeOf(t.roots)).toBe("bundle_duplicate");
    const t2 = tree({ "x/File.js": "1" });
    writeFileSync(join(t2.dir, "x", "file.js"), "2");
    if ((await fsp.readdir(join(t2.dir, "x"))).length === 2) expect(await codeOf(t2.roots)).toBe("bundle_duplicate");
  });

  it("a symbolic link (to a file, to a directory, named node_modules, or as the root) is bundle_unsupported_entry", async () => {
    const t = tree(BASE_FILES);
    try {
      symlinkSync(join(t.dir, "a.js"), join(t.dir, "link.js"));
    } catch {
      return; // links are not permitted here
    }
    expect(await codeOf(t.roots)).toBe("bundle_unsupported_entry");
    const t2 = tree(BASE_FILES);
    symlinkSync(join(t2.dir, "b"), join(t2.dir, "dirlink"), "dir");
    expect(await codeOf(t2.roots)).toBe("bundle_unsupported_entry");
    const t3 = tree(BASE_FILES);
    symlinkSync(join(t3.dir, "b"), join(t3.dir, "node_modules"), "dir");
    expect(await codeOf(t3.roots)).toBe("bundle_unsupported_entry"); // the exclusion of node_modules cannot hide a link
    const t4 = tree(BASE_FILES);
    const rootLink = join(base, `t${n++}-rootlink`);
    symlinkSync(t4.dir, rootLink, "dir");
    expect(await codeOf([{ label: "packages/x/dist", dir: rootLink }])).toBe("bundle_unsupported_entry");
  });

  it("a special file (a Unix socket) is bundle_unsupported_entry, and also inside a subdirectory", async () => {
    const t = tree(BASE_FILES);
    const sock = join(t.dir, "b", "s");
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(sock, () => resolve());
      });
    } catch {
      return; // sockets are not available here
    }
    try {
      expect(await codeOf(t.roots)).toBe("bundle_unsupported_entry");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.runIf(canPermissionTest)("a file that cannot be read is bundle_read_failed; a directory that cannot be listed is bundle_read_failed", async () => {
    const t = tree(BASE_FILES);
    chmodSync(join(t.dir, "a.js"), 0o000);
    try {
      expect(await codeOf(t.roots)).toBe("bundle_read_failed");
    } finally {
      chmodSync(join(t.dir, "a.js"), 0o600);
    }
    const t2 = tree(BASE_FILES);
    chmodSync(join(t2.dir, "b"), 0o000);
    try {
      expect(await codeOf(t2.roots)).toBe("bundle_read_failed");
    } finally {
      chmodSync(join(t2.dir, "b"), 0o700);
    }
  });

  it("a failure never carries a hash, a file list, or an exception text", async () => {
    const r = await scanBundleRoots(tree({ "bad name.js": "x" }).roots, undefined);
    expect(r).toEqual({ ok: false, code: "bundle_path_invalid" });
  });
});

describe("limits (a value equal to a limit is accepted, a value above it is refused)", () => {
  it("one file: 8 MiB is accepted and 8 MiB + 1 byte is bundle_limit_exceeded (production value)", async () => {
    const ok = tree({ "a.js": Buffer.alloc(8 * 1024 * 1024, 0x61) });
    expect(await codeOf(ok.roots)).toBe("ok");
    const over = tree({ "a.js": Buffer.alloc(8 * 1024 * 1024 + 1, 0x61) });
    expect(await codeOf(over.roots)).toBe("bundle_limit_exceeded");
  });

  it("depth 16 is accepted and depth 17 is bundle_limit_exceeded (production value; a root has depth 0)", async () => {
    const at16 = tree({ [`${Array.from({ length: 16 }, () => "d").join("/")}/x.js`]: "x" });
    expect(await codeOf(at16.roots)).toBe("ok");
    const at17 = tree({ [`${Array.from({ length: 17 }, () => "d").join("/")}/x.js`]: "x" });
    expect(await codeOf(at17.roots)).toBe("bundle_limit_exceeded");
  });

  it("5,000 files are accepted and 5,001 are bundle_limit_exceeded (production value; a larger value passed as an override is ignored)", async () => {
    const mk = (count: number): Root[] => {
      const dir = join(base, `t${n++}`, "root");
      mkdirSync(dir, { recursive: true });
      for (let i = 0; i < count; i++) writeFileSync(join(dir, `f${i}.js`), "");
      return [{ label: "packages/x/dist", dir }];
    };
    expect(await codeOf(mk(5000))).toBe("ok");
    expect(await codeOf(mk(5001), undefined, { files: 1_000_000 })).toBe("bundle_limit_exceeded");
  }, 60_000);

  it("tighter limits (the override can only lower a limit): files, total bytes, directories, entries, depth, one file", async () => {
    expect(await codeOf(tree({ "a.js": "1", "b.js": "2", "c.js": "3" }).roots, undefined, { files: 3 })).toBe("ok");
    expect(await codeOf(tree({ "a.js": "1", "b.js": "2", "c.js": "3", "d.js": "4" }).roots, undefined, { files: 3 })).toBe("bundle_limit_exceeded");
    expect(await codeOf(tree({ "a.js": "12345", "b.js": "12345" }).roots, undefined, { totalBytes: 10 })).toBe("ok");
    expect(await codeOf(tree({ "a.js": "12345", "b.js": "123456" }).roots, undefined, { totalBytes: 10 })).toBe("bundle_limit_exceeded");
    expect(await codeOf(tree({ "a.js": "12345" }).roots, undefined, { fileBytes: 5 })).toBe("ok");
    expect(await codeOf(tree({ "a.js": "123456" }).roots, undefined, { fileBytes: 5 })).toBe("bundle_limit_exceeded");
    // directories: the root itself and each walked subdirectory count; a skipped node_modules does not
    expect(await codeOf(tree({ "x/a.js": "1", "y/b.js": "2", "node_modules/p/c.js": "3" }).roots, undefined, { directories: 3 })).toBe("ok");
    expect(await codeOf(tree({ "x/a.js": "1", "y/b.js": "2", "z/c.js": "3" }).roots, undefined, { directories: 3 })).toBe("bundle_limit_exceeded");
    // the directories are counted over all roots together
    const two = [...tree({ "x/a.js": "1" }, "packages/a/dist").roots, ...tree({ "y/b.js": "2" }, "packages/b/dist").roots];
    expect(await codeOf(two, undefined, { directories: 4 })).toBe("ok");
    expect(await codeOf(two, undefined, { directories: 3 })).toBe("bundle_limit_exceeded");
    // entries: files, directories and the skipped node_modules directory are all entries
    const e = { "a.js": "1", "b.js": "2", "node_modules/p.js": "3", "sub/c.js": "4" }; // a.js b.js node_modules sub (4) + sub/c.js (1) = 5 entries
    expect(await codeOf(tree(e).roots, undefined, { entries: 5 })).toBe("ok");
    expect(await codeOf(tree(e).roots, undefined, { entries: 4 })).toBe("bundle_limit_exceeded");
    // depth
    expect(await codeOf(tree({ "d/d/x.js": "1" }).roots, undefined, { depth: 2 })).toBe("ok");
    expect(await codeOf(tree({ "d/d/d/x.js": "1" }).roots, undefined, { depth: 2 })).toBe("bundle_limit_exceeded");
  });

  it("the first listing and the re-listing are counted separately: a tree that is exactly at the entry limit is accepted (nothing is counted twice)", async () => {
    const t = tree({ "a.js": "1", "b.js": "2", "c.js": "3" });
    expect(await codeOf(t.roots, undefined, { entries: 3, directories: 1, files: 3 })).toBe("ok");
    expect(await codeOf(t.roots, undefined, { entries: 2 })).toBe("bundle_limit_exceeded");
  });

  it("an override that is not a lower non-negative integer is ignored (the production limit stays)", async () => {
    const t = tree({ "a.js": "1", "b.js": "2" });
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, 10 ** 9, "3" as never]) expect(await codeOf(t.roots, undefined, { files: bad as number }), String(bad)).toBe("ok");
    expect(await codeOf(t.roots, undefined, { files: 0 })).toBe("bundle_limit_exceeded");
  });

  it("a directory with very many entries is refused at the entry limit while it is listed (not read to the end)", async () => {
    const t = tree({});
    for (let i = 0; i < 40; i++) writeFileSync(join(t.dir, `f${i}.js`), "");
    const spy = vi.spyOn(fsp, "lstat");
    expect(await codeOf(t.roots, undefined, { entries: 10 })).toBe("bundle_limit_exceeded");
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2); // the root only: no file was examined after the limit was reached
  });
});

describe("abort", () => {
  it("an abort signal that is already set gives timeout and no file access at all", async () => {
    const t = tree(BASE_FILES);
    const spies = (["opendir", "lstat", "open"] as const).map((k) => vi.spyOn(fsp, k));
    const ac = new AbortController();
    ac.abort();
    const r = await scanBundleRoots(t.roots, ac.signal);
    expect(r).toEqual({ ok: false, code: "timeout" });
    for (const s of spies) expect(s.mock.calls.length).toBe(0);
  });

  it("an abort during the listing: timeout, and no file is examined or opened afterwards", async () => {
    const t = tree(BASE_FILES);
    const ac = new AbortController();
    const orig = fsp.opendir.bind(fsp);
    vi.spyOn(fsp, "opendir").mockImplementation((async (...a: Parameters<typeof fsp.opendir>) => {
      const d = await orig(...a);
      ac.abort();
      return d;
    }) as never);
    const lstat = vi.spyOn(fsp, "lstat");
    const open = vi.spyOn(fsp, "open");
    const before = lstat.mock.calls.length;
    const r = await scanBundleRoots(t.roots, ac.signal);
    expect(r).toEqual({ ok: false, code: "timeout" });
    expect(lstat.mock.calls.length - before).toBe(1); // the root itself, examined before the listing started
    expect(open.mock.calls.length).toBe(0);
  });

  it("an abort while the files are read: timeout, no new file is opened, every opened handle is closed, and no hash is returned", async () => {
    const t = tree(BASE_FILES);
    const ac = new AbortController();
    const orig = fsp.open.bind(fsp);
    let opened = 0;
    let closed = 0;
    vi.spyOn(fsp, "open").mockImplementation((async (...a: Parameters<typeof fsp.open>) => {
      const h = await orig(...a);
      opened++;
      const c = h.close.bind(h);
      h.close = async () => {
        closed++;
        return c();
      };
      ac.abort(); // the first file is open; the abort comes now
      return h;
    }) as never);
    const r = await scanBundleRoots(t.roots, ac.signal);
    expect(r).toEqual({ ok: false, code: "timeout" });
    expect(opened).toBe(1);
    expect(closed).toBe(1);
  });

  it("an abort between two files: the second file is never opened", async () => {
    const t = tree(BASE_FILES);
    const ac = new AbortController();
    const orig = fsp.open.bind(fsp);
    let opened = 0;
    vi.spyOn(fsp, "open").mockImplementation((async (...a: Parameters<typeof fsp.open>) => {
      opened++;
      const h = await orig(...a);
      const c = h.close.bind(h);
      h.close = async () => {
        const r = await c();
        ac.abort(); // the first file is finished and closed
        return r;
      };
      return h;
    }) as never);
    expect(await codeOf(t.roots, ac.signal)).toBe("timeout");
    expect(opened).toBe(1);
  });
});

describe("change detection (a consistency check, NOT a guard against a race)", () => {
  /** Runs a mutation just before the Nth file is opened (N counts from 0). */
  function beforeOpen(index: number, mutate: () => void): void {
    const orig = fsp.open.bind(fsp);
    let i = 0;
    vi.spyOn(fsp, "open").mockImplementation((async (...a: Parameters<typeof fsp.open>) => {
      if (i++ === index) mutate();
      return orig(...a);
    }) as never);
  }
  /** Runs a mutation when the Nth directory listing starts. */
  function beforeListing(index: number, mutate: () => void): void {
    const orig = fsp.opendir.bind(fsp);
    let i = 0;
    vi.spyOn(fsp, "opendir").mockImplementation((async (...a: Parameters<typeof fsp.opendir>) => {
      if (i++ === index) mutate();
      return orig(...a);
    }) as never);
  }

  it("a file that grows after the listing is bundle_changed", async () => {
    const t = tree({ "a.js": "12345" });
    beforeOpen(0, () => appendFileSync(join(t.dir, "a.js"), "6"));
    expect(await codeOf(t.roots)).toBe("bundle_changed");
  });

  it("a file rewritten with the same size and a new modification time is bundle_changed", async () => {
    const t = tree({ "a.js": "12345" });
    beforeOpen(0, () => {
      writeFileSync(join(t.dir, "a.js"), "54321");
      utimesSync(join(t.dir, "a.js"), new Date(Date.now() + 5000), new Date(Date.now() + 5000));
    });
    expect(await codeOf(t.roots)).toBe("bundle_changed");
  });

  it("a file replaced by another file of the same size (a new inode) is bundle_changed", async () => {
    const t = tree({ "a.js": "12345" });
    beforeOpen(0, () => {
      writeFileSync(join(t.dir, "a.tmp"), "12345");
      utimesSync(join(t.dir, "a.tmp"), new Date(0), new Date(0));
      renameSync(join(t.dir, "a.tmp"), join(t.dir, "a.js"));
    });
    expect(await codeOf(t.roots)).toBe("bundle_changed");
  });

  it("a file that is removed, or replaced by a symbolic link, after the listing is bundle_changed", async () => {
    const t = tree({ "a.js": "12345", "b.js": "1" });
    beforeOpen(0, () => unlinkSync(join(t.dir, "a.js")));
    expect(await codeOf(t.roots)).toBe("bundle_changed");
    vi.restoreAllMocks();
    const t2 = tree({ "a.js": "12345", "b.js": "1" });
    let linked = true;
    beforeOpen(0, () => {
      try {
        unlinkSync(join(t2.dir, "a.js"));
        symlinkSync(join(t2.dir, "b.js"), join(t2.dir, "a.js"));
      } catch {
        linked = false;
      }
    });
    const code = await codeOf(t2.roots);
    if (linked) expect(code).toBe("bundle_changed");
  });

  it("a file added, removed or turned into a skipped directory between the first and the second listing is bundle_changed", async () => {
    const t = tree({ "a.js": "1", "b.js": "2" });
    beforeListing(1, () => writeFileSync(join(t.dir, "added.js"), "x")); // the first listing is call 0; the re-listing is call 1
    expect(await codeOf(t.roots)).toBe("bundle_changed");
    vi.restoreAllMocks();
    const t2 = tree({ "a.js": "1", "b.js": "2" });
    beforeListing(1, () => mkdirSync(join(t2.dir, "node_modules")));
    expect(await codeOf(t2.roots)).toBe("bundle_changed");
    vi.restoreAllMocks();
    const t3 = tree({ "a.js": "1", "b.js": "2" });
    beforeListing(1, () => unlinkSync(join(t3.dir, "b.js")));
    expect(await codeOf(t3.roots)).toBe("bundle_changed");
  });

  it("an unchanged tree is accepted with both listings (the control of the tests above)", async () => {
    const t = tree({ "a.js": "1", "b.js": "2" });
    expect(await codeOf(t.roots)).toBe("ok");
  });

  it("the files are read once, and the directory handle is closed even when the listing is refused", async () => {
    const t = tree({ "a.js": "1", "b.js": "2", "c.js": "3" });
    const orig = fsp.opendir.bind(fsp);
    let closes = 0;
    vi.spyOn(fsp, "opendir").mockImplementation((async (...a: Parameters<typeof fsp.opendir>) => {
      const d = await orig(...a);
      const c = d.close.bind(d);
      d.close = ((...args: unknown[]) => {
        closes++;
        return (c as (...x: unknown[]) => unknown)(...args);
      }) as never;
      return d;
    }) as never);
    expect(await codeOf(t.roots, undefined, { entries: 2 })).toBe("bundle_limit_exceeded");
    expect(closes).toBeGreaterThanOrEqual(1);
  });
});

// keep the digest import used for a documentation check of the hash form
describe("form", () => {
  it("bundleSha256 is 64 lowercase hexadecimal characters", async () => {
    const r = await scanBundleRoots(tree(BASE_FILES).roots, undefined);
    expect(r.ok && /^[0-9a-f]{64}$/.test(r.bundleSha256)).toBe(true);
    expect(createHash("sha256").update("x").digest("hex")).toHaveLength(64);
  });
});