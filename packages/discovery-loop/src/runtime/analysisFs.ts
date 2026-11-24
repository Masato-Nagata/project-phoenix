// The real file system of the Source_Bundler (`LoopDeps.analysisFs`, task 4.9-B): a read-only adapter of the analyzer `FileSystemPort`
// (`readFile`, `lstat`) that is confined to ONE fixed root directory, given when the adapter is created (the composition root passes `/repo`).
// It is not a general file access API: it has no write, list, stat-by-descriptor or path-resolving method, and a path outside the root is
// refused before the file system is touched.
//
// Confinement. A path is accepted only when it is `<root>/<segment>/...` with at least one segment, written with `/`, and no segment is empty,
// `.` or `..`; there is no NUL and no `\`. The root itself and anything else is refused with `EIO`. The root must be an absolute, normalized
// path of an existing directory that is its own `realpath` (no link in it), checked once when the adapter is created.
//
// Reading (`readFile`), one attempt, no retry, the same procedure as the read-only adapters of `runtimeFacts/`:
//   1. `realpath` of the path must equal the path, so no directory of the path and not the file is a symbolic link;
//   2. the file is opened with `O_RDONLY | O_NOFOLLOW` and everything is read from that ONE descriptor;
//   3. the descriptor must be a regular file with a link count of exactly 1 and at most ANALYSIS_FILE_MAX_BYTES; the bytes read must equal its size;
//   4. afterwards the descriptor's size, modification time, device, inode and link count (still exactly 1) are unchanged, the path is still a
//      regular file with the same device and inode, and `realpath` still equals the path. A replaced, truncated, grown or newly linked file
//      is refused.
// The link count is read from the OPENED descriptor (`fstat`), so it is the count of the file that is read, not of a path that may have changed
// since the Source_Bundler's own `lstat` check (`entry_link`), which stays in place. A link made after the second check is not seen.
//
// Errors. The analyzer reads only `.code` of a rejection (`ENOENT` means "does not exist", anything else "unreadable"), and the read observer of
// the orchestrator needs the codes `EACCES` and `EPERM` to recognise a denied read as an isolation violation (R15.6). So a rejection is an
// `AnalysisFsError` whose `code` is one of the closed set ENOENT, ENOTDIR, EACCES, EPERM, EIO; every other cause, and every refusal of this
// module, is `EIO`. A refusal by confinement is `EIO` on purpose: it is not a denial by the kernel and must not be reported as one. The error
// has no path, no errno text, no message of the system and no file content; its message is the code.
//
// Not claimed (residual risks): TOCTOU is not excluded (a replacement that restores the same inode and time, or a directory swap after the
// last check, could go unseen); the reduction comes from the container (read-only mounts of single files, runtime user without write access),
// which is measured in a real container later, not here.
import { constants, lstatSync, promises as fsp, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Result } from "../schema/types.js";

/** The largest file this adapter reads. The allowlisted sources and the two allowlist documents are far smaller. */
export const ANALYSIS_FILE_MAX_BYTES = 1_048_576;

export type AnalysisFsErrorCode = "ENOENT" | "ENOTDIR" | "EACCES" | "EPERM" | "EIO";
const PASSED_THROUGH: readonly string[] = ["ENOENT", "ENOTDIR", "EACCES", "EPERM"];

export class AnalysisFsError extends Error {
  readonly code: AnalysisFsErrorCode;
  constructor(code: AnalysisFsErrorCode) {
    super(code);
    this.name = "AnalysisFsError";
    this.code = code;
  }
}

export interface AnalysisFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  lstat(path: string): Promise<{ kind: "file" | "dir" | "symlink" | "other"; nlink: number }>;
}

export type AnalysisFsCreateErrorCode = "platform_unsupported" | "options_invalid" | "root_invalid";

/** Test seam: runs after the bytes were read and before the file is checked again. The composition root never passes it. */
export interface AnalysisFsSeam {
  readonly afterRead?: () => void;
}

