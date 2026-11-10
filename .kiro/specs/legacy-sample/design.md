# Design Document — legacy-sample

## Overview

This document describes the design of the `legacy-sample`: a small, self-contained order-management application built on PHP 5.6 and MySQL 5.7. The system serves as the analysis target for Project Phoenix's AI-driven spec restoration, modernization, and compatibility verification pipeline.

The application is intentionally written in procedural PHP without frameworks, with business rules embedded directly in source code and no explanatory comments. This reproduces real-world conditions of an undocumented legacy system. The ground-truth specification is stored separately in `evaluation/ground-truth/` and is never passed to the Phoenix AI pipeline.

---

## Architecture

### Container Topology

```
  Host
  ┌──────────────────────────────────────────────────────────────┐
  │ Phoenix Verifier / HTTP client ──► 127.0.0.1:8056            │
  └──────────────────────────────────┬───────────────────────────┘
                                     │ (only published port)
┌────────────────────────────────────┼─────────────────────────────┐
│  Network: legacy-api  (bridge, NOT internal)                     │
│                                    │                             │
│                        ┌───────────┴──────────┐                  │
│                        │  reverse-proxy       │                  │
│                        │  nginx-unprivileged  │                  │
│                        └───────────┬──────────┘                  │
└────────────────────────────────────┼─────────────────────────────┘
                                     │ (reverse-proxy joins both networks)
┌────────────────────────────────────┼─────────────────────────────┐
│  Network: legacy-internal  (internal: true)                      │
│                                    │ fixed upstream legacy-app:80│
│  ┌──────────────────────┐   ┌──────┴───────────────────────┐     │
│  │  legacy-db           │◄──┤  legacy-app                  │     │
│  │  MySQL 5.7           │   │  PHP 5.6 / Apache            │     │
│  │  (no published port) │   │  (no published port)         │     │
│  │  CPU ≤ 0.5 / 128MB   │   │  CPU ≤ 0.5 / 128MB           │     │
│  └──────────────────────┘   └──────────────────────────────┘     │
│  (reverse-proxy: CPU ≤ 0.25 / 64MB, read-only rootfs, uid 101)   │
└──────────────────────────────────────────────────────────────────┘

  Host Filesystem (outside Docker)
  legacy/src/               ── read-only mount ──► legacy-app
  legacy/sql/               ── read-only mount ──► legacy-db init scripts
  infra/nginx/nginx.conf    ── read-only mount ──► reverse-proxy
  evaluation/ground-truth/  ── NOT mounted; no container access
```

**Key isolation properties:**
- The `legacy-internal` network is `internal: true`. `legacy-app` and `legacy-db` are connected to this network only, and measurements show neither can reach external IPs or resolve external names.
- The `legacy-api` network is a standard bridge. Only `reverse-proxy` is connected to it. `legacy-app` and `legacy-db` are not.
- Neither `legacy-app` nor `legacy-db` publishes a port to the host (no `ports:` entry). Only `reverse-proxy` publishes, and only on `127.0.0.1:8056` (container port 8080), not `0.0.0.0`.
- `reverse-proxy` forwards to one fixed upstream (`legacy-app:80`), accepts only GET and POST, and has no admin endpoints. It runs as uid 101 with a read-only root filesystem, `cap_drop: ALL`, and `no-new-privileges`.
- `evaluation/ground-truth/` is never mounted into any container and is never reachable via the Test API.
- All source mounts are read-only; no pipeline component writes back to `legacy/src/`.

### Docker Network Rationale

A container attached to an `internal: true` network has no route to the outside. A container whose port must be published to the host has to be attached to a non-internal network. To keep the exposure small, only the minimal component that does the publishing, `reverse-proxy`, is placed on `legacy-api`. `legacy-app` and `legacy-db` stay on `legacy-internal` only.

- `legacy-internal` (`internal: true`): `legacy-db`, `legacy-app`, and `reverse-proxy`. This carries app ↔ db traffic and proxy → app traffic.
- `legacy-api` (bridge): `reverse-proxy` only. This is the path for the host-published port.

In an earlier configuration, `legacy-app` was also attached to `legacy-api`. Measurement showed that `legacy-app` could open TCP connections to external IPs in that setup. The PHP function restrictions and the DNS setting were only mitigations and did not stop it. In the current configuration the outbound block is confirmed by measurement (`tests/legacy-sample/test_network_isolation.ps1`):

- `legacy-app` and `legacy-db` cannot open TCP to 1.1.1.1:53, 8.8.8.8:53, 1.1.1.1:443, or 9.9.9.9:443, and cannot resolve an external name. Positive controls (`legacy-app` → `legacy-db:3306`, `legacy-db` → `legacy-app:80`) succeed, so the probes can report a connection.
- Port 8056 is not reachable on the host's non-loopback IPv4 addresses (six were measured) or on `[::1]`.
- With a canary container on `legacy-api`, crafted requests (absolute URI, Host header, path tricks, override headers, CONNECT, PUT/DELETE/PATCH/OPTIONS) were not forwarded by the proxy to any arbitrary destination.

The PHP settings (`allow_url_fopen = Off`, `disable_functions`) and `dns: ["127.0.0.1"]` on `legacy-app` remain as additional mitigations. They are not the isolation mechanism.

Residual items:
- `reverse-proxy` itself is on `legacy-api` and can open outbound TCP connections to external IPs (measured). It is operated with the fixed-upstream configuration only and does not execute untrusted code.
- UDP, ICMP, outbound IPv6, and destinations other than those listed above have not been measured. They are not assumed to be safe.
- The `legacy-app` image includes Apache `mod_status` (`/server-status`, local-only by default). Through the proxy it is answered with 403.

### Access Paths

| From | To | Path | Network | Note |
|------|----|------|---------|------|
| Phoenix Verifier | reverse-proxy | HTTP `127.0.0.1:8056` | host → legacy-api | JSON over HTTP; the only published port |
| reverse-proxy | legacy-app | HTTP, fixed upstream `legacy-app:80` | legacy-internal | GET/POST only |
| legacy-app | legacy-db | MySQLi, `legacy-db:3306` | legacy-internal | |
| legacy-app | Internet | Blocked | legacy-internal (`internal: true`) | Measured: external TCP and DNS fail |
| legacy-db | Anywhere | Blocked | legacy-internal (`internal: true`) | Measured: external TCP and DNS fail; no published port |
| reverse-proxy | Internet | **Not blocked** | legacy-api | Measured: outbound TCP possible; operated with fixed-upstream config only |
| Phoenix AI pipeline | Allowlisted files under legacy/src/ and legacy/sql/ | Direct filesystem read | — | Input to analyzer |
| Evaluation programs | evaluation/ground-truth/ | Direct filesystem read | — | Never via HTTP |
| Phoenix AI pipeline | evaluation/ground-truth/ | **Prohibited** | — | Structural separation |

---

## Directory Structure

