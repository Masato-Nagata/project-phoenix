// The production AuditPort of the Loop_Orchestrator (task 4.9-B): `prepareAudit` and `auditPayload` over the ai-client Payload_Auditor.
// It adds no audit rule, no masking rule and no new check: it only builds the envelope and the context that the existing auditor needs, and
// keeps the two tied to each other.
//
// DATA FLOW of one request.
//   1. The orchestrator hands `prepareAudit` the Source_Bundle, the request kind, the template id, the stored-part references and ONE frozen
//      snapshot of the committed records.
//   2. From the records that the stored references point to, ONE map `recordId -> { kind, canonical JSON of the record payload, SHA-256 of
//      that text }` is built. The canonical text is computed here, once; a later change of the record object cannot reach it.
//   3. The envelope (`schemaVersion`, `kind`, `instruction`, `parts`) is built from that map (the content of a stored part is parsed back from
//      the canonical text, `recordSha256` is the hash in the map) and from the Source_Bundle (one `source_file` part per file, in manifest
//      order, with the hash and the LF-normalized text of the bundle, which must agree with each other). The bytes are the canonical JSON of
//      the envelope, so the auditor's own A02 check (strict parse, canonical form) accepts them.
//   4. The AuditContext of the ai-client auditor (`lookupRecord`, the manifest, the allowlist, the template hashes, the secret values) is
//      derived from the SAME map and from copies of the same inputs. It is kept in a table that only this module can read. The caller gets
//      an opaque, frozen, empty handle; the context is never given to a Provider (the Provider receives the AuditedRequest that `auditPayload`
//      of ai-client mints, bound to the audited bytes).
//   5. `auditPayload(bytes, kind, cfg, handle)` finds the context by the handle and refuses (throws a closed error, which the orchestrator
//      turns into an `error` of the Run, before any Provider call) when the handle is unknown, the kind differs, or the bytes differ from the
//      bytes that were prepared (a swap between preparation and audit). Only then does it call the ai-client `auditPayload` with a fresh copy
//      of the bytes. A blocked audit returns no request, so no Provider call can follow.
//
// FAIL CLOSED. Any unexpected shape (a missing or duplicate record, a wrong kind, a bundle whose text and hash disagree, a record that has no
// canonical form, an unknown template, a throwing accessor) gives `prepare_failed`. No error carries a value, an id, a path, a hash or text.
//
// WHAT THIS MODULE DOES NOT HAVE. The text of the fixed instruction templates: only their ids and SHA-256 are injected (`instructionTemplates`).
// The credential values (`secretValues`) are injected too and are empty for the Mock_Provider.
import { REQUEST_KINDS, STORED_PART_TYPES, auditPayload as clientAuditPayload, isSha256Hex, sha256Hex, tryCanonicalJson } from "@phoenix/ai-client";
import type { AuditConfigLoadResult, AuditContext, AuditLimits, AuditResult, AuditedRequest, Json, RequestKind, Result, StoredRecordView } from "@phoenix/ai-client";

export interface AuditAdapterOptions {
  /** The content of `docs/ai-input-allowlist.json`: the paths a source part may have. */
  readonly allowlist: readonly string[];
  /** templateId -> SHA-256 of the fixed instruction text. */
  readonly instructionTemplates: ReadonlyMap<string, string>;
  /** Variable names and values of the credentials that must never be sent (empty for the Mock_Provider). */
  readonly secretValues: readonly { readonly name: string; readonly value: string }[];
  readonly limits?: AuditLimits;
}

export type AuditAdapterRefusalCode = "context_unknown" | "kind_mismatch" | "bytes_changed";
/** Thrown by `auditPayload` only. The message is the code; nothing else is carried. */
export class AuditAdapterError extends Error {
  readonly code: AuditAdapterRefusalCode;
  constructor(code: AuditAdapterRefusalCode) {
    super(code);
    this.name = "AuditAdapterError";
    this.code = code;
  }
}

export type PrepareFailed = { readonly code: "prepare_failed" };
export interface AuditAdapter<THandle extends object> {
  prepareAudit(input: unknown): Result<{ readonly bytes: Uint8Array; readonly ctx: THandle }, PrepareFailed>;
  auditPayload(bytes: Uint8Array, kind: string, cfg: AuditConfigLoadResult, ctx: THandle): { audit: AuditResult; request?: AuditedRequest };
}

