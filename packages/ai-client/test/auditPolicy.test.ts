// Decisions of the acceptance of task 3.4: release of the audited bytes, limits, allowlist intersection, record kind.
// Every audited request and result comes from the real `auditPayload`.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AUDIT_CHECK_IDS, AUDIT_LIMITS_CEILING, DEFAULT_AUDIT_LIMITS, auditPayload, canonicalJson, effectiveAuditLimits, parseAuditConfig, sha256Hex,
} from "../src/index.js";
import type { AuditCheckId, AuditConfigLoadResult, AuditContext, AuditResult, Json, RequestKind } from "../src/index.js";
import {
  ALLOWLIST, CANARY_VALUE, RECORD_ID, RESTRICTED_PREFIX, RESTRICTED_TEXTS, SECRET_VALUE, SOURCE_A, SOURCE_B, configBytes, enc, makeWorld,
} from "./helpers/auditFixtures.js";

type World = ReturnType<typeof makeWorld>;
const KIND: RequestKind = "hypothesis_revision";
const audit = (w: World, bytes: Uint8Array, ctx: AuditContext = w.ctx, cfg: AuditConfigLoadResult = w.cfg) => auditPayload(bytes, KIND, cfg, ctx);
const outcome = (a: AuditResult, id: AuditCheckId): string => a.checks.find((c) => c.id === id)?.outcome ?? "missing";
const detail = (a: AuditResult, id: AuditCheckId): string | undefined => a.checks.find((c) => c.id === id)?.detail;
const SENSITIVE: AuditCheckId[] = ["A05", "A06", "A07", "A08"];
const sensitiveClear = (a: AuditResult): boolean => SENSITIVE.every((id) => outcome(a, id) === "pass");
const sameBytes = (a: Uint8Array | undefined, b: Uint8Array): boolean => a !== undefined && Buffer.from(a).equals(Buffer.from(b));