```
project-phoenix/
├── legacy/
│   ├── src/
│   │   ├── index.php          # Entry point and router
│   │   ├── db.php             # Database connection helper
│   │   ├── products.php       # Product listing and retrieval
│   │   ├── orders.php         # Order placement, cancellation, history
│   │   └── utils.php          # Shared response helpers
│   ├── sql/
│   │   ├── schema.sql         # Table DDL
│   │   └── seed.sql           # Initial products and customers
│   ├── Dockerfile
│   └── README.md              # Setup and usage instructions only (no business rule descriptions)
│
├── evaluation/
│   ├── ground-truth/
│   │   ├── ground-truth.json  # Authoritative scenario definitions
│   │   └── README.md          # How to use ground truth; access restriction notes
│   └── legacy-defect-candidates.md  # Record of legacy behavior defect candidates (not Ground Truth)
│
├── tests/
│   └── legacy-sample/
│       ├── test_phase2.ps1    # Outside legacy/ because expected values restate business rules; never AI input
│       ├── test_phase3_boundaries.ps1        # Boundary values: minimum order amount, discount, shipping fee
│       ├── test_phase3_reset.ps1             # Reset completeness, idempotence, ID numbering, failure injection
│       ├── test_phase3_reproducibility.ps1   # Reset -> same input -> same result; created_at normalization
│       ├── test_phase3_concurrency.ps1       # Concurrent orders must not double-allocate stock
│       ├── test_network_isolation.ps1        # Measured network isolation: topology, ports, TCP/DNS reachability, canary forwarding tests
│       ├── observe_defect_candidates.ps1     # Observes legacy defect candidates; not part of run_all
│       ├── run_all.ps1                       # Runs all tests above in order and aggregates results
│       └── lib/
│           └── common.ps1                    # Shared helpers: API calls, direct DB access, created_at normalization
│
├── docs/
│   └── ai-input-allowlist.md  # AI input allowlist policy
│
├── infra/
│   ├── docker-compose.yml
│   └── nginx/
│       └── nginx.conf         # reverse-proxy configuration
│
└── .env.example
```

`legacy/src/` contains only executable PHP source files. No design documents, no specification files, and no PHPDoc blocks describing business rule purposes are present in this directory.

---

## Data Models

### Database Schema

#### `customers` table

