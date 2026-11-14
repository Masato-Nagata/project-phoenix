// Masking unit tests (task 2.12; R10.2, R10.12; design "Masking decisions", C2-1 to C2-4, C2-6).
// Expected values are written by hand. Neutral names only.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MASK_TOKEN, isPathMasked, maskConfigHash, maskJson, maskedPrefixLength, validateMaskConfig, type Json } from "../src/index.js";
import { cfgOf, deepFreeze } from "./helpers/compareFixtures.js";

const T = "<masked>";

describe("the mask token is a fixed constant (C2-1)", () => {
  it("is the string <masked>", () => {
    expect(MASK_TOKEN).toBe(T);
  });

  it("cannot be set by a configuration: a token key is refused and maskJson ignores it", () => {
    const r = validateMaskConfig({ paths: ["a"], token: "XXX" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.join(" ")).toContain("not configurable");
    // Even when a caller hands maskJson an object with a token property, the constant is used.
    const withToken = { paths: ["a"], token: "XXX" } as unknown as { paths: string[] };
    expect(maskJson({ a: 1, b: 2 }, withToken)).toEqual({ a: T, b: 2 });
  });
});

describe("validateMaskConfig (C2-4)", () => {
  it("accepts the documented path syntax, with a leading index and [*]", () => {
    for (const p of ["a", "a.b", "a[0]", "a[*]", "a[*].b_c", "[0]", "[*]", "[*].id", "a.b[12].c", "_x"]) {
      expect(validateMaskConfig({ paths: [p] }).ok, p).toBe(true);
    }
    expect(validateMaskConfig({ paths: [] }).ok).toBe(true);
  });

  it("refuses anything else, $status included", () => {
    const bad = ["", "$status", "a.", ".a", "a..b", "a[", "a[]", "a[x]", "a[01]", "a[00001]", "a b", "a[*", "1a", "a.1", "a-b", "a/b", "a[-1]", "*", "a.*", "x".repeat(129)];
    for (const p of bad) expect(validateMaskConfig({ paths: [p] }).ok, JSON.stringify(p)).toBe(false);
    for (const raw of [undefined, null, 5, "x", [], { paths: "a" }, { paths: [1] }, { paths: [null] }, {}, { paths: ["a"], extra: 1 }]) {
      expect(validateMaskConfig(raw).ok, JSON.stringify(raw)).toBe(false);
    }
    expect(validateMaskConfig({ paths: Array.from({ length: 65 }, (_, i) => `a${i}`) }).ok).toBe(false);
  });

  it("returns a frozen copy", () => {
    const raw = { paths: ["a"] };
    const r = validateMaskConfig(raw);
    expect(r.ok).toBe(true);
    if (r.ok) {
      raw.paths.push("b");
      expect(r.value.paths).toEqual(["a"]);
      expect(Object.isFrozen(r.value)).toBe(true);
    }
  });
});

describe("maskConfigHash (C2-4)", () => {
  const sha = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

  it("is the SHA-256 of the canonical JSON of the sorted, de-duplicated paths", () => {
    expect(maskConfigHash(cfgOf("b", "a"))).toBe(sha('{"paths":["a","b"]}'));
    expect(maskConfigHash(cfgOf("a", "b"))).toBe(sha('{"paths":["a","b"]}'));
    expect(maskConfigHash(cfgOf("b", "a", "b", "a"))).toBe(sha('{"paths":["a","b"]}'));
    expect(maskConfigHash(cfgOf())).toBe(sha('{"paths":[]}'));
    expect(maskConfigHash(cfgOf("a[*].b", "a"))).toBe(sha('{"paths":["a","a[*].b"]}'));
  });

  it("differs when the set of paths differs, and is 64 lowercase hex characters", () => {
    expect(maskConfigHash(cfgOf("a"))).not.toBe(maskConfigHash(cfgOf("b")));
    expect(maskConfigHash(cfgOf("a"))).not.toBe(maskConfigHash(cfgOf("a", "b")));
    expect(maskConfigHash(cfgOf("a"))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("maskJson", () => {
  it("replaces values at keys, nested keys, indexes, and wildcards", () => {
    const v: Json = { id: 7, created: "t", items: [{ id: 1, n: "x" }, { id: 2, n: "y" }], meta: { at: "t2", keep: true } };
    expect(maskJson(v, cfgOf("created"))).toEqual({ id: 7, created: T, items: [{ id: 1, n: "x" }, { id: 2, n: "y" }], meta: { at: "t2", keep: true } });
    expect(maskJson(v, cfgOf("meta.at", "items[1].n"))).toEqual({ id: 7, created: "t", items: [{ id: 1, n: "x" }, { id: 2, n: T }], meta: { at: T, keep: true } });
    expect(maskJson(v, cfgOf("items[*].id"))).toEqual({ id: 7, created: "t", items: [{ id: T, n: "x" }, { id: T, n: "y" }], meta: { at: "t2", keep: true } });
    expect(maskJson(v, cfgOf("items[*]"))).toEqual({ id: 7, created: "t", items: [T, T], meta: { at: "t2", keep: true } });
    expect(maskJson([{ a: 1 }, { a: 2 }], cfgOf("[*].a"))).toEqual([{ a: T }, { a: T }]);
    expect(maskJson([5, 6], cfgOf("[1]"))).toEqual([5, T]);
  });

  it("can mask a value of any type, the root included", () => {
    expect(maskJson({ a: null, b: [1], c: { d: 1 }, e: false, f: 0 }, cfgOf("a", "b", "c", "e", "f"))).toEqual({ a: T, b: T, c: T, e: T, f: T });
    expect(maskJson("x", cfgOf("a"))).toBe("x");
  });

  it("never creates a path that does not exist (R10.2)", () => {
    expect(maskJson({ a: 1 }, cfgOf("b"))).toEqual({ a: 1 });
    expect(Object.keys(maskJson({ a: 1 }, cfgOf("b.c")) as object)).toEqual(["a"]);
    expect(maskJson({ a: 1 }, cfgOf("a.b"))).toEqual({ a: 1 }); // a is a number
    expect(maskJson({ a: [1] }, cfgOf("a[3]"))).toEqual({ a: [1] }); // index beyond the end
    expect(maskJson({ a: [] }, cfgOf("a[*]", "a[*].x"))).toEqual({ a: [] }); // nothing to match
    expect(maskJson({ a: { x: 1 } }, cfgOf("a[*]"))).toEqual({ a: { x: 1 } }); // a wildcard does not match a key
    expect(maskJson({ a: [1] }, cfgOf("a.x"))).toEqual({ a: [1] }); // a key does not match an index
    expect(maskJson([1], cfgOf("a"))).toEqual([1]);
  });

  it("gives the same result for any order of the paths and for repeated paths (parent and child)", () => {
    const v: Json = { a: { b: 1, c: 2 }, l: [{ x: 1, y: 2 }, { x: 3, y: 4 }] };
    const sets = [["a", "a.b"], ["a.b", "a"], ["a", "a.b", "a"], ["l[*]", "l[0].x"], ["l[0].x", "l[*]"], ["l[0].x", "l[*].y", "l[*]"]];
    const expected = [{ a: T, l: v.l }, { a: T, l: v.l }, { a: T, l: v.l }, { a: v.a, l: [T, T] }, { a: v.a, l: [T, T] }, { a: v.a, l: [T, T] }];
    sets.forEach((s, i) => expect(maskJson(v, cfgOf(...s)), s.join(",")).toEqual(expected[i]));
    expect(maskJson(v, cfgOf("a.b", "a.c"))).toEqual({ a: { b: T, c: T }, l: v.l });
  });

  it("is idempotent", () => {
    const v: Json = { a: { b: 1 }, l: [{ x: 1 }, { x: 2 }, 3], s: "<masked>" };
    for (const paths of [["a"], ["a.b"], ["l[*].x"], ["l[*]", "a.b"], ["s"], ["zzz"], []]) {
      const once = maskJson(v, cfgOf(...paths));
      expect(maskJson(once, cfgOf(...paths)), paths.join(",")).toEqual(once);
    }
  });

  it("does not modify its input and shares no node with the result", () => {
    const v = deepFreeze({ a: { b: [1, { c: 2 }] }, d: 3 });
    const r = maskJson(v, cfgOf("d")) as { a: { b: unknown[] } };
    expect(r).toEqual({ a: { b: [1, { c: 2 }] }, d: T });
    expect(r.a).not.toBe(v.a);
    expect(r.a.b).not.toBe(v.a.b);
    expect(v).toEqual({ a: { b: [1, { c: 2 }] }, d: 3 });
  });

  it("keeps a key named __proto__ as an ordinary key", () => {
    const v = JSON.parse('{"__proto__": {"x": 1}, "a": 1}') as Json;
    const r = maskJson(v, cfgOf("a"));
    expect(Object.keys(r as object)).toEqual(["__proto__", "a"]);
    expect(Object.getPrototypeOf(r)).toBe(Object.prototype);
  });

  it("is not a redaction tool: a value that is not at a configured path stays as it is (C2-6)", () => {
    const v: Json = { token: "secret-looking-value", note: "value with a key-like text", created_at: "t" };
    const r = maskJson(v, cfgOf("created_at")) as Record<string, Json>;
    expect(r["token"]).toBe("secret-looking-value");
    expect(r["note"]).toBe("value with a key-like text");
    expect(r["created_at"]).toBe(T);
  });

  it("refuses a value nested deeper than 64 levels instead of leaving it unmasked", () => {
    let deep: Json = 1;
    for (let i = 0; i < 70; i += 1) deep = { a: deep };
    expect(() => maskJson(deep, cfgOf("zzz"))).toThrow();
  });
});

describe("isPathMasked: the matching of a concrete predicted path (C2-3)", () => {
  it("masks a path that equals an entry or lies below it", () => {
    expect(isPathMasked("created", cfgOf("created"))).toBe(true);
    expect(isPathMasked("meta.at", cfgOf("meta"))).toBe(true);
    expect(isPathMasked("meta.at.deep", cfgOf("meta"))).toBe(true);
    expect(isPathMasked("items[0].id", cfgOf("items[*]"))).toBe(true);
    expect(isPathMasked("items[3].id", cfgOf("items[*].id"))).toBe(true);
    expect(isPathMasked("items[3]", cfgOf("items[3]"))).toBe(true);
    expect(isPathMasked("items[03]", cfgOf("items[3]"))).toBe(true); // the same index
  });

  it("gives the length of the outermost masked node", () => {
    expect(maskedPrefixLength("a.b.c", cfgOf("a.b", "a.b.c"))).toBe(2);
    expect(maskedPrefixLength("a.b.c", cfgOf("a.b.c", "a"))).toBe(1);
    expect(maskedPrefixLength("items[2].id", cfgOf("items[*].id"))).toBe(3);
    expect(maskedPrefixLength("a", cfgOf("a.b"))).toBeUndefined();
  });

  it("does not mask a path above an entry, a sibling, another index, or a different kind of segment", () => {
    expect(isPathMasked("meta", cfgOf("meta.at"))).toBe(false);
    expect(isPathMasked("meta.other", cfgOf("meta.at"))).toBe(false);
    expect(isPathMasked("items[1].id", cfgOf("items[0].id"))).toBe(false);
    expect(isPathMasked("items", cfgOf("items[*]"))).toBe(false);
    expect(isPathMasked("items.id", cfgOf("items[*].id"))).toBe(false);
    expect(isPathMasked("a", cfgOf("A"))).toBe(false); // case-sensitive
    expect(isPathMasked("a", cfgOf())).toBe(false);
    expect(isPathMasked("not a path", cfgOf("a"))).toBe(false);
  });
});