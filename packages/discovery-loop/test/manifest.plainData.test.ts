// Task 4.6 W3-A: the internal helper module of the Run_Manifest section builders (`src/manifest/plainData.ts`). Deterministic and offline.
// **Validates: Requirements 12.13, 22.3**
import { describe, expect, it } from "vitest";
import { SHA256_HEX, ZERO_SHA256, copyPlainJson, dataValue, hasExactKeys, isPlainDataObject, sectionFail } from "../src/manifest/plainData.js";

describe("isPlainDataObject", () => {
  it("accepts plain data objects, including a null prototype, and refuses everything else", () => {
    expect(isPlainDataObject({})).toBe(true);
    expect(isPlainDataObject({ a: 1 })).toBe(true);
    expect(isPlainDataObject(Object.create(null))).toBe(true);
    for (const v of [null, undefined, 1, "x", [], () => 1, new Map(), new Date(0)]) expect(isPlainDataObject(v)).toBe(false);
  });
  it("refuses an accessor (and never runs it), a symbol key, a foreign prototype and a non-enumerable property", () => {
    let ran = false;
    const g = {};
    Object.defineProperty(g, "a", { enumerable: true, get: () => ((ran = true), 1) });
    expect(isPlainDataObject(g)).toBe(false);
    expect(ran).toBe(false);
    expect(isPlainDataObject({ [Symbol("s")]: 1 })).toBe(false);
    class K {
      a = 1;
    }
    expect(isPlainDataObject(new K())).toBe(false);
    const h = {};
    Object.defineProperty(h, "a", { enumerable: false, value: 1 });
    expect(isPlainDataObject(h)).toBe(false);
  });
});

describe("dataValue", () => {
  it("returns an own data value, and reports an absent or accessor property as not present without running it", () => {
    let ran = false;
    const o = { a: 1 };
    Object.defineProperty(o, "g", { enumerable: true, get: () => ((ran = true), 2) });
    expect(dataValue(o, "a")).toEqual({ present: true, value: 1 });
    expect(dataValue(o, "missing")).toEqual({ present: false });
    expect(dataValue(o, "g")).toEqual({ present: false });
    expect(ran).toBe(false);
    expect(dataValue({}, "toString")).toEqual({ present: false }); // an inherited property is not an own one
  });
});

describe("hasExactKeys", () => {
  it("is true only for the same key set, in any order", () => {
    expect(hasExactKeys({ a: 1, b: 2 }, ["b", "a"])).toBe(true);
    expect(hasExactKeys({ a: 1 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({ a: 1, b: 2, c: 3 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({ a: 1, c: 2 }, ["a", "b"])).toBe(false);
    expect(hasExactKeys({}, [])).toBe(true);
  });
});

describe("sectionFail", () => {
  it("carries the code, and the index only when one is given", () => {
    expect(sectionFail("x_code")).toEqual({ ok: false, error: { code: "x_code" } });
    expect(sectionFail("x_code", 0)).toEqual({ ok: false, error: { code: "x_code", index: 0 } });
  });
});

describe("constants", () => {
  it("SHA256_HEX is 64 lowercase hex characters and ZERO_SHA256 matches it", () => {
    expect(SHA256_HEX.test("a".repeat(64))).toBe(true);
    for (const bad of ["A".repeat(64), "a".repeat(63), "a".repeat(65), "g".repeat(64), "a".repeat(64) + "\n"]) expect(SHA256_HEX.test(bad)).toBe(false);
    expect(SHA256_HEX.test(ZERO_SHA256)).toBe(true);
  });
});

describe("copyPlainJson", () => {
  it("copies plain JSON deeply and never aliases the input", () => {
    const input = { a: [1, { b: "x" }, null, true], c: { d: 1.5 } };
    const out = copyPlainJson(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
    ((out as { a: unknown[] }).a[1] as { b: string }).b = "changed";
    expect(input.a[1]).toEqual({ b: "x" });
  });
  it("copies the JSON scalars, including null (which is a value, not a failure)", () => {
    expect(copyPlainJson(null)).toBeNull();
    expect(copyPlainJson("s")).toBe("s");
    expect(copyPlainJson(0)).toBe(0);
    expect(copyPlainJson(false)).toBe(false);
  });
  it("accepts a deeply frozen input", () => {
    const f = Object.freeze({ a: Object.freeze([1, 2]) });
    expect(copyPlainJson(f)).toEqual({ a: [1, 2] });
  });
  it("refuses undefined, functions, symbols, bigint, non-finite and unsafe numbers, accessors, symbol keys, holes, extra array properties and __proto__", () => {
    let ran = false;
    const g = {};
    Object.defineProperty(g, "a", { enumerable: true, get: () => ((ran = true), 1) });
    const arrExtra: unknown[] = [1];
    (arrExtra as unknown as Record<string, unknown>)["x"] = 1;
    // eslint-disable-next-line no-sparse-arrays
    const holes = [1, , 3];
    const proto = JSON.parse('{"__proto__": 1}') as unknown;
    const bad: unknown[] = [undefined, () => 1, Symbol("s"), 1n, NaN, Infinity, 2 ** 60, g, { [Symbol("s")]: 1 }, { a: undefined }, holes, arrExtra, proto, new Map(), new Date(0)];
    for (const v of bad) expect(copyPlainJson(v), String(typeof v)).toBeUndefined();
    expect(ran).toBe(false);
  });
  it("refuses a nesting deeper than 32 levels and accepts one at the limit", () => {
    const nest = (n: number): unknown => (n === 0 ? 1 : { a: nest(n - 1) });
    expect(copyPlainJson(nest(31))).not.toBeUndefined();
    expect(copyPlainJson(nest(40))).toBeUndefined();
  });
});