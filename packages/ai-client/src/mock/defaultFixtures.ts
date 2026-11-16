// Hand-written fixtures of the Mock_Provider (R3.10, R3.13; design decision D10).
// They are about a fictitious "widget" API with placeholder numbers (the neutral example of the design). They are written by hand as
// static text. They are not derived from, and do not refer to, any evaluation file, Ground_Truth, Migration_Decisions, Conformance_Baseline
// or observed Legacy_App behavior, and they carry no canary. They need not describe the Legacy_App correctly (R3.14): a Run that uses
// them is never evidence of AI discovery capability.
//
// Layout of a response (the shape the schemas of `packages/discovery-loop` validate):
// - hypothesis_generation and hypothesis_revision: a `hypothesis-proposal` object.
// - experiment_generation: an object `{ "experiments": [ <experiment>, ... ] }`. The spec defines the schema of one Experiment but no
//   envelope for several; this envelope is PROVISIONAL and is to be confirmed with the Loop_Orchestrator design (M4).
// - Claim ids such as `clm-0001` follow the illustrative Experiment of the design; the orchestrator assigns the real ones.
// - The citation file is an allowlisted path, but its quote is fictitious on purpose: a citation check against the real file must not
//   report `supported`, so the quote is not copied from any source file.
import type { MockFixture } from "./mockProvider.js";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);

const HYPOTHESIS_GENERATION = `{
  "derived": [
    { "name": "cost", "expr": { "op": "mul", "args": [
      { "op": "input", "path": "requests[0].body.count" },
      { "op": "lookup", "table": "unit_cost_by_label", "key": { "op": "input", "path": "requests[0].body.label" } } ] } }
  ],
  "tables": [
    { "name": "unit_cost_by_label", "entries": [ { "key": "x", "value": 7 }, { "key": "y", "value": 9 } ] }
  ],
  "claims": [
    {
      "localKey": "positive_count_gives_cost",
      "condition": {
        "description": "The first request body has a positive count.",
        "expression": { "op": "gt", "left": { "op": "input", "path": "requests[0].body.count" }, "right": { "op": "lit", "value": 0 } }
      },
      "effect": {
        "description": "The response status is 201 and data.cost equals the unit cost of the label times the count.",
        "response": {
          "status": { "op": "lit", "value": 201 },
          "fields": [ { "path": "data.cost", "value": { "op": "derived", "name": "cost" } } ]
        }
      },
      "confidence": "low",
      "openQuestions": [ "Does the unit cost depend on anything besides the label?" ],
      "citations": [ { "file": "legacy/src/utils.php", "startLine": 1, "endLine": 1, "quote": "fictitious quote of the mock fixture" } ]
    }
  ]
}`;

const EXPERIMENT_GENERATION = `{
  "experiments": [
    {
      "localKey": "list_returns_ok",
      "target": { "kind": "claim", "id": "clm-0001" },
      "requests": [ { "method": "GET", "path": "/orders" } ],
      "prediction": { "target": { "list": "requests", "index": 0 }, "status": 200, "fields": [ { "path": "data.state", "value": "archived" } ] }
    }
  ]
}`;

const HYPOTHESIS_REVISION = `{
  "claims": [
    {
      "localKey": "positive_count_gives_cost",
      "revises": "clm-0001",
      "condition": {
        "description": "The first request body has a positive count.",
        "expression": { "op": "gt", "left": { "op": "input", "path": "requests[0].body.count" }, "right": { "op": "lit", "value": 0 } }
      },
      "effect": {
        "description": "The response status is 200 for a request that only reads data.",
        "response": { "status": { "op": "lit", "value": 200 }, "fields": [] }
      },
      "confidence": "medium",
      "openQuestions": [],
      "citations": [ { "file": "legacy/src/utils.php", "startLine": 1, "endLine": 1, "quote": "fictitious quote of the mock fixture" } ]
    }
  ]
}`;

/** Name of the fixture set that a run configuration (`mockFixtureSet`) selects by default. */
export const DEFAULT_MOCK_FIXTURE_SET_NAME = "default-widget-v1";

export const DEFAULT_MOCK_FIXTURES: readonly MockFixture[] = Object.freeze([
  { requestKind: "hypothesis_generation", response: enc(HYPOTHESIS_GENERATION) },
  { requestKind: "experiment_generation", response: enc(EXPERIMENT_GENERATION) },
  { requestKind: "hypothesis_revision", response: enc(HYPOTHESIS_REVISION) },
]);

/** Named fixture sets. A set name that is not listed is a configuration error (see `createProvider`). */
export const MOCK_FIXTURE_SETS: Readonly<Record<string, readonly MockFixture[]>> = Object.freeze({
  [DEFAULT_MOCK_FIXTURE_SET_NAME]: DEFAULT_MOCK_FIXTURES,
});
