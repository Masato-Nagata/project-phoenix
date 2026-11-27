// Synthetic recorded Runs for the replay tests (task 4.7, step A2). A recorded Run is made by the REAL stack: the stage B ticket, `composeRun`
// with the real Run_Manifest port, the Loop_Orchestrator (start gate, startRun, the phases, terminate, seal), the REAL production audit adapter
// (`createAuditAdapter`, so the request bytes come from the code of a Run), the Mock_Provider behind the ai-client provider guard, the verifier
// Runner over the verifier FAKE HTTP port, and the RunRecordStore on a MemoryFileSystem. The Completion_Marker is written as the Launcher would.
// All data is synthetic (neutral widget data, fictitious ids and hashes). Nothing here is a measurement or a real Run; nothing reads `evaluation/`.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createProvider, sha256Hex } from "@phoenix/ai-client";
import { COMPLETION_MARKER_FILE, MANIFEST_FILE, RECORDS_FILE, RunRecordStore, acceptRun, canonicalJson, joinPath, type Json, type MemoryFileSystem } from "../../src/index.js";
import { createLoopOrchestrator } from "../../src/orchestrator/loopOrchestrator.js";
import { composeRun } from "../../src/orchestrator/runComposition.js";
import type { RunResult } from "../../src/orchestrator/types.js";
import type { BoundedRead, BoundedReadPort } from "../../src/replay/replayInputs.js";
import { createAuditAdapter } from "../../src/runtime/auditAdapter.js";
import { MockProvider } from "../../../ai-client/src/mock/mockProvider.js";
import type { MockFixture } from "../../../ai-client/src/index.js";
import { RUN_DIR, SOURCE_PATH, TEMPLATE_IDS, buildWorld, testFixtures, type Any, type World, type WorldOptions } from "../support/mockRunWorld.js";
import { SYNTHETIC_RUN_ID } from "../support/syntheticRunId.js";
import { writeCompletionMarker } from "./runFixtures.js";

export { RUN_DIR };
export const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
export const dec = (b: Uint8Array | undefined): string => new TextDecoder().decode(b);
const NONCE = "synthetic-nonce-replay";
const IMAGE_ID = `sha256:${sha("synthetic-image-replay")}`;
const templateSha = (id: string): string => sha256Hex(`synthetic instruction text of ${id}`);

/** The baked policy data of the verifier (synthetic sample data of the repository), as the two explicit external inputs of a replay. */
export const POLICY_BYTES = (): Uint8Array => new Uint8Array(readFileSync(new URL("../../../verifier/data/policy-config.json", import.meta.url)));
export const TABLE_BYTES = (): Uint8Array => new Uint8Array(readFileSync(new URL("../../../verifier/data/preparation-table.json", import.meta.url)));
export const ok = (bytes: Uint8Array): BoundedRead => ({ kind: "ok", bytes });

// ---------------------------------------------------------------------------------------------
// Mock_Provider scripts (neutral, hand-written)
// ---------------------------------------------------------------------------------------------
const DEFAULTS = testFixtures();
const fixtureOf = (kind: string): Uint8Array => (DEFAULTS.find((f) => f.requestKind === kind) as MockFixture).response;
export const EXPERIMENT = {
  accepted: (localKey: string, path = "/orders"): Json => ({
    localKey, target: { kind: "claim", id: "clm-0001" }, requests: [{ method: "GET", path }],
    prediction: { target: { list: "requests", index: 0 }, status: 200, fields: [{ path: "data.state", value: "archived" }] },
  }),
  /** Schema-valid, but the baked policy has no such operation: a policy rejection. */
  rejected: (localKey: string): Json => ({
    localKey, target: { kind: "claim", id: "clm-0001" }, requests: [{ method: "GET", path: "/customers" }],
    prediction: { target: { list: "requests", index: 0 }, status: 200, fields: [{ path: "data.state", value: "archived" }] },
  }),
  /** Schema-valid, but the target is not a claim of the hypothesis: an `experiment_invalid` record. */
  unknownTarget: (localKey: string): Json => ({
    localKey, target: { kind: "claim", id: "clm-9999" }, requests: [{ method: "GET", path: "/orders" }],
    prediction: { target: { list: "requests", index: 0 }, status: 200, fields: [{ path: "data.state", value: "archived" }] },
  }),
};
export interface Script {
  readonly generation?: "default" | "unparseable" | "absent";
  readonly experiments?: readonly Json[] | "absent";
  readonly revision?: "default" | "absent";
}
export function scriptFixtures(s: Script = {}): MockFixture[] {
  const out: MockFixture[] = [];
  const g = s.generation ?? "default";
  if (g === "default") out.push({ requestKind: "hypothesis_generation", response: fixtureOf("hypothesis_generation") });
  if (g === "unparseable") out.push({ requestKind: "hypothesis_generation", response: enc("{ not json") });
  if (s.experiments === undefined) out.push({ requestKind: "experiment_generation", response: fixtureOf("experiment_generation") });
  else if (s.experiments !== "absent") out.push({ requestKind: "experiment_generation", response: enc(JSON.stringify({ experiments: s.experiments })) });
  if ((s.revision ?? "default") === "default") out.push({ requestKind: "hypothesis_revision", response: fixtureOf("hypothesis_revision") });
  return out;
}

