// Task 4.4, stage 2: single use of a startup ticket (`consumeStartup`) and the allowed environment names (`buildAllowedEnvNames`).
// Real tickets issued by `checkStartupRefusals` with fake in-memory ports. Synthetic data only.
// **Validates: Requirements 2.16, 15.16**
import { describe, expect, it } from "vitest";
import { composeAllowedEnvNames } from "../src/isolation/index.js";
import * as consumeModule from "../src/orchestrator/consume.js";
import { consumeStartup } from "../src/orchestrator/consume.js";
import { buildAllowedEnvNames } from "../src/orchestrator/envAllowlist.js";
import { CREDENTIAL_NAME, issueStartup, lookAlikes, type Any } from "./support/orchestratorFakes.js";

describe("consumeStartup", () => {
  it("accepts a real ticket once and refuses it afterwards (control for every refusal below)", async () => {
    const { approval } = await issueStartup();
    expect(consumeStartup(approval)).toBe("ok");
    expect(consumeStartup(approval)).toBe("already_consumed");
    expect(consumeStartup(approval)).toBe("already_consumed");
  });

  it("two calls in the same tick: the first is ok, the second already consumed (no await between them)", async () => {
    const { approval } = await issueStartup();
    const results = [consumeStartup(approval), consumeStartup(approval)];
    expect(results).toEqual(["ok", "already_consumed"]);
  });

  it("refuses every non-ticket without throwing, and a refused look-alike does not consume the real ticket", async () => {
    const { approval } = await issueStartup();
    for (const [name, value] of Object.entries(lookAlikes(approval))) {
      expect(consumeStartup(value), name).toBe("not_a_startup");
      expect(consumeStartup(value), `${name} (again)`).toBe("not_a_startup");
    }
    expect(consumeStartup(approval)).toBe("ok");
  });

  it("consuming one ticket does not consume another", async () => {
    const a = await issueStartup();
    const b = await issueStartup();
    expect(consumeStartup(a.approval)).toBe("ok");
    expect(consumeStartup(b.approval)).toBe("ok");
    expect(consumeStartup(a.approval)).toBe("already_consumed");
  });

  it("exports exactly consumeStartup (no set, no reset)", () => {
    expect(Object.keys(consumeModule).sort()).toEqual(["consumeStartup"]);
  });
});

describe("buildAllowedEnvNames", () => {
  it("mock (no credentials): the config names only, composed with the four module constants", async () => {
    const { approval } = await issueStartup({ envNames: ["EXAMPLE_ONE", "EXAMPLE_TWO"] });
    const names = buildAllowedEnvNames(approval);
    expect(names).toEqual(composeAllowedEnvNames(["EXAMPLE_ONE", "EXAMPLE_TWO"]));
    for (const c of ["HOME", "PHOENIX_LEASE_D_MS", "PHOENIX_LEASE_NONCE", "PHOENIX_RUN_ID"]) expect(names).toContain(c);
    expect([...names]).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });

  it("a kiro-cli-like ticket: the credential name is removed even when it is also listed in envNames", async () => {
    const { approval } = await issueStartup({ provider: "kiro-cli", envNames: ["EXAMPLE_ONE", CREDENTIAL_NAME] });
    expect(approval.credentials).toEqual([{ name: CREDENTIAL_NAME, set: true }]);
    expect(approval.config.envNames).toContain(CREDENTIAL_NAME);
    const names = buildAllowedEnvNames(approval);
    expect(names).not.toContain(CREDENTIAL_NAME);
    expect(names).toEqual(composeAllowedEnvNames(["EXAMPLE_ONE"]));
  });

  it("does not read envVarsRead: a throwing getter is never run, and a credential name in envVarsRead has no effect", () => {
    const throwing = {
      config: { envNames: ["EXAMPLE_ONE"] },
      credentials: [] as { name: string; set: boolean }[],
      get envVarsRead(): never {
        throw new Error("envVarsRead must not be read");
      },
    };
    expect(buildAllowedEnvNames(throwing as Any)).toEqual(composeAllowedEnvNames(["EXAMPLE_ONE"]));
    const listed = { config: { envNames: ["EXAMPLE_ONE"] }, credentials: [], envVarsRead: [{ name: CREDENTIAL_NAME, set: true }] };
    expect(buildAllowedEnvNames(listed as Any)).toEqual(composeAllowedEnvNames(["EXAMPLE_ONE"]));
  });

  it("the composition contract is unchanged: module constants plus the given names, sorted and deduplicated", () => {
    expect(composeAllowedEnvNames(["B_ONE", "A_ONE", "B_ONE", "HOME"])).toEqual(["A_ONE", "B_ONE", "HOME", "PHOENIX_LEASE_D_MS", "PHOENIX_LEASE_NONCE", "PHOENIX_RUN_ID"]);
    expect(buildAllowedEnvNames({ config: { envNames: ["B_ONE", "A_ONE", "B_ONE"] }, credentials: [] } as Any)).toEqual(
      composeAllowedEnvNames(["B_ONE", "A_ONE", "B_ONE"]),
    );
  });
});
