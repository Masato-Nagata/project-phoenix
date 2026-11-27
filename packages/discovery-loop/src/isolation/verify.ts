// Ground_Truth access-denial verification, task 4.2 (R15.2, R15.3, R15.11, R15.12, R15.13, R15.14, R15.16).
//
// `verifyGroundTruthAccessDenial(deps, expected)` measures six checks and reports all of them, in a fixed order, even after a failure.
// It never throws and has no waiver parameter, flag or setting. It writes no Run content and never touches `/run/out`.
//
// SCOPE OF A `verified` RESULT. It means that, in this Run, the six measurements below passed. It is NOT proof of real container
// isolation and NOT the independent access-denial assurance of R15.14: the runtime has no `evaluation/` mount, so `read_denial` normally
// observes `absent`, and the independent assurance exists only with the task 4.11 evidence. Real-container behavior is UNVERIFIED until
// tasks 4.9, 4.11 and 4.14. Neither this result nor the Payload_Audit result is evidence for the other (R2.15, R15.16).
import { createHash } from "node:crypto";

import type { Json } from "../schema/types.js";
import { validateAttestation } from "./attestation.js";
import { classifyOutcome, isProbeOutcome } from "./classify.js";
import { importScanSelfCheck, scanBundle } from "./importScan.js";
import { PROBE_LOCATIONS, PROBE_OPS, PROBE_SET_SHA256, type ProbeOp } from "./probeSet.js";
import {
  CHECK_ORDER,
  MOUNT_NOT_MEASURED,
  type AccessDenialResult,
  type BundleSnapshot,
  type CheckId,
  type FailureCode,
  type IsolationCheck,
  type IsolationDeps,
  type IsolationExpectation,
  type ProbeOutcome,
  type ScratchPaths,
} from "./types.js";

/** Upper bound of one port call. A port that does not answer in time fails its check with `timeout`. */
export const PORT_TIMEOUT_MS = 5000;

/** Names that the Launcher sets in the `run` profile (design, "Environment"). */
export const MODULE_ENV_NAMES: readonly string[] = Object.freeze(["HOME", "PHOENIX_LEASE_D_MS", "PHOENIX_LEASE_NONCE", "PHOENIX_RUN_ID"]);

/**
 * Names that the runtime base provides in a real container: the image defaults of the pinned Node.js base image and of
 * `infra/discovery/runtime.Dockerfile` (`PATH`, `NODE_VERSION`, `NODE_ENV`, `NPM_CONFIG_UPDATE_NOTIFIER`) and the name that Docker adds at
 * run time (`HOSTNAME`). A FIXED list, taken from the real-container measurement of task 4.9-E1 (2026-11-25). It is NOT derived from
 * `process.env` at run time, and it has no wildcard or prefix rule: a name that was not observed (for example `YARN_VERSION`) is not on it.
 * It allows these NAMES to be present only. It grants no permission to read a value, to send anything to an AI service, or to widen an
 * Approval, and it is not re-exported from `index.ts`. `env_values_not_inspected` stays an open residual risk.
 */
export const RUNTIME_BASE_ENV_NAMES: readonly string[] = Object.freeze(["HOSTNAME", "NODE_ENV", "NODE_VERSION", "NPM_CONFIG_UPDATE_NOTIFIER", "PATH"]);

/**
 * Longest wait for a port call that already timed out (a late scratch preparation or a late root-file-system creation) to settle
 * before the module cleans up. It is a verify-level bound on top of `PORT_TIMEOUT_MS`; every wait of the module is finite.
 */
export const SETTLE_GRACE_MS = 3000;

/**
 * Builds `allowedEnvNames` from names plus the module constants: `MODULE_ENV_NAMES` (`HOME`, `PHOENIX_LEASE_D_MS`, `PHOENIX_LEASE_NONCE`,
 * `PHOENIX_RUN_ID`) and `RUNTIME_BASE_ENV_NAMES` (`HOSTNAME`, `NODE_ENV`, `NODE_VERSION`, `NPM_CONFIG_UPDATE_NOTIFIER`, `PATH`).
 * It is a pure function of its argument and those nine fixed names and adds nothing else.
 * The caller (task 4.4) must pass ONLY names from `approval.envVarsRead`, never `approval.credentials`: a credential must not be brought
 * into the runtime (human decision of 2026-11-17, decision 2; it supersedes the `credentials` wording of tasks.md 4.2 item (2)).
 */
