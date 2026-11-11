# Ground Truth (legacy-sample)

Status: **approved by the project owner (Masato Nagata).** `ground-truth.json` was drafted by the Kiro development agent from the approved requirements and design and values calculated by hand from the seed data (never from legacy output), then reviewed and approved by the project owner. `meta.authoring` records `status: approved`, `approved_by` and `approved_at`. The review package is `evaluation/review/ground-truth-review.md`.

## Purpose

`ground-truth.json` is the expected specification of the legacy-sample application. It is the reference for:

- the Spec_Restoration_Evaluation (AI-restored spec vs Ground Truth, R13.1-13.2), which is not implemented yet, and
- the Ground Truth conformance run of the legacy app (`evaluation/runner/`), which shows where the legacy app follows the expected specification and where it does not.

It is not the reference of the Compatibility_Evaluation. That evaluation compares the legacy app with the modern app (R13.3).

## Access restriction

- `evaluation/` is never mounted into any container and is not referenced by `infra/docker-compose.yml`.
- It is not reachable through the legacy app's HTTP interface (SCN-013; `tests/legacy-sample/test_ground_truth_isolation.ps1` probes 17 paths, including traversal and encoded variants, as raw HTTP requests).
- `meta.canary` is a unique marker. It appears only in `ground-truth.json` in this repository (checked by `test_ai_input_isolation.ps1`). Finding it anywhere else, in a container, or in an AI payload means the Ground Truth leaked.

## Phoenix AI allowlist

The Phoenix runtime AI receives only the 7 concrete files listed in `docs/ai-input-allowlist.md` (authoritative policy) and `docs/ai-input-allowlist.json` (machine-readable form):

`legacy/src/index.php`, `legacy/src/db.php`, `legacy/src/products.php`, `legacy/src/orders.php`, `legacy/src/utils.php`, `legacy/sql/schema.sql`, `legacy/sql/seed.sql`

Files are never added by wildcard expansion or by scanning or walking directories. A file is added only through a reviewed change to both allowlist files. `evaluation/` (including this directory) is excluded.

## Spec-restorer input constraint

`packages/spec-restorer` must not pass any content from `evaluation/` to `packages/ai-client`. This is enforced by the explicit allowlist of concrete file paths, not by excluding directories from a scan.

## Development vs runtime scope

The Kiro IDE development agent may read this directory while writing and reviewing code. That is a different actor. The restriction applies to the Phoenix runtime: analyzer, spec-restorer, modernizer, and every call to `ai-client`.

## Verification method

| Check | Status |
|-------|--------|
| Not reachable over HTTP; not mounted; no compose reference; canary absent from all containers and the legacy database | Implemented: `test_ground_truth_isolation.ps1` |
| Allowlist rule: a reference builder (`tests/legacy-sample/lib/ai-input-builder.ps1`) reads exactly the listed files, fails closed on traversal, absolute paths, wildcards, directories, nested or non-source files, duplicates, missing files and junctions, and writes a manifest with content hashes | Implemented: `test_ai_input_isolation.ps1` |
| Canary decoys in `evaluation/`, `tests/`, `docs/`, `.kiro/`, READMEs, `.env`, and next to allowed files in `legacy/src` and `legacy/sql` never reach the bundle; a naive directory scan does pick them up (negative control) | Implemented: `test_ai_input_isolation.ps1` |
| Allowlist JSON equals the table in `docs/ai-input-allowlist.md` | Implemented: `test_ground_truth_schema.ps1` |
| Payload scan of the text that the real analyzer / spec-restorer sends to `ai-client` | **Unverified.** Those packages are not implemented. Their specs must add this check; it is the authoritative one. A path log alone is not sufficient |

## File layout and schema

```text
evaluation/
├── ground-truth/ground-truth.json          expected specification only (this README describes it)
├── migration-decisions.json                human migration decisions MD-001..MD-006
├── legacy-defect-candidates.md             observed defect candidates DC-001..DC-006
├── review/ground-truth-review.md           human review package and decision log
├── runner/                                 conformance runner (PowerShell 7)
└── results/ground-truth-conformance.json   generated baseline (observed behavior, comparison, approved divergences)
```

`ground-truth.json`:

| Key | Content |
|-----|---------|
| `meta` | `kind: expected_specification`, `authoring` (`status`, `approved_by`, `approved_at`), `canary`, `minimum_order_value` (1000), `discount_tiers`, `shipping_fee_tiers` (literal constants, R9.7), `non_deterministic_fields` (`data.order_id`, `created_at`), `field_path_syntax` |
| `defect_candidate_links` | DC-001..DC-006 to scenario unit |
| `boundary_cases` | BC-001..BC-011 for subtotals 0, 999, 1000, 2999, 3000, 4999, 5000, 9999, 10000, 5299, 5300. BC-010/BC-011 also record `expected_net_amount` (4999 / 5000) |
| `scenarios` | SCN-001..SCN-017. SCN-017 has variants `SCN-017-a`..`-d`, so there are 20 scenario units |

A scenario unit has `steps` (each with `role` `setup` or `action`, a `request`, and optional `capture` of response values such as an order id) and `expected_specification` with `derived_from` (how the values were obtained), `response_code_source` (`design` or `human_approved`), `step_expectations` (status and fields per step, optional `must_not_contain`) and `state_checks` (follow-up GET requests and their expected fields). Field paths use `a.b`, `[n]` and `[*]`; `{"$type": "integer"}` checks only the type; `{{name}}` is a captured value and `{{canary}}` is `meta.canary`. The schema also allows `undetermined: true` with a `reason` for an expectation that has not been decided; no unit uses it after the approval.

