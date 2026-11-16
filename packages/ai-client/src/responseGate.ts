// Untrusted AI response gate (task 3.8; R3.8, R3.9, R4.2, R4.3, R4.8, R4.9, R7.2, R7.4, R7.7, R7.8, R17.1 to R17.9).
//
// Every provider response is untrusted data. Nothing of it is used until it has passed, in this order: the size check (before any parsing, R17.3),
// the strict JSON parse (UTF-8, depth 32, no duplicate key, safe numbers, R17.5 and R17.6), the count limits (R17.2 and R17.4), the discard of
// authority-like names at the top level of a Claim (task 3.10, R4.11, R4.17, R6.16), and the schema of its request kind (R4, R7; an undefined
// field rejects the whole response, R17.6). The gate parses JSON only: it does not evaluate, execute or
// interpret any text of a response (R17.7). Its input is bytes, its accepted output is parsed data, and its rejection carries NO text of the
// response: only a reason code, the limit that was exceeded, the size and SHA-256 of the received bytes, and issue codes with sanitized paths.
// The exact received bytes are stored by the caller (R17.8); a rejected response is never passed to a later request (R17.9), and each rejection
// is one failed call under the retry limit of R11.10.
//
// The schemas live in `packages/discovery-loop`. This package must not depend on it, so the validator is given through `SchemaValidatorPort`
// (the validator of discovery-loop has this shape); the Loop_Orchestrator (M4) supplies it.
import { sha256Hex } from "./hash.js";
import { tryCanonicalJson } from "./json/canonicalJson.js";
import { strictJsonParse } from "./json/strictJsonParse.js";
import { isAuditViolation } from "./providerError.js";
import { REQUEST_KINDS } from "./types.js";
import type { AuditViolation, Json, ProviderError, RequestKind, Result, Sha256 } from "./types.js";

// ---------------------------------------------------------------------------------------------
// Limits (R17.2)
// ---------------------------------------------------------------------------------------------
export interface ResponseLimits {
  readonly maxResponseBytes: number;
  readonly maxClaims: number;
  readonly maxCitationsPerClaim: number;
  readonly maxExperiments: number;
  readonly maxRequestsPerExperiment: number;
  readonly maxRequestBodyBytes: number;
}
/** Defaults of R17.2: 256 KiB, 50 Claims, 5 Citations per Claim, 10 Experiments, 10 requests per Experiment, 8,192 bytes per request body. */
export const DEFAULT_RESPONSE_LIMITS: ResponseLimits = Object.freeze({
  maxResponseBytes: 262_144,
  maxClaims: 50,
  maxCitationsPerClaim: 5,
  maxExperiments: 10,
  maxRequestsPerExperiment: 10,
  maxRequestBodyBytes: 8_192,
});
/** R17.6: more than 32 levels of nesting is rejected. Not configurable. */
export const RESPONSE_MAX_DEPTH = 32;

export type ResponseLimitsError = { readonly code: "limit_invalid" | "limit_unknown"; readonly name: string };

/**
 * Applies configured values over the defaults. A value must be an integer of at least 1 (R17.2). An invalid or unknown value is an error:
 * no default is used in its place (the Run must refuse to start, as for the limits of R11.8). The name is reported, never a response text.
 */
export function resolveResponseLimits(overrides: Readonly<Record<string, unknown>> = {}): Result<ResponseLimits, ResponseLimitsError> {
  const out: Record<string, number> = { ...DEFAULT_RESPONSE_LIMITS };
  for (const name of Object.keys(overrides)) {
    if (!Object.hasOwn(DEFAULT_RESPONSE_LIMITS, name)) return { ok: false, error: { code: "limit_unknown", name } };
    const v = overrides[name];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 1) return { ok: false, error: { code: "limit_invalid", name } };
    out[name] = v;
  }
  return { ok: true, value: Object.freeze(out) as unknown as ResponseLimits };
}

// ---------------------------------------------------------------------------------------------
// Validator port and result types
// ---------------------------------------------------------------------------------------------
/** What the gate needs from the schema validator of `packages/discovery-loop` (its `SchemaValidator.validate` has this shape). */
export interface SchemaIssue {
  readonly code: string;
  readonly path: string;
}
export interface SchemaValidatorPort {
  validate(schemaName: string, value: unknown): Result<Json, readonly SchemaIssue[]>;
}

