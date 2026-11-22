// Test support for task 4.4, unit U7: the composition root of a MOCK RUN, built from the REAL adapters of the sibling packages and in-memory ports.
// Real: the orchestrator, the startup ticket (stage B, with the real policy loader and the real audit configuration parser), the RunRecordStore on a
// MemoryFileSystem, the ai-client Mock_Provider behind the provider wrapper, `auditPayload`, the response gate, the verifier Runner / Comparator /
// policy / acceptance check (with a FAKE http port: no network), and the analyzer Source_Bundler and Citation_Verifier on an in-memory file system.
// Fake: the lease (the verifier FakeLease), the clocks and the timers. All data is synthetic. Nothing here reads `evaluation/`, a secret or a real path.
//
// `prepareAudit` (the AuditPort of U7) builds ONE normalized snapshot from `records` (id -> kind, canonical JSON of the record PAYLOAD, sha256 of that
// canonical JSON). The envelope bytes (the stored parts: content and `recordSha256`) AND the `lookupRecord` of the AuditContext are both derived from
// that one map, so they cannot disagree.
import { createSchemaValidator } from "../../src/schema/index.js";
import { MANIFEST_FILE, MemoryFileSystem, RunRecordStore, checkStartupRefusals, validateRunConfig, type FileSystemPort, type RunConfig } from "../../src/index.js";
import type { StartupApproval } from "../../src/config/startup.js";
import type { RecordEnvelope } from "../../src/store/runRecordStore.js";
import type { SemanticSha256Of } from "../../src/orchestrator/hypothesisPhase.js";
import { createLoopOrchestrator, type LoopExtras, type LoopOrchestrator } from "../../src/orchestrator/loopOrchestrator.js";
import type { AuditContextHandle, LoopDeps, PrepareAuditInput, RunResult, StoredPartRef, TimerPort } from "../../src/orchestrator/types.js";
import { MockProvider } from "../../../ai-client/src/mock/mockProvider.js";
import {
  DEFAULT_MOCK_FIXTURES, auditPayload, canonicalJson, createProvider, gateProviderResult, gateResponse, resolveResponseLimits, sha256Hex,
} from "../../../ai-client/src/index.js";
import type { AuditContext, AuditedRequest, Json, MockFixture, RequestKind, StoredRecordView } from "../../../ai-client/src/index.js";
import { MANIFEST_HASH_RULE, buildSourceBundle, validateDeclarations, validateExpr, verifyCitations } from "../../../analyzer/src/index.js";
import { MemFs, makeRepo } from "../../../analyzer/test/helpers/bundleFixtures.js";
import { createAcceptanceCheck, evaluateForRecord } from "../../../verifier/src/identity/acceptance.js";
import { compare } from "../../../verifier/src/compare/compare.js";
import { createRunner } from "../../../verifier/src/runner/runner.js";
import { DEFAULT_ADDRESS_POLICY } from "../../../verifier/src/index.js";
import { FakeTime } from "../../../verifier/test/helpers/leaseFixtures.js";
import { FakeHttp, FakeLease } from "../../../verifier/test/helpers/runnerFixtures.js";
import { manifestInput } from "../helpers/runFixtures.js";
import { passingIsolation } from "./orchestratorFakes.js";
import { auditPort, envPort, policyPort, syntheticAuditConfig, toBytes } from "./startupAdapters.js";
import { SYNTHETIC_RUN_ID } from "./syntheticRunId.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

export const RUN_DIR = "/run/out";
export const REPO_ROOT = "/repo";
export const SOURCE_PATH = "legacy/src/utils.php";
export const SOURCE_TEXT = "<?php\n// synthetic helper of the mock run\n";
/** Values of the audit configuration that live inside the startup ticket; none of them may appear in any artifact, payload or log. */
export const APPROVAL_CANARIES = ["SYNTHETIC-CANARY-0001", "SYNTHETIC-DECOY-0001"] as const;
export const SECRET_PATTERN_ID = "synthetic-secret";
export const SECRET_TEXT = "SYNTHETIC-SECRET-0001";
export const TEMPLATE_IDS = { hypothesisGeneration: "hypothesis-generation-v1", experimentGeneration: "experiment-generation-v1", hypothesisRevision: "hypothesis-revision-v1" } as const;

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const templateSha = (id: string): string => sha256Hex(`synthetic instruction text of ${id}`);

