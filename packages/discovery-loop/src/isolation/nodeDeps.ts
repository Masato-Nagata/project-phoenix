// The real `node:fs` adapter of `IsolationDeps` (design item 1). This is the ONLY file of the isolation module that imports `node:fs`.
//
// Rules kept here: a port answer is a closed outcome (an errno code or ok), never a message, a name or a path; environment VALUES are never
// read (only `Object.keys` of the environment); the scratch directory is `<scratchRoot>/phoenix-isolation-<runId>/` only; nothing is
// created or written under `/run/out`; the root-file-system probe is one `O_CREAT|O_EXCL` file that is removed at most once, and only if
// this adapter created it. The defaults below are the container locations; the options exist so that tests can use a temporary directory
// on tmpfs. Behavior inside a real container (EROFS on Docker Desktop, uid, mounts) is UNVERIFIED until tasks 4.9 and later.
import { constants, promises as fsp } from "node:fs";
import { join, posix } from "node:path";

import type { Result } from "../schema/types.js";
import { RUN_ID_PATTERN } from "./attestation.js";
import type { IsolationDeps, ProbeOutcome } from "./types.js";

export interface NodeIsolationOptions {
  readonly runId: string;
  /** Directories of the first-party compiled trees (`dist/`). `label` is the prefix of the relative path that the scanner reports. */
  readonly bundleRoots: readonly { readonly label: string; readonly dir: string }[];
  /** Default `/tmp`. */
  readonly scratchRoot?: string;
  /** Default `/`. */
  readonly rootfsDir?: string;
  /** Default `/run/lease/isolation-attestation.json`. */
  readonly attestationPath?: string;
}

export const DEFAULT_ATTESTATION_PATH = "/run/lease/isolation-attestation.json";
const MAX_ATTESTATION_BYTES = 65536;
const MAX_BUNDLE_FILE_BYTES = 8 * 1024 * 1024;

/**
 * Longest wait of `scratch.cleanup` for a scratch preparation that is still running. It is below `PORT_TIMEOUT_MS` (5000) of verify.ts,
 * so that the whole cleanup stays inside the verify-level bound. This file does not import verify.ts (the value is duplicated on purpose).
 */
export const CLEANUP_WAIT_MS = 3000;

const OK: ProbeOutcome = Object.freeze({ kind: "ok" });
const CLOSED_SIGNAL = Symbol("closed");