/** `code` and a path of known, bounded tokens. Never a message and never a value of the response. */
export interface SafeIssue {
  readonly code: string;
  readonly path: string;
}

export type GateRejectionReason =
  | "size_exceeded" // R17.3
  | "invalid_utf8" | "invalid_json" | "depth_exceeded" | "duplicate_key" | "unsafe_number" // R17.6
  | "count_exceeded" // R17.4
  | "undefined_field" // R17.6
  | "schema_violation" // R4.2, R7.2
  | "not_canonicalizable" // parsed, but it cannot be written as canonical JSON (a lone surrogate, a number outside the safe range)
  | "not_inspectable"; // anything else that stops the check: fail closed (R3.8, R17.1)

export interface GateLimitHit {
  readonly name: keyof ResponseLimits;
  readonly limit: number;
  readonly observed: number;
}
/** A whole-response rejection (R17.3, R17.4, R17.6). It holds no text and no parsed value of the response. */
export interface GateRejection {
  readonly ok: false;
  readonly kind: RequestKind;
  readonly reason: GateRejectionReason;
  /** The limit that was exceeded, for `size_exceeded` and `count_exceeded` (R17.3, R17.4). */
  readonly limit?: GateLimitHit;
  readonly issues: readonly SafeIssue[];
  /** An undefined field whose name looks like a tool call, function call, action or command (see `looksLikeToolCall`). The response is rejected anyway. */
  readonly toolCallLike: boolean;
  /** SHA-256 and size of the received bytes (the caller stores the bytes themselves, R17.8). */
  readonly sha256: Sha256;
  readonly byteLength: number;
  /** R17.9: the rejection is one failed AI_Provider call under the retry limit. */
  readonly failedCall: true;
}
declare const validatedBrand: unique symbol;

/** Which of the four tests of R4.17 a name matched (the first that applies, in this order). Informational. */
export type AuthorityRule = "origin" | "evidence_prefix" | "evidence_status_suffix" | "approval_prefix";
export interface DiscardedAuthorityField {
  /** Index of the Claim in `claims`. */
  readonly claimIndex: number;
  /** JSON pointer of the object that held the property, for example `/claims/2`. */
  readonly path: string;
  /** The property name if it is a short identifier-like name, otherwise `<key>`: untrusted text is not copied into a record or a log. */
  readonly name: string;
  readonly rule: AuthorityRule;
}
export interface RejectedExperiment {
  readonly index: number;
  readonly issues: readonly SafeIssue[];
}
export interface GateAcceptedHypothesis {
  readonly ok: true;
  readonly kind: "hypothesis_generation" | "hypothesis_revision";
  readonly sha256: Sha256;
  readonly byteLength: number;
  /** The parsed response with the authority-like properties of its Claims removed, valid against `hypothesis-proposal`. Data only; it never carries an Origin, an Evidence_Status or an approval-like value. */
  readonly proposal: Json;
  /**
   * The authority-like properties that were removed from the top level of a Claim before the schema check, by name and place, never by value
   * (R6.16, R23.6). The orchestrator writes them as an `ai_content_discarded` record (`path` and `name` are the fields of that record). Empty when
   * nothing was removed. Only an accepted response reports them: a rejected response is not used at all.
   */
  readonly discarded: readonly DiscardedAuthorityField[];
  readonly [validatedBrand]: true;
}
export interface GateAcceptedExperiments {
  readonly ok: true;
  readonly kind: "experiment_generation";
  readonly sha256: Sha256;
  readonly byteLength: number;
  /** The Experiments that passed the schema, in order. */
  readonly experiments: readonly Json[];
  /** Experiments that failed the schema without an undefined field are rejected one by one, the others are kept (R7.4). */
  readonly rejectedExperiments: readonly RejectedExperiment[];
  readonly [validatedBrand]: true;
}
export type GateAccepted = GateAcceptedHypothesis | GateAcceptedExperiments;
export type GateResult = GateAccepted | GateRejection;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------
const isObj = (v: unknown): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);
const SAFE_TOKEN = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
/** A reported property name: a short identifier-like name that may contain `-` (`Evidence-Status` is a spelling the matcher handles). */
const REPORTABLE_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,31}$/;
const MAX_ISSUES = 20;
const MAX_PATH_TOKENS = 12;

