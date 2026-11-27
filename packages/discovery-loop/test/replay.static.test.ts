// Static checks of the replay (task 4.7 step A2, human decisions D2 and D3 of 2026-11-27). Source text only; each check has a positive
// control. Covers: the closed file list and import list of every replay module, no outbound module or code in them, the replay parts are
// unreachable from the composition root of a Run (`main.ts`) and from the package entry (transitively), only `replayMain.ts` imports
// `replay/`, nothing imports `replayMain.ts`, the replay root does not reach the start gate, startRun, terminate, the Run composition, the
// isolation module, the lease, Runner or start-up adapters, and the replay-only parts are named nowhere else in `src`.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG = fileURLToPath(new URL("../", import.meta.url));
const SRC = join(PKG, "src");
const REPLAY = join(SRC, "replay");

const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const blankStrings = (s: string): string => s.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
const code = (s: string): string => blankStrings(stripComments(s));
function specifiersOf(source: string): string[] {
  const c = stripComments(source);
  const found: string[] = [];
  for (const m of c.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) found.push(m[1] as string);
  for (const m of c.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) found.push(m[1] as string);
  for (const m of c.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) found.push(m[1] as string);
  for (const m of c.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g)) found.push(m[1] as string);
  return found;
}
function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" || e.name === "dist" ? [] : walk(join(dir, e.name))) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}
const rel = (f: string): string => relative(SRC, f).split(sep).join("/");
const read = (relPath: string): string => readFileSync(join(SRC, relPath), "utf8");

/** The transitive closure of relative imports (type imports included: conservative) from one src file, as src-relative paths. */
function closure(start: string, sources: (p: string) => string = read): Set<string> {
  const seen = new Set<string>();
  const todo = [start];
  while (todo.length > 0) {
    const f = todo.pop() as string;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const s of specifiersOf(sources(f))) {
      if (!s.startsWith("./") && !s.startsWith("../")) continue;
      const target = rel(resolve(dirname(join(SRC, f)), s.replace(/\.js$/, ".ts")));
      if (existsSync(join(SRC, target))) todo.push(target);
    }
  }
  return seen;
}

