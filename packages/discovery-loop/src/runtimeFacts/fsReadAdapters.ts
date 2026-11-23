// Run_Manifest runtime facts, task 4.6 work unit W4-C part C1: the read-only Node.js file adapters of the ports of W4-A and W4-B.
//
// What this module is: three adapters that answer the ports `LeaseJsonReadPort` (W4-A) and `RuntimeVersionReadPort` (W4-B) from the real
// file system, plus the one internal function that reads a file. It is the ONLY file of `runtimeFacts/` that imports `node:fs`.
//
// Where the paths come from: the composition root passes every directory EXPLICITLY when it creates an adapter. Nothing here knows a
// container path, and no port method takes a path: a method takes nothing (or a package name that is checked against the package name
// grammar), and the file name below the injected directory is a fixed constant of this module. `process.versions` is not referenced here:
// the Node.js version comes from the `versions` object the caller injects (the composition root passes `process.versions`).
//
// How a file is read (one attempt, no retry, nothing is returned except a closed answer):
//   1. the full path is built lexically from the injected directory and fixed segments; `realpath` of it must equal it, so no directory
//      of the path and not the file is a symbolic link (a directory that was a symbolic link when the adapter was created is refused then);
//   2. the file is opened with `O_RDONLY | O_NOFOLLOW` and everything is read from that ONE file descriptor, never from the path again;
//   3. the descriptor must be a regular file whose size is within the limit; the bytes read must equal that size; the limit is
//      4 KiB for `lease.json` and 64 KiB for a `package.json` (the two are different limits and are never shared);
//   4. after the read the path is checked again: still a regular file with the same device and inode as the descriptor, the descriptor's
//      size and modification time unchanged, and `realpath` still equal to the path. A replaced, truncated or grown file is refused.
//   5. the bytes must be valid UTF-8.
// `absent` means that a path component does not exist. Every other failure is `error`. No message, errno, path or content is returned.
//
// What this module does NOT claim (residual risks, not removed by this code):
//   - TOCTOU is not excluded. Steps 1 and 4 are separate system calls from step 2, and a main-process write between two of them could
//     go unseen (for example a replacement that restores the same inode and modification time, or a directory swap after step 4).
//     The reduction comes from the container, not from this code: a read-only root file system, files owned by root, and a runtime user
//     with no write access. That is NOT measured here (task 4.9 measures it in a real container).
//   - Hard links are not detected (the link count is not required to be 1; its value on the image layers is unmeasured).
//   - Nothing says that the file is the file that the running code was loaded from, or that the facts are business-specification correct.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Result } from "../schema/types.js";
import { LEASE_JSON_MAX_BYTES, type LeaseJsonReadAnswer, type LeaseJsonReadPort } from "./leaseFacts.js";
import { PACKAGE_JSON_MAX_BYTES, WORKSPACE_SCOPE_PREFIX, processNodeVersion, type PackageJsonReadAnswer, type RuntimeVersionReadPort } from "./versionFacts.js";

