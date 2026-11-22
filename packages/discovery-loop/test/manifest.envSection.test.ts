// Task 4.6 W2: the Run_Manifest `envVarsRead` section (`src/manifest/envSection.ts`). Deterministic and offline; synthetic names only.
// Rules under test: same name and same state is one entry; same name in a different state is refused; a credential is `set: true` only;
// an error never carries a name or a value; the input is never changed or aliased.
// **Validates: Requirements 19.2, 19.3, 12.13**
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ENV_NAME_PATTERN } from "../src/config/limits.js";
import { MANIFEST_FILE } from "../src/index.js";
import { buildEnvSection } from "../src/manifest/envSection.js";
import { RUN_DIR, buildWorld, type Any } from "./support/mockRunWorld.js";
import { CREDENTIAL_NAME, issueStartup } from "./support/orchestratorFakes.js";

const CANARY_NAME = "CANARY_ENV_NAME_7Q";
const CANARY_VALUE = "canary-secret-value-91x";
const e = (name: string, set: boolean): { name: string; set: boolean } => ({ name, set });
const deepFreeze = <T>(v: T): T => {
  if (typeof v === "object" && v !== null) {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
};
const codeOf = (r: ReturnType<typeof buildEnvSection>): string | undefined => (r.ok ? undefined : r.error.code);

describe("merging", () => {
  it("no duplicate: the flags first, then the credentials, each once, in input order", () => {
    const r = buildEnvSection([e("A_ONE", true), e("B_TWO", false)], [e("C_KEY", true)]);
    expect(r).toEqual({ ok: true, value: [e("A_ONE", true), e("B_TWO", false), e("C_KEY", true)] });
  });

  it("the same name with the same state, in both lists, is one entry at the position of its first occurrence", () => {
    const r = buildEnvSection([e("A_ONE", true), e("C_KEY", true), e("B_TWO", false)], [e("C_KEY", true)]);
    expect(r).toEqual({ ok: true, value: [e("A_ONE", true), e("C_KEY", true), e("B_TWO", false)] });
  });

  it("the same name with the same state inside one list is one entry (flags and credentials)", () => {
    expect(buildEnvSection([e("A_ONE", false), e("A_ONE", false)], [])).toEqual({ ok: true, value: [e("A_ONE", false)] });
    expect(buildEnvSection([], [e("C_KEY", true), e("C_KEY", true)])).toEqual({ ok: true, value: [e("C_KEY", true)] });
  });

  it("empty lists give an empty section (a Mock Run has no credential)", () => {
    expect(buildEnvSection([], [])).toEqual({ ok: true, value: [] });
  });
});

describe("refusals", () => {
  it("the same name in a different state is refused, in either order and in either list", () => {
    const a = buildEnvSection([e("C_KEY", false)], [e("C_KEY", true)]);
    expect(a).toEqual({ ok: false, error: { code: "state_conflict", list: "credentials", index: 0 } });
    const b = buildEnvSection([e("A_ONE", true), e("A_ONE", false)], []);
    expect(b).toEqual({ ok: false, error: { code: "state_conflict", list: "flags", index: 1 } });
    // passing control: the same names with equal states are accepted
    expect(buildEnvSection([e("C_KEY", true)], [e("C_KEY", true)]).ok).toBe(true);
    expect(buildEnvSection([e("A_ONE", true), e("A_ONE", true)], []).ok).toBe(true);
  });

  it("an unset credential is refused (a Run with an unset credential cannot have been approved); the flag list may hold unset names", () => {
    expect(buildEnvSection([], [e("C_KEY", false)])).toEqual({ ok: false, error: { code: "credential_unset", list: "credentials", index: 0 } });
    expect(buildEnvSection([e("A_ONE", false)], []).ok).toBe(true); // passing control
    expect(buildEnvSection([], [e("C_KEY", true)]).ok).toBe(true); // passing control
  });

  it("malformed input is refused with a closed code (each with a passing control above)", () => {
    const cases: [unknown, unknown, string][] = [
      [undefined, [], "list_not_array"],
      [[], null, "list_not_array"],
      [{ length: 0 }, [], "list_not_array"],
      [["A_ONE"], [], "entry_not_plain_object"],
      [[null], [], "entry_not_plain_object"],
      [[[]], [], "entry_not_plain_object"],
      [[{ name: "A_ONE" }], [], "entry_keys"],
      [[{ name: "A_ONE", set: true, value: "x" }], [], "entry_keys"],
      [[{ name: "A_ONE", flag: true }], [], "entry_keys"],
      [[{ name: 1, set: true }], [], "name_invalid"],
      [[{ name: "", set: true }], [], "name_invalid"],
      [[{ name: "1ABC", set: true }], [], "name_invalid"],
      [[{ name: "A-B", set: true }], [], "name_invalid"],
      [[{ name: "A".repeat(129), set: true }], [], "name_invalid"],
      [[{ name: "A_ONE", set: "true" }], [], "set_not_boolean"],
      [[{ name: "A_ONE", set: 1 }], [], "set_not_boolean"],
    ];
    for (const [flags, credentials, code] of cases) expect(codeOf(buildEnvSection(flags, credentials)), JSON.stringify([flags, credentials])).toBe(code);
  });

  it("accessors, symbol keys, a foreign prototype and array holes are refused, and a getter is never run", () => {
    let ran = false;
    const withGetter = {};
    Object.defineProperty(withGetter, "name", { enumerable: true, get: () => ((ran = true), "A_ONE") });
    Object.defineProperty(withGetter, "set", { enumerable: true, value: true });
    expect(codeOf(buildEnvSection([withGetter], []))).toBe("entry_not_plain_object");
    expect(ran).toBe(false);

    const withSymbol: Record<string | symbol, unknown> = { name: "A_ONE", set: true };
    withSymbol[Symbol("x")] = 1;
    expect(codeOf(buildEnvSection([withSymbol], []))).toBe("entry_not_plain_object");

    class Entry {
      name = "A_ONE";
      set = true;
    }
    expect(codeOf(buildEnvSection([new Entry()], []))).toBe("entry_not_plain_object");
    expect(codeOf(buildEnvSection([Object.assign(Object.create(null), { name: "A_ONE", set: true })], []))).toBeUndefined(); // passing control: a null prototype is plain

    // eslint-disable-next-line no-sparse-arrays
    expect(codeOf(buildEnvSection([e("A_ONE", true), , e("B_TWO", true)] as unknown[], []))).toBe("entry_not_plain_object");
  });

  it("the name grammar equals ENV_NAME_PATTERN of the run configuration", () => {
    const re = new RegExp(ENV_NAME_PATTERN);
    for (const name of ["A", "_", "a1", "A_ONE", "Z".repeat(128), "Z".repeat(129), "", "1A", "A B", "A-B", "A.B", "É", "A\n"]) {
      expect(buildEnvSection([e(name, true)], []).ok, JSON.stringify(name)).toBe(re.test(name));
    }
  });
});

describe("immutability", () => {
  it("deep-frozen input is accepted and unchanged; the output holds fresh objects and a later change of it does not reach the input", () => {
    const flags = deepFreeze([e("A_ONE", true), e("B_TWO", false)]);
    const credentials = deepFreeze([e("C_KEY", true)]);
    const before = JSON.stringify([flags, credentials]);
    const r = buildEnvSection(flags, credentials);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.stringify([flags, credentials])).toBe(before);
    for (const out of r.value) for (const inp of [...flags, ...credentials]) expect(out).not.toBe(inp);
    r.value[0] = e("X_CHANGED", false);
    r.value.push(e("Y_ADDED", true));
    expect(JSON.stringify([flags, credentials])).toBe(before);
  });
});

