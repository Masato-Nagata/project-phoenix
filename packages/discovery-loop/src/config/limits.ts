// Constants of the run configuration (task 4.1, stage A; design: "Run configuration (summary)", table "Limits of the run configuration").
// This file has no imports on purpose: the schema (`schema/schemas.ts`) and the validator (`config/runConfig.ts`) both read it, and
// discovery-loop has no runtime dependency on the other packages. Local copies of values that other packages define are kept equal by
// `test/runConfigParity.test.ts`.

/** How a value above `max` is reported: `range` is an ordinary range, `fixed` is a fixed bound of a schema or of the policy loader (R17.2). */
export type LimitBound = "range" | "fixed";

export interface LimitSpec {
  readonly min: number;
  readonly max: number;
  /** Applied by the validator only when the key is absent. `null` is never read as absent (R11.8 (a), (b)). */
  readonly default: number;
  readonly bound: LimitBound;
}

/**
 * The 14 keys of `limits`. Existing ranges: iterations, experiments (R11.7); perRequestSeconds, perExperimentSeconds (R9.14); claims 50,
 * citations 5, requests 10 (fixed schema bounds); requestBodyBytes 8192 (maximum of the policy loader). New decisions of 2026-11-16:
 * rejectedExperiments, runSeconds, providerCallSeconds, providerRetries, responseBytes, experimentsPerResponse (R8.11, R11.10, R17.2).
 */
export const RUN_LIMITS = Object.freeze({
  iterations: Object.freeze({ min: 1, max: 10, default: 3, bound: "range" }),
  experiments: Object.freeze({ min: 1, max: 100, default: 20, bound: "range" }),
  rejectedExperiments: Object.freeze({ min: 1, max: 100, default: 20, bound: "range" }),
  runSeconds: Object.freeze({ min: 1, max: 3600, default: 1800, bound: "range" }),
  providerCallSeconds: Object.freeze({ min: 1, max: 600, default: 120, bound: "range" }),
  providerRetries: Object.freeze({ min: 0, max: 10, default: 2, bound: "range" }),
  responseBytes: Object.freeze({ min: 1, max: 1_048_576, default: 262_144, bound: "range" }),
  claimsPerHypothesis: Object.freeze({ min: 1, max: 50, default: 50, bound: "fixed" }),
  citationsPerClaim: Object.freeze({ min: 1, max: 5, default: 5, bound: "fixed" }),
  experimentsPerResponse: Object.freeze({ min: 1, max: 100, default: 10, bound: "range" }),
  requestsPerExperiment: Object.freeze({ min: 1, max: 10, default: 10, bound: "fixed" }),
  requestBodyBytes: Object.freeze({ min: 1, max: 8192, default: 8192, bound: "fixed" }),
  perRequestSeconds: Object.freeze({ min: 1, max: 60, default: 10, bound: "range" }),
  perExperimentSeconds: Object.freeze({ min: 1, max: 600, default: 60, bound: "range" }),
} as const satisfies Record<string, LimitSpec>);

export type RunLimitKey = keyof typeof RUN_LIMITS;
export const RUN_LIMIT_KEYS = Object.freeze(Object.keys(RUN_LIMITS) as RunLimitKey[]);

/** The providers a run configuration may name (design schema). `replay` is not a run configuration value. */
export const RUN_CONFIG_PROVIDERS = Object.freeze(["mock", "kiro-cli"] as const);
export type RunConfigProvider = (typeof RUN_CONFIG_PROVIDERS)[number];

/** The closed set of Test API addresses (R18.2, R18.3). */
export const TEST_API_BASE_ADDRESSES = Object.freeze(["http://127.0.0.1:8056", "http://reverse-proxy:8080"] as const);
export type TestApiBaseAddress = (typeof TEST_API_BASE_ADDRESSES)[number];

/** Names of the Mock_Provider fixture sets (a local copy of `MOCK_FIXTURE_SETS` of packages/ai-client; no fallback for another name). */
export const MOCK_FIXTURE_SET_NAMES = Object.freeze(["default-widget-v1"] as const);
export const DEFAULT_MOCK_FIXTURE_SET_NAME = "default-widget-v1" as const;

/** `mask.paths`: at most 64 entries (validateMaskConfig), each of 1 to 128 characters (parseMaskPattern). Duplicates stay allowed. */
export const MAX_MASK_PATHS = 64;
export const MAX_MASK_PATH_LENGTH = 128;
const SEG_INDEX = "\\[(?:0|[1-9][0-9]{0,3}|\\*)\\]";
const SEG_KEY = "[A-Za-z_][A-Za-z0-9_]*";
/**
 * The grammar of `parseMaskPattern` (packages/verifier/src/compare/path.ts) as one regular expression: the first segment is a name or an
 * index (`[n]`, `[*]`); each later segment is `.name` or an index. A parity test compares it with `parseMaskPattern` on generated strings.
 */
export const MASK_PATH_PATTERN = `^(?:${SEG_KEY}|${SEG_INDEX})(?:\\.${SEG_KEY}|${SEG_INDEX})*$`;

/** `envNames`: names of environment variables the runtime may read; only the character class and the length are limited. */
export const ENV_NAME_PATTERN = "^[A-Za-z_][A-Za-z0-9_]{0,127}$";

/**
 * The names that a pointer of an issue may contain when they come from the INPUT: the keys the schema defines and `token` (the removed
 * `mask.token`, C2-1). They are constants of this package, so an echoed name is never user text. Any other key name of the input is
 * written as `<unknown>`: a key name is free text and can be a secret.
 */
export const RUN_CONFIG_KNOWN_NAMES: readonly string[] = Object.freeze([
  "schemaVersion", "provider", "mockFixtureSet", "limits", "testApi", "mask", "envNames", "baseAddress", "paths", "token",
  ...(Object.keys(RUN_LIMITS) as RunLimitKey[]),
]);
/** The fixed stand-in for any key name that is not in `RUN_CONFIG_KNOWN_NAMES`. It is a valid JSON Pointer token. */
export const UNKNOWN_KEY_PLACEHOLDER = "<unknown>";