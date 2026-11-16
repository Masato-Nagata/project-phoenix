// Detection of restricted path prefixes written in another notation (NFKC, percent decoding), and what it does not touch.
// Decided by the human: a lone `%` in ordinary text is allowed; normalization and decoding serve the restricted-prefix scan only and never the
// allowlist (exact string equality); invalid UTF-8 in an escape sequence and ambiguous (too deeply nested) encoding fail closed; ordinary
// Japanese text must not be blocked. Synthetic data only; assertions compare check ids and codes, never the text of a payload.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { auditPayload } from "../src/index.js";
import type { AuditCheckId, AuditResult, Json } from "../src/index.js";
import { ALLOWLIST, RESTRICTED_PREFIX, SOURCE_A, SOURCE_B, makeWorld } from "./helpers/auditFixtures.js";

const KIND = "hypothesis_revision" as const;
const NO_SLASH = RESTRICTED_PREFIX.slice(0, -1);
const toFullwidth = (s: string): string => [...s].map((c) => (c >= "!" && c <= "~" ? String.fromCharCode(c.charCodeAt(0) + 0xfee0) : c)).join("");
const escapeAll = (s: string): string => [...s].map((c) => [...new TextEncoder().encode(c)].map((b) => `%${b.toString(16).toUpperCase().padStart(2, "0")}`).join("")).join("");
const auditContent = (content: Json): AuditResult => {
  const w = makeWorld({ storedContent: content });
  return auditPayload(w.bytes(w.envelope()), KIND, w.cfg, w.ctx).audit;
};
const failedIds = (a: AuditResult): AuditCheckId[] => a.checks.filter((c) => c.outcome === "fail").map((c) => c.id);
const detail = (a: AuditResult): string | undefined => a.checks.find((c) => c.id === "A05")?.detail;

describe("restricted path prefix: other notations are found", () => {
  const variants: [string, string][] = [
    ["percent-encoded slash", `see ${NO_SLASH}%2Ffile.json`],
    ["lower-case escape", `see ${NO_SLASH}%2ffile.json`],
    ["percent-encoded backslash", `see ${NO_SLASH}%5Cfile.json`],
    ["every character escaped", `see ${escapeAll(RESTRICTED_PREFIX)}file.json`],
    ["double encoded", `see ${NO_SLASH}%252Ffile.json`],
    ["triple encoded", `see ${NO_SLASH}%25252Ffile.json`],
    ["double encoded, every character", `see ${escapeAll(escapeAll(RESTRICTED_PREFIX))}file.json`],
    ["fullwidth letters and slash", `see ${toFullwidth(RESTRICTED_PREFIX)}file.json`],
    ["fullwidth percent sign", `see ${NO_SLASH}${toFullwidth("%2F")}file.json`],
    ["fullwidth and upper case", `see ${toFullwidth(RESTRICTED_PREFIX.toUpperCase())}file.json`],
    ["escape inside a longer text", `Fix the file at ${NO_SLASH.toUpperCase()}%2Fa%2Fb and continue.`],
  ];
  it.each(variants)("blocks %s, naming the prefix by index only", (_name, text) => {
    for (const content of [{ note: text }, { [text]: 1 }] as Json[]) {
      const a = auditContent(content);
      expect(failedIds(a)).toEqual(["A05"]);
      expect(detail(a)).toBe("restricted_path_prefix");
      expect(a.matches).toEqual([{ checkId: "A05", matchId: "restricted_path_prefix:0" }]);
      expect(a.bytesWithheld).toBe(true);
    }
  });

  it("does not put the encoded text into the result", () => {
    const a = auditContent({ note: `see ${escapeAll(RESTRICTED_PREFIX)}file.json` });
    const text = JSON.stringify({ ...a, auditedBytes: undefined });
    expect(text.includes("%66") || text.toLowerCase().includes("fictional")).toBe(false);
  });
});

