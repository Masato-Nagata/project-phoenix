// Synthetic inputs of the Audit_Config_Builder tests. Every text is invented. Nothing here is, or is derived from, a real restricted file.
import { BUILDER_DEFAULT_N } from "../../src/auditConfigBuilder.js";
import type { BuildInput, BuilderIo, RunArgs } from "../../src/auditConfigBuilder.js";

export const BUILDER_N = 6;
export const GT_CANARY = "SYNTH-GT-CANARY-0001-xyz";
export const SHARED_SENTENCE = "this shared sentence is also part of the allowed corpus text";

export const GT_TEXT = JSON.stringify({
  canary: GT_CANARY,
  rules: [{ id: "g1", text: "synthetic ground truth rule says tango uniform victor whiskey xray yankee zulu" }, { id: "g2", text: SHARED_SENTENCE }],
});
export const MD_TEXT = "synthetic migration decision text: amber bronze cobalt dahlia ember fennel garnet heather indigo jasper";
export const BASELINE_TEXT = JSON.stringify({
  units: [
    { id: "u1", observed: { body: "observed response words one two three four five six seven eight nine" }, expected: { text: "expected baseline sentence lima mike november oscar papa quebec romeo sierra" } },
    { id: "u2", observed: { body: "another observed response kilo kilo kilo kilo kilo kilo kilo kilo" }, expected: { text: "second expected sentence alpha beta gamma delta epsilon zeta eta theta" } },
  ],
});
export const REVIEW_TEXT = "synthetic review package paragraph: kangaroo koala lemur llama lynx meerkat narwhal ocelot panda";
export const RESULTS_TEXT = "synthetic evaluation results line: quartz rhodium sapphire topaz uranium vanadium wolfram xenon yttrium";

export const CORPUS = [
  { id: "src-utils", text: "<?php\n// fictional allowed helper source with words\n" },
  { id: "instr-revise", text: `fixed instruction text of the tests. ${SHARED_SENTENCE}.` },
  { id: "api-ops", text: "GET /orders POST /orders GET /orders/{id} POST /orders/{id}/cancel" },
];

export const ALLOWLIST_INPUT = ["legacy/src/utils.php", "legacy/src/db.php"];
export const PREFIXES_INPUT = ["synthetic-restricted-area/", "synthetic-approvals/"];

export function counterRandom(start = 1): (chars: number) => string {
  let c = start;
  return (chars) => (c++).toString(16).padStart(chars, "0");
}

export function baseInput(over: Partial<BuildInput> = {}): BuildInput {
  return {
    restricted: [
      { fileId: "ground-truth", kind: "json", content: GT_TEXT, canaryPointers: ["/canary"] },
      { fileId: "migration-decisions", kind: "text", content: MD_TEXT },
      { fileId: "conformance-baseline", kind: "json", content: BASELINE_TEXT, excludeSubtrees: ["/units/*/observed"] },
      { fileId: "review-package", kind: "text", content: REVIEW_TEXT },
      { fileId: "evaluation-results", kind: "text", content: RESULTS_TEXT },
    ],
    corpus: CORPUS,
    allowlist: ALLOWLIST_INPUT,
    restrictedPathPrefixes: PREFIXES_INPUT,
    n: BUILDER_N,
    randomHex: counterRandom(),
    ...over,
  };
}

/** An in-memory file store that records every write. */
export function memoryIo(files: Record<string, string>, random = counterRandom()): BuilderIo & { writes: { path: string; bytes: Uint8Array }[]; reads: string[] } {
  const writes: { path: string; bytes: Uint8Array }[] = [];
  const reads: string[] = [];
  return {
    writes,
    reads,
    readFile: async (path) => {
      reads.push(path);
      const t = files[path];
      if (t === undefined) throw new Error("no such file");
      return new TextEncoder().encode(t);
    },
    writeFile: async (path, bytes) => {
      writes.push({ path, bytes: bytes.slice() });
    },
    randomHex: random,
  };
}

export const SYNTH_FILES: Record<string, string> = {
  "/in/gt.json": GT_TEXT,
  "/in/md.txt": MD_TEXT,
  "/in/baseline.json": BASELINE_TEXT,
  "/in/review.txt": REVIEW_TEXT,
  "/in/results.txt": RESULTS_TEXT,
  "/in/src.txt": CORPUS[0]?.text as string,
  "/in/instr.txt": CORPUS[1]?.text as string,
  "/in/ops.txt": CORPUS[2]?.text as string,
};
export const SYNTH_ARGS: RunArgs = {
  restricted: [
    { fileId: "ground-truth", path: "/in/gt.json", kind: "json", canaryPointers: ["/canary"] },
    { fileId: "migration-decisions", path: "/in/md.txt", kind: "text" },
    { fileId: "conformance-baseline", path: "/in/baseline.json", kind: "json", excludeSubtrees: ["/units/*/observed"] },
    { fileId: "review-package", path: "/in/review.txt", kind: "text" },
    { fileId: "evaluation-results", path: "/in/results.txt", kind: "text" },
  ],
  corpus: [
    { id: "src-utils", path: "/in/src.txt" },
    { id: "instr-revise", path: "/in/instr.txt" },
    { id: "api-ops", path: "/in/ops.txt" },
  ],
  allowlist: ALLOWLIST_INPUT,
  restrictedPathPrefixes: PREFIXES_INPUT,
  outputPath: "/out/discovery/config/audit-config.json",
  n: BUILDER_N,
};
export { BUILDER_DEFAULT_N };