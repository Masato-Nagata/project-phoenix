# Legacy Defect Candidates

Status: recorded during Phase 3 follow-up; linked to Ground Truth scenarios in Phase 4; all six decided by the project owner (follow_expected_specification). Not part of the Ground Truth and never passed to the Phoenix runtime AI (this file lives under `evaluation/`, outside the AI input allowlist).

## How to read this file

- An entry is a defect candidate: observed legacy behavior that does not match the expected behavior derived from the approved requirements. Observed behavior is evidence, not specification. It is not "correct because the legacy app does it".
- The legacy behavior was not changed. Business rules and SQL data were left as they are.
- Causes below are hypotheses from reading the code. They are not verified facts.
- The expected behavior for these inputs is a design-level expectation (Requirement 3.1 plus the request validation step in the design: `400` with `"Invalid request"`). R3.1 states the accepted input, not the exact rejection code or message. R3.13 (added in Phase 3 follow-up) requires rejecting a quantity that is not a positive integer. The drafted Ground Truth expects `400` `"Invalid request"` and marks the code and message `pending_human_confirmation`.

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
| DC-005 | `"5"` (string) | `201`, order created; the string is accepted as `5` | rejected as `400` `"Invalid request"` (approved: only JSON integers are valid) | order created |
| DC-006 | key `quantity` missing | `409` `"Insufficient stock"` | rejected as `400` `"Invalid request"` | no order; stock unchanged |

Hypotheses (unverified): the quantity is cast with `(int)`, which turns `"abc"`, a missing key, and `null` into `0` and truncates `1.5` to `1`; a quantity of `0` is then reported as insufficient stock because the conditional stock update changes no row; a negative value reaches the unsigned `quantity` column and the insert fails, which is reported as an internal error.

Data integrity: for DC-001, DC-002, DC-004, and DC-006 the request is rolled back and no order or stock change remains. DC-003 and DC-005 are accepted, so DC-003 changes the ordered quantity without telling the caller.

## Classification

| Aspect | Value |
|--------|-------|
| Category | Input validation gap against R3.1 |
| Status of the legacy behavior | Defect candidate; not specification |
| Severity | Low in this isolated sample (no integrity loss on rejected inputs); relevant for evaluation correctness |

## Links to the Ground Truth and the decision registry

| ID | Ground Truth unit | Expected (approved) | Conformance result | Decision record | Decision |
|----|-------------------|---------------------|--------------------|-----------------|----------|
| DC-001 | SCN-015 | `400` `"Invalid request"` | `approved_divergence` | MD-001 | follow_expected_specification |
| DC-002 | SCN-016 | `400` `"Invalid request"` | `approved_divergence` | MD-002 | follow_expected_specification |
| DC-003 | SCN-017-a | `400` `"Invalid request"` | `approved_divergence` | MD-003 | follow_expected_specification |
| DC-004 | SCN-017-b | `400` `"Invalid request"` | `approved_divergence` | MD-004 | follow_expected_specification |
| DC-005 | SCN-017-d | `400` `"Invalid request"` | `approved_divergence` | MD-006 (was a specification decision) | follow_expected_specification |
| DC-006 | SCN-017-c | `400` `"Invalid request"` | `approved_divergence` | MD-005 | follow_expected_specification |

All decisions were recorded by Masato Nagata (project owner) with `decided_at` and `rationale` in `evaluation/migration-decisions.json`. Rationale (MD-001..MD-005): 不正な数量は入力検証で拒否する。既存レガシーの409、500、数量切り捨てによる注文作成は欠陥として扱い、新システムには継承しない。 Rationale (MD-006): JSON整数のみを許可し、数値文字列の暗黙変換は認めない。

The mapping is stored in `evaluation/ground-truth/ground-truth.json` (`defect_candidate_links` and each unit's `defect_candidates`) and in the registry; `tests/legacy-sample/test_ground_truth_schema.ps1` and the runner's registry validation check that they agree.

## Consequences

1. The legacy app is not changed. It stays the reference system and keeps these defects.
2. The modern app must follow the expected specification for these inputs (400 `"Invalid request"`, no order, no stock change).
3. The Compatibility_Evaluation (R13.3) reports these six scenarios as approved divergences, taken from `approved_divergences` in `evaluation/results/ground-truth-conformance.json`, not as failures.
4. Further invalid forms specified by the approval (`"05"`, `" 5"`, `"5.0"`, `"+5"`, `null`, booleans, arrays, objects) were not probed against the legacy app and have no Ground Truth unit yet.