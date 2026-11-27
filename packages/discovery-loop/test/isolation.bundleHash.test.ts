// bundleSha256 (G2-C, design.md item 7a): the pure rules, the independent golden vector, and the compatibility of the Run_Manifest with and without the
// field. The expected values of test-vectors/bundle-hash/vector.json were fixed by the independent PowerShell implementation
// (tests/discovery-loop/test_bundle_hash_vector.ps1: Get-FileHash and the existing ConvertTo-CanonicalJson), NOT by this code.
// Synthetic data in temporary directories only. A pass says nothing about a real runtime image (rebuilt later, G2-D).
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { canonicalJson } from "../src/canonical/canonicalJson.js";
import { acceptRun, createNodeFileSystem, verifyRunDirectory } from "../src/index.js";
import { BUNDLE_HASH_RULE, BUNDLE_LIMITS, bundleDocumentText, computeBundleSha256, findBundlePathProblem, isValidBundlePath, ordinalCompare } from "../src/isolation/bundleHash.js";
import { scanBundle } from "../src/isolation/importScan.js";
import { scanBundleRoots } from "../src/isolation/nodeDeps.js";

interface Vector {
  readonly tree: Record<string, { path: string; base64: string }[]>;
  readonly expected: { roots: string[]; skippedDirectories: string[]; files: { path: string; sha256: string }[]; canonicalJson: string; canonicalJsonBytes: number; bundleSha256: string };
}
const VEC = fileURLToPath(new URL("../test-vectors/", import.meta.url));
const vector = JSON.parse(readFileSync(join(VEC, "bundle-hash", "vector.json"), "utf8")) as Vector;
const base = mkdtempSync(join(tmpdir(), "phoenix-bundlehash-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
let n = 0;
const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

function materialize(tree: Vector["tree"], over: Record<string, Buffer> = {}): { label: string; dir: string }[] {
  const top = join(base, `v${n++}`);
  return Object.entries(tree).map(([label, files]) => {
    const dir = join(top, ...label.split("/"));
    mkdirSync(dir, { recursive: true });
    for (const f of files) {
      const full = join(dir, ...f.path.split("/"));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, over[`${label}/${f.path}`] ?? Buffer.from(f.base64, "base64"));
    }
    return { label, dir };
  });
}

describe("the limits and the path rules", () => {
  it("the limits are the approved values (a value equal to a limit is accepted by the walk; see the walk tests)", () => {
    expect(BUNDLE_LIMITS).toEqual({ fileBytes: 8_388_608, files: 5000, totalBytes: 67_108_864, directories: 1000, entries: 10_000, depth: 16 });
    expect(Object.isFrozen(BUNDLE_LIMITS)).toBe(true);
    expect(BUNDLE_HASH_RULE).toBe("dist-bundle-sha256-v1");
  });

  it("accepts the grammar A-Z a-z 0-9 . _ @ + - with / between elements", () => {
    for (const p of ["packages/analyzer/dist/index.js", "a", "a.b-c_d@e+f/0.js", "x/.hidden", "x/...", "A/B"]) expect(isValidBundlePath(p), p).toBe(true);
  });

  it("refuses an empty path or element, `.` and `..`, an absolute path, a trailing /, a backslash, a tab, a line feed, a control character, non-ASCII, and any other character", () => {
    const bad = ["", "/a", "a/", "a//b", "a/./b", "a/../b", ".", "..", "a/..", "a\\b", "a\tb", "a\nb", "a\u0001b", "a\u007fb", "é.js", "a\u00e9", "日本.js", "a b", "a:b", "a$b", "a*b", "a?b", "a#b", "a%b", "a~b"];
    for (const p of bad) expect(isValidBundlePath(p), JSON.stringify(p)).toBe(false);
    for (const p of [1, null, undefined, {}, []]) expect(isValidBundlePath(p)).toBe(false);
  });

  it("gives bundle_path_invalid for a bad path and bundle_duplicate for a repeated path or a path that differs only in letter case (roots, skipped directories and files together)", () => {
    const f = (path: string) => ({ path, sha256: "0".repeat(64) });
    expect(findBundlePathProblem({ roots: ["r"], skippedDirectories: [], files: [f("r/a.js")] })).toBeUndefined();
    expect(findBundlePathProblem({ roots: ["r"], skippedDirectories: [], files: [f("r/a b.js")] })).toBe("bundle_path_invalid");
    expect(findBundlePathProblem({ roots: ["r/"], skippedDirectories: [], files: [] })).toBe("bundle_path_invalid");
    expect(findBundlePathProblem({ roots: ["r"], skippedDirectories: [], files: [f("r/a.js"), f("r/a.js")] })).toBe("bundle_duplicate");
    expect(findBundlePathProblem({ roots: ["r"], skippedDirectories: [], files: [f("r/a.js"), f("r/A.js")] })).toBe("bundle_duplicate");
    expect(findBundlePathProblem({ roots: ["r", "R"], skippedDirectories: [], files: [] })).toBe("bundle_duplicate");
    expect(findBundlePathProblem({ roots: ["r"], skippedDirectories: ["r/node_modules"], files: [f("r/Node_Modules")] })).toBe("bundle_duplicate");
    // a bad path wins over a duplicate (checked first)
    expect(findBundlePathProblem({ roots: ["r"], skippedDirectories: [], files: [f("r/a.js"), f("r/a.js"), f("r/é")] })).toBe("bundle_path_invalid");
  });
});

describe("order and document", () => {
  const f = (path: string, c: string) => ({ path, sha256: sha(c) });
  const shuffled = [f("r/a.js", "1"), f("r/B.js", "2"), f("r/a/b.js", "3"), f("r/a-b.js", "4"), f("r/a+b.js", "5"), f("r/a.b.js", "6"), f("r/a@b.js", "7"), f("r/a_b.js", "8"), f("r/0.js", "9")];

  it("sorts every array in ASCII ordinal order after collection, whatever the order of the input", () => {
    const doc = JSON.parse(bundleDocumentText({ roots: ["r"], skippedDirectories: ["r/z/node_modules", "r/a/node_modules"], files: shuffled })) as { files: { path: string }[]; skippedDirectories: string[] };
    expect(doc.files.map((x) => x.path)).toEqual(["r/0.js", "r/B.js", "r/a+b.js", "r/a-b.js", "r/a.b.js", "r/a.js", "r/a/b.js", "r/a@b.js", "r/a_b.js"]);
    expect(doc.skippedDirectories).toEqual(["r/a/node_modules", "r/z/node_modules"]);
    const reversed = [...shuffled].reverse();
    expect(bundleDocumentText({ roots: ["r"], skippedDirectories: [], files: reversed })).toBe(bundleDocumentText({ roots: ["r"], skippedDirectories: [], files: shuffled }));
    expect(computeBundleSha256({ roots: ["r"], skippedDirectories: [], files: reversed })).toBe(computeBundleSha256({ roots: ["r"], skippedDirectories: [], files: shuffled }));
  });

  it("uses code-unit order, not a locale order (B before a; `.` before `/`; `+` before `-`)", () => {
    expect(ordinalCompare("B.js", "a.js")).toBe(-1);
    expect(ordinalCompare("a.js", "a/b.js")).toBe(-1);
    expect(ordinalCompare("a+b", "a-b")).toBe(-1);
    expect(ordinalCompare("a", "a")).toBe(0);
    expect(ordinalCompare("b", "a")).toBe(1);
    expect("B.js".localeCompare("a.js")).toBeGreaterThan(0); // the locale order is the opposite, so the ordinal order is not by accident
  });

  it("the document has the four keys in canonical order, no BOM and no final line feed; bundleSha256 is the SHA-256 of its UTF-8 bytes", () => {
    const input = { roots: ["r2", "r1"], skippedDirectories: [], files: [f("r1/a.js", "x")] };
    const text = bundleDocumentText(input);
    expect(text).toBe(`{"files":[{"path":"r1/a.js","sha256":"${sha("x")}"}],"hashRule":"dist-bundle-sha256-v1","roots":["r1","r2"],"skippedDirectories":[]}`);
    expect(text.endsWith("\n")).toBe(false);
    expect(text.charCodeAt(0)).toBe(0x7b);
    expect(computeBundleSha256(input)).toBe(sha(Buffer.from(text, "utf8")));
  });
});

describe("the independent golden vector (expected values fixed by the PowerShell implementation)", () => {
  it("the file hashes are the SHA-256 of the raw bytes, the order is the expected one, and the document is byte for byte the expected one", () => {
    const files = Object.entries(vector.tree).flatMap(([label, fs]) => fs.filter((x) => !x.path.startsWith("node_modules/")).map((x) => ({ path: `${label}/${x.path}`, sha256: sha(Buffer.from(x.base64, "base64")) })));
    const skipped = Object.entries(vector.tree).flatMap(([label, fs]) => (fs.some((x) => x.path.startsWith("node_modules/")) ? [`${label}/node_modules`] : []));
    const sorted = [...files].sort((a, b) => ordinalCompare(a.path, b.path));
    expect(sorted).toEqual(vector.expected.files);
    expect(skipped.sort(ordinalCompare)).toEqual(vector.expected.skippedDirectories);
    const input = { roots: Object.keys(vector.tree), skippedDirectories: skipped, files };
    expect(bundleDocumentText(input)).toBe(vector.expected.canonicalJson);
    expect(Buffer.byteLength(vector.expected.canonicalJson, "utf8")).toBe(vector.expected.canonicalJsonBytes);
    expect(computeBundleSha256(input)).toBe(vector.expected.bundleSha256);
    expect(vector.expected.files).toHaveLength(22);
    expect(vector.expected.skippedDirectories).toHaveLength(2);
  });

  it("the walk of a tree built from the vector gives the same bundleSha256, and the same files in the order of the listing", async () => {
    const roots = materialize(vector.tree);
    const r = await scanBundleRoots(roots, undefined);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.bundleSha256).toBe(vector.expected.bundleSha256);
    expect(r.files.map((x) => x.rel).sort(ordinalCompare)).toEqual(vector.expected.files.map((x) => x.path));
    // the same names under the four roots do not collide
    expect(r.files.filter((x) => x.rel.endsWith("/dist/index.js"))).toHaveLength(4);
    // .node and .wasm keep the empty text (textSha256 is unchanged); the other files give their text
    expect(r.files.find((x) => x.rel.endsWith("native.node"))?.text).toBe("");
    expect(r.files.find((x) => x.rel.endsWith("mod.wasm"))?.text).toBe("");
    expect(r.files.find((x) => x.rel.endsWith("crlf.js"))?.text).toBe("a\r\nb\n");
  });

  it("the roots may be given in any order: the same bundleSha256", async () => {
    const roots = materialize(vector.tree);
    const a = await scanBundleRoots(roots, undefined);
    const b = await scanBundleRoots([...roots].reverse(), undefined);
    expect(a.ok && b.ok && a.bundleSha256 === b.bundleSha256).toBe(true);
  });

  it("two different invalid UTF-8 byte sequences have the same textSha256 and different bundleSha256", async () => {
    const x = await scanBundleRoots(materialize(vector.tree), undefined);
    const y = await scanBundleRoots(materialize(vector.tree, { "packages/verifier/dist/bad-a.js": Buffer.from([0x63, 0xfe, 0xff]) }), undefined);
    expect(x.ok && y.ok).toBe(true);
    if (!x.ok || !y.ok) return;
    const tx = scanBundle(x.files).textSha256;
    const ty = scanBundle(y.files).textSha256;
    expect(tx).toBe(ty);
    expect(x.bundleSha256).not.toBe(y.bundleSha256);
  });

  it("a change of one byte in each kind of file (JSON, type definition, source map, .node, .wasm, plain script) changes the hash, and all results differ", async () => {
    const baseHash = vector.expected.bundleSha256;
    const seen = new Set<string>([baseHash]);
    for (const [label, rel] of [["packages/discovery-loop/dist", "data.json"], ["packages/discovery-loop/dist", "types.d.ts"], ["packages/discovery-loop/dist", "index.js.map"], ["packages/verifier/dist", "bin/native.node"], ["packages/verifier/dist", "bin/mod.wasm"], ["packages/analyzer/dist", "index.js"]] as const) {
      const entry = vector.tree[label]?.find((x) => x.path === rel);
      const bytes = Buffer.from(entry?.base64 ?? "", "base64");
      bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
      const r = await scanBundleRoots(materialize(vector.tree, { [`${label}/${rel}`]: bytes }), undefined);
      expect(r.ok, rel).toBe(true);
      if (r.ok) {
        expect(seen.has(r.bundleSha256), rel).toBe(false);
        seen.add(r.bundleSha256);
      }
    }
  });
});

