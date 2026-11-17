// Run-time `import_analysis` scanner (design item 7). Pure: no file, no clock, no process access.
//
// It scans the text of the first-party compiled `.js`, `.mjs` and `.cjs` files, classifies every import construct it knows, and FAILS on
// every construct it does not know (fail-closed). It looks at import specifiers only; it does NOT scan string literals for evaluation
// paths at run time (the run time itself holds the probe paths and would flag itself; that scan is test-time only, task 4.11).
//
// This is a SELF-ATTESTATION of the bundle by the bundle (residual risk `import_analysis_self_attestation`). It is a lexer plus token
// patterns, not a full JavaScript parser. Known limits that are NOT detected: an alias of `process` followed by `.binding`, a function
// constructor reached through `.constructor`, and a regular-expression / division ambiguity after `)` or `}` (the lexer treats `/` after them
// as division; a wrong guess normally ends in an unterminated state, which fails). Its false failures on the real `dist/` are
// unmeasured until task 4.9 (UNVERIFIED).
import { createHash } from "node:crypto";

export type FindingCode = "forbidden_import" | "unclassified_syntax";
export type FindingKind =
  | "forbidden_specifier"
  | "non_literal_specifier"
  | "escaped_specifier"
  | "require_other_use"
  | "create_require"
  | "eval"
  | "function_constructor"
  | "import_meta_resolve"
  | "process_dlopen"
  | "process_binding"
  | "lexical_unterminated"
  | "invalid_utf8"
  | "identifier_escape"
  | "executable_artifact"
  | "unknown_file_type"
  | "unrecognized_import_form"
  | "unrecognized_export_form";

export interface Finding {
  readonly file: string;
  readonly code: FindingCode;
  readonly kind: FindingKind;
}

export interface ScanResult {
  readonly findings: readonly Finding[];
  readonly filesTotal: number;
  readonly filesScanned: number;
  readonly specifierCount: number;
  readonly bareSpecifierCount: number;
  /** SHA-256 over the sorted (path, SHA-256 of text) pairs of the text that the port delivered. NOT the `bundleSha256` of the manifest. */
  readonly textSha256: string;
}

const EVALUATOR_NAME = "spec-restoration-evaluator";
const FORBIDDEN_SEGMENT = "evaluation";
const SCRIPT_EXT = [".js", ".mjs", ".cjs"];
const DATA_EXT = [".json", ".d.ts", ".d.mts", ".d.cts", ".map", ".tsbuildinfo"];
const BINARY_EXT = [".node", ".wasm"];
const REGEX_AFTER_KEYWORD = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
const NO_REGEX_AFTER_PUNCT = new Set([")", "]", "}", "++", "--"]);

class Unclassified extends Error {
  constructor(readonly kind: FindingKind) {
    super(kind);
  }
}

interface Tok {
  t: "id" | "p" | "str" | "tpl" | "num" | "re";
  v: string;
  subst?: boolean;
}

