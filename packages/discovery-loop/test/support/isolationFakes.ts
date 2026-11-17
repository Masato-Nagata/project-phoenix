// Test support for task 4.2: fake ports for the Ground_Truth access-denial verification. Synthetic data only; no access to evaluation/.
import { EXPECTED_RUN_MOUNT_DESTINATIONS } from "../../src/isolation/attestation.js";
import type { IsolationDeps, ProbeOutcome, ScratchPaths } from "../../src/isolation/types.js";

export const RUN_ID = "run-20261114T024339Z-5d10ba5ec199";
export const OK: ProbeOutcome = { kind: "ok" };
export const E = (code: string): ProbeOutcome => ({ kind: "error", code });
export const SCRATCH: ScratchPaths = {
  kind: "ok",
  readableDir: "/tmp/fake/readable",
  readableFile: "/tmp/fake/readable/file.txt",
  deniedDir: "/tmp/fake/denied",
  deniedChild: "/tmp/fake/denied/child.txt",
  absent: "/tmp/fake/absent-path",
};

export function goodAttestation(runId = RUN_ID): Record<string, unknown> {
  return {
    check: "mount_inspection",
    container: `phoenix-discovery-${runId}`,
    profile: "run",
    mounts: [...EXPECTED_RUN_MOUNT_DESTINATIONS],
    networks: ["phoenix-discovery-lab"],
    ok: true,
    problems: [],
  };
}

export const GOOD_BUNDLE = [
  { rel: "dist/a.js", text: 'import { b } from "./b.js";\nimport fs from "node:fs";\nexport const a = b;\n' },
  { rel: "dist/b.js", text: "export const b = 1;\n" },
  { rel: "dist/a.d.ts", text: "export declare const a: number;\n" },
];

export const ALLOWED = ["HOME", "PHOENIX_LEASE_D_MS", "PHOENIX_LEASE_NONCE", "PHOENIX_RUN_ID"];

export interface Behavior {
  runId: string;
  fsOutcome: (op: "stat" | "list" | "read", path: string) => ProbeOutcome | Promise<ProbeOutcome> | "throw";
  prepare: () => Awaited<ReturnType<IsolationDeps["scratch"]["prepare"]>> | "throw";
  cleanup: () => ProbeOutcome | "throw";
  ids: () => { uid: number; euid: number; gid: number } | "throw" | unknown;
  tryCreate: () => ProbeOutcome | "throw";
  removeCreated: () => ProbeOutcome | "throw";
  envNames: () => readonly string[] | "throw" | unknown;
  attestation: () => Awaited<ReturnType<IsolationDeps["attestation"]["read"]>> | "throw" | unknown;
  bundle: () => readonly { rel: string; text: string }[] | undefined | "throw" | unknown;
}

export function defaultFsOutcome(_op: string, path: string): ProbeOutcome {
  if (path === SCRATCH.readableDir || path === SCRATCH.readableFile) return OK;
  if (path === SCRATCH.deniedDir || path === SCRATCH.deniedChild) return E("EACCES");
  return E("ENOENT");
}

export function defaults(): Behavior {
  return {
    runId: RUN_ID,
    fsOutcome: defaultFsOutcome,
    prepare: () => SCRATCH,
    cleanup: () => OK,
    ids: () => ({ uid: 10001, euid: 10001, gid: 10001 }),
    tryCreate: () => E("EROFS"),
    removeCreated: () => OK,
    envNames: () => [...ALLOWED],
    attestation: () => ({ kind: "ok", json: goodAttestation() }),
    bundle: () => GOOD_BUNDLE,
  };
}

export function makeDeps(over: Partial<Behavior> = {}): { deps: IsolationDeps; calls: Record<string, number> } {
  const b = { ...defaults(), ...over };
  const calls: Record<string, number> = {};
  const hit = (k: string): void => {
    calls[k] = (calls[k] ?? 0) + 1;
  };
  const fsOp =
    (op: "stat" | "list" | "read") =>
    async (p: string): Promise<ProbeOutcome> => {
      hit(`fs.${op}`);
      const r = await b.fsOutcome(op, p);
      if (r === "throw") throw new Error("CANARY-fs-message");
      return r;
    };
  const t = <T>(k: string, v: () => T | "throw"): T => {
    hit(k);
    const r = v();
    if (r === "throw") throw new Error("CANARY-port-message");
    return r;
  };
  const deps = {
    runId: b.runId,
    fs: { stat: fsOp("stat"), list: fsOp("list"), read: fsOp("read") },
    scratch: {
      prepare: async () => t("scratch.prepare", b.prepare),
      cleanup: async () => t("scratch.cleanup", b.cleanup),
    },
    proc: { ids: () => t("proc.ids", b.ids as () => { uid: number; euid: number; gid: number } | "throw") },
    rootfs: {
      tryCreate: async () => t("rootfs.tryCreate", b.tryCreate),
      removeCreated: async () => t("rootfs.removeCreated", b.removeCreated),
    },
    env: { names: () => t("env.names", b.envNames as () => readonly string[] | "throw") },
    attestation: { read: async () => t("attestation.read", b.attestation as () => never) },
    bundle: { files: async () => t("bundle.files", b.bundle as () => never) },
  } as IsolationDeps;
  return { deps, calls };
}
