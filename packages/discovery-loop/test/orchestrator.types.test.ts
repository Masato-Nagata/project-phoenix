// Task 4.4, unit U0: the types and ports of the Loop_Orchestrator (`src/orchestrator/types.ts`). Deterministic and offline; nothing is started.
//
// Part 1 compiles probe files with the TypeScript compiler API against the REAL sources of verifier and analyzer. Vitest does not type-check
// and `tsconfig` includes `src` only, so a `@ts-expect-error` in a test file would prove nothing (the model is `mayStartRun.test.ts`).
// The probe is ONE virtual file; each group of probes checks its own lines. Accepted lines must produce no diagnostic. Each rejected line must
// produce EXACTLY ONE diagnostic whose code is in the list of that line. Where the checker may report the same defect with either of two codes
// (for example a missing property of a union member: TS2322 or TS2741, an excess property: TS2322 or TS2353), both are listed; the codes follow
// from the syntax of the line, not from observed output (nothing was executed when this file was written).
// Part 2 checks the source text of `types.ts` (comments stripped; every detector has a positive control built from a fixture string).
// Part 3 pins the closed vocabularies and the key lists.
// **Validates: Requirements 2.12, 11.12, 12.13, 12.14, 15.6, 19.3, 19.7**
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { TERMINATION_REASONS, UNSEALED_FAILURE_CODES, LEASE_REASONS, START_GATE_REFUSAL_CODES } from "../src/orchestrator/types.js";

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const TYPES_PATH = join(TEST_DIR, "..", "src", "orchestrator", "types.ts");
const TYPES_TEXT = readFileSync(TYPES_PATH, "utf8");

// ---------------------------------------------------------------------------------------------------------------------------------
// Part 1: type-level probes
// ---------------------------------------------------------------------------------------------------------------------------------
interface Bad {
  readonly text: string;
  readonly why: string;
  readonly codes: readonly number[];
}
interface Group {
  readonly accepted: number[];
  readonly bad: { line: number; codes: readonly number[]; why: string }[];
}
const probeLines: string[] = [];
const groups = new Map<string, Group>();
function addGroup(name: string, accepted: readonly string[], bad: readonly Bad[]): void {
  const g: Group = { accepted: [], bad: [] };
  for (const l of accepted) {
    probeLines.push(l);
    g.accepted.push(probeLines.length);
  }
  for (const b of bad) {
    probeLines.push(`${b.text} // BAD ${b.why}`);
    g.bad.push({ line: probeLines.length, codes: b.codes, why: b.why });
  }
  groups.set(name, g);
}

addGroup(
  "header",
  [
    'import type { AccessDenialResult } from "../src/isolation/types.js";',
    'import type { AnalysisFsPort, AnalysisPort, AuditContextHandle, CallOutcomeView, ExecutionOutcomeView, LoopDeps, ManifestCore, RunResult, RunSummary } from "../src/orchestrator/types.js";',
    'import type { ExecutionObservation, ExecutionOutcome, InterruptedOutcome } from "../../verifier/src/runner/types.js";',
    'import type { buildSourceBundle as realBuildSourceBundle } from "../../analyzer/src/bundle/bundler.js";',
    'import type { FileSystemPort as RealAnalyzerFs } from "../../analyzer/src/bundle/types.js";',
    "type Equals<X, Y> = (<T>() => T extends X ? 1 : 2) extends (<T>() => T extends Y ? 1 : 2) ? true : false;",
    "declare const obs: ExecutionObservation;",
    "declare const sum: RunSummary;",
    "declare const rr: RunResult;",
    "declare const ad: AccessDenialResult;",
    "declare const deps: LoopDeps;",
  ],
  [],
);

