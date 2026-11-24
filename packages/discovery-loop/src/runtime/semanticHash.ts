// Production `semanticSha256Of` of the Loop_Orchestrator (task 4.9-B). It adds no rule of its own: the semantic identity of a claim is the
// SHA-256 (lowercase hex, 64 characters) of the UTF-8 bytes of the canonical JSON (ai-client `tryCanonicalJson`) of the object
// `{ condition, effect, citations }` plus `threshold` ONLY when the claim has one (an own property that is not `undefined`; JSON `null` counts
// as present). This is the same value as `sha256Hex(canonicalJson(input))` over the orchestrator's input, which has exactly these keys.
// Any key other than the four is not hashed. A failure of the canonical form is the closed code `semantic_hash_failed`; no value is returned
// in an error.
import { sha256Hex, tryCanonicalJson } from "@phoenix/ai-client";
import type { Json } from "@phoenix/ai-client";

export interface SemanticHashInput {
  readonly condition: Json;
  readonly effect: Json;
  readonly citations: Json;
  readonly threshold?: Json;
}

export type SemanticHashResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly error: { readonly code: "semantic_hash_failed" } };

const FAILED: SemanticHashResult = Object.freeze({ ok: false as const, error: Object.freeze({ code: "semantic_hash_failed" as const }) });

export function semanticSha256Of(v: SemanticHashInput): SemanticHashResult {
  try {
    if (typeof v !== "object" || v === null) return FAILED;
    const semantic: { [k: string]: Json } = { condition: v.condition, effect: v.effect, citations: v.citations };
    if (Object.hasOwn(v, "threshold") && v.threshold !== undefined) semantic["threshold"] = v.threshold;
    const canonical = tryCanonicalJson(semantic);
    if (!canonical.ok) return FAILED;
    return { ok: true, value: sha256Hex(canonical.value) };
  } catch {
    return FAILED;
  }
}