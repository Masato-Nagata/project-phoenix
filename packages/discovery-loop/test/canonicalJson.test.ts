import { describe, expect, it } from "vitest";
import { canonicalBytes, canonicalJson, parseCanonical, tryCanonicalJson, type Json } from "../src/index.js";

const code = (v: unknown): string | undefined => {
  const r = tryCanonicalJson(v);
  return r.ok ? undefined : r.error.code;
};

describe("canonicalJson", () => {
  it("sorts keys by UTF-16 code unit order at every level", () => {
    expect(canonicalJson({ b: 1, a: { z: 1, y: [{ d: 1, c: 2 }] } })).toBe('{"a":{"y":[{"c":2,"d":1}],"z":1},"b":1}');
    // U+FF5E (BMP) sorts after U+1F600 (surrogate pair D83D...) in code-unit order
    expect(canonicalJson({ "\uff5e": 1, "\u{1f600}": 2 })).toBe('{"\u{1f600}":2,"\uff5e":1}');
    expect(canonicalJson({ B: 1, a: 2, "": 3 })).toBe('{"":3,"B":1,"a":2}');
  });

  it("is independent of insertion order and has no whitespace", () => {
    expect(canonicalJson({ a: [1, 2], b: "x y" })).toBe(canonicalJson({ b: "x y", a: [1, 2] }));
    expect(canonicalJson({ a: [1, 2], b: "x y" })).toBe('{"a":[1,2],"b":"x y"}');
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
  });

  it("writes integers plainly, normalizes -0, and uses the shortest float form", () => {
    expect(canonicalJson([5, -3, 0, -0, 9007199254740991, -9007199254740991])).toBe("[5,-3,0,0,9007199254740991,-9007199254740991]");
    expect(canonicalJson([1.5, 0.1, 1e-7])).toBe("[1.5,0.1,1e-7]");
    const parsed = parseCanonical("[5.0,1e2]", { requireCanonical: false });
    expect(parsed.ok && canonicalJson(parsed.value)).toBe("[5,100]");
  });

  it("rejects non-finite and unsafe numbers", () => {
    for (const n of [NaN, Infinity, -Infinity]) expect(code(n)).toBe("unsafe_number");
    expect(code(9007199254740992)).toBe("unsafe_number");
    expect(code(1e21)).toBe("unsafe_number");
  });

  it("rejects non-JSON values and reports the path", () => {
    expect(code(undefined)).toBe("non_json_value");
    expect(code(() => 1)).toBe("non_json_value");
    expect(code(1n)).toBe("non_json_value");
    expect(code(Symbol("s"))).toBe("non_json_value");
    expect(code(new Date(0))).toBe("non_json_value");
    expect(code(new Map())).toBe("non_json_value");
    expect(code({ a: undefined })).toBe("non_json_value");
    expect(code([1, , 3])).toBe("non_json_value"); // eslint-disable-line no-sparse-arrays
    expect(code({ [Symbol("k")]: 1 })).toBe("non_json_value");
    const r = tryCanonicalJson({ "a/b": [1, undefined] });
    expect(!r.ok && r.error.path).toBe("/a~1b/1");
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(code(cyc)).toBe("non_json_value");
    expect(() => canonicalJson(undefined as unknown as Json)).toThrow(/non_json_value/);
  });

  it("escapes with the shortest standard escapes and rejects lone surrogates", () => {
    expect(canonicalJson('"\\\b\f\n\r\t\u0001\u001f/\u007f\u2028')).toBe('"\\"\\\\\\b\\f\\n\\r\\t\\u0001\\u001f/\u007f\u2028"');
    expect(canonicalJson("\u{1f600}é")).toBe('"\u{1f600}é"');
    expect(code("\ud800")).toBe("lone_surrogate");
    expect(code("a\udc00")).toBe("lone_surrogate");
    expect(code({ "\ud800": 1 })).toBe("lone_surrogate");
  });

  it("outputs UTF-8 bytes without a BOM", () => {
    const b = canonicalBytes({ k: "é\u{1f600}" });
    expect(Array.from(b.slice(0, 2))).toEqual([0x7b, 0x22]);
    expect(Buffer.from(b).toString("utf8")).toBe('{"k":"é\u{1f600}"}');
    expect(Array.from(canonicalBytes("é"))).toEqual([0x22, 0xc3, 0xa9, 0x22]);
  });

  it("keeps __proto__ as an ordinary key", () => {
    const parsed = parseCanonical('{"__proto__":1}');
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && canonicalJson(parsed.value)).toBe('{"__proto__":1}');
  });
});

describe("parseCanonical", () => {
  const record: Json = { seq: 1, prevHash: "0".repeat(64), payload: { n: [1, 2.5, null, true], s: "é\n" } };

  it("round-trips a record exactly, as text and as bytes", () => {
    const text = canonicalJson(record);
    const fromText = parseCanonical(text);
    expect(fromText).toEqual({ ok: true, value: record });
    const fromBytes = parseCanonical(canonicalBytes(record));
    expect(fromBytes).toEqual({ ok: true, value: record });
    expect(fromBytes.ok && canonicalJson(fromBytes.value)).toBe(text);
  });

  it("rejects well-formed JSON that is not canonical", () => {
    for (const t of ['{"b":1,"a":2}', '{"a": 1}', "[5.0]", '"\\u0041"', " 1", "1\n"]) {
      const r = parseCanonical(t);
      expect(!r.ok && r.error.code).toBe("not_canonical");
    }
  });

  it("delegates malformed input to the strict parser", () => {
    const cases: [string | Uint8Array, string][] = [
      ['{"a":1,"a":2}', "duplicate_key"],
      ["9007199254740993", "unsafe_number"],
      ["1e999", "unsafe_number"],
      ["{", "invalid_json"],
      ["\ufeff{}", "invalid_json"],
      [new Uint8Array([0x22, 0xff, 0x22]), "invalid_utf8"],
      ["[".repeat(33) + "]".repeat(33), "depth_exceeded"],
      [" ".repeat(262145), "size_exceeded"],
    ];
    for (const [input, expected] of cases) {
      const r = parseCanonical(input);
      expect(!r.ok && r.error.code).toBe(expected);
    }
  });

  it("rejects a lone surrogate escape that parses but cannot be written", () => {
    const r = parseCanonical('"\\ud800"');
    expect(!r.ok && r.error.code).toBe("lone_surrogate");
  });
});
