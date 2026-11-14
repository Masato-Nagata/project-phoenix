// Feature: discovery-loop, Property 1: Source_Bundle determinism and manifest equality
// **Validates: Requirements 1.1, 1.2, 1.6, 1.7, 1.8**
//
// For any valid allowlist and any file contents, the Source_Bundler reads exactly the listed files in the listed order,
// the manifest lists exactly the allowlist paths in the same order with the LF-normalized SHA-256 of each file, and the
// same input gives byte-identical manifest bytes and bundle text, whatever the root path or the order in which the
// file system happens to hold its entries.
//
// The oracle is written independently of the code under test (own line-ending scan, own manifest text). Reproducibility
// record: SEED = 440001, NUM_RUNS = 300. All generated text is neutral.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildSourceBundle, renderBundleText, serializeManifest } from "../src/index.js";
import {
  JSON_DOC,
  MD_DOC,
  MemFs,
  ROOT,
  allowlistJson,
  allowlistMd,
  makeRepo,
  oracleBundleText,
  oracleHash,
  oracleManifestText,
  oracleNormalize,
} from "./helpers/bundleFixtures.js";

const SEED = 440001;
const NUM_RUNS = 300;
const TIMEOUT_MS = 120_000;

const nameArb = fc.stringMatching(/^[A-Za-z0-9_]{1,10}$/);
const entryArb = fc.oneof(nameArb.map((n) => `legacy/src/${n}.php`), nameArb.map((n) => `legacy/sql/${n}.sql`));
const entriesArb = fc.uniqueArray(entryArb, { minLength: 1, maxLength: 7, selector: (e) => e.toLowerCase() });

const PIECES = ["a", "b", "Z", " ", "\t", "\u00e9", "\u{1F600}", "\uFEFF", "\n", "\r", "\r\n", "<?php", ""] as const;
const textArb = fc.array(fc.constantFrom(...PIECES), { maxLength: 30 }).map((p) => p.join(""));

const caseArb = fc
  .tuple(entriesArb, fc.array(textArb, { minLength: 7, maxLength: 7 }))
  .map(([entries, texts]) => ({ entries, texts: Object.fromEntries(entries.map((e, i) => [e, texts[i] ?? ""])) as Record<string, string> }));

describe(`Property 1: Source_Bundle determinism and manifest equality (seed ${SEED}, numRuns ${NUM_RUNS})`, () => {
  it("builds a manifest equal to the allowlist, with oracle hashes, canonical bytes, and no host path", async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async ({ entries, texts }) => {
        const fs = makeRepo(entries, { texts });
        const r = await buildSourceBundle(fs, ROOT, JSON_DOC, MD_DOC);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.manifest.map((m) => m.path)).toEqual(entries); // same paths, same order (R1.7)
        expect(r.value.files.map((f) => f.path)).toEqual(entries);
        for (let i = 0; i < entries.length; i += 1) {
          const e = entries[i] as string;
          expect(r.value.manifest[i]?.sha256Lf).toBe(oracleHash(texts[e] as string));
          expect(r.value.files[i]?.text).toBe(oracleNormalize(texts[e] as string));
        }
        const files = entries.map((e) => ({ path: e, text: texts[e] as string }));
        const manifestText = new TextDecoder().decode(serializeManifest(r.value.manifest));
        expect(manifestText).toBe(oracleManifestText(files));
        expect(manifestText).not.toContain(ROOT);
        expect(renderBundleText(r.value)).toBe(oracleBundleText(files));
        // Nothing but the two documents, the listed files, and their parent directories was touched (R1.2).
        const allowed = new Set<string>([`${ROOT}/${JSON_DOC}`, `${ROOT}/${MD_DOC}`, `${ROOT}/legacy`, `${ROOT}/legacy/src`, `${ROOT}/legacy/sql`, ...entries.map((e) => `${ROOT}/${e}`)]);
        expect(fs.paths().filter((p) => !allowed.has(p))).toEqual([]);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("gives byte-identical output for identical input, another root path, and another entry order in the file system", async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, fc.constantFrom("/repo", "/a/b/c", "/x"), async ({ entries, texts }, root) => {
        const first = makeRepo(entries, { texts });
        const r1 = await buildSourceBundle(first, ROOT, JSON_DOC, MD_DOC);
        // The same repository under another root, with its entries inserted in the reverse order.
        const reversed = new Map([...first.entries].reverse().map(([k, v]) => [k.replace(ROOT, root), v] as const));
        const r2 = await buildSourceBundle(new MemFs(reversed), root, JSON_DOC, MD_DOC);
        expect(r1.ok && r2.ok).toBe(true);
        if (!r1.ok || !r2.ok) return;
        expect(serializeManifest(r1.value.manifest)).toEqual(serializeManifest(r2.value.manifest));
        expect(renderBundleText(r1.value)).toBe(renderBundleText(r2.value));
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("follows the allowlist order: a reversed allowlist gives the reversed manifest", async () => {
    await fc.assert(
      fc.asyncProperty(caseArb, async ({ entries, texts }) => {
        const forward = await buildSourceBundle(makeRepo(entries, { texts }), ROOT, JSON_DOC, MD_DOC);
        const back = [...entries].reverse();
        const reverse = await buildSourceBundle(makeRepo(back, { texts, jsonText: allowlistJson(back), mdText: allowlistMd(back) }), ROOT, JSON_DOC, MD_DOC);
        expect(forward.ok && reverse.ok).toBe(true);
        if (forward.ok && reverse.ok) expect(reverse.value.manifest).toEqual([...forward.value.manifest].reverse());
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);
});