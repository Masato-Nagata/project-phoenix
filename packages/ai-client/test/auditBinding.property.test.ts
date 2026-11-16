// Feature: discovery-loop, Property 20: Audit fails closed and binds the transmitted bytes
// **Validates: Requirements 2.3, 2.9**
// Fixed seed and bounded run count so a failure can be reproduced. Only synthetic data is used; generated values are descriptors or
// non-sensitive random content, and assertions compare codes, hashes and booleans, never payload text.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  REQUEST_KINDS, STORED_PART_TYPES, auditPayload, canonicalJson, createProvider, isAuditViolation, parseAuditConfig, sha256Hex, tryCanonicalJson,
} from "../src/index.js";
import type { AiProvider, AuditConfigLoadResult, AuditContext, AuditedRequest, Json, ProviderError, Result } from "../src/index.js";
import { mintAuditedRequest } from "../src/internal/auditedRegistry.js";
import { ALLOWLIST, CANARY_VALUE, configBytes, dec, enc } from "./helpers/auditFixtures.js";
import { build } from "./helpers/propertyWorld.js";
import type { Built, PayloadSpec } from "./helpers/propertyWorld.js";

const FC = { seed: 20_001_001, numRuns: 100 };
const live = () => ({ timeoutMs: 1000, signal: new AbortController().signal });

// ---- generators of verified payloads ----
const word = fc.stringMatching(/^[a-z]{2,8}$/);
const textArb = fc.array(word, { maxLength: 20 }).map((w) => `<?php\n// ${w.join(" ")}\n`);
const contentArb = fc.jsonValue({ maxDepth: 3 }).filter((v) => tryCanonicalJson(v).ok) as fc.Arbitrary<Json>;
const specArb: fc.Arbitrary<PayloadSpec> = fc.shuffledSubarray([...ALLOWLIST], { minLength: 1, maxLength: 3 }).chain((paths) =>
  fc.record({
    kind: fc.constantFrom(...REQUEST_KINDS),
    sources: fc.array(textArb, { minLength: paths.length, maxLength: paths.length }).map((texts) => paths.map((path, i) => ({ path, text: texts[i] as string }))),
    stored: fc.array(fc.record({ type: fc.constantFrom(...STORED_PART_TYPES), content: contentArb }), { minLength: 1, maxLength: 3 }),
  }),
);

function spy() {
  const calls: { kind: string; bytes: Uint8Array; sha256: string }[] = [];
  const inner: AiProvider = {
    identity: { id: "spy", version: "0", model: "not_applicable" },
    complete: async (req) => {
      calls.push({ kind: req.kind, bytes: req.bytes, sha256: req.sha256 });
      return { ok: true, value: new Uint8Array([1]) };
    },
  };
  return { calls, provider: createProvider({ provider: "mock" }, { mock: () => inner }) };
}
const violation = (r: Result<Uint8Array, ProviderError>) => (!r.ok && isAuditViolation(r.error) ? r.error.violation : undefined);
const sha = (b: Uint8Array): string => sha256Hex(b);

