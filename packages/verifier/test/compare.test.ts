// Comparator unit tests (task 2.12; R10.1 to R10.13; design "Masking decisions" and "Comparator decisions").
// Expected values are written by hand. Neutral names only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MASK_TOKEN, NO_MASK_CONFIG_HASH, compare, deriveMaskNote, maskConfigHash, maskPredictedValue, type Json, type MaskConfig, type Observation } from "../src/index.js";
import { cfgOf, deepFreeze, jsonResponse, observation, prediction } from "./helpers/compareFixtures.js";

const CFG = cfgOf("created_at", "items[*].id");
const body = { id: 5, name: "x", created_at: "2000-01-01", items: [{ id: 1, tag: "a" }, { id: 2, tag: "b" }], extra: { deep: [1, 2] } };
const maskedBody = { id: 5, name: "x", created_at: MASK_TOKEN, items: [{ id: MASK_TOKEN, tag: "a" }, { id: MASK_TOKEN, tag: "b" }], extra: { deep: [1, 2] } };
const obs = (b: unknown = maskedBody, status = 200) => observation(CFG, [jsonResponse(status, b as never)]);

afterEach(() => vi.useRealTimers());

describe("match and mismatch (R10.3 to R10.7)", () => {
  it("matches when the status and every predicted field are equal; fields that are not named are ignored", () => {
    const r = compare(prediction(200, [{ path: "id", value: 5 }, { path: "items[1].tag", value: "b" }]), obs(), CFG);
    expect(r).toEqual({ experimentId: "exp-1", result: "match", differences: [], maskSha256: maskConfigHash(CFG) });
  });

  it("reports a status difference first, then the field differences in code-point order of the path", () => {
    const r = compare(prediction(201, [{ path: "name", value: "y" }, { path: "id", value: 6 }, { path: "extra.deep[1]", value: 3 }]), obs(), CFG);
    expect(r.result).toBe("mismatch");
    expect(r.differences).toEqual([
      { path: "$status", predicted: 201, observed: 200 },
      { path: "extra.deep[1]", predicted: 3, observed: 2 },
      { path: "id", predicted: 6, observed: 5 },
      { path: "name", predicted: "y", observed: "x" },
    ]);
  });

  it("compares exactly: no coercion, no case folding, no trimming, no tolerance", () => {
    const o = observation(cfgOf(), [jsonResponse(200, { n: 1, s: "Abc", t: " x", z: 0, f: false, nul: null, o: { a: 1 }, l: [1] })]);
    const cases: [string, unknown][] = [["n", "1"], ["n", true], ["n", 1.0000001], ["s", "abc"], ["t", "x"], ["z", false], ["f", 0], ["f", null], ["nul", 0], ["nul", ""], ["o", { a: "1" }], ["l", [1, 2]], ["l", {}]];
    for (const [path, value] of cases) {
      expect(compare(prediction(200, [{ path, value: value as never }]), o, cfgOf()).result, `${path} ${JSON.stringify(value)}`).toBe("mismatch");
    }
    // The same values, written equal, match; object key order does not matter.
    expect(compare(prediction(200, [{ path: "o", value: { a: 1 } }, { path: "n", value: 1 }, { path: "nul", value: null }]), o, cfgOf()).result).toBe("match");
  });

  it("treats a predicted field that is absent from the Observation as a difference with the absent marker (R10.6)", () => {
    const r = compare(prediction(200, [{ path: "missing", value: null }, { path: "items[5].tag", value: "a" }, { path: "name.inner", value: 1 }]), obs(), CFG);
    expect(r.differences).toEqual([
      { path: "items[5].tag", predicted: "a", observed: { $absent: true } },
      { path: "missing", predicted: null, observed: { $absent: true } },
      { path: "name.inner", predicted: 1, observed: { $absent: true } },
    ]);
  });

  it("keeps two differences for a path predicted twice, in the order of the Prediction", () => {
    const r = compare(prediction(200, [{ path: "id", value: 1 }, { path: "id", value: 2 }]), obs(), CFG);
    expect(r.differences.map((d) => d.predicted)).toEqual([1, 2]);
  });

  it("reads a state check when the Prediction targets one", () => {
    const o = observation(CFG, [jsonResponse(200, { a: 1 })], { stateChecks: [jsonResponse(404, { a: 2 })] });
    expect(compare(prediction(404, [{ path: "a", value: 2 }], { list: "stateChecks", index: 0 }), o, CFG).result).toBe("match");
    expect(compare(prediction(200, [{ path: "a", value: 1 }], { list: "stateChecks", index: 0 }), o, CFG).result).toBe("mismatch");
  });

  it("treats a missing response as an absent status and absent fields (a mismatch)", () => {
    const r = compare(prediction(200, [{ path: "a", value: 1 }], { list: "requests", index: 3 }), obs(), CFG);
    expect(r.result).toBe("mismatch");
    expect(r.differences).toEqual([
      { path: "$status", predicted: 200, observed: { $absent: true } },
      { path: "a", predicted: 1, observed: { $absent: true } },
    ]);
  });
});

