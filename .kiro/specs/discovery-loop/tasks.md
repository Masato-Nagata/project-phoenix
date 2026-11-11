# Implementation Plan: discovery-loop

## Overview

This plan implements the AI_Discovery_Loop in eight milestones, M0 to M7. M0 is a gated prerequisite milestone with no feature code. M1 to M5 build and verify the deterministic modules, the host-side tools, and the Mock_Provider path offline. M6 and M7 are human-gated and are the only milestones that touch Kiro CLI or a real AI service.

### Implementation start conditions

- M0 to M5 are the MVP and the initial implementation scope (R21.18).
- No task of M0 to M5 starts until the human gives an explicit instruction to start implementation (Gate `start-implementation`, R21.19). The approval of the requirements, the design, or this task list does not count.
- M6 and M7 each need a separate explicit human approval (R21.10). An approval for M6 is not an approval for M7. Any transmission of the synthetic source to a third-party AI service needs a further, separate approval that names the AI_Provider and the Source_Bundle manifest hashes (R21.11).
- Applying the Discovery_Override (`discovery-lab` network, `discovery-runtime` service) needs its own explicit approval, separate from the approval of its content (R18.20).
- Node.js and Kiro CLI are never installed on the host (R20.10, R21.14). Builds and tests run only in the approved container.
- Every M0 item that changes a file or the environment needs its own explicit approval, presented with the exact diff or command first.
- M0 status: the human approved the creation of the M0 files only, not any execution. Tasks 0.3 to 0.7 are the finished file work and are checked. Every M0 task that pulls or builds an image, runs a container, creates a lockfile, runs `npm ci`, verifies versions, or applies the override stays open and needs its own approval.

### Critical path to the first Mock loop (Kiroween priority)

Goal: one complete end-to-end Mock Run (Mock_Provider, no external AI service) through the Launcher, with a verified export. This section only orders existing sub-tasks. It removes no safety item.

**Ordered chain** (each item needs the items before it that it depends on; items on the same line can run in parallel):

1. M0 approvals and execution: 0.1 (start instruction), 0.2 (container runtime), 0.8 (pull), 0.9 (verify versions), 0.10 (build the toolchain image), 0.11 (lockfile and `npm ci`). The file work 0.3 to 0.7 is already done. 0.12 and 0.13 (override check and apply approval) can run in parallel with 0.8 to 0.11, but 0.12 needs only 0.2.
2. M1 core: 1.1, then 1.3 and 1.4, then 1.9, 1.12, and 1.14, then 1.15 and 1.16. Also 1.2 (version-pinning check, in parallel with 1.3). Their tests run as soon as the code exists.
3. M2 chain: 2.1 (Source_Bundler), 2.4 (Citation_Verifier), 2.8 (Experiment_Policy), 2.12 (Comparator) in parallel; then 2.15 (Experiment_Runner with lease checks); then 2.18 (Launcher: locks, Run_Volume, lease, `docker run`), 2.21 (export procedure with Completion_Marker, Reason_File, and volume disposition), and 2.22 (abandoned-mutex handling); then 2.19 (apply the override) and 2.20 (Test API integration run).
4. M3 chain: 3.1, then 3.2 (Mock_Provider), 3.4 (Payload_Auditor, allowlist fail-closed and audit), and 3.8 (untrusted-output gate) in parallel, then 3.10 (approval-like content discard). The allowlist fail-closed behavior is in 2.1 (Source_Bundler) and 3.4.
5. M4 chain: 4.1 (RunConfig), 4.2 (Ground_Truth access denial by container rights), 4.10 (approval command, in parallel), then 4.3 (start gate), 4.4 (orchestrator), 4.6 (manifest), 4.9 (runtime container wired to the Launcher), 4.12 (lab network measurement record), 4.15 (write the Discovery_Override isolation test, mandatory) and 4.16 (run it in the applied state), then 4.14 (one Mock Run through the Launcher, with the export verified).

**Security-mandatory items kept on the chain** (none is skipped to reach the first Mock loop): the allowlist fail-closed Source_Bundler (2.1), the Payload_Auditor with an audit before every send (3.4), the Experiment_Policy (2.8), the untrusted AI output gate (3.8, 3.10), the Ground_Truth access-denial verification by container rights (4.2, 4.3), the Run_Lease and the lease check before every request (2.15, 2.18), the Run_Volume export with the Completion_Marker (2.18, 2.21), and the Discovery_Override isolation test (4.15, 4.16).

**Can run in parallel with the chain:** the property tests next to their implementation tasks (1.5, 1.7, 1.10, 1.11, 1.13, 1.17 to 1.23, 2.2, 2.3, 2.5, 2.9 to 2.11, 2.13, 2.14, 2.16, 3.3, 3.5, 3.6, 3.9, 4.5); 3.7 (Audit_Config_Builder); 4.10 (approval command); 4.13 (credential tests); and the writing of the Launcher export tests (2.23), which should still run before 4.14.

**Off the critical path but required before MVP completion:** the evaluator (M5, 5.1 to 5.13 and 5.16), the lock tests (5.14, 5.15), the reproducibility command and property (4.7, 4.8), the runtime isolation tests (4.11), the override removal, the restoration check, and the run of the legacy-sample isolation test (4.17), the real-Docker export integration check (4.18), the Launcher export and abandoned-mutex unit tests (2.23), and the full property suites. **These tests are not optional.** Being off the critical path means only that the first Mock loop can run before they finish. Each must pass before the MVP is reported complete (R21.18, R24.3); only the two tasks marked `*` (1.8 and 2.6) may be skipped.

**Human approvals on the critical path, in order:**

1. Gate `start-implementation` (0.1).
2. Container runtime use (Gate `container-runtime`, 0.2).
3. `docker pull` (0.8).
4. Version verification (0.9), then `docker build` of the toolchain image (0.10). The toolchain image must exist before any container-run npm step, so the build comes before `npm ci`.
5. Lockfile creation and `npm ci` (0.11, and again in 1.1 after the package skeletons exist).
6. `docker build` of the runtime image (4.9, any file under `infra/` also needs approval).
7. Override apply (Gate `override-apply`, approved in 0.13 and applied in 2.19).
8. Test API integration run (2.20, user confirmation; the override is applied), and the run of the isolation test in the applied state (4.16).
9. Mock Run (4.14, user confirmation; the conformance runner is idle).

### Conventions

- Top-level task numbers match milestone numbers: task 0 is M0, task 1 is M1, and so on.
- The language is TypeScript with `strict` enabled for the packages, and PowerShell 7 for the host-side Launcher and the approval command (design D5, D8, D13, R20.1). The design names concrete types and file layouts, so no language question is needed.
- Every item marked "Requires explicit human approval before execution" must stop and present the exact action, target, and evidence to the user. Silence or ambiguous wording is not approval, and an approval covers only the single action presented (R21.12). If the approval is withdrawn or the Source_Bundle manifest hashes change, stop and ask again (R21.13).
- Until the approval command of task 4.10 exists, approvals are given in the conversation. Afterwards the human can have them transcribed as Approval_Records, with approver, decision, target, and rationale stated explicitly by the human and never inferred (R23.8).
- Test commands use single-run mode (`vitest --run`), never watch mode. Host-side PowerShell tests follow the style of `tests/legacy-sample/`.
- Tasks that touch the live Legacy_App run only after the user confirms the run, and never while the conformance runner is active (R21.3).
- No task text, fixture, generator, or example may contain a business-rule value of the Legacy_App. Fixtures use the neutral fictitious API of the design.
- Steering files, `legacy/`, `legacy-sample` spec files, `evaluation/runner/`, and `infra/docker-compose.yml` are not modified by any task. Proposed steering changes stay proposals.
- The Kiro development agent never runs `git commit`, `git push`, or `git merge`.
- Checked M0 sub-tasks: the file-creation sub-tasks (0.3 to 0.7) and the approved and executed sub-tasks 0.2, 0.8, 0.9, 0.10, 0.11, and 0.12 (evidence notes in each). The gates 0.1 and 0.13, the M0 checkpoint 0.14, and the M0 parent stay open.

## Tasks

