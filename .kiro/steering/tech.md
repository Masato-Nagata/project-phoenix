# Tech — Project Phoenix

## Technology Stack

### Frontend
| Layer | Choice | Notes |
|-------|--------|-------|
| Framework | React | TypeScript strict mode |
| Build tool | Vite | To be confirmed at implementation time |
| Styling | Tailwind CSS | Utility-first; configured at UI spec stage |
| State management | React standard Hooks | No additional library unless a concrete need arises |

### Backend
| Layer | Choice | Notes |
|-------|--------|-------|
| Runtime | Node.js | Active LTS line (26.x at the discovery-loop M0); exact version and container image digest in `docs/version-pinning.json`. Node.js runs only inside pinned containers, never installed on the host |
| Language | TypeScript | Strict mode; compiled with tsc (exact version in `docs/version-pinning.json`) |
| Tests | Vitest + fast-check | Unit, integration, and property-based tests; exact versions pinned |
| Schema validation | Ajv (JSON Schema 2020-12) | AI output and stored records are validated before use |
| HTTP framework | Fastify | Type-safe plugins; JSON schema validation built-in |
| Database (platform) | SQLite | Pipeline metadata and verification results; accessed via a thin repository layer |

### Legacy System (sample target)
| Layer | Choice |
|-------|--------|
| Language | PHP 5.6 |
| Database | MySQL 5.7 |
| Execution | Docker (isolated, no external network) |

### Modernized System (migration target)
| Layer | Choice | Notes |
|-------|--------|-------|
| Language | PHP 8.4 | Actively supported; targets latest stable 8.x at implementation time |
| Database | MySQL 8.x or compatible | To be confirmed at migration spec stage |

### Infrastructure
| Concern | Choice |
|---------|--------|
| Monorepo | npm workspaces (exact versions, committed lockfile, `npm ci` only) |
| Containerization | Docker / Docker Compose (base Compose file plus separately approved override files) |
| Host-side tooling | PowerShell 7 (Launcher, approval command, isolation tests); no Node.js on the host |
| CI (MVP) | None — local execution only |
| Secret management | `.env` files excluded from Git; no secrets in sample data |

### AI Integration
- All AI calls are routed through a single provider-abstraction layer (`packages/ai-client`).
- MVP implements two providers:
  - **Mock Provider** — returns deterministic canned responses; used for local development and unit tests without any external dependency.
  - **Real AI Provider** — one concrete provider. The first candidate is Kiro CLI in headless mode (Kiro_CLI_Provider), run only inside an isolated AI_Sandbox container (discovery-loop spec, M6/M7). Building that environment, connecting to it, and sending any payload to it each require a separate explicit human approval. Other providers (e.g., AWS Bedrock, OpenAI, Anthropic API) remain possible behind the same interface.
- The abstraction interface must support swapping the provider via configuration without changing any caller code.
- The Mock Provider must be usable as a drop-in replacement so the full pipeline can be exercised offline.

---

## Architecture Principles

### Overall Shape
```
React UI  ←→  Node.js Backend API  ←→  AI Provider (abstracted)
                     ↓
             Analysis Engine (TS)
                     ↓
         Legacy Docker Container  /  Modern PHP Container
```

- The backend is the single source of truth for pipeline state.
- The frontend is a read/act layer; it does not run analysis directly.
- Legacy and modern containers communicate only with the backend via controlled interfaces (HTTP or file volume). They have no direct internet access.

### Module Responsibilities
| Module | Responsibility |
|--------|---------------|
| `analyzer` | Parse PHP source, SQL schema, and `composer.json`; produce a structured index |
| `ai-client` | Provider-abstracted wrapper for all LLM calls |
| `spec-restorer` | Orchestrate AI calls to produce spec documents with source citations |
| `modernizer` | Generate modernized PHP code using the restored spec as input |
| `verifier` | Drive legacy and modern containers with identical inputs; diff and record results |
| `api` | REST (or similar) endpoints consumed by the React UI |
| `ui` | React application for displaying results and triggering pipeline steps |

---

## AI vs. Deterministic Responsibility Split

A core design principle is the clear separation of AI inference from deterministic program control.

| Concern | Owner | Rationale |
|---------|-------|-----------|
| Source code parsing and indexing | Deterministic (program) | Parsing is exact; AI must not guess file structure |
| Business rule inference and spec writing | AI | Natural-language reasoning is AI's strength |
| Source citations (file + line) | Deterministic (program) | Citations must be verifiable facts, not hallucinations |
| Code generation (modernized PHP) | AI (proposal) | AI drafts; human or test suite confirms |
| Test input generation | AI (assisted) | Program validates and executes |
| Output comparison and diff | Deterministic (program) | Objective; must not be subject to interpretation |
| Pipeline state transitions | Deterministic (program) | Reproducibility requires explicit control flow |
| Dangerous operations (delete, deploy) | Human approval required | See `safety.md` |

**Rule:** AI output is always labeled as a proposal or inference until confirmed by a passing test or explicit human approval. The data model keeps origin (who produced it), evidence (`source` citation checks and `experiment` observations), and human approval separate (see `structure.md`); source or experiment evidence never establishes business-specification correctness on its own.

---

## Testing Principles

- **Compatibility tests are the primary quality gate.** A migration is not complete until all compatibility test cases pass.
- Each compatibility test case records: input, expected output (from legacy run), actual output (from modern run), and pass/fail status.
- Unit tests cover deterministic modules (parser, differ, verifier runner).
- AI output is not unit-tested for content; it is validated by downstream tests (compatibility suite, human review).
- Test data must not contain real customer information.
- Test framework choice is deferred to the relevant Spec stage; match the ecosystem standard for each sub-project (e.g., Vitest for TypeScript, PHPUnit for PHP).