/** Keeps array indexes and short identifier-like names, replaces any other key by `<key>`, and bounds the length. */
function safePath(path: string): string {
  if (path === "") return "";
  const tokens = path.split("/").slice(1).map((t) => t.replaceAll("~1", "/").replaceAll("~0", "~"));
  const kept = tokens.slice(0, MAX_PATH_TOKENS).map((t) => (/^(0|[1-9][0-9]{0,5})$/.test(t) || SAFE_TOKEN.test(t) ? t : "<key>"));
  return "/" + kept.join("/") + (tokens.length > MAX_PATH_TOKENS ? "/..." : "");
}
const safeIssues = (issues: readonly SchemaIssue[], prefix = ""): SafeIssue[] =>
  issues.slice(0, MAX_ISSUES).map((i) => ({ code: String(i.code).slice(0, 40), path: `${prefix}${safePath(String(i.path))}` }));

const TOOL_CALL_NAME = /^(tool|function|action|command|exec|shell|bash|invoke|call)/;
/** The field name after case and the separators `_` and `-` are removed starts like a tool, function, action or command name. */
export const looksLikeToolCall = (fieldName: string): boolean => TOOL_CALL_NAME.test(fieldName.toLowerCase().replaceAll("_", "").replaceAll("-", ""));
const lastToken = (path: string): string => (path.split("/").pop() ?? "").replaceAll("~1", "/").replaceAll("~0", "~");
const hasToolCallName = (issues: readonly SchemaIssue[]): boolean => issues.some((i) => i.code === "undefined_field" && looksLikeToolCall(lastToken(String(i.path))));

const utf8Length = (v: Json): number | undefined => {
  const c = tryCanonicalJson(v);
  return c.ok ? new TextEncoder().encode(c.value).length : undefined;
};

class Stop extends Error {
  constructor(readonly rejection: Omit<GateRejection, "ok" | "kind" | "sha256" | "byteLength" | "failedCall" | "issues" | "toolCallLike"> & { issues?: readonly SafeIssue[]; toolCallLike?: boolean }) {
    super("stop");
  }
}

// ---------------------------------------------------------------------------------------------
// Authority-like names at the top level of a Claim (task 3.10; R4.11, R4.16, R4.17, R6.16, R23.4, R23.6)
// ---------------------------------------------------------------------------------------------
/**
 * R4.17: after conversion to lower case and deletion of every `_` and `-`, the name equals `origin`, starts with `evidence`, ends with
 * `evidencestatus`, or starts with `approv`. This is the broad matcher of design item 10 (a conservative superset of the reserved names of R4.16).
 * Only `_` and `-` are removed: no spaces, dots, width forms or invisible characters, so a notation that is not covered stays an undefined field and
 * rejects the whole response.
 */
export function authorityRuleOf(name: string): AuthorityRule | undefined {
  const n = name.toLowerCase().replace(/[_-]/g, "");
  if (n === "origin") return "origin";
  if (n.startsWith("evidence")) return "evidence_prefix";
  if (n.endsWith("evidencestatus")) return "evidence_status_suffix";
  if (n.startsWith("approv")) return "approval_prefix";
  return undefined;
}
export const isAuthorityLikeName = (name: string): boolean => authorityRuleOf(name) !== undefined;

/**
 * Removes the authority-like direct properties of each Claim of the Hypothesis (`claims[i]`), nothing else: not a nested property, not a property of
 * the Hypothesis or of the response, not a Claim that is not an object. It works on a copy; the removed values are dropped and are not kept anywhere.
 * It never adds, renames or changes a property, so what is left is validated by the closed schema exactly as it would be without the removed ones:
 * an undefined field that is not authority-like still rejects the whole response, and a Claim that is invalid for another reason stays invalid.
 */
function discardAuthorityFields(tree: { [k: string]: Json }): { tree: { [k: string]: Json }; discarded: DiscardedAuthorityField[] } {
  const claims = tree["claims"];
  if (!Array.isArray(claims)) return { tree, discarded: [] };
  const discarded: DiscardedAuthorityField[] = [];
  const cleaned = claims.map((claim, claimIndex) => {
    if (!isObj(claim)) return claim;
    const kept: [string, Json][] = [];
    for (const [name, value] of Object.entries(claim)) {
      const rule = authorityRuleOf(name);
      if (rule === undefined) kept.push([name, value]);
      else discarded.push({ claimIndex, path: `/claims/${claimIndex}`, name: REPORTABLE_NAME.test(name) ? name : "<key>", rule });
    }
    return discarded.length === 0 || kept.length === Object.keys(claim).length ? claim : Object.fromEntries(kept);
  });
  if (discarded.length === 0) return { tree, discarded };
  return { tree: Object.fromEntries(Object.entries(tree).map(([k, v]) => (k === "claims" ? [k, cleaned] : [k, v]))), discarded };
}

