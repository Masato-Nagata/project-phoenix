// Source_Bundler unit tests (task 2.1; R1.1 to R1.8). Neutral fixtures only.
// Expected values are written by hand or computed by the independent oracle of the fixtures, not by the code under test.
import { describe, expect, it } from "vitest";
import {
  buildSourceBundle,
  compareAllowlists,
  findDuplicate,
  parseAllowlistJson,
  parseAllowlistTable,
  parseStrictJson,
  renderBundleText,
  serializeManifest,
  validateEntryForm,
  verifyManifest,
  type BundleErrorCode,
} from "../src/index.js";
import {
  HASH_RULE,
  JSON_DOC,
  MD_DOC,
  ROOT,
  allowlistJson,
  allowlistMd,
  makeRepo,
  oracleBundleText,
  oracleHash,
  oracleManifestText,
  utf8,
} from "./helpers/bundleFixtures.js";

const A = "legacy/src/alpha.php";
const B = "legacy/src/beta.php";
const S = "legacy/sql/gamma.sql";
const LISTED = [A, B, S];

async function build(fs: ReturnType<typeof makeRepo>) {
  return buildSourceBundle(fs, ROOT, JSON_DOC, MD_DOC);
}

async function expectError(fs: ReturnType<typeof makeRepo>, code: BundleErrorCode, path?: string) {
  const r = await build(fs);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.code).toBe(code);
  if (path !== undefined) expect(r.error.path).toBe(path);
  expect(Object.keys(r)).toEqual(["ok", "error"]); // no bundle, no manifest
  expect(r.error.detail.length).toBeGreaterThan(0);
  expect(JSON.stringify(r.error)).not.toContain(ROOT); // no host path
}