- [ ] 0. M0 Prerequisites (gated, no feature code)
  - [x] 0.1 Gate: explicit instruction to start implementation
    - **Requires explicit human approval before execution.** Do not start any other task until the human gives an explicit instruction to start implementation (Gate `start-implementation`).
    - Present the MVP scope (M0 to M5), the list of M0 items that each need their own approval, and the fact that M6 and M7 are not included.
    - The human approved the creation of the M0 files (tasks 0.3 to 0.7). That approval covered file creation only; it is neither this Gate nor an approval of any execution.
    - _Requirements: 21.10, 21.12, 21.18, 21.19_
  - [x] 0.2 Approve the container-based Node.js runtime (no host install)
    - **Requires explicit human approval before execution** (Gate `container-runtime`).
    - Present the container-based runtime: the pinned Node.js LTS image, the build and test commands, `--network none` for test runs, and which steps need network access (image pull, dependency download, lockfile creation). Host installation of Node.js is not offered.
    - Do not run `docker pull`, `docker build`, `docker run`, `npm install`, `npm ci`, a build, or a test until this approval exists.
    - Done (evidence): the human approved the container-based Node.js runtime and the agent executed the approved steps on 2026-11-12 (online re-check of versions and the image digest, unchanged). No host installation.
    - _Requirements: 20.10, 20.11, 21.12, 21.14, 21.17_
  - [x] 0.3 Create the Version_Pinning_Record file with candidate entries
    - Done: `docs/version-pinning.json` exists and every entry has the status `candidate_observed`. A `candidate_observed` entry is not a verified version (R20.13); verification is task 0.9.
    - _Requirements: 20.6, 20.12, 20.13_
  - [x] 0.4 Create the build and package configuration files
    - Done: root `package.json` (npm workspaces, exact versions, no range operator), `.npmrc`, `infra/discovery/toolchain.Dockerfile`, `infra/discovery/runtime.Dockerfile`, and `.dockerignore`. The files only exist; nothing was built, pulled, or installed from them.
    - `infra/docker-compose.yml` is unchanged. The runtime image is built later in task 4.9.
    - _Requirements: 20.1, 20.3, 20.7, 20.10_
  - [x] 0.5 Create the Discovery_Override file (not applied)
    - Done: `infra/docker-compose.discovery.yml` defines only the `internal: true` network `phoenix-discovery-lab` (IPv6 disabled) and the `reverse-proxy` membership. It defines no `discovery-runtime` service: the Launcher starts that container with `docker run` (A10, task 2.18). `infra/docker-compose.yml` is unchanged. The override is not applied.
    - _Requirements: 18.2, 18.12, 18.13, 18.14, 18.15, 18.20_
  - [x] 0.6 Add `.gitignore` entries
    - Done: `discovery/runs/`, `channel/`, `leases/`, `locks/`, and `config/` entries under `discovery/` were added; `.env` and `*.env` stay excluded and `.env.example` stays allowed. `discovery/approvals/` has no ignore entry, so the Approval_Store can be tracked.
    - Still for the human to decide (not part of this file work): whether `discovery/approvals/` is committed. The Kiro development agent does not commit. A target Run identifier may refer to a Run directory that exists only on the machine that made it.
    - _Requirements: 12.12, 19.4, 23.1_
  - [x] 0.7 Add `.env.example` placeholders
    - Done: `.env.example` has the `KIRO_API_KEY` entry with an empty placeholder. No real value is written.
    - _Requirements: 19.4, 19.5_
  - [x] 0.8 Pull the pinned container image(s)
    - **Requires explicit human approval before execution**, and requires 0.2. Present the exact `docker pull` command(s), the image reference and digest from `docs/version-pinning.json`, and the registry that is contacted. Network access is needed for this step only.
    - Nothing is installed on the host.
    - Done (evidence, 2026-11-12): `docker pull` of `node:26.13.0-trixie-slim` by index digest `sha256:5adad64f9a1fca2d51972caa65983634c8a774eb300d72b20f7f2a0f60368072`.
    - _Requirements: 20.8, 20.10, 20.11, 21.12, 21.17_
  - [x] 0.9 Verify the candidate versions and pin them as verified
    - **Requires explicit human approval before execution**, and requires 0.8. Registry queries and compatibility checks run only inside the approved container.
    - For each `candidate_observed` entry, record the exact `major.minor.patch` version, the verification date, and the verification source, and change the status to verified only after the check was performed and recorded (R20.13). Mark any entry that cannot be verified as `unverified`. Implementation of a part that depends on an unverified entry must not begin.
    - Entries: Node.js LTS, npm, image digest, TypeScript, Vitest, fast-check, vite, `@types/node`, dependency-cruiser (OD-6), the JSON Schema validator (candidate Ajv), and every other planned dependency. Record Vitest and fast-check as the chosen test frameworks (D8, R20.12).
    - Verify that the host has no new installation of Node.js, npm, or any other tool.
    - Done for the toolchain packages (evidence, 2026-11-12): `docs/version-pinning.json` is `verified` for Node.js, npm, the base image, typescript (tsc 6.0.3, strict, 0 errors), vitest (4.1.12), vite, fast-check (4.10.2; 2 tests passed with `--network none`), `@types/node`, and dependency-cruiser (18.7.2, resolved a TypeScript import edge). `npm audit signatures`: 91 verified signatures, 32 verified attestations.
    - Open part, moved to M1 (tasks 1.1 and 1.2): `ajv` and `ajv-formats` stay `candidate_observed` because they are not in the M0 lockfile. They are verified in M1 when the dependencies are added; until then they count as not verified (R20.13) and block the checkpoint 0.14 and any part that depends on them.
    - _Requirements: 20.1, 20.6, 20.7, 20.8, 20.10, 20.12, 20.13, 21.17_
  - [x] 0.10 Build the toolchain image
    - **Requires explicit human approval before execution**, and requires 0.8 and 0.9. Present the exact `docker build` command and build context (deny-all `.dockerignore` rules).
    - The build fails if the image does not contain the pinned Node.js and npm versions. Nothing is installed on the host. The runtime image is built separately in task 4.9.
    - Done (evidence, 2026-11-12): image `phoenix/discovery-toolchain:m0` built with an empty build context and `--network none`. The `# syntax=` line was removed from the Dockerfile (avoids pulling an extra frontend image); `HOME` and `NPM_CONFIG_CACHE` are set to `/tmp` because the build user has no home.
    - _Requirements: 20.1, 20.10, 20.11, 21.12_
  - [x] 0.11 Create the lockfile and run `npm ci` in the toolchain container
    - **Requires explicit human approval before execution**, and requires 0.10. Present the exact commands (lockfile creation with the network limited to the npm registry, then `npm ci`) and the named volume used for `node_modules`.
    - The lockfile is committed by the human, not by the Kiro development agent. The lockfile is created again after the package skeletons exist (task 1.1), under its own approval.
    - Run the version-pinning consistency check of task 1.2 once it exists.
    - Done (evidence, 2026-11-12): `package-lock.json` generated with `npm install --ignore-scripts` in a container that received only `package.json` and `.npmrc` (123 lock entries, 91 installed packages, all from registry.npmjs.org with sha512 integrity; only `fsevents` declares an install script, darwin-only). `npm ci` reproduced it: lockfile unchanged, identical 168-entry tree. The consistency check of task 1.2 does not exist yet and runs under 1.2.
    - _Requirements: 20.7, 20.9, 20.10, 20.11, 21.12_
  - [x] 0.12 Check the Discovery_Override merge result (read-only)
    - **Requires explicit human approval before execution** (it runs the Docker CLI), and requires 0.2. The check is `docker compose -f ... -f ... config`; it applies nothing and creates no network.
    - Compare the effective membership of `reverse-proxy` with the expected three networks, and confirm that no `discovery-runtime` service is defined and that `infra/docker-compose.yml` is byte-identical (hash compare).
    - Done (evidence): the read-only `docker compose config` render of base plus override was executed and passed; nothing was applied.
    - _Requirements: 18.2, 18.12, 18.13, 18.14, 21.12, 21.17_
  - [ ] 0.13 Obtain the separate approval for applying the Discovery_Override
    - **Requires explicit human approval before execution** (Gate `override-apply`), separate from every other approval, including the approval that allowed the file to be created.
    - Present the exact command, the effective network membership change of `reverse-proxy` (two networks to three while applied), the removal procedure, and the consequence that `tests/legacy-sample/test_network_isolation.ps1` must be run without the override.
    - Record the content hash of the override file that was approved. Task 2.19 applies the override only if the file still has that hash; otherwise it asks again. Nothing is applied in M0.
    - _Requirements: 18.15, 18.18, 18.20, 21.12, 21.13_
  - [ ] 0.14 Checkpoint - M0 gate review
    - Acceptance condition (R21.17): the Version_Pinning_Record exists with every direct and development dependency, the Node.js LTS version, the npm version, and the image digest, each exact, sourced, and verified (no `candidate_observed` entry counts); the container-based runtime is approved; the override content is drafted and approved but not applied; `.gitignore` and `.env.example` are changed only as approved; the start instruction of 0.1 is recorded; no Node.js, npm, or other tool was installed on the host.
    - Test policy: a consistency check of the Version_Pinning_Record against the package manifests (R20.9, once manifests exist) and a check that the host has no new installation; no application code is executed, no AI call, no network access beyond registry verification.
    - Stop condition: any dependency or image without a verified exact version, any missing approval, or any host installation blocks M1. Ensure all checks pass, ask the user if questions arise.
    - _Requirements: 20.6, 20.8, 20.13, 21.9, 21.12, 21.17_

