// Lease check at a phase boundary (task 4.4, unit U6a; R11.16, R24.12, R24.15).
//
// `checkLeaseBoundary(port, session)` is the running rule between phases: the lease is checked on the SAME instance that stage B proved, with the
// deadline and the signal of the session. It never writes a record, never calls the terminator and never throws.
//
// Order: (1) a latched cause stops, without a raise; (2) an aborted signal is attributed (`interrupted`) and stops; (3) the one deadline test
// (`deadlineCheckpoint`) must say `continue`; (4) ONE `check` on the same instance (`.call(port, ...)`), then (5) the latch is read again, because a
// cause may have been latched while the check was awaited.
// Answers: valid -> continue; invalid with the reason `heartbeat_stale` -> `launcher_killed`; any other invalid reason -> `lease_unavailable`;
// a throw, a rejection (a `LeaseCheckInterrupted` too) or an odd shape -> the symptom `lease_check_interrupted` (an unexplained one falls back to
// `error`, a latched cause is kept). No message or value of the port is copied anywhere.
//
// NOTE: the reading of the lease answer duplicates `recheckLease` of `startRun.ts` (which is not exported and is not changed in this unit); it also
// needs the reason, which `recheckLease` does not return.
import { deadlineCheckpoint } from "./deadline.js";
import type { RunSession } from "./session.js";

const latchNone = (session: RunSession): boolean => session.terminationStatus().state === "none";

function failClosed(session: RunSession): "stop" {
  try {
    session.raise("error");
  } catch {
    // the session never throws; nothing more can be done
  }
  return "stop";
}

export async function checkLeaseBoundary(port: unknown, session: RunSession): Promise<"continue" | "stop"> {
  try {
    if (!latchNone(session)) return "stop";
    if (session.signal.aborted) {
      session.attributeSymptom("interrupted");
      return "stop";
    }
    if (deadlineCheckpoint(session) !== "continue") return "stop";

    let state: unknown;
    try {
      if (typeof port !== "object" || port === null) {
        session.attributeSymptom("lease_check_interrupted");
        return "stop";
      }
      const check = (port as { check?: unknown }).check;
      if (typeof check !== "function") {
        session.attributeSymptom("lease_check_interrupted");
        return "stop";
      }
      state = await (check as (o: unknown) => unknown).call(port, { deadlineAtMs: session.deadlineAtMs, signal: session.signal });
    } catch {
      session.attributeSymptom("lease_check_interrupted");
      return "stop";
    }

    if (typeof state !== "object" || state === null) {
      session.attributeSymptom("lease_check_interrupted");
      return "stop";
    }
    const valid = (state as { valid?: unknown }).valid;
    if (valid === true) return latchNone(session) ? "continue" : "stop";
    if (valid === false) {
      const reason = (state as { reason?: unknown }).reason;
      session.raise(reason === "heartbeat_stale" ? "launcher_killed" : "lease_unavailable");
      return "stop";
    }
    session.attributeSymptom("lease_check_interrupted");
    return "stop";
  } catch {
    return failClosed(session);
  }
}
