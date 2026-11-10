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
│   └── verifier/          # Compatibility test runner and differ
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
│   └── nginx/             # Reverse proxy config (if needed)
│
├── docs/                  # Architecture diagrams, ADRs, pipeline overview
├── .env.example           # Template; actual .env files are git-ignored
├── .gitignore
├── LICENSE
└── README.md
```

> **Note:** The monorepo tooling (npm workspaces, pnpm, or Turborepo) is TBD — decide at the first backend/frontend Spec stage. Until then, each `packages/` subdirectory is treated as an independent module.

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
| `packages/verifier` | TypeScript | Drive containers, collect responses, diff outputs, record results |
| `legacy/` | PHP 5.6 | Sample order-management app; must not be modified by the pipeline |
| `modern/` | PHP 8.4 | Migration output; managed by `modernizer`; reviewed by human |
| `infra/` | YAML / shell | Container orchestration; no application logic |
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
- Fields that carry AI-inferred content must include a `confidence` or `source` discriminator to distinguish them from source-verified facts.
- Example: `{ value: "...", origin: "ai-inferred" | "source-verified", citation?: { file: string; line: number } }`

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
- Kiro does not commit, push, or merge Git changes — that is the user's responsibility.
