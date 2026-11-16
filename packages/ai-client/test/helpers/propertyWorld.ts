// Builder of synthetic payloads for the property tests of the Payload_Auditor (properties 19 and 20).
// Everything is invented for the tests: no value comes from `evaluation/`, the Legacy_App or a credential store.
import { canonicalJson, parseAuditConfig, sha256Hex } from "../../src/index.js";
import type { AuditConfigLoadResult, AuditContext, Json, RequestKind, StoredPartType } from "../../src/index.js";
import { ALLOWLIST, SECRET_NAME, SECRET_VALUE, TEMPLATE_ID, TEMPLATE_SHA, configBytes, enc } from "./auditFixtures.js";

export interface PayloadSpec {
  kind: RequestKind;
  /** In bundle order. */
  sources: { path: string; text: string }[];
  stored: { type: StoredPartType; content: Json }[];
}
export type Env = { [k: string]: any };
export interface Built {
  cfg: AuditConfigLoadResult;
  ctx: AuditContext;
  records: Map<string, { kind: string; sha256: string; canonicalJson: string }>;
  env: Env;
  bytes(): Uint8Array;
}

/** A consistent world for `spec`: the manifest and the records are built from the spec, so a spec on its own violates nothing. */
export function build(spec: PayloadSpec, cfg: AuditConfigLoadResult = parseAuditConfig(configBytes())): Built {
  const records = new Map<string, { kind: string; sha256: string; canonicalJson: string }>();
  const storedParts = spec.stored.map((s, i) => {
    const canon = canonicalJson(s.content);
    const id = `rec-${100000 + i}`;
    records.set(id, { kind: s.type, sha256: sha256Hex(canon), canonicalJson: canon });
    return { partId: `s${i + 1}`, type: s.type, recordId: id, recordSha256: sha256Hex(canon), content: structuredClone(s.content) };
  });
  const env: Env = {
    schemaVersion: 1,
    kind: spec.kind,
    instruction: { templateId: TEMPLATE_ID, sha256: TEMPLATE_SHA },
    parts: [
      ...spec.sources.map((s, i) => ({ partId: `p${i + 1}`, type: "source_file", path: s.path, sha256Lf: sha256Hex(s.text), text: s.text })),
      ...storedParts,
    ],
  };
  const ctx: AuditContext = {
    bundle: { manifest: spec.sources.map((s) => ({ path: s.path, sha256Lf: sha256Hex(s.text) })) },
    allowlist: ALLOWLIST,
    lookupRecord: (id) => records.get(id),
    instructionTemplates: new Map([[TEMPLATE_ID, TEMPLATE_SHA]]),
    secretValues: [{ name: SECRET_NAME, value: SECRET_VALUE }],
  };
  return { cfg, ctx, records, env, bytes: () => enc(canonicalJson(env as Json)) };
}