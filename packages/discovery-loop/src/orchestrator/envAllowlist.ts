// Allowed environment names of the isolation check (task 4.4, stage 2; R15.16, human decision 2 of 2026-11-17).
// Input: the names of `config.envNames` minus the names of `credentials`. A credential must not be brought into the runtime. The list of names
// that stage B read (the `envVarsRead` field) is NOT used, and no environment value is read here: the ticket holds names and flags only.
import type { StartupApproval } from "../config/startup.js";
import { composeAllowedEnvNames } from "../isolation/index.js";

export function buildAllowedEnvNames(startup: Pick<StartupApproval, "config" | "credentials">): readonly string[] {
  const credentialNames = new Set<string>(startup.credentials.map((c) => c.name));
  return composeAllowedEnvNames(startup.config.envNames.filter((n) => !credentialNames.has(n)));
}
