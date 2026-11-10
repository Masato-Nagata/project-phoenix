# Implementation Plan: legacy-sample

## Overview

This plan implements the `legacy-sample` order-management application — a PHP 5.6 / MySQL 5.7 system running inside Docker that serves as the analysis target for Project Phoenix. Tasks are organized into four phases: Docker infrastructure setup, business logic implementation, test API and reproducibility, and ground truth / evaluation scenario construction.

All monetary calculations use integer arithmetic only. PHP source code in `legacy/src/` must be written in procedural style with no classes, namespaces, interfaces, or comments describing business rule purpose.

## Tasks

- [x] 1. Phase 1 — Docker Infrastructure Setup

  - [x] 1.1 Verify PHP 5.6 Docker image availability
    - Run `docker pull php:5.6-apache` and confirm it succeeds
    - Run `docker run --rm php:5.6-apache php -v` and confirm output contains "PHP 5.6"
    - Document image digest for reproducibility
    - _Requirements: 11, 12.1_

  - [x] 1.2 Create directory skeleton and environment template
    - Create directories: `legacy/src/`, `legacy/sql/`, `evaluation/ground-truth/`, `infra/`
    - Create `.env.example` with keys: `LEGACY_DB_ROOT_PASSWORD`, `LEGACY_DB_NAME`, `LEGACY_DB_USER`, `LEGACY_DB_PASSWORD` (placeholder values only, no real secrets)
    - Merge `.env` and `*.env` entries into `.gitignore` without duplicating existing entries
    - _Requirements: 12.5, 9.1_

  - [x] 1.3 Create database schema SQL
    - Write `legacy/sql/schema.sql` with DDL for `customers`, `products`, `orders`, `order_lines` exactly as specified in design.md
    - Include all constraints: `chk_unit_price`, `chk_stock_quantity`, foreign keys, indexes (`idx_order_lines_order_id`, `idx_order_lines_product_id`)
    - Include `status` ENUM(`'pending'`, `'shipped'`, `'cancelled'`) on the `orders` table
    - Verify SQL is free of syntax errors against MySQL 5.7 syntax
    - _Requirements: 1.1, 2.1, 3.1, 5.1, 6.4, 6.5_

  - [x] 1.4 Create seed data SQL
    - Write `legacy/sql/seed.sql` with exactly 3 customers and 5 products as specified in design.md seed data tables
    - Product prices must exercise all discount and shipping fee tier boundaries (see design.md boundary_cases)
    - Verify SQL is free of syntax errors against MySQL 5.7 syntax
    - _Requirements: 1.5, 2.2, 4.5_

  - [x] 1.5 Create legacy Dockerfile
    - Base image: `php:5.6-apache`
    - Install `mysqli` extension via `docker-php-ext-install mysqli`
    - Create non-root user with UID 1000 and GID 1000 (`appuser`)
    - Append to `/usr/local/etc/php/php.ini`: `allow_url_fopen = Off`, `allow_url_include = Off`, `disable_functions = fsockopen,socket_create,socket_connect,curl_init,curl_exec`, `display_errors = Off`, `error_log = /dev/stderr`
    - Enable Apache `rewrite` module
    - Set `USER appuser` before `EXPOSE 80`
    - Confirm `docker build ./legacy -t legacy-app-test` succeeds
    - _Requirements: 11.2, 11.3, 11.7_

  - [x] 1.6 Create docker-compose.yml
    - Define two networks: `legacy-internal` (`driver: bridge, internal: true`) and `legacy-api` (`driver: bridge`)
    - `legacy-db` service: `mysql:5.7`, no host port binding, connected to `legacy-internal` only, resource limits CPU ≤ 0.5 / memory ≤ 128M, healthcheck via `mysqladmin ping`, user `"999:999"`, read-only mounts for `schema.sql` and `seed.sql` to `/docker-entrypoint-initdb.d/`
    - `legacy-app` service: built from `./legacy`, connected to `legacy-internal` only, no `ports` (not published to the host), `dns: ["127.0.0.1"]`, read-only mount `./legacy/src` → `/var/www/html`, resource limits CPU ≤ 0.5 / memory ≤ 128M, user `"1000:1000"`, `depends_on: legacy-db: condition: service_healthy`
    - `reverse-proxy` service: image `nginxinc/nginx-unprivileged:1.27-alpine` pinned by digest, `entrypoint` starts nginx directly, connected to `legacy-internal` and `legacy-api`, the only host port binding is `127.0.0.1:8056:8080`, read-only mount `./infra/nginx/nginx.conf` → `/etc/nginx/nginx.conf`, `read_only: true` with tmpfs `/tmp`, `cap_drop: ALL`, `no-new-privileges`, resource limits CPU ≤ 0.25 / memory ≤ 64M, `wget`-based healthcheck, `depends_on: legacy-app: condition: service_started, restart: true`
    - Named volume `legacy-db-data` for MySQL data directory
    - `evaluation/` must not appear in any `volumes:` entry
    - Confirm `docker compose -f infra/docker-compose.yml --project-directory . up -d --build` starts all services without error
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.9, 12.1, 12.2_

  - [x] 1.7 Implement health check endpoint and skeleton PHP files
    - Create `legacy/src/db.php`: establish `mysqli` connection from env vars (`DB_HOST`, `DB_USER`, `DB_PASS`, `DB_NAME`, `DB_PORT`); expose connection as shared variable via `require_once`
    - Create `legacy/src/utils.php`: implement `json_success($data, $status = 200)` and `json_error($message, $status, $extra = [])` helper functions; set `Content-Type: application/json` header
    - Create `legacy/src/index.php`: read `REQUEST_METHOD` and `REQUEST_URI`; route `GET /health` to an inline handler that queries `SELECT 1` and returns `{ "success": true, "data": { "app": "ok", "db": "ok" } }` (200) or `{ "success": false, "data": { "app": "ok", "db": "error" } }` (503) on DB failure
    - Confirm `curl http://127.0.0.1:8056/health` returns 200 within 30 seconds of `docker compose -f infra/docker-compose.yml --project-directory . up -d --build`
    - _Requirements: 8.3, 12.2, 12.3_

  - [x] 1.8 Verify Docker network isolation and port binding
    - After `docker compose up`, run `docker inspect` and confirm `legacy-app` and `legacy-db` are each connected to `legacy-internal` only
    - Confirm `reverse-proxy` is connected to `legacy-internal` and `legacy-api`
    - Confirm `legacy-internal` is `internal` and `legacy-api` is not `internal`
    - Confirm `legacy-app` and `legacy-db` publish no ports to the host
    - Confirm the only host-published port is the `reverse-proxy` binding `127.0.0.1:8056` (not `0.0.0.0`)
    - Confirm `curl http://127.0.0.1:8056/health` returns HTTP 200
    - Document in `legacy/README.md`: residual items are that `reverse-proxy` itself can make outbound connections through `legacy-api`, and that UDP, ICMP, and IPv6 paths were not measured; a complete network-level guarantee is not claimed
    - Document that the API is published only on `127.0.0.1:8056` and that its reachability from the host's non-loopback IPv4 addresses is measured in task 1.11 (the result is limited to the addresses measured; access from other machines on the network is environment-dependent and is not asserted here)
    - Measuring that outbound traffic from `legacy-app` and `legacy-db` is actually blocked is covered by task 1.11
    - _Requirements: 11.1, 11.5_

  - [x] 1.9 Verify volume mounts and ground truth isolation
    - Run `docker inspect legacy-app` and confirm Mounts section contains no path under `evaluation/`
    - Run `docker inspect legacy-app` and confirm `legacy/src/` mount has `"RW": false`
    - Run `docker inspect legacy-db` and confirm Mounts section contains no path under `evaluation/`
    - Run `grep -r "evaluation" infra/docker-compose.yml` and confirm zero matches
    - Record all checks in `legacy/README.md` under a "Isolation Verification Checklist" section
    - _Requirements: 9.1, 11.3, 11.6_

  - [x] 1.10 Add a fixed-upstream reverse proxy and stop publishing legacy-app directly
    - Create `infra/nginx/nginx.conf`: one upstream with the single server `legacy-app:80`; one server on port 8080 and one location; `limit_except GET POST { deny all; }`; `proxy_pass` to the literal upstream (no variable, no `resolver`); fixed `Host` header; `server_tokens off`; request body limit 1 MB; temporary paths under `/tmp`; no status or admin endpoints
    - Update `infra/docker-compose.yml` as described in task 1.6 (add `reverse-proxy`, remove `ports` and the `legacy-api` network from `legacy-app`)
    - Start with `docker compose -f infra/docker-compose.yml --project-directory . up -d --build` and confirm `GET http://127.0.0.1:8056/health` returns 200 through the proxy
    - Confirm that business logic and the API specification are unchanged by re-running all regression tests (Phase 2 and Phase 3, 136 checks)
    - _Requirements: 8.7, 11.1, 11.5, 11.6, 11.9, 12.1_

  - [x] 1.11 Measure network isolation
    - Create `tests/legacy-sample/test_network_isolation.ps1` (PowerShell 7, `docker` CLI required)
    - Check topology, published ports, proxy hardening (uid, read-only rootfs, `cap_drop`), mounts, and a static check of `nginx.conf`
    - Run positive controls first (legacy-app to legacy-db:3306, legacy-db to legacy-app:80, reverse-proxy to legacy-app:80) so that a probe can report "connected"
    - Show that legacy-app and legacy-db cannot open TCP to external IPs by direct address (1.1.1.1:53, 8.8.8.8:53, 1.1.1.1:443, 9.9.9.9:443) and cannot resolve an external name
    - Show that port 8056 is not reachable on the host's non-loopback IPv4 addresses
    - Start a canary container on `legacy-api` and show that crafted requests (absolute URI, Host header, double slash, override headers, CONNECT, PUT/DELETE/PATCH/OPTIONS) are not forwarded to it
    - Record the measured scope and the residual items in `legacy/README.md`: reverse-proxy can open outbound TCP (measured); UDP, ICMP, outbound IPv6, and other destinations were not measured and are not assumed safe
    - _Requirements: 8.7, 11.1, 11.5, 11.8, 11.9_