const isIdStart = (c: string): boolean => /[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127;
const isIdPart = (c: string): boolean => /[A-Za-z0-9_$]/.test(c) || c.charCodeAt(0) > 127;

function lex(s: string): Tok[] {
  if (s.includes("\uFFFD")) throw new Unclassified("invalid_utf8");
  const out: Tok[] = [];
  const n = s.length;
  let i = 0;
  let depth = 0;
  const tplDepths: number[] = [];
  if (s.startsWith("#!")) while (i < n && s[i] !== "\n") i++;

  // reads template characters from `i` (just after "`" or after the closing "}" of a substitution); returns true when it ended at "${"
  const readTemplate = (tok: Tok | undefined): void => {
    let raw = "";
    for (;;) {
      if (i >= n) throw new Unclassified("lexical_unterminated");
      const c = s[i] as string;
      if (c === "\\") {
        raw += s.slice(i, i + 2);
        i += 2;
      } else if (c === "`") {
        i++;
        if (tok !== undefined && tok.subst !== true) tok.v = raw;
        return;
      } else if (c === "$" && s[i + 1] === "{") {
        i += 2;
        if (tok !== undefined) tok.subst = true;
        tplDepths.push(depth);
        return;
      } else {
        raw += c;
        i++;
      }
    }
  };

  while (i < n) {
    const c = s[i] as string;
    if (/\s/.test(c) || c === "\uFEFF") {
      i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "/") {
      while (i < n && s[i] !== "\n" && s[i] !== "\r") i++;
      continue;
    }
    if (c === "/" && s[i + 1] === "*") {
      const end = s.indexOf("*/", i + 2);
      if (end < 0) throw new Unclassified("lexical_unterminated");
      i = end + 2;
      continue;
    }
    if (c === "\\") throw new Unclassified("identifier_escape");
    if (isIdStart(c)) {
      const st = i;
      i++;
      while (i < n && isIdPart(s[i] as string)) i++;
      if (s[i] === "\\") throw new Unclassified("identifier_escape");
      out.push({ t: "id", v: s.slice(st, i) });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(s[i + 1] ?? ""))) {
      const st = i;
      i++;
      while (i < n && (/[0-9A-Za-z_.]/.test(s[i] as string) || ((s[i] === "+" || s[i] === "-") && /[eE]/.test(s[i - 1] as string) && !/^0[xX]/.test(s.slice(st, i))))) i++;
      out.push({ t: "num", v: s.slice(st, i) });
      continue;
    }
    if (c === '"' || c === "'") {
      const st = ++i;
      for (;;) {
        if (i >= n) throw new Unclassified("lexical_unterminated");
        const d = s[i] as string;
        if (d === "\\") {
          i += 2;
        } else if (d === c) break;
        else if (d === "\n" || d === "\r") throw new Unclassified("lexical_unterminated");
        else i++;
      }
      out.push({ t: "str", v: s.slice(st, i) });
      i++;
      continue;
    }
    if (c === "`") {
      i++;
      const tok: Tok = { t: "tpl", v: "" };
      out.push(tok);
      readTemplate(tok);
      continue;
    }
    if (c === "/") {
      const prev = out[out.length - 1];
      const regexAllowed =
        prev === undefined ||
        (prev.t === "p" && !NO_REGEX_AFTER_PUNCT.has(prev.v)) ||
        (prev.t === "id" && REGEX_AFTER_KEYWORD.has(prev.v));
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        for (;;) {
          if (j >= n) throw new Unclassified("lexical_unterminated");
          const d = s[j] as string;
          if (d === "\n" || d === "\r") throw new Unclassified("lexical_unterminated");
          if (d === "\\") j += 2;
          else if (d === "[") {
            inClass = true;
            j++;
          } else if (d === "]") {
            inClass = false;
            j++;
          } else if (d === "/" && !inClass) break;
          else j++;
        }
        j++;
        while (j < n && isIdPart(s[j] as string)) j++;
        out.push({ t: "re", v: "" });
        i = j;
        continue;
      }
    }
    if ((c === "+" || c === "-") && s[i + 1] === c) {
      out.push({ t: "p", v: c + c });
      i += 2;
      continue;
    }
    if (c === "{") depth++;
    if (c === "}") {
      if (tplDepths.length > 0 && tplDepths[tplDepths.length - 1] === depth) {
        tplDepths.pop();
        i++;
        readTemplate(undefined);
        continue;
      }
      depth--;
    }
    out.push({ t: "p", v: c });
    i++;
  }
  if (tplDepths.length > 0) throw new Unclassified("lexical_unterminated");
  return out;
}

const isPlainLiteral = (t: Tok | undefined): t is Tok => t !== undefined && (t.t === "str" || (t.t === "tpl" && t.subst !== true));
const isP = (t: Tok | undefined, v: string): boolean => t !== undefined && t.t === "p" && t.v === v;
const isId = (t: Tok | undefined, v: string): boolean => t !== undefined && t.t === "id" && t.v === v;

