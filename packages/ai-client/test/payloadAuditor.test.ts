import { describe, expect, it } from "vitest";
import { AUDIT_CHECK_IDS, auditPayload, canonicalJson, parseAuditConfig, sha256Hex } from "../src/index.js";
import type { AuditCheckId, AuditResult, Json, RequestKind } from "../src/index.js";
import {
  CANARY_VALUE, DECOY_VALUE, RECORD_ID, RESTRICTED_PREFIX, RESTRICTED_TEXTS, SECRET_NAME, SECRET_VALUE, SOURCE_A, SOURCE_B,
  configBytes, dec, enc, makeWorld,
} from "./helpers/auditFixtures.js";

type World = ReturnType<typeof makeWorld>;
const KIND: RequestKind = "hypothesis_revision";

function audit(w: World, bytes: Uint8Array, kind: RequestKind = KIND) {
  return auditPayload(bytes, kind, w.cfg, w.ctx);
}
const outcome = (a: AuditResult, id: AuditCheckId): string => a.checks.find((c) => c.id === id)?.outcome ?? "missing";
const detail = (a: AuditResult, id: AuditCheckId): string | undefined => a.checks.find((c) => c.id === id)?.detail;
const failed = (a: AuditResult): AuditCheckId[] => a.checks.filter((c) => c.outcome === "fail").map((c) => c.id);
/** A world in which one stored record carries `content`, consistent with its hash, so that only the content check can fail. */
const withContent = (content: Json): World => makeWorld({ storedContent: content });

