// Secret scan of the Evidence_Store (design: "Append-only rules"; R12.13, R19.2, R19.7).
// Patterns and secret environment values come from configuration. A hit is reported by pattern id only.
import { canonicalJson } from "../canonical/index.js";
import type { Json } from "../schema/index.js";

export const MIN_SECRET_VALUE_LENGTH = 8;
const ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;

export interface SecretPatternConfig {
  /** Reported in the rejection record. Must not contain the secret. */
  id: string;
  /** Regular expression source. */
  source: string;
  flags?: string;
}
export interface SecretEnvValue {
  /** Environment variable name; the reported pattern id is `env:<name>`. */
  name: string;
  value: string;
}
export interface SecretConfig {
  patterns?: readonly SecretPatternConfig[];
  envValues?: readonly SecretEnvValue[];
}

export class SecretScanner {
  private readonly patterns: { id: string; re: RegExp }[] = [];
  private readonly values: { id: string; text: string; bytes: Buffer }[] = [];

  /** Throws on an invalid pattern id or regular expression (a configuration error at start). */
  constructor(config: SecretConfig = {}) {
    for (const p of config.patterns ?? []) {
      if (!ID_RE.test(p.id)) throw new Error(`invalid secret pattern id: ${p.id.slice(0, 64)}`);
      const flags = (p.flags ?? "").replace(/[gy]/g, "");
      this.patterns.push({ id: p.id, re: new RegExp(p.source, flags) });
    }
    for (const v of config.envValues ?? []) {
      if (v.value.length < MIN_SECRET_VALUE_LENGTH) continue; // shorter values are not scanned (design)
      const id = `env:${v.name}`;
      if (!ID_RE.test(id)) throw new Error("invalid secret environment variable name");
      this.values.push({ id, text: v.value, bytes: Buffer.from(v.value, "utf8") });
    }
  }

  /** Pattern id of the first hit in a text, or undefined. */
  scanText(text: string): string | undefined {
    for (const v of this.values) if (text.includes(v.text)) return v.id;
    for (const p of this.patterns) if (p.re.test(text)) return p.id;
    return undefined;
  }

  /** Scans exact bytes (a blob): raw bytes for secret values, UTF-8 and Latin-1 views for patterns. */
  scanBytes(bytes: Uint8Array): string | undefined {
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (const v of this.values) if (buf.includes(v.bytes)) return v.id;
    return this.scanText(buf.toString("utf8")) ?? this.scanText(buf.toString("latin1"));
  }

  /**
   * Scans a record: its canonical text and every key and string value (so an escape sequence in the
   * canonical text cannot hide a secret).
   */
  scanRecord(record: Json): string | undefined {
    const hit = this.scanText(canonicalJson(record));
    if (hit !== undefined) return hit;
    const stack: Json[] = [record];
    while (stack.length > 0) {
      const v = stack.pop() as Json;
      if (typeof v === "string") {
        const h = this.scanText(v);
        if (h !== undefined) return h;
      } else if (Array.isArray(v)) {
        stack.push(...v);
      } else if (v !== null && typeof v === "object") {
        for (const [k, child] of Object.entries(v)) {
          const h = this.scanText(k);
          if (h !== undefined) return h;
          stack.push(child);
        }
      }
    }
    return undefined;
  }
}
