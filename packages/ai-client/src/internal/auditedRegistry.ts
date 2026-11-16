// Runtime registry of audited requests (task 3.4; R2.1, R2.3, R3.8).
//
// The type brand of `AuditedRequest` proves nothing at runtime. This module is what does: an `AuditedRequest` is valid only if the object
// is a key of the module-private WeakMap below, and the WeakMap is written only by `mintAuditedRequest`, which only the Payload_Auditor
// calls. Consequences:
// - a cast, an object spread, `Object.create(audited)`, `structuredClone`, or a request made by another copy of this package (another module
//   instance has its own WeakMap) is not in the map, so it is refused with `not_audited`, even when its hash is right;
// - the audited bytes are a private copy held in the state; the object only offers a getter that returns a fresh copy, so no caller can
//   change the audited bytes, and the object is frozen;
// - a request is single use: `consumeForSend` marks it used before anything else, synchronously.
// This module is not exported from the package entry, and the package `exports` map blocks deep imports.
import { isSha256Hex, sha256Hex } from "../hash.js";
import { REQUEST_KINDS } from "../types.js";
import type { AuditViolation, AuditedRequest, RequestKind, Sha256 } from "../types.js";

interface AuditedState {
  readonly kind: RequestKind;
  readonly bytes: Uint8Array;
  readonly sha256: Sha256;
  consumed: boolean;
}

const registry = new WeakMap<object, AuditedState>();

/** Only the Payload_Auditor calls this, after a `pass` result. `snapshot` is copied again, so the caller keeps no handle on the held bytes. */
export function mintAuditedRequest(kind: RequestKind, snapshot: Uint8Array, sha256: Sha256): AuditedRequest {
  const state: AuditedState = { kind, bytes: new Uint8Array(snapshot), sha256, consumed: false };
  const req = Object.freeze({
    kind,
    sha256,
    get bytes(): Uint8Array {
      return new Uint8Array(state.bytes);
    },
  });
  registry.set(req, state);
  return req as unknown as AuditedRequest;
}

export type Consumption = { readonly ok: true } | { readonly ok: false; readonly violation: AuditViolation };

/** Reads fields of an object that may be hostile (a getter can throw or return anything). Only well-formed values are kept. */
function claimedFields(req: unknown): Pick<AuditViolation, "requestKind" | "claimedSha256"> {
  const out: { requestKind?: RequestKind; claimedSha256?: Sha256 } = {};
  try {
    if (typeof req !== "object" || req === null) return out;
    const kind: unknown = (req as { kind?: unknown }).kind;
    const sha: unknown = (req as { sha256?: unknown }).sha256;
    if ((REQUEST_KINDS as readonly unknown[]).includes(kind)) out.requestKind = kind as RequestKind;
    if (isSha256Hex(sha)) out.claimedSha256 = sha;
  } catch {
    // a getter that throws gives no claimed fields
  }
  return out;
}

/**
 * The single check before a call. It is synchronous and runs before the first `await` of the caller, so two concurrent calls with one request
 * cannot both pass. Order: known? used? mark used (always, from here on), hash of the held bytes equals the audited hash? public fields equal
 * the audited state? A request that is refused after the mark stays used. A request that is not known cannot be marked; it is refused.
 */
export function consumeForSend(req: unknown): Consumption {
  const claimed = claimedFields(req);
  const state = typeof req === "object" && req !== null ? registry.get(req) : undefined;
  if (state === undefined) return { ok: false, violation: { code: "not_audited", ...claimed } };
  const audited = { requestKind: state.kind, auditedSha256: state.sha256 };
  if (state.consumed) return { ok: false, violation: { code: "already_used", ...claimed, ...audited } };
  state.consumed = true;
  const recomputed = sha256Hex(state.bytes);
  if (recomputed !== state.sha256) {
    return { ok: false, violation: { code: "hash_mismatch", ...claimed, ...audited, recomputedSha256: recomputed } };
  }
  if (claimed.requestKind !== state.kind || claimed.claimedSha256 !== state.sha256) {
    return { ok: false, violation: { code: "state_inconsistent", ...claimed, ...audited } };
  }
  return { ok: true };
}