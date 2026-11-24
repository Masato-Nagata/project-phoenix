// Task 4.9-B: the production AuditPort (`prepareAudit` and `auditPayload`) over the REAL ai-client Payload_Auditor. Synthetic data only:
// fictitious canaries, a fictitious credential, an invented source file. No file, no network, no real audit configuration.
import { describe, expect, it } from "vitest";
import { canonicalJson, parseAuditConfig, sha256Hex } from "@phoenix/ai-client";
import type { AuditConfigLoadResult, Json } from "@phoenix/ai-client";
import { AuditAdapterError, createAuditAdapter, type AuditAdapter } from "../src/runtime/auditAdapter.js";

const PATH = "legacy/src/utils.php";
const TEXT = "<?php\n// synthetic helper of the mock run\n";
const TEMPLATE_ID = "tpl-revision";
const TEMPLATE_SHA = sha256Hex("synthetic instruction text of tpl-revision");
const CANARY_VALUE = "SYNTHETIC-CANARY-0001";
const SECRET_NAME = "FICTIONAL_API_KEY";
const SECRET_VALUE = "sk-fictional-0123456789abcdef";
const enc = new TextEncoder();
const dec = new TextDecoder();

const configBytes = (): Uint8Array =>
  enc.encode(
    JSON.stringify({
      schemaVersion: 1,
      allowlist: [PATH],
      canaries: [{ id: "canary-1", value: CANARY_VALUE }],
      decoys: [{ id: "decoy-1", value: "SYNTHETIC-DECOY-0001" }],
      fingerprints: [1, 2, 3, 4].map((i) => ({ id: `fp-${i}`, fileId: `file-${i}`, n: 12, hashes: ["0123456789ab", "ba9876543210"] })),
      restrictedPathPrefixes: ["synthetic-restricted/"],
      tokenizer: "token-ngram-sha256-v1",
    }),
  );
const cfg = (): AuditConfigLoadResult => {
  const r = parseAuditConfig(configBytes());
  if (!r.ok) throw new Error("the synthetic audit configuration must parse");
  return r;
};

type Handle = object;
function adapter(over: Record<string, unknown> = {}): AuditAdapter<Handle> {
  const r = createAuditAdapter<Handle>({
    allowlist: [PATH],
    instructionTemplates: new Map([[TEMPLATE_ID, TEMPLATE_SHA]]),
    secretValues: [],
    ...over,
  });
  if (!r.ok) throw new Error("expected ok");
  return r.value;
}

interface Input {
  bundle: { manifest: { path: string; sha256Lf: string }[]; files: { path: string; text: string }[] };
  kind: string;
  templateId: string;
  stored: { partId: string; type: string; recordId: string }[];
  records: { id: string; kind: string; payload: unknown }[];
}
const input = (text: string = TEXT): Input => ({
  bundle: { manifest: [{ path: PATH, sha256Lf: sha256Hex(text) }], files: [{ path: PATH, text }] },
  kind: "hypothesis_revision",
  templateId: TEMPLATE_ID,
  stored: [{ partId: "h1-hypothesis-revision", type: "hypothesis_revision", recordId: "rec-000001" }],
  records: [
    { id: "rec-000001", kind: "hypothesis_revision", payload: { summary: "fictional revision text" } },
    { id: "rec-000002", kind: "experiment", payload: { n: 1 } },
  ],
});
function prep(a: AuditAdapter<Handle>, i: unknown = input()): { bytes: Uint8Array; ctx: Handle } {
  const r = a.prepareAudit(i);
  if (!r.ok) throw new Error("expected prepare ok");
  return r.value;
}
const thrown = (f: () => unknown): AuditAdapterError | undefined => {
  try {
    f();
  } catch (e) {
    return e instanceof AuditAdapterError ? e : undefined;
  }
  return undefined;
};
const FAILED = { ok: false, error: { code: "prepare_failed" } };

