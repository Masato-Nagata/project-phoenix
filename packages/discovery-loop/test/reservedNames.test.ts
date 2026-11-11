// Pins the reserved-name matching rule of design "M1 review resolutions" item 10 (R4.16, R4.17).
import { describe, expect, it } from "vitest";
import { discardAiAuthorityFields, isAuthorityLikeName } from "../src/index.js";

const MATCH = [
  "origin", "Origin", "evidence", "evidences", "evidenceNote", "evidence_status", "evidence-status",
  "evidenceStatus", "EVIDENCE_STATUS", "Evidence-Status", "source_evidence_status",
  "approval", "approved", "APPROVED", "approvedBy", "approver",
] as const;
const NO_MATCH = ["originator", "my_origin", "original", "disapproved", "proof", "evidenc", "origin ", "origin.x"] as const;

describe("reserved-name matching rule (item 10)", () => {
  it.each(MATCH)("matches %s", (name) => {
    expect(isAuthorityLikeName(name)).toBe(true);
  });

  it.each(NO_MATCH)("does not match the near-miss %s", (name) => {
    expect(isAuthorityLikeName(name)).toBe(false);
  });

  it("discards matching direct properties of a Claim and keeps every other property", () => {
    const claim = { statement: "s", Origin: "x", evidenceNote: 1, approvedBy: "y", originator: "keep", disapproved: true };
    const { cleaned, discarded } = discardAiAuthorityFields(claim);
    expect(Object.keys(cleaned).sort()).toEqual(["disapproved", "originator", "statement"]);
    expect(discarded.map((d) => d.name).sort()).toEqual(["Origin", "approvedBy", "evidenceNote"]);
  });

  it("does not discard a reserved name that is nested", () => {
    const claim = { statement: "s", condition: { origin: "x", evidence_status: "y", nested: { approved: true } }, citations: [{ approval: 1 }] };
    const { cleaned, discarded } = discardAiAuthorityFields(claim);
    expect(discarded).toEqual([]);
    expect(cleaned).toEqual(claim);
  });
});