describe("buildSourceBundle: success (R1.1, R1.2, R1.6, R1.7, R1.8)", () => {
  it("reads exactly the listed files in the listed order and writes a manifest equal to the allowlist", async () => {
    const texts = { [A]: "a1\na2\n", [B]: "b1\n", [S]: "s1\n" };
    const fs = makeRepo(LISTED, { texts });
    const r = await build(fs);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.manifest.map((m) => m.path)).toEqual(LISTED);
    expect(r.value.files.map((f) => f.path)).toEqual(LISTED);
    expect(r.value.manifest.map((m) => m.sha256Lf)).toEqual(LISTED.map((p) => oracleHash(texts[p as keyof typeof texts])));
    // Only the two documents, the parent directories and the three listed files were touched.
    expect(new Set(fs.paths())).toEqual(
      new Set([
        `${ROOT}/${JSON_DOC}`, `${ROOT}/${MD_DOC}`, `${ROOT}/legacy`, `${ROOT}/legacy/src`, `${ROOT}/legacy/sql`,
        `${ROOT}/${A}`, `${ROOT}/${B}`, `${ROOT}/${S}`,
      ]),
    );
  });

  it("serializes the manifest as canonical JSON with no host path, time, or size, and renders the bundle text", async () => {
    const texts = { [A]: "a\r\nb\r", [B]: "", [S]: "x" };
    const r = await build(makeRepo(LISTED, { texts }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const files = LISTED.map((p) => ({ path: p, text: texts[p as keyof typeof texts] }));
    expect(new TextDecoder().decode(serializeManifest(r.value.manifest))).toBe(oracleManifestText(files));
    expect(oracleManifestText(files)).toContain(HASH_RULE);
    expect(renderBundleText(r.value)).toBe(oracleBundleText(files));
  });

  it("normalizes CRLF, lone CR and LF to the same hash, and keeps the byte-order mark (R1.6, R5.7)", async () => {
    const forms = ["a\nb\nc", "a\r\nb\r\nc", "a\rb\rc", "a\r\nb\rc"];
    const hashes: string[] = [];
    for (const f of forms) {
      const r = await build(makeRepo([A], { texts: { [A]: f } }));
      expect(r.ok).toBe(true);
      if (r.ok) {
        hashes.push(r.value.manifest[0]?.sha256Lf ?? "");
        expect(r.value.files[0]?.text).toBe("a\nb\nc");
      }
    }
    expect(new Set(hashes).size).toBe(1);
    const withBom = await build(makeRepo([A], { texts: { [A]: new Uint8Array([0xef, 0xbb, 0xbf, 0x61]) } }));
    const without = await build(makeRepo([A], { texts: { [A]: "a" } }));
    expect(withBom.ok && without.ok).toBe(true);
    if (withBom.ok && without.ok) {
      expect(withBom.value.files[0]?.text).toBe("\uFEFFa");
      expect(withBom.value.manifest[0]?.sha256Lf).not.toBe(without.value.manifest[0]?.sha256Lf);
    }
  });

  it("ignores the description fields of the allowlist and a matching row outside the table (C5-1, C5-2)", async () => {
    const md = allowlistMd(LISTED, { after: `| \`${A}\` | row outside the table |` });
    const r = await build(makeRepo(LISTED, { mdText: md }));
    expect(r.ok).toBe(true);
  });

  it("gives byte-identical output for identical input and for another root path (R1.8)", async () => {
    const r1 = await build(makeRepo(LISTED));
    const r2 = await buildSourceBundle(makeRepo(LISTED), ROOT, JSON_DOC, MD_DOC);
    expect(r1.ok && r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(serializeManifest(r1.value.manifest)).toEqual(serializeManifest(r2.value.manifest));
      expect(renderBundleText(r1.value)).toBe(renderBundleText(r2.value));
    }
  });
});

describe("allowlist JSON (R1.4, C5-1)", () => {
  it("accepts a valid document and returns the entries in order", () => {
    const r = parseAllowlistJson(allowlistJson(LISTED));
    expect(r).toEqual({ ok: true, value: LISTED });
  });

  const bad: [string, string, BundleErrorCode][] = [
    ["empty text", "", "allowlist_invalid_json"],
    ["truncated", '{"schema_version":1,"files":[', "allowlist_invalid_json"],
    ["text after the value", '{"schema_version":1,"files":["a"]} x', "allowlist_invalid_json"],
    ["a byte-order mark", "\uFEFF" + allowlistJson(LISTED), "allowlist_invalid_json"],
    ["a duplicate key", '{"schema_version":1,"files":["a"],"files":["b"]}', "allowlist_invalid_json"],
    ["an array", "[]", "allowlist_invalid_json"],
    ["a string", '"x"', "allowlist_invalid_json"],
    ["null", "null", "allowlist_invalid_json"],
    ["a trailing comma", '{"schema_version":1,"files":["a",]}', "allowlist_invalid_json"],
    ["a control character in a string", '{"schema_version":1,"files":["a\u0001"]}', "allowlist_invalid_json"],
    ["an unknown key", allowlistJson(LISTED, { extra: 1 }), "allowlist_unknown_field"],
    ["schema_version 2", allowlistJson(LISTED, { schema_version: 2 }), "allowlist_unsupported_version"],
    ["schema_version as a string", allowlistJson(LISTED, { schema_version: "1" }), "allowlist_unsupported_version"],
    ["schema_version missing", '{"files":["a"]}', "allowlist_unsupported_version"],
    ["files missing", '{"schema_version":1}', "allowlist_no_files"],
    ["files empty", allowlistJson([]), "allowlist_no_files"],
    ["files not a list", allowlistJson(LISTED, { files: "x" }), "allowlist_no_files"],
    ["a number entry", allowlistJson([A, 5]), "allowlist_entry_not_string"],
    ["a null entry", allowlistJson([A, null]), "allowlist_entry_not_string"],
    ["an object entry", allowlistJson([A, { path: B }]), "allowlist_entry_not_string"],
  ];
  for (const [name, text, code] of bad) {
    it(`rejects ${name} with ${code}`, () => {
      const r = parseAllowlistJson(text);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe(code);
    });
  }

  it("strict JSON: valid documents parse, escapes work, and depth is limited", () => {
    expect(parseStrictJson('{"a":[1,-2.5e1,"\\u0041\\n",true,false,null]}')).toEqual({ ok: true, value: { a: [1, -25, "A\n", true, false, null] } });
    expect(parseStrictJson("[".repeat(40) + "]".repeat(40)).ok).toBe(false);
    expect(parseStrictJson('{"a":01}').ok).toBe(false);
    expect(parseStrictJson("{'a':1}").ok).toBe(false);
  });
});

describe("entry form and duplicates (R1.3, C5-3, C5-7)", () => {
  const forms: [string, BundleErrorCode][] = [
    ["/legacy/src/a.php", "entry_absolute"],
    ["\\legacy\\src\\a.php", "entry_absolute"],
    ["C:/legacy/src/a.php", "entry_absolute"],
    ["~/legacy/src/a.php", "entry_absolute"],
    ["legacy/src/../src/a.php", "entry_traversal"],
    ["../legacy/src/a.php", "entry_traversal"],
    ["legacy/src/..\\a.php", "entry_traversal"],
    ["legacy//src/a.php", "entry_traversal"],
    ["legacy/./src/a.php", "entry_traversal"],
    ["legacy/src/", "entry_traversal"],
    ["legacy\\src\\a.php", "entry_shape"],
    ["legacy/src/*.php", "entry_shape"],
    ["legacy/src/a?.php", "entry_shape"],
    ["legacy/src/[ab].php", "entry_shape"],
    ["legacy/src/{a,b}.php", "entry_shape"],
    [" legacy/src/a.php", "entry_shape"],
    ["legacy/src/a.php ", "entry_shape"],
    ["", "entry_shape"],
    ["legacy/src/sub/a.php", "entry_shape"],
    ["legacy/src/a.txt", "entry_shape"],
    ["legacy/src/a.PHP", "entry_shape"],
    ["legacy/src/a-b.php", "entry_shape"],
    ["legacy/sql/a.php", "entry_shape"],
    ["legacy/src", "entry_shape"],
    ["README.md", "entry_shape"],
    ["legacy/README.md", "entry_shape"],
    ["evaluation/ground-truth/a.php", "entry_shape"],
    ["tests/legacy-sample/a.php", "entry_shape"],
    [".kiro/specs/a.php", "entry_shape"],
    ["infra/a.php", "entry_shape"],
  ];
  for (const [entry, code] of forms) {
    it(`rejects ${JSON.stringify(entry)} with ${code}`, () => {
      expect(validateEntryForm(entry)?.code).toBe(code);
    });
  }

  it("accepts the form of the seven real entries", () => {
    for (const e of ["legacy/src/index.php", "legacy/src/db.php", "legacy/sql/schema.sql", "legacy/sql/seed.sql", "legacy/src/utils_2.php"]) {
      expect(validateEntryForm(e)).toBeUndefined();
    }
  });

  it("detects exact and case-only duplicates and names the later entry", () => {
    expect(findDuplicate([A, B, S])).toBeUndefined();
    expect(findDuplicate([A, B, A])).toMatchObject({ code: "entry_duplicate", path: A });
    expect(findDuplicate([A, "legacy/src/ALPHA.php"])).toMatchObject({ code: "entry_duplicate", path: "legacy/src/ALPHA.php" });
  });

  it("stops before any listed file is touched", async () => {
    const fs = makeRepo([A, B], { jsonText: allowlistJson([A, "legacy/src/sub/x.php", B]) });
    await expectError(fs, "entry_shape", "legacy/src/sub/x.php");
    expect(fs.paths().filter((p) => p.includes("/legacy/"))).toEqual([]);
  });
});

describe("Markdown table (R1.5, C5-2)", () => {
  const table = (rows: string[]) => ["### Allowed (x)", "", "| File | Reason |", "|---|---|", ...rows, "", "### Not allowed"].join("\n");

  it("reads the rows of the table in order", () => {
    expect(parseAllowlistTable(allowlistMd(LISTED))).toEqual({ ok: true, value: LISTED });
    expect(parseAllowlistTable(allowlistMd(LISTED, { eol: "\r\n" }))).toEqual({ ok: true, value: LISTED });
    expect(parseAllowlistTable(table(["| `a` | r |", "| `b` | r |"]))).toEqual({ ok: true, value: ["a", "b"] });
  });

  const bad: [string, string][] = [
    ["no heading", "| File | Reason |\n|---|---|\n| `a` | r |\n"],
    ["two headings", table(["| `a` | r |"]) + "\n### Allowed again\n\n| File | Reason |\n|---|---|\n| `a` | r |\n"],
    ["a wrong header row", ["### Allowed", "", "| Path | Reason |", "|---|---|", "| `a` | r |"].join("\n")],
    ["a header with three columns", ["### Allowed", "", "| File | Reason | X |", "|---|---|---|", "| `a` | r | x |"].join("\n")],
    ["a missing separator", ["### Allowed", "", "| File | Reason |", "| `a` | r |"].join("\n")],
    ["a separator with text", ["### Allowed", "", "| File | Reason |", "|abc|---|", "| `a` | r |"].join("\n")],
    ["a row with three cells", table(["| `a` | r | x |"])],
    ["a row with one cell", table(["| `a` |"])],
    ["a row that does not end with a bar", table(["| `a` | r"])],
    ["a path without backticks", table(["| a | r |"])],
    ["a code span with other text", table(["| see `a` | r |"])],
    ["an empty code span", table(["| `` | r |"])],
    ["an empty second cell", table(["| `a` |  |"])],
    ["no data row", table([])],
    ["text between heading and table", ["### Allowed", "", "Some text.", "| File | Reason |", "|---|---|", "| `a` | r |"].join("\n")],
  ];
  for (const [name, md] of bad) {
    it(`rejects ${name} with allowlist_md_mismatch`, () => {
      const r = parseAllowlistTable(md);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("allowlist_md_mismatch");
    });
  }

  it("ends the table at the first line that does not start with a bar", () => {
    const md = ["### Allowed", "", "| File | Reason |", "|---|---|", "| `a` | r |", "", "| `b` | r |"].join("\n");
    expect(parseAllowlistTable(md)).toEqual({ ok: true, value: ["a"] });
  });

  it("names the first difference with the index and both values", () => {
    expect(compareAllowlists([A, B], [A, B])).toBeUndefined();
    expect(compareAllowlists([A, B], [B, A])?.detail).toContain("index 0");
    expect(compareAllowlists([A, B], [A])?.detail).toContain("index 1");
    expect(compareAllowlists([A], [A, B])?.detail).toContain("json=missing");
    expect(compareAllowlists([A, B], [A, S])?.detail).toContain(JSON.stringify(B));
  });

  it("stops the build on a difference of set or order, before any listed file is read", async () => {
    for (const mdEntries of [[B, A, S], [A, B], [A, B, S, "legacy/src/extra.php"], [A, B, "legacy/sql/other.sql"]]) {
      const fs = makeRepo(LISTED, { mdText: allowlistMd(mdEntries) });
      await expectError(fs, "allowlist_md_mismatch");
      expect(fs.paths().filter((p) => p.includes("/legacy/"))).toEqual([]);
    }
  });
});

describe("buildSourceBundle: failures leave no bundle and no manifest (R1.3, R1.4)", () => {
  it("reports a missing allowlist document and a document that is not valid text", async () => {
    await expectError(makeRepo(LISTED, { mutate: (m) => m.delete(`${ROOT}/${JSON_DOC}`) }), "allowlist_missing", JSON_DOC);
    await expectError(makeRepo(LISTED, { mutate: (m) => m.delete(`${ROOT}/${MD_DOC}`) }), "allowlist_missing", MD_DOC);
    await expectError(makeRepo(LISTED, { mutate: (m) => { const e = m.get(`${ROOT}/${JSON_DOC}`); if (e) e.unreadable = true; } }), "allowlist_missing", JSON_DOC);
    await expectError(makeRepo(LISTED, { mdText: new Uint8Array([0xff, 0xfe, 0x41]) }), "allowlist_md_mismatch", MD_DOC);
    await expectError(makeRepo(LISTED, { jsonText: undefined, mutate: (m) => m.set(`${ROOT}/${JSON_DOC}`, { kind: "file", bytes: new Uint8Array([0xff]) }) }), "allowlist_invalid_json", JSON_DOC);
  });

  it("reports a missing file, a directory, a link, a hard link, an unreadable file, and a special file", async () => {
    await expectError(makeRepo(LISTED, { mutate: (m) => m.delete(`${ROOT}/${B}`) }), "entry_missing", B);
    await expectError(makeRepo(LISTED, { mutate: (m) => m.set(`${ROOT}/${B}`, { kind: "dir" }) }), "entry_directory", B);
    await expectError(makeRepo(LISTED, { mutate: (m) => m.set(`${ROOT}/${B}`, { kind: "symlink" }) }), "entry_link", B);
    await expectError(makeRepo(LISTED, { mutate: (m) => m.set(`${ROOT}/legacy/src`, { kind: "symlink" }) }), "entry_link", A);
    await expectError(makeRepo(LISTED, { mutate: (m) => { const e = m.get(`${ROOT}/${B}`); if (e) e.nlink = 2; } }), "entry_link", B);
    await expectError(makeRepo(LISTED, { mutate: (m) => { const e = m.get(`${ROOT}/${B}`); if (e) e.unreadable = true; } }), "entry_unreadable", B);
    await expectError(makeRepo(LISTED, { mutate: (m) => m.set(`${ROOT}/${B}`, { kind: "other" }) }), "entry_unreadable", B);
    await expectError(makeRepo(LISTED, { mutate: (m) => m.delete(`${ROOT}/legacy/sql`) }), "entry_missing", S);
  });

  it("reports invalid UTF-8 in a listed file (the byte-order mark alone is fine)", async () => {
    await expectError(makeRepo(LISTED, { texts: { [B]: new Uint8Array([0x61, 0xc3, 0x28]) } }), "entry_not_utf8", B);
    await expectError(makeRepo(LISTED, { texts: { [B]: new Uint8Array([0xff]) } }), "entry_not_utf8", B);
    const ok = await build(makeRepo(LISTED, { texts: { [B]: "caf\u00e9 \u{1F600}\n" } }));
    expect(ok.ok).toBe(true);
  });

  it("reports the first defect in the listed order", async () => {
    const fs = makeRepo(LISTED, { mutate: (m) => { m.delete(`${ROOT}/${B}`); m.set(`${ROOT}/${S}`, { kind: "symlink" }); } });
    await expectError(fs, "entry_missing", B);
    expect(fs.paths()).not.toContain(`${ROOT}/${S}`);
  });
});

describe("verifyManifest (R1.7)", () => {
  const m = (paths: string[]) => paths.map((path) => ({ path, sha256Lf: "0".repeat(64) }));
  it("accepts an equal list and refuses an extra, a missing, a reordered, or a different entry", () => {
    expect(verifyManifest(LISTED, m(LISTED))).toBeUndefined();
    for (const bad of [m([A, B]), m([A, B, S, "legacy/sql/x.sql"]), m([B, A, S]), m([A, B, "legacy/sql/other.sql"])]) {
      expect(verifyManifest(LISTED, bad)?.code).toBe("manifest_mismatch");
    }
  });
});