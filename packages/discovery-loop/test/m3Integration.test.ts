// Task 3.11: the M3 integration test. Payload_Auditor -> Provider Wrapper -> Mock_Provider -> AI response gate, with the real schemas, offline, with synthetic
// data only (R21.4: offline unit tests with the Mock_Provider only). Stop condition of M3: a blocked payload that is transmitted, or an audit result that is
// not recorded, blocks M4; both are checked below.
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_MOCK_FIXTURES, DEFAULT_RESPONSE_LIMITS, PROVIDER_CREDENTIALS, ProviderSelectionError, REQUEST_KINDS, auditPayload, checkProviderCredentials, createProvider,
  gateProviderResult, isAuditViolation, ngramHashes, sha256Hex, tokenize, toInertText,
} from "../../ai-client/src/index.js";
import type { AiProvider, AuditedRequest, CallOutcome, GateAcceptedHypothesis, MockFixture, ProviderFactories, RequestKind, SchemaValidatorPort } from "../../ai-client/src/index.js";
import { MockProvider } from "../../ai-client/src/mock/mockProvider.js";
import { mintAuditedRequest } from "../../ai-client/src/internal/auditedRegistry.js";
import { ALLOWLIST, CANARY_VALUE, DECOY_VALUE, RESTRICTED_PREFIX, RESTRICTED_TEXTS, SECRET_NAME, SECRET_VALUE } from "../../ai-client/test/helpers/auditFixtures.js";
import { build } from "../../ai-client/test/helpers/propertyWorld.js";
import type { PayloadSpec } from "../../ai-client/test/helpers/propertyWorld.js";
import { createSchemaValidator } from "../src/schema/index.js";

const validator = createSchemaValidator() as unknown as SchemaValidatorPort;
const L = DEFAULT_RESPONSE_LIMITS;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
const live = () => ({ timeoutMs: 1000, signal: new AbortController().signal });
const fixtureOf = (kind: RequestKind): Uint8Array => (DEFAULT_MOCK_FIXTURES.find((f) => f.requestKind === kind) as MockFixture).response;
const HYP = JSON.parse(dec(fixtureOf("hypothesis_generation")));
const KINDS: readonly RequestKind[] = REQUEST_KINDS;

const specOf = (kind: RequestKind, content: unknown = { note: "fictional" }): PayloadSpec => ({
  kind,
  sources: [{ path: "legacy/src/utils.php", text: "<?php\n// fictional\n" }],
  stored: [{ type: "hypothesis_revision", content: content as never }],
});
function audited(kind: RequestKind, content?: unknown) {
  const b = build(specOf(kind, content));
  return { ...auditPayload(b.bytes(), kind, b.cfg, b.ctx), built: b };
}
/** A provider that records the hash of every request that reaches it. */
function counting(inner: AiProvider): { provider: AiProvider; calls: string[] } {
  const calls: string[] = [];
  return { calls, provider: { identity: inner.identity, complete: (req, o) => (calls.push(req.sha256), inner.complete(req, o)) } };
}
/** The pipeline: an audited request goes through the wrapper that createProvider puts around `inner`, then the gate. */
async function pipeline(kind: RequestKind, inner: AiProvider, content?: unknown) {
  const a = audited(kind, content);
  if (a.request === undefined) throw new Error("the payload of the scenario must pass the audit");
  const { calls, provider } = counting(inner);
  const wrapped = createProvider({ provider: "mock" }, { mock: () => provider });
  const result = await wrapped.complete(a.request, live());
  return { a, calls, result, outcome: gateProviderResult(kind, result, L, validator) };
}
const withFixtures = (fixtures: MockFixture[]): AiProvider => new MockProvider(fixtures);
const returning = (kind: RequestKind, bytes: Uint8Array): AiProvider => withFixtures([{ requestKind: kind, response: bytes }]);
const defaultMock = (): AiProvider => new MockProvider(DEFAULT_MOCK_FIXTURES);
const asText = (v: unknown): string => JSON.stringify(v, (_k, x) => (x instanceof Uint8Array ? `[bytes:${x.length}]` : x));
const failed = (o: CallOutcome) => (o.kind === "failed_call" ? o : undefined);