// ---------------------------------------------------------------------------------------------
describe("Property 20: the audit fails closed", () => {
  const baseObject = (): Record<string, unknown> => JSON.parse(dec(configBytes())) as Record<string, unknown>;
  const without = (field: string, mode: "absent" | "empty"): AuditConfigLoadResult => {
    const o = baseObject();
    if (mode === "absent") delete o[field];
    else o[field] = [];
    return parseAuditConfig(enc(canonicalJson(o as Json)));
  };
  const FIELDS = ["canaries", "decoys", "fingerprints", "allowlist", "restrictedPathPrefixes", "tokenizer", "schemaVersion"] as const;

  const configArb: fc.Arbitrary<AuditConfigLoadResult> = fc.oneof(
    fc.constant(parseAuditConfig(undefined)),
    fc.constant(parseAuditConfig(new Uint8Array())),
    fc.constant<AuditConfigLoadResult>({ ok: false, reason: "unreadable" }),
    fc.tuple(fc.constantFrom(...FIELDS), fc.constantFrom<"absent" | "empty">("absent", "empty")).map(([f, m]) => without(f, m)).filter((c) => !c.ok),
    fc.nat(100_000).map((n) => {
      const full = configBytes();
      return parseAuditConfig(full.slice(0, n % full.length)); // every proper prefix of the configuration
    }),
    fc.uint8Array({ minLength: 1, maxLength: 64 }).map((b) => parseAuditConfig(b)).filter((c) => !c.ok),
  );

  it("blocks every payload when the audit configuration is missing, unreadable, empty, truncated, or lacks canaries, decoys, fingerprints or the allowlist (R2.9)", () => {
    fc.assert(
      fc.property(specArb, configArb, (spec, cfg) => {
        const b = build(spec, cfg);
        const { audit, request } = auditPayload(b.bytes(), spec.kind, cfg, b.ctx);
        expect(audit.result, "a payload passed without a usable audit configuration").toBe("blocked");
        expect(request === undefined, "an AuditedRequest was created").toBe(true);
        expect(audit.checks.find((c) => c.id === "A01")?.outcome).toBe("fail");
        for (const id of ["A05", "A06", "A07"] as const) expect(audit.checks.find((c) => c.id === id)?.outcome).toBe("not_run");
        expect(audit.bytesWithheld && audit.auditedBytes === undefined, "bytes were returned although the sensitive checks did not run").toBe(true);
        expect(audit.payloadSha256).toBe(sha(b.bytes()));
      }),
      FC,
    );
  });

  it("blocks and does not throw when a dependency of a check fails, whichever one it is (an incomplete check blocks, R2.9)", () => {
    const faults: [string, (ctx: AuditContext) => AuditContext][] = [
      ["lookupRecord", (c) => ({ ...c, lookupRecord: () => { throw new Error("x"); } })],
      ["instructionTemplates", (c) => ({ ...c, instructionTemplates: { get: () => { throw new Error("x"); } } as never })],
      ["bundle", (c) => Object.defineProperty({ ...c }, "bundle", { get: () => { throw new Error("x"); } })],
      ["allowlist", (c) => Object.defineProperty({ ...c }, "allowlist", { get: () => { throw new Error("x"); } })],
      ["secretValues", (c) => Object.defineProperty({ ...c }, "secretValues", { get: () => { throw new Error("x"); } })],
      ["limits", (c) => Object.defineProperty({ ...c }, "limits", { get: () => { throw new Error("x"); } })],
    ];
    fc.assert(
      fc.property(specArb, fc.constantFrom(...faults), (spec, [name, f]) => {
        const b = build(spec);
        let out: ReturnType<typeof auditPayload> | undefined;
        expect(() => { out = auditPayload(b.bytes(), spec.kind, b.cfg, f(b.ctx)); }, `auditPayload threw when ${name} failed`).not.toThrow();
        expect(out?.audit.result, `${name} failed but the payload was not blocked`).toBe("blocked");
        expect(out?.request === undefined).toBe(true);
        expect(out?.audit.checks).toHaveLength(9);
        expect(out?.audit.checks.some((c) => c.outcome === "fail"), "no check reports the failure").toBe(true);
        expect(JSON.stringify(out?.audit).includes("Error"), "an exception text reached the result").toBe(false);
      }),
      FC,
    );
  });

  it("blocks and does not throw when the configuration object itself is hostile", () => {
    const hostile = { get ok(): boolean { throw new Error("x"); } } as unknown as AuditConfigLoadResult;
    fc.assert(
      fc.property(specArb, (spec) => {
        const b = build(spec);
        let out: ReturnType<typeof auditPayload> | undefined;
        expect(() => { out = auditPayload(b.bytes(), spec.kind, hostile, b.ctx); }).not.toThrow();
        expect(out?.audit.result).toBe("blocked");
        expect(out?.request === undefined).toBe(true);
      }),
      { ...FC, numRuns: 20 },
    );
  });

  it("never gives a canary-bearing payload a request when the configuration is partially usable (only canaries missing)", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const cfg = without("canaries", "absent");
        const s = structuredClone(spec);
        (s.stored[0] as { content: Json }).content = { note: CANARY_VALUE };
        const b = build(s, cfg);
        const { audit, request } = auditPayload(b.bytes(), s.kind, cfg, b.ctx);
        expect(audit.result === "blocked" && request === undefined).toBe(true);
      }),
      { ...FC, numRuns: 30 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("Property 20: the transmitted bytes are bound to the audited hash", () => {
  const mutationsArb = fc.array(fc.record({ at: fc.nat(1_000_000), value: fc.integer({ min: 0, max: 255 }) }), { minLength: 1, maxLength: 8 });

  it("changing any byte of the input array after the audit never changes what is transmitted: the hash equals the audited hash", async () => {
    await fc.assert(
      fc.asyncProperty(specArb, mutationsArb, async (spec, muts) => {
        const b = build(spec);
        const input = b.bytes();
        const original = input.slice();
        const { audit, request } = auditPayload(input, spec.kind, b.cfg, b.ctx);
        for (const m of muts) input[m.at % input.length] = m.value; // the caller changes its array after the audit
        const { calls, provider } = spy();
        const r = await provider.complete(request as AuditedRequest, live());
        expect(r.ok).toBe(true);
        expect(calls).toHaveLength(1);
        const hashes = [sha(calls[0]?.bytes as Uint8Array), calls[0]?.sha256, request?.sha256, audit.payloadSha256, sha(original)];
        expect(new Set(hashes).size, "the transmitted hash differs from the audited hash").toBe(1);
        expect(Buffer.from(calls[0]?.bytes as Uint8Array).equals(Buffer.from(original))).toBe(true);
      }),
      FC,
    );
  });

  it("changing the copy that `bytes` returns changes nothing held: every read returns the audited bytes", async () => {
    await fc.assert(
      fc.asyncProperty(specArb, mutationsArb, async (spec, muts) => {
        const b = build(spec);
        const { audit, request } = auditPayload(b.bytes(), spec.kind, b.cfg, b.ctx);
        for (const m of muts) {
          const copy = (request as AuditedRequest).bytes;
          copy[m.at % copy.length] = (copy[m.at % copy.length] as number) ^ 0xff;
        }
        const { calls, provider } = spy();
        expect((await provider.complete(request as AuditedRequest, live())).ok).toBe(true);
        expect(sha(calls[0]?.bytes as Uint8Array)).toBe(audit.payloadSha256);
      }),
      FC,
    );
  });

  it("refuses to send when a byte of the held audited bytes differs from the audited hash (hash_mismatch), and the provider is not called", async () => {
    await fc.assert(
      fc.asyncProperty(specArb, fc.nat(1_000_000), fc.integer({ min: 1, max: 255 }), async (spec, at, flip) => {
        const b = build(spec);
        const original = b.bytes();
        const tampered = original.slice();
        tampered[at % tampered.length] = (tampered[at % tampered.length] as number) ^ flip; // any one byte, any non-zero change
        const req = mintAuditedRequest(spec.kind, tampered, sha(original)); // test only: the situation the guard exists for
        const { calls, provider } = spy();
        const v = violation(await provider.complete(req, live()));
        expect(v?.code, "a request whose bytes do not match the audited hash was sent").toBe("hash_mismatch");
        expect(v?.recomputedSha256).toBe(sha(tampered));
        expect(v?.auditedSha256).toBe(sha(original));
        expect(calls).toHaveLength(0);
      }),
      FC,
    );
  });

  it("never hands an unaudited or used request to the provider, whatever the sequence of calls; every call carries an audited hash", async () => {
    type Op = { op: "fresh" } | { op: "issue" } | { op: "useIssued"; i: number } | { op: "reuse"; i: number } | { op: "forge" } | { op: "spread"; i: number } | { op: "aborted" };
    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.constant({ op: "fresh" as const }),
      fc.constant({ op: "issue" as const }),
      fc.record({ op: fc.constant("useIssued" as const), i: fc.nat(20) }),
      fc.record({ op: fc.constant("reuse" as const), i: fc.nat(20) }),
      fc.constant({ op: "forge" as const }),
      fc.record({ op: fc.constant("spread" as const), i: fc.nat(20) }),
      fc.constant({ op: "aborted" as const }),
    );
    await fc.assert(
      fc.asyncProperty(specArb, fc.array(opArb, { maxLength: 14 }), async (spec, ops) => {
        const b = build(spec);
        const bytes = b.bytes();
        const { calls, provider } = spy();
        const issued: { req: AuditedRequest; used: boolean }[] = [];
        const forgedHashes = new Set<string>();
        let expectedCalls = 0;
        const audit = (): AuditedRequest => {
          const r = auditPayload(bytes, spec.kind, b.cfg, b.ctx).request;
          if (r === undefined) throw new Error("fixture payload must pass");
          issued.push({ req: r, used: false });
          return r;
        };
        const use = async (e: { req: AuditedRequest; used: boolean }, signal = new AbortController().signal) => {
          const r = await provider.complete(e.req, { timeoutMs: 1000, signal });
          if (!e.used) {
            expect(r.ok, "a first use of a real audited request was refused").toBe(true);
            e.used = true;
            expectedCalls++;
          } else expect(violation(r)?.code, "a used request was accepted").toBe("already_used");
        };
        let n = 0;
        for (const o of ops) {
          if (o.op === "fresh") { audit(); await use(issued[issued.length - 1] as (typeof issued)[number]); }
          else if (o.op === "issue") audit();
          else if (o.op === "useIssued" && issued.length > 0) await use(issued[o.i % issued.length] as (typeof issued)[number]);
          else if (o.op === "reuse") { const used = issued.filter((e) => e.used); if (used.length > 0) await use(used[o.i % used.length] as (typeof used)[number]); }
          else if (o.op === "forge") {
            const fb = enc(`forged ${n++} ${canonicalJson(b.env as Json)}`);
            forgedHashes.add(sha(fb));
            const r = await provider.complete({ kind: spec.kind, bytes: fb, sha256: sha(fb) } as unknown as AuditedRequest, live());
            expect(violation(r)?.code, "a request with a correct hash but no audit was accepted").toBe("not_audited");
          } else if (o.op === "spread" && issued.length > 0) {
            const e = issued[o.i % issued.length] as (typeof issued)[number];
            const r = await provider.complete({ ...e.req }, live());
            expect(violation(r)?.code, "a copy of an audited request was accepted").toBe("not_audited");
          } else if (o.op === "aborted") {
            const ac = new AbortController();
            ac.abort();
            audit();
            await use(issued[issued.length - 1] as (typeof issued)[number], ac.signal);
          }
        }
        expect(calls.length, "the provider was called a number of times other than the number of first uses of audited requests").toBe(expectedCalls);
        for (const c of calls) {
          expect(c.sha256).toBe(sha(bytes));
          expect(sha(c.bytes)).toBe(sha(bytes));
          expect(forgedHashes.has(sha(c.bytes)), "a forged request reached the provider").toBe(false);
        }
        // a request that was only issued is still unused, and a spread copy did not use it up
        for (const e of issued.filter((x) => !x.used)) expect((await provider.complete(e.req, live())).ok).toBe(true);
      }),
      { ...FC, numRuns: 80 },
    );
  });

  it("a retry needs a new audit: the audit of the same bytes gives a new request whose hash is the same audited hash", async () => {
    await fc.assert(
      fc.asyncProperty(specArb, fc.integer({ min: 1, max: 4 }), async (spec, attempts) => {
        const b = build(spec);
        const bytes = b.bytes();
        const { calls, provider } = spy();
        const seen = new Set<AuditedRequest>();
        for (let i = 0; i < attempts; i++) {
          const { audit, request } = auditPayload(bytes, spec.kind, b.cfg, b.ctx);
          expect(request !== undefined && !seen.has(request)).toBe(true);
          seen.add(request as AuditedRequest);
          expect((await provider.complete(request as AuditedRequest, live())).ok).toBe(true);
          expect(violation(await provider.complete(request as AuditedRequest, live()))?.code).toBe("already_used");
          expect(audit.payloadSha256).toBe(sha(bytes));
        }
        expect(calls).toHaveLength(attempts);
        expect(new Set(calls.map((c) => sha(c.bytes))).size).toBe(1);
      }),
      { ...FC, numRuns: 50 },
    );
  });
});