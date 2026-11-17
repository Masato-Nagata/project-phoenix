// Task 4.1, acceptance item G3: the SHA-256 values that the policy port reports equal the values that the existing code computes from the very
// objects of the approval. Definitions (read from `packages/verifier/src/identity/hash.ts`, not invented here):
//   policyConfigSha256(cfg)      = SHA-256 (UTF-8) of canonicalIdentityText(cfg without its `preparationTable`)
//   preparationTableSha256(table) = SHA-256 (UTF-8) of canonicalIdentityText(table)
// `canonicalIdentityText` is the existing canonical JSON of the policy module (keys sorted by UTF-16 code unit, no white space) with the refusals of
// the Evidence_Store's canonical JSON. The test uses that function and Node's `createHash` only; it adds no normalization of its own.
// Synthetic and baked data only (the baked policy files of packages/verifier/data are the runtime image's own data).
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalIdentityText, executionIdentity, policyConfigSha256, preparationTableSha256 } from "../../verifier/src/identity/hash.js";
import { DEFAULT_ADDRESS_POLICY } from "../../verifier/src/runner/address.js";
import { checkRunnerStart } from "../../verifier/src/runner/runner.js";
import { DEFAULT_RUNNER_LIMITS } from "../../verifier/src/runner/types.js";
import { checkStartupRefusals, validateRunConfig } from "../src/index.js";
import { bakedPolicyRaw, bakedPreparationTableRaw } from "./support/startupAdapters.js";
import { scene } from "./support/startupWorld.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");
const config = (over: Record<string, unknown> = {}) => {
  const r = validateRunConfig({ schemaVersion: 1, provider: "mock", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames: [], ...over });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const approvalOf = async (opts: Parameters<typeof scene>[0], cfg = config()): Promise<Any> => {
  const s = scene(opts);
  try {
    const r = await checkStartupRefusals(cfg, s.ports);
    if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
    return r.value;
  } finally {
    s.cleanup();
  }
};

/** The hashes of the objects that the approval carries, by the definition above. */
function recomputed(a: Any): { policy: string; table: string; tableOfPolicy: string } {
  const { preparationTable, ...rest } = a.policy.value as Record<string, unknown>;
  return { policy: sha(canonicalIdentityText(rest)), table: sha(canonicalIdentityText(a.policy.table)), tableOfPolicy: sha(canonicalIdentityText(preparationTable)) };
}
/** The check of the task: what the port reported is what the objects hash to, and the table of the policy is the table of the Runner. */
function consistent(a: Any): boolean {
  const h = recomputed(a);
  return a.policy.policySha256 === h.policy && a.policy.preparationTableSha256 === h.table && h.table === h.tableOfPolicy;
}
const narrowedRaw = (requests: number, bodyBytes: number) => (): unknown => {
  const raw = structuredClone(bakedPolicyRaw()) as Any;
  raw.limits.requests = requests;
  raw.limits.bodyBytes = bodyBytes;
  return raw;
};

describe("G3: the hashes of the approval are the hashes of its objects (real loaders, real hash functions)", () => {
  it("the reported values equal the definition recomputed from the approval's own objects", async () => {
    const a = await approvalOf({});
    const h = recomputed(a);
    expect(a.policy.policySha256).toBe(h.policy);
    expect(a.policy.preparationTableSha256).toBe(h.table);
    expect(h.tableOfPolicy).toBe(h.table); // the table inside the policy is the table of the approval, by hash
    expect(consistent(a)).toBe(true);
  });
  it("they also equal the functions that the Loop_Orchestrator and the acceptance check use (policyConfigSha256, preparationTableSha256, executionIdentity)", async () => {
    const a = await approvalOf({});
    expect(policyConfigSha256(a.policy.value)).toBe(a.policy.policySha256);
    expect(preparationTableSha256(a.policy.table)).toBe(a.policy.preparationTableSha256);
    expect(preparationTableSha256(a.policy.value.preparationTable)).toBe(a.policy.preparationTableSha256);
    const id = executionIdentity({}, a.policy.value, a.policy.table);
    expect(id.policyConfigSha256).toBe(a.policy.policySha256);
    expect(id.preparationTableSha256).toBe(a.policy.preparationTableSha256);
  });
  it("the Runner's own start check, given the approval's policy and table, accepts them and computes the same two hashes", async () => {
    const a = await approvalOf({});
    const start = checkRunnerStart({
      baseAddress: DEFAULT_ADDRESS_POLICY.internalOrigin,
      addressPolicy: DEFAULT_ADDRESS_POLICY,
      limits: DEFAULT_RUNNER_LIMITS,
      mask: { paths: [] },
      policy: a.policy.value,
      prepTable: a.policy.table,
    });
    expect(start.ok, JSON.stringify(start.ok ? "" : start.error)).toBe(true);
    if (start.ok) {
      expect(start.value.policySha256).toBe(a.policy.policySha256);
      expect(start.value.tableSha256).toBe(a.policy.preparationTableSha256);
    }
  });
  it("the values are stable: two runs over the same baked data report the same hashes, and they are lowercase hexadecimal of 64 characters", async () => {
    const a = await approvalOf({});
    const b = await approvalOf({});
    expect(b.policy.policySha256).toBe(a.policy.policySha256);
    expect(b.policy.preparationTableSha256).toBe(a.policy.preparationTableSha256);
    for (const v of [a.policy.policySha256, a.policy.preparationTableSha256]) expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(a.policy.policySha256).not.toBe(a.policy.preparationTableSha256);
  });
  it("a narrowed policy changes the policy hash and not the table hash, and stays consistent", async () => {
    const base = await approvalOf({});
    const narrow = await approvalOf({ policy: narrowedRaw(5, 4096) }, config({ limits: { requestsPerExperiment: 5, requestBodyBytes: 4096 } }));
    expect(narrow.policy.policySha256).not.toBe(base.policy.policySha256);
    expect(narrow.policy.preparationTableSha256).toBe(base.policy.preparationTableSha256);
    expect(consistent(narrow)).toBe(true);
  });
  it("a changed preparation table changes the table hash and not the policy hash, and stays consistent", async () => {
    const changedTable = (): unknown => {
      const t = structuredClone(bakedPreparationTableRaw()) as Any;
      t.steps[0].numbered.max = 4; // the change that the verifier's own identity test uses; 5 in the baked data
      return t;
    };
    const base = await approvalOf({});
    const changed = await approvalOf({ table: changedTable });
    expect(changed.policy.preparationTableSha256).not.toBe(base.policy.preparationTableSha256);
    expect(changed.policy.policySha256).toBe(base.policy.policySha256);
    expect(consistent(changed)).toBe(true);
  });

  describe("POSITIVE CONTROLS: the check can see a wrong report", () => {
    it("a port that reports the hash of another object is not consistent", async () => {
      const a = await approvalOf({});
      for (const wrong of [{ policySha256: a.policy.preparationTableSha256 }, { preparationTableSha256: a.policy.policySha256 }, { policySha256: "0".repeat(64) }, { preparationTableSha256: "f".repeat(64) }]) {
        const forged = { policy: { ...a.policy, ...wrong } };
        expect(consistent(forged), JSON.stringify(Object.keys(wrong))).toBe(false);
      }
    });
    it("an approval whose table object differs from the table inside its policy is not consistent", async () => {
      const a = await approvalOf({});
      const other = await approvalOf({ table: () => { const t = structuredClone(bakedPreparationTableRaw()) as Any; t.steps[0].numbered.max = 4; return t; } });
      const mixed = { policy: { ...a.policy, table: other.policy.value.preparationTable, preparationTableSha256: other.policy.preparationTableSha256 } };
      expect(consistent(mixed)).toBe(false);
    });
    it("a port that reports hashes that do not match its objects is passed by stage B (it cannot know) and caught by this check", async () => {
      const s = scene();
      try {
        const real = s.ports.policy.load.bind(s.ports.policy);
        const lying = { ...s.ports, policy: { load: async () => { const r = (await real()) as Any; return { ...r, policySha256: "a".repeat(64) }; } } };
        const r = await checkStartupRefusals(config(), lying as Any);
        expect(r.ok).toBe(true); // stage B has no hash function (no dependency on the verifier); the adapter is responsible
        expect(r.ok && consistent(r.value)).toBe(false);
      } finally {
        s.cleanup();
      }
    });
  });
});