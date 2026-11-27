// C2 (task 4.7 step A2, human decision D4 of 2026-11-27): the pure envelope function extracted from `runtime/auditAdapter.ts` changes NO byte
// of the request of a Run. Two independent references, none of them produced by the new code:
//   1. a hand-written canonical envelope whose SHA-256 was computed with PowerShell on the host before any test ran (evidence a2-09);
//   2. the verbatim copy of `runtime/auditAdapter.ts` at HEAD 62e02624 (`test/fixtures/auditAdapterAtHead.ts`, its SHA-256 is pinned below),
//      run on generated inputs side by side with the current adapter and with `buildRequestEnvelope`.
// The audit itself is unchanged: the same inputs give the same verdicts and the same refusals in both adapters.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseAuditConfig, sha256Hex } from "@phoenix/ai-client";
import { buildRequestEnvelope, createAuditAdapter } from "../src/runtime/auditAdapter.js";
import { createAuditAdapter as createAuditAdapterAtHead } from "./fixtures/auditAdapterAtHead.js";

const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

const HEAD_COPY_SHA256 = "7b304191b6ff8fb64dc467a0b809e0a0e4bb3add83f924c3c456725846aa434f";

// ---- the hand-written vector (evidence a2-09) ------------------------------------------------------------------------------------
const TEMPLATE_SHA = "317849d121db3d9a67d47a0f04b0c8dae401bcc00d7e91de8d104e360b25ca33";
const TEXT = "<?php\n// synthetic c2 vector\n";
const VECTOR_INPUT = {
  kind: "experiment_generation",
  templateId: "tpl-c2",
  bundle: { manifest: [{ path: "legacy/src/utils.php", sha256Lf: "cfa18e9232cac863afa2ecc240180006f47b1746134e5b4eb3e259005e70fd39" }], files: [{ path: "legacy/src/utils.php", text: TEXT }] },
  stored: [{ partId: "hyp-1-hypothesis-revision", type: "hypothesis_revision", recordId: "rec-000004" }],
  records: [{ id: "rec-000004", kind: "hypothesis_revision", payload: { revision: 1, hypothesisId: "hyp-1" } }],
};
const VECTOR_TEXT =
  '{"instruction":{"sha256":"317849d121db3d9a67d47a0f04b0c8dae401bcc00d7e91de8d104e360b25ca33","templateId":"tpl-c2"},"kind":"experiment_generation","parts":[{"partId":"src-1","path":"legacy/src/utils.php","sha256Lf":"cfa18e9232cac863afa2ecc240180006f47b1746134e5b4eb3e259005e70fd39","text":"<?php\\n// synthetic c2 vector\\n","type":"source_file"},{"content":{"hypothesisId":"hyp-1","revision":1},"partId":"hyp-1-hypothesis-revision","recordId":"rec-000004","recordSha256":"2cc828997eb8b126e94a71f887dd89ce74a2c5c8ee4dcafcac68333438aea5ac","type":"hypothesis_revision"}],"schemaVersion":1}';
const VECTOR_SHA256 = "0f03b384960252bed183a23b16e5f389a41f13bfa4a421242672462ac38e8a03";

const templates = new Map([["tpl-c2", TEMPLATE_SHA]]);
const options = { allowlist: ["legacy/src/utils.php"], instructionTemplates: templates, secretValues: [] };

describe("C2: the request bytes of a Run are unchanged", () => {
  it("the HEAD copy is byte-identical to the file of HEAD 62e02624 (pinned SHA-256)", () => {
    expect(sha(readFileSync(new URL("./fixtures/auditAdapterAtHead.ts", import.meta.url)))).toBe(HEAD_COPY_SHA256);
  });
  it("the hand-written vector: the current adapter, the HEAD adapter and buildRequestEnvelope give exactly the vector bytes and SHA-256", () => {
    expect(sha(VECTOR_TEXT)).toBe(VECTOR_SHA256); // the literal is the one hashed with PowerShell
    const now = createAuditAdapter<object>(options);
    const head = createAuditAdapterAtHead<object>(options);
    if (!now.ok || !head.ok) throw new Error("options refused");
    const a = now.value.prepareAudit(VECTOR_INPUT);
    const b = head.value.prepareAudit(VECTOR_INPUT);
    const c = buildRequestEnvelope(VECTOR_INPUT, templates);
    if (!a.ok || !b.ok || !c.ok) throw new Error("prepare refused");
    expect(dec(a.value.bytes)).toBe(VECTOR_TEXT);
    expect(dec(b.value.bytes)).toBe(VECTOR_TEXT);
    expect(dec(c.value.bytes)).toBe(VECTOR_TEXT);
    expect(sha(a.value.bytes)).toBe(VECTOR_SHA256);
    expect(sha(c.value.bytes)).toBe(VECTOR_SHA256);
    expect(c.value.templateHash).toBe(TEMPLATE_SHA);
    expect(c.value.kind).toBe("experiment_generation");
  });
  it("negative control: one changed character of the source text changes the bytes and the hash (the vector is not trivially satisfied)", () => {
    const text = "<?php\n// synthetic c2 vectoR\n";
    const changed = { ...VECTOR_INPUT, bundle: { manifest: [{ path: "legacy/src/utils.php", sha256Lf: sha256Hex(text) }], files: [{ path: "legacy/src/utils.php", text }] } };
    const c = buildRequestEnvelope(changed, templates);
    if (!c.ok) throw new Error("refused");
    expect(sha(c.value.bytes)).not.toBe(VECTOR_SHA256);
  });
});