// (1) every variant of the real ExecutionOutcome is assignable to the view; the view is a strict supertype.
addGroup(
  "outcome",
  [
    "declare const rExecuted: Extract<ExecutionOutcome, { status: 'executed' }>;",
    "declare const rTimedOut: Extract<ExecutionOutcome, { status: 'timed_out' }>;",
    "declare const rAborted: Extract<ExecutionOutcome, { status: 'aborted' }>;",
    "declare const rNotExecuted: Extract<ExecutionOutcome, { status: 'not_executed' }>;",
    "declare const rInterrupted: InterruptedOutcome;",
    "declare const rAny: ExecutionOutcome;",
    "export const o1: ExecutionOutcomeView = rExecuted;",
    "export const o2: ExecutionOutcomeView = rTimedOut;",
    "export const o3: ExecutionOutcomeView = rAborted;",
    "export const o4: ExecutionOutcomeView = rNotExecuted;",
    "export const o5: ExecutionOutcomeView = rInterrupted;",
    "export const o6: ExecutionOutcomeView = rAny;",
    'export const o7: ExecutionOutcome = { status: "aborted", reason: "lease_unavailable", observation: obs, leaseReason: "revoked", terminationReason: "lease_unavailable" };',
    "export const o8: ExecutionOutcomeView = o7;",
    'export const o9: ExecutionOutcomeView = { status: "not_executed", reason: "runner_internal_error", observation: obs, fatal: true };',
    'export const o10: ExecutionOutcomeView = { status: "interrupted", cause: "forced_stop", experimentId: "e", phase: "seq", sentRequests: 0, collectedResponses: 0, collectedStateChecks: 0 };',
    'export const o11: ExecutionOutcomeView = { status: "executed", observation: obs };',
    "export const o12: string | undefined = rAny.status === 'aborted' ? rAny.reason : undefined;",
    "declare const view: ExecutionOutcomeView;",
    "export const o13: string | undefined = view.status === 'interrupted' ? view.cause : view.status === 'executed' ? view.observation.experimentId : undefined;",
  ],
  [
    { text: 'export const ob1: ExecutionOutcomeView = { status: "executed" };', why: "executed without an observation", codes: [2322, 2741] },
    {
      text: 'export const ob2: ExecutionOutcomeView = { status: "interrupted", cause: "forced_stop", experimentId: "e", phase: "seq", sentRequests: 0, collectedResponses: 0, collectedStateChecks: 0, observation: obs };',
      why: "an interrupted outcome has no observation",
      codes: [2322, 2353],
    },
    { text: 'export const ob3: ExecutionOutcomeView = { status: "done", observation: obs };', why: "unknown status", codes: [2322] },
    { text: "export const ob4: ExecutionOutcome = view;", why: "the view is a strict supertype, not assignable back to the real outcome", codes: [2322] },
    { text: 'export const ob5: ExecutionOutcomeView = { status: "aborted", reason: "other", observation: obs };', why: "aborted reason outside the closed pair", codes: [2322] },
    { text: "export const ob6 = view.observation;", why: "interrupted has no observation, so the property is not on the union", codes: [2339] },
  ],
);

// (2) RunResult
addGroup(
  "runResult",
  [
    "export const r1: RunResult = { sealed: true, summary: sum };",
    'export const r2: RunResult = { sealed: false, started: false, failure: "store_open_failed" };',
    'export const r3: RunResult = { sealed: false, started: true, terminationReason: "error", failure: "seal_failed" };',
    "export const r4: string = rr.sealed ? rr.summary.manifestSha256 : rr.failure;",
    "export const r5: boolean = rr.sealed ? false : rr.started;",
  ],
  [
    { text: "export const rb1: RunResult = { sealed: true };", why: "sealed without a summary", codes: [2322, 2741] },
    {
      text: 'export const rb2: RunResult = { sealed: false, started: true, failure: "seal_failed", manifestSha256: "0".repeat(64) };',
      why: "an unsealed result has no manifest hash",
      codes: [2322, 2353],
    },
    { text: 'export const rb3: RunResult = { sealed: true, summary: sum, failure: "seal_failed" };', why: "a sealed result has no failure", codes: [2322, 2353] },
    { text: 'export const rb4: RunResult = { sealed: false, started: true, failure: "boom" };', why: "failure outside the closed list", codes: [2322] },
    { text: 'export const rb5: RunResult = { sealed: false, failure: "seal_failed" };', why: "started is required", codes: [2322, 2741] },
    { text: "export const rn1 = rr.summary;", why: "summary is not on the union", codes: [2339] },
    { text: 'export const rn2 = rr.sealed ? rr.failure : "";', why: "failure in the sealed branch", codes: [2339] },
    { text: 'export const rn3 = rr.sealed ? "" : rr.summary;', why: "summary in the unsealed branch", codes: [2339] },
    { text: "export const rn4 = rr.manifestSha256;", why: "no top-level manifest hash", codes: [2339] },
  ],
);

// (3) LoopDeps
const NEW_KEYS =
  '"isolation" | "fs" | "runVolumeDir" | "clock" | "wallClock" | "timers" | "provider" | "audit" | "responseGate" | "policy" | "runnerFactory" | "comparator" | "analysisFs" | "repoRoot" | "analysis" | "storeFactory" | "manifest"';
