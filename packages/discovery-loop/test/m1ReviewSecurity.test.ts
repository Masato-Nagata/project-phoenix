// Feature: discovery-loop, Property 21: Untrusted AI responses are gated whole
// Security tests of the M1 review (task 1.27, design "M1 review resolutions" items 7, 8 and 9, and C1).
// **Validates: Requirements 4.8, 4.11, 4.16, 6.16, 17.6, 23.4, 23.6, 23.14**
//
// The gate of M3 (task 3.10) does not exist yet. The M1-level gate used here is exactly what the design says
// the strict gate does: (1) remove the reserved names at the top level of each Claim, (2) record the discard
// without the value, (3) validate the remainder against the closed hypothesis-proposal schema. Anything the
// closed schema does not define rejects the whole response and nothing is stored.
// Reproducibility record of the property tests: SEED = 21021, NUM_RUNS = 100 (fixed on purpose).
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from "node:crypto";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import {
  EvidenceStore,
  SCHEMAS,
  SCHEMA_NAMES,
  canonicalJson,
  createSchemaValidator,
  discardAiAuthorityFields,
  isAuthorityLikeName,
  type SchemaName,
} from "../src/index.js";
import { ApprovalReader, type TargetResolver } from "../src/approval/index.js";
import { appendApproval, buildChain } from "../src/approval/tooling.js";
import { createFactsQuery } from "../src/report/index.js";
import { FIXTURE_SETS } from "./fixtures/schemaFixtures.js";

// The isolation tests build many small worlds; give them room on a slow container.
vi.setConfig({ testTimeout: 120_000 });

const SEED = 21021;
const NUM_RUNS = 100;
const RUN = "run-0001";
const anyTarget: TargetResolver = { resolves: () => true };
const validator = createSchemaValidator();

const RESERVED = ["origin", "evidence", "evidence_status", "approval", "approved"] as const;
/** Same names with other case or separators; the Claim-level discard matches these too (isAuthorityLikeName). */
const RESERVED_VARIANTS = ["Origin", "EVIDENCE", "evidenceStatus", "Evidence-Status", "APPROVAL", "Approved"] as const;

const baseProposal = (): any => {
  const full = FIXTURE_SETS.find((s) => s.schema === "hypothesis-proposal")?.valid.find((v) => v.id === "full proposal")?.value;
  const p = structuredClone(full) as any;
  const second = structuredClone(p.claims[0]);
  second.localKey = "second_claim";
  p.claims.push(second);
  return p;
};

// ---------------------------------------------------------------------------------------------
// M1-level gate
// ---------------------------------------------------------------------------------------------
type GateResult =
  | { accepted: false; issues: { code: string; path: string }[] }
  | { accepted: true; discarded: { path: string; name: string }[]; cleaned: any };

function gate(response: unknown): GateResult {
  const discarded: { path: string; name: string }[] = [];
  let candidate: any = response;
  if (typeof response === "object" && response !== null && Array.isArray((response as any).claims)) {
    candidate = {
      ...(response as any),
      claims: (response as any).claims.map((c: unknown, i: number) => {
        if (typeof c !== "object" || c === null || Array.isArray(c)) return c;
        const r = discardAiAuthorityFields(c as any, `/claims/${i}`);
        discarded.push(...r.discarded);
        return r.cleaned;
      }),
    };
  }
  const checked = validator.validate("hypothesis-proposal", candidate);
  if (!checked.ok) return { accepted: false, issues: checked.error.map((i) => ({ code: i.code, path: i.path })) };
  return { accepted: true, discarded, cleaned: candidate };
}

/** Gate, then store the accepted Claims. A rejected response touches nothing. */
function ingest(store: EvidenceStore, response: unknown, aiOutputRecordId = "rec-000005"): GateResult {
  const g = gate(response);
  if (!g.accepted) return g;
  (response as any).claims.forEach((claim: any, i: number) => {
    const r = store.createClaimRevision({ claimId: `ingest-${i}`, reason: "initial", aiClaim: claim, aiOutputRecordId });
    if (!r.ok) throw new Error(`store refused an accepted claim: ${JSON.stringify(r.error)}`);
  });
  return g;
}