// ---------------------------------------------------------------------------------------------
// Recording a Run with the real stack
// ---------------------------------------------------------------------------------------------
function facts(w: World): Any {
  const ok2 = (t: string) => ({ kind: "ok" as const, text: t });
  const lease = JSON.stringify({ heartbeat_interval_ms: 1000, issued_by: "launcher", launcher_pid: 4242, launcher_start_ticks: "630000000000000000", nonce_sha256: sha(NONCE), run_id: SYNTHETIC_RUN_ID, stale_after_ms: 4000 });
  const launcher = JSON.stringify({ schema_version: 2, issued_by: "launcher", run_id: SYNTHETIC_RUN_ID, runtime_image_id: IMAGE_ID, audit_config_sha256: w.approval.auditConfig.sha256, audit_config_kind: "fixture" });
  return {
    lease: { readLeaseJson: () => ok2(lease) },
    launcher: { readLauncherFacts: () => ok2(launcher) },
    versions: {
      readNodeVersion: () => "1.2.3",
      readNpmPackageJson: () => ok2(JSON.stringify({ name: "npm", version: "9.8.7" })),
      readDeclaredPackageJson: () => ok2(JSON.stringify({ dependencies: { ajv: "8.20.0" } })),
      readInstalledPackageJson: (n: string) => ok2(JSON.stringify({ name: n, version: "8.20.0" })),
    },
  };
}

export interface Recorded {
  readonly world: World;
  readonly mem: MemoryFileSystem;
  readonly dir: string;
  readonly result: RunResult;
  /** Calls that reached the Mock_Provider (the provider of the RECORDING; a replay must never reach it). */
  readonly mockCalls: () => number;
  /** Requests the fake Legacy_App saw. */
  readonly legacyRequests: () => number;
}

export interface RecordOptions {
  readonly world?: WorldOptions;
  readonly script?: Script;
  /** Write the Completion_Marker (default true). */
  readonly marker?: boolean;
}

/** One Mock Run through the whole real path, sealed, with the Completion_Marker. */
export async function recordRun(o: RecordOptions = {}): Promise<Recorded> {
  const w = await buildWorld(o.world ?? {});
  let mockCalls = 0;
  const inner = new MockProvider(scriptFixtures(o.script ?? {}));
  const counting = {
    identity: inner.identity,
    complete: (req: Any, opts: Any) => {
      mockCalls += 1;
      return inner.complete(req, opts);
    },
  };
  const provider = createProvider({ provider: "mock" }, { mock: () => counting as Any });
  const templates = new Map<string, string>(Object.values(TEMPLATE_IDS).map((id) => [id, templateSha(id)]));
  const adapter = createAuditAdapter<Any>({ allowlist: [SOURCE_PATH], instructionTemplates: templates, secretValues: [{ name: "PHOENIX_LEASE_NONCE", value: NONCE }] });
  if (!adapter.ok) throw new Error("audit adapter options refused");
  const { manifest: _testOnly, ...rest } = w.deps as Any;
  void _testOnly;
  const deps = {
    ...rest,
    provider,
    audit: {
      prepareAudit: (input: unknown) => adapter.value.prepareAudit(input),
      auditPayload: (bytes: Uint8Array, kind: string, cfg: Any, ctx: Any) => adapter.value.auditPayload(bytes, kind, cfg, ctx),
    },
  };
  const composition = composeRun({ startup: w.approval, nonce: NONCE, facts: facts(w), deps } as Any);
  if (!composition.ok) throw new Error(`composition refused: ${composition.error.code}`);
  const result = await createLoopOrchestrator(composition.value, w.extras).run(w.approval);
  if (!result.sealed) throw new Error(`the recorded Run was not sealed: ${JSON.stringify(result)}`);
  if (o.marker !== false) await writeCompletionMarker(w.mem, RUN_DIR);
  return { world: w, mem: w.mem, dir: RUN_DIR, result, mockCalls: () => mockCalls, legacyRequests: () => w.http.seen.length };
}

// ---------------------------------------------------------------------------------------------
// Read ports over a MemoryFileSystem
// ---------------------------------------------------------------------------------------------
export interface CountingPort extends BoundedReadPort {
  readonly reads: string[];
}
/** The bounded port over a MemoryFileSystem: a file larger than `maxBytes` is refused (`too_large`). Read only. */
export function memoryPort(mem: MemoryFileSystem, after?: (path: string) => void): CountingPort {
  const reads: string[] = [];
  return {
    reads,
    listDir: (p: string) => mem.listDir(p),
    async readBounded(p: string, max: number): Promise<BoundedRead> {
      reads.push(p);
      const b = mem.peek(p);
      after?.(p);
      if (b === undefined) return { kind: "missing" };
      if (b.byteLength > max) return { kind: "too_large" };
      return { kind: "ok", bytes: b };
    },
  };
}

