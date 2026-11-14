// Isolation of the masking and the Comparator (task 2.12; R15.1, R15.7; design "Masking decisions", C2-2 and C2-6).
// The modules reachable from the compare entry point do no I/O and import nothing from evaluation/, tests/, .kiro/,
// infra/, or a README.md; the only non-relative import is node:crypto (for the hash). A positive control shows the
// check can see a violation. This is a static check of what is imported; the Comparator has no file access at all.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scan, violations } from "./helpers/importGraph.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/compareLeak/", import.meta.url));
const ALLOWED_BARE = ["node:crypto"];

describe("the masking and the Comparator have no route to the Ground_Truth or to any file", () => {
  it("reach no forbidden location, stay inside the package, and import only node:crypto", () => {
    const graph = scan(resolve(SRC, "compare/index.ts"));
    const names = graph.files.map((f) => f.slice(SRC.length));
    for (const expected of ["compare/compare.ts", "compare/mask.ts", "compare/maskNote.ts", "compare/path.ts", "compare/types.ts"]) expect(names).toContain(expected);
    expect(graph.files.every((f) => f.startsWith(SRC))).toBe(true);
    expect(graph.edges.some((e) => e.spec === "node:crypto")).toBe(true);
    expect(violations(graph, SRC, ALLOWED_BARE)).toEqual([]);
  });

  it("positive control: a module that imports a directory named evaluation is reported", () => {
    const found = violations(scan(resolve(FIXTURES, "entry.ts")), FIXTURES, ALLOWED_BARE);
    expect(found.some((v) => v.includes("forbidden location") && v.includes("evaluation"))).toBe(true);
  });

  it("positive control: a node:fs import is reported", () => {
    const found = violations(scan(resolve(FIXTURES, "entryBare.ts")), FIXTURES, ALLOWED_BARE);
    expect(found.some((v) => v.includes("non-relative import node:fs"))).toBe(true);
  });
});