describe("restricted path prefix: invalid or ambiguous encoding fails closed", () => {
  it("blocks escape sequences that are not valid UTF-8 (lone byte, truncated sequence, overlong form, surrogate)", () => {
    for (const text of ["bad %FF byte", "cut %E3%81 short", "overlong %C0%AF slash", "surrogate %ED%A0%80 half", "start %80 only"]) {
      const a = auditContent({ note: text });
      expect(failedIds(a), text).toEqual(["A05"]);
      expect(detail(a), text).toBe("path_encoding_invalid");
      expect(a.matches.every((m) => /^restricted_path_encoding:\d+$/.test(m.matchId))).toBe(true);
      expect(a.bytesWithheld).toBe(true);
    }
  });

  it("blocks an encoding nested more than three times, and still finds a prefix hidden in three layers", () => {
    const four = auditContent({ note: "x %2525252F y" });
    expect(failedIds(four)).toEqual(["A05"]);
    expect(detail(four)).toBe("path_encoding_ambiguous");
    expect(detail(auditContent({ note: `${NO_SLASH}%25252F` }))).toBe("restricted_path_prefix");
    expect(detail(auditContent({ note: `${NO_SLASH}%2525252F` }))).toBe("path_encoding_ambiguous");
  });

  it("blocks a stray percent sign that forms a new escape with the text decoded after it, instead of letting it through", () => {
    const a = auditContent({ note: `%d${escapeAll(RESTRICTED_PREFIX)}a` });
    expect(failedIds(a)).toEqual(["A05"]);
    expect(detail(a)).toBe("path_encoding_invalid");
  });

  it("names the position of the string, not the string, and blocks a key with a bad escape too", () => {
    const a = auditContent({ ["bad%FFkey"]: 1 });
    expect(detail(a)).toBe("path_encoding_invalid");
    expect(JSON.stringify(a.matches).includes("bad")).toBe(false);
  });
});

describe("ordinary text is not blocked", () => {
  const prose = [
    "割引率は50%です。", "合計は100%達成しました。", "進捗：３０％（目標は８０％）", "%を含む文章を書きます。", "売上が20%増加しました（前年比）。",
    "注文数は 5% 以下に抑えること。", "100%", "%", "%%", "50% off と 割引50％", "税率10%と8%の違い。", "この価格は%ですか？", "完了率:99.5%(速報値)",
    "日本語のテキスト、ひらがな・カタカナ・漢字、ｶﾀｶﾅ（半角）、全角ＡＢＣ１２３。", "顧客番号はＣ－０００１で、注文は３件。",
    "The rate is 5% and the cap is 100%.", "100%OFF is not an escape, nor is 5%x.", "%d items and %s names", "表示は 100%-ok です。",
    "URLの%20は空白、%2Fはスラッシュを表します。", "%E6%97%A5%E6%9C%AC (日本) のエンコード", "%E3%81%82%E3%81%84 (あい)", "path/to/file and a/b/c",
    "legacy src の話", "evaluation という単語だけ", "fictional restricted area の説明", "restricted-area/ だけでは接頭辞ではない",
  ];
  it.each(prose)("passes %s", (text) => {
    for (const content of [{ note: text }, { [text]: 1 }, [text]] as Json[]) {
      const a = auditContent(content);
      expect(a.result, "ordinary text was blocked").toBe("pass");
    }
  });

  it("passes a whole Japanese hypothesis text with percent signs", () => {
    const text = "条件：注文の合計が1000円以上のとき、割引率は5%または10%になる。ただし、会員は＋2%の追加割引を受けられる（上限は15%）。理由は不明であり、ソースの該当行を確認する必要がある。";
    expect(auditContent({ description: text, openQuestions: [text, "%の扱い（切り捨てか四捨五入か）は不明。"] }).result).toBe("pass");
  });
});

