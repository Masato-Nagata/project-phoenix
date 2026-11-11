// Property 16: Records and artifacts containing secrets are rejected whole.
// **Validates: Requirements 12.13, 19.2, 19.7, 19.9**
// Only generated fake canary secrets are used. Non-secret text uses a lowercase alphabet that cannot form a canary.
import { createHash } from "node:crypto";
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  GENESIS_HASH,
  MemoryFileSystem,
  RunRecordStore,
  canonicalJson,
  type Json,
  type RecordEnvelope,
} from "../src/index.js";

const DIR = "/run/out";
const dec = (b: Uint8Array | undefined): string => new TextDecoder().decode(b);
const sha = (b: Uint8Array | string): string => createHash("sha256").update(b).digest("hex");
const UPPER = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"];
const LOWER = [..."abcdefghijklmnopqrstuvwxyz0123456789 "];

const CONFIG = {
  patterns: [{ id: "canary-token", source: "CANARY-[A-Z0-9]{10,}" }],
  envValues: [{ name: "CANARY_ENV", value: "ENVCANARY_PLACEHOLDER" }],
};

type Kind = "pattern" | "env";
interface Secret {
  kind: Kind;
  text: string;
  id: string;
}

// Secret values: pattern hit "CANARY-XXXXXXXXXX+", env value "ENVCANARY_..." (>= 8 chars). Env value is fixed per run.
const secretArb = (envValue: string): fc.Arbitrary<Secret> =>
  fc.oneof(
    fc
      .array(fc.constantFrom(...UPPER), { minLength: 10, maxLength: 24 })
      .map((a): Secret => ({ kind: "pattern", text: `CANARY-${a.join("")}`, id: "canary-token" })),
    fc.constant<Secret>({ kind: "env", text: envValue, id: "env:CANARY_ENV" }),
  );

const lowerText = fc.array(fc.constantFrom(...LOWER), { maxLength: 12 }).map((a) => a.join(""));
const awkward = fc.array(fc.constantFrom(..."\"\\\n\t/ <>é"), { maxLength: 3 }).map((a) => a.join(""));
const key = fc.array(fc.constantFrom(...LOWER.filter((c) => c !== " ")), { minLength: 1, maxLength: 6 }).map((a) => a.join(""));

const leaf: fc.Arbitrary<Json> = fc.oneof(lowerText, fc.integer({ min: -1000, max: 1000 }), fc.boolean(), fc.constant(null));
const jsonTree: fc.Arbitrary<Json> = fc.letrec<{ tree: Json }>((tie) => ({
  tree: fc.oneof(
    { depthSize: "small", maxDepth: 3 },
    leaf,
    fc.array(tie("tree"), { maxLength: 3 }),
    fc.dictionary(key, tie("tree"), { maxKeys: 3 }),
  ),
})).tree;
const plainPayload: fc.Arbitrary<{ [k: string]: Json }> = fc.dictionary(key, jsonTree, { maxKeys: 4 });

type Where = "key" | "value" | "array";
const wrapArb = fc.record({
  where: fc.constantFrom<Where>("key", "value", "array"),
  depth: fc.integer({ min: 0, max: 3 }),
  prefix: fc.tuple(lowerText, awkward).map(([a, b]) => a + b),
  suffix: fc.tuple(awkward, lowerText).map(([a, b]) => a + b),
  base: plainPayload,
});

function embed(secret: string, w: { where: Where; depth: number; prefix: string; suffix: string; base: { [k: string]: Json } }): { [k: string]: Json } {
  const s = `${w.prefix}${secret}${w.suffix}`;
  let inner: Json = w.where === "key" ? { [s]: 1 } : w.where === "value" ? { v: s } : [1, s];
  for (let i = 0; i < w.depth; i++) inner = i % 2 === 0 ? { n: [inner] } : { n: inner };
  return { ...w.base, zz: inner };
}

const bytesArb = fc.uint8Array({ maxLength: 40 }).map((u) => u.map((b) => b % 0x7b + 0x20 & 0x7f)); // printable-ish ASCII; no uppercase canary run is likely
// Blob bytes with a secret embedded at an arbitrary offset.
const secretBlob = (s: Secret) =>
  fc.tuple(bytesArb, bytesArb).map(([a, b]) => new Uint8Array([...a, ...new TextEncoder().encode(s.text), ...b]));
// Plain blob bytes drawn from lowercase only, so they cannot hold a canary.
const plainBlob = fc.array(fc.constantFrom(...LOWER.map((c) => c.charCodeAt(0))), { maxLength: 40 }).map((a) => new Uint8Array(a));

const componentArb = (s: Secret | undefined) =>
  fc.oneof(key, fc.constant(undefined), s ? fc.constant(`who-${s.text}`) : key);

type Op =
  | { t: "record"; payload: { [k: string]: Json }; secret?: Secret; component?: string | undefined }
  | { t: "blob"; data: Uint8Array; secret?: Secret; component?: string | undefined };

