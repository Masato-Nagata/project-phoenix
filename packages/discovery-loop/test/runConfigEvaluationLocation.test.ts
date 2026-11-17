// Task 4.1, acceptance item G2: R15.10 positive control. "A test-only runtime configuration that names the evaluation output location must be
// rejected." The run configuration has no key that takes a file-system location, so such a configuration is refused as an unknown key, and no name
// or path filter is involved (R15.13). Every location below is a synthetic STRING; no path is opened, listed or read, and nothing under
// `evaluation/` is accessed by this test.
import { describe, expect, it } from "vitest";
import { checkStartupRefusals, validateRunConfig, type ConfigIssue } from "../src/index.js";
import { scene } from "./support/startupWorld.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const base = (): Any => ({ schemaVersion: 1, provider: "mock", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames: [] });
const issuesOf = (raw: unknown): ConfigIssue[] => {
  const r = validateRunConfig(raw);
  if (r.ok) throw new Error("expected a refusal");
  return r.error;
};

/** Strings that name an evaluation location (synthetic: the design names these places, the test only writes the words). */
const LOCATIONS = [
  "evaluation/results/spec-restoration",
  "evaluation/ground-truth/ground-truth.json",
  "evaluation\\results\\spec-restoration",
  "/mnt/evaluation/results",
  "file:///evaluation/results",
  "../evaluation/results",
  "evaluation",
];
/** Key names that an operator might use, among them the names of the evaluator's own configuration (design: EvaluatorConfig). */
const KEYS = ["evaluationOutput", "evaluationOutputDir", "outputDir", "outputPath", "resultsDir", "groundTruthPath", "decisionsPath", "baselinePath", "approvalsPath", "runDir", "evaluation"];
/** Words that must appear in no issue: the input's key names and values are never echoed. */
const LEAK = /evaluation|results|ground|restoration|decisions|baseline|approvals|runDir|outputDir|outputPath|mnt|file:/i;