- [x] 2. Phase 2 — Business Logic Implementation

  - [x] 2.1 Implement product catalog API
    - Create `legacy/src/products.php` with `list_products()` and `get_product($id)`
    - `list_products()`: `SELECT id, name, unit_price, stock_quantity FROM products ORDER BY id`; return array wrapped in `json_success`
    - `get_product($id)`: validate `$id` is a positive integer (non-integer → 400); `SELECT` single row; not found → `json_error("Product not found", 404)`
    - Add routes to `index.php`: `GET /products` → `list_products()`, `GET /products/{id}` → `get_product($id)`
    - Confirm `GET /products` returns 5 products matching seed data; `GET /products/999` returns 404
    - _Requirements: 1.2, 1.3, 1.4_

  - [x]* 2.2 Write integration tests for product catalog
    - Test `GET /products` returns all 5 seed products with correct fields
    - Test `GET /products/1` returns Notebook A4 with correct unit_price and stock_quantity
    - Test `GET /products/999` returns 404
    - _Requirements: 1.2, 1.3, 1.4_

  - [x] 2.3 Implement order placement — validation and calculation
    - Create `legacy/src/orders.php` and implement the validation and calculation portion of `place_order($data)`:
      - Parse JSON body via `json_decode(file_get_contents('php://input'), true)`
      - Missing `customer_id` or missing/empty `lines` → `json_error("Invalid request", 400)`
      - More than 100 lines → `json_error("Invalid request", 400)`
      - Customer not found → `json_error("Customer not found", 404)`
      - Collect all product IDs; fetch in one query; unrecognised IDs → `json_error("Unknown products", 400, ["product_ids" => [...]])`
      - Compute `$subtotal` as `sum(unit_price * quantity)` using integer arithmetic only
      - `$subtotal < 1000` → `json_error("Minimum order value not met", 400)`
      - Check `stock_quantity >= quantity` for each product; collect failures → `json_error("Insufficient stock", 409, ["products" => [...]])`
      - Compute `$discount`: `if ($subtotal < 3000) { $discount = 0; } elseif ($subtotal <= 9999) { $discount = 300; } else { $discount = 1000; }` — no identifying comments on these conditionals
      - Compute `$net_amount = $subtotal - $discount`
      - Compute `$shipping_fee`: `if ($net_amount < 5000) { $shipping_fee = 500; } else { $shipping_fee = 0; }` — no identifying comments
      - Compute `$total = $subtotal - $discount + $shipping_fee`
    - Add route to `index.php`: `POST /orders` → `place_order($data)`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.7, 3.8, 3.9, 3.10, 3.11, 4.1, 4.2, 4.3, 4.4, 10.1, 10.3_

  - [ ]* 2.4 Write property test for discount calculation (Property 2)
    - **Property 2: Discount Is Determined Solely by Subtotal Tier**
    - Generate valid orders with varying subtotals; assert `discount == 0` when `subtotal < 3000`, `discount == 300` when `3000 <= subtotal <= 9999`, `discount == 1000` when `subtotal >= 10000`
    - Call `POST /reset` before each test run
    - Minimum 100 iterations
    - **Validates: Requirements 3.3, 4.1**

  - [ ]* 2.5 Write property test for shipping fee calculation (Property 3)
    - **Property 3: Shipping Fee Is Determined Solely by Net Amount Tier**
    - Generate valid orders; assert `shipping_fee == 500` when `(subtotal - discount) < 5000`, `shipping_fee == 0` when `(subtotal - discount) >= 5000`
    - Call `POST /reset` before each test run
    - Minimum 100 iterations
    - **Validates: Requirements 3.4, 4.2**

  - [ ]* 2.6 Write property test for total calculation (Property 4)
    - **Property 4: Total Equals the Arithmetic Combination of Computed Values**
    - For any successful order response, assert `total == subtotal - discount + shipping_fee` as exact integer arithmetic
    - Minimum 100 iterations
    - **Validates: Requirements 3.5, 4.4**

  - [x] 2.7 Implement order placement — transaction and stock reservation
    - Complete `place_order($data)` by adding the database transaction after validation passes:
      - `BEGIN;`
      - `SELECT id, stock_quantity FROM products WHERE id IN (...) FOR UPDATE;`
      - Re-check stock inside transaction; if any `stock_quantity < requested_quantity` → `ROLLBACK; json_error(..., 409)`
      - `INSERT INTO orders (customer_id, status, subtotal, discount, shipping_fee, total) VALUES (...)`
      - `INSERT INTO order_lines (order_id, product_id, quantity, unit_price) VALUES (...)` for each line
      - `UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?` for each line
      - `COMMIT;`
      - On any DB error → `ROLLBACK; json_error("Internal error", 500)`
    - Success response: HTTP 201, `{ "success": true, "data": { "order_id": N, "subtotal": N, "discount": N, "shipping_fee": N, "total": N } }`
    - Confirm `GET /products/{id}` shows reduced stock after successful order
    - _Requirements: 3.1, 3.5, 3.6, 3.12, 5.1, 5.2, 5.4, 10.2_

  - [ ]* 2.8 Write property test for subtotal calculation (Property 1)
    - **Property 1: Subtotal Is the Sum of Line Totals**
    - Generate orders with 1–10 random lines using seed product prices; assert `subtotal == sum(unit_price * quantity)` for all lines using integer arithmetic
    - Call `POST /reset` before each test run
    - Minimum 100 iterations
    - **Validates: Requirements 3.2**

  - [ ]* 2.9 Write property test for stock non-negativity (Property 5)
    - **Property 5: Stock Quantity Never Becomes Negative**
    - Submit sequences of order placement requests that attempt to exhaust stock; assert no product's `stock_quantity` ever drops below 0 in `GET /products` responses; orders that would cause negative stock must be rejected before any change is committed
    - Call `POST /reset` before each sequence
    - Minimum 100 iterations
    - **Validates: Requirements 5.2, 5.4**

  - [x] 2.10 Implement order cancellation
    - Implement `cancel_order($id)` in `orders.php`:
      - Validate `$id` is a positive integer (non-integer → 400)
      - Fetch order by ID → not found → `json_error("Order not found", 404)`
      - Status check: `cancelled` → `json_error("Order is already cancelled", 409)`, `shipped` → `json_error("Order cannot be cancelled", 409)`, `pending` → proceed
      - `BEGIN;`
      - `UPDATE orders SET status = 'cancelled' WHERE id = ?`
      - `UPDATE products SET stock_quantity = stock_quantity + ? WHERE id = ?` for each order line
      - `COMMIT;`
      - On DB error → `ROLLBACK; json_error("Internal error", 500)`
      - Success response: HTTP 200, `{ "success": true, "data": { "order_id": N, "restored_stock": [{ "product_id": N, "stock_quantity": N }, ...] } }`
    - Add route to `index.php`: `POST /orders/{id}/cancel` → `cancel_order($id)`
    - Confirm stock is restored to pre-order value after cancel
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.6_

  - [ ]* 2.11 Write property test for stock restoration on cancellation (Property 6)
    - **Property 6: Order Cancellation Restores Exact Reserved Stock**
    - Place an order, record pre-order and post-order stock; cancel the order; assert `stock_quantity` returns to pre-order value for all ordered products; assert sum of restorations equals sum of reservations
    - Call `POST /reset` before each test run
    - Minimum 100 iterations
    - **Validates: Requirements 6.1, 5.5**

  - [x] 2.12 Implement order history API
    - Implement `list_orders()` and `get_order($id)` in `orders.php`:
      - `list_orders()`: `SELECT id, customer_id, status, subtotal, discount, shipping_fee, total, created_at FROM orders ORDER BY id`; return array (empty array `[]` if no rows, no error); format `created_at` as ISO 8601 (`Y-m-d\TH:i:sP`)
      - `get_order($id)`: validate `$id`; fetch order row → not found → 404; fetch all `order_lines` for the order; include `lines` array with `product_id`, `quantity`, `unit_price` for each line; same `created_at` format
    - Add routes to `index.php`: `GET /orders` → `list_orders()`, `GET /orders/{id}` → `get_order($id)`
    - Confirm `GET /orders` returns `[]` before any orders; confirm `GET /orders/{id}` returns correct line details after placement
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x]* 2.13 Write integration tests for order history
    - Test `GET /orders` returns `[]` when no orders exist
    - Test `GET /orders/{id}` after placement returns correct subtotal, discount, shipping_fee, total, and lines
    - Test `GET /orders/999` returns 404
    - _Requirements: 7.1, 7.2, 7.3, 7.4_

  - [x] 2.14 Implement test-only ship endpoint
    - Implement `ship_order($id)` in `orders.php`:
      - Validate `$id`; fetch order → not found → 404
      - Status check: `shipped` → `json_error("Order is already shipped", 409)`, `cancelled` → `json_error("Order cannot be shipped: already cancelled", 409)`, `pending` → proceed
      - `UPDATE orders SET status = 'shipped' WHERE id = ?` (no stock change)
      - Success: HTTP 200, `{ "success": true, "data": { "order_id": N, "status": "shipped" } }`
    - Add route to `index.php`: `POST /test/orders/{id}/ship` → `ship_order($id)` (matched before the generic `/orders/{id}/cancel` pattern)
    - Confirm `POST /orders/{id}/cancel` returns 409 after ship
    - _Requirements: 6.4, 6.5_

  - [x] 2.15 Checkpoint — verify all business logic endpoints
    - Confirm `GET /products`, `GET /products/{id}`, `POST /orders`, `GET /orders`, `GET /orders/{id}`, `POST /orders/{id}/cancel`, `POST /test/orders/{id}/ship` all return expected responses
    - Ensure all tests pass; ask the user if questions arise.