const OLD_KEYS =
  '"isolation" | "fs" | "runVolumeDir" | "clock" | "wallClock" | "provider" | "audit" | "responseGate" | "policy" | "runnerFactory" | "comparator" | "analysis" | "manifest"';
addGroup(
  "loopDeps",
  [
    `export const k1: Equals<keyof LoopDeps, ${NEW_KEYS}> = true;`,
    'export const k2: Equals<Extract<keyof LoopDeps["analysis"], "sourceBundle">, never> = true;',
    'export const k3: Equals<keyof LoopDeps["analysis"], "buildSourceBundle" | "verifyCitations" | "validateDeclarations" | "validateExpr"> = true;',
    'export const k4: Equals<LoopDeps["analysisFs"], AnalysisFsPort> = true;',
    'export const k5: string = deps.repoRoot;',
  ],
  [
    { text: `export const kb1: Equals<keyof LoopDeps, ${OLD_KEYS}> = true;`, why: "the old thirteen keys are not the key set", codes: [2322] },
    { text: "export const kb2 = deps.analysis.sourceBundle;", why: "no source bundle value on the analysis port", codes: [2339] },
    { text: 'export const kb3: Equals<Extract<keyof LoopDeps["analysis"], "sourceBundle">, "sourceBundle"> = true;', why: "the key sourceBundle is gone", codes: [2322] },
    { text: "export const kb4 = deps.secretValues;", why: "no secret values on the dependencies", codes: [2339] },
  ],
);

// (4) the real analyzer API fits the port
addGroup(
  "analysis",
  [
    "declare const realBuild: typeof realBuildSourceBundle;",
    "declare const realFs: RealAnalyzerFs;",
    'export const a1: AnalysisPort["buildSourceBundle"] = realBuild;',
    "export const a2: AnalysisFsPort = realFs;",
    "export const a3: RealAnalyzerFs = {} as AnalysisFsPort;",
  ],
  [
    { text: "export const ab1: AnalysisFsPort = { readFile: async () => new Uint8Array() };", why: "lstat is missing", codes: [2322, 2741] },
    {
      text: 'export const ab2: AnalysisPort["buildSourceBundle"] = async (fs: number) => ({ ok: true as const, value: fs });',
      why: "a first parameter that is not a file system",
      codes: [2322],
    },
  ],
);

// (5) the opaque audit context handle
addGroup(
  "auditHandle",
  [
    "export const h1 = deps.audit.prepareAudit({ bundle: {}, kind: 'hypothesis_generation', templateId: 't', stored: [], records: [] });",
    "export const h2: AuditContextHandle | undefined = h1.ok ? h1.value.ctx : undefined;",
    "export const h3 = h1.ok ? deps.audit.auditPayload(new Uint8Array(0), 'hypothesis_generation', undefined, h1.value.ctx) : undefined;",
    "export const h4: Uint8Array | undefined = h1.ok ? h1.value.bytes : undefined;",
    "export const h5: 'prepare_failed' | undefined = h1.ok ? undefined : h1.error.code;",
  ],
  [
    { text: "export const hb1: AuditContextHandle = {};", why: "a plain object is not a handle", codes: [2322, 2741] },
    { text: 'export const hb2 = deps.audit.auditPayload(new Uint8Array(0), "k", undefined, {});', why: "auditPayload takes the handle only", codes: [2345] },
    { text: 'export const hb3: AuditContextHandle = "ctx";', why: "a string is not a handle", codes: [2322] },
    {
      text: "export const hb4 = deps.audit.prepareAudit({ bundle: {}, kind: 'k', templateId: 't', stored: [], records: [], secretValues: [], lookupRecord: () => undefined });",
      why: "prepareAudit takes no secret values and no lookupRecord",
      codes: [2322, 2345, 2353],
    },
  ],
);