describe("createAuditAdapter options", () => {
  it("accepts the minimal valid options and options with limits", () => {
    expect(createAuditAdapter({ allowlist: [PATH], instructionTemplates: new Map([[TEMPLATE_ID, TEMPLATE_SHA]]), secretValues: [] }).ok).toBe(true);
    expect(createAuditAdapter({ allowlist: [], instructionTemplates: new Map(), secretValues: [{ name: SECRET_NAME, value: SECRET_VALUE }], limits: { maxBytes: 1000, maxDepth: 8 } }).ok).toBe(true);
  });
  it("refuses everything else with the closed code", () => {
    const good = { allowlist: [PATH], instructionTemplates: new Map([[TEMPLATE_ID, TEMPLATE_SHA]]), secretValues: [] as unknown[] };
    const bads: unknown[] = [
      undefined,
      null,
      [],
      "x",
      { ...good, allowlist: undefined },
      { ...good, allowlist: [""] },
      { ...good, allowlist: [1] },
      { ...good, instructionTemplates: {} },
      { ...good, instructionTemplates: new Map([["", TEMPLATE_SHA]]) },
      { ...good, instructionTemplates: new Map([[TEMPLATE_ID, "not-a-hash"]]) },
      { ...good, instructionTemplates: new Map([[TEMPLATE_ID, TEMPLATE_SHA.toUpperCase()]]) },
      { ...good, secretValues: undefined },
      { ...good, secretValues: [{ name: "", value: "x" }] },
      { ...good, secretValues: [{ name: "N", value: 1 }] },
      { ...good, limits: { maxBytes: 1 } },
      { ...good, limits: { maxBytes: 1.5, maxDepth: 3 } },
    ];
    for (const b of bads) expect(createAuditAdapter(b), JSON.stringify(b)).toEqual({ ok: false, error: { code: "options_invalid" } });
  });
  it("copies the options: a later change of the caller's objects changes nothing", () => {
    const templates = new Map([[TEMPLATE_ID, TEMPLATE_SHA]]);
    const allowlist = [PATH];
    const a = adapter({ allowlist, instructionTemplates: templates });
    templates.set(TEMPLATE_ID, sha256Hex("another text"));
    allowlist.length = 0;
    const p = prep(a);
    expect(a.auditPayload(p.bytes, "hypothesis_revision", cfg(), p.ctx).audit.result).toBe("pass");
  });
});

describe("prepareAudit: the envelope", () => {
  it("builds the canonical envelope from the bundle, the template and ONLY the referenced records", () => {
    const i = input();
    const { bytes } = prep(adapter(), i);
    const payload = { summary: "fictional revision text" };
    const expected: Json = {
      schemaVersion: 1,
      kind: "hypothesis_revision",
      instruction: { templateId: TEMPLATE_ID, sha256: TEMPLATE_SHA },
      parts: [
        { partId: "src-1", type: "source_file", path: PATH, sha256Lf: sha256Hex(TEXT), text: TEXT },
        { partId: "h1-hypothesis-revision", type: "hypothesis_revision", recordId: "rec-000001", recordSha256: sha256Hex(canonicalJson(payload)), content: payload },
      ],
    };
    expect(dec.decode(bytes)).toBe(canonicalJson(expected));
    expect(dec.decode(bytes)).not.toContain("rec-000002");
  });

  it("a record that no part refers to is not touched, even if it has no canonical form", () => {
    const i = input();
    i.records[1] = { id: "rec-000002", kind: "experiment", payload: { n: Number.NaN } };
    expect(adapter().prepareAudit(i).ok).toBe(true);
  });

  it("one source part per bundle file, in manifest order", () => {
    const i = input();
    const other = "<?php\n// second file\n";
    i.bundle.manifest.push({ path: "legacy/src/db.php", sha256Lf: sha256Hex(other) });
    i.bundle.files.push({ path: "legacy/src/db.php", text: other });
    const env = JSON.parse(dec.decode(prep(adapter(), i).bytes)) as { parts: { partId: string; path?: string }[] };
    expect(env.parts.map((p) => p.partId)).toEqual(["src-1", "src-2", "h1-hypothesis-revision"]);
    expect(env.parts.slice(0, 2).map((p) => p.path)).toEqual([PATH, "legacy/src/db.php"]);
  });

  it("returns a frozen, empty, opaque handle and a fresh copy of the bytes for each call", () => {
    const a = adapter();
    const p1 = prep(a);
    const p2 = prep(a);
    expect(p1.ctx).not.toBe(p2.ctx);
    expect(Object.isFrozen(p1.ctx)).toBe(true);
    expect(Reflect.ownKeys(p1.ctx)).toEqual([]);
    expect(JSON.stringify(p1.ctx)).toBe("{}");
    expect(p1.bytes).not.toBe(p2.bytes);
    expect([...p1.bytes]).toEqual([...p2.bytes]);
  });
});