// ---------------------------------------------------------------------------------------------
describe("M3 pipeline: an audited request is served and its response is gated", () => {
  it.each(KINDS)("%s: audit pass, wrapper, Mock_Provider, gate accepts", async (kind) => {
    const { a, calls, outcome } = await pipeline(kind, defaultMock());
    expect(a.audit.result).toBe("pass");
    expect(calls).toEqual([a.audit.payloadSha256]); // exactly one provider call, with the audited hash
    expect(outcome.kind).toBe("accepted");
    if (outcome.kind === "accepted") expect(outcome.result.sha256).toBe(sha256Hex(fixtureOf(kind)));
  });

  it("identical requests get byte-identical responses, from separate audits and separate providers (R3.3, R21.4)", async () => {
    for (const kind of KINDS) {
      const one = await pipeline(kind, defaultMock());
      const two = await pipeline(kind, defaultMock());
      expect(one.a.audit.payloadSha256).toBe(two.a.audit.payloadSha256);
      expect(one.result.ok && two.result.ok && Buffer.from(one.result.value).equals(Buffer.from(two.result.value))).toBe(true);
    }
  });

  it("an accepted Hypothesis carries no authority-like property and no removal report when nothing was removed", async () => {
    const { outcome } = await pipeline("hypothesis_generation", defaultMock());
    if (outcome.kind !== "accepted") throw new Error("accepted expected");
    expect((outcome.result as GateAcceptedHypothesis).discarded).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("M3 pipeline: requests that must not reach the provider (R2.1, R2.3, R3.8)", () => {
  it("an unaudited request is refused as an audit violation; the Mock_Provider is not called", async () => {
    const bytes = enc("an unaudited payload");
    const forged = { kind: "hypothesis_generation", bytes, sha256: sha256Hex(bytes) } as unknown as AuditedRequest;
    const { calls, provider } = counting(defaultMock());
    const r = await createProvider({ provider: "mock" }, { mock: () => provider }).complete(forged, live());
    expect(calls).toEqual([]);
    expect(!r.ok && isAuditViolation(r.error) && r.error.violation.code).toBe("not_audited");
  });

  it("a used request is refused on the second use, also after a failed first call", async () => {
    const a = audited("hypothesis_generation");
    const { calls, provider } = counting(returning("hypothesis_generation", enc("not json")));
    const wrapped = createProvider({ provider: "mock" }, { mock: () => provider });
    const first = gateProviderResult("hypothesis_generation", await wrapped.complete(a.request as AuditedRequest, live()), L, validator);
    expect(first.kind).toBe("failed_call"); // the response was rejected by the gate, so the call counts as failed
    const second = await wrapped.complete(a.request as AuditedRequest, live());
    expect(!second.ok && isAuditViolation(second.error) && second.error.violation.code).toBe("already_used");
    expect(calls).toHaveLength(1);
  });

  it("a request whose held bytes do not match the audited hash is refused", async () => {
    const original = enc("payload of the scenario");
    const req = mintAuditedRequest("hypothesis_generation", original.slice(0, -1), sha256Hex(original)); // test-only construction of the inconsistency
    const { calls, provider } = counting(defaultMock());
    const r = await createProvider({ provider: "mock" }, { mock: () => provider }).complete(req, live());
    expect(!r.ok && isAuditViolation(r.error) && r.error.violation.code).toBe("hash_mismatch");
    expect(calls).toEqual([]);
  });

  it("a retry needs a new audit, and the new request is served", async () => {
    const a = audited("hypothesis_generation");
    const { calls, provider } = counting(defaultMock());
    const wrapped = createProvider({ provider: "mock" }, { mock: () => provider });
    await wrapped.complete(a.request as AuditedRequest, live());
    const again = auditPayload(a.built.bytes(), "hypothesis_generation", a.built.cfg, a.built.ctx).request as AuditedRequest;
    expect(again).not.toBe(a.request);
    expect((await wrapped.complete(again, live())).ok).toBe(true);
    expect(calls).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
describe("M3 stop condition (R21.4): a blocked payload is never transmitted, and every audit result is recorded", () => {
  const cases: [string, unknown, string][] = [
    ["a canary", { note: `see ${CANARY_VALUE}` }, "A06"],
    ["a decoy", { note: DECOY_VALUE }, "A06"],
    ["a fingerprint of restricted content", { note: RESTRICTED_TEXTS[1] }, "A07"],
    ["a credential value", { note: SECRET_VALUE }, "A08"],
    ["a restricted path prefix", { note: `${RESTRICTED_PREFIX}file.json` }, "A05"],
    ["a restricted path prefix, percent-encoded", { note: `${RESTRICTED_PREFIX.slice(0, -1)}%2Ffile.json` }, "A05"],
  ];
  it.each(cases)("%s blocks the payload: no request exists, so no provider can be called, and the result is complete", (_name, content, check) => {
    const a = audited("hypothesis_generation", content);
    expect(a.request).toBeUndefined();
    expect(a.audit.result).toBe("blocked");
    expect(a.audit.checks.find((c) => c.id === check)?.outcome).toBe("fail");
    // recorded: nine checks, the hash of the audited bytes, identifiers of what matched
    expect(a.audit.checks).toHaveLength(9);
    expect(a.audit.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.audit.matches.length > 0).toBe(true);
    // the bytes of such a payload are not kept, and no sensitive value is in the result
    expect(a.audit.bytesWithheld).toBe(true);
    const text = asText(a.audit);
    for (const s of [CANARY_VALUE, DECOY_VALUE, SECRET_VALUE, RESTRICTED_TEXTS[1] as string, RESTRICTED_PREFIX]) expect(text.includes(s), "the audit result holds a sensitive value").toBe(false);
  });

  it("a non-allowlisted path and a Source_Bundle hash mismatch block the payload", () => {
    const b = build({ ...specOf("hypothesis_generation"), sources: [{ path: "legacy/src/other.php", text: "<?php\n// fictional\n" }] });
    const path = auditPayload(b.bytes(), "hypothesis_generation", b.cfg, b.ctx);
    expect(path.request).toBeUndefined();
    expect(path.audit.checks.find((c) => c.id === "A05")?.outcome).toBe("fail");
    const m = build(specOf("hypothesis_generation"));
    m.env["parts"][0].text = "<?php\n// altered\n";
    const mismatch = auditPayload(m.bytes(), "hypothesis_generation", m.cfg, m.ctx);
    expect(mismatch.request).toBeUndefined();
    expect(mismatch.audit.checks.find((c) => c.id === "A04")?.outcome).toBe("fail");
    expect(ALLOWLIST).not.toContain("legacy/src/other.php");
  });

  it("an audit that cannot be completed is blocked (fail closed): missing configuration, a failing dependency, a hostile context, non-byte input", () => {
    const b = build(specOf("hypothesis_generation"));
    const bytes = b.bytes();
    const hostile = Object.defineProperty({ ...b.ctx }, "secretValues", { get: () => { throw new Error("boom"); } });
    const results = [
      auditPayload(bytes, "hypothesis_generation", { ok: false, reason: "missing" }, b.ctx),
      auditPayload(bytes, "hypothesis_generation", { ok: false, reason: "unreadable" }, b.ctx),
      auditPayload(bytes, "hypothesis_generation", b.cfg, { ...b.ctx, lookupRecord: () => { throw new Error("boom"); } }),
      auditPayload(bytes, "hypothesis_generation", b.cfg, hostile),
      auditPayload("not bytes" as never, "hypothesis_generation", b.cfg, b.ctx),
      auditPayload(new Uint8Array(new SharedArrayBuffer(8)), "hypothesis_generation", b.cfg, b.ctx),
    ];
    for (const r of results) {
      expect(r.request).toBeUndefined();
      expect(r.audit.result).toBe("blocked");
      expect(r.audit.checks).toHaveLength(9);
    }
  });

  it("every blocked payload is blocked for the same reason through a clean run of the whole pipeline: nothing is transmitted", async () => {
    const { calls, provider } = counting(defaultMock());
    const wrapped = createProvider({ provider: "mock" }, { mock: () => provider });
    for (const [, content] of cases) {
      const a = audited("hypothesis_generation", content);
      if (a.request !== undefined) await wrapped.complete(a.request, live());
    }
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("M3 pipeline: three different outcomes are kept apart (R3.8, R17.9)", () => {
  it("a provider failure, a rejected response and an audit violation have three different outcomes", async () => {
    const providerFail: AiProvider = { identity: { id: "x", version: "0", model: "not_applicable" }, complete: async () => ({ ok: false, error: { reason: "timeout", detail: "d" } }) };
    const p = await pipeline("hypothesis_generation", providerFail);
    expect(p.outcome).toMatchObject({ kind: "failed_call", reason: "timeout", source: "provider", retryable: true });
    const g = await pipeline("hypothesis_generation", returning("hypothesis_generation", enc("{")));
    expect(g.outcome).toMatchObject({ kind: "failed_call", reason: "unparseable", source: "gate", retryable: true });
    const bytes = enc("x");
    const forged = { kind: "hypothesis_generation", bytes, sha256: sha256Hex(bytes) } as unknown as AuditedRequest;
    const v = gateProviderResult("hypothesis_generation", await createProvider({ provider: "mock" }, { mock: () => defaultMock() }).complete(forged, live()), L, validator);
    expect(v).toMatchObject({ kind: "audit_violation", retryable: false, stopRun: true });
    expect("reason" in v && v.reason !== undefined).toBe(false); // an audit violation has no failure class of R3.8
  });

  it("an unmatched request is a failed call of the provider, and the Mock_Provider does not make up an answer (R3.12)", async () => {
    const partial = withFixtures([{ requestKind: "hypothesis_generation", response: fixtureOf("hypothesis_generation") }]);
    const r = await pipeline("experiment_generation", partial);
    expect(r.result.ok).toBe(false);
    expect(!r.result.ok && r.result.error.reason).toBe("unmatched_request");
    expect(r.outcome).toMatchObject({ kind: "failed_call", source: "provider", providerReason: "unmatched_request" });
    expect(r.outcome.kind === "accepted").toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe("M3 pipeline: responses of the provider are untrusted (R17)", () => {
  const MARK = "RESPONSE-MARK-8812";
  const hyp = (mutate: (t: any) => void): Uint8Array => {
    const t = structuredClone(HYP);
    mutate(t);
    return enc(JSON.stringify(t));
  };

  it("a response that is rejected as a whole passes no data on, no text of the response, and counts as one failed call", async () => {
    const bad: [string, Uint8Array][] = [
      ["malformed", enc(`{"claims":[${MARK}`)],
      ["undefined field", hyp((t) => (t.notes = MARK))],
      ["tool call", hyp((t) => (t.tool_calls = [{ name: MARK }]))],
      ["nested authority name", hyp((t) => (t.claims[0].condition.origin = MARK))],
      ["hypothesis top authority name", hyp((t) => (t.approval = MARK))],
      ["not an object", enc(`["${MARK}"]`)],
      ["duplicate key named by the response", enc(`{"claims":[],"k-${MARK}":1,"k-${MARK}":2}`)],
      ["undefined field named by the response", enc(`{"claims":[],"k-${MARK}":1}`)],
    ];
    for (const [name, bytes] of bad) {
      const { outcome } = await pipeline("hypothesis_generation", returning("hypothesis_generation", bytes));
      const f = failed(outcome);
      expect(f, name).toMatchObject({ kind: "failed_call", reason: "unparseable", retryable: true, source: "gate" });
      expect("result" in outcome, `${name}: a rejection carries data`).toBe(false);
      expect(asText(outcome).includes(MARK), `${name}: text of the response was carried on`).toBe(false);
      expect(f?.gate?.failedCall).toBe(true);
    }
    const tool = await pipeline("hypothesis_generation", returning("hypothesis_generation", hyp((t) => (t.tool_calls = []))));
    expect(failed(tool.outcome)?.toolCall).toBe(true);
  });

  it("authority-like properties are removed at the top level of a Claim only, and the rest is accepted", async () => {
    const bytes = hyp((t) => Object.assign(t.claims[0], { origin: "human-authored", approval: "approved", evidence_status: "supported", evidence: [MARK] }));
    const { outcome } = await pipeline("hypothesis_generation", returning("hypothesis_generation", bytes));
    if (outcome.kind !== "accepted") throw new Error("accepted expected");
    const res = outcome.result as GateAcceptedHypothesis;
    expect(res.proposal).toEqual(HYP);
    expect(res.discarded.map((d) => d.name).sort()).toEqual(["approval", "evidence", "evidence_status", "origin"]);
    expect(asText(res.discarded).includes(MARK)).toBe(false);
    // the same names one level down are undefined fields
    const nested = await pipeline("hypothesis_generation", returning("hypothesis_generation", hyp((t) => (t.claims[0].effect.approval = "x"))));
    expect(failed(nested.outcome)).toMatchObject({ reason: "unparseable" });
  });

  it("an ordinary undefined field rejects the whole response, also when authority-like names are removed beside it", async () => {
    const bytes = hyp((t) => Object.assign(t.claims[0], { origin: "x", notes: MARK }));
    const { outcome } = await pipeline("hypothesis_generation", returning("hypothesis_generation", bytes));
    expect(failed(outcome)?.gate?.reason).toBe("undefined_field");
    expect("discarded" in (failed(outcome)?.gate ?? {})).toBe(false);
  });

  it("an Experiment that fails the schema alone is dropped and the others are kept; an undefined field in one rejects the whole response", async () => {
    const e0 = JSON.parse(dec(fixtureOf("experiment_generation"))).experiments[0];
    const bad = { ...structuredClone(e0), localKey: "bad_one" };
    delete bad.prediction;
    const mixed = enc(JSON.stringify({ experiments: [e0, bad, { ...structuredClone(e0), localKey: "second" }] }));
    const ok = await pipeline("experiment_generation", returning("experiment_generation", mixed));
    expect(ok.outcome.kind).toBe("accepted");
    if (ok.outcome.kind === "accepted" && ok.outcome.result.kind === "experiment_generation") {
      expect(ok.outcome.result.experiments).toHaveLength(2);
      expect(ok.outcome.result.rejectedExperiments.map((x) => x.index)).toEqual([1]);
    }
    const whole = enc(JSON.stringify({ experiments: [e0, { ...structuredClone(e0), localKey: "other", shell: MARK }] }));
    const rej = await pipeline("experiment_generation", returning("experiment_generation", whole));
    expect(failed(rej.outcome)).toMatchObject({ reason: "unparseable", source: "gate" });
    expect(asText(rej.outcome).includes(MARK)).toBe(false);
    // every Experiment rejected on its own: the response is still valid and is not a failed call
    const none = enc(JSON.stringify({ experiments: [bad, { ...structuredClone(bad), localKey: "b2" }] }));
    expect((await pipeline("experiment_generation", returning("experiment_generation", none))).outcome.kind).toBe("accepted");
  });
});

// ---------------------------------------------------------------------------------------------
describe("hostile Mock_Provider responses: rejected, or stored as inert data, with no effect (R17.10)", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    vi.restoreAllMocks();
  });
  const hyp = (mutate: (t: any) => void): Uint8Array => {
    const t = structuredClone(HYP);
    mutate(t);
    return enc(JSON.stringify(t));
  };

  function hostile(sentinel: string): [string, Uint8Array, "reject" | "inert", string?][] {
    const text = JSON.stringify(HYP);
    return [
      ["oversized", enc(text + " ".repeat(L.maxResponseBytes)), "reject", "size_exceeded"],
      ["over-count", hyp((t) => (t.claims = Array.from({ length: 51 }, (_x, i) => ({ ...structuredClone(HYP.claims[0]), localKey: `c${i}` })))), "reject", "count_exceeded"],
      ["malformed", enc(text.slice(0, -7)), "reject", "invalid_json"],
      ["duplicate key", enc(text.replace('"claims"', '"claims":[],"claims"')), "reject", "duplicate_key"],
      ["deeply nested", enc(`{"claims":${"[".repeat(40)}${"]".repeat(40)}}`), "reject", "depth_exceeded"],
      ["undefined field", hyp((t) => (t.exec = `touch ${sentinel}`)), "reject", "undefined_field"],
      ["command string", hyp((t) => (t.claims[0].condition.description = `rm -rf / ; touch ${sentinel} ; $(touch ${sentinel}) ; process.exit(1)`)), "inert"],
      ["path traversal string", hyp((t) => (t.claims[0].effect.description = `../../../../etc/passwd ${sentinel}`)), "inert"],
      ["markup", hyp((t) => (t.claims[0].openQuestions = ['<script>fetch("http://example.invalid/x")</script>', "<img src=x onerror=alert(1)>"])), "inert"],
    ];
  }

  it("each response is rejected whole or kept as data; nothing was executed, written, opened or sent", async () => {
    dir = mkdtempSync(join(tmpdir(), "m3-hostile-"));
    const sentinel = join(dir, "pwned");
    writeFileSync(join(dir, "kept.txt"), "unchanged");
    const envBefore = JSON.stringify(Object.entries(process.env).sort());
    const cwdBefore = process.cwd();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
    const connectSpy = vi.spyOn(net.Socket.prototype, "connect");
    for (const [name, bytes, expectation, reason] of hostile(sentinel)) {
      const { outcome } = await pipeline("hypothesis_generation", returning("hypothesis_generation", bytes));
      if (expectation === "reject") {
        expect(failed(outcome), name).toMatchObject({ reason: "unparseable", source: "gate", retryable: true });
        expect(failed(outcome)?.gate?.reason, name).toBe(reason);
      } else {
        expect(outcome.kind, name).toBe("accepted");
        if (outcome.kind === "accepted") {
          const shown = toInertText(JSON.stringify((outcome.result as GateAcceptedHypothesis).proposal));
          expect(shown.includes("<script>") || shown.includes("<img"), `${name}: markup is not escaped`).toBe(false);
        }
      }
    }
    expect(existsSync(sentinel), "a command of a response was executed").toBe(false);
    expect(readdirSync(dir)).toEqual(["kept.txt"]);
    expect(readFileSync(join(dir, "kept.txt"), "utf8")).toBe("unchanged");
    expect(JSON.stringify(Object.entries(process.env).sort())).toBe(envBefore);
    expect(process.cwd()).toBe(cwdBefore);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(connectSpy).not.toHaveBeenCalled(); // no connection, so no effect on the Legacy_App
  });

  it("the hostile text is data: the same strings are in the accepted proposal, unchanged, and display escapes them", async () => {
    const bytes = hyp((t) => (t.claims[0].condition.description = "<b>bold</b> && `whoami` ../../x"));
    const { outcome } = await pipeline("hypothesis_generation", returning("hypothesis_generation", bytes));
    if (outcome.kind !== "accepted") throw new Error("accepted expected");
    expect(JSON.stringify((outcome.result as GateAcceptedHypothesis).proposal)).toContain("../../x");
    expect(toInertText("<b>bold</b> && `whoami`")).toBe("&lt;b&gt;bold&lt;/b&gt; &amp;&amp; &#96;whoami&#96;");
  });
});

// ---------------------------------------------------------------------------------------------
describe("the provider is switched by configuration only, with no fallback (R3.1)", () => {
  it("the same caller code serves two implementations by one configuration value", async () => {
    const stub: AiProvider = { identity: { id: "kiro-stub", version: "9", model: "stub-model" }, complete: async () => ({ ok: true, value: fixtureOf("hypothesis_generation") }) };
    const factories: ProviderFactories = { mock: () => defaultMock(), "kiro-cli": () => stub };
    const callerCode = async (cfg: { provider: "mock" | "replay" | "kiro-cli" }) => {
      const provider = createProvider(cfg, factories);
      const a = audited("hypothesis_generation");
      return { id: provider.identity.id, outcome: gateProviderResult("hypothesis_generation", await provider.complete(a.request as AuditedRequest, live()), L, validator) };
    };
    const mock = await callerCode({ provider: "mock" });
    const real = await callerCode({ provider: "kiro-cli" });
    expect([mock.id, real.id]).toEqual(["mock", "kiro-stub"]);
    expect([mock.outcome.kind, real.outcome.kind]).toEqual(["accepted", "accepted"]);
  });

  it("a provider without an implementation fails closed and never becomes the Mock_Provider; the default has the mock only", () => {
    for (const name of ["replay", "kiro-cli"] as const) {
      expect(() => createProvider({ provider: name })).toThrowError(ProviderSelectionError);
    }
    expect(createProvider({ provider: "mock" }).identity.id).toBe("mock");
    expect(() => createProvider({ provider: "other" as never })).toThrowError(ProviderSelectionError);
    expect(() => createProvider({ provider: "mock", mockFixtureSet: "nope" })).toThrowError(ProviderSelectionError);
  });
});

// ---------------------------------------------------------------------------------------------
describe("Mock_Provider fixtures (R3.10, R3.11, R3.13): the three kinds exist, hold no canary, and the module imports nothing of the evaluation directory", () => {
  it("has a response for each of the three request kinds, and each passes the gate with the real schemas", () => {
    for (const kind of KINDS) {
      const f = DEFAULT_MOCK_FIXTURES.filter((x) => x.requestKind === kind);
      expect(f.length, kind).toBeGreaterThanOrEqual(1);
      expect(gateProviderResult(kind, { ok: true, value: (f[0] as MockFixture).response }, L, validator).kind, kind).toBe("accepted");
    }
  });

  const srcDir = join(import.meta.dirname, "..", "..", "ai-client", "src", "mock");
  /** Files that refer to the evaluation directory by a path in a string, or import it. */
  const code = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1"); // comments may talk about the directory; code may not name it
  const evaluationRefs = (files: { path: string; text: string }[]): string[] =>
    files.filter((f) => /["'`][^"'`\n]*\bevaluation[\\/]/.test(code(f.text)) || /from\s+["'][^"']*evaluation/.test(code(f.text))).map((f) => f.path);
  /** Fixture texts that contain one of the given values, or a window of the given restricted texts. */
  const holdsSecret = (texts: string[], values: string[], restricted: string[]): boolean => {
    const windows = new Set(restricted.flatMap((t) => [...ngramHashes(tokenize(t), 6)]));
    return texts.some((t) => values.some((v) => t.toLowerCase().includes(v.toLowerCase())) || [...ngramHashes(tokenize(t), 6)].some((h) => windows.has(h)));
  };

  it("no fixture contains a canary, a decoy, a credential value, or a window of restricted text", () => {
    const texts = DEFAULT_MOCK_FIXTURES.map((f) => dec(f.response));
    expect(holdsSecret(texts, [CANARY_VALUE, DECOY_VALUE, SECRET_VALUE], RESTRICTED_TEXTS)).toBe(false);
    // positive control: the same check finds a planted fixture
    expect(holdsSecret([...texts, `note ${CANARY_VALUE}`], [CANARY_VALUE], RESTRICTED_TEXTS)).toBe(true);
    expect(holdsSecret([...texts, RESTRICTED_TEXTS[2] as string], [CANARY_VALUE], RESTRICTED_TEXTS)).toBe(true);
  });

  it("the Mock_Provider module and its fixtures name no path of the evaluation directory and import nothing outside the package (static check, with a positive control)", () => {
    const files = ["mockProvider.ts", "defaultFixtures.ts"].map((n) => ({ path: n, text: readFileSync(join(srcDir, n), "utf8") }));
    expect(evaluationRefs(files)).toEqual([]);
    for (const f of files) {
      for (const m of f.text.matchAll(/^import\s+(?:type\s+)?[^"']*from\s+["']([^"']+)["']/gm)) expect(m[1]?.startsWith("../") || m[1]?.startsWith("./"), `${f.path} imports ${m[1]}`).toBe(true);
      expect(f.text).not.toMatch(/\bfrom\s+["']node:(fs|path|child_process|net|http|https|os)/);
    }
    const planted = [...files, { path: "planted.ts", text: 'import { x } from "../../evaluation/ground-truth/ground-truth.json";' }, { path: "planted2.ts", text: 'const p = "evaluation/results/x";' }];
    expect(evaluationRefs(planted)).toEqual(["planted.ts", "planted2.ts"]);
  });
});

// ---------------------------------------------------------------------------------------------
describe("credentials (R19.1, R19.6, R19.9, R19.10)", () => {
  it("a Run with the Mock_Provider needs no credential: the check passes with an empty environment and the pipeline runs", async () => {
    expect(PROVIDER_CREDENTIALS.mock).toEqual([]);
    const before = { ...process.env };
    delete process.env["KIRO_API_KEY"];
    try {
      expect(checkProviderCredentials("mock", process.env)).toEqual({ ok: true, referenced: [] });
      const { outcome } = await pipeline("hypothesis_generation", defaultMock());
      expect(outcome.kind).toBe("accepted");
    } finally {
      process.env = before;
    }
  });

  it("a real provider with an unset variable refuses the Run naming the variable, and no provider is built or called", () => {
    const built: string[] = [];
    const factories: ProviderFactories = { "kiro-cli": () => (built.push("kiro-cli"), defaultMock()) };
    const start = (provider: "mock" | "kiro-cli", env: Record<string, string | undefined>) => {
      const c = checkProviderCredentials(provider, env);
      if (!c.ok) return { refused: c.error };
      return { provider: createProvider({ provider } as never, provider === "kiro-cli" ? factories : undefined) };
    };
    const r = start("kiro-cli", { KIRO_API_KEY: "" });
    expect(r).toEqual({ refused: { code: "credential_unset", variable: "KIRO_API_KEY" } });
    expect(built).toEqual([]);
    expect("provider" in start("kiro-cli", { KIRO_API_KEY: "synthetic-credential-value" })).toBe(true);
  });

  it("a canary secret set in the environment is in none of the audit results, outcomes, errors or reports of a run; a payload that carries it is blocked by variable name", async () => {
    const SECRET = "SYNTHETIC-ENV-CANARY-77aa31";
    const env: Record<string, string | undefined> = { [SECRET_NAME]: SECRET };
    const artifacts: unknown[] = [];
    const clean = build(specOf("hypothesis_generation"));
    const ctx = { ...clean.ctx, secretValues: [{ name: SECRET_NAME, value: env[SECRET_NAME] as string }] };
    for (const kind of KINDS) {
      const b = build(specOf(kind));
      const a = auditPayload(b.bytes(), kind, b.cfg, { ...ctx });
      expect(a.audit.result).toBe("pass");
      artifacts.push(a.audit);
      const wrapped = createProvider({ provider: "mock" });
      const r = await wrapped.complete(a.request as AuditedRequest, live());
      artifacts.push(r, gateProviderResult(kind, r, L, validator));
    }
    const bad = build(specOf("hypothesis_generation", { note: `token ${SECRET}` }));
    const blocked = auditPayload(bad.bytes(), "hypothesis_generation", bad.cfg, { ...bad.ctx, secretValues: ctx.secretValues });
    expect(blocked.request).toBeUndefined();
    expect(blocked.audit.matches).toEqual([{ checkId: "A08", matchId: SECRET_NAME }]);
    artifacts.push(blocked.audit, checkProviderCredentials("kiro-cli", env), checkProviderCredentials("mock", env));
    // an error record of a refused Run
    artifacts.push(checkProviderCredentials("kiro-cli", { KIRO_API_KEY: "" }));
    const all = artifacts.map(asText).join("\n");
    expect(all.includes(SECRET), "the secret is in a run artifact, a log or an error").toBe(false);
    // positive control: the same scan finds a deliberately written secret
    expect([...artifacts, { leaked: SECRET }].map(asText).join("\n").includes(SECRET)).toBe(true);
  });
});