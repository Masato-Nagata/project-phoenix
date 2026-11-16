import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_NAMES,
  ProviderSelectionError,
  checkRequestHash,
  createProvider,
  isSha256Hex,
  sha256Hex,
} from "../src/index.js";
import type { AiProvider, AuditedRequest, ProviderConfig, ProviderFactories } from "../src/index.js";

function fakeProvider(id: string): AiProvider {
  return {
    identity: { id, version: "0", model: "not_applicable" },
    complete: async () => ({ ok: true, value: new Uint8Array() }),
  };
}

describe("createProvider", () => {
  const factories: ProviderFactories = {
    mock: () => fakeProvider("mock"),
    replay: () => fakeProvider("replay"),
  };

  it("selects the implementation by the single provider value, with the same caller code", () => {
    const callerCode = (cfg: ProviderConfig): string => createProvider(cfg, factories).identity.id;
    expect(callerCode({ provider: "mock" })).toBe("mock");
    expect(callerCode({ provider: "replay" })).toBe("replay");
  });

  it("passes the whole configuration to the factory", () => {
    let seen: ProviderConfig | undefined;
    createProvider({ provider: "mock", extra: [1, { a: true }] }, { mock: (c) => ((seen = c), fakeProvider("mock")) });
    expect(seen).toEqual({ provider: "mock", extra: [1, { a: true }] });
  });

  it("fails closed for a known name without a registered factory and does not fall back", () => {
    expect(() => createProvider({ provider: "kiro-cli" }, factories)).toThrowError(ProviderSelectionError);
    try {
      createProvider({ provider: "kiro-cli" }, factories);
    } catch (e) {
      expect((e as ProviderSelectionError).code).toBe("provider_not_available");
    }
  });

  it("rejects an unknown name, a non-string name and inherited property names", () => {
    for (const bad of ["Mock", "", "constructor", "__proto__", "toString"]) {
      try {
        createProvider({ provider: bad as never }, factories);
        expect.unreachable();
      } catch (e) {
        expect((e as ProviderSelectionError).code).toBe("unknown_provider");
      }
    }
    expect(() => createProvider({ provider: 1 as never }, factories)).toThrowError(ProviderSelectionError);
  });

  it("registers only the mock provider by default and never falls back to it", () => {
    expect(createProvider({ provider: "mock" }).identity).toEqual({ id: "mock", version: "1", model: "not_applicable" });
    for (const name of PROVIDER_NAMES.filter((n) => n !== "mock")) {
      try {
        createProvider({ provider: name });
        expect.unreachable();
      } catch (e) {
        expect((e as ProviderSelectionError).code).toBe("provider_not_available");
      }
    }
  });

  it("selects a mock fixture set by name and rejects an unknown or non-string name", () => {
    expect(createProvider({ provider: "mock", mockFixtureSet: "default-widget-v1" }).identity.id).toBe("mock");
    for (const bad of ["nope", "", "constructor", 1, null]) {
      try {
        createProvider({ provider: "mock", mockFixtureSet: bad as never });
        expect.unreachable();
      } catch (e) {
        expect((e as ProviderSelectionError).code).toBe("invalid_provider_config");
      }
    }
  });
});

describe("hash helpers", () => {
  it("computes the SHA-256 of bytes and strings", () => {
    expect(sha256Hex(new Uint8Array())).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe(sha256Hex(new TextEncoder().encode("abc")));
  });

  it("validates lowercase 64-character hex only", () => {
    expect(isSha256Hex(sha256Hex("x"))).toBe(true);
    expect(isSha256Hex(sha256Hex("x").toUpperCase())).toBe(false);
    expect(isSha256Hex("abc")).toBe(false);
    expect(isSha256Hex(undefined)).toBe(false);
  });

  it("checkRequestHash passes for matching bytes and fails with reason error otherwise", () => {
    const bytes = new TextEncoder().encode("payload");
    expect(checkRequestHash({ bytes, sha256: sha256Hex(bytes) }).ok).toBe(true);
    const r = checkRequestHash({ bytes, sha256: sha256Hex("other") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("error");
  });

  it("checkRequestHash detects a single changed byte", () => {
    const bytes = new TextEncoder().encode("payload");
    const hash = sha256Hex(bytes);
    const changed = bytes.slice();
    changed[0] = (changed[0] ?? 0) ^ 1;
    expect(checkRequestHash({ bytes: changed, sha256: hash }).ok).toBe(false);
  });
});

describe("interface surface (R3.6)", () => {
  it("an AiProvider has only identity and complete", () => {
    expect(Object.keys(fakeProvider("x")).sort()).toEqual(["complete", "identity"]);
  });

  it("the AuditedRequest brand has no runtime value and is not exported from the package entry", async () => {
    const entry = await import("../src/index.js");
    expect(Object.keys(entry)).not.toContain("auditedBrand");
    const req = { kind: "hypothesis_generation", bytes: new Uint8Array(), sha256: sha256Hex("") } as unknown as AuditedRequest;
    expect(Object.getOwnPropertySymbols(req)).toEqual([]);
  });

  it("the mock provider module reads no clock and no random source (R3.3)", () => {
    for (const name of ["mockProvider.ts", "defaultFixtures.ts"]) {
      const text = readFileSync(join(import.meta.dirname, "..", "src", "mock", name), "utf8");
      expect(text).not.toMatch(/\bDate\b|Math\.random|performance\.|crypto\.random|setTimeout|setInterval|process\./);
    }
  });

  it("package source imports no file, process, network, Docker, Git, evaluation or other-package module; only node:crypto", () => {
    const srcDir = join(import.meta.dirname, "..", "src");
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) files.push(p);
      }
    };
    walk(srcDir);
    expect(files.length).toBeGreaterThan(0);
    const importRe = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const m of text.matchAll(importRe)) {
        const spec = m[1] ?? "";
        const inside = spec.startsWith(".") && resolve(dirname(f), spec).startsWith(srcDir + sep);
        expect(inside || spec === "node:crypto", `${f} imports ${spec}`).toBe(true);
      }
      expect(text).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|process\.env|eval|Function)\s*\(/);
    }
  });
});
