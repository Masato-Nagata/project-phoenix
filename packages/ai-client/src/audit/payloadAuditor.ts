// Payload_Auditor (task 3.4; R2.1 to R2.9, R2.11, R2.12, R2.14, R11.2, R11.3, R19.7; design "Payload_Auditor").
//
// `auditPayload` audits the exact bytes that would be transmitted. It takes a private copy of the bytes first and audits that copy, so
// nothing the caller does to its array later changes what was audited. It runs the nine checks A01 to A09 in a fixed order and lists every
// outcome; a check that cannot run is `not_run`, and any `fail` or `not_run` makes the result `blocked` (R2.9, fail closed). Only a
// `pass` returns an `AuditedRequest`, which is bound to the audited hash and valid for one provider call (see `internal/auditedRegistry`).
//
// What the auditor never does: write a canary, decoy, fingerprint or secret value anywhere (a result holds identifiers and fixed codes
// only; a payload-derived path is redacted if it contains a sensitive value); verify runtime access rights or report an isolation status
// (R2.11, R2.14: that is task 4.2).
import { sha256Hex } from "../hash.js";
import { mintAuditedRequest } from "../internal/auditedRegistry.js";
import { canonicalJson, tryCanonicalJson } from "../json/canonicalJson.js";
import { strictJsonParse } from "../json/strictJsonParse.js";
import { ngramHashes, tokenize } from "../tokenizer.js";
import { REQUEST_KINDS } from "../types.js";
import type { AuditedRequest, Json, RequestKind } from "../types.js";
import { AUDIT_CHECK_IDS, STORED_PART_TYPES } from "./types.js";
import type {
  AuditCheck,
  AuditCheckId,
  AuditConfig,
  AuditConfigLoadResult,
  AuditContext,
  AuditLimits,
  AuditMatch,
  AuditResult,
  PayloadEnvelope,
  SourceFilePart,
  StoredPart,
} from "./types.js";

/** Defaults (approved): 4 MiB and 32 levels of JSON nesting. The spec sets no limit for a request payload. */
export const DEFAULT_AUDIT_LIMITS: AuditLimits = Object.freeze({ maxBytes: 4 * 1024 * 1024, maxDepth: 32 });
/**
 * Highest value that `AuditContext.limits` may reach. It equals the default for now: a context may tighten a limit but cannot raise it, because
 * the spec defines no upper bound and none is invented here. A value that is not a positive safe integer is ignored (the default applies), so a
 * malformed limit can never switch a limit off (a comparison with `NaN` would).
 */
export const AUDIT_LIMITS_CEILING: AuditLimits = DEFAULT_AUDIT_LIMITS;

export function effectiveAuditLimits(requested: AuditLimits | undefined): AuditLimits {
  const pick = (v: unknown, ceiling: number): number =>
    typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? Math.min(v, ceiling) : ceiling;
  return { maxBytes: pick(requested?.maxBytes, AUDIT_LIMITS_CEILING.maxBytes), maxDepth: pick(requested?.maxDepth, AUDIT_LIMITS_CEILING.maxDepth) };
}
const MAX_PARTS = 256;
const HEX64 = /^[0-9a-f]{64}$/;

type JObj = { [k: string]: Json };
const isObj = (v: unknown): v is JObj => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";

// ---------------------------------------------------------------------------------------------
// Envelope structure (A02)
// ---------------------------------------------------------------------------------------------
type EnvelopeResult = { ok: true; env: PayloadEnvelope } | { ok: false; detail: string };

/** Exact key set: names an extra key as `<unknown>` so that no key text of the untrusted input is copied into a detail. */
function keyProblem(o: JObj, keys: readonly string[], ptr: string): string | undefined {
  for (const k of keys) if (!Object.hasOwn(o, k)) return `missing_field:${ptr}/${k}`;
  if (Object.keys(o).length !== keys.length) return `undefined_field:${ptr}/<unknown>`;
  return undefined;
}