- [x] 1. M1 Data model, Evidence_Store, and Approval_Store core
  - [x] 1.1 Create the npm workspaces skeleton and the container test target
    - The root `package.json`, `.npmrc`, `toolchain.Dockerfile`, `runtime.Dockerfile`, and `.dockerignore` already exist (0.4). Add a shared strict `tsconfig` base and package skeletons for `packages/discovery-loop`, `packages/analyzer`, `packages/ai-client`, and `packages/verifier`, each exposing only `src/index.ts`.
    - Declare every dependency as an exact version taken from the verified Version_Pinning_Record (0.9); no range operator and no `latest`.
    - Carried over from 0.9: verify `ajv` and `ajv-formats` (still `candidate_observed`, not in the M0 lockfile) when they are added to the manifests here, record the exact version, date, and source, and set them to `verified` before any task that imports them.
    - Make sure the `test` target and the build context exclude repository secrets, `evaluation/`, `tests/`, `.kiro/`, `infra/`, `docs/`, `legacy/`, and `.env` (deny-all build-context rules of the design). Make no change to `infra/docker-compose.yml`.
    - **Requires explicit human approval before execution** for the container step that updates the lockfile for the new workspaces and re-runs `npm ci` in the approved toolchain container.
    - _Requirements: 20.1, 20.2, 20.3, 20.4, 20.5, 20.7, 20.10_
  - [x] 1.2 Implement the version-pinning check
    - Compare every manifest dependency version with the Version_Pinning_Record; report the dependency name and both versions on a mismatch, and fail on any range operator or `latest`.
    - Treat an entry with the status `candidate_observed` or `unverified` as not verified: the check fails for it and never counts it as verified (R20.13). Until `ajv` and `ajv-formats` are verified (carried over from 0.9, see 1.1), the check reports them as not verified.
    - Write unit tests for match, mismatch, range operator, missing entry, a `candidate_observed` entry, and an `unverified` entry.
    - _Requirements: 20.7, 20.8, 20.9, 20.13_
  - [x] 1.3 Define JSON schemas, shared types, and the validator wrapper
    - JSON Schema draft 2020-12 with `additionalProperties: false` for: common definitions, Source_Bundle manifest, Hypothesis and Claim (the AI-facing proposal form defines no `origin`, `evidence`, or `approval` field), Citation, Experiment (rejecting reset and the test namespace, no HTTP method or path in preparation steps), Prediction, Observation, Evidence (kinds `source` and `experiment` only, each with its own required fields), RecordEnvelope (including `ai_content_discarded` and `store_rejection` records), Approval_Record, and Run_Manifest.
    - Implement the validator wrapper with the strict parse rules: size and nesting limits, duplicate-key rejection, and defined-fields-only.
    - Add one valid and several invalid fixtures per schema, including an Evidence record of kind `source` with an experiment field, an Evidence kind other than the two, and an AI proposal carrying a reserved field. All fixtures use the neutral fictitious API.
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.7, 4.10, 6.3, 7.2, 7.3, 7.5, 7.6, 12.3, 17.6, 23.1, 23.4_
  - [x] 1.4 Implement canonical JSON serialization and parsing
    - Deterministic key order, no whitespace variance, integers without a fractional lexeme, and an exact round trip for every stored record.
    - _Requirements: 12.15, 17.8, 22.1_
  - [x] 1.5 Write property test for canonical JSON and record round trip
    - **Property 14: Canonical JSON and record round trip**
    - **Validates: Requirements 12.15, 17.8**
  - [x] 1.6 Implement the Rule_Expression_Language AST, validation, and evaluator
    - In `packages/analyzer`: JSON AST with literals, request-input references, references to declared derived values and lookup tables, integer arithmetic with defined `overflow` and `division_by_zero` errors, comparison, and boolean operators; total evaluation with bounded node count, depth, and step limit; no loop, recursion, I/O, or outside reference.
    - Operator names are the generic names of the design; none names or hints at a business concept.
    - Add golden test vectors as data files in `packages/analyzer/test-vectors/` for reuse by the evaluator in M5.
    - _Requirements: 4.5, 4.6, 4.7, 4.8_
  - [x] 1.7 Write property test for total, deterministic expression evaluation
    - **Property 24: Expression evaluation is total and deterministic**
    - **Validates: Requirements 4.6**
  - [ ]* 1.8 Write property test for expression arithmetic and round trip
    - **Property 25: Expression arithmetic matches the reference model, and expressions round trip**
    - **Validates: Requirements 4.6, 4.8**
  - [x] 1.9 Implement the Evidence_Store write path
    - In `packages/discovery-loop`: record envelope with record id, sequence number starting at 1 with no gaps, and predecessor hash (64-zero genesis value); append-only writes through a `FileSystemPort`; atomic write so no partial record is visible; refusal to start unless the mounted Run_Volume is empty (the Launcher creates it, C3; the runtime writes the Run records only to the Run_Volume and has no Windows bind mount that receives them, R12.17); rejection records for modify or delete requests.
    - Secret-pattern rejection of the whole record with a rejection record that names the pattern and omits the value.
    - Store AI output as exact received bytes plus SHA-256.
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 12.13, 12.14, 12.17, 17.8, 19.2, 19.7_
  - [x] 1.10 Write property test for secret rejection
    - **Property 16: Records and artifacts containing secrets are rejected whole**
    - **Validates: Requirements 12.13, 19.2, 19.7, 19.9**
  - [x] 1.11 Write property test for failed-write behavior
    - **Property 17: A failed write leaves only a complete, valid prefix**
    - Use a file-system wrapper that fails at a chosen step.
    - **Validates: Requirements 12.14**
  - [x] 1.12 Implement Evidence_Store verification and Run_Manifest sealing
    - Verification recomputes every artifact hash and chain link, reports `modified`, `missing`, `unlisted`, or `chain_break` with the record id or path, reports `incomplete` when there is no Run_Manifest, and writes nothing.
    - Seal exactly one Run_Manifest listing every artifact by relative path and hash, with configuration, limits, provider identity, tool versions, termination reason, record count, and last-record hash. Approval_Records are never listed as Run artifacts.
    - Treat only the Completion_Marker, the Reason_File, and the Launcher record as files the Run_Manifest need not list (R12.9).
    - Provide the one reader acceptance function used by the evaluator, the reproducibility check, the replay, and the report entry point: a Run is accepted only if the Completion_Marker exists, its content equals the SHA-256 hash of the Run_Manifest, and verification succeeds; otherwise it is `incomplete`. Directories under `discovery/runs/.incoming/` are never read as complete Runs.
    - _Requirements: 12.7, 12.8, 12.9, 12.10, 12.11, 12.16, 12.23, 12.24_
  - [x] 1.13 Write property test for tamper detection
    - **Property 15: Tampering with a Run directory is always detected, and verification does not write**
    - **Validates: Requirements 12.4, 12.6, 12.8, 12.9, 12.10, 12.11**
  - [x] 1.14 Implement the Origin, Evidence, and Approval data model and status derivation
    - Three separate concepts. Origin (`ai-inferred` or `human-authored`, written once, immutable, loop creates only `ai-inferred`). Evidence (append-only records of kind `source` and `experiment`, outcomes `supports`, `contradicts`, `inconclusive`). Approval (derived only from the Approval_Store, never stored with the Claim revision).
    - Pure functions `deriveSourceStatus` and `deriveExperimentStatus` returning `absent`, `supported`, `contradicted`, or `mixed` from the records of one kind only, independent of record order; `inconclusive` counts as neither.
    - Initial statuses on creation and on revision (new revision identifier, Origin `ai-inferred`, both Evidence_Statuses `absent`, Approval `none`, nothing copied or re-linked); ordered revision lists with predecessor, reason, and linked Evidence ids; actor checks that reject a wrong writer (Origin change, `source` append by a component other than the Citation_Verifier, `experiment` append outside the match, mismatch, and not_comparable rules, unknown kind) with a recorded rejection that names the component and leaves records unchanged.
    - The loop has no interface that writes an Approval_Record and no read of the Approval_Store while payloads are built.
    - _Requirements: 4.10, 4.11, 4.12, 4.13, 5.4, 5.6, 5.8, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.8, 6.9, 6.11, 6.12, 6.14, 6.15, 6.16, 12.7_
  - [x] 1.15 Implement the four-facts query and the report renderer
    - Query per Claim revision identifier that returns Origin, `source` Evidence_Status, `experiment` Evidence_Status, and Approval status as four separate fields, with no combined or ranked value. An unknown identifier returns an error that names it and never a default such as `absent` or `none`.
    - The renderer always shows a `contradicted` or `mixed` status and every contradicting Evidence id (no cap) in the same entry as any `supported` status or `approved` Approval. The query lives in the `report` entry point, not in the runtime entry point.
    - _Requirements: 6.10, 6.12, 6.13, 6.19_
  - [x] 1.16 Implement the Approval_Store core (read side and reference validator)
    - Hash-chained JSONL record format: sequence from 1 without gaps, genesis predecessor of 64 zeros, `supersedes` rules (existing record of the same target, not already superseded, superseding record is the latest for its target), `store_rejection` lines for modify or delete requests, and the field validation rules of R23.7 with each missing or invalid field named.
    - `ApprovalReader` (verify without writing, `approvalStatus(target)` returning `none` when no record targets it, unknown target is an error). Pure validator and chain builder are used by tests and golden-vector generation only and are not exported through the runtime entry point.
    - Write golden vectors as data files (records with expected canonical bytes and hashes) for the PowerShell writer of task 4.10.
    - _Requirements: 6.9, 6.11, 23.1, 23.2, 23.4, 23.7, 23.9, 23.10, 23.11, 23.12_
  - [x] 1.17 Write property test for evidence-derived statuses
    - **Property 5: Evidence statuses are derived per kind, from counts, and independent of order**
    - **Validates: Requirements 5.8, 6.4, 6.5, 6.6, 6.7, 6.18**
  - [x] 1.18 Write property test for independence of the four facts
    - **Property 6: The four facts are independent**
    - Compare the serialized representation of all four facts before and after each generated single update.
    - **Validates: Requirements 6.5, 6.6, 6.9, 6.17**
  - [x] 1.19 Write property test for Origin immutability and revisions
    - **Property 7: Origin is immutable and Claim revisions inherit nothing**
    - **Validates: Requirements 4.10, 4.11, 4.13, 6.1, 6.2, 6.4, 6.14, 6.16, 11.5, 12.7**
  - [x] 1.20 Write property test that evidence is append-only and contradictions are never hidden
    - **Property 8: Evidence is append-only, written only by its owners, and contradictions are never hidden**
    - **Validates: Requirements 6.3, 6.12, 6.13, 6.15**
  - [x] 1.21 Write property test for unknown Claim revision queries
    - **Property 31: Querying an unknown Claim revision is an error**
    - **Validates: Requirements 6.19**
  - [x] 1.22 Write property test for Approval_Store round trip and tamper detection
    - **Property 32: Approval_Store records round-trip and the chain detects tampering**
    - **Validates: Requirements 23.2, 23.9, 23.11**
  - [x] 1.23 Write property test for Approval validation, supersession, and derived status
    - **Property 33: Approval validation, supersession and derived status**
    - **Validates: Requirements 6.9, 23.1, 23.5, 23.7, 23.12**
  - [x] 1.24 Write Evidence_Store, Origin, and Approval_Store unit tests
    - An altered record is reported as a mismatch of the right kind; a modify or delete request leaves the record byte-identical and appends a rejection; a pre-existing Run directory is refused; an Approval_Record lacking any required field is rejected by field name; a wrong actor declaration is rejected; the loop entry point exports no Approval write function and does not import the Approval_Store reader (static check with a positive control).
    - _Requirements: 6.10, 6.11, 12.2, 12.5, 12.9, 21.2, 23.2, 23.7_
  - [x] 1.25 Checkpoint - M1 acceptance
    - Acceptance condition (R21.2): the Hypothesis, Claim, Experiment, and Evidence schemas validate their fixtures; the Evidence_Store passes hash-chain verification and the round-trip property; an altered record is reported as a mismatch; the Approval_Store core validates Approval_Records, rejects every record that lacks a required field, and passes hash-chain verification.
    - Test policy: unit and property tests only, run in the approved container with `--network none`; no AI_Provider, no Docker beyond the test container, no network.
    - Stop condition: any failing M1 test blocks M2. Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 21.1, 21.2, 21.9_
  - [x] 1.26 Apply M1 review fixes
    - Implements the design subsection "M1 review resolutions" (items 1 to 4, 6, 7, 9). Touches only `packages/discovery-loop`, `packages/analyzer`, and their fixtures and golden vectors.
    - Revert LocalKey to `^[a-z][a-z0-9_]{0,31}$` in the discovery-loop schemas (`LOCAL_KEY_PATTERN`) and in the analyzer expression name validation (`NAME_RE` for derived-value and table names, and the names referenced by `derived` and `lookup`). Request-input paths keep their pattern. Update the fixtures and the golden vectors in `packages/analyzer/test-vectors/` consistently, so that names accepted only by the widened pattern are now rejected by both packages.
    - Detect overflow at every intermediate arithmetic node; the first out-of-range node gives `overflow` with the pointer of that node. Add a vector in which a later operation would bring the value back into range.
    - Make `evaluate` return `invalid_expression` for any structurally invalid AST, never throw, and never return `ok: true`. Add `invalid_expression` to `EvalErrorCode`.
    - Derive the `source` Evidence_Status by pooling all `source` outcomes (`deriveSourceStatus`) as in resolution 6, and make the Approval reader report no completeness claim without an anchor (resolution 7).
    - Add a test that asserts equality of the duplicated definitions in the two packages: the LocalKey pattern, the Scalar range, and the Expr operator set (resolution 4).
    - _Requirements: 4.6, 4.8, 4.14, 4.15, 6.5, 6.18, 23.9, 23.14_
  - [x] 1.27 Write security tests for the M1 review
    - Nested reserved fields: for each reserved name (`origin`, `evidence`, `evidence_status`, `approval`, `approved`) and for several nesting positions (inside `condition`, `effect`, `citations`, `threshold`, another nested object, the Hypothesis top level, the response top level), the whole response is rejected and no part is stored or used. Positive control: the same name at the top level of a Claim is discarded, recorded as `ai_content_discarded` without the value, and the rest of the response is accepted.
    - Authority isolation: for every discarded or rejected authority field, compare the four facts (Origin, `source` Evidence_Status, `experiment` Evidence_Status, Approval status) before and after; they are identical.
    - Required fields with `strictRequired` disabled (resolution 8): generate, for every schema and every required field, including nested objects, an otherwise valid input that lacks that field and assert that the schema rejects it and names the field.
    - Approval tail truncation: removing trailing records yields a chain that verifies without mismatch but is not reported as complete when no anchor is supplied; with a correct anchor the removal is reported (document-behavior test).
    - **Property 21: Untrusted AI responses are gated whole**
    - **Validates: Requirements 4.8, 4.11, 4.16, 6.16, 17.6, 23.4, 23.6, 23.14**
  - [x] 1.28 Checkpoint - M1 review regression
    - Re-run all required M1 tests, `tsc -b`, and `check:pins` in the approved toolchain container with `--network none`. Report the test-count difference against the M1 baseline of 22 test files and 686 tests, and the reason for each difference.
    - Out of scope for this checkpoint: any M2 work, applying the override, operations on existing containers, a database reset, use of the Test API, a real AI call, changes to Ground_Truth or Migration_Decisions, and `git commit` or `git push`.
    - Stop condition: any failing M1 test blocks M2. Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 21.1, 21.2, 21.9_
  - [x] 1.29 Apply confirmed M1 policy decisions
    - Implements the design subsection "M1 review resolutions" items 10 to 14. Touches only `packages/analyzer`, `packages/discovery-loop`, and their tests.
    - Implement the item 14 distinction in `packages/analyzer` (`EvalError.cause`, the new code `internal_error`, and `invalid_expression` with `cause: 'structural'`), and in any duplicated type in `packages/discovery-loop`.
    - Minimal tests: (a) a structurally invalid AST yields `invalid_expression` with `cause: 'structural'`; (b) an injected internal fault (a test-only hook, or a Proxy or getter that throws during evaluation) yields `internal_error` with `cause: 'internal_fault'`, never `ok: true`, never throws, and the result carries no exception text; (c) a test pinning the reserved-name matching rule of item 10, with positive cases (case and separator variants such as `Origin`, `evidence_status`, `evidence-status`, `evidenceStatus`, `APPROVED`, and prefix names such as `evidenceNote` and `approvedBy`) and negative cases including near-misses that must NOT match (`originator`, `my_origin`, `disapproved`, `evidenc`), and a check that a nested name is not discarded by `discardAiAuthorityFields`; (d) a `-0` normalization test for literals and lookup values, if not already present; (e) update the duplicated-definition equality test of 1.26 if the type changed.
    - _Requirements: 4.15, 4.16, 4.17, 4.18, 4.19_
  - [x] 1.30 Checkpoint - M1 final regression and Git hygiene check
    - Re-run all M1 tests, `tsc -b`, and `check:pins` in the approved toolchain container with `--network none`. Report the count difference against the baseline of 24 test files and 799 tests, and the reason for each difference.
    - Then inspect `git status`, `git diff --stat`, and the untracked files, using read-only Git commands only. Scan the changes for secrets, credentials, `.env` files, real PII, absolute host paths, log files, `node_modules`, `dist`, and build artifacts, stray files, and large binaries. Confirm that `.gitignore` covers them. Run no `git add`, `git commit`, or `git push`, and delete no file without asking the user.
    - Out of scope for this checkpoint: any M2 work, applying the override, operations on existing containers, a database reset, use of the Test API, a real AI call, and changes to Ground_Truth or Migration_Decisions.
    - Stop condition: any failing M1 test blocks M2. Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 21.1, 21.2, 21.9_
  - [-] 1.31 Normalize line endings and save M0 and M1 to Git
    - Add a `.gitattributes` that sets `text eol=lf` only for the paths created or changed by M0 and M1 (root config files, `.kiro/steering/`, `.kiro/specs/discovery-loop/`, `docs/version-pinning.json`, `infra/discovery/`, `infra/docker-compose.discovery.yml`, `packages/`, `.env.example`, `.gitignore`, `.gitattributes`); no repository-wide rule and no renormalization of `legacy/`, `evaluation/`, `tests/legacy-sample/`, `infra/docker-compose.yml`, or `infra/nginx/`. Verify that the line-ending change creates no unintended diff.
    - Re-check the diff and untracked files for secrets, Ground_Truth data, and generated artifacts; re-run the required tests, `tsc -b`, and `check:pins`; confirm the protected paths are unchanged.
    - With the explicit one-time human approval: stage only the M0 and M1 deliverables by explicit path, commit on `develop` with the message `Complete Phoenix Discovery Loop M0 and M1`, check the remote for unexpected updates before pushing, and push normally to `origin/develop`. No push to `main`, no force push, no rebase, no history rewrite.
    - _Requirements: 19.1, 19.2, 20.7, 21.1, 21.9_

