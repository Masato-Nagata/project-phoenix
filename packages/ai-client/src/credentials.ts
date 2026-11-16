// Credential check at the start of a Run (task 3.11; R19.1, R19.3, R19.6, R19.10; design C7).
//
// A provider that needs a credential reads it only from an environment variable. This package never reads the process environment itself: the
// caller (the Launcher or the Loop_Orchestrator) passes the environment as a plain mapping. The runtime side of the Kiro_CLI_Provider holds no credential
// (C7): the host-side sandbox controller reads `KIRO_API_KEY` and passes it only into the AI_Sandbox, and reports only set or unset. This function is the
// refusal rule of R19.6 and the set/unset report of R19.3. It never returns, throws or logs a value.
import type { ProviderName } from "./provider.js";

/** The environment variables each provider needs. The Mock_Provider and the replay provider need none (R19.10). */
export const PROVIDER_CREDENTIALS: Readonly<Record<ProviderName, readonly string[]>> = Object.freeze({
  mock: Object.freeze([] as string[]),
  replay: Object.freeze([] as string[]),
  "kiro-cli": Object.freeze(["KIRO_API_KEY"]),
});

export type EnvironmentLike = Readonly<Record<string, string | undefined>>;
/** What the Run_Manifest records for a credential: its name and whether it was set, never its value (R19.3). */
export interface CredentialReference {
  readonly name: string;
  readonly set: boolean;
}
export type CredentialCheck =
  | { readonly ok: true; readonly referenced: readonly CredentialReference[] }
  /** Refuse to start the Run, record an error naming `variable` and not its value, and make no provider call (R19.6). */
  | {
      readonly ok: false;
      readonly error: { readonly code: "credential_unset" | "unknown_provider"; readonly variable?: string };
      readonly referenced: readonly CredentialReference[];
    };

/** A value counts as set when it is a string with a visible character; an unset, empty or blank variable is unset. */
const isSet = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";

/**
 * Checks the credentials that the selected provider needs. A name that is not one of the providers fails closed. Every needed variable is listed in
 * `referenced` with its set flag; the first unset one is named in the error. The values are never copied.
 */
export function checkProviderCredentials(provider: string, env: EnvironmentLike): CredentialCheck {
  if (!Object.hasOwn(PROVIDER_CREDENTIALS, provider)) return { ok: false, error: { code: "unknown_provider" }, referenced: [] };
  const names = PROVIDER_CREDENTIALS[provider as ProviderName];
  const referenced = names.map((name) => ({ name, set: Object.hasOwn(env, name) && isSet(env[name]) }));
  const missing = referenced.find((r) => !r.set);
  if (missing !== undefined) return { ok: false, error: { code: "credential_unset", variable: missing.name }, referenced };
  return { ok: true, referenced };
}