interface Position {
  label: string;
  /** JSON pointer of the object that receives the reserved name (threshold: the pointer of the property). */
  pointer: string;
  put(resp: any, name: string, value: unknown): void;
}
const at = (label: string, pointer: string, get: (r: any) => any): Position => ({
  label,
  pointer,
  put: (r, name, value) => {
    get(r)[name] = value;
  },
});
const POSITIONS: Position[] = [
  at("response top level (the Hypothesis proposal in M1)", "", (r) => r),
  at("derived value", "/derived/0", (r) => r.derived[0]),
  at("derived expression", "/derived/0/expr", (r) => r.derived[0].expr),
  at("derived expression argument", "/derived/0/expr/args/0", (r) => r.derived[0].expr.args[0]),
  at("lookup table", "/tables/0", (r) => r.tables[0]),
  at("lookup table entry", "/tables/0/entries/0", (r) => r.tables[0].entries[0]),
  at("condition", "/claims/0/condition", (r) => r.claims[0].condition),
  at("condition expression", "/claims/0/condition/expression", (r) => r.claims[0].condition.expression),
  at("condition expression operand", "/claims/0/condition/expression/left", (r) => r.claims[0].condition.expression.left),
  at("effect", "/claims/0/effect", (r) => r.claims[0].effect),
  at("effect response", "/claims/0/effect/response", (r) => r.claims[0].effect.response),
  at("effect response status", "/claims/0/effect/response/status", (r) => r.claims[0].effect.response.status),
  at("effect response field", "/claims/0/effect/response/fields/0", (r) => r.claims[0].effect.response.fields[0]),
  at("effect response field value", "/claims/0/effect/response/fields/0/value", (r) => r.claims[0].effect.response.fields[0].value),
  at("citation", "/claims/0/citations/0", (r) => r.claims[0].citations[0]),
  at("citation of the second claim", "/claims/1/citations/0", (r) => r.claims[1].citations[0]),
  at("effect of the second claim", "/claims/1/effect", (r) => r.claims[1].effect),
  {
    label: "threshold (an object where the schema wants a string)",
    pointer: "/claims/0/threshold",
    put: (r, name, value) => {
      r.claims[0].threshold = { [name]: value };
    },
  },
];

const SECRET_VALUE = "sentinel-authority-value-0f3a9c";

describe("positive control: the base proposal passes the gate untouched", () => {
  it("accepts the unmodified proposal and discards nothing", () => {
    const g = gate(baseProposal());
    expect(g.accepted).toBe(true);
    if (g.accepted) expect(g.discarded).toEqual([]);
  });
});

describe("nested reserved fields reject the whole response (resolution 9, C1)", () => {
  for (const name of RESERVED) {
    it(`${name}: rejected at every nesting position, nothing stored or used`, () => {
      for (const pos of POSITIONS) {
        const store = new EvidenceStore(validator);
        const resp = baseProposal();
        pos.put(resp, name, SECRET_VALUE);
        const g = ingest(store, resp);
        expect(g.accepted, `${name} at ${pos.label}`).toBe(false);
        if (g.accepted) continue;
        expect(g.issues.length, pos.label).toBeGreaterThan(0);
        // The rejection points at the offending place, so no partial acceptance is possible.
        expect(g.issues.some((i) => i.path.startsWith(pos.pointer)), `${pos.label}: ${JSON.stringify(g.issues)}`).toBe(true);
        if (pos.pointer !== "/claims/0/threshold") {
          expect(g.issues, pos.label).toContainEqual({ code: "undefined_field", path: `${pos.pointer}/${name}` });
        }
        // Nothing stored: no revision, no discard record, no event of any kind.
        expect(store.events(), pos.label).toEqual([]);
        expect(store.revisionsOf("ingest-0").ok, pos.label).toBe(false);
      }
    });
  }

  it("a nested reserved name is not removed by the Claim-level discard", () => {
    const claim = baseProposal().claims[0];
    claim.condition.origin = SECRET_VALUE;
    const r = discardAiAuthorityFields(claim, "/claims/0");
    expect(r.discarded).toEqual([]);
    expect(r.cleaned["condition"].origin).toBe(SECRET_VALUE);
  });

  it("a nested reserved name next to a Claim-level one still rejects the whole response", () => {
    const store = new EvidenceStore(validator);
    const resp = baseProposal();
    resp.claims[0].origin = "human-authored"; // would be discarded on its own
    resp.claims[1].citations[0].approval = "approved"; // nested: undefined field
    const g = ingest(store, resp);
    expect(g.accepted).toBe(false);
    expect(store.events()).toEqual([]);
  });

  it("any other undefined field on a Claim still rejects the whole response", () => {
    const store = new EvidenceStore(validator);
    const resp = baseProposal();
    resp.claims[0].note = "x";
    expect(ingest(store, resp).accepted).toBe(false);
    expect(store.events()).toEqual([]);
  });
});

