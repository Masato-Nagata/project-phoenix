// The real `node:fs` adapter of `IsolationDeps` (design item 1). This is the ONLY file of the isolation module that imports `node:fs`.
//
// Rules kept here: a port answer is a closed outcome (an errno code or ok), never a message, a name or a path; environment VALUES are never
// read (only `Object.keys` of the environment); the scratch directory is `<scratchRoot>/phoenix-isolation-<runId>/` only; nothing is
// created or written under `/run/out`; the root-file-system probe is one `O_CREAT|O_EXCL` file that is removed at most once, and only if
// this adapter created it. The defaults below are the container locations; the options exist so that tests can use a temporary directory
// on tmpfs. Behavior inside a real container (EROFS on Docker Desktop, uid, mounts) is UNVERIFIED until tasks 4.9 and later.
import { createHash } from "node:crypto";
import { constants, promises as fsp, type BigIntStats, type Dir } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { join, posix } from "node:path";

import type { Result } from "../schema/types.js";
import { RUN_ID_PATTERN } from "./attestation.js";
import { BUNDLE_LIMITS, computeBundleSha256, findBundlePathProblem, isValidBundlePath, ordinalCompare } from "./bundleHash.js";
import type { BundleFailureCode, BundleSnapshot, IsolationDeps, ProbeOutcome } from "./types.js";

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

// ------------------------------------------------------------------------------------------------------------------------------------
// The bundle walk (design.md, item 7a). ONE walk gives the text for the import scan and the `bundleSha256` of the raw bytes.
//   - Limits over all roots together (BUNDLE_LIMITS), checked while listing, so that a large tree is refused before it is read; the listing uses
//     `opendir` and counts every entry as it is found, so a directory with very many entries is not read to the end.
//   - An AbortSignal is checked before and after every file-system call. After an abort no new file access is started, the open handles are
//     closed, and the result is `timeout`, never a hash. A call that is already running in the operating system is not interrupted (residual risk).
//   - Change detection (NOT a guard against a time-of-check-to-time-of-use race): the first listing records the identity of each file; the read
//     checks it again by `lstat`, by `fstat` before and after the read, and by the number of bytes; a second listing with the same limits must
//     give the same files, sizes, identities and skipped directories.
// A link, a special file, a path outside the grammar, a duplicate, an empty root, a read failure and a change are refusals with a closed code.
class BundleStop extends Error {
  readonly code: BundleFailureCode | "timeout";
  constructor(code: BundleFailureCode | "timeout") {
    super(code);
    this.code = code;
  }
}

interface EnumFile {
  readonly rel: string;
  readonly abs: string;
  readonly size: number;
  readonly dev: bigint;
  readonly ino: bigint;
  readonly mtimeNs: bigint;
}
interface Enumeration {
  readonly files: readonly EnumFile[];
  readonly skipped: readonly string[];
}
export type Root = { readonly label: string; readonly dir: string };
export type BundleLimits = { readonly [K in keyof typeof BUNDLE_LIMITS]: number };

/**
 * The limits of one walk. `tighter` may only LOWER a limit (for a test that must not create 5,000 files); a value above the production limit, or
 * a value that is not a non-negative integer, is ignored, so the production limits cannot be relaxed through it.
 */
function effectiveLimits(tighter: Partial<BundleLimits> | undefined): BundleLimits {
  const out: { -readonly [K in keyof BundleLimits]: number } = { ...BUNDLE_LIMITS };
  if (tighter === undefined) return out;
  for (const k of Object.keys(out) as (keyof BundleLimits)[]) {
    const v = tighter[k];
    if (typeof v === "number" && Number.isInteger(v) && v >= 0 && v < out[k]) out[k] = v;
  }
  return out;
}
const O_READ = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);
const READ_CHUNK = 64 * 1024;