// ---------------------------------------------------------------------------------------------
// Local helpers (no import from `manifest/`; same contract as the helpers of leaseFacts.ts and versionFacts.ts)
// ---------------------------------------------------------------------------------------------
/** A plain object with only own enumerable string-keyed data properties (no accessor, no symbol key, Object.prototype or null prototype). */
function isPlainDataObject(v: unknown): v is object {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key !== "string") return false;
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (d === undefined || !("value" in d) || d.enumerable !== true) return false;
  }
  return true;
}
function dataValue(o: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d === undefined || !("value" in d) ? undefined : d.value;
}
function hasExactKeys(o: object, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_NAME_LENGTH = 214;
/** The file names below the injected directories. Fixed here; no caller supplies a file name. */
const LEASE_FILE = "lease.json";
const PACKAGE_FILE = "package.json";

const ABSENT: PackageJsonReadAnswer = Object.freeze({ kind: "absent" });
const FAILED: PackageJsonReadAnswer = Object.freeze({ kind: "error" });
const isMissing = (e: unknown): boolean => {
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
};

// ---------------------------------------------------------------------------------------------
// The one internal read
// ---------------------------------------------------------------------------------------------
/** Test seam: runs after the bytes were read and before the file is checked again. Never passed by an adapter. */
export interface ReadSeamInternal {
  readonly afterRead?: () => void;
}

/**
 * INTERNAL (exported for the tests of this module; the composition root uses the adapters below). Reads `<root>/<segments...>` once.
 * `root` is an absolute, normalized directory that the caller has already checked; `segments` are fixed or validated names.
 */
export function readFixedRootFileInternal(root: string, segments: readonly string[], maxBytes: number, seam?: ReadSeamInternal): PackageJsonReadAnswer {
  const full = join(root, ...segments);
  let fd: number | undefined;
  try {
    let real: string;
    try {
      real = realpathSync(full);
    } catch (e) {
      return isMissing(e) ? ABSENT : FAILED;
    }
    if (real !== full) return FAILED; // a symbolic link in a directory or the file itself
    fd = openSync(full, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) return FAILED;
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const n = readSync(fd, buf, total, buf.length - total, total);
      if (n === 0) break;
      total += n;
      if (total > maxBytes) return FAILED; // the file grew past the limit while it was read
    }
    if (total !== before.size) return FAILED;
    seam?.afterRead?.();
    const after = fstatSync(fd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ino !== before.ino || after.dev !== before.dev) return FAILED;
    const onPath = lstatSync(full);
    if (!onPath.isFile() || onPath.ino !== before.ino || onPath.dev !== before.dev) return FAILED; // replaced after the read
    if (realpathSync(full) !== full) return FAILED;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buf.subarray(0, total));
    } catch {
      return FAILED;
    }
    return { kind: "ok", text };
  } catch (e) {
    return isMissing(e) ? ABSENT : FAILED;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* nothing to report: the answer is already decided and no detail may leave this module */
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Options and errors
// ---------------------------------------------------------------------------------------------
export type FsReadAdapterErrorCode =
  | "platform_unsupported"
  | "options_not_plain_object"
  | "options_keys"
  | "lease_dir_invalid"
  | "npm_dir_invalid"
  | "declared_dir_invalid"
  | "modules_dir_invalid";
export interface FsReadAdapterError {
  readonly code: FsReadAdapterErrorCode;
}
const fail = (code: FsReadAdapterErrorCode): Result<never, FsReadAdapterError> => ({ ok: false, error: { code } });

/**
 * True for an absolute, normalized directory path (no `..`, no `.` segment, no repeated or trailing separator, no NUL) that is a real
 * directory and is its own `realpath` (neither it nor a parent is a symbolic link).
 */
function isFixedRoot(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.includes("\0") || !isAbsolute(v) || resolve(v) !== v) return false;
  try {
    return lstatSync(v).isDirectory() && realpathSync(v) === v;
  } catch {
    return false;
  }
}

/** Reads one injected directory option. */
function rootOption(options: object, key: string, code: FsReadAdapterErrorCode): Result<string, FsReadAdapterError> {
  const v = dataValue(options, key);
  return isFixedRoot(v) ? { ok: true, value: v } : fail(code);
}

function checkPlatform(): Result<true, FsReadAdapterError> {
  return typeof constants.O_NOFOLLOW === "number" && constants.O_NOFOLLOW !== 0 ? { ok: true, value: true } : fail("platform_unsupported");
}

// ---------------------------------------------------------------------------------------------
// Lease adapter (W4-A port)
// ---------------------------------------------------------------------------------------------
export interface LeaseJsonAdapterOptions {
  /** The directory that holds `lease.json` (the read-only lease mount). Required; there is no default. */
  readonly leaseDir: string;
}

/** The adapter of `LeaseJsonReadPort`: reads `<leaseDir>/lease.json`, at most 4 KiB (`LEASE_JSON_MAX_BYTES`). Read only. */
export function createLeaseJsonReadAdapter(options: unknown): Result<LeaseJsonReadPort, FsReadAdapterError> {
  const platform = checkPlatform();
  if (!platform.ok) return platform;
  if (!isPlainDataObject(options)) return fail("options_not_plain_object");
  if (!hasExactKeys(options, ["leaseDir"])) return fail("options_keys");
  const dir = rootOption(options, "leaseDir", "lease_dir_invalid");
  if (!dir.ok) return dir;
  const leaseDir = dir.value;
  const port: LeaseJsonReadPort = {
    readLeaseJson: (): LeaseJsonReadAnswer => readFixedRootFileInternal(leaseDir, [LEASE_FILE], LEASE_JSON_MAX_BYTES),
  };
  return { ok: true, value: Object.freeze(port) };
}

// ---------------------------------------------------------------------------------------------
// Launcher facts adapter (W4-C C2 port, structurally the `LauncherFactsReadPort` of launcherFacts.ts)
// ---------------------------------------------------------------------------------------------
/** The file name below the lease directory. Fixed here; no caller supplies a file name. */
const LAUNCHER_FACTS_FILE = "launcher-facts.json";

