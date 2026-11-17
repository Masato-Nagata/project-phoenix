// Task 4.2: the run-time `import_analysis` scanner on in-memory fixtures (design item 7). Synthetic sources only.
// The scanner is a self-attestation of the bundle; these tests show its logic, not that a real `dist/` is clean (UNVERIFIED until 4.9/4.11).
// **Validates: Requirements 15.1, 15.7, 15.13**
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import { importScanSelfCheck, isForbiddenSpecifier, scanBundle } from "../src/isolation/importScan.js";

const scan = (text: string, rel = "dist/f.js") => scanBundle([{ rel, text }]);
const kinds = (text: string, rel?: string): string[] => scan(text, rel).findings.map((f) => `${f.code}:${f.kind}`);

describe("supported syntax is classified and gives no finding", () => {
  const supported: [string, string][] = [
    ["default import", 'import a from "x";'],
    ["named import with alias", "import { a as b, c } from 'x';"],
    ["namespace import", 'import * as ns from "x";'],
    ["default and named", 'import d, { a } from "x";'],
    ["a binding named from", 'import { from } from "x";'],
    ["side-effect import", 'import "x";'],
    ["export from", 'export { a } from "x";'],
    ["export star", 'export * from "x";'],
    ["export star as", 'export * as n from "x";'],
    ["local export (no specifier)", "const a = 1; export { a };"],
    ["dynamic import with a literal", 'const m = import("x");'],
    ["dynamic import with a plain template", "const m = import(`./x.js`);"],
    ["require with a literal", 'const m = require("x");'],
    ["import.meta.url", "const u = import.meta.url;"],
    ["hashbang", '#!/usr/bin/env node\nimport "./x.js";'],
  ];
  for (const [name, src] of supported) {
    it(name, () => {
      expect(kinds(src)).toEqual([]);
    });
  }
  it("counts specifiers and bare specifiers", () => {
    const r = scan('import a from "./a.js"; import b from "node:fs"; import c from "ajv"; const d = require("/abs/x.js");');
    expect(r.specifierCount).toBe(4);
    expect(r.bareSpecifierCount).toBe(2);
  });
  it("text inside strings, comments, templates and regular expressions is not syntax", () => {
    const src = [
      "const s = \"import('x' + y) and eval(1) and require(z)\";",
      "// eval(1); require(zz)",
      "/* import(q) */ const t = `eval(${a}) ${\"}\"} ${`nested ${b}`}`;",
      'const r = /["\'`]\\/(\\d)/g;',
      "const q = a / b / c;",
      "let n = x++ / 2;",
      "const ok = (() => { return /re/.test(s); })();",
    ].join("\n");
    expect(kinds(src)).toEqual([]);
  });
});

describe("unsupported syntax fails (unclassified_syntax)", () => {
  const unsupported: [string, string, string][] = [
    ["computed dynamic import", "const m = import(x);", "non_literal_specifier"],
    ["concatenated dynamic import", 'const m = import("a" + b);', "non_literal_specifier"],
    ["template with substitution", "const m = import(`a${b}`);", "non_literal_specifier"],
    ["dynamic import with two arguments", 'const m = import("a", { with: {} });', "non_literal_specifier"],
    ["require with a variable", "const m = require(x);", "require_other_use"],
    ["require alias", "const r = require;", "require_other_use"],
    ["module.require", 'module.require("x");', "require_other_use"],
    ["require.resolve", 'require.resolve("x");', "require_other_use"],
    ["createRequire", "const r = createRequire(u);", "create_require"],
    ["eval", "eval(code);", "eval"],
    ["new Function", 'const f = new Function("return 1");', "function_constructor"],
    ["Function call", 'const f = Function("return 1");', "function_constructor"],
    ["import.meta.resolve", 'const u = import.meta.resolve("x");', "import_meta_resolve"],
    ["process.dlopen", "process.dlopen(m, f);", "process_dlopen"],
    ["process.binding", 'process.binding("fs");', "process_binding"],
    ["process computed member", 'process["bind" + "ing"]("fs");', "process_binding"],
    ["unterminated string", 'const a = "abc\nconst b = 1;', "lexical_unterminated"],
    ["unterminated template", "const a = `abc ${b}", "lexical_unterminated"],
    ["unterminated comment", "/* abc", "lexical_unterminated"],
    ["unterminated regular expression", "const r = /abc\n;", "lexical_unterminated"],
    ["invalid UTF-8 (replacement character)", 'const a = "\uFFFD";', "invalid_utf8"],
    ["escaped identifier", "\\u0065val(1);", "identifier_escape"],
    ["escaped specifier", 'import a from "\\u0078";', "escaped_specifier"],
    ["import without a from clause", "import x;", "unrecognized_import_form"],
    ["export star without from", "export * foo;", "unrecognized_export_form"],
  ];
  for (const [name, src, kind] of unsupported) {
    it(name, () => {
      expect(kinds(src)).toContain(`unclassified_syntax:${kind}`);
    });
  }
  it("executable artifacts and unknown file types fail; data files are not parsed", () => {
    const r = scanBundle([
      { rel: "dist/a.node", text: "" },
      { rel: "dist/b.WASM", text: "" },
      { rel: "dist/c.txt", text: "x" },
      { rel: "dist/d.json", text: "eval(" },
      { rel: "dist/e.d.ts", text: "eval(" },
      { rel: "dist/f.js.map", text: "eval(" },
      { rel: "dist/.tsbuildinfo", text: "eval(" },
      { rel: "dist/g.mjs", text: "eval(1);" },
      { rel: "dist/h.cjs", text: "eval(1);" },
      { rel: "dist/I.JS", text: "eval(1);" },
    ]);
    expect(r.findings.map((f) => `${f.file}:${f.kind}`).sort()).toEqual(
      ["dist/I.JS:eval", "dist/a.node:executable_artifact", "dist/b.WASM:executable_artifact", "dist/c.txt:unknown_file_type", "dist/g.mjs:eval", "dist/h.cjs:eval"].sort(),
    );
    expect(r.filesScanned).toBe(3);
  });
});

