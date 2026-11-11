# Requirements Document

## Introduction

This document defines the requirements for the `legacy-sample` — a small, self-contained order-management application built on PHP 5.6 and MySQL 5.7. It serves as the analysis target for Project Phoenix's AI-driven spec restoration, modernization, and compatibility verification pipeline.

The sample app is intentionally written in procedural PHP without modern frameworks, with business rules embedded directly in source code and no external specification documents. This reproduces the real-world conditions of an undocumented legacy system. The system runs exclusively inside an isolated Docker environment, and its exposure to the host is limited to the loopback interface (127.0.0.1) through a reverse proxy. Outbound traffic from the legacy-app and legacy-db containers is blocked by an `internal: true` network, and this block has been confirmed by measurement for TCP connections to the tested external addresses and for external name resolution (Requirement 11). The reverse-proxy container itself is connected to a non-internal network that permits outbound traffic and is therefore operated with a fixed-upstream-only configuration; paths that have not been measured (such as UDP, ICMP, and IPv6) are not assumed to be blocked.

A separate **ground-truth specification** is stored under `evaluation/ground-truth/` — outside both `legacy/` and `packages/` — so that it is structurally separated from the source corpus and pipeline packages accessed by the Phoenix AI. The ground truth is used exclusively by evaluation programs to compare AI-restored specs and compatibility test results against authoritative expected values. It is never passed to the Phoenix AI pipeline during spec restoration.

---

## Glossary

- **Legacy_App**: The PHP 5.6 / MySQL 5.7 order-management application defined in this spec, running inside the legacy Docker container.
- **Product**: A purchasable item with a name, unit price, and current stock quantity.
- **Customer**: A person or entity that places Orders; identified by a unique identifier and name in the Customer master table.
- **Order**: A transactional record that groups one or more Order_Lines under a single customer reference.
- **Order_Line**: A single line within an Order representing a quantity of one Product.
- **Subtotal**: The sum of (unit price × quantity) across all Order_Lines of an Order, before any discount or shipping fee is applied.
- **Discount**: A reduction applied to the Subtotal according to embedded business rules (e.g., order-amount threshold).
- **Net_Amount**: The Order Subtotal minus the Discount; the intermediate value used to determine the Shipping_Fee. Computed as Net_Amount = Subtotal − Discount.
- **Shipping_Fee**: A flat or rule-based charge added after the Discount is applied, determined by the Net_Amount.
- **Total**: Subtotal − Discount + Shipping_Fee.
- **Minimum_Order_Value**: The minimum Subtotal (before discount) required for an order to be accepted; set to 1,000 yen.
- **Stock_Reservation**: The act of reducing available stock when an Order is placed.
- **Stock_Restoration**: The act of returning reserved stock to available quantity when an Order is cancelled.
- **Test_API**: The HTTP interface exposed by the Legacy_App for programmatic invocation by the Phoenix verifier.
- **Ground_Truth**: The expected specification of inputs and outputs, stored under `evaluation/ground-truth/` and used to evaluate AI-restored specs. It becomes authoritative only after human review. A draft may be prepared by the development agent from the approved requirements and design, never from legacy output and never by the Phoenix runtime AI. The review status is recorded in the file itself.
- **Ground_Truth_Conformance_Run**: The execution of the Ground_Truth scenarios against the Legacy_App to record where the legacy behavior follows or differs from the expected specification; it is neither a Spec_Restoration_Evaluation nor a Compatibility_Evaluation.
- **Migration_Decision**: A human decision, recorded in `evaluation/migration-decisions.json`, for a scenario whose observed legacy behavior differs from the expected specification (replicate the legacy behavior or follow the expected specification), or, as a specification decision, for a scenario whose expected behavior is not yet determined.
- **Spec_Restoration_Evaluation**: The process of comparing an AI-restored specification document against the Ground_Truth to assess the accuracy of AI-inferred business rules.
- **Compatibility_Evaluation**: The process of comparing HTTP responses of the Legacy_App and the modernized app for identical inputs to assess behavioral equivalence.
- **Discovery_Loop**: An automated iteration cycle in which the Phoenix pipeline resets the Legacy_App, submits a test scenario, collects the response, and proceeds to the next scenario without manual intervention.
- **Phoenix_Verifier**: The `packages/verifier` module of Project Phoenix that drives the Legacy_App via the Test_API and records results.
- **Docker_Network**: The pair of Docker networks used by the legacy environment: `legacy-internal` (`internal: true`; connects legacy-db, legacy-app, and reverse-proxy) and `legacy-api` (standard bridge, not `internal`; connects reverse-proxy only).
- **Reverse_Proxy**: The minimal nginx container that publishes the Test_API on the host at 127.0.0.1:8056 and forwards requests only to the fixed upstream legacy-app:80.