- [x] 3. Phase 3 — Test API and Reproducibility

  - [x] 3.1 Implement reset endpoint
    - Implement `reset_db()` in `utils.php`:
      - Session setup: `SET SESSION innodb_lock_wait_timeout = 5` and `SET SESSION lock_wait_timeout = 5`
      - Note: MySQL `ALTER TABLE` / `TRUNCATE` cause an implicit commit and cannot be rolled back, so the reset runs in three stages
      - Stage 1 — data restore (single atomic transaction): `BEGIN;` record counts of `order_lines` / `orders`; delete all `order_lines` and `orders`; delete `products` / `customers` not in the seed; upsert seed `customers` / `products` (name, unit price, stock set to seed values); `COMMIT;`
        - On failure → `ROLLBACK`; `json_error("Reset failed", 500, ["step" => "...", "state" => "rolled_back"])`
      - Stage 2 — AUTO_INCREMENT reset (outside the transaction): `ALTER TABLE order_lines AUTO_INCREMENT = 1`, `ALTER TABLE orders AUTO_INCREMENT = 1`
        - On failure → `json_error("Reset failed", 500, ["step" => "...", "state" => "data_reset_auto_increment_pending"])`; re-running `POST /reset` completes the reset
      - Stage 3 — post-verification: `order_lines` / `orders` counts are 0; seed row counts match; next AUTO_INCREMENT of both tables is 1; `products` contents match the seed
        - On mismatch → `json_error("Reset failed", 500, ["step" => "...", "state" => "unknown"])`
      - Success (only when Stage 3 passes): HTTP 200, `{ "success": true, "data": { "orders_deleted": N, "order_lines_deleted": N, "products_restored": 5 } }`
    - Add route to `index.php`: `POST /reset` → `reset_db()`
    - Confirm `GET /products` shows all seed stock values after reset; `GET /orders` returns `[]`
    - _Requirements: 8.4, 8.5, 8.8, 12.6_

  - [x]* 3.2 Write integration tests for reset endpoint
    - Test reset after placing orders: `GET /orders` returns `[]`, all product stock_quantities match seed values
    - Test two consecutive resets produce identical state
    - Test `AUTO_INCREMENT` reset: first order after reset has `order_id = 1`
    - _Requirements: 8.4, 8.5, 12.4, 12.7_

  - [x] 3.3 Verify reproducibility and Discovery Loop interface
    - Execute the following cycle three times and record results:
      - `POST /reset`
      - `POST /orders` with a fixed payload (e.g., customer_id 1, product_id 1 × 20 units)
      - Record `subtotal`, `discount`, `shipping_fee`, `total`, and `order_id`
      - `GET /products/1` — record `stock_quantity`
    - Assert that `subtotal`, `discount`, `shipping_fee`, `total`, and `stock_quantity` are identical across all three cycles
    - Assert `order_id` is `1` in every cycle (AUTO_INCREMENT reset confirmed)
    - Assert `created_at` differs between cycles (non-deterministic field confirmed)
    - Document findings in `legacy/README.md` under "Reproducibility Verification"
    - _Requirements: 12.4, 12.6, 12.7_

  - [x] 3.4 Checkpoint — verify all test API and reproducibility requirements
    - Ensure all tests pass; ask the user if questions arise.

