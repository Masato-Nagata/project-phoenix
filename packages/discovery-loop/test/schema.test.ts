import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  createSchemaValidator,
  DEFAULT_PARSE_LIMITS,
  LOCAL_KEY_PATTERN,
  SCHEMA_NAMES,
  SCHEMAS,
  strictParse,
  type Issue,
} from "../src/index.js";
import { FIXTURE_SETS } from "./fixtures/schemaFixtures.js";

const validator = createSchemaValidator();
const text = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

describe("schema fixtures", () => {
  it("covers every schema except the definitions-only one with one valid and several invalid fixtures", () => {
    const covered = new Set(FIXTURE_SETS.map((s) => s.schema));
    for (const name of SCHEMA_NAMES) {
      if (name === "common") continue; // definitions only; its definitions are exercised through "facts" and every other schema
      expect(covered.has(name), `fixtures for ${name}`).toBe(true);
    }
    for (const set of FIXTURE_SETS) {
      expect(set.valid.length, `${set.schema} valid`).toBeGreaterThanOrEqual(1);
      expect(set.invalid.length, `${set.schema} invalid`).toBeGreaterThanOrEqual(3);
    }
  });

  for (const set of FIXTURE_SETS) {
    describe(set.schema, () => {
      for (const f of set.valid) {
        it(`accepts: ${f.id}`, () => {
          const r = validator.validate(set.schema, f.value);
          expect(r.ok ? [] : r.error).toEqual([]);
        });
      }
      for (const f of set.invalid) {
        it(`rejects: ${f.id}`, () => {
          const r = validator.validate(set.schema, f.value);
          expect(r.ok).toBe(false);
          if (!r.ok) {
            const hit = r.error.some((i: Issue) => i.code === f.expect.code && i.path === f.expect.path);
            expect(hit, JSON.stringify(r.error)).toBe(true);
          }
        });
      }
    });
  }
});