---

## Requirements

### Requirement 1: Product Catalog

**User Story:** As a Phoenix engineer, I want the Legacy_App to maintain a product catalog, so that orders can reference products with known prices and stock levels.

#### Acceptance Criteria

1. THE Legacy_App SHALL store each Product with at least the following attributes: unique identifier, name (1–255 characters), unit price (integer yen, 1 to 9,999,999), and current stock quantity (integer, 0 to 999,999).
2. WHEN a request is made to list all Products, THE Legacy_App SHALL return all Products currently stored in the database, each including all attributes defined in criterion 1.
3. WHEN a request is made to retrieve a single Product by its identifier, THE Legacy_App SHALL return that Product's attributes as defined in criterion 1.
4. IF a request is made to retrieve a Product using an identifier that does not exist, THEN THE Legacy_App SHALL return an error response indicating the Product was not found, and no Product data shall be included in the response.
5. THE Legacy_App SHALL seed the database with at least five distinct Products on initialization, providing a reproducible baseline for testing, where each seeded Product satisfies all attribute constraints defined in criterion 1.
6. IF a request is made to store a Product with a name exceeding 255 characters, a unit price less than 1 or greater than 9,999,999, or a stock quantity less than 0 or greater than 999,999, THEN THE Legacy_App SHALL reject the request with an error response indicating which attribute constraint was violated.

---

### Requirement 2: Customer Master Data

**User Story:** As a Phoenix engineer, I want the Legacy_App to maintain a customer master with fixed seed data, so that order placement can reference known customer records without requiring a customer management UI.

#### Acceptance Criteria

1. THE Legacy_App SHALL store each Customer with at least the following attributes: unique identifier and customer name (1–255 characters).
2. THE Legacy_App SHALL seed the database with at least three distinct Customers on initialization; these seed records SHALL remain unchanged by any pipeline operation.
3. THE Legacy_App SHALL NOT expose any HTTP endpoint for creating, updating, or deleting Customer records; customer data is managed exclusively through the seed SQL files.
4. WHEN an order placement request references a Customer identifier that exists in the Customer master, THE Legacy_App SHALL accept the reference and associate the Order with that Customer.
5. IF an order placement request references a Customer identifier that does not exist in the Customer master, THEN THE Legacy_App SHALL reject the request and return an error response indicating the Customer was not found, without creating any Order or modifying any stock.

---

### Requirement 3: Order Placement

**User Story:** As a Phoenix engineer, I want the Legacy_App to accept order placement requests, so that the full order-creation path, including calculations and stock changes, can be analyzed and verified.

#### Acceptance Criteria

