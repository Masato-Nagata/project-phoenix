// Version-pinning check (M1 task 1.2; R20.7, R20.8, R20.9, R20.13).
// Tooling module: NOT exported from src/index.ts and not part of the runtime entry point.
// Pure logic only; file reading lives in loadManifests / loadRecord below and in checkPins.ts.

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export type FindingKind =
  | "mismatch"
  | "range_operator"
  | "latest"
  | "missing_entry"
  | "not_verified"
  | "workspace_mismatch";

export interface PinFinding {
  readonly kind: FindingKind;
  readonly manifest: string;
  readonly name: string;
  /** Version declared in the manifest. */
  readonly manifestVersion: string;
  /** Version in the Version_Pinning_Record, when an entry exists. */
  readonly recordVersion?: string;
  /** Version of the workspace package of this repository, for a `workspace_mismatch`. */
  readonly workspaceVersion?: string;
  /** Verification status of the record entry, when relevant. */
  readonly status?: string;
  readonly message: string;
}

export interface ManifestInput {
  /** Display path, e.g. "package.json" or "packages/discovery-loop/package.json". */
  readonly path: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly devDependencies?: Readonly<Record<string, string>>;
}

export interface PinRecordEntry {
  readonly name: string;
  readonly version: string;
  readonly verification?: { readonly status?: string };
}

export interface PinRecord {
  readonly dependencies: readonly PinRecordEntry[];
}

export interface PinCheckResult {
  readonly ok: boolean;
  readonly checked: number;
  readonly findings: readonly PinFinding[];
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * `workspaces` maps the name of each REAL workspace package of this repository (see `loadWorkspaces`) to its own exact version. A dependency
 * with such a name is not a third-party package: it needs no entry in the record, but its declared version must be an exact version (checked
 * first, like every other declaration) and must equal the version of the workspace package. A name that is not in the map, including an
 * `@phoenix/*` name of a package that does not exist, gets the ordinary third-party check and is reported as `missing_entry`.
 */
export function checkVersionPins(
  manifests: readonly ManifestInput[],
  record: PinRecord,
  workspaces: ReadonlyMap<string, string> = new Map(),
): PinCheckResult {
  const entries = new Map<string, PinRecordEntry>();
  for (const e of record.dependencies) entries.set(e.name, e);

  const findings: PinFinding[] = [];
  let checked = 0;

  for (const m of manifests) {
    const sections = [m.dependencies ?? {}, m.devDependencies ?? {}];
    for (const section of sections) {
      for (const [name, declared] of Object.entries(section)) {
        checked += 1;
        const base = { manifest: m.path, name, manifestVersion: declared };

        if (declared.trim().toLowerCase() === "latest") {
          findings.push({
            ...base,
            kind: "latest",
            message: `${m.path}: ${name} uses "latest"; an exact version is required`,
          });
          continue;
        }
        if (!EXACT_VERSION.test(declared)) {
          findings.push({
            ...base,
            kind: "range_operator",
            message: `${m.path}: ${name} version "${declared}" is not an exact version (range operator or tag)`,
          });
          continue;
        }

        const workspaceVersion = workspaces.get(name);
        if (workspaceVersion !== undefined) {
          if (workspaceVersion !== declared) {
            findings.push({
              ...base,
              kind: "workspace_mismatch",
              workspaceVersion,
              message: `${m.path}: workspace package ${name} is declared as ${declared} but the workspace has ${workspaceVersion}`,
            });
          }
          continue;
        }

        const entry = entries.get(name);
        if (entry === undefined) {
          findings.push({
            ...base,
            kind: "missing_entry",
            message: `${m.path}: ${name} ${declared} has no entry in docs/version-pinning.json`,
          });
          continue;
        }

        if (entry.version !== declared) {
          findings.push({
            ...base,
            kind: "mismatch",
            recordVersion: entry.version,
            message: `${m.path}: ${name} manifest version ${declared} differs from record version ${entry.version}`,
          });
        }

        const status = entry.verification?.status;
        if (status !== "verified") {
          findings.push({
            ...base,
            kind: "not_verified",
            recordVersion: entry.version,
            status: status ?? "none",
            message: `${m.path}: ${name} ${declared} is not verified in the record (status: ${status ?? "none"})`,
          });
        }
      }
    }
  }

  return { ok: findings.length === 0, checked, findings };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function toManifest(path: string, raw: unknown): ManifestInput {
  const obj = (raw ?? {}) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return {
    path,
    ...(obj.dependencies !== undefined ? { dependencies: obj.dependencies } : {}),
    ...(obj.devDependencies !== undefined ? { devDependencies: obj.devDependencies } : {}),
  };
}

/** Reads the root package.json and every packages/<name>/package.json under repoRoot. */
export function loadManifests(repoRoot: string): ManifestInput[] {
  const result = [toManifest("package.json", readJson(join(repoRoot, "package.json")))];
  const packagesDir = join(repoRoot, "packages");
  if (existsSync(packagesDir)) {
    const names = readdirSync(packagesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const name of names) {
      const file = join(packagesDir, name, "package.json");
      if (existsSync(file)) result.push(toManifest(`packages/${name}/package.json`, readJson(file)));
    }
  }
  return result;
}

export function loadRecord(repoRoot: string): PinRecord {
  return readJson(join(repoRoot, "docs", "version-pinning.json")) as PinRecord;
}

/**
 * The real workspace packages: `packages/<dir>/package.json` of a repository whose root manifest lists the workspace pattern `packages/*`.
 * A package counts only with a string name and an exact version. A name that two directories claim is ambiguous and is not included.
 */
export function loadWorkspaces(repoRoot: string): Map<string, string> {
  const out = new Map<string, string>();
  const root = readJson(join(repoRoot, "package.json")) as { workspaces?: unknown };
  if (!Array.isArray(root.workspaces) || !root.workspaces.includes("packages/*")) return out;
  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return out;
  const ambiguous = new Set<string>();
  const names = readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  for (const dir of names) {
    const file = join(packagesDir, dir, "package.json");
    if (!existsSync(file)) continue;
    const pkg = readJson(file) as { name?: unknown; version?: unknown };
    if (typeof pkg.name !== "string" || pkg.name === "" || typeof pkg.version !== "string" || !EXACT_VERSION.test(pkg.version)) continue;
    if (out.has(pkg.name)) ambiguous.add(pkg.name);
    else out.set(pkg.name, pkg.version);
  }
  for (const name of ambiguous) out.delete(name);
  return out;
}

export function checkRepository(repoRoot: string): PinCheckResult {
  return checkVersionPins(loadManifests(repoRoot), loadRecord(repoRoot), loadWorkspaces(repoRoot));
}
