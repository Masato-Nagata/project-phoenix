// Test support for task 4.4, stage 2 (start gate). Synthetic data only; no access to evaluation/, the Approval Store or secrets.
// The startup tickets are REAL: they are issued by `checkStartupRefusals` with in-memory fake ports (the model is `startup.test.ts`).
// The isolation ports are the fakes of task 4.2 (`isolationFakes.ts`). Nothing here starts a process, touches a network or a real directory.
import { checkStartupRefusals, validateRunConfig, type RunConfig } from "../../src/index.js";
import type { StartupApproval } from "../../src/config/startup.js";
import type { IsolationDeps } from "../../src/isolation/types.js";
import type { LoopDeps } from "../../src/orchestrator/types.js";
import { MemoryFileSystem } from "../../src/store/memoryFileSystem.js";
import { goodAttestation, makeDeps, type Behavior } from "./isolationFakes.js";
import { OTHER_SYNTHETIC_RUN_ID, SYNTHETIC_RUN_ID } from "./syntheticRunId.js";

export { OTHER_SYNTHETIC_RUN_ID, SYNTHETIC_RUN_ID };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Any = any;

/** A fictitious value inside the audit configuration of the fixture: it must never appear in any result of the gate. */
export const AUDIT_CANARY = "AUDIT_CANARY_7f3a91";
/** A fictitious credential variable name of a kiro-cli-like ticket. */
export const CREDENTIAL_NAME = "X_KEY";
/** A string that port errors carry; it must never appear in any refusal. */
export const ERROR_CANARY = "CANARY-lease-message-5e2a";

const H64 = (c: string): string => c.repeat(64);

/** The lease instance of the ticket. `check` counts its calls and records its arguments; `behave` decides the answer (it may throw or return a promise). */
export class FakeLease {
  checks = 0;
  lastArgs: unknown[] = [];
  constructor(private readonly behave: () => unknown = () => ({ valid: true })) {}
  check(...args: unknown[]): unknown {
    this.checks += 1;
    this.lastArgs = args;
    return this.behave();
  }
}

/** A class with the name of the verifier error, as the gate recognises it structurally. The real class cannot be imported here. */
export class LeaseCheckInterrupted extends Error {
  constructor() {
    super(ERROR_CANARY);
    this.name = "LeaseCheckInterrupted";
  }
}

export interface IssueOptions {
  provider?: "mock" | "kiro-cli";
  envNames?: string[];
  /** The answer of `lease.port.check()` of the ticket (the gate's check, not the stage B proof). */
  behave?: () => unknown;
  /** Replaces the lease instance of the ticket (for a wrong shape). */
  leaseInstance?: unknown;
  /** The run id that the stage B proof reports and that the ticket keeps. */
  runId?: string;
}

export interface Issued {
  readonly approval: StartupApproval<Any, Any, Any, FakeLease>;
  readonly lease: FakeLease;
  readonly cfg: RunConfig;
}

