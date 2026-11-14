// Feature: discovery-loop, Property 2: Source_Bundler fails closed on any invalid allowlist
// **Validates: Requirements 1.3, 1.4, 1.5**
//
// For any allowlist defect (an absolute, traversal, directory, link, hard-link, duplicate, missing, unreadable, or
// malformed entry; a missing, invalid, or empty document; a difference between the JSON and the Markdown table), the
// Source_Bundler returns an error that names the defect and produces no bundle and no manifest. Defects found before
// the files are examined never cause a listed file to be read.
//
// Reproducibility record: SEED = 440002, NUM_RUNS = 300. All generated names are neutral.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildSourceBundle, type BundleErrorCode } from "../src/index.js";
import { JSON_DOC, MD_DOC, ROOT, allowlistJson, allowlistMd, makeRepo, type MemFs } from "./helpers/bundleFixtures.js";

const SEED = 440002;
const NUM_RUNS = 300;
const TIMEOUT_MS = 120_000;

const nameArb = fc.stringMatching(/^[A-Za-z0-9_]{1,10}$/);
const entryArb = fc.oneof(nameArb.map((n) => `legacy/src/${n}.php`), nameArb.map((n) => `legacy/sql/${n}.sql`));
const entriesArb = fc.uniqueArray(entryArb, { minLength: 2, maxLength: 7, selector: (e) => e.toLowerCase() });

interface Defect {
  /** Builds the repository with exactly one defect. */
  build(entries: string[], i: number): MemFs;
  code: BundleErrorCode;
  /** The entry the error must name, or the document path, or undefined when no path is checked. */
  path?(entries: string[], i: number): string | undefined;
  /** True when the defect is found before any listed file is touched. */
  early: boolean;
}

const FORMS: [string, BundleErrorCode][] = [
  ["/legacy/src/a.php", "entry_absolute"], ["C:/legacy/src/a.php", "entry_absolute"], ["~/legacy/src/a.php", "entry_absolute"],
  ["legacy/src/../src/a.php", "entry_traversal"], ["../legacy/src/a.php", "entry_traversal"], ["legacy//src/a.php", "entry_traversal"],
  ["legacy/./src/a.php", "entry_traversal"], ["legacy\\src\\a.php", "entry_shape"], ["legacy/src/*.php", "entry_shape"],
  [" legacy/src/a.php", "entry_shape"], ["", "entry_shape"], ["legacy/src/sub/a.php", "entry_shape"], ["README.md", "entry_shape"],
  ["legacy/README.md", "entry_shape"], ["evaluation/ground-truth/a.php", "entry_shape"], ["tests/legacy-sample/a.php", "entry_shape"],
  [".kiro/specs/a.php", "entry_shape"], ["infra/a.php", "entry_shape"], ["legacy/src/a.txt", "entry_shape"],
];

/** Same entry with the name part in upper case: still of the allowed shape, a duplicate when compared without case. */
const caseVariant = (e: string): string => {
  const m = /^(legacy\/(?:src|sql)\/)([A-Za-z0-9_]+)(\.(?:php|sql))$/.exec(e);
  return m === null ? e : `${m[1] as string}${(m[2] as string).toUpperCase()}${m[3] as string}`;
};

const swapAt = (entries: string[], i: number, v: unknown): unknown[] => entries.map((e, k) => (k === i ? v : e));