function validateEnvelope(tree: Json, kind: RequestKind): EnvelopeResult {
  const no = (detail: string): EnvelopeResult => ({ ok: false, detail });
  if (!isObj(tree)) return no("bad_type:");
  const top = keyProblem(tree, ["schemaVersion", "kind", "instruction", "parts"], "");
  if (top !== undefined) return no(top);
  if (tree["schemaVersion"] !== 1) return no("bad_value:/schemaVersion");
  if (tree["kind"] !== kind) return no("kind_mismatch:/kind");
  const ins = tree["instruction"];
  if (!isObj(ins)) return no("bad_type:/instruction");
  const insProblem = keyProblem(ins, ["templateId", "sha256"], "/instruction");
  if (insProblem !== undefined) return no(insProblem);
  if (!isStr(ins["templateId"]) || ins["templateId"] === "") return no("bad_value:/instruction/templateId");
  if (!isStr(ins["sha256"]) || !HEX64.test(ins["sha256"])) return no("bad_value:/instruction/sha256");
  const parts = tree["parts"];
  if (!Array.isArray(parts)) return no("bad_type:/parts");
  if (parts.length < 1 || parts.length > MAX_PARTS) return no("bad_value:/parts");
  const ids = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    const ptr = `/parts/${i}`;
    if (!isObj(p)) return no(`bad_type:${ptr}`);
    const type = p["type"];
    if (!isStr(type)) return no(`bad_type:${ptr}/type`);
    const partId = p["partId"];
    if (!isStr(partId) || partId === "") return no(`bad_value:${ptr}/partId`);
    if (ids.has(partId)) return no(`duplicate_part_id:${ptr}/partId`);
    ids.add(partId);
    let problem: string | undefined;
    if (type === "source_file") {
      problem = keyProblem(p, ["partId", "type", "path", "sha256Lf", "text"], ptr);
      if (problem === undefined) {
        if (!isStr(p["path"]) || p["path"] === "") problem = `bad_value:${ptr}/path`;
        else if (!isStr(p["sha256Lf"]) || !HEX64.test(p["sha256Lf"])) problem = `bad_value:${ptr}/sha256Lf`;
        else if (!isStr(p["text"])) problem = `bad_type:${ptr}/text`;
      }
    } else if ((STORED_PART_TYPES as readonly string[]).includes(type)) {
      problem = keyProblem(p, ["partId", "type", "recordId", "recordSha256", "content"], ptr);
      if (problem === undefined) {
        if (!isStr(p["recordId"]) || p["recordId"] === "") problem = `bad_value:${ptr}/recordId`;
        else if (!isStr(p["recordSha256"]) || !HEX64.test(p["recordSha256"])) problem = `bad_value:${ptr}/recordSha256`;
      }
    } else {
      problem = keyProblem(p, ["partId", "type"], ptr); // a type outside the permitted kinds: A03 blocks it
    }
    if (problem !== undefined) return no(problem);
  }
  return { ok: true, env: tree as unknown as PayloadEnvelope };
}

// ---------------------------------------------------------------------------------------------
// String collection for scans
// ---------------------------------------------------------------------------------------------
/** Every object key and every string value of the tree. */
function collectStrings(v: Json, out: string[]): void {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (isObj(v)) {
    for (const k of Object.keys(v)) {
      out.push(k);
      collectStrings(v[k] as Json, out);
    }
  }
}

/** Strings of the envelope outside the text of source files (A05 prefix scan: source text may legitimately talk about anything allowlisted). */
function nonSourceStrings(env: PayloadEnvelope): string[] {
  const out: string[] = [env.instruction.templateId, env.instruction.sha256];
  for (const p of env.parts) {
    out.push(p.partId, p.type);
    if (p.type === "source_file") out.push((p as SourceFilePart).path, (p as SourceFilePart).sha256Lf);
    else if ((STORED_PART_TYPES as readonly string[]).includes(p.type)) {
      const s = p as StoredPart;
      out.push(s.recordId, s.recordSha256);
      collectStrings(s.content, out);
    }
  }
  return out;
}

const foldPath = (s: string): string => s.replaceAll("\\", "/").toLowerCase();