describe("G2 (R15.10): a configuration that names the evaluation output location is rejected, as an unknown key", () => {
  it("POSITIVE CONTROL: the same configuration without the location is accepted", () => {
    expect(validateRunConfig(base()).ok).toBe(true);
  });

  it("at the top level: every key name with every location is refused with exactly one issue at the placeholder", () => {
    for (const key of KEYS) {
      for (const location of LOCATIONS) {
        const cfg = base();
        cfg[key] = location;
        expect(issuesOf(cfg), `${key} = ${location}`).toEqual([{ code: "unknown_key", path: "/<unknown>" }]);
      }
    }
  });

  it("in every object of the configuration: limits, testApi, mask", () => {
    for (const key of KEYS) {
      for (const [where, mutate] of [
        ["/limits/<unknown>", (c: Any, v: string) => { c.limits[key] = v; }],
        ["/testApi/<unknown>", (c: Any, v: string) => { c.testApi[key] = v; }],
        ["/mask/<unknown>", (c: Any, v: string) => { c.mask[key] = v; }],
      ] as const) {
        const cfg = base();
        mutate(cfg, LOCATIONS[0] as string);
        expect(issuesOf(cfg), `${where} ${key}`).toEqual([{ code: "unknown_key", path: where }]);
      }
    }
  });

  it("the location as the NAME of the key, and as a value that is an object, an array or null", () => {
    for (const location of LOCATIONS) {
      const named = base();
      named[location] = 1;
      expect(issuesOf(named), location).toEqual([{ code: "unknown_key", path: "/<unknown>" }]);
    }
    for (const value of [{ path: "evaluation/results" }, ["evaluation/results"], null, 1, true]) {
      const cfg = base();
      cfg["evaluationOutput"] = value;
      expect(issuesOf(cfg)).toEqual([{ code: "unknown_key", path: "/<unknown>" }]);
    }
  });

  it("several such keys at once give one issue per parent, and the issues never echo a key name or a location", () => {
    const cfg = base();
    for (const key of KEYS) cfg[key] = LOCATIONS[0];
    cfg.limits.outputDir = LOCATIONS[1];
    cfg.mask.resultsDir = LOCATIONS[2];
    const issues = issuesOf(cfg);
    expect(issues).toEqual([
      { code: "unknown_key", path: "/<unknown>" },
      { code: "unknown_key", path: "/limits/<unknown>" },
      { code: "unknown_key", path: "/mask/<unknown>" },
    ]);
    expect(JSON.stringify(issues)).not.toMatch(LEAK);
  });

  it("a location in a place that takes a string is refused by the closed set or the grammar, and is never echoed", () => {
    const cases: [string, (c: Any, v: string) => void, string, string][] = [
      ["mask.paths", (c, v) => { c.mask.paths = [v]; }, "pattern_mismatch", "/mask/paths/0"],
      ["envNames", (c, v) => { c.envNames = [v]; }, "pattern_mismatch", "/envNames/0"],
      ["mockFixtureSet", (c, v) => { c.mockFixtureSet = v; }, "enum_mismatch", "/mockFixtureSet"],
      ["provider", (c, v) => { c.provider = v; }, "enum_mismatch", "/provider"],
      ["testApi.baseAddress", (c, v) => { c.testApi.baseAddress = v; }, "enum_mismatch", "/testApi/baseAddress"],
      ["schemaVersion", (c, v) => { c.schemaVersion = v; }, "enum_mismatch", "/schemaVersion"],
    ];
    for (const location of LOCATIONS.filter((l) => l !== "evaluation")) {
      for (const [label, set, code, path] of cases) {
        const cfg = base();
        set(cfg, location);
        const issues = issuesOf(cfg);
        expect(issues, `${label} = ${location}`).toEqual([{ code, path }]);
        expect(JSON.stringify(issues)).not.toMatch(LEAK);
      }
    }
  });

  it("no name filter is the mechanism: a plain field name that contains the word is a valid mask path, because a mask path is a JSON path and never a location", () => {
    // `mask.paths` entries are field paths into Test API response bodies (C2-2). The grammar, not a blacklist, decides what is valid.
    expect(validateRunConfig({ ...base(), mask: { paths: ["evaluation", "evaluation.results"] } }).ok).toBe(true);
    expect(validateRunConfig({ ...base(), envNames: ["EVALUATION_OUTPUT"] }).ok).toBe(true); // a name, never read as a path
    expect(validateRunConfig({ ...base(), mask: { paths: ["evaluation/results"] } }).ok).toBe(false); // a location is not a path of that grammar
  });

  it("a canary secret in a key name or a value does not appear in any issue", () => {
    const CANARY = "CANARY_8d2c_SECRET";
    const cfg = base();
    cfg[CANARY] = CANARY;
    cfg.limits[`${CANARY}-x`] = CANARY;
    cfg.envNames = [CANARY + "!"];
    cfg.mask.paths = [`${CANARY}/evaluation`];
    const text = JSON.stringify(issuesOf(cfg));
    expect(text).not.toContain(CANARY);
    expect(text).not.toContain("SECRET");
  });
});

describe("G2: stage B: a file in the configuration directory that is not one of the two is refused, and its name is not echoed", () => {
  it("a file named like an evaluation output location (a synthetic temporary file)", async () => {
    const s = scene({ configFiles: ["run-config.json", "audit-config.json", "evaluation-output.json"] });
    try {
      const r = await checkStartupRefusals((() => { const v = validateRunConfig(base()); if (!v.ok) throw new Error("x"); return v.value; })(), s.ports);
      expect(r.ok).toBe(false);
      expect(r.ok ? [] : r.error).toEqual([{ code: "config_files_unexpected", check: "io" }]);
      expect(JSON.stringify(r)).not.toMatch(/evaluation/i);
    } finally {
      s.cleanup();
    }
  });
  it("a name that is not one of the two files, such as a directory name, is refused as well, whatever the port lists", async () => {
    const v = validateRunConfig(base());
    if (!v.ok) throw new Error("x");
    for (const listed of [["run-config.json", "audit-config.json", "evaluation"], ["run-config.json", "evaluation/results"], ["evaluation"], []]) {
      const s = scene();
      try {
        const ports = { ...s.ports, io: { ...s.ports.io, configFiles: () => listed } };
        const r = await checkStartupRefusals(v.value, ports as Any);
        expect(r.ok ? [] : r.error, JSON.stringify(listed)).toEqual([{ code: "config_files_unexpected", check: "io" }]);
      } finally {
        s.cleanup();
      }
    }
  });
});