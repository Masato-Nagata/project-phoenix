// Task 4.6 W1: Run_Manifest `sourceBundle` section builder.
// Source: M1 schema `source-bundle-manifest`; decisions D1 (schema authoritative) and D2 (refuse, never default).
import { describe, expect, it } from "vitest";
import { MANIFEST_HASH_RULE, serializeManifest, sha256OfNormalized } from "../../analyzer/src/bundle/index.js";
import { SCHEMAS } from "../src/index.js";
import { createSchemaValidator } from "../src/schema/index.js";
import {
  SOURCE_BUNDLE_HASH_RULE,
  SOURCE_BUNDLE_SCHEMA_VERSION,
  buildSourceBundleSection,
} from "../src/manifest/sourceBundleSection.js";

const H = (c: string): string => c.repeat(64);
const good = (): { path: string; sha256Lf: string }[] => [
  { path: "src/widgets.php", sha256Lf: H("a") },
  { path: "docs/README.md", sha256Lf: H("b") },
];
const code = (v: unknown): string | undefined => {
  const r = buildSourceBundleSection(v);
  return r.ok ? undefined : r.error.code;
};
const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) {
    Object.values(v).forEach(deepFreeze);
    Object.freeze(v);
  }
  return v;
};

describe("constants", () => {
  it("equal the schema constants and the analyzer", () => {
    const schema = SCHEMAS["source-bundle-manifest"] as unknown as { properties: { schemaVersion: { const: unknown }; hashRule: { const: unknown } } };
    expect(SOURCE_BUNDLE_SCHEMA_VERSION).toBe(schema.properties.schemaVersion.const);
    expect(SOURCE_BUNDLE_HASH_RULE).toBe(schema.properties.hashRule.const);
    expect(SOURCE_BUNDLE_HASH_RULE).toBe(MANIFEST_HASH_RULE);
    const doc = JSON.parse(new TextDecoder().decode(serializeManifest([{ path: "a.php", sha256Lf: H("c") }]))) as { schemaVersion: unknown };
    expect(SOURCE_BUNDLE_SCHEMA_VERSION).toBe(doc.schemaVersion);
  });
});

describe("valid input", () => {
  it("validates against the M1 schema source-bundle-manifest and copies the files exactly in order", () => {
    const input = good();
    const r = buildSourceBundleSection(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(createSchemaValidator().validate("source-bundle-manifest", r.value).ok).toBe(true);
    expect(r.value.files).toEqual(good());
    expect(r.value.schemaVersion).toBe(1);
    expect(r.value.hashRule).toBe(MANIFEST_HASH_RULE);
  });
  it("does not alias the input and does not mutate a deep-frozen input", () => {
    const input = deepFreeze(good());
    const r = buildSourceBundleSection(input);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.files).not.toBe(input);
    r.value.files.forEach((f, i) => expect(f).not.toBe(input[i]));
    expect(input).toEqual(good());
  });
  it("equals the analyzer manifest document and the payload of the source_bundle_manifest record", () => {
    const manifest = ["src/a.php", "src/b.php"].map((p, i) => ({ path: p, sha256Lf: sha256OfNormalized(`text ${i}\n`) }));
    const r = buildSourceBundleSection(manifest);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual(JSON.parse(new TextDecoder().decode(serializeManifest(manifest))));
    // the orchestrator writes `{ files: [{ path, sha256Lf }] }` for the record
    expect(r.value.files).toEqual(manifest.map((m) => ({ path: m.path, sha256Lf: m.sha256Lf })));
  });
});

describe("refusals (a passing control sits in 'valid input')", () => {
  it("list level", () => {
    expect(code(undefined)).toBe("files_not_array");
    expect(code(null)).toBe("files_not_array");
    expect(code({ 0: good()[0], length: 1 })).toBe("files_not_array");
    expect(code("x")).toBe("files_not_array");
    expect(code([])).toBe("files_empty");
    expect(code(good())).toBeUndefined();
  });
  it("entry shape", () => {
    expect(code([null])).toBe("entry_not_plain_object");
    expect(code(["a"])).toBe("entry_not_plain_object");
    expect(code([[]])).toBe("entry_not_plain_object");
    expect(code([Object.create({ path: "a", sha256Lf: H("a") })])).toBe("entry_not_plain_object");
    expect(code([{ get path() { return "a.php"; }, sha256Lf: H("a") }])).toBe("entry_not_plain_object");
    expect(code([new Map()])).toBe("entry_not_plain_object");
    expect(code([{ sha256Lf: H("a") }])).toBe("entry_keys");
    expect(code([{ path: "a.php" }])).toBe("entry_keys");
    expect(code([{ path: "a.php", sha256Lf: H("a"), extra: 1 }])).toBe("entry_keys");
    expect(code([{ path: 1, sha256Lf: H("a") }])).toBe("path_not_string");
    expect(code([{ path: "a.php", sha256Lf: 1 }])).toBe("hash_not_string");
    expect(code([{ path: undefined, sha256Lf: H("a") }])).toBe("path_not_string");
    expect(code([{ path: "a.php", sha256Lf: H("a") }])).toBeUndefined();
  });
  it("path", () => {
    for (const p of ["", "/a.php", "a\\b.php", "./a.php", "../a.php", "a/../b.php", "a/./b.php", "a//b.php", "a/", "a b.php", "a.php\n", "é.php", "a".repeat(257)]) {
      expect(code([{ path: p, sha256Lf: H("a") }]), JSON.stringify(p)).toBe("path_invalid");
    }
    expect(code([{ path: "a".repeat(256), sha256Lf: H("a") }])).toBeUndefined();
    expect(code([{ path: "a/b-c_d.e.php", sha256Lf: H("a") }])).toBeUndefined();
  });
  it("hash", () => {
    for (const h of [H("A"), "a".repeat(63), "a".repeat(65), "g".repeat(64), "", `${H("a")}\n`]) {
      expect(code([{ path: "a.php", sha256Lf: h }]), JSON.stringify(h)).toBe("hash_invalid");
    }
    expect(code([{ path: "a.php", sha256Lf: H("0") }])).toBeUndefined();
  });
  it("duplicate path, also when only the case differs (analyzer rule)", () => {
    expect(code([{ path: "a.php", sha256Lf: H("a") }, { path: "a.php", sha256Lf: H("b") }])).toBe("path_duplicate");
    expect(code([{ path: "a.php", sha256Lf: H("a") }, { path: "A.PHP", sha256Lf: H("b") }])).toBe("path_duplicate");
    expect(code([{ path: "a.php", sha256Lf: H("a") }, { path: "b.php", sha256Lf: H("b") }])).toBeUndefined();
  });
  it("the error carries a closed code and an index, never an input value", () => {
    const r = buildSourceBundleSection([{ path: "secret/../value", sha256Lf: H("a") }]);
    expect(r).toEqual({ ok: false, error: { code: "path_invalid", index: 0 } });
    expect(JSON.stringify(r)).not.toContain("secret");
  });
});