// ---- generated inputs: HEAD adapter vs current adapter vs the pure function ---------------------------------------------------------
const pathArb = fc.constantFrom("legacy/src/utils.php", "legacy/src/db.php", "legacy/src/orders.php");
const textArb = fc.string({ maxLength: 40 }).map((s) => s.replace(/\r\n?/g, "\n"));
const payloadArb = fc.dictionary(fc.constantFrom("a", "b", "claims", "x_y", "n"), fc.oneof(fc.integer(), fc.string({ maxLength: 8 }), fc.boolean(), fc.constant(null)), { maxKeys: 4 });
const inputArb = fc
  .record({
    kind: fc.constantFrom("hypothesis_generation", "experiment_generation", "hypothesis_revision", "unknown_kind"),
    templateId: fc.constantFrom("tpl-c2", "tpl-other", "tpl-missing"),
    files: fc.uniqueArray(fc.record({ path: pathArb, text: textArb }), { selector: (f) => f.path, minLength: 1, maxLength: 3 }),
    breakHash: fc.boolean(),
    records: fc.array(fc.record({ kind: fc.constantFrom("hypothesis_revision", "experiment", "observation", "comparison", "evidence"), payload: payloadArb }), { maxLength: 4 }),
    refs: fc.array(fc.nat(5), { maxLength: 4 }),
  })
  .map((g) => {
    const records = g.records.map((r, i) => ({ id: `rec-${String(i + 4).padStart(6, "0")}`, kind: r.kind, payload: r.payload }));
    const stored = g.refs.map((n, i) => {
      const r = records[n];
      return { partId: `part-${i}`, type: r === undefined ? "experiment" : r.kind, recordId: r === undefined ? "rec-999999" : r.id };
    });
    const manifest = g.files.map((f, i) => ({ path: f.path, sha256Lf: g.breakHash && i === 0 ? sha256Hex(`${f.text}x`) : sha256Hex(f.text) }));
    return { kind: g.kind, templateId: g.templateId, bundle: { manifest, files: g.files }, stored, records };
  });
const generatedTemplates = new Map([["tpl-c2", TEMPLATE_SHA], ["tpl-other", sha256Hex("other template")]]);
const generatedOptions = { allowlist: ["legacy/src/utils.php", "legacy/src/db.php"], instructionTemplates: generatedTemplates, secretValues: [{ name: "SYNTHETIC_KEY", value: "SYNTHETIC-SECRET-0001" }] };
// the same synthetic shape as test/runtime.auditAdapter.test.ts (fictitious canaries and fingerprints)
const auditConfig = parseAuditConfig(
  enc(
    JSON.stringify({
      schemaVersion: 1,
      allowlist: ["legacy/src/utils.php", "legacy/src/db.php"],
      canaries: [{ id: "canary-1", value: "SYNTHETIC-CANARY-0001" }],
      decoys: [{ id: "decoy-1", value: "SYNTHETIC-DECOY-0001" }],
      fingerprints: [1, 2, 3, 4].map((i) => ({ id: `fp-${i}`, fileId: `file-${i}`, n: 12, hashes: ["0123456789ab", "ba9876543210"] })),
      restrictedPathPrefixes: ["synthetic-restricted/"],
      tokenizer: "token-ngram-sha256-v1",
    }),
  ),
);
if (!auditConfig.ok) throw new Error("the synthetic audit configuration must parse");

describe("C2 on generated inputs (fast-check, fixed seed, 200 runs)", () => {
  it("the HEAD adapter, the current adapter and buildRequestEnvelope agree on refusal, bytes and SHA-256; the audit verdicts agree too", () => {
    fc.assert(
      fc.property(inputArb, (input) => {
        const now = createAuditAdapter<object>(generatedOptions);
        const head = createAuditAdapterAtHead<object>(generatedOptions);
        if (!now.ok || !head.ok) return false;
        const a = now.value.prepareAudit(input);
        const b = head.value.prepareAudit(input);
        const c = buildRequestEnvelope(input, generatedTemplates);
        expect(a.ok).toBe(b.ok);
        expect(c.ok).toBe(b.ok);
        if (a.ok && b.ok && c.ok) {
          expect(sha(a.value.bytes)).toBe(sha(b.value.bytes));
          expect(sha(c.value.bytes)).toBe(sha(b.value.bytes));
          expect(dec(a.value.bytes)).toBe(dec(b.value.bytes));
          const va = now.value.auditPayload(a.value.bytes, input.kind, auditConfig, a.value.ctx);
          const vb = head.value.auditPayload(b.value.bytes, input.kind, auditConfig, b.value.ctx);
          expect(va.audit.result).toBe(vb.audit.result);
          expect(JSON.stringify(va.audit.checks)).toBe(JSON.stringify(vb.audit.checks));
          expect(va.audit.payloadSha256).toBe(vb.audit.payloadSha256);
          expect(va.request === undefined).toBe(vb.request === undefined);
        }
        return true;
      }),
      { numRuns: 200, seed: 23_000_101 },
    );
  });
  it("positive control: the generator produces both accepted and refused inputs", () => {
    const samples = fc.sample(inputArb, { numRuns: 200, seed: 23_000_101 });
    const outcomes = new Set(samples.map((i) => buildRequestEnvelope(i, generatedTemplates).ok));
    expect(outcomes).toEqual(new Set([true, false]));
  });
});