const errorOf = (e: unknown): AnalysisFsError => {
  if (e instanceof AnalysisFsError) return e;
  let code: unknown;
  try {
    code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  } catch {
    code = undefined;
  }
  return new AnalysisFsError(typeof code === "string" && PASSED_THROUGH.includes(code) ? (code as AnalysisFsErrorCode) : "EIO");
};

function isFixedRoot(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 2 || v.includes("\0") || v.includes("\\") || !isAbsolute(v) || resolve(v) !== v) return false;
  try {
    return lstatSync(v).isDirectory() && realpathSync(v) === v;
  } catch {
    return false;
  }
}

export function createAnalysisFs(options: unknown, seam?: AnalysisFsSeam): Result<AnalysisFileSystem, { readonly code: AnalysisFsCreateErrorCode }> {
  const fail = (code: AnalysisFsCreateErrorCode): Result<never, { readonly code: AnalysisFsCreateErrorCode }> => ({ ok: false, error: { code } });
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) return fail("platform_unsupported");
  if (typeof options !== "object" || options === null || Array.isArray(options)) return fail("options_invalid");
  const keys = Reflect.ownKeys(options);
  const d = Object.getOwnPropertyDescriptor(options, "root");
  if (keys.length !== 1 || keys[0] !== "root" || d === undefined || !("value" in d)) return fail("options_invalid");
  const root: unknown = d.value;
  if (!isFixedRoot(root)) return fail("root_invalid");

  const prefix = `${root}/`;
  /** True for `<root>/<segment>(/<segment>)*` only. */
  const confined = (path: unknown): path is string => {
    if (typeof path !== "string" || !path.startsWith(prefix) || path.includes("\0") || path.includes("\\")) return false;
    return path.slice(prefix.length).split("/").every((s) => s !== "" && s !== "." && s !== "..");
  };

  const adapter: AnalysisFileSystem = {
    async lstat(path: string): Promise<{ kind: "file" | "dir" | "symlink" | "other"; nlink: number }> {
      if (!confined(path)) throw new AnalysisFsError("EIO");
      try {
        const st = await fsp.lstat(path);
        const kind = st.isFile() ? "file" : st.isDirectory() ? "dir" : st.isSymbolicLink() ? "symlink" : "other";
        return { kind, nlink: Number(st.nlink) };
      } catch (e) {
        throw errorOf(e);
      }
    },

    async readFile(path: string): Promise<Uint8Array> {
      if (!confined(path)) throw new AnalysisFsError("EIO");
      let fh: Awaited<ReturnType<typeof fsp.open>> | undefined;
      try {
        if ((await fsp.realpath(path)) !== path) throw new AnalysisFsError("EIO");
        fh = await fsp.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const before = await fh.stat();
        if (!before.isFile() || before.nlink !== 1 || before.size > ANALYSIS_FILE_MAX_BYTES) throw new AnalysisFsError("EIO");
        const buf = Buffer.alloc(before.size + 1);
        let total = 0;
        for (;;) {
          const { bytesRead } = await fh.read(buf, total, buf.length - total, total);
          if (bytesRead === 0) break;
          total += bytesRead;
          if (total > before.size) throw new AnalysisFsError("EIO"); // the file grew while it was read
        }
        if (total !== before.size) throw new AnalysisFsError("EIO");
        seam?.afterRead?.();
        const after = await fh.stat();
        if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev || after.nlink !== 1) throw new AnalysisFsError("EIO");
        const onPath = await fsp.lstat(path);
        if (!onPath.isFile() || onPath.ino !== before.ino || onPath.dev !== before.dev) throw new AnalysisFsError("EIO"); // replaced after the read
        if ((await fsp.realpath(path)) !== path) throw new AnalysisFsError("EIO");
        return new Uint8Array(buf.subarray(0, total)); // a copy
      } catch (e) {
        throw errorOf(e);
      } finally {
        if (fh !== undefined) {
          try {
            await fh.close();
          } catch {
            // nothing to report: the answer is already decided and no detail may leave this module
          }
        }
      }
    },
  };
  return { ok: true, value: Object.freeze(adapter) };
}