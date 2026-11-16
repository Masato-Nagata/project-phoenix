// Feature: discovery-loop, Property 21: Untrusted AI responses are gated whole
// **Validates: Requirements 4.2, 4.3, 4.8, 7.2, 7.4, 7.7, 17.1, 17.3, 17.4, 17.5, 17.6, 17.9**
// Fixed seed and bounded run count, so a failure can be reproduced. The gate is the one of `packages/ai-client`; the validator is the real one of
// this package (real schemas). Synthetic data only. Generated values are descriptors and neutral words; every response carries a unique marker
// string, and a rejection must never contain it. Assertions compare codes, counts and booleans, never response text.
//
// Decided readings used here: an undefined field anywhere rejects the whole response; any other schema failure of an Experiment rejects that Experiment
// only; a failure outside the Experiments (the envelope, a Hypothesis) rejects the whole response; a configured limit above a fixed bound of the
// schema does not raise the effective limit. Authority-like names at the top level of a Claim are task 3.10 and are not generated here.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOCK_FIXTURES, DEFAULT_RESPONSE_LIMITS, gateProviderResult, gateResponse, resolveResponseLimits, sha256Hex,
} from "../../ai-client/src/index.js";
import type { GateRejection, Json, ProviderError, RequestKind, ResponseLimits, Result, SchemaValidatorPort } from "../../ai-client/src/index.js";
import { createSchemaValidator } from "../src/schema/index.js";

const FC = { seed: 21_001_001, numRuns: 100 };
const real = createSchemaValidator() as unknown as SchemaValidatorPort;
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const L = DEFAULT_RESPONSE_LIMITS;
const limitsOf = (o: Partial<ResponseLimits>): ResponseLimits => {
  const r = resolveResponseLimits(o);
  if (!r.ok) throw new Error(`bad limits ${r.error.name}`);
  return r.value;
};
/** The real validator, with a count of the calls: a response that fails before the schema stage must not reach it. */
function spied(): SchemaValidatorPort & { calls: number } {
  const s = { calls: 0, validate: (n: string, v: unknown) => { s.calls++; return real.validate(n, v); } };
  return s;
}
const fixture = (kind: RequestKind): any => JSON.parse(new TextDecoder().decode((DEFAULT_MOCK_FIXTURES.find((f) => f.requestKind === kind) as { response: Uint8Array }).response));
const HYP = fixture("hypothesis_generation");
const EXP = fixture("experiment_generation");

// ---- generators of valid responses ----
const word = fc.stringMatching(/^[a-z]{3,8}$/);
const textArb = fc.array(word, { minLength: 1, maxLength: 6 }).map((w) => w.join(" "));
const markerArb = fc.stringMatching(/^[0-9a-f]{12}$/).map((h) => `mk${h}`);
const fmtArb = fc.constantFrom<null | 2 | "\t">(null, 2, "\t");
interface HypSpec { claims: number; citations: number; questions: number; text: string; conf: string; withDerived: boolean; fmt: null | 2 | "\t"; marker: string }
interface ExpSpec { count: number; requests: number; body: boolean; text: string; fmt: null | 2 | "\t"; marker: string }
const hypSpecArb: fc.Arbitrary<HypSpec> = fc.record({
  claims: fc.integer({ min: 1, max: 8 }), citations: fc.integer({ min: 1, max: 5 }), questions: fc.integer({ min: 0, max: 3 }), text: textArb,
  conf: fc.constantFrom("low", "medium", "high"), withDerived: fc.boolean(), fmt: fmtArb, marker: markerArb,
});
const expSpecArb: fc.Arbitrary<ExpSpec> = fc.record({
  count: fc.integer({ min: 1, max: 10 }), requests: fc.integer({ min: 1, max: 10 }), body: fc.boolean(), text: textArb, fmt: fmtArb, marker: markerArb,
});
function buildHyp(s: Pick<HypSpec, "claims" | "citations" | "questions" | "text" | "conf" | "withDerived" | "marker">): any {
  const claims = Array.from({ length: s.claims }, (_x, i) => ({
    ...structuredClone(HYP.claims[0]),
    localKey: `c${i + 1}`,
    condition: { ...structuredClone(HYP.claims[0].condition), description: `${s.text} ${s.marker}` },
    confidence: s.conf,
    openQuestions: Array.from({ length: s.questions }, (_y, j) => `${s.text} ${j}`),
    citations: Array.from({ length: s.citations }, (_y, j) => ({ file: "legacy/src/utils.php", startLine: 1, endLine: 1, quote: `q${j}` })),
  }));
  return { ...(s.withDerived ? { derived: structuredClone(HYP.derived), tables: structuredClone(HYP.tables) } : {}), claims };
}
const reqOf = (s: Pick<ExpSpec, "body" | "text" | "marker">, bodyBytes?: number): any =>
  bodyBytes !== undefined ? { method: "POST", path: "/orders", body: { d: "x".repeat(bodyBytes - 8) } }
  : s.body ? { method: "POST", path: "/orders", body: { note: `${s.text} ${s.marker}` } } : { method: "GET", path: "/orders" };
