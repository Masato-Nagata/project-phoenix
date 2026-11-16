// Common verification wrapper of every provider that `createProvider` returns (task 3.4; R2.1, R2.3, R3.8).
// It does not depend on what an individual provider checks. Before the wrapped provider runs, it:
//   1. refuses a request that this package's Payload_Auditor did not create (`not_audited`), even if the hash is right;
//   2. refuses a request that was used before (`already_used`);
//   3. marks the request used, synchronously, before the first `await`, whatever follows (an aborted signal, a time-out, a provider error);
//   4. recomputes the SHA-256 of the held audited bytes and compares it with the audited hash (`hash_mismatch`, `state_inconsistent`).
// On any refusal the wrapped provider is not called and the result is an `audit_violation` error. A retry therefore needs a new audit (R3.8).
import { consumeForSend } from "./internal/auditedRegistry.js";
import type { AiProvider, AuditViolationCode, CompleteOptions, ProviderError, Result } from "./types.js";

const DETAIL: Readonly<Record<AuditViolationCode, string>> = Object.freeze({
  not_audited: "request was not created by the Payload_Auditor of this package",
  already_used: "audited request was already used",
  hash_mismatch: "held audited bytes do not match the audited sha256",
  state_inconsistent: "request fields do not match the audited state",
});

const failure = (reason: "error" | "undeterminable", detail: string): Result<Uint8Array, ProviderError> => ({
  ok: false,
  error: { reason, detail },
});

const guarded = new WeakSet<object>();

/** Idempotent: a provider that is already guarded is returned as it is, so a request is never consumed twice by two wrappers. */
export function guardProvider(inner: AiProvider): AiProvider {
  if (guarded.has(inner)) return inner;
  const wrapper: AiProvider = Object.freeze({
    identity: inner.identity,
    // Not an `async` function on purpose: the check and the consumption are plain synchronous code at the top.
    complete(req: Parameters<AiProvider["complete"]>[0], opts: CompleteOptions): Promise<Result<Uint8Array, ProviderError>> {
      const c = consumeForSend(req);
      if (!c.ok) {
        return Promise.resolve({
          ok: false,
          error: { reason: "audit_violation", detail: DETAIL[c.violation.code], violation: c.violation },
        });
      }
      let pending: Promise<Result<Uint8Array, ProviderError>>;
      try {
        pending = Promise.resolve(inner.complete(req, opts));
      } catch {
        // No exception text is passed on: it could contain payload content.
        return Promise.resolve(failure("error", "provider raised an exception"));
      }
      return pending.then(
        (r) => {
          const ok = typeof r === "object" && r !== null && (r.ok === false || (r.ok === true && r.value instanceof Uint8Array));
          return ok ? r : failure("undeterminable", "provider returned a malformed result");
        },
        () => failure("error", "provider rejected"),
      );
    },
  });
  guarded.add(wrapper);
  return wrapper;
}