describe("prepareAudit: fail closed", () => {
  const CANARY = "CANARY-audit-adapter-77b1";
  const mutate = (f: (i: Input) => void): unknown => {
    const i = input();
    i.records[0] = { id: "rec-000001", kind: "hypothesis_revision", payload: { summary: CANARY } };
    f(i);
    return i;
  };
  const cases: [string, unknown][] = [
    ["null input", null],
    ["undefined input", undefined],
    ["array input", []],
    ["string input", "x"],
    ["unknown kind", mutate((i) => (i.kind = "other"))],
    ["kind not a string", mutate((i) => ((i as unknown as Record<string, unknown>)["kind"] = 1))],
    ["unknown template", mutate((i) => (i.templateId = "tpl-unknown"))],
    ["template id missing", mutate((i) => delete (i as unknown as Record<string, unknown>)["templateId"])],
    ["bundle missing", mutate((i) => delete (i as unknown as Record<string, unknown>)["bundle"])],
    ["empty bundle", mutate((i) => ((i.bundle.manifest = []), (i.bundle.files = [])))],
    ["manifest and files differ in length", mutate((i) => i.bundle.files.pop())],
    ["file text differs from the manifest hash", mutate((i) => ((i.bundle.files[0] as { text: string }).text = `${TEXT}x`))],
    ["file path differs from the manifest path", mutate((i) => ((i.bundle.files[0] as { path: string }).path = "legacy/src/other.php"))],
    ["manifest hash is not a hash", mutate((i) => ((i.bundle.manifest[0] as { sha256Lf: string }).sha256Lf = "zz"))],
    ["records not an array", mutate((i) => ((i as unknown as Record<string, unknown>)["records"] = {}))],
    ["duplicate record id", mutate((i) => i.records.push({ id: "rec-000001", kind: "hypothesis_revision", payload: {} }))],
    ["record without id", mutate((i) => i.records.push({ kind: "experiment", payload: {} } as unknown as Input["records"][number]))],
    ["record with empty kind", mutate((i) => ((i.records[1] as { kind: string }).kind = ""))],
    ["stored not an array", mutate((i) => ((i as unknown as Record<string, unknown>)["stored"] = null))],
    ["stored record missing", mutate((i) => ((i.stored[0] as { recordId: string }).recordId = "rec-999999"))],
    ["stored type differs from the record kind", mutate((i) => ((i.stored[0] as { type: string }).type = "experiment"))],
    ["stored type not permitted", mutate((i) => ((i.stored[0] as { type: string }).type = "source_file"))],
    ["stored part id empty", mutate((i) => ((i.stored[0] as { partId: string }).partId = ""))],
    ["stored part id collides with a source part", mutate((i) => ((i.stored[0] as { partId: string }).partId = "src-1"))],
    ["duplicate stored part id", mutate((i) => i.stored.push({ ...(i.stored[0] as Input["stored"][number]) }))],
    ["referenced payload undefined", mutate((i) => ((i.records[0] as { payload: unknown }).payload = undefined))],
    ["referenced payload not JSON", mutate((i) => ((i.records[0] as { payload: unknown }).payload = { f: () => CANARY }))],
    ["referenced payload with NaN", mutate((i) => ((i.records[0] as { payload: unknown }).payload = { n: Number.NaN, s: CANARY }))],
  ];
  for (const [name, bad] of cases) {
    it(`refuses: ${name}`, () => {
      const r = adapter().prepareAudit(bad);
      expect(r).toEqual(FAILED);
      expect(JSON.stringify(r)).not.toContain(CANARY);
    });
  }

  it("refuses an input with a throwing accessor, and never throws", () => {
    const i = input();
    Object.defineProperty(i, "kind", { enumerable: true, get: () => { throw new Error(CANARY); } });
    const a = adapter();
    expect(() => a.prepareAudit(i)).not.toThrow();
    expect(JSON.stringify(a.prepareAudit(i))).not.toContain(CANARY);
    expect(a.prepareAudit(i)).toEqual(FAILED);
  });
});

