// ReplayProvider: the record-replay source of a replay (task 4.7, step A2; R22.4, R22.5; human decision D3 of 2026-11-27).
//
// What it is. A source of RECORDED answers inside discovery-loop. It is not an implementation of the ai-client provider abstraction, it is not
// registered in `createProvider` (which keeps refusing `replay`), and it sends nothing: this module imports `node:crypto` (hashing) and two
// type-only modules, and nothing else (pinned by the static test). The provider identity it shows is the identity RECORDED in the original Run,
// used as historical information so that the regenerated `ai_call` records can be compared; it does not mean that this provider is, or that
// any real provider was called.
//
// What it checks, for every call, against the NEXT recorded `ai_call` (in order):
//   - the request object was created by the replay audit of the same session (`ReplayRequestRegistry`);
//   - `payloadAuditRecordId`, request kind and attempt equal the recorded call;
//   - the SHA-256 of the request bytes equals the request hash and the recorded `requestSha256`.
// Only then it answers the recorded outcome: the verified recorded response bytes (a fresh copy), the recorded provider error reason, or a
// provider-side timeout. A mismatch is noted in the divergence cell and answered as an audit violation of the closed vocabulary
// (`hash_mismatch` or `not_audited`), which `callProvider` turns into `error` and a stop without any retry (R22.5).
import { createHash } from "node:crypto";
import type { ReplayRequest, ReplayRequestRegistry } from "./replayAudit.js";
import type { ProviderIdentity, RecordedCall } from "./replayInputs.js";
import type { DivergenceCell } from "./replaySupport.js";

export type ReplayAnswer =
  | { readonly ok: true; readonly value: Uint8Array }
  | { readonly ok: false; readonly error: { readonly reason: string; readonly detail: string; readonly violation?: { readonly code: "not_audited" | "hash_mismatch" } } };

export interface ReplayProvider {
  readonly identity: ProviderIdentity;
  complete(request: unknown, options: { readonly timeoutMs: number; readonly signal: AbortSignal }): Promise<ReplayAnswer>;
  /** Recorded calls not yet answered. */
  unconsumed(): number;
  /** How many recorded answers were handed out. */
  answered(): number;
}

const sha256Hex = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const violation = (code: "not_audited" | "hash_mismatch"): ReplayAnswer =>
  Object.freeze({ ok: false as const, error: Object.freeze({ reason: "audit_violation", detail: "", violation: Object.freeze({ code }) }) });

export function createReplayProvider(options: {
  readonly identity: ProviderIdentity;
  readonly recorded: readonly RecordedCall[];
  readonly registry: ReplayRequestRegistry;
  readonly cell: DivergenceCell;
}): ReplayProvider {
  const { registry, cell } = options;
  const identity: ProviderIdentity = Object.freeze({ id: options.identity.id, version: options.identity.version, model: options.identity.model });
  const recorded = [...options.recorded];
  let cursor = 0;
  let answered = 0;

  const complete = async (request: unknown, _options: { readonly timeoutMs: number; readonly signal: AbortSignal }): Promise<ReplayAnswer> => {
    if (!registry.owns(request)) {
      cell.noteRequest("request_not_from_replay_audit", recorded[cursor]?.id);
      return violation("not_audited");
    }
    const req = request as ReplayRequest;
    const next = recorded[cursor];
    if (next === undefined) {
      cell.noteRequest("request_unexpected");
      return violation("hash_mismatch");
    }
    if (next.payloadAuditRecordId !== req.payloadAuditRecordId) {
      cell.noteRequest("request_order_mismatch", next.id);
      return violation("hash_mismatch");
    }
    if (next.requestKind !== req.kind) {
      cell.noteRequest("request_kind_mismatch", next.id);
      return violation("hash_mismatch");
    }
    if (next.attempt !== req.attempt) {
      cell.noteRequest("request_attempt_mismatch", next.id);
      return violation("hash_mismatch");
    }
    if (sha256Hex(req.bytes) !== req.sha256 || req.sha256 !== next.requestSha256) {
      cell.noteRequest("request_hash_mismatch", next.id);
      return violation("hash_mismatch");
    }
    cursor += 1;
    answered += 1;
    const a = next.answer;
    if (a.outcome === "response") {
      // the bytes were verified against their blob name and the recorded response hash before the replay started; checked once more here
      if (sha256Hex(a.bytes) !== a.responseSha256) {
        cell.noteRequest("request_hash_mismatch", next.id);
        return violation("hash_mismatch");
      }
      return Object.freeze({ ok: true as const, value: new Uint8Array(a.bytes) });
    }
    if (a.outcome === "provider_error") return Object.freeze({ ok: false as const, error: Object.freeze({ reason: a.providerReason, detail: "" }) });
    return Object.freeze({ ok: false as const, error: Object.freeze({ reason: "timeout", detail: "" }) });
  };

  return Object.freeze({
    identity,
    complete,
    unconsumed: (): number => recorded.length - cursor,
    answered: (): number => answered,
  });
}
