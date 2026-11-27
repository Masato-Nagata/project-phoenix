// Synthetic, sealed Run directories for the reproducibility comparison tests (task 4.7, step A1). Every Run is built with the real
// RunRecordStore (so it is a genuinely sealed, accepted Run) on a MemoryFileSystem. Nothing here is a measurement or a real Run.
import { COMPLETION_MARKER_FILE, MANIFEST_FILE, RECORDS_FILE, canonicalJson, joinPath, type Json, type JsonObject, type MemoryFileSystem } from "../../src/index.js";
import { bytes, manifestInput, openStore, sha256, text, writeCompletionMarker } from "./runFixtures.js";

export type Step =
  | { op: "append"; kind: "run_started" | "error"; payload: JsonObject }
  | { op: "blob"; content: string };

export const dirOf = (name: string): string => `/discovery/runs/${name}`;
export const appendStep = (kind: "run_started" | "error", payload: JsonObject = {}): Step => ({ op: "append", kind, payload });

/** Three records: run_started, error n=1, error n=2. */
export const BASE_STEPS: readonly Step[] = [appendStep("run_started"), appendStep("error", { n: 1 }), appendStep("error", { n: 2 })];

export interface SealedFixture {
  dir: string;
  manifestSha256: string;
}

/** Writes a sealed Run (records, blobs, manifest) and, unless `marker` is false, the Completion_Marker. */
export async function sealRun(
  fs: MemoryFileSystem,
  name: string,
  steps: readonly Step[] = BASE_STEPS,
  manifest: JsonObject = {},
  marker = true,
): Promise<SealedFixture> {
  const dir = dirOf(name);
  const store = await openStore(fs, dir);
  for (const s of steps) {
    const r = s.op === "append" ? await store.append(s.kind, s.payload) : await store.putAiOutput(bytes(s.content));
    if (!r.ok) throw new Error(`fixture write failed: ${JSON.stringify(r.error)}`);
  }
  const sealed = await store.seal(manifestInput({ runId: name, ...manifest }));
  if (!sealed.ok) throw new Error(`seal failed: ${JSON.stringify(sealed.error)}`);
  if (marker) await writeCompletionMarker(fs, dir);
  return { dir, manifestSha256: sealed.value.sha256 };
}

/** Rewrites manifest.json through `change` (canonical form, one LF) and the Completion_Marker to match, like a second legitimate seal. */
export async function rewriteSealedManifest(fs: MemoryFileSystem, dir: string, change: (manifest: { [k: string]: Json }) => void): Promise<string> {
  const manifest = JSON.parse(text(fs.peek(joinPath(dir, MANIFEST_FILE)))) as { [k: string]: Json };
  change(manifest);
  const out = bytes(`${canonicalJson(manifest)}\n`);
  fs.poke(joinPath(dir, MANIFEST_FILE), out);
  fs.poke(joinPath(dir, COMPLETION_MARKER_FILE), bytes(sha256(out)));
  return sha256(out);
}

/**
 * Re-writes `records.jsonl` so that every line is the same record in a different raw form (keys in reverse order), then seals the new
 * file hash into the manifest. The hash chain still verifies (hashes are recomputed from the parsed record), so the Run is accepted,
 * but the raw bytes of `records.jsonl` differ from the original.
 */
export async function reformatRecordsRaw(fs: MemoryFileSystem, dir: string): Promise<void> {
  const path = joinPath(dir, RECORDS_FILE);
  const lines = text(fs.peek(path)).split("\n").filter((l) => l !== "");
  const reformatted = lines.map((l) => JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(l) as Record<string, unknown>).reverse())));
  const next = bytes(`${reformatted.join("\n")}\n`);
  fs.poke(path, next);
  await rewriteSealedManifest(fs, dir, (m) => {
    const artifacts = m["artifacts"] as { path: string; sha256: string }[];
    const entry = artifacts.find((a) => a.path === RECORDS_FILE);
    if (entry === undefined) throw new Error("no records artifact");
    entry.sha256 = sha256(next);
  });
}