function normalizeSegments(rel: string, spec: string): string[] {
  const base = rel.replace(/\\/g, "/").split("/").slice(0, -1);
  const parts = spec.replace(/\\/g, "/").split("/");
  const out = spec.startsWith("/") ? [] : base;
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === ".." && out.length > 0 && out[out.length - 1] !== "..") out.pop();
    else out.push(p);
  }
  return out;
}

/** True when the specifier, taken as text or resolved against the importing file, names an evaluation path segment or the evaluator package. */
export function isForbiddenSpecifier(rel: string, spec: string): boolean {
  const lower = spec.toLowerCase();
  if (lower.includes(EVALUATOR_NAME)) return true;
  const textSegments = lower.split(/[\\/]/);
  if (textSegments.includes(FORBIDDEN_SEGMENT)) return true;
  if (spec.startsWith(".") || spec.startsWith("/")) {
    const resolved = normalizeSegments(rel, spec).map((x) => x.toLowerCase());
    if (resolved.includes(FORBIDDEN_SEGMENT)) return true;
    if (resolved.join("/").includes(EVALUATOR_NAME)) return true;
  }
  return false;
}

function analyzeText(rel: string, text: string): { findings: Finding[]; specifiers: string[] } {
  const findings: Finding[] = [];
  const specifiers: string[] = [];
  const add = (code: FindingCode, kind: FindingKind): void => {
    findings.push({ file: rel, code, kind });
  };
  let toks: Tok[];
  try {
    toks = lex(text);
  } catch (e) {
    if (e instanceof Unclassified) add("unclassified_syntax", e.kind);
    else add("unclassified_syntax", "lexical_unterminated");
    return { findings, specifiers };
  }
  const useSpecifier = (t: Tok | undefined): void => {
    if (!isPlainLiteral(t)) {
      add("unclassified_syntax", "non_literal_specifier");
      return;
    }
    if (t.v.includes("\\")) {
      add("unclassified_syntax", "escaped_specifier");
      return;
    }
    if (t.v.includes("%")) {
      add("unclassified_syntax", "escaped_specifier");
      return;
    }
    specifiers.push(t.v);
    if (isForbiddenSpecifier(rel, t.v)) add("forbidden_import", "forbidden_specifier");
  };
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i] as Tok;
    if (tk.t !== "id") continue;
    const prev = toks[i - 1];
    const next = toks[i + 1];
    const afterDot = isP(prev, ".");
    switch (tk.v) {
      case "import": {
        if (afterDot) break;
        if (isP(next, "(")) {
          const arg = toks[i + 2];
          if (isPlainLiteral(arg) && isP(toks[i + 3], ")")) useSpecifier(arg);
          else add("unclassified_syntax", "non_literal_specifier");
        } else if (isP(next, ".")) {
          if (isId(toks[i + 2], "meta") && isP(toks[i + 3], ".") && isId(toks[i + 4], "resolve")) add("unclassified_syntax", "import_meta_resolve");
        } else if (next !== undefined && next.t === "str") {
          useSpecifier(next);
        } else if (next !== undefined && (next.t === "id" || isP(next, "{") || isP(next, "*"))) {
          let j = i + 1;
          let found = false;
          for (; j < toks.length; j++) {
            const x = toks[j] as Tok;
            if (x.t === "id" && x.v === "from" && toks[j + 1]?.t === "str") {
              useSpecifier(toks[j + 1]);
              found = true;
              break;
            }
            const okTok = x.t === "id" || x.t === "str" || (x.t === "p" && (x.v === "{" || x.v === "}" || x.v === "," || x.v === "*"));
            if (!okTok) break;
          }
          if (!found) add("unclassified_syntax", "unrecognized_import_form");
        } else {
          add("unclassified_syntax", "unrecognized_import_form");
        }
        break;
      }
      case "export": {
        if (afterDot) break;
        if (isP(next, "{")) {
          let j = i + 2;
          while (j < toks.length && !isP(toks[j], "}")) j++;
          if (j >= toks.length) {
            add("unclassified_syntax", "unrecognized_export_form");
          } else if (isId(toks[j + 1], "from")) {
            if (toks[j + 2]?.t === "str") useSpecifier(toks[j + 2]);
            else add("unclassified_syntax", "unrecognized_export_form");
          }
        } else if (isP(next, "*")) {
          let j = i + 2;
          if (isId(toks[j], "as")) j += 2;
          if (isId(toks[j], "from") && toks[j + 1]?.t === "str") useSpecifier(toks[j + 1]);
          else add("unclassified_syntax", "unrecognized_export_form");
        }
        break;
      }
      case "require": {
        if (!afterDot && isP(next, "(") && isPlainLiteral(toks[i + 2]) && isP(toks[i + 3], ")")) useSpecifier(toks[i + 2]);
        else add("unclassified_syntax", "require_other_use");
        break;
      }
      case "createRequire":
        add("unclassified_syntax", "create_require");
        break;
      case "eval":
        add("unclassified_syntax", "eval");
        break;
      case "Function":
        if (isId(prev, "new") || isP(next, "(")) add("unclassified_syntax", "function_constructor");
        break;
      case "dlopen":
        add("unclassified_syntax", "process_dlopen");
        break;
      case "process": {
        let j = i + 1;
        if (isP(toks[j], "?")) j++;
        if (isP(toks[j], ".") && isId(toks[j + 1], "binding")) add("unclassified_syntax", "process_binding");
        else if (isP(toks[j], ".") && isId(toks[j + 1], "dlopen")) add("unclassified_syntax", "process_dlopen");
        else if (isP(toks[j], "[")) add("unclassified_syntax", "process_binding");
        break;
      }
      default:
        break;
    }
  }
  return { findings, specifiers };
}

