// Run configuration validation, stage A (task 4.1).
export { isValidatedRunConfig, validateRunConfig } from "./runConfig.js";
export type { ConfigIssue, ConfigIssueCode, RunConfig, RunLimits } from "./runConfig.js";
export {
  DEFAULT_MOCK_FIXTURE_SET_NAME,
  ENV_NAME_PATTERN,
  MASK_PATH_PATTERN,
  MAX_MASK_PATHS,
  MAX_MASK_PATH_LENGTH,
  MOCK_FIXTURE_SET_NAMES,
  RUN_CONFIG_KNOWN_NAMES,
  RUN_CONFIG_PROVIDERS,
  RUN_LIMITS,
  RUN_LIMIT_KEYS,
  TEST_API_BASE_ADDRESSES,
  UNKNOWN_KEY_PLACEHOLDER,
} from "./limits.js";
export type { LimitBound, LimitSpec, RunConfigProvider, RunLimitKey, TestApiBaseAddress } from "./limits.js";
// Run configuration validation, stage B (task 4.1): the start-up refusals over injected, read-only ports.
export {
  EXPECTED_CONFIG_FILES,
  STARTUP_CHECK_ORDER,
  STARTUP_NAME_VOCABULARY,
  STARTUP_REFUSAL_CODES,
  checkStartupRefusals,
} from "./startup.js";
// `isStartupApproval` is NOT re-exported here. The existing isolation guards (R6.11) allow no runtime export whose name contains "approv" except
// `deriveApprovalStatus`; this guard has nothing to do with the Approval_Store. The orchestrator of this package imports it from "./config/startup.js".
export type {
  AuditLoad,
  CredentialView,
  LeaseCheckView,
  LeaseTimingView,
  PolicyLoad,
  StartupApproval,
  StartupCheckId,
  StartupPorts,
  StartupRefusal,
  StartupRefusalCode,
} from "./startup.js";