const REPLAY_FILES = ["recordedRunner.ts", "replayAudit.ts", "replayInputs.ts", "replayProvider.ts", "replaySupport.ts"];
/** The exact imports of each replay module. No orchestrator, runtime, sibling, network, process or file module. */
const ALLOWED: Record<string, readonly string[]> = {
  "recordedRunner.ts": ["../canonical/index.js", "../schema/index.js", "./replayInputs.js", "./replaySupport.js"],
  "replayAudit.ts": ["node:crypto", "./replayInputs.js", "./replaySupport.js"],
  "replayInputs.ts": [
    "node:crypto", "../canonical/index.js", "../config/index.js", "../schema/index.js", "../store/fileSystemPort.js", "../store/runRecordStore.js",
    "../store/runVerification.js", "./replaySupport.js",
  ],
  "replayProvider.ts": ["node:crypto", "./replayAudit.js", "./replayInputs.js", "./replaySupport.js"],
  "replaySupport.ts": [],
};
// (`auditPayload` is not listed: the replay audit implements the AuditPort method of that name; the ai-client auditor is excluded by the import lists.)
const FORBIDDEN_CODE = /\bprocess\b|\bglobalThis\b|\bfetch\s*\(|\bDate\b|\bsetTimeout\b|\bsetInterval\b|Math\.random|\beval\s*\(|\bFunction\s*\(|evaluation|ground[_ -]?truth|approv|override|\bcreateProvider\b|\bcreateRunner\b|\bcreateLeasePort\b|\bbuildSourceBundle\b/i;
const OUTBOUND = /^(?:node:)?(?:net|http|https|http2|dgram|tls|dns|child_process|worker_threads|cluster|fs|fs\/promises)$/;

describe("the replay modules", () => {
  it("the folder holds exactly the planned files", () => {
    expect(readdirSync(REPLAY).filter((f) => f.endsWith(".ts")).sort()).toEqual(REPLAY_FILES);
    expect(Object.keys(ALLOWED).sort()).toEqual(REPLAY_FILES);
  });
  it("every import of every replay module is on its exact list", () => {
    for (const f of REPLAY_FILES) expect([...new Set(specifiersOf(read(`replay/${f}`)))].sort(), f).toEqual([...(ALLOWED[f] ?? [])].sort());
  });
  it("no replay module has an outbound module (network, process, file) or forbidden code (clock, random, provider factory, auditor, Runner, lease, Source_Bundler)", () => {
    for (const f of REPLAY_FILES) {
      const s = read(`replay/${f}`);
      expect(specifiersOf(s).filter((x) => OUTBOUND.test(x)), f).toEqual([]);
      expect(code(s).match(FORBIDDEN_CODE)?.[0], f).toBeUndefined();
    }
  });
  it.each([
    ['import { request } from "node:http";'],
    ['import net from "node:net";'],
    ['const cp = require("node:child_process");'],
    ['import { readFile } from "node:fs/promises";'],
  ])("positive control (outbound module): %j", (bad) => {
    expect(specifiersOf(bad).filter((x) => OUTBOUND.test(x)).length).toBeGreaterThan(0);
  });
  it.each([["await fetch(u)"], ["const t = Date.now();"], ["process.env.X"], ["createProvider({ provider: 'mock' })"], ["createRunner(deps)"], ["setTimeout(f, 1)"]])("positive control (code): %j", (bad) => {
    expect(code(bad).match(FORBIDDEN_CODE)).not.toBeNull();
  });
  it("negative control: a forbidden word only in a comment or a string is not code", () => {
    expect(code('// uses fetch( and process\nconst s = "createProvider";').match(FORBIDDEN_CODE)).toBeNull();
  });
});

describe("the replay is unreachable from a Run and from the package entry", () => {
  const isReplay = (p: string): boolean => p === "replayMain.ts" || p.startsWith("replay/");
  it("the transitive imports of main.ts and of index.ts contain no replay module", () => {
    const fromMain = closure("main.ts");
    const fromIndex = closure("index.ts");
    expect(fromMain.has("orchestrator/loopOrchestrator.ts")).toBe(true); // the closure works
    expect([...fromMain].filter(isReplay)).toEqual([]);
    expect([...fromIndex].filter(isReplay)).toEqual([]);
  });
  it("positive control: the closure of replayMain.ts reaches the replay modules", () => {
    const fromReplay = closure("replayMain.ts");
    for (const f of REPLAY_FILES) expect(fromReplay.has(`replay/${f}`), f).toBe(true);
  });
  it("positive control of the closure: a fake main.ts that imports replayMain is detected", () => {
    const fake = (p: string): string => (p === "main.ts" ? 'import { replayRun } from "./replayMain.js";' : read(p));
    expect([...closure("main.ts", fake)].filter(isReplay).length).toBeGreaterThan(0);
  });
  it("only replayMain.ts imports replay/, and no file imports replayMain.ts", () => {
    const importersOf = (re: RegExp): string[] => walk(SRC).filter((f) => specifiersOf(readFileSync(f, "utf8")).some((s) => re.test(s))).map(rel).filter((f) => !f.startsWith("replay/")).sort();
    expect(importersOf(/(^|\/)replay\//)).toEqual(["replayMain.ts"]);
    expect(walk(SRC).filter((f) => specifiersOf(readFileSync(f, "utf8")).some((s) => /(^|\/)replayMain(\.js)?$/.test(s))).map(rel)).toEqual([]);
  });
  it("the replay root reaches no start gate, startRun, terminate, Run composition, manifest port, isolation module, lease, Runner, clock or start-up adapter", () => {
    const fromReplay = [...closure("replayMain.ts")];
    const forbidden = [
      "orchestrator/startGate.ts", "orchestrator/startRun.ts", "orchestrator/terminate.ts", "orchestrator/loopOrchestrator.ts", "orchestrator/runComposition.ts",
      "orchestrator/manifestPort.ts", "orchestrator/consume.ts", "gate/mayStartRun.ts", "runtime/clocks.ts", "runtime/runnerFactory.ts", "runtime/startupPorts.ts",
      "runtime/startupInputs.ts", "runtime/analysisFs.ts", "main.ts",
    ];
    expect(fromReplay.filter((f) => forbidden.includes(f))).toEqual([]);
    expect(fromReplay.filter((f) => f.startsWith("isolation/") && f !== "isolation/types.ts")).toEqual([]);
    expect(fromReplay.filter((f) => f.startsWith("runtimeFacts/") || f.startsWith("approval/") || f.startsWith("report/") || f.startsWith("manifest/"))).toEqual([]);
    // positive control: the same check over main.ts finds them
    const fromMain = [...closure("main.ts")];
    expect(fromMain.filter((f) => forbidden.includes(f)).length).toBeGreaterThan(5);
  });
  it("the replay-only parts are named in no file of src outside replay/ and replayMain.ts", () => {
    const names = /\b(?:createReplayLeasePort|createReplayAudit|createReplayProvider|createRecordedRunner|createFixedClock|createSilentTimers|createDivergenceCell|buildReplayPlan|acceptForReplay|replayRun)\b/;
    const offenders = walk(SRC).map(rel).filter((f) => !f.startsWith("replay/") && f !== "replayMain.ts").filter((f) => names.test(code(read(f))));
    expect(offenders).toEqual([]);
    expect(names.test(code("const p = createReplayLeasePort();"))).toBe(true);
  });
  it("the ai-client provider factory registers no replay provider (createProvider keeps refusing replay)", () => {
    const provider = readFileSync(join(PKG, "..", "ai-client", "src", "provider.ts"), "utf8");
    expect(code(provider)).toMatch(/DEFAULT_PROVIDER_FACTORIES:\s*ProviderFactories\s*=\s*Object\.freeze\(\{\s*mock:\s*mockFactory\s*\}\)/);
    for (const f of walk(join(PKG, "..", "ai-client", "src"))) expect(/discovery-loop|ReplayProvider|recordedRunner/.test(code(readFileSync(f, "utf8"))), f).toBe(false);
  });
  it("replayMain.ts has no environment read and no outbound network or process module; it reads files only through its bounded port", () => {
    const s = read("replayMain.ts");
    expect(code(s)).not.toMatch(/process\.env|\bfetch\s*\(|\bcreateProvider\b|\bauditPayload\b|\bcreateRunner\b|\bcreateLeasePort\b|\bbuildSourceBundle\b|\bcreateAuditAdapter\b/);
    expect(specifiersOf(s).filter((x) => /^(?:node:)?(?:net|http|https|http2|dgram|tls|dns|child_process|worker_threads|cluster)$/.test(x))).toEqual([]);
    expect(specifiersOf(s).filter((x) => x.startsWith("node:")).sort()).toEqual(["node:fs", "node:fs/promises", "node:path", "node:url"]);
    // the command passes no test hook
    expect(code(s)).toMatch(/replayRun\(\{ port, runDir: given\.run, policyConfig, preparationTable \}\)/);
  });
});