// ---------------------------------------------------------------------------------------------
// Candidates for the restricted path prefix scan (A05 only)
// ---------------------------------------------------------------------------------------------
/** A run of valid percent escapes, `%2F` or `%E6%97%A5`. A `%` that is not followed by two hexadecimal digits is plain text, not an escape. */
const ESCAPE_RUN = /(?:%[0-9A-Fa-f]{2})+/g;
const HAS_ESCAPE = /%[0-9A-Fa-f]{2}/;
/** Layers of percent decoding that are followed. A string that would need a further pass is ambiguous and blocks (fail closed). */
const MAX_DECODE_LAYERS = 3;
type PathCandidates = { ok: true; values: string[] } | { ok: false; code: "path_encoding_invalid" | "path_encoding_ambiguous" };

/** Decodes every run of valid escapes of one layer as UTF-8. Returns undefined if a run is not valid UTF-8. */
function decodeEscapeLayer(s: string): string | undefined {
  let invalid = false;
  const out = s.replace(ESCAPE_RUN, (run) => {
    const bytes = new Uint8Array(run.length / 3);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(run.slice(i * 3 + 1, i * 3 + 3), 16);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      invalid = true;
      return run;
    }
  });
  return invalid ? undefined : out;
}

/**
 * The forms of a string under which a restricted path prefix is looked for: the string itself, its NFKC form (fullwidth letters and slashes, and
 * a fullwidth `%`, become ASCII), and each layer of percent decoding of it (`%2F`, `%252F`), each folded for case and `\`. The decoded forms are
 * only searched for a prefix: they are never used to accept a path, and the allowlist check (exact string equality) does not use them.
 * Fail closed: an escape sequence that is not valid UTF-8, or one that needs more than `MAX_DECODE_LAYERS` passes, gives no candidates.
 * A lone `%` in ordinary text (`50%`) is not an escape and is left as it is.
 */
function pathCandidates(s: string): PathCandidates {
  const values: string[] = [];
  let layer = s;
  for (let depth = 0; ; depth++) {
    const normalized = layer.normalize("NFKC");
    values.push(foldPath(layer), foldPath(normalized));
    layer = normalized;
    if (!HAS_ESCAPE.test(layer)) return { ok: true, values };
    if (depth >= MAX_DECODE_LAYERS) return { ok: false, code: "path_encoding_ambiguous" };
    const decoded = decodeEscapeLayer(layer);
    if (decoded === undefined) return { ok: false, code: "path_encoding_invalid" };
    layer = decoded;
  }
}

// ---------------------------------------------------------------------------------------------
// The audit
// ---------------------------------------------------------------------------------------------
/**
 * Audits the exact bytes that would be transmitted (see the header of this file). It never throws: if anything unexpected happens outside a
 * single check (a hostile or broken `cfg` or `ctx`, for example a getter that throws), the audit cannot be completed and the result is
 * `blocked` (R2.9, fail closed) with no request and no bytes returned.
 */
export function auditPayload(
  bytes: Uint8Array,
  kind: RequestKind,
  cfg: AuditConfigLoadResult,
  ctx: AuditContext,
): { audit: AuditResult; request?: AuditedRequest } {
  try {
    return auditPayloadChecked(bytes, kind, cfg, ctx);
  } catch {
    let hash: string;
    try {
      hash = sha256Hex(new Uint8Array(bytes));
    } catch {
      hash = sha256Hex(new Uint8Array(0));
    }
    const checks: AuditCheck[] = AUDIT_CHECK_IDS.map((id) =>
      id === "A09" ? { id, outcome: "fail" as const, detail: "internal_error" } : { id, outcome: "not_run" as const, detail: "internal_error" },
    );
    return { audit: { result: "blocked", payloadSha256: hash, bytesWithheld: true, checks, matches: [] } };
  }
}