async function enumerateBundle(roots: readonly Root[], signal: AbortSignal | undefined, L: BundleLimits): Promise<Enumeration> {
  const files: EnumFile[] = [];
  const skipped: string[] = [];
  let dirs = 0;
  let entries = 0;
  let bytes = 0;
  const alive = (): void => {
    if (signal?.aborted === true) throw new BundleStop("timeout");
  };
  const over = (condition: boolean): void => {
    if (condition) throw new BundleStop("bundle_limit_exceeded");
  };
  const walkDir = async (abs: string, rel: string, depth: number): Promise<void> => {
    alive();
    dirs++;
    over(dirs > L.directories || depth > L.depth);
    const found: { name: string; kind: "dir" | "file" | "link" | "other" }[] = [];
    let handle: Dir;
    try {
      handle = await fsp.opendir(abs, { bufferSize: 64 });
    } catch {
      throw new BundleStop("bundle_read_failed");
    }
    try {
      for await (const e of handle) {
        alive();
        entries++;
        over(entries > L.entries);
        found.push({ name: e.name, kind: e.isDirectory() ? "dir" : e.isFile() ? "file" : e.isSymbolicLink() ? "link" : "other" });
      }
    } catch (e) {
      if (e instanceof BundleStop) throw e;
      throw new BundleStop("bundle_read_failed");
    } finally {
      try {
        await handle.close(); // already closed after a complete listing: the error is expected and ignored
      } catch {
        /* closed */
      }
    }
    alive();
    found.sort((a, b) => ordinalCompare(a.name, b.name));
    for (const e of found) {
      alive();
      const childRel = `${rel}/${e.name}`;
      if (!isValidBundlePath(childRel)) throw new BundleStop("bundle_path_invalid");
      if (e.kind === "link" || e.kind === "other") throw new BundleStop("bundle_unsupported_entry");
      const childAbs = join(abs, e.name);
      if (e.kind === "dir") {
        if (e.name === "node_modules") {
          skipped.push(childRel); // third-party packages are not entered; the directory itself was a real directory (not a link)
          continue;
        }
        await walkDir(childAbs, childRel, depth + 1);
        continue;
      }
      let st: BigIntStats;
      try {
        st = await fsp.lstat(childAbs, { bigint: true });
      } catch {
        throw new BundleStop("bundle_read_failed");
      }
      alive();
      if (!st.isFile()) throw new BundleStop("bundle_changed"); // listed as a file, no longer one
      over(st.size > BigInt(L.fileBytes));
      const size = Number(st.size);
      files.push({ rel: childRel, abs: childAbs, size, dev: st.dev, ino: st.ino, mtimeNs: st.mtimeNs });
      bytes += size;
      over(files.length > L.files || bytes > L.totalBytes);
    }
  };
  for (const r of roots) {
    alive();
    let st: BigIntStats;
    try {
      st = await fsp.lstat(r.dir, { bigint: true });
    } catch {
      throw new BundleStop("bundle_read_failed");
    }
    alive();
    if (st.isSymbolicLink()) throw new BundleStop("bundle_unsupported_entry");
    if (!st.isDirectory()) throw new BundleStop("bundle_read_failed");
    const before = files.length;
    await walkDir(r.dir, r.label, 0);
    if (files.length === before) throw new BundleStop("bundle_empty_root");
  }
  return { files, skipped };
}

const sameEnumeration = (a: Enumeration, b: Enumeration): boolean => {
  if (a.files.length !== b.files.length || a.skipped.length !== b.skipped.length) return false;
  for (let i = 0; i < a.files.length; i++) {
    const x = a.files[i];
    const y = b.files[i];
    if (x === undefined || y === undefined) return false;
    if (x.rel !== y.rel || x.size !== y.size || x.dev !== y.dev || x.ino !== y.ino || x.mtimeNs !== y.mtimeNs) return false;
  }
  return a.skipped.every((s, i) => s === b.skipped[i]);
};

const isBinaryName = (rel: string): boolean => {
  const lower = rel.toLowerCase();
  return lower.endsWith(".node") || lower.endsWith(".wasm");
};