// ---------------------------------------------------------------------------------------------
describe("release of the audited bytes (R2.2 yields to R2.12 and R19.2)", () => {
  it("returns the bytes for a pass", () => {
    const w = makeWorld();
    const bytes = w.bytes(w.envelope());
    const { audit: a } = audit(w, bytes);
    expect(a.result).toBe("pass");
    expect(sameBytes(a.auditedBytes, bytes)).toBe(true);
    expect(a.bytesWithheld).toBe(false);
  });

  it("returns the bytes for a blocked result caused by other checks, when A05 to A08 all pass", () => {
    const w = makeWorld();
    const mk = (f: (e: { [k: string]: any }) => void): Uint8Array => {
      const e = w.envelope();
      f(e);
      return w.bytes(e);
    };
    const cases: [AuditCheckId, Uint8Array][] = [
      ["A03", mk((e) => (e.instruction.templateId = "other-v1"))],
      ["A03", mk((e) => (e.parts[2].recordId = "rec-999999"))],
      ["A04", mk((e) => (e.parts[0].text = "<?php\n// altered\n"))],
      ["A04", mk((e) => e.parts.splice(1, 1))],
    ];
    for (const [failedId, bytes] of cases) {
      const { audit: a, request } = audit(w, bytes);
      expect(a.result).toBe("blocked");
      expect(request).toBeUndefined();
      expect(outcome(a, failedId)).toBe("fail");
      expect(sensitiveClear(a)).toBe(true);
      expect(a.bytesWithheld).toBe(false);
      expect(sameBytes(a.auditedBytes, bytes)).toBe(true);
    }
  });

  it("withholds the bytes when any one of A05, A06, A07 or A08 failed", () => {
    const text = "<?php\n// fictional other file\n";
    const worlds: [AuditCheckId, World][] = [
      ["A05", makeWorld({ sources: [{ path: "legacy/src/other.php", text }] })],
      ["A06", makeWorld({ storedContent: { n: CANARY_VALUE } })],
      ["A07", makeWorld({ storedContent: { n: RESTRICTED_TEXTS[2] as string } })],
      ["A08", makeWorld({ storedContent: { n: SECRET_VALUE } })],
    ];
    for (const [id, w] of worlds) {
      const bytes = w.bytes(w.envelope());
      const { audit: a } = audit(w, bytes);
      expect(outcome(a, id)).toBe("fail");
      expect(a.result).toBe("blocked");
      expect(a.bytesWithheld, id).toBe(true);
      expect(a.auditedBytes, id).toBeUndefined();
      expect(a.payloadSha256).toBe(sha256Hex(bytes)); // the hash is kept
      expect(JSON.stringify(a)).not.toContain(CANARY_VALUE);
    }
  });

  it("withholds the bytes when any of A05 to A08 did not run (fail closed)", () => {
    const w = makeWorld();
    const good = w.bytes(w.envelope());
    const shared = new Uint8Array(new SharedArrayBuffer(good.length));
    shared.set(good);
    const notRun: [string, AuditResult][] = [
      ["no config", audit(w, good, w.ctx, parseAuditConfig(undefined)).audit],
      ["invalid config", audit(w, good, w.ctx, parseAuditConfig(enc("{}"))).audit],
      ["unreadable config", audit(w, good, w.ctx, { ok: false, reason: "unreadable" }).audit],
      ["no valid envelope (A02 failed)", audit(w, enc(JSON.stringify(w.envelope(), null, 1))).audit],
      ["shared memory", audit(w, shared).audit],
      ["too large", audit(w, good, { ...w.ctx, limits: { maxBytes: 10, maxDepth: 32 } }).audit],
      ["not bytes", audit(w, "text" as never).audit],
    ];
    for (const [name, a] of notRun) {
      expect(a.result, name).toBe("blocked");
      expect(SENSITIVE.some((id) => outcome(a, id) === "not_run"), name).toBe(true);
      expect(a.bytesWithheld, name).toBe(true);
      expect(a.auditedBytes, name).toBeUndefined();
      expect(a.payloadSha256, name).toMatch(/^[0-9a-f]{64}$/);
      expect(a.checks.map((c) => c.id), name).toEqual([...AUDIT_CHECK_IDS]);
    }
  });

  it("holds for any combination of faults: bytes are returned if and only if A05 to A08 all passed", () => {
    const w = makeWorld();
    const base = w.envelope();
    const faults: ((e: { [k: string]: any }) => void)[] = [
      (e) => (e.parts[0].text = "<?php\n// altered\n"),
      (e) => (e.parts[2].recordId = "rec-999999"),
      (e) => (e.instruction.templateId = "other-v1"),
      (e) => (e.parts[2].content = { n: CANARY_VALUE }),
      (e) => (e.parts[2].content = { n: RESTRICTED_TEXTS[1] }),
      (e) => (e.parts[2].content = { n: SECRET_VALUE }),
      (e) => (e.parts[2].content = { n: `${RESTRICTED_PREFIX}x` }),
      (e) => (e.parts[1].path = "legacy/src/other.php"),
      (e) => (e.extra = 1),
    ];
    fc.assert(
      fc.property(fc.subarray(faults), fc.constantFrom("ok", "missing", "invalid"), (chosen, cfgKind) => {
        const env = structuredClone(base);
        for (const f of chosen) f(env);
        const cfg = cfgKind === "ok" ? w.cfg : cfgKind === "missing" ? parseAuditConfig(undefined) : parseAuditConfig(enc("{}"));
        const bytes = w.bytes(env as Json);
        const { audit: a, request } = auditPayload(bytes, KIND, cfg, w.ctx);
        expect(a.checks).toHaveLength(9);
        expect(a.payloadSha256).toBe(sha256Hex(bytes));
        expect(a.bytesWithheld).toBe(!sensitiveClear(a));
        expect(a.auditedBytes === undefined).toBe(!sensitiveClear(a));
        if (a.auditedBytes !== undefined) expect(sameBytes(a.auditedBytes, bytes)).toBe(true);
        expect(request !== undefined).toBe(a.result === "pass");
        if (a.result === "pass") expect(sensitiveClear(a)).toBe(true);
      }),
      { seed: 34_004, numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------------------------
describe("payload size and depth limits", () => {
  it("has the approved defaults and a ceiling that equals them", () => {
    expect(DEFAULT_AUDIT_LIMITS).toEqual({ maxBytes: 4 * 1024 * 1024, maxDepth: 32 });
    expect(AUDIT_LIMITS_CEILING).toEqual(DEFAULT_AUDIT_LIMITS);
  });

  it("lets a context tighten a limit, never raise it, and ignores anything that is not a positive safe integer", () => {
    const d = DEFAULT_AUDIT_LIMITS;
    expect(effectiveAuditLimits(undefined)).toEqual(d);
    expect(effectiveAuditLimits({ maxBytes: 100, maxDepth: 5 })).toEqual({ maxBytes: 100, maxDepth: 5 });
    expect(effectiveAuditLimits({ maxBytes: 1, maxDepth: 1 })).toEqual({ maxBytes: 1, maxDepth: 1 });
    expect(effectiveAuditLimits({ maxBytes: d.maxBytes + 1, maxDepth: d.maxDepth + 1 })).toEqual(d);
    expect(effectiveAuditLimits({ maxBytes: Number.MAX_SAFE_INTEGER, maxDepth: 10_000 })).toEqual(d);
    for (const bad of [Number.NaN, Infinity, -Infinity, 0, -1, 1.5, "9" as never, null as never, undefined as never, 2 ** 60]) {
      expect(effectiveAuditLimits({ maxBytes: bad, maxDepth: bad }), String(bad)).toEqual(d);
    }
  });

  it("accepts a payload of exactly maxBytes and blocks one byte more, with nothing scanned", () => {
    const w = makeWorld();
    const bytes = w.bytes(w.envelope());
    const at = audit(w, bytes, { ...w.ctx, limits: { maxBytes: bytes.length, maxDepth: 32 } }).audit;
    expect(at.result).toBe("pass");
    const over = audit(w, bytes, { ...w.ctx, limits: { maxBytes: bytes.length - 1, maxDepth: 32 } }).audit;
    expect(over.result).toBe("blocked");
    expect(detail(over, "A02")).toBe("size_exceeded");
    for (const id of ["A03", "A04", "A05", "A06", "A07", "A08"] as const) expect(outcome(over, id)).toBe("not_run");
    expect(over.bytesWithheld).toBe(true);
  });

  it("blocks 4 MiB plus one byte by default; 4 MiB is within the size limit; a larger override does not help", () => {
    const w = makeWorld();
    const limit = DEFAULT_AUDIT_LIMITS.maxBytes;
    const atLimit = audit(w, new Uint8Array(limit).fill(0x78)).audit; // not JSON, but not too large either
    expect(detail(atLimit, "A02")).toBe("invalid_json");
    const over = new Uint8Array(limit + 1).fill(0x78);
    expect(detail(audit(w, over).audit, "A02")).toBe("size_exceeded");
    const raised = audit(w, over, { ...w.ctx, limits: { maxBytes: limit * 100, maxDepth: 32 } }).audit;
    expect(detail(raised, "A02")).toBe("size_exceeded");
    expect(raised.result).toBe("blocked");
  });

  it("blocks a malformed size limit as if it were the default, not as unlimited", () => {
    const w = makeWorld();
    const over = new Uint8Array(DEFAULT_AUDIT_LIMITS.maxBytes + 1).fill(0x78);
    for (const bad of [Number.NaN, Infinity, 0, -5, 1.5]) {
      const a = audit(w, over, { ...w.ctx, limits: { maxBytes: bad, maxDepth: 32 } }).audit;
      expect(detail(a, "A02"), String(bad)).toBe("size_exceeded");
    }
  });

  /** An envelope whose stored content is `k` nested arrays; the whole payload is then `3 + k` levels deep (object, array, object, then k). */
  const nested = (k: number): Json => {
    let v: Json = [];
    for (let i = 1; i < k; i++) v = [v];
    return v;
  };
  const depthOf = (k: number): AuditResult => {
    const w = makeWorld({ storedContent: nested(k) });
    return audit(w, w.bytes(w.envelope())).audit;
  };

  it("accepts nesting of exactly 32 levels and blocks 33 (depth_exceeded)", () => {
    expect(depthOf(29).result).toBe("pass");
    const a = depthOf(30);
    expect(a.result).toBe("blocked");
    expect(detail(a, "A02")).toBe("depth_exceeded");
    expect(a.bytesWithheld).toBe(true);
  });

  it("applies a tighter depth override, and ignores a larger one", () => {
    const w = makeWorld();
    const bytes = w.bytes(w.envelope()); // 4 levels deep
    expect(audit(w, bytes, { ...w.ctx, limits: { maxBytes: 1 << 20, maxDepth: 4 } }).audit.result).toBe("pass");
    expect(detail(audit(w, bytes, { ...w.ctx, limits: { maxBytes: 1 << 20, maxDepth: 3 } }).audit, "A02")).toBe("depth_exceeded");
    const deep = makeWorld({ storedContent: nested(30) });
    const raised = audit(deep, deep.bytes(deep.envelope()), { ...deep.ctx, limits: { maxBytes: 1 << 20, maxDepth: 1000 } }).audit;
    expect(detail(raised, "A02")).toBe("depth_exceeded");
  });
});

// ---------------------------------------------------------------------------------------------
describe("allowlist: only the intersection of the audit configuration and the context", () => {
  const one = (path: string): World => makeWorld({ sources: [{ path, text: "<?php\n// fictional\n" }] });
  const withLists = (w: World, cfgList: string[], ctxList: string[]) => ({
    cfg: parseAuditConfig(configBytes({ allowlist: cfgList })),
    ctx: { ...w.ctx, allowlist: ctxList },
  });
  const run = (path: string, cfgList: string[], ctxList: string[]): AuditResult => {
    const w = one(path);
    const { cfg, ctx } = withLists(w, cfgList, ctxList);
    return audit(w, w.bytes(w.envelope()), ctx, cfg).audit;
  };
  const P = "legacy/src/utils.php";
  const Q = "legacy/src/db.php";

  it("allows a path that is in both lists", () => {
    expect(run(P, [P, Q], [P]).result).toBe("pass");
  });

  it("refuses a path that is in the configuration only, or in the context only", () => {
    const a = run(P, [P], [Q]);
    expect(a.result).toBe("blocked");
    expect(detail(a, "A05")).toBe("allowlist_intersection_empty");
    const onlyCfg = run(P, [P, Q], [Q, "legacy/sql/schema.sql"]);
    expect(detail(onlyCfg, "A05")).toBe("path_not_allowlisted");
    const onlyCtx = run(P, [Q, "legacy/sql/schema.sql"], [P, Q]);
    expect(detail(onlyCtx, "A05")).toBe("path_not_allowlisted");
    expect(onlyCtx.bytesWithheld).toBe(true);
  });

  it("refuses everything when the intersection is empty, also for a payload that is otherwise valid, and when the context list is empty", () => {
    for (const [c, x] of [[[Q], [P]], [[P], []], [[P, Q], ["legacy/sql/seed.sql"]]] as const) {
      const a = run(P, [...c], [...x]);
      expect(a.result).toBe("blocked");
      expect(detail(a, "A05")).toBe("allowlist_intersection_empty");
    }
  });

  it("compares paths exactly: case, slash form, a leading ./ and a trailing slash are different paths", () => {
    for (const variant of ["LEGACY/src/utils.php", "legacy\\src\\utils.php", "./legacy/src/utils.php", "legacy/src/utils.php/", "legacy/src//utils.php", " legacy/src/utils.php"]) {
      const a = run(variant, ALLOWLIST, ALLOWLIST);
      expect(a.result, variant).toBe("blocked");
      expect(detail(a, "A05"), variant).toBe("path_not_allowlisted");
    }
  });

  it("never accepts a path outside the intersection, for any pair of lists (property)", () => {
    const pool = [...ALLOWLIST];
    fc.assert(
      fc.property(fc.subarray(pool, { minLength: 1 }), fc.subarray(pool), fc.constantFrom(...pool), (cfgList, ctxList, path) => {
        const a = run(path, cfgList, ctxList);
        const inBoth = cfgList.includes(path) && ctxList.includes(path);
        // A05 passes exactly when the path is in both lists; widening either list alone never changes that.
        expect(outcome(a, "A05") === "pass").toBe(inBoth);
        expect(a.result === "pass").toBe(inBoth);
        if (!inBoth) expect(a.bytesWithheld).toBe(true);
      }),
      { seed: 34_005, numRuns: 100 },
    );
  });

  it("adding a path to one list does not widen what the other list refuses", () => {
    expect(run(P, [Q], [P, Q]).result).toBe("blocked");
    expect(run(P, [P, Q], [Q]).result).toBe("blocked");
    expect(run(P, [Q, P], [Q, P]).result).toBe("pass");
  });

  it("uses the manifest entries unchanged: SOURCE paths used elsewhere in the tests are in the shared list", () => {
    expect(ALLOWLIST).toContain(SOURCE_A.path);
    expect(ALLOWLIST).toContain(SOURCE_B.path);
  });
});

// ---------------------------------------------------------------------------------------------
describe("A03 verifies the part type against the record kind (fail closed when the kind cannot be verified)", () => {
  const withKind = (kind: unknown): { w: World; bytes: Uint8Array } => {
    const w = makeWorld();
    const rec = w.records.get(RECORD_ID) as { kind: unknown; sha256: string; canonicalJson: string };
    const holder: { kind: unknown } = rec;
    holder.kind = kind;
    if (kind === "<absent>") delete (rec as { kind?: unknown }).kind;
    return { w, bytes: w.bytes(w.envelope()) };
  };

  it("passes when the kind equals the part type", () => {
    const { w, bytes } = withKind("hypothesis_revision");
    expect(audit(w, bytes).audit.result).toBe("pass");
  });

  it("blocks a record of another kind, whatever the other kind is, even though its hash and content match", () => {
    for (const kind of ["experiment", "observation", "comparison", "policy_decision", "ai_output", "payload_audit", "Hypothesis_Revision", " hypothesis_revision"]) {
      const { w, bytes } = withKind(kind);
      const a = audit(w, bytes).audit;
      expect(a.result, kind).toBe("blocked");
      expect(detail(a, "A03"), kind).toBe("record_kind_mismatch");
      expect(outcome(a, "A03")).toBe("fail");
    }
  });

  it("blocks a record whose kind is missing, empty or not a string: not verified is not a pass", () => {
    for (const kind of ["<absent>", undefined, null, "", 7, {}, []]) {
      const { w, bytes } = withKind(kind);
      const a = audit(w, bytes).audit;
      expect(a.result, String(kind)).toBe("blocked");
      expect(detail(a, "A03"), String(kind)).toBe("record_kind_unverified");
    }
  });

  it("checks every stored part type against its own record kind", () => {
    const w = makeWorld();
    const types = ["hypothesis_revision", "experiment", "observation", "comparison"] as const;
    const env = w.envelope();
    env["parts"] = env["parts"].slice(0, 2);
    types.forEach((t, i) => {
      const content = { note: `fictional ${t}` };
      const canon = canonicalJson(content);
      const id = `rec-1${i}0000`;
      w.records.set(id, { kind: t, sha256: sha256Hex(canon), canonicalJson: canon });
      env["parts"].push({ partId: `s${i}`, type: t, recordId: id, recordSha256: sha256Hex(canon), content });
    });
    expect(audit(w, w.bytes(env)).audit.result).toBe("pass");
    // swap two kinds in the store: both parts must now be refused
    const a = w.records.get("rec-100000") as { kind: string };
    const b = w.records.get("rec-110000") as { kind: string };
    [a.kind, b.kind] = [b.kind, a.kind];
    const r = audit(w, w.bytes(env)).audit;
    expect(r.result).toBe("blocked");
    expect(r.matches.filter((m) => m.checkId === "A03").map((m) => m.matchId).sort()).toEqual(["part:2", "part:3"]);
  });

  it("a part type outside the four kinds is still refused, with or without a record", () => {
    const w = makeWorld();
    const env = w.envelope();
    env["parts"].push({ partId: "p10", type: "experiment_result" });
    const a = audit(w, w.bytes(env)).audit;
    expect(detail(a, "A03")).toBe("part_type_not_permitted");
  });
});