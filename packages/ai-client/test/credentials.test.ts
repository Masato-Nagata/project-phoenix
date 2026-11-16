// Task 3.11: credentials come from environment variables only; an unset variable of a real provider refuses the Run by name; the Mock_Provider needs none.
// Synthetic values only (R19.1: no credential value in code, configuration or fixtures).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PROVIDER_CREDENTIALS, PROVIDER_NAMES, checkProviderCredentials } from "../src/index.js";

const FAKE = "synthetic-credential-value-0042";
const repo = join(import.meta.dirname, "..", "..", "..");

describe("checkProviderCredentials (R19.3, R19.6, R19.10)", () => {
  it("needs no credential for the Mock_Provider and the replay provider, with an empty environment", () => {
    expect(PROVIDER_CREDENTIALS.mock).toEqual([]);
    expect(checkProviderCredentials("mock", {})).toEqual({ ok: true, referenced: [] });
    expect(checkProviderCredentials("replay", {})).toEqual({ ok: true, referenced: [] });
  });

  it("refuses the real provider when its variable is unset, empty or blank, naming the variable and never a value", () => {
    for (const env of [{}, { KIRO_API_KEY: undefined }, { KIRO_API_KEY: "" }, { KIRO_API_KEY: "   " }, { KIRO_API_KEY: "\t\n" }, { OTHER_KEY: FAKE }]) {
      const r = checkProviderCredentials("kiro-cli", env);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.error).toEqual({ code: "credential_unset", variable: "KIRO_API_KEY" });
        expect(r.referenced).toEqual([{ name: "KIRO_API_KEY", set: false }]);
      }
      expect(JSON.stringify(r).includes(FAKE)).toBe(false);
    }
  });

  it("accepts the real provider when its variable is set, and reports the name with a set flag only", () => {
    const r = checkProviderCredentials("kiro-cli", { KIRO_API_KEY: FAKE, UNRELATED: "x" });
    expect(r).toEqual({ ok: true, referenced: [{ name: "KIRO_API_KEY", set: true }] });
    expect(JSON.stringify(r).includes(FAKE)).toBe(false);
  });

  it("fails closed for a provider name that is not one of the three, and for names that exist on every object", () => {
    for (const name of ["", "Mock", "openai", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const r = checkProviderCredentials(name, { KIRO_API_KEY: FAKE });
      expect(r.ok, name).toBe(false);
      if (!r.ok) expect(r.error.code).toBe("unknown_provider");
    }
  });

  it("reads a variable only if it is an own entry of the given environment (an inherited name does not count)", () => {
    const inherited = Object.create({ KIRO_API_KEY: FAKE }) as Record<string, string>;
    expect(checkProviderCredentials("kiro-cli", inherited).ok).toBe(false);
  });

  it("lists every provider, and each variable name is an upper-case environment name", () => {
    for (const p of PROVIDER_NAMES) {
      expect(Object.hasOwn(PROVIDER_CREDENTIALS, p)).toBe(true);
      for (const v of PROVIDER_CREDENTIALS[p]) expect(v).toMatch(/^[A-Z][A-Z0-9_]*$/);
    }
  });
});

describe("no credential in the repository files of this feature (R19.1, R19.4, R19.5)", () => {
  it(".env.example lists the variable with no value, and .gitignore keeps .env files out of Git", () => {
    const example = readFileSync(join(repo, ".env.example"), "utf8").split(/\r?\n/);
    const line = example.find((l) => l.startsWith("KIRO_API_KEY="));
    expect(line).toBe("KIRO_API_KEY=");
    const ignore = readFileSync(join(repo, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
    expect(ignore).toContain(".env");
    expect(ignore).toContain("*.env");
    expect(ignore).toContain("!.env.example");
  });

  it("the package source, its fixtures and its tests hold no value that looks like a credential, and the source never reads the process environment", () => {
    const files = ["src/credentials.ts", "src/provider.ts", "src/mock/mockProvider.ts", "src/mock/defaultFixtures.ts", "src/responseGate.ts", "src/audit/payloadAuditor.ts"];
    for (const f of files) {
      const text = readFileSync(join(import.meta.dirname, "..", f), "utf8");
      expect(text, f).not.toMatch(/\bsk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      expect(text, f).not.toMatch(/process\.env|\bprocess\b\s*\[/);
    }
  });
});