/**
 * The adapter of the launcher facts port: reads `<leaseDir>/launcher-facts.json`, at most 4 KiB (the same bound as `lease.json`;
 * launcherFacts.ts enforces its own equal bound when it parses). The method takes no argument. Read only.
 */
export function createLauncherFactsReadAdapter(options: unknown): Result<{ readLauncherFacts(): LeaseJsonReadAnswer }, FsReadAdapterError> {
  const platform = checkPlatform();
  if (!platform.ok) return platform;
  if (!isPlainDataObject(options)) return fail("options_not_plain_object");
  if (!hasExactKeys(options, ["leaseDir"])) return fail("options_keys");
  const dir = rootOption(options, "leaseDir", "lease_dir_invalid");
  if (!dir.ok) return dir;
  const leaseDir = dir.value;
  const port = {
    readLauncherFacts: (): LeaseJsonReadAnswer => readFixedRootFileInternal(leaseDir, [LAUNCHER_FACTS_FILE], LEASE_JSON_MAX_BYTES),
  };
  return { ok: true, value: Object.freeze(port) };
}

// ---------------------------------------------------------------------------------------------
// Runtime version adapter (W4-B port)
// ---------------------------------------------------------------------------------------------
export interface RuntimeVersionAdapterOptions {
  /** The object that `readNodeVersion` reads `node` from. The composition root passes the process version table. Required; no fallback. */
  readonly versions: unknown;
  /** The directory that holds the `package.json` of the installed npm package. */
  readonly npmPackageDir: string;
  /** The directory that holds the `package.json` of the package that is run (its `dependencies` are the declaration). */
  readonly declaredPackageDir: string;
  /** The `node_modules` directory; an installed package `<name>` is read from `<modulesDir>/<name>/package.json`. */
  readonly modulesDir: string;
}

/** The segments of an installed package directory, or `undefined` for a name that is not a valid, non-workspace package name. */
function installedSegments(name: unknown): readonly string[] | undefined {
  if (typeof name !== "string" || name.length === 0 || name.length > MAX_NAME_LENGTH || !PACKAGE_NAME.test(name)) return undefined;
  if (name.startsWith(WORKSPACE_SCOPE_PREFIX)) return undefined;
  const parts = name.split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return undefined;
  return Object.freeze([...parts, PACKAGE_FILE]);
}

/**
 * The adapter of `RuntimeVersionReadPort`. Reads `package.json` files only, at most 64 KiB each (`PACKAGE_JSON_MAX_BYTES`).
 * `readInstalledPackageJson(name)` checks the name again (the package name grammar, no `..` or empty segment, no `@phoenix/` scope) and
 * answers `error` for any other value without touching the file system.
 */
export function createRuntimeVersionReadAdapter(options: unknown): Result<RuntimeVersionReadPort, FsReadAdapterError> {
  const platform = checkPlatform();
  if (!platform.ok) return platform;
  if (!isPlainDataObject(options)) return fail("options_not_plain_object");
  if (!hasExactKeys(options, ["versions", "npmPackageDir", "declaredPackageDir", "modulesDir"])) return fail("options_keys");
  const npm = rootOption(options, "npmPackageDir", "npm_dir_invalid");
  if (!npm.ok) return npm;
  const declared = rootOption(options, "declaredPackageDir", "declared_dir_invalid");
  if (!declared.ok) return declared;
  const modules = rootOption(options, "modulesDir", "modules_dir_invalid");
  if (!modules.ok) return modules;
  const versions = dataValue(options, "versions");
  const npmDir = npm.value;
  const declaredDir = declared.value;
  const modulesDir = modules.value;
  const port: RuntimeVersionReadPort = {
    readNodeVersion: (): unknown => processNodeVersion(versions),
    readNpmPackageJson: (): PackageJsonReadAnswer => readFixedRootFileInternal(npmDir, [PACKAGE_FILE], PACKAGE_JSON_MAX_BYTES),
    readDeclaredPackageJson: (): PackageJsonReadAnswer => readFixedRootFileInternal(declaredDir, [PACKAGE_FILE], PACKAGE_JSON_MAX_BYTES),
    readInstalledPackageJson: (name: string): PackageJsonReadAnswer => {
      const segments = installedSegments(name);
      return segments === undefined ? FAILED : readFixedRootFileInternal(modulesDir, segments, PACKAGE_JSON_MAX_BYTES);
    },
  };
  return { ok: true, value: Object.freeze(port) };
}