function buildExp(s: Pick<ExpSpec, "count" | "requests" | "body" | "text" | "marker">): any {
  return { experiments: Array.from({ length: s.count }, (_x, i) => ({ ...structuredClone(EXP.experiments[0]), localKey: `e${i + 1}`, requests: Array.from({ length: s.requests }, () => reqOf(s)) })) };
}
const toBytes = (tree: unknown, fmt: null | 2 | "\t" = null): Uint8Array => enc(JSON.stringify(tree, null, fmt ?? undefined));
const rejected = (r: ReturnType<typeof gateResponse>): GateRejection => {
  if (r.ok) throw new Error("the response was accepted");
  return r;
};
/** A rejection holds no text and no data of the response, and says it is one failed call. */
function expectCleanRejection(r: GateRejection, bytes: Uint8Array, markers: string[]): void {
  const text = JSON.stringify(r);
  for (const m of markers) expect(text.includes(m), "a rejection contains text of the response").toBe(false);
  expect("proposal" in r || "experiments" in r || "value" in r || "rejectedExperiments" in r, "a rejection carries data").toBe(false);
  expect(r.failedCall).toBe(true);
  expect(r.sha256).toBe(sha256Hex(bytes));
  expect(r.byteLength).toBe(bytes.length);
  for (const i of r.issues) expect(/^(\/[A-Za-z0-9_<>]*)*$/.test(i.path.replaceAll("...", "")), i.path).toBe(true);
}