describe("positive control: a reserved name at the top level of a Claim is discarded", () => {
  for (const name of RESERVED) {
    it(`${name}: discarded, recorded without the value, rest of the response accepted`, () => {
      const store = new EvidenceStore(validator);
      const resp = baseProposal();
      resp.claims[0][name] = SECRET_VALUE;
      const g = ingest(store, resp);
      expect(g.accepted).toBe(true);
      if (!g.accepted) return;
      expect(g.discarded).toEqual([{ path: "/claims/0", name }]);
      const events = store.events();
      const discard = events.filter((e) => e.type === "ai_content_discarded");
      expect(discard).toEqual([{ type: "ai_content_discarded", aiOutputRecordId: "rec-000005", fields: [{ path: "", name }] }]);
      // Both Claims were stored, with an orchestrator-assigned Origin and without the reserved field.
      for (const id of ["ingest-0-r1", "ingest-1-r1"]) {
        const rev = store.getRevision(id);
        expect(rev.ok).toBe(true);
        if (rev.ok) {
          expect(rev.value.origin).toBe("ai-inferred");
          expect(Object.keys(rev.value.content)).not.toContain(name);
        }
      }
      // The value is never stored, hashed or echoed.
      expect(JSON.stringify(events)).not.toContain(SECRET_VALUE);
      expect(JSON.stringify([...Array(2).keys()].map((i) => store.getRevision(`ingest-${i}-r1`)))).not.toContain(SECRET_VALUE);
      // The recorded payload fits the closed ai_content_discarded schema, which has no value field.
      const payload = { aiOutputRecordId: (discard[0] as any).aiOutputRecordId, fields: (discard[0] as any).fields };
      const envelope = {
        schemaVersion: 1, seq: 2, id: "rec-000002", kind: "ai_content_discarded", prevHash: "0".repeat(64), payload, hash: "d".repeat(64),
      };
      expect(validator.validate("record-envelope", envelope).ok).toBe(true);
    });
  }

  it("the discard matches case and separator variants, and a missing value never matters", () => {
    for (const name of RESERVED_VARIANTS) {
      expect(isAuthorityLikeName(name), name).toBe(true);
      const g = gate({ ...baseProposal(), claims: [{ ...baseProposal().claims[0], [name]: null }] });
      expect(g.accepted, name).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Authority isolation
// ---------------------------------------------------------------------------------------------
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");

function approvalCandidate(rev: string, decision: string): unknown {
  return {
    approver: "Alice Example",
    timestamp: "2025-03-04T05:06:07.000+09:00",
    target: { kind: "claim_revision", run_id: RUN, claim_revision_id: rev },
    decision,
    rationale: "Reviewed.",
    recorded_by: "human",
  };
}

function makeWorld(): { store: EvidenceStore; approvalText: string } {
  const store = new EvidenceStore(validator);
  for (const claimId of ["clm-1", "clm-2"]) {
    const r = store.createClaimRevision({ claimId, reason: "initial", aiClaim: { effect: "x" }, aiOutputRecordId: "rec-000001" });
    if (!r.ok) throw new Error("setup");
  }
  const ev = (component: string, record: unknown): void => {
    const r = store.appendEvidence({ component, record } as never);
    if (!r.ok) throw new Error(`setup evidence: ${JSON.stringify(r.error)}`);
  };
  ev("citation_verifier", {
    evidenceId: "ev-1", kind: "source", claimRevisionId: "clm-1-r1", citationRecordId: "rec-000010", citations: [{ index: 0, result: "verified" }],
  });
  ev("experiment_rule:mismatch", {
    evidenceId: "ev-2", kind: "experiment", claimRevisionId: "clm-1-r1", outcome: "contradicts", experimentId: "exp-1",
    comparisonRecordId: "rec-000020", observationRecordId: "rec-000021", predictionRecordId: "rec-000022",
  });
  ev("citation_verifier", {
    evidenceId: "ev-3", kind: "source", claimRevisionId: "clm-2-r1", citationRecordId: "rec-000011",
    citations: [{ index: 0, result: "failed", reason: "quote_not_found" }],
  });
  const chain = buildChain([approvalCandidate("clm-1-r1", "approved"), approvalCandidate("clm-2-r1", "rejected")], anyTarget);
  if (!chain.ok) throw new Error("setup approvals");
  return { store, approvalText: chain.value.text };
}

interface Snapshot {
  facts: string;
  approvalSha: string;
  approvalReport: string;
  events: string;
}
function snapshot(store: EvidenceStore, approvalText: string, ids: string[]): Snapshot {
  const reader = ApprovalReader.fromBytes(approvalText, anyTarget);
  const q = createFactsQuery(store, RUN, reader);
  const facts = ids.map((id) => {
    const f = q.facts(id);
    if (!f.ok) throw new Error(`facts failed for ${id}: ${JSON.stringify(f.error)}`);
    // The four facts, each as its own value.
    return { id, origin: f.value.origin, source: f.value.sourceEvidenceStatus, experiment: f.value.experimentEvidenceStatus, approval: f.value.approvalStatus };
  });
  return {
    facts: canonicalJson(facts),
    approvalSha: sha(approvalText),
    approvalReport: canonicalJson({ report: reader.verify(), approvals: reader.approvals() } as never),
    events: canonicalJson(store.events() as never),
  };
}

describe("authority isolation: discarded or rejected authority fields change none of the four facts", () => {
  const EXISTING = ["clm-1-r1", "clm-2-r1"];
  const VALUES: unknown[] = ["human-authored", "supported", "approved", true, { kind: "source", outcome: "supports" }, [{ status: "supported" }]];

  const proposalWith = (claimPatch: (c: any) => void): any => {
    const p = baseProposal();
    p.claims = [p.claims[0]];
    claimPatch(p.claims[0]);
    return p;
  };

  it("discarded at Claim level: existing revisions, a new revision and the Approval_Store are unaffected", () => {
    for (const name of [...RESERVED, ...RESERVED_VARIANTS]) {
      for (const value of VALUES) {
        const { store, approvalText } = makeWorld();
        const before = snapshot(store, approvalText, EXISTING);
        const resp = proposalWith((c) => {
          c[name] = value;
        });
        // A new Claim, and a new revision of the supported + approved Claim clm-1 (same Claim id).
        const g = gate(resp);
        expect(g.accepted, `${name}=${JSON.stringify(value)}`).toBe(true);
        const newClaim = store.createClaimRevision({ claimId: "clm-3", reason: "initial", aiClaim: resp.claims[0], aiOutputRecordId: "rec-000030" });
        const revised = store.createClaimRevision({ claimId: "clm-1", reason: "revision", aiClaim: resp.claims[0], aiOutputRecordId: "rec-000031" });
        expect(newClaim.ok && revised.ok).toBe(true);
        const after = snapshot(store, approvalText, EXISTING);
        // Facts of the existing revisions, the Approval_Store bytes and its verification are identical.
        expect(after.facts, `${name}=${JSON.stringify(value)}`).toBe(before.facts);
        expect(after.approvalSha).toBe(before.approvalSha);
        expect(after.approvalReport).toBe(before.approvalReport);
        // The new revisions carry the fixed starting facts, whatever the AI claimed.
        const fresh = JSON.parse(snapshot(store, approvalText, ["clm-3-r1", "clm-1-r2"]).facts) as any[];
        for (const f of fresh) {
          expect(f, `${name}=${JSON.stringify(value)}`).toMatchObject({ origin: "ai-inferred", source: "absent", experiment: "absent", approval: "none" });
        }
        // Control: the same Claim without the authority field gives the same facts.
        const control = makeWorld();
        const c = proposalWith(() => undefined);
        control.store.createClaimRevision({ claimId: "clm-3", reason: "initial", aiClaim: c.claims[0], aiOutputRecordId: "rec-000030" });
        control.store.createClaimRevision({ claimId: "clm-1", reason: "revision", aiClaim: c.claims[0], aiOutputRecordId: "rec-000031" });
        expect(snapshot(store, approvalText, [...EXISTING, "clm-3-r1", "clm-1-r2"]).facts).toBe(
          snapshot(control.store, control.approvalText, [...EXISTING, "clm-3-r1", "clm-1-r2"]).facts,
        );
        // Only the discard records differ from the control (one per stored Claim revision), and they carry no value field.
        const discards = store.events().filter((e) => e.type === "ai_content_discarded");
        expect(discards.length).toBe(2);
        for (const d of discards) expect(Object.keys(d).sort()).toEqual(["aiOutputRecordId", "fields", "type"]);
      }
    }
  });

  it("rejected (nested or response level): nothing changes, facts and Approval_Store bytes included", () => {
    for (const name of RESERVED) {
      for (const pos of POSITIONS) {
        const { store, approvalText } = makeWorld();
        const before = snapshot(store, approvalText, EXISTING);
        const resp = baseProposal();
        pos.put(resp, name, name === "approved" ? true : "approved");
        const g = ingest(store, resp);
        expect(g.accepted, `${name} at ${pos.label}`).toBe(false);
        const after = snapshot(store, approvalText, EXISTING);
        expect(after, `${name} at ${pos.label}`).toEqual(before);
      }
    }
  });

  it("approval-like content never creates or alters an Approval_Record", () => {
    const { approvalText } = makeWorld();
    const readerBefore = ApprovalReader.fromBytes(approvalText, anyTarget);
    // Candidates built from AI-supplied content: AI as the actor, a Claim-level approval field, an unknown actor.
    const aiLike: unknown[] = [
      { ...(approvalCandidate("clm-3-r1", "approved") as object), recorded_by: "ai" },
      { ...(approvalCandidate("clm-3-r1", "approved") as object), recorded_by: "ai-inferred" },
      { ...(approvalCandidate("clm-3-r1", "approved") as object), approved: true },
      { ...(approvalCandidate("clm-3-r1", "approved") as object), origin: "human-authored" },
      { claims: [{ approval: "approved" }] },
      "approved",
      null,
    ];
    for (const candidate of aiLike) {
      const r = appendApproval(approvalText, candidate, anyTarget);
      expect(r.ok, JSON.stringify(candidate)).toBe(false);
    }
    // The text is a value the caller still holds; a rejected append returns no new text. The reader agrees.
    const readerAfter = ApprovalReader.fromBytes(approvalText, anyTarget);
    expect(canonicalJson({ r: readerAfter.verify(), a: readerAfter.approvals() } as never)).toBe(
      canonicalJson({ r: readerBefore.verify(), a: readerBefore.approvals() } as never),
    );
    // The model and the gate have no way to reach an Approval writer at all: run a full ingest of approval-like
    // content and confirm the bytes the reader sees are unchanged.
    const store = new EvidenceStore(validator);
    const resp = baseProposal();
    resp.claims[0].approval = "approved";
    resp.claims[0].approved = true;
    expect(ingest(store, resp).accepted).toBe(true);
    expect(readerAfter.approvals().length).toBe(2);
    expect(readerAfter.approvals().map((a) => a.seq)).toEqual(readerBefore.approvals().map((a) => a.seq));
  });
});

// ---------------------------------------------------------------------------------------------
// Required fields with strictRequired disabled (resolution 8)
// ---------------------------------------------------------------------------------------------
type Node = Record<string, any>;
interface Loc {
  doc: string;
  ptr: string;
}
interface RequiredCase {
  schema: SchemaName;
  /** Where the `required` keyword lives. */
  loc: Loc;
  field: string;
  /** Instance pointer of the object that must carry the field. */
  instancePtr: string;
  root: unknown;
}

const addFormats: (a: Ajv2020) => Ajv2020 = (addFormatsModule as any).default ?? (addFormatsModule as any);
const walkAjv = new Ajv2020({ strict: false, allErrors: false, discriminator: true, allowUnionTypes: true });
addFormats(walkAjv);
for (const n of SCHEMA_NAMES) walkAjv.addSchema(SCHEMAS[n] as Node);

const DOCS = new Map<string, Node>();
for (const n of SCHEMA_NAMES) DOCS.set((SCHEMAS[n] as Node)["$id"], SCHEMAS[n] as Node);

const isObj = (v: unknown): v is Node => typeof v === "object" && v !== null && !Array.isArray(v);
const esc = (s: string): string => s.replace(/~/g, "~0").replace(/\//g, "~1");
const unesc = (s: string): string => s.replace(/~1/g, "/").replace(/~0/g, "~");
const nodeAt = (l: Loc): Node => {
  let cur: any = DOCS.get(l.doc);
  for (const t of l.ptr.split("/").slice(1)) cur = cur?.[unesc(t)];
  if (cur === undefined) throw new Error(`no schema node at ${l.doc}#${l.ptr}`);
  return cur;
};
const child = (l: Loc, ...tokens: (string | number)[]): Loc => ({ doc: l.doc, ptr: l.ptr + tokens.map((t) => `/${esc(String(t))}`).join("") });
const resolveRef = (l: Loc, ref: string): Loc => {
  const [d, frag] = ref.split("#");
  return { doc: d === "" || d === undefined ? l.doc : d, ptr: frag ?? "" };
};
const compiled = new Map<string, ValidateFunction>();
const matches = (l: Loc, inst: unknown): boolean => {
  const key = l.ptr === "" ? l.doc : `${l.doc}#${l.ptr}`;
  let fn = compiled.get(key);
  if (fn === undefined) {
    fn = walkAjv.getSchema(key);
    if (fn === undefined) throw new Error(`cannot compile ${key}`);
    compiled.set(key, fn);
  }
  return fn(inst) === true;
};
const ifCache = new Map<unknown, ValidateFunction>();
const ifMatches = (cond: unknown, inst: unknown): boolean => {
  let fn = ifCache.get(cond);
  if (fn === undefined) {
    fn = walkAjv.compile(cond as object);
    ifCache.set(cond, fn);
  }
  return fn(inst) === true;
};

/** Walks a schema and a valid instance together and lists every required field that applies to the instance. */
function collect(loc: Loc, inst: unknown, ip: string, out: { loc: Loc; field: string; ip: string }[]): void {
  const node = nodeAt(loc);
  if (typeof node["$ref"] === "string") collect(resolveRef(loc, node["$ref"]), inst, ip, out);
  if (isObj(inst)) {
    for (const f of (node["required"] as string[] | undefined) ?? []) {
      if (!(f in inst)) throw new Error(`the valid fixture lacks required field ${f} at ${ip} (${loc.doc}#${loc.ptr})`);
      out.push({ loc, field: f, ip });
    }
    const props = node["properties"] as Node | undefined;
    for (const [k, v] of Object.entries(inst)) {
      if (props !== undefined && k in props) collect(child(loc, "properties", k), v, `${ip}/${esc(k)}`, out);
      else if (isObj(node["additionalProperties"])) collect(child(loc, "additionalProperties"), v, `${ip}/${esc(k)}`, out);
    }
  }
  if (Array.isArray(inst) && isObj(node["items"])) {
    inst.forEach((v, i) => collect(child(loc, "items"), v, `${ip}/${i}`, out));
  }
  if (Array.isArray(node["allOf"])) node["allOf"].forEach((_: unknown, i: number) => collect(child(loc, "allOf", i), inst, ip, out));
  for (const key of ["oneOf", "anyOf"]) {
    if (!Array.isArray(node[key])) continue;
    node[key].forEach((_: unknown, i: number) => {
      const bl = child(loc, key, i);
      if (matches(bl, inst)) collect(bl, inst, ip, out);
    });
  }
  if (node["if"] !== undefined) {
    if (ifMatches(node["if"], inst)) {
      if (node["then"] !== undefined) collect(child(loc, "then"), inst, ip, out);
    } else if (node["else"] !== undefined) {
      collect(child(loc, "else"), inst, ip, out);
    }
  }
}

/** Every `required` list written in the schema objects, except those under `not` or `if` (conditions, not obligations). */
function staticRequired(): Set<string> {
  const found = new Set<string>();
  const SKIP = new Set(["not", "if", "enum", "const", "default", "examples", "description"]);
  const visit = (doc: string, ptr: string, node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach((n, i) => visit(doc, `${ptr}/${i}`, n));
      return;
    }
    if (!isObj(node)) return;
    for (const [k, v] of Object.entries(node)) {
      if (SKIP.has(k)) continue;
      if (k === "required" && Array.isArray(v)) {
        for (const f of v) found.add(`${doc}#${ptr}|${String(f)}`);
      } else if (k === "properties" || k === "$defs" || k === "patternProperties") {
        for (const [name, sub] of Object.entries(v as Node)) visit(doc, `${ptr}/${esc(k)}/${esc(name)}`, sub);
      } else {
        visit(doc, `${ptr}/${esc(k)}`, v);
      }
    }
  };
  for (const [doc, schema] of DOCS) visit(doc, "", schema);
  return found;
}

/** Valid instances for schema parts the shared fixtures do not exercise. */
const SUPPLEMENTARY: { schema: SchemaName; id: string; value: unknown }[] = [
  { schema: "rule-expression", id: "not", value: { op: "not", arg: { op: "lit", value: true } } },
  { schema: "rule-expression", id: "count with where", value: { op: "count", over: "requests[0].body.items", where: { op: "lit", value: true } } },
  { schema: "rule-expression", id: "sub", value: { op: "sub", left: { op: "lit", value: 3 }, right: { op: "lit", value: 1 } } },
  { schema: "rule-expression", id: "lookup", value: { op: "lookup", table: "label_cost", key: { op: "lit", value: 1 } } },
];

function instances(): { schema: SchemaName; id: string; value: unknown }[] {
  const out: { schema: SchemaName; id: string; value: unknown }[] = [];
  for (const set of FIXTURE_SETS) for (const v of set.valid) out.push({ schema: set.schema, id: v.id, value: v.value });
  out.push(...SUPPLEMENTARY);
  return out;
}

function buildCases(): RequiredCase[] {
  const seen = new Set<string>();
  const cases: RequiredCase[] = [];
  for (const inst of instances()) {
    const found: { loc: Loc; field: string; ip: string }[] = [];
    collect({ doc: (SCHEMAS[inst.schema] as Node)["$id"], ptr: "" }, inst.value, "", found);
    for (const f of found) {
      const key = `${f.loc.doc}#${f.loc.ptr}|${f.field}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cases.push({ schema: inst.schema, loc: f.loc, field: f.field, instancePtr: f.ip, root: inst.value });
    }
  }
  return cases;
}

const getAt = (root: any, ptr: string): any => {
  let cur = root;
  for (const t of ptr.split("/").slice(1)) cur = cur[unesc(t)];
  return cur;
};

describe("required fields are enforced although strictRequired is off (resolution 8)", () => {
  const cases = buildCases();
  const reached = new Set(cases.map((c) => `${c.loc.doc}#${c.loc.ptr}|${c.field}`));

  it("positive control: every valid fixture passes unmodified", () => {
    for (const inst of instances()) {
      const r = validator.validate(inst.schema, inst.value);
      expect(r.ok, `${inst.schema}: ${inst.id}`).toBe(true);
    }
  });

  it("the schema walk finds a non-trivial number of (schema, field) cases", () => {
    console.info(`[1.27] generated (schema, required field) cases: ${cases.length}`);
    expect(cases.length).toBeGreaterThanOrEqual(150);
    expect(new Set(cases.map((c) => c.schema)).size).toBe(SCHEMA_NAMES.length - 1); // every schema except `common`
  });

  it("every required list written in a schema is reached by a case (new required fields are covered automatically)", () => {
    const unreached = [...staticRequired()].filter((k) => !reached.has(k)).sort();
    expect(unreached, `required fields no valid fixture exercises: add a fixture or a SUPPLEMENTARY instance`).toEqual([]);
  });

  it("the kind-specific if/then branches are part of the walk", () => {
    const keys = [...reached];
    expect(keys.some((k) => k.startsWith("evidence.schema.json#/allOf/0/then|citations"))).toBe(true);
    expect(keys.some((k) => k.startsWith("evidence.schema.json#/allOf/1/then|outcome"))).toBe(true);
    expect(keys.some((k) => k.startsWith("run-manifest.schema.json#/properties/mutualExclusion/allOf/0/then|lease"))).toBe(true);
    expect(keys.some((k) => k.startsWith("record-envelope.schema.json#/$defs/StoreRejectionPayload/allOf/0/then|patternId"))).toBe(true);
  });

  for (const schema of SCHEMA_NAMES.filter((n) => n !== "common")) {
    it(`${schema}: an otherwise valid input lacking any required field is rejected, and the field is named`, () => {
      const mine = cases.filter((c) => c.schema === schema);
      expect(mine.length, schema).toBeGreaterThan(0);
      for (const c of mine) {
        const mutated = structuredClone(c.root) as any;
        const holder = getAt(mutated, c.instancePtr);
        expect(Object.keys(holder), `${schema} ${c.instancePtr}`).toContain(c.field);
        delete holder[c.field];
        const r = validator.validate(schema, mutated);
        const label = `${schema}: ${c.instancePtr}/${c.field} (${c.loc.doc}#${c.loc.ptr})`;
        expect(r.ok, label).toBe(false);
        if (r.ok) continue;
        const named = r.error.some(
          (i) =>
            (i.code === "missing_field" && i.path === `${c.instancePtr}/${esc(c.field)}`) ||
            // A missing oneOf discriminator tag is reported by Ajv as a tag error on the object, naming the tag.
            (i.keyword === "discriminator" && i.path === c.instancePtr && i.message.includes(`"${c.field}"`)),
        );
        expect(named, `${label}: ${JSON.stringify(r.error)}`).toBe(true);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Approval_Store tail truncation (resolution 7), document-behavior test
// ---------------------------------------------------------------------------------------------
describe("Approval_Store tail truncation is documented behavior (resolution 7)", () => {
  const built = buildChain(
    [1, 2, 3, 4].map((i) => approvalCandidate(`clm-${i}-r1`, "approved")),
    anyTarget,
  );
  if (!built.ok) throw new Error("setup chain");
  const full = built.value.text;
  const lines = full.split("\n").filter((l) => l !== "");
  const head = built.value.lines.at(-1)!;
  const anchor = { seq: head.seq, hash: head.hash };
  const truncated = (keep: number): string => lines.slice(0, keep).map((l) => `${l}\n`).join("");

  it("positive control: the full store verifies and, with the correct anchor, is reported as excluded_by_anchor", () => {
    expect(lines.length).toBe(4);
    expect(ApprovalReader.fromBytes(full, anyTarget).verify()).toMatchObject({ ok: true, tailTruncation: "not_checked" });
    expect(ApprovalReader.fromBytes(full, anyTarget, { anchor }).verify()).toMatchObject({ ok: true, tailTruncation: "excluded_by_anchor" });
  });

  for (const keep of [3, 2, 1, 0]) {
    it(`removing the last ${4 - keep} record(s): no mismatch and not reported as complete without an anchor; with the anchor: missing`, () => {
      const text = truncated(keep);
      const noAnchor = ApprovalReader.fromBytes(text, anyTarget).verify();
      expect(noAnchor.ok).toBe(true);
      expect(noAnchor.mismatches).toEqual([]);
      expect(noAnchor.tailTruncation).toBe("not_checked"); // never a completeness claim
      // The removed approvals silently read as `none` when no anchor is supplied: this is the documented gap.
      const lost = ApprovalReader.fromBytes(text, anyTarget).statusOf({ kind: "claim_revision", runId: RUN, claimRevisionId: "clm-4-r1" });
      expect(lost).toEqual({ ok: true, value: "none" });

      const withAnchor = ApprovalReader.fromBytes(text, anyTarget, { anchor });
      const report = withAnchor.verify();
      expect(report.ok).toBe(false);
      expect(report.tailTruncation).toBe("not_checked");
      expect(report.mismatches.map((m) => ({ seq: m.seq, kind: m.kind }))).toEqual([{ seq: anchor.seq, kind: "missing" }]);
      // No status is derived from a store that fails the anchor check.
      const refused = withAnchor.statusOf({ kind: "claim_revision", runId: RUN, claimRevisionId: "clm-1-r1" });
      expect(refused.ok).toBe(false);
    });
  }

  it("a wrong anchor hash on an untruncated store is a mismatch, not an exclusion", () => {
    const r = ApprovalReader.fromBytes(full, anyTarget, { anchor: { seq: anchor.seq, hash: "f".repeat(64) } }).verify();
    expect(r.ok).toBe(false);
    expect(r.tailTruncation).toBe("not_checked");
  });
});

// ---------------------------------------------------------------------------------------------
// Property 21
// ---------------------------------------------------------------------------------------------
describe("Property 21: Untrusted AI responses are gated whole", () => {
  const nameArb = fc.constantFrom<string>(...RESERVED, ...RESERVED_VARIANTS);
  const valueArb: fc.Arbitrary<unknown> = fc.oneof(
    fc.constantFrom("approved", "human-authored", "supported", ""),
    fc.integer(),
    fc.boolean(),
    fc.constant(null),
    fc.constant({}),
    fc.constant([]),
    fc.constant({ nested: { origin: "human-authored" } }),
  );
  const positionArb = fc.integer({ min: 0, max: POSITIONS.length - 1 });

  it("a reserved name at a random nesting position rejects the whole response and stores nothing", () => {
    fc.assert(
      fc.property(positionArb, nameArb, valueArb, fc.boolean(), (p, name, value, alsoClaimLevel) => {
        const pos = POSITIONS[p]!;
        const store = new EvidenceStore(validator);
        const resp = baseProposal();
        if (alsoClaimLevel) resp.claims[1].origin = "human-authored"; // legal on its own
        pos.put(resp, name, value);
        const g = ingest(store, resp);
        expect(g.accepted).toBe(false);
        expect(store.events()).toEqual([]);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it("the same name at the top level of a Claim is discarded without the value and the rest is accepted", () => {
    const sentinelArb = fc
      .array(fc.constantFrom(..."0123456789abcdef"), { minLength: 16, maxLength: 32 })
      .map((a) => `sent-${a.join("")}`);
    fc.assert(
      fc.property(nameArb, sentinelArb, fc.integer({ min: 0, max: 1 }), (name, sentinel, claimIndex) => {
        const store = new EvidenceStore(validator);
        const resp = baseProposal();
        resp.claims[claimIndex][name] = sentinel;
        const g = ingest(store, resp);
        expect(g.accepted).toBe(true);
        if (!g.accepted) return;
        expect(g.discarded).toEqual([{ path: `/claims/${claimIndex}`, name }]);
        expect(JSON.stringify(store.events())).not.toContain(sentinel);
        for (const id of ["ingest-0-r1", "ingest-1-r1"]) {
          const f = store.originOf(id);
          expect(f).toEqual({ ok: true, value: "ai-inferred" });
          expect(store.sourceStatusOf(id)).toEqual({ ok: true, value: "absent" });
          expect(store.experimentStatusOf(id)).toEqual({ ok: true, value: "absent" });
        }
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });
});