describe("schema definitions", () => {
  // Walks a schema and returns the JSON pointers of object schemas that list `properties` but are not closed.
  function openObjects(node: unknown, path: string, inPartial: boolean, out: string[]): void {
    if (Array.isArray(node)) {
      node.forEach((n, i) => openObjects(n, `${path}/${i}`, inPartial, out));
      return;
    }
    if (typeof node !== "object" || node === null) return;
    const o = node as Record<string, unknown>;
    // `if`, `then`, `else` and `not` carry partial constraints on an object that is closed elsewhere.
    if ("properties" in o && !inPartial && o["additionalProperties"] !== false) out.push(path);
    for (const [k, v] of Object.entries(o)) {
      if (k === "properties" || k === "$defs") {
        for (const [pk, pv] of Object.entries(v as Record<string, unknown>)) openObjects(pv, `${path}/${k}/${pk}`, inPartial, out);
      } else if (k === "enum" || k === "const" || k === "required" || k === "default") {
        continue;
      } else {
        openObjects(v, `${path}/${k}`, inPartial || k === "if" || k === "then" || k === "else" || k === "not", out);
      }
    }
  }

  it("closes every object schema with additionalProperties:false", () => {
    const open: string[] = [];
    for (const name of SCHEMA_NAMES) openObjects(SCHEMAS[name], name, false, open);
    expect(open).toEqual([]);
  });

  it("declares draft 2020-12 and a unique $id for every schema", () => {
    const ids = new Set<string>();
    for (const name of SCHEMA_NAMES) {
      expect(SCHEMAS[name]["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
      ids.add(SCHEMAS[name]["$id"] as string);
    }
    expect(ids.size).toBe(SCHEMA_NAMES.length);
  });

  function propertyNames(node: unknown, out: Set<string>): void {
    if (Array.isArray(node)) return node.forEach((n) => propertyNames(n, out));
    if (typeof node !== "object" || node === null) return;
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (k === "properties") for (const pk of Object.keys(v as object)) out.add(pk);
      propertyNames(v, out);
    }
  }

  it("defines no origin, evidence, evidence_status or approval field in the AI-facing schemas (R23.4)", () => {
    const names = new Set<string>();
    for (const n of ["hypothesis-proposal", "citation", "rule-expression", "experiment", "prediction"] as const) {
      propertyNames(SCHEMAS[n], names);
    }
    for (const reserved of ["origin", "evidence", "evidence_status", "evidenceStatus", "approval", "approvals", "approvalStatus"]) {
      expect(names.has(reserved), reserved).toBe(false);
    }
  });

  it("defines no method, path, URL or header field on a preparation step (R7.3)", () => {
    const prep = (SCHEMAS["experiment"]["$defs"] as Record<string, { properties: Record<string, unknown> }>)["PrepStep"];
    expect(Object.keys(prep!.properties).sort()).toEqual(["bind", "kind", "params"]);
  });

  it("uses a LocalKey pattern equal to the analyzer's name pattern and the analyzer's operator vocabulary", () => {
    const validateSrc = text("../../analyzer/src/expr/validate.ts");
    const m = /NAME_RE = \/(.+)\/;/.exec(validateSrc);
    expect(m?.[1]).toBe(LOCAL_KEY_PATTERN);

    const typesSrc = text("../../analyzer/src/expr/types.ts");
    const list = /EXPR_OPERATORS = \[([^\]]+)\]/.exec(typesSrc);
    const analyzerOps = [...(list?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!).sort();
    const defs = (SCHEMAS["rule-expression"]["$defs"] as Record<string, { properties?: { op?: { const?: string; enum?: string[] } } }>);
    const schemaOps: string[] = [];
    for (const d of Object.values(defs)) {
      const op = d.properties?.op;
      if (op?.const !== undefined) schemaOps.push(op.const);
      if (op?.enum !== undefined) schemaOps.push(...op.enum);
    }
    expect(schemaOps.sort()).toEqual(analyzerOps);
  });
});

describe("agreement with the analyzer's expression validation vectors", () => {
  interface Vectors {
    cases: { id: string; expr: unknown; expect: { valid: boolean; issues?: { code: string }[] } }[];
  }
  const vectors = JSON.parse(text("../../analyzer/test-vectors/expr-validation.json")) as Vectors;
  // These codes are checks that JSON Schema can express. The others (references, aggregate placement,
  // limits) belong to validateExpr only (design: "the schema checks shape only").
  const structural = new Set(["not_object", "missing_field", "unknown_field", "bad_type", "bad_value", "bad_path", "unknown_operator", "arity", "bad_name"]);

  for (const c of vectors.cases) {
    it(`${c.id}`, () => {
      const r = validator.validate("rule-expression", c.expr);
      const codes = (c.expect.issues ?? []).map((i) => i.code);
      const shapeProblem = codes.some((x) => structural.has(x));
      expect(r.ok, JSON.stringify(r.ok ? [] : r.error)).toBe(!shapeProblem);
    });
  }
});

describe("strictParse", () => {
  const ok = (s: string) => strictParse(s);

  it("parses ordinary JSON", () => {
    expect(ok('{"a":[1,2,{"b":null}],"c":"x\\u0041\\n"}')).toEqual({ ok: true, value: { a: [1, 2, { b: null }], c: "xA\n" } });
  });

  it("rejects input over the size limit before parsing, for strings and bytes", () => {
    const limits = { maxBytes: 10, maxDepth: 32 };
    const s = strictParse('{"a":"xxxxxxxx"}', limits);
    expect(s.ok ? "" : s.error.code).toBe("size_exceeded");
    // not valid JSON either, but the size check comes first
    const b = strictParse(new Uint8Array(11).fill(0x7b), limits);
    expect(b.ok ? "" : b.error.code).toBe("size_exceeded");
    expect(strictParse("[1,2,3]", limits).ok).toBe(true);
  });

  it("uses 262144 bytes and 32 levels by default (R17.2, R17.6)", () => {
    expect(DEFAULT_PARSE_LIMITS).toEqual({ maxBytes: 262144, maxDepth: 32 });
    const atLimit = '"' + "x".repeat(262144 - 2) + '"';
    expect(strictParse(atLimit).ok).toBe(true);
    const r = strictParse(atLimit + " ");
    expect(r.ok ? "" : r.error.code).toBe("size_exceeded");
  });

  it("counts size in bytes, not characters", () => {
    const r = strictParse('"éé"', { maxBytes: 5, maxDepth: 32 }); // 4 characters, 6 bytes
    expect(r.ok ? "" : r.error.code).toBe("size_exceeded");
  });

  it("accepts 32 levels of nesting and rejects 33", () => {
    expect(ok("[".repeat(32) + "]".repeat(32)).ok).toBe(true);
    const r = ok("[".repeat(33) + "]".repeat(33));
    expect(r.ok ? "" : r.error.code).toBe("depth_exceeded");
    const o = ok('{"a":'.repeat(33) + "1" + "}".repeat(33));
    expect(o.ok ? "" : o.error.code).toBe("depth_exceeded");
  });

  it("does not overflow the stack on very deep input", () => {
    const r = strictParse("[".repeat(100000), { maxBytes: 1000000, maxDepth: 32 });
    expect(r.ok ? "" : r.error.code).toBe("depth_exceeded");
  });

  it("rejects a duplicate key and names its path", () => {
    const r = ok('{"a":{"b":1,"c":2,"b":3}}');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatchObject({ code: "duplicate_key", path: "/a/b" });
    const e = ok('{"a/b":1,"a/b":2}');
    if (!e.ok) expect(e.error.path).toBe("/a~1b");
  });

  it("rejects a duplicate key written with an escape", () => {
    const r = ok('{"a":1,"\\u0061":2}');
    expect(r.ok ? "" : r.error.code).toBe("duplicate_key");
  });

  it.each([
    ["empty", ""],
    ["trailing comma", "[1,]"],
    ["single quotes", "{'a':1}"],
    ["trailing text", "{} x"],
    ["leading zero", "[01]"],
    ["bare plus", "[+1]"],
    ["NaN", "[NaN]"],
    ["unterminated string", '"abc'],
    ["control character", '"a\tb"'],
    ["bad escape", '"\\x"'],
    ["comment", "// x\n{}"],
    ["byte order mark", "\uFEFF{}"],
  ])("rejects invalid JSON: %s", (_n, s) => {
    const r = ok(s);
    expect(r.ok ? "" : r.error.code).toBe("invalid_json");
  });

  it("rejects bytes that are not UTF-8", () => {
    const r = strictParse(new Uint8Array([0x22, 0xff, 0x22]));
    expect(r.ok ? "" : r.error.code).toBe("invalid_utf8");
    const bom = strictParse(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]));
    expect(bom.ok ? "" : bom.error.code).toBe("invalid_json");
  });

  it("rejects integers outside the safe range and non-finite numbers", () => {
    for (const s of ["[9007199254740992]", "[-9007199254740992]", "[1e999]"]) {
      const r = ok(s);
      expect(r.ok ? "" : r.error.code, s).toBe("unsafe_number");
    }
    expect(ok("[9007199254740991, 1.5, 1e3]").ok).toBe(true);
  });

  it("keeps __proto__ as an ordinary own key and never touches the prototype", () => {
    const r = ok('{"__proto__":{"polluted":true}}');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(Object.keys(r.value as object)).toEqual(["__proto__"]);
      expect(Object.getPrototypeOf(r.value)).toBe(Object.prototype);
    }
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
});

