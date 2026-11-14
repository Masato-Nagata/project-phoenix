// Shared fixtures for the Experiment_Policy tests (tasks 2.8 to 2.11).
// The API is the neutral fictitious widget API of the design. No business value of the Legacy_App appears here.
import { loadPolicyConfig, type PolicyConfig } from "../../src/index.js";
import { loadedTable } from "./prepFixtures.js";

/** A fresh raw configuration each call, so a test may mutate it. Mirrors the design example. It has no list of preparation kinds: the preparation table is the single definition (task 2.26). */
export function rawPolicyConfig(): Record<string, any> {
  return {
    schemaVersion: 1,
    operations: [
      { method: "GET", path: "/products", readOnly: true },
      { method: "GET", path: "/products/{id}", readOnly: true },
      { method: "GET", path: "/orders", readOnly: true },
      { method: "GET", path: "/orders/{id}", readOnly: true },
      { method: "POST", path: "/orders", readOnly: false },
      { method: "POST", path: "/orders/{id}/cancel", readOnly: false },
    ],
    denyFolded: { equals: ["/reset"], prefixes: ["/test/"] },
    headers: [
      { name: "content-type", value: "application/json" },
      { name: "accept", value: "application/json" },
    ],
    limits: { requests: 10, stateChecks: 5, preparationSteps: 10, bodyBytes: 8192 },
    pathParam: { min: 1, max: 2147483647 },
  };
}

export function loadedPolicyConfig(): PolicyConfig {
  const loaded = loadPolicyConfig(rawPolicyConfig(), loadedTable());
  if (!loaded.ok) throw new Error(`fixture configuration does not load: ${loaded.error.join("; ")}`);
  return loaded.value;
}

/** The allowlist paths of the fixture configuration. */
export const ALLOWED_GET_PATHS = ["/products", "/products/{id}", "/orders", "/orders/{id}"] as const;
export const ALLOWED_POST_PATHS = ["/orders", "/orders/{id}/cancel"] as const;