1. WHEN an order placement request is received containing a customer reference and between 1 and 100 Order_Lines (each specifying a Product identifier and a positive integer quantity), THE Legacy_App SHALL create an Order record and the corresponding Order_Line records in the database.
2. WHEN an Order is created, THE Legacy_App SHALL compute the Subtotal as the sum of (unit price × quantity) for all Order_Lines, where the unit price is the price recorded on the Product at the time the order is created.
3. WHEN an Order is created, THE Legacy_App SHALL compute the Discount by applying embedded business rules to the Subtotal.
4. WHEN an Order is created, THE Legacy_App SHALL compute the Shipping_Fee by applying embedded business rules to the Net_Amount.
5. WHEN an Order is created, THE Legacy_App SHALL compute the Total as Subtotal − Discount + Shipping_Fee and persist this value.
6. WHEN an Order is created, THE Legacy_App SHALL perform a Stock_Reservation by reducing each referenced Product's stock quantity by the ordered quantity; if the reservation cannot be completed for all Order_Lines as a single atomic operation, THE Legacy_App SHALL leave all stock quantities unchanged.
7. IF an order placement request is missing a customer reference or contains a customer reference that does not correspond to an existing Customer record, THEN THE Legacy_App SHALL reject the request and return an error response without creating any Order or modifying any stock.
8. IF an order placement request contains one or more Product identifiers that do not exist, THEN THE Legacy_App SHALL reject the request and return an error response identifying all unrecognised Product identifiers, without creating any Order or modifying any stock.
9. IF an order placement request specifies a quantity that exceeds the available stock of any Product, THEN THE Legacy_App SHALL reject the request and return an error response identifying each Product with insufficient stock by its identifier, its current stock quantity (`available`), and the requested quantity (`requested`), without creating any Order or modifying any stock.
10. IF an order placement request contains no Order_Lines, THEN THE Legacy_App SHALL reject the request and return an error response.
11. IF an order placement request has a Subtotal (computed as the sum of unit price × quantity before any discount) less than 1,000 yen, THEN THE Legacy_App SHALL reject the request and return an error response indicating the minimum order value has not been met, without creating any Order or modifying any stock.
12. WHEN an Order is successfully created, THE Legacy_App SHALL return the Order identifier and the computed Subtotal, Discount, Shipping_Fee, and Total values in the response.
13. IF an order placement request contains an Order_Line whose quantity is not a JSON positive integer, THEN THE Legacy_App SHALL reject the whole request with HTTP 400 and the error "Invalid request", without creating any Order or Order_Line and without modifying any stock. The following quantity values are invalid: zero, negative numbers, non-integer numbers (e.g. 1.5), strings including numeric strings (e.g. "5", "05", " 5", "5.0", "+5", "abc"), null, booleans, arrays, objects, and a missing quantity property. Note: the current legacy implementation does not meet this criterion (defect candidates DC-001..DC-006) and is intentionally not changed; the modern application must meet it (approved migration decisions MD-001..MD-006).

---

### Requirement 4: Discount and Shipping Fee Calculation Rules

**User Story:** As a Phoenix engineer, I want the discount and shipping fee calculation rules to be deterministic and verifiable, so that the AI-restored spec can be evaluated against known expected outputs.

#### Acceptance Criteria

1. THE Legacy_App SHALL implement a Discount calculation with exactly three tiers based on the Order Subtotal: (a) Subtotal less than 3,000 yen → Discount is 0 yen; (b) Subtotal between 3,000 yen and 9,999 yen (inclusive) → Discount is 300 yen; (c) Subtotal of 10,000 yen or more → Discount is 1,000 yen; this logic SHALL be expressed as conditional statements embedded in PHP source files with no comment identifying the tier or its business purpose.
2. THE Legacy_App SHALL implement a Shipping_Fee calculation with two tiers based on the Net_Amount (Subtotal − Discount): (a) Net_Amount less than 5,000 yen → Shipping_Fee is 500 yen; (b) Net_Amount of 5,000 yen or more → Shipping_Fee is 0 yen; this logic SHALL be expressed as conditional statements embedded in PHP source files with no comment identifying the tier or its business purpose.
3. THE Legacy_App SHALL enforce a minimum order value of 1,000 yen based on the Order Subtotal before discount; this rule SHALL be expressed as a conditional check embedded in PHP source files, evaluated before any Discount or Shipping_Fee calculation, with no comment identifying the rule's business purpose.
4. THE Legacy_App SHALL compute Total as an integer: Total = Subtotal − Discount + Shipping_Fee, where Subtotal, Discount, Shipping_Fee, and Total are all non-negative integers expressed in yen with no floating-point arithmetic involved.
5. THE Ground_Truth SHALL record the following eleven input values and their expected Discount and Shipping_Fee outputs to cover all boundary conditions: Subtotal = 0, 999, 1,000, 2,999, 3,000, 4,999, 5,000, 5,299, 5,300, 9,999, and 10,000 yen.