// (5b) the gate outcome narrows on `kind`; the real ai-client CallOutcome is assignable to the view
addGroup(
  "callOutcome",
  [
    'import type { CallOutcome } from "../../ai-client/src/responseGate.js";',
    "declare const rco: CallOutcome;",
    "export const c1: CallOutcomeView = rco;",
    "export const c2 = deps.responseGate.gateProviderResult('hypothesis_generation', { ok: false, error: { reason: 'error', detail: 'x' } }, undefined, undefined);",
    "export const c3: string | undefined = c2.kind === 'failed_call' ? c2.source : c2.kind === 'audit_violation' ? c2.violation.code : undefined;",
    "export const c4: boolean | undefined = c2.kind === 'failed_call' ? c2.toolCall : undefined;",
    "export const c5: unknown = c2.kind === 'accepted' ? c2.result : undefined;",
  ],
  [
    { text: "export const cb1 = c2.kind === 'accepted' ? c2.source : undefined;", why: "source is not on the accepted member", codes: [2339] },
    { text: "export const cb2: CallOutcomeView = { kind: 'failed_call', reason: 'error', retryable: false, source: 'provider', toolCall: false };", why: "a failed call is always retryable", codes: [2322] },
    { text: "export const cb3: CallOutcomeView = { kind: 'audit_violation', retryable: false, stopRun: true };", why: "an audit violation carries its violation", codes: [2322, 2741] },
  ],
);

// (6) ManifestCore
const CORE_BODY =
  'runId: "r", wallClock: { startedAt: "a", finishedAt: "b" }, terminationReason: "error", finalHypothesisRevision: "none", limitsUsed: { iterations: 0, acceptedExperiments: 0, rejectedExperiments: 0 }, provider: { id: "mock", version: "1", model: "m", isMock: true }, envVarsRead: [{ name: "X", set: true }], payloadAudit: { configCheck: "pass", audits: 0, passed: 0, blocked: 0, auditConfigSha256: "h" }, accessDenial: ad, configHashes: { policyConfigSha256: "h", preparationTableSha256: "h" }, leaseFacts: { heartbeatIntervalMs: 1, staleAfterMs: 2, propagationDelayMs: 3 }, effectiveConfig: {}';
const EXTRA_KEYS: readonly string[] = ["schemaVersion: 1", "chain: []", "artifacts: []", "toolVersions: {}", "secretValues: []", "mutualExclusion: {}", "aiSandbox: {}", "legacyStartState: {}"];
addGroup(
  "manifestCore",
  [
    `export const m0: ManifestCore = { ${CORE_BODY} };`,
    `export const m1: ManifestCore = { ${CORE_BODY}, sourceBundleManifest: [] };`,
    "export const m2: Record<string, unknown> = deps.manifest.build(m0);",
  ],
  [
    ...EXTRA_KEYS.map(
      (extra, i): Bad => ({ text: `export const mb${i}: ManifestCore = { ${CORE_BODY}, ${extra} };`, why: `extra key ${extra.split(":")[0]}`, codes: [2322, 2353] }),
    ),
    { text: `export const mc1: ManifestCore = { ${CORE_BODY.replace(", effectiveConfig: {}", "")} };`, why: "effectiveConfig is required", codes: [2322, 2741] },
    { text: `export const mc2: ManifestCore = { ${CORE_BODY.replace("isMock: true }", 'isMock: true, apiKey: "x" }')} };`, why: "a key inside provider", codes: [2322, 2353] },
    { text: `export const mc3: ManifestCore = { ${CORE_BODY.replace("accessDenial: ad", "accessDenial: {}")} };`, why: "accessDenial must be the branded result shape", codes: [2322, 2739, 2740, 2741] },
  ],
);

interface Located {
  readonly line: number;
  readonly code: number;
  readonly text: string;
}
let located: readonly Located[] | undefined;
function compileProbe(): readonly Located[] {
  if (located !== undefined) return located;
  const PROBE_PATH = join(TEST_DIR, "__orchestratorTypesProbe.ts");
  const PROBE_TEXT = probeLines.join("\n") + "\n";
  const norm = (p: string): string => resolve(p).replace(/\\/g, "/");
  const repoRoot = resolve(TEST_DIR, "..", "..", "..");
  const options: ts.CompilerOptions = {
    strict: true,
    noUncheckedIndexedAccess: true,
    exactOptionalPropertyTypes: true,
    verbatimModuleSyntax: true,
    isolatedModules: true,
    target: ts.ScriptTarget.ES2023,
    lib: ["lib.es2023.d.ts"],
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    noEmit: true,
    types: ["node"],
    typeRoots: [join(repoRoot, "node_modules", "@types")],
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const isProbe = (f: string): boolean => norm(f) === norm(PROBE_PATH);
  const origGet = host.getSourceFile.bind(host);
  const origExists = host.fileExists.bind(host);
  const origRead = host.readFile.bind(host);
  host.getSourceFile = (f, langOrOptions, onError, shouldCreate) =>
    isProbe(f) ? ts.createSourceFile(f, PROBE_TEXT, langOrOptions, true) : origGet(f, langOrOptions, onError, shouldCreate);
  host.fileExists = (f) => isProbe(f) || origExists(f);
  host.readFile = (f) => (isProbe(f) ? PROBE_TEXT : origRead(f));
  const program = ts.createProgram({ rootNames: [PROBE_PATH], options, host });
  const sf = program.getSourceFile(PROBE_PATH);
  if (sf === undefined) throw new Error("the probe file was not created");
  located = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf)].map((d) => ({
    // A diagnostic without a position gets line 0, which belongs to no group, so the final check fails on it.
    line: d.file === undefined || d.start === undefined ? 0 : d.file.getLineAndCharacterOfPosition(d.start).line + 1,
    code: d.code,
    text: ts.flattenDiagnosticMessageText(d.messageText, " | "),
  }));
  return located;
}
const describeAll = (ds: readonly Located[]): string => ds.map((d) => `line ${d.line} TS${d.code}: ${d.text}`).join("\n");