export async function issueStartup(opts: IssueOptions = {}): Promise<Issued> {
  const provider = opts.provider ?? "mock";
  const envNames = opts.envNames ?? ["EXAMPLE_ONE", "EXAMPLE_TWO"];
  const v = validateRunConfig({ schemaVersion: 1, provider, limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames });
  if (!v.ok) throw new Error(`the test configuration is invalid: ${JSON.stringify(v.error)}`);
  const lease = new FakeLease(opts.behave);
  const instance = opts.leaseInstance ?? lease;
  const runId = opts.runId ?? SYNTHETIC_RUN_ID;
  const ports: Any = {
    policy: { load: () => ({ ok: true, policy: { kind: "policy" }, table: { kind: "table" }, limits: { requests: 10, bodyBytes: 8192 }, policySha256: H64("a"), preparationTableSha256: H64("b") }) },
    auditConfig: { load: () => ({ ok: true, load: { kind: "audit", canary: AUDIT_CANARY }, sha256: H64("c") }) },
    env: { isSet: () => true, credentials: () => ({ ok: true, referenced: provider === "kiro-cli" ? [{ name: CREDENTIAL_NAME, set: true }] : [] }) },
    sandbox: { providerAvailable: () => true, destinations: () => ["relay.example.invalid"] },
    lease: {
      variables: () => ({ runId: true, nonce: true }),
      timing: () => ({ ok: true, heartbeatIntervalMs: 1000, staleAfterMs: 4000, propagationDelayMs: 123 }),
      port: () => instance,
      check: () => Promise.resolve({ valid: true, runId }),
    },
    io: { runVolume: () => ({ exists: true, writable: true, empty: true }), configFiles: () => ["run-config.json", "audit-config.json"] },
  };
  const r = await checkStartupRefusals(v.value, ports);
  if (!r.ok) throw new Error(`expected a ticket, got ${JSON.stringify(r.error)}`);
  return { approval: r.value as StartupApproval<Any, Any, Any, FakeLease>, lease, cfg: v.value };
}

/** Isolation ports whose verification is `verified` for `runId` (default: the synthetic run id of the tickets). */
export function passingIsolation(runId: string = SYNTHETIC_RUN_ID, over: Partial<Behavior> = {}): { deps: IsolationDeps; calls: Record<string, number> } {
  return makeDeps({ runId, attestation: () => ({ kind: "ok", json: goodAttestation(runId) }), ...over });
}
/** Isolation ports whose verification is `failed` (a root user). */
export function failingIsolation(over: Partial<Behavior> = {}): { deps: IsolationDeps; calls: Record<string, number> } {
  return passingIsolation(SYNTHETIC_RUN_ID, { ids: () => ({ uid: 0, euid: 0, gid: 0 }), ...over });
}

export const callsTotal = (calls: Record<string, number>): number => Object.values(calls).reduce((a, b) => a + b, 0);

/** A byte-level picture of an in-memory file system. */
export async function fsSnapshot(mem: MemoryFileSystem): Promise<string> {
  const files = mem.allFiles();
  return JSON.stringify({
    files: files.map((f) => [f, Buffer.from(mem.peek(f) ?? new Uint8Array(0)).toString("hex")]),
    root: await mem.listDir("/"),
    out: await mem.listDir("/run/out"),
  });
}

export interface StrictWorld {
  readonly deps: LoopDeps;
  /** Every top-level key of `loopDeps` that was read, other than `isolation`. It must stay empty at every refusal and at success. */
  readonly touched: string[];
  readonly mem: MemoryFileSystem;
}

/**
 * A `LoopDeps` whose only usable port is `isolation`. Any other key that the gate reads is recorded in `touched`, and every key except `fs`
 * answers `undefined` (a later call on it throws, which the gate would turn into a refusal and the test into a failure). The `fs` answer is an
 * in-memory file system that holds one file, so that a write or a rename shows in `fsSnapshot`.
 */
export function strictLoopDeps(isolation: IsolationDeps): StrictWorld {
  const touched: string[] = [];
  const mem = new MemoryFileSystem();
  mem.addDir("/run/out");
  mem.poke("/run/out/keep.bin", new Uint8Array([1, 2, 3]));
  const deps = new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      if (prop === "isolation") return isolation;
      touched.push(String(prop));
      return prop === "fs" ? mem : undefined;
    },
  });
  return { deps: deps as unknown as LoopDeps, touched, mem };
}

/** Things that are not the ticket although they may look like it. */
export function lookAlikes(real: object): Record<string, unknown> {
  return {
    undefined: undefined,
    null: null,
    number: 42,
    string: "ticket",
    plainObject: {},
    copy: { ...real },
    frozenClone: Object.freeze({ ...real }),
    prototypeChild: Object.create(real) as unknown,
    proxyOfReal: new Proxy(real, {}),
    jsonRoundTrip: JSON.parse(JSON.stringify(real)) as unknown,
  };
}
