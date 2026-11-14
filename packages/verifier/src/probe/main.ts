// Entry point of the probe container (task 2.20). Started only by the Launcher with the probe profile: the lease directory read-only at
// /run/lease, the Run_Volume at /run/out (the only place it writes), the packages and node_modules read-only, and the network
// phoenix-discovery-lab only. Configuration comes from the data files of this package and from three environment variables:
// PHOENIX_RUN_ID, PHOENIX_LEASE_NONCE (not secrets), and PHOENIX_LEASE_D_MS (the measured propagation delay of the lease-timing record).
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { createLeasePort } from "../lease/fsLeaseView.js";
import { createSystemClock, createSystemSleeper } from "../lease/system.js";
import { createHttpPort } from "../runner/httpAdapter.js";
import { PROBE_STATEMENT, runProbe } from "./probe.js";

const data = (name: string): unknown => JSON.parse(readFileSync(new URL(`../../data/${name}`, import.meta.url), "utf8")) as unknown;

async function main(): Promise<number> {
  const runId = process.env["PHOENIX_RUN_ID"] ?? "";
  const nonce = process.env["PHOENIX_LEASE_NONCE"] ?? "";
  const dText = process.env["PHOENIX_LEASE_D_MS"] ?? "";
  const d = /^[0-9]{1,6}$/.test(dText) ? Number(dText) : undefined;
  const config = data("probe-config.json") as { baseAddress?: unknown };
  const clock = createSystemClock();
  const sleeper = createSystemSleeper();
  const { result, exitCode } = await runProbe(
    { runId, propagationDelayMs: d, config, policy: data("policy-config.json"), table: data("preparation-table.json"), mask: data("mask-config.json"), experiments: data("probe-experiments.json") },
    {
      http: createHttpPort({ origin: typeof config.baseAddress === "string" ? config.baseAddress : "" }),
      lease: (timing) => createLeasePort({ directory: "/run/lease", runId, nonce, timing: timing.value, clock, sleeper }),
      clock,
    },
  );
  const text = `${JSON.stringify(result, null, 2)}\n`;
  writeFileSync("/run/out/probe-result.json.tmp", text, { encoding: "utf8", flag: "w" });
  renameSync("/run/out/probe-result.json.tmp", "/run/out/probe-result.json");
  process.stdout.write(`${PROBE_STATEMENT}\nprobe ok: ${String(result.ok)}; requests sent: ${result.totalRequests}\n`);
  return exitCode;
}

main().then(
  (code) => { process.exitCode = code; },
  () => { process.exitCode = 1; },
);