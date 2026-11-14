// Node.js adapter for the lease directory (task 2.15): reads `/run/lease/` and nothing else. It exposes no write, process, Docker,
// or Git operation; only `readFileSync` and `lstatSync` of `node:fs` are imported, and a test checks that.
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RunLease } from "./runLease.js";
import { LeaseWatcher } from "./watcher.js";
import type { LeaseTiming } from "./timing.js";
import type { LeaseDirView, MonotonicClock, ReadResult, Sleeper } from "./types.js";

const MAX_FILE_BYTES = 4096;

function isMissing(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** Reads a regular file of at most 4 KiB. Absent: it does not exist. Error: anything else (a directory, a link, too large, unreadable). */
function readSmallFile(path: string): ReadResult {
  try {
    const st = lstatSync(path);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return { kind: "error" };
    return { kind: "ok", text: readFileSync(path, "utf8") };
  } catch (error) {
    return isMissing(error) ? { kind: "absent" } : { kind: "error" };
  }
}

/** A read-only view of a lease directory. `revoked` is `ok` when anything of that name exists (its presence makes the lease invalid). */
export function createFsLeaseView(directory: string): LeaseDirView {
  return {
    readLeaseJson: () => readSmallFile(join(directory, "lease.json")),
    readHeartbeat: () => readSmallFile(join(directory, "heartbeat")),
    readRevoked: () => {
      try {
        lstatSync(join(directory, "revoked"));
        return { kind: "ok", text: "" };
      } catch (error) {
        return isMissing(error) ? { kind: "absent" } : { kind: "error" };
      }
    },
  };
}

export interface LeasePortConfig {
  readonly directory: string;
  readonly runId: string;
  readonly nonce: string;
  readonly timing: LeaseTiming;
  readonly clock: MonotonicClock;
  readonly sleeper: Sleeper;
}

/** The `LeasePort` of the runtime: the first check runs the start-up proof, every later check applies the running rule. */
export function createLeasePort(config: LeasePortConfig): RunLease {
  const watcher = new LeaseWatcher({ view: createFsLeaseView(config.directory), clock: config.clock, runId: config.runId, nonce: config.nonce, timing: config.timing });
  return new RunLease({ watcher, clock: config.clock, sleeper: config.sleeper, timing: config.timing });
}