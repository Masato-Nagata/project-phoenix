// SHA-256 helpers (pure, deterministic). `node:crypto` is the only Node.js module the package source may import.
import { createHash } from "node:crypto";
import type { AuditedRequest, ProviderError, Result, Sha256 } from "./types.js";

const SHA256_HEX = /^[0-9a-f]{64}$/;

export function sha256Hex(data: Uint8Array | string): Sha256 {
  return createHash("sha256").update(data).digest("hex");
}

export function isSha256Hex(value: unknown): value is Sha256 {
  return typeof value === "string" && SHA256_HEX.test(value);
}

/** R2.3: a provider recomputes the hash of the bytes it is about to transmit or match, and fails if it differs from the audited hash. */
export function checkRequestHash(req: Pick<AuditedRequest, "bytes" | "sha256">): Result<void, ProviderError> {
  const actual = sha256Hex(req.bytes);
  if (actual !== req.sha256) {
    return { ok: false, error: { reason: "error", detail: "request bytes do not match the audited sha256" } };
  }
  return { ok: true, value: undefined };
}
