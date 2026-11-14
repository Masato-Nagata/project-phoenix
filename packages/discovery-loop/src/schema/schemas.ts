// JSON Schema (draft 2020-12) definitions of the discovery-loop data model (design: "Data Models").
// Every closed object sets additionalProperties:false (R4.3, R17.6). Schemas are plain data so they
// compile into dist without a JSON import. Cross references use the `$id` values of the design.
//
// Neutral by construction: no field name, enumeration value or example here names a business rule
// of the legacy app (R7.6).
import type { SchemaName } from "./types.js";

type Schema = Record<string, unknown>;

const DRAFT = "https://json-schema.org/draft/2020-12/schema";

const COMMON = "common.schema.json";
const EXPR = "rule-expression.schema.json";

const common = (name: string): Schema => ({ $ref: `${COMMON}#/$defs/${name}` });
const expr = (name: string): Schema => ({ $ref: `${EXPR}#/$defs/${name}` });

/** Case-insensitive regex fragment for a lowercase ASCII word (JSON Schema patterns have no flags). */
function ci(word: string): string {
  return [...word].map((c) => `[${c}${c.toUpperCase()}]`).join("");
}

const PATH_PATTERN = "^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*|\\[[0-9]{1,4}\\])*$";
const ELEM_PATH_PATTERN = "^$|^[A-Za-z_][A-Za-z0-9_]*(\\.[A-Za-z_][A-Za-z0-9_]*|\\[[0-9]{1,4}\\])*$";

/**
 * Names usable as LocalKey, derived-value and table names (M1 review resolution 1). Equal to the analyzer's
 * Rule_Expression_Language name pattern (packages/analyzer/src/expr/validate.ts NAME_RE); a test asserts it.
 */
export const LOCAL_KEY_PATTERN = "^[a-z][a-z0-9_]{0,31}$";

// ---------------------------------------------------------------------------------------------
const commonSchema: Schema = {
  $schema: DRAFT,
  $id: COMMON,
  $defs: {
    Sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    Id: { type: "string", pattern: "^[a-z][a-z0-9-]{0,63}$" },
    LocalKey: { type: "string", pattern: LOCAL_KEY_PATTERN },
    Scalar: {
      type: ["integer", "string", "boolean", "null"],
      minimum: -9007199254740991,
      maximum: 9007199254740991,
      maxLength: 256,
    },
    Origin: { enum: ["ai-inferred", "human-authored"] },
    EvidenceKind: { enum: ["source", "experiment"] },
    EvidenceStatus: { enum: ["absent", "supported", "contradicted", "mixed"] },
    ApprovalStatus: { enum: ["none", "approved", "rejected", "needs_changes"] },
    ApprovalDecision: { enum: ["approved", "rejected", "needs_changes"] },
    Facts: {
      description: "The four facts of one Claim revision. Four separate values, never merged (R6.10)",
      type: "object",
      additionalProperties: false,
      required: ["claimRevisionId", "origin", "sourceEvidenceStatus", "experimentEvidenceStatus", "approvalStatus"],
      properties: {
        claimRevisionId: { $ref: "#/$defs/Id" },
        origin: { $ref: "#/$defs/Origin" },
        sourceEvidenceStatus: { $ref: "#/$defs/EvidenceStatus" },
        experimentEvidenceStatus: { $ref: "#/$defs/EvidenceStatus" },
        approvalStatus: { $ref: "#/$defs/ApprovalStatus" },
      },
    },
  },
};

/** Root schema for the Facts definition of the common definitions, so that it can be validated by name. */
const factsSchema: Schema = {
  $schema: DRAFT,
  $id: "facts.schema.json",
  $ref: `${COMMON}#/$defs/Facts`,
};

