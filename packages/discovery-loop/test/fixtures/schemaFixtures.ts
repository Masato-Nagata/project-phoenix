// Fixtures for the schema tests (task 1.3). Every value uses the neutral fictitious "widget" API
// (fields count, label, unit_cost). No legacy business value appears here.
import type { IssueCode, SchemaName } from "../../src/schema/types.js";

export interface InvalidFixture {
  id: string;
  value: unknown;
  /** The expected first-class issue: some issue with this code and this JSON pointer must be reported. */
  expect: { code: IssueCode; path: string };
}
export interface FixtureSet {
  schema: SchemaName;
  valid: { id: string; value: unknown }[];
  invalid: InvalidFixture[];
}

const h = (c: string): string => c.repeat(64);
const GENESIS = h("0");

/** Deep copy of `base` with `fn` applied; keeps the fixtures declarative. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function edit<T>(base: T, fn: (v: any) => void): unknown {
  const copy = structuredClone(base);
  fn(copy);
  return copy;
}
const bad = (id: string, value: unknown, code: IssueCode, path: string): InvalidFixture => ({
  id,
  value,
  expect: { code, path },
});

// ---------------------------------------------------------------------------------------------
const facts = {
  claimRevisionId: "clm-0001-r1",
  origin: "ai-inferred",
  sourceEvidenceStatus: "supported",
  experimentEvidenceStatus: "absent",
  approvalStatus: "none",
};
const factsSet: FixtureSet = {
  schema: "facts",
  valid: [{ id: "four separate facts", value: facts }],
  invalid: [
    bad("origin outside the two values", edit(facts, (v) => { v.origin = "ai-verified"; }), "bad_value", "/origin"),
    bad("merged status field", edit(facts, (v) => { v.status = "supported"; }), "undefined_field", "/status"),
    bad("missing experiment status", edit(facts, (v) => { delete v.experimentEvidenceStatus; }), "missing_field", "/experimentEvidenceStatus"),
    bad("approval status outside the set", edit(facts, (v) => { v.approvalStatus = "pending"; }), "bad_value", "/approvalStatus"),
  ],
};

// ---------------------------------------------------------------------------------------------
const manifest = {
  schemaVersion: 1,
  hashRule: "sha256 over UTF-8 bytes after CRLF and lone CR are replaced by LF",
  files: [
    { path: "src/widgets.php", sha256Lf: h("a") },
    { path: "sql/widgets.sql", sha256Lf: h("b") },
  ],
};
const manifestSet: FixtureSet = {
  schema: "source-bundle-manifest",
  valid: [{ id: "two files", value: manifest }],
  invalid: [
    bad("byte count field", edit(manifest, (v) => { v.files[0].bytes = 10; }), "undefined_field", "/files/0/bytes"),
    bad("upper-case hash", edit(manifest, (v) => { v.files[0].sha256Lf = h("A"); }), "bad_value", "/files/0/sha256Lf"),
    bad("no files", edit(manifest, (v) => { v.files = []; }), "bad_value", "/files"),
    bad("absolute path", edit(manifest, (v) => { v.files[0].path = "/etc/widgets.php"; }), "bad_value", "/files/0/path"),
    bad("dot segment", edit(manifest, (v) => { v.files[0].path = "src/../widgets.php"; }), "schema_violation", "/files/0/path"),
    bad("timestamp field", edit(manifest, (v) => { v.generatedAt = "2025-01-01T00:00:00Z"; }), "undefined_field", "/generatedAt"),
    bad("missing hash rule", edit(manifest, (v) => { delete v.hashRule; }), "missing_field", "/hashRule"),
  ],
};

// ---------------------------------------------------------------------------------------------
const exprValid = {
  op: "if",
  cond: { op: "gt", left: { op: "input", path: "requests[0].body.count" }, right: { op: "lit", value: 0 } },
  then: {
    op: "add",
    args: [
      { op: "derived", name: "base_cost" },
      { op: "lookup", table: "label_cost", key: { op: "input", path: "requests[0].body.label" } },
    ],
  },
  else: { op: "idiv", left: { op: "lit", value: 7 }, right: { op: "lit", value: 2 }, round: "floor" },
};
const exprSet: FixtureSet = {
  schema: "rule-expression",
  valid: [
    { id: "nested expression", value: exprValid },
    { id: "aggregate with elem", value: { op: "sum", over: "requests[0].body.items", each: { op: "elem", path: "count" } } },
    { id: "is_type on elem", value: { op: "is_type", ref: { op: "elem", path: "" }, type: "int" } },
  ],
  invalid: [
    bad("operator outside the vocabulary", { op: "pow", left: { op: "lit", value: 1 }, right: { op: "lit", value: 2 } }, "schema_violation", ""),
    bad("extra field on lit", { op: "lit", value: 1, note: "x" }, "undefined_field", "/note"),
    bad("fractional literal", { op: "lit", value: 1.5 }, "bad_type", "/value"),
    bad("nary with one argument", { op: "add", args: [{ op: "lit", value: 1 }] }, "bad_value", "/args"),
    bad("bad input path", { op: "input", path: "requests[0]..body" }, "bad_value", "/path"),
    bad("missing round on idiv", edit(exprValid, (v) => { delete v.else.round; }), "missing_field", "/else/round"),
    bad("unknown type name", { op: "is_type", ref: { op: "input", path: "a" }, type: "float" }, "bad_value", "/type"),
    bad("is_type on a literal", { op: "is_type", ref: { op: "lit", value: 1 }, type: "int" }, "schema_violation", "/ref"),
  ],
};

// ---------------------------------------------------------------------------------------------
const citation = { file: "src/widgets.php", startLine: 10, endLine: 12, quote: "if ($count > 0)" };
const citationSet: FixtureSet = {
  schema: "citation",
  valid: [{ id: "range with quote", value: citation }],
  invalid: [
    bad("start line zero", edit(citation, (v) => { v.startLine = 0; }), "bad_value", "/startLine"),
    bad("start line as string", edit(citation, (v) => { v.startLine = "10"; }), "bad_type", "/startLine"),
    bad("missing quote", edit(citation, (v) => { delete v.quote; }), "missing_field", "/quote"),
    bad("empty quote", edit(citation, (v) => { v.quote = ""; }), "bad_value", "/quote"),
    bad("verified flag", edit(citation, (v) => { v.verified = true; }), "undefined_field", "/verified"),
  ],
};

// ---------------------------------------------------------------------------------------------
const claim = {
  localKey: "positive_count_creates",
  condition: {
    description: "The count is above zero",
    expression: { op: "gt", left: { op: "input", path: "requests[0].body.count" }, right: { op: "lit", value: 0 } },
  },
  effect: {
    description: "The widget is created",
    response: {
      step: 0,
      status: { op: "lit", value: 201 },
      fields: [{ path: "data.state", value: { op: "lit", value: "created" } }],
    },
  },
  threshold: "count above zero",
  confidence: "medium",
  openQuestions: ["Is there an upper bound on count?"],
  citations: [citation],
};
const proposal = {
  derived: [{ name: "base_cost", expr: { op: "mul", args: [{ op: "input", path: "requests[0].body.count" }, { op: "lit", value: 3 }] } }],
  tables: [{ name: "label_cost", entries: [{ key: "x", value: 1 }, { key: 2, value: 5 }] }],
  claims: [claim],
};
const proposalSet: FixtureSet = {
  schema: "hypothesis-proposal",
  valid: [
    { id: "full proposal", value: proposal },
    { id: "claims only, no threshold, step last", value: { claims: [edit(claim, (v) => { delete v.threshold; v.effect.response.step = "last"; })] } },
  ],
  invalid: [
    // AI proposal carrying a reserved field (R23.4): each reserved name is an undefined field.
    bad("reserved origin on a claim", edit(proposal, (v) => { v.claims[0].origin = "human-authored"; }), "undefined_field", "/claims/0/origin"),
    bad("reserved evidence on a claim", edit(proposal, (v) => { v.claims[0].evidence = []; }), "undefined_field", "/claims/0/evidence"),
    bad("reserved evidence_status on a claim", edit(proposal, (v) => { v.claims[0].evidence_status = "supported"; }), "undefined_field", "/claims/0/evidence_status"),
    bad("reserved approval on a claim", edit(proposal, (v) => { v.claims[0].approval = "approved"; }), "undefined_field", "/claims/0/approval"),
    bad("reserved approval at top level", edit(proposal, (v) => { v.approval = "approved"; }), "undefined_field", "/approval"),
    bad("reserved field inside a citation", edit(proposal, (v) => { v.claims[0].citations[0].evidence = "supported"; }), "undefined_field", "/claims/0/citations/0/evidence"),
    bad("no claims", { claims: [] }, "bad_value", "/claims"),
    bad("missing citations", edit(proposal, (v) => { delete v.claims[0].citations; }), "missing_field", "/claims/0/citations"),
    bad("six citations", edit(proposal, (v) => { v.claims[0].citations = Array.from({ length: 6 }, () => citation); }), "bad_value", "/claims/0/citations"),
    bad("confidence outside the set", edit(proposal, (v) => { v.claims[0].confidence = "certain"; }), "bad_value", "/claims/0/confidence"),
    bad("empty threshold", edit(proposal, (v) => { v.claims[0].threshold = ""; }), "bad_value", "/claims/0/threshold"),
    bad("null threshold", edit(proposal, (v) => { v.claims[0].threshold = null; }), "bad_type", "/claims/0/threshold"),
    bad("bad response path", edit(proposal, (v) => { v.claims[0].effect.response.fields[0].path = "data..state"; }), "bad_value", "/claims/0/effect/response/fields/0/path"),
    bad("step out of range", edit(proposal, (v) => { v.claims[0].effect.response.step = 10; }), "schema_violation", "/claims/0/effect/response/step"),
    bad("unknown operator in condition", edit(proposal, (v) => { v.claims[0].condition.expression = { op: "pow" }; }), "schema_violation", "/claims/0/condition/expression"),
    // LocalKey is ^[a-z][a-z0-9_]{0,31}$ (M1 review resolution 1): names accepted only by the widened pattern are rejected.
    bad("claim localKey with a capital letter", edit(proposal, (v) => { v.claims[0].localKey = "Positive_count"; }), "bad_value", "/claims/0/localKey"),
    bad("claim localKey with a leading underscore", edit(proposal, (v) => { v.claims[0].localKey = "_positive"; }), "bad_value", "/claims/0/localKey"),
    bad("claim localKey of 33 characters", edit(proposal, (v) => { v.claims[0].localKey = "a".repeat(33); }), "bad_value", "/claims/0/localKey"),
    bad("derived value name with a capital letter", edit(proposal, (v) => { v.derived[0].name = "Base_cost"; }), "bad_value", "/derived/0/name"),
    bad("lookup table name of 33 characters", edit(proposal, (v) => { v.tables[0].name = "t".repeat(33); }), "bad_value", "/tables/0/name"),
  ],
};

// ---------------------------------------------------------------------------------------------
const prediction = { target: { list: "requests", index: 0 }, status: 200, fields: [{ path: "data.state", value: "archived" }] };
const predictionSet: FixtureSet = {
  schema: "prediction",
  valid: [{ id: "status and one field", value: prediction }],
  invalid: [
    bad("status below range", edit(prediction, (v) => { v.status = 99; }), "bad_value", "/status"),
    bad("no expected field", edit(prediction, (v) => { v.fields = []; }), "bad_value", "/fields"),
    bad("target list outside the set", edit(prediction, (v) => { v.target.list = "preparation"; }), "bad_value", "/target/list"),
    bad("index above nine", edit(prediction, (v) => { v.target.index = 10; }), "bad_value", "/target/index"),
    bad("confidence field", edit(prediction, (v) => { v.confidence = "high"; }), "undefined_field", "/confidence"),
  ],
};

// ---------------------------------------------------------------------------------------------
const experiment = {
  localKey: "try_small_batch",
  target: { kind: "claim", id: "clm-0001" },
  preparation: [{ kind: "widget_exists", bind: "w1", params: { label: "x", count: 1 } }],
  requests: [{ method: "POST", path: "/widgets/{id}/archive", pathParams: { id: { $bind: "w1" } } }],
  stateChecks: [{ method: "GET", path: "/widgets" }],
  prediction,
};
const withPath = (p: string): unknown => edit(experiment, (v) => { v.requests[0].path = p; });
const experimentSet: FixtureSet = {
  schema: "experiment",
  valid: [
    { id: "one request with preparation and bound parameter", value: experiment },
    { id: "minimal", value: { localKey: "e1", target: { kind: "hypothesis", id: "hyp-1" }, requests: [{ method: "GET", path: "/widgets" }], prediction } },
  ],
  invalid: [
    bad("experiment localKey with a capital letter", edit(experiment, (v) => { v.localKey = "Try_small_batch"; }), "bad_value", "/localKey"),
    bad("experiment localKey of 33 characters", edit(experiment, (v) => { v.localKey = "e".repeat(33); }), "bad_value", "/localKey"),
    bad("preparation bind with a capital letter", edit(experiment, (v) => { v.preparation[0].bind = "W1"; }), "bad_value", "/preparation/0/bind"),
    bad("reset operation", withPath("/reset"), "schema_violation", "/requests/0/path"),
    bad("reset in another case", withPath("/Reset"), "schema_violation", "/requests/0/path"),
    bad("test namespace", withPath("/test/widgets/1/ship"), "schema_violation", "/requests/0/path"),
    bad("test namespace in another case", withPath("/TEST/x"), "schema_violation", "/requests/0/path"),
    bad("absolute URL", withPath("http://127.0.0.1:8056/widgets"), "bad_value", "/requests/0/path"),
    bad("protocol-relative URL", withPath("//host/widgets"), "schema_violation", "/requests/0/path"),
    bad("dot segment", withPath("/widgets/../reset"), "schema_violation", "/requests/0/path"),
    bad("query in path", withPath("/widgets?x=1"), "bad_value", "/requests/0/path"),
    bad("reset in a state check", edit(experiment, (v) => { v.stateChecks[0].path = "/reset"; }), "schema_violation", "/stateChecks/0/path"),
    bad("method outside GET and POST", edit(experiment, (v) => { v.requests[0].method = "DELETE"; }), "bad_value", "/requests/0/method"),
    bad("preparation step with a method field", edit(experiment, (v) => { v.preparation[0].method = "POST"; }), "undefined_field", "/preparation/0/method"),
    bad("preparation step with a path field", edit(experiment, (v) => { v.preparation[0].path = "/widgets"; }), "undefined_field", "/preparation/0/path"),
    bad("preparation step with a url field", edit(experiment, (v) => { v.preparation[0].url = "http://x"; }), "undefined_field", "/preparation/0/url"),
    bad("preparation step with a header field", edit(experiment, (v) => { v.preparation[0].headers = {}; }), "undefined_field", "/preparation/0/headers"),
    bad("method smuggled in params", edit(experiment, (v) => { v.preparation[0].params.Method = "POST"; }), "schema_violation", "/preparation/0/params"),
    bad("path smuggled in params", edit(experiment, (v) => { v.preparation[0].params.path = "/reset"; }), "schema_violation", "/preparation/0/params"),
    bad("nested params", edit(experiment, (v) => { v.preparation[0].params.inner = { a: 1 }; }), "bad_type", "/preparation/0/params/inner"),
    bad("preparation kind reset", edit(experiment, (v) => { v.preparation[0].kind = "reset"; }), "schema_violation", "/preparation/0/kind"),
    bad("preparation kind in the test namespace", edit(experiment, (v) => { v.preparation[0].kind = "test_ship"; }), "schema_violation", "/preparation/0/kind"),
    bad("no request", edit(experiment, (v) => { v.requests = []; }), "bad_value", "/requests"),
    bad("eleven requests", edit(experiment, (v) => { v.requests = Array.from({ length: 11 }, () => ({ method: "GET", path: "/widgets" })); }), "bad_value", "/requests"),
    bad("missing prediction", edit(experiment, (v) => { delete v.prediction; }), "missing_field", "/prediction"),
    bad("target kind outside the set", edit(experiment, (v) => { v.target.kind = "order"; }), "bad_value", "/target/kind"),
    bad("expected result field", edit(experiment, (v) => { v.expected = {}; }), "undefined_field", "/expected"),
  ],
};

// ---------------------------------------------------------------------------------------------
const observation = {
  experimentId: "exp-0001",
  outcome: "executed",
  preparation: [{ stepIndex: 0, operation: "widget_exists", status: 201 }],
  responses: [{ status: 200, bodyKind: "json", body: { data: { state: "archived" } } }],
  stateChecks: [{ status: 200, bodyKind: "empty" }],
  maskSha256: h("c"),
};
const observationSet: FixtureSet = {
  schema: "observation",
  valid: [
    { id: "executed", value: observation },
    { id: "not executed", value: { experimentId: "exp-0002", outcome: "not_executed", notExecuted: { reason: "policy_rejected", step: 1 }, preparation: [], responses: [], stateChecks: [], maskSha256: h("c") } },
  ],
  invalid: [
    bad("outcome outside the set", edit(observation, (v) => { v.outcome = "done"; }), "bad_value", "/outcome"),
    bad("missing mask hash", edit(observation, (v) => { delete v.maskSha256; }), "missing_field", "/maskSha256"),
    bad("short mask hash", edit(observation, (v) => { v.maskSha256 = "abc"; }), "bad_value", "/maskSha256"),
    bad("body kind outside the set", edit(observation, (v) => { v.responses[0].bodyKind = "xml"; }), "bad_value", "/responses/0/bodyKind"),
    bad("timestamp field", edit(observation, (v) => { v.observedAt = "2025-01-01T00:00:00Z"; }), "undefined_field", "/observedAt"),
    bad("abort reason outside the set", edit(observation, (v) => { v.abortReason = "network"; }), "bad_value", "/abortReason"),
  ],
};

// ---------------------------------------------------------------------------------------------
const comparison = {
  experimentId: "exp-0001",
  result: "mismatch",
  differences: [{ path: "$status", predicted: 200, observed: 404 }],
  maskSha256: h("c"),
};
const comparisonSet: FixtureSet = {
  schema: "comparison-result",
  valid: [
    { id: "mismatch with a status difference", value: comparison },
    { id: "not comparable with a reason", value: { experimentId: "exp-0001", result: "not_comparable", reason: "timed_out", differences: [], maskSha256: h("c") } },
  ],
  invalid: [
    bad("result outside the set", edit(comparison, (v) => { v.result = "equal"; }), "bad_value", "/result"),
    bad("missing differences", edit(comparison, (v) => { delete v.differences; }), "missing_field", "/differences"),
    bad("difference without observed", edit(comparison, (v) => { delete v.differences[0].observed; }), "missing_field", "/differences/0/observed"),
    bad("reason outside the set", edit(comparison, (v) => { v.reason = "unknown"; }), "bad_value", "/reason"),
    bad("score field", edit(comparison, (v) => { v.score = 1; }), "undefined_field", "/score"),
  ],
};

// ---------------------------------------------------------------------------------------------
const sourceEvidence = {
  evidenceId: "evd-0001",
  kind: "source",
  claimRevisionId: "clm-0001-r1",
  citationRecordId: "rec-000007",
  citations: [{ index: 0, result: "verified" }, { index: 1, result: "failed", reason: "quote_not_found" }],
};
const experimentEvidence = {
  evidenceId: "evd-0002",
  kind: "experiment",
  claimRevisionId: "clm-0001-r1",
  outcome: "supports",
  experimentId: "exp-0001",
  comparisonRecordId: "rec-000012",
  observationRecordId: "rec-000011",
  predictionRecordId: "rec-000009",
};
const evidenceSet: FixtureSet = {
  schema: "evidence",
  valid: [
    { id: "source record with per-citation results", value: sourceEvidence },
    { id: "experiment record with outcome and linked ids", value: experimentEvidence },
    { id: "experiment record, inconclusive", value: edit(experimentEvidence, (v) => { v.outcome = "inconclusive"; }) },
  ],
  invalid: [
    bad("source record with an experiment field", edit(sourceEvidence, (v) => { v.experimentId = "exp-0001"; }), "schema_violation", ""),
    bad("source record with a comparison link", edit(sourceEvidence, (v) => { v.comparisonRecordId = "rec-000012"; }), "schema_violation", ""),
    bad("source record with an outcome", edit(sourceEvidence, (v) => { v.outcome = "supports"; }), "schema_violation", ""),
    bad("source record without citations", edit(sourceEvidence, (v) => { delete v.citations; }), "missing_field", "/citations"),
    bad("source record without its record id", edit(sourceEvidence, (v) => { delete v.citationRecordId; }), "missing_field", "/citationRecordId"),
    bad("experiment record with citations", edit(experimentEvidence, (v) => { v.citations = [{ index: 0, result: "verified" }]; }), "schema_violation", ""),
    bad("experiment record with a citation record id", edit(experimentEvidence, (v) => { v.citationRecordId = "rec-000007"; }), "schema_violation", ""),
    bad("experiment record without outcome", edit(experimentEvidence, (v) => { delete v.outcome; }), "missing_field", "/outcome"),
    bad("experiment record without observation link", edit(experimentEvidence, (v) => { delete v.observationRecordId; }), "missing_field", "/observationRecordId"),
    bad("experiment outcome outside the set", edit(experimentEvidence, (v) => { v.outcome = "confirmed"; }), "bad_value", "/outcome"),
    bad("kind approval", edit(sourceEvidence, (v) => { v.kind = "approval"; }), "bad_value", "/kind"),
    bad("kind human", edit(experimentEvidence, (v) => { v.kind = "human"; }), "bad_value", "/kind"),
    bad("missing kind", edit(sourceEvidence, (v) => { delete v.kind; }), "missing_field", "/kind"),
    bad("failed citation without a reason", edit(sourceEvidence, (v) => { delete v.citations[1].reason; }), "missing_field", "/citations/1/reason"),
    bad("verified citation with a reason", edit(sourceEvidence, (v) => { v.citations[0].reason = "quote_not_found"; }), "schema_violation", "/citations/0"),
    bad("status field", edit(sourceEvidence, (v) => { v.status = "supported"; }), "undefined_field", "/status"),
  ],
};

// ---------------------------------------------------------------------------------------------
const envelope = (kind: string, payload: unknown): Record<string, unknown> => ({
  schemaVersion: 1,
  seq: 2,
  id: "rec-000002",
  kind,
  prevHash: GENESIS,
  payload,
  hash: h("d"),
});
const discarded = envelope("ai_content_discarded", { aiOutputRecordId: "rec-000001", fields: [{ path: "/claims/0", name: "origin" }] });
const rejection = envelope("store_rejection", { attempt: "set_origin", component: "orchestrator", targetRecordId: "rec-000001", reason: "origin is immutable" });
const secretRejection = envelope("store_rejection", { attempt: "secret_pattern", component: "evidence-store", patternId: "api-key-v1", reason: "record contains a secret pattern" });
const envelopeSet: FixtureSet = {
  schema: "record-envelope",
  valid: [
    { id: "generic record", value: envelope("run_started", {}) },
    { id: "ai_content_discarded names the field only", value: discarded },
    { id: "store_rejection for an origin change", value: rejection },
    { id: "store_rejection for a secret names the pattern id", value: secretRejection },
  ],
  invalid: [
    bad("kind approval", envelope("approval", {}), "bad_value", "/kind"),
    bad("sequence zero", edit(envelope("run_started", {}), (v) => { v.seq = 0; }), "bad_value", "/seq"),
    bad("id without padding", edit(envelope("run_started", {}), (v) => { v.id = "rec-2"; }), "bad_value", "/id"),
    bad("short previous hash", edit(envelope("run_started", {}), (v) => { v.prevHash = "0"; }), "bad_value", "/prevHash"),
    bad("missing hash", edit(envelope("run_started", {}), (v) => { delete v.hash; }), "missing_field", "/hash"),
    bad("timestamp field", edit(envelope("run_started", {}), (v) => { v.at = "now"; }), "undefined_field", "/at"),
    bad("payload is not an object", edit(envelope("run_started", {}), (v) => { v.payload = []; }), "bad_type", "/payload"),
    bad("discarded record carries the value", edit(discarded, (v) => { v.payload.fields[0].value = "human-authored"; }), "undefined_field", "/payload/fields/0/value"),
    bad("discarded record without fields", edit(discarded, (v) => { v.payload.fields = []; }), "bad_value", "/payload/fields"),
    bad("rejection of a secret without a pattern id", edit(secretRejection, (v) => { delete v.payload.patternId; }), "missing_field", "/payload/patternId"),
    bad("rejection carries the matched value", edit(secretRejection, (v) => { v.payload.matched = "sk-xxxx"; }), "undefined_field", "/payload/matched"),
    bad("rejection attempt outside the set", edit(rejection, (v) => { v.payload.attempt = "rename"; }), "bad_value", "/payload/attempt"),
  ],
};

// ---------------------------------------------------------------------------------------------
const approval = {
  type: "approval",
  seq: 3,
  prev_hash: h("e"),
  approver: "Reviewer One",
  timestamp: "2025-01-01T12:00:00.000+09:00",
  target: { kind: "claim_revision", run_id: "run-0001", claim_revision_id: "clm-0001-r2" },
  decision: "approved",
  rationale: "Checked against the cited lines.",
  recorded_by: "human",
  supersedes: 2,
  hash: h("f"),
};
const approvalSet: FixtureSet = {
  schema: "approval-record",
  valid: [
    { id: "claim revision approval superseding an earlier record", value: approval },
    { id: "run approval", value: edit(approval, (v) => { v.target = { kind: "run", run_id: "run-0001" }; delete v.supersedes; v.recorded_by = "kiro-development-agent"; }) },
    { id: "gate approval", value: edit(approval, (v) => { v.target = { kind: "gate", gate_id: "override-apply" }; delete v.supersedes; v.timestamp = "2025-01-01T03:00:00Z"; }) },
    { id: "gate approval of the M0 checkpoint exception (R21.20)", value: edit(approval, (v) => { v.target = { kind: "gate", gate_id: "m0-checkpoint-exception" }; delete v.supersedes; v.timestamp = "2026-11-14T12:00:00+09:00"; }) },
    { id: "store_rejection line", value: { type: "store_rejection", seq: 4, prev_hash: h("f"), reason: "modify request refused", attempted_seq: 2, hash: h("1") } },
  ],
  invalid: [
    bad("recorded_by outside the two actors", edit(approval, (v) => { v.recorded_by = "ai"; }), "bad_value", "/recorded_by"),
    bad("decision outside the set", edit(approval, (v) => { v.decision = "maybe"; }), "bad_value", "/decision"),
    bad("gate id not defined", edit(approval, (v) => { v.target = { kind: "gate", gate_id: "deploy" }; }), "bad_value", "/target/gate_id"),
    bad("gate id close to the exception gate but not defined", edit(approval, (v) => { v.target = { kind: "gate", gate_id: "m0-checkpoint" }; }), "bad_value", "/target/gate_id"),
    bad("gate id of the exception gate in upper case", edit(approval, (v) => { v.target = { kind: "gate", gate_id: "M0-CHECKPOINT-EXCEPTION" }; }), "bad_value", "/target/gate_id"),
    bad("blank rationale", edit(approval, (v) => { v.rationale = "   "; }), "bad_value", "/rationale"),
    bad("empty rationale", edit(approval, (v) => { v.rationale = ""; }), "bad_value", "/rationale"),
    bad("rationale over 2000 characters", edit(approval, (v) => { v.rationale = "x".repeat(2001); }), "bad_value", "/rationale"),
    bad("empty approver", edit(approval, (v) => { v.approver = ""; }), "bad_value", "/approver"),
    bad("approver over 100 characters", edit(approval, (v) => { v.approver = "a".repeat(101); }), "bad_value", "/approver"),
    bad("timestamp without offset", edit(approval, (v) => { v.timestamp = "2025-01-01T12:00:00"; }), "bad_value", "/timestamp"),
    bad("missing recorded_by", edit(approval, (v) => { delete v.recorded_by; }), "missing_field", "/recorded_by"),
    bad("claim target without run id", edit(approval, (v) => { delete v.target.run_id; }), "missing_field", "/target/run_id"),
    bad("target with two kinds of identifier", edit(approval, (v) => { v.target.gate_id = "m6-start"; }), "undefined_field", "/target/gate_id"),
    bad("target kind outside the set", edit(approval, (v) => { v.target = { kind: "hypothesis", run_id: "run-0001" }; }), "schema_violation", "/target"),
    bad("record type outside the set", edit(approval, (v) => { v.type = "approval_note"; }), "schema_violation", ""),
    bad("evidence status field", edit(approval, (v) => { v.evidence_status = "supported"; }), "undefined_field", "/evidence_status"),
    bad("supersedes zero", edit(approval, (v) => { v.supersedes = 0; }), "bad_value", "/supersedes"),
    bad("store_rejection line with approval content", { type: "store_rejection", seq: 4, prev_hash: h("f"), reason: "x", decision: "approved", hash: h("1") }, "undefined_field", "/decision"),
  ],
};

// ---------------------------------------------------------------------------------------------
const runManifest = {
  schemaVersion: 1,
  runId: "run-0001",
  wallClock: { startedAt: "2025-01-01T00:00:00Z", finishedAt: "2025-01-01T00:10:00Z" },
  excludedFields: ["runId", "wallClock"],
  terminationReason: "iteration_limit_reached",
  finalHypothesisRevision: "hyp-1-r2",
  config: { schemaVersion: 1, provider: "mock" },
  limitsUsed: { iterations: 3, acceptedExperiments: 4, rejectedExperiments: 1 },
  provider: { id: "mock", version: "1", model: "none", isMock: true },
  toolVersions: { node: "v0.0.0", npm: "0.0.0", dependencies: { ajv: "0.0.0" }, runtimeImageDigest: `sha256:${h("2")}` },
  sourceBundle: manifest,
  legacyStartState: { identity: h("3") },
  envVarsRead: [{ name: "EXAMPLE_NAME", set: false }],
  payload_audit: { configCheck: "pass", audits: 2, passed: 2, blocked: 0, auditConfigSha256: h("4") },
  ground_truth_access_denial: { status: "verified", executedInThisRun: true, checks: ["read_denial", "mount_inspection"] },
  isolationChecks: [{ id: "net-none", status: "verified", measuredBy: "launcher", measured: { routes: [] } }],
  mutualExclusion: { mode: "mechanical", lease: { nonceSha256: h("5"), launcherPid: 100, heartbeatIntervalMs: 1000, staleAfterMs: 5000 } },
  aiSandbox: { safetyStatus: "not_applicable", permittedDestinations: [] },
  residualRisks: [{ id: "risk-1", status: "unresolved" }],
  chain: { records: 12, lastHash: h("6") },
  artifacts: [{ path: "records.jsonl", sha256: h("7") }, { path: "blobs/" + h("8"), sha256: h("8") }],
};
const manifestRunSet: FixtureSet = {
  schema: "run-manifest",
  valid: [
    { id: "mechanical mutual exclusion", value: runManifest },
    { id: "attestation mutual exclusion", value: edit(runManifest, (v) => { v.mutualExclusion = { mode: "attestation", attestation: { approver: "Reviewer One", timestamp: "2025-01-01T00:00:00Z" } }; }) },
  ],
  invalid: [
    bad("termination reason outside the set", edit(runManifest, (v) => { v.terminationReason = "done"; }), "bad_value", "/terminationReason"),
    bad("missing chain", edit(runManifest, (v) => { delete v.chain; }), "missing_field", "/chain"),
    bad("approval list in the manifest", edit(runManifest, (v) => { v.approvals = []; }), "undefined_field", "/approvals"),
    bad("access denial not executed in this Run", edit(runManifest, (v) => { v.ground_truth_access_denial.executedInThisRun = false; }), "bad_value", "/ground_truth_access_denial/executedInThisRun"),
    bad("mechanical mode without lease", edit(runManifest, (v) => { delete v.mutualExclusion.lease; }), "missing_field", "/mutualExclusion/lease"),
    bad("attestation mode without attestation", edit(runManifest, (v) => { v.mutualExclusion = { mode: "attestation" }; }), "missing_field", "/mutualExclusion/attestation"),
    bad("image digest without prefix", edit(runManifest, (v) => { v.toolVersions.runtimeImageDigest = h("2"); }), "bad_value", "/toolVersions/runtimeImageDigest"),
    bad("artifact without hash", edit(runManifest, (v) => { delete v.artifacts[0].sha256; }), "missing_field", "/artifacts/0/sha256"),
    bad("canary field in payload audit", edit(runManifest, (v) => { v.payload_audit.canary = "x"; }), "undefined_field", "/payload_audit/canary"),
    bad("source bundle with a byte count", edit(runManifest, (v) => { v.sourceBundle.files[0].bytes = 1; }), "undefined_field", "/sourceBundle/files/0/bytes"),
  ],
};

// ---------------------------------------------------------------------------------------------
export const FIXTURE_SETS: readonly FixtureSet[] = [
  factsSet,
  manifestSet,
  exprSet,
  citationSet,
  proposalSet,
  predictionSet,
  experimentSet,
  observationSet,
  comparisonSet,
  evidenceSet,
  envelopeSet,
  approvalSet,
  manifestRunSet,
];