---

### Requirement 5: Stock Check and Reservation

**User Story:** As a Phoenix engineer, I want stock management to be atomically linked to order creation, so that stock behavior under concurrent and sequential test scenarios is predictable and verifiable.

#### Acceptance Criteria

1. WHEN an Order record is committed to the database, THE Legacy_App SHALL decrement the `stock_quantity` of each ordered Product by the exact ordered quantity within the same database transaction as the Order record insertion.
2. IF the `stock_quantity` of any Product in an order placement request is less than the requested quantity for that Product, THEN THE Legacy_App SHALL abort the entire transaction, leave all `stock_quantity` values unchanged, and return an error response identifying each Product with insufficient stock by its identifier, its current stock quantity (`available`), and the requested quantity (`requested`).
3. WHILE an Order is in a non-cancelled state, THE Legacy_App SHALL compute and expose each Product's available quantity as `stock_quantity` minus the sum of ordered quantities for that Product across all non-cancelled Orders.
4. THE Legacy_App SHALL enforce that a Product's `stock_quantity` never becomes negative as a result of order placement.
5. WHEN an Order transitions to a cancelled state, THE Legacy_App SHALL restore the `stock_quantity` of each ordered Product by adding back the cancelled ordered quantity within the same database transaction as the cancellation.

---

### Requirement 6: Order Cancellation and Stock Restoration

**User Story:** As a Phoenix engineer, I want the Legacy_App to support order cancellation with stock restoration, so that the cancellation path can be included in compatibility verification scenarios.

#### Acceptance Criteria

1. WHEN a cancellation request is received for an Order that exists and is not already cancelled, THE Legacy_App SHALL update the Order status to cancelled and restore the `stock_quantity` of each ordered Product by adding back the quantity reserved in that Order; either both the status update and all stock restorations complete successfully, or none of them are applied.
2. IF a cancellation request is received for an Order identifier that does not exist, THEN THE Legacy_App SHALL return an error response indicating the Order was not found, without modifying any data.
3. IF a cancellation request is received for an Order that is already cancelled, THEN THE Legacy_App SHALL return an error response indicating the Order is already cancelled, without modifying any data.
4. THE Legacy_App SHALL maintain an explicit classification of each Order status as either cancellable or non-cancellable; IF a cancellation request is received for an Order whose current status is classified as non-cancellable, THEN THE Legacy_App SHALL return an error response indicating the Order cannot be cancelled in its current status, without modifying any data.
5. THE Legacy_App SHALL support at least one non-cancellable Order status to ensure that the cancellation rejection path is exercisable in compatibility testing.
6. WHEN an Order is successfully cancelled, THE Legacy_App SHALL return a confirmation response including each affected Product's identifier and its final `stock_quantity` after restoration.

---

### Requirement 7: Order History

**User Story:** As a Phoenix engineer, I want the Legacy_App to expose order history, so that read-path behavior can be included in compatibility verification scenarios.

#### Acceptance Criteria

1. WHEN a request to list all Orders is received, THE Legacy_App SHALL return a collection of all Orders, each including its identifier, status, Subtotal, Discount, Shipping_Fee, and Total, without Order_Line details.
2. WHEN a request to retrieve a single Order by its identifier is received, THE Legacy_App SHALL return that Order's identifier, status, Subtotal, Discount, Shipping_Fee, and Total, together with all associated Order_Lines each including Product identifier, quantity, and unit price at time of ordering.
3. IF a request is made to retrieve an Order using an identifier that does not exist, THEN THE Legacy_App SHALL return an error response indicating the Order was not found.
4. IF a request to list all Orders is received and no Orders exist, THEN THE Legacy_App SHALL return an empty collection with no error indication.

---

### Requirement 8: Test API Interface

**User Story:** As a Phoenix engineer, I want the Legacy_App to expose a structured HTTP interface, so that the Phoenix_Verifier can invoke scenarios programmatically without manual interaction.

#### Acceptance Criteria