// ---------------------------------------------------------------------------------------------
const sourceBundleManifest: Schema = {
  $schema: DRAFT,
  $id: "source-bundle-manifest.schema.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "hashRule", "files"],
  properties: {
    schemaVersion: { const: 1 },
    hashRule: { const: "sha256 over UTF-8 bytes after CRLF and lone CR are replaced by LF" },
    files: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "sha256Lf"],
        properties: {
          // Relative, forward-slash path with no dot segment. The exact allowlist comparison is made by the bundler.
          path: {
            type: "string",
            minLength: 1,
            maxLength: 256,
            pattern: "^[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$",
            not: { type: "string", pattern: "(^|/)\\.{1,2}(/|$)" },
          },
          sha256Lf: common("Sha256"),
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
const exprDef = (extra: Schema): Schema => ({ type: "object", additionalProperties: false, ...extra });
const ruleExpression: Schema = {
  $schema: DRAFT,
  $id: EXPR,
  description: "Root validates one expression; other schemas reference the Expr definition.",
  $ref: "#/$defs/Expr",
  $defs: {
    InputPath: { type: "string", pattern: PATH_PATTERN, maxLength: 128 },
    ElemPath: { type: "string", pattern: ELEM_PATH_PATTERN, maxLength: 128 },
    Expr: {
      type: "object",
      discriminator: { propertyName: "op" },
      oneOf: [
        "Lit", "Input", "Elem", "Derived", "Lookup", "Nary", "Binary", "Idiv", "Not", "If", "IsType", "Sum", "Count",
      ].map((n) => ({ $ref: `#/$defs/${n}` })),
    },
    Lit: exprDef({
      required: ["op", "value"],
      properties: { op: { const: "lit" }, value: common("Scalar") },
    }),
    Input: exprDef({
      required: ["op", "path"],
      properties: { op: { const: "input" }, path: { $ref: "#/$defs/InputPath" } },
    }),
    Elem: exprDef({
      required: ["op", "path"],
      properties: { op: { const: "elem" }, path: { $ref: "#/$defs/ElemPath" } },
    }),
    Derived: exprDef({
      required: ["op", "name"],
      properties: { op: { const: "derived" }, name: common("LocalKey") },
    }),
    Lookup: exprDef({
      required: ["op", "table", "key"],
      properties: { op: { const: "lookup" }, table: common("LocalKey"), key: { $ref: "#/$defs/Expr" } },
    }),
    Nary: exprDef({
      required: ["op", "args"],
      properties: {
        op: { enum: ["add", "mul", "and", "or"] },
        args: { type: "array", minItems: 2, maxItems: 16, items: { $ref: "#/$defs/Expr" } },
      },
    }),
    Binary: exprDef({
      required: ["op", "left", "right"],
      properties: {
        op: { enum: ["sub", "eq", "ne", "lt", "le", "gt", "ge"] },
        left: { $ref: "#/$defs/Expr" },
        right: { $ref: "#/$defs/Expr" },
      },
    }),
    Idiv: exprDef({
      required: ["op", "left", "right", "round"],
      properties: {
        op: { const: "idiv" },
        left: { $ref: "#/$defs/Expr" },
        right: { $ref: "#/$defs/Expr" },
        round: { enum: ["floor", "trunc", "ceil"] },
      },
    }),
    Not: exprDef({
      required: ["op", "arg"],
      properties: { op: { const: "not" }, arg: { $ref: "#/$defs/Expr" } },
    }),
    If: exprDef({
      required: ["op", "cond", "then", "else"],
      properties: {
        op: { const: "if" },
        cond: { $ref: "#/$defs/Expr" },
        then: { $ref: "#/$defs/Expr" },
        else: { $ref: "#/$defs/Expr" },
      },
    }),
    IsType: exprDef({
      required: ["op", "ref", "type"],
      properties: {
        op: { const: "is_type" },
        ref: {
          type: "object",
          discriminator: { propertyName: "op" },
          oneOf: [{ $ref: "#/$defs/Input" }, { $ref: "#/$defs/Elem" }],
        },
        type: { enum: ["int", "real", "string", "bool", "null", "array", "object", "missing"] },
      },
    }),
    Sum: exprDef({
      required: ["op", "over", "each"],
      properties: { op: { const: "sum" }, over: { $ref: "#/$defs/InputPath" }, each: { $ref: "#/$defs/Expr" } },
    }),
    Count: exprDef({
      required: ["op", "over"],
      properties: { op: { const: "count" }, over: { $ref: "#/$defs/InputPath" }, where: { $ref: "#/$defs/Expr" } },
    }),
  },
};

// ---------------------------------------------------------------------------------------------
const citation: Schema = {
  $schema: DRAFT,
  $id: "citation.schema.json",
  type: "object",
  additionalProperties: false,
  required: ["file", "startLine", "endLine", "quote"],
  properties: {
    file: { type: "string", minLength: 1, maxLength: 256 },
    startLine: { type: "integer", minimum: 1 },
    endLine: { type: "integer", minimum: 1 },
    quote: { type: "string", minLength: 1, maxLength: 4000 },
  },
};

// ---------------------------------------------------------------------------------------------
const responseField = {
  type: "object",
  additionalProperties: false,
  required: ["path", "value"],
  properties: { path: { $ref: "#/$defs/ResponsePath" }, value: expr("Expr") },
};
const description = (max: number): Schema => ({ type: "string", minLength: 1, maxLength: max });

const hypothesisProposal: Schema = {
  $schema: DRAFT,
  $id: "hypothesis-proposal.schema.json",
  description:
    "AI-facing proposal form. It defines no origin, evidence, evidence_status or approval field at any level (R23.4).",
  type: "object",
  additionalProperties: false,
  required: ["claims"],
  properties: {
    derived: { type: "array", maxItems: 32, items: { $ref: "#/$defs/DerivedValue" } },
    tables: { type: "array", maxItems: 16, items: { $ref: "#/$defs/LookupTable" } },
    claims: { type: "array", minItems: 1, maxItems: 50, items: { $ref: "#/$defs/Claim" } },
  },
  $defs: {
    DerivedValue: {
      type: "object",
      additionalProperties: false,
      required: ["name", "expr"],
      properties: { name: common("LocalKey"), expr: expr("Expr") },
    },
    LookupTable: {
      type: "object",
      additionalProperties: false,
      required: ["name", "entries"],
      properties: {
        name: common("LocalKey"),
        entries: {
          type: "array",
          minItems: 1,
          maxItems: 64,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["key", "value"],
            properties: {
              key: { type: ["integer", "string"], maxLength: 256 },
              value: common("Scalar"),
            },
          },
        },
      },
    },
    ResponsePath: { type: "string", pattern: PATH_PATTERN },
    Claim: {
      type: "object",
      additionalProperties: false,
      required: ["localKey", "condition", "effect", "confidence", "openQuestions", "citations"],
      properties: {
        localKey: common("LocalKey"),
        revises: common("Id"),
        condition: {
          type: "object",
          additionalProperties: false,
          required: ["description", "expression"],
          properties: { description: description(1000), expression: expr("Expr") },
        },
        effect: {
          type: "object",
          additionalProperties: false,
          required: ["description", "response"],
          properties: {
            description: description(1000),
            response: {
              type: "object",
              additionalProperties: false,
              required: ["status", "fields"],
              properties: {
                step: {
                  description: "Index of the request the response belongs to, or the string last (the default)",
                  anyOf: [{ type: "integer", minimum: 0, maximum: 9 }, { const: "last" }],
                },
                status: expr("Expr"),
                fields: { type: "array", maxItems: 32, items: responseField },
              },
            },
          },
        },
        threshold: description(200),
        confidence: { enum: ["low", "medium", "high"] },
        openQuestions: { type: "array", maxItems: 20, items: description(500) },
        citations: { type: "array", minItems: 1, maxItems: 5, items: { $ref: "citation.schema.json" } },
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
const prediction: Schema = {
  $schema: DRAFT,
  $id: "prediction.schema.json",
  type: "object",
  additionalProperties: false,
  required: ["target", "status", "fields"],
  properties: {
    target: {
      type: "object",
      additionalProperties: false,
      required: ["list", "index"],
      properties: {
        list: { enum: ["requests", "stateChecks"] },
        index: { type: "integer", minimum: 0, maximum: 9 },
      },
    },
    status: { type: "integer", minimum: 100, maximum: 599 },
    fields: {
      type: "array",
      minItems: 1,
      maxItems: 32,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "value"],
        properties: { path: { type: "string", minLength: 1, maxLength: 128 }, value: {} },
      },
    },
  },
};

// Names a preparation step may not use as a parameter key: it must never carry a method, path, URL or header (R7.3).
const FORBIDDEN_PARAM_KEYS = ["method", "path", "url", "uri", "header", "headers", "host"];
const forbiddenParamKeyPattern = `^(?:${FORBIDDEN_PARAM_KEYS.map(ci).join("|")})$`;
// Names a preparation step kind may not use: the reset operation and the test namespace (R7.5).
const forbiddenKindPattern = `^(?:${ci("reset")}|${ci("test")})(?:_|$)`;

const experiment: Schema = {
  $schema: DRAFT,
  $id: "experiment.schema.json",
  type: "object",
  additionalProperties: false,
  required: ["localKey", "target", "requests", "prediction"],
  properties: {
    localKey: common("LocalKey"),
    target: {
      type: "object",
      additionalProperties: false,
      required: ["kind", "id"],
      properties: { kind: { enum: ["claim", "hypothesis"] }, id: common("Id") },
    },
    preparation: { type: "array", maxItems: 10, items: { $ref: "#/$defs/PrepStep" } },
    requests: { type: "array", minItems: 1, maxItems: 10, items: { $ref: "#/$defs/RequestSpec" } },
    stateChecks: { type: "array", maxItems: 5, items: { $ref: "#/$defs/RequestSpec" } },
    prediction: { $ref: "prediction.schema.json" },
  },
  $defs: {
    RequestPath: {
      description:
        "Relative path only: no scheme, host, query, fragment, percent-encoding or dot segment, and never the reset operation or the test namespace (R7.5, R8). The policy checks the rules again.",
      type: "string",
      minLength: 1,
      maxLength: 128,
      pattern: "^/[A-Za-z0-9_{}./-]*$",
      allOf: [
        { not: { type: "string", pattern: "^//" } },
        { not: { type: "string", pattern: `^/${ci("reset")}(?:/|$)` } },
        { not: { type: "string", pattern: `^/${ci("test")}(?:/|$)` } },
        { not: { type: "string", pattern: "(?:^|/)\\.{1,2}(?:/|$)" } },
      ],
    },
    RequestSpec: {
      type: "object",
      additionalProperties: false,
      required: ["method", "path"],
      properties: {
        method: { enum: ["GET", "POST"] },
        path: { $ref: "#/$defs/RequestPath" },
        pathParams: { type: "object", maxProperties: 4, additionalProperties: { $ref: "#/$defs/ParamValue" } },
        headers: { type: "object", maxProperties: 4, additionalProperties: { type: "string", maxLength: 128 } },
        body: { description: "any JSON value; serialized canonically by the runner" },
      },
    },
    ParamValue: {
      oneOf: [
        { type: "integer", minimum: 1, maximum: 2147483647 },
        {
          type: "object",
          additionalProperties: false,
          required: ["$bind"],
          properties: { $bind: common("LocalKey") },
        },
      ],
    },
    PrepStep: {
      description:
        "Declarative starting state. No method, path, URL or header field exists here (R7.3); the kind is resolved by the runner-owned table.",
      type: "object",
      additionalProperties: false,
      required: ["kind", "params"],
      properties: {
        kind: { allOf: [common("LocalKey"), { not: { type: "string", pattern: forbiddenKindPattern } }] },
        bind: common("LocalKey"),
        params: {
          type: "object",
          maxProperties: 16,
          propertyNames: { not: { type: "string", pattern: forbiddenParamKeyPattern } },
          additionalProperties: common("Scalar"),
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
const observation: Schema = {
  $schema: DRAFT,
  $id: "observation.schema.json",
  type: "object",
  additionalProperties: false,
  required: ["experimentId", "outcome", "preparation", "responses", "stateChecks", "maskSha256"],
  properties: {
    experimentId: common("Id"),
    outcome: { enum: ["executed", "timed_out", "aborted", "not_executed"] },
    abortReason: { enum: ["lease_unavailable", "address_not_allowed"] },
    notExecuted: {
      type: "object",
      additionalProperties: false,
      required: ["reason"],
      properties: {
        reason: { type: "string" },
        step: { type: "integer" },
        detail: { type: "string", maxLength: 500 },
      },
    },
    preparation: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["stepIndex", "operation", "status"],
        properties: { stepIndex: { type: "integer" }, operation: { type: "string" }, status: { type: "integer" } },
      },
    },
    responses: { type: "array", items: { $ref: "#/$defs/Resp" } },
    stateChecks: { type: "array", items: { $ref: "#/$defs/Resp" } },
    maskSha256: common("Sha256"),
  },
  $defs: {
    Resp: {
      type: "object",
      additionalProperties: false,
      required: ["status", "bodyKind"],
      properties: {
        status: { type: "integer" },
        bodyKind: { enum: ["json", "text", "empty"] },
        body: { description: "masked parsed JSON when bodyKind is json; masked text otherwise" },
      },
    },
  },
};

const comparisonResult: Schema = {
  $schema: DRAFT,
  $id: "comparison-result.schema.json",
  type: "object",
  additionalProperties: false,
  required: ["experimentId", "result", "differences", "maskSha256"],
  properties: {
    experimentId: common("Id"),
    result: { enum: ["match", "mismatch", "not_comparable"] },
    reason: {
      enum: ["not_executed", "timed_out", "aborted", "prediction_missing", "observation_unparseable", "mask_config_invalid"],
    },
    differences: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "predicted", "observed"],
        properties: { path: { type: "string" }, predicted: {}, observed: {} },
      },
    },
    maskSha256: common("Sha256"),
  },
};

// ---------------------------------------------------------------------------------------------
// Evidence: kinds `source` and `experiment` only, each with its own required fields (R6.3).
// A `source` record has no outcome (the per-Citation list expresses the mixed case); an `experiment`
// record has no citation fields.
const SOURCE_FORBIDDEN = ["outcome", "experimentId", "comparisonRecordId", "observationRecordId", "predictionRecordId"];
const EXPERIMENT_FORBIDDEN = ["citationRecordId", "citations"];
const forbid = (names: string[]): Schema => ({ not: { anyOf: names.map((n) => ({ required: [n] })) } });

const evidence: Schema = {
  $schema: DRAFT,
  $id: "evidence.schema.json",
  type: "object",
  additionalProperties: false,
  required: ["evidenceId", "kind", "claimRevisionId"],
  properties: {
    evidenceId: common("Id"),
    kind: common("EvidenceKind"),
    claimRevisionId: common("Id"),
    outcome: { enum: ["supports", "contradicts", "inconclusive"] },
    citationRecordId: { type: "string", pattern: "^rec-[0-9]{6,}$" },
    citations: {
      type: "array",
      minItems: 1,
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["index", "result"],
        properties: {
          index: { type: "integer", minimum: 0 },
          result: { enum: ["verified", "failed"] },
          reason: {
            enum: ["malformed_citation", "file_not_in_bundle", "range_out_of_bounds", "quote_not_found", "source_unavailable"],
          },
        },
        allOf: [
          { if: { required: ["result"], properties: { result: { const: "failed" } } }, then: { required: ["reason"] } },
          { if: { required: ["result"], properties: { result: { const: "verified" } } }, then: forbid(["reason"]) },
        ],
      },
    },
    experimentId: common("Id"),
    comparisonRecordId: { type: "string", pattern: "^rec-[0-9]{6,}$" },
    observationRecordId: { type: "string", pattern: "^rec-[0-9]{6,}$" },
    predictionRecordId: { type: "string", pattern: "^rec-[0-9]{6,}$" },
  },
  allOf: [
    {
      if: { required: ["kind"], properties: { kind: { const: "source" } } },
      then: { required: ["citationRecordId", "citations"], ...forbid(SOURCE_FORBIDDEN) },
    },
    {
      if: { required: ["kind"], properties: { kind: { const: "experiment" } } },
      then: {
        required: ["outcome", "experimentId", "comparisonRecordId", "observationRecordId", "predictionRecordId"],
        ...forbid(EXPERIMENT_FORBIDDEN),
      },
    },
  ],
};

// ---------------------------------------------------------------------------------------------
const RECORD_KINDS = [
  "run_started", "isolation_checks", "source_bundle_manifest", "payload_audit", "ai_call", "ai_output", "ai_rejected",
  "ai_content_discarded", "hypothesis_revision", "citation_verification", "experiment", "experiment_invalid",
  "policy_decision", "experiment_dropped", "observation", "comparison", "evidence", "store_rejection", "lease_event",
  "termination", "error",
];

const recordEnvelope: Schema = {
  $schema: DRAFT,
  $id: "record-envelope.schema.json",
  type: "object",
  additionalProperties: false,
  required: ["schemaVersion", "seq", "id", "kind", "prevHash", "payload", "hash"],
  properties: {
    schemaVersion: { const: 1 },
    seq: { type: "integer", minimum: 1 },
    id: { type: "string", pattern: "^rec-[0-9]{6,}$" },
    kind: { enum: RECORD_KINDS },
    prevHash: common("Sha256"),
    payload: { type: "object" },
    hash: common("Sha256"),
  },
  allOf: [
    {
      if: { required: ["kind"], properties: { kind: { const: "ai_content_discarded" } } },
      then: { properties: { payload: { $ref: "#/$defs/AiContentDiscardedPayload" } } },
    },
    {
      if: { required: ["kind"], properties: { kind: { const: "store_rejection" } } },
      then: { properties: { payload: { $ref: "#/$defs/StoreRejectionPayload" } } },
    },
  ],
  $defs: {
    AiContentDiscardedPayload: {
      description:
        "Names the discarded field and where it was, never its value (R6.16, R23.6). There is deliberately no value field.",
      type: "object",
      additionalProperties: false,
      required: ["aiOutputRecordId", "fields"],
      properties: {
        aiOutputRecordId: { type: "string", pattern: "^rec-[0-9]{6,}$" },
        fields: {
          type: "array",
          minItems: 1,
          maxItems: 100,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["path", "name"],
            properties: {
              path: { type: "string", maxLength: 256, description: "JSON pointer of the object that held the field" },
              name: { type: "string", minLength: 1, maxLength: 128 },
            },
          },
        },
      },
    },
    StoreRejectionPayload: {
      description:
        "A refused store request. It carries the component identity and, for a secret hit, the pattern id only, never the matched value (R12.5, R12.13, R6.2, R6.15).",
      type: "object",
      additionalProperties: false,
      required: ["attempt", "component", "reason"],
      properties: {
        attempt: {
          enum: [
            "modify_record", "delete_record", "set_origin", "append_evidence_disallowed_kind",
            "append_evidence_disallowed_actor", "secret_pattern",
          ],
        },
        component: { type: "string", minLength: 1, maxLength: 64 },
        targetRecordId: { type: "string", pattern: "^rec-[0-9]{6,}$" },
        patternId: { type: "string", minLength: 1, maxLength: 64 },
        reason: { type: "string", minLength: 1, maxLength: 500 },
      },
      allOf: [
        { if: { required: ["attempt"], properties: { attempt: { const: "secret_pattern" } } }, then: { required: ["patternId"] } },
      ],
    },
  },
};

// ---------------------------------------------------------------------------------------------
const GATE_IDS = [
  "start-implementation", "container-runtime", "override-draft", "override-apply", "install-kiro-cli", "m6-start",
  "m7-start", "transmit-source",
  // R21.20 (2026-11-14): one-time exception for the M0 checkpoint, allowing only the start of M3. Not the start-implementation gate.
  "m0-checkpoint-exception",
];

const approvalRecord: Schema = {
  $schema: DRAFT,
  $id: "approval-record.schema.json",
  description: "One line of the Approval_Store: an approval or a refused-tampering line (R23).",
  type: "object",
  discriminator: { propertyName: "type" },
  oneOf: [{ $ref: "#/$defs/Approval" }, { $ref: "#/$defs/StoreRejectionLine" }],
  $defs: {
    RunId: { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$" },
    Target: {
      type: "object",
      discriminator: { propertyName: "kind" },
      oneOf: [
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "run_id", "claim_revision_id"],
          properties: { kind: { const: "claim_revision" }, run_id: { $ref: "#/$defs/RunId" }, claim_revision_id: common("Id") },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "run_id"],
          properties: { kind: { const: "run" }, run_id: { $ref: "#/$defs/RunId" } },
        },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "gate_id"],
          properties: { kind: { const: "gate" }, gate_id: { enum: GATE_IDS } },
        },
      ],
    },
    Approval: {
      type: "object",
      additionalProperties: false,
      required: ["type", "seq", "prev_hash", "approver", "timestamp", "target", "decision", "rationale", "recorded_by", "hash"],
      properties: {
        type: { const: "approval" },
        seq: { type: "integer", minimum: 1 },
        prev_hash: common("Sha256"),
        approver: { type: "string", minLength: 1, maxLength: 100 },
        timestamp: {
          type: "string",
          format: "date-time",
          pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$",
        },
        target: { $ref: "#/$defs/Target" },
        decision: common("ApprovalDecision"),
        rationale: { type: "string", minLength: 1, maxLength: 2000, pattern: "\\S" },
        recorded_by: { enum: ["human", "kiro-development-agent"] },
        supersedes: { type: "integer", minimum: 1 },
        hash: common("Sha256"),
      },
    },
    StoreRejectionLine: {
      type: "object",
      additionalProperties: false,
      required: ["type", "seq", "prev_hash", "reason", "hash"],
      properties: {
        type: { const: "store_rejection" },
        seq: { type: "integer", minimum: 1 },
        prev_hash: common("Sha256"),
        reason: { type: "string", minLength: 1, maxLength: 500 },
        attempted_seq: { type: "integer", minimum: 1 },
        hash: common("Sha256"),
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
const sha = common("Sha256");
const runManifest: Schema = {
  $schema: DRAFT,
  $id: "run-manifest.schema.json",
  type: "object",
  additionalProperties: false,
  required: [
    "schemaVersion", "runId", "wallClock", "excludedFields", "terminationReason", "finalHypothesisRevision", "config",
    "limitsUsed", "provider", "toolVersions", "sourceBundle", "legacyStartState", "envVarsRead", "payload_audit",
    "ground_truth_access_denial", "isolationChecks", "mutualExclusion", "aiSandbox", "residualRisks", "chain", "artifacts",
  ],
  properties: {
    schemaVersion: { const: 1 },
    runId: { type: "string", minLength: 1 },
    wallClock: {
      type: "object",
      additionalProperties: false,
      required: ["startedAt", "finishedAt"],
      properties: { startedAt: { type: "string" }, finishedAt: { type: "string" } },
    },
    excludedFields: { const: ["runId", "wallClock"] },
    terminationReason: {
      enum: [
        "iteration_limit_reached", "experiment_limit_reached", "time_limit_reached", "no_further_experiments",
        "provider_failure", "payload_audit_blocked", "policy_rejection_limit", "isolation_violation", "lease_unavailable",
        "launcher_killed", "error",
      ],
    },
    finalHypothesisRevision: {
      type: "string",
      minLength: 1,
      description: "id of the last revision that passed schema validation and Citation verification, or the value none (R11.18)",
    },
    config: { type: "object", description: "Copy of the Run configuration; validated by its own schema (run-config), not here" },
    limitsUsed: {
      type: "object",
      additionalProperties: false,
      required: ["iterations", "acceptedExperiments", "rejectedExperiments"],
      properties: {
        iterations: { type: "integer", minimum: 0 },
        acceptedExperiments: { type: "integer", minimum: 0 },
        rejectedExperiments: { type: "integer", minimum: 0 },
      },
    },
    provider: {
      type: "object",
      additionalProperties: false,
      required: ["id", "version", "model", "isMock"],
      properties: { id: { type: "string" }, version: { type: "string" }, model: { type: "string" }, isMock: { type: "boolean" } },
    },
    toolVersions: {
      type: "object",
      additionalProperties: false,
      required: ["node", "npm", "dependencies", "runtimeImageDigest"],
      properties: {
        node: { type: "string" },
        npm: { type: "string" },
        dependencies: { type: "object", additionalProperties: { type: "string" } },
        runtimeImageDigest: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
      },
    },
    sourceBundle: { $ref: "source-bundle-manifest.schema.json" },
    legacyStartState: {
      type: "object",
      additionalProperties: false,
      required: ["identity"],
      properties: { identity: { type: "string", minLength: 1 } },
    },
    envVarsRead: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "set"],
        properties: { name: { type: "string" }, set: { type: "boolean" } },
      },
    },
    payload_audit: {
      type: "object",
      additionalProperties: false,
      required: ["configCheck", "audits", "passed", "blocked", "auditConfigSha256"],
      properties: {
        configCheck: { enum: ["pass", "blocked"] },
        audits: { type: "integer", minimum: 0 },
        passed: { type: "integer", minimum: 0 },
        blocked: { type: "integer", minimum: 0 },
        auditConfigSha256: sha,
      },
    },
    ground_truth_access_denial: {
      type: "object",
      additionalProperties: false,
      required: ["status", "executedInThisRun", "checks"],
      properties: {
        status: { enum: ["verified", "failed"] },
        executedInThisRun: { const: true },
        checks: { type: "array", items: { enum: ["read_denial", "mount_inspection"] } },
      },
    },
    isolationChecks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status", "measuredBy", "measured"],
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          measuredBy: { type: "string" },
          measured: { description: "what was measured; any JSON value" },
        },
      },
    },
    mutualExclusion: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { enum: ["mechanical", "attestation"] },
        lease: {
          type: "object",
          additionalProperties: false,
          required: ["nonceSha256", "launcherPid", "heartbeatIntervalMs", "staleAfterMs"],
          properties: {
            nonceSha256: sha,
            launcherPid: { type: "integer" },
            heartbeatIntervalMs: { type: "integer" },
            staleAfterMs: { type: "integer" },
          },
        },
        attestation: {
          type: "object",
          additionalProperties: false,
          required: ["approver", "timestamp"],
          properties: { approver: { type: "string" }, timestamp: { type: "string" } },
        },
      },
      allOf: [
        { if: { required: ["mode"], properties: { mode: { const: "mechanical" } } }, then: { required: ["lease"] } },
        { if: { required: ["mode"], properties: { mode: { const: "attestation" } } }, then: { required: ["attestation"] } },
      ],
    },
    aiSandbox: {
      type: "object",
      additionalProperties: false,
      required: ["safetyStatus", "permittedDestinations"],
      properties: {
        safetyStatus: { enum: ["UNVERIFIED", "verified", "not_applicable"] },
        permittedDestinations: { type: "array", items: { type: "string" } },
      },
    },
    residualRisks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "status"],
        properties: { id: { type: "string" }, status: { enum: ["unresolved", "measured"] } },
      },
    },
    chain: {
      type: "object",
      additionalProperties: false,
      required: ["records", "lastHash"],
      properties: { records: { type: "integer", minimum: 0 }, lastHash: sha },
    },
    artifacts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "sha256"],
        properties: { path: { type: "string", minLength: 1 }, sha256: sha },
      },
    },
  },
};

// ---------------------------------------------------------------------------------------------
/** All schemas by short name. The order puts referenced schemas first, which Ajv does not require but keeps reading easy. */
export const SCHEMAS: Readonly<Record<SchemaName, Schema>> = Object.freeze({
  common: commonSchema,
  facts: factsSchema,
  "source-bundle-manifest": sourceBundleManifest,
  "rule-expression": ruleExpression,
  citation,
  "hypothesis-proposal": hypothesisProposal,
  prediction,
  experiment,
  observation,
  "comparison-result": comparisonResult,
  evidence,
  "record-envelope": recordEnvelope,
  "approval-record": approvalRecord,
  "run-manifest": runManifest,
});