- [ ] 4. Phase 4 — Ground Truth and Evaluation Scenarios

  - [ ] 4.1 Create ground truth JSON
    - Create `evaluation/ground-truth/ground-truth.json` following the schema defined in design.md:
      - `meta` section: `minimum_order_value: 1000`, `discount_tiers` array (3 tiers), `shipping_fee_tiers` array (2 tiers) — all as literal numeric constants
      - `boundary_cases` array: all 9 subtotal values from design.md (0, 999, 1000, 2999, 3000, 4999, 5000, 9999, 10000) with expected `discount` and `shipping_fee`
      - `scenarios` array: SCN-001 through SCN-014, each with `id`, `description`, `request` (`method`, `path`, `body`), `expected_status`, `expected_fields`, `non_deterministic_fields`
      - For monetary scenarios (SCN-001–SCN-004), compute expected values manually from seed product prices and business rule tiers; record as literal integers
      - `non_deterministic_fields` for order responses: `["data.order_id", "data.created_at"]`
      - SCN-014 must include precondition step `POST /test/orders/{id}/ship`
      - Also add the defect-candidate scenarios SCN-015 to SCN-017 (invalid quantity: zero, negative, non-integer / non-numeric / missing). Their expected values are derived from Requirement 3.13 and confirmed by a human; they are not derived from the observed legacy output (see `evaluation/legacy-defect-candidates.md`)
    - Validate JSON syntax: `cat evaluation/ground-truth/ground-truth.json | python -m json.tool` (or equivalent) returns no errors
    - _Requirements: 3.13, 4.5, 9.1–9.8_

  - [ ] 4.2 Create ground truth README and Phoenix AI allowlist documentation
    - Create `evaluation/ground-truth/README.md` with the following sections:
      - **Purpose**: explains role of ground-truth.json (Spec_Restoration_Evaluation reference only)
      - **Access Restriction**: `evaluation/ground-truth/` is never mounted in any Docker container; not reachable via the Legacy_App HTTP interface
      - **Phoenix AI Allowlist Design**: documents that AI input is an explicit list of 7 concrete file paths (`legacy/src/index.php`, `legacy/src/db.php`, `legacy/src/products.php`, `legacy/src/orders.php`, `legacy/src/utils.php`, `legacy/sql/schema.sql`, `legacy/sql/seed.sql`); files must not be added by wildcard expansion or directory scanning/recursive walks; additions are made only through a reviewed allowlist change; `docs/ai-input-allowlist.md` is the authoritative definition; `evaluation/ground-truth/` is explicitly excluded from this allowlist
      - **Spec-Restorer Input Constraint**: `packages/spec-restorer` must not pass any content from `evaluation/` to `packages/ai-client`; this is enforced by the explicit allowlist of concrete file paths, not by directory scans
      - **Development vs. Runtime Scope Note**: Kiro IDE development agents may reference ground-truth files during code review and design work; this is acceptable. The restriction applies only to Phoenix runtime execution (analyzer, spec-restorer AI calls).
      - **Verification Method**: documents (policy and method only; implementing manifest and payload verification is the responsibility of the analyzer / spec-restorer specs, not this task) how compliance is confirmed: path validation with fail-closed behavior; a per-run input manifest that equals the allowlist exactly; payload verification, i.e. scanning the text actually sent to `packages/ai-client` for canary strings from `evaluation/ground-truth/` fixtures and for paths outside the allowlist, as the authoritative check; a path log alone is not sufficient; plus a `grep` check that `infra/docker-compose.yml` contains no `evaluation` mount
    - _Requirements: 9.1, 9.2, 9.3, 9.4, 9.9, 13.1_

  - [ ]* 4.3 Write integration tests for ground truth isolation
    - Test `GET http://127.0.0.1:8056/evaluation/ground-truth/ground-truth.json` returns HTTP 404 (SCN-013)
    - Test `GET http://127.0.0.1:8056/evaluation` returns HTTP 404
    - Verify `grep -r "evaluation" infra/docker-compose.yml` exits with zero matches
    - _Requirements: 9.1, 9.4_

  - [ ] 4.4 Run all ground truth scenarios against live legacy app
    - For each SCN-001 through SCN-014:
      - Call `POST /reset` to ensure known initial state
      - Execute the scenario's request as specified in `ground-truth.json`
      - For SCN-014, execute the precondition `POST /test/orders/{id}/ship` first
      - Compare actual HTTP status against `expected_status`
      - Compare actual response fields against `expected_fields`; skip fields listed in `non_deterministic_fields` (check presence and type only)
      - Record pass/fail for each scenario
    - If any scenario fails due to a Legacy_App bug (not a ground-truth error), fix the PHP source and rerun
    - If any scenario fails due to incorrect expected values in ground-truth.json, update ground-truth.json
    - Confirm all 14 scenarios pass
    - SCN-001 to SCN-014 must all pass. Run SCN-015 to SCN-017 separately; they are expected to differ from the legacy app, so report them as defect candidates and do not count them in the pass gate. Do not modify the legacy app to make them pass without a recorded human decision
    - _Requirements: 9.5, 9.6, 9.7, 9.8, 13.3_

  - [ ] 4.5 Final integration verification
    - Run full clean sequence: `docker compose -f infra/docker-compose.yml --project-directory . down -v && docker compose -f infra/docker-compose.yml --project-directory . up -d --build`
    - Wait for health check to return 200 (within 30 seconds)
    - Call `POST /reset`
    - Execute SCN-001 through SCN-014 in sequence
    - Confirm all 14 scenarios pass in a single uninterrupted run
    - Confirm the following MVP completion checklist:
      1. `docker compose -f infra/docker-compose.yml --project-directory . up -d --build` starts all containers and health check passes within 30s
      2. `POST /orders` returns correct discount, shipping_fee, and total per design.md calculation rules
      3. Insufficient stock, unknown product, and minimum order violations each return appropriate errors
      4. `POST /orders/{id}/cancel` cancels the order and restores stock
      5. `POST /test/orders/{id}/ship` transitions to shipped; subsequent cancel returns 409
      6. `POST /reset` restores all product stock to seed values and clears order history
      7. Reset → same order → same calculated result cycle is reproducible
      8. SCN-001 through SCN-014 all match ground-truth.json
      9. `evaluation/ground-truth/` is not mounted in any container
      10. `legacy/src/` contains no comments or documents describing business rule purpose
    - Document results in `legacy/README.md` under "MVP Completion Verification"
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.6, 12.7, 10.1, 10.3_

  - [ ] 4.6 Checkpoint — final sign-off
    - Ensure all tests pass; ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP path