describe("auditPayload: the audit runs on the prepared bytes and the matching context", () => {
  it("passes a normal request and returns the request that is bound to the audited bytes", () => {
    const a = adapter();
    const { bytes, ctx } = prep(a);
    const out = a.auditPayload(bytes, "hypothesis_revision", cfg(), ctx);
    expect(out.audit.result).toBe("pass");
    expect(out.audit.payloadSha256).toBe(sha256Hex(bytes));
    expect(out.audit.checks.map((c) => c.outcome)).toEqual(Array(9).fill("pass"));
    expect(out.request).toBeDefined();
    expect(out.request?.sha256).toBe(sha256Hex(bytes));
    expect(out.request?.kind).toBe("hypothesis_revision");
    expect([...(out.request?.bytes ?? [])]).toEqual([...bytes]);
  });

  it("each handle audits its own request only: the bytes of another preparation are a swap and are refused", () => {
    const a = adapter();
    const first = prep(a);
    const other = input();
    other.records[0] = { id: "rec-000001", kind: "hypothesis_revision", payload: { summary: "a different revision text" } };
    const second = prep(a, other);
    expect([...first.bytes]).not.toEqual([...second.bytes]);
    expect(thrown(() => a.auditPayload(second.bytes, "hypothesis_revision", cfg(), first.ctx))?.code).toBe("bytes_changed");
    expect(a.auditPayload(second.bytes, "hypothesis_revision", cfg(), second.ctx).audit.result).toBe("pass");
  });

  it("a later change of the records, the bundle or the returned bytes cannot change what is audited", () => {
    const a = adapter();
    const i = input();
    const { bytes, ctx } = prep(a, i);
    const original = new Uint8Array(bytes);
    // the caller changes everything it still holds
    (i.records[0]?.payload as { summary: string }).summary = "changed after the audit was prepared";
    (i.bundle.files[0] as { text: string }).text = "<?php // changed";
    i.stored.length = 0;
    // the returned bytes are changed by one bit: this is a different payload and is refused
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(thrown(() => a.auditPayload(bytes, "hypothesis_revision", cfg(), ctx))?.code).toBe("bytes_changed");
    // the original bytes still pass, so nothing of the prepared state was changed by any of this
    const out = a.auditPayload(original, "hypothesis_revision", cfg(), ctx);
    expect(out.audit.result).toBe("pass");
    expect(dec.decode(out.request?.bytes)).toContain("fictional revision text");
    expect(dec.decode(out.request?.bytes)).not.toContain("changed after");
  });

  it("the bytes of the request are a private copy: changing the passed array afterwards does not change the request", () => {
    const a = adapter();
    const { bytes, ctx } = prep(a);
    const out = a.auditPayload(bytes, "hypothesis_revision", cfg(), ctx);
    const before = [...(out.request?.bytes ?? [])];
    bytes.fill(0);
    expect([...(out.request?.bytes ?? [])]).toEqual(before);
  });

  it("refuses with a closed error, before any audit, for an unknown handle, a wrong kind and bytes that are not the prepared bytes", () => {
    const a = adapter();
    const b = adapter();
    const { bytes, ctx } = prep(a);
    const foreign = prep(b);
    const cases: [string, () => unknown, string][] = [
      ["a plain object", () => a.auditPayload(bytes, "hypothesis_revision", cfg(), {}), "context_unknown"],
      ["a frozen empty object", () => a.auditPayload(bytes, "hypothesis_revision", cfg(), Object.freeze({})), "context_unknown"],
      ["the handle of another adapter", () => a.auditPayload(foreign.bytes, "hypothesis_revision", cfg(), foreign.ctx), "context_unknown"],
      ["null", () => a.auditPayload(bytes, "hypothesis_revision", cfg(), null as unknown as object), "context_unknown"],
      ["another kind", () => a.auditPayload(bytes, "experiment_generation", cfg(), ctx), "kind_mismatch"],
      ["a kind that does not exist", () => a.auditPayload(bytes, "nope", cfg(), ctx), "kind_mismatch"],
      ["bytes that are a string", () => a.auditPayload("x" as unknown as Uint8Array, "hypothesis_revision", cfg(), ctx), "bytes_changed"],
      ["empty bytes", () => a.auditPayload(new Uint8Array(0), "hypothesis_revision", cfg(), ctx), "bytes_changed"],
    ];
    for (const [name, f, code] of cases) {
      const e = thrown(f);
      expect(e, name).toBeInstanceOf(AuditAdapterError);
      expect(e?.code, name).toBe(code);
      expect(e?.message, name).toBe(code);
    }
  });
});

