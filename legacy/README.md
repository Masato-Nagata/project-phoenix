# legacy-sample

PHP 5.6 / MySQL 5.7 order-management application — analysis target for Project Phoenix.

## Quick Start

```powershell
# From project root (PowerShell 7+)
Copy-Item .env.example .env
docker compose -f infra/docker-compose.yml --project-directory . up -d --build
curl http://127.0.0.1:8056/health
```

`--project-directory .` is required because the compose file lives in `infra/` while `.env` and the `./legacy/...` mounts are resolved from the project root.

## Running the Tests

Tests live outside this directory, in `tests/legacy-sample/`.

**PowerShell 7 (`pwsh.exe`) is required.** The test scripts use `Invoke-WebRequest -SkipHttpErrorCheck` and `ForEach-Object -Parallel`, which are not available in Windows PowerShell 5.x (`powershell.exe`). The `docker` CLI must also be on the PATH, because some tests read and change the database directly through `docker exec` (credentials come from the container environment and are never printed).

```powershell
# From project root; the legacy containers must be running
pwsh -NoProfile -NonInteractive -File tests/legacy-sample/run_all.ps1
```

`run_all.ps1` runs these scripts in order, prints only FAIL lines, UNVERIFIED notes and per-script results, and exits non-zero if anything fails. Each script can also be run on its own. Without `-IncludeIsolation` it runs the Phase 2/3 regression (136 checks) and the Phase 4 scripts (92 checks); `-IncludeIsolation` adds the network isolation measurement.

| Script | What it checks |
|--------|----------------|
| `test_phase2.ps1` | Regression: catalog, order placement, discount/shipping examples, stock reservation, cancellation, shipped rejection, history (23 checks) |
| `test_phase3_boundaries.ps1` | Minimum order value, discount, and shipping thresholds at exact boundary values |
| `test_phase3_reset.ps1` | Reset completeness, idempotence, AUTO_INCREMENT restart, and failure injection |
| `test_phase3_reproducibility.ps1` | Reset, same input, same result across cycles; `created_at` normalization |
| `test_phase3_concurrency.ps1` | Parallel orders never double-reserve stock |
| `test_network_isolation.ps1` | Measured network isolation (needs the `docker` CLI): topology, published ports, TCP and DNS reachability with positive controls, host reachability, proxy forwarding tests with a canary, and Apache `mod_status` disabled. The count depends on the number of host IPv4 addresses (one T11 check per address; 55 on the last run with six addresses). Run separately or with `run_all.ps1 -IncludeIsolation` |
| `test_ground_truth_schema.ps1` | Static: Ground Truth structure, R9.6 categories, literal constants, monetary values vs tiers, 9 boundary values, BC-001 domain reason, defect candidate links, decision registry, approval status, decision registry, net-amount shipping boundaries, allowlist JSON vs `docs/ai-input-allowlist.md` (37 checks, no container needed) |
| `test_ground_truth_conformance.ps1` | Runs the conformance runner; checks the 14 matches and 6 approved divergences, separation of expected / observed / decision, the approved divergence list, BC-010/BC-011, not-executed handling, and negative controls (wrong expectation, expectation edited to match legacy, missing or pending decision, missing approver, defect-candidate mismatch, wrong SCN-006 value, wrong boundary total) that must fail the gate (26 checks) |
| `test_ground_truth_reproducibility.ps1` | Two runs are byte-identical and equal the committed baseline; no timestamps; masking hides real values; input hashes are current (9 checks) |
| `test_ground_truth_isolation.ps1` | Ground Truth not reachable over HTTP (17 raw-request probes incl. traversal), not mounted, no canary in any container or in the database, with controls (9 checks) |
| `test_ai_input_isolation.ps1` | AI input allowlist rule with a reference builder and canary decoys, fail-closed cases, junction, repository-wide canary placement (11 checks). Prints UNVERIFIED for the real analyzer payload, which does not exist yet |
| `observe_defect_candidates.ps1` | Informational only, never fails: records how the legacy app handles invalid quantities (see `evaluation/legacy-defect-candidates.md`) |

The scripts call `POST /reset` and modify database state. They also create temporary rows, a temporary trigger, and a short-lived lock holder inside the local legacy database, and remove them when they finish. Run them only against the local isolated environment.
## AI Input Scope

