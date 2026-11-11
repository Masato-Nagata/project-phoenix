// Test helpers for Run directories (task 1.12). The Completion_Marker is written by the Launcher in M2; the helper here
// only lets tests create one. It is not part of the package exports.
import { createHash } from "node:crypto";
import { COMPLETION_MARKER_FILE, MANIFEST_FILE, MemoryFileSystem, RunRecordStore, joinPath, type FileSystemPort, type JsonObject } from "../../src/index.js";

export const RUN_DIR = "/discovery/runs/run-0001";
const h = (c: string): string => c.repeat(64);

export const sha256 = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
export const text = (b: Uint8Array | undefined): string => new TextDecoder().decode(b);
export const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);

/** Everything of a valid Run_Manifest except schemaVersion, chain and artifacts (the store supplies those). */
export function manifestInput(overrides: JsonObject = {}): JsonObject {
  return {
    runId: "run-0001",
    wallClock: { startedAt: "2025-01-01T00:00:00Z", finishedAt: "2025-01-01T00:10:00Z" },
    excludedFields: ["runId", "wallClock"],
    terminationReason: "iteration_limit_reached",
    finalHypothesisRevision: "none",
    config: { schemaVersion: 1, provider: "mock" },
    limitsUsed: { iterations: 1, acceptedExperiments: 1, rejectedExperiments: 0 },
    provider: { id: "mock", version: "1", model: "none", isMock: true },
    toolVersions: { node: "v0.0.0", npm: "0.0.0", dependencies: { ajv: "0.0.0" }, runtimeImageDigest: `sha256:${h("2")}` },
    sourceBundle: {
      schemaVersion: 1,
      hashRule: "sha256 over UTF-8 bytes after CRLF and lone CR are replaced by LF",
      files: [{ path: "src/widgets.php", sha256Lf: h("a") }],
    },
    legacyStartState: { identity: h("3") },
    envVarsRead: [{ name: "EXAMPLE_NAME", set: false }],
    payload_audit: { configCheck: "pass", audits: 1, passed: 1, blocked: 0, auditConfigSha256: h("4") },
    ground_truth_access_denial: { status: "verified", executedInThisRun: true, checks: ["read_denial", "mount_inspection"] },
    isolationChecks: [{ id: "net-none", status: "verified", measuredBy: "launcher", measured: { routes: [] } }],
    mutualExclusion: { mode: "mechanical", lease: { nonceSha256: h("5"), launcherPid: 100, heartbeatIntervalMs: 1000, staleAfterMs: 5000 } },
    aiSandbox: { safetyStatus: "not_applicable", permittedDestinations: [] },
    residualRisks: [{ id: "risk-1", status: "unresolved" }],
    ...overrides,
  };
}

export async function openStore(fs: FileSystemPort & { addDir?(p: string): void }, dir = RUN_DIR): Promise<RunRecordStore> {
  fs.addDir?.(dir);
  const r = await RunRecordStore.open(fs, dir);
  if (!r.ok) throw new Error("open failed");
  return r.value;
}

export interface BuiltRun {
  fs: MemoryFileSystem;
  dir: string;
  manifestSha256: string;
  blobHash: string;
}

/** A sealed Run with 3 records and 1 blob (no Completion_Marker yet). */
export async function buildSealedRun(fs = new MemoryFileSystem(), dir = RUN_DIR): Promise<BuiltRun> {
  const store = await openStore(fs, dir);
  await store.append("run_started", { n: 1 });
  const ai = await store.putAiOutput(bytes("{\"reply\":true}"));
  if (!ai.ok) throw new Error("put");
  await store.append("error", { n: 2 });
  const sealed = await store.seal(manifestInput());
  if (!sealed.ok) throw new Error(`seal failed: ${JSON.stringify(sealed.error)}`);
  return { fs, dir, manifestSha256: sealed.value.sha256, blobHash: ai.value.blob.blob };
}

/** Test helper that creates a Completion_Marker: the SHA-256 of `manifest.json`, written last. */
export async function writeCompletionMarker(fs: FileSystemPort, dir: string, content?: string): Promise<void> {
  const manifest = await fs.readFile(joinPath(dir, MANIFEST_FILE));
  if (manifest === undefined && content === undefined) throw new Error("no manifest.json");
  await fs.writeFileSynced(joinPath(dir, COMPLETION_MARKER_FILE), bytes(content ?? sha256(manifest as Uint8Array)));
}

/** A MemoryFileSystem that records every mutating call and every read, to prove what a function does. */
export class SpyFileSystem extends MemoryFileSystem {
  readonly writes: string[] = [];
  readonly reads: string[] = [];
  override async mkdir(path: string): Promise<void> {
    this.writes.push(`mkdir ${path}`);
    return super.mkdir(path);
  }
  override async writeFileSynced(path: string, data: Uint8Array): Promise<void> {
    this.writes.push(`write ${path}`);
    return super.writeFileSynced(path, data);
  }
  override async rename(from: string, to: string): Promise<void> {
    this.writes.push(`rename ${from}`);
    return super.rename(from, to);
  }
  override async syncDir(path: string): Promise<void> {
    this.writes.push(`syncDir ${path}`);
    return super.syncDir(path);
  }
  override async removeFile(path: string): Promise<void> {
    this.writes.push(`remove ${path}`);
    return super.removeFile(path);
  }
  override async readFile(path: string): Promise<Uint8Array | undefined> {
    this.reads.push(path);
    return super.readFile(path);
  }
  /** Forgets what was recorded so far (building a fixture is not what the test measures). */
  reset(): void {
    this.writes.length = 0;
    this.reads.length = 0;
  }
}
