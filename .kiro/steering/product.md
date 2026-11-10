# Product — Project Phoenix

## Vision

Project Phoenix is a platform that uses AI to restore the specifications of legacy systems, modernize them into contemporary stacks, and objectively verify behavioral compatibility between the old and new systems.

The name "Phoenix" reflects the core concept: a legacy system that cannot simply be discarded is reborn as a modern, maintainable system without losing its accumulated business logic.

## Target Users (MVP)

- Small-to-medium enterprises operating PHP/MySQL legacy systems that lack internal documentation
- Engineers or consultants responsible for modernization of those systems
- Decision-makers who need an objective risk assessment before committing to a migration

## MVP Scope

The MVP demonstrates the full modernization pipeline on a small, self-contained sample system.

| # | Capability | Description |
|---|-----------|-------------|
| 1 | Sample legacy system | A small order-management app running on PHP 5.6 / MySQL 5.7 |
| 2 | Isolated execution | The legacy environment runs inside Docker with restricted network and permissions |
| 3 | Static analysis | Source code, SQL schema, and dependencies are parsed and indexed |
| 4 | Spec restoration | AI reconstructs specifications and business rules; every claim is linked to a source location (file + line) |
| 5 | Modernization | The restored spec drives migration to PHP 8.4 |
| 6 | Compatibility verification | Identical inputs are sent to both systems; responses and side-effects are compared automatically |
| 7 | React UI | A browser-based UI lets users review analysis results, restored specs, migration output, and verification reports |

## Out of Scope (MVP)

- Support for languages other than PHP (Python, Java, COBOL, etc.)
- Multi-project or multi-tenant management
- Automated deployment to production environments
- Real customer data or confidential business information in sample data
- Commercial billing, user authentication beyond local dev, or SLA guarantees

## Success Criteria

1. The legacy sample app starts and responds correctly inside Docker.
2. The AI-generated specification document covers all major business rules of the sample app, each with a cited source location (file + line); AI-inferred claims are explicitly distinguished from source-verified facts.
3. The modernized PHP 8.4 app passes the compatibility verification suite: for every test case, the legacy output and the modern output match exactly.
4. The verifier detects and reports any mismatch between legacy and modern outputs — a deliberate divergence introduced during testing must appear as a failure in the report.
5. The React UI displays analysis results, the restored spec (with citations), and the verification report without manual data wrangling.
6. The entire pipeline can be reproduced end-to-end by running documented commands on a clean machine.

## Future Direction

After MVP, Project Phoenix aims to expand into a commercial legacy-system diagnostic and modernization service for SMEs, with support for multiple languages, cloud-hosted execution, and professional reporting.
