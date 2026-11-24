// The production Runner factory of the Loop_Orchestrator (task 4.9-B): the verifier `createRunner` with the Node.js HTTP adapter.
//
// What the factory closes over: the monotonic clock and the sleeper of the runtime, the lease heartbeat interval H of the proven lease (for
// the in-flight lease watch, P = `watchIntervalOf(H)`), and the HTTP port constructor. Everything else comes from the orchestrator's input:
// the SAME lease instance that stage B proved, the policy and the preparation table of the ticket, the mask, the configured base address,
// the time limits, and the acceptance check over the committed records. The address policy is the verifier default.
//
// Creating the factory, or calling it, sends nothing: `createHttpPort` only stores its origin, and `createRunner` only validates its
// dependencies (a refusal throws `RunnerStartRefused`, which the orchestrator turns into `runner_start_refused`). The first request is the
// health check that the orchestrator makes after the start gate and the start records.
import { DEFAULT_ADDRESS_POLICY, createHttpPort, createRunner, watchIntervalOf } from "@phoenix/verifier";
import type { ExperimentRunner, HttpPort, MonotonicClock, RunnerDeps, Sleeper } from "@phoenix/verifier";

/** What the orchestrator passes (the shape of its `RunnerFactoryInput`, with the verifier types). */
export interface ProductionRunnerInput {
  readonly lease: RunnerDeps["lease"];
  readonly policy: RunnerDeps["policy"];
  readonly table: RunnerDeps["prepTable"];
  readonly mask: RunnerDeps["mask"];
  readonly baseAddress: string;
  readonly limits: RunnerDeps["limits"];
  isAccepted: RunnerDeps["isAccepted"];
}

export interface RunnerFactoryOptions {
  readonly clock: MonotonicClock;
  readonly sleeper: Sleeper;
  /** H of the lease that stage B proved. */
  readonly heartbeatIntervalMs: number;
  /** The HTTP port for an origin. Default: the Node.js adapter of the verifier. */
  readonly createHttp?: (origin: string) => HttpPort;
}

export function createRunnerFactory(options: RunnerFactoryOptions): (input: ProductionRunnerInput) => ExperimentRunner {
  const createHttp = options.createHttp ?? ((origin: string): HttpPort => createHttpPort({ origin }));
  const intervalMs = watchIntervalOf(options.heartbeatIntervalMs);
  return (input: ProductionRunnerInput): ExperimentRunner =>
    createRunner({
      http: createHttp(input.baseAddress),
      lease: input.lease,
      prepTable: input.table,
      policy: input.policy,
      mask: input.mask,
      baseAddress: input.baseAddress,
      addressPolicy: DEFAULT_ADDRESS_POLICY,
      limits: input.limits,
      clock: options.clock,
      isAccepted: input.isAccepted,
      inFlightWatch: { intervalMs, sleeper: options.sleeper },
    });
}