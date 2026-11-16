// Test-only world for the Payload_Auditor: a fictional Source_Bundle, records, templates, secrets and audit configuration.
// Nothing here is derived from `evaluation/` or from the Legacy_App; every value is invented for the tests.
import { TOKENIZER_ID, canonicalJson, ngramHashes, parseAuditConfig, sha256Hex, tokenize } from "../../src/index.js";
import type { AuditConfigLoadResult, AuditContext, Json, RequestKind } from "../../src/index.js";

export const CANARY_VALUE = "ZZCANARY-4f9a1c07e2b8";
export const DECOY_VALUE = "ZZDECOY-91d3a5c6f0e7";
export const SECRET_NAME = "FICTIONAL_API_KEY";
export const SECRET_VALUE = "sk-fictional-0123456789abcdef";
export const FP_N = 6;
/** Four invented "restricted files"; their 6-gram fingerprints are what the auditor must find. */
export const RESTRICTED_TEXTS = [
  "restricted alpha record one says hotel india juliet kilo lima mike november oscar papa",
  "restricted beta record two says quebec romeo sierra tango uniform victor whiskey xray yankee",
  "restricted gamma record three says zulu amber bronze cobalt dahlia ember fennel garnet heather",
  "restricted delta record four says indigo jasper krypton lantern marble nectar onyx pewter quartz",
];
export const RESTRICTED_PREFIX = "fictional-restricted-area/";

export const ALLOWLIST = [
  "legacy/src/index.php", "legacy/src/db.php", "legacy/src/products.php", "legacy/src/orders.php",
  "legacy/src/utils.php", "legacy/sql/schema.sql", "legacy/sql/seed.sql",
];
export const SOURCE_A = { path: "legacy/src/utils.php", text: "<?php\n// fictional helper A\n" };
export const SOURCE_B = { path: "legacy/src/db.php", text: "<?php\n// fictional helper B\n" };
export const TEMPLATE_ID = "revise-v1";
export const TEMPLATE_SHA = sha256Hex("fixed instruction text of the tests");
export const RECORD_ID = "rec-000007";

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
export const dec = (b: Uint8Array): string => new TextDecoder().decode(b);

export function configBytes(over: Record<string, unknown> = {}): Uint8Array {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    allowlist: ALLOWLIST,
    canaries: [{ id: "canary-1", value: CANARY_VALUE }],
    decoys: [{ id: "decoy-1", value: DECOY_VALUE }],
    fingerprints: RESTRICTED_TEXTS.map((t, i) => ({
      id: `fp-${i + 1}`,
      fileId: `restricted-file-${i + 1}`,
      n: FP_N,
      hashes: [...ngramHashes(tokenize(t), FP_N)].sort(),
    })),
    restrictedPathPrefixes: [RESTRICTED_PREFIX],
    tokenizer: TOKENIZER_ID,
    ...over,
  };
  return enc(canonicalJson(base as Json));
}

export interface World {
  cfg: AuditConfigLoadResult;
  ctx: AuditContext;
  records: Map<string, { kind: string; sha256: string; canonicalJson: string }>;
  /** A valid envelope for `kind` (a fresh deep copy on every call). */
  envelope(kind?: RequestKind): { [k: string]: any };
  bytes(env: unknown): Uint8Array;
}

export function makeWorld(
  o: {
    sources?: { path: string; text: string }[];
    storedContent?: Json;
    cfg?: AuditConfigLoadResult;
    secrets?: { name: string; value: string }[];
  } = {},
): World {
  const sources = o.sources ?? [SOURCE_A, SOURCE_B];
  const storedContent: Json = o.storedContent ?? { summary: "fictional revision text" };
  const canon = canonicalJson(storedContent);
  const records = new Map([[RECORD_ID, { kind: "hypothesis_revision", sha256: sha256Hex(canon), canonicalJson: canon }]]);
  const ctx: AuditContext = {
    bundle: { manifest: sources.map((s) => ({ path: s.path, sha256Lf: sha256Hex(s.text) })) },
    allowlist: ALLOWLIST,
    lookupRecord: (id) => records.get(id),
    instructionTemplates: new Map([[TEMPLATE_ID, TEMPLATE_SHA]]),
    secretValues: o.secrets ?? [{ name: SECRET_NAME, value: SECRET_VALUE }],
  };
  const cfg = o.cfg ?? parseAuditConfig(configBytes());
  return {
    cfg,
    ctx,
    records,
    envelope: (kind: RequestKind = "hypothesis_revision") => ({
      schemaVersion: 1,
      kind,
      instruction: { templateId: TEMPLATE_ID, sha256: TEMPLATE_SHA },
      parts: [
        ...sources.map((s, i) => ({ partId: `p${i + 1}`, type: "source_file", path: s.path, sha256Lf: sha256Hex(s.text), text: s.text })),
        { partId: "p9", type: "hypothesis_revision", recordId: RECORD_ID, recordSha256: sha256Hex(canon), content: structuredClone(storedContent) },
      ],
    }),
    bytes: (env: unknown) => enc(canonicalJson(env as Json)),
  };
}