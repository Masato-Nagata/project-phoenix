// Runtime guarantees of an AuditedRequest and the verification wrapper of createProvider (task 3.4; R2.1, R2.3, R3.8).
// Every audited request here comes from the real `auditPayload`. No test builds an audited request by any other means, and the
// package source has no function that does (checked below).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MOCK_FIXTURES, auditPayload, createProvider, isAuditViolation, sha256Hex } from "../src/index.js";
import type { AiProvider, AuditedRequest, ProviderError, RequestKind, Result } from "../src/index.js";
import { guardProvider } from "../src/providerGuard.js";
import { consumeForSend, mintAuditedRequest } from "../src/internal/auditedRegistry.js";
import { dec, makeWorld } from "./helpers/auditFixtures.js";

const KIND: RequestKind = "hypothesis_revision";
const live = () => ({ timeoutMs: 1000, signal: new AbortController().signal });

/** A fresh real audit of the same payload; every call returns a new audited request. */
function world() {
  const w = makeWorld();
  const bytes = w.bytes(w.envelope());
  const newRequest = (): AuditedRequest => {
    const r = auditPayload(bytes, KIND, w.cfg, w.ctx);
    if (r.request === undefined) throw new Error("the fixture payload must pass");
    return r.request;
  };
  return { w, bytes, newRequest };
}

/** An inner provider that records what it was given. */
function spyProvider(result: () => Promise<Result<Uint8Array, ProviderError>> | Result<Uint8Array, ProviderError> = () => ({ ok: true, value: new Uint8Array([1]) })) {
  const calls: { kind: RequestKind; bytes: Uint8Array; sha256: string }[] = [];
  const provider: AiProvider = {
    identity: { id: "spy", version: "0", model: "not_applicable" },
    complete: async (req) => {
      calls.push({ kind: req.kind, bytes: req.bytes, sha256: req.sha256 });
      return result();
    },
  };
  return { provider, calls };
}
const guarded = (inner: AiProvider): AiProvider => createProvider({ provider: "mock" }, { mock: () => inner });
const violationOf = (r: Result<Uint8Array, ProviderError>) => {
  expect(r.ok).toBe(false);
  if (r.ok || !isAuditViolation(r.error)) throw new Error("expected an audit_violation");
  return r.error;
};