```sql
CREATE TABLE customers (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name        VARCHAR(255) NOT NULL,
    PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### `products` table

```sql
CREATE TABLE products (
    id             INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name           VARCHAR(255) NOT NULL,
    unit_price     INT UNSIGNED NOT NULL,   -- yen, 1 to 9,999,999
    stock_quantity INT UNSIGNED NOT NULL,   -- 0 to 999,999
    PRIMARY KEY (id),
    CONSTRAINT chk_unit_price     CHECK (unit_price BETWEEN 1 AND 9999999),
    CONSTRAINT chk_stock_quantity CHECK (stock_quantity <= 999999)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

#### `orders` table

```sql
CREATE TABLE orders (
    id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
    customer_id   INT UNSIGNED NOT NULL,
    status        ENUM('pending', 'shipped', 'cancelled') NOT NULL DEFAULT 'pending',
    subtotal      INT UNSIGNED NOT NULL,
    discount      INT UNSIGNED NOT NULL,
    shipping_fee  INT UNSIGNED NOT NULL,
    total         INT UNSIGNED NOT NULL,
    created_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

**Status classification:**
| Status | Cancellable |
|--------|-------------|
| `pending` | Yes |
| `shipped` | No |
| `cancelled` | No (already cancelled) |

The `shipped` status is the required non-cancellable state (Requirement 6.5). It is set via the test-only endpoint `POST /test/orders/{id}/ship`. The reset endpoint sets all orders back to seed state (empty).

#### `order_lines` table

```sql
CREATE TABLE order_lines (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    order_id    INT UNSIGNED NOT NULL,
    product_id  INT UNSIGNED NOT NULL,
    quantity    INT UNSIGNED NOT NULL,   -- 1 to 999,999
    unit_price  INT UNSIGNED NOT NULL,   -- price at time of order
    PRIMARY KEY (id),
    CONSTRAINT fk_order_lines_order   FOREIGN KEY (order_id)   REFERENCES orders(id),
    CONSTRAINT fk_order_lines_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE INDEX idx_order_lines_order_id   ON order_lines (order_id);
CREATE INDEX idx_order_lines_product_id ON order_lines (product_id);
```

### Indexes

| Table | Index | Columns | Purpose |
|-------|-------|---------|---------|
| `orders` | PK | `id` | Primary lookup |
| `orders` | FK | `customer_id` | Customer reference integrity |
| `order_lines` | PK | `id` | Primary lookup |
| `order_lines` | `idx_order_lines_order_id` | `order_id` | Fetch lines for an order |
| `order_lines` | `idx_order_lines_product_id` | `product_id` | Stock aggregation query |

### Seed Data

#### Customers (at least 3)

| id | name |
|----|------|
| 1 | Tanaka Taro |
| 2 | Suzuki Hanako |
| 3 | Sato Kenji |

#### Products (at least 5)

| id | name | unit_price (yen) | stock_quantity |
|----|------|-----------------|----------------|
| 1 | Notebook A4 | 150 | 500 |
| 2 | Ballpoint Pen (Black) | 80 | 1000 |
| 3 | Sticky Notes (Pack) | 200 | 300 |
| 4 | USB Flash Drive 32GB | 1200 | 100 |
| 5 | Desk Organizer | 800 | 50 |

Product prices are chosen so that combinations can produce Subtotal values that exercise all discount and shipping fee tier boundaries documented in Requirement 4. The reset endpoint restores all `stock_quantity` values to these seed values.

---

## Components and Interfaces

### Application Architecture

The application is written in procedural PHP 5.6. No classes, interfaces, traits, namespaces, or dependency injection constructs are used anywhere in `legacy/src/`.

**File responsibilities:**

| File | Responsibility |
|------|---------------|
| `index.php` | HTTP request routing; dispatches to handler functions |
| `db.php` | Database connection; single shared connection per request |
| `products.php` | `list_products()`, `get_product($id)` |
| `orders.php` | `place_order($data)`, `cancel_order($id)`, `list_orders()`, `get_order($id)`, `ship_order($id)` |
| `utils.php` | `json_success($data, $status)`, `json_error($message, $status, $extra)`, `reset_db()`, `health_check()` |

### Entry Point and Routing

`index.php` reads `$_SERVER['REQUEST_METHOD']` and `$_SERVER['REQUEST_URI']` to dispatch requests. Path matching uses simple string comparison with `strpos` or `preg_match` — no framework router.

```
GET  /health                    → health_check()
POST /reset                     → reset_db()
GET  /products                  → list_products()
GET  /products/{id}             → get_product($id)
POST /orders                    → place_order($body)
GET  /orders                    → list_orders()
GET  /orders/{id}               → get_order($id)
POST /orders/{id}/cancel        → cancel_order($id)
POST /test/orders/{id}/ship     → ship_order($id)
```

Request body is read via `file_get_contents('php://input')` and decoded with `json_decode`. The `Content-Type: application/json` header is required for POST requests.

### Database Connection

`db.php` establishes a single `mysqli` connection per request using environment variables:

```php
$db = new mysqli(
    getenv('DB_HOST'),
    getenv('DB_USER'),
    getenv('DB_PASS'),
    getenv('DB_NAME'),
    (int)getenv('DB_PORT')
);
```

The connection is used by all handler files via `require_once 'db.php'`. No connection pooling; each PHP request opens and closes one connection.

### Error Response Format

All error responses use a consistent JSON structure:

```json
{
  "success": false,
  "error": "<human-readable message>",
  "details": { ... }   // optional; present when multiple items are identified (e.g., bad product IDs)
}
```

All success responses include:

```json
{
  "success": true,
  "data": { ... }
}
```

HTTP status codes follow the scheme defined in Requirement 8.6:
- `2xx` — success
- `4xx` — client error (invalid input, not found, business rule rejection)
- `5xx` — server error (database failure, reset failure)

---

## Business Logic Design

### Processing Flow for Order Placement

```
POST /orders
  │
  ├─ 1. Decode and validate request structure
  │       Missing customer_id or empty order_lines → 400
  │
  ├─ 2. Verify customer exists
  │       Customer not found → 404
  │
  ├─ 3. Verify all product IDs exist
  │       Unknown product IDs → 400, list unrecognised IDs in details
  │
  ├─ 4. Compute Subtotal = sum(unit_price × quantity) for all lines
  │       (unit_price fetched from products table at this moment)
  │
  ├─ 5. Minimum order value check: Subtotal < 1000 → 400
  │
  ├─ 6. Check stock for all products
  │       Any product with stock < requested quantity → 409, list in details
  │
  ├─ 7. Compute Discount (embedded conditional, no identifying comments)
  │       Subtotal < 3000          → Discount = 0
  │       3000 ≤ Subtotal ≤ 9999  → Discount = 300
  │       Subtotal ≥ 10000         → Discount = 1000
  │
  ├─ 8. Compute Net_Amount = Subtotal − Discount
  │
  ├─ 9. Compute Shipping_Fee (embedded conditional, no identifying comments)
  │       Net_Amount < 5000  → Shipping_Fee = 500
  │       Net_Amount ≥ 5000  → Shipping_Fee = 0
  │
  ├─ 10. Compute Total = Subtotal − Discount + Shipping_Fee
  │
  └─ 11. BEGIN TRANSACTION
           INSERT INTO orders (customer_id, status, subtotal, discount, shipping_fee, total)
           INSERT INTO order_lines for each line
           UPDATE products SET stock_quantity = stock_quantity − quantity (all in one transaction)
           COMMIT → return 201 with order summary
           ROLLBACK on any error → return 500
```

Steps 5 and 7–10 are implemented as plain PHP conditionals (`if/elseif`) in `orders.php` with no comment identifying the business purpose of any condition.

### Discount Calculation

The following logic is embedded as conditional statements in PHP source. No comment names or describes the tiers.

```
if subtotal < 3000:
    discount = 0
elseif subtotal <= 9999:
    discount = 300
else:
    discount = 1000
```

### Shipping Fee Calculation

```
net_amount = subtotal - discount
if net_amount < 5000:
    shipping_fee = 500
else:
    shipping_fee = 0
```

### Total Calculation

```
total = subtotal - discount + shipping_fee
```

All values are non-negative integers in yen. No floating-point arithmetic is used anywhere in the calculation path.

### Stock Reservation Transaction

The stock check (step 6) and the stock decrement (step 11) are separated: step 6 reads current stock and returns an error if any product is under-stocked; step 11 performs the actual decrement inside a transaction with a `SELECT ... FOR UPDATE` lock to prevent a race condition between concurrent requests.

```sql
BEGIN;
SELECT id, stock_quantity FROM products WHERE id IN (...) FOR UPDATE;
-- re-check stock inside transaction
UPDATE products SET stock_quantity = stock_quantity - ? WHERE id = ?;
-- (repeated for each line)
INSERT INTO orders ...;
INSERT INTO order_lines ...;
COMMIT;
```

If any UPDATE would result in `stock_quantity < 0`, the transaction is rolled back and a 409 response is returned.

### Order Cancellation Transaction

```
POST /orders/{id}/cancel
  │
  ├─ 1. Fetch order by ID → not found → 404
  ├─ 2. Check status:
  │       status = 'cancelled' → 409 (already cancelled)
  │       status = 'shipped'   → 409 (non-cancellable)
  │       status = 'pending'   → proceed
  └─ 3. BEGIN TRANSACTION
           UPDATE orders SET status = 'cancelled' WHERE id = ?
           UPDATE products SET stock_quantity = stock_quantity + quantity
             for each order_line
           COMMIT → return 200 with affected product stock quantities
           ROLLBACK on any error → return 500
```

### Status Transition

```
pending ──→ shipped    (via POST /test/orders/{id}/ship — test-only endpoint; no stock change)
pending ──→ cancelled  (via POST /orders/{id}/cancel; stock restored)
shipped → [no further transition allowed]
cancelled → [no further transition allowed]
```

---

## Test API Design

### Endpoint Specification

#### Health Check

```
GET /health

Response 200:
{
  "success": true,
  "data": {
    "app": "ok",
    "db": "ok"
  }
}
```

If the database connection fails, `"db"` is `"error"` and the HTTP status is `503`.

#### Reset

```
POST /reset

Response 200:
{
  "success": true,
  "data": {
    "orders_deleted": <integer>,
    "order_lines_deleted": <integer>,
    "products_restored": <integer>
  }
}
```

`products_restored` is the number of seed products (5). Reset runs in three stages. MySQL DDL (`ALTER TABLE`, `TRUNCATE`) causes an implicit commit and cannot be rolled back, so the whole reset cannot be a single atomic transaction. Seed values are held inside `reset_db()` because `legacy/sql` is not mounted in the legacy-app container; drift from `seed.sql` is detected by tests that compare `GET /products` with `seed.sql`. The session sets `innodb_lock_wait_timeout` and `lock_wait_timeout` to 5 seconds so the reset cannot hang on lock waits.

**Stage 1 — Data restore (single transaction, atomic):**
1. DELETE all rows from `order_lines`
2. DELETE all rows from `orders`
3. DELETE `products` and `customers` rows whose ids are not in the seed set
4. Upsert the seed `customers` and `products` (name, unit price and stock quantity all set to seed values)
5. COMMIT

If any step fails, the transaction is rolled back and the response is `500` with `details.state = "rolled_back"` (or `"unchanged"` if the transaction could not begin).

**Stage 2 — AUTO_INCREMENT reset (outside the transaction):** `ALTER TABLE order_lines AUTO_INCREMENT = 1`, then `ALTER TABLE orders AUTO_INCREMENT = 1`. These cannot be made atomic. On failure the response is `500` with `details.step` (e.g., `reset auto_increment orders`) and `details.state = "data_reset_auto_increment_pending"` (data reset, counters not). The reset is idempotent, so the caller re-issues it to complete the state.

**Stage 3 — Post-verification:** confirm that `orders` and `order_lines` are empty, the `products` and `customers` counts match the seed, the next AUTO_INCREMENT of both tables is 1, and every product's name, unit price and stock quantity match the seed. On any mismatch the response is `500` with `details.state = "unknown"`. HTTP 200 is returned only when verification passes.

Failure response format (see Error Handling > Reset Failure):

```json
{ "success": false, "error": "Reset failed",
  "details": { "step": "...", "state": "rolled_back | data_reset_auto_increment_pending | unknown | unchanged" } }
```

#### Products

```
GET /products
Response 200: { "success": true, "data": [ { product }, ... ] }

GET /products/{id}
Response 200: { "success": true, "data": { product } }
Response 404: { "success": false, "error": "Product not found" }
```

Product object:
```json
{ "id": 1, "name": "Notebook A4", "unit_price": 150, "stock_quantity": 500 }
```

#### Order Placement

```
POST /orders
Content-Type: application/json

Request:
{
  "customer_id": 1,
  "lines": [
    { "product_id": 1, "quantity": 5 },
    { "product_id": 3, "quantity": 2 }
  ]
}

Response 201:
{
  "success": true,
  "data": {
    "order_id": <integer>,
    "subtotal": <integer>,
    "discount": <integer>,
    "shipping_fee": <integer>,
    "total": <integer>
  }
}
```

**Error responses for order placement:**

| Condition | HTTP Status | `error` field |
|-----------|-------------|---------------|
| Missing `customer_id` or empty `lines` | 400 | "Invalid request" |
| Customer not found | 404 | "Customer not found" |
| Unknown product ID(s) | 400 | "Unknown products" + `details.product_ids` |
| Subtotal < 1000 | 400 | "Minimum order value not met" |
| Insufficient stock | 409 | "Insufficient stock" + `details.products` |

#### Order History

```
GET /orders
Response 200: { "success": true, "data": [ { order_summary }, ... ] }

GET /orders/{id}
Response 200: { "success": true, "data": { order_detail } }
Response 404: { "success": false, "error": "Order not found" }
```

Order summary object (list endpoint):
```json
{
  "id": 1,
  "customer_id": 1,
  "status": "pending",
  "subtotal": 1150,
  "discount": 0,
  "shipping_fee": 500,
  "total": 1650,
  "created_at": "2024-01-15T10:30:00+00:00"
}
```

Order detail object (single endpoint — adds `lines`):
```json
{
  "id": 1,
  "customer_id": 1,
  "status": "pending",
  "subtotal": 1150,
  "discount": 0,
  "shipping_fee": 500,
  "total": 1650,
  "created_at": "2024-01-15T10:30:00+00:00",
  "lines": [
    { "product_id": 1, "quantity": 5, "unit_price": 150 },
    { "product_id": 3, "quantity": 2, "unit_price": 200 }
  ]
}
```

#### Order Cancellation

```
POST /orders/{id}/cancel

Response 200:
{
  "success": true,
  "data": {
    "order_id": <integer>,
    "restored_stock": [
      { "product_id": <integer>, "stock_quantity": <integer> },
      ...
    ]
  }
}
```

**Error responses for cancellation:**

| Condition | HTTP Status | `error` field |
|-----------|-------------|---------------|
| Order not found | 404 | "Order not found" |
| Already cancelled | 409 | "Order is already cancelled" |
| Non-cancellable status (shipped) | 409 | "Order cannot be cancelled" |

#### Ship Order (Test-Only)

```
POST /test/orders/{id}/ship

Purpose: Test-only endpoint to transition an order from pending to shipped status, enabling
compatibility test scenarios that verify cancellation rejection for non-cancellable orders.
Stock quantities are not modified by this transition.

Request: (no body required)

Response 200:
{
  "success": true,
  "data": {
    "order_id": <integer>,
    "status": "shipped"
  }
}
```

**Error responses for ship:**

| Condition | HTTP Status | `error` field |
|-----------|-------------|---------------|
| Order not found | 404 | "Order not found" |
| Order is already shipped | 409 | "Order is already shipped" |
| Order is already cancelled | 409 | "Order cannot be shipped: already cancelled" |

### Test-Only Endpoints

Endpoints prefixed with `/test/` are explicitly marked as test-only by their path prefix.
These endpoints exist solely to enable compatibility test scenarios and do not model real business flows.

`POST /test/orders/{id}/ship` design constraints:
- Does **not** modify `stock_quantity` (the shipped transition has no inventory effect)
- Updates `status` from `'pending'` to `'shipped'` only
- Transition from `'cancelled'` → `'shipped'` is prohibited (returns 409)
- Transition from `'shipped'` → `'shipped'` is prohibited (returns 409; ensures idempotency is not assumed)
- This endpoint is reachable from the host only through the reverse-proxy, which publishes only on the loopback `127.0.0.1:8056`; port 8056 was measured to be unreachable from the host's non-loopback IPv4 addresses (`tests/legacy-sample/test_network_isolation.ps1`).

Ground Truth must include SCN-014 (cancellation rejected for shipped order):
- Precondition: call `POST /test/orders/{id}/ship` to set the order to shipped
- Operation: `POST /orders/{id}/cancel`
- Expected: HTTP 409, `error` = `"Order cannot be cancelled"`

### Non-Deterministic Value Handling

Two fields are inherently non-deterministic:

| Field | Source of non-determinism | Normalization strategy |
|-------|--------------------------|------------------------|
| `order_id` | AUTO_INCREMENT; depends on prior resets | After reset, IDs are predictable (start from 1). Phoenix Verifier normalizes by matching on relative position or by using IDs returned from previous placement calls. |
| `created_at` | `CURRENT_TIMESTAMP` at insertion time | Phoenix Verifier excludes `created_at` from equality comparison, or compares only presence (field exists, is a valid ISO 8601 timestamp). |

**AUTO_INCREMENT reset strategy:** The `reset` endpoint executes `ALTER TABLE orders AUTO_INCREMENT = 1` and `ALTER TABLE order_lines AUTO_INCREMENT = 1` after deleting all rows. This makes order IDs predictable across reset cycles: the first order placed after a reset always receives `id = 1`. These statements are DDL (implicit commit, not rollback-able), so they run as a separate step outside the data-restore transaction. If one fails, the endpoint does not return success; it returns HTTP 500 with `details.state = "data_reset_auto_increment_pending"`.

**Verifier comparison rule:** For any response field listed as non-deterministic in the Ground Truth scenario definition, the Phoenix Verifier treats it as "present and valid format" rather than comparing the exact value.

---

## Ground Truth Design

### Role and Authorship Principle

Ground Truth is a **human-authored authoritative specification**. AI-generated output (restored specs, code proposals, inferred expected values) must never be written into the Ground Truth or overwrite its contents.

```
Ground Truth author:  Human (Phoenix engineer)
Ground Truth content: Manually calculated and recorded from seed data and business rules
AI's role:            Never reads the Ground Truth. Generates restored spec independently.
Evaluation role:      Compares AI-generated restored spec against Ground Truth (comparison only).
```

Patterns that violate this principle (prohibited):
- Writing Phoenix AI output into `evaluation/ground-truth/ground-truth.json`
- Having AI generate Ground Truth scenario definitions
- Treating Legacy_App execution results as Ground Truth during compatibility testing

### Separation Guarantee — Layered Design

**Layer 1: Structural separation (directory)**
- `evaluation/ground-truth/` belongs to neither `legacy/` nor `packages/`; it is an independent directory
- AI pipeline input is an explicit allowlist of concrete file paths (see `docs/ai-input-allowlist.md`), not directories.
- The analyzer takes the allowlist as explicit input; it never discovers, scans, or recursively walks directories, and never expands wildcards to add files. Existing in an allowed directory does not make a file eligible.
- Adding a file requires an explicit change to the allowlist in a reviewed commit.

**Layer 2: Docker mount scope restriction**
- The `evaluation/` directory is never mounted into any Docker service
- All `volumes:` entries in `docker-compose.yml` must not reference any `evaluation/` path
- Verification method: `grep -r "evaluation" infra/docker-compose.yml` must return zero matches

**Layer 3: AI input validation, manifest, and payload verification**
- Path validation: resolve each path to a real path, match it against the allowlist, and reject `..` and symlinks that leave the allowed set; fail closed on any violation (never skip silently)
- Per-run input manifest (path + content hash) that must equal the allowlist exactly; an extra or missing file is a failure
- Authoritative check: scan the text actually sent to `packages/ai-client` for canary strings from `evaluation/ground-truth/` fixtures and for any path outside the allowlist; a path log alone is not sufficient evidence
- Unit tests assert that the prompt sent by spec-restorer to the AI client does not contain any `evaluation/` path or content

**Layer 4: Runtime non-reference guarantee**
- `packages/spec-restorer` code must not perform any `fs.readFile` / `fs.readdir` or equivalent file operations targeting `evaluation/`; enforced by static code review
- Unit tests verify that the context array passed to `packages/ai-client` does not include any content from `evaluation/ground-truth/`

**Layer 5: HTTP interface inaccessibility (SCN-013)**
- A test scenario records that `GET /evaluation/ground-truth/ground-truth.json` returns 404 from Legacy_App
- Apache's document root is `/var/www/html` (mapped to `legacy/src/`); `evaluation/` is physically outside this root and cannot be served

### File Location and Access Restriction

```
evaluation/
└── ground-truth/
    ├── ground-truth.json   # Scenario definitions
    └── README.md           # Usage instructions and access restriction notes
```

Access restriction is enforced structurally:
1. The `evaluation/` directory is **never mounted** into any Docker container (not in `docker-compose.yml` volume definitions).
2. The Legacy_App's Apache document root is `legacy/src/`. Even if a container could reach the host filesystem (it cannot due to volume restrictions), `evaluation/` is outside the document root.
3. The Phoenix AI pipeline receives only the allowlisted files. The analyzer is given the explicit allowlist and performs no directory enumeration or recursive discovery anywhere (not under `legacy/`, not above it).
4. The Ground Truth README documents this restriction explicitly so that future pipeline changes do not accidentally add `evaluation/` to the input set.

### Ground Truth JSON Schema

```json
{
  "meta": {
    "minimum_order_value": 1000,
    "discount_tiers": [
      { "subtotal_min": 0,     "subtotal_max": 2999,  "discount": 0 },
      { "subtotal_min": 3000,  "subtotal_max": 9999,  "discount": 300 },
      { "subtotal_min": 10000, "subtotal_max": null,   "discount": 1000 }
    ],
    "shipping_fee_tiers": [
      { "net_amount_min": 0,    "net_amount_max": 4999, "shipping_fee": 500 },
      { "net_amount_min": 5000, "net_amount_max": null,  "shipping_fee": 0 }
    ]
  },
  "boundary_cases": [
    { "subtotal": 0,     "expected_discount": 0,    "expected_shipping_fee": 500 },
    { "subtotal": 999,   "expected_discount": 0,    "expected_shipping_fee": 500 },
    { "subtotal": 1000,  "expected_discount": 0,    "expected_shipping_fee": 500 },
    { "subtotal": 2999,  "expected_discount": 0,    "expected_shipping_fee": 500 },
    { "subtotal": 3000,  "expected_discount": 300,  "expected_shipping_fee": 500 },
    { "subtotal": 4999,  "expected_discount": 300,  "expected_shipping_fee": 500 },
    { "subtotal": 5000,  "expected_discount": 300,  "expected_shipping_fee": 500 },
    { "subtotal": 9999,  "expected_discount": 300,  "expected_shipping_fee": 0 },
    { "subtotal": 10000, "expected_discount": 1000, "expected_shipping_fee": 0 }
  ],
  "scenarios": [
    {
      "id": "SCN-001",
      "description": "...",
      "request": { "method": "POST", "path": "/orders", "body": { } },
      "expected_status": 201,
      "expected_fields": {
        "success": true,
        "data.subtotal": "<integer>",
        "data.discount": "<integer>",
        "data.shipping_fee": "<integer>",
        "data.total": "<integer>"
      },
      "non_deterministic_fields": ["data.order_id", "created_at"]
    }
  ]
}
```

### Required Scenario Coverage

The Ground Truth must include at least one scenario from each of the following categories:

| Scenario ID prefix | Category | Key verification point |
|-------------------|----------|----------------------|
| SCN-001 | Successful order — all tiers exercised | subtotal, discount, shipping_fee, total values |
| SCN-002 | Successful order — discount tier 1 (Subtotal ≥ 10,000) | Discount = 1,000 |
| SCN-003 | Successful order — discount tier 2 (3,000 ≤ Subtotal ≤ 9,999) | Discount = 300 |
| SCN-004 | Successful order — free shipping (Net_Amount ≥ 5,000) | Shipping_Fee = 0 |
| SCN-005 | Rejection — Subtotal < 1,000 (minimum order not met) | 400 status |
| SCN-006 | Rejection — insufficient stock | 409 status, product IDs in details |
| SCN-007 | Rejection — unknown product ID | 400 status |
| SCN-008 | Rejection — unknown customer ID | 404 status |
| SCN-009 | Cancellation with stock restoration | product stock_quantity after cancel |
| SCN-010 | Cancellation rejected — already cancelled | 409 status |
| SCN-011 | Cancellation rejected — invalid order ID | 404 status |
| SCN-012 | Reset idempotency — two resets in sequence | identical state after each reset |
| SCN-013 | Ground truth inaccessibility — GET /evaluation | 404 from Legacy_App |
| SCN-014 | Cancellation rejected — non-cancellable (shipped) | 409 status; requires prior `POST /test/orders/{id}/ship` call |
| SCN-015 | Rejection — quantity zero (defect candidate DC-001) | Expected per R3.13: rejected as invalid request (4xx; exact code/message to be confirmed by the human Ground Truth author); no order, no stock change. Legacy observed `409`. |
| SCN-016 | Rejection — negative quantity (defect candidate DC-002) | Same expectation as SCN-015. Legacy observed `500`. |
| SCN-017 | Rejection — non-integer, non-numeric, or missing quantity (defect candidates DC-003, DC-004, DC-006; DC-005 numeric string needs a human decision) | Same expectation as SCN-015. Legacy observed `201` (1.5 truncated), `409`, `409`. |

**Defect-candidate scenarios:** The expected values of SCN-015 to SCN-017 are derived from the requirement (R3.13), not from the observed legacy output, and follow the Role and Authorship Principle (the Ground Truth is authored by a human). These scenarios are expected to fail against the legacy app. They are excluded from the gate "all of SCN-001 to SCN-014 pass on the legacy app" and are reported separately. Details and reproduction steps for each candidate are in `evaluation/legacy-defect-candidates.md`.

### Scenario Definition for Monetary Calculations

For scenarios that verify monetary calculations, `expected_fields` records exact integer values computed from the seed product prices and the business rule tiers. These values are recorded as literals in the Ground Truth file, not derived from source code symbol references.

Example for SCN-003 using seed products (Notebook A4 × 20 = 3,000 yen):
```json
{
  "id": "SCN-003",
  "request": {
    "method": "POST", "path": "/orders",
    "body": { "customer_id": 1, "lines": [{ "product_id": 1, "quantity": 20 }] }
  },
  "expected_status": 201,
  "expected_fields": {
    "success": true,
    "data.subtotal": 3000,
    "data.discount": 300,
    "data.shipping_fee": 500,
    "data.total": 3200
  }
}
```

---

## Evaluation Architecture

### Two Independent Evaluation Processes

```
┌──────────────────────────────────────────────────────────────────┐
│  Spec Restoration Evaluation (DOCUMENT-BASED)                    │
│                                                                  │
│  Ground Truth ──► [human-authored, AI never reads this]          │
│       │                                                          │
│       ▼  compare: rules, tiers, thresholds                       │
│  AI-Restored Spec ──► [AI output; no Ground Truth in prompt]     │
│       │                                                          │
│       └─ Result: rule accuracy, match/mismatch per rule          │
│          ※ AI が Ground Truth を「見て合わせる」ことは禁止       │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│  Compatibility Evaluation (EXECUTION-BASED)                      │
│                                                                  │
│  Input Scenario ──► Legacy_App (HTTP) ──► Legacy Response        │
│       │                    ↑                     │               │
│       │         [Ground Truth は参照しない]       │               │
│       └──────► Modern_App (HTTP) ──► Modern Response             │
│                                           │                      │
│               Differ ◄────────────────────┘                     │
│                  │                                               │
│                  └─ Result: pass/fail per scenario               │
│     ※ Legacy_App の実行結果が「正解」であり Ground Truth ではない │
└──────────────────────────────────────────────────────────────────┘
```

**Why the two evaluations do not interfere:**

1. **Different inputs:** Spec Restoration Evaluation operates on documents (AI-generated spec vs. Ground Truth). Compatibility Evaluation operates on live HTTP responses. No shared data source.
2. **Different reference points:** Spec Restoration uses Ground Truth as reference. Compatibility Evaluation uses Legacy_App HTTP responses as reference — Ground Truth is not consulted.
3. **Separate result storage:** Results are written to different records in the SQLite pipeline state database under distinct keys (`spec_eval` vs. `compat_eval`).
4. **No shared state:** Running the Compatibility Evaluation does not alter the AI-restored spec, and running the Spec Restoration Evaluation does not trigger container execution.

**Defect candidates make the two references diverge:** For the defect candidates DC-001 to DC-006, the two evaluations use different references. The Spec_Restoration_Evaluation reference is the Ground Truth (the R3.13 expectation). The Compatibility_Evaluation reference (R13.3) is the actual legacy response. For each candidate, a human must therefore record a decision before modernization: replicate the legacy behavior, or follow R3.13. Until that decision is recorded, results for these inputs are not counted as ordinary passes or failures and are reported separately. The legacy app is not modified to make these scenarios pass without a recorded decision.

**Distinction between legacy execution results and Ground Truth:**

```
Legacy_App HTTP responses
  └─ Role: reference ("correct answer") for Compatibility_Evaluation
  └─ When used: during new-vs-old behavior comparison
  └─ Relationship to AI: AI may observe these during verification; never during spec restoration

Ground Truth (evaluation/ground-truth/ground-truth.json)
  └─ Role: reference for Spec_Restoration_Evaluation accuracy assessment
  └─ When used: when evaluating accuracy of AI-restored spec
  └─ Relationship to AI: NEVER included in AI input under any circumstances
```

AI inferring "expected values" by analyzing legacy source code is categorically different from the "human-manually-calculated correct values" recorded in Ground Truth. Whether the AI's inference matches Ground Truth is the core of the evaluation — the AI's inference must never become the Ground Truth. The fairness of the evaluation depends on AI having never read the Ground Truth.

---

## Correctness Properties

*A property is a characteristic or behavior that should hold true across all valid executions of a system — essentially, a formal statement about what the system should do. Properties serve as the bridge between human-readable specifications and machine-verifiable correctness guarantees.*

### Property 1: Subtotal Is the Sum of Line Totals

*For any* valid order containing one or more order lines, the `subtotal` returned in the response must equal the arithmetic sum of `unit_price × quantity` for every line in that order, where `unit_price` is the price recorded in the products table at the time the order is placed.

**Validates: Requirements 3.2**

### Property 2: Discount Is Determined Solely by Subtotal Tier

*For any* valid order, the `discount` returned in the response must equal exactly 0 if `subtotal < 3000`, exactly 300 if `3000 ≤ subtotal ≤ 9999`, and exactly 1000 if `subtotal ≥ 10000`.

**Validates: Requirements 3.3, 4.1**

### Property 3: Shipping Fee Is Determined Solely by Net Amount Tier

*For any* valid order, the `shipping_fee` returned in the response must equal exactly 500 if `(subtotal − discount) < 5000`, and exactly 0 if `(subtotal − discount) ≥ 5000`.

**Validates: Requirements 3.4, 4.2**

### Property 4: Total Equals the Arithmetic Combination of Computed Values

*For any* valid order, the `total` returned in the response must equal `subtotal − discount + shipping_fee` as computed from the other three fields in the same response. This must hold as exact integer arithmetic with no rounding.

**Validates: Requirements 3.5, 4.4**

### Property 5: Stock Quantity Never Becomes Negative

*For any* sequence of order placement requests against the legacy system, no product's `stock_quantity` in the database must ever fall below zero. An order that would cause any product's stock to go below zero must be rejected before any stock change is committed.

**Validates: Requirements 5.2, 5.4**

### Property 6: Order Cancellation Restores Exact Reserved Stock

*For any* order that is successfully placed and then successfully cancelled, the `stock_quantity` of every product referenced in that order must return to the same value it held immediately before the order was placed. The restoration must be exact: the sum of restorations across all lines equals the sum of reservations at placement time.

**Validates: Requirements 6.1, 5.5**

---

## Error Handling

### Response Consistency

All responses — success or error — use the uniform envelope defined in Components and Interfaces. No PHP runtime errors, stack traces, or HTML error pages are exposed to the caller. `display_errors` is set to `Off` in the PHP configuration; all errors are logged to the container's stderr.

### Transaction Failure

Any database error during an order placement or cancellation transaction causes an immediate rollback. The response body includes `"error": "Internal error"` with HTTP 500. No partial state is persisted.

### Input Validation Order

Input is validated in the following order before any database write:
1. Request structure (JSON parseable, required fields present)
2. Customer existence
3. Product existence (all IDs)
4. Minimum order value (Subtotal ≥ 1,000)
5. Stock availability (all products)

This ordering ensures that the most informative error is returned first and that no partial database reads are performed unnecessarily.

### Reset Failure

If any reset stage fails, the response is HTTP 500 with `{ "success": false, "error": "Reset failed", "details": { "step": "...", "state": "..." } }`. `details.step` names the failed step and `details.state` is one of:

| `details.state` | Meaning |
|-----------------|---------|
| `unchanged` | The reset failed before any change was made (e.g., the transaction could not begin). |
| `rolled_back` | A data-restore step failed and the transaction was rolled back; the database is as it was before the reset. |
| `data_reset_auto_increment_pending` | Data has been reset and committed, but the AUTO_INCREMENT reset did not complete (or the post-check found a counter not at 1). |
| `unknown` | The post-reset verification found a mismatch (or the commit outcome is uncertain); the database state cannot be assumed. |

In every failure case, the caller (Phoenix Verifier) must re-issue the reset request (the reset is idempotent) and must not treat the database as being in its initial state until a reset returns HTTP 200.

---

## Testing Strategy

This feature covers a Docker-deployed PHP 5.6 application with a MySQL backend. The testing approach is:

**Property-based tests** (Vitest + fast-check, run from the Phoenix Verifier against the running container):

- Each property is implemented as a property-based test using the seed product prices as fixed input parameters and varying order line quantities to exercise the full input space for each tier boundary.
- Minimum 100 iterations per property test.
- Tag format: `Feature: legacy-sample, Property {N}: {property_text}`

Property tests run against the live legacy container over HTTP. Each test calls `POST /reset` before the run to ensure a known starting state.

**Integration tests** (example-based, Vitest):
- Order placement error paths (missing customer, bad product IDs, insufficient stock)
- Order cancellation error paths (not found, already cancelled, non-cancellable)
- Order history retrieval (list and single)
- Reset idempotency (reset twice, compare product stock quantities)
- Simultaneous placement that would over-commit stock (atomicity)
- Ship order via `POST /test/orders/{id}/ship` then attempt cancellation → expect 409

**Smoke tests** (single execution, startup validation):
- Health check endpoint returns `{ "app": "ok", "db": "ok" }` within 30 seconds of container start
- Seed data: at least 5 products and 3 customers present after startup
- `docker compose -f infra/docker-compose.yml --project-directory . up -d --build` completes without error on a clean machine

**PHP code review (manual):**
- Requirements 10.1–10.4 (no business-rule comments, procedural style, no classes) are verified by code review, not automated tests.

**Docker configuration verification (manual/scripted):**
- Confirm `legacy-internal` network has `internal: true`
- Confirm `legacy-api` network is a standard bridge (not internal)
- Confirm `legacy-app` and `legacy-db` are each connected to `legacy-internal` only
- Confirm `reverse-proxy` is connected to both `legacy-internal` and `legacy-api`
- Confirm `legacy-app` and `legacy-db` publish no host ports (no `ports:` entry)
- Confirm the only published port is the reverse-proxy's `127.0.0.1:8056` (container port 8080), not `0.0.0.0`
- Confirm `grep -r "evaluation" infra/docker-compose.yml` returns zero matches
- Confirm non-root container users (`legacy-app` 1000, `legacy-db` 999, `reverse-proxy` 101)
- Confirm `legacy/src/` is mounted read-only
- Confirm `infra/nginx/nginx.conf` is mounted read-only into the reverse-proxy, and that the proxy runs with a read-only root filesystem, a `/tmp` tmpfs, `cap_drop: ALL`, and `no-new-privileges`
- Confirm CPU and memory limits in `docker-compose.yml`: 0.5 CPU / 128 MB for `legacy-app` and `legacy-db`, 0.25 CPU / 64 MB for `reverse-proxy`
- Confirm `allow_url_fopen = Off`, `allow_url_include = Off`, and socket/curl functions disabled in `php.ini` (mitigations only; see Docker Network Rationale)
- Confirm `dns: ["127.0.0.1"]` is set on `legacy-app` (mitigation only)

**Automated network isolation measurement:** `tests/legacy-sample/test_network_isolation.ps1` measures the isolation rather than inferring it from configuration. It checks network topology and published ports, and runs TCP reachability probes with positive controls (legacy-app → legacy-db:3306 and legacy-db → legacy-app:80 must succeed, so a probe can report "connected"). It verifies that legacy-app and legacy-db cannot open TCP connections to external IPs (1.1.1.1:53, 8.8.8.8:53, 1.1.1.1:443, 9.9.9.9:443) or resolve external names, and that port 8056 is unreachable on the host's non-loopback IPv4 addresses. It also starts a canary container on `legacy-api` and sends crafted requests (absolute URI, Host header, path tricks, override headers, CONNECT, PUT/DELETE/PATCH/OPTIONS) to confirm the proxy forwards nothing to arbitrary destinations.

Paths that are not measured (UDP, ICMP, outbound IPv6, and destinations other than those above) are not considered safe. The reverse-proxy's own outbound TCP access is measured as possible and is a known residual (see Docker Network Rationale).

---

## Docker and Deployment Design

### `docker-compose.yml` Service Overview

```yaml
services:
  legacy-db:
    image: mysql:5.7
    environment:
      MYSQL_ROOT_PASSWORD: ${LEGACY_DB_ROOT_PASSWORD}
      MYSQL_DATABASE:      ${LEGACY_DB_NAME}
      MYSQL_USER:          ${LEGACY_DB_USER}
      MYSQL_PASSWORD:      ${LEGACY_DB_PASSWORD}
    volumes:
      - ./legacy/sql/schema.sql:/docker-entrypoint-initdb.d/01_schema.sql:ro
      - ./legacy/sql/seed.sql:/docker-entrypoint-initdb.d/02_seed.sql:ro
      - legacy-db-data:/var/lib/mysql
    networks:
      - legacy-internal
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 128M
    user: "999:999"
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost", "--silent"]
      interval: 5s
      timeout: 5s
      retries: 12

  legacy-app:
    build: ./legacy
    environment:
      DB_HOST: legacy-db
      DB_PORT: "3306"
      DB_NAME: ${LEGACY_DB_NAME}
      DB_USER: ${LEGACY_DB_USER}
      DB_PASS: ${LEGACY_DB_PASSWORD}
    volumes:
      - ./legacy/src:/var/www/html:ro
    networks:
      - legacy-internal
    dns:
      - "127.0.0.1"
    depends_on:
      legacy-db:
        condition: service_healthy
    deploy:
      resources:
        limits:
          cpus: "0.5"
          memory: 128M
    user: "1000:1000"

  reverse-proxy:
    image: nginxinc/nginx-unprivileged:1.27-alpine@sha256:65e3e85dbaed8ba248841d9d58a899b6197106c23cb0ff1a132b7bfe0547e4c0
    entrypoint: ["nginx", "-g", "daemon off;"]
    volumes:
      - ./infra/nginx/nginx.conf:/etc/nginx/nginx.conf:ro
    ports:
      - "127.0.0.1:8056:8080"
    networks:
      - legacy-internal
      - legacy-api
    depends_on:
      legacy-app:
        condition: service_started
        restart: true
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    deploy:
      resources:
        limits:
          cpus: "0.25"
          memory: 64M
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/health"]
      interval: 5s
      timeout: 5s
      retries: 12

networks:
  legacy-internal:
    driver: bridge
    internal: true
  legacy-api:
    driver: bridge

volumes:
  legacy-db-data:
```
### Reverse proxy

The `reverse-proxy` service is the only component published to the host. Its configuration is `infra/nginx/nginx.conf`, mounted read-only.

- One upstream with one fixed server, `legacy-app:80`. The `proxy_pass` target is the literal upstream name; no variable is used to build a destination.
- Only `GET` and `POST` are accepted (`limit_except GET POST { deny all; }`); other methods are refused.
- No `resolver` directive, no status or admin endpoints, and no other `location` blocks. A single `server` block with one `location /`.
- `server_tokens off`, and the request body is limited to 1 MB (`client_max_body_size 1m`).
- Temporary paths are under `/tmp`, which is a tmpfs, so the root filesystem can stay read-only.
- The upstream name `legacy-app` is resolved by nginx at startup. If `legacy-app` is recreated (new IP), the proxy must restart to pick it up. `depends_on` with `restart: true` makes Compose restart the proxy when `legacy-app` is recreated.
- The image is pinned by digest (`nginxinc/nginx-unprivileged:1.27-alpine@sha256:...`). The container starts nginx directly through `entrypoint` and runs as uid 101.

### `legacy/Dockerfile`

```dockerfile
FROM php:5.6-apache

# Create non-root user
RUN groupadd -g 1000 appuser && useradd -u 1000 -g appuser -s /sbin/nologin appuser

# Install mysqli extension
RUN docker-php-ext-install mysqli

# Restrict outbound PHP capabilities
RUN echo "allow_url_fopen = Off" >> /usr/local/etc/php/php.ini \
 && echo "allow_url_include = Off" >> /usr/local/etc/php/php.ini \
 && echo "disable_functions = fsockopen,socket_create,socket_connect,curl_init,curl_exec" >> /usr/local/etc/php/php.ini

# Apache configuration: disable directory listing
RUN a2enmod rewrite

USER appuser

EXPOSE 80
```

### Environment Variables (`.env.example`)

```dotenv
# Legacy MySQL
LEGACY_DB_ROOT_PASSWORD=changeme_root
LEGACY_DB_NAME=legacy_orders
LEGACY_DB_USER=legacy_app
LEGACY_DB_PASSWORD=changeme_app
```

No secret values are committed. Developers copy `.env.example` to `.env` and change passwords before first use. The application does not require real secrets for local development; the placeholder values in `.env.example` are sufficient to start the container.

### Container Startup Sequence

1. `legacy-db` starts and runs MySQL init scripts (`01_schema.sql`, `02_seed.sql`).
2. `legacy-db` healthcheck passes (mysqladmin ping succeeds).
3. `legacy-app` starts (after `legacy-db` is healthy); Apache begins serving on port 80 inside `legacy-internal`.
4. `reverse-proxy` starts (after `legacy-app` has started) and listens on container port 8080, published as `127.0.0.1:8056`.
5. Phoenix Verifier polls `GET /health` through the reverse-proxy (`127.0.0.1:8056`) until the response is `200` with `{ "db": "ok" }`, with a 30-second timeout. The reverse-proxy's own healthcheck also requests `/health` on `127.0.0.1:8080`, so it passes only when the path proxy → app → db works.

The MySQL init scripts in `/docker-entrypoint-initdb.d/` are executed in filename order on first container creation. They are mounted read-only.

### Volume Summary

| Mount | Host Path | Container Path | Mode |
|-------|-----------|---------------|------|
| PHP source | `./legacy/src` | `/var/www/html` | read-only |
| SQL schema | `./legacy/sql/schema.sql` | `/docker-entrypoint-initdb.d/01_schema.sql` | read-only |
| SQL seed | `./legacy/sql/seed.sql` | `/docker-entrypoint-initdb.d/02_seed.sql` | read-only |
| DB data | `legacy-db-data` (named volume) | `/var/lib/mysql` | read-write |
| Proxy config | `./infra/nginx/nginx.conf` | `/etc/nginx/nginx.conf` | read-only |
| Proxy temp | tmpfs (no host path) | `/tmp` | read-write (in memory) |

`evaluation/ground-truth/` is not mounted in any service.

---

## Non-Determinism Handling

### Non-Deterministic Fields

| Field | Location | Source |
|-------|----------|--------|
| `order_id` (and `id`) | `orders` table, all order-related responses | AUTO_INCREMENT |
| `created_at` | `orders` table, order detail responses | `CURRENT_TIMESTAMP` at INSERT |

### Normalization Strategy

**For Phoenix Verifier comparisons (Compatibility Evaluation):**

The Ground Truth scenario definitions include a `non_deterministic_fields` array listing JSON path expressions for fields that must not be compared by value. The Verifier applies the following rules:

1. Fields in `non_deterministic_fields` are compared only for presence and type (integer for IDs, ISO 8601 string for timestamps).
2. All other fields are compared for exact value equality.
3. When an `order_id` returned by the Legacy App is needed as input to a subsequent request (e.g., cancel the order just placed), the Verifier captures the ID from the response and uses it as a variable — it does not hardcode IDs in scenario definitions.

**For Auto_INCREMENT reset:**

The `POST /reset` endpoint executes the following after the data-restore transaction has committed (outside the transaction; see the Reset endpoint specification):
```sql
ALTER TABLE orders AUTO_INCREMENT = 1;
ALTER TABLE order_lines AUTO_INCREMENT = 1;
```

This guarantees that after a reset, the first order created receives `id = 1`. Scenarios defined in the Ground Truth may reference `order_id = 1` for the first order after a reset, making scenario definitions predictable.

**For `created_at` field format:**

The Legacy App returns `created_at` formatted as an ISO 8601 string (`Y-m-d\TH:i:sP` in PHP). The Modern App must use the same format. The Verifier masks this field during equality comparison.
