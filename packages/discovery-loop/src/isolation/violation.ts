// Run-time isolation violation (R15.6; design item 2). Implemented here, wired by the orchestrator in task 4.4.
// A denied attempt (EACCES, EPERM) during the Run stops the Run with `isolation_violation`. An absent path is not a violation.
// The report never carries a free path: `locationId` is a fixed probe-location id or `unlisted`.
import { classifyCode } from "./classify.js";
import { locationIdOf } from "./probeSet.js";

export interface IsolationViolation {
  readonly code: "isolation_violation";
  readonly op: string;
  readonly errorCode: string;
  readonly locationId: string;
}

export function detectIsolationViolation(a: { op: "stat" | "list" | "read"; path: string; errorCode: string }): IsolationViolation | undefined {
  try {
    if (typeof a !== "object" || a === null) return undefined;
    if (typeof a.errorCode !== "string" || classifyCode(a.errorCode) !== "denied") return undefined;
    const op = a.op === "stat" || a.op === "list" || a.op === "read" ? a.op : "unknown";
    return { code: "isolation_violation", op, errorCode: a.errorCode, locationId: typeof a.path === "string" ? locationIdOf(a.path) : "unlisted" };
  } catch {
    return undefined;
  }
}