describe("auditPayload: a blocked audit gives no request", () => {
  it("blocks a canary in the source text, returns no request and no bytes, and shows no value", () => {
    const a = adapter();
    const i = input(`${TEXT}// ${CANARY_VALUE}\n`);
    const { bytes, ctx } = prep(a, i);
    const out = a.auditPayload(bytes, "hypothesis_revision", cfg(), ctx);
    expect(out.audit.result).toBe("blocked");
    expect(out.request).toBeUndefined();
    expect(out.audit.bytesWithheld).toBe(true);
    expect(JSON.stringify(out)).not.toContain(CANARY_VALUE);
  });

  it("blocks a credential value in a stored record, names only the variable, and shows no value", () => {
    const a = adapter({ secretValues: [{ name: SECRET_NAME, value: SECRET_VALUE }] });
    const i = input();
    i.records[0] = { id: "rec-000001", kind: "hypothesis_revision", payload: { summary: `uses ${SECRET_VALUE}` } };
    const { bytes, ctx } = prep(a, i);
    const out = a.auditPayload(bytes, "hypothesis_revision", cfg(), ctx);
    expect(out.audit.result).toBe("blocked");
    expect(out.request).toBeUndefined();
    const shown = JSON.stringify(out);
    expect(shown).not.toContain(SECRET_VALUE);
    expect(shown).toContain(SECRET_NAME);
  });

  it("blocks when the audit configuration is not valid", () => {
    const a = adapter();
    const { bytes, ctx } = prep(a);
    const out = a.auditPayload(bytes, "hypothesis_revision", parseAuditConfig(undefined), ctx);
    expect(out.audit.result).toBe("blocked");
    expect(out.request).toBeUndefined();
  });

  it("blocks a path that is not in the allowlist of the adapter", () => {
    const a = adapter({ allowlist: ["legacy/src/other.php"] });
    const { bytes, ctx } = prep(a);
    const out = a.auditPayload(bytes, "hypothesis_revision", cfg(), ctx);
    expect(out.audit.result).toBe("blocked");
    expect(out.request).toBeUndefined();
  });

  it("applies the limits of the options", () => {
    const a = adapter({ limits: { maxBytes: 64, maxDepth: 8 } });
    const { bytes, ctx } = prep(a);
    const out = a.auditPayload(bytes, "hypothesis_revision", cfg(), ctx);
    expect(out.audit.result).toBe("blocked");
    expect(out.request).toBeUndefined();
  });

  it("the template check A03 passes, because the envelope and the context are built from the same template table", () => {
    const a = adapter();
    const { bytes, ctx } = prep(a);
    expect(a.auditPayload(bytes, "hypothesis_revision", cfg(), ctx).audit.checks.find((c) => c.id === "A03")?.outcome).toBe("pass");
  });
});