const extOf = (rel: string, list: readonly string[]): boolean => {
  const l = rel.toLowerCase();
  return list.some((e) => l.endsWith(e));
};
const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

export function scanBundle(files: readonly { readonly rel: string; readonly text: string }[]): ScanResult {
  const findings: Finding[] = [];
  let scanned = 0;
  let specifierCount = 0;
  let bare = 0;
  for (const f of files) {
    if (extOf(f.rel, BINARY_EXT)) {
      findings.push({ file: f.rel, code: "unclassified_syntax", kind: "executable_artifact" });
    } else if (extOf(f.rel, SCRIPT_EXT)) {
      scanned++;
      const r = analyzeText(f.rel, f.text);
      findings.push(...r.findings);
      for (const s of r.specifiers) {
        specifierCount++;
        if (!(s.startsWith(".") || s.startsWith("/"))) bare++;
      }
    } else if (!extOf(f.rel, DATA_EXT)) {
      findings.push({ file: f.rel, code: "unclassified_syntax", kind: "unknown_file_type" });
    }
  }
  const textSha256 = sha(
    [...files]
      .map((f) => `${f.rel}\t${sha(f.text)}\n`)
      .sort()
      .join(""),
  );
  return { findings, filesTotal: files.length, filesScanned: scanned, specifierCount, bareSpecifierCount: bare, textSha256 };
}

/** Built-in self check, run in this Run before the scan result is accepted (design item 7). True only if the scanner behaves as required. */
export function importScanSelfCheck(): boolean {
  try {
    const one = (src: string): readonly Finding[] => scanBundle([{ rel: "dist/self.js", text: src }]).findings;
    const a = one('import x from "../../evaluation/ground-truth/a.js";\n');
    const b = one('const m = require("evaluation/x");\n');
    const c = one("const m = import(a + b);\n");
    const d = one('import { a } from "./b.js";\nexport const c = a;\n');
    return (
      a.some((f) => f.code === "forbidden_import") &&
      b.some((f) => f.code === "forbidden_import") &&
      c.some((f) => f.code === "unclassified_syntax") &&
      d.length === 0
    );
  } catch {
    return false;
  }
}