- Property tests (2.4–2.6, 2.8, 2.9, 2.11) require a running legacy container and use `POST /reset` before each run
- Integration tests (2.2, 2.13, 3.2, 4.3) are example-based and complement property tests
- The design document uses PHP and SQL, so no language selection prompt is needed
- `legacy/src/` must never contain PHPDoc blocks (`/** ... */`) or inline comments that state the business purpose of any condition
- All conditional blocks implementing discount tiers, shipping fee tiers, and minimum order value check must appear without naming comments
- The Docker design uses two networks (`legacy-internal` with `internal: true`, and `legacy-api` for the reverse-proxy only). Outbound blocking for legacy-app and legacy-db is measured (task 1.11), not assumed. The reverse-proxy itself can open outbound connections, and UDP, ICMP, and IPv6 paths are not measured; no complete isolation guarantee is claimed
- Ground truth is authored by humans only; AI-generated output must never be written into `evaluation/ground-truth/ground-truth.json`
- Tests for this spec live in `tests/legacy-sample/` (outside `legacy/`), because expected values in tests restate the business rules and must never be AI input. Test scripts require PowerShell 7 (`pwsh`). Phase 3 and Phase 4 tests follow the same location.
- `tests/legacy-sample/test_network_isolation.ps1` measures network isolation (it needs the `docker` CLI). Run it on its own or with `run_all.ps1 -IncludeIsolation`; it is not part of the default 136-check regression. `observe_defect_candidates.ps1` only records legacy behavior for the defect candidates and never fails.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4", "1.5"] },
    { "id": 2, "tasks": ["1.6"] },
    { "id": 3, "tasks": ["1.7"] },
    { "id": 4, "tasks": ["1.9", "1.10"] },
    { "id": 5, "tasks": ["1.8", "1.11"] },
    { "id": 6, "tasks": ["2.1"] },
    { "id": 7, "tasks": ["2.2", "2.3"] },
    { "id": 8, "tasks": ["2.4", "2.5", "2.6", "2.7"] },
    { "id": 9, "tasks": ["2.8", "2.9", "2.10"] },
    { "id": 10, "tasks": ["2.11", "2.12", "2.14"] },
    { "id": 11, "tasks": ["2.13"] },
    { "id": 12, "tasks": ["3.1"] },
    { "id": 13, "tasks": ["3.2", "3.3"] },
    { "id": 14, "tasks": ["4.1"] },
    { "id": 15, "tasks": ["4.2", "4.3", "4.4"] },
    { "id": 16, "tasks": ["4.5"] }
  ]
}
```
