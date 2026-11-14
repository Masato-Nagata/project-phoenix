// Compatibility of the Comparator's records with the M1 schemas (`prediction`, `observation`, `comparison-result`).
// This test reads the built @phoenix/discovery-loop package (the schema validator) as a test-only dependency; the
// Comparator itself does not import it.
import { createSchemaValidator } from "@phoenix/discovery-loop";
import { describe, expect, it } from "vitest";
import { compare, maskConfigHash, type Observation } from "../src/index.js";
import { cfgOf, jsonResponse, observation, prediction } from "./helpers/compareFixtures.js";

const validator = createSchemaValidator();
const CFG = cfgOf("created_at", "items[*].id");
const body = { id: 5, created_at: "<masked>", items: [{ id: "<masked>" }] };
const withPreparation = (o: Observation): Record<string, unknown> => ({ ...o, preparation: [] });

describe("records the Comparator reads and writes validate against the M1 schemas", () => {
  it("a Prediction and an executed Observation built like the runner's are valid", () => {
    const p = prediction(200, [{ path: "id", value: 5 }, { path: "items[0].id", value: 1 }]);
    expect(validator.validate("prediction", p).ok).toBe(true);
    const o = observation(CFG, [jsonResponse(200, body)]);
    const checked = validator.validate("observation", withPreparation(o));
    expect(checked.ok, checked.ok ? "" : JSON.stringify(checked.error)).toBe(true);
  });

  it("every kind of result validates, including the absent marker and the all-zero hash of a missing configuration", () => {
    const p = prediction(201, [{ path: "id", value: 6 }, { path: "gone", value: 1 }]);
    const o = observation(CFG, [jsonResponse(200, body)]);
    const results = [
      compare(prediction(200, [{ path: "id", value: 5 }]), o, CFG),
      compare(p, o, CFG),
      compare(p, { ...o, outcome: "not_executed" }, CFG),
      compare(p, { ...o, outcome: "timed_out" }, CFG),
      compare(p, { ...o, outcome: "aborted" }, CFG),
      compare(undefined, o, CFG),
      compare(p, o, undefined),
      compare(p, o, cfgOf("other")),
      compare(p, observation(CFG, [{ status: 200, bodyKind: "text", body: "ok" }]), CFG),
    ];
    expect(results.map((r) => (r.result === "not_comparable" ? r.reason : r.result))).toEqual([
      "match", "mismatch", "not_executed", "timed_out", "aborted", "prediction_missing", "mask_config_invalid", "mask_config_invalid", "observation_unparseable",
    ]);
    for (const r of results) {
      const checked = validator.validate("comparison-result", r);
      expect(checked.ok, checked.ok ? "" : JSON.stringify(checked.error)).toBe(true);
    }
    expect(results[6]?.maskSha256).toBe("0".repeat(64));
    expect(results[0]?.maskSha256).toBe(maskConfigHash(CFG));
  });
});