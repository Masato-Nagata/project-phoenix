// Container side of the lease timing measurement (task 2.27; design "Lease timing measurement (not a Discovery Run)").
// It runs the lease watcher of task 2.15 unchanged and acknowledges what it observes. It touches no Legacy_App, no Test API, and no
// network (the container has --network none); it writes only into the acknowledgement directory.
//
// Modes:
//   propagate  - for every new counter value v seen in heartbeat, create `<ack>/beat-<v>` at once; at the end (revoked, or the time
//                limit) write `<ack>/observer.json` with the gaps between observed changes on the monotonic clock.
//   startup    - run the start-up liveness proof of RunLease; then one health request through a counting port that has no network.
//                Write `<ack>/startup.json` with the result and the number of requests that reached the port.
//   kill       - run the proof, write `<ack>/proof-passed`, then check the lease every P and exit with code 3 when it becomes invalid.
import { RunLease } from "../lease/runLease.js";
import { LeaseWatcher, parseCounter } from "../lease/watcher.js";
import type { LeaseDirView, LeaseState, MonotonicClock, Sleeper } from "../lease/types.js";
import type { LeaseTiming } from "../lease/timing.js";

export type MeasureMode = "propagate" | "startup" | "kill";

export interface AckWriter {
  /** Creates or replaces a file in the acknowledgement directory. */
  write(name: string, text: string): void;
}

export interface MeasureDeps {
  readonly view: LeaseDirView;
  readonly clock: MonotonicClock;
  readonly sleeper: Sleeper;
  readonly ack: AckWriter;
  readonly runId: string;
  readonly nonce: string;
  readonly timing: LeaseTiming;
  /** Poll interval of the propagation observer (small, so that the round trip is dominated by the propagation delay). */
  readonly observePollMs?: number;
  /** Upper bound of a propagation phase on the monotonic clock. */
  readonly maxObserveMs?: number;
}

export async function observePropagation(deps: MeasureDeps): Promise<{ beats: number; gaps: number[] }> {
  const poll = deps.observePollMs ?? 5;
  const max = deps.maxObserveMs ?? 30 * 60 * 1000;
  const start = deps.clock.nowMs();
  let last: number | undefined;
  let lastChangeAt: number | undefined;
  const gaps: number[] = [];
  let beats = 0;
  for (;;) {
    const revoked = deps.view.readRevoked();
    if (revoked.kind === "ok") break;
    const hb = deps.view.readHeartbeat();
    if (hb.kind === "ok") {
      const v = parseCounter(hb.text);
      if (v !== undefined && (last === undefined || v > last)) {
        const now = deps.clock.nowMs();
        deps.ack.write(`beat-${v}`, "");
        if (lastChangeAt !== undefined) gaps.push(Math.round(now - lastChangeAt));
        lastChangeAt = now;
        last = v;
        beats += 1;
      }
    }
    if (deps.clock.nowMs() - start > max) break;
    await deps.sleeper.sleep(poll);
  }
  deps.ack.write("observer.json", JSON.stringify({ beats, gaps }));
  return { beats, gaps };
}

function gateOf(deps: MeasureDeps): RunLease {
  const watcher = new LeaseWatcher({ view: deps.view, clock: deps.clock, runId: deps.runId, nonce: deps.nonce, timing: deps.timing });
  return new RunLease({ watcher, clock: deps.clock, sleeper: deps.sleeper, timing: deps.timing });
}

/** The proof, then one request to a port without network, sent only if the lease says valid. */
export async function startupTrial(deps: MeasureDeps): Promise<{ result: "passed" | "refused"; reason?: string; requests: number }> {
  const lease = gateOf(deps);
  let requests = 0;
  const state: LeaseState = await lease.check();
  if (state.valid) requests += 1; // the request would be sent here; the port of this harness has no network
  const out = state.valid ? { result: "passed" as const, requests } : { result: "refused" as const, reason: state.reason, requests };
  deps.ack.write("startup.json", JSON.stringify(out));
  return out;
}

/** The proof, then the running rule every P until the lease is invalid. Returns the exit code of the container. */
export async function killTrial(deps: MeasureDeps): Promise<number> {
  const lease = gateOf(deps);
  const first = await lease.check();
  if (!first.valid) {
    deps.ack.write("proof-refused", first.reason);
    return 2;
  }
  deps.ack.write("proof-passed", "");
  for (;;) {
    await deps.sleeper.sleep(deps.timing.watchIntervalMs);
    const s = await lease.check();
    if (!s.valid) return 3;
  }
}