The Phoenix AI receives only the 7 files listed in `docs/ai-input-allowlist.md` / `docs/ai-input-allowlist.json` (5 PHP files in `legacy/src/`, 2 SQL files in `legacy/sql/`). Tests, `evaluation/`, `.kiro/`, `docs/`, `legacy/Dockerfile` and READMEs (including this file) are never passed to it. The real analyzer payload check is unverified until the analyzer exists.

## Ground Truth Evaluation

The expected specification is in `evaluation/ground-truth/ground-truth.json` (approved by the project owner). `evaluation/runner/Invoke-GroundTruthEvaluation.ps1` runs it against this app and writes `evaluation/results/ground-truth-conformance.json`. Current baseline: SCN-001..SCN-014 match; SCN-015, SCN-016 and SCN-017-a..d are approved divergences (the legacy app keeps its invalid-quantity defects DC-001..DC-006; the modern app must answer 400 "Invalid request", decisions MD-001..MD-006); boundary cases 10 of 10 executed match, BC-001 not executed; gate pass. This app is not changed to remove the divergences. Details: `evaluation/ground-truth/README.md`; review package: `evaluation/review/ground-truth-review.md`.

## Base Images

The legacy app is built from `php:5.6-apache` (PHP 5.6.40). The image is end-of-life and unpatched, which is why the environment is isolated.

```
php@sha256:0a40fd273961b99d8afe69a61a68c73c04bc0caa9de384d3b2dd9e7986eec86d
```

The reverse proxy uses the official `nginxinc/nginx-unprivileged:1.27-alpine` image (nginx 1.27.5, runs as uid 101), pinned by digest in `infra/docker-compose.yml`:

```
nginxinc/nginx-unprivileged@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0
```

## Docker Network Design

Three containers and two networks:

| Container | Networks | Published to the host |
|-----------|----------|-----------------------|
| `legacy-db` (MySQL 5.7) | `legacy-internal` | nothing |
| `legacy-app` (PHP 5.6 / Apache) | `legacy-internal` | nothing |
| `reverse-proxy` (nginx, unprivileged) | `legacy-internal`, `legacy-api` | `127.0.0.1:8056` (container port 8080) |

| Network | Type | Purpose |
|---------|------|---------|
| `legacy-internal` | `internal: true` | app to db traffic and proxy to app traffic. No route to the outside |
| `legacy-api` | standard bridge | used only by `reverse-proxy` so that its port can be published on the host loopback |

A container on an `internal: true` network has no route to the outside, while a published port needs a non-internal network. Only the minimal publishing component, `reverse-proxy`, therefore sits on `legacy-api`. `legacy-app` and `legacy-db` do not.

### Reverse proxy

`infra/nginx/nginx.conf` is mounted read-only. It has one fixed upstream (`legacy-app:80`), one server, and one location; it allows GET and POST only; and it has no variable-based destination, no `resolver`, and no status or admin endpoint. The container runs as uid 101 with a read-only root filesystem (plus a tmpfs `/tmp`), all capabilities dropped, and `no-new-privileges`. Compose restarts it when `legacy-app` is recreated, because nginx resolves the upstream name only at startup.

### Measured isolation (last run: 55 of 55 checks passed)

Measured with `tests/legacy-sample/test_network_isolation.ps1`:

| Check | Result |
|-------|--------|
| `legacy-app` and `legacy-db` are on `legacy-internal` only; `reverse-proxy` is on both networks | as designed |
| Only `reverse-proxy` publishes a port, bound to `127.0.0.1:8056` | as designed |
| `legacy-app` to `1.1.1.1:53`, `8.8.8.8:53`, `1.1.1.1:443`, `9.9.9.9:443` (TCP, direct IP) | all failed |
| `legacy-db` to the same four addresses | all failed |
| `legacy-app` and `legacy-db` resolving an external name | failed |
| Positive controls: `legacy-app` to `legacy-db:3306`, `legacy-db` to `legacy-app:80`, `reverse-proxy` to `legacy-app:80` | all succeeded |
| API reachable on `127.0.0.1:8056` (health 200, db ok) | yes |
| Port 8056 on the host's six non-loopback IPv4 addresses, and on `[::1]` | not reachable |
| Apache `mod_status`: not loaded (`apache2ctl -M`); `/server-status` and `/server-status?auto` answer the app's 404 JSON | disabled |
| Crafted requests through the proxy (absolute URI, Host header, double slash, override headers, CONNECT, PUT/DELETE/PATCH/OPTIONS) against a canary container | none reached the canary |