1. THE Legacy_App SHALL expose a Test_API over HTTP that accepts and returns JSON-encoded payloads for all operations defined in Requirements 1 through 7.
2. THE Test_API SHALL be accessible to the Phoenix_Verifier via the Docker internal network and via the host loopback address `127.0.0.1:8056` (through the Reverse_Proxy) without requiring authentication credentials.
3. THE Test_API SHALL include a health-check endpoint that returns a JSON response body containing at least a status field for the application and a status field for the database connection, both indicating operational status.
4. THE Test_API SHALL include a reset endpoint that, when called, restores the database to its seeded initial state and returns a JSON response body confirming the number of Order and Order_Line records deleted and the number of Products whose stock quantities were restored.
5. WHEN the reset endpoint is called, THE Legacy_App SHALL ensure either all Order records, Order_Line records, and Product stock quantities are restored to the seeded state, or none of the changes are applied; partial resets are not permitted.
6. THE Test_API SHALL return exactly one HTTP status code per response, where that code falls within the 2xx range for success, the 4xx range for client errors, and the 5xx range for server errors.
7. THE Test_API SHALL be reachable only between containers on the `legacy-internal` network and from the host via the loopback address `127.0.0.1:8056` published by the Reverse_Proxy; THE Legacy_App container and the legacy-db container SHALL NOT publish any port to the host, and THE Test_API SHALL NOT be bound to `0.0.0.0` or to any non-loopback host address.
8. IF the reset endpoint fails to restore the database to its seeded state, THEN THE Legacy_App SHALL return a 5xx error response and leave the database in a state that can be reported to the caller.

---

### Requirement 9: Ground Truth Specification

**User Story:** As a Phoenix engineer, I want the expected behavior of the Legacy_App to be documented in a machine-readable ground-truth file stored in `evaluation/ground-truth/`, so that it is never passed to the Phoenix AI pipeline during spec restoration and can be used exclusively by evaluation programs to compare AI-restored specs and compatibility test results against authoritative expected values.

#### Acceptance Criteria

