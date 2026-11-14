// Strict JSON parser for the allowlist document (design: "Source_Bundler decisions", item 1).
//
// `JSON.parse` accepts duplicate keys and keeps the last one, which would let a second `files` key replace the first
// without notice. This parser follows the JSON grammar (RFC 8259) and additionally rejects a duplicate key in any
// object, a nesting deeper than the limit, a control character in a string, and any text after the value. A leading
// byte-order mark is not whitespace and is an error.
import type { Json, Result } from "../expr/types.js";

export const STRICT_JSON_MAX_DEPTH = 32;

class Fail extends Error {}

class Parser {
  private pos = 0;
  constructor(private readonly text: string) {}

  parseDocument(): Json {
    this.skipWs();
    const v = this.value(0);
    this.skipWs();
    if (this.pos !== this.text.length) this.fail("text after the value");
    return v;
  }

  private fail(msg: string): never {
    throw new Fail(`${msg} at offset ${this.pos}`);
  }

  private skipWs(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos += 1;
      else break;
    }
  }

  private value(depth: number): Json {
    if (depth > STRICT_JSON_MAX_DEPTH) this.fail("nesting too deep");
    const ch = this.text.charAt(this.pos);
    if (ch === "{") return this.object(depth);
    if (ch === "[") return this.array(depth);
    if (ch === '"') return this.string();
    if (ch === "-" || (ch >= "0" && ch <= "9")) return this.number();
    if (this.text.startsWith("true", this.pos)) {
      this.pos += 4;
      return true;
    }
    if (this.text.startsWith("false", this.pos)) {
      this.pos += 5;
      return false;
    }
    if (this.text.startsWith("null", this.pos)) {
      this.pos += 4;
      return null;
    }
    return this.fail("unexpected character");
  }

  private object(depth: number): Json {
    this.pos += 1; // {
    const out: { [k: string]: Json } = {};
    const seen = new Set<string>();
    this.skipWs();
    if (this.text.charAt(this.pos) === "}") {
      this.pos += 1;
      return out;
    }
    for (;;) {
      this.skipWs();
      if (this.text.charAt(this.pos) !== '"') this.fail("object key must be a string");
      const key = this.string();
      if (seen.has(key)) this.fail(`duplicate key ${JSON.stringify(key)}`);
      seen.add(key);
      this.skipWs();
      if (this.text.charAt(this.pos) !== ":") this.fail("expected ':'");
      this.pos += 1;
      this.skipWs();
      // Object.defineProperty keeps a key such as "__proto__" as an ordinary own property.
      Object.defineProperty(out, key, { value: this.value(depth + 1), enumerable: true, writable: true, configurable: true });
      this.skipWs();
      const c = this.text.charAt(this.pos);
      this.pos += 1;
      if (c === "}") return out;
      if (c !== ",") this.fail("expected ',' or '}'");
    }
  }

  private array(depth: number): Json {
    this.pos += 1; // [
    const out: Json[] = [];
    this.skipWs();
    if (this.text.charAt(this.pos) === "]") {
      this.pos += 1;
      return out;
    }
    for (;;) {
      this.skipWs();
      out.push(this.value(depth + 1));
      this.skipWs();
      const c = this.text.charAt(this.pos);
      this.pos += 1;
      if (c === "]") return out;
      if (c !== ",") this.fail("expected ',' or ']'");
    }
  }

  private string(): string {
    this.pos += 1; // opening quote
    let out = "";
    for (;;) {
      if (this.pos >= this.text.length) this.fail("unterminated string");
      const c = this.text.charAt(this.pos);
      const code = this.text.charCodeAt(this.pos);
      if (c === '"') {
        this.pos += 1;
        return out;
      }
      if (code < 0x20) this.fail("control character in string");
      if (c !== "\\") {
        out += c;
        this.pos += 1;
        continue;
      }
      const e = this.text.charAt(this.pos + 1);
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
          const hex = this.text.slice(this.pos, this.pos + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail("bad \\u escape");
          out += String.fromCharCode(Number.parseInt(hex, 16));
          this.pos += 4;
          break;
        }
        default:
          this.fail("bad escape");
      }
    }
  }

  private number(): number {
    const m = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(this.text.slice(this.pos));
    if (m === null) this.fail("bad number");
    this.pos += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) this.fail("number out of range");
    return n;
  }
}

/** Parses `text` as strict JSON. Never throws. */
export function parseStrictJson(text: string): Result<Json, string> {
  try {
    return { ok: true, value: new Parser(text).parseDocument() };
  } catch (e) {
    return { ok: false, error: e instanceof Fail ? e.message : "invalid JSON" };
  }
}