/** Every file of the memory file system with the SHA-256 of its bytes (to prove that nothing was written). */
export const snapshotOf = (mem: MemoryFileSystem): string[] => mem.allFiles().map((f) => `${f} ${sha(mem.peek(f) ?? new Uint8Array(0))}`);

// ---------------------------------------------------------------------------------------------
// Editing a recorded Run into another ACCEPTED Run (the store, the manifest and the marker are rewritten consistently)
// ---------------------------------------------------------------------------------------------
export type Rec = { [k: string]: Json };
export const recordsOf = (mem: MemoryFileSystem, dir = RUN_DIR): Rec[] =>
  dec(mem.peek(joinPath(dir, RECORDS_FILE))).split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Rec);
export const manifestOf = (mem: MemoryFileSystem, dir = RUN_DIR): Rec => JSON.parse(dec(mem.peek(joinPath(dir, MANIFEST_FILE)))) as Rec;

/**
 * Rewrites the record chain (seq, id, prevHash and hash recomputed in order, every other field as `edit` returns it), the records artifact
 * and `chain` of the manifest (plus `editManifest`), the manifest bytes (canonical, one LF) and the Completion_Marker. Blobs in `addBlobs` are
 * written and listed. The Run is accepted afterwards (the reader acceptance does not validate payloads); that is what the replay must catch.
 */
export async function rewriteRun(
  mem: MemoryFileSystem,
  edit: (records: Rec[]) => Rec[],
  options: { readonly editManifest?: (m: Rec) => void; readonly addBlobs?: readonly Uint8Array[]; readonly keepIds?: boolean; readonly dir?: string } = {},
): Promise<void> {
  const dir = options.dir ?? RUN_DIR;
  const edited = edit(recordsOf(mem, dir).map((r) => JSON.parse(JSON.stringify(r)) as Rec));
  let prev = "0".repeat(64);
  const lines: string[] = [];
  edited.forEach((r, i) => {
    const head: Rec = { ...r };
    delete head["hash"];
    if (options.keepIds !== true) {
      head["seq"] = i + 1;
      head["id"] = `rec-${String(i + 1).padStart(6, "0")}`;
    }
    head["prevHash"] = prev;
    const hash = sha(canonicalJson(head as Json));
    prev = hash;
    lines.push(canonicalJson({ ...head, hash } as Json));
  });
  const recordsBytes = enc(lines.length === 0 ? "" : `${lines.join("\n")}\n`);
  mem.poke(joinPath(dir, RECORDS_FILE), recordsBytes);
  const manifest = manifestOf(mem, dir);
  const artifacts = (manifest["artifacts"] as { path: string; sha256: string }[]).filter((a) => a.path !== RECORDS_FILE);
  artifacts.push({ path: RECORDS_FILE, sha256: sha(recordsBytes) });
  for (const b of options.addBlobs ?? []) {
    const h = sha(b);
    mem.poke(joinPath(dir, `blobs/${h}`), b);
    if (!artifacts.some((a) => a.path === `blobs/${h}`)) artifacts.push({ path: `blobs/${h}`, sha256: h });
  }
  artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  manifest["artifacts"] = artifacts as unknown as Json;
  manifest["chain"] = { records: edited.length, lastHash: prev };
  options.editManifest?.(manifest);
  const out = enc(`${canonicalJson(manifest as Json)}\n`);
  mem.poke(joinPath(dir, MANIFEST_FILE), out);
  mem.poke(joinPath(dir, COMPLETION_MARKER_FILE), enc(sha(out)));
  const accepted = await acceptRun(mem, dir);
  if (!accepted.accepted) throw new Error(`the rewritten Run is not accepted: ${accepted.reason}`);
}

/** Replaces the termination reason in the record and in the manifest. */
export const setTermination = (reason: string): { edit: (r: Rec[]) => Rec[]; editManifest: (m: Rec) => void } => ({
  edit: (r) => r.map((x) => (x["kind"] === "termination" ? { ...x, payload: { terminationReason: reason } } : x)),
  editManifest: (m) => {
    m["terminationReason"] = reason;
  },
});

/** The index of the n-th record (0-based n) of a kind. */
export const indexOf = (records: readonly Rec[], kind: string, n = 0): number => {
  let seen = -1;
  for (let i = 0; i < records.length; i += 1) if (records[i]?.["kind"] === kind && (seen += 1) === n) return i;
  throw new Error(`no ${kind} number ${n}`);
};

/** A store-level re-seal is not needed by the tests; the store class is re-exported for the unit tests that build their own records. */
export { RunRecordStore };
