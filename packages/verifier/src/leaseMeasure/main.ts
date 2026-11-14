// Entry point of the lease measurement container (task 2.27). Started only by Measure-LeaseTiming.ps1 with --network none, the lease
// directory read-only at /run/lease, the acknowledgement directory read-write at /run/ack, and the packages and node_modules read-only.
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createFsLeaseView } from "../lease/fsLeaseView.js";
import { createSystemClock, createSystemSleeper } from "../lease/system.js";
import { checkLeaseTiming } from "../lease/timing.js";
import { killTrial, observePropagation, startupTrial, type MeasureMode } from "./harness.js";

const ACK = "/run/ack";

async function main(): Promise<number> {
  const mode = (process.env["PHOENIX_MEASURE_MODE"] ?? "") as MeasureMode;
  const h = Number(process.env["PHOENIX_LEASE_H_MS"] ?? "");
  const s = Number(process.env["PHOENIX_LEASE_S_MS"] ?? "");
  // D is what this measurement determines; the harness's own watcher is built with D = 0 (S does not depend on D).
  const timing = checkLeaseTiming({ heartbeatIntervalMs: h, staleAfterMs: s }, 0);
  if (!timing.ok) {
    process.stderr.write(`invalid settings: ${timing.error.join(",")}\n`);
    return 2;
  }
  const deps = {
    view: createFsLeaseView("/run/lease"),
    clock: createSystemClock(),
    sleeper: createSystemSleeper(),
    ack: {
      write(name: string, text: string): void {
        const tmp = join(ACK, `.${name}.tmp`);
        writeFileSync(tmp, text, "utf8");
        renameSync(tmp, join(ACK, name));
      },
    },
    runId: process.env["PHOENIX_RUN_ID"] ?? "",
    nonce: process.env["PHOENIX_LEASE_NONCE"] ?? "",
    timing: timing.value,
  };
  switch (mode) {
    case "propagate":
      await observePropagation(deps);
      return 0;
    case "startup":
      await startupTrial(deps);
      return 0;
    case "kill":
      return killTrial(deps);
    default:
      process.stderr.write("unknown mode\n");
      return 2;
  }
}

main().then(
  (code) => { process.exitCode = code; },
  () => { process.exitCode = 1; },
);