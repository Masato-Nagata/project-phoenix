// The Run_Lease gate (design: "Lease timing": start-up liveness proof, running rule, hold; R9.4, R9.5, R24.9, R24.12, R24.15; task 2.15).
//
// `check()` is the only way to ask whether a request may be sent. It never answers `valid` before the start-up proof has passed,
// so no request can be sent before the runtime has seen the counter change. After the proof, each check reads the lease once;
// an indeterminate reading is repeated up to three times 100 ms apart, then the request is held (the check is repeated every P)
// until the reading is determinate or U has passed since the first indeterminate reading; then the lease is `unreadable`.
// The gate never sends anything and never writes.
import { LeaseCheckInterrupted, type LeaseCheckOptions, type LeasePort, type LeaseState, type MonotonicClock, type Sleeper } from "./types.js";
import type { LeaseTiming } from "./timing.js";
import type { LeaseWatcher } from "./watcher.js";

export interface RunLeaseDeps {
  readonly watcher: LeaseWatcher;
  readonly clock: MonotonicClock;
  readonly sleeper: Sleeper;
  readonly timing: LeaseTiming;
}

const RETRIES = 3;
const RETRY_GAP_MS = 100;
const unreadable = (): LeaseState => Object.freeze({ valid: false as const, reason: "unreadable" as const, cause: "read_hold_expired" as const });
const stale = (): LeaseState => Object.freeze({ valid: false as const, reason: "heartbeat_stale" as const, cause: "no_counter_change" as const });

export class RunLease implements LeasePort {
  private readonly deps: RunLeaseDeps;
  private proven = false;
  private latched: LeaseState | undefined;

  constructor(deps: RunLeaseDeps) {
    this.deps = deps;
  }

  /** True once the start-up proof has passed. */
  get isProven(): boolean {
    return this.proven;
  }

  async check(options: LeaseCheckOptions = {}): Promise<LeaseState> {
    if (this.latched !== undefined) return this.latched;
    const state = this.proven ? await this.gate(options) : await this.proof(options);
    if (!state.valid) this.latched = state;
    else this.proven = true;
    return state;
  }

  /** Waits, but gives up when the signal is aborted or the deadline has passed. */
  private async wait(ms: number, options: LeaseCheckOptions): Promise<void> {
    const { clock, sleeper } = this.deps;
    const interrupted = (): void => {
      if (options.signal?.aborted === true) throw new LeaseCheckInterrupted("aborted");
      if (options.deadlineAtMs !== undefined && clock.nowMs() >= options.deadlineAtMs) throw new LeaseCheckInterrupted("deadline");
    };
    interrupted();
    const limit = options.deadlineAtMs === undefined ? ms : Math.max(0, Math.min(ms, options.deadlineAtMs - clock.nowMs()));
    try {
      await sleeper.sleep(limit, options.signal);
    } catch {
      // The sleeper gives up when the signal aborts; `interrupted` below tells the abort from any other failure.
    }
    interrupted();
  }

  /**
   * Start-up liveness proof: the counter must change within S of the first reading. A stopped Launcher cannot produce a change,
   * so no value of S lets it pass; a copied or old directory is stopped by the nonce and the run id. The number of polls is also
   * bounded: a clock that does not move cannot be trusted to end the wait, and the safe answer is "stale".
   */
  private async proof(options: LeaseCheckOptions): Promise<LeaseState> {
    const { watcher, clock, timing } = this.deps;
    const t0 = clock.nowMs();
    const maxPolls = Math.ceil(timing.staleAfterMs / timing.watchIntervalMs) * 4 + 10;
    let firstIndeterminate: number | undefined;
    let sawChange = false; // a change seen while a file could not be read still counts: it is the sign of a live writer
    for (let polls = 1; ; polls += 1) {
      const reading = watcher.poll();
      const now = clock.nowMs();
      if (reading.changed) sawChange = true;
      if (reading.kind === "determinate") {
        if (!reading.state.valid || sawChange) return reading.state;
        firstIndeterminate = undefined;
      } else {
        firstIndeterminate ??= now;
        if (now - firstIndeterminate >= timing.holdLimitMs) return unreadable();
      }
      if (now - t0 >= timing.staleAfterMs || polls >= maxPolls) return stale();
      await this.wait(timing.watchIntervalMs, options);
    }
  }

  /** The check before a request, after the proof (running rule and hold). */
  private async gate(options: LeaseCheckOptions): Promise<LeaseState> {
    const { watcher, clock, timing } = this.deps;
    let reading = watcher.poll();
    if (reading.kind === "determinate") return reading.state;
    const first = clock.nowMs();
    for (let i = 0; i < RETRIES; i += 1) {
      await this.wait(RETRY_GAP_MS, options);
      reading = watcher.poll();
      if (reading.kind === "determinate") return reading.state;
    }
    for (;;) {
      const elapsed = clock.nowMs() - first;
      if (elapsed >= timing.holdLimitMs) return unreadable();
      await this.wait(Math.min(timing.watchIntervalMs, timing.holdLimitMs - elapsed), options);
      reading = watcher.poll();
      if (reading.kind === "determinate") return reading.state;
    }
  }
}