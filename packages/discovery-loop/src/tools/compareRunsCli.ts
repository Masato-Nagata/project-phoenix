// CLI of the reproducibility comparison (R22.7, R22.8; task 4.7, step A1). Tooling only; not imported by src/index.ts or main.ts.
//
//   node dist/tools/compareRunsCli.js <run-dir-a> <run-dir-b>
//
// Output: exactly one canonical JSON line. A comparison verdict (`identical`, `different`, `incomplete`) goes to standard output; a usage
// error and an internal error go to standard error. The line holds no path, no wall-clock value and no error message text.
//
// EXIT CODES (human decision D4): 0 identical; 1 different; 2 incomplete, usage error, or internal error. The structured `result`
// field tells the cases apart. An internal error uses 2, never 0 or 1, so it cannot look like a comparison verdict.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { canonicalJson } from "../canonical/index.js";
import type { Json } from "../schema/index.js";
import { CompareRunsInternalError, compareRuns, type CompareRunsResult } from "../reproducibility/compareRuns.js";
import { createNodeFileSystem } from "../store/nodeFileSystem.js";
import type { ReadOnlyFileSystemPort } from "../store/runVerification.js";

export const COMPARE_EXIT_CODES = Object.freeze({ identical: 0, different: 1, incomplete: 2, usage_error: 2, error: 2 } as const);
export const COMPARE_USAGE = "compare-runs <run-dir-a> <run-dir-b>";

export interface CompareCliIo {
  stdout(line: string): void;
  stderr(line: string): void;
}

const line = (v: unknown): string => canonicalJson({ tool: "compare-runs", schemaVersion: 1, ...(v as object) } as Json);

/** Runs the CLI over `argv` (without the node and script entries). Never throws. Writes exactly one line. */
export async function runCompareRunsCli(argv: readonly string[], io: CompareCliIo, fs: ReadOnlyFileSystemPort): Promise<number> {
  const usage = (code: "wrong_argument_count" | "unknown_option" | "empty_path"): number => {
    io.stderr(line({ result: "usage_error", code, usage: COMPARE_USAGE }));
    return COMPARE_EXIT_CODES.usage_error;
  };
  if (argv.length !== 2) return usage("wrong_argument_count");
  const [dirA, dirB] = argv as readonly [string, string];
  if (dirA.startsWith("-") || dirB.startsWith("-")) return usage("unknown_option");
  if (dirA === "" || dirB === "") return usage("empty_path");

  let result: CompareRunsResult;
  try {
    result = await compareRuns(fs, dirA, dirB);
  } catch (e) {
    io.stderr(line({ result: "error", code: "internal_error", ...(e instanceof CompareRunsInternalError ? { detail: e.code } : {}) }));
    return COMPARE_EXIT_CODES.error;
  }
  io.stdout(line(result));
  return COMPARE_EXIT_CODES[result.result];
}

function isEntryPoint(argvPath: string | undefined, moduleUrl: string): boolean {
  if (typeof argvPath !== "string" || argvPath === "") return false;
  try {
    return pathToFileURL(resolve(argvPath)).href === moduleUrl;
  } catch {
    return false;
  }
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  const node = createNodeFileSystem();
  // Only the two read operations are handed on: the comparison has no write, rename, mkdir or remove in reach.
  const readOnly: ReadOnlyFileSystemPort = { listDir: (p) => node.listDir(p), readFile: (p) => node.readFile(p) };
  runCompareRunsCli(
    process.argv.slice(2),
    { stdout: (l) => process.stdout.write(`${l}\n`), stderr: (l) => process.stderr.write(`${l}\n`) },
    readOnly,
  ).then(
    (code) => {
      process.exitCode = code;
    },
    () => {
      process.exitCode = 2;
    },
  );
}