describe("masking inside the comparison (R10.2, C2)", () => {
  it("masks a predicted field on both sides: any predicted value matches when the path exists", () => {
    const r = compare(prediction(200, [{ path: "created_at", value: "anything at all" }, { path: "items[0].id", value: 12345 }]), obs(), CFG);
    expect(r.result).toBe("match");
  });

  it("masks the body again, so a body that was not masked at capture gives the same result (masking twice is a no-op)", () => {
    const p = prediction(200, [{ path: "created_at", value: "x" }, { path: "id", value: 5 }]);
    expect(compare(p, obs(body), CFG)).toEqual(compare(p, obs(maskedBody), CFG));
  });

  it("treats a path below a masked node as masked: nothing below the token can differ, but the masked node must exist", () => {
    const cfg = cfgOf("meta");
    const o = observation(cfg, [jsonResponse(200, { meta: { at: "t", by: "u" }, id: 1 })]);
    expect(compare(prediction(200, [{ path: "meta.at", value: "x" }, { path: "meta.by.deep", value: 3 }, { path: "id", value: 1 }]), o, cfg).result).toBe("match");
    const without = observation(cfg, [jsonResponse(200, { id: 1 })]);
    expect(compare(prediction(200, [{ path: "meta.at", value: "x" }]), without, cfg).differences).toEqual([{ path: "meta.at", predicted: MASK_TOKEN, observed: { $absent: true } }]);
  });

  it("still requires the masked path to exist in the Observation", () => {
    const o = observation(CFG, [jsonResponse(200, { id: 5 })]);
    const r = compare(prediction(200, [{ path: "created_at", value: "x" }]), o, CFG);
    expect(r.differences).toEqual([{ path: "created_at", predicted: MASK_TOKEN, observed: { $absent: true } }]);
  });

  it("always compares the status code: it cannot be masked, and a status-only mismatch is a mismatch", () => {
    const p = prediction(500, [{ path: "created_at", value: "x" }]);
    const r = compare(p, obs(), CFG);
    expect(r.result).toBe("mismatch");
    expect(r.differences).toEqual([{ path: "$status", predicted: 500, observed: 200 }]);
    expect(compare(prediction(200, [{ path: "created_at", value: "x" }]), obs(), cfgOf("$status")).reason).toBe("mask_config_invalid");
  });

  it("does not use a token from the configuration", () => {
    const withToken = { paths: ["created_at"], token: "Z" } as unknown as MaskConfig;
    const r = compare(prediction(200, [{ path: "created_at", value: "x" }]), observation(CFG, [jsonResponse(200, maskedBody)]), withToken);
    expect(r).toMatchObject({ result: "not_comparable", reason: "mask_config_invalid" });
  });
});

