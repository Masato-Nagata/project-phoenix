// Feature: discovery-loop, Property 19: The Payload_Auditor blocks forbidden content and passes verified content
// **Validates: Requirements 2.4, 2.5, 2.6, 2.7, 2.8, 2.13, 11.2, 11.3**
// Each generated payload violates exactly one check; a payload that violates none passes.
// Fixed seed and bounded run count so a failure can be reproduced. Only synthetic data is used. The generated values are descriptors of a
// violation (kind, slot, position), never a sensitive value, so a failing run prints nothing sensitive; assertions compare check ids and
// booleans, and a leak is reported by a label, not by the text.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REQUEST_KINDS, STORED_PART_TYPES, auditPayload, tokenize, tryCanonicalJson } from "../src/index.js";
import type { AuditCheckId, AuditResult, Json } from "../src/index.js";
import { ALLOWLIST, CANARY_VALUE, DECOY_VALUE, RESTRICTED_PREFIX, RESTRICTED_TEXTS, SECRET_NAME, SECRET_VALUE } from "./helpers/auditFixtures.js";
import { build } from "./helpers/propertyWorld.js";
import type { Built, PayloadSpec } from "./helpers/propertyWorld.js";

const FC = { seed: 19_001_001, numRuns: 150 };
const SENSITIVE_IDS: AuditCheckId[] = ["A05", "A06", "A07", "A08"];

// ---- generators of verified payloads ----
const word = fc.stringMatching(/^[a-z]{2,8}$/);
const hex6 = fc.stringMatching(/^[a-f0-9]{6}$/);
const textArb = fc.array(word, { maxLength: 24 }).map((w) => `<?php\n// ${w.join(" ")}\n`);
const contentArb = fc.jsonValue({ maxDepth: 3 }).filter((v) => tryCanonicalJson(v).ok) as fc.Arbitrary<Json>;
const specArb: fc.Arbitrary<PayloadSpec> = fc.shuffledSubarray([...ALLOWLIST], { minLength: 1, maxLength: 3 }).chain((paths) =>
  fc.record({
    kind: fc.constantFrom(...REQUEST_KINDS),
    sources: fc.array(textArb, { minLength: paths.length, maxLength: paths.length }).map((texts) => paths.map((path, i) => ({ path, text: texts[i] as string }))),
    stored: fc.array(fc.record({ type: fc.constantFrom(...STORED_PART_TYPES), content: contentArb }), { minLength: 1, maxLength: 3 }),
  }),
);

// ---- generators of violations (descriptors only) ----
const slotArb = fc.constantFrom("leaf", "key", "source");
const PATH_STYLES = ["unlisted", "upper", "backslash", "dotslash", "trailing_slash", "double_slash", "leading_space", "percent_encoded", "fullwidth_slash", "nul_suffix", "percent_letter", "fullwidth_letters"] as const;
const PREFIX_STYLES = ["plain", "upper", "backslash", "mixed_case", "embedded", "percent_slash", "percent_slash_lower", "double_encoded", "triple_encoded", "all_escaped", "fullwidth", "percent_backslash"] as const;
const BUNDLE_OPS = ["altered_text", "altered_hash", "added", "missing", "reordered"] as const;
const PART_OPS = ["unknown_type", "unknown_record", "altered_content", "altered_record_hash", "wrong_kind", "unknown_instruction", "instruction_hash"] as const;
type Violation =
  | { k: "canary" | "decoy" | "secret"; slot: string; pos: number; idx: number }
  | { k: "fingerprint"; slot: string; file: number; start: number; len: number; pos: number; idx: number; sep: string }
  | { k: "path"; style: (typeof PATH_STYLES)[number]; idx: number; junk: string }
  | { k: "prefix"; style: (typeof PREFIX_STYLES)[number]; slot: string; idx: number }
  | { k: "bundle"; op: (typeof BUNDLE_OPS)[number]; idx: number; junk: string }
  | { k: "part"; op: (typeof PART_OPS)[number]; idx: number; junk: string };