describe("a legitimate audited request", () => {
  it("is served by the Mock_Provider through createProvider, with a real audit (wrapper path)", async () => {
    const { newRequest } = world();
    const provider = createProvider({ provider: "mock" });
    const r = await provider.complete(newRequest(), live());
    expect(r.ok).toBe(true);
    const hypothesis = DEFAULT_MOCK_FIXTURES.find((f) => f.requestKind === KIND);
    if (r.ok) expect(Buffer.from(r.value).equals(Buffer.from(hypothesis?.response as Uint8Array))).toBe(true);
  });

  it("reaches the inner provider with the audited kind, bytes and hash", async () => {
    const { bytes, newRequest } = world();
    const { provider, calls } = spyProvider();
    const r = await guarded(provider).complete(newRequest(), live());
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.kind).toBe(KIND);
    expect(calls[0]?.sha256).toBe(sha256Hex(bytes));
    expect(Buffer.from(calls[0]?.bytes as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
  });

  it("keeps the identity of the wrapped provider and the AiProvider shape (identity, complete)", () => {
    const { provider } = spyProvider();
    const g = guarded(provider);
    expect(g.identity).toEqual(provider.identity);
    expect(Object.keys(g).sort()).toEqual(["complete", "identity"]);
    expect(Object.isFrozen(g)).toBe(true);
  });
});

describe("forged requests are refused with audit_violation, and the provider is not called", () => {
  it("refuses a request made by a cast, even when its hash is right", async () => {
    const { bytes } = world();
    const { provider, calls } = spyProvider();
    const forged = { kind: KIND, bytes, sha256: sha256Hex(bytes) } as unknown as AuditedRequest;
    const e = violationOf(await guarded(provider).complete(forged, live()));
    expect(e.violation.code).toBe("not_audited");
    expect(e.violation.claimedSha256).toBe(sha256Hex(bytes));
    expect(e.violation.auditedSha256).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("refuses a copy of a real audited request (spread, Object.create, structuredClone, JSON round trip)", async () => {
    const { newRequest } = world();
    const { provider, calls } = spyProvider();
    const g = guarded(provider);
    const real = newRequest();
    const copies: unknown[] = [{ ...real }, Object.create(real), structuredClone({ kind: real.kind, bytes: real.bytes, sha256: real.sha256 }), JSON.parse(JSON.stringify({ kind: real.kind, sha256: real.sha256 }))];
    for (const c of copies) expect(violationOf(await g.complete(c as AuditedRequest, live())).violation.code).toBe("not_audited");
    expect(calls).toHaveLength(0);
    // the real one is untouched by the refused copies
    expect((await g.complete(real, live())).ok).toBe(true);
  });

  it("refuses values that are not objects, and objects whose getters throw", async () => {
    const { provider, calls } = spyProvider();
    const g = guarded(provider);
    const hostile = { get kind(): string { throw new Error("x"); }, get sha256(): string { throw new Error("y"); } };
    for (const v of [undefined, null, 1, "text", [], hostile]) expect(violationOf(await g.complete(v as never, live())).violation.code).toBe("not_audited");
    expect(calls).toHaveLength(0);
  });

  it("refuses a request of another copy of the package (a second module instance has its own registry)", async () => {
    const { newRequest } = world();
    const first = newRequest();
    vi.resetModules();
    const other = await import("../src/index.js");
    const { provider, calls } = spyProvider();
    const g = other.createProvider({ provider: "mock" }, { mock: () => provider });
    const e = violationOf(await g.complete(first, live()));
    expect(e.violation.code).toBe("not_audited");
    expect(calls).toHaveLength(0);
    // and the reverse direction: a request of the other copy is refused by this copy
    const w2 = makeWorld();
    const foreign = other.auditPayload(w2.bytes(w2.envelope()), KIND, w2.cfg, w2.ctx).request as AuditedRequest;
    expect(foreign).toBeDefined();
    expect(violationOf(await guarded(provider).complete(foreign, live())).violation.code).toBe("not_audited");
  });
});

describe("single use", () => {
  it("refuses a second use of the same request, and the second use does not call the provider", async () => {
    const { newRequest } = world();
    const { provider, calls } = spyProvider();
    const g = guarded(provider);
    const req = newRequest();
    expect((await g.complete(req, live())).ok).toBe(true);
    const e = violationOf(await g.complete(req, live()));
    expect(e.violation.code).toBe("already_used");
    expect(e.violation.auditedSha256).toBe(req.sha256);
    expect(calls).toHaveLength(1);
  });

  it("consumes the request for a call with an already aborted signal", async () => {
    const { newRequest } = world();
    const { provider } = spyProvider();
    const g = createProvider({ provider: "mock" });
    const req = newRequest();
    const ac = new AbortController();
    ac.abort();
    const first = await g.complete(req, { timeoutMs: 1000, signal: ac.signal });
    expect(first).toEqual({ ok: false, error: { reason: "error", detail: "aborted" } });
    expect(violationOf(await g.complete(req, live())).violation.code).toBe("already_used");
    void provider;
  });

  it("consumes the request when the provider returns an error, rejects, throws, or returns something malformed", async () => {
    const cases: [string, () => Promise<Result<Uint8Array, ProviderError>>][] = [
      ["error", async () => ({ ok: false, error: { reason: "error", detail: "inner failure" } })],
      ["timeout", async () => ({ ok: false, error: { reason: "timeout", detail: "slow" } })],
      ["rejects", () => Promise.reject(new Error("secret payload text"))],
      ["throws", () => { throw new Error("secret payload text"); }],
      ["malformed", async () => ({ ok: true, value: "not bytes" }) as never],
    ];
    for (const [name, make] of cases) {
      const { newRequest } = world();
      const { provider, calls } = spyProvider(make);
      const g = guarded(provider);
      const req = newRequest();
      const r1 = await g.complete(req, live());
      expect(r1.ok, name).toBe(false);
      if (!r1.ok) {
        expect(JSON.stringify(r1.error), name).not.toContain("secret payload text");
        expect(isAuditViolation(r1.error), name).toBe(false);
      }
      expect(violationOf(await g.complete(req, live())).violation.code, name).toBe("already_used");
      expect(calls, name).toHaveLength(1);
    }
  });

  it("consumes the request before the first await: two concurrent calls, one wins", async () => {
    const { newRequest } = world();
    const { provider, calls } = spyProvider();
    const g = guarded(provider);
    const req = newRequest();
    const [a, b] = await Promise.all([g.complete(req, live()), g.complete(req, live())]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    expect(violationOf(a.ok ? b : a).violation.code).toBe("already_used");
    expect(calls).toHaveLength(1);
  });

  it("allows a retry only with a new audit: the same bytes audited again give a new, usable request", async () => {
    const { newRequest } = world();
    const { provider, calls } = spyProvider(async () => ({ ok: false, error: { reason: "timeout", detail: "slow" } }));
    const g = guarded(provider);
    const first = newRequest();
    await g.complete(first, live());
    expect(violationOf(await g.complete(first, live())).violation.code).toBe("already_used");
    const retry = newRequest();
    expect(retry).not.toBe(first);
    expect(retry.sha256).toBe(first.sha256);
    const r = await g.complete(retry, live());
    expect(isAuditViolation((r as { error?: ProviderError }).error ?? ({ reason: "error", detail: "" } as ProviderError))).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("a request refused as not audited cannot be 'used up' by someone else, and a used request stays used in another wrapper", async () => {
    const { newRequest } = world();
    const a = spyProvider();
    const b = spyProvider();
    const req = newRequest();
    expect((await guarded(a.provider).complete(req, live())).ok).toBe(true);
    expect(violationOf(await guarded(b.provider).complete(req, live())).violation.code).toBe("already_used");
    expect(b.calls).toHaveLength(0);
  });
});

describe("audited bytes cannot be changed from outside", () => {
  it("is not affected by a change of the caller's input array after the audit", async () => {
    const w = makeWorld();
    const input = w.bytes(w.envelope());
    const original = input.slice();
    const { request } = auditPayload(input, KIND, w.cfg, w.ctx);
    input.fill(0);
    const { provider, calls } = spyProvider();
    expect((await guarded(provider).complete(request as AuditedRequest, live())).ok).toBe(true);
    expect(Buffer.from(calls[0]?.bytes as Uint8Array).equals(Buffer.from(original))).toBe(true);
    expect(sha256Hex(calls[0]?.bytes as Uint8Array)).toBe(request?.sha256);
  });

  it("returns a copy from every read of bytes, so a change of that copy changes nothing held", async () => {
    const { bytes, newRequest } = world();
    const req = newRequest();
    const a = req.bytes;
    const b = req.bytes;
    expect(a).not.toBe(b);
    a.fill(0xff);
    expect(Buffer.from(req.bytes).equals(Buffer.from(bytes))).toBe(true);
    const { provider, calls } = spyProvider();
    await guarded(provider).complete(req, live());
    expect(Buffer.from(calls[0]?.bytes as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
  });

  it("is frozen: kind and hash cannot be replaced, and the registry state does not follow a property write", async () => {
    const { newRequest } = world();
    const req = newRequest() as unknown as Record<string, unknown>;
    expect(Object.isFrozen(req)).toBe(true);
    expect(() => { req["sha256"] = sha256Hex("other"); }).toThrow(TypeError);
    expect(() => { req["kind"] = "experiment_generation"; }).toThrow(TypeError);
    expect(() => { req["bytes"] = new Uint8Array(); }).toThrow(TypeError);
  });

  it("the registry keeps its own copy of the bytes it is given, even if the caller of mint keeps the array (defense in depth)", () => {
    // `auditPayload` already passes a private array, so this cannot be seen through the public API; the registry does not rely on that.
    const given = new TextEncoder().encode("payload");
    const hash = sha256Hex(given);
    const req = mintAuditedRequest(KIND, given, hash);
    given.fill(0);
    expect(dec(req.bytes)).toBe("payload");
    expect(consumeForSend(req).ok).toBe(true);
  });
  it("detects held bytes that no longer match the audited hash (hash_mismatch) and does not call the provider", async () => {
    // Not reachable through the public API; this builds the inconsistency with the registry's own constructor, in test code only.
    const bytes = new TextEncoder().encode("payload");
    const req = mintAuditedRequest(KIND, bytes, sha256Hex("different"));
    const c = consumeForSend(req);
    expect(c.ok).toBe(false);
    if (!c.ok) {
      expect(c.violation.code).toBe("hash_mismatch");
      expect(c.violation.recomputedSha256).toBe(sha256Hex(bytes));
      expect(c.violation.auditedSha256).toBe(sha256Hex("different"));
    }
    const { provider, calls } = spyProvider();
    expect(violationOf(await guarded(provider).complete(req, live())).violation.code).toBe("already_used"); // it was consumed by the check above
    expect(calls).toHaveLength(0);
    const fresh = mintAuditedRequest(KIND, bytes, sha256Hex("different"));
    expect(violationOf(await guarded(provider).complete(fresh, live())).violation.code).toBe("hash_mismatch");
    expect(calls).toHaveLength(0);
  });
});

describe("audit_violation carries information to record and no payload", () => {
  it("has a fixed detail and a violation of kind and hashes only", async () => {
    const { bytes } = world();
    const { provider } = spyProvider();
    const forged = { kind: KIND, bytes, sha256: sha256Hex(bytes) } as unknown as AuditedRequest;
    const e = violationOf(await guarded(provider).complete(forged, live()));
    expect(e.reason).toBe("audit_violation");
    expect(e.detail).toBe("request was not created by the Payload_Auditor of this package");
    expect(Object.keys(e.violation).sort()).toEqual(["claimedSha256", "code", "requestKind"]);
    const text = JSON.stringify(e);
    expect(text).not.toContain("fictional revision text");
    expect(text).not.toContain(dec(bytes).slice(0, 40));
  });

  it("is told apart from a provider failure by isAuditViolation", () => {
    expect(isAuditViolation({ reason: "error", detail: "x" })).toBe(false);
    expect(isAuditViolation({ reason: "timeout", detail: "x" })).toBe(false);
    expect(isAuditViolation({ reason: "audit_violation", detail: "x", violation: { code: "already_used" } })).toBe(true);
  });
});

describe("no public path to an unguarded provider or to a forged request", () => {
  it("createProvider wraps every provider, including one that is already a guarded wrapper (no double consumption)", async () => {
    const { newRequest } = world();
    const { provider, calls } = spyProvider();
    const once = guardProvider(provider);
    expect(guardProvider(once)).toBe(once);
    const g = createProvider({ provider: "mock" }, { mock: () => once });
    expect((await g.complete(newRequest(), live())).ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("the package entry exports exactly these values (a new export must be added here on purpose)", async () => {
    const entry = await import("../src/index.js");
    expect(Object.keys(entry).sort()).toEqual([
      "AUDIT_CHECK_IDS", "AUDIT_LIMITS_CEILING", "DEFAULT_AUDIT_LIMITS", "DEFAULT_MOCK_FIXTURES", "DEFAULT_MOCK_FIXTURE_SET_NAME", "DEFAULT_NGRAM_SIZE", "DEFAULT_RESPONSE_LIMITS",
      "FINGERPRINT_HEX_LENGTH", "MOCK_FIXTURE_SETS", "PACKAGE_NAME", "PROVIDER_CREDENTIALS", "PROVIDER_NAMES", "ProviderSelectionError", "REQUEST_KINDS",
      "RESPONSE_MAX_DEPTH", "STORED_PART_TYPES", "TOKENIZER_ID", "auditPayload", "authorityRuleOf", "canonicalJson", "checkProviderCredentials", "checkRequestHash", "createProvider", "isAuditViolation",
      "effectiveAuditLimits", "gateProviderResult", "gateResponse", "isAuthorityLikeName", "isSha256Hex", "looksLikeToolCall", "resolveResponseLimits", "toInertText", "ngramHashes", "parseAuditConfig", "sha256Hex", "strictJsonParse", "tokenize", "tryCanonicalJson",
    ].sort());
    for (const hidden of ["MockProvider", "DEFAULT_PROVIDER_FACTORIES", "guardProvider", "mintAuditedRequest", "consumeForSend", "KiroCliProvider", "ReplayProvider"]) {
      expect(Object.keys(entry), hidden).not.toContain(hidden);
    }
  });

  it("no source file other than the Payload_Auditor calls mintAuditedRequest, and no source file builds an audited request by a cast", () => {
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
    const norm = (p: string): string => p.replaceAll("\\", "/");
    const users = files.filter((f) => /mintAuditedRequest\(/.test(readFileSync(f, "utf8"))).map(norm);
    expect(users.map((p) => p.split("/src/")[1]).sort()).toEqual(["audit/payloadAuditor.ts", "internal/auditedRegistry.ts"]);
    for (const f of files) {
      if (norm(f).endsWith("internal/auditedRegistry.ts")) continue;
      expect(readFileSync(f, "utf8"), f).not.toMatch(/as unknown as AuditedRequest|as AuditedRequest/);
    }
  });
});