# Structure — Project Phoenix

## Recommended Directory Layout

```
project-phoenix/
├── .kiro/
│   ├── steering/          # Kiro steering files (always included)
│   │   ├── product.md
│   │   ├── tech.md
│   │   ├── structure.md
│   │   └── safety.md
│   ├── specs/             # Spec-driven development artifacts
│   │   └── <feature>/
│   │       ├── requirements.md
│   │       ├── design.md
│   │       └── tasks.md
│   └── hooks/             # Kiro automation hooks
│
├── packages/
│   ├── ui/                # React / TypeScript frontend
│   ├── api/               # Node.js / TypeScript backend API
│   ├── analyzer/          # Static analysis engine (PHP, SQL, Composer)
│   ├── ai-client/         # Provider-abstracted AI wrapper
│   ├── spec-restorer/     # Spec document generation
│   ├── modernizer/        # Modernized PHP code generation
│   ├── verifier/          # Compatibility test runner and differ; Experiment_Runner, Experiment_Policy, Comparator
│   └── discovery-loop/    # AI_Discovery_Loop orchestrator and Evidence_Store (discovery-loop spec)
│
├── legacy/                # Sample legacy system (PHP 5.6 / MySQL 5.7)
│   ├── src/               # Legacy PHP source code
│   ├── sql/               # Schema and seed SQL
│   ├── Dockerfile
│   └── README.md
│
├── modern/                # Generated modernized system (PHP 8.x)
│   ├── src/               # Modernized PHP source code (AI-generated, human-reviewed)
│   ├── sql/               # Migrated schema
│   ├── Dockerfile
│   └── README.md
│
├── infra/
│   ├── docker-compose.yml # Orchestrates legacy, modern, api, and ui containers
│   ├── docker-compose.discovery.yml # Discovery_Override: adds the internal discovery-lab network (applied only with approval)
│   ├── discovery/         # Toolchain and runtime Dockerfiles of the AI_Discovery_Loop (Node.js runs only in containers)
│   └── nginx/             # Reverse proxy config (if needed)
│
├── discovery/
│   ├── runs/              # Exported Run records (git-ignored by default)
│   └── approvals/         # Human Approval_Store (append-only audit record; real data NOT tracked in Git)
│
├── evaluation/            # Ground Truth, migration decisions, conformance runner, results; never AI input
│   └── spec-restoration-evaluator/  # Independent_Evaluator (separate package, not importable by runtime packages)
│
├── tests/                 # Test suites outside the analysed source (e.g. tests/legacy-sample, tests/discovery-loop)
├── docs/                  # Architecture diagrams, ADRs, pipeline overview, version-pinning.json
├── .env.example           # Template; actual .env files are git-ignored
├── .gitignore
├── LICENSE
└── README.md
```

> **Note:** The monorepo tooling is npm workspaces (root `package.json`, `workspaces: ["packages/*"]`), decided in the discovery-loop spec. Exact versions are recorded in `docs/version-pinning.json`; Node.js runs only inside the pinned toolchain and runtime containers, never on the host. The Independent_Evaluator under `evaluation/` is not a workspace member, so runtime packages cannot depend on it.

---

## Module Responsibilities

| Directory | Language | Responsibility |
|-----------|----------|---------------|
| `packages/ui` | TypeScript / React | Display pipeline results; trigger pipeline steps via API |
| `packages/api` | TypeScript / Node.js | Pipeline orchestration, state management, REST endpoints |
| `packages/analyzer` | TypeScript | Parse PHP AST, SQL DDL, Composer manifest; emit structured index |
| `packages/ai-client` | TypeScript | Abstract LLM calls; enforce provider-swap interface |
| `packages/spec-restorer` | TypeScript | Produce spec documents from analyzer output via AI; attach citations |
| `packages/modernizer` | TypeScript | Generate PHP 8.x code proposals from restored spec |
| `packages/verifier` | TypeScript | Drive containers, collect responses, diff outputs, record results; Experiment_Runner, Experiment_Policy, and Comparator of the AI_Discovery_Loop |
| `packages/discovery-loop` | TypeScript | AI_Discovery_Loop orchestration (hypothesis, experiment, observation, update) and the Evidence_Store; uses analyzer, ai-client, verifier through their public entry points |
| `evaluation/spec-restoration-evaluator` | TypeScript | Independent_Evaluator; separate process; reads saved Runs and the Ground Truth; never runs the legacy app |
| `legacy/` | PHP 5.6 | Sample order-management app; must not be modified by the pipeline |
| `modern/` | PHP 8.4 | Migration output; managed by `modernizer`; reviewed by human |
| `infra/` | YAML / shell / Dockerfile | Container orchestration and container images; no application logic |
| `discovery/` | JSON / JSONL | Exported Run records (`runs/`, git-ignored) and the human Approval_Store (`approvals/`, real data git-ignored; the Approval_Store code in `discovery/tools/` is tracked) |
| `docs/` | Markdown | Architecture Decision Records (ADRs), diagrams, onboarding guide |

