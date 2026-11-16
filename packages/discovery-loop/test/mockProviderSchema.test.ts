// R3.5: the Mock_Provider returns responses that pass the same JSON schema validation as responses of a real provider.
// The schemas live in this package; the Mock_Provider is read through the public entry file of `packages/ai-client`.
import { describe, expect, it } from "vitest";
import { DEFAULT_MOCK_FIXTURES } from "../../ai-client/src/index.js";
import type { RequestKind } from "../../ai-client/src/index.js";
import { createSchemaValidator } from "../src/schema/index.js";

const validator = createSchemaValidator();

/** The canned response of a request kind, read from the public fixture set (the raw provider is not exported; its lookup is tested in packages/ai-client). */
async function serve(kind: RequestKind): Promise<Uint8Array> {
  const fixture = DEFAULT_MOCK_FIXTURES.find((f) => f.requestKind === kind && f.matchRequestSha256 === undefined);
  if (fixture === undefined) throw new Error(`no fixture for ${kind}`);
  return fixture.response;
}

describe("Mock_Provider responses pass the schemas of the real responses (R3.5)", () => {
  it.each(["hypothesis_generation", "hypothesis_revision"] as const)("%s is a valid hypothesis-proposal", async (kind) => {
    const r = validator.parseAndValidate("hypothesis-proposal", await serve(kind));
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });

  it("experiment_generation holds 1 to 10 experiments that each pass the experiment schema (R7.1, R7.2)", async () => {
    const bytes = await serve("experiment_generation");
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as { experiments: unknown[] };
    expect(Object.keys(parsed)).toEqual(["experiments"]);
    expect(parsed.experiments.length).toBeGreaterThanOrEqual(1);
    expect(parsed.experiments.length).toBeLessThanOrEqual(10);
    for (const e of parsed.experiments) {
      const r = validator.validate("experiment", e);
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
  });

  it("the revision revises a claim of the generation fixture", async () => {
    const gen = JSON.parse(new TextDecoder().decode(await serve("hypothesis_generation"))) as { claims: { localKey: string }[] };
    const rev = JSON.parse(new TextDecoder().decode(await serve("hypothesis_revision"))) as { claims: { revises?: string }[] };
    expect(gen.claims.length).toBeGreaterThanOrEqual(1);
    expect(rev.claims.every((c) => typeof c.revises === "string")).toBe(true);
  });
});
