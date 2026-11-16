// Feature: discovery-loop, Property 22: Mock_Provider is deterministic and never fabricates
// **Validates: Requirements 3.3, 3.12**
// Fixed seed and bounded run count so a failure is reproducible. No per-test timeout is set: the default of 5 s applies.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_NAMES,
  REQUEST_KINDS,
  createProvider,
  sha256Hex,
} from "../src/index.js";
import type { AiProvider, AuditedRequest, MockFixture, ProviderFactories, RequestKind } from "../src/index.js";
// The raw provider is not exported from the package entry (task 3.4); these tests reach it by a relative import on purpose.
import { MockProvider } from "../src/mock/mockProvider.js";

const FC: fc.Parameters<unknown> = { seed: 22_003_001, numRuns: 100 };

// ---- helpers ----
const opts = () => ({ timeoutMs: 1000, signal: new AbortController().signal });
/** Test-only construction by cast; the real constructor is the Payload_Auditor of task 3.4. */
const request = (kind: RequestKind, bytes: Uint8Array, sha256?: string): AuditedRequest =>
  ({ kind, bytes, sha256: sha256 ?? sha256Hex(bytes) }) as unknown as AuditedRequest;
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
type Outcome = { ok: true; hex: string } | { ok: false; reason: string; detail: string };
async function serve(p: AiProvider, req: AuditedRequest): Promise<Outcome> {
  const r = await p.complete(req, opts());
  return r.ok ? { ok: true, hex: hex(r.value) } : { ok: false, reason: r.error.reason, detail: r.error.detail };
}

// ---- generators ----
const kindArb = fc.constantFrom<RequestKind>(...REQUEST_KINDS);
const bytesArb = fc.uint8Array({ maxLength: 64 });
const responseArb = fc.uint8Array({ minLength: 1, maxLength: 32 });
/** A request in a small pool, so that fixtures keyed by hash are hit often. */
const poolArb = fc.array(fc.tuple(kindArb, bytesArb), { minLength: 1, maxLength: 6 });

interface Table {
  fixtures: MockFixture[];
  /** The model: what the table answers for a given request. */
  expected(kind: RequestKind, sha: string): string | undefined;
}
/** A random fixture table built over a pool of requests: any subset of kind-wide fixtures and of hash-specific fixtures. */
const tableArb = (pool: readonly (readonly [RequestKind, Uint8Array])[]): fc.Arbitrary<Table> =>
  fc
    .tuple(
      fc.array(fc.option(responseArb, { nil: undefined }), { minLength: REQUEST_KINDS.length, maxLength: REQUEST_KINDS.length }),
      fc.array(fc.option(responseArb, { nil: undefined }), { minLength: pool.length, maxLength: pool.length }),
    )
    .map(([wide, specific]) => {
      const fixtures: MockFixture[] = [];
      const wideBy = new Map<RequestKind, Uint8Array>();
      REQUEST_KINDS.forEach((kind, i) => {
        const r = wide[i];
        if (r !== undefined) {
          fixtures.push({ requestKind: kind, response: r });
          wideBy.set(kind, r);
        }
      });
      const specBy = new Map<string, Uint8Array>();
      pool.forEach(([kind, bytes], i) => {
        const r = specific[i];
        const key = `${kind}:${sha256Hex(bytes)}`;
        if (r !== undefined && !specBy.has(key)) {
          fixtures.push({ requestKind: kind, matchRequestSha256: sha256Hex(bytes), response: r });
          specBy.set(key, r);
        }
      });
      return {
        fixtures,
        expected: (kind, sha) => {
          const r = specBy.get(`${kind}:${sha}`) ?? wideBy.get(kind);
          return r === undefined ? undefined : hex(r);
        },
      };
    });
const scenarioArb = poolArb.chain((pool) => tableArb(pool).map((table) => ({ pool, table })));