1. THE Ground_Truth SHALL be stored under `evaluation/ground-truth/` (outside both `legacy/` and `packages/`), so that it is structurally separated from the source corpus and pipeline packages accessed by the Phoenix AI.
2. THE Phoenix AI pipeline (spec-restorer, modernizer, and analyzer modules) SHALL NOT receive the contents of `evaluation/ground-truth/` as input; the pipeline input SHALL be limited to an explicit allowlist of concrete file paths within `legacy/src/` and `legacy/sql/`, and the pipeline SHALL NOT discover or add input files by scanning or recursively enumerating directories or by expanding wildcards.
3. THE evaluation programs that compare AI-restored specs or compatibility test results against the Ground_Truth SHALL reside outside `legacy/src/` and SHALL access `evaluation/ground-truth/` exclusively through documented, explicit file references, not through directory scans of `legacy/`.
4. THE Ground_Truth SHALL include a test case that verifies the `evaluation/ground-truth/` directory is not reachable via the Test_API or the Legacy_App's HTTP interface, confirming that the ground truth cannot be inadvertently exposed to the AI pipeline through the running system.
5. THE Ground_Truth SHALL document, for each verifiable scenario, a unique scenario identifier, the input payload, the expected HTTP status code, and the expected response body fields; for success scenarios, expected fields include computed monetary values expressed as integers in yen; for rejection scenarios, expected fields include an error indicator sufficient to distinguish the rejection reason.
6. THE Ground_Truth SHALL cover at least the following scenario categories, with at least one scenario per category: successful order placement with monetary calculations, order placement rejected due to minimum order value not met, order placement rejected due to insufficient stock, order placement rejected due to missing product, order cancellation with stock restoration, and order cancellation rejected for invalid or already-cancelled orders.
7. THE Ground_Truth SHALL record the minimum order value, Discount tier thresholds, and Shipping_Fee tier thresholds as literal numeric constants within the Ground_Truth file itself, not as references to source-code symbols or file paths.
8. THE Ground_Truth SHALL be stored in a structured, machine-readable format (JSON or YAML) so that the Phoenix_Verifier can load it without manual parsing.
9. THE Phoenix AI pipeline SHALL validate each input path against the allowlist by resolving real paths and rejecting `..` traversal and symlinks that leave the allowed set; SHALL stop the run without skipping silently when any path is unreadable, not on the allowlist, extra, or missing (fail closed); SHALL record a per-run input manifest of path and content hash that equals the allowlist exactly; and SHALL verify that the content actually sent to the AI provider contains no content derived from `evaluation/ground-truth/` and no path outside the allowlist.
10. THE Ground_Truth SHALL contain only the expected specification; observed Legacy_App behavior, the comparison, and the Migration_Decision status SHALL be recorded separately (in a generated result file and in the decision registry), and expected values SHALL NOT be changed to match observed legacy behavior.
11. THE Ground_Truth SHALL record its review status and, once approved, the approver and the approval time (ISO 8601 with offset); THE Ground_Truth SHALL mark expected values whose exact response code or message is not yet confirmed; WHERE the expected behavior of a scenario is not determined, THE Ground_Truth SHALL mark the scenario undetermined with a reason instead of an expected value.
12. THE Ground_Truth_Conformance_Run SHALL pass its gate only when every scenario either matches without a decision record or is a detected mismatch covered by a decided Migration_Decision; THE Ground_Truth_Conformance_Run SHALL fail its gate for a mismatch without a decision record, for a pending (unapproved) Migration_Decision, for an undetermined expectation, for a decision record whose scenario now matches, for any execution error, for any executed boundary case that does not match, and for any inconsistency in the decision registry (unknown or duplicate entries, defect candidates that differ from the Ground_Truth, decided entries without approver, approval time or rationale).
13. THE Ground_Truth_Conformance_Run SHALL report boundary cases or scenarios that were not executed as not executed, with the reason, and SHALL NOT count them as passes.
14. THE Ground_Truth_Conformance_Run SHALL start each scenario from the initial state (reset), SHALL mask non-deterministic values (`order_id`, `created_at`) including inside difference messages, SHALL store no wall-clock values, SHALL record content hashes of the Ground_Truth, the decision registry, and the allowlisted legacy files, and SHALL produce byte-identical result files on repeated runs against the same inputs.
15. THE AI input isolation SHALL be verified with canary strings: the Ground_Truth SHALL contain a unique canary value that appears in no other repository file, no container, and no database content; until the analyzer and spec-restorer exist, the rule SHALL be verified with a reference allowlist builder and canary decoys, and the check of the payload actually sent to the AI provider (criterion 9) SHALL be reported as unverified rather than passed.
16. THE Ground_Truth_Conformance_Run SHALL list every mismatch covered by a follow-the-expected-specification decision as an approved divergence (scenario, decision, defect candidates, approver, legacy response, approved target), so that the Compatibility_Evaluation can report it as an approved difference rather than a failure.
17. THE Ground_Truth SHALL verify that the shipping fee is decided on the Net_Amount with boundary cases at Subtotal 5,299 yen (Discount 300, Net_Amount 4,999, Shipping_Fee 500, Total 5,499) and 5,300 yen (Discount 300, Net_Amount 5,000, Shipping_Fee 0, Total 5,000).
18. FOR the Ground_Truth HTTP isolation scenario, THE expected result SHALL be a 4xx rejection whose body contains no Ground_Truth content and no canary value; the exact response body SHALL NOT be required.

---

### Requirement 10: Embedded Business Rules as AI Analysis Target

**User Story:** As a Phoenix engineer, I want the Legacy_App's business rules to be embedded directly in PHP source code without external documentation, so that they represent an authentic target for AI-driven spec restoration.

#### Acceptance Criteria