- [ ] 2. M2 Source_Bundler, Citation_Verifier, Experiment_Policy, Comparator, Experiment_Runner, and Launcher
  - [ ] 2.1 Implement the Source_Bundler in `packages/analyzer`
    - Port of the reference builder `tests/legacy-sample/lib/ai-input-builder.ps1` as TypeScript: read exactly the allowlisted files in listed order, reject every error case (absolute path, traversal, directory, link, duplicate, missing, unreadable, malformed allowlist, JSON versus Markdown table difference), normalize CRLF and lone CR to LF before hashing, and write a deterministic manifest.
    - Read the allowlist JSON and Markdown through ports; the two allowlist documents are mounted read-only in the runtime (C5).
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_
  - [ ] 2.2 Write property test for Source_Bundle determinism and manifest equality
    - **Property 1: Source_Bundle determinism and manifest equality**
    - **Validates: Requirements 1.1, 1.2, 1.6, 1.7, 1.8**
  - [ ] 2.3 Write property test that the Source_Bundler fails closed
    - **Property 2: Source_Bundler fails closed on any invalid allowlist**
    - **Validates: Requirements 1.3, 1.4, 1.5**
  - [ ] 2.4 Implement the Citation_Verifier in `packages/analyzer`
    - Fixed check order (`malformed_citation`, `file_not_in_bundle`, `range_out_of_bounds`, `quote_not_found`) plus `source_unavailable` for hash, read, or UTF-8 failure; the text rules of R5.7 (LF normalization, no trim, no Unicode normalization, BOM kept); one result per Citation; no AI, network, or other input.
    - Verification results are the only source of `source` Evidence records (task 1.14 rejects any other writer).
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_
  - [ ] 2.5 Write property test for citation soundness and completeness
    - **Property 3: Citation verification is sound and complete**
    - **Validates: Requirements 5.2, 5.5, 5.7**
  - [ ]* 2.6 Write property test for citation failure classification
    - **Property 4: Citation failures are classified by the first failing check and stay local**
    - **Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.9**
  - [ ] 2.7 Write the Source_Bundler import and attempted-read isolation test
    - Static dependency analysis proving no import of, and an attempted-read check proving no access to, `evaluation/`, `tests/`, `.kiro/`, `infra/`, or any `README.md`. Include a positive control: a fixture that imports a forbidden location must be reported.
    - _Requirements: 1.9, 15.1, 15.7, 15.13_
  - [ ] 2.8 Implement the Experiment_Policy in `packages/verifier`
    - Pure `decide` function over Experiment content and baked-in policy configuration: exact method and path allowlist, deny rules for reset and the test namespace under all encodings, header allowlist, absolute URL, host, and traversal rejection, count and size limits, evaluation-failure rejection, and a fixed rule-id order.
    - Fail closed: a missing, malformed, or widened configuration (including a denied operation in the allowlist) rejects every Experiment and prevents the Run from starting.
    - _Requirements: 7.5, 8.1, 8.2, 8.3, 8.4, 8.5, 8.6, 8.7, 8.8, 8.9, 8.10, 8.11, 9.16_
  - [ ] 2.9 Write property test for deterministic policy decisions
    - **Property 9: Experiment_Policy decisions are deterministic**
    - **Validates: Requirements 8.2, 8.3, 8.9**
  - [ ] 2.10 Write property test for rejection of reset and the test namespace
    - **Property 10: Reset and the test namespace are rejected under all encodings**
    - **Validates: Requirements 7.3, 7.5, 8.4, 8.5**
  - [ ] 2.11 Write property test for accepted Experiment content
    - **Property 11: Accepted Experiments contain only allowlisted, in-limit content**
    - **Validates: Requirements 8.1, 8.7, 8.8**
  - [ ] 2.12 Implement masking and the Comparator in `packages/verifier`
    - Idempotent `maskJson` with one fixed mask token; Comparator with exact value and type comparison, unnamed Observation fields ignored, ordered difference list with the status first, `not_comparable` reasons (including `not_executed`, `timed_out`, and `aborted` Observations), no mutation of inputs, and results free of wall-clock and random values.
    - The comparison result is the only basis for `experiment` Evidence and implies no `source` Evidence, Origin, or Approval; `match` is reported as agreement with observed behavior, not as specification correctness.
    - _Requirements: 10.1, 10.2, 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11, 10.12, 10.13_
  - [ ] 2.13 Write property test for masking idempotence
    - **Property 12: Masking is idempotent**
    - **Validates: Requirements 10.2, 10.12**
  - [ ] 2.14 Write property test for Comparator exactness and ordering
    - **Property 13: Comparator results are exact, ordered and repeatable**
    - **Validates: Requirements 10.3, 10.4, 10.5, 10.6, 10.7, 10.8, 10.9, 10.10, 10.11**
  - [ ] 2.15 Implement the preparation table and the Experiment_Runner with lease checks
    - In `packages/verifier`: health check within 10 seconds; execute only Experiments with a recorded `accept` decision (`policy_not_accepted` otherwise); `LeasePort.check()` before the Run, before each Experiment, and before every request including reset and preparation (no per-Experiment lock: the Launcher holds the Run_Lock for the whole Run); one Experiment at a time, in submitted order; reset and confirm first; runner-owned preparation table (never SQL, never AI-supplied operations); request sequence in declared order; Observation captured masked.
    - Lease invalid before the first request-sequence request: `not_executed` with `lease_unavailable`. Lease invalid after at least one such request: `aborted` with `lease_unavailable` and the responses collected so far. A stale heartbeat maps to `launcher_killed`, other mid-run invalidity to `lease_unavailable`. No `HttpPort.send` while the check is invalid.
    - Per-request and per-Experiment time limits with `not_executed` and `timed_out` reasons; refuse to start for a Test_API address that is neither the loopback-published Reverse_Proxy address nor the configured internal address, recording the address and sending no request. Use an injected `HttpPort`; the AI has no access except through validated, policy-accepted Experiments.
    - _Requirements: 7.3, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11, 9.12, 9.13, 9.14, 9.15, 9.16, 9.18, 17.7, 18.2, 18.3, 24.9, 24.12, 24.15_
  - [ ] 2.16 Write property test for the Run_Lease gate
    - **Property 34: The Run_Lease gates every request**
    - Use a fake monotonic clock and a scripted lease directory view.
    - **Validates: Requirements 9.4, 9.5, 24.9, 24.12, 24.15**
  - [ ] 2.17 Write Experiment_Runner unit tests with fake HTTP and lease ports
    - Reset first; preparation order and failure handling; every `not_executed`, `aborted`, and `timed_out` reason; rejection of requests the policy rejects; unhealthy Legacy_App executes nothing; refused address; no request when the lease is missing, malformed, bound to another Run, or revoked.
    - _Requirements: 9.1, 9.2, 9.3, 9.5, 9.7, 9.8, 9.11, 9.14, 18.3, 21.3, 24.9_
  - [ ] 2.18 Implement the host-side Launcher in `discovery/tools/Start-DiscoveryRun.ps1` (PowerShell 7)
    - Acquire the existing named mutex `Local\ProjectPhoenixGroundTruthEvaluation` with a zero wait and an exclusive Run-versus-Run file handle with a zero wait, both owned by the Launcher process and never delegated to a child process or the container. On failure: exit non-zero, report `conformance_mutex` or `run_lock`, create no Run_Volume, no Run directory, no lease, and no container.
    - Mutex scope: the guarantee covers one host and one Windows logon session only (the `Local\` namespace, A11). State this in the script header and in the Run_Manifest facts (task 4.6); exclusion across logon sessions, users, or hosts is not guaranteed and is recorded as a residual risk with status `unresolved` (task 2.22).
    - Only after both locks are held: stop leftover runtime containers by label (C9, stated in Requirement 24.12), create the Run_Volume `phoenix-run-<run-id>` (refuse if a Run_Volume, `discovery/runs/<run-id>/`, or `discovery/runs/.incoming/<run-id>/` already exists, leaving it unchanged, R12.2) and no export directory, issue the Run_Lease bound to the Run identifier and the Launcher process, renew the heartbeat, and mark an earlier Run without a manifest as `interrupted` (task 2.22).
    - Start the runtime container only with `docker run`, not as a Compose service (A10), attached to the network `phoenix-discovery-lab` and to no other network, with the Run_Volume as the only location that receives Run records and no published port. The start step is wired to the runtime image in 4.9. Inspect the created container (`mount_inspection` attestation).
    - On normal or error end: stop the container, confirm it is not running, revoke the lease, and only then release the mutex. Run the export procedure of task 2.21 and release the Run lock only after it ended with `complete` or `incomplete`. Refuse to start a Run unless the latest `override-apply` Approval_Record is `approved` and the Approval_Store verifies (mechanical backstop).
    - Measure the lease propagation time and the behavior of the Run_Volume and the lock and lease directories on Docker Desktop (OD-3) so the staleness setting can meet the 10-second stop target. The conformance runner is not modified.
    - _Requirements: 12.1, 12.2, 12.17, 15.12, 18.13, 18.20, 24.4, 24.5, 24.6, 24.7, 24.8, 24.10, 24.11, 24.12, 24.16_
  - [ ] 2.19 Apply the approved Discovery_Override
    - **Requires explicit human approval before execution** (the Gate `override-apply` of 0.13). Re-present the exact command and the effective network membership change, and apply only if the override file still has the content hash approved in 0.13. Do not run `infra/docker-compose.yml` edits of any kind.
    - After applying, verify with `docker network inspect` that `phoenix-discovery-lab` is `internal` with IPv6 disabled, has `reverse-proxy` as its only member until the Launcher starts a runtime container (the runtime is started with `docker run`, not by the override), and that `reverse-proxy` has exactly three networks. Measure and record that the nginx configuration accepts connections on the new interface and whether a Host header is needed (design: UNVERIFIED until checked here). Run `test_network_isolation.ps1` only without the override.
    - _Requirements: 18.2, 18.12, 18.13, 18.14, 18.15, 18.17, 18.18, 18.20, 21.12_
  - [ ] 2.20 Run the integration test against the live Test API
    - **Requires user confirmation before running, and the override applied under 2.19.** Do not run while the conformance runner is active; run through the Launcher.
    - Execute one accepted Experiment with a reset beforehand through the Test API only, and verify that every request the policy rejects is rejected. Use neutral Experiments; log no business-rule values. Run from a runtime test container over the lab network, with a positive control that a service on the lab network is reachable.
    - Include measurements of bind-mount behavior for exclusive create, rename, and fsync on the lock and lease directories, and of the Windows directory rename used by the export (OD-3). Run records go to the Run_Volume, not to a bind mount.
    - _Requirements: 9.1, 9.2, 9.7, 9.12, 18.2, 21.3, 24.4_
  - [ ] 2.21 Implement the Launcher export procedure with the Completion_Marker
    - In `discovery/tools/Start-DiscoveryRun.ps1` (or a script it calls), after the runtime container has stopped and the lease is revoked, in this order: (1) create `discovery/runs/.incoming/<run-id>/` only now (fail if it exists); (2) copy the Run_Volume with a short-lived helper container (pinned base image, `--network none`, `--read-only`, non-root, `--cap-drop ALL`, no published port, the Run_Volume read-only, only the export directory read-write); (3) verify the export on the host in PowerShell 7 (file list against the Run_Manifest, SHA-256 of every file, hash-chain walk, count and last hash; D18), modifying nothing; (4) write the Completion_Marker `COMPLETE` last, containing the SHA-256 of the Run_Manifest; (5) move the export to `discovery/runs/<run-id>/` without assuming that the rename is atomic; (6) verify again at the final location and check the marker.
    - On a failure of any step: keep the Run as `incomplete`, remove any Completion_Marker that was written, write a Reason_File (`REASON.json`) that names the failing step (`create_export`, `copy`, `verify`, `marker`, `move`, or `final_verify`) and contains no secret, and never present the Run as complete.
    - Volume disposition: remove the Run_Volume only after the final verification succeeded; keep it for diagnosis when any step fails or the Launcher is killed. Write the Launcher record `<run-id>.launcher.json` next to the export with `removed_after_verified_export` or `kept_for_diagnosis`; it is not a Run artifact and the Run_Manifest does not list it. If the volume removal fails, the Run stays `complete` and the record says `kept_for_diagnosis`.
    - Implement the chain verification in PowerShell against the golden vectors of 1.16 and 1.4, so the TypeScript and PowerShell implementations agree. Readers use the acceptance function of 1.12.
    - The code is tested offline with a fake Docker port (2.23). Running the real helper container against a real Run_Volume happens only in task 4.17, with user confirmation.
    - _Requirements: 12.8, 12.9, 12.11, 12.18, 12.19, 12.20, 12.21, 12.22, 12.23, 12.24, 24.6, 24.7_
  - [ ] 2.22 Implement abandoned-mutex handling and the single-session scope note
    - If the Launcher acquires the conformance mutex in the abandoned state (the exception reports `AbandonedMutexException`), it starts no Experiment and no runtime container for that start attempt, creates no Run_Volume, releases the mutex and any Run lock it holds, reports `conformance_mutex_abandoned`, and exits non-zero. Recovery is left to the next explicit start, which first stops leftover runtime containers by label (after both locks are held and before a new Run is created) and marks the earlier Run as `interrupted` with a Reason_File in its Incoming_Export, keeping the Run_Volume for diagnosis.
    - Record the single-host, single-logon-session scope (A11) in the Launcher output on every start and in the residual-risk register input of 6.9, with status `unresolved`.
    - Measure the behavior of the existing conformance runner (unmodified) against an abandoned mutex; the acceptance condition is that it runs no scenario (exit status 2 or an error exit). The runner is not modified.
    - _Requirements: 24.12, 24.16, 24.17, 24.18, 24.19_
  - [ ] 2.23 Write the Launcher export and abandoned-mutex unit tests
    - Run the real script against a fake Docker port and a temporary directory; no external AI service. Export cases: a positive control (a complete Run is accepted by every reader), and one negative case each for a missing Completion_Marker, a marker hash different from the Run_Manifest hash, one modified file, one unlisted file, one missing listed file, a broken chain link, a copy failure (the helper made to fail), and a Launcher killed before the marker is written. Each negative case asserts no `COMPLETE`, a Reason_File with the right step, the Run_Volume kept, and that no reader accepts the Run.
    - Disposition cases: `removed_after_verified_export` only after a verified final location; `kept_for_diagnosis` after any failure, after a failed volume removal, and after a kill.
    - Pre-existing `<run-id>` collisions (final directory, Incoming_Export, Run_Volume) are refused and left unchanged. An abandoned mutex (a helper process that exits without releasing the real named mutex) gives `conformance_mutex_abandoned`, a non-zero exit, no Run_Volume, and no container.
    - _Requirements: 12.2, 12.20, 12.21, 12.22, 12.23, 12.24, 24.13, 24.17_
  - [ ] 2.24 Checkpoint - M2 acceptance
    - Acceptance condition (R21.3): the Source_Bundler produces a manifest equal to the allowlist and rejects each error case of R1.3; the Experiment_Runner executes one accepted Experiment against the healthy Legacy_App with a reset beforehand and rejects every request the Experiment_Policy rejects. The Launcher export procedure and the abandoned-mutex handling pass their unit tests (2.23).
    - Test policy: unit tests for the deterministic modules, plus integration tests against the Legacy_App only through the Test API, run only after the user confirms.
    - Stop condition: any failing M2 test, or a Legacy_App that is not healthy, blocks M3. Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 21.1, 21.3, 21.9_

- [ ] 3. M3 AI client, Payload_Auditor, and Mock_Provider
  - [ ] 3.1 Define the AI_Provider interface, provider selection, and shared tokenizer in `packages/ai-client`
    - Structured request and response types; a single configuration value selects the implementation with no caller change; the interface exposes no file, process, network, Docker, or Git operation.
    - Export the pure `tokenize` and `ngramHashes` functions used by both the auditor and the audit-config builder.
    - _Requirements: 3.1, 3.5, 3.6, 3.7, 2.12_
  - [ ] 3.2 Implement the Mock_Provider with hand-written neutral fixtures
    - Static canned responses for the three request kinds (Hypothesis generation, Experiment generation, Hypothesis revision), written by hand about the fictitious API and never derived from any evaluation file or observed behavior; returns an unmatched-request error and never fabricates; byte-identical output for byte-identical requests; no import of `evaluation/`; responses pass the same schemas as real responses; no credential needed.
    - _Requirements: 3.2, 3.3, 3.4, 3.5, 3.10, 3.11, 3.12, 3.13, 3.14, 19.10_
  - [ ] 3.3 Write property test for Mock_Provider determinism
    - **Property 22: Mock_Provider is deterministic and never fabricates**
    - **Validates: Requirements 3.3, 3.12**
  - [ ] 3.4 Implement the Payload_Auditor
    - Audit the exact bytes to be transmitted; save the bytes, hash, result, checks performed, and per-check outcome; block on canary or decoy match (by identifier only), non-allowlisted path, Source_Bundle hash mismatch, any part outside the permitted part kinds, restricted-content fingerprint, credential value, or any incomplete check or missing or empty audit configuration; bind the transmitted bytes to the audited hash.
    - Never write a canary, decoy, or fingerprint value to any log, artifact, or manifest. The auditor does not verify runtime access rights and never reports an isolation status (that is task 4.2).
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.11, 2.12, 2.14, 11.2, 11.3, 19.7_
  - [ ] 3.5 Write property test for blocking forbidden content
    - **Property 19: The Payload_Auditor blocks forbidden content and passes verified content**
    - Each generated payload violates exactly one check; a payload that violates none passes.
    - **Validates: Requirements 2.4, 2.5, 2.6, 2.7, 2.8, 2.13, 11.2, 11.3**
  - [ ] 3.6 Write property test for fail-closed audit and byte binding
    - **Property 20: Audit fails closed and binds the transmitted bytes**
    - **Validates: Requirements 2.3, 2.9**
  - [ ] 3.7 Implement the host-side Audit_Config_Builder in `evaluation/audit-config-builder/`
    - Containerized, `--network none`, imports only the pure `tokenize` and `ngramHashes`; builds n-gram fingerprints for each restricted file minus the allowed corpus, with the Conformance_Baseline observed-response subtree exclusion (OD-4); writes `discovery/config/audit-config.json`; prints no canary, decoy, or fingerprint values.
    - Test with synthetic fixture files only. **Running it against the real restricted files requires user confirmation**, and its output is never committed.
    - _Requirements: 2.8, 2.9, 2.12, 15.3_
  - [ ] 3.8 Implement the untrusted AI response gate
    - Size check before parsing; count limits (Claims, Citations, Experiments, requests, body bytes) with integer configuration of at least 1; JSON-only parsing; depth limit of 32; duplicate-key and undefined-field rejection; whole-response rejection recorded with the exceeded limit; rejected text never forwarded to a later request; each rejection counted as one failed call; no execution or interpretation of AI text beyond the expression evaluator.
    - Output is stored and displayed as inert plain text.
    - _Requirements: 3.8, 3.9, 4.2, 4.3, 4.8, 4.9, 7.2, 7.4, 7.7, 7.8, 17.1, 17.2, 17.3, 17.4, 17.5, 17.6, 17.7, 17.8, 17.9_
  - [ ] 3.9 Write property test for whole-response gating
    - **Property 21: Untrusted AI responses are gated whole**
    - **Validates: Requirements 4.2, 4.3, 4.8, 7.2, 7.4, 7.7, 17.1, 17.3, 17.4, 17.5, 17.6, 17.9**
  - [ ] 3.10 Implement the approval-like content discard
    - Before strict validation, remove exactly the reserved names `origin`, `evidence`, `evidence_status`, `approval`, `approved` at the Claim level and write an `ai_content_discarded` record that names the field and omits the value (C1). Any other undefined field still rejects the whole response. The stored Claim revision always carries an orchestrator-assigned Origin.
    - Approval-like content in AI output never creates an Approval_Record, because the loop has no write interface to the Approval_Store; add unit tests with fixtures for each reserved name, for approval-like text, and for the absence of any Approval_Store access from the gate.
    - _Requirements: 4.11, 6.11, 6.16, 17.6, 23.4, 23.6_
  - [ ] 3.11 Write the M3 unit and safety tests
    - Provider switch by configuration only; Mock_Provider fixtures exist for all three request kinds and an unmatched request errors; Mock_Provider fixtures contain no canary and the module has no import of `evaluation/` (static check with a positive control).
    - Hostile Mock_Provider responses (oversized, over-count, malformed, duplicate-key, deeply nested, undefined field, command string, path traversal string, markup) are rejected or stored as inert data with no effect on the file system, the process environment, or the Legacy_App.
    - Credentials are read only from environment variables; an unset variable for a real provider refuses the Run naming the variable and not its value; the Mock_Provider needs no credential.
    - _Requirements: 2.13, 3.1, 3.2, 3.10, 3.11, 3.12, 3.13, 17.10, 19.1, 19.6, 19.10_
  - [ ] 3.12 Checkpoint - M3 acceptance
    - Acceptance condition (R21.4): the Mock_Provider returns identical responses for identical requests; the provider is switchable by configuration only; the Payload_Auditor blocks a payload containing a canary, a fingerprint of restricted content, a non-allowlisted path, or a Source_Bundle hash mismatch.
    - Test policy: offline unit tests with the Mock_Provider only.
    - Stop condition: any case in which a blocked payload is transmitted or the audit result is not recorded blocks M4. Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 21.1, 21.4, 21.9_

- [ ] 4. M4 Loop_Orchestrator, runtime container, isolation, approval command, and one full Mock Run
  - [ ] 4.1 Implement RunConfig validation and start-up refusals
    - Integer limits with defaults (Iterations 3, Experiments 20, rejected Experiments 20, total time, per-call time, retries) and permitted ranges; refuse to start on a missing, non-integer, or out-of-range value with no silent default; refuse on an invalid Experiment_Policy configuration, an unreadable audit configuration, an undeterminable AI_Sandbox destination list when the Kiro CLI provider is selected, an unset credential for a real provider, a missing or invalid Run_Lease, or a configuration that names an evaluation output location.
    - Create no Run content when a refusal happens at start-up.
    - _Requirements: 8.6, 11.7, 11.8, 11.10, 15.10, 15.11, 18.9, 19.6, 24.9_
  - [ ] 4.2 Implement the Ground_Truth access-denial verification as its own component
    - A module separate from the Payload_Auditor, with its own tests, producing the result recorded in the Run_Manifest field `ground_truth_access_denial`. It measures what the runtime process can read, list, and stat under the runtime rights (checks `import_analysis`, `read_denial`, `uid`, `rootfs_readonly`, `env_names`) and consumes the Launcher-measured `mount_inspection` attestation. A check is `verified` only when executed in that Run; a failed or incomplete check refuses the Run with no Run content; a later denied read stops the Run with `isolation_violation`.
    - Neither this result nor the Payload_Audit result is used as evidence for the other.
    - _Requirements: 2.14, 2.15, 15.2, 15.3, 15.6, 15.11, 15.12, 15.13, 15.14, 15.16_
  - [ ] 4.3 Implement the start gate `mayStartRun`
    - `mayStartRun(payloadAuditConfig, accessDenial)` is true only when the Payload_Audit configuration check is `pass` and the access-denial status is `verified`, each produced by a different module in that Run. Both are required for every Run, and each is written to its own Run_Manifest field (`payload_audit`, `ground_truth_access_denial`).
    - Write the truth-table unit test (true for exactly one of the four input combinations) and a static check that neither module imports the other, with a positive control.
    - _Requirements: 2.14, 2.15, 2.16, 15.14, 15.15, 15.16_
  - [ ] 4.4 Implement the Loop_Orchestrator state machine in `packages/discovery-loop`
    - Phases for Hypothesis generation, Experiment generation, policy validation, execution, comparison, and revision; Payload_Audit before every call and retry (a blocked audit is never retried or counted as a provider retry); validated Hypothesis and Citation checks before use; `source` Evidence written once per revision by the Citation_Verifier result; `experiment` Evidence per tested Claim revision from the comparison result (`inconclusive` for `not_comparable`); Experiment counting only after policy acceptance; deadline checks and abort at the total time limit.
    - Limit handling per A8: the revision call of an Iteration is made only if no limit is reached; after any limit (Iteration, Experiment, total time, rejected-Experiment, provider retry) there is no new provider call and no closing revision; the Run_Manifest names the last revision that passed schema and Citation verification as `finalHypothesisRevision` (or `none`); later comparison results stay as Evidence records.
    - Exactly one termination reason from the fixed set (including `lease_unavailable`, `launcher_killed`, and `isolation_violation`), then seal the Run_Manifest. Deterministic counter-based identifiers for Hypothesis, Claim, Experiment, and Evidence. Use public package entry points only; never read the Approval_Store while building payloads.
    - _Requirements: 2.1, 2.10, 3.7, 3.8, 3.9, 4.1, 4.9, 4.10, 6.11, 7.1, 7.8, 8.10, 8.11, 11.1, 11.2, 11.3, 11.4, 11.5, 11.6, 11.7, 11.9, 11.10, 11.11, 11.12, 11.13, 11.14, 11.15, 11.16, 11.17, 11.18, 20.4, 22.2, 24.15_
  - [ ] 4.5 Write property test for bounded termination with exactly one reason
    - **Property 18: Every Run terminates within bounds with exactly one reason**
    - Use a scripted provider and a fake clock.
    - **Validates: Requirements 2.10, 3.8, 3.9, 4.9, 8.10, 8.11, 11.7, 11.8, 11.9, 11.10, 11.11, 11.12, 11.13, 11.14, 11.15, 11.16, 11.17, 11.18**
  - [ ] 4.6 Assemble the Run_Manifest content
    - Configuration and limits, provider identity and version, Node.js, package manager, and dependency versions, Source_Bundle paths and hashes, Legacy_App starting-state identity, excluded fields, environment variable names with set or unset only, `payload_audit` and `ground_truth_access_denial` as separate fields, the `finalHypothesisRevision`, AI_Sandbox safety status `UNVERIFIED` until a verification record exists, residual-risk statuses, and the Launcher lock and lease facts, including the single-host, single-logon-session scope of the mutual exclusion (residual risk `unresolved`). The operator attestation of R24.2 is used only for a Run started without the Launcher and is labeled as an attestation.
    - _Requirements: 2.11, 2.14, 11.16, 11.18, 15.12, 16.13, 16.14, 18.8, 18.11, 19.3, 22.3, 24.2, 24.16, 24.19_
  - [ ] 4.7 Implement replay and the reproducibility comparison command
    - Replay uses only recorded Mock_Provider responses and makes no other provider call; report `diverged` with the first differing record id when a request hash differs; compare two Runs after removing the manifest-listed excluded fields and report `identical` with exit status 0 or `different` with the first differing record id and a non-zero status.
    - _Requirements: 22.1, 22.4, 22.5, 22.7_
  - [ ] 4.8 Write property test for reproducibility and replay divergence
    - **Property 23: Runs with identical inputs produce identical records, and replay detects divergence**
    - Use an in-memory fake Legacy_App with neutral data.
    - **Validates: Requirements 22.1, 22.2, 22.4, 22.5, 22.7**
  - [ ] 4.9 Build the `discovery-runtime` container and wire it to the Launcher
    - Multi-stage image from the pinned digest, non-root user, read-only root, no repository mount, no Docker socket, no HOME, no Approval_Store mount, policy configuration and preparation table baked in, deny-all build-context list re-allowing only manifests, lockfile, tsconfig, and `packages/**`, and the labels the Launcher uses to find leftover containers.
    - Wire the Launcher start step of 2.18 to this image with the mount table of the design (seven source files and the allowlist documents read-only, two config files, the lease directory read-only, the Run_Volume read-write as the only location for Run records, and no Windows bind mount that receives Run records). The container is started only by the Launcher with `docker run` on the network `phoenix-discovery-lab` (no Compose service, A10).
    - **Requires explicit human approval before execution** for the `docker build` of the runtime image, and for any file under `infra/`; only the already approved Discovery_Override applies, with no published port and no change to existing isolation settings.
    - _Requirements: 12.1, 12.2, 15.2, 15.3, 15.11, 15.12, 18.2, 20.10, 23.3, 24.7_
  - [ ] 4.10 Implement the host-side approval command `discovery/tools/Add-ApprovalRecord.ps1` (PowerShell 7) with tests
    - The only writer of the Approval_Store. Requires approver, decision, target, rationale, and an actor declaration (`human` or `kiro-development-agent`) explicitly with no default; takes the timestamp from the host clock with offset and accepts no caller-supplied timestamp; sets `recorded_by` to the declared actor; has no modify or delete verb; a `supersedes` argument must satisfy the rules of R23.12; exits non-zero and names each field on rejection; leaves the store byte-identical on an invalid record; appends a `store_rejection` line for a modify or delete attempt; has a read-only `verify` operation; uses a store mutex so concurrent invocations get distinct sequence numbers and valid links; removes the temporary file and reports an error on a failed write.
    - Tests run the real script on a temporary store: the golden vectors of 1.16 (the TypeScript reader accepts the PowerShell output and the reverse), one case per R23.7 condition, a missing or other actor, concurrent invocations, a failed write, supersedes accepted and rejected cases, and verify detecting `modified`, `missing`, and `chain_break`. These tests are required.
    - The Kiro development agent runs the command only with values the human stated explicitly (R23.8).
    - Open decision with deadline M4 (design "M1 review resolutions", item 11): decide and implement the external anchor policy (R23.14) before the M4 checkpoint (4.19). The decision states where the anchor lives outside the store, who writes it, when it is updated, and how it is compared with the store (last sequence number and last-record hash). Until it is decided, no component claims that the Approval_Store is complete.
    - _Requirements: 6.9, 6.11, 23.1, 23.2, 23.5, 23.7, 23.8, 23.9, 23.11, 23.12, 23.13, 23.14_
  - [ ] 4.11 Write the runtime isolation tests
    - Static import check with a positive control (a fixture importing an evaluation module is reported); the runtime entry point imports neither `report` nor `ApprovalReader`.
    - Read, list, and stat denial under the runtime rights with a positive control (the same attempts succeed under the evaluator rights), plus mount-list inspection against the expected table. This test is separate from the Payload_Audit tests.
    - The Approval_Store is neither visible nor writable under the runtime rights, with a positive control that the host-side command can write.
    - Canary scan of a Mock Run's artifacts, payloads, and logs with a positive control (a Run seeded with a canary through a test-only channel is detected).
    - Evaluation output present and unreadable during a Run, with a positive control (a test-only configuration naming the evaluation output location is rejected).
    - Path-string or name-based filters are not counted as evidence.
    - _Requirements: 6.11, 15.1, 15.2, 15.3, 15.7, 15.8, 15.9, 15.10, 15.13, 15.16, 23.3_
  - [ ] 4.12 Verify the `discovery-lab` network and write the measurement record
    - After the override is applied under 2.19: `infra/docker-compose.yml` is byte-identical (hash compare); `discovery-lab` is `internal` and has exactly `discovery-runtime` and `reverse-proxy`; `discovery-runtime` has only that network and no published port; `reverse-proxy` has exactly three networks (two without the override); the evaluator and the Audit_Config_Builder run with `--network none`; a deliberately added container on `discovery-lab` is reported (positive control).
    - Measure that `discovery-runtime` reaches `reverse-proxy:8080`, has no route to the Internet, and has no listener (TCP and UDP port scan against `reverse-proxy` and from it), with a positive control of a successful connection to a service on the lab network. Write the measurement record for the internal-only isolation of `discovery-lab`; unmeasured paths stay `unresolved`.
    - _Requirements: 18.1, 18.4, 18.10, 18.12, 18.13, 18.14, 18.15, 18.16, 18.17, 18.18, 18.19, 21.5_
  - [ ] 4.13 Write the credential-handling Run tests
    - A Mock Run with no credential variables completes; a Run with a canary secret in the environment leaves that secret in no artifact, manifest, payload, log, or error record, with a positive control that a deliberately written secret is detected.
    - _Requirements: 19.2, 19.3, 19.9, 19.10_
  - [ ] 4.14 Execute one full Mock Run end-to-end through the Launcher and verify it
    - **Requires explicit human approval before execution**, plus user confirmation before running (it resets and uses the live Legacy_App; the conformance runner must be idle; the override must be applied under 2.19; the runtime image must be built under 4.9; the isolation test of 4.16 must have passed).
    - Start through the Launcher with the Mock_Provider and no external AI service. Verify that the Payload_Audit configuration check and the Ground_Truth access-denial verification both passed and are recorded in separate manifest fields, verify the Run_Manifest, confirm a recorded termination reason, and confirm that the Launcher exported the Run from the Run_Volume with a verified Completion_Marker and recorded the volume disposition. Then repeat with identical configuration and confirm `identical` and a successful replay (readers accept only the complete Run).
    - _Requirements: 2.16, 3.4, 11.16, 12.8, 12.9, 12.17, 12.18, 12.19, 12.20, 12.22, 12.23, 15.12, 15.14, 22.1, 22.4, 22.6, 22.7, 24.7_
  - [ ] 4.15 Write the Discovery_Override isolation test `tests/discovery-loop/test_discovery_network_isolation.ps1` (mandatory)
    - A new PowerShell 7 script that uses only the Docker CLI, in the style of `tests/legacy-sample/`. It is separate from `tests/legacy-sample/test_network_isolation.ps1` and does not replace or modify it. It is mandatory for M4 (R21.5), not optional, and not an extension of the legacy test (A13). It refuses to run (non-zero exit, message) if the network `phoenix-discovery-lab` does not exist. It prints one line per check (`PASS`, `FAIL`, or `NOT MEASURED`) and exits non-zero if any check or any positive control fails (a failing control means the check is blind).
    - Group A, topology (R18.23): `phoenix-discovery-lab` is internal with IPv6 disabled; the members are exactly `reverse-proxy` plus the runtime container or the probe; `reverse-proxy` has exactly three networks; `legacy-app` and `legacy-db` keep the membership recorded in a baseline taken before apply; published ports are unchanged; `infra/docker-compose.yml` hash equals the recorded hash. Positive control: a deliberately attached extra container is reported, and a comparison against a deliberately wrong expected list fails.
    - Group B, reachability (R18.24): a probe started with the runtime's network flags reaches the `reverse-proxy:8080` health endpoint (positive control) and cannot reach `legacy-app` or `legacy-db` by name or IP address, an external TCP destination, an external DNS name, the host gateway, or any other `reverse-proxy` port (bounded scan; expected open set is 8080 only). A control container on a non-internal network shows the method can observe a reachable path. A timeout is reported as `blocked`, a refusal as `closed`, never as `not measured`.
    - Group C, forwarding (R18.25): from the lab side, traffic is not forwarded to the legacy networks or to external destinations through `reverse-proxy` or the host; UDP, ICMP, and IPv6 paths are recorded as `not measured` unless measured. Positive control: a request through `reverse-proxy` to its configured upstream succeeds.
    - Group D, runtime rights (R18.26): `docker inspect` of the runtime container (or one started with the same arguments) checks network attachments, user, privileged flag, capabilities, mounts (equal to the mount table and the Run_Volume), published ports (none), resource limits, read-only root, `no-new-privileges`, and no Docker socket. Negative fixture: a deliberately non-compliant container definition (root user, extra network, Docker-socket mount, published port, no limits) that the same check function must report for each property.
    - Group E, restoration (R18.27): after the override is removed in a separate approved step, `reverse-proxy` has exactly two networks, `phoenix-discovery-lab` no longer exists, and `tests/legacy-sample/test_network_isolation.ps1` is executed and passes. A result file that is missing or older than the removal is a failure, never a skip. The script does not remove the override itself.
    - Group F, not measured (R18.28): each unmeasured path (UDP, ICMP, IPv6 from the probe, other hosts, symbolic-link and hard-link checks, outbound traffic of `reverse-proxy` through `legacy-api`) is written as `not measured`; the record format rejects `blocked` for a path with no measurement.
    - Writing the script is file work; running it is task 4.16 and 4.17.
    - _Requirements: 18.4, 18.21, 18.22, 18.23, 18.24, 18.25, 18.26, 18.27, 18.28, 21.5_
  - [ ] 4.16 Run the Discovery_Override isolation test in the applied state (groups A to D and F)
    - **Requires explicit human approval before execution** (it starts probe and control containers), and requires the override applied under 2.19 and the runtime image built under 4.9. Do not run while the conformance runner is active.
    - Record the result as the measurement record for the internal-only isolation of `discovery-lab`; paths recorded `not measured` stay `unresolved` and are not assumed blocked. A failing check or a failing positive control blocks M5.
    - _Requirements: 18.4, 18.19, 18.21, 18.23, 18.24, 18.25, 18.26, 18.28, 21.5_
  - [ ] 4.17 Remove the override, run the legacy-sample isolation test, and run group E
    - **Requires explicit human approval before execution** for the removal of the Discovery_Override (it changes the effective network membership of `reverse-proxy`, R18.20) and for each container-executing test. Run it after the Mock Run of 4.14 (the Mock Run needs the override applied). A later re-apply needs its own `override-apply` approval.
    - After removal, run `tests/legacy-sample/test_network_isolation.ps1` and confirm it passes with `reverse-proxy` on two networks; then run group E of the isolation test. Do not modify `tests/legacy-sample/`. A skipped, missing, or not-run legacy test is never evidence of safety, and a result older than the removal is a failure.
    - _Requirements: 18.18, 18.20, 18.22, 18.27, 21.5_
  - [ ] 4.18 Run the Run_Volume export integration check with real Docker
    - **Requires explicit human approval before execution** (it creates a volume and runs a stub container and the helper container). Use a harmless labeled stub container that writes a valid sealed Run into a Run_Volume; no Legacy_App and no external AI service are needed.
    - Positive control: the export is copied, verified, marked `COMPLETE`, moved, verified again, the volume is removed, and the Launcher record says `removed_after_verified_export`. Then tamper with one file in a second volume and confirm `incomplete`, a Reason_File, no `COMPLETE`, the volume kept, and `kept_for_diagnosis`. Measure the Windows directory rename behavior (OD-3); completion rests on the marker, not on the rename.
    - _Requirements: 12.18, 12.19, 12.20, 12.21, 12.22, 12.24, 24.11_
  - [ ] 4.19 Checkpoint - M4 acceptance
    - Acceptance condition (R21.5): one Run terminates with a recorded termination reason, writes a Run_Manifest that passes verification, is exported with a Completion_Marker, passes the runtime isolation checks of R15 including the mandatory Ground_Truth access-denial verification, the `discovery-lab` network matches R18.12 to R18.17 after the override was applied with a separate human approval, the Discovery_Override isolation test passes (and the legacy-sample isolation test passes after the override is removed), a measurement record for the internal-only isolation of `discovery-lab` exists, and two Runs with identical configuration produce identical records.
    - Test policy: end-to-end Run with the Mock_Provider and no external AI service.
    - Stop condition: a non-terminating Run, a failed manifest verification, an incomplete export, a failed isolation check (including the Discovery_Override isolation test), or a non-identical repeat Run blocks M5. Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 21.1, 21.5, 21.9_

- [ ] 5. M5 Independent_Evaluator and mechanical mutual exclusion
  - [ ] 5.1 Create the evaluator package and container in `evaluation/spec-restoration-evaluator/`
    - Own `package.json` and container image, outside every runtime package; no runtime module imports it; `--network none`; read-only mounts for the Run directory, the four evaluation inputs, and the Approval_Store; one writable output directory under `evaluation/results/spec-restoration/` that never overwrites any other result file; versions taken from the Version_Pinning_Record.
    - _Requirements: 13.1, 13.3, 13.8, 13.9, 13.10, 13.12, 15.4, 18.16, 20.5_
  - [ ] 5.2 Implement verify-first input checking, including the Approval_Store chain
    - Recompute every artifact hash and the chain, and refuse (non-zero exit, error report naming each problem, no score) on mismatch, missing, or unlisted artifacts, a missing Run_Manifest, a Ground_Truth that is missing, unreadable, invalid, or not in the approved state, or a Conformance_Baseline or Migration_Decisions that is missing, malformed, or inconsistent with the Ground_Truth (including differing Approved_Divergence counts). Verify the Approval_Store chain read-only before scoring; a chain that fails verification is treated like an invalid input (C10, stated in Requirements 13.2 and 13.13). Open only the permitted files and write nothing into the Run directory.
    - Verify the mapping of Baseline units to the input document and the reference matcher kinds against the real files (OD-5).
    - _Requirements: 13.2, 13.4, 13.5, 13.6, 13.7, 13.13, 14.11, 23.9_
  - [ ] 5.3 Re-implement the expression evaluator inside the evaluator package
    - Independent implementation (D4) that consumes the shared golden vectors from `packages/analyzer/test-vectors/`. Canonical JSON and chain verification are re-implemented in the evaluator as well.
    - _Requirements: 4.6, 14.4_
  - [ ] 5.4 Write property test for evaluator and runtime expression agreement
    - **Property 26: The evaluator's expression implementation agrees with the runtime's**
    - Run both implementations in one test process from a third location that imports both.
    - **Validates: Requirements 4.6, 14.4**
  - [ ] 5.5 Implement deterministic Prediction derivation
    - Applying Claims by condition truth over the Baseline request inputs; union of expected responses; `conflicting` marking for differing values; unevaluable Claims treated as not applying with a recorded reason; no AI call.
    - _Requirements: 14.4_
  - [ ] 5.6 Implement two-axis scoring and the report
    - Axis A against the Conformance_Baseline only, axis B against the Ground_Truth and Migration_Decisions; `correct`, `incorrect`, `uncovered`, and `baseline_not_covered` (excluded from the axis A numerator and denominator, listed, never inferred); the separate Approved_Divergence list; per-axis counts and denominators; no merged score without both axes.
    - Four facts per applying Claim revision as four separate fields (Origin, `source` status, `experiment` status, Approval status read from the Approval_Store) with supporting and contradicting Evidence ids; a separate list of Claim revisions without a `supported` Evidence_Status of either kind, independent of their Approval and Origin.
    - Every `uncovered` unit carries exactly one reason code from `no_applying_claim`, `fixture_not_reproducible`, and `unsupported_request_form`; counts per reason code; an evaluation-limitations section that names every unit with the second or third code and its reason and keeps those units out of any AI-failure count (A6, A7). The Mock_Provider identity is flagged so the result is not presented as evidence of AI capability. Label as Spec_Restoration_Evaluation; byte-identical output with no timestamps, process ids, or host paths.
    - _Requirements: 3.14, 6.10, 6.12, 6.13, 13.11, 13.12, 14.1, 14.2, 14.3, 14.5, 14.6, 14.7, 14.8, 14.9, 14.10, 14.12, 14.13, 14.14, 14.15_
  - [ ] 5.7 Write property test for verify-first and determinism
    - **Property 27: The evaluator is verify-first and deterministic**
    - **Validates: Requirements 13.4, 13.5, 13.6, 13.11, 14.12**
  - [ ] 5.8 Write property test for independent axes
    - **Property 28: Axes are scored independently from the same Prediction**
    - **Validates: Requirements 14.1, 14.3, 14.7, 14.8**
  - [ ] 5.9 Write property test for Prediction derivation
    - **Property 29: Prediction derivation is a union with explicit conflicts**
    - **Validates: Requirements 14.4**
  - [ ] 5.10 Write property test for scoring partition, denominators, and reason codes
    - **Property 30: Scoring is a partition with correct denominators**
    - **Validates: Requirements 14.2, 14.5, 14.6, 14.9, 14.13, 14.14, 14.15**
  - [ ] 5.11 Write property test for the no-supporting-evidence list
    - **Property 35: Claim revisions without supporting evidence are listed by Evidence only**
    - **Validates: Requirements 6.10, 14.10**
  - [ ] 5.12 Write evaluator unit tests on saved Run artifacts
    - A Run with a modified hash, a missing artifact, an unlisted artifact, and a missing manifest is refused with no score; an Approval_Store with a broken chain is refused with no score; axis A and axis B are separate values; the Approved_Divergence list is present; unit scoring includes `uncovered` (with each reason code) and `baseline_not_covered`; the evaluation-limitations section is present; the Mock_Provider flag is present; two executions produce byte-identical output; the saved Run input and the Ground_Truth are unmodified after evaluation; a golden test on the committed Baseline.
    - _Requirements: 13.5, 13.6, 13.10, 13.11, 13.13, 14.2, 14.6, 14.8, 14.9, 14.15, 21.6_
  - [ ] 5.13 Write the evaluator isolation tests
    - Static import check that no runtime module imports the evaluator and that the evaluator imports no Docker or Legacy_App client, with a positive control.
    - Container check: a write into the Run directory fails and a write into the output directory succeeds (positive control); `--network none` is in effect; the Approval_Store mount is read-only; the evaluator reads only the permitted files.
    - Read-denial checks of the protected locations under the runtime rights, each with a positive control under the evaluator rights.
    - Canary scan of the Run artifacts, with a positive control.
    - _Requirements: 13.1, 13.2, 13.3, 13.8, 15.1, 15.4, 15.7, 15.8, 15.9, 18.16, 21.6, 23.3_
  - [ ] 5.14 Write the mutual exclusion tests (a) to (c) with the real named mutex
    - **Requires user confirmation before running** (it starts the existing conformance runner script, unmodified, which must exit with status 2 before any scenario). Real Windows named mutex `Local\ProjectPhoenixGroundTruthEvaluation`; no mock; no external AI service. These tests are required for MVP completion.
    - (a) While a Run holds the Run_Lock, the unmodified conformance runner exits with status 2 and runs no scenario. (b) While the conformance runner holds the mutex, the Launcher exits non-zero, reports `conformance_mutex`, creates no Run directory, and starts no container. (c) While one Run holds the Run_Lock, a second Launcher start exits non-zero, reports `run_lock`, creates no Run directory, and starts no container. Each case has a control: the lock is acquirable once its holder has ended.
    - _Requirements: 24.3, 24.4, 24.5, 24.8, 24.13, 24.14_
  - [ ] 5.15 Write the mutual exclusion tests (d) and (e) with the real named mutex
    - **Requires user confirmation before running.** Real named mutex; a harmless labeled stub container may stand in for the runtime where the full Run is not needed.
    - (d) After a normal end, an error end, and a killed Launcher process, the mutex and the Run lock can each be acquired by a new process within 10 seconds, the runtime container is not running, and the Run_Lease is rejected by the runtime. When the mutex is acquired in the abandoned state (a helper process that exits without releasing the real named mutex), the Launcher starts no Experiment and no runtime container, creates no Run_Volume, releases the mutex, reports `conformance_mutex_abandoned`, and exits non-zero; a following explicit start performs the leftover-container stop and the `interrupted` marking; and the unmodified conformance runner against an abandoned mutex runs no scenario (exit status 2 or an error exit). (e) In the normal-end and error-end cases the container-stop confirmation precedes the lock release; in the kill case no runtime container is running 10 seconds after the kill. Also: a subsequent Launcher start stops a leftover labeled container only after it holds both locks and before it creates a Run directory, and marks a Run directory without a manifest as `interrupted`.
    - _Requirements: 24.3, 24.6, 24.9, 24.10, 24.11, 24.12, 24.13, 24.14_
  - [ ] 5.16 Score the M4 Mock Run with the Independent_Evaluator
    - Run only after the Run has terminated and the Run_Manifest has been verified. The result is labeled as a Mock_Provider result and is not evidence of AI discovery capability.
    - _Requirements: 3.14, 13.4, 15.4, 21.15_
  - [ ] 5.17 Checkpoint - M5 acceptance and MVP completion
    - Acceptance condition (R21.6): the Independent_Evaluator refuses a Run with a mismatching hash, reports axis A and axis B as separate values, reports the Approved_Divergence list, reports uncovered scenario units as `uncovered` with reason codes and the evaluation limitations, produces byte-identical output for identical inputs, and the mutual exclusion tests (a) to (e) of R24.13 pass with the real mutex.
    - MVP completion (R21.18, R24.3): M0 to M5 are complete, including the mechanical mutual exclusion; the M4 Mock Run has been scored (R21.15). The MVP is not reported complete while any test of R24.13 fails or is missing.
    - Test policy: unit tests on saved Run artifacts, the isolation tests of R15.7 to R15.10, and the lock tests of R24.13.
    - Stop condition: any evaluator access to the Legacy_App, any Ground_Truth canary found in a Run artifact, or any failing or missing lock test blocks the approval requests for M6. Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 21.1, 21.6, 21.9, 21.15, 21.18, 24.3_

- [ ] 6. M6 Kiro CLI execution environment (GATED, outside the MVP)
  - [ ] 6.1 Gate: explicit human approval to start M6
    - **Do not start without explicit human approval for M6.** Requires explicit human approval before execution (Gate `m6-start`).
    - Present the proposed M6 action, the M5 milestone evidence, and the unresolved residual risks, then wait. An approval for M6 is not an approval for M7 or for any transmission.
    - _Requirements: 21.9, 21.10, 21.12_
  - [ ] 6.2 Review the Kiro CLI installer and documentation
    - **Requires explicit human approval before execution** of any installation. Fetched installer content is untrusted and is not executed until reviewed.
    - Review the installer and documented behavior (headless mode, tool-call events, MCP configuration, knowledge features), record what is documented and mark it locally unverified. Present the exact install command and target for approval; nothing is installed on the host.
    - _Requirements: 16.6, 20.10, 21.12, 21.14_
  - [ ] 6.3 Build the AI_Sandbox image with a pinned Kiro CLI
    - **Requires explicit human approval before execution** (installation inside the image; version recorded in the Version_Pinning_Record).
    - Non-root user, CPU and memory limits, no published port, no `.kiro` steering, spec, hook, or MCP configuration files in the image, and an empty HOME and working directory at call start.
    - _Requirements: 16.1, 16.3, 16.4, 16.11, 20.6, 20.10_
  - [ ] 6.4 Verify CLI flags and the zero-tools, zero-MCP, knowledge-disabled state on the real CLI
    - Environment checks only: no synthetic source is sent and no AI service call is made. Depend on no flag or setting that has not been verified on the real CLI; if tool-call events cannot be observed or classified, record that and treat calls as failed.
    - Record the observed state of each knowledge and code-intelligence feature.
    - _Requirements: 16.5, 16.6, 16.7, 16.8, 21.7_
  - [ ] 6.5 Implement the host-side sandbox controller
    - PowerShell controller under `discovery/tools/` that starts one AI_Sandbox per request with a fixed argument list, a per-call input directory (read-only) and an output directory, an empty HOME and working directory, only the required credential variables passed (the host reads `KIRO_API_KEY` and reports only set or unset; the runtime holds no credential, C7), the per-call time limit, and process-tree kill on timeout.
    - Mounts limited to the per-call input location and the sandbox's own directories; no repository, no Docker socket, no existing HOME, no Approval_Store.
    - _Requirements: 16.1, 16.2, 16.3, 16.9, 16.10, 19.8_
  - [ ] 6.6 Configure the egress allowlist and AI_Sandbox networks
    - **Requires explicit human approval before execution** (decision on the proxy product, OD-2, and any change under `infra/`). Present the diff first.
    - `ai-egress-inner` and `ai-egress-outer` with a destination-allowlist proxy; the AI_Sandbox joins neither `legacy-internal`, `legacy-api`, nor `discovery-lab`; destinations come from the documentation and stay unverified until measured.
    - _Requirements: 16.12, 18.7, 18.9, 18.17, 21.12_
  - [ ] 6.7 Produce the measured access-rights record
    - Record mounts, visible files, environment variable names, and network routes for TCP, UDP, ICMP, IPv6, and DNS separately, marking each path not measured as `not measured`, with positive controls so a denial caused by a wrong path or a missing target is not counted as a pass. No synthetic source is sent.
    - Check every criterion of R16 individually and record the result of each.
    - _Requirements: 16.2, 16.3, 16.4, 16.5, 16.11, 16.12, 16.15, 18.5, 18.6, 18.10, 21.7_
  - [ ] 6.8 Record the Kiro_CLI_Provider safety status
    - Status is `UNVERIFIED` unless a verification record produced on the real Kiro CLI shows zero tools and zero MCP servers available to the AI. Write the record; never promote the status without it. The Run_Manifest builder (4.6) reads this record.
    - _Requirements: 16.13, 16.14, 16.16, 21.7_
  - [ ] 6.9 Record the residual-risk register and its check
    - A machine-checked data file listing each residual risk of R18.4 (Reverse_Proxy outbound traffic, UDP, ICMP, IPv6, other hosts, symbolic-link checks, hard-link checks, internal-only isolation of `discovery-lab` until the M4 record) and the AI_Sandbox outbound access of R18.5, each with status `unresolved` or `measured`, plus a check that fails if a risk is marked `measured` without a measurement record stating routes and date.
    - Include the statement that an unmeasured path is not assumed blocked.
    - _Requirements: 18.4, 18.5, 18.6, 18.10, 18.11, 18.19_
  - [ ] 6.10 Checkpoint - M6 acceptance
    - Acceptance condition (R21.7): the measured access rights of the AI_Sandbox (mounts, visible files, environment variables, network routes) are recorded, the criteria of R16 are checked individually, and the safety status of the Kiro_CLI_Provider is recorded as `verified` or `UNVERIFIED`.
    - Test policy: environment checks that send no synthetic source and make no AI service call.
    - Stop condition: any measured violation of R16 (repository mount, Docker socket, existing HOME, `legacy-internal` or `legacy-api` membership, or a tool-call event) blocks M7. Ensure all checks pass, ask the user if questions arise.
    - _Requirements: 16.1, 21.1, 21.7, 21.9_

- [ ] 7. M7 Real AI connection and loop demonstration (GATED, outside the MVP)
  - [ ] 7.1 Gate: separate explicit human approval to start M7
    - **Do not start without explicit human approval for M7.** Requires explicit human approval before execution (Gate `m7-start`).
    - Present the proposed action, the M6 evidence, the safety status, and the unresolved residual risks, then wait. The M6 approval does not count.
    - _Requirements: 21.10, 21.12_
  - [ ] 7.2 Implement the Kiro_CLI_Provider in `packages/ai-client`
    - Invoke Kiro CLI only through the sandbox controller; fail the call and discard the response on any tool-call event or when tool-call presence cannot be determined; per-call time limit with process-tree kill and a recorded timeout; credentials from environment variables on the host side only; provider identity, version, and model recorded; selectable by the single configuration value.
    - Rely on only the CLI flags verified in 6.4.
    - _Requirements: 3.1, 3.7, 16.1, 16.6, 16.7, 16.8, 16.9, 16.10, 19.1, 19.8_
  - [ ] 7.3 Write Kiro_CLI_Provider unit tests with a fake process
    - A tool-call event fails the call and discards the response; an undeterminable output fails the call; a timeout kills the process tree and is recorded; an error or unparseable response is retried under a new Payload_Audit up to the retry limit; no credential value reaches a record.
    - These tests send nothing to a real service.
    - _Requirements: 3.8, 16.7, 16.8, 16.10, 19.2, 21.8_
  - [ ] 7.4 Obtain separate approval for external transmission
    - **Requires explicit human approval before execution** (Gate `transmit-source`). The approval must name the AI_Provider and the Source_Bundle manifest hashes it covers and is separate from the M7 start approval.
    - While the safety status is `UNVERIFIED` or the verification record is missing, transmission needs this approval for that Run. Stop and ask again if the manifest hashes change or the approval is withdrawn.
    - _Requirements: 16.16, 21.11, 21.12, 21.13_
  - [ ] 7.5 Run the single demonstration Run with the Kiro_CLI_Provider
    - **Requires the approvals of 7.1 and 7.4 and user confirmation before running.** Start through the Launcher; the conformance runner must be idle.
    - One Run within the limits of the configuration; the Payload_Audit passes before every transmission and the Ground_Truth access-denial verification passes before the Run; the Run_Manifest records the permitted AI_Sandbox destinations, the safety status, and the residual-risk statuses. A failed Payload_Audit, a tool-call event, a limit breach, or an unrecoverable error ends the Run and needs a new human approval before any retry.
    - _Requirements: 2.1, 2.16, 11.7, 16.13, 18.8, 21.8, 24.7_
  - [ ] 7.6 Score the demonstration Run with the Independent_Evaluator
    - Run the evaluator after the Run has terminated and the manifest has been verified. Report both axes, the Approved_Divergence list, and the `uncovered` units with their limitations without presenting a merged score on its own.
    - _Requirements: 13.4, 14.9, 15.4, 21.8_
  - [ ] 7.7 Write the completion record
    - State the Kiro_CLI_Provider safety status (`verified` or `UNVERIFIED`), the list of unresolved residual risks, and the Run_Manifest hash of the demonstration Run.
    - _Requirements: 18.11, 21.16_
  - [ ] 7.8 Re-run the Mock Run as the regression baseline
    - Repeat the M4 Mock Run configuration through the Launcher and confirm `identical` against the M4 result, so that M6 and M7 changes did not alter the deterministic path.
    - _Requirements: 21.8, 22.1, 22.7_
  - [ ] 7.9 Checkpoint - M7 acceptance
    - Acceptance condition (R21.8): one Run with the Kiro_CLI_Provider terminates with a recorded termination reason, passes the Payload_Audit before every transmission, and is scored by the Independent_Evaluator.
    - Test policy: a single demonstration Run within the limits of R11.7, with the Mock_Provider Run of M4 as the regression baseline.
    - Stop condition: a failed Payload_Audit, a tool-call event, a limit breach, or an unrecoverable error ends the Run and requires a new human approval before any retry. Ensure all tests pass, ask the user if questions arise.
    - _Requirements: 21.1, 21.8, 21.9, 21.16_

## Notes

- Tasks marked with `*` are optional and can be skipped for a faster MVP path. Only two property tests are optional (Property 25 in 1.8 and Property 4 in 2.6). All safety, isolation, lock, approval, integrity, and determinism tests are required.
- Property tests use Vitest and fast-check, at least 100 iterations each, with the comment tag `Feature: discovery-loop, Property N: <title>`. Properties 1 to 35 each have one task. The mutex, file-handle lock, container, mount, and network checks are integration tests, not property tests.
- Placement differs from the design table in two places. Properties 24 and 25 are in M1 next to the expression evaluator they test. Property 34 is in M2 next to the Experiment_Runner and its lease check. Properties 31 to 33 are in M1 with the Origin, Evidence, and Approval model.
- The Launcher (2.18) is written in M2 so the live integration test (2.20) runs under the Run_Lock. Its container start step is wired to the runtime image in 4.9, and its export procedure (2.21) and abandoned-mutex handling (2.22) are also in M2, and its lock tests are in M5 (5.14, 5.15).
- The override file is created in M0 (0.5), its application is approved in M0 (0.13), and it is applied in M2 (2.19) because the lab network is needed for the integration test. No infra edit happens without the specific approval, and `infra/docker-compose.yml` is never edited.
- Flagged for human decision: whether `discovery/approvals/` is committed (0.6, proposal: commit it; the decision stays with the human); how gate approvals before task 4.10 exists are recorded (proposal: in the conversation, later transcribed as Approval_Records stated explicitly by the human).
- Open decisions of the design are resolved at the tasks that name them (OD-2 in 6.6, OD-3 in 2.18 and 2.20, OD-4 in 3.7, OD-5 in 5.2, OD-6 in 0.9, OD-7 before 2.18). Version pinning (OD-1) is resolved in 0.9.
- The Discovery_Override isolation test is a separate mandatory script (4.15, 4.16, 4.17); the legacy-sample isolation test is run after the override is removed, never replaced. Run records go to a Run_Volume and are exported by the Launcher with a Completion_Marker (2.21).
- Tasks 0.3 to 0.7 are checked because their files exist. Every other M0 sub-task needs execution and a separate human approval, so it is unchecked.
- Checkpoint sub-tasks and top-level tasks are not part of the dependency graph.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["0.1"] },
    { "id": 1, "tasks": ["0.2"] },
    { "id": 2, "tasks": ["0.8", "0.12"] },
    { "id": 3, "tasks": ["0.9", "0.13"] },
    { "id": 4, "tasks": ["0.10"] },
    { "id": 5, "tasks": ["0.11"] },
    { "id": 6, "tasks": ["1.1"] },
    { "id": 7, "tasks": ["1.2", "1.4", "1.6"] },
    { "id": 8, "tasks": ["1.3", "1.5", "1.7", "1.8"] },
    { "id": 9, "tasks": ["1.9"] },
    { "id": 10, "tasks": ["1.10", "1.11", "1.12", "1.14"] },
    { "id": 11, "tasks": ["1.13", "1.15", "1.16"] },
    { "id": 12, "tasks": ["1.17", "1.18", "1.19", "1.20", "1.21", "1.22", "1.23", "1.24"] },
    { "id": 13, "tasks": ["1.26"] },
    { "id": 14, "tasks": ["1.27"] },
    { "id": 15, "tasks": ["2.1", "2.4", "2.8", "2.12"] },
    { "id": 16, "tasks": ["2.2", "2.3", "2.5", "2.6", "2.7", "2.9", "2.10", "2.11", "2.13", "2.14", "2.15"] },
    { "id": 17, "tasks": ["2.16", "2.17", "2.18"] },
    { "id": 18, "tasks": ["2.19", "2.21"] },
    { "id": 19, "tasks": ["2.22"] },
    { "id": 20, "tasks": ["2.20", "2.23"] },
    { "id": 21, "tasks": ["3.1"] },
    { "id": 22, "tasks": ["3.2", "3.4", "3.8"] },
    { "id": 23, "tasks": ["3.3", "3.5", "3.6", "3.7", "3.9", "3.10"] },
    { "id": 24, "tasks": ["3.11"] },
    { "id": 25, "tasks": ["4.1", "4.2", "4.10", "4.15"] },
    { "id": 26, "tasks": ["4.3"] },
    { "id": 27, "tasks": ["4.4"] },
    { "id": 28, "tasks": ["4.5", "4.6"] },
    { "id": 29, "tasks": ["4.7", "4.9"] },
    { "id": 30, "tasks": ["4.8", "4.11", "4.12", "4.13", "4.16"] },
    { "id": 31, "tasks": ["4.14"] },
    { "id": 32, "tasks": ["4.17", "4.18"] },
    { "id": 33, "tasks": ["5.1"] },
    { "id": 34, "tasks": ["5.2", "5.3"] },
    { "id": 35, "tasks": ["5.4", "5.5"] },
    { "id": 36, "tasks": ["5.6"] },
    { "id": 37, "tasks": ["5.7", "5.8", "5.9", "5.10", "5.11", "5.12", "5.13", "5.14", "5.15"] },
    { "id": 38, "tasks": ["5.16"] },
    { "id": 39, "tasks": ["6.1"] },
    { "id": 40, "tasks": ["6.2"] },
    { "id": 41, "tasks": ["6.3", "6.5", "6.9"] },
    { "id": 42, "tasks": ["6.4", "6.6"] },
    { "id": 43, "tasks": ["6.7"] },
    { "id": 44, "tasks": ["6.8"] },
    { "id": 45, "tasks": ["7.1"] },
    { "id": 46, "tasks": ["7.2"] },
    { "id": 47, "tasks": ["7.3", "7.8"] },
    { "id": 48, "tasks": ["7.4"] },
    { "id": 49, "tasks": ["7.5"] },
    { "id": 50, "tasks": ["7.6"] },
    { "id": 51, "tasks": ["7.7"] }
  ]
}
```
