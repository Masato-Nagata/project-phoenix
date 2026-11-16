// Task 3.7, property tests of the Audit_Config_Builder (synthetic inputs; fixed seed so that a failure can be reproduced).
// Generated words carry a per-file prefix, so the windows of different files and of the corpus never coincide by chance, and a failure is a
// real fault. The values printed on a failure are generated words and numbers, never a configured canary or decoy.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { auditPayload, ngramHashes, parseAuditConfig, tokenize } from "../src/index.js";
import type { AuditCheckId, AuditResult } from "../src/index.js";
import { buildAuditConfig } from "../src/auditConfigBuilder.js";
import type { BuildInput } from "../src/auditConfigBuilder.js";
import { counterRandom } from "./helpers/builderFixtures.js";
import { build } from "./helpers/propertyWorld.js";
import type { PayloadSpec } from "./helpers/propertyWorld.js";

const FC = { seed: 37_001_001, numRuns: 60 };
const word = fc.stringMatching(/^[a-z]{3,7}$/);
const words = (tag: string, min: number, max: number): fc.Arbitrary<string[]> =>
  fc.array(word, { minLength: min, maxLength: max }).map((ws) => ws.map((w, i) => `${tag}${i}${w}`));

interface Scenario {
  n: number;
  files: { fileId: string; tokens: string[] }[];
  corpus: { id: string; tokens: string[] }[];
  canary: string;
  seed: number;
}
const scenarioArb: fc.Arbitrary<Scenario> = fc.integer({ min: 6, max: 9 }).chain((n) =>
  fc.record({
    n: fc.constant(n),
    files: fc.tuple(...[0, 1, 2, 3, 4].map((i) => words(`f${i}x`, n + 3, n + 14))).map((all) => all.map((tokens, i) => ({ fileId: `file-${i}`, tokens }))),
    corpus: fc.tuple(words("cax", 3, 20), words("cbx", 3, 20)).map((all) => all.map((tokens, i) => ({ id: `doc-${i}`, tokens }))),
    canary: word.map((w) => `SYNTH-CANARY-${w}-12345`),
    seed: fc.integer({ min: 1, max: 1_000_000 }),
  }),
);
const toInput = (s: Scenario): BuildInput => ({
  restricted: s.files.map((f, i) =>
    i === 0
      ? { fileId: f.fileId, kind: "json" as const, content: JSON.stringify({ canary: s.canary, text: f.tokens.join(" ") }), canaryPointers: ["/canary"] }
      : { fileId: f.fileId, kind: "text" as const, content: f.tokens.join(" ") },
  ),
  corpus: s.corpus.map((c) => ({ id: c.id, text: c.tokens.join(" ") })),
  allowlist: ["legacy/src/utils.php", "legacy/src/db.php"],
  restrictedPathPrefixes: ["synthetic-restricted-area/"],
  n: s.n,
  randomHex: counterRandom(s.seed),
});
const ok = (i: BuildInput) => {
  const r = buildAuditConfig(i);
  if (!r.ok) throw new Error(`builder failed: ${r.error.code}`);
  return r.value;
};
const failedIds = (a: AuditResult): AuditCheckId[] => a.checks.filter((c) => c.outcome === "fail").map((c) => c.id);
function auditContent(bytes: Uint8Array, content: unknown): AuditResult {
  const cfg = parseAuditConfig(bytes);
  const spec: PayloadSpec = { kind: "hypothesis_revision", sources: [{ path: "legacy/src/utils.php", text: "<?php\n// fictional\n" }], stored: [{ type: "hypothesis_revision", content: content as never }] };
  const b = build(spec, cfg);
  return auditPayload(b.bytes(), spec.kind, b.cfg, { ...b.ctx, allowlist: ["legacy/src/utils.php", "legacy/src/db.php"], secretValues: [] }).audit;
}

