// Small type guards for the policy. Untrusted values are checked at run time even though they are typed.

/** A plain JSON-like object: not null, not an array, prototype is Object.prototype or null. */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Canonical JSON text: sorted keys (UTF-16 code-unit order), no whitespace. Throws for anything that is not JSON. */
export function canonicalJsonText(v: unknown, depth = 0): string {
  if (depth > 64) throw new Error("nesting too deep");
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new Error("non-finite number");
      return JSON.stringify(v);
    case "string":
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) {
        const parts: string[] = [];
        for (let i = 0; i < v.length; i += 1) parts.push(canonicalJsonText(v[i] as unknown, depth + 1));
        return `[${parts.join(",")}]`;
      }
      if (!isPlainObject(v)) throw new Error("not a plain object");
      const keys = Object.keys(v).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJsonText(v[k], depth + 1)}`).join(",")}}`;
    }
    default:
      throw new Error("not JSON");
  }
}