describe("Run_Manifest compatibility (bundleSha256 is optional for the readers)", () => {
  const temps: string[] = [];
  const copy = (name: string): string => {
    const d = join(mkdtempSync(join(tmpdir(), "bundle-compat-")), "run-0001");
    temps.push(dirname(d));
    cpSync(join(VEC, name), d, { recursive: true });
    return d;
  };
  afterAll(() => { for (const t of temps) rmSync(t, { recursive: true, force: true }); });
  const mark = (dir: string): void => writeFileSync(join(dir, "COMPLETE"), sha(readFileSync(join(dir, "manifest.json"))));

  it("the frozen version-1 and version-2 vectors have no bundleSha256 and are still accepted", async () => {
    for (const name of ["sealed-run", "sealed-run-v2"]) {
      const dir = copy(name);
      expect(readFileSync(join(dir, "manifest.json"), "utf8"), name).not.toContain("bundleSha256");
      mark(dir);
      expect((await acceptRun(createNodeFileSystem(), dir)).accepted, name).toBe(true);
    }
  });

  it("the version-2 vector with bundleSha256 verifies, is incomplete without a marker, and is accepted with one", async () => {
    const dir = copy("sealed-run-v2-bundle-hash");
    const fs = createNodeFileSystem();
    expect((await verifyRunDirectory(fs, dir)).result).toBe("success");
    expect((await acceptRun(fs, dir)).accepted).toBe(false);
    mark(dir);
    expect((await acceptRun(fs, dir)).accepted).toBe(true);
    writeFileSync(join(dir, "COMPLETE"), "0".repeat(64));
    expect((await acceptRun(fs, dir)).accepted).toBe(false);
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as { schemaVersion: number; isolationChecks: { id: string; measured: { bundleSha256?: string; textSha256?: string } }[] };
    expect(m.schemaVersion).toBe(2);
    const entry = m.isolationChecks.find((c) => c.id === "import_analysis");
    expect(entry?.measured.bundleSha256).toBe(vector.expected.bundleSha256);
    expect(entry?.measured.bundleSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(entry?.measured.textSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the manifest file is the canonical JSON plus exactly one line feed, and equals the canonical form of the v2 manifest plus the one entry (independent PowerShell generation)", () => {
    const v2 = readFileSync(join(VEC, "sealed-run-v2", "manifest.json"), "utf8");
    expect(v2.endsWith("\n") && !v2.endsWith("\n\n")).toBe(true);
    const parsed = JSON.parse(v2) as { isolationChecks: unknown[] };
    parsed.isolationChecks.push({
      id: "import_analysis", status: "verified", measuredBy: "runtime",
      measured: {
        bundleSha256: vector.expected.bundleSha256,
        filesScanned: vector.expected.files.filter((x) => /\.(js|mjs|cjs)$/.test(x.path)).length,
        filesTotal: vector.expected.files.length,
        findingCount: 0,
        textSha256: sha("synthetic-text-sha256"),
      },
    });
    const expected = Buffer.from(`${canonicalJson(parsed as never)}\n`, "utf8");
    const actual = readFileSync(join(VEC, "sealed-run-v2-bundle-hash", "manifest.json"));
    expect(actual.equals(expected)).toBe(true);
    expect(actual[0]).not.toBe(0xef); // no byte-order mark
    expect(actual.includes(Buffer.from("\r\n"))).toBe(false);
  });

  it("the new vector keeps the records and the blob of the version-2 vector, and the version-2 vector is unchanged (pinned)", () => {
    for (const f of ["records.jsonl", "blobs/d8c6799938e5f522ec575307e8004224c9c97b443d6a2f32bdd0385119965d6a"]) {
      expect(sha(readFileSync(join(VEC, "sealed-run-v2-bundle-hash", f))), f).toBe(sha(readFileSync(join(VEC, "sealed-run-v2", f))));
    }
    expect(sha(readFileSync(join(VEC, "sealed-run-v2", "manifest.json")))).toBe("47e842f8f4082eca2fb299bfadd61883c230543d56e216128b5e3333e53f5aa1");
    expect(sha(readFileSync(join(VEC, "sealed-run", "manifest.json")))).toBe("6e89c956402198a5de8fbb7b877dc84fb6234041d273ed7adfeb13e18f182f99");
    expect(sha(readFileSync(join(VEC, "sealed-run-v2-bundle-hash", "manifest.json")))).toBe("3dec760be8b4a915b4d67123d9ed82493b53612945d96e0e54f6743aba1b9d5c");
  });
});