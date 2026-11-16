// Provider selection by a single configuration value (R3.1). The Mock_Provider is registered (task 3.2); the Replay_Provider and the
// Kiro_CLI_Provider arrive later. A name without a registered factory fails closed and never falls back to another provider.
import { DEFAULT_MOCK_FIXTURES, MOCK_FIXTURE_SETS } from "./mock/defaultFixtures.js";
import { MockProvider } from "./mock/mockProvider.js";
import { guardProvider } from "./providerGuard.js";
import type { AiProvider, Json } from "./types.js";

export type ProviderName = "mock" | "replay" | "kiro-cli";
export const PROVIDER_NAMES: readonly ProviderName[] = ["mock", "replay", "kiro-cli"];

/** `provider` is the single selecting value; the rest is provider-specific and opaque to callers. */
export type ProviderConfig = { provider: ProviderName } & { [k: string]: Json };

export type ProviderFactory = (cfg: ProviderConfig) => AiProvider;
export type ProviderFactories = Readonly<Partial<Record<ProviderName, ProviderFactory>>>;

export type ProviderSelectionErrorCode = "unknown_provider" | "provider_not_available" | "invalid_provider_config";

export class ProviderSelectionError extends Error {
  readonly code: ProviderSelectionErrorCode;
  constructor(code: ProviderSelectionErrorCode, message: string) {
    super(message);
    this.name = "ProviderSelectionError";
    this.code = code;
  }
}

/** `mock`: `mockFixtureSet` (optional string, the run configuration key) names a set of `MOCK_FIXTURE_SETS`; an unknown name fails. */
const mockFactory: ProviderFactory = (cfg) => {
  const setName = cfg["mockFixtureSet"];
  if (setName === undefined) return new MockProvider(DEFAULT_MOCK_FIXTURES);
  if (typeof setName !== "string" || !Object.hasOwn(MOCK_FIXTURE_SETS, setName)) {
    throw new ProviderSelectionError("invalid_provider_config", "unknown mockFixtureSet");
  }
  return new MockProvider(MOCK_FIXTURE_SETS[setName] ?? []);
};

/**
 * Factories shipped with the package: `mock` (task 3.2). `replay` and `kiro-cli` are added by later tasks. They build RAW providers and are
 * therefore not exported from the package entry; the only public way to get a provider is `createProvider`, which wraps the result.
 */
export const DEFAULT_PROVIDER_FACTORIES: ProviderFactories = Object.freeze({ mock: mockFactory });

/**
 * Returns the implementation named by `cfg.provider`, wrapped by the audit guard (`guardProvider`). Changing that value is the only change needed to swap implementations (R3.1).
 * Throws `ProviderSelectionError` for a name that is not one of `PROVIDER_NAMES` and for a name without a registered factory.
 * It never falls back to another provider.
 */
export function createProvider(cfg: ProviderConfig, factories: ProviderFactories = DEFAULT_PROVIDER_FACTORIES): AiProvider {
  const name: unknown = cfg.provider;
  if (typeof name !== "string" || !(PROVIDER_NAMES as readonly string[]).includes(name)) {
    throw new ProviderSelectionError("unknown_provider", "unknown provider name");
  }
  const factory = Object.hasOwn(factories, name) ? factories[name as ProviderName] : undefined;
  if (factory === undefined) {
    throw new ProviderSelectionError("provider_not_available", `provider "${name}" has no registered implementation`);
  }
  // Every provider that leaves this function is wrapped: no individual provider has to remember to verify the audit (task 3.4).
  return guardProvider(factory(cfg));
}
