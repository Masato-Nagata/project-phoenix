// Task 3.7: the Audit_Config_Builder, with synthetic inputs only.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_NGRAM_SIZE, auditPayload, ngramHashes, parseAuditConfig, tokenize } from "../src/index.js";
import type { AuditCheckId, AuditResult } from "../src/index.js";
import { BUILDER_DEFAULT_N, buildAuditConfig, runAuditConfigBuilder } from "../src/auditConfigBuilder.js";
import type { BuildInput, BuildOutput } from "../src/auditConfigBuilder.js";
import {
  BASELINE_TEXT, BUILDER_N, CORPUS, GT_CANARY, GT_TEXT, MD_TEXT, SHARED_SENTENCE, SYNTH_ARGS, SYNTH_FILES, baseInput, counterRandom, memoryIo,
} from "./helpers/builderFixtures.js";
import { build } from "./helpers/propertyWorld.js";
import type { PayloadSpec } from "./helpers/propertyWorld.js";

const dec = (b: Uint8Array): string => new TextDecoder().decode(b);
function built(over: Partial<BuildInput> = {}): BuildOutput {
  const r = buildAuditConfig(baseInput(over));
  if (!r.ok) throw new Error(`builder failed: ${r.error.code}`);
  return r.value;
}
const failedIds = (a: AuditResult): AuditCheckId[] => a.checks.filter((c) => c.outcome === "fail").map((c) => c.id);

/** A payload of the shape of the auditor tests whose stored content is `content`, audited against the builder's configuration. */
function auditWith(out: BuildOutput, content: unknown) {
  const cfg = parseAuditConfig(out.bytes);
  const spec: PayloadSpec = {
    kind: "hypothesis_revision",
    sources: [{ path: "legacy/src/utils.php", text: "<?php\n// fictional\n" }],
    stored: [{ type: "hypothesis_revision", content: content as never }],
  };
  const b = build(spec, cfg);
  return auditPayload(b.bytes(), spec.kind, b.cfg, { ...b.ctx, allowlist: ["legacy/src/utils.php", "legacy/src/db.php"], secretValues: [] }).audit;
}