const violationArb: fc.Arbitrary<Violation> = fc.oneof(
  fc.record({ k: fc.constantFrom("canary", "decoy", "secret"), slot: slotArb, pos: fc.nat(500), idx: fc.nat(10) }),
  fc.record({ k: fc.constant("fingerprint"), slot: slotArb, file: fc.integer({ min: 0, max: 3 }), start: fc.nat(30), len: fc.integer({ min: 6, max: 10 }), pos: fc.nat(500), idx: fc.nat(10), sep: fc.constantFrom(" ", "\n", "\t", "  \n  ") }),
  fc.record({ k: fc.constant("path"), style: fc.constantFrom(...PATH_STYLES), idx: fc.nat(10), junk: hex6 }),
  fc.record({ k: fc.constant("prefix"), style: fc.constantFrom(...PREFIX_STYLES), slot: fc.constantFrom("leaf", "key"), idx: fc.nat(10) }),
  fc.record({ k: fc.constant("bundle"), op: fc.constantFrom(...BUNDLE_OPS), idx: fc.nat(10), junk: hex6 }),
  fc.record({ k: fc.constant("part"), op: fc.constantFrom(...PART_OPS), idx: fc.nat(10), junk: hex6 }),
) as fc.Arbitrary<Violation>;

// ---- applying a violation ----
const insertAt = (text: string, ins: string, pos: number): string => {
  const i = pos % (text.length + 1);
  return text.slice(0, i) + ins + text.slice(i);
};
/** Puts `ins` inside one string leaf of `content` at position `pos`; if the content has no string, inside a new leaf. */
function placeInContent(content: Json, ins: string, pos: number): Json {
  const copy = structuredClone(content);
  const leaves: { set: (s: string) => void; get: () => string }[] = [];
  const walk = (parent: any, key: string | number): void => {
    const v = parent[key];
    if (typeof v === "string") leaves.push({ get: () => parent[key], set: (s) => (parent[key] = s) });
    else if (Array.isArray(v)) v.forEach((_x, i) => walk(v, i));
    else if (v !== null && typeof v === "object") Object.keys(v).forEach((k) => walk(v, k));
  };
  const holder = { root: copy };
  walk(holder, "root");
  if (leaves.length === 0) return { data: copy, note: insertAt("pad pad", ins, pos) };
  const leaf = leaves[pos % leaves.length] as (typeof leaves)[number];
  leaf.set(insertAt(leaf.get(), ins, pos));
  return holder.root;
}
const variantPath = (p: string, style: (typeof PATH_STYLES)[number], junk: string): string => {
  switch (style) {
    case "unlisted": return `legacy/src/x${junk}.php`;
    case "upper": return p.toUpperCase();
    case "backslash": return p.replaceAll("/", "\\");
    case "dotslash": return `./${p}`;
    case "trailing_slash": return `${p}/`;
    case "double_slash": return p.replace("/", "//");
    case "leading_space": return ` ${p}`;
    case "percent_encoded": return p.replaceAll("/", "%2F");
    case "fullwidth_slash": return p.replaceAll("/", "\uff0f");
    case "nul_suffix": return `${p}\u0000`;
    case "percent_letter": return `%6C${p.slice(1)}`;
    case "fullwidth_letters": return toFullwidth(p);
  }
};
const toFullwidth = (s: string): string => [...s].map((c) => (c >= "!" && c <= "~" ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join("");
const escapeAll = (s: string): string => [...s].map((c) => [...new TextEncoder().encode(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("")).join("");
const NO_SLASH = RESTRICTED_PREFIX.slice(0, -1);
const variantPrefix = (style: (typeof PREFIX_STYLES)[number]): string => {
  switch (style) {
    case "plain": return `see ${RESTRICTED_PREFIX}file.json`;
    case "upper": return `see ${RESTRICTED_PREFIX.toUpperCase()}file.json`;
    case "backslash": return `see ${RESTRICTED_PREFIX.replaceAll("/", "\\")}file.json`;
    case "mixed_case": return `see Fictional-Restricted-AREA/file.json`;
    case "embedded": return `a//./${RESTRICTED_PREFIX}/b`;
    case "percent_slash": return `see ${NO_SLASH}%2Ffile.json`;
    case "percent_slash_lower": return `see ${NO_SLASH.toUpperCase()}%2ffile.json`;
    case "double_encoded": return `see ${NO_SLASH}%252Ffile.json`;
    case "triple_encoded": return `see ${NO_SLASH}%25252Ffile.json`;
    case "all_escaped": return `see ${escapeAll(RESTRICTED_PREFIX)}file.json`;
    case "fullwidth": return `see ${toFullwidth(RESTRICTED_PREFIX)}file.json`;
    case "percent_backslash": return `see ${NO_SLASH}%5Cfile.json`;
  }
};

interface Applied {
  built: Built;
  expectId: AuditCheckId;
  /** Exact `matches` expected, or undefined when only the check id is asserted. */
  matches?: { checkId: AuditCheckId; matchId: string }[];
}
function apply(base: PayloadSpec, v: Violation): Applied {
  const spec: PayloadSpec = structuredClone(base);
  const si = (i: number): number => i % spec.sources.length;
  const ti = (i: number): number => i % spec.stored.length;
  const slotted = (slot: string, ins: string, pos: number, idx: number, tokenSafe = false): void => {
    const text = tokenSafe ? ` ${ins} ` : ins;
    if (slot === "source") {
      const s = spec.sources[si(idx)] as { text: string };
      s.text = insertAt(s.text, text, pos);
    } else if (slot === "key") {
      const t = spec.stored[ti(idx)] as { content: Json };
      t.content = { data: t.content, [`a${text}b`]: 0 };
    } else {
      const t = spec.stored[ti(idx)] as { content: Json };
      t.content = placeInContent(t.content, text, pos);
    }
  };
  switch (v.k) {
    case "canary":
    case "decoy":
    case "secret": {
      const value = v.k === "canary" ? CANARY_VALUE : v.k === "decoy" ? DECOY_VALUE : SECRET_VALUE;
      slotted(v.slot, value, v.pos, v.idx);
      const id: AuditCheckId = v.k === "secret" ? "A08" : "A06";
      const matchId = v.k === "canary" ? "canary-1" : v.k === "decoy" ? "decoy-1" : SECRET_NAME;
      return { built: build(spec), expectId: id, matches: [{ checkId: id, matchId }] };
    }
    case "fingerprint": {
      const tokens = tokenize(RESTRICTED_TEXTS[v.file] as string);
      const len = Math.min(v.len, tokens.length);
      const start = v.start % (tokens.length - len + 1);
      // The tokens may be separated by any whitespace: in the payload bytes a newline is the two characters `\n`, so only a scan of the decoded strings sees it.
      slotted(v.slot, tokens.slice(start, start + len).join(v.sep), v.pos, v.idx, true);
      return { built: build(spec), expectId: "A07", matches: [{ checkId: "A07", matchId: `fp-${v.file + 1}` }] };
    }
    case "path": {
      const s = spec.sources[si(v.idx)] as { path: string };
      s.path = variantPath(s.path, v.style, v.junk);
      return { built: build(spec), expectId: "A05" };
    }
    case "prefix": {
      const t = spec.stored[ti(v.idx)] as { content: Json };
      const text = variantPrefix(v.style);
      t.content = v.slot === "key" ? { data: t.content, [text]: 0 } : { data: t.content, note: text };
      return { built: build(spec), expectId: "A05", matches: [{ checkId: "A05", matchId: "restricted_path_prefix:0" }] };
    }
    case "bundle": {
      const built = build(spec);
      const parts = built.env["parts"] as any[];
      const n = spec.sources.length;
      const i = v.idx % n;
      const op = v.op === "reordered" && n < 2 ? "altered_text" : v.op;
      if (op === "altered_text") parts[i].text += "x";
      else if (op === "altered_hash") parts[i].sha256Lf = "0".repeat(58) + v.junk;
      else if (op === "added") parts.splice(n, 0, { ...structuredClone(parts[0]), partId: "extra1" });
      else if (op === "missing") parts.splice(i, 1);
      else [parts[0], parts[1]] = [parts[1], parts[0]];
      return { built, expectId: "A04" };
    }
    case "part": {
      const built = build(spec);
      const parts = built.env["parts"] as any[];
      const first = spec.sources.length; // index of the first stored part
      const j = first + (v.idx % spec.stored.length);
      const part = parts[j];
      if (v.op === "unknown_type") parts.push({ partId: "u1", type: `zz${v.junk}` });
      else if (v.op === "unknown_record") part.recordId = `rec-9${v.junk}`;
      else if (v.op === "altered_content") part.content = { tampered: part.content };
      else if (v.op === "altered_record_hash") part.recordSha256 = "0".repeat(58) + v.junk;
      else if (v.op === "wrong_kind") (built.records.get(part.recordId) as { kind: string }).kind = STORED_PART_TYPES.find((t) => t !== part.type) as string;
      else if (v.op === "unknown_instruction") built.env["instruction"].templateId = `zz-${v.junk}`;
      else built.env["instruction"].sha256 = "0".repeat(58) + v.junk;
      // a bad instruction is not tied to a part, so it has no part identifier; every other fault names the part
      const instructionFault = v.op === "unknown_instruction" || v.op === "instruction_hash";
      return instructionFault ? { built, expectId: "A03", matches: [] } : { built, expectId: "A03" };
    }
  }
}

const run = (b: Built, kind: PayloadSpec["kind"]) => auditPayload(b.bytes(), kind, b.cfg, b.ctx);
const failedIds = (a: AuditResult): AuditCheckId[] => a.checks.filter((c) => c.outcome === "fail").map((c) => c.id);
const leaks = (a: AuditResult): boolean => {
  const text = JSON.stringify({ ...a, auditedBytes: undefined });
  return [CANARY_VALUE, DECOY_VALUE, SECRET_VALUE, RESTRICTED_PREFIX, ...RESTRICTED_TEXTS].some((s) => text.toLowerCase().includes(s.toLowerCase()));
};

describe("Property 19: the Payload_Auditor blocks forbidden content and passes verified content", () => {
  it("passes every payload built only from verified parts, and returns a request bound to the audited hash and the bytes", () => {
    fc.assert(
      fc.property(specArb, (spec) => {
        const b = build(spec);
        const bytes = b.bytes();
        const { audit, request } = auditPayload(bytes, spec.kind, b.cfg, b.ctx);
        expect(audit.result).toBe("pass");
        expect(audit.checks.every((c) => c.outcome === "pass")).toBe(true);
        expect(audit.matches).toEqual([]);
        expect(audit.bytesWithheld).toBe(false);
        expect(request !== undefined && request.sha256 === audit.payloadSha256 && request.kind === spec.kind).toBe(true);
        expect(Buffer.from(audit.auditedBytes as Uint8Array).equals(Buffer.from(bytes))).toBe(true);
      }),
      FC,
    );
  });

  it("blocks a payload with exactly one violation at the matching check only, with an identifier, never the value, and creates no request", () => {
    fc.assert(
      fc.property(specArb, violationArb, (spec, v) => {
        const a = apply(spec, v);
        const { audit, request } = run(a.built, spec.kind);
        expect(audit.result, "the payload with one violation was not blocked").toBe("blocked");
        expect(request === undefined, "an AuditedRequest was created for a blocked payload").toBe(true);
        expect(failedIds(audit), "the violation was not isolated to the expected check").toEqual([a.expectId]);
        expect(audit.checks.filter((c) => c.id !== a.expectId).every((c) => c.outcome === "pass"), "another check did not pass").toBe(true);
        if (a.matches !== undefined) expect(audit.matches).toEqual(a.matches);
        else expect(audit.matches.length > 0 && audit.matches.every((m) => m.checkId === a.expectId), "no identifier at the matching check").toBe(true);
        expect(leaks(audit), "a result contains a sensitive value").toBe(false);
        // R2.2 exception: the bytes are returned only when A05 to A08 all passed
        const sensitiveHit = SENSITIVE_IDS.includes(a.expectId);
        expect(audit.bytesWithheld).toBe(sensitiveHit);
        expect(audit.auditedBytes === undefined).toBe(sensitiveHit);
      }),
      { ...FC, numRuns: 300 },
    );
  });

  it("finds a canary, decoy, secret or restricted-content window at any position of any string slot (value, key, source text)", () => {
    const kinds = fc.constantFrom("canary", "decoy", "secret", "fingerprint");
    fc.assert(
      fc.property(specArb, kinds, slotArb, fc.nat(2000), fc.nat(10), fc.integer({ min: 0, max: 3 }), fc.constantFrom(" ", "\n", "\t", "  \n  "), (spec, k, slot, pos, idx, file, sep) => {
        const v: Violation = k === "fingerprint" ? { k, slot, file, start: pos, len: 6, pos, idx, sep } : { k, slot, pos, idx };
        const a = apply(spec, v);
        const { audit, request } = run(a.built, spec.kind);
        expect(request === undefined && audit.result === "blocked").toBe(true);
        expect(failedIds(audit)).toEqual([a.expectId]);
        expect(audit.matches).toEqual(a.matches);
      }),
      FC,
    );
  });

  it("does not let a notation of a path get around the allowlist or the restricted path prefix (case, separators, ./, //, encoding, width, NUL)", () => {
    fc.assert(
      fc.property(specArb, fc.constantFrom(...PATH_STYLES), fc.nat(10), hex6, (spec, style, idx, junk) => {
        const a = apply(spec, { k: "path", style, idx, junk });
        const { audit, request } = run(a.built, spec.kind);
        expect(request === undefined && audit.result === "blocked", `path style ${style} was accepted`).toBe(true);
        expect(failedIds(audit), `path style ${style}`).toEqual(["A05"]);
      }),
      FC,
    );
    fc.assert(
      fc.property(specArb, fc.constantFrom(...PREFIX_STYLES), fc.constantFrom("leaf", "key"), fc.nat(10), (spec, style, slot, idx) => {
        const a = apply(spec, { k: "prefix", style, slot, idx });
        const { audit, request } = run(a.built, spec.kind);
        expect(request === undefined && audit.result === "blocked", `prefix style ${style} was accepted`).toBe(true);
        expect(failedIds(audit), `prefix style ${style}`).toEqual(["A05"]);
      }),
      FC,
    );
  });

  it("blocks a Source_Bundle that is altered, added to, missing a file, or reordered, naming the manifest path and nothing from the payload (R2.6)", () => {
    fc.assert(
      fc.property(specArb, fc.constantFrom(...BUNDLE_OPS), fc.nat(10), hex6, (spec, op, idx, junk) => {
        const a = apply(spec, { k: "bundle", op, idx, junk });
        const { audit, request } = run(a.built, spec.kind);
        expect(request === undefined && audit.result === "blocked").toBe(true);
        expect(failedIds(audit)).toEqual(["A04"]);
        const manifestPaths = spec.sources.map((s) => s.path);
        expect(audit.matches.length > 0 && audit.matches.every((m) => m.checkId === "A04" && manifestPaths.includes(m.matchId)), "a match is not a manifest path").toBe(true);
        expect(audit.bytesWithheld, "A05 to A08 passed, so the bytes are returned").toBe(false);
      }),
      FC,
    );
  });

  it("blocks a part that is not a verified stored artifact of the Run, or an instruction that is not the fixed text (R2.7, R11.2, R11.3)", () => {
    fc.assert(
      fc.property(specArb, fc.constantFrom(...PART_OPS), fc.nat(10), hex6, (spec, op, idx, junk) => {
        const a = apply(spec, { k: "part", op, idx, junk });
        const { audit, request } = run(a.built, spec.kind);
        expect(request === undefined && audit.result === "blocked").toBe(true);
        expect(failedIds(audit)).toEqual(["A03"]);
        expect(audit.matches.every((m) => m.checkId === "A03" && /^part:\d+$/.test(m.matchId)), "a match is not a part index").toBe(true);
      }),
      FC,
    );
  });

  it("is a pure function of its inputs: the same payload gives the same result (R2.13 base case for every generated payload)", () => {
    fc.assert(
      fc.property(specArb, violationArb, (spec, v) => {
        const a = apply(spec, v);
        const x = run(a.built, spec.kind).audit;
        const y = run(a.built, spec.kind).audit;
        expect(JSON.stringify({ ...x, auditedBytes: undefined })).toBe(JSON.stringify({ ...y, auditedBytes: undefined }));
      }),
      { ...FC, numRuns: 100 },
    );
  });
});