### Residual items and what is not claimed

- `reverse-proxy` itself is on the non-internal `legacy-api` network and can open outbound TCP connections (measured: it connected to `1.1.1.1:53`). It runs only the fixed-upstream configuration above. Do not run untrusted code in it.
- UDP, ICMP, outbound IPv6, and destinations other than the four listed above were not measured. They are not assumed to be blocked.
- The host check covered the host's own addresses only. Reachability from other machines on a network depends on the environment and was not tested.
- The PHP settings (`allow_url_fopen = Off`, `disable_functions`) and `dns: ["127.0.0.1"]` on `legacy-app` are mitigations, not the isolation mechanism.
- Apache `mod_status` is disabled in the image (`a2dismod status` in `legacy/Dockerfile`, Phase 4). Other Apache modules of the base image were not reviewed.
- Measured blocking of the tested paths is not a statement that the environment is safe for unknown code. That decision belongs to the project owner after reviewing this scope.

## Isolation Verification

Run the automated measurement (PowerShell 7, `docker` CLI):

```powershell
pwsh -NoProfile -File tests/legacy-sample/test_network_isolation.ps1
```

Quick manual spot checks:

```powershell
# Published ports: only reverse-proxy, only on 127.0.0.1:8056
docker compose -f infra/docker-compose.yml --project-directory . ps --format "{{.Name}} {{.Ports}}"

# legacy/src is mounted read-only (expected: RW=false)
docker inspect (docker compose -f infra/docker-compose.yml --project-directory . ps -q legacy-app) --format '{{range .Mounts}}{{if eq .Destination "/var/www/html"}}RW={{.RW}}{{end}}{{end}}'

# evaluation/ is not referenced by the compose file (expected: no output)
Select-String -Path infra/docker-compose.yml -Pattern "evaluation"

# Ground Truth is not served over HTTP (expected: 404)
curl -s -o NUL -w "%{http_code}" http://127.0.0.1:8056/evaluation/ground-truth/ground-truth.json
```
## Reproducibility Verification

Verified by `test_phase3_reproducibility.ps1`, `test_phase3_reset.ps1`, and `test_phase3_boundaries.ps1`.

### Reset semantics

`POST /reset` restores the seeded state: orders and order lines are removed, products and customers are set back to the values in `legacy/sql/seed.sql` (extra rows removed, edited rows restored), and the `orders` / `order_lines` AUTO_INCREMENT counters restart at 1.

MySQL `ALTER TABLE` and `TRUNCATE` cause an implicit commit and cannot be rolled back, so reset runs in three stages and does not pretend to be one transaction:

1. Data restore in a single transaction (atomic; a failure rolls everything back).
2. AUTO_INCREMENT reset outside the transaction.
3. Post-verification of counts, counters, and product contents. HTTP 200 is returned only if this passes.

Any failure returns HTTP 500 with `details.step` and `details.state`:

| `details.state` | Meaning | What the caller does |
|-----------------|---------|----------------------|
| `unchanged` | Failed before anything was changed | Call reset again |
| `rolled_back` | Data restore failed; database is exactly as before | Call reset again |
| `data_reset_auto_increment_pending` | Data is reset but the AUTO_INCREMENT counters are not | Call reset again (it is idempotent) |
| `unknown` | Post-verification did not match | Call reset again, then check the result |

Do not treat the database as being in the initial state until a reset has returned 200.

### Non-deterministic values

| Field | Rule |
|-------|------|
| `created_at` | Excluded from equality. Checked only for presence and ISO 8601 format (`YYYY-MM-DDTHH:MM:SS+hh:mm`), then replaced by `<TIMESTAMP>` before responses are compared. |
| `order_id` | Not masked. After a reset it is deterministic (1, 2, 3, ...), and the tests assert that. |

### Results (last run)

