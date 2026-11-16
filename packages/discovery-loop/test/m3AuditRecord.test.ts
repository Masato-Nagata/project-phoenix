// Task 3.12 evidence: the audit result is a complete value that the real record store accepts as a `payload_audit` record, the store refuses a record that holds a
// secret, and a failed write is reported as a failure that the caller must act on (R2.2, R12.14, R11.15). The ORDER "record the audit result, then call the provider" is
// done by the Loop_Orchestrator (M4); this file does not test an orchestrator, it shows what the orchestrator will be given. Synthetic data only.
import { describe, expect, it } from "vitest";
import { auditPayload } from "../../ai-client/src/index.js";
import type { AuditResult, Json } from "../../ai-client/src/index.js";
import { CANARY_VALUE, SECRET_VALUE } from "../../ai-client/test/helpers/auditFixtures.js";
import { build } from "../../ai-client/test/helpers/propertyWorld.js";
import { MemoryFileSystem, RunRecordStore } from "../src/index.js";

const DIR = "/run/out";
const dec = (b: Uint8Array | undefined): string => new TextDecoder().decode(b);
const KIND = "hypothesis_generation" as const;
const audit = (content: unknown): AuditResult => {
  const b = build({ kind: KIND, sources: [{ path: "legacy/src/utils.php", text: "<?php\n// fictional\n" }], stored: [{ type: "hypothesis_revision", content: content as never }] });
  return auditPayload(b.bytes(), KIND, b.cfg, b.ctx).audit;
};
/** What the orchestrator records for an audit: identifiers, outcomes and the hash. The bytes themselves are a blob, kept only when the audit allows it (R2.2 exception). */
const recordOf = (a: AuditResult): Json => ({
  requestKind: KIND, result: a.result, payloadSha256: a.payloadSha256, bytesWithheld: a.bytesWithheld,
  checks: a.checks.map((c) => ({ id: c.id, outcome: c.outcome, ...(c.detail === undefined ? {} : { detail: c.detail }) })),
  matches: a.matches.map((m) => ({ checkId: m.checkId, matchId: m.matchId })),
});
async function openStore(secrets: { envValues?: { name: string; value: string }[] } = {}, fs = new MemoryFileSystem()) {
  fs.addDir(DIR);
  const r = await RunRecordStore.open(fs, DIR, { secrets });
  if (!r.ok) throw new Error("open failed");
  return { store: r.value, fs };
}

describe("the audit result can be recorded as it is returned (R2.2)", () => {
  it("a pass and each kind of block become payload_audit records with the nine checks and the hash", async () => {
    const { store, fs } = await openStore();
    const results = [audit({ note: "fictional" }), audit({ note: CANARY_VALUE }), audit({ note: SECRET_VALUE })];
    expect(results.map((r) => r.result)).toEqual(["pass", "blocked", "blocked"]);
    for (const a of results) expect((await store.append("payload_audit", recordOf(a) as never)).ok).toBe(true);
    const text = dec(fs.peek(`${DIR}/records.jsonl`));
    const rows = text.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(3);
    for (const [i, row] of rows.entries()) {
      expect(row.kind).toBe("payload_audit");
      expect(row.payload.checks).toHaveLength(9);
      expect(row.payload.payloadSha256).toBe((results[i] as AuditResult).payloadSha256);
    }
    // what was found is named by identifier only
    expect(text.includes(CANARY_VALUE) || text.includes(SECRET_VALUE)).toBe(false);
    expect(rows[1].payload.matches.map((m: { matchId: string }) => m.matchId)).toContain("canary-1");
  });

  it("the store refuses a record that holds a configured secret, so a result with a secret in it could not be written", async () => {
    const { store, fs } = await openStore({ envValues: [{ name: "FICTIONAL_API_KEY", value: SECRET_VALUE }] });
    const leaky = { ...(recordOf(audit({ note: "fictional" })) as object), note: SECRET_VALUE } as never;
    const r = await store.append("payload_audit", leaky);
    expect(r.ok).toBe(false);
    expect(dec(fs.peek(`${DIR}/records.jsonl`)).includes(SECRET_VALUE)).toBe(false);
    expect((await store.append("payload_audit", recordOf(audit({ note: "fictional" })) as never)).ok).toBe(true); // a clean record is still written
  });
});

describe("a record that cannot be written is a failure that the caller receives (R12.14, R11.15)", () => {
  it("a failed write returns an error result, leaves no partial record, and the store then refuses further records", async () => {
    const mem = new MemoryFileSystem();
    let armed = false;
    const port = new Proxy(mem, {
      get(target, prop) {
        if (prop === "writeFileSynced" && armed) return () => Promise.reject(new Error("disk full"));
        const v = (target as never as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const { store } = await openStore({}, port as MemoryFileSystem);
    expect((await store.append("payload_audit", recordOf(audit({ note: "fictional" })) as never)).ok).toBe(true);
    const before = dec(mem.peek(`${DIR}/records.jsonl`));
    armed = true;
    const failed = await store.append("payload_audit", recordOf(audit({ note: "fictional" })) as never);
    expect(failed.ok).toBe(false);
    expect(dec(mem.peek(`${DIR}/records.jsonl`))).toBe(before); // the old file, no partial record
    armed = false;
    expect((await store.append("payload_audit", recordOf(audit({ note: "fictional" })) as never)).ok, "the store went on after a failed write").toBe(false);
  });
});