1. THE Legacy_App SHALL implement all of the following business-rule categories as conditional statements embedded directly in PHP source files: (a) order-total discount tiers with at least 3 distinct quantity or value thresholds, (b) shipping fee calculation with at least 2 distinct bands based on order total value, and (c) a minimum-order-value rule below which checkout is rejected — with no comment on any of these conditional blocks that names, labels, or describes the business purpose of that condition (e.g., no `// bulk discount`, no `// free shipping threshold`).
2. THE Legacy_App SHALL implement stock-check and stock-reservation logic within the same PHP source file and function scope as the order-processing entry point, with no separate PHP file, class, or named interface dedicated solely to stock management.
3. THE Legacy_App SHALL NOT include, within `legacy/src/`, any file whose primary content is a description of business rules (such as a README, design note, or specification document), nor any PHPDoc block (`/** ... */`) or inline comment that states the purpose, name, or rationale of a business rule — neutral structural comments (e.g., `// loop over cart items`, `// connect to database`) are permitted.
4. THE Legacy_App source code SHALL be written in procedural PHP 5.6 style: only global functions and procedural script files are permitted; PHP classes, interfaces, traits, namespaces, and dependency injection constructs SHALL NOT appear anywhere in `legacy/src/`.

---

### Requirement 11: Docker Isolation and Security

**User Story:** As a Phoenix engineer, I want the Legacy_App to run in a strictly isolated Docker environment, so that the unpatched PHP 5.6 runtime cannot affect the host machine, network, or other containers.

#### Acceptance Criteria

1. THE Legacy_App environment SHALL consist of exactly three containers (legacy-db, legacy-app, and reverse-proxy) and exactly two Docker networks: `legacy-internal`, configured with `internal: true`, to which the legacy-db, legacy-app, and reverse-proxy containers are connected, and `legacy-api`, a standard bridge network that is not `internal`, to which only the reverse-proxy container is connected; THE legacy-app container and the legacy-db container SHALL be connected only to `legacy-internal` and SHALL NOT publish any port to the host; THE reverse-proxy container SHALL be the only container that publishes a port to the host, at `127.0.0.1:8056` (container port 8080).
2. THE Legacy_App container SHALL run as a non-root unprivileged user with a UID greater than 0.
3. THE Legacy_App container SHALL mount the `legacy/src/` directory as read-only; no pipeline component SHALL write to `legacy/src/` through the container mount.
4. THE Legacy_App container SHALL have CPU and memory resource limits defined in `docker-compose.yml`, with a maximum of 1.0 CPU core and 256 MB of memory.
5. THE Legacy_App environment SHALL NOT publish any port to `0.0.0.0`; the only host port binding SHALL be the Reverse_Proxy binding at `127.0.0.1:8056`, and the legacy-app and legacy-db containers SHALL NOT publish any port.
6. THE Legacy_App container SHALL mount only the directories explicitly required for operation (`legacy/src/` and `legacy/sql/`), and THE Reverse_Proxy container SHALL mount only its own configuration file (`infra/nginx/nginx.conf`) as read-only; no host home directory, `.ssh` directory, or path outside `legacy/` SHALL be mounted.
7. THE Legacy_App SHALL NOT implement deliberate security vulnerabilities such as SQL injection, path traversal, or remote code execution vectors; the isolation requirement is designed to contain the risk of unpatched runtime vulnerabilities in PHP 5.6, not to compensate for intentional application weaknesses.
8. THE Legacy_App environment SHALL block outbound network traffic from the legacy-app container and the legacy-db container at the network level by means of the `internal: true` network; this block SHALL be verified, before any unknown or untrusted code is executed in the containers, by a test that shows TCP connections to externally addressed destinations by direct IP address fail, together with a positive control showing that an expected connection (legacy-app to legacy-db) succeeds; PHP-level restrictions (`allow_url_fopen`, `disable_functions`) and DNS settings SHALL be treated as mitigations, not as a complete block; THE verification record SHALL state the paths that were measured, and paths that were not measured (such as UDP, ICMP, and IPv6) SHALL NOT be assumed to be blocked.
9. THE Reverse_Proxy container SHALL forward requests only to the single fixed upstream `legacy-app:80`, without variable-based destinations or a resolver; SHALL allow only the GET and POST methods; SHALL expose no administrative or status endpoint of its own; SHALL run as a non-root user with a read-only root filesystem and all capabilities dropped; and SHALL publish to the host only `127.0.0.1:8056`. THE verification suite SHALL include a test showing that crafted requests (absolute-URI request lines, a manipulated Host header, path manipulation, override headers, and the CONNECT method) cannot cause the Reverse_Proxy to forward to any destination other than legacy-app:80. Because the Reverse_Proxy container is connected to `legacy-api`, which permits outbound traffic (TCP connections to external IP addresses from this container are possible, as measured), the environment SHALL NOT be regarded as outbound-blocked for the Reverse_Proxy container, and unknown or untrusted code SHALL NOT be executed in it (residual risk).
10. THE Legacy_App image SHALL disable Apache `mod_status`, and `/server-status` SHALL NOT be served (the request is answered by the application as not found).

