# Legacy Defect Candidates

Status: recorded during Phase 3 follow-up. Not part of the Ground Truth and never passed to the Phoenix runtime AI (this file lives under `evaluation/`, outside the AI input allowlist).

## How to read this file

- An entry is a defect candidate: observed legacy behavior that does not match the expected behavior derived from the approved requirements. Observed behavior is evidence, not specification. It is not "correct because the legacy app does it".
- The legacy behavior was not changed. Business rules and SQL data were left as they are.
- Causes below are hypotheses from reading the code. They are not verified facts.
- The expected behavior for these inputs is a design-level expectation (Requirement 3.1 plus the request validation step in the design: `400` with `"Invalid request"`). R3.1 states the accepted input, not the exact rejection code or message. A human must confirm the exact expectation before it is written into the Ground Truth.

## Reproduce

```powershell
# From project root; the legacy containers must be running (PowerShell 7)
pwsh -NoProfile -File tests/legacy-sample/observe_defect_candidates.ps1
```

The script resets the database before every probe and at the end, never fails, and is not part of `run_all.ps1`.

## Candidates

All probes send an order with one valid line (product 4, quantity 10) and one line with the quantity under test (product 1).

| ID | Quantity sent | Observed in legacy | Expected per R3.1 / design | State after the request |
|----|---------------|--------------------|----------------------------|-------------------------|
| DC-001 | `0` | `409` `"Insufficient stock"` | rejected as `400` `"Invalid request"` | no order; stock unchanged |
| DC-002 | `-5` | `500` `"Internal error"` | rejected as `400` `"Invalid request"` | no order; stock unchanged |
| DC-003 | `1.5` | `201`, order created; quantity silently becomes `1` (stock 500 to 499, subtotal 12150) | rejected as `400` `"Invalid request"` | order created with a changed quantity |
| DC-004 | `"abc"` | `409` `"Insufficient stock"` | rejected as `400` `"Invalid request"` | no order; stock unchanged |
| DC-005 | `"5"` (string) | `201`, order created; the string is accepted as `5` | not an integer; a human decides whether numeric strings are acceptable | order created |
| DC-006 | key `quantity` missing | `409` `"Insufficient stock"` | rejected as `400` `"Invalid request"` | no order; stock unchanged |

Hypotheses (unverified): the quantity is cast with `(int)`, which turns `"abc"`, a missing key, and `null` into `0` and truncates `1.5` to `1`; a quantity of `0` is then reported as insufficient stock because the conditional stock update changes no row; a negative value reaches the unsigned `quantity` column and the insert fails, which is reported as an internal error.

Data integrity: for DC-001, DC-002, DC-004, and DC-006 the request is rolled back and no order or stock change remains. DC-003 and DC-005 are accepted, so DC-003 changes the ordered quantity without telling the caller.

## Classification

| Aspect | Value |
|--------|-------|
| Category | Input validation gap against R3.1 |
| Status of the legacy behavior | Defect candidate; not specification |
| Severity | Low in this isolated sample (no integrity loss on rejected inputs); relevant for evaluation correctness |

## What Phase 4 must do with these

1. Spec_Restoration_Evaluation: add Ground Truth scenarios for invalid quantities whose expected result is the human-confirmed rejection (proposed IDs: SCN-015 quantity `0`, SCN-016 negative quantity, SCN-017 non-integer / non-numeric / missing quantity). The expected values come from the requirements, not from the observed legacy output.
2. Compatibility_Evaluation: by Requirement 13.3 the reference is the legacy app's actual response, which here differs from the expected behavior above. For every candidate a human must record a decision before modernization: replicate the legacy behavior, or follow R3.1. Until then, results for these inputs must be reported separately and not counted as ordinary passes or failures.
3. Do not edit the legacy app to make these scenarios pass without a recorded decision.