---

## Naming Conventions

### General
- All prose documents (README, ADRs, spec files, UI copy) are written in **English**.
- Kiro steering files and spec task descriptions are in English.
- User-facing explanations and confirmations from Kiro are in **Japanese**.

### Files and Directories
- Directories: `kebab-case`
- TypeScript source files: `camelCase.ts` for modules, `PascalCase.tsx` for React components
- PHP source files: follow PSR-4 (`PascalCase.php` for classes)
- SQL files: `snake_case.sql`
- Config files: follow ecosystem convention (`.env`, `docker-compose.yml`, `tsconfig.json`)

### TypeScript
- Interfaces: `PascalCase`, prefixed with `I` only when needed to disambiguate from a class
- Types: `PascalCase`
- Functions and variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE` for module-level compile-time constants; `camelCase` for runtime values
- Enums: `PascalCase` name, `PascalCase` members

### Data Model Conventions
- Provenance, evidence, and human approval are three separate concepts and are never merged into one field:
  - **Origin** states who produced a piece of content: `"ai-inferred"` (produced by an AI provider) or `"human-authored"`. It never changes for a stored revision and never records verification.
  - **Evidence** is a separate, append-only record linked to the content, of kind `"source"` (deterministic citation check: the cited text exists) or `"experiment"` (observed behavior of the running system). Each kind has its own derived status: `absent`, `supported`, `contradicted`, or `mixed`. Neither kind establishes business-specification correctness.
  - **Approval** is a separate, append-only human record (approver, timestamp, target, decision, rationale). No AI creates or changes it. Only an `approved` record establishes business-specification correctness.
- Fields that carry AI-inferred content must keep `origin: "ai-inferred"`; a programmatic citation check adds `source` evidence instead of changing the origin.
- Example: `{ value: "...", origin: "ai-inferred" | "human-authored", evidence: [{ kind: "source" | "experiment", outcome: "supports" | "contradicts" | "inconclusive", citation?: { file: string; startLine: number; endLine: number } }], approval: "none" | "approved" | "rejected" | "needs_changes" }` (approval is derived from Approval records, not stored by the producer).

---

## Spec Management Policy

Project Phoenix uses **Kiro Spec-driven development** for all non-trivial features.

### Spec Lifecycle
1. **Requirements** (`requirements.md`) — written first; user approves before proceeding.
2. **Design** (`design.md`) — derived from requirements; user approves before proceeding.
3. **Tasks** (`tasks.md`) — implementation tasks derived from design; executed by Kiro.

### Spec Storage
- Each feature or pipeline stage gets its own directory under `.kiro/specs/<feature-name>/`.
- Spec files are committed to Git and considered part of the project documentation.
- Completed specs are kept as-is; do not delete them after implementation.

### Spec Naming
Suggested feature directories for MVP:

| Directory | Covers |
|-----------|--------|
| `legacy-sample` | Legacy PHP app and Docker setup |
| `analyzer` | Static analysis engine |
| `spec-restorer` | AI-driven spec restoration |
| `modernizer` | PHP 8.x code generation |
| `verifier` | Compatibility test runner |
| `api` | Backend REST API |
| `ui` | React frontend |

### Constraints
- Kiro does not proceed to the next lifecycle stage without explicit user approval.
- Large-scale changes to existing files require prior confirmation.
- Kiro runs `git commit`, `git push`, or `git merge` only when the user explicitly instructs that operation in the conversation, for that specific operation. An earlier instruction, an approval of a document, or silence is not an instruction. Without such an instruction, these operations remain the user's responsibility. Force pushes, history rewrites, and pushes to `main` additionally require an explicit instruction naming that action.