// ---------------------------------------------------------------------------------------------
describe("Property 21: valid responses are accepted, with the parse strict and the exact bytes identified", () => {
  it("accepts a valid Hypothesis in any formatting, and identifies the exact received bytes by SHA-256 and size", () => {
    fc.assert(
      fc.property(hypSpecArb, fc.constantFrom<RequestKind>("hypothesis_generation", "hypothesis_revision"), (s, kind) => {
        const tree = buildHyp(s);
        const bytes = toBytes(tree, s.fmt);
        const v = spied();
        const r = gateResponse(kind, bytes, L, v);
        expect(r.ok, "a valid Hypothesis was rejected").toBe(true);
        if (!r.ok || r.kind === "experiment_generation") return;
        expect(r.proposal).toEqual(tree); // the parse gives exactly what was written
        expect(r.sha256).toBe(sha256Hex(bytes));
        expect(r.byteLength).toBe(bytes.length);
        expect(v.calls).toBe(1);
      }),
      FC,
    );
  });

  it("accepts a valid Experiment response in any formatting, keeps every Experiment in order, and identifies the exact bytes", () => {
    fc.assert(
      fc.property(expSpecArb, (s) => {
        const tree = buildExp(s);
        const bytes = toBytes(tree, s.fmt);
        const r = gateResponse("experiment_generation", bytes, L, real);
        expect(r.ok, "a valid Experiment response was rejected").toBe(true);
        if (!r.ok || r.kind !== "experiment_generation") return;
        expect(r.experiments).toEqual(tree.experiments);
        expect(r.rejectedExperiments).toEqual([]);
        expect(r.sha256).toBe(sha256Hex(bytes));
      }),
      FC,
    );
  });

  it("the accepted data does not change with what is later done to the input array, and the hash is of the bytes as received", () => {
    fc.assert(
      fc.property(hypSpecArb, (s) => {
        const bytes = toBytes(buildHyp(s), s.fmt);
        const before = sha256Hex(bytes);
        const r = gateResponse("hypothesis_generation", bytes, L, real);
        bytes.fill(0);
        expect(r.ok && r.sha256 === before).toBe(true);
      }),
      { ...FC, numRuns: 40 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("Property 21: size limit (R17.3)", () => {
  it("accepts a response of exactly the limit and rejects one byte more without parsing it", () => {
    fc.assert(
      fc.property(hypSpecArb, fc.nat(40), (s, extra) => {
        const base = toBytes(buildHyp(s));
        const lim = base.length + extra;
        const padded = (n: number): Uint8Array => { const b = new Uint8Array(n).fill(0x20); b.set(base); return b; };
        const limits = limitsOf({ maxResponseBytes: lim });
        const atLimit = gateResponse("hypothesis_generation", padded(lim), limits, real);
        expect(atLimit.ok, "a response of exactly the limit was rejected").toBe(true);
        const v = spied();
        const over = rejected(gateResponse("hypothesis_generation", padded(lim + 1), limits, v));
        expect(over.reason).toBe("size_exceeded");
        expect(over.limit).toEqual({ name: "maxResponseBytes", limit: lim, observed: lim + 1 });
        expect(v.calls, "an oversized response was parsed or validated").toBe(0);
        expectCleanRejection(over, padded(lim + 1), [s.marker]);
      }),
      FC,
    );
  });

  it("rejects any oversized content, valid or not, by size alone", () => {
    fc.assert(
      fc.property(fc.nat(200), fc.uint8Array({ minLength: 1, maxLength: 64 }), (extra, noise) => {
        const lim = 100 + extra;
        const big = new Uint8Array(lim + 1);
        big.set(noise.slice(0, lim + 1));
        const r = rejected(gateResponse("experiment_generation", big, limitsOf({ maxResponseBytes: lim }), real));
        expect(r.reason).toBe("size_exceeded");
      }),
      FC,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("Property 21: count limits (R17.2, R17.4) reject the whole response, naming the limit", () => {
  it("claims: exactly the limit is accepted, one more is rejected before the schema", () => {
    fc.assert(
      fc.property(hypSpecArb, fc.integer({ min: 1, max: 10 }), (s, k) => {
        const limits = limitsOf({ maxClaims: k });
        expect(gateResponse("hypothesis_generation", toBytes(buildHyp({ ...s, claims: k })), limits, real).ok).toBe(true);
        const v = spied();
        const bytes = toBytes(buildHyp({ ...s, claims: k + 1 }));
        const r = rejected(gateResponse("hypothesis_generation", bytes, limits, v));
        expect([r.reason, r.limit]).toEqual(["count_exceeded", { name: "maxClaims", limit: k, observed: k + 1 }]);
        expect(v.calls).toBe(0);
        expectCleanRejection(r, bytes, [s.marker]);
      }),
      FC,
    );
  });

  it("citations per claim", () => {
    fc.assert(
      fc.property(hypSpecArb, fc.integer({ min: 1, max: 4 }), (s, k) => {
        const limits = limitsOf({ maxCitationsPerClaim: k });
        expect(gateResponse("hypothesis_revision", toBytes(buildHyp({ ...s, citations: k })), limits, real).ok).toBe(true);
        const r = rejected(gateResponse("hypothesis_revision", toBytes(buildHyp({ ...s, citations: k + 1 })), limits, real));
        expect([r.reason, r.limit]).toEqual(["count_exceeded", { name: "maxCitationsPerClaim", limit: k, observed: k + 1 }]);
      }),
      FC,
    );
  });

  it("Experiments per response, and requests per Experiment", () => {
    fc.assert(
      fc.property(expSpecArb, fc.integer({ min: 1, max: 9 }), (s, k) => {
        const byCount = limitsOf({ maxExperiments: k });
        expect(gateResponse("experiment_generation", toBytes(buildExp({ ...s, count: k })), byCount, real).ok).toBe(true);
        const a = rejected(gateResponse("experiment_generation", toBytes(buildExp({ ...s, count: k + 1 })), byCount, real));
        expect([a.reason, a.limit]).toEqual(["count_exceeded", { name: "maxExperiments", limit: k, observed: k + 1 }]);
        const byRequests = limitsOf({ maxRequestsPerExperiment: k });
        expect(gateResponse("experiment_generation", toBytes(buildExp({ ...s, count: 2, requests: k })), byRequests, real).ok).toBe(true);
        const b = rejected(gateResponse("experiment_generation", toBytes(buildExp({ ...s, count: 2, requests: k + 1 })), byRequests, real));
        expect([b.reason, b.limit]).toEqual(["count_exceeded", { name: "maxRequestsPerExperiment", limit: k, observed: k + 1 }]);
      }),
      FC,
    );
  });

  it("the bytes of a request body: exactly the limit is accepted, one more is rejected (also in a state check)", () => {
    fc.assert(
      fc.property(expSpecArb, fc.integer({ min: 20, max: 400 }), fc.boolean(), (s, k, inStateCheck) => {
        const limits = limitsOf({ maxRequestBodyBytes: k });
        const make = (n: number): any => {
          const t = buildExp({ ...s, body: false, count: 1, requests: 1 }); // the other request has no body, so only the tested one can exceed the limit
          if (inStateCheck) t.experiments[0].stateChecks = [reqOf(s, n)];
          else t.experiments[0].requests = [reqOf(s, n)];
          return t;
        };
        expect(gateResponse("experiment_generation", toBytes(make(k)), limits, real).ok, "a body of exactly the limit was rejected").toBe(true);
        const r = rejected(gateResponse("experiment_generation", toBytes(make(k + 1)), limits, real));
        expect([r.reason, r.limit]).toEqual(["count_exceeded", { name: "maxRequestBodyBytes", limit: k, observed: k + 1 }]);
      }),
      FC,
    );
  });

  it("a configured limit above a fixed bound of the schema does not raise the effective limit (claims 50, citations 5, requests 10)", () => {
    fc.assert(
      fc.property(hypSpecArb, expSpecArb, fc.integer({ min: 1, max: 200 }), (h, e, more) => {
        const wide = limitsOf({ maxClaims: 50 + more, maxCitationsPerClaim: 5 + more, maxRequestsPerExperiment: 10 + more });
        expect(gateResponse("hypothesis_generation", toBytes(buildHyp({ ...h, claims: 50, citations: 5 })), wide, real).ok).toBe(true);
        const claims = rejected(gateResponse("hypothesis_generation", toBytes(buildHyp({ ...h, claims: 51, citations: 1 })), wide, real));
        expect(claims.reason, "51 claims were accepted because the configured limit was higher").toBe("schema_violation");
        const cites = rejected(gateResponse("hypothesis_generation", toBytes(buildHyp({ ...h, claims: 1, citations: 6 })), wide, real));
        expect(cites.reason, "6 citations were accepted because the configured limit was higher").toBe("schema_violation");
        expect(gateResponse("experiment_generation", toBytes(buildExp({ ...e, count: 1, requests: 10 })), wide, real).ok).toBe(true);
        // 11 requests: not accepted as a valid Experiment (the schema allows 10); the whole response is not accepted with it
        const r = gateResponse("experiment_generation", toBytes(buildExp({ ...e, count: 1, requests: 11 })), wide, real);
        expect(r.ok && r.kind === "experiment_generation" ? r.experiments.length : 0, "an Experiment of 11 requests was accepted").toBe(0);
      }),
      FC,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("Property 21: parse failures reject the whole response (R17.5, R17.6)", () => {
  it("rejects any proper prefix of a response (truncation)", () => {
    fc.assert(
      fc.property(hypSpecArb, fc.nat(100_000), (s, at) => {
        const full = toBytes(buildHyp(s)); // compact: no trailing whitespace, so a proper prefix is never a whole document
        const cut = full.slice(0, at % full.length);
        const v = spied();
        const r = rejected(gateResponse("hypothesis_generation", cut, L, v));
        expect(["invalid_json", "invalid_utf8"]).toContain(r.reason);
        expect(v.calls).toBe(0);
        expectCleanRejection(r, cut, [s.marker]);
      }),
      FC,
    );
  });

  it("rejects text around or inside the JSON: trailing text, a BOM, a code fence, a comment, single quotes, a trailing comma, a non-JSON literal", () => {
    const wrappers: [string, (t: string) => Uint8Array, string][] = [
      ["trailing", (t) => enc(`${t} x`), "invalid_json"],
      ["bom", (t) => new Uint8Array([0xef, 0xbb, 0xbf, ...enc(t)]), "invalid_json"],
      ["fence", (t) => enc("```json\n" + t + "\n```"), "invalid_json"],
      ["comment", (t) => enc(`/*c*/${t}`), "invalid_json"],
      ["single quotes", (t) => enc(t.replaceAll('"', "'")), "invalid_json"],
      ["trailing comma", (t) => enc(t.slice(0, -1) + ",}"), "invalid_json"],
      ["literal", (t) => enc(t.replace(/^\{/, "{\"n\":NaN,")), "invalid_json"],
      ["two documents", (t) => enc(`${t}${t}`), "invalid_json"],
      ["bad utf-8", (t) => new Uint8Array([...enc(t.slice(0, 5)), 0xff, ...enc(t.slice(5))]), "invalid_utf8"],
      ["unsafe integer", (t) => enc(t.replace(/^\{/, "{\"n\":9007199254740993,")), "unsafe_number"],
    ];
    fc.assert(
      fc.property(hypSpecArb, fc.constantFrom(...wrappers), (s, [name, wrap, reason]) => {
        const text = JSON.stringify(buildHyp(s));
        const bytes = wrap(text);
        const v = spied();
        const r = rejected(gateResponse("hypothesis_generation", bytes, L, v));
        expect(r.reason, name).toBe(reason);
        expect(v.calls, name).toBe(0);
        expectCleanRejection(r, bytes, [s.marker]);
      }),
      FC,
    );
  });

  it("rejects a duplicate key in any object, whatever the schema says about it", () => {
    fc.assert(
      fc.property(hypSpecArb, fc.nat(1000), (s, pick) => {
        const text = JSON.stringify(buildHyp(s));
        const pairs = [...text.matchAll(/"[A-Za-z]+":(?:"[^"]*"|\d+|true|false)/g)].map((m) => m[0]);
        const target = pairs[pick % pairs.length] as string;
        const at = text.indexOf(target);
        const doubled = text.slice(0, at) + target + "," + text.slice(at);
        const bytes = enc(doubled);
        const v = spied();
        const r = rejected(gateResponse("hypothesis_generation", bytes, L, v));
        expect(r.reason).toBe("duplicate_key");
        expect(v.calls).toBe(0);
        expectCleanRejection(r, bytes, [s.marker]);
      }),
      FC,
    );
  });

  it("nesting: 32 levels are not a depth failure, 33 are, wherever the nesting sits (R17.6)", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 70 }), fc.constantFrom<RequestKind>("hypothesis_generation", "experiment_generation"), (k, kind) => {
        const key = kind === "experiment_generation" ? "experiments" : "claims";
        const text = `{"${key}":${"[".repeat(k)}${"]".repeat(k)}}`; // the object is level 1, the arrays are levels 2 to k+1
        const r = gateResponse(kind, enc(text), L, real);
        if (k + 1 > 32) expect(rejected(r).reason, `k=${k}`).toBe("depth_exceeded");
        else expect(r.ok ? "accepted" : rejected(r).reason, `k=${k}`).not.toBe("depth_exceeded");
      }),
      FC,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("Property 21: fields the schema does not define reject the whole response (R17.6)", () => {
  const HYP_POS = ["top", "claim", "condition", "effect", "response", "citation", "derived", "table"] as const;
  const EXP_POS = ["envelope", "experiment", "target", "request", "prediction"] as const;
  const AUTHORITY = ["origin", "evidence", "evidence_status", "approval", "approved", "Origin", "EVIDENCE", "approvalStatus", "evidenceId", "Evidence-Status"];
  const TOOLISH = ["tool_calls", "function_call", "action", "command", "shell", "exec", "Tool-Use"];
  const nameArb = fc.oneof(
    fc.stringMatching(/^[a-z]{3,10}$/).map((n) => `zz${n}`),
    fc.constantFrom(...TOOLISH),
    fc.constantFrom(...AUTHORITY),
  );
  function holder(tree: any, kind: RequestKind, pos: string, idx: number): any {
    if (kind === "experiment_generation") {
      const e = tree.experiments[idx % tree.experiments.length];
      return { envelope: tree, experiment: e, target: e.target, request: e.requests[idx % e.requests.length], prediction: e.prediction }[pos];
    }
    const c = tree.claims[idx % tree.claims.length];
    return { top: tree, claim: c, condition: c.condition, effect: c.effect, response: c.effect.response, citation: c.citations[idx % c.citations.length], derived: tree.derived?.[0] ?? c.condition, table: tree.tables?.[0] ?? c.condition }[pos];
  }

  it("rejects an undefined field at any defined place of a Hypothesis or an Experiment response, with a tool-call flag when its name looks like one", () => {
    fc.assert(
      fc.property(hypSpecArb, expSpecArb, fc.boolean(), nameArb, fc.nat(50), fc.nat(50), (h, e, isExp, name, posPick, idx) => {
        const kind: RequestKind = isExp ? "experiment_generation" : "hypothesis_revision";
        const tree = isExp ? buildExp(e) : buildHyp(h);
        const marker = isExp ? e.marker : h.marker;
        const positions: readonly string[] = isExp ? EXP_POS : HYP_POS;
        // The top level of a Claim is task 3.10 (authority-like names are discarded there); an authority-like name is put in the Claim's parts instead.
        let pos = positions[posPick % positions.length] as string;
        if (!isExp && pos === "claim" && AUTHORITY.includes(name)) pos = "condition";
        const target = holder(tree, kind, pos, idx);
        target[`${name}`] = { marker };
        const bytes = toBytes(tree);
        const r = rejected(gateResponse(kind, bytes, L, real));
        expect(r.reason, `undefined field at ${pos}`).toBe("undefined_field");
        expect(r.issues.some((i) => i.code === "undefined_field")).toBe(true);
        // An independent oracle: only the names of the TOOLISH list look like a tool call; the generated `zz...` names and the authority-like names do not.
        expect(r.toolCallLike, `tool-call flag for ${name}`).toBe(TOOLISH.includes(name));
        expectCleanRejection(r, bytes, [marker]);
      }),
      { ...FC, numRuns: 200 },
    );
  });

  it("an authority-like name outside the top level of a Claim is an undefined field and rejects the whole response, also with valid Experiments beside it", () => {
    fc.assert(
      fc.property(expSpecArb, fc.constantFrom(...AUTHORITY), fc.nat(50), (e, name, pick) => {
        const tree = buildExp({ ...e, count: Math.max(e.count, 2) });
        tree.experiments[pick % tree.experiments.length][name] = "x";
        const r = gateResponse("experiment_generation", toBytes(tree), L, real);
        expect(rejected(r).reason).toBe("undefined_field");
      }),
      FC,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("Property 21: an Experiment is rejected on its own, a broken envelope or Hypothesis whole (R7.4)", () => {
  const BAD_EXPERIMENT: ((e: any) => void)[] = [
    (e) => delete e.prediction,
    (e) => delete e.localKey,
    (e) => (e.requests = "x"),
    (e) => (e.requests = []),
    (e) => (e.requests[0].path = "/reset"),
    (e) => (e.requests[0].path = "/test/orders/1/ship"),
    (e) => (e.requests[0].method = "PUT"),
    (e) => (e.localKey = "Bad Key"),
    (e) => (e.target.kind = "other"),
    (e) => (e.prediction.status = 99),
  ];
  it("drops exactly the Experiments that fail the schema and keeps the others in order", () => {
    fc.assert(
      fc.property(expSpecArb, fc.array(fc.nat(BAD_EXPERIMENT.length - 1), { minLength: 10, maxLength: 10 }), fc.array(fc.boolean(), { minLength: 10, maxLength: 10 }), (e, ops, mask) => {
        const tree = buildExp({ ...e, count: 10, requests: Math.min(e.requests, 3) });
        const bad = new Set<number>();
        tree.experiments.forEach((x: any, i: number) => {
          if (mask[i]) {
            (BAD_EXPERIMENT[ops[i] as number] as (e: any) => void)(x);
            bad.add(i);
          }
        });
        const bytes = toBytes(tree);
        const r = gateResponse("experiment_generation", bytes, L, real);
        expect(r.ok, "an Experiment failure rejected the whole response").toBe(true);
        if (!r.ok || r.kind !== "experiment_generation") return;
        expect(r.rejectedExperiments.map((x) => x.index)).toEqual([...bad].sort((a, b) => a - b));
        expect(r.experiments.length).toBe(10 - bad.size);
        expect(r.experiments).toEqual(tree.experiments.filter((_x: unknown, i: number) => !bad.has(i)));
        expect(r.sha256).toBe(sha256Hex(bytes));
        expect(JSON.stringify(r.rejectedExperiments).includes(e.marker)).toBe(false);
      }),
      FC,
    );
  });

  it("a single undefined field in one Experiment rejects the whole response, even when the others are valid", () => {
    fc.assert(
      fc.property(expSpecArb, fc.nat(9), fc.array(fc.nat(BAD_EXPERIMENT.length - 1), { minLength: 0, maxLength: 3 }), (e, which, ops) => {
        const tree = buildExp({ ...e, count: 10, requests: 1 });
        tree.experiments[which].zzfield = 1;
        ops.forEach((o, j) => (BAD_EXPERIMENT[o] as (e: any) => void)(tree.experiments[(which + 1 + j) % 10]));
        expect(rejected(gateResponse("experiment_generation", toBytes(tree), L, real)).reason).toBe("undefined_field");
      }),
      FC,
    );
  });

  it("a broken envelope, or any schema failure of a Hypothesis, rejects the whole response", () => {
    const BAD_ENVELOPE: ((t: any) => unknown)[] = [
      () => [], () => 7, () => "text", () => null, () => ({}), (t) => ({ experiments: t.experiments[0] }), () => ({ experiments: "x" }), () => ({ experiments: null }),
    ];
    const BAD_HYP: ((t: any) => unknown)[] = [
      () => [], () => ({}), (t) => ({ ...t, claims: [] }), (t) => { delete t.claims[0].confidence; return t; }, (t) => { t.claims[0].confidence = "certain"; return t; },
      (t) => { t.claims[0].openQuestions = "none"; return t; }, (t) => { delete t.claims[0].citations; return t; }, (t) => { t.claims[0].citations = []; return t; },
    ];
    fc.assert(
      fc.property(expSpecArb, hypSpecArb, fc.nat(100), (e, h, pick) => {
        const env = (BAD_ENVELOPE[pick % BAD_ENVELOPE.length] as (t: any) => unknown)(buildExp({ ...e, count: 2 }));
        const a = rejected(gateResponse("experiment_generation", toBytes(env), L, real));
        expect(a.reason).toBe("schema_violation");
        const hyp = (BAD_HYP[pick % BAD_HYP.length] as (t: any) => unknown)(buildHyp(h));
        const b = rejected(gateResponse("hypothesis_generation", toBytes(hyp), L, real));
        expect(b.reason).toBe("schema_violation");
      }),
      FC,
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("Property 21: what cannot be inspected is rejected (fail closed)", () => {
  const MISBEHAVIOUR: ((s: string) => SchemaValidatorPort)[] = [
    (s) => ({ validate: () => { throw new Error(s); } }),
    () => ({ validate: () => undefined as never }),
    () => ({ validate: () => null as never }),
    () => ({ validate: () => "ok" as never }),
    () => ({ validate: () => ({ ok: "yes" }) as never }),
    () => ({ validate: () => ({ ok: false }) as never }),
    () => ({ validate: () => ({ ok: false, error: "no" }) as never }),
    () => ({ validate: () => ({ ok: false, error: [{ code: 1, path: 2 }] }) as never }),
    () => ({ validate: () => 42 as never }),
  ];
  it("a validator that fails or answers in another shape rejects every valid response, whole, without an exception", () => {
    fc.assert(
      fc.property(hypSpecArb, expSpecArb, fc.constantFrom(...MISBEHAVIOUR), (h, e, make) => {
        const a = rejected(gateResponse("hypothesis_generation", toBytes(buildHyp(h)), L, make(h.marker)));
        const b = rejected(gateResponse("experiment_generation", toBytes(buildExp(e)), L, make(e.marker)));
        for (const r of [a, b]) {
          expect(r.reason).toBe("not_inspectable");
          expect(r.failedCall).toBe(true);
          expect(JSON.stringify(r).includes(h.marker) || JSON.stringify(r).includes(e.marker)).toBe(false);
        }
      }),
      FC,
    );
  });

  it("input that is not bytes, or a request kind that does not exist, is rejected as not inspectable", () => {
    fc.assert(
      fc.property(hypSpecArb, fc.constantFrom<unknown>("text", 7, null, undefined, {}, [1, 2], new Uint16Array(2), new ArrayBuffer(4)), (h, bad) => {
        expect(rejected(gateResponse("hypothesis_generation", bad as never, L, real)).reason).toBe("not_inspectable");
        expect(rejected(gateResponse("tool_call" as never, toBytes(buildHyp(h)), L, real)).reason).toBe("not_inspectable");
      }),
      { ...FC, numRuns: 40 },
    );
  });

  it("a value that cannot be written as canonical JSON is rejected (a lone surrogate, a number beyond the safe range)", () => {
    fc.assert(
      fc.property(hypSpecArb, fc.constantFrom('"\\ud800"', '"\\udc00x"', "1e300", "-1e999"), (h, bad) => {
        const text = JSON.stringify(buildHyp(h)).replace(/^\{/, `{"zz":${bad},`);
        const r = rejected(gateResponse("hypothesis_generation", enc(text), L, spied()));
        expect(["not_canonicalizable", "unsafe_number"]).toContain(r.reason);
      }),
      { ...FC, numRuns: 40 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("Property 21: each rejection is one failed call, and an audit violation is none", () => {
  type Item =
    | { t: "valid"; spec: HypSpec }
    | { t: "rejected"; spec: HypSpec; how: number }
    | { t: "provider_error"; reason: "error" | "timeout" | "unmatched_request" | "tool_call_detected" | "undeterminable" }
    | { t: "audit_violation"; code: "not_audited" | "already_used" | "hash_mismatch" | "state_inconsistent" };
  const itemArb: fc.Arbitrary<Item> = fc.oneof(
    hypSpecArb.map((spec): Item => ({ t: "valid", spec })),
    fc.tuple(hypSpecArb, fc.nat(6)).map(([spec, how]): Item => ({ t: "rejected", spec, how })),
    fc.constantFrom("error", "timeout", "unmatched_request", "tool_call_detected", "undeterminable").map((reason): Item => ({ t: "provider_error", reason } as Item)),
    fc.constantFrom("not_audited", "already_used", "hash_mismatch", "state_inconsistent").map((code): Item => ({ t: "audit_violation", code } as Item)),
  );
  const reject = (spec: HypSpec, how: number): Uint8Array => {
    const tree = buildHyp(spec);
    const text = JSON.stringify(tree);
    switch (how % 7) {
      case 0: return enc(text.slice(0, Math.max(1, text.length >> 1)));
      case 1: return enc(text.replace(/^\{/, `{"zzextra":"${spec.marker}",`));
      case 2: return enc(text.replace('"claims"', '"claims":[],"claims"'));
      case 3: return enc(`{"claims":${"[".repeat(40)}${"]".repeat(40)}}`);
      case 4: return enc(text + " ".repeat(L.maxResponseBytes));
      case 5: return toBytes(buildHyp({ ...spec, claims: 51, citations: 1 }));
      default: return enc(JSON.stringify({ ...tree, tool_calls: [{ name: spec.marker }] }));
    }
  };

  it("counts one failed call per rejection and per provider error, none per audit violation, and passes on data only for valid responses", () => {
    fc.assert(
      fc.property(fc.array(itemArb, { minLength: 1, maxLength: 20 }), (items) => {
        let accepted = 0, failed = 0, violations = 0, expectedAccepted = 0, expectedFailed = 0, expectedViolations = 0;
        for (const item of items) {
          let result: Result<Uint8Array, ProviderError>;
          let bytes: Uint8Array | undefined;
          let marker = "";
          if (item.t === "valid") { bytes = toBytes(buildHyp(item.spec), item.spec.fmt); result = { ok: true, value: bytes }; marker = item.spec.marker; expectedAccepted++; }
          else if (item.t === "rejected") { bytes = reject(item.spec, item.how); result = { ok: true, value: bytes }; marker = item.spec.marker; expectedFailed++; }
          else if (item.t === "provider_error") { result = { ok: false, error: { reason: item.reason, detail: "mk-detail-text" } }; expectedFailed++; }
          else { result = { ok: false, error: { reason: "audit_violation", detail: "fixed", violation: { code: item.code } } }; expectedViolations++; }
          const out = gateProviderResult("hypothesis_generation", result, L, real);
          const text = JSON.stringify(out);
          if (item.t === "valid") {
            expect(out.kind).toBe("accepted");
            if (out.kind === "accepted") expect(out.result.sha256).toBe(sha256Hex(bytes as Uint8Array));
            accepted++;
          } else if (item.t === "audit_violation") {
            expect(out).toMatchObject({ kind: "audit_violation", retryable: false, stopRun: true });
            expect("reason" in out, "an audit violation was given a failure reason").toBe(false);
            violations++;
          } else {
            expect(out).toMatchObject({ kind: "failed_call", retryable: true });
            if (out.kind === "failed_call") {
              expect(out.reason).toBe(item.t === "rejected" ? "unparseable" : item.reason === "timeout" ? "timeout" : "error");
              expect(out.source).toBe(item.t === "rejected" ? "gate" : "provider");
              if (out.gate !== undefined) expect(out.gate.failedCall).toBe(true);
            }
            expect(text.includes("mk-detail-text"), "provider error text was carried").toBe(false);
            failed++;
          }
          if (marker !== "" && item.t !== "valid") expect(text.includes(marker), "a rejected response was carried on").toBe(false);
          if (out.kind !== "accepted") expect("result" in out, "a failed call carries data").toBe(false);
        }
        expect([accepted, failed, violations]).toEqual([expectedAccepted, expectedFailed, expectedViolations]);
      }),
      { ...FC, numRuns: 80 },
    );
  });
});