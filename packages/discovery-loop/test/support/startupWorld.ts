// Test support for the acceptance tests of task 4.1 (G1 to G3): a synthetic scene (temporary directories, the real adapters of `startupAdapters.ts`,
// a fake clock) and a byte-level snapshot of directories. Synthetic data only; nothing outside the temporary directories is read or written.
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { StartupPorts } from "../../src/index.js";
import { FakeTime, auditPort, envPort, ioPort, leasePort, makeLeaseDir, makeTempDir, policyPort, sandboxPort, syntheticAuditConfig, toBytes, type FakeEnv } from "./startupAdapters.js";

// ---- snapshot -----------------------------------------------------------------------------------
export type SnapshotEntry = { readonly type: "dir" } | { readonly type: "file"; readonly size: number; readonly sha256: string } | { readonly type: "other" } | { readonly type: "absent" };
export type Snapshot = Readonly<Record<string, SnapshotEntry>>;

/**
 * The names, the hierarchy and the bytes of every entry under the given directories (a directory that does not exist is recorded as `absent`).
 * Two snapshots are equal only when every name, every kind and every byte is equal. A symbolic link or other entry is recorded as `other`.
 */
export function snapshotDirs(dirs: Readonly<Record<string, string>>, ignore: (label: string, relative: string) => boolean = () => false): Snapshot {
  const out: Record<string, SnapshotEntry> = {};
  const walk = (label: string, base: string, relative: string): void => {
    const full = relative === "" ? base : join(base, relative);
    let st;
    try {
      st = lstatSync(full);
    } catch {
      out[`${label}:${relative}`] = { type: "absent" };
      return;
    }
    if (ignore(label, relative)) return;
    if (st.isDirectory()) {
      out[`${label}:${relative}`] = { type: "dir" };
      for (const name of readdirSync(full).sort()) walk(label, base, relative === "" ? name : `${relative}/${name}`);
    } else if (st.isFile()) {
      const bytes = readFileSync(full);
      out[`${label}:${relative}`] = { type: "file", size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex") };
    } else {
      out[`${label}:${relative}`] = { type: "other" };
    }
  };
  for (const [label, dir] of Object.entries(dirs)) walk(label, dir, "");
  return out;
}

// ---- scene --------------------------------------------------------------------------------------
export interface SceneOptions {
  env?: FakeEnv;
  audit?: () => Uint8Array | undefined;
  policy?: () => unknown;
  table?: () => unknown;
  destinations?: string[];
  /** The Launcher is played by the fake sleeper: it writes a heartbeat unless this is false. */
  beat?: boolean;
  leaseOpts?: Parameters<typeof makeLeaseDir>[0];
  volume?: "empty" | "missing" | "populated";
  configFiles?: readonly string[] | "missing";
  revoked?: boolean;
}

export interface Scene {
  readonly ports: StartupPorts<any, any, any, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  readonly root: string;
  readonly volume: string;
  readonly configDir: string;
  readonly lease: ReturnType<typeof makeLeaseDir>;
  readonly time: FakeTime;
  /** The directories a start-up check must leave as they are. */
  readonly dirs: Readonly<Record<string, string>>;
  cleanup(): void;
}

export function scene(opts: SceneOptions = {}): Scene {
  const lease = makeLeaseDir(opts.leaseOpts);
  const root = makeTempDir("phoenix-scene-");
  const volume = join(root, "volume");
  const configDir = join(root, "config");
  const kind = opts.volume ?? "empty";
  if (kind !== "missing") mkdirSync(volume);
  if (kind === "populated") {
    writeFileSync(join(volume, "left-over.bin"), Buffer.from([0, 1, 2, 255, 254]));
    mkdirSync(join(volume, "sub", "deep"), { recursive: true });
    writeFileSync(join(volume, "sub", "deep", "records.jsonl"), '{"seq":1}\n{"seq":2}\n');
  }
  const files = opts.configFiles ?? ["run-config.json", "audit-config.json"];
  if (files !== "missing") {
    mkdirSync(configDir);
    for (const f of files) writeFileSync(join(configDir, f), `{"synthetic":"${f}"}`);
  }
  if (opts.revoked === true) writeFileSync(join(lease.directory, "revoked"), "");
  const env: FakeEnv = opts.env ?? { PHOENIX_RUN_ID: lease.runId, PHOENIX_LEASE_NONCE: lease.nonce, PHOENIX_LEASE_D_MS: "50" };
  const time = new FakeTime();
  if (opts.beat !== false) time.onSleep = () => lease.beat();
  const ports: StartupPorts<any, any, any, any> = { // eslint-disable-line @typescript-eslint/no-explicit-any
    policy: policyPort(opts.policy, opts.table),
    auditConfig: auditPort(() => (opts.audit === undefined ? toBytes(syntheticAuditConfig()) : opts.audit())),
    env: envPort(env),
    sandbox: sandboxPort(() => opts.destinations),
    lease: leasePort(env, lease.directory, time),
    io: ioPort(volume, configDir),
  };
  return {
    ports, root, volume, configDir, lease, time,
    dirs: { root, lease: lease.directory },
    cleanup: () => { for (const d of [root, lease.directory]) rmSync(d, { recursive: true, force: true }); },
  };
}