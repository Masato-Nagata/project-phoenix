// Source_Bundler against the seven real allowlisted files and the real allowlist documents (task 2.1, 2.2).
//
// The expected hashes are in packages/analyzer/test-vectors/source-bundle/real-files.json. They were computed by a
// different tool chain (perl and sha256sum), not by the reference builder and not by the code under test. This test
// needs the seven files and the two documents to be present (the approved test container mounts exactly those files,
// read-only; no other file of legacy/, and nothing of evaluation/, is mounted).
import { lstat, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  buildSourceBundle,
  parseAllowlistJson,
  parseAllowlistTable,
  renderBundleText,
  serializeManifest,
  type FileKind,
  type FileSystemPort,
} from "../src/index.js";
import { forbiddenAccesses } from "./helpers/importGraph.js";

const REPO = fileURLToPath(new URL("../../../", import.meta.url)).replace(/\/$/, "");
const VECTORS = JSON.parse(readFileSync(fileURLToPath(new URL("../test-vectors/source-bundle/real-files.json", import.meta.url)), "utf8")) as {
  files: { path: string; sha256Lf: string; bytesAfterNormalization: number }[];
};

/** Node file system behind the port, with a log of every path it was asked about. */
function nodeFs(root: string): FileSystemPort & { accessed: string[] } {
  const accessed: string[] = [];
  return {
    accessed,
    async lstat(path: string): Promise<{ kind: FileKind; nlink: number }> {
      accessed.push(path);
      const st = await lstat(path);
      const kind: FileKind = st.isSymbolicLink() ? "symlink" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other";
      return { kind, nlink: st.nlink };
    },
    async readFile(path: string): Promise<Uint8Array> {
      accessed.push(path);
      return new Uint8Array(await readFile(path));
    },
  };
}

describe("the seven real files", () => {
  it("the real allowlist JSON and Markdown table list the same seven files as the independent vectors", () => {
    const json = parseAllowlistJson(readFileSync(join(REPO, "docs/ai-input-allowlist.json"), "utf8"));
    const table = parseAllowlistTable(readFileSync(join(REPO, "docs/ai-input-allowlist.md"), "utf8"));
    expect(json.ok && table.ok).toBe(true);
    if (!json.ok || !table.ok) return;
    const expected = VECTORS.files.map((f) => f.path);
    expect(expected).toHaveLength(7);
    expect(json.value).toEqual(expected);
    expect(table.value).toEqual(expected);
  });

  it("builds a bundle whose hashes equal the independently computed vectors, touching only allowed paths", async () => {
    const fs = nodeFs(REPO);
    const r = await buildSourceBundle(fs, REPO);
    expect(r.ok, r.ok ? "" : `${r.error.code}: ${r.error.detail} (${r.error.path ?? ""})`).toBe(true);
    if (!r.ok) return;
    expect(r.value.manifest.map((m) => ({ path: m.path, sha256Lf: m.sha256Lf }))).toEqual(VECTORS.files.map((f) => ({ path: f.path, sha256Lf: f.sha256Lf })));
    for (const f of r.value.files) {
      const v = VECTORS.files.find((x) => x.path === f.path);
      expect(new TextEncoder().encode(f.text).length, f.path).toBe(v?.bytesAfterNormalization);
      expect(f.text.includes("\r"), f.path).toBe(false);
    }
    expect(renderBundleText(r.value).startsWith(`=== FILE: ${VECTORS.files[0]?.path} ===\n`)).toBe(true);
    expect(new TextDecoder().decode(serializeManifest(r.value.manifest))).not.toContain(REPO);
    const allowed = new Set<string>([
      join(REPO, "docs/ai-input-allowlist.json"), join(REPO, "docs/ai-input-allowlist.md"),
      join(REPO, "legacy"), join(REPO, "legacy/src"), join(REPO, "legacy/sql"),
      ...VECTORS.files.map((f) => `${REPO}/${f.path}`),
    ]);
    const normalized = fs.accessed.map((p) => p.replaceAll("\\", "/"));
    expect(normalized.filter((p) => !allowed.has(p) && !allowed.has(p.replaceAll("/", "\\")))).toEqual([]);
    expect(forbiddenAccesses(normalized, REPO)).toEqual([]);
  });
});