describe("forbidden reach (forbidden_import)", () => {
  it("flags an evaluation path segment, the evaluator package, relative resolution and case differences", () => {
    expect(kinds('import x from "../../evaluation/a.js";', "dist/a/b.js")).toEqual(["forbidden_import:forbidden_specifier"]);
    expect(kinds('const m = require("evaluation/x");')).toEqual(["forbidden_import:forbidden_specifier"]);
    expect(kinds('const m = import("@phoenix/evaluation/x");')).toEqual(["forbidden_import:forbidden_specifier"]);
    expect(kinds('import "spec-restoration-evaluator";')).toEqual(["forbidden_import:forbidden_specifier"]);
    expect(kinds('import "file:///repo/Evaluation/x.js";')).toEqual(["forbidden_import:forbidden_specifier"]);
    // a specifier with a backslash is not a plain literal: it fails as unclassified (fail-closed), it is not silently accepted
    expect(kinds('export * from "..\\\\evaluation\\\\x.js";')).toEqual(["unclassified_syntax:escaped_specifier"]);
    // a file that lives under an evaluation path reaches it through a relative import
    expect(kinds('import "./y.js";', "evaluation/lib/x.js")).toEqual(["forbidden_import:forbidden_specifier"]);
  });
  it("passing controls: near names and ordinary imports pass", () => {
    for (const s of ["./evaluator.js", "./evaluations/x.js", "./evaluation-x.js", "../shared/y.js", "node:fs", "ajv"]) {
      expect(isForbiddenSpecifier("dist/a.js", s), s).toBe(false);
    }
    expect(kinds('import "./evaluator.js"; import "ajv";')).toEqual([]);
  });
  it("positive control: a fixture file that imports an evaluation module is reported in a clean tree", () => {
    const clean = [
      { rel: "dist/a.js", text: 'import { b } from "./b.js"; export const a = b;' },
      { rel: "dist/b.js", text: "export const b = 1;" },
    ];
    expect(scanBundle(clean).findings).toEqual([]);
    const withFixture = [...clean, { rel: "dist/fixture.js", text: 'import g from "../evaluation/ground-truth/ground-truth.json";' }];
    expect(scanBundle(withFixture).findings).toEqual([{ file: "dist/fixture.js", code: "forbidden_import", kind: "forbidden_specifier" }]);
  });
});

describe("built-in self check and determinism", () => {
  it("passes", () => {
    expect(importScanSelfCheck()).toBe(true);
  });
  it("the text hash does not depend on the file order", () => {
    const f = [
      { rel: "dist/a.js", text: "export const a = 1;" },
      { rel: "dist/b.js", text: "export const b = 2;" },
    ];
    expect(scanBundle(f).textSha256).toBe(scanBundle([...f].reverse()).textSha256);
    expect(scanBundle(f).textSha256).not.toBe(scanBundle([f[0] as (typeof f)[0], { rel: "dist/b.js", text: "export const b = 3;" }]).textSha256);
  });
  it("property: a source made of plain declarations and literal imports gives no finding, and adding one eval always gives one", () => {
    // the index suffix keeps every binding name a valid non-keyword identifier; the module name is only text inside a string
    const ident = fc.stringMatching(/^[a-z][a-z0-9]{0,6}$/);
    fc.assert(
      fc.property(fc.array(fc.tuple(ident, ident), { minLength: 1, maxLength: 8 }), (pairs) => {
        const src = pairs.map(([a, b], i) => `import { ${a}${i} } from "./${b}.js";\nexport const v${i} = ${a}${i};`).join("\n");
        expect(scan(src).findings).toEqual([]);
        expect(scan(`${src}\neval(1);`).findings.map((f) => f.kind)).toEqual(["eval"]);
      }),
      { numRuns: 100, seed: 4202 },
    );
  });
});