The Ground Truth holds no observed legacy behavior. Observed behavior, comparison, and the migration decision are written by the runner into the result file, one record per unit with separate `expected_specification`, `observed_legacy_behavior`, `comparison`, and `migration_decision` keys.

## Approved specification points

- Quantity: only a JSON positive integer is valid. `0`, `-5`, `1.5`, `"5"`, `"05"`, `" 5"`, `"5.0"`, `"+5"`, `"abc"`, `null`, a missing `quantity`, booleans, arrays and objects are invalid. A request with any invalid quantity is rejected as a whole with 400 `"Invalid request"`; no order is created and stock is unchanged (R3.13). The Ground Truth covers `0`, `-5`, `1.5`, `"abc"`, missing and `"5"` (SCN-015 .. SCN-017-d); the other invalid forms are specified but have no separate unit yet.
- Insufficient stock: each insufficient line is reported with `product_id`, `available` (current stock) and `requested` (requested quantity) (SCN-006, R3.9, R5.2).
- Ground Truth isolation over HTTP: a 4xx rejection without Ground Truth content or canary is required; the exact 404 body is not (SCN-013 checks 404 and the absence of the canary; `test_ground_truth_isolation.ps1` checks 17 raw probes for 4xx and no Ground Truth content).

## Running the conformance evaluation

```powershell
# From project root; the legacy containers must be running (PowerShell 7)
pwsh -NoProfile -File evaluation/runner/Invoke-GroundTruthEvaluation.ps1 -OutputPath $env:TEMP/gt.json
```

Exit codes: 0 gate pass, 1 gate fail, 2 app not healthy or another run in progress (runs are serialized with a mutex because every unit resets the shared database). Each unit starts with `POST /reset`. Boundary cases use a temporary 1-yen product (id 101) inserted into the local database and removed by the final reset (approved method). Without `-OutputPath` the runner overwrites the committed baseline `evaluation/results/ground-truth-conformance.json`.

The result contains no wall-clock values (decision times stay in the registry); `order_id` and `created_at` are masked as `<non-deterministic>` also inside difference messages. Repeated runs produce byte-identical files (`test_ground_truth_reproducibility.ps1`). `-RawOutputPath` writes the unmasked responses for diagnosis; that file is not deterministic.

### Classifications and gate

| Classification | Meaning | Gate |
|----------------|---------|------|
| `match` | Observed behavior equals the expected specification; no decision record | pass |
| `approved_divergence` | Mismatch detected and covered by a decided `follow_expected_specification` decision: an approved, intentional incompatibility | pass; listed under `approved_divergences` |
| `mismatch_replicate_legacy` | Mismatch covered by a decided `replicate_legacy_behavior` decision | pass; reported separately |
| `mismatch_decision_pending` | Mismatch whose decision is still `pending` (unapproved) | **fail** |
| `specification_decision_pending` | Expectation undetermined (not comparable) | **fail** |
| `unexpected_mismatch` | Mismatch or not comparable without a decision record | **fail** |
| `stale_registry_entry` | Match, but a decision record still exists (for example the expectation was edited to match legacy) | **fail** |
| `error` | Setup step or capture failed | **fail** |

The gate also fails on any registry error: duplicate ids or scenarios, a scenario that does not exist, defect candidates that differ from the Ground Truth, an unknown decision or kind, a decided entry without `decided_by`, an ISO 8601 `decided_at` with offset, or `rationale`, a pending entry that carries decision data, or a decision on an undetermined expectation. A boundary case that does not match fails the gate. A boundary case that is not executed is reported as `not_executed` and is not counted as a pass.

### Approved divergences and the Compatibility_Evaluation

`approved_divergences` in the result lists each approved incompatibility with its scenario, decision id, defect candidates, approver, the legacy response (status and error) and the approved target. The Compatibility_Evaluation (legacy vs modern app, R13.3) must report these scenarios explicitly as approved differences: the modern app is expected to return the approved target instead of the legacy response. For every other scenario the legacy response stays the reference.

## Current baseline (approved Ground Truth)

| Result | Units |
|--------|-------|
| `match` | SCN-001 .. SCN-014 (14) |
| `approved_divergence` | SCN-015 (DC-001, MD-001), SCN-016 (DC-002, MD-002), SCN-017-a (DC-003, MD-003), SCN-017-b (DC-004, MD-004), SCN-017-c (DC-006, MD-005), SCN-017-d (DC-005, MD-006) |
| Boundary cases | 10 executed, 10 match; BC-001 not executed |

Gate: pass. This run is a conformance run of the legacy app against the expected specification. It is neither the Spec_Restoration_Evaluation nor the Compatibility_Evaluation (R13.4, R13.6).

### Why BC-001 is not executed (approved)

BC-001 is the rule output for a subtotal of 0. No valid order produces it: every product price is at least 1 yen (`CHECK (unit_price BETWEEN 1 AND 9999999)` in `legacy/sql/schema.sql`), and a quantity must be a JSON positive integer (R3.13). **MySQL 5.7 parses but does not enforce CHECK**, so the price domain is declared, not enforced. Producing a subtotal of 0 would need an invalid quantity (DC-001 / SCN-015), an empty line list (rejected as an invalid request, R3.10), or a 0-yen product outside the declared domain. None of these tests the rule, so the case is recorded as `not_executed`; `test_ground_truth_schema.ps1` (GS33) checks the domain facts this reason depends on.

## Changing the Ground Truth

Changes to expectations or decisions are reviewed changes by a human. Expected values are never edited to match the legacy output. After a change, run the runner (it rewrites the baseline) and `tests/legacy-sample/run_all.ps1 -IncludeIsolation`.