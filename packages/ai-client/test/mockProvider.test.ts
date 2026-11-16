import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOCK_FIXTURES,
  MOCK_FIXTURE_SETS,
  REQUEST_KINDS,
  createProvider,
  sha256Hex,
} from "../src/index.js";
// The raw provider is not exported from the package entry (task 3.4); these tests reach it by a relative import on purpose.
import { MockProvider } from "../src/mock/mockProvider.js";
import type { AuditedRequest, MockFixture, RequestKind } from "../src/index.js";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

/** Test-only construction. The real constructor is the Payload_Auditor of task 3.4; this is a cast, not an audit. */
function req(kind: RequestKind, text: string, sha256?: string): AuditedRequest {
  const bytes = enc(text);
  return { kind, bytes, sha256: sha256 ?? sha256Hex(bytes) } as unknown as AuditedRequest;
}
const opts = () => ({ timeoutMs: 1000, signal: new AbortController().signal });

describe("MockProvider: fixtures and matching", () => {
  const p = new MockProvider(DEFAULT_MOCK_FIXTURES);

  it("has fixtures for each of the three request kinds (R3.13)", () => {
    for (const kind of REQUEST_KINDS) {
      expect(DEFAULT_MOCK_FIXTURES.some((f) => f.requestKind === kind), kind).toBe(true);
    }
  });

  it("answers each kind with valid UTF-8 JSON", async () => {
    for (const kind of REQUEST_KINDS) {
      const r = await p.complete(req(kind, "any request"), opts());
      expect(r.ok).toBe(true);
      if (r.ok) expect(() => JSON.parse(dec(r.value))).not.toThrow();
    }
  });

  it("returns byte-identical responses for identical requests, regardless of call count and earlier calls (R3.3)", async () => {
    const a = await p.complete(req("hypothesis_generation", "same"), opts());
    await p.complete(req("experiment_generation", "other"), opts());
    await p.complete(req("hypothesis_generation", "unrelated"), opts());
    const b = await p.complete(req("hypothesis_generation", "same"), opts());
    const fresh = await new MockProvider(DEFAULT_MOCK_FIXTURES).complete(req("hypothesis_generation", "same"), opts());
    expect(a.ok && b.ok && fresh.ok).toBe(true);
    if (a.ok && b.ok && fresh.ok) {
      expect(Buffer.from(a.value).equals(Buffer.from(b.value))).toBe(true);
      expect(Buffer.from(a.value).equals(Buffer.from(fresh.value))).toBe(true);
    }
  });

  it("is a pure function of kind and bytes for any request bytes (property)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...REQUEST_KINDS), fc.string({ unit: "binary" }), async (kind, text) => {
        const x = await p.complete(req(kind, text), opts());
        const y = await p.complete(req(kind, text), opts());
        expect(x).toEqual(y);
      }),
      { numRuns: 100 },
    );
  });

  it("does not let a caller change later answers through a returned array or the fixture array it passed in", async () => {
    const source = enc('{"a":1}');
    const q = new MockProvider([{ requestKind: "hypothesis_revision", response: source }]);
    source[0] = 0;
    const first = await q.complete(req("hypothesis_revision", "x"), opts());
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(dec(first.value)).toBe('{"a":1}');
      first.value[0] = 0;
    }
    const second = await q.complete(req("hypothesis_revision", "x"), opts());
    expect(second.ok && dec(second.value)).toBe('{"a":1}');
  });

  it("prefers a hash-specific fixture over the kind-wide one, and matches the kind as well", async () => {
    const hit = req("experiment_generation", "special");
    const q = new MockProvider([
      { requestKind: "experiment_generation", response: enc("wide") },
      { requestKind: "experiment_generation", matchRequestSha256: hit.sha256, response: enc("specific") },
    ]);
    const a = await q.complete(hit, opts());
    const b = await q.complete(req("experiment_generation", "other"), opts());
    const c = await q.complete(req("hypothesis_generation", "special"), opts());
    expect(a.ok && dec(a.value)).toBe("specific");
    expect(b.ok && dec(b.value)).toBe("wide");
    expect(c.ok).toBe(false);
  });

  it("returns unmatched_request with no body when no fixture answers, and never fabricates (R3.12)", async () => {
    const q = new MockProvider([{ requestKind: "hypothesis_generation", response: enc("only") }]);
    const r = await q.complete(req("experiment_generation", "x"), opts());
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.reason).toBe("unmatched_request");
      expect(r.error.detail).toContain("experiment_generation");
      expect(r).not.toHaveProperty("value");
    }
    const empty = await new MockProvider([]).complete(req("hypothesis_generation", "x"), opts());
    expect(!empty.ok && empty.error.reason).toBe("unmatched_request");
    const hashOnly = new MockProvider([
      { requestKind: "hypothesis_generation", matchRequestSha256: sha256Hex("other"), response: enc("r") },
    ]);
    const miss = await hashOnly.complete(req("hypothesis_generation", "x"), opts());
    expect(!miss.ok && miss.error.reason).toBe("unmatched_request");
  });

  it("does not echo request content in an error detail, only kind and hash", async () => {
    const secret = "SECRET-PAYLOAD-TEXT";
    const r = await new MockProvider([]).complete(req("hypothesis_generation", secret), opts());
    expect(!r.ok && r.error.detail).not.toContain(secret);
  });
});

