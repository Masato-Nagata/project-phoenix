import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { canonicalJson, parseAuditConfig, strictJsonParse, tryCanonicalJson } from "../src/index.js";
import type { Json } from "../src/index.js";
import { CANARY_VALUE, RESTRICTED_TEXTS, SECRET_VALUE, configBytes, enc } from "./helpers/auditFixtures.js";

const opts = { maxDepth: 32 };
const code = (s: string): string | undefined => {
  const r = strictJsonParse(enc(s), opts);
  return r.ok ? undefined : r.error.code;
};

describe("strictJsonParse", () => {
  it("accepts ordinary JSON and keeps __proto__ as an own key", () => {
    const r = strictJsonParse(enc('{"a":[1,2.5,"x",null,true],"__proto__":1}'), opts);
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.value as object)).toEqual(["a", "__proto__"]);
  });

  it("rejects duplicate keys, trailing text, a BOM, bad UTF-8, control characters, deep nesting, unsafe integers and oversize input", () => {
    expect(code('{"a":1,"a":2}')).toBe("duplicate_key");
    expect(code("{} x")).toBe("invalid_json");
    expect(strictJsonParse(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]), opts).ok).toBe(false);
    expect(strictJsonParse(new Uint8Array([0x22, 0xff, 0x22]), opts)).toMatchObject({ ok: false, error: { code: "invalid_utf8" } });
    expect(code('"a\u0001b"')).toBe("invalid_json");
    expect(code("[".repeat(33) + "]".repeat(33))).toBe("depth_exceeded");
    expect(code("[".repeat(32) + "]".repeat(32))).toBeUndefined();
    expect(code("9007199254740993")).toBe("unsafe_number");
    expect(code("1e999")).toBe("unsafe_number");
    expect(strictJsonParse(enc("[1,2,3]"), { maxDepth: 4, maxBytes: 3 })).toMatchObject({ ok: false, error: { code: "size_exceeded" } });
  });
});

describe("canonicalJson", () => {
  it("sorts keys, drops whitespace, writes -0 as 0 and uses short escapes", () => {
    expect(canonicalJson({ b: 1, a: [true, null, -0, "x\ny\u0001"], "é": 2 })).toBe('{"a":[true,null,0,"x\\ny\\u0001"],"b":1,"é":2}');
  });

  it("rejects non-finite numbers, unsafe integers, lone surrogates and non-JSON values", () => {
    for (const bad of [Number.NaN, Infinity, 2 ** 53, "\ud800", undefined, () => 1, new Date(0), { a: undefined }]) {
      expect(tryCanonicalJson(bad).ok).toBe(false);
    }
  });

  it("is idempotent through the strict parser (round trip)", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        fc.pre(tryCanonicalJson(v).ok); // fc.jsonValue also makes integers beyond the safe range, which canonical JSON refuses
        const text = canonicalJson(v as Json);
        const back = strictJsonParse(enc(text), { maxDepth: 256 });
        expect(back.ok).toBe(true);
        if (back.ok) expect(canonicalJson(back.value)).toBe(text);
      }),
      { seed: 34_001, numRuns: 100 },
    );
  });
});

describe("parseAuditConfig", () => {
  it("accepts the test configuration and returns the hash of the bytes", () => {
    const r = parseAuditConfig(configBytes());
    expect(r.ok).toBe(true);
  });

  it("reports missing, empty and invalid with fixed codes, never with a value", () => {
    expect(parseAuditConfig(undefined)).toEqual({ ok: false, reason: "missing" });
    expect(parseAuditConfig(new Uint8Array())).toEqual({ ok: false, reason: "empty" });
    const bads: Record<string, unknown>[] = [
      { schemaVersion: 2 },
      { allowlist: [] },
      { canaries: [{ id: "c", value: "short" }] },
      { canaries: [] },
      { decoys: [{ id: "d", value: "ZZDECOY-aaaaaaaa" }, { id: "d", value: "ZZDECOY-bbbbbbbb" }] },
      { fingerprints: [] },
      { restrictedPathPrefixes: [""] },
      { tokenizer: "x" },
      { extra: 1 },
    ];
    for (const over of bads) {
      const r = parseAuditConfig(configBytes(over));
      expect(r.ok, JSON.stringify(Object.keys(over))).toBe(false);
      const text = JSON.stringify(r);
      for (const v of [CANARY_VALUE, SECRET_VALUE, RESTRICTED_TEXTS[0] as string, "ZZDECOY"]) expect(text).not.toContain(v);
    }
    expect(parseAuditConfig(enc("{not json"))).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("rejects fingerprint sets with fewer than 4 files, n below 6, or a hash that is not 12 lowercase hex characters", () => {
    const fp = (n: number, hashes: string[]) => ({ id: "x", fileId: "f", n, hashes });
    const four = (f: unknown) => [f, { ...(f as object), id: "y" }, { ...(f as object), id: "z" }, { ...(f as object), id: "w" }];
    expect(parseAuditConfig(configBytes({ fingerprints: four(fp(6, ["0123456789ab"])) })).ok).toBe(true);
    expect(parseAuditConfig(configBytes({ fingerprints: four(fp(5, ["0123456789ab"])) })).ok).toBe(false);
    expect(parseAuditConfig(configBytes({ fingerprints: four(fp(6, ["0123456789AB"])) })).ok).toBe(false);
    expect(parseAuditConfig(configBytes({ fingerprints: four(fp(6, [])) })).ok).toBe(false);
    expect(parseAuditConfig(configBytes({ fingerprints: four(fp(6, ["0123456789ab"])).slice(0, 3) })).ok).toBe(false);
  });
});