/** Waits for a promise to settle (fulfilled or rejected) for at most `ms`. A finite wait: the timer is always cleared. */
async function waitSettled(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const wait = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    });
    return await Promise.race([p.then(() => true, () => true), wait]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
const codeOf = (e: unknown): string => {
  const c = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof c === "string" && /^[A-Z0-9_]{1,32}$/.test(c) ? c : "UNKNOWN";
};
const err = (e: unknown): ProbeOutcome => ({ kind: "error", code: codeOf(e) });

async function attempt(f: () => Promise<unknown>): Promise<ProbeOutcome> {
  try {
    await f();
    return OK;
  } catch (e) {
    return err(e);
  }
}

export function createNodeIsolationDeps(opts: NodeIsolationOptions): Result<IsolationDeps, { readonly code: "run_id_invalid" }> {
  if (typeof opts.runId !== "string" || !RUN_ID_PATTERN.test(opts.runId)) return { ok: false, error: { code: "run_id_invalid" } };
  const runId = opts.runId;
  const scratchRoot = opts.scratchRoot ?? "/tmp";
  const rootfsDir = opts.rootfsDir ?? "/";
  const attestationPath = opts.attestationPath ?? DEFAULT_ATTESTATION_PATH;
  const scratchDir = join(scratchRoot, `phoenix-isolation-${runId}`);
  const probeFile = join(rootfsDir, `.phoenix-rootfs-probe-${runId}`);
  // The adapter is single-use per verification run. Latches: `scratchClosed` is set first by `scratch.cleanup`; `rootfsClosed` is set by
  // `rootfs.removeCreated` while the creation is still running (the verification has given up waiting for it).
  let created = false;
  let removalTried = false;
  let openPending = false;
  let rootfsClosed = false;
  let scratchClosed = false;
  let scratchInflight: Promise<unknown> | undefined;
  let cleanupRun: Promise<ProbeOutcome> | undefined;
  // Outcome of a removal that the adapter itself did after a late creation. Recorded only; no port exposes it (IsolationDeps is unchanged).
  let lateRemoval: ProbeOutcome | undefined;
  void lateRemoval;

  const deniedDirPath = join(scratchDir, "denied");
  const undoScratch = async (): Promise<void> => {
    try {
      await fsp.chmod(deniedDirPath, 0o700);
    } catch {
      /* the directory may not exist */
    }
    try {
      await fsp.rm(scratchDir, { recursive: true, force: true });
    } catch {
      /* residue is then reported by cleanup, which verifies by stat */
    }
  };

  const doPrepare = async () => {
    let madeScratch = false;
    const step = async (f: () => Promise<unknown>): Promise<void> => {
      await f();
      if (scratchClosed) throw CLOSED_SIGNAL; // checked after every fs step
    };
    try {
      const readableDir = join(scratchDir, "readable");
      const readableFile = join(readableDir, "file.txt");
      const deniedDir = deniedDirPath;
      const deniedChild = join(deniedDir, "child.txt");
      await step(async () => {
        await fsp.mkdir(scratchDir, { mode: 0o700 });
        madeScratch = true; // set before the closed check, so that a closed latch right after the mkdir still undoes it
      });
      await step(() => fsp.mkdir(readableDir, { mode: 0o700 }));
      await step(() => fsp.writeFile(readableFile, "x", { mode: 0o600 }));
      await step(() => fsp.mkdir(deniedDir, { mode: 0o700 }));
      await step(() => fsp.writeFile(deniedChild, "x", { mode: 0o600 })); // the child is created first, then the parent is closed
      await step(() => fsp.chmod(deniedDir, 0o000));
      return { kind: "ok" as const, readableDir, readableFile, deniedDir, deniedChild, absent: join(scratchDir, "absent-path") };
    } catch (e) {
      if (e === CLOSED_SIGNAL || scratchClosed) {
        if (madeScratch) await undoScratch(); // undo what this call created; nothing further is created
        return { kind: "error" as const, code: "CLOSED" };
      }
      return { kind: "error" as const, code: codeOf(e) };
    }
  };

  const removeAll = async (): Promise<ProbeOutcome> => {
    try {
      try {
        await fsp.chmod(deniedDirPath, 0o700);
      } catch (e) {
        if (codeOf(e) !== "ENOENT" && codeOf(e) !== "ENOTDIR") throw e;
      }
      await fsp.rm(scratchDir, { recursive: true, force: true });
      try {
        await fsp.stat(scratchDir);
        return { kind: "error", code: "NOT_REMOVED" };
      } catch (e) {
        return codeOf(e) === "ENOENT" ? OK : err(e);
      }
    } catch (e) {
      return err(e);
    }
  };

  const doCleanup = async (): Promise<ProbeOutcome> => {
    scratchClosed = true; // first: a running prepare stops creating and undoes its own work
    const settled = scratchInflight === undefined ? true : await waitSettled(scratchInflight, CLEANUP_WAIT_MS);
    const out = await removeAll();
    if (!settled) return { kind: "error", code: "PREPARE_UNSETTLED" }; // never ok: the removal is not confirmed
    return out;
  };

  const deps: IsolationDeps = {
    runId,
    fs: {
      stat: (p) => attempt(() => fsp.stat(p)),
      list: (p) => attempt(() => fsp.readdir(p)),
      read: (p) =>
        attempt(async () => {
          const h = await fsp.open(p, "r");
          try {
            await h.read(Buffer.alloc(1), 0, 1, 0);
          } finally {
            await h.close();
          }
        }),
    },
    scratch: {
      async prepare() {
        if (scratchClosed) return { kind: "error" as const, code: "CLOSED" }; // after cleanup nothing is created
        const p = doPrepare();
        scratchInflight = p;
        return p;
      },
      cleanup() {
        if (cleanupRun === undefined) cleanupRun = doCleanup(); // serialized: one cleanup, a second call gets the same answer
        return cleanupRun;
      },
    },
    proc: {
      ids: () => ({ uid: process.getuid?.() ?? -1, euid: process.geteuid?.() ?? -1, gid: process.getgid?.() ?? -1 }),
    },
    rootfs: {
      async tryCreate() {
        if (rootfsClosed) return { kind: "error", code: "CLOSED" };
        openPending = true;
        let h: Awaited<ReturnType<typeof fsp.open>>;
        try {
          h = await fsp.open(probeFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
        } catch (e) {
          openPending = false;
          return err(e);
        }
        openPending = false;
        created = true; // the file exists from here on, whatever happens to close()
        if (rootfsClosed) {
          // late completion: the verification has finished its check. The adapter removes the file itself, one attempt.
          try {
            await h.close();
          } catch {
            /* the unlink below is still attempted */
          }
          removalTried = true;
          lateRemoval = await attempt(() => fsp.unlink(probeFile));
          return OK;
        }
        try {
          await h.close();
        } catch {
          /* the file exists: the answer stays ok so that the caller removes it once */
        }
        return OK;
      },
      async removeCreated() {
        if (!created) {
          if (openPending) {
            rootfsClosed = true; // latch: the running creation removes its own file when it completes
            return { kind: "error", code: "PENDING" };
          }
          return { kind: "error", code: "NOT_CREATED" };
        }
        if (removalTried) return { kind: "error", code: "NOT_CREATED" };
        removalTried = true; // one attempt only: no retry, no chmod recovery
        return attempt(() => fsp.unlink(probeFile));
      },
    },
    env: { names: () => Object.keys(process.env) },
    attestation: {
      async read() {
        let text: string;
        try {
          const h = await fsp.open(attestationPath, "r");
          try {
            const buf = Buffer.alloc(MAX_ATTESTATION_BYTES + 1);
            const { bytesRead } = await h.read(buf, 0, buf.length, 0);
            if (bytesRead > MAX_ATTESTATION_BYTES) return { kind: "unreadable" as const };
            text = buf.subarray(0, bytesRead).toString("utf8");
          } finally {
            await h.close();
          }
        } catch (e) {
          return { kind: codeOf(e) === "ENOENT" ? ("missing" as const) : ("unreadable" as const) };
        }
        try {
          return { kind: "ok" as const, json: JSON.parse(text) as unknown };
        } catch {
          return { kind: "unparsable" as const };
        }
      },
    },
    bundle: {
      async files() {
        const out: { rel: string; text: string }[] = [];
        const decoder = new TextDecoder("utf-8", { fatal: false });
        const walk = async (dir: string, prefix: string): Promise<boolean> => {
          const entries = (await fsp.readdir(dir, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          for (const e of entries) {
            const full = join(dir, e.name);
            const rel = posix.join(prefix, e.name);
            if (e.isDirectory()) {
              if (e.name === "node_modules") continue; // third-party packages are not entered
              if (!(await walk(full, rel))) return false;
            } else if (e.isFile()) {
              const st = await fsp.stat(full);
              if (st.size > MAX_BUNDLE_FILE_BYTES) return false;
              const lower = e.name.toLowerCase();
              if (lower.endsWith(".node") || lower.endsWith(".wasm")) out.push({ rel, text: "" });
              else out.push({ rel, text: decoder.decode(await fsp.readFile(full)) });
            } else {
              return false; // a link or special file: the tree cannot be classified
            }
          }
          return true;
        };
        try {
          for (const r of opts.bundleRoots) if (!(await walk(r.dir, r.label))) return undefined;
        } catch {
          return undefined;
        }
        return out;
      },
    },
  };
  return { ok: true, value: Object.freeze(deps) };
}