export function composeAllowedEnvNames(approvalNames: readonly string[]): readonly string[] {
  return Object.freeze([...new Set([...MODULE_ENV_NAMES, ...RUNTIME_BASE_ENV_NAMES, ...approvalNames])].sort());
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** `pending` is set only for a timeout: the underlying call, kept so that the module can wait for it (bounded) before it cleans up. Its value is never used. */
type Guarded<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "failed"; readonly code: "port_failed" | "timeout"; readonly pending?: Promise<unknown> };

const noop = (): void => undefined;

/** onTimeout runs once when the wait ends by the timer (used to abort a walk that is still running); it never changes the result. */
async function guard<T>(call: () => Promise<T> | T, onTimeout?: () => void): Promise<Guarded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const pending: Promise<unknown> = Promise.resolve().then(call);
    pending.then(noop, noop); // a late rejection is never an unhandled rejection
    const timeout = new Promise<"__timeout__">((resolve) => {
      timer = setTimeout(() => resolve("__timeout__"), PORT_TIMEOUT_MS);
    });
    const r = await Promise.race([pending, timeout]);
    if (r === "__timeout__") {
      try {
        onTimeout?.();
      } catch {
        /* an abort handler never changes the result */
      }
      return { kind: "failed", code: "timeout", pending };
    }
    return { kind: "value", value: r as T };
  } catch {
    return { kind: "failed", code: "port_failed" };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

type Settled = { readonly settled: true; readonly value: unknown } | { readonly settled: false };

/** Waits for a pending call for at most `ms`. A rejection counts as settled. The timer is always cleared. */
async function settle(pending: Promise<unknown> | undefined, ms: number): Promise<Settled> {
  if (pending === undefined) return { settled: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const wait = new Promise<Settled>((resolve) => {
      timer = setTimeout(() => resolve({ settled: false }), ms);
    });
    const finished = pending.then(
      (value): Settled => ({ settled: true, value }),
      (): Settled => ({ settled: true, value: undefined }),
    );
    return await Promise.race([finished, wait]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Freezes a value and everything reachable from it. Cycle-safe (a visited set); no dependency. */
function deepFreeze<T>(value: T, seen: WeakSet<object> = new WeakSet<object>()): T {
  if (typeof value !== "object" || value === null || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
  return Object.freeze(value);
}

/** A probe answer as a closed outcome: a failed or malformed port answer becomes an error outcome that classifies as `unexpected`. */
async function probe(call: () => Promise<ProbeOutcome>): Promise<ProbeOutcome> {
  const g = await guard(call);
  if (g.kind === "failed") return { kind: "error", code: g.code };
  return isProbeOutcome(g.value) ? g.value : { kind: "error", code: "port_failed" };
}

const done = (id: CheckId, ok: boolean, measuredBy: "runtime" | "launcher", measured: { [k: string]: Json }): IsolationCheck =>
  Object.freeze({ id, status: ok ? "verified" : "failed", measuredBy, measured: Object.freeze(measured) as Json });

const failedCheck = (id: CheckId, measuredBy: "runtime" | "launcher", reason: FailureCode, extra: { [k: string]: Json } = {}): IsolationCheck =>
  done(id, false, measuredBy, { ...extra, reason });

// ------------------------------------------------------------------------------------------------------------------------------------
// import_analysis
/** The codes that the bundle walk may give (	imeout is the abort of the walk). */
const BUNDLE_CODES: ReadonlySet<string> = new Set(['timeout', 'bundle_path_invalid', 'bundle_duplicate', 'bundle_changed', 'bundle_limit_exceeded', 'bundle_empty_root', 'bundle_read_failed', 'bundle_unsupported_entry']);

async function checkImportAnalysis(deps: IsolationDeps): Promise<IsolationCheck> {
  if (!importScanSelfCheck()) return failedCheck("import_analysis", "runtime", "control_failed");
  // One walk gives the text and the `bundleSha256` (design.md, item 7a). A port without `snapshot` (a test fake) gives the text only: then no
  // `bundleSha256` is recorded. After a timeout the walk is told to stop, and its end is awaited for a bounded time (the handles are closed).
  let snapshotFn: ((signal: AbortSignal) => Promise<BundleSnapshot>) | undefined;
  try {
    const f = deps.bundle.snapshot;
    if (typeof f === "function") snapshotFn = f.bind(deps.bundle);
  } catch {
    return failedCheck("import_analysis", "runtime", "port_failed");
  }
  let files: unknown;
  let bundleSha256: string | undefined;
  if (snapshotFn !== undefined) {
    const call = snapshotFn;
    const ac = new AbortController();
    const g = await guard(() => call(ac.signal), () => ac.abort());
    if (g.kind === "failed") {
      await settle(g.pending, SETTLE_GRACE_MS);
      return failedCheck("import_analysis", "runtime", g.code);
    }
    const s: unknown = g.value;
    if (typeof s !== "object" || s === null) return failedCheck("import_analysis", "runtime", "not_measured");
    const o = s as { ok?: unknown; code?: unknown; files?: unknown; bundleSha256?: unknown };
    if (o.ok === false) return failedCheck("import_analysis", "runtime", typeof o.code === "string" && BUNDLE_CODES.has(o.code) ? (o.code as FailureCode) : "not_measured");
    if (o.ok !== true || typeof o.bundleSha256 !== "string" || !/^[0-9a-f]{64}$/.test(o.bundleSha256)) return failedCheck("import_analysis", "runtime", "not_measured");
    files = o.files;
    bundleSha256 = o.bundleSha256;
  } else {
    const g = await guard(() => deps.bundle.files());
    if (g.kind === "failed") return failedCheck("import_analysis", "runtime", g.code);
    files = g.value;
  }
  if (!Array.isArray(files) || !files.every((f) => typeof f === "object" && f !== null && typeof f.rel === "string" && typeof f.text === "string")) {
    return failedCheck("import_analysis", "runtime", "not_measured");
  }  const r = scanBundle(files);
  const base = {
    filesTotal: r.filesTotal,
    filesScanned: r.filesScanned,
    specifierCount: r.specifierCount,
    bareSpecifierCount: r.bareSpecifierCount,
    textSha256: r.textSha256,
    findingCount: r.findings.length,
    findings: r.findings.slice(0, 20).map((f) => ({ file: f.file, code: f.code, kind: f.kind })),
  };
  if (r.filesScanned === 0) return failedCheck("import_analysis", "runtime", "not_measured", base);
  if (r.findings.some((f) => f.code === "forbidden_import")) return failedCheck("import_analysis", "runtime", "forbidden_import", base);
  if (r.findings.length > 0) return failedCheck("import_analysis", "runtime", "unclassified_syntax", base);
  // the hash is recorded only when the whole check is verified (a failed check never carries it)
  return done("import_analysis", true, "runtime", bundleSha256 === undefined ? base : { ...base, bundleSha256 });
}

// ------------------------------------------------------------------------------------------------------------------------------------
// read_denial
const OPS: { readonly [K in ProbeOp]: (d: IsolationDeps, p: string) => Promise<ProbeOutcome> } = {
  stat: (d, p) => probe(() => d.fs.stat(p)),
  list: (d, p) => probe(() => d.fs.list(p)),
  read: (d, p) => probe(() => d.fs.read(p)),
};

async function controlsHold(deps: IsolationDeps, s: ScratchPaths): Promise<{ readable: boolean; denied: boolean; absent: boolean }> {
  const all = async (cls: "readable" | "denied" | "absent", paths: { stat: string; list: string; read: string }): Promise<boolean> => {
    let ok = true;
    for (const op of PROBE_OPS) if (classifyOutcome(await OPS[op](deps, paths[op])) !== cls) ok = false;
    return ok;
  };
  return {
    readable: await all("readable", { stat: s.readableFile, read: s.readableFile, list: s.readableDir }),
    denied: await all("denied", { stat: s.deniedChild, read: s.deniedChild, list: s.deniedDir }),
    absent: await all("absent", { stat: s.absent, read: s.absent, list: s.absent }),
  };
}

const isScratch = (v: unknown): v is ScratchPaths => {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return o["kind"] === "ok" && ["readableDir", "readableFile", "deniedDir", "deniedChild", "absent"].every((k) => typeof o[k] === "string" && (o[k] as string).length > 0);
};

async function checkReadDenial(deps: IsolationDeps, euid: number | undefined): Promise<{ check: IsolationCheck; tmpWritable: boolean }> {
  const reasons: FailureCode[] = [];
  const counts = { absent: 0, denied: 0, readable: 0, unexpected: 0 };
  let controls: { readable: boolean; denied: boolean; absent: boolean } = { readable: false, denied: false, absent: false };
  let tmpWritable = false;

  if (euid === undefined || euid === 0) reasons.push("control_failed");

  const prep = await guard(() => deps.scratch.prepare());
  const prepareTimedOut = prep.kind === "failed" && prep.code === "timeout";
  if (prep.kind === "failed" || !isScratch(prep.value)) {
    if (prepareTimedOut) reasons.push("timeout"); // a late value of the pending prepare is never used
    reasons.push("control_failed");
  } else {
    tmpWritable = true;
    controls = await controlsHold(deps, prep.value);
    if (!controls.readable || !controls.denied || !controls.absent) reasons.push("control_failed");
  }

  for (const loc of PROBE_LOCATIONS) {
    for (const op of PROBE_OPS) {
      const out = await OPS[op](deps, loc.path);
      const cls = classifyOutcome(out);
      counts[cls]++;
      if (cls === "readable") reasons.push("readable");
      else if (cls === "unexpected") reasons.push(out.kind === "error" && (out.code === "timeout" || out.code === "port_failed") ? (out.code as FailureCode) : "unexpected_errno");
    }
  }

  // If prepare timed out, its call may still be running. Wait for it at most SETTLE_GRACE_MS (finite), so that a late creation is not
  // cleaned up before it exists. Then cleanup is called exactly once, also after earlier failures. A failed or unconfirmed cleanup fails the check.
  let scratchSettled = true;
  if (prep.kind === "failed" && prepareTimedOut) scratchSettled = (await settle(prep.pending, SETTLE_GRACE_MS)).settled;
  const cl = await probe(() => deps.scratch.cleanup());
  const cleanupTimedOut = cl.kind === "error" && cl.code === "timeout";
  const cleanupOk = cl.kind === "ok" && scratchSettled;
  const unconfirmed = cleanupTimedOut || !scratchSettled;
  if (cleanupTimedOut) reasons.push("timeout");
  if (!cleanupOk) reasons.push("cleanup_failed");

  const unique = [...new Set(reasons)];
  const measured: { [k: string]: Json } = {
    probeSetSha256: PROBE_SET_SHA256,
    locations: PROBE_LOCATIONS.length,
    probes: PROBE_LOCATIONS.length * PROBE_OPS.length,
    absentCount: counts.absent,
    deniedCount: counts.denied,
    readableCount: counts.readable,
    unexpectedCount: counts.unexpected,
    assurance: counts.denied > 0 ? "denied_observed" : "not_visible_only",
    independentDenialAssurance: "unverified",
    controls: { readable: controls.readable, denied: controls.denied, absent: controls.absent },
    cleanup: cleanupOk ? "ok" : unconfirmed ? "unconfirmed" : "failed",
  };
  if (prepareTimedOut) measured["scratchSettled"] = scratchSettled;
  if (unconfirmed) measured["residuePossible"] = true; // removal is not confirmed: a leftover scratch directory is not excluded
  if (unique.length > 0) {
    measured["reason"] = unique[0] as string;
    measured["reasons"] = unique;
  }
  return { check: done("read_denial", unique.length === 0, "runtime", measured), tmpWritable };
}

// ------------------------------------------------------------------------------------------------------------------------------------
// mount_inspection (measured by the Launcher; re-validated here)
async function checkMountInspection(deps: IsolationDeps): Promise<IsolationCheck> {
  const notMeasured = [...MOUNT_NOT_MEASURED];
  const g = await guard(() => deps.attestation.read());
  if (g.kind === "failed") return failedCheck("mount_inspection", "launcher", g.code, { notMeasured });
  const a = g.value as { kind?: unknown; json?: unknown } | null | undefined;
  if (typeof a !== "object" || a === null) return failedCheck("mount_inspection", "launcher", "attestation_invalid", { notMeasured });
  if (a.kind !== "ok") {
    const detail = a.kind === "missing" || a.kind === "unreadable" || a.kind === "unparsable" ? a.kind : "malformed";
    return failedCheck("mount_inspection", "launcher", "attestation_invalid", { notMeasured, detail });
  }
  const v = validateAttestation(a.json, typeof deps.runId === "string" ? deps.runId : "");
  if (!v.ok) return failedCheck("mount_inspection", "launcher", v.reasons[0] as FailureCode, { notMeasured, reasons: [...v.reasons] });
  return done("mount_inspection", true, "launcher", { notMeasured, mountCount: v.mountCount, networkCount: v.networkCount });
}

// ------------------------------------------------------------------------------------------------------------------------------------
// uid
async function checkUid(deps: IsolationDeps): Promise<{ check: IsolationCheck; euid: number | undefined }> {
  const g = await guard(() => deps.proc.ids());
  if (g.kind === "failed") return { check: failedCheck("uid", "runtime", g.code), euid: undefined };
  const ids = g.value as { uid?: unknown; euid?: unknown; gid?: unknown } | null | undefined;
  const okNum = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x) && x >= 0;
  if (typeof ids !== "object" || ids === null || !okNum(ids.uid) || !okNum(ids.euid) || !okNum(ids.gid)) {
    return { check: failedCheck("uid", "runtime", "port_failed"), euid: undefined };
  }
  if (ids.euid === 0 || ids.uid === 0) {
    return { check: failedCheck("uid", "runtime", "root_user", { euidIsZero: ids.euid === 0, uidIsZero: ids.uid === 0 }), euid: ids.euid };
  }
  return { check: done("uid", true, "runtime", { euidIsZero: false, uidIsZero: false }), euid: ids.euid };
}

// ------------------------------------------------------------------------------------------------------------------------------------
// rootfs_readonly: only EROFS on creation passes (design item 5 (b)).
async function checkRootfs(deps: IsolationDeps, tmpWritable: boolean): Promise<IsolationCheck> {
  const reasons: FailureCode[] = [];
  let removed: "not_needed" | "ok" | "failed" | "unconfirmed" = "not_needed";
  let late: "created" | "not_created" | "unsettled" | undefined;
  // exactly one removal attempt, no retry and no recovery
  const removeOnce = async (): Promise<boolean> => (await probe(() => deps.rootfs.removeCreated())).kind === "ok";
  const g = await guard(() => deps.rootfs.tryCreate());
  const out: ProbeOutcome = g.kind === "failed" ? { kind: "error", code: g.code } : isProbeOutcome(g.value) ? g.value : { kind: "error", code: "port_failed" };
  if (g.kind === "failed" && g.code === "timeout") {
    // The creation may still complete. Wait at most SETTLE_GRACE_MS. Whether the check passed is not decided by a late value.
    reasons.push("timeout");
    const s = await settle(g.pending, SETTLE_GRACE_MS);
    if (s.settled && isProbeOutcome(s.value) && s.value.kind === "ok") {
      late = "created";
      removed = (await removeOnce()) ? "ok" : "failed";
      if (removed === "failed") reasons.push("cleanup_failed");
    } else if (s.settled) {
      late = "not_created";
    } else {
      // Unsettled: the adapter is told once that the check is over (a late creation is then removed by the adapter itself); the
      // removal is never reported as confirmed.
      late = "unsettled";
      await removeOnce();
      removed = "unconfirmed";
      reasons.push("cleanup_failed");
    }
  } else if (out.kind === "ok") {
    reasons.push("rootfs_writable");
    removed = (await removeOnce()) ? "ok" : "failed";
    if (removed === "failed") reasons.push("cleanup_failed");
  } else if (out.code === "EROFS") {
    // passes, subject to the control below
  } else if (out.code === "EACCES" || out.code === "EPERM") {
    reasons.push("rootfs_inconclusive");
  } else if (out.code === "EEXIST") {
    reasons.push("rootfs_stale_probe"); // an existing file is never touched
  } else if (out.code === "timeout" || out.code === "port_failed") {
    reasons.push(out.code);
  } else {
    reasons.push("unexpected_errno");
  }
  // control: creation in /tmp succeeds (the scratch directory could be prepared), else the EROFS observation proves nothing
  if (!tmpWritable) reasons.push("control_failed");
  const unique = [...new Set(reasons)];
  const measured: { [k: string]: Json } = { tmpControl: tmpWritable, removal: removed };
  if (late !== undefined) measured["lateCreation"] = late;
  if (removed === "unconfirmed") measured["residuePossible"] = true;
  if (unique.length > 0) {
    measured["reason"] = unique[0] as string;
    measured["reasons"] = unique;
  }
  return done("rootfs_readonly", unique.length === 0, "runtime", measured);
}

// ------------------------------------------------------------------------------------------------------------------------------------
// env_names: names only. A value never reaches this module; an unexpected name is counted and never written.
async function checkEnvNames(deps: IsolationDeps, expected: IsolationExpectation): Promise<IsolationCheck> {
  const allowedIn: unknown = typeof expected === "object" && expected !== null ? (expected as { allowedEnvNames?: unknown }).allowedEnvNames : undefined;
  if (!Array.isArray(allowedIn) || !allowedIn.every((x) => typeof x === "string")) return failedCheck("env_names", "runtime", "not_measured");
  const allowed = new Set<string>(allowedIn as string[]);
  const allowlistSha256 = sha256([...allowed].sort().join("\n"));
  const g = await guard(() => deps.env.names());
  if (g.kind === "failed") return failedCheck("env_names", "runtime", g.code, { allowlistSha256 });
  const names: unknown = g.value;
  if (!Array.isArray(names) || !names.every((x) => typeof x === "string")) return failedCheck("env_names", "runtime", "port_failed", { allowlistSha256 });
  const unexpectedCount = (names as string[]).filter((n) => !allowed.has(n)).length;
  const measured = { nameCount: names.length, unexpectedCount, allowlistSha256 };
  if (unexpectedCount > 0) return failedCheck("env_names", "runtime", "env_unexpected", measured);
  return done("env_names", true, "runtime", measured);
}

// ------------------------------------------------------------------------------------------------------------------------------------
const issued = new WeakSet<object>();

/** True only for a value that `verifyGroundTruthAccessDenial` returned. A copy or a look-alike is rejected. */
export function isAccessDenialResult(v: unknown): v is AccessDenialResult {
  return typeof v === "object" && v !== null && issued.has(v);
}

export async function verifyGroundTruthAccessDenial(deps: IsolationDeps, expected: IsolationExpectation): Promise<AccessDenialResult> {
  const runId = typeof deps === "object" && deps !== null && typeof deps.runId === "string" ? deps.runId : "";
  const safe = async (id: CheckId, by: "runtime" | "launcher", f: () => Promise<IsolationCheck>): Promise<IsolationCheck> => {
    try {
      return await f();
    } catch {
      return failedCheck(id, by, "port_failed");
    }
  };
  const byId = new Map<CheckId, IsolationCheck>();
  try {
    byId.set("import_analysis", await safe("import_analysis", "runtime", () => checkImportAnalysis(deps)));
    // the uid check runs before read_denial because the sensitivity controls need euid != 0; it is reported in its own place
    let uidOut: { check: IsolationCheck; euid: number | undefined } = { check: failedCheck("uid", "runtime", "port_failed"), euid: undefined };
    try {
      uidOut = await checkUid(deps);
    } catch {
      /* stays failed */
    }
    let rd: { check: IsolationCheck; tmpWritable: boolean } = { check: failedCheck("read_denial", "runtime", "port_failed"), tmpWritable: false };
    try {
      rd = await checkReadDenial(deps, uidOut.euid);
    } catch {
      /* stays failed */
    }
    byId.set("read_denial", rd.check);
    byId.set("mount_inspection", await safe("mount_inspection", "launcher", () => checkMountInspection(deps)));
    byId.set("uid", uidOut.check);
    byId.set("rootfs_readonly", await safe("rootfs_readonly", "runtime", () => checkRootfs(deps, rd.tmpWritable)));
    byId.set("env_names", await safe("env_names", "runtime", () => checkEnvNames(deps, expected)));
  } catch {
    /* every missing entry is filled below as failed */
  }
  const checks = CHECK_ORDER.map((id) => byId.get(id) ?? failedCheck(id, id === "mount_inspection" ? "launcher" : "runtime", "port_failed"));
  // Deeply immutable: checks, each check, `measured` and every nested array or object. Frozen before the brand is registered.
  const result: AccessDenialResult = deepFreeze({
    status: checks.every((c) => c.status === "verified") ? ("verified" as const) : ("failed" as const),
    runId,
    checks,
  });
  issued.add(result);
  return result;
}