- Three reset-and-run cycles, with leftover orders and edited or extra rows created before cycles 2 and 3: responses are byte-identical after masking `created_at`, and the database snapshot (orders, order lines, products, customers) is identical in every cycle. Before masking, the raw responses of cycle 1 and 2 differ, which shows the masking is what makes them comparable.
- Expected literals (amounts, line items, final stock) are asserted in every cycle, so a consistently wrong result would not pass.
- Minimum order value, discount, and shipping fee thresholds are each tested one yen below, at, and one yen above the boundary, including the shipping decision on the amount after discount. Odd amounts that the seed prices cannot produce are tested with a temporary 1-yen product inserted directly into the local database and removed by the next reset.
- Failure injection: a trigger that blocks deleting orders leaves the database untouched and reports `rolled_back`; a held metadata lock makes the AUTO_INCREMENT step time out and reports `data_reset_auto_increment_pending`; a repeated reset repairs it.
- 12 and 16 parallel orders never reserve more stock than exists, never return a server error, and never leave negative stock. The test sends requests in parallel; it does not independently prove how MySQL interleaved them.

### Known limits

- Seed values are duplicated inside `reset_db()` because `legacy/sql` is not mounted into the app container. `test_phase3_reset.ps1` compares the API output with `seed.sql` to detect drift.
- Reset is not safe to run while other clients are placing orders.
- Invalid quantities (zero, negative, non-integer, non-numeric, missing) are not handled as the requirements expect. The behavior is recorded as defect candidates in `evaluation/legacy-defect-candidates.md` and was not changed.

## MVP Completion Verification

Clean run on the development host (Windows, Docker Desktop), last repeated after the project owner approved the Ground Truth (task 4.6):

1. Before `down -v`, the only Docker volume on the host was `project-phoenix_legacy-db-data` (compose project `project-phoenix`, volume `legacy-db-data`; synthetic seed data only). No other project's containers, volumes or networks existed, so `down -v` removed only this project's resources. Images were kept.
2. `docker compose -f infra/docker-compose.yml --project-directory . down -v`, then `up -d --build` (image build served from the local cache).
3. `/health` returned 200 (`app: ok`, `db: ok`) about 18 seconds after `up` started.
4. `evaluation/runner/Invoke-GroundTruthEvaluation.ps1` (resets before every unit): gate pass; the result file is byte-identical to the committed baseline `evaluation/results/ground-truth-conformance.json`.
5. `tests/legacy-sample/run_all.ps1 -IncludeIsolation`: 11 scripts, 283 of 283 checks passed (Phase 2/3 regression 136, network isolation 55, Phase 4 92), plus one UNVERIFIED note for the real analyzer payload.

| # | MVP checklist item | Result | Evidence |
|---|--------------------|--------|----------|
| 1 | `up -d --build` starts all containers; health within 30 s | yes (about 20 s) | step 3 |
| 2 | `POST /orders` returns the correct discount, shipping fee and total | yes | SCN-001..004, BC-002..009, `test_phase2.ps1`, `test_phase3_boundaries.ps1` |
| 3 | Insufficient stock, unknown product, minimum order violations return the right errors | yes | SCN-005..008 |
| 4 | Cancel cancels and restores stock | yes | SCN-009 |
| 5 | `POST /test/orders/{id}/ship` ships; a later cancel returns 409 | yes | SCN-014 |
| 6 | `POST /reset` restores seed stock and clears orders | yes | SCN-012, `test_phase3_reset.ps1` |
| 7 | reset, same order, same result is reproducible | yes | `test_phase3_reproducibility.ps1`, `test_ground_truth_reproducibility.ps1` |
| 8 | SCN-001..SCN-014 match the Ground Truth | yes, against the **approved** Ground Truth; SCN-015..SCN-017-d are approved divergences | conformance baseline |
| 9 | `evaluation/ground-truth/` is not mounted in any container | yes | `test_ground_truth_isolation.ps1` GI4-GI8 |
| 10 | `legacy/src/` has no comments or documents describing business rules | yes: no comment lines in `legacy/src` or `legacy/sql`; files are the 5 PHP files and `.htaccess` | grep for `//`, `#`, `/*`, `*`, `--` lines |

Not covered by this verification: BC-001 (not executed), the invalid quantity forms without a Ground Truth unit (`"05"`, `" 5"`, `"5.0"`, `"+5"`, `null`, booleans, arrays, objects), the real analyzer payload (unverified), and the network residual items listed above.