const DEFECTS: Record<string, Defect> = {
  jsonMissing: { early: true, code: "allowlist_missing", build: (e) => makeRepo(e, { mutate: (m) => m.delete(`${ROOT}/${JSON_DOC}`) }), path: () => JSON_DOC },
  mdMissing: { early: true, code: "allowlist_missing", build: (e) => makeRepo(e, { mutate: (m) => m.delete(`${ROOT}/${MD_DOC}`) }), path: () => MD_DOC },
  jsonTruncated: {
    early: true, code: "allowlist_invalid_json", path: () => JSON_DOC,
    build: (e, i) => { const full = allowlistJson(e); return makeRepo(e, { jsonText: full.slice(0, i % full.length) }); },
  },
  jsonDuplicateKey: { early: true, code: "allowlist_invalid_json", build: (e) => makeRepo(e, { jsonText: `{"schema_version":1,"files":${JSON.stringify(e)},"files":${JSON.stringify(e)}}` }) },
  jsonNotObject: { early: true, code: "allowlist_invalid_json", build: (e, i) => makeRepo(e, { jsonText: ["[]", "5", "null", '"x"', "true"][i % 5] }) },
  unknownKey: { early: true, code: "allowlist_unknown_field", build: (e, i) => makeRepo(e, { jsonText: allowlistJson(e, { [`extra${i}`]: 1 }) }) },
  badVersion: {
    early: true, code: "allowlist_unsupported_version",
    build: (e, i) => makeRepo(e, { jsonText: [allowlistJson(e, { schema_version: 2 }), allowlistJson(e, { schema_version: "1" }), allowlistJson(e, { schema_version: null }), `{"files":${JSON.stringify(e)}}`][i % 4] }),
  },
  noFiles: {
    early: true, code: "allowlist_no_files",
    build: (e, i) => makeRepo(e, { jsonText: [allowlistJson([]), allowlistJson(e, { files: "x" }), allowlistJson(e, { files: null }), allowlistJson(e, { files: {} }), '{"schema_version":1}'][i % 5] }),
  },
  entryNotString: {
    early: true, code: "allowlist_entry_not_string",
    build: (e, i) => makeRepo(e, { jsonText: allowlistJson(swapAt(e, i % e.length, [5, null, {}, [], true][i % 5])) }),
  },
  entryForm: {
    early: true, code: "entry_shape",
    build: (e, i) => makeRepo(e, { jsonText: allowlistJson(swapAt(e, i % e.length, (FORMS[i % FORMS.length] as [string, string])[0])) }),
  },
  duplicate: {
    early: true, code: "entry_duplicate",
    build: (e, i) => makeRepo(e, { jsonText: allowlistJson([...e, i % 2 === 0 ? (e[i % e.length] as string) : caseVariant(e[i % e.length] as string)]) }),
    path: (e, i) => (i % 2 === 0 ? (e[i % e.length] as string) : caseVariant(e[i % e.length] as string)),
  },
  mdRowRemoved: { early: true, code: "allowlist_md_mismatch", build: (e, i) => makeRepo(e, { mdText: allowlistMd(e.filter((_, k) => k !== i % e.length)) }) },
  mdRowAdded: { early: true, code: "allowlist_md_mismatch", build: (e) => makeRepo(e, { mdText: allowlistMd([...e, "legacy/src/zzz_extra.php"]) }) },
  mdSwapped: {
    early: true, code: "allowlist_md_mismatch",
    build: (e, i) => { const k = i % (e.length - 1); const md = [...e]; [md[k], md[k + 1]] = [md[k + 1] as string, md[k] as string]; return makeRepo(e, { mdText: allowlistMd(md) }); },
  },
  mdNoHeading: { early: true, code: "allowlist_md_mismatch", build: (e) => makeRepo(e, { mdText: allowlistMd(e).replace("### Allowed", "### Permitted") }) },
  mdBadHeader: { early: true, code: "allowlist_md_mismatch", build: (e) => makeRepo(e, { mdText: allowlistMd(e).replace("| File | Reason |", "| Path | Why |") }) },
  mdNoBackticks: { early: true, code: "allowlist_md_mismatch", build: (e) => makeRepo(e, { mdText: allowlistMd(e).replaceAll("`", "") }) },
  fileMissing: { early: false, code: "entry_missing", build: (e, i) => makeRepo(e, { mutate: (m) => m.delete(`${ROOT}/${e[i % e.length]}`) }), path: (e, i) => e[i % e.length] },
  fileIsDir: { early: false, code: "entry_directory", build: (e, i) => makeRepo(e, { mutate: (m) => m.set(`${ROOT}/${e[i % e.length]}`, { kind: "dir" }) }), path: (e, i) => e[i % e.length] },
  fileSymlink: { early: false, code: "entry_link", build: (e, i) => makeRepo(e, { mutate: (m) => m.set(`${ROOT}/${e[i % e.length]}`, { kind: "symlink" }) }), path: (e, i) => e[i % e.length] },
  parentSymlink: {
    early: false, code: "entry_link",
    build: (e, i) => { const t = e[i % e.length] as string; return makeRepo(e, { mutate: (m) => m.set(`${ROOT}/${t.split("/").slice(0, 2).join("/")}`, { kind: "symlink" }) }); },
    path: (e, i) => e.find((x) => x.startsWith((e[i % e.length] as string).split("/").slice(0, 2).join("/"))),
  },
  hardLink: {
    early: false, code: "entry_link",
    build: (e, i) => makeRepo(e, { mutate: (m) => { const x = m.get(`${ROOT}/${e[i % e.length]}`); if (x) x.nlink = 2 + (i % 3); } }),
    path: (e, i) => e[i % e.length],
  },
  fileUnreadable: {
    early: false, code: "entry_unreadable",
    build: (e, i) => makeRepo(e, { mutate: (m) => { const x = m.get(`${ROOT}/${e[i % e.length]}`); if (x) x.unreadable = true; } }),
    path: (e, i) => e[i % e.length],
  },
  fileNotUtf8: {
    early: false, code: "entry_not_utf8",
    build: (e, i) => makeRepo(e, { texts: { [e[i % e.length] as string]: new Uint8Array([0x61, 0xc3, 0x28]) } }),
    path: (e, i) => e[i % e.length],
  },
};

describe(`Property 2: Source_Bundler fails closed on any invalid allowlist (seed ${SEED}, numRuns ${NUM_RUNS})`, () => {
  it("returns only an error that names the defect, and touches no listed file for an early defect", async () => {
    await fc.assert(
      fc.asyncProperty(entriesArb, fc.constantFrom(...Object.keys(DEFECTS)), fc.nat(1000), async (entries, kind, i) => {
        const defect = DEFECTS[kind] as Defect;
        const fs = defect.build(entries, i);
        const r = await buildSourceBundle(fs, ROOT, JSON_DOC, MD_DOC);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(Object.keys(r)).toEqual(["ok", "error"]); // no bundle, no manifest
        // Form defects have their own code per form; every other defect has one fixed code.
        if (kind === "entryForm") {
          const form = FORMS[i % FORMS.length] as [string, BundleErrorCode];
          expect(r.error.code).toBe(form[1]);
        } else {
          expect(r.error.code).toBe(defect.code);
        }
        const expectedPath = defect.path?.(entries, i);
        if (expectedPath !== undefined) expect(r.error.path).toBe(expectedPath);
        expect(r.error.detail.length).toBeGreaterThan(0);
        expect(JSON.stringify(r.error)).not.toContain(ROOT);
        if (defect.early) {
          const touchedListed = fs.paths().filter((p) => entries.some((e) => p === `${ROOT}/${e}`));
          expect(touchedListed).toEqual([]);
        }
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);
});