describe("MockProvider: request checks", () => {
  const p = new MockProvider(DEFAULT_MOCK_FIXTURES);

  it("fails with error when the bytes do not match the audited hash (checkRequestHash, R2.3)", async () => {
    const r = await p.complete(req("hypothesis_generation", "payload", sha256Hex("different")), opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.reason).toBe("error");
  });

  it("fails with error for a kind that is not one of the three", async () => {
    const r = await p.complete(req("tool_call" as never, "x"), opts());
    expect(!r.ok && r.error.reason).toBe("error");
  });

  it("serves no response when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await p.complete(req("hypothesis_generation", "x"), { timeoutMs: 1000, signal: ac.signal });
    expect(r).toEqual({ ok: false, error: { reason: "error", detail: "aborted" } });
  });

  it("checks the abort before the hash and the fixture lookup", async () => {
    const ac = new AbortController();
    ac.abort();
    const r = await p.complete(req("hypothesis_generation", "x", sha256Hex("bad")), { timeoutMs: 1000, signal: ac.signal });
    expect(!r.ok && r.error.detail).toBe("aborted");
  });

  it("rejects a timeoutMs that is not a finite number above 0", async () => {
    for (const timeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5" as never]) {
      const r = await p.complete(req("hypothesis_generation", "x"), { timeoutMs, signal: new AbortController().signal });
      expect(!r.ok && r.error.reason, String(timeoutMs)).toBe("error");
    }
  });

  it("never returns timeout and answers at once for any positive limit", async () => {
    const started = Date.now();
    const r = await p.complete(req("hypothesis_generation", "x"), { timeoutMs: 1, signal: new AbortController().signal });
    expect(r.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does not listen to a signal that aborts after the call (the answer is already returned)", async () => {
    const ac = new AbortController();
    const done = p.complete(req("hypothesis_generation", "x"), { timeoutMs: 1000, signal: ac.signal });
    ac.abort();
    const r = await done;
    expect(r.ok).toBe(true);
  });
});

describe("MockProvider: configuration errors", () => {
  it("rejects an unknown kind, a bad hash, a non-Uint8Array response and duplicate fixtures", () => {
    const ok = enc("x");
    expect(() => new MockProvider([{ requestKind: "nope" as never, response: ok }])).toThrow(TypeError);
    expect(() => new MockProvider([{ requestKind: "hypothesis_generation", matchRequestSha256: "abc", response: ok }])).toThrow(TypeError);
    expect(() => new MockProvider([{ requestKind: "hypothesis_generation", response: "x" as never }])).toThrow(TypeError);
    const dup: MockFixture[] = [
      { requestKind: "hypothesis_generation", response: ok },
      { requestKind: "hypothesis_generation", response: ok },
    ];
    expect(() => new MockProvider(dup)).toThrow(TypeError);
    const h = sha256Hex("a");
    expect(
      () =>
        new MockProvider([
          { requestKind: "hypothesis_generation", matchRequestSha256: h, response: ok },
          { requestKind: "hypothesis_generation", matchRequestSha256: h, response: ok },
        ]),
    ).toThrow(TypeError);
  });

  it("is selected through createProvider with no caller change (identity of the raw provider is kept)", () => {
    const viaConfig = createProvider({ provider: "mock" });
    expect(viaConfig.identity).toEqual(new MockProvider(DEFAULT_MOCK_FIXTURES).identity);
  });
});

describe("default fixtures: neutrality", () => {
  const all = Object.values(MOCK_FIXTURE_SETS).flat();

  it("carry no authority-like name at any level (R4.16) and no evaluation path", () => {
    const names: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v !== null && typeof v === "object") {
        for (const [k, x] of Object.entries(v)) {
          names.push(k);
          walk(x);
        }
      }
    };
    for (const f of all) {
      const text = dec(f.response);
      expect(text).not.toMatch(/evaluation[\\/]|ground[-_ ]?truth|canary|decoy|migration[-_ ]decision|conformance/i);
      walk(JSON.parse(text));
    }
    for (const n of names) {
      const folded = n.toLowerCase().replaceAll("_", "").replaceAll("-", "");
      expect(folded === "origin" || folded.startsWith("evidence") || folded.endsWith("evidencestatus") || folded.startsWith("approv"), n).toBe(false);
    }
  });
});
