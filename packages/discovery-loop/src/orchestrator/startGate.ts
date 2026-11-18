// Start gate of the Loop_Orchestrator (task 4.4, stage 2; R2.14, R2.15, R2.16, R15.14, R15.15, R15.16, R24.15).
//
// Fixed order, one call each:
//   1. consumeStartup (brand check and single use), synchronously, before the first `await`
//   2. buildAllowedEnvNames
//   3. verifyGroundTruthAccessDenial(loopDeps.isolation, { allowedEnvNames })   (always; there is no branch on the configuration)
//   4. isAccessDenialResult(result)
//   5. result.runId === startup.lease.runId
//   6. mayStartRun(startup.payloadAuditConfig, result.status)
//   7. startup.lease.port.check()   (the same instance that stage B proved)
// It never throws and never rejects. It reads `loopDeps.isolation` and nothing else, opens no store, writes no record, and uses no clock.
// A refusal is a code from a closed list (plus a lease reason name and a hint for later stages); it never carries a message, a value or a path.
import type { StartupApproval } from "../config/startup.js";
import { mayStartRun } from "../gate/mayStartRun.js";
import { isAccessDenialResult, verifyGroundTruthAccessDenial } from "../isolation/index.js";
import { consumeStartup } from "./consume.js";
import { buildAllowedEnvNames } from "./envAllowlist.js";
import { LEASE_REASONS, type LeaseReasonName, type LoopDeps, type StartGateRefusal, type StartGateResult } from "./types.js";

const fail = (r: StartGateRefusal): StartGateResult => ({ ok: false, error: Object.freeze({ ...r }) });
const refuse = (code: StartGateRefusal["code"]): StartGateResult => fail({ code });

type LeaseOutcome = { readonly kind: "valid" } | { readonly kind: "invalid"; readonly reason: LeaseReasonName | undefined } | { readonly kind: "failed" };
const FAILED: LeaseOutcome = Object.freeze({ kind: "failed" as const });

/** One `check()` call on the given instance. A wrong shape, an exception or a rejection (including `LeaseCheckInterrupted`) is `failed`; the error is dropped. */
async function checkLease(port: unknown): Promise<LeaseOutcome> {
  try {
    if (typeof port !== "object" || port === null) return FAILED;
    const check = (port as { check?: unknown }).check;
    if (typeof check !== "function") return FAILED;
    const state: unknown = await (check as () => unknown).call(port);
    if (typeof state !== "object" || state === null) return FAILED;
    const valid = (state as { valid?: unknown }).valid;
    if (valid === true) return { kind: "valid" };
    if (valid !== false) return FAILED;
    const reason = (state as { reason?: unknown }).reason;
    const known = typeof reason === "string" && (LEASE_REASONS as readonly string[]).includes(reason);
    return { kind: "invalid", reason: known ? (reason as LeaseReasonName) : undefined };
  } catch {
    return FAILED;
  }
}

export async function startGate<TLease, TAudit, TPolicy, TTable, TRequest>(
  loopDeps: LoopDeps<TLease, TAudit, TPolicy, TTable, TRequest>,
  startup: StartupApproval<TPolicy, TTable, TAudit, TLease>,
): Promise<StartGateResult> {
  try {
    // 1. Synchronous: no `await` comes before this call, so a second call in the same tick already sees the ticket as consumed.
    const consumed = consumeStartup(startup);
    if (consumed === "not_a_startup") return refuse("startup_invalid");
    if (consumed === "already_consumed") return refuse("startup_already_consumed");

    // 2.
    const allowedEnvNames = buildAllowedEnvNames(startup);

    // 3.
    let result: unknown;
    try {
      result = await verifyGroundTruthAccessDenial(loopDeps.isolation, { allowedEnvNames });
    } catch {
      return refuse("isolation_port_failed");
    }

    // 4.
    if (!isAccessDenialResult(result)) return refuse("access_denial_not_issued");

    // 5. Strict equality of two non-empty strings. Neither value is echoed.
    const runId = startup.lease.runId;
    if (typeof runId !== "string" || runId === "" || typeof result.runId !== "string" || result.runId === "" || result.runId !== runId) return refuse("run_id_mismatch");

    // 6.
    if (!mayStartRun(startup.payloadAuditConfig, result.status)) return refuse("start_gate_closed");

    // 7. No second proof and no new lease: the instance of the ticket is used as it is.
    const lease = await checkLease(startup.lease.port);
    if (lease.kind === "failed") return refuse("lease_check_failed");
    if (lease.kind === "invalid") {
      const hint = lease.reason === "heartbeat_stale" ? ("launcher_killed" as const) : ("lease_unavailable" as const);
      return lease.reason === undefined
        ? fail({ code: "lease_invalid", terminationReasonHint: hint })
        : fail({ code: "lease_invalid", leaseReason: lease.reason, terminationReasonHint: hint });
    }

    return { ok: true, value: Object.freeze({ runId, accessDenial: result, allowedEnvNames }) };
  } catch {
    return refuse("internal_error");
  }
}
