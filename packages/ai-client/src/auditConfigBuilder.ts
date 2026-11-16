// Audit_Config_Builder (task 3.7; R2.8, R2.9, R2.12, R15.3; design "Audit_Config_Builder" and "How fingerprints are produced").
//
// A host-side preparation step that produces the audit configuration read by the Payload_Auditor. It is NOT part of the runtime:
// - it is not exported from the package entry `src/index.ts`, no other module of the package imports it (static check), and the package
//   `exports` map blocks deep imports;
// - from this package it uses only the pure `tokenize` and `ngramHashes` (the same functions as the auditor, so the two cannot disagree on
//   tokenization); everything else is a type or standard library code;
// - it holds no path of its own and does no file access. The restricted files, the allowed corpus and the output path are given by the host
//   run step (a container with `--network none` that mounts the inputs read-only); the reading and writing go through `BuilderIo`;
// - it never prints or returns a canary, decoy or fingerprint value: the summary has identifiers, counts and the hash of the output only.
// Running it against the real restricted files needs a separate human approval; this task is tested with synthetic fixtures only.
import { createHash } from "node:crypto";
import type { AuditConfig } from "./audit/types.js";
import { ngramHashes, tokenize } from "./tokenizer.js";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/** Default n-gram size of the design (`n = 12`); a test checks that it equals `DEFAULT_NGRAM_SIZE` of the tokenizer module. */
export const BUILDER_DEFAULT_N = 12;
/** Value of `tokenizer` in the configuration; the type of `AuditConfig` makes a drift of the identifier a compile error. */
const TOKENIZER: AuditConfig["tokenizer"] = "token-ngram-sha256-v1";
const MIN_N = 6; // schema: n >= 6
const MIN_FINGERPRINT_SETS = 4; // schema: at least 4 sets
const MIN_SECRET_LENGTH = 8; // schema: canary and decoy values have at least 8 characters
const DEFAULT_DECOY_COUNT = 2;
const DECOY_RANDOM_CHARS = 24;

export interface RestrictedFileInput {
  /** Identifier of the file in the configuration (`fileId`); never its path. */
  readonly fileId: string;
  readonly kind: "text" | "json";
  /** The file content as text (UTF-8). */
  readonly content: string;
  /** For a JSON file: subtrees that hold observed responses and are left out of the fingerprints (OD-4). JSON pointers; `*` matches any key or index. */
  readonly excludeSubtrees?: readonly string[];
  /** For a JSON file: pointers to string values that become canaries (the canary field of the Ground_Truth). */
  readonly canaryPointers?: readonly string[];
}
export interface CorpusInput {
  readonly id: string;
  readonly text: string;
}
export interface BuildInput {
  readonly restricted: readonly RestrictedFileInput[];
  /** Everything the runtime may legitimately send: the allowlisted source files, the instruction templates, the Test API operation names. */
  readonly corpus: readonly CorpusInput[];
  readonly allowlist: readonly string[];
  readonly restrictedPathPrefixes: readonly string[];
  readonly n?: number;
  readonly decoyCount?: number;
  /** Source of the decoy values: `chars` random lowercase hexadecimal characters. Injected, so that a test can be repeatable. */
  readonly randomHex: (chars: number) => string;
}

export type BuilderErrorCode =
  | "n_invalid" | "decoy_count_invalid" | "input_invalid" | "too_few_restricted_files" | "duplicate_id" | "invalid_json"
  | "pointer_invalid" | "canary_missing" | "canary_not_string" | "canary_too_short" | "decoy_invalid" | "fingerprint_set_empty"
  | "output_path_forbidden" | "output_path_is_input" | "input_unreadable" | "input_not_utf8" | "output_unwritable";
/** `id` names the input (a file id, a corpus id or an output role); it never carries content. */
export interface BuilderError {
  readonly code: BuilderErrorCode;
  readonly id?: string;
}

export interface FingerprintSummary {
  readonly id: string;
  readonly fileId: string;
  readonly n: number;
  readonly hashCount: number;
  /** Number of nodes removed by the observed-response patterns of this file, per pattern, in the order given. */
  readonly excludedNodes: readonly number[];
}
/** Identifiers, counts and the hash of the output. No canary, decoy or fingerprint value, no restricted text. */
export interface BuildSummary {
  readonly outputSha256: string;
  readonly canaryIds: readonly string[];
  readonly decoyIds: readonly string[];
  readonly fingerprintSets: readonly FingerprintSummary[];
  readonly allowlistCount: number;
  readonly restrictedPathPrefixCount: number;
  readonly residuals: readonly string[];
}
export interface BuildOutput {
  /** The configuration as UTF-8 JSON bytes (stable key order, sorted lists, no whitespace). */
  readonly bytes: Uint8Array;
  readonly summary: BuildSummary;
}

