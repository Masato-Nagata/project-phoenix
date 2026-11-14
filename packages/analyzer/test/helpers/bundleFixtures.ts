// Shared fixtures for the Source_Bundler tests (tasks 2.1, 2.2, 2.3, 2.7).
// Only neutral names are used; no business value of the Legacy_App appears in a fixture.
import { createHash } from "node:crypto";
import type { FileKind, FileSystemPort } from "../../src/index.js";

export const ROOT = "/repo";
export const JSON_DOC = "docs/ai-input-allowlist.json";
export const MD_DOC = "docs/ai-input-allowlist.md";

export interface MemEntry {
  kind: FileKind;
  nlink?: number;
  bytes?: Uint8Array;
  unreadable?: boolean;
}

const enoent = (p: string): Error => Object.assign(new Error(`ENOENT ${p}`), { code: "ENOENT" });

/** In-memory file system with a log of every access. It has no write method. */
export class MemFs implements FileSystemPort {
  readonly accessed: string[] = [];
  constructor(readonly entries: Map<string, MemEntry>) {}

  async lstat(path: string): Promise<{ kind: FileKind; nlink: number }> {
    this.accessed.push(`lstat ${path}`);
    const e = this.entries.get(path);
    if (e === undefined) throw enoent(path);
    return { kind: e.kind, nlink: e.nlink ?? 1 };
  }

  async readFile(path: string): Promise<Uint8Array> {
    this.accessed.push(`readFile ${path}`);
    const e = this.entries.get(path);
    if (e === undefined) throw enoent(path);
    if (e.unreadable === true) throw Object.assign(new Error(`EACCES ${path}`), { code: "EACCES" });
    if (e.kind !== "file") throw Object.assign(new Error(`EISDIR ${path}`), { code: "EISDIR" });
    return e.bytes ?? new Uint8Array();
  }

  /** The paths touched by `readFile` or `lstat`, without the operation name. */
  paths(): string[] {
    return this.accessed.map((a) => a.slice(a.indexOf(" ") + 1));
  }
}

export const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

/** The allowlist JSON text for the given entries (valid unless `mutate` breaks it). */
export function allowlistJson(entries: readonly unknown[], extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema_version: 1,
    description: "fixture",
    location_note: "fixture",
    files: entries,
    ...extra,
  });
}

/** The allowlist Markdown text in the format of docs/ai-input-allowlist.md. */
export function allowlistMd(entries: readonly string[], opts: { eol?: string; after?: string } = {}): string {
  const eol = opts.eol ?? "\n";
  const rows = entries.map((e) => `| \`${e}\` | Application source |`);
  return [
    "# AI Input Allowlist Policy",
    "",
    "## Policy",
    "",
    "### Allowed (fixture)",
    "",
    "| File | Reason |",
    "|------|--------|",
    ...rows,
    "",
    opts.after ?? "### Not allowed",
    "",
    "`tests/`, `evaluation/`, every `README.md`.",
    "",
  ].join(eol);
}

export interface RepoOptions {
  texts?: Readonly<Record<string, string | Uint8Array>>;
  jsonText?: string | undefined;
  mdText?: string | Uint8Array | undefined;
  mutate?: (entries: Map<string, MemEntry>) => void;
}

/** A repository with the given entries as files (content from `texts`, default a short line each). */
export function makeRepo(listed: readonly string[], opts: RepoOptions = {}): MemFs {
  const m = new Map<string, MemEntry>();
  const dirs = new Set<string>();
  for (const e of listed) {
    const parts = e.split("/");
    for (let n = 1; n < parts.length; n += 1) dirs.add(parts.slice(0, n).join("/"));
  }
  for (const d of dirs) m.set(`${ROOT}/${d}`, { kind: "dir" });
  for (const e of listed) {
    const t = opts.texts?.[e] ?? `line of ${e}\n`;
    m.set(`${ROOT}/${e}`, { kind: "file", bytes: typeof t === "string" ? utf8(t) : t });
  }
  const json = opts.jsonText === undefined ? allowlistJson(listed) : opts.jsonText;
  m.set(`${ROOT}/${JSON_DOC}`, { kind: "file", bytes: utf8(json) });
  const md = opts.mdText === undefined ? allowlistMd(listed) : opts.mdText;
  m.set(`${ROOT}/${MD_DOC}`, { kind: "file", bytes: typeof md === "string" ? utf8(md) : md });
  opts.mutate?.(m);
  return new MemFs(m);
}

// ------------------------------------------------------------------ independent oracle (not the code under test)

/** LF normalization written independently of `normalizeLf`: scan, no regular expression. */
export function oracleNormalize(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (ch === "\r") {
      if (text.charAt(i + 1) === "\n") i += 1;
      out += "\n";
    } else out += ch;
  }
  return out;
}

export const oracleHash = (text: string): string => createHash("sha256").update(Buffer.from(oracleNormalize(text), "utf8")).digest("hex");

export const HASH_RULE = "sha256 over UTF-8 bytes after CRLF and lone CR are replaced by LF";

/** The canonical manifest document written by hand: keys in sorted order, no whitespace. */
export function oracleManifestText(files: readonly { path: string; text: string }[]): string {
  const rows = files.map((f) => `{"path":${JSON.stringify(f.path)},"sha256Lf":"${oracleHash(f.text)}"}`);
  return `{"files":[${rows.join(",")}],"hashRule":${JSON.stringify(HASH_RULE)},"schemaVersion":1}`;
}

export const oracleBundleText = (files: readonly { path: string; text: string }[]): string =>
  files.map((f) => `=== FILE: ${f.path} ===\n${oracleNormalize(f.text)}\n`).join("");