describe("object and list values in a Prediction are masked like the Observation (design Comparator decisions, item 6)", () => {
  const T = MASK_TOKEN;

  it("matches an object value whose masked descendant differs, because both sides are masked", () => {
    const r = compare(prediction(200, [{ path: "items[0]", value: { id: 999, tag: "a" } }, { path: "items", value: [{ id: 0, tag: "a" }, { id: 0, tag: "b" }] }]), obs(), CFG);
    expect(r).toMatchObject({ result: "match", differences: [] });
  });

  it("still compares the other keys inside the object exactly (R10.3), and shows the masked predicted value", () => {
    const r = compare(prediction(200, [{ path: "items[0]", value: { id: 999, tag: "zzz" } }]), obs(), CFG);
    expect(r.result).toBe("mismatch");
    expect(r.differences).toEqual([{ path: "items[0]", predicted: { id: T, tag: "zzz" }, observed: { id: T, tag: "a" } }]);
  });

  it("does not add a masked key that the Prediction lacks: the key sets then differ", () => {
    const r = compare(prediction(200, [{ path: "items[0]", value: { tag: "a" } }]), obs(), CFG);
    expect(r.result).toBe("mismatch");
    expect(r.differences).toEqual([{ path: "items[0]", predicted: { tag: "a" }, observed: { id: T, tag: "a" } }]);
  });

  it("does not add a masked key either when the Observation lacks it: a predicted key that is absent is a difference", () => {
    const cfg = cfgOf("meta.at");
    const o = observation(cfg, [jsonResponse(200, { meta: { by: "u" } })]);
    const r = compare(prediction(200, [{ path: "meta", value: { at: "t", by: "u" } }]), o, cfg);
    expect(r.differences).toEqual([{ path: "meta", predicted: { at: T, by: "u" }, observed: { by: "u" } }]);
    // Neither side has the key: nothing is created, the values are equal.
    expect(compare(prediction(200, [{ path: "meta", value: { by: "u" } }]), o, cfg).result).toBe("match");
  });

  it("applies [*] to array indexes only, never to object keys", () => {
    const cfg = cfgOf("m[*].id");
    const o = observation(cfg, [jsonResponse(200, { m: { a: { id: 1 } }, l: [{ id: 1 }] })]);
    expect(compare(prediction(200, [{ path: "m", value: { a: { id: 2 } } }]), o, cfg).result).toBe("mismatch"); // m is an object: nothing is masked
    expect(compare(prediction(200, [{ path: "m", value: { a: { id: 1 } } }]), o, cfg).result).toBe("match");
    const cfg2 = cfgOf("l[*].id");
    const o2 = observation(cfg2, [jsonResponse(200, { l: [{ id: T }, { id: T }] })]);
    expect(compare(prediction(200, [{ path: "l", value: [{ id: 1 }, { id: 2 }] }]), o2, cfg2).result).toBe("match");
    expect(compare(prediction(200, [{ path: "l", value: [{ id: 1 }] }]), o2, cfg2).result).toBe("mismatch"); // the length is compared
  });

  it("maps an absolute mask path onto the part of the object that the predicted path designates", () => {
    const cfg = cfgOf("a.b.c", "a.x[1]");
    const o = observation(cfg, [jsonResponse(200, { a: { b: { c: T, d: 2 }, x: [0, T, 2] } })]);
    const hit = (path: string, value: Json) => compare(prediction(200, [{ path, value }]), o, cfg);
    expect(hit("a", { b: { c: 9, d: 2 }, x: [0, 9, 2] }).result).toBe("match");
    expect(hit("a.b", { c: 9, d: 2 }).result).toBe("match");
    expect(hit("a.x", [0, 9, 2]).result).toBe("match");
    expect(hit("a.x", [1, 9, 2]).result).toBe("mismatch");
    expect(hit("a.b", { c: 9, d: 3 }).result).toBe("mismatch");
    // A path that is not below any mask entry is unchanged.
    expect(hit("a.b.d", 2).result).toBe("match");
  });

  it("handles a parent and a child path together: the outermost masked node wins, in any order", () => {
    const o = (cfg: MaskConfig) => observation(cfg, [jsonResponse(200, { r: { a: T, z: 3 } })]);
    for (const paths of [["r.a", "r.a.b"], ["r.a.b", "r.a"], ["r.a", "r.a", "r.a.b.c"]]) {
      const cfg = cfgOf(...paths);
      expect(compare(prediction(200, [{ path: "r", value: { a: { b: { c: 1 } }, z: 3 } }]), o(cfg), cfg).result, paths.join()).toBe("match");
    }
  });

  it("masks nested objects at any depth and keeps the rest", () => {
    const cfg = cfgOf("a.b.c");
    const o = observation(cfg, [jsonResponse(200, { a: { b: { c: T, d: [1, { c: 5 }] } } })]);
    expect(compare(prediction(200, [{ path: "a", value: { b: { c: { deep: true }, d: [1, { c: 5 }] } } }]), o, cfg).result).toBe("match");
    expect(compare(prediction(200, [{ path: "a", value: { b: { c: 1, d: [1, { c: 6 }] } } }]), o, cfg).result).toBe("mismatch"); // d[1].c is not masked
  });

  it("does nothing inside the value without a mask entry below the path, and for the empty configuration", () => {
    const o = observation(cfgOf(), [jsonResponse(200, { a: { b: 1 } })]);
    expect(compare(prediction(200, [{ path: "a", value: { b: 2 } }]), o, cfgOf()).result).toBe("mismatch");
    expect(maskPredictedValue({ b: 2 }, "a", cfgOf("zz.b"))).toEqual({ b: 2 });
  });

  it("leaves the Prediction unchanged and returns a copy", () => {
    const value = { id: 1, nested: { id: 2, keep: [1, 2] } };
    const p = deepFreeze(prediction(200, [{ path: "items[0]", value }]));
    const cfg = deepFreeze(cfgOf("items[*].id", "items[*].nested.id"));
    const o = observation(cfg, [jsonResponse(200, { items: [{ id: T, nested: { id: T, keep: [1, 3] } }] })]);
    const r = compare(p, o, cfg);
    expect(r.differences).toEqual([{ path: "items[0]", predicted: { id: T, nested: { id: T, keep: [1, 2] } }, observed: { id: T, nested: { id: T, keep: [1, 3] } } }]);
    expect(value).toEqual({ id: 1, nested: { id: 2, keep: [1, 2] } });
    const shown = r.differences[0]?.predicted as { nested: { keep: unknown } };
    expect(shown.nested.keep).not.toBe(value.nested.keep);
    expect(maskPredictedValue(value as Json, "items[0]", cfg)).not.toBe(value);
  });

  it("shows a copy of the predicted value even when no mask entry applies inside it", () => {
    const value = { id: 1, tag: "q", list: [1] };
    const p = deepFreeze(prediction(200, [{ path: "items[0]", value }]));
    const r = compare(p, obs(), cfgOf("created_at", "items[*].id"));
    const shown = r.differences[0]?.predicted as { list: unknown };
    expect(shown).not.toBe(value);
    expect(shown.list).not.toBe(value.list);
    const copyOf = maskPredictedValue(value, "other", cfgOf("created_at"));
    expect(copyOf).toEqual(value);
    expect((copyOf as { list: unknown }).list).not.toBe(value.list);
  });

  it("returns the token for a value at a masked path, and masking twice changes nothing", () => {
    const cfg = cfgOf("items[*].nested");
    expect(maskPredictedValue({ x: 1 }, "items[2].nested", cfg)).toBe(T);
    expect(maskPredictedValue({ x: 1 }, "items[2].nested.x", cfg)).toBe(T);
    const once = maskPredictedValue({ nested: { x: 1 }, y: 1 }, "items[2]", cfg);
    expect(once).toEqual({ nested: T, y: 1 });
    expect(maskPredictedValue(once, "items[2]", cfg)).toEqual(once);
    expect(() => maskPredictedValue(1, "1bad", cfg)).toThrow();
  });
});