function checkGroup(name: string): void {
  const g = groups.get(name);
  expect(g, name).toBeDefined();
  if (g === undefined) return;
  const all = compileProbe();
  const detail = `all diagnostics:\n${describeAll(all)}`;
  for (const line of g.accepted) expect(all.filter((d) => d.line === line), `accepted line ${line}: ${probeLines[line - 1]}\n${detail}`).toEqual([]);
  for (const b of g.bad) {
    const here = all.filter((d) => d.line === b.line);
    expect(here.length, `rejected line ${b.line} (${b.why}) must give exactly one diagnostic\n${detail}`).toBe(1);
    expect(b.codes, `rejected line ${b.line} (${b.why}): code TS${here[0]?.code}\n${detail}`).toContain(here[0]?.code);
  }
}

describe("type safety (compiler API over the real sources)", () => {
  it("the probe has no diagnostic outside the lines of a group (no unplanned or positionless diagnostic)", () => {
    const planned = new Set<number>();
    for (const g of groups.values()) {
      for (const l of g.accepted) planned.add(l);
      for (const b of g.bad) planned.add(b.line);
    }
    const all = compileProbe();
    expect(all.filter((d) => d.line === 0 || !planned.has(d.line)), describeAll(all)).toEqual([]);
    expect(probeLines.length).toBeGreaterThan(80);
  }, 120_000);
  it("(0) the header imports resolve and produce no diagnostic", () => checkGroup("header"), 120_000);
  it("(1) every variant of the real ExecutionOutcome is assignable to ExecutionOutcomeView; the view is a strict supertype", () => {
    checkGroup("outcome");
    expect(groups.get("outcome")?.bad.length).toBe(6);
  }, 120_000);
  it("(2) RunResult: sealed needs a summary, an unsealed result has no manifest hash, narrowing works", () => {
    checkGroup("runResult");
    expect(groups.get("runResult")?.bad.length).toBe(9);
  }, 120_000);
  it("(3) LoopDeps has exactly the 17 keys and no source bundle value", () => {
    checkGroup("loopDeps");
  }, 120_000);
  it("(4) the real analyzer buildSourceBundle and FileSystemPort fit the analysis ports", () => {
    checkGroup("analysis");
  }, 120_000);
  it("(5) the audit context handle is opaque and prepareAudit has the planned shape", () => {
    checkGroup("auditHandle");
  }, 120_000);
  it("(5b) the gate outcome narrows on kind, and the real ai-client CallOutcome is assignable to it", () => {
    checkGroup("callOutcome");
    expect(groups.get("callOutcome")?.bad.length).toBe(3);
  }, 120_000);
  it("(6) ManifestCore refuses every key outside the core, also inside provider, and needs effectiveConfig", () => {
    checkGroup("manifestCore");
    expect(groups.get("manifestCore")?.bad.length).toBe(EXTRA_KEYS.length + 3);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Part 2: the source text of types.ts
// ---------------------------------------------------------------------------------------------------------------------------------
const stripComments = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
const blankStrings = (s: string): string => s.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
const code = (s: string): string => blankStrings(stripComments(s));
function specifiersOf(source: string): string[] {
  const c = stripComments(source);
  const found: string[] = [];
  for (const m of c.matchAll(/^\s*(?:import|export)\b[^;]*?\bfrom\s*["']([^"']+)["']/gm)) found.push(m[1] as string);
  for (const m of c.matchAll(/^\s*import\s*["']([^"']+)["']/gm)) found.push(m[1] as string);
  for (const m of c.matchAll(/\bimport\s*\(\s*["']([^"']+)["']/g)) found.push(m[1] as string);
  return found;
}

describe("source text of types.ts: no secret-valued property", () => {
  const SECRET_LIKE = /secret|password|apikey|credential|token|envvalue/i;
  /** Every identifier that is followed by `:` or `?:` (a property or a parameter name) in the code, strings blanked. */
  const namesOf = (source: string): string[] => [...code(source).matchAll(/\b([A-Za-z_]\w*)\s*\??:/g)].map((m) => m[1] as string);
  const offenders = (source: string): string[] => namesOf(source).filter((n) => SECRET_LIKE.test(n));
  it("no property or parameter name of types.ts names a secret value", () => {
    expect(namesOf(TYPES_TEXT).length).toBeGreaterThan(60);
    expect(offenders(TYPES_TEXT)).toEqual([]);
  });
  it("positive control: each forbidden property name is reported, a plain name is not", () => {
    for (const n of ["secretValues", "envValues", "apiKey", "credentialValue", "password", "token", "secret"]) {
      expect(offenders(`export interface A { readonly ${n}: string; }`), n).toEqual([n]);
      expect(offenders(`export interface A { ${n}?: string }`), n).toEqual([n]);
    }
    expect(offenders("export interface A { readonly name: string; set: boolean; }")).toEqual([]);
    expect(offenders('// secretValues in a comment\nexport const X = "token";')).toEqual([]);
  });
});

describe("source text of types.ts: no process, clock, random source or dynamic code", () => {
  const FORBIDDEN: readonly { id: string; re: RegExp }[] = [
    { id: "process", re: /\bprocess\b|\bglobalThis\b/ },
    { id: "Date", re: /\bDate\b/ },
    { id: "random", re: /Math\.random|getRandomValues|randomUUID|randomBytes/ },
    { id: "timer", re: /\bsetTimeout\b|\bsetInterval\b|\bsetImmediate\b|\bperformance\b|hrtime/ },
    { id: "dynamic", re: /\beval\s*\(|new Function\s*\(|\bimport\s*\(|\brequire\s*\(/ },
  ];
  const found = (source: string): string[] => FORBIDDEN.filter((f) => f.re.test(code(source))).map((f) => f.id);
  it("holds", () => {
    expect(found(TYPES_TEXT)).toEqual([]);
  });
  it("positive control", () => {
    expect(found("const e = process.env.X;")).toContain("process");
    expect(found("const t = new Date();")).toContain("Date");
    expect(found("const r = Math.random();")).toContain("random");
    expect(found("setTimeout(f, 1);")).toContain("timer");
    expect(found('await import("x");')).toContain("dynamic");
    expect(found("// process, Date, Math.random and setTimeout in a comment\nconst a = 1;")).toEqual([]);
  });
});

describe("source text of types.ts: imports", () => {
  const ALLOWED = ["../isolation/types.js", "../schema/types.js", "../store/fileSystemPort.js", "../store/runRecordStore.js"];
  const FOREIGN = /ai-client|verifier|analyzer|@phoenix/;
  const valueImports = (source: string): string[] => [...stripComments(source).matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s*["']([^"']+)["']/gm)].map((m) => m[1] as string);
  it("imports exactly the four allowed modules, none of them foreign, all as `import type`", () => {
    expect(specifiersOf(TYPES_TEXT).sort()).toEqual([...ALLOWED].sort());
    expect(specifiersOf(TYPES_TEXT).filter((s) => FOREIGN.test(s))).toEqual([]);
    expect(valueImports(TYPES_TEXT)).toEqual([]);
    expect(stripComments(TYPES_TEXT)).toMatch(/^import type \{ OpenError, RunRecordStore \} from "\.\.\/store\/runRecordStore\.js";$/m);
  });
  it("positive control", () => {
    expect(specifiersOf('import type { A } from "../../ai-client/src/index.js";').filter((s) => FOREIGN.test(s))).toHaveLength(1);
    expect(specifiersOf('import type { A } from "@phoenix/analyzer";').filter((s) => FOREIGN.test(s))).toHaveLength(1);
    expect(specifiersOf('export type { A } from "../../verifier/src/index.js";').filter((s) => FOREIGN.test(s))).toHaveLength(1);
    expect(valueImports('import { A } from "../store/runRecordStore.js";')).toEqual(["../store/runRecordStore.js"]);
    expect(valueImports('import type { A } from "../store/runRecordStore.js";')).toEqual([]);
  });
});

describe("source text of types.ts: types and constants only", () => {
  const COL0_OK: readonly RegExp[] = [
    /^import type \{[^}]*\} from "[^"]+";$/,
    /^export interface \w+(?:<[^>]*>)? \{$/,
    /^export type \w+(?:<[^>]*>)? =/,
    /^declare const \w+: unique symbol;$/,
    /^\}$/,
    /^export const [A-Z_]+ = Object\.freeze\(\[$/,
    /^export const [A-Z_]+ = Object\.freeze\(\[[^\]]*\] as const\);$/,
    /^\] as const\);$/,
  ];
  function bodyViolations(source: string): string[] {
    const bad: string[] = [];
    for (const line of stripComments(source).split(/\r?\n/)) {
      if (line.trim() === "" || /^\s/.test(line)) continue;
      if (!COL0_OK.some((re) => re.test(line))) bad.push(line);
    }
    const c = code(source);
    for (const [id, re] of [
      ["function", /\bfunction\b/],
      ["class", /\bclass\b/],
      ["arrow body", /=>\s*[{(]/],
      ["statement", /\breturn\b|\basync\b|\bawait\b|\bnew\b|\bthrow\b|\bif\s*\(|\bfor\s*\(|\bwhile\s*\(/],
    ] as const) {
      if (re.test(c)) bad.push(id);
    }
    return bad;
  }
  it("every top-level line is a type import, an interface, a type, the unique-symbol brand, or a frozen `as const` list", () => {
    expect(bodyViolations(TYPES_TEXT)).toEqual([]);
  });
  it("positive control", () => {
    expect(bodyViolations("export function f() {\n  return 1;\n}")).toEqual(expect.arrayContaining(["export function f() {", "function", "statement"]));
    expect(bodyViolations("export class A {}")).toEqual(expect.arrayContaining(["class"]));
    expect(bodyViolations("export const f = () => 1;")).toEqual(["export const f = () => 1;"]);
    expect(bodyViolations("export const g = () => { return 1; };")).toEqual(expect.arrayContaining(["arrow body", "statement"]));
    expect(bodyViolations("const x = 1;")).toEqual(["const x = 1;"]);
    expect(bodyViolations('export const A_B = Object.freeze(["a"] as const);\nexport type T = (typeof A_B)[number];')).toEqual([]);
    expect(bodyViolations("export interface P {\n  schedule(delayMs: number, onFire: () => void): { cancel(): void };\n}")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Part 3: vocabularies and key lists
// ---------------------------------------------------------------------------------------------------------------------------------
describe("closed vocabularies", () => {
  it("UNSEALED_FAILURE_CODES is pinned, frozen, free of duplicates and of value-like names", () => {
    expect([...UNSEALED_FAILURE_CODES]).toEqual([
      "runner_start_refused", "store_open_failed", "lease_invalid_at_start", "store_failed", "secret_rejected", "manifest_build_failed", "seal_failed", "internal_error",
    ]);
    expect(Object.isFrozen(UNSEALED_FAILURE_CODES)).toBe(true);
    expect(new Set(UNSEALED_FAILURE_CODES).size).toBe(UNSEALED_FAILURE_CODES.length);
    for (const c of UNSEALED_FAILURE_CODES) {
      expect(c, c).toMatch(/^[a-z]+(?:_[a-z]+)*$/);
      expect(c, c).not.toMatch(/value|path|message|name|detail|token|password|credential|key/);
    }
  });
  it("positive control: a value-like code would be reported", () => {
    for (const bad of ["secret_value_found", "bad_path", "error_message", "unknown_name", "api_key_rejected"]) {
      expect(bad).toMatch(/value|path|message|name|detail|token|password|credential|key/);
    }
  });
  it("TERMINATION_REASONS still has the eleven values; the other closed lists did not change", () => {
    expect(TERMINATION_REASONS).toHaveLength(11);
    expect(Object.isFrozen(TERMINATION_REASONS)).toBe(true);
    expect(LEASE_REASONS).toHaveLength(7);
    expect(START_GATE_REFUSAL_CODES).toHaveLength(9);
    // a failure code is not a termination reason
    expect((UNSEALED_FAILURE_CODES as readonly string[]).filter((c) => (TERMINATION_REASONS as readonly string[]).includes(c))).toEqual([]);
  });
});

describe("the interface key lists", () => {
  const keysOf = (source: string, name: string): string[] => {
    const body = new RegExp(`export interface ${name}(?:<[^>]*>)? \\{([\\s\\S]*?)\\n\\}`).exec(stripComments(source))?.[1] ?? "";
    return [...body.matchAll(/^ {2}readonly (\w+)\??:/gm)].map((m) => m[1] as string);
  };
  const bodyOf = (source: string, name: string): string => new RegExp(`export interface ${name}(?:<[^>]*>)? \\{([\\s\\S]*?)\\n\\}`).exec(stripComments(source))?.[1] ?? "";
  const CORE_KEYS = [
    "runId", "wallClock", "terminationReason", "finalHypothesisRevision", "limitsUsed", "provider", "envVarsRead", "payloadAudit", "accessDenial", "configHashes", "leaseFacts",
    "sourceBundleManifest", "effectiveConfig",
  ];
  const FORBIDDEN_KEYS = [
    "schemaVersion", "chain", "artifacts", "toolVersions", "mutualExclusion", "aiSandbox", "legacyStartState", "secretValues", "envValues", "apiKey", "auditConfig", "lease", "leasePort",
    "approval", "approvals", "path", "payload", "ground_truth_access_denial", "isolationChecks", "config", "startup",
  ];
  it("ManifestCore has exactly the thirteen planned keys, in order, and none of the forbidden ones", () => {
    expect(keysOf(TYPES_TEXT, "ManifestCore")).toEqual(CORE_KEYS);
    expect(CORE_KEYS.filter((k) => FORBIDDEN_KEYS.includes(k))).toEqual([]);
    expect(new Set(CORE_KEYS).size).toBe(13);
  });
  it("the nested interfaces of the core have exactly the planned keys", () => {
    const planned: Readonly<Record<string, readonly string[]>> = {
      ManifestWallClock: ["startedAt", "finishedAt"],
      ManifestLimitsUsed: ["iterations", "acceptedExperiments", "rejectedExperiments"],
      ManifestProvider: ["id", "version", "model", "isMock"],
      ManifestEnvVarRead: ["name", "set"],
      ManifestPayloadAudit: ["configCheck", "audits", "passed", "blocked", "auditConfigSha256"],
      ManifestConfigHashes: ["policyConfigSha256", "preparationTableSha256"],
      ManifestLeaseFacts: ["heartbeatIntervalMs", "staleAfterMs", "propagationDelayMs"],
    };
    for (const [name, keys] of Object.entries(planned)) {
      expect(keysOf(TYPES_TEXT, name), name).toEqual(keys);
      expect(keys.filter((k) => FORBIDDEN_KEYS.includes(k)), name).toEqual([]);
    }
  });
  it("the core refers to no startup ticket, audit configuration, lease port, approval, byte buffer or path type", () => {
    const REFS = /\b(?:StartupApproval|AuditConfig\w*|AuditContext\w*|LeasePort|RunLease\w*|\w*Approval\w*|Uint8Array|Buffer|FileSystemPort|RunRecordStore)\b/;
    const names = ["ManifestCore", "ManifestWallClock", "ManifestLimitsUsed", "ManifestProvider", "ManifestEnvVarRead", "ManifestPayloadAudit", "ManifestConfigHashes", "ManifestLeaseFacts"];
    for (const n of names) expect(code(bodyOf(TYPES_TEXT, n)), n).not.toMatch(REFS);
    // positive control
    expect(REFS.test("readonly lease: LeasePort;")).toBe(true);
    expect(REFS.test("readonly cfg: AuditConfigLoadResult;")).toBe(true);
    expect(REFS.test("readonly a: StartupApproval;")).toBe(true);
    expect(REFS.test("readonly b: Uint8Array;")).toBe(true);
  });
  it("positive control: the key parser sees a missing and an extra key", () => {
    expect(keysOf("export interface X {\n  readonly a: number;\n  readonly b?: string;\n}", "X")).toEqual(["a", "b"]);
    expect(keysOf("export interface X {\n  readonly a: number;\n}", "Y")).toEqual([]);
    expect(keysOf("export interface X<T = 1> {\n  // readonly c: number;\n  readonly a: T;\n}", "X")).toEqual(["a"]);
  });
  it("RunResult and RunSummary: no manifest hash outside the sealed summary", () => {
    const c = code(TYPES_TEXT);
    expect(c.match(/\bmanifestSha256\b/g)?.length).toBe(1); // RunSummary only
    expect(keysOf(TYPES_TEXT, "RunSummary")).toEqual(["runId", "terminationReason", "manifestSha256"]);
    expect(c).not.toMatch(/\bsourceBundle\b/);
  });
});