interface Prepared {
  readonly kind: RequestKind;
  readonly sha256: string;
  readonly context: AuditContext;
}

const PREPARE_FAILED: Result<never, PrepareFailed> = Object.freeze({ ok: false as const, error: Object.freeze({ code: "prepare_failed" as const }) });
const OPTIONS_INVALID: Result<never, { readonly code: "options_invalid" }> = Object.freeze({ ok: false as const, error: Object.freeze({ code: "options_invalid" as const }) });

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string" && v !== "";
const encoder = new TextEncoder();

/** `THandle` is the opaque handle type of the orchestrator's `AuditContextHandle`; this module cannot import it (see the import boundary). */
export function createAuditAdapter<THandle extends object>(options: unknown): Result<AuditAdapter<THandle>, { readonly code: "options_invalid" }> {
  if (!isObj(options)) return OPTIONS_INVALID;
  const { allowlist, instructionTemplates, secretValues, limits } = options as { allowlist?: unknown; instructionTemplates?: unknown; secretValues?: unknown; limits?: unknown };
  if (!Array.isArray(allowlist) || !allowlist.every(isText)) return OPTIONS_INVALID;
  if (!(instructionTemplates instanceof Map)) return OPTIONS_INVALID;
  const templates = new Map<string, string>();
  for (const [id, hash] of instructionTemplates as Map<unknown, unknown>) {
    if (!isText(id) || !isSha256Hex(hash)) return OPTIONS_INVALID;
    templates.set(id, hash);
  }
  if (!Array.isArray(secretValues)) return OPTIONS_INVALID;
  const secrets: { readonly name: string; readonly value: string }[] = [];
  for (const s of secretValues as unknown[]) {
    if (!isObj(s)) return OPTIONS_INVALID;
    const name = s["name"];
    const value = s["value"];
    if (!isText(name) || typeof value !== "string") return OPTIONS_INVALID;
    secrets.push(Object.freeze({ name, value }));
  }
  let auditLimits: AuditLimits | undefined;
  if (limits !== undefined) {
    if (!isObj(limits) || !Number.isSafeInteger(limits["maxBytes"]) || !Number.isSafeInteger(limits["maxDepth"])) return OPTIONS_INVALID;
    auditLimits = Object.freeze({ maxBytes: limits["maxBytes"] as number, maxDepth: limits["maxDepth"] as number });
  }
  const allowed: readonly string[] = Object.freeze([...(allowlist as string[])]);
  const frozenSecrets: readonly { readonly name: string; readonly value: string }[] = Object.freeze(secrets);

  // handle -> what was prepared. Only this module reads it.
  const prepared = new WeakMap<object, Prepared>();

  const prepareAudit = (input: unknown): Result<{ readonly bytes: Uint8Array; readonly ctx: THandle }, PrepareFailed> => {
    try {
      if (!isObj(input)) return PREPARE_FAILED;
      const kind = input["kind"];
      if (typeof kind !== "string" || !(REQUEST_KINDS as readonly string[]).includes(kind)) return PREPARE_FAILED;
      const templateId = input["templateId"];
      const templateHash = typeof templateId === "string" ? templates.get(templateId) : undefined;
      if (typeof templateId !== "string" || templateHash === undefined) return PREPARE_FAILED;

      // the Source_Bundle: manifest and files agree entry by entry
      const bundle = input["bundle"];
      if (!isObj(bundle)) return PREPARE_FAILED;
      const manifestIn = bundle["manifest"];
      const filesIn = bundle["files"];
      if (!Array.isArray(manifestIn) || !Array.isArray(filesIn) || manifestIn.length === 0 || manifestIn.length !== filesIn.length) return PREPARE_FAILED;
      const manifest: { readonly path: string; readonly sha256Lf: string }[] = [];
      const sourceParts: Json[] = [];
      const partIds = new Set<string>();
      for (let i = 0; i < manifestIn.length; i += 1) {
        const m: unknown = manifestIn[i];
        const f: unknown = filesIn[i];
        if (!isObj(m) || !isObj(f)) return PREPARE_FAILED;
        const path = m["path"];
        const sha256Lf = m["sha256Lf"];
        const text = f["text"];
        if (!isText(path) || !isSha256Hex(sha256Lf) || typeof text !== "string" || f["path"] !== path || sha256Hex(text) !== sha256Lf) return PREPARE_FAILED;
        manifest.push(Object.freeze({ path, sha256Lf }));
        const partId = `src-${i + 1}`;
        partIds.add(partId);
        sourceParts.push({ partId, type: "source_file", path, sha256Lf, text });
      }

      // the records: one entry per id; a duplicate id is ambiguous and refused
      const recordsIn = input["records"];
      if (!Array.isArray(recordsIn)) return PREPARE_FAILED;
      const byId = new Map<string, { kind: string; payload: unknown }>();
      for (const r of recordsIn as unknown[]) {
        if (!isObj(r)) return PREPARE_FAILED;
        const id = r["id"];
        const recordKind = r["kind"];
        if (!isText(id) || !isText(recordKind) || byId.has(id)) return PREPARE_FAILED;
        byId.set(id, { kind: recordKind, payload: r["payload"] });
      }

      // the stored parts: the ONE snapshot, built from the referenced records
      const storedIn = input["stored"];
      if (!Array.isArray(storedIn)) return PREPARE_FAILED;
      const snapshot = new Map<string, StoredRecordView>();
      const storedParts: Json[] = [];
      for (const ref of storedIn as unknown[]) {
        if (!isObj(ref)) return PREPARE_FAILED;
        const partId = ref["partId"];
        const type = ref["type"];
        const recordId = ref["recordId"];
        if (!isText(partId) || !isText(recordId) || typeof type !== "string") return PREPARE_FAILED;
        if (!(STORED_PART_TYPES as readonly string[]).includes(type) || partIds.has(partId)) return PREPARE_FAILED;
        const record = byId.get(recordId);
        if (record === undefined || record.kind !== type) return PREPARE_FAILED;
        let view = snapshot.get(recordId);
        if (view === undefined) {
          const canonical = tryCanonicalJson(record.payload);
          if (!canonical.ok) return PREPARE_FAILED;
          view = Object.freeze({ kind: record.kind, sha256: sha256Hex(canonical.value), canonicalJson: canonical.value });
          snapshot.set(recordId, view);
        }
        partIds.add(partId);
        storedParts.push({ partId, type, recordId, recordSha256: view.sha256, content: JSON.parse(view.canonicalJson) as Json });
      }

      const envelope: Json = { schemaVersion: 1, kind, instruction: { templateId, sha256: templateHash }, parts: [...sourceParts, ...storedParts] };
      const canonicalEnvelope = tryCanonicalJson(envelope);
      if (!canonicalEnvelope.ok) return PREPARE_FAILED;
      const bytes = encoder.encode(canonicalEnvelope.value);

      const context: AuditContext = {
        bundle: { manifest: Object.freeze(manifest) },
        allowlist: allowed,
        lookupRecord: (id: string): StoredRecordView | undefined => {
          try {
            const v = snapshot.get(id);
            return v === undefined ? undefined : { kind: v.kind, sha256: v.sha256, canonicalJson: v.canonicalJson };
          } catch {
            return undefined;
          }
        },
        instructionTemplates: new Map([[templateId, templateHash]]),
        secretValues: frozenSecrets,
        ...(auditLimits === undefined ? {} : { limits: auditLimits }),
      };
      const handle = Object.freeze({}) as unknown as THandle;
      prepared.set(handle, Object.freeze({ kind: kind as RequestKind, sha256: sha256Hex(bytes), context }));
      return { ok: true, value: { bytes: new Uint8Array(bytes), ctx: handle } };
    } catch {
      return PREPARE_FAILED;
    }
  };

  const auditPayload = (bytes: Uint8Array, kind: string, cfg: AuditConfigLoadResult, ctx: THandle): { audit: AuditResult; request?: AuditedRequest } => {
    const p = typeof ctx === "object" && ctx !== null ? prepared.get(ctx) : undefined;
    if (p === undefined) throw new AuditAdapterError("context_unknown");
    if (kind !== p.kind) throw new AuditAdapterError("kind_mismatch");
    if (!(bytes instanceof Uint8Array) || sha256Hex(bytes) !== p.sha256) throw new AuditAdapterError("bytes_changed");
    return clientAuditPayload(new Uint8Array(bytes), p.kind, cfg, p.context);
  };

  return { ok: true, value: Object.freeze({ prepareAudit, auditPayload }) };
}