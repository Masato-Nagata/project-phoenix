// Strict JSON parser for untrusted input (R17.3, R17.5, R17.6).
// Rejects: oversized input (before parsing), invalid UTF-8, a BOM, invalid JSON, nesting deeper
// than the limit, duplicate keys in one object, and integer lexemes outside the safe range.
// It never evaluates anything and keeps `__proto__` as an ordinary own key.
import { DEFAULT_PARSE_LIMITS, type Issue, type Json, type ParseLimits, type Result } from "./types.js";

class ParseFailure extends Error {
  constructor(readonly issue: Issue) {
    super(issue.message);
  }
}

const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;
const INTEGER_LEXEME_RE = /^-?[0-9]+$/;
const MAX_SAFE = 9007199254740991n;

function pointerToken(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

class Parser {
  private pos = 0;
  constructor(private readonly s: string, private readonly maxDepth: number) {}

  private fail(code: Issue["code"], path: string, message: string): never {
    throw new ParseFailure({ code, path, message });
  }

  private ws(): void {
    for (;;) {
      const c = this.s.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) this.pos++;
      else return;
    }
  }

  parseDocument(): Json {
    this.ws();
    const v = this.value(0, "");
    this.ws();
    if (this.pos !== this.s.length) this.fail("invalid_json", "", `unexpected character at offset ${this.pos}`);
    return v;
  }

  private value(depth: number, path: string): Json {
    const ch = this.s[this.pos];
    if (ch === "{") return this.object(depth + 1, path);
    if (ch === "[") return this.array(depth + 1, path);
    if (ch === '"') return this.string(path);
    if (ch === "-" || (ch !== undefined && ch >= "0" && ch <= "9")) return this.number(path);
    if (this.s.startsWith("true", this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.s.startsWith("false", this.pos)) {
      this.pos += 5;
      return false;
    }
    if (this.s.startsWith("null", this.pos)) {
      this.pos += 4;
      return null;
    }
    return this.fail("invalid_json", path, `unexpected character at offset ${this.pos}`);
  }

  private object(depth: number, path: string): Json {
    if (depth > this.maxDepth) this.fail("depth_exceeded", path, `nesting is deeper than ${this.maxDepth} levels`);
    this.pos++; // {
    const out: { [k: string]: Json } = {};
    const seen = new Set<string>();
    this.ws();
    if (this.s[this.pos] === "}") {
      this.pos++;
      return out;
    }
    for (;;) {
      this.ws();
      if (this.s[this.pos] !== '"') this.fail("invalid_json", path, `object key expected at offset ${this.pos}`);
      const key = this.string(path);
      const childPath = `${path}/${pointerToken(key)}`;
      if (seen.has(key)) this.fail("duplicate_key", childPath, `duplicate key "${key}"`);
      seen.add(key);
      this.ws();
      if (this.s[this.pos] !== ":") this.fail("invalid_json", childPath, `":" expected at offset ${this.pos}`);
      this.pos++;
      this.ws();
      const v = this.value(depth, childPath);
      Object.defineProperty(out, key, { value: v, enumerable: true, writable: true, configurable: true });
      this.ws();
      const c = this.s[this.pos];
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "}") {
        this.pos++;
        return out;
      }
      return this.fail("invalid_json", path, `"," or "}" expected at offset ${this.pos}`);
    }
  }

  private array(depth: number, path: string): Json {
    if (depth > this.maxDepth) this.fail("depth_exceeded", path, `nesting is deeper than ${this.maxDepth} levels`);
    this.pos++; // [
    const out: Json[] = [];
    this.ws();
    if (this.s[this.pos] === "]") {
      this.pos++;
      return out;
    }
    for (;;) {
      this.ws();
      out.push(this.value(depth, `${path}/${out.length}`));
      this.ws();
      const c = this.s[this.pos];
      if (c === ",") {
        this.pos++;
        continue;
      }
      if (c === "]") {
        this.pos++;
        return out;
      }
      return this.fail("invalid_json", path, `"," or "]" expected at offset ${this.pos}`);
    }
  }

  private string(path: string): string {
    this.pos++; // opening quote
    let out = "";
    let start = this.pos;
    for (;;) {
      if (this.pos >= this.s.length) this.fail("invalid_json", path, "unterminated string");
      const c = this.s.charCodeAt(this.pos);
      if (c === 0x22) {
        out += this.s.slice(start, this.pos);
        this.pos++;
        return out;
      }
      if (c < 0x20) this.fail("invalid_json", path, `control character in string at offset ${this.pos}`);
      if (c === 0x5c) {
        out += this.s.slice(start, this.pos);
        const e = this.s[this.pos + 1];
        this.pos += 2;
        switch (e) {
          case '"': out += '"'; break;
          case "\\": out += "\\"; break;
          case "/": out += "/"; break;
          case "b": out += "\b"; break;
          case "f": out += "\f"; break;
          case "n": out += "\n"; break;
          case "r": out += "\r"; break;
          case "t": out += "\t"; break;
          case "u": {
            const hex = this.s.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("invalid_json", path, `bad \\u escape at offset ${this.pos}`);
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            this.fail("invalid_json", path, `bad escape at offset ${this.pos - 1}`);
        }
        start = this.pos;
        continue;
      }
      this.pos++;
    }
  }

  private number(path: string): number {
    NUMBER_RE.lastIndex = this.pos;
    const m = NUMBER_RE.exec(this.s);
    if (m === null) return this.fail("invalid_json", path, `bad number at offset ${this.pos}`);
    const lexeme = m[0];
    this.pos += lexeme.length;
    const n = Number(lexeme);
    if (!Number.isFinite(n)) this.fail("unsafe_number", path, "number is not finite");
    if (INTEGER_LEXEME_RE.test(lexeme)) {
      const big = BigInt(lexeme);
      if (big > MAX_SAFE || big < -MAX_SAFE) this.fail("unsafe_number", path, "integer is outside the safe integer range");
    }
    return n;
  }
}

/**
 * Parses untrusted JSON text or bytes under the strict rules. Returns the first problem as a single issue.
 * The size check runs on the byte length before any decoding or parsing.
 */
export function strictParse(
  input: string | Uint8Array,
  limits: ParseLimits = DEFAULT_PARSE_LIMITS,
): Result<Json, Issue> {
  const byteLength = typeof input === "string" ? Buffer.byteLength(input, "utf8") : input.byteLength;
  if (byteLength > limits.maxBytes) {
    return {
      ok: false,
      error: { code: "size_exceeded", path: "", message: `input is ${byteLength} bytes; the limit is ${limits.maxBytes}` },
    };
  }
  let text: string;
  if (typeof input === "string") text = input;
  else {
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(input);
    } catch {
      return { ok: false, error: { code: "invalid_utf8", path: "", message: "input is not valid UTF-8" } };
    }
  }
  try {
    return { ok: true, value: new Parser(text, limits.maxDepth).parseDocument() };
  } catch (e) {
    if (e instanceof ParseFailure) return { ok: false, error: e.issue };
    throw e;
  }
}