describe("Property 22: Mock_Provider is deterministic and never fabricates", () => {
  it("answers exactly what the fixture table says: hash-specific, else kind-wide, else unmatched_request with no body (R3.3, R3.12)", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, kindArb, bytesArb, async ({ pool, table }, extraKind, extraBytes) => {
        const p = new MockProvider(table.fixtures);
        for (const [kind, bytes] of [...pool, [extraKind, extraBytes] as const]) {
          const got = await serve(p, request(kind, bytes));
          const want = table.expected(kind, sha256Hex(bytes));
          if (want === undefined) {
            expect(got.ok).toBe(false);
            if (!got.ok) expect(got.reason).toBe("unmatched_request");
          } else {
            expect(got).toEqual({ ok: true, hex: want });
          }
        }
      }),
      FC,
    );
  });

  it("returns byte-identical results for identical requests, on the same and on a fresh provider, with the same error text (R3.3)", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, async ({ pool, table }) => {
        const a = new MockProvider(table.fixtures);
        const b = new MockProvider(table.fixtures);
        for (const [kind, bytes] of pool) {
          const first = await serve(a, request(kind, bytes));
          expect(await serve(a, request(kind, bytes))).toEqual(first);
          expect(await serve(b, request(kind, bytes.slice()))).toEqual(first);
        }
      }),
      FC,
    );
  });

  it("does not depend on call count, on the order of calls or on earlier calls, including concurrent calls (R3.3)", async () => {
    await fc.assert(
      fc.asyncProperty(
        scenarioArb,
        fc.array(fc.nat(), { minLength: 1, maxLength: 20 }),
        async ({ pool, table }, picks) => {
          const reference = new Map<number, Outcome>();
          for (let i = 0; i < pool.length; i++) {
            const [kind, bytes] = pool[i] as readonly [RequestKind, Uint8Array];
            reference.set(i, await serve(new MockProvider(table.fixtures), request(kind, bytes)));
          }
          // One provider serves a random sequence with repeats, sequentially and then all at once.
          const p = new MockProvider(table.fixtures);
          const order = picks.map((n) => n % pool.length);
          for (const i of order) {
            const [kind, bytes] = pool[i] as readonly [RequestKind, Uint8Array];
            expect(await serve(p, request(kind, bytes))).toEqual(reference.get(i));
          }
          const concurrent = await Promise.all(
            order.map((i) => {
              const [kind, bytes] = pool[i] as readonly [RequestKind, Uint8Array];
              return serve(p, request(kind, bytes));
            }),
          );
          concurrent.forEach((got, k) => expect(got).toEqual(reference.get(order[k] as number)));
        },
      ),
      FC,
    );
  });

  it("shares no state through response arrays: changing a returned array or a fixture array never changes a later answer", async () => {
    await fc.assert(
      fc.asyncProperty(kindArb, responseArb, bytesArb, async (kind, response, bytes) => {
        const source = response.slice();
        const p = new MockProvider([{ requestKind: kind, response: source }]);
        const before = hex(response);
        source.fill(0xff); // the caller's fixture array
        const r1 = await p.complete(request(kind, bytes), opts());
        expect(r1.ok && hex(r1.value)).toBe(before);
        if (r1.ok) {
          expect(r1.value).not.toBe(source);
          r1.value.fill(0xaa); // the array that was returned
        }
        const r2 = await p.complete(request(kind, bytes), opts());
        const r3 = await p.complete(request(kind, bytes), opts());
        expect(r2.ok && hex(r2.value)).toBe(before);
        if (r2.ok && r3.ok) expect(r2.value).not.toBe(r3.value);
      }),
      FC,
    );
  });

  it("rejects every request whose sha256 differs from the hash of its bytes, with no response body (R2.3)", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, kindArb, bytesArb, bytesArb, async ({ table }, kind, bytes, otherBytes) => {
        const p = new MockProvider(table.fixtures);
        fc.pre(sha256Hex(bytes) !== sha256Hex(otherBytes));
        const wrongHash = await p.complete(request(kind, bytes, sha256Hex(otherBytes)), opts());
        expect(wrongHash.ok).toBe(false);
        if (!wrongHash.ok) expect(wrongHash.error.reason).toBe("error");
        expect(wrongHash).not.toHaveProperty("value");
        // Bytes changed after the hash was taken (one flipped bit, or an appended byte).
        const flipped = bytes.length > 0 ? bytes.slice() : new Uint8Array([0]);
        const hashOfOriginal = sha256Hex(bytes);
        if (bytes.length > 0) flipped[0] = (flipped[0] as number) ^ 1;
        const changed = await p.complete(request(kind, flipped, hashOfOriginal), opts());
        expect(changed.ok).toBe(false);
        if (!changed.ok) expect(changed.error.reason).toBe("error");
        // A malformed hash is not accepted either.
        const malformed = await p.complete(request(kind, bytes, hashOfOriginal.toUpperCase()), opts());
        expect(malformed.ok).toBe(false);
      }),
      FC,
    );
  });

  it("never answers a hash mismatch from a fixture, even when the fixture would match the claimed hash", async () => {
    await fc.assert(
      fc.asyncProperty(kindArb, bytesArb, bytesArb, responseArb, async (kind, claimedBytes, sentBytes, response) => {
        fc.pre(sha256Hex(claimedBytes) !== sha256Hex(sentBytes));
        const p = new MockProvider([
          { requestKind: kind, matchRequestSha256: sha256Hex(claimedBytes), response },
          { requestKind: kind, response },
        ]);
        const r = await p.complete(request(kind, sentBytes, sha256Hex(claimedBytes)), opts());
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.error.reason).toBe("error");
      }),
      FC,
    );
  });

  it("never answers a kind or a hash that has no fixture, and keeps the error free of the request content", async () => {
    await fc.assert(
      fc.asyncProperty(kindArb, bytesArb, bytesArb, responseArb, async (kind, registered, other, response) => {
        fc.pre(sha256Hex(registered) !== sha256Hex(other));
        const otherKind = REQUEST_KINDS.find((k) => k !== kind) as RequestKind;
        const p = new MockProvider([{ requestKind: kind, matchRequestSha256: sha256Hex(registered), response }]);
        for (const req of [request(otherKind, registered), request(kind, other)]) {
          const r = await p.complete(req, opts());
          expect(r.ok).toBe(false);
          if (!r.ok) {
            expect(r.error.reason).toBe("unmatched_request");
            expect(r.error.detail).toBe(`no canned response for kind ${req.kind} and request sha256 ${req.sha256}`);
          }
        }
        expect((await new MockProvider([]).complete(request(kind, other), opts())).ok).toBe(false);
      }),
      FC,
    );
  });

  it("accepts no abort or invalid time limit, whatever the request: no response is served (R3.8 input handling)", async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArb, fc.constantFrom(0, -1, -0.5, Number.NaN, Number.POSITIVE_INFINITY), async ({ pool, table }, bad) => {
        const p = new MockProvider(table.fixtures);
        const [kind, bytes] = pool[0] as readonly [RequestKind, Uint8Array];
        const ac = new AbortController();
        ac.abort();
        const aborted = await p.complete(request(kind, bytes), { timeoutMs: 1000, signal: ac.signal });
        expect(aborted).toEqual({ ok: false, error: { reason: "error", detail: "aborted" } });
        const badLimit = await p.complete(request(kind, bytes), { timeoutMs: bad, signal: new AbortController().signal });
        expect(badLimit.ok).toBe(false);
        if (!badLimit.ok) expect(badLimit.error.reason).toBe("error");
      }),
      FC,
    );
  });
});

