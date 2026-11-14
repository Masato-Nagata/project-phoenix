// Source_Bundler import and attempted-read isolation test (task 2.7; R1.9, R15.1, R15.7, R15.13).
//
// Two independent checks, each with a positive control:
//  1. Static dependency analysis: no module reachable from the Source_Bundler imports evaluation/, tests/, .kiro/,
//     infra/, or a README.md, leaves the package, or imports anything but node:crypto.
//  2. Attempted reads: with a file system that records every access and holds decoys at the forbidden locations, a
//     build touches only the two allowlist documents, the listed files, and their parent directories.
// A path-string check alone is not accepted as evidence (R15.13); both checks look at what is imported or accessed.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSourceBundle } from "../src/index.js";
import { JSON_DOC, MD_DOC, ROOT, allowlistJson, allowlistMd, makeRepo, utf8, type MemFs } from "./helpers/bundleFixtures.js";
import { forbiddenAccesses, isForbiddenPath, scan, violations } from "./helpers/importGraph.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/bundleLeak/", import.meta.url));
const ALLOWED_BARE = ["node:crypto"];

describe("static dependency analysis (R1.9)", () => {
  it("the Source_Bundler reaches no forbidden location, stays inside the package, and imports only node:crypto", () => {
    const graph = scan(resolve(SRC, "bundle/index.ts"));
    // The graph is not empty: it contains the bundler, the allowlist parser, the JSON parser, and the shared helpers.
    const names = graph.files.map((f) => f.slice(SRC.length));
    for (const expected of ["bundle/bundler.ts", "bundle/allowlist.ts", "bundle/strictJson.ts", "bundle/types.ts", "citation/verify.ts"]) {
      expect(names).toContain(expected);
    }
    expect(graph.files.every((f) => f.startsWith(SRC))).toBe(true);
    expect(graph.edges.some((e) => e.spec === "node:crypto")).toBe(true);
    expect(violations(graph, SRC, ALLOWED_BARE)).toEqual([]);
  });

  it("positive control: a module that imports a directory named evaluation is reported", () => {
    const graph = scan(resolve(FIXTURES, "entry.ts"));
    expect(graph.files.map((f) => f.slice(FIXTURES.length))).toContain("evaluation/secret.ts");
    const found = violations(graph, FIXTURES, ALLOWED_BARE);
    expect(found.some((v) => v.includes("forbidden location") && v.includes("evaluation"))).toBe(true);
  });

  it("positive control: a non-relative import and a README.md import are reported", () => {
    const found = violations(scan(resolve(FIXTURES, "entryBare.ts")), FIXTURES, ALLOWED_BARE);
    expect(found.some((v) => v.includes("non-relative import node:fs"))).toBe(true);
    expect(found.some((v) => v.includes("README.md"))).toBe(true);
  });

  it("positive control: an import that leaves the package and names .kiro/ and infra/ is reported", () => {
    const found = violations(scan(resolve(FIXTURES, "entryOutside.ts")), FIXTURES, ALLOWED_BARE);
    expect(found.some((v) => v.includes("leaves the package"))).toBe(true);
    expect(found.some((v) => v.includes(".kiro"))).toBe(true);
    expect(found.some((v) => v.includes("infra"))).toBe(true);
  });

  it("the forbidden-location predicate recognizes every location of R1.9", () => {
    for (const p of ["evaluation/ground-truth/x.json", "tests/legacy-sample/t.ps1", ".kiro/steering/tech.md", "infra/docker-compose.yml", "README.md", "legacy/README.md", "a/readme.md"]) {
      expect(isForbiddenPath(p), p).toBe(true);
    }
    for (const p of ["legacy/src/index.php", "legacy/sql/schema.sql", "docs/ai-input-allowlist.md", "legacy/src/tests.php"]) {
      expect(isForbiddenPath(p), p).toBe(false);
    }
  });
});

const DECOYS = [
  "evaluation/ground-truth/ground-truth.json",
  "evaluation/review/ground-truth-review.md",
  "tests/legacy-sample/lib/ai-input-builder.ps1",
  ".kiro/steering/tech.md",
  "infra/docker-compose.yml",
  "README.md",
  "legacy/README.md",
  "legacy/src/.htaccess",
  ".env",
];
const LISTED = ["legacy/src/alpha.php", "legacy/src/beta.php", "legacy/sql/gamma.sql"];

function repoWithDecoys(listed: readonly string[], jsonText?: string, mdText?: string): MemFs {
  return makeRepo(listed, {
    jsonText,
    mdText,
    mutate: (m) => {
      for (const d of DECOYS) m.set(`${ROOT}/${d}`, { kind: "file", bytes: utf8("decoy") });
    },
  });
}

describe("attempted-read check (R1.9)", () => {
  it("a build touches only the allowlist documents, the listed files, and their parent directories", async () => {
    const fs = repoWithDecoys(LISTED);
    const r = await buildSourceBundle(fs, ROOT, JSON_DOC, MD_DOC);
    expect(r.ok).toBe(true);
    expect(forbiddenAccesses(fs.paths(), ROOT)).toEqual([]);
    const allowed = new Set([`${ROOT}/${JSON_DOC}`, `${ROOT}/${MD_DOC}`, `${ROOT}/legacy`, `${ROOT}/legacy/src`, `${ROOT}/legacy/sql`, ...LISTED.map((e) => `${ROOT}/${e}`)]);
    expect(fs.paths().filter((p) => !allowed.has(p))).toEqual([]);
    // The decoys were present and could have been read.
    for (const d of DECOYS) expect(fs.entries.has(`${ROOT}/${d}`)).toBe(true);
  });

  it("an allowlist that names a forbidden location is refused and the location is never accessed", async () => {
    for (const d of DECOYS.filter((x) => x !== ".env")) {
      const fs = repoWithDecoys(LISTED, allowlistJson([...LISTED, d]), allowlistMd([...LISTED, d]));
      const r = await buildSourceBundle(fs, ROOT, JSON_DOC, MD_DOC);
      expect(r.ok, d).toBe(false);
      if (!r.ok) expect(r.error.path, d).toBe(d);
      expect(fs.paths().filter((p) => p !== `${ROOT}/${JSON_DOC}`), d).toEqual([]);
    }
  });

  it("positive control: a reader that touches a forbidden location is detected by the same check", async () => {
    const fs = repoWithDecoys(LISTED);
    await fs.readFile(`${ROOT}/evaluation/ground-truth/ground-truth.json`);
    await fs.lstat(`${ROOT}/README.md`);
    const found = forbiddenAccesses(fs.paths(), ROOT);
    expect(found).toContain(`${ROOT}/evaluation/ground-truth/ground-truth.json`);
    expect(found).toContain(`${ROOT}/README.md`);
    const leaky = repoWithDecoys(LISTED);
    await leaky.readFile(`${ROOT}/.env`);
    expect(forbiddenAccesses(leaky.paths(), ROOT)).toEqual([`${ROOT}/.env`]);
  });
});