describe("the allowlist is not touched by normalization or decoding", () => {
  const one = (path: string): AuditResult => {
    const w = makeWorld({ sources: [{ path, text: "<?php\n// fictional\n" }] });
    return auditPayload(w.bytes(w.envelope()), KIND, w.cfg, w.ctx).audit;
  };
  it("accepts the exact path and refuses every path that only becomes an allowlisted path after NFKC or decoding", () => {
    expect(one(SOURCE_A.path).result).toBe("pass");
    for (const p of ALLOWLIST) {
      for (const variant of [p.replaceAll("/", "%2F"), `%6C${p.slice(1)}`, toFullwidth(p), p.replace(".", "%2E"), escapeAll(p), p.replaceAll("/", "%252F"), p.replace("/", "\uff0f")]) {
        const a = one(variant);
        expect(a.result, "a notation of an allowlisted path was accepted").toBe("blocked");
        expect(failedIds(a)).toEqual(["A05"]);
        expect(detail(a)).toBe("path_not_allowlisted");
      }
    }
    expect(one(SOURCE_B.path).result).toBe("pass");
  });
});

describe("properties (fixed seed 38001001)", () => {
  const FC = { seed: 38_001_001, numRuns: 150 };
  const encodeAllOnce = (s: string): string => escapeAll(s);
  const hiragana = fc.stringMatching(/^[ぁ-んァ-ヶ一-龥、。ー]{1,14}$/);
  const snippet = fc.oneof(
    hiragana,
    fc.constantFrom("50% ", "100%達成", "％", "%を", "5%", " %、", "ABC", "legacy", "evaluation", "(10%)", "%d", "％２０"),
    fc.stringMatching(/^[a-z ]{1,10}$/),
  );

  it("finds the prefix in up to three layers of full escaping, with the rest of the text around it, and blocks four layers as ambiguous", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), fc.boolean(), snippet, snippet, (layers, upper, before, after) => {
        let enc = upper ? RESTRICTED_PREFIX.toUpperCase() : RESTRICTED_PREFIX;
        for (let i = 0; i < layers; i++) enc = encodeAllOnce(enc);
        const a = auditContent({ note: `${before}${enc}${after}` });
        expect(failedIds(a), `layers ${layers}`).toEqual(["A05"]);
        // A stray `%` plus a hexadecimal letter in front of the escaped text can form a new escape after decoding (`%d` + `%66...` gives `%df...`);
        // that is invalid UTF-8 and fails closed. Either way the payload is blocked, and nothing is allowed through.
        // (at three layers the new escape needs a fourth pass, which is `path_encoding_ambiguous`.)
        const expected = layers <= 3 ? ["restricted_path_prefix", "path_encoding_invalid", "path_encoding_ambiguous"] : ["path_encoding_ambiguous", "path_encoding_invalid"];
        expect(expected.includes(detail(a) as string), `layers ${layers}`).toBe(true);
      }),
      FC,
    );
  });

  it("does not block ordinary Japanese or English prose with lone percent signs", () => {
    fc.assert(
      fc.property(fc.array(snippet, { minLength: 1, maxLength: 8 }), (parts) => {
        // Snippets are joined by a space: a `%` directly followed by two hexadecimal letters is an escape by definition (see the notes of the report).
        const a = auditContent({ note: parts.join(" ") });
        expect(a.result, "ordinary text was blocked").toBe("pass");
      }),
      FC,
    );
  });

  it("never lets the encoded form widen the allowlist: a path is accepted only when it is exactly in both lists", () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALLOWLIST), fc.integer({ min: 1, max: 2 }), (path, layers) => {
        let enc = path;
        for (let i = 0; i < layers; i++) enc = encodeAllOnce(enc);
        const w = makeWorld({ sources: [{ path: enc, text: "<?php\n// fictional\n" }] });
        const a = auditPayload(w.bytes(w.envelope()), KIND, w.cfg, w.ctx).audit;
        expect(a.result).toBe("blocked");
        expect(detail(a)).toBe("path_not_allowlisted");
      }),
      FC,
    );
  });
});