const isObj = (v: unknown): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);
const err = (code: BuilderErrorCode, id?: string): Result<never, BuilderError> => ({ ok: false, error: id === undefined ? { code } : { code, id } });
const sortedUnique = (xs: readonly string[]): string[] => [...new Set(xs)].sort();
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

// ---- JSON pointers ----
function pointerTokens(p: string): string[] | undefined {
  if (!p.startsWith("/")) return undefined;
  const raw = p.slice(1).split("/");
  const out: string[] = [];
  for (const t of raw) {
    if (/~(?![01])/.test(t)) return undefined;
    out.push(t.replaceAll("~1", "/").replaceAll("~0", "~"));
  }
  return out;
}
function resolvePointer(root: Json, tokens: readonly string[]): Json | undefined {
  let cur: Json | undefined = root;
  for (const t of tokens) {
    if (Array.isArray(cur)) cur = /^(0|[1-9][0-9]*)$/.test(t) ? cur[Number(t)] : undefined;
    else if (isObj(cur)) cur = Object.hasOwn(cur, t) ? cur[t] : undefined;
    else return undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}
/** Removes the nodes matched by `segs` (`*` matches any key or index). An array element is replaced by null so that no index shifts. */
function prune(node: Json, segs: readonly string[], counter: { n: number }): Json {
  const [head, ...rest] = segs;
  if (head === undefined) return node;
  if (Array.isArray(node)) {
    return node.map((child, i) => {
      if (head !== "*" && head !== String(i)) return child;
      if (rest.length === 0) {
        counter.n++;
        return null;
      }
      return prune(child, rest, counter);
    });
  }
  if (isObj(node)) {
    const entries: [string, Json][] = [];
    for (const [k, v] of Object.entries(node)) {
      if (head !== "*" && head !== k) entries.push([k, v]);
      else if (rest.length === 0) counter.n++;
      else entries.push([k, prune(v, rest, counter)]);
    }
    return Object.fromEntries(entries); // defines own properties, so a key such as "__proto__" stays a plain key
  }
  return node;
}
/** Every object key and string value, as the auditor's scan of decoded strings sees them. */
function collectStrings(v: Json, out: string[]): void {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (isObj(v)) {
    for (const k of Object.keys(v)) {
      out.push(k);
      collectStrings(v[k] as Json, out);
    }
  }
}

function windows(text: string, n: number): Set<string> {
  return ngramHashes(tokenize(text), n);
}

/**
 * Builds the audit configuration from in-memory inputs. Pure apart from the injected `randomHex`.
 * It fails closed: a configuration that the Payload_Auditor would refuse (fewer than 4 fingerprint sets, an empty set, a canary or decoy shorter
 * than 8 characters, n below 6) is an error here and nothing is produced.
 */
export function buildAuditConfig(input: BuildInput): Result<BuildOutput, BuilderError> {
  const n = input.n ?? BUILDER_DEFAULT_N;
  if (!Number.isInteger(n) || n < MIN_N) return err("n_invalid");
  const decoyCount = input.decoyCount ?? DEFAULT_DECOY_COUNT;
  if (!Number.isInteger(decoyCount) || decoyCount < 1 || decoyCount > 100) return err("decoy_count_invalid");
  if (input.restricted.length < MIN_FINGERPRINT_SETS) return err("too_few_restricted_files");
  if (input.allowlist.length < 1 || !input.allowlist.every((p) => typeof p === "string" && p !== "")) return err("input_invalid", "allowlist");
  if (!input.restrictedPathPrefixes.every((p) => typeof p === "string" && p !== "")) return err("input_invalid", "restrictedPathPrefixes");
  if (input.corpus.length < 1) return err("input_invalid", "corpus");
  const ids = new Set<string>();
  for (const f of input.restricted) {
    if (!ID_RE.test(f.fileId)) return err("input_invalid", "fileId");
    if (ids.has(f.fileId)) return err("duplicate_id", f.fileId);
    ids.add(f.fileId);
  }
  const corpusIds = new Set<string>();
  for (const c of input.corpus) {
    if (!ID_RE.test(c.id)) return err("input_invalid", "corpusId");
    if (corpusIds.has(c.id)) return err("duplicate_id", c.id);
    corpusIds.add(c.id);
  }

  // The allowed corpus: every window of every legitimate document, taken per document (a window never spans two documents).
  const allowed = new Set<string>();
  for (const c of input.corpus) for (const h of windows(c.text, n)) allowed.add(h);

  const canaries: { id: string; value: string }[] = [];
  const fingerprintSets: { id: string; fileId: string; n: number; hashes: string[] }[] = [];
  const fingerprintSummary: FingerprintSummary[] = [];
  const files = [...input.restricted].sort((a, b) => (a.fileId < b.fileId ? -1 : a.fileId > b.fileId ? 1 : 0));
  for (const f of files) {
    const hashes = new Set<string>();
    let excluded: number[] = [];
    if (f.kind === "json") {
      let tree: Json;
      try {
        tree = JSON.parse(f.content) as Json;
      } catch {
        return err("invalid_json", f.fileId);
      }
      for (const p of f.canaryPointers ?? []) {
        const tokens = pointerTokens(p);
        if (tokens === undefined) return err("pointer_invalid", f.fileId);
        const value = resolvePointer(tree, tokens);
        if (value === undefined) return err("canary_missing", f.fileId);
        if (typeof value !== "string") return err("canary_not_string", f.fileId);
        if (value.length < MIN_SECRET_LENGTH) return err("canary_too_short", f.fileId);
        canaries.push({ id: "", value });
      }
      let pruned = tree;
      for (const p of f.excludeSubtrees ?? []) {
        const tokens = pointerTokens(p);
        if (tokens === undefined || tokens.length === 0) return err("pointer_invalid", f.fileId);
        const counter = { n: 0 };
        pruned = prune(pruned, tokens, counter);
        excluded = [...excluded, counter.n];
      }
      // A JSON file is fingerprinted by its DECODED strings (keys and values, joined by a newline), the same unit that the auditor scans after
      // it has parsed the payload. The raw JSON text is not used: its punctuation windows (`"},{"id":"`) also occur in the envelope of every
      // payload and would block clean payloads.
      const strings: string[] = [];
      collectStrings(pruned, strings);
      for (const h of windows(strings.join("\n"), n)) hashes.add(h);
    } else {
      if ((f.canaryPointers ?? []).length > 0 || (f.excludeSubtrees ?? []).length > 0) return err("input_invalid", f.fileId);
      for (const h of windows(f.content, n)) hashes.add(h);
    }
    const kept = [...hashes].filter((h) => !allowed.has(h)).sort();
    if (kept.length === 0) return err("fingerprint_set_empty", f.fileId);
    fingerprintSets.push({ id: `fp-${f.fileId}`, fileId: f.fileId, n, hashes: kept });
    fingerprintSummary.push({ id: `fp-${f.fileId}`, fileId: f.fileId, n, hashCount: kept.length, excludedNodes: excluded });
  }
  if (canaries.length === 0) return err("canary_missing");
  // Identifiers are counters in the order of the sorted file ids; equal values count once.
  const seenCanary = new Set<string>();
  const canaryList = canaries.filter((c) => (seenCanary.has(c.value) ? false : (seenCanary.add(c.value), true))).map((c, i) => ({ id: `canary-${i + 1}`, value: c.value }));

  // Decoys: random, so that they exist only in this file (design step 5).
  const decoys: { id: string; value: string }[] = [];
  const used = new Set<string>(canaryList.map((c) => c.value));
  for (let i = 1; i <= decoyCount; i++) {
    const r = input.randomHex(DECOY_RANDOM_CHARS);
    const value = `DECOY-${r}`;
    if (typeof r !== "string" || !/^[0-9a-f]+$/.test(r) || r.length !== DECOY_RANDOM_CHARS || used.has(value)) return err("decoy_invalid");
    used.add(value);
    decoys.push({ id: `decoy-${i}`, value });
  }

  const config: AuditConfig = {
    schemaVersion: 1,
    allowlist: sortedUnique(input.allowlist),
    canaries: canaryList,
    decoys,
    fingerprints: fingerprintSets,
    restrictedPathPrefixes: sortedUnique(input.restrictedPathPrefixes),
    tokenizer: TOKENIZER,
  };
  // A fixed key order and no whitespace make the bytes a function of the inputs.
  const text = JSON.stringify({
    schemaVersion: config.schemaVersion,
    allowlist: config.allowlist,
    canaries: config.canaries.map((c) => ({ id: c.id, value: c.value })),
    decoys: config.decoys.map((c) => ({ id: c.id, value: c.value })),
    fingerprints: config.fingerprints.map((f) => ({ id: f.id, fileId: f.fileId, n: f.n, hashes: f.hashes })),
    restrictedPathPrefixes: config.restrictedPathPrefixes,
    tokenizer: config.tokenizer,
  });
  const bytes = new TextEncoder().encode(text);
  const hasObserved = files.some((f) => (f.excludeSubtrees ?? []).length > 0);
  return {
    ok: true,
    value: {
      bytes,
      summary: {
        outputSha256: createHash("sha256").update(bytes).digest("hex"),
        canaryIds: canaryList.map((c) => c.id),
        decoyIds: decoys.map((d) => d.id),
        fingerprintSets: fingerprintSummary,
        allowlistCount: config.allowlist.length,
        restrictedPathPrefixCount: config.restrictedPathPrefixes.length,
        residuals: hasObserved ? ["observed_responses_of_excluded_subtrees_are_not_fingerprinted"] : [],
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// The run step: reads the inputs and writes the output through a port. The host gives the paths.
// ---------------------------------------------------------------------------------------------
export interface BuilderIo {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  randomHex(chars: number): string;
}
export interface RunArgs {
  readonly restricted: readonly { fileId: string; path: string; kind: "text" | "json"; excludeSubtrees?: readonly string[]; canaryPointers?: readonly string[] }[];
  readonly corpus: readonly { id: string; path: string }[];
  readonly allowlist: readonly string[];
  readonly restrictedPathPrefixes: readonly string[];
  /** Where the configuration is written (`discovery/config/audit-config.json`). */
  readonly outputPath: string;
  readonly n?: number;
  readonly decoyCount?: number;
}

const norm = (p: string): string => p.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/^\.\//, "").toLowerCase();
/** The output may not go into the evaluation directory and may not overwrite an input. */
function checkOutputPath(args: RunArgs): BuilderError | undefined {
  const out = norm(args.outputPath);
  if (out === "" || /(^|\/)evaluation(\/|$)/.test(out)) return { code: "output_path_forbidden" };
  const inputs = [...args.restricted.map((f) => norm(f.path)), ...args.corpus.map((c) => norm(c.path))];
  if (inputs.includes(out)) return { code: "output_path_is_input" };
  return undefined;
}

export async function runAuditConfigBuilder(io: BuilderIo, args: RunArgs): Promise<Result<BuildSummary, BuilderError>> {
  const bad = checkOutputPath(args);
  if (bad !== undefined) return { ok: false, error: bad };
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const read = async (id: string, path: string): Promise<Result<string, BuilderError>> => {
    let bytes: Uint8Array;
    try {
      bytes = await io.readFile(path);
    } catch {
      return err("input_unreadable", id);
    }
    try {
      return { ok: true, value: decoder.decode(bytes) };
    } catch {
      return err("input_not_utf8", id);
    }
  };
  const restricted: RestrictedFileInput[] = [];
  for (const f of args.restricted) {
    const r = await read(f.fileId, f.path);
    if (!r.ok) return r;
    restricted.push({
      fileId: f.fileId,
      kind: f.kind,
      content: r.value,
      ...(f.excludeSubtrees === undefined ? {} : { excludeSubtrees: f.excludeSubtrees }),
      ...(f.canaryPointers === undefined ? {} : { canaryPointers: f.canaryPointers }),
    });
  }
  const corpus: CorpusInput[] = [];
  for (const c of args.corpus) {
    const r = await read(c.id, c.path);
    if (!r.ok) return r;
    corpus.push({ id: c.id, text: r.value });
  }
  const built = buildAuditConfig({
    restricted,
    corpus,
    allowlist: args.allowlist,
    restrictedPathPrefixes: args.restrictedPathPrefixes,
    ...(args.n === undefined ? {} : { n: args.n }),
    ...(args.decoyCount === undefined ? {} : { decoyCount: args.decoyCount }),
    randomHex: (chars) => io.randomHex(chars),
  });
  if (!built.ok) return built;
  try {
    await io.writeFile(args.outputPath, built.value.bytes);
  } catch {
    return err("output_unwritable", "output");
  }
  return { ok: true, value: built.value.summary };
}