describe("a body that is empty or a JSON scalar (design: documented current behavior)", () => {
  it("an empty body with a predicted field is not_comparable(observation_unparseable), even when the status differs", () => {
    const o = observation(CFG, [{ status: 204, bodyKind: "empty" }]);
    expect(compare(prediction(200, [{ path: "id", value: 1 }]), o, CFG)).toMatchObject({ result: "not_comparable", reason: "observation_unparseable" });
  });

  it("a JSON scalar body is parsed: every predicted path is then absent, a mismatch", () => {
    for (const scalar of [5, "text", true, null]) {
      const o = observation(CFG, [jsonResponse(200, scalar)]);
      const r = compare(prediction(200, [{ path: "id", value: 1 }]), o, CFG);
      expect(r.differences, JSON.stringify(scalar)).toEqual([{ path: "id", predicted: 1, observed: { $absent: true } }]);
      expect(r.result).toBe("mismatch");
    }
  });

  it("a text body with a different status stays not_comparable (R10.9 over R10.6)", () => {
    const o = observation(CFG, [{ status: 502, bodyKind: "text", body: "bad gateway" }]);
    expect(compare(prediction(200, [{ path: "id", value: 1 }]), o, CFG)).toMatchObject({ result: "not_comparable", reason: "observation_unparseable", differences: [] });
  });
});

