// Ground_Truth access-denial verification, task 4.2 (design D19, "Task 4.2 design decisions (2026-11-17)", item 2).
// Types only. This module is separate from the Payload_Auditor (R2.14, D14): it imports nothing from ai-client, verifier, analyzer,
// config/startup.ts or the mayStartRun module, and none of them imports it.
import type { Json } from "../schema/types.js";

/** One port answer. It never carries content, names or paths. A timeout is the code `timeout`. */
export type ProbeOutcome = { readonly kind: "ok" } | { readonly kind: "error"; readonly code: string };

/** denied: EACCES, EPERM. absent: ENOENT, ENOTDIR. readable: ok. unexpected: every other code, `timeout`, `port_failed`. */
export type ErrnoClass = "denied" | "absent" | "readable" | "unexpected";

export interface ScratchPaths {
  readonly kind: "ok";
  readonly readableDir: string;
  readonly readableFile: string;
  readonly deniedDir: string;
  readonly deniedChild: string;
  readonly absent: string;
}

export interface IsolationDeps {
  /** PHOENIX_RUN_ID as read by the composition root. Not part of `expected`. Task 4.2 does not claim that it corresponds to the Launcher, the attestation or the RunLease (task 4.9). */
  readonly runId: string;
  readonly fs: {
    stat(p: string): Promise<ProbeOutcome>;
    list(p: string): Promise<ProbeOutcome>;
    read(p: string): Promise<ProbeOutcome>;
  };
  /** `/tmp/phoenix-isolation-<runId>/` only; never `/run/out`. */
  readonly scratch: {
    prepare(): Promise<ScratchPaths | { readonly kind: "error"; readonly code: string }>;
    cleanup(): Promise<ProbeOutcome>;
  };
  readonly proc: { ids(): { readonly uid: number; readonly euid: number; readonly gid: number } };
  /** `tryCreate` is O_CREAT|O_EXCL of `/.phoenix-rootfs-probe-<runId>`; `removeCreated` is called at most once. */
  readonly rootfs: { tryCreate(): Promise<ProbeOutcome>; removeCreated(): Promise<ProbeOutcome> };
  /** Names only; values never reach the module. */
  readonly env: { names(): readonly string[] };
  readonly attestation: {
    read(): Promise<{ readonly kind: "ok"; readonly json: unknown } | { readonly kind: "missing" | "unreadable" | "unparsable" }>;
  };
  readonly bundle: { files(): Promise<readonly { readonly rel: string; readonly text: string }[] | undefined> };
}

/** Data only. Every field is `readonly string` or `readonly string[]`; there is no boolean, enum, optional or waiver field (R15.14). */
export interface IsolationExpectation {
  readonly allowedEnvNames: readonly string[];
}

export type CheckId = "import_analysis" | "read_denial" | "mount_inspection" | "uid" | "rootfs_readonly" | "env_names";

export type FailureCode =
  | "not_measured"
  | "port_failed"
  | "timeout"
  | "readable"
  | "unexpected_errno"
  | "control_failed"
  | "cleanup_failed"
  | "attestation_invalid"
  | "mounts_differ"
  | "networks_differ"
  | "container_mismatch"
  | "profile_mismatch"
  | "launcher_not_ok"
  | "forbidden_import"
  | "unclassified_syntax"
  | "root_user"
  | "rootfs_writable"
  | "rootfs_inconclusive"
  | "rootfs_stale_probe"
  | "env_unexpected";

export interface IsolationCheck {
  readonly id: CheckId;
  readonly status: "verified" | "failed";
  readonly measuredBy: "runtime" | "launcher";
  readonly measured: Json;
}

export interface AccessDenialResult {
  readonly status: "verified" | "failed";
  readonly runId: string;
  readonly checks: readonly IsolationCheck[];
}

export const CHECK_ORDER: readonly CheckId[] = Object.freeze([
  "import_analysis",
  "read_denial",
  "mount_inspection",
  "uid",
  "rootfs_readonly",
  "env_names",
] as const);

/** Fixed list of what the Launcher attestation does not measure (design item 6). */
export const MOUNT_NOT_MEASURED: readonly string[] = Object.freeze([
  "mount_source_kind",
  "mount_type",
  "container_environment",
  "user",
  "read_only_root_flag",
  "capability_drop",
  "image_digest",
]);

/** Residual-risk ids that the orchestrator records as `unresolved` (design item 10). */
export const RESIDUAL_RISK_IDS: readonly string[] = Object.freeze([
  "read_denial_positive_control_unverified",
  "mount_inspection_source_kind_unmeasured",
  "mount_inspection_run_binding_weak",
  "mount_inspection_pre_start_snapshot",
  "import_analysis_self_attestation",
  "env_values_not_inspected",
]);