describe("Audit_Config_Builder: properties", () => {
  it("always builds a configuration that the auditor accepts; the hashes are the windows of the file minus the corpus (shared tokenizer)", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const out = ok(toInput(s));
        const parsed = parseAuditConfig(out.bytes);
        expect(parsed.ok, "the auditor refused the configuration").toBe(true);
        if (!parsed.ok) return;
        const corpus = new Set(s.corpus.flatMap((c) => [...ngramHashes(tokenize(c.tokens.join(" ")), s.n)]));
        for (const f of s.files) {
          const set = parsed.config.fingerprints.find((x) => x.fileId === f.fileId);
          // file-0 is JSON and is fingerprinted by its decoded strings (keys and values joined by a newline); the others by their text
          const unit = f.fileId === "file-0" ? ["canary", s.canary, "text", f.tokens.join(" ")].join("\n") : f.tokens.join(" ");
          const expected = new Set<string>(ngramHashes(tokenize(unit), s.n));
          const want = [...expected].filter((h) => !corpus.has(h)).sort();
          expect(set?.hashes, `fingerprints of ${f.fileId} differ from the shared tokenizer`).toEqual(want);
        }
        expect(parsed.config.canaries).toEqual([{ id: "canary-1", value: s.canary }]);
      }),
      FC,
    );
  });

  it("is deterministic and independent of the order of its inputs", () => {
    fc.assert(
      fc.property(scenarioArb, fc.nat(1000), (s, k) => {
        const input = toInput(s);
        const a = ok({ ...input, randomHex: counterRandom(s.seed) });
        const rot = (xs: readonly unknown[]) => xs.map((_x, i) => xs[(i + k) % xs.length]);
        const b = ok({ ...input, restricted: rot(input.restricted) as never, corpus: rot(input.corpus) as never, randomHex: counterRandom(s.seed) });
        expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes)), "the bytes depend on the input order").toBe(true);
        expect(a.summary).toEqual(b.summary);
      }),
      FC,
    );
  });

  it("the auditor blocks any window of a restricted file by that file's set, and passes any window of the corpus", () => {
    fc.assert(
      fc.property(scenarioArb, fc.nat(1000), fc.nat(1000), fc.nat(5), (s, fi, start, extra) => {
        const out = ok(toInput(s));
        const f = s.files[fi % s.files.length] as Scenario["files"][number];
        const len = Math.min(s.n + (extra % 4), f.tokens.length);
        const from = start % (f.tokens.length - len + 1);
        const blocked = auditContent(out.bytes, { note: `see ${f.tokens.slice(from, from + len).join(" ")} end` });
        expect(failedIds(blocked), "a window of a restricted file was not blocked").toEqual(["A07"]);
        expect(blocked.matches).toEqual([{ checkId: "A07", matchId: `fp-${f.fileId}` }]);
        const c = s.corpus[fi % s.corpus.length] as Scenario["corpus"][number];
        const cl = Math.min(s.n + (extra % 4), c.tokens.length);
        const clean = auditContent(out.bytes, { note: c.tokens.slice(0, cl).join(" ") });
        expect(clean.result, "a window of the allowed corpus was blocked").toBe("pass");
      }),
      FC,
    );
  });

  it("the canary is found at any position, and a decoy by its own identifier", () => {
    fc.assert(
      fc.property(scenarioArb, fc.nat(300), (s, pos) => {
        const out = ok(toInput(s));
        const cfg = parseAuditConfig(out.bytes);
        if (!cfg.ok) throw new Error("config");
        const at = (text: string, ins: string): string => text.slice(0, pos % (text.length + 1)) + ins + text.slice(pos % (text.length + 1));
        const a = auditContent(out.bytes, { note: at("padding words here", s.canary) });
        // The canary is also part of the Ground_Truth text, so its windows are fingerprints too: A06 names the canary, A07 may name the file.
        expect(a.matches.filter((m) => m.checkId === "A06")).toEqual([{ checkId: "A06", matchId: "canary-1" }]);
        expect(a.result).toBe("blocked");
        const d = auditContent(out.bytes, { note: at("padding words here", cfg.config.decoys[0]?.value as string) });
        expect(d.matches).toEqual([{ checkId: "A06", matchId: "decoy-1" }]); // a decoy exists only in the configuration
      }),
      FC,
    );
  });
});