describe("buildAuditConfig: output and compatibility", () => {
  it("produces a configuration that the Payload_Auditor accepts, with all required parts", () => {
    const out = built();
    const parsed = parseAuditConfig(out.bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const c = parsed.config;
    expect(c.schemaVersion).toBe(1);
    expect(c.tokenizer).toBe("token-ngram-sha256-v1");
    expect(c.fingerprints).toHaveLength(5);
    expect(c.fingerprints.map((f) => f.fileId).sort()).toEqual(["conformance-baseline", "evaluation-results", "ground-truth", "migration-decisions", "review-package"]);
    for (const f of c.fingerprints) {
      expect(f.n).toBe(BUILDER_N);
      expect(f.hashes.length).toBeGreaterThan(0);
      expect(f.hashes.every((h) => /^[0-9a-f]{12}$/.test(h))).toBe(true);
    }
    expect(c.allowlist).toEqual(["legacy/src/db.php", "legacy/src/utils.php"]);
    expect(c.restrictedPathPrefixes).toEqual(["synthetic-approvals/", "synthetic-restricted-area/"]);
    expect(parsed.sha256).toBe(out.summary.outputSha256);
  });

  it("takes the canary from the pointed field and makes random decoys that exist only in this file", () => {
    const c = parseAuditConfig(built().bytes);
    if (!c.ok) throw new Error("config");
    expect(c.config.canaries).toEqual([{ id: "canary-1", value: GT_CANARY }]);
    expect(c.config.decoys.map((d) => d.id)).toEqual(["decoy-1", "decoy-2"]);
    for (const d of c.config.decoys) {
      expect(d.value).toMatch(/^DECOY-[0-9a-f]{24}$/);
      expect([GT_TEXT, MD_TEXT, BASELINE_TEXT, ...CORPUS.map((x) => x.text)].some((t) => t.includes(d.value))).toBe(false);
    }
    const other = parseAuditConfig(built({ randomHex: counterRandom(500) }).bytes);
    if (!other.ok) throw new Error("config");
    expect(other.config.decoys).not.toEqual(c.config.decoys);
    expect(other.config.canaries).toEqual(c.config.canaries);
    expect(other.config.fingerprints).toEqual(c.config.fingerprints);
  });

  it("uses the shared tokenizer: the fingerprints are exactly the windows of the file minus the windows of the corpus", () => {
    const out = built();
    const c = parseAuditConfig(out.bytes);
    if (!c.ok) throw new Error("config");
    const corpusHashes = new Set(CORPUS.flatMap((d) => [...ngramHashes(tokenize(d.text), BUILDER_N)]));
    const md = c.config.fingerprints.find((f) => f.fileId === "migration-decisions");
    const expected = [...ngramHashes(tokenize(MD_TEXT), BUILDER_N)].filter((h) => !corpusHashes.has(h)).sort();
    expect(md?.hashes).toEqual(expected);
    expect(BUILDER_DEFAULT_N).toBe(DEFAULT_NGRAM_SIZE);
  });

  it("is deterministic: the same inputs and the same random source give the same bytes, in any input order", () => {
    const a = built({ randomHex: counterRandom() });
    const b = built({ randomHex: counterRandom() });
    expect(Buffer.from(a.bytes).equals(Buffer.from(b.bytes))).toBe(true);
    expect(a.summary).toEqual(b.summary);
    const input = baseInput({ randomHex: counterRandom() });
    const shuffled = buildAuditConfig({ ...input, restricted: [...input.restricted].reverse(), corpus: [...input.corpus].reverse(), allowlist: [...input.allowlist].reverse() });
    expect(shuffled.ok && Buffer.from(shuffled.value.bytes).equals(Buffer.from(a.bytes))).toBe(true);
  });

  it("subtracts the allowed corpus: a sentence of the corpus is not a fingerprint, a sentence only in the restricted file is", () => {
    const out = built();
    expect(failedIds(auditWith(out, { note: SHARED_SENTENCE }))).toEqual([]);
    const blocked = auditWith(out, { note: "synthetic ground truth rule says tango uniform victor whiskey xray yankee zulu" });
    expect(failedIds(blocked)).toEqual(["A07"]);
    expect(blocked.matches).toEqual([{ checkId: "A07", matchId: "fp-ground-truth" }]);
  });

  it("leaves observed-response subtrees of the baseline out and keeps the expected parts", () => {
    const out = built();
    expect(failedIds(auditWith(out, { note: "observed response words one two three four five six seven eight nine" }))).toEqual([]);
    const blocked = auditWith(out, { note: "expected baseline sentence lima mike november oscar papa quebec romeo sierra" });
    expect(blocked.matches).toEqual([{ checkId: "A07", matchId: "fp-conformance-baseline" }]);
    const fp = out.summary.fingerprintSets.find((f) => f.fileId === "conformance-baseline");
    expect(fp?.excludedNodes).toEqual([2]);
    expect(out.summary.residuals).toEqual(["observed_responses_of_excluded_subtrees_are_not_fingerprinted"]);
    // without the exclusion the observed text would be fingerprinted
    const all = built({ restricted: baseInput().restricted.map((f) => (f.fileId === "conformance-baseline" ? { ...f, excludeSubtrees: [] } : f)) });
    expect(failedIds(auditWith(all, { note: "observed response words one two three four five six seven eight nine" }))).toEqual(["A07"]);
    expect(all.summary.residuals).toEqual([]);
  });

  it("works end to end with the auditor: a clean payload passes, the canary and a decoy are blocked by identifier, restricted text by file", () => {
    const out = built();
    expect(auditWith(out, { note: "ordinary words only" }).result).toBe("pass");
    const c = parseAuditConfig(out.bytes);
    if (!c.ok) throw new Error("config");
    const canary = auditWith(out, { note: GT_CANARY });
    expect(canary.matches.filter((m) => m.checkId === "A06")).toEqual([{ checkId: "A06", matchId: "canary-1" }]); // its windows are also fingerprints of the file
    expect(canary.result).toBe("blocked");
    const decoy = auditWith(out, { note: c.config.decoys[1]?.value });
    expect(decoy.matches).toEqual([{ checkId: "A06", matchId: "decoy-2" }]);
    for (const [text, id] of [[MD_TEXT, "fp-migration-decisions"]] as const) {
      expect(auditWith(out, { note: text }).matches).toEqual([{ checkId: "A07", matchId: id }]);
    }
  });
});

describe("buildAuditConfig: fails closed, and never reveals a value", () => {
  const code = (over: Partial<BuildInput>) => {
    const r = buildAuditConfig(baseInput(over));
    return r.ok ? "ok" : r.error.code;
  };
  const files = baseInput().restricted;

  it("refuses inputs that the Payload_Auditor would refuse", () => {
    expect(code({ n: 5 })).toBe("n_invalid");
    expect(code({ n: 12.5 })).toBe("n_invalid");
    expect(code({ restricted: files.slice(0, 3) })).toBe("too_few_restricted_files");
    expect(code({ decoyCount: 0 })).toBe("decoy_count_invalid");
    expect(code({ allowlist: [] })).toBe("input_invalid");
    expect(code({ corpus: [] })).toBe("input_invalid");
    expect(code({ restrictedPathPrefixes: [""] })).toBe("input_invalid");
  });

  it("refuses a file whose every window is in the corpus (an empty fingerprint set), a missing, short or non-string canary, bad JSON and bad pointers", () => {
    const covered = { fileId: "review-package", kind: "text" as const, content: SHARED_SENTENCE };
    const swap = (fileId: string, repl: BuildInput["restricted"][number]) => files.map((f) => (f.fileId === fileId ? repl : f));
    expect(code({ restricted: swap("review-package", covered) })).toBe("fingerprint_set_empty");
    const gt = (content: string, canaryPointers: string[]) => swap("ground-truth", { fileId: "ground-truth", kind: "json", content, canaryPointers });
    expect(code({ restricted: gt(GT_TEXT, ["/nothing"]) })).toBe("canary_missing");
    expect(code({ restricted: gt(JSON.stringify({ canary: "short" }), ["/canary"]) })).toBe("canary_too_short");
    expect(code({ restricted: gt(JSON.stringify({ canary: 12345678901 }), ["/canary"]) })).toBe("canary_not_string");
    expect(code({ restricted: gt("{not json", ["/canary"]) })).toBe("invalid_json");
    expect(code({ restricted: gt(GT_TEXT, ["canary"]) })).toBe("pointer_invalid");
    expect(code({ restricted: gt(GT_TEXT, []) })).toBe("canary_missing");
    const base = swap("conformance-baseline", { fileId: "conformance-baseline", kind: "json", content: BASELINE_TEXT, excludeSubtrees: ["units"] });
    expect(code({ restricted: base })).toBe("pointer_invalid");
    expect(code({ restricted: [...files, { ...files[1], fileId: "ground-truth" } as never] })).toBe("duplicate_id");
  });

  it("refuses a random source that gives a bad or repeated decoy", () => {
    expect(code({ randomHex: () => "0".repeat(24) })).toBe("decoy_invalid");
    expect(code({ randomHex: () => "xyz" })).toBe("decoy_invalid");
    expect(code({ randomHex: () => "abc" })).toBe("decoy_invalid");
  });

  it("puts no canary, decoy, fingerprint or restricted text into the summary or into an error", () => {
    const out = built();
    const c = parseAuditConfig(out.bytes);
    if (!c.ok) throw new Error("config");
    const secrets = [GT_CANARY, ...c.config.decoys.map((d) => d.value), ...c.config.fingerprints.flatMap((f) => f.hashes), GT_TEXT, MD_TEXT];
    const text = JSON.stringify(out.summary);
    expect(secrets.some((s) => text.includes(s)), "the summary contains a value").toBe(false);
    const failed = buildAuditConfig(baseInput({ restricted: files.map((f) => (f.fileId === "ground-truth" ? { ...f, content: "{broken " + GT_CANARY } : f)) }));
    expect(failed.ok).toBe(false);
    expect(JSON.stringify(failed).includes(GT_CANARY), "an error contains a value").toBe(false);
  });
});

describe("runAuditConfigBuilder: the run step", () => {
  it("reads only the given inputs, writes exactly the configuration to the output path, and returns the summary", async () => {
    const io = memoryIo(SYNTH_FILES);
    const r = await runAuditConfigBuilder(io, SYNTH_ARGS);
    expect(r.ok).toBe(true);
    expect(io.writes.map((w) => w.path)).toEqual([SYNTH_ARGS.outputPath]);
    expect([...io.reads].sort()).toEqual(Object.keys(SYNTH_FILES).sort());
    const written = io.writes[0] as { bytes: Uint8Array };
    expect(parseAuditConfig(written.bytes).ok).toBe(true);
    if (r.ok) expect(r.value.outputSha256).toBe(parseAuditConfig(written.bytes).ok ? (parseAuditConfig(written.bytes) as { sha256: string }).sha256 : "");
    // the same inputs and the same random source: the same bytes
    const again = memoryIo(SYNTH_FILES);
    await runAuditConfigBuilder(again, SYNTH_ARGS);
    expect(Buffer.from((again.writes[0] as { bytes: Uint8Array }).bytes).equals(Buffer.from(written.bytes))).toBe(true);
  });

  it("writes nothing when the build fails or an input is missing or is not UTF-8, and names the input, never its content", async () => {
    const missing = memoryIo(Object.fromEntries(Object.entries(SYNTH_FILES).filter(([k]) => k !== "/in/review.txt")));
    const r1 = await runAuditConfigBuilder(missing, SYNTH_ARGS);
    expect(r1).toEqual({ ok: false, error: { code: "input_unreadable", id: "review-package" } });
    expect(missing.writes).toHaveLength(0);
    const badUtf8: Record<string, string> = { ...SYNTH_FILES };
    const io = memoryIo(badUtf8);
    const orig = io.readFile;
    io.readFile = async (p) => (p === "/in/md.txt" ? new Uint8Array([0xff, 0xfe]) : orig(p));
    expect(await runAuditConfigBuilder(io, SYNTH_ARGS)).toEqual({ ok: false, error: { code: "input_not_utf8", id: "migration-decisions" } });
    const tooFew = memoryIo(SYNTH_FILES);
    const r2 = await runAuditConfigBuilder(tooFew, { ...SYNTH_ARGS, restricted: SYNTH_ARGS.restricted.slice(0, 2) });
    expect(r2).toEqual({ ok: false, error: { code: "too_few_restricted_files" } });
    expect(tooFew.writes).toHaveLength(0);
    const failing = memoryIo(SYNTH_FILES);
    failing.writeFile = async () => { throw new Error("disk"); };
    expect(await runAuditConfigBuilder(failing, SYNTH_ARGS)).toEqual({ ok: false, error: { code: "output_unwritable", id: "output" } });
  });

  it("refuses an output path in the evaluation directory or equal to an input, before reading anything", async () => {
    for (const outputPath of ["evaluation/x.json", "./Evaluation/ground-truth/audit.json", "C:\\repo\\evaluation\\out.json", "/mnt/evaluation", "", "/in/gt.json", "\\in\\GT.json"]) {
      const io = memoryIo(SYNTH_FILES);
      const r = await runAuditConfigBuilder(io, { ...SYNTH_ARGS, outputPath });
      expect(r.ok, outputPath).toBe(false);
      expect(io.reads, outputPath).toHaveLength(0);
      expect(io.writes, outputPath).toHaveLength(0);
    }
  });
});

describe("the builder is not part of the runtime", () => {
  const srcDir = join(import.meta.dirname, "..", "src");
  const listing = (): { path: string; text: string }[] => {
    const out: { path: string; text: string }[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith(".ts")) out.push({ path: p.replaceAll("\\", "/"), text: readFileSync(p, "utf8") });
      }
    };
    walk(srcDir);
    return out;
  };
  /** Files that import the builder (any import or dynamic import of a specifier ending in `auditConfigBuilder.js`), except the builder itself. */
  const importers = (files: { path: string; text: string }[]): string[] =>
    files.filter((f) => !f.path.endsWith("/auditConfigBuilder.ts") && /["'][^"']*auditConfigBuilder(\.js)?["']/.test(f.text)).map((f) => f.path);

  it("is imported by no source file, and is not named by the package entry", () => {
    expect(importers(listing())).toEqual([]);
    expect(readFileSync(join(srcDir, "index.ts"), "utf8")).not.toMatch(/auditConfigBuilder|buildAuditConfig|runAuditConfigBuilder/i);
  });

  it("positive control: the same check finds a module that does import the builder", () => {
    const planted = [...listing(), { path: "/x/src/provider.ts", text: 'import { buildAuditConfig } from "./auditConfigBuilder.js";' }, { path: "/x/src/y.ts", text: 'const m = await import("./auditConfigBuilder");' }];
    expect(importers(planted)).toEqual(["/x/src/provider.ts", "/x/src/y.ts"]);
  });

  it("imports nothing but the shared tokenizer module, the node hash, and types; and names no path of the evaluation directory", () => {
    const text = readFileSync(join(srcDir, "auditConfigBuilder.ts"), "utf8");
    const specs = [...text.matchAll(/^import\s+(type\s+)?[^"']*from\s+["']([^"']+)["']/gm)].map((m) => `${m[1] ? "type " : ""}${m[2]}`).sort();
    expect(specs).toEqual(["./tokenizer.js", "node:crypto", "type ./audit/types.js"].sort());
    expect(text).not.toMatch(/\bfrom\s+["']node:(fs|path|child_process|net|http|https|os)/);
    expect(text).not.toMatch(/evaluation[\\/]/i);
    expect(text).not.toMatch(/\b(fetch|XMLHttpRequest|WebSocket|process\.env)\b/);
  });

  it("the package entry exports no builder (the entry list is fixed by the auditedRequest test, and the deep import is refused)", async () => {
    const entry = await import("../src/index.js");
    expect(Object.keys(entry).some((k) => /builder/i.test(k))).toBe(false);
  });
});