// The replay AuditPort (task 4.7, step A2; R22.4, R22.5; human decisions D1, D4 of 2026-11-27).
//
// `prepareAudit` REGENERATES the request: it calls the injected pure envelope function, which is the SAME function that `prepareAudit` of the
// production audit adapter uses (`buildRequestEnvelope` of `runtime/auditAdapter.ts`, decision D4), over the Source_Bundle restored from the
// records, the template table restored from the records, and the snapshot of the REGENERATED records. The recorded request bytes are never
// returned as the request.
// `auditPayload` compares the regenerated request with the NEXT recorded `payload_audit`, in order: the kind and the SHA-256 of the bytes.
// Only when both are equal is the RECORDED verdict handed back (result, checks, matches, bytesWithheld). The audit is NOT executed again:
// no allowlist, no audit configuration, no canary list is held here, and nothing claims otherwise (`audit: reused_not_reexecuted`).
// A `blocked` verdict stays `blocked` and returns no request, so no provider call can follow it; a `pass` verdict returns a replay request
// that only the ReplayProvider of the same session accepts. A mismatch is noted in the divergence cell and the call is refused with a throw,
// BEFORE any provider call: `callProvider` latches `error` and the replay stops (R22.5).
// Pure: no I/O, no clock, no import of the orchestrator, the runtime adapters or a sibling package.
import { createHash } from "node:crypto";
import type { RecordedAudit } from "./replayInputs.js";
import type { DivergenceCell } from "./replaySupport.js";

/** The injected envelope function (the C2 pure function). It answers the canonical envelope bytes, or a refusal. */
export type EnvelopeFunction = (input: unknown, templates: ReadonlyMap<string, string>) => { readonly ok: true; readonly value: { readonly kind: string; readonly bytes: Uint8Array } } | { readonly ok: false };

/** The request a replay hands to the ReplayProvider. Not an ai-client `AuditedRequest`: a real provider behind the ai-client guard refuses it. */
export interface ReplayRequest {
  readonly kind: string;
  readonly sha256: string;
  readonly bytes: Uint8Array;
  readonly attempt: number;
  /** The recorded `payload_audit` whose verdict was reused. */
  readonly payloadAuditRecordId: string;
}

export interface ReplayRequestRegistry {
  /** true only for a request object that the replay audit of THIS session created. */
  owns(request: unknown): boolean;
}

export class ReplayAuditRefusal extends Error {
  constructor(readonly code: "context_unknown" | "kind_mismatch" | "bytes_changed" | "request_mismatch") {
    super(code);
    this.name = "ReplayAuditRefusal";
  }
}

export interface ReplayAudit {
  prepareAudit(input: unknown): { readonly ok: true; readonly value: { readonly bytes: Uint8Array; readonly ctx: object } } | { readonly ok: false; readonly error: { readonly code: "prepare_failed" } };
  auditPayload(bytes: Uint8Array, kind: string, cfg: unknown, ctx: unknown): { readonly audit: unknown; readonly request?: ReplayRequest };
  readonly registry: ReplayRequestRegistry;
  /** Recorded audits not yet compared. */
  unconsumed(): number;
  /** How many verdicts were reused. */
  reused(): number;
}

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const PREPARE_FAILED = Object.freeze({ ok: false as const, error: Object.freeze({ code: "prepare_failed" as const }) });

export function createReplayAudit(options: {
  readonly envelope: EnvelopeFunction;
  readonly templates: ReadonlyMap<string, string>;
  readonly recorded: readonly RecordedAudit[];
  readonly cell: DivergenceCell;
}): ReplayAudit {
  const { envelope, cell } = options;
  const templates: ReadonlyMap<string, string> = new Map(options.templates);
  const recorded = [...options.recorded];
  const prepared = new WeakMap<object, { readonly kind: string; readonly sha256: string }>();
  const requests = new WeakSet<object>();
  let cursor = 0;
  let reusedCount = 0;

  const prepareAudit: ReplayAudit["prepareAudit"] = (input) => {
    let built: ReturnType<EnvelopeFunction>;
    try {
      built = envelope(input, templates);
    } catch {
      built = { ok: false };
    }
    if (!built.ok) {
      cell.noteRequest("request_not_buildable", recorded[cursor]?.id);
      return PREPARE_FAILED;
    }
    const bytes = new Uint8Array(built.value.bytes);
    const ctx = Object.freeze({});
    prepared.set(ctx, Object.freeze({ kind: built.value.kind, sha256: sha256Hex(bytes) }));
    return { ok: true, value: { bytes: new Uint8Array(bytes), ctx } };
  };

  const auditPayload: ReplayAudit["auditPayload"] = (bytes, kind, _cfg, ctx) => {
    const p = typeof ctx === "object" && ctx !== null ? prepared.get(ctx) : undefined;
    if (p === undefined) throw new ReplayAuditRefusal("context_unknown");
    if (kind !== p.kind) throw new ReplayAuditRefusal("kind_mismatch");
    if (!(bytes instanceof Uint8Array) || sha256Hex(bytes) !== p.sha256) throw new ReplayAuditRefusal("bytes_changed");
    const next = recorded[cursor];
    if (next === undefined) {
      cell.noteRequest("request_unexpected");
      throw new ReplayAuditRefusal("request_mismatch");
    }
    if (next.requestKind !== kind) {
      cell.noteRequest("request_kind_mismatch", next.id);
      throw new ReplayAuditRefusal("request_mismatch");
    }
    if (next.payloadSha256 !== p.sha256) {
      cell.noteRequest("request_hash_mismatch", next.id);
      throw new ReplayAuditRefusal("request_mismatch");
    }
    cursor += 1;
    reusedCount += 1;
    const audit = Object.freeze({
      result: next.result,
      payloadSha256: next.payloadSha256,
      bytesWithheld: next.bytesWithheld,
      checks: next.checks.map((c) => (c.detail === undefined ? { id: c.id, outcome: c.outcome } : { id: c.id, outcome: c.outcome, detail: c.detail })),
      matches: next.matches.map((m) => ({ checkId: m.checkId, matchId: m.matchId })),
      // the regenerated bytes (equal hash) stand where the original wrote the audited bytes; nothing is written when the original did not
      ...(next.hasBlob ? { auditedBytes: new Uint8Array(bytes) } : {}),
    });
    if (next.result !== "pass") return { audit };
    const request: ReplayRequest = Object.freeze({
      kind,
      sha256: p.sha256,
      bytes: new Uint8Array(bytes),
      attempt: next.attempt,
      payloadAuditRecordId: next.id,
    });
    requests.add(request);
    return { audit, request };
  };

  return Object.freeze({
    prepareAudit,
    auditPayload,
    registry: Object.freeze({ owns: (r: unknown): boolean => typeof r === "object" && r !== null && requests.has(r) }),
    unconsumed: (): number => recorded.length - cursor,
    reused: (): number => reusedCount,
  });
}