describe("auditPayload: a payload that violates nothing", () => {
  it("passes all nine checks in the fixed order and returns an audited request bound to the audited hash (R2.1, R2.3)", () => {
    const w = makeWorld();
    const bytes = w.bytes(w.envelope());
    const { audit: a, request } = audit(w, bytes);
    expect(a.result).toBe("pass");
    expect(a.checks.map((c) => c.id)).toEqual([...AUDIT_CHECK_IDS]);
    expect(a.checks.every((c) => c.outcome === "pass")).toBe(true);
    expect(a.matches).toEqual([]);
    expect(a.payloadSha256).toBe(sha256Hex(bytes));
    expect(a.bytesWithheld).toBe(false);
    expect(Buffer.from(a.auditedBytes as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
    expect(request).toBeDefined();
    expect(request?.sha256).toBe(a.payloadSha256);
    expect(request?.kind).toBe(KIND);
    expect(Buffer.from(request?.bytes as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
  });

  it("passes for each of the three request kinds", () => {
    const w = makeWorld();
    for (const kind of ["hypothesis_generation", "experiment_generation", "hypothesis_revision"] as const) {
      expect(audit(w, w.bytes(w.envelope(kind)), kind).audit.result).toBe("pass");
    }
  });
});

describe("auditPayload: each check blocks exactly its own violation", () => {
  function expectBlockedOnly(a: AuditResult, request: unknown, id: AuditCheckId): void {
    expect(a.result).toBe("blocked");
    expect(request).toBeUndefined();
    expect(failed(a)).toEqual([id]);
  }

  it("A01: a missing, empty, invalid or unreadable audit configuration blocks, and the config-dependent checks do not run (R2.9)", () => {
    const base = makeWorld();
    const bytes = base.bytes(base.envelope());
    const cases = [
      ["missing", parseAuditConfig(undefined)],
      ["empty", parseAuditConfig(new Uint8Array())],
      ["invalid", parseAuditConfig(enc("{}"))],
      ["unreadable", { ok: false, reason: "unreadable" } as const],
    ] as const;
    for (const [reason, cfg] of cases) {
      const { audit: a, request } = auditPayload(bytes, KIND, cfg, base.ctx);
      expect(a.result, reason).toBe("blocked");
      expect(request).toBeUndefined();
      expect(outcome(a, "A01")).toBe("fail");
      expect(detail(a, "A01")).toBe(reason);
      for (const id of ["A05", "A06", "A07"] as const) expect(outcome(a, id)).toBe("not_run");
      for (const id of ["A02", "A03", "A04", "A08", "A09"] as const) expect(outcome(a, id)).toBe("pass");
    }
  });

  it("A02: a payload that is not canonical, has a duplicate key, an undefined field, bad UTF-8, a wrong kind or is too large", () => {
    const w = makeWorld();
    const good = w.envelope();
    const pretty = enc(JSON.stringify(good, null, 2));
    const dup = enc(dec(w.bytes(good)).replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1'));
    const extra = w.bytes({ ...good, extra: 1 });
    const badUtf8 = new Uint8Array([0x7b, 0xff, 0x7d]);
    const wrongKind = w.bytes({ ...good, kind: "experiment_generation" });
    for (const [name, bytes] of [["not_canonical", pretty], ["duplicate_key", dup], ["undefined_field", extra], ["invalid_utf8", badUtf8], ["kind_mismatch", wrongKind]] as const) {
      const { audit: a, request } = audit(w, bytes);
      expect(a.result, name).toBe("blocked");
      expect(request).toBeUndefined();
      expect(outcome(a, "A02"), name).toBe("fail");
      expect(detail(a, "A02")?.startsWith(name), `${name}: ${detail(a, "A02")}`).toBe(true);
    }
    const small = { ...w.ctx, limits: { maxBytes: 100, maxDepth: 32 } };
    const big = auditPayload(w.bytes(good), KIND, w.cfg, small);
    expect(big.audit.result).toBe("blocked");
    expect(detail(big.audit, "A02")).toBe("size_exceeded");
    expect(outcome(big.audit, "A06")).toBe("not_run");
  });

  it("A02: never copies an unknown key of the untrusted payload into a detail", () => {
    const w = makeWorld();
    const { audit: a } = audit(w, w.bytes({ ...w.envelope(), [`key-${CANARY_VALUE}`]: 1 }));
    expect(detail(a, "A02")).toBe("undefined_field:/<unknown>");
  });

  it("A03: an unknown instruction, a part outside the permitted kinds, a missing record, a wrong record hash and altered content", () => {
    const w = makeWorld();
    const mk = (f: (e: { [k: string]: any }) => void): Uint8Array => {
      const e = w.envelope();
      f(e);
      return w.bytes(e);
    };
    const cases: [string, Uint8Array][] = [
      ["instruction_template_unknown", mk((e) => (e.instruction.templateId = "other-v1"))],
      ["instruction_hash_mismatch", mk((e) => (e.instruction.sha256 = sha256Hex("other")))],
      ["part_type_not_permitted", mk((e) => e.parts.push({ partId: "p10", type: "free_text" }))],
      ["record_not_found", mk((e) => (e.parts[2].recordId = "rec-999999"))],
      ["record_hash_mismatch", mk((e) => (e.parts[2].recordSha256 = sha256Hex("other")))],
      ["content_differs", mk((e) => (e.parts[2].content = { summary: "changed after storing" }))],
    ];
    for (const [name, bytes] of cases) {
      const { audit: a, request } = audit(w, bytes);
      expectBlockedOnly(a, request, "A03");
      expect(detail(a, "A03"), name).toBe(name);
      expect(a.matches.every((m) => m.checkId === "A03" && /^part:\d+$/.test(m.matchId))).toBe(true);
    }
  });

  it("A04: a changed, reordered, missing, added or renamed source file differs from the Source_Bundle manifest (R2.6)", () => {
    const w = makeWorld();
    const mk = (f: (e: { [k: string]: any }) => void): Uint8Array => {
      const e = w.envelope();
      f(e);
      return w.bytes(e);
    };
    const cases: [string, Uint8Array][] = [
      ["text_differs", mk((e) => (e.parts[0].text = "<?php\n// altered\n"))],
      ["hash_mismatch", mk((e) => (e.parts[0].sha256Lf = sha256Hex("other")))],
      ["count_mismatch", mk((e) => e.parts.splice(1, 1))],
      ["count_mismatch", mk((e) => e.parts.splice(2, 0, { partId: "p5", type: "source_file", path: SOURCE_A.path, sha256Lf: sha256Hex(SOURCE_A.text), text: SOURCE_A.text }))],
      ["path_mismatch", mk((e) => ([e.parts[0], e.parts[1]] = [e.parts[1], e.parts[0]]))],
    ];
    for (const [name, bytes] of cases) {
      const { audit: a, request } = audit(w, bytes);
      expect(a.result, name).toBe("blocked");
      expect(request).toBeUndefined();
      expect(outcome(a, "A04"), name).toBe("fail");
      expect(detail(a, "A04"), name).toBe(name);
      // The recorded path is the manifest's, so the payload cannot choose what is written.
      expect(a.matches.filter((m) => m.checkId === "A04").every((m) => [SOURCE_A.path, SOURCE_B.path].includes(m.matchId))).toBe(true);
    }
  });

  it("A05: a source path that is not an exact allowlist path (R2.5)", () => {
    const text = "<?php\n// fictional other file\n";
    const w = makeWorld({ sources: [{ path: "legacy/src/other.php", text }] });
    const { audit: a, request } = audit(w, w.bytes(w.envelope()));
    expectBlockedOnly(a, request, "A05");
    expect(a.matches).toContainEqual({ checkId: "A05", matchId: "legacy/src/other.php" });
    expect(detail(a, "A05")).toBe("path_not_allowlisted");
    const near = makeWorld({ sources: [{ path: "legacy/src/utils.php/", text }] });
    expect(audit(near, near.bytes(near.envelope())).audit.result).toBe("blocked");
  });

  it("A05: a restricted path prefix outside the text of a source file, in any case or slash form, but not inside source text", () => {
    for (const content of [{ note: `see ${RESTRICTED_PREFIX}file.json` }, { [RESTRICTED_PREFIX.toUpperCase()]: 1 }, { note: RESTRICTED_PREFIX.replaceAll("/", "\\") }]) {
      const w = withContent(content as Json);
      const { audit: a, request } = audit(w, w.bytes(w.envelope()));
      expectBlockedOnly(a, request, "A05");
      expect(a.matches).toContainEqual({ checkId: "A05", matchId: "restricted_path_prefix:0" });
    }
    const srcText = `<?php\n// mentions ${RESTRICTED_PREFIX} in a comment\n`;
    const ok = makeWorld({ sources: [{ path: SOURCE_A.path, text: srcText }, SOURCE_B] });
    expect(audit(ok, ok.bytes(ok.envelope())).audit.result).toBe("pass");
  });

  it("A06: a canary or a decoy anywhere, found by identifier, also in another letter case (R2.4)", () => {
    for (const [value, id] of [[CANARY_VALUE, "canary-1"], [DECOY_VALUE, "decoy-1"], [CANARY_VALUE.toLowerCase(), "canary-1"]] as const) {
      const w = withContent({ note: `prefix ${value} suffix` });
      const { audit: a, request } = audit(w, w.bytes(w.envelope()));
      expectBlockedOnly(a, request, "A06");
      expect(a.matches).toEqual([{ checkId: "A06", matchId: id }]);
    }
    const inSource = makeWorld({ sources: [{ path: SOURCE_A.path, text: `<?php // ${CANARY_VALUE}\n` }, SOURCE_B] });
    const r = audit(inSource, inSource.bytes(inSource.envelope()));
    expect(r.audit.result).toBe("blocked");
    expect(r.audit.matches).toEqual([{ checkId: "A06", matchId: "canary-1" }]);
  });

  it("A07: restricted-content fingerprints are found in any string and across source text, by fingerprint id (R2.8)", () => {
    for (let i = 0; i < RESTRICTED_TEXTS.length; i++) {
      const w = withContent({ note: `copied: ${RESTRICTED_TEXTS[i]} (end)` });
      const { audit: a, request } = audit(w, w.bytes(w.envelope()));
      expectBlockedOnly(a, request, "A07");
      expect(a.matches).toEqual([{ checkId: "A07", matchId: `fp-${i + 1}` }]);
    }
    // line breaks and case do not hide it
    const w = withContent({ note: (RESTRICTED_TEXTS[0] as string).toUpperCase().replaceAll(" ", "\n  ") });
    expect(audit(w, w.bytes(w.envelope())).audit.matches).toEqual([{ checkId: "A07", matchId: "fp-1" }]);
    // fewer than six consecutive tokens of it are not enough
    const short = withContent({ note: (RESTRICTED_TEXTS[0] as string).split(" ").slice(0, 5).join(" ") });
    expect(audit(short, short.bytes(short.envelope())).audit.result).toBe("pass");
  });

  it("A08: a credential value, found by variable name (R19.7)", () => {
    const w = withContent({ note: `token ${SECRET_VALUE}` });
    const { audit: a, request } = audit(w, w.bytes(w.envelope()));
    expectBlockedOnly(a, request, "A08");
    expect(a.matches).toEqual([{ checkId: "A08", matchId: SECRET_NAME }]);
    const empty = makeWorld({ secrets: [{ name: "EMPTY", value: "" }] });
    expect(audit(empty, empty.bytes(empty.envelope())).audit.result).toBe("pass");
  });

  it("A09: SharedArrayBuffer input is blocked with the detail shared_array_buffer and no check runs on it", () => {
    const w = makeWorld();
    const good = w.bytes(w.envelope());
    const shared = new Uint8Array(new SharedArrayBuffer(good.length));
    shared.set(good);
    const { audit: a, request } = audit(w, shared);
    expect(a.result).toBe("blocked");
    expect(request).toBeUndefined();
    expect(outcome(a, "A09")).toBe("fail");
    expect(detail(a, "A09")).toBe("shared_array_buffer");
    for (const id of ["A02", "A03", "A04", "A05", "A06", "A07", "A08"] as const) expect(outcome(a, id)).toBe("not_run");
    expect(a.payloadSha256).toBe(sha256Hex(good));
    // a view over part of a normal buffer is fine
    const big = new Uint8Array(good.length + 8);
    big.set(good, 4);
    expect(audit(w, big.subarray(4, 4 + good.length)).audit.result).toBe("pass");
  });

  it("A09: input that is not a Uint8Array is blocked, and nothing throws", () => {
    const w = makeWorld();
    for (const bad of ["text", null, undefined, [1, 2], new Uint16Array(4), {}]) {
      const { audit: a, request } = audit(w, bad as never);
      expect(a.result).toBe("blocked");
      expect(request).toBeUndefined();
      expect(detail(a, "A09")).toBe("not_bytes");
    }
  });

  it("an unknown request kind blocks (A02)", () => {
    const w = makeWorld();
    const { audit: a, request } = audit(w, w.bytes(w.envelope()), "tool_call" as never);
    expect(a.result).toBe("blocked");
    expect(request).toBeUndefined();
    expect(detail(a, "A02")).toBe("unknown_kind");
  });

  it("a check that throws is a failed check, not an exception (an incomplete check blocks, R2.9)", () => {
    const w = makeWorld();
    const ctx = { ...w.ctx, lookupRecord: () => { throw new Error(`boom ${CANARY_VALUE}`); } };
    const { audit: a, request } = auditPayload(w.bytes(w.envelope()), KIND, w.cfg, ctx);
    expect(a.result).toBe("blocked");
    expect(request).toBeUndefined();
    expect(detail(a, "A03")).toBe("check_error");
    expect(JSON.stringify(a.checks)).not.toContain("boom");
  });
});

describe("auditPayload: results hold identifiers and fixed codes, never sensitive values (R2.12)", () => {
  it("a blocked result contains no canary, decoy, secret or restricted text, and withholds the audited bytes when sensitive content matched", () => {
    const content = { a: CANARY_VALUE, b: DECOY_VALUE, c: SECRET_VALUE, d: RESTRICTED_TEXTS[0], e: `${RESTRICTED_PREFIX}x` };
    const w = withContent(content);
    const { audit: a } = audit(w, w.bytes(w.envelope()));
    expect(failed(a)).toEqual(["A05", "A06", "A07", "A08"]);
    expect(a.bytesWithheld).toBe(true);
    expect(a.auditedBytes).toBeUndefined();
    const text = JSON.stringify(a);
    for (const secret of [CANARY_VALUE, DECOY_VALUE, SECRET_VALUE, RESTRICTED_TEXTS[0] as string, RESTRICTED_PREFIX]) expect(text).not.toContain(secret);
    expect(a.matches.map((m) => m.matchId).sort()).toEqual(["canary-1", "decoy-1", "fp-1", SECRET_NAME, "restricted_path_prefix:0"].sort());
    expect(a.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("a payload-derived path that contains a sensitive value is redacted in the result", () => {
    const text = "<?php\n// fictional\n";
    const w = makeWorld({ sources: [{ path: `legacy/${CANARY_VALUE}.php`, text }] });
    const { audit: a } = audit(w, w.bytes(w.envelope()));
    expect(a.result).toBe("blocked");
    expect(JSON.stringify(a)).not.toContain(CANARY_VALUE);
    expect(a.matches).toContainEqual({ checkId: "A05", matchId: "[redacted]" });
  });

  it("keeps the audited bytes for a structural block (nothing sensitive matched)", () => {
    const w = makeWorld();
    const e = w.envelope();
    e.parts[0].text = "<?php\n// altered\n";
    const bytes = w.bytes(e);
    const { audit: a } = audit(w, bytes);
    expect(a.result).toBe("blocked");
    expect(a.bytesWithheld).toBe(false);
    expect(Buffer.from(a.auditedBytes as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
  });

  it("is deterministic: the same inputs give the same result (apart from the request object)", () => {
    const w = makeWorld();
    const bytes = w.bytes(w.envelope());
    const a = audit(w, bytes).audit;
    const b = audit(w, bytes).audit;
    expect(JSON.stringify({ ...a, auditedBytes: undefined })).toBe(JSON.stringify({ ...b, auditedBytes: undefined }));
  });

  it("the audit configuration tokenizer must be the shared one, and its sha256 is the hash of its bytes", () => {
    const bytes = configBytes();
    const r = parseAuditConfig(bytes);
    expect(r.ok && r.sha256).toBe(sha256Hex(bytes));
    expect(parseAuditConfig(configBytes({ tokenizer: "other" })).ok).toBe(false);
  });

  it("does not use the audited record kind to vouch for content: a record id of another Run record still must match its hash and content", () => {
    const w = makeWorld();
    w.records.set("rec-000008", { kind: "hypothesis_revision", sha256: sha256Hex(canonicalJson({ x: 1 })), canonicalJson: canonicalJson({ x: 1 }) });
    const e = w.envelope();
    e.parts[2].recordId = "rec-000008";
    expect(audit(w, w.bytes(e)).audit.result).toBe("blocked");
    expect(RECORD_ID).toBe("rec-000007");
  });
});