// ---------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------
/**
 * Checks one provider response. It never throws: whatever goes wrong inside (a validator that throws or answers in another shape, a value that cannot
 * be inspected) rejects the whole response as `not_inspectable` (fail closed). The input bytes are copied first.
 */
export function gateResponse(kind: RequestKind, bytes: Uint8Array, limits: ResponseLimits, validator: SchemaValidatorPort): GateResult {
  let snapshot: Uint8Array;
  let notBytes = false;
  try {
    // Only a Uint8Array is a response; `new Uint8Array("text")` would silently make an empty array.
    notBytes = !ArrayBuffer.isView(bytes) || Object.prototype.toString.call(bytes) !== "[object Uint8Array]";
    snapshot = notBytes ? new Uint8Array(0) : new Uint8Array(bytes);
  } catch {
    notBytes = true;
    snapshot = new Uint8Array(0);
  }
  const sha256 = sha256Hex(snapshot);
  const byteLength = snapshot.byteLength;
  const reject = (s: Stop["rejection"]): GateRejection => ({
    ok: false,
    kind,
    reason: s.reason,
    ...(s.limit === undefined ? {} : { limit: s.limit }),
    issues: s.issues ?? [],
    toolCallLike: s.toolCallLike ?? false,
    sha256,
    byteLength,
    failedCall: true,
  });
  try {
    if (notBytes || !(REQUEST_KINDS as readonly unknown[]).includes(kind)) throw new Stop({ reason: "not_inspectable" });
    // 1. Size, before any parsing (R17.3).
    if (byteLength > limits.maxResponseBytes) {
      throw new Stop({ reason: "size_exceeded", limit: { name: "maxResponseBytes", limit: limits.maxResponseBytes, observed: byteLength } });
    }
    // 2. JSON only, strictly (R17.5, R17.6).
    const parsed = strictJsonParse(snapshot, { maxDepth: RESPONSE_MAX_DEPTH, maxBytes: limits.maxResponseBytes });
    if (!parsed.ok) {
      throw new Stop({ reason: parsed.error.code === "size_exceeded" ? "size_exceeded" : parsed.error.code, issues: [{ code: parsed.error.code, path: safePath(parsed.error.path) }] });
    }
    const tree = parsed.value;
    // 3. The parsed value must be writable as canonical JSON, or no later record could hold it.
    const canon = tryCanonicalJson(tree);
    if (!canon.ok) throw new Stop({ reason: "not_canonicalizable", issues: [{ code: canon.error.code, path: safePath(canon.error.path) }] });
    return kind === "experiment_generation"
      ? gateExperiments(tree, limits, validator, sha256, byteLength, reject)
      : gateHypothesis(kind, tree, limits, validator, sha256, byteLength, reject);
  } catch (e) {
    if (e instanceof Stop) return reject(e.rejection);
    return reject({ reason: "not_inspectable" });
  }
}

function runValidator(validator: SchemaValidatorPort, schema: string, value: unknown): Result<Json, readonly SchemaIssue[]> {
  let r: unknown;
  try {
    r = validator.validate(schema, value);
  } catch {
    throw new Stop({ reason: "not_inspectable" });
  }
  const shaped = r as { ok?: unknown; value?: unknown; error?: unknown };
  if (shaped?.ok === true) return { ok: true, value: shaped.value as Json };
  if (shaped?.ok === false && Array.isArray(shaped.error) && shaped.error.every((i) => typeof i?.code === "string" && typeof i?.path === "string")) {
    return { ok: false, error: shaped.error as SchemaIssue[] };
  }
  throw new Stop({ reason: "not_inspectable" });
}