/** One file: the SHA-256 of its raw bytes and, unless it is a binary (`.node`, `.wasm`), its text (decoded as before; the bytes are not kept otherwise). */
async function readBundleFile(f: EnumFile, signal: AbortSignal | undefined): Promise<{ sha256: string; text: string }> {
  const alive = (): void => {
    if (signal?.aborted === true) throw new BundleStop("timeout");
  };
  alive();
  let now: BigIntStats;
  try {
    now = await fsp.lstat(f.abs, { bigint: true });
  } catch (e) {
    throw new BundleStop(codeOf(e) === "ENOENT" ? "bundle_changed" : "bundle_read_failed");
  }
  alive();
  if (!now.isFile() || now.dev !== f.dev || now.ino !== f.ino || now.mtimeNs !== f.mtimeNs || Number(now.size) !== f.size) throw new BundleStop("bundle_changed");
  let fh: FileHandle;
  try {
    fh = await fsp.open(f.abs, O_READ);
  } catch (e) {
    const c = codeOf(e);
    throw new BundleStop(c === "ENOENT" || c === "ELOOP" ? "bundle_changed" : "bundle_read_failed");
  }
  try {
    alive();
    const first = await fh.stat({ bigint: true });
    alive();
    if (!first.isFile() || first.dev !== f.dev || first.ino !== f.ino || first.mtimeNs !== f.mtimeNs || Number(first.size) !== f.size) throw new BundleStop("bundle_changed");
    const hash = createHash("sha256");
    const keep: Buffer[] | undefined = isBinaryName(f.rel) ? undefined : [];
    const buf = Buffer.alloc(READ_CHUNK);
    let total = 0;
    for (;;) {
      alive();
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      alive();
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > f.size) throw new BundleStop("bundle_changed");
      hash.update(buf.subarray(0, bytesRead));
      if (keep !== undefined) keep.push(Buffer.from(buf.subarray(0, bytesRead)));
    }
    if (total !== f.size) throw new BundleStop("bundle_changed");
    const last = await fh.stat({ bigint: true });
    alive();
    if (last.size !== first.size || last.mtimeNs !== first.mtimeNs || last.ctimeNs !== first.ctimeNs || last.dev !== first.dev || last.ino !== first.ino) throw new BundleStop("bundle_changed");
    return { sha256: hash.digest("hex"), text: keep === undefined ? "" : new TextDecoder("utf-8", { fatal: false }).decode(Buffer.concat(keep)) };
  } catch (e) {
    if (e instanceof BundleStop) throw e;
    throw new BundleStop("bundle_read_failed");
  } finally {
    try {
      await fh.close();
    } catch {
      /* the failure to close is not a result */
    }
  }
}

export async function scanBundleRoots(roots: readonly Root[], signal: AbortSignal | undefined, tighter?: Partial<BundleLimits>): Promise<BundleSnapshot> {
  const L = effectiveLimits(tighter);
  try {
    const labels = roots.map((r) => r.label);
    const labelProblem = findBundlePathProblem({ roots: labels, skippedDirectories: [], files: [] });
    if (labelProblem !== undefined) throw new BundleStop(labelProblem);
    if (signal?.aborted === true) throw new BundleStop("timeout");
    const first = await enumerateBundle(roots, signal, L);
    const hashes: { path: string; sha256: string }[] = [];
    const texts: { rel: string; text: string }[] = [];
    // the paths are checked after the first listing (grammar and duplicates); the read starts only for a sound list
    const problem = findBundlePathProblem({ roots: labels, skippedDirectories: first.skipped, files: first.files.map((f) => ({ path: f.rel, sha256: "" })) });
    if (problem !== undefined) throw new BundleStop(problem);
    for (const f of first.files) {
      const r = await readBundleFile(f, signal);
      hashes.push({ path: f.rel, sha256: r.sha256 });
      texts.push({ rel: f.rel, text: r.text });
    }
    const second = await enumerateBundle(roots, signal, L);
    if (!sameEnumeration(first, second)) throw new BundleStop("bundle_changed");
    return { ok: true, files: texts, bundleSha256: computeBundleSha256({ roots: labels, skippedDirectories: first.skipped, files: hashes }) };
  } catch (e) {
    return { ok: false, code: e instanceof BundleStop ? e.code : "bundle_read_failed" };
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
        let h: FileHandle;
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
      // The text list as before (undefined when the tree cannot be classified), from the same walk as `snapshot`.
      async files() {
        const r = await scanBundleRoots(opts.bundleRoots, undefined);
        return r.ok ? r.files : undefined;
      },
      snapshot: (signal) => scanBundleRoots(opts.bundleRoots, signal),
    },
  };
  return { ok: true, value: Object.freeze(deps) };
}
