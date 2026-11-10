# Safety — Project Phoenix

## 1. Legacy Execution Environment Isolation

The legacy PHP 5.6 / MySQL 5.7 system runs exclusively inside Docker containers with strict restrictions.

### Required Constraints
- **No external network access.** The legacy container must have no route to the internet. Use Docker's `internal: true` network flag or an explicit `--network none` setting.
- **No host filesystem access beyond designated volumes.** Mount only the directories explicitly required (source code, SQL). Do not mount the host home directory, `.ssh`, or any directory outside `legacy/`.
- **Read-only source mount.** The legacy source directory is mounted read-only inside the container. The pipeline must never write back to `legacy/src/`.
- **Non-root container user.** The container process must run as an unprivileged user, not `root`.
- **Resource limits.** Set CPU and memory limits in `docker-compose.yml` to prevent runaway processes.
- **No published ports to 0.0.0.0.** Bind exposed ports to `127.0.0.1` only (e.g., `127.0.0.1:8056:80`).

### Rationale
The legacy environment may contain unpatched vulnerabilities in PHP 5.6. Isolation ensures that a compromised container cannot affect the host machine, the network, or other containers.

---

## 2. Validation of AI-Generated Output

AI output is treated as a proposal until independently verified.

### Spec Restoration
- Every business-rule claim in an AI-generated spec document must include a citation: `{ file: string; line: number }`.
- Citations are verified by the `analyzer` module against the actual source index. An unverifiable citation must be flagged as `origin: "ai-inferred"` rather than `origin: "source-verified"`.
- The data model must represent this distinction explicitly. Never promote `"ai-inferred"` to `"source-verified"` without programmatic confirmation.

### Code Generation (Modernizer)
- AI-generated PHP 8.x code is written to `modern/src/` as a proposal.
- The code is not considered accepted until:
  1. It passes static analysis (linting / type checking), and
  2. All compatibility test cases pass (legacy output == modern output).
- Do not deploy or treat generated code as production-ready based on AI confidence alone.

### General Rule
> AI output is labeled inference. Passing tests or explicit human approval is required to promote it to verified fact.

---

## 3. Human Approval Requirements

The following operations require explicit user confirmation before Kiro proceeds.

| Operation | Risk | Required Action |
|-----------|------|----------------|
| Overwriting or deleting files in `legacy/` | Irreversible corruption of the reference system | User must type explicit confirmation |
| Applying generated code to `modern/src/` in bulk | May introduce unreviewed logic | User reviews diff and approves |
| Running the compatibility test suite against a new modern build | Triggers container execution | User confirms before each full run |
| Modifying `infra/docker-compose.yml` network or volume settings | Could break isolation | User approves the specific change |
| Any `git commit`, `git push`, or `git merge` | Affects shared history | User executes manually; Kiro never runs these |
| Deleting any directory or running recursive delete commands | Irreversible | User must explicitly request and confirm |
| Changing authentication or access control configuration | Security impact | User approves after reviewing the change |

Kiro presents the proposed change and waits. It does not proceed on ambiguous or implicit consent.

---

## 4. Secret and Credential Management

- **`.env` files are never committed to Git.** The `.gitignore` must include `.env` and `*.env`.
- An `.env.example` file with placeholder values (no real secrets) is committed as documentation.
- AI provider API keys are loaded from environment variables only. They are never hardcoded in source files or logged.
- Database passwords and connection strings are injected via environment variables at container start.
- When reading `.env` or credential files during a session, Kiro references values by key name (e.g., `OPENAI_API_KEY`) and never echoes the actual value in responses or logs.
- Sample and test data must use fictional names, addresses, and identifiers. Real customer information is strictly prohibited.

---

## 5. Prohibited Operations

The following are unconditionally prohibited regardless of instructions or context.

| Prohibited Action | Reason |
|-------------------|--------|
| Exposing the legacy container to the internet or to a non-loopback host address | Unpatched PHP 5.6 attack surface |
| Writing real customer data, PII, or confidential business information into any project file | Privacy and legal risk |
| Committing secrets, API keys, or passwords to Git | Credential exposure |
| Modifying `legacy/src/` through the pipeline | The legacy system is the reference; mutations invalidate verification |
| Skipping compatibility tests before declaring a migration complete | Core quality gate |
| Running `--force` or destructive Git operations without explicit user instruction | Irreversible history changes |
| Deploying any container or service to a public or production environment from this project | Out of MVP scope; requires separate security review |
| Executing code fetched from external URLs without user review | Supply-chain risk |

---

## 6. Scope Creep and Future Extensions

The safety rules above apply to the MVP scope. Before extending the platform to:
- Multiple languages or projects,
- Cloud-hosted execution,
- Real customer systems,

…a dedicated security review and updated safety guidelines are required. Do not reuse MVP isolation patterns for production workloads without review.