// ---------------------------------------------------------------------------------------------------------------------------------
// prepareAudit
// ---------------------------------------------------------------------------------------------------------------------------------
/** One normalized snapshot entry: the single source of the envelope parts and of `lookupRecord`. */
export interface SnapshotEntry {
  readonly kind: string;
  readonly canonicalJson: string;
  readonly sha256: string;
}
export interface PreparedAudit {
  readonly kind: string;
  readonly bytes: Uint8Array;
  readonly ctx: AuditContext;
  readonly snapshot: ReadonlyMap<string, SnapshotEntry>;
  readonly partIds: readonly string[];
}
export interface PrepareOptions {
  readonly allowlist: readonly string[];
  /** Test hook: rewrites the partId of a stored part (used to force a duplicate partId). */
  readonly rewriteStoredPartId?: (partId: string) => string;
  readonly onPrepared?: (p: PreparedAudit) => void;
}
type PrepareResult = { readonly ok: true; readonly value: { readonly bytes: Uint8Array; readonly ctx: AuditContextHandle } } | { readonly ok: false; readonly error: { readonly code: "prepare_failed" } };
const PREPARE_FAILED: PrepareResult = Object.freeze({ ok: false as const, error: Object.freeze({ code: "prepare_failed" as const }) });

export function prepareAuditFrom(input: PrepareAuditInput, opts: PrepareOptions): PrepareResult {
  try {
    const bundle = input.bundle as { manifest?: readonly { path: string; sha256Lf: string }[]; files?: readonly { path: string; text: string }[] };
    if (!Array.isArray(bundle.manifest) || !Array.isArray(bundle.files) || bundle.manifest.length !== bundle.files.length) return PREPARE_FAILED;
    const templateId = input.templateId;
    if (!(Object.values(TEMPLATE_IDS) as string[]).includes(templateId)) return PREPARE_FAILED;
    // the ONE snapshot
    const snapshot = new Map<string, SnapshotEntry>();
    for (const r of input.records) {
      const canon = canonicalJson(r.payload as Json);
      snapshot.set(r.id, Object.freeze({ kind: r.kind, canonicalJson: canon, sha256: sha256Hex(canon) }));
    }
    const sourceParts = bundle.manifest.map((m, i) => {
      const file = bundle.files?.[i];
      if (file === undefined || file.path !== m.path || sha256Hex(file.text.replace(/\r\n?/g, "\n")) !== m.sha256Lf) throw new Error("bundle inconsistent");
      return { partId: `src-${i + 1}`, type: "source_file", path: m.path, sha256Lf: m.sha256Lf, text: file.text };
    });
    const seen = new Set<string>(sourceParts.map((p) => p.partId));
    const storedParts = input.stored.map((ref: StoredPartRef) => {
      const entry = snapshot.get(ref.recordId);
      if (entry === undefined || entry.kind !== ref.type) throw new Error("stored reference unknown");
      const partId = opts.rewriteStoredPartId === undefined ? ref.partId : opts.rewriteStoredPartId(ref.partId);
      if (seen.has(partId)) throw new Error("duplicate partId");
      seen.add(partId);
      return { partId, type: ref.type, recordId: ref.recordId, recordSha256: entry.sha256, content: JSON.parse(entry.canonicalJson) as Json };
    });
    const envelope = {
      schemaVersion: 1,
      kind: input.kind,
      instruction: { templateId, sha256: templateSha(templateId) },
      parts: [...sourceParts, ...storedParts],
    };
    const bytes = enc(canonicalJson(envelope as unknown as Json));
    const ctx: AuditContext = {
      bundle: { manifest: bundle.manifest.map((m) => ({ path: m.path, sha256Lf: m.sha256Lf })) },
      allowlist: opts.allowlist,
      lookupRecord: (id: string): StoredRecordView | undefined => {
        try {
          const e = snapshot.get(id);
          return e === undefined ? undefined : { kind: e.kind, sha256: e.sha256, canonicalJson: e.canonicalJson };
        } catch {
          return undefined;
        }
      },
      instructionTemplates: new Map([[templateId, templateSha(templateId)]]),
      secretValues: [{ name: "FICTIONAL_API_KEY", value: "sk-fictional-0123456789abcdef" }],
    };
    opts.onPrepared?.({ kind: input.kind, bytes, ctx, snapshot, partIds: [...seen] });
    return { ok: true, value: { bytes, ctx: ctx as unknown as AuditContextHandle } };
  } catch {
    return PREPARE_FAILED;
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------------------------------------------------------------
const defaultFixture = (kind: RequestKind): string => dec((DEFAULT_MOCK_FIXTURES.find((f) => f.requestKind === kind) as MockFixture).response);

/** The default fixtures plus a TEST-ONLY `hypothesis_revision`: the default claim `clm-0001` revised once more, with its own text. */
export function testFixtures(o: { secretInGeneration?: boolean; padGenerationToBytes?: number } = {}): MockFixture[] {
  const generation = JSON.parse(defaultFixture("hypothesis_generation")) as Any;
  if (o.secretInGeneration === true) generation.claims[0].openQuestions = [`question with ${SECRET_TEXT} inside`];
  const revision = JSON.parse(defaultFixture("hypothesis_revision")) as Any;
  revision.claims[0].effect.description = "The response status is 200 for a request that only reads data (test-only revision).";
  revision.claims[0].openQuestions = ["Is the revision stable?"];
  let generationBytes = enc(JSON.stringify(generation));
  if (o.padGenerationToBytes !== undefined) {
    // valid JSON whitespace after the value: the response stays valid and the schema validator sees the same document
    if (generationBytes.byteLength > o.padGenerationToBytes) throw new Error("the generation response is larger than the requested size");
    const padded = new Uint8Array(o.padGenerationToBytes).fill(0x20);
    padded.set(generationBytes);
    generationBytes = padded;
  }
  return [
    { requestKind: "hypothesis_generation", response: generationBytes },
    ...DEFAULT_MOCK_FIXTURES.filter((f) => f.requestKind === "experiment_generation"),
    { requestKind: "hypothesis_revision", response: enc(JSON.stringify(revision)) },
  ];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// the world
// ---------------------------------------------------------------------------------------------------------------------------------
export interface WorldOptions {
  readonly iterations?: number;
  /** Replaces the store `append` answer for the nth write of `kind` (a failure that the store itself would report). */
  readonly failAppend?: { readonly kind: string; readonly error: "io_failure" | "invalid_record"; readonly nth?: number };
  readonly secretInGeneration?: boolean;
  /** The Source_Bundler cannot read the listed file: EACCES (an isolation violation). */
  readonly denyRead?: boolean;
  /** The allowlist document is missing: the build fails with ENOENT (not a violation). */
  readonly missingAllowlist?: boolean;
  readonly rewriteStoredPartId?: (partId: string) => string;
  /** Test-only: the manifest port leaks the whole startup ticket into the manifest (the positive control of the canary scan). */
  readonly leakApproval?: boolean;
  /** Called inside `complete` of the provider, before the answer (receives the 1-based call number). */
  readonly onProviderCall?: (n: number, w: World) => void;
  readonly healthFails?: boolean;
  /** Run limits of the ticket (for example `responseBytes`); merged over `iterations`. */
  readonly limits?: Record<string, number>;
  /** Test-only: the first Mock_Provider response (hypothesis_generation) is padded with JSON whitespace to exactly this many bytes. */
  readonly padGenerationToBytes?: number;
  /** Test-only: the text of the one allowlisted source file (synthetic data only). */
  readonly sourceText?: string;
}

export interface TimerEntry {
  readonly delay: number;
  readonly fire: () => void;
  cancelled: number;
}
export interface ProviderCall {
  readonly kind: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
}

export interface World {
  readonly approval: StartupApproval<Any, Any, Any, Any>;
  readonly orchestrator: LoopOrchestrator<Any, Any, Any, Any>;
  readonly run: () => Promise<RunResult>;
  readonly mem: MemoryFileSystem;
  readonly time: FakeTime;
  readonly http: FakeHttp;
  readonly lease: FakeLease;
  readonly timers: TimerEntry[];
  readonly prepared: PreparedAudit[];
  readonly providerCalls: ProviderCall[];
  readonly appended: string[];
  readonly analysisFs: MemFs;
  readonly bundleFiles: readonly { path: string; text: string }[];
  readonly deps: LoopDeps<Any, Any, Any, Any, Any>;
  readonly extras: LoopExtras;
  /** From now on every store write fails with `io_failure` (the store went down). */
  armStoreFailure(): void;
  store(): RunRecordStore | undefined;
  records(): readonly RecordEnvelope[];
  manifestExists(): boolean;
}

/** Every byte of every file of the Run_Volume (records, blobs, manifest) as text. */
export function volumeText(mem: MemoryFileSystem): string {
  return mem.allFiles().map((f) => `${f}\n${dec(mem.peek(f) ?? new Uint8Array(0))}`).join("\n");
}

async function issueTicket(limits: Record<string, number>, lease: FakeLease): Promise<StartupApproval<Any, Any, Any, Any>> {
  const v = validateRunConfig({
    schemaVersion: 1, provider: "mock", limits, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: ["data.created_at"] }, envNames: ["EXAMPLE_ONE"],
  });
  if (!v.ok) throw new Error(`the test configuration is invalid: ${JSON.stringify(v.error)}`);
  const cfg: RunConfig = v.value;
  const ports: Any = {
    policy: policyPort(),
    auditConfig: auditPort(() => toBytes(syntheticAuditConfig())),
    env: envPort({ EXAMPLE_ONE: "synthetic" }),
    sandbox: { providerAvailable: () => true, destinations: () => ["relay.example.invalid"] },
    lease: {
      variables: () => ({ runId: true, nonce: true }),
      timing: () => ({ ok: true, heartbeatIntervalMs: 1000, staleAfterMs: 4000, propagationDelayMs: 123 }),
      port: () => lease,
      check: () => Promise.resolve({ valid: true, runId: SYNTHETIC_RUN_ID }),
    },
    io: { runVolume: () => ({ exists: true, writable: true, empty: true }), configFiles: () => ["run-config.json", "audit-config.json"] },
  };
  const r = await checkStartupRefusals(cfg, ports);
  if (!r.ok) throw new Error(`expected a ticket, got ${JSON.stringify(r.error)}`);
  return r.value as StartupApproval<Any, Any, Any, Any>;
}

export async function buildWorld(o: WorldOptions = {}): Promise<World> {
  const time = new FakeTime();
  time.t = 1_000;
  const lease = new FakeLease();
  const http = new FakeHttp(time, lease);
  const approval = await issueTicket({ iterations: o.iterations ?? 2, ...(o.limits ?? {}) }, lease);

  // analysis file system: one allowlisted file, the two allowlist documents
  const repo = makeRepo([SOURCE_PATH], { texts: { [SOURCE_PATH]: o.sourceText ?? SOURCE_TEXT } });
  if (o.denyRead === true) repo.entries.set(`${REPO_ROOT}/${SOURCE_PATH}`, { kind: "file", bytes: enc(SOURCE_TEXT), unreadable: true });
  if (o.missingAllowlist === true) repo.entries.delete(`${REPO_ROOT}/docs/ai-input-allowlist.json`);

  // the Run_Volume and the store (with the optional faults)
  const mem = new MemoryFileSystem();
  mem.addDir(RUN_DIR);
  let store: RunRecordStore | undefined;
  let down = false;
  const seen = new Map<string, number>();
  const appended: string[] = [];
  const storeFactory = {
    async open(fs: FileSystemPort, dir: string): Promise<Any> {
      const r = await RunRecordStore.open(fs, dir, { secrets: { patterns: [{ id: SECRET_PATTERN_ID, source: "SYNTHETIC-SECRET-[0-9]{4}" }] } });
      if (!r.ok) return r;
      store = r.value;
      const real = r.value.append.bind(r.value);
      (r.value as Any).append = async (kind: string, payload: Any, options: Any): Promise<Any> => {
        appended.push(kind);
        const n = (seen.get(kind) ?? 0) + 1;
        seen.set(kind, n);
        if (down) return { ok: false, error: { kind: "io_failure", message: "store down" } };
        const f = o.failAppend;
        if (f !== undefined && f.kind === kind && n === (f.nth ?? 1)) return { ok: false, error: { kind: f.error, message: "injected" } };
        return real(kind as never, payload, options);
      };
      return r;
    },
  };

  // provider: the real Mock_Provider behind the real wrapper, with a spy on what reaches it
  const providerCalls: ProviderCall[] = [];
  const inner = new MockProvider(
    testFixtures({
      ...(o.secretInGeneration === true ? { secretInGeneration: true } : {}),
      ...(o.padGenerationToBytes === undefined ? {} : { padGenerationToBytes: o.padGenerationToBytes }),
    }),
  );
  // eslint-disable-next-line prefer-const
  let world: World;
  let callNumber = 0;
  const spy = {
    identity: inner.identity,
    complete: (req: AuditedRequest, opts: { timeoutMs: number; signal: AbortSignal }): Promise<Any> => {
      callNumber += 1;
      providerCalls.push({ kind: req.kind, sha256: req.sha256, bytes: new Uint8Array(req.bytes) });
      o.onProviderCall?.(callNumber, world);
      return inner.complete(req, opts);
    },
  };
  const provider = createProvider({ provider: "mock" }, { mock: () => spy as Any });

  const timers: TimerEntry[] = [];
  const timerPort: TimerPort = {
    schedule(delay, onFire) {
      const entry: TimerEntry = { delay, fire: onFire, cancelled: 0 };
      timers.push(entry);
      return { cancel: () => { entry.cancelled += 1; } };
    },
  };
  let wall = 0;
  const prepared: PreparedAudit[] = [];
  const auditConfigAllowlist = [SOURCE_PATH];
  const limitsOfRunner = (v: Any): Any => ({ requestTimeoutMs: v.requestTimeoutMs, experimentTimeoutMs: v.experimentTimeoutMs });

  const deps = {
    isolation: passingIsolation().deps,
    fs: mem,
    runVolumeDir: RUN_DIR,
    clock: { nowMs: (): number => time.t },
    wallClock: { nowIso: (): string => `2025-01-01T00:00:${String(10 * wall++).padStart(2, "0")}Z` },
    timers: timerPort,
    provider,
    audit: {
      prepareAudit: (input: PrepareAuditInput) =>
        prepareAuditFrom(input, {
          allowlist: auditConfigAllowlist,
          ...(o.rewriteStoredPartId === undefined ? {} : { rewriteStoredPartId: o.rewriteStoredPartId }),
          onPrepared: (p) => prepared.push(p),
        }),
      auditPayload: (bytes: Uint8Array, kind: string, cfg: Any, ctx: AuditContextHandle) => auditPayload(bytes, kind as RequestKind, cfg, ctx as unknown as AuditContext),
    },
    responseGate: { gateProviderResult, gateResponse, resolveResponseLimits },
    policy: { evaluateForRecord, createAcceptanceCheck },
    runnerFactory: (input: Any) => {
      const runner = createRunner({
        http,
        lease: input.lease,
        prepTable: input.table,
        policy: input.policy,
        mask: input.mask,
        baseAddress: input.baseAddress,
        addressPolicy: DEFAULT_ADDRESS_POLICY,
        limits: limitsOfRunner(input.limits),
        clock: time,
        isAccepted: input.isAccepted,
      });
      if (o.healthFails !== true) return runner;
      return { health: async () => ({ ok: false as const, error: "unhealthy" }), execute: runner.execute.bind(runner) };
    },
    comparator: { compare },
    analysisFs: repo,
    repoRoot: REPO_ROOT,
    analysis: { buildSourceBundle, verifyCitations, validateDeclarations, validateExpr },
    storeFactory,
    manifest: {
      build: (core: Any) => {
        if (core.sourceBundleManifest === undefined) throw new Error("no Source_Bundle: no manifest");
        const config: Any = { ...core.effectiveConfig };
        if (o.leakApproval === true) config.leaked = JSON.stringify(approval);
        return manifestInput({
          runId: core.runId,
          wallClock: core.wallClock,
          terminationReason: core.terminationReason,
          finalHypothesisRevision: core.finalHypothesisRevision,
          config,
          limitsUsed: core.limitsUsed,
          provider: core.provider,
          sourceBundle: { schemaVersion: 1, hashRule: MANIFEST_HASH_RULE, files: core.sourceBundleManifest.files },
          envVarsRead: core.envVarsRead,
          payload_audit: core.payloadAudit,
          mutualExclusion: {
            mode: "mechanical",
            lease: { nonceSha256: "5".repeat(64), launcherPid: 100, heartbeatIntervalMs: core.leaseFacts.heartbeatIntervalMs, staleAfterMs: core.leaseFacts.staleAfterMs },
          },
        });
      },
    },
  } as unknown as LoopDeps<Any, Any, Any, Any, Any>;

  const sha: SemanticSha256Of = (v) => {
    try {
      return { ok: true, value: sha256Hex(canonicalJson(v as unknown as Json)) };
    } catch {
      return { ok: false, error: { code: "semantic_hash_failed" } };
    }
  };
  const limits = approval.config.limits;
  const extras: LoopExtras = {
    validator: createSchemaValidator(),
    semanticSha256Of: sha,
    templateIds: TEMPLATE_IDS,
    responseLimits: (() => {
      const r = resolveResponseLimits({ maxResponseBytes: limits.responseBytes, maxExperiments: limits.experimentsPerResponse });
      if (!r.ok) throw new Error("response limits");
      return { hypothesisGeneration: r.value, experimentGeneration: r.value, hypothesisRevision: r.value };
    })(),
  };
  const orchestrator = createLoopOrchestrator(deps, extras);
  world = {
    approval,
    orchestrator,
    run: () => orchestrator.run(approval),
    mem,
    time,
    http,
    lease,
    timers,
    prepared,
    providerCalls,
    appended,
    analysisFs: repo,
    bundleFiles: [{ path: SOURCE_PATH, text: o.sourceText ?? SOURCE_TEXT }],
    deps,
    extras,
    armStoreFailure: () => {
      down = true;
    },
    store: () => store,
    records: () => store?.list() ?? [],
    manifestExists: () => mem.allFiles().includes(`${RUN_DIR}/${MANIFEST_FILE}`),
  };
  return world;
}