describe("not_comparable (R10.8, R10.9) and the order of the reasons", () => {
  const p = prediction(200, [{ path: "id", value: 5 }]);

  it("reports the state of the Experiment first", () => {
    for (const outcome of ["not_executed", "timed_out", "aborted"] as const) {
      const r = compare(p, { ...obs(), outcome }, CFG);
      expect(r).toEqual({ experimentId: "exp-1", result: "not_comparable", reason: outcome, differences: [], maskSha256: maskConfigHash(CFG) });
    }
    // The state wins over a missing Prediction and a bad configuration.
    expect(compare(undefined, { ...obs(), outcome: "aborted" }, undefined).reason).toBe("aborted");
  });

  it("reports a missing or malformed Prediction", () => {
    for (const bad of [undefined, null, {}, { target: { list: "requests", index: 0 }, status: 200 }, { target: { list: "other", index: 0 }, status: 200, fields: [] }, prediction(200, [{ path: "1bad", value: 1 }]), { ...p, status: "200" }]) {
      expect(compare(bad as never, obs(), CFG).reason, JSON.stringify(bad)).toBe("prediction_missing");
    }
    expect(compare(undefined, obs(), undefined).reason).toBe("prediction_missing"); // before the configuration
  });

  it("reports a missing or invalid mask configuration, and a configuration whose hash differs from the Observation's (C2-4)", () => {
    for (const bad of [undefined, null, { paths: ["$status"] }, { paths: "a" }, {}]) {
      const r = compare(p, obs(), bad as never);
      expect(r, JSON.stringify(bad)).toMatchObject({ result: "not_comparable", reason: "mask_config_invalid", maskSha256: NO_MASK_CONFIG_HASH });
    }
    // The Observation was captured with another configuration.
    const r = compare(p, obs(), cfgOf("created_at"));
    expect(r).toMatchObject({ result: "not_comparable", reason: "mask_config_invalid", maskSha256: maskConfigHash(cfgOf("created_at")) });
    expect(compare(p, { ...obs(), maskSha256: "0".repeat(64) }, CFG).reason).toBe("mask_config_invalid");
    // The same set of paths in another order or with a repeat is the same configuration.
    expect(compare(p, obs(), cfgOf("items[*].id", "created_at", "items[*].id")).result).toBe("match");
  });

  it("reports a body that cannot be read as structured data when a field is predicted", () => {
    for (const resp of [{ status: 200, bodyKind: "text", body: "ok" }, { status: 200, bodyKind: "empty" }, { status: 200, bodyKind: "json" }] as const) {
      expect(compare(p, observation(CFG, [resp as never]), CFG).reason).toBe("observation_unparseable");
    }
    // A body that is nested too deeply to mask is not comparable either.
    let deep: unknown = 1;
    for (let i = 0; i < 70; i += 1) deep = { a: deep };
    expect(compare(p, observation(CFG, [jsonResponse(200, deep as never)]), CFG).reason).toBe("observation_unparseable");
    expect(compare(p, { experimentId: "e" } as never, CFG).reason).toBe("observation_unparseable");
  });
});