describe("parseAndValidate", () => {
  const claimBody = (extra: string): string =>
    `{"claims":[{"localKey":"k1","condition":{"description":"d","expression":{"op":"lit","value":true}},` +
    `"effect":{"description":"e","response":{"status":{"op":"lit","value":200},"fields":[]}},` +
    `"confidence":"low","openQuestions":[],"citations":[{"file":"f","startLine":1,"endLine":1,"quote":"q"}]${extra}}]}`;

  it("accepts a valid proposal from text and from bytes", () => {
    expect(validator.parseAndValidate("hypothesis-proposal", claimBody("")).ok).toBe(true);
    expect(validator.parseAndValidate("hypothesis-proposal", new TextEncoder().encode(claimBody(""))).ok).toBe(true);
  });

  it("rejects a reserved field as an undefined field", () => {
    const r = validator.parseAndValidate("hypothesis-proposal", claimBody(',"origin":"human-authored"'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContainEqual(expect.objectContaining({ code: "undefined_field", path: "/claims/0/origin" }));
  });

  it("rejects a duplicate key before validating", () => {
    const r = validator.parseAndValidate("hypothesis-proposal", claimBody(',"confidence":"high"'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toEqual([expect.objectContaining({ code: "duplicate_key", path: "/claims/0/confidence" })]);
  });

  it("rejects oversized and over-nested input without validating", () => {
    const big = validator.parseAndValidate("citation", " ".repeat(300000));
    expect(big.ok ? "" : big.error[0]?.code).toBe("size_exceeded");
    const deep = validator.parseAndValidate("citation", "[".repeat(40));
    expect(deep.ok ? "" : deep.error[0]?.code).toBe("depth_exceeded");
  });

  it("reports every problem of a parsed document, in a stable order", () => {
    const r = validator.parseAndValidate("citation", '{"file":"","startLine":0,"extra":1}');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.error.map((i) => i.path);
      expect(paths).toEqual([...paths].sort());
      const keys = r.error.map((i) => `${i.code}:${i.path}`);
      expect(keys).toEqual(
        expect.arrayContaining(["bad_value:/file", "bad_value:/startLine", "missing_field:/endLine", "missing_field:/quote", "undefined_field:/extra"]),
      );
    }
  });

  it("does not coerce types or fill defaults", () => {
    const input = { file: "f", startLine: "1", endLine: 1, quote: "q" };
    const r = validator.validate("citation", input);
    expect(r.ok).toBe(false);
    expect(input.startLine).toBe("1");
  });
});