function gateHypothesis(
  kind: "hypothesis_generation" | "hypothesis_revision",
  tree: Json,
  limits: ResponseLimits,
  validator: SchemaValidatorPort,
  sha256: Sha256,
  byteLength: number,
  reject: (s: Stop["rejection"]) => GateRejection,
): GateResult {
  if (!isObj(tree)) return reject({ reason: "schema_violation", issues: [{ code: "bad_type", path: "" }] });
  // Count limits come first (R17.4); a value of the wrong shape is left to the schema.
  const claims = tree["claims"];
  if (Array.isArray(claims)) {
    if (claims.length > limits.maxClaims) {
      return reject({ reason: "count_exceeded", limit: { name: "maxClaims", limit: limits.maxClaims, observed: claims.length } });
    }
    let most = 0;
    for (const c of claims) if (isObj(c) && Array.isArray(c["citations"])) most = Math.max(most, c["citations"].length);
    if (most > limits.maxCitationsPerClaim) {
      return reject({ reason: "count_exceeded", limit: { name: "maxCitationsPerClaim", limit: limits.maxCitationsPerClaim, observed: most } });
    }
  }
  // The authority-like properties of the Claims are removed BEFORE the schema check (C1, task 3.10); the remainder is checked by the closed schema.
  const { tree: cleaned, discarded } = discardAuthorityFields(tree);
  const r = runValidator(validator, "hypothesis-proposal", cleaned);
  if (!r.ok) {
    const undefinedField = r.error.some((i) => i.code === "undefined_field");
    return reject({ reason: undefinedField ? "undefined_field" : "schema_violation", issues: safeIssues(r.error), toolCallLike: hasToolCallName(r.error) });
  }
  return { ok: true, kind, sha256, byteLength, proposal: r.value, discarded: Object.freeze(discarded) } as unknown as GateAcceptedHypothesis;
}

function gateExperiments(
  tree: Json,
  limits: ResponseLimits,
  validator: SchemaValidatorPort,
  sha256: Sha256,
  byteLength: number,
  reject: (s: Stop["rejection"]) => GateRejection,
): GateResult {
  // The envelope `{ "experiments": [ ... ] }` is PROVISIONAL (to be fixed in M4).
  if (!isObj(tree)) return reject({ reason: "schema_violation", issues: [{ code: "bad_type", path: "" }] });
  const extra = Object.keys(tree).filter((k) => k !== "experiments");
  if (extra.length > 0) {
    const issues = extra.map((k) => ({ code: "undefined_field", path: `/${k.replaceAll("~", "~0").replaceAll("/", "~1")}` }));
    return reject({ reason: "undefined_field", issues: safeIssues(issues), toolCallLike: hasToolCallName(issues) });
  }
  const list = tree["experiments"];
  if (list === undefined) return reject({ reason: "schema_violation", issues: [{ code: "missing_field", path: "/experiments" }] });
  if (!Array.isArray(list)) return reject({ reason: "schema_violation", issues: [{ code: "bad_type", path: "/experiments" }] });
  if (list.length > limits.maxExperiments) {
    return reject({ reason: "count_exceeded", limit: { name: "maxExperiments", limit: limits.maxExperiments, observed: list.length } });
  }
  let mostRequests = 0;
  let largestBody = 0;
  for (const e of list) {
    if (!isObj(e)) continue;
    for (const field of ["requests", "stateChecks"] as const) {
      const reqs = e[field];
      if (!Array.isArray(reqs)) continue;
      if (field === "requests") mostRequests = Math.max(mostRequests, reqs.length);
      for (const q of reqs) {
        if (isObj(q) && q["body"] !== undefined) {
          const n = utf8Length(q["body"]);
          if (n === undefined) throw new Stop({ reason: "not_inspectable" });
          largestBody = Math.max(largestBody, n);
        }
      }
    }
  }
  if (mostRequests > limits.maxRequestsPerExperiment) {
    return reject({ reason: "count_exceeded", limit: { name: "maxRequestsPerExperiment", limit: limits.maxRequestsPerExperiment, observed: mostRequests } });
  }
  if (largestBody > limits.maxRequestBodyBytes) {
    return reject({ reason: "count_exceeded", limit: { name: "maxRequestBodyBytes", limit: limits.maxRequestBodyBytes, observed: largestBody } });
  }
  const accepted: Json[] = [];
  const rejected: RejectedExperiment[] = [];
  for (let i = 0; i < list.length; i++) {
    const r = runValidator(validator, "experiment", list[i]);
    if (r.ok) {
      accepted.push(r.value);
      continue;
    }
    // An undefined field anywhere is a whole-response rejection (R17.6); any other schema failure rejects only that Experiment (R7.4).
    if (r.error.some((x) => x.code === "undefined_field")) {
      return reject({ reason: "undefined_field", issues: safeIssues(r.error, `/experiments/${i}`), toolCallLike: hasToolCallName(r.error) });
    }
    rejected.push({ index: i, issues: safeIssues(r.error) });
  }
  return { ok: true, kind: "experiment_generation", sha256, byteLength, experiments: accepted, rejectedExperiments: rejected } as unknown as GateAcceptedExperiments;
}