const opArb = (envValue: string): fc.Arbitrary<Op> => {
  const sec = secretArb(envValue);
  return fc.oneof(
    plainPayload.chain((payload) => componentArb(undefined).map((component): Op => ({ t: "record", payload, component }))),
    sec.chain((secret) =>
      fc.tuple(wrapArb, componentArb(secret)).map(([w, component]): Op => ({ t: "record", payload: embed(secret.text, w), secret, component })),
    ),
    plainBlob.chain((data) => componentArb(undefined).map((component): Op => ({ t: "blob", data, component }))),
    sec.chain((secret) => fc.tuple(secretBlob(secret), componentArb(secret)).map(([data, component]): Op => ({ t: "blob", data, secret, component }))),
  );
};

const envValueArb = fc
  .array(fc.constantFrom(...UPPER), { minLength: 3, maxLength: 20 })
  .map((a) => `ENVCANARY_${a.join("")}`);

describe("Property 16: records and artifacts containing secrets are rejected whole", () => {
  it("never writes any part of a secret-bearing record or blob, names only the pattern id, and keeps the chain valid", async () => {
    await fc.assert(
      fc.asyncProperty(
        envValueArb.chain((env) => fc.tuple(fc.constant(env), fc.array(opArb(env), { minLength: 1, maxLength: 10 }))),
        async ([env, ops]) => {
          const fs = new MemoryFileSystem();
          fs.addDir(DIR);
          const r = await RunRecordStore.open(fs, DIR, { secrets: { patterns: CONFIG.patterns, envValues: [{ name: "CANARY_ENV", value: env }] } });
          if (!r.ok) throw new Error("open");
          const store = r.value;

          const expected: { kind: string; payload: unknown }[] = [];
          const goodBlobs = new Map<string, Uint8Array>();
          const badBlobHashes = new Set<string>();
          const secretTexts = new Set<string>();

          for (const op of ops) {
            if (op.secret) secretTexts.add(op.secret.text);
            if (op.t === "record") {
              const res = await store.append("error", op.payload, (op.component === undefined ? {} : { component: op.component }));
              if (op.secret === undefined) {
                expect(res.ok).toBe(true);
                expected.push({ kind: "error", payload: op.payload });
              } else {
                expect(!res.ok && res.error.kind === "secret_rejected" && res.error.patternId).toBe(op.secret.id);
                expected.push({
                  kind: "store_rejection",
                  payload: {
                    attempt: "secret_pattern",
                    component: op.component === undefined ? "unknown" : op.component.includes(op.secret.text) ? "redacted" : op.component,
                    patternId: op.secret.id,
                    reason: "content matched a configured secret pattern and was not written",
                  },
                });
              }
            } else {
              const res = await store.putBlob(op.data, (op.component === undefined ? {} : { component: op.component }));
              if (op.secret === undefined) {
                expect(res.ok).toBe(true);
                goodBlobs.set(sha(op.data), op.data);
              } else {
                expect(!res.ok && res.error.kind === "secret_rejected" && res.error.patternId).toBe(op.secret.id);
                badBlobHashes.add(sha(op.data));
                expected.push({
                  kind: "store_rejection",
                  payload: {
                    attempt: "secret_pattern",
                    component: op.component === undefined ? "unknown" : op.component.includes(op.secret.text) ? "redacted" : op.component,
                    patternId: op.secret.id,
                    reason: "content matched a configured secret pattern and was not written",
                  },
                });
              }
            }
          }

          // Nothing of any secret appears in any file of the store (all bytes).
          for (const path of fs.allFiles()) {
            const bytes = fs.peek(path) as Uint8Array;
            const text = Buffer.from(bytes).toString("latin1");
            for (const s of secretTexts) expect(text.includes(s), `${path} contains a secret`).toBe(false);
          }

          // Written records equal the expected sequence exactly (non-secret unchanged, rejections by id only).
          const recs = dec(fs.peek(`${DIR}/records.jsonl`))
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l) as RecordEnvelope);
          expect(recs.map((x) => ({ kind: x.kind, payload: x.payload }))).toEqual(expected);

          // Chain stays valid.
          let prev = GENESIS_HASH;
          recs.forEach((rec, i) => {
            expect(rec.seq).toBe(i + 1);
            expect(rec.prevHash).toBe(prev);
            const { hash, ...rest } = rec;
            expect(hash).toBe(sha(canonicalJson(rest as unknown as Json)));
            prev = hash;
          });
          expect(store.lastRecordHash).toBe(prev);
          expect(store.count).toBe(recs.length);

          // Blobs: exactly the non-secret ones, byte-identical; no file for rejected blobs.
          const blobFiles = fs.allFiles().filter((p) => p.startsWith(`${DIR}/blobs/`));
          const goodOnly = [...goodBlobs.keys()].filter((h) => !badBlobHashes.has(h));
          expect(blobFiles.sort()).toEqual(goodOnly.map((h) => `${DIR}/blobs/${h}`).sort());
          for (const h of goodOnly) expect(fs.peek(`${DIR}/blobs/${h}`)).toEqual(goodBlobs.get(h));
          expect(fs.allFiles().every((p) => !p.endsWith(".tmp"))).toBe(true);
        },
      ),
      { seed: 160016, numRuns: 60 },
    );
  }, 120_000);
});
