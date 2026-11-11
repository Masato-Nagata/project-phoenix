// Feature: discovery-loop, Property 14: Canonical JSON and record round trip
// **Validates: Requirements 12.15, 17.8**
// Fixed seed and bounded run count so a failure is reproducible.
import { createHash } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MemoryFileSystem,
  RunRecordStore,
  canonicalBytes,
  canonicalJson,
  createSchemaValidator,
  parseCanonical,
  type Json,
  type RecordEnvelope,
  type RecordKind,
} from "../src/index.js";

const SEED = 14_012_345;
const NUM_RUNS = 200;
const FC: fc.Parameters<unknown> = { seed: SEED, numRuns: NUM_RUNS };

const DIR = "/run/out";
const VALIDATOR = createSchemaValidator(); // compiled once; schemas are stateless
const TIMEOUT_MS = 120_000;
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const dec = (b: Uint8Array | undefined): string => new TextDecoder().decode(b);

// ---- generators (within the parse limits: depth <= 6, safe integers, finite doubles, valid Unicode) ----
const jsonNumber = fc.oneof(
  fc.integer({ min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER }),
  fc.integer({ min: -1000, max: 1000 }),
  fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e15, max: 1e15 }).map((n) => (Object.is(n, -0) ? 0 : n)),
);
const jsonString = fc.oneof(fc.string({ maxLength: 12 }), fc.string({ unit: "grapheme", maxLength: 8 }), fc.string({ unit: "binary", maxLength: 8 }));
const safeKey = jsonString.filter((k) => k !== "__proto__");

const jsonValue: fc.Arbitrary<Json> = fc.letrec<{ value: Json }>((tie) => ({
  value: fc.oneof(
    { depthSize: "small", maxDepth: 5 },
    fc.constant(null),
    fc.boolean(),
    jsonNumber,
    jsonString,
    fc.array(tie("value"), { maxLength: 4 }),
    fc.array(fc.tuple(safeKey, tie("value")), { maxLength: 4 }).map((e) => Object.fromEntries(e) as Json),
  ),
})).value;

const jsonObject = fc
  .array(fc.tuple(safeKey, jsonValue), { maxLength: 5 })
  .map((e) => Object.fromEntries(e) as { [k: string]: Json });

const kinds: RecordKind[] = ["run_started", "observation", "evidence", "hypothesis_revision", "error", "comparison"];

/** Same value, different key order. */
function reverseKeys(v: Json): Json {
  if (Array.isArray(v)) return v.map(reverseKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).reverse().map(([k, c]) => [k, reverseKeys(c)]));
  }
  return v;
}

describe(`Property 14: Canonical JSON and record round trip (seed ${SEED}, numRuns ${NUM_RUNS})`, () => {
  it("serialize -> parseCanonical -> serialize is byte-identical and value-equal", () => {
    fc.assert(
      fc.property(jsonValue, (v) => {
        const text = canonicalJson(v);
        const parsed = parseCanonical(text);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(parsed.value).toEqual(v);
        expect(canonicalJson(parsed.value)).toBe(text);
        expect(Buffer.from(canonicalBytes(parsed.value)).equals(Buffer.from(canonicalBytes(v)))).toBe(true);
        // Bytes input parses to the same value and is accepted as canonical.
        const fromBytes = parseCanonical(canonicalBytes(v));
        expect(fromBytes.ok && canonicalJson(fromBytes.value)).toBe(text);
        // Keys are sorted at every level and no insignificant whitespace exists: stable on its own output.
        expect(canonicalJson(JSON.parse(text) as Json)).toBe(text);
      }),
      FC,
    );
  }, TIMEOUT_MS);

  it("key order and whitespace variants of one value give identical canonical bytes", () => {
    fc.assert(
      fc.property(jsonValue, fc.constantFrom(0, 1, 2, 4, "\t"), (v, indent) => {
        const canonical = canonicalJson(v);
        const variant = JSON.stringify(reverseKeys(v), null, indent);
        const parsed = parseCanonical(variant, { requireCanonical: false });
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) return;
        expect(canonicalJson(parsed.value)).toBe(canonical);
        // A non-canonical spelling is refused by default, never silently accepted.
        const strict = parseCanonical(variant);
        if (variant === canonical) expect(strict.ok).toBe(true);
        else expect(!strict.ok && strict.error.code).toBe("not_canonical");
      }),
      FC,
    );
  }, TIMEOUT_MS);

  it("stored records read back from the JSONL line equal the appended records", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(fc.tuple(fc.constantFrom(...kinds), jsonObject), { minLength: 1, maxLength: 4 }), async (items) => {
        const fs = new MemoryFileSystem();
        fs.addDir(DIR);
        const opened = await RunRecordStore.open(fs, DIR, { validator: VALIDATOR });
        if (!opened.ok) throw new Error("open failed");
        const store = opened.value;
        const appended: RecordEnvelope[] = [];
        for (const [kind, payload] of items) {
          const r = await store.append(kind, payload);
          expect(r.ok).toBe(true);
          if (r.ok) appended.push(r.value);
        }
        const raw = dec(fs.peek(`${DIR}/records.jsonl`));
        expect(raw.endsWith("\n")).toBe(true);
        const lines = raw.slice(0, -1).split("\n");
        expect(lines.length).toBe(items.length);
        let prev = "0".repeat(64);
        lines.forEach((line, i) => {
          const parsed = parseCanonical(line); // also proves the line is canonical
          expect(parsed.ok).toBe(true);
          if (!parsed.ok) return;
          const env = parsed.value as unknown as RecordEnvelope;
          expect(env).toEqual(appended[i]);
          expect(env.payload).toEqual(items[i]![1]);
          expect(canonicalJson(env as unknown as Json)).toBe(line);
          expect(env.prevHash).toBe(prev);
          const { hash, ...head } = env;
          expect(hash).toBe(sha(canonicalJson(head as unknown as Json)));
          prev = hash;
        });
        expect(dec(fs.peek(`${DIR}/records.jsonl`))).toBe(lines.map((l) => `${l}\n`).join(""));
        expect(store.list()).toEqual(appended);
      }),
      FC,
    );
  }, TIMEOUT_MS);

  it("exact AI output bytes round-trip with a matching SHA-256", async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 512 }), async (bytes) => {
        const fs = new MemoryFileSystem();
        fs.addDir(DIR);
        const opened = await RunRecordStore.open(fs, DIR, { validator: VALIDATOR });
        if (!opened.ok) throw new Error("open failed");
        const r = await opened.value.putAiOutput(bytes);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        const hash = sha(bytes);
        expect(r.value.blob).toEqual({ blob: hash, bytes: bytes.length });
        const stored = fs.peek(`${DIR}/blobs/${hash}`);
        expect(stored).toBeDefined();
        expect(Buffer.from(stored as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
        expect(sha(stored as Uint8Array)).toBe(hash);
        const line = dec(fs.peek(`${DIR}/records.jsonl`)).slice(0, -1);
        const env = parseCanonical(line);
        expect(env.ok && (env.value as unknown as RecordEnvelope).payload).toEqual({ output: { blob: hash, bytes: bytes.length } });
      }),
      FC,
    );
  }, TIMEOUT_MS);
});