---

### Requirement 12: Reproducibility and Repeatability

**User Story:** As a Phoenix engineer, I want the Legacy_App environment to be fully reproducible from a clean machine, so that the entire Phoenix pipeline can be validated end-to-end without environment-specific setup.

#### Acceptance Criteria

1. THE Legacy_App SHALL be buildable and startable by running the single documented command `docker compose -f infra/docker-compose.yml --project-directory . up -d --build` from the project root on a machine with only Docker installed, with no additional tools or manual steps required.
2. WHEN the Legacy_App container starts for the first time, THE Legacy_App SHALL automatically apply the SQL schema and seed data such that the application returns a non-error HTTP response to its health-check endpoint without any manual database setup.
3. WHEN the Legacy_App container reaches a running state, THE Legacy_App SHALL respond to HTTP requests within 30 seconds, indicating readiness without requiring manual intervention.
4. IF the reset endpoint has been called before each run, THEN THE Legacy_App SHALL produce byte-identical HTTP response bodies and status codes for the same HTTP request inputs across separate runs, with no dependency on external state, wall-clock time, or random number generation in any business logic path.
5. THE Legacy_App SHALL NOT require any `.env` values containing secrets for local development; all default configuration values needed to start the container SHALL be provided in `.env.example`.
6. THE Legacy_App SHALL support repeated execution with varied input conditions by exposing the reset endpoint defined in Requirement 8; the Phoenix Discovery_Loop SHALL be able to call reset, submit a new input scenario, and verify the output within a single automated session without manual intervention.
7. THE Legacy_App SHALL produce deterministic outputs for the same input scenario regardless of the number of preceding reset-and-run cycles, with no accumulation of state between cycles.

---

### Requirement 13: Evaluation Separation

**User Story:** As a Phoenix engineer, I want the spec-restoration evaluation and the behavioral compatibility evaluation to be treated as distinct verification processes, so that each can be assessed and reported independently.

#### Acceptance Criteria

1. THE system SHALL distinguish between two categories of evaluation: (a) **Spec_Restoration_Evaluation** — comparing the AI-restored specification against the Ground_Truth to assess accuracy of rule inference; and (b) **Compatibility_Evaluation** — comparing the HTTP responses of the Legacy_App and the modernized app for identical inputs to assess behavioral equivalence.
2. THE Spec_Restoration_Evaluation SHALL use the Ground_Truth as its reference and SHALL NOT require executing the Legacy_App or the modernized app; it operates on documents and structured data only.
3. THE Compatibility_Evaluation SHALL use the Legacy_App's actual HTTP responses as the reference (not the Ground_Truth directly), and SHALL compare those responses against the modernized app's responses for the same inputs.
4. THE Ground_Truth SHALL NOT be used as a direct input to the Compatibility_Evaluation; its role is to validate the AI-restored spec, not to substitute for live Legacy_App execution.
5. THE evaluation results for Spec_Restoration_Evaluation and Compatibility_Evaluation SHALL be recorded and reported separately, so that a discrepancy in one does not obscure or conflate results in the other.
6. THE Ground_Truth_Conformance_Run results SHALL be recorded separately from Spec_Restoration_Evaluation and Compatibility_Evaluation results and SHALL be labelled as neither.
7. THE Compatibility_Evaluation SHALL report scenarios listed as approved divergences explicitly as approved differences, with the decision that approved them, and SHALL use the Legacy_App response as the reference for all other scenarios.