describe("R6.6 is not changed and the note is derived from stored records (C2-5)", () => {
  it("a prediction made only of masked fields is still a match (the outcome rule supports stays untouched)", () => {
    const p = prediction(200, [{ path: "created_at", value: "x" }, { path: "items[1].id", value: 0 }]);
    const r = compare(p, obs(), CFG);
    expect(r.result).toBe("match");
    expect(r.differences).toEqual([]);
    expect(deriveMaskNote(p, CFG)).toEqual({ ok: true, value: { predictedFields: 2, maskedFields: 2, unmaskedFields: 0, statusOnly: true } });
  });

  it("counts masked and unmasked predicted fields from the Prediction and the configuration only", () => {
    const p = prediction(200, [{ path: "created_at", value: "x" }, { path: "id", value: 5 }, { path: "items[0].tag", value: "a" }, { path: "items[0].id", value: 1 }]);
    expect(deriveMaskNote(p, CFG)).toEqual({ ok: true, value: { predictedFields: 4, maskedFields: 2, unmaskedFields: 2, statusOnly: false } });
    expect(deriveMaskNote(p, cfgOf())).toEqual({ ok: true, value: { predictedFields: 4, maskedFields: 0, unmaskedFields: 4, statusOnly: false } });
    expect(deriveMaskNote(deepFreeze(p), deepFreeze(CFG))).toEqual(deriveMaskNote(p, CFG)); // deterministic, no mutation
    expect(deriveMaskNote(p, { paths: ["$status"] }).ok).toBe(false);
    expect(deriveMaskNote(prediction(200, []), CFG)).toEqual({ ok: true, value: { predictedFields: 0, maskedFields: 0, unmaskedFields: 0, statusOnly: false } });
  });
});

describe("purity (R10.10, R10.11)", () => {
  it("does not modify the Prediction, the Observation, or the configuration, and shares nothing with them", () => {
    const p = deepFreeze(prediction(201, [{ path: "items[0]", value: { id: 1, tag: "q" } }, { path: "name", value: "y" }]));
    const o = deepFreeze(obs());
    const c = deepFreeze(cfgOf("created_at"));
    const o2 = deepFreeze(observation(c, [jsonResponse(200, maskedBody)]));
    const r = compare(p, o2, c);
    expect(r.result).toBe("mismatch");
    const diff = r.differences.find((d) => d.path === "items[0]");
    expect(diff?.observed).toEqual(maskedBody.items[0]);
    expect(diff?.observed).not.toBe(maskedBody.items[0]);
    expect(o).toBeDefined();
  });

  it("gives byte-identical results for repeated calls and does not depend on the clock", () => {
    const p = prediction(200, [{ path: "id", value: 6 }, { path: "name", value: "x" }]);
    const o = obs();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2001-01-01T00:00:00Z"));
    const first = JSON.stringify(compare(p, o, CFG));
    vi.setSystemTime(new Date("2040-12-31T23:59:59Z"));
    for (let i = 0; i < 3; i += 1) expect(JSON.stringify(compare(p, o, CFG))).toBe(first);
  });

  it("never throws, whatever it is given", () => {
    for (const bad of [undefined, null, 5, "x", [], {}, { experimentId: 1 }] as unknown[]) {
      expect(() => compare(bad as never, bad as never, bad as never)).not.toThrow();
    }
    const o = { ...obs(), responses: "not a list" } as unknown as Observation;
    expect(compare(prediction(200, [{ path: "id", value: 5 }]), o, CFG).result).toBe("not_comparable");
  });
});