// Mock_Provider (task 3.2; R3.2 to R3.6, R3.10 to R3.14, R19.10).
// Serves hand-written static fixtures. It reads no clock, no random source, no file, no process state and no network, keeps no state
// between calls, and imports nothing outside this package (no `evaluation/`). It needs no credential.
import { checkRequestHash, isSha256Hex } from "../hash.js";
import { REQUEST_KINDS } from "../types.js";
import type {
  AiProvider,
  AuditedRequest,
  CompleteOptions,
  ProviderError,
  ProviderIdentity,
  RequestKind,
  Result,
  Sha256,
} from "../types.js";

/**
 * A canned response. With `matchRequestSha256` it answers only the request with exactly that hash (and kind); without it, it answers
 * every request of its kind that no hash-specific fixture answers. The response bytes are returned as they are.
 */
export interface MockFixture {
  readonly requestKind: RequestKind;
  readonly matchRequestSha256?: Sha256;
  readonly response: Uint8Array;
}

/** Recorded in the Evidence_Store and the Run_Manifest (R3.7, R3.14). The provider has no model. */
export const MOCK_PROVIDER_IDENTITY: ProviderIdentity = Object.freeze({ id: "mock", version: "1", model: "not_applicable" });

const fail = (reason: Exclude<ProviderError["reason"], "audit_violation">, detail: string): Result<Uint8Array, ProviderError> => ({
  ok: false,
  error: { reason, detail },
});

const isRequestKind = (v: unknown): v is RequestKind => (REQUEST_KINDS as readonly unknown[]).includes(v);

export class MockProvider implements AiProvider {
  readonly identity: ProviderIdentity = MOCK_PROVIDER_IDENTITY;
  readonly #byKindAndHash = new Map<string, Uint8Array>();
  readonly #byKind = new Map<RequestKind, Uint8Array>();

  /**
   * Throws `TypeError` for an invalid fixture (unknown kind, malformed hash, response that is not a Uint8Array) and for two fixtures
   * with the same kind and the same match key: a fixture table with an ambiguous answer is a configuration error, not a choice.
   * The response bytes are copied, so a later change of the caller's array does not change the answer.
   */
  constructor(fixtures: readonly MockFixture[]) {
    for (const f of fixtures) {
      if (!isRequestKind(f.requestKind)) throw new TypeError("mock fixture: unknown request kind");
      if (!(f.response instanceof Uint8Array)) throw new TypeError("mock fixture: response must be a Uint8Array");
      const copy = f.response.slice();
      if (f.matchRequestSha256 === undefined) {
        if (this.#byKind.has(f.requestKind)) throw new TypeError(`mock fixture: duplicate fixture for kind ${f.requestKind}`);
        this.#byKind.set(f.requestKind, copy);
      } else {
        if (!isSha256Hex(f.matchRequestSha256)) throw new TypeError("mock fixture: matchRequestSha256 is not a lowercase SHA-256 hex");
        const key = `${f.requestKind}:${f.matchRequestSha256}`;
        if (this.#byKindAndHash.has(key)) throw new TypeError(`mock fixture: duplicate fixture for ${key}`);
        this.#byKindAndHash.set(key, copy);
      }
    }
  }

  /**
   * Order of checks (each failure returns an error and no response body):
   * 1. `signal` already aborted: `error` (detail `aborted`). The provider performs no work after an abort. The caller knows why it aborted
   *    (Run deadline or forced stop) and records that cause itself; the provider does not turn an abort into `timeout`.
   * 2. `timeoutMs` is not a finite number above 0: `error`. The Mock_Provider serves from memory without waiting, so a valid positive limit
   *    cannot be exceeded and `timeout` is never returned.
   * 3. `sha256(bytes)` differs from `sha256` of the request: `error` (R2.3, `checkRequestHash`).
   * 4. The kind is not one of the three request kinds: `error`.
   * 5. No fixture answers the request: `unmatched_request`. The Mock_Provider never fabricates a response (R3.12).
   * The answer depends only on the request kind and the request bytes (R3.3). It returns a fresh copy of the fixture bytes.
   */
  async complete(req: AuditedRequest, opts: CompleteOptions): Promise<Result<Uint8Array, ProviderError>> {
    if (opts.signal.aborted) return fail("error", "aborted");
    if (typeof opts.timeoutMs !== "number" || !Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
      return fail("error", "timeoutMs must be a finite number above 0");
    }
    const hash = checkRequestHash(req);
    if (!hash.ok) return { ok: false, error: hash.error };
    if (!isRequestKind(req.kind)) return fail("error", "unknown request kind");
    const response = this.#byKindAndHash.get(`${req.kind}:${req.sha256}`) ?? this.#byKind.get(req.kind);
    if (response === undefined) {
      return fail("unmatched_request", `no canned response for kind ${req.kind} and request sha256 ${req.sha256}`);
    }
    return { ok: true, value: response.slice() };
  }
}