// ---------------------------------------------------------------------------------------------
// Connection to the provider result
// ---------------------------------------------------------------------------------------------
/** The failure classes of R3.8 that the orchestrator records for a failed call. */
export type FailedCallReason = "error" | "unparseable" | "timeout";
export type CallOutcome =
  | { readonly kind: "accepted"; readonly result: GateAccepted }
  /**
   * A failed AI_Provider call: counted under the retry limit (R11.10), retried only with a NEW Payload_Audit (R3.8), and `provider_failure`
   * when the retries are exhausted (R3.9, R4.9). `gate` is set when the response was rejected by the gate (`unparseable`).
   * No text of the response or of the provider error is carried.
   */
  | {
      readonly kind: "failed_call";
      readonly reason: FailedCallReason;
      readonly retryable: true;
      readonly source: "provider" | "gate";
      readonly providerReason?: Exclude<ProviderError["reason"], "audit_violation">;
      readonly gate?: GateRejection;
      /** The provider reported a tool-call event, or the response had a tool-call-like field: the orchestrator records it (R16.7). */
      readonly toolCall: boolean;
    }
  /** An audit-integrity violation. Not a failed call, never retried, not counted; the Run stops (termination reason `error`, R11.15). */
  | { readonly kind: "audit_violation"; readonly retryable: false; readonly stopRun: true; readonly violation: AuditViolation };

/**
 * Turns what `AiProvider.complete` returned into one outcome. A provider error never reaches the gate. An `audit_violation` is kept apart from
 * ordinary failures. A response is accepted only through `gateResponse`; a rejected response yields no data at all.
 */
export function gateProviderResult(
  kind: RequestKind,
  result: Result<Uint8Array, ProviderError>,
  limits: ResponseLimits,
  validator: SchemaValidatorPort,
): CallOutcome {
  try {
    if (!result.ok) {
      const e = result.error;
      if (isAuditViolation(e)) return { kind: "audit_violation", retryable: false, stopRun: true, violation: e.violation };
      const reason: FailedCallReason = e.reason === "timeout" ? "timeout" : "error";
      return { kind: "failed_call", reason, retryable: true, source: "provider", providerReason: e.reason, toolCall: e.reason === "tool_call_detected" };
    }
    const g = gateResponse(kind, result.value, limits, validator);
    if (g.ok) return { kind: "accepted", result: g };
    return { kind: "failed_call", reason: "unparseable", retryable: true, source: "gate", gate: g, toolCall: g.toolCallLike };
  } catch {
    return { kind: "failed_call", reason: "error", retryable: true, source: "provider", toolCall: false };
  }
}

// ---------------------------------------------------------------------------------------------
// Inert display (R17.8)
// ---------------------------------------------------------------------------------------------
const ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;", "`": "&#96;" };
/**
 * Text of an AI response (or of a field of it) made safe to show as plain text: markup characters become entities, and control, bidirectional
 * and line-separator characters become visible `\uXXXX` escapes. The result is data for display only; nothing is executed or rendered.
 * Longer text is cut at `maxChars` and marked.
 */
export function toInertText(input: Uint8Array | string, maxChars = 100_000): string {
  const text = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(input);
  const cut = text.length > maxChars ? text.slice(0, maxChars) : text;
  let out = "";
  for (const ch of cut) {
    const cp = ch.codePointAt(0) as number;
    if (ESCAPES[ch] !== undefined) out += ESCAPES[ch];
    else if (
      (cp < 0x20 && cp !== 0x0a && cp !== 0x09) || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029 || cp === 0xfeff ||
      (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069) || cp === 0x200e || cp === 0x200f
    ) {
      out += `\\u${cp.toString(16).padStart(4, "0")}`;
    } else out += ch;
  }
  return text.length > maxChars ? `${out}\n[cut at ${maxChars} characters]` : out;
}