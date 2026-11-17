// Ground_Truth access-denial verification (task 4.2). Not re-exported from the package entry: the orchestrator (task 4.4) imports this
// folder by path. `nodeDeps.ts` (the only module that imports `node:fs`) is deliberately not part of this barrel.
export * from "./types.js";
export { classifyCode, classifyOutcome } from "./classify.js";
export { PROBE_LOCATIONS, PROBE_OPS, PROBE_SET_SHA256, locationIdOf } from "./probeSet.js";
export { detectIsolationViolation } from "./violation.js";
export type { IsolationViolation } from "./violation.js";
export { composeAllowedEnvNames, isAccessDenialResult, verifyGroundTruthAccessDenial, MODULE_ENV_NAMES, PORT_TIMEOUT_MS, SETTLE_GRACE_MS } from "./verify.js";