describe("Property 22: provider selection never falls back", () => {
  const sentinel = (id: string, calls: string[]): AiProvider => {
    calls.push(`built:${id}`);
    return { identity: { id, version: "0", model: "not_applicable" }, complete: async () => ({ ok: true, value: new Uint8Array() }) };
  };

  it("builds only the factory named by the configuration value and calls no other factory", () => {
    fc.assert(
      fc.property(fc.constantFrom(...PROVIDER_NAMES), fc.subarray([...PROVIDER_NAMES]), (name, registered) => {
        const calls: string[] = [];
        const factories: ProviderFactories = Object.fromEntries(registered.map((n) => [n, () => sentinel(n, calls)]));
        if (registered.includes(name)) {
          expect(createProvider({ provider: name }, factories).identity.id).toBe(name);
          expect(calls).toEqual([`built:${name}`]);
        } else {
          expect(() => createProvider({ provider: name }, factories)).toThrowError(/no registered implementation/);
          expect(calls).toEqual([]);
        }
      }),
      FC,
    );
  });

  it("never returns a provider for a name outside the three provider names, whatever is registered", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 12 }), (name) => {
        fc.pre(!(PROVIDER_NAMES as readonly string[]).includes(name));
        const calls: string[] = [];
        const factories: ProviderFactories = { mock: () => sentinel("mock", calls), replay: () => sentinel("replay", calls), "kiro-cli": () => sentinel("kiro-cli", calls) };
        expect(() => createProvider({ provider: name as never }, factories)).toThrowError(/unknown provider name/);
        expect(calls).toEqual([]);
      }),
      FC,
    );
  });

  it("without a factory table, only mock is available; replay and kiro-cli fail instead of becoming the mock", () => {
    expect(createProvider({ provider: "mock" }).identity.id).toBe("mock");
    for (const name of ["replay", "kiro-cli"] as const) {
      expect(() => createProvider({ provider: name })).toThrowError(/no registered implementation/);
    }
  });
});