function auditPayloadChecked(
  bytes: Uint8Array,
  kind: RequestKind,
  cfg: AuditConfigLoadResult,
  ctx: AuditContext,
): { audit: AuditResult; request?: AuditedRequest } {
  const checks = new Map<AuditCheckId, AuditCheck>();
  const matches: AuditMatch[] = [];
  const setCheck = (id: AuditCheckId, outcome: AuditCheck["outcome"], detail?: string): void => {
    checks.set(id, detail === undefined ? { id, outcome } : { id, outcome, detail });
  };
  const addMatch = (checkId: AuditCheckId, matchId: string): void => {
    if (!matches.some((m) => m.checkId === checkId && m.matchId === matchId)) matches.push({ checkId, matchId });
  };
  /** Runs one check; an unexpected exception makes it `fail` with a fixed code (an incomplete check blocks, R2.9). */
  const run = (id: AuditCheckId, fn: () => string | undefined): void => {
    try {
      const detail = fn();
      if (detail === undefined) setCheck(id, "pass");
      else setCheck(id, "fail", detail);
    } catch {
      setCheck(id, "fail", "check_error");
    }
  };

  // ---- the private copy that is audited ----
  let inputIssue: "not_bytes" | "shared_array_buffer" | undefined;
  let snapshot = new Uint8Array(0);
  try {
    if (!ArrayBuffer.isView(bytes) || Object.prototype.toString.call(bytes) !== "[object Uint8Array]") inputIssue = "not_bytes";
    else {
      if (Object.prototype.toString.call(bytes.buffer) === "[object SharedArrayBuffer]") inputIssue = "shared_array_buffer";
      snapshot = new Uint8Array(bytes); // a copy into a fresh ArrayBuffer
    }
  } catch {
    inputIssue = "not_bytes";
  }
  const payloadSha256 = sha256Hex(snapshot);
  const config: AuditConfig | undefined = cfg.ok ? cfg.config : undefined;

  // A01: the audit configuration (R2.9)
  run("A01", () => (cfg.ok ? undefined : cfg.reason));

  const limits = effectiveAuditLimits(ctx.limits);
  const tooLarge = snapshot.byteLength > limits.maxBytes;
  let tree: Json | undefined;
  let env: PayloadEnvelope | undefined;
  let rawText = "";
  let joined = "";

  if (inputIssue === undefined && !tooLarge) {
    rawText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(snapshot);

    // A02: envelope is canonical, strictly parsed and has no undefined field (R2.7)
    run("A02", () => {
      if (!(REQUEST_KINDS as readonly unknown[]).includes(kind)) return "unknown_kind";
      const parsed = strictJsonParse(snapshot, limits);
      if (!parsed.ok) return parsed.error.code;
      tree = parsed.value;
      const strings: string[] = [];
      collectStrings(tree, strings);
      joined = strings.join("\n");
      const canon = tryCanonicalJson(tree);
      if (!canon.ok) return canon.error.code;
      if (new TextDecoder().decode(snapshot) !== canon.value) return "not_canonical";
      const v = validateEnvelope(tree, kind);
      if (!v.ok) return v.detail;
      env = v.env;
      return undefined;
    });
    if (tree === undefined) {
      // A payload that does not parse is still scanned as text by A06 to A08.
      joined = "";
    }
    const envelope = env as PayloadEnvelope | undefined;

    // Sensitive values, used to keep a payload-derived path out of a result.
    const sensitive: string[] = [
      ...(config ? [...config.canaries, ...config.decoys].map((e) => e.value.toLowerCase()) : []),
      ...ctx.secretValues.filter((s) => s.value !== "").map((s) => s.value.toLowerCase()),
    ];
    const safeId = (s: string): string => {
      const l = s.toLowerCase();
      if (sensitive.some((v) => l.includes(v))) return "[redacted]";
      return (s.length > 200 ? s.slice(0, 200) : s).replace(/[\u0000-\u001f\u007f]/g, "?");
    };

    // A03: composition (R2.7)
    if (envelope === undefined) setCheck("A03", "not_run", "no_valid_envelope");
    else {
      run("A03", () => {
        let detail: string | undefined;
        const tpl = ctx.instructionTemplates.get(envelope.instruction.templateId);
        if (tpl === undefined) detail = "instruction_template_unknown";
        else if (tpl !== envelope.instruction.sha256) detail = "instruction_hash_mismatch";
        envelope.parts.forEach((p, i) => {
          if (p.type === "source_file") return;
          if (!(STORED_PART_TYPES as readonly string[]).includes(p.type)) {
            addMatch("A03", `part:${i}`);
            detail ??= "part_type_not_permitted";
            return;
          }
          const s = p as StoredPart;
          const rec = ctx.lookupRecord(s.recordId);
          let why: string | undefined;
          if (rec === undefined) why = "record_not_found";
          else if (typeof rec.kind !== "string" || rec.kind === "") why = "record_kind_unverified";
          else if (rec.kind !== s.type) why = "record_kind_mismatch";
          else if (sha256Hex(rec.canonicalJson) !== rec.sha256) why = "store_inconsistent";
          else if (s.recordSha256 !== rec.sha256) why = "record_hash_mismatch";
          else if (canonicalJson(s.content) !== rec.canonicalJson) why = "content_differs";
          if (why !== undefined) {
            addMatch("A03", `part:${i}`);
            detail ??= why;
          }
        });
        return detail;
      });
    }

    // A04: source files equal the Source_Bundle manifest: full set, order and count (R2.6)
    if (envelope === undefined) setCheck("A04", "not_run", "no_valid_envelope");
    else {
      run("A04", () => {
        const manifest = ctx.bundle.manifest;
        if (manifest.length === 0) return "manifest_empty";
        const sources = envelope.parts.filter((p): p is SourceFilePart => p.type === "source_file");
        let detail: string | undefined;
        if (sources.length !== manifest.length) detail = "count_mismatch";
        const n = Math.min(sources.length, manifest.length);
        for (let i = 0; i < n; i++) {
          const m = manifest[i] as { path: string; sha256Lf: string };
          const s = sources[i] as SourceFilePart;
          let why: string | undefined;
          if (s.path !== m.path) why = "path_mismatch";
          else if (s.sha256Lf !== m.sha256Lf) why = "hash_mismatch";
          else if (sha256Hex(s.text) !== m.sha256Lf) why = "text_differs";
          if (why !== undefined) {
            addMatch("A04", m.path); // the path of the trusted manifest, not payload text
            detail ??= why;
          }
        }
        // A file the manifest does not list is named too (R2.6, the affected file). Its path comes from the payload, so it is written only when
        // the configuration is present to redact a sensitive value; otherwise only its position is recorded.
        for (const m of manifest.slice(n)) addMatch("A04", m.path);
        sources.slice(n).forEach((s, i) => addMatch("A04", config !== undefined ? safeId(s.path) : `extra_source:${n + i}`));
        return detail;
      });
    }

    // A05: paths (R2.5)
    if (envelope === undefined) setCheck("A05", "not_run", "no_valid_envelope");
    else if (config === undefined) setCheck("A05", "not_run", "no_audit_config");
    else {
      run("A05", () => {
        let detail: string | undefined;
        // Only the intersection of the two lists is allowed (exact string equality). A path in one list only is refused, an empty
        // intersection refuses everything, and neither list can widen what the other allows.
        const allowed = new Set(config.allowlist.filter((p) => ctx.allowlist.includes(p)));
        if (allowed.size === 0) detail = "allowlist_intersection_empty";
        for (const p of envelope.parts) {
          if (p.type !== "source_file") continue;
          const path = (p as SourceFilePart).path;
          if (!allowed.has(path)) {
            addMatch("A05", safeId(path));
            detail ??= "path_not_allowlisted";
          }
        }
        // The prefixes are searched for in every candidate form of every string outside source text (see `pathCandidates`).
        const prefixes = config.restrictedPathPrefixes.map((p) => foldPath(p.normalize("NFKC")));
        const hit = new Set<number>();
        nonSourceStrings(envelope).forEach((s, si) => {
          const cands = pathCandidates(s);
          if (!cands.ok) {
            addMatch("A05", `restricted_path_encoding:${si}`); // the position only, never the string
            detail ??= cands.code;
            return;
          }
          prefixes.forEach((prefix, i) => {
            if (cands.values.some((v) => v.includes(prefix))) hit.add(i);
          });
        });
        for (const i of [...hit].sort((a, b) => a - b)) {
          addMatch("A05", `restricted_path_prefix:${i}`);
          detail ??= "restricted_path_prefix";
        }
        return detail;
      });
    }

    // Text that A06 to A08 search: the raw text and, when the payload parsed, the decoded strings (JSON escapes cannot hide a value).
    const haystacks = [rawText, joined].filter((s) => s !== "");
    const lowered = haystacks.map((s) => s.toLowerCase());
    const contains = (needle: string): boolean => needle !== "" && lowered.some((h) => h.includes(needle.toLowerCase()));

    // A06: canary and decoy (R2.4)
    if (config === undefined) setCheck("A06", "not_run", "no_audit_config");
    else {
      run("A06", () => {
        let hit = false;
        for (const e of [...config.canaries, ...config.decoys]) {
          if (contains(e.value)) {
            addMatch("A06", e.id);
            hit = true;
          }
        }
        return hit ? "canary_or_decoy_found" : undefined;
      });
    }

    // A07: fingerprints of restricted files (R2.8)
    if (config === undefined) setCheck("A07", "not_run", "no_audit_config");
    else {
      run("A07", () => {
        const tokenLists = haystacks.map((h) => tokenize(h));
        const byN = new Map<number, Set<string>>();
        for (const n of new Set(config.fingerprints.map((f) => f.n))) {
          const all = new Set<string>();
          for (const t of tokenLists) for (const h of ngramHashes(t, n)) all.add(h);
          byN.set(n, all);
        }
        let hit = false;
        for (const f of config.fingerprints) {
          const found = byN.get(f.n) as Set<string>;
          if (f.hashes.some((h) => found.has(h))) {
            addMatch("A07", f.id);
            hit = true;
          }
        }
        return hit ? "restricted_content_fingerprint" : undefined;
      });
    }

    // A08: secrets (R19.7); matched by variable name only
    run("A08", () => {
      let hit = false;
      for (const s of ctx.secretValues) {
        if (contains(s.value)) {
          addMatch("A08", s.name);
          hit = true;
        }
      }
      return hit ? "secret_value_found" : undefined;
    });
  } else if (tooLarge && inputIssue === undefined) {
    // No scan of an oversized payload (bounded work); the result is blocked.
    setCheck("A02", "fail", "size_exceeded");
    for (const id of ["A03", "A04", "A05", "A06", "A07", "A08"] as const) setCheck(id, "not_run", "size_exceeded");
  } else {
    for (const id of ["A02", "A03", "A04", "A05", "A06", "A07", "A08"] as const) setCheck(id, "not_run", "input_rejected");
  }

  // A09: hash binding. The bytes are bound to the hash of the private copy; the input must be plain memory and must not have changed.
  run("A09", () => {
    if (inputIssue !== undefined) return inputIssue;
    if (sha256Hex(new Uint8Array(bytes)) !== payloadSha256) return "input_changed";
    return undefined;
  });

  const ordered: AuditCheck[] = AUDIT_CHECK_IDS.map((id) => checks.get(id) ?? { id, outcome: "not_run" as const });
  const pass = ordered.every((c) => c.outcome === "pass");
  // The bytes are returned only if A05 to A08 all passed. A failed or not-run check of these four means that nothing shows the bytes to be free
  // of restricted paths, canaries, restricted-content fingerprints and credentials, so they are withheld (R2.12, R19.2; fail closed).
  const sensitiveClear = (["A05", "A06", "A07", "A08"] as const).every((id) => checks.get(id)?.outcome === "pass");
  const audit: AuditResult = {
    result: pass ? "pass" : "blocked",
    payloadSha256,
    ...(sensitiveClear ? { auditedBytes: new Uint8Array(snapshot) } : {}),
    bytesWithheld: !sensitiveClear,
    checks: ordered,
    matches,
  };
  return pass ? { audit, request: mintAuditedRequest(kind, snapshot, payloadSha256) } : { audit };
}