describe("names and flags only: no value in any result", () => {
  it("an extra key (where a value could ride) is refused, and the error carries neither the name nor the value", () => {
    const r = buildEnvSection([{ name: CANARY_NAME, set: true, value: CANARY_VALUE }], []);
    expect(r.ok).toBe(false);
    const text = JSON.stringify(r);
    expect(text).not.toContain(CANARY_VALUE);
    expect(text).not.toContain(CANARY_NAME);
  });

  it("a value in a field of the grammar (a name that is not a name) is refused without being echoed", () => {
    const r = buildEnvSection([{ name: `${CANARY_NAME}=${CANARY_VALUE}`, set: true }], []);
    expect(r).toEqual({ ok: false, error: { code: "name_invalid", list: "flags", index: 0 } });
    expect(JSON.stringify(r)).not.toContain(CANARY_VALUE);
  });

  it("every error for a named entry carries only code, list and index", () => {
    for (const r of [
      buildEnvSection([e(CANARY_NAME, false)], [e(CANARY_NAME, true)]),
      buildEnvSection([], [e(CANARY_NAME, false)]),
      buildEnvSection([{ name: CANARY_NAME, set: "x" }], []),
    ]) {
      expect(r.ok).toBe(false);
      if (r.ok) continue;
      expect(Object.keys(r.error).sort().filter((k) => k !== "index")).toEqual(["code", "list"]);
      expect(JSON.stringify(r)).not.toContain(CANARY_NAME);
    }
  });

  it("positive control: a name that is accepted does appear in the success result, so the scans above can see a leak", () => {
    const ok = buildEnvSection([e(CANARY_NAME, true)], []);
    expect(JSON.stringify(ok)).toContain(CANARY_NAME);
    expect(JSON.stringify(ok)).not.toContain(CANARY_VALUE);
    expect(Object.keys((ok as { value: object[] }).value[0] as object).sort()).toEqual(["name", "set"]);
  });

  it("the module is pure and reads no environment: its source has no process, env, clock, random, node: or dynamic code", () => {
    const text = readFileSync(new URL("../src/manifest/envSection.ts", import.meta.url), "utf8");
    const code = text.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
    expect(code).not.toMatch(/\bprocess\b|\bDate\b|\bperformance\b|Math\.random|\brequire\s*\(|\beval\b|\bFunction\b|\bimport\s*\(|node:|\bJSON\b|console/);
    const specifiers = [...code.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specifiers).toEqual(["../schema/types.js", "./plainData.js"]); // the shared helper module of W3-A
  });
});

describe("who imports it", () => {
  const SRC = fileURLToPath(new URL("../src/", import.meta.url));
  const importers = (needle: RegExp): string[] =>
    (readdirSync(SRC, { recursive: true, encoding: "utf8" }) as string[])
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => needle.test(readFileSync(`${SRC}${f}`, "utf8")))
      .map((f) => f.split("\\").join("/"))
      .sort();
  it("in src, only loopOrchestrator.ts imports envSection (positive control: the detector finds the known importer of the Source_Bundle section's type file)", () => {
    expect(importers(/from\s*["'][^"']*manifest\/envSection\.js["']/)).toEqual(["orchestrator/loopOrchestrator.ts"]);
    expect(importers(/from\s*["']\.\.\/schema\/types\.js["']/)).toContain("manifest/envSection.ts");
  });
});
describe("properties", () => {
  const nameArb = fc.constantFrom("A_ONE", "B_TWO", "C_KEY", "D_FOUR", "E_FIVE");
  const entryArb = fc.record({ name: nameArb, set: fc.boolean() });
  it("on success each name appears once, with the state of every input entry of that name; on refusal some name has two states", () => {
    fc.assert(
      fc.property(fc.array(entryArb, { maxLength: 8 }), fc.array(fc.record({ name: nameArb, set: fc.constant(true) }), { maxLength: 4 }), (flags, credentials) => {
        const r = buildEnvSection(flags, credentials);
        const all = [...flags, ...credentials];
        const statesOf = (n: string): Set<boolean> => new Set(all.filter((x) => x.name === n).map((x) => x.set));
        if (r.ok) {
          const names = r.value.map((x) => x.name);
          expect(new Set(names).size).toBe(names.length);
          expect([...names].sort()).toEqual([...new Set(all.map((x) => x.name))].sort());
          for (const x of r.value) expect([...statesOf(x.name)]).toEqual([x.set]);
        } else {
          expect(r.error.code).toBe("state_conflict");
          expect([...new Set(all.map((x) => x.name))].some((n) => statesOf(n).size > 1)).toBe(true);
        }
      }),
      { seed: 20260622, numRuns: 300 },
    );
  });
});

describe("agreement with the startup ticket and the Mock Run", () => {
  it("a real kiro-cli-like ticket (the credential name is also in envNames, same state): the section equals approval.envVarsRead, and every credential is set", async () => {
    const { approval } = await issueStartup({ provider: "kiro-cli", envNames: ["EXAMPLE_ONE", CREDENTIAL_NAME] });
    expect(approval.credentials).toEqual([{ name: CREDENTIAL_NAME, set: true }]);
    const r = buildEnvSection(approval.envVarsRead, approval.credentials);
    expect(r).toEqual({ ok: true, value: approval.envVarsRead.map((x) => ({ name: x.name, set: x.set })) });
    expect(approval.envVarsRead.filter((x) => x.name === CREDENTIAL_NAME)).toHaveLength(1);
  });

  it("a real mock ticket has no credential, and the section is the flags of envNames", async () => {
    const { approval } = await issueStartup({ envNames: ["EXAMPLE_ONE", "EXAMPLE_TWO"] });
    expect(approval.credentials).toEqual([]);
    expect(buildEnvSection(approval.envVarsRead, approval.credentials)).toEqual({ ok: true, value: [e("EXAMPLE_ONE", true), e("EXAMPLE_TWO", true)] });
  });

  it("the Mock Run (real orchestrator, real store) records exactly this section in the sealed Run_Manifest, names and flags only", async () => {
    const w = await buildWorld();
    const r = await w.run();
    expect(r.sealed).toBe(true);
    const manifest = JSON.parse(new TextDecoder().decode(w.mem.peek(`${RUN_DIR}/${MANIFEST_FILE}`) as Uint8Array)) as Any;
    const expected = buildEnvSection(w.approval.envVarsRead, w.approval.credentials);
    expect(expected.ok).toBe(true);
    if (!expected.ok) return;
    expect(manifest.envVarsRead).toEqual(expected.value);
    expect(manifest.envVarsRead).toEqual([e("EXAMPLE_ONE", true)]);
    for (const x of manifest.envVarsRead as Any[]) expect(Object.keys(x).sort()).toEqual(["name", "set"]);
  });
});