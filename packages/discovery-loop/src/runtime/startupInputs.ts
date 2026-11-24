// Fixed-path inputs of the runtime start (task 4.9-B): the run configuration, the audit configuration, the baked policy data, the allowlist
// document and the fixed instruction templates. Every file is read through `createAnalysisFs` (analysisFs.ts), so each read keeps that
// adapter's rules: a fixed root given at creation, a path of the form `<root>/<segment>/...`, no symbolic link in the path or as the file,
// a regular file with a link count of exactly 1, at most ANALYSIS_FILE_MAX_BYTES (1 MiB), one descriptor, and the identity checks after
// the read. Nothing here parses, decodes or normalizes: the caller gets the exact bytes, or a closed answer.
//
// A reader is created for ONE root and a closed list of file names; a name outside that list is refused without touching the file system.
// There is no search, no default and no fallback location. Answers:
//   - `ok`: the exact bytes (a fresh copy);
//   - `missing`: the file does not exist (ENOENT) below an existing root;
//   - `unreadable`: anything else (a root that is not a real directory, a link, a hard link, a size above the bound, a changed file,
//     a denied read, a name outside the list). No code, path, errno text or content leaves this module.
import { AnalysisFsError, createAnalysisFs } from "./analysisFs.js";

export const RUN_CONFIG_FILE = "run-config.json";
export const AUDIT_CONFIG_FILE = "audit-config.json";
export const POLICY_CONFIG_FILE = "policy-config.json";
export const PREPARATION_TABLE_FILE = "preparation-table.json";
export const ALLOWLIST_JSON_FILE = "docs/ai-input-allowlist.json";

export type InputRead = { readonly kind: "ok"; readonly bytes: Uint8Array } | { readonly kind: "missing" } | { readonly kind: "unreadable" };

export interface FixedInputReader {
  read(name: string): Promise<InputRead>;
}

const MISSING: InputRead = Object.freeze({ kind: "missing" as const });
const UNREADABLE: InputRead = Object.freeze({ kind: "unreadable" as const });

/** A reader of the files `names` below `root`. A root that the adapter refuses gives a reader whose every read is `unreadable`. */
export function createFixedInputReader(root: string, names: readonly string[]): FixedInputReader {
  const allowed = new Set<string>(names.filter((n) => typeof n === "string" && n !== ""));
  const made = createAnalysisFs({ root });
  const fs = made.ok ? made.value : undefined;
  return Object.freeze({
    async read(name: string): Promise<InputRead> {
      if (fs === undefined || typeof name !== "string" || !allowed.has(name)) return UNREADABLE;
      try {
        const bytes = await fs.readFile(`${root}/${name}`);
        return { kind: "ok", bytes };
      } catch (e) {
        return e instanceof AnalysisFsError && e.code === "ENOENT" ? MISSING : UNREADABLE;
      }
    },
  });
}

/** The text of valid UTF-8 bytes, or `undefined`. A byte-order mark is kept as U+FEFF; nothing is replaced. */
export function decodeUtf8Strict(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return undefined;
  }
}