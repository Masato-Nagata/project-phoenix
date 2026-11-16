// Loading of the audit configuration (design "Audit configuration"; R2.9, R2.12). This package has no file access: the host reader
// gives the bytes (or `undefined` when the file is missing). Nothing here writes a canary, decoy or fingerprint value anywhere; the
// `detail` of a failure is a field name or a fixed code.
import { sha256Hex } from "../hash.js";
import { strictJsonParse } from "../json/strictJsonParse.js";
import { TOKENIZER_ID } from "../tokenizer.js";
import type { Json } from "../types.js";
import type { AuditConfig, AuditConfigLoadResult, AuditFingerprintSet, AuditSecretEntry } from "./types.js";

const MAX_CONFIG_BYTES = 64 * 1024 * 1024;
const HASH12 = /^[0-9a-f]{12}$/;

const isObj = (v: unknown): v is { [k: string]: Json } => typeof v === "object" && v !== null && !Array.isArray(v);
const hasExactKeys = (o: { [k: string]: Json }, keys: readonly string[]): boolean =>
  Object.keys(o).length === keys.length && keys.every((k) => Object.hasOwn(o, k));
const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function secretList(v: Json | undefined, field: string): AuditSecretEntry[] | string {
  if (!Array.isArray(v) || v.length < 1) return field;
  const out: AuditSecretEntry[] = [];
  const ids = new Set<string>();
  for (const e of v) {
    if (!isObj(e) || !hasExactKeys(e, ["id", "value"])) return field;
    const { id, value } = e;
    if (!isNonEmptyString(id) || typeof value !== "string" || value.length < 8 || ids.has(id)) return field;
    ids.add(id);
    out.push({ id, value });
  }
  return out;
}

/** Strict validation of the configuration bytes. `undefined` means the file is missing, an empty array means empty. */
export function parseAuditConfig(bytes: Uint8Array | undefined): AuditConfigLoadResult {
  if (bytes === undefined) return { ok: false, reason: "missing" };
  if (bytes.byteLength === 0) return { ok: false, reason: "empty" };
  const parsed = strictJsonParse(bytes, { maxDepth: 8, maxBytes: MAX_CONFIG_BYTES });
  if (!parsed.ok) return { ok: false, reason: "invalid", detail: parsed.error.code };
  const root = parsed.value;
  const bad = (field: string): AuditConfigLoadResult => ({ ok: false, reason: "invalid", detail: field });
  if (!isObj(root) || !hasExactKeys(root, ["schemaVersion", "allowlist", "canaries", "decoys", "fingerprints", "restrictedPathPrefixes", "tokenizer"])) {
    return bad("fields");
  }
  if (root["schemaVersion"] !== 1) return bad("schemaVersion");
  if (root["tokenizer"] !== TOKENIZER_ID) return bad("tokenizer");
  const allow = root["allowlist"];
  if (!Array.isArray(allow) || allow.length < 1 || !allow.every(isNonEmptyString)) return bad("allowlist");
  const canaries = secretList(root["canaries"], "canaries");
  if (typeof canaries === "string") return bad(canaries);
  const decoys = secretList(root["decoys"], "decoys");
  if (typeof decoys === "string") return bad(decoys);
  const fps = root["fingerprints"];
  if (!Array.isArray(fps) || fps.length < 4) return bad("fingerprints");
  const fingerprints: AuditFingerprintSet[] = [];
  const fpIds = new Set<string>();
  for (const e of fps) {
    if (!isObj(e) || !hasExactKeys(e, ["id", "fileId", "n", "hashes"])) return bad("fingerprints");
    const { id, fileId, n, hashes } = e;
    if (!isNonEmptyString(id) || fpIds.has(id) || !isNonEmptyString(fileId)) return bad("fingerprints");
    if (typeof n !== "number" || !Number.isInteger(n) || n < 6) return bad("fingerprints");
    if (!Array.isArray(hashes) || hashes.length < 1 || !hashes.every((h) => typeof h === "string" && HASH12.test(h))) return bad("fingerprints");
    fpIds.add(id);
    fingerprints.push({ id, fileId, n, hashes: hashes as string[] });
  }
  const prefixes = root["restrictedPathPrefixes"];
  if (!Array.isArray(prefixes) || !prefixes.every(isNonEmptyString)) return bad("restrictedPathPrefixes");
  const config: AuditConfig = {
    schemaVersion: 1,
    allowlist: allow as string[],
    canaries,
    decoys,
    fingerprints,
    restrictedPathPrefixes: prefixes as string[],
    tokenizer: TOKENIZER_ID,
  };
  return { ok: true, config, sha256: sha256Hex(bytes) };
}