// Run_Manifest runtime version facts, task 4.6 work unit W4-B: the Node.js version, the npm version and the direct dependency versions
// of the runtime, as they are INSTALLED. The result has the shape that `buildToolVersionsSection` (W3-A) takes, without the image id
// (`runtimeImageDigest` is read by the Launcher and is not a fact of this unit).
//
// Where each value comes from (nothing is guessed, nothing is filled in, nothing is a fixed value):
//   - node: the own data property `node` of `process.versions` (a getter is never run). It must be `major.minor.patch`.
//   - npm: the `version` of the `package.json` of the INSTALLED npm package, read through the port. The text must name the package `npm`.
//     No `npm` command is started and no `packageManager` field is read: that field is a declaration, not a measurement. If the port
//     cannot read the file (npm absent, unreadable), there is no npm fact and the whole collection is refused.
//   - direct dependencies: the names and the declared versions come from `dependencies` of the declared `package.json` (the package that
//     is run); the versions are the `version` of `<installed>/<name>/package.json`, read through the port, one read per declared name.
//     The declared version must be an exact version (requirement 20.7: no range), so the comparison is string equality and needs no semver
//     library. A range, a tag or a protocol in a declaration is refused, never interpreted.
//   - not covered: workspace packages of the scope `@phoenix/` (neither read nor listed; they are refused if they appear in a list that
//     is handed to the pure check), transitive dependencies, development dependencies (they are pruned from the runtime image), and the
//     image id.
//
// What this module does NOT claim: a file that was read is the content of the installed package as the file system shows it. This unit
// does not check an integrity string and does not prove that the code that runs is the code of that file. The facts are observations of
// installed metadata, not business-specification correctness.
//
// Rules: every error is a closed code (and a list position where one applies); no name, no version, no path and no file text is ever part
// of an error. An input is never changed, an accessor of an input is never run, a read that fails is refused (fail closed), and there is
// no retry. The port has read operations only; this unit never builds a path (the adapter does, from the validated package name).
import { strictParse } from "../schema/strictParse.js";
import type { Result } from "../schema/types.js";

// ---------------------------------------------------------------------------------------------
// Local helpers (the module boundary of W3-A and W4-A is kept: nothing is imported from `manifest/`).
// ---------------------------------------------------------------------------------------------
/** A closed code and, for a list position, an index. No input value is ever echoed. */
interface SectionError<C extends string> {
  readonly code: C;
  readonly index?: number;
}
const sectionFail = <C extends string>(code: C, index?: number): Result<never, SectionError<C>> =>
  index === undefined ? { ok: false, error: { code } } : { ok: false, error: { code, index } };

/** A plain object with only own enumerable string-keyed data properties (no accessor, no symbol key, Object.prototype or null prototype). */
function isPlainDataObject(v: unknown): v is object {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return false;
  for (const key of Reflect.ownKeys(v)) {
    if (typeof key !== "string") return false;
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (d === undefined || !("value" in d) || d.enumerable !== true) return false;
  }
  return true;
}

/** Own data property value, or `{ present: false }` when absent or an accessor. A getter is never run. */
function dataValue(o: object, key: string): { present: boolean; value?: unknown } {
  const d = Object.getOwnPropertyDescriptor(o, key);
  if (d === undefined || !("value" in d)) return { present: false };
  return { present: true, value: d.value };
}

/** True when the own enumerable keys are exactly `keys` (any order, no extra, none missing). */
function hasExactKeys(o: object, keys: readonly string[]): boolean {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => own.includes(k));
}

/** The elements of a real array with data elements only (no hole, no accessor, no extra own property), or `undefined`. */
function dataElements(v: unknown, maxLength: number): unknown[] | undefined {
  if (!Array.isArray(v) || Object.getPrototypeOf(v) !== Array.prototype || v.length > maxLength) return undefined;
  if (Reflect.ownKeys(v).length !== v.length + 1) return undefined;
  const out: unknown[] = [];
  for (let i = 0; i < v.length; i += 1) {
    const d = Object.getOwnPropertyDescriptor(v, String(i));
    if (d === undefined || !("value" in d) || d.enumerable !== true) return undefined;
    out.push(d.value);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Grammars and bounds. The version grammars are the ones of `buildToolVersionsSection` (W3-A); a test pins that they agree.
// ---------------------------------------------------------------------------------------------
const RUNTIME_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const EXACT_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_NAME_LENGTH = 214;
/** Scope of the workspace packages of this repository. They are not direct third-party dependencies and are never read or listed. */
export const WORKSPACE_SCOPE_PREFIX = "@phoenix/";
/** Size bound of one `package.json` text. */
export const PACKAGE_JSON_MAX_BYTES = 65536;
const PACKAGE_JSON_MAX_DEPTH = 16;
/** At most this many direct dependencies are handled (a bound for the loop, not a policy). */
export const MAX_DIRECT_DEPENDENCIES = 256;
/** Dependency sections other than `dependencies` that would make a direct dependency invisible to this unit. */
const UNSUPPORTED_SECTIONS: readonly string[] = ["optionalDependencies", "peerDependencies", "bundleDependencies", "bundledDependencies"];

const isInternalName = (name: string): boolean => name.startsWith(WORKSPACE_SCOPE_PREFIX);
const validName = (v: unknown): v is string => typeof v === "string" && v.length <= MAX_NAME_LENGTH && PACKAGE_NAME.test(v);

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------
/** A package name with a version (declared or installed, by the list it is in). */
export interface DependencyEntry {
  readonly name: string;
  readonly version: string;
}

/** The facts of one collection. Frozen. `dependencies` lists the INSTALLED versions, sorted by name. */
export interface RuntimeVersionFacts {
  readonly node: string;
  readonly npm: string;
  readonly dependencies: { readonly [name: string]: string };
}

export type RuntimeVersionFactsErrorCode =
  // node
  | "node_invalid"
  | "node_read_failed"
  // npm
  | "npm_read_absent"
  | "npm_read_failed"
  | "npm_read_answer_invalid"
  | "npm_json_invalid"
  | "npm_json_not_object"
  | "npm_name_mismatch"
  | "npm_version_invalid"
  // declared package.json
  | "declared_read_absent"
  | "declared_read_failed"
  | "declared_read_answer_invalid"
  | "declared_json_invalid"
  | "declared_json_not_object"
  | "declared_section_unsupported"
  | "declared_dependencies_invalid"
  | "declared_name_invalid"
  | "declared_version_not_exact"
  // installed package.json
  | "installed_read_absent"
  | "installed_read_failed"
  | "installed_read_answer_invalid"
  | "installed_json_invalid"
  | "installed_json_not_object"
  | "installed_name_mismatch"
  | "installed_version_invalid"
  // pure check of the two lists
  | "list_invalid"
  | "entry_invalid"
  | "internal_dependency_listed"
  | "declared_duplicate"
  | "declared_conflict"
  | "installed_duplicate"
  | "installed_conflict"
  | "no_direct_dependencies"
  | "installed_undeclared"
  | "installed_missing"
  | "version_mismatch"
  | "too_many_dependencies";
export type RuntimeVersionFactsError = SectionError<RuntimeVersionFactsErrorCode>;

const fail = (code: RuntimeVersionFactsErrorCode, index?: number): Result<never, RuntimeVersionFactsError> => sectionFail(code, index);

// ---------------------------------------------------------------------------------------------
// The read port
// ---------------------------------------------------------------------------------------------
/** `absent`: the file does not exist. `error`: anything else (unreadable, not a regular file, too large). */
export type PackageJsonReadAnswer = { readonly kind: "ok"; readonly text: string } | { readonly kind: "absent" } | { readonly kind: "error" };

/**
 * The read operations of this unit. There is no write, no list, no command and no other file.
 *   - `readNodeVersion`: the value of `process.versions.node` (see `processNodeVersion`).
 *   - `readNpmPackageJson`: the `package.json` of the installed npm package.
 *   - `readDeclaredPackageJson`: the `package.json` of the package that is run (its `dependencies` are the declaration).
 *   - `readInstalledPackageJson(name)`: the `package.json` of the installed package `name`. `name` is a validated package name of the
 *     grammar `PACKAGE_NAME`, never in the scope `@phoenix/`; the adapter builds its own fixed-root path from it.
 */
export interface RuntimeVersionReadPort {
  readNodeVersion(): unknown;
  readNpmPackageJson(): PackageJsonReadAnswer;
  readDeclaredPackageJson(): PackageJsonReadAnswer;
  readInstalledPackageJson(name: string): PackageJsonReadAnswer;
}

/**
 * The own data property `node` of the object given, `undefined` when it is absent, an accessor, or the argument is not an object. Never runs a
 * getter. The argument is required: the caller passes `process.versions` explicitly, and `undefined` never falls back to the real environment.
 */
export function processNodeVersion(versions: unknown): unknown {
  if (typeof versions !== "object" || versions === null) return undefined;
  return dataValue(versions, "node").value;
}

// ---------------------------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------------------------
/** Pure. `major.minor.patch` and nothing else (no leading `v`, no pre-release, no blank, no non-string). */
export function parseNodeVersion(value: unknown): Result<string, RuntimeVersionFactsError> {
  return typeof value === "string" && RUNTIME_VERSION.test(value) ? { ok: true, value } : fail("node_invalid");
}

function parseJsonObject(text: string, invalid: RuntimeVersionFactsErrorCode, notObject: RuntimeVersionFactsErrorCode): Result<object, RuntimeVersionFactsError> {
  const parsed = strictParse(text, { maxBytes: PACKAGE_JSON_MAX_BYTES, maxDepth: PACKAGE_JSON_MAX_DEPTH });
  if (!parsed.ok) return fail(invalid);
  return isPlainDataObject(parsed.value) ? { ok: true, value: parsed.value } : fail(notObject);
}

/** Pure. The text of the installed npm `package.json`: it must name the package `npm` and carry a `major.minor.patch` version. */
export function parseNpmPackageJson(text: unknown): Result<string, RuntimeVersionFactsError> {
  if (typeof text !== "string") return fail("npm_json_invalid");
  const root = parseJsonObject(text, "npm_json_invalid", "npm_json_not_object");
  if (!root.ok) return root;
  if (dataValue(root.value, "name").value !== "npm") return fail("npm_name_mismatch");
  const version = dataValue(root.value, "version").value;
  return typeof version === "string" && RUNTIME_VERSION.test(version) ? { ok: true, value: version } : fail("npm_version_invalid");
}

/**
 * Pure. The text of the declared `package.json`: the entries of `dependencies` as `{ name, version }` (the DECLARED version), in file
 * order, without the workspace scope. Refused: a text that is not strict JSON (a duplicate key included), a missing or non-object
 * `dependencies`, an optional, peer or bundled section, a name outside the package name grammar, and a version that is not an exact
 * version (a range, a tag, a protocol, an empty text).
 */
export function parseDeclaredDependencies(text: unknown): Result<readonly DependencyEntry[], RuntimeVersionFactsError> {
  if (typeof text !== "string") return fail("declared_json_invalid");
  const root = parseJsonObject(text, "declared_json_invalid", "declared_json_not_object");
  if (!root.ok) return root;
  for (const key of UNSUPPORTED_SECTIONS) if (Object.keys(root.value).includes(key)) return fail("declared_section_unsupported");
  const deps = dataValue(root.value, "dependencies").value;
  if (!isPlainDataObject(deps)) return fail("declared_dependencies_invalid");
  const names = Object.keys(deps);
  if (names.length > MAX_DIRECT_DEPENDENCIES) return fail("too_many_dependencies");
  const out: DependencyEntry[] = [];
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i] as string;
    if (!validName(name)) return fail("declared_name_invalid", i);
    if (isInternalName(name)) continue;
    const version = dataValue(deps, name).value;
    if (typeof version !== "string" || !EXACT_VERSION.test(version)) return fail("declared_version_not_exact", i);
    out.push(Object.freeze({ name, version }));
  }
  return { ok: true, value: Object.freeze(out) };
}

/** Pure. The text of an installed `package.json`: it must name the package that was asked for and carry an exact version. */
export function parseInstalledPackageJson(text: unknown, expectedName: string, index?: number): Result<DependencyEntry, RuntimeVersionFactsError> {
  if (typeof text !== "string") return fail("installed_json_invalid", index);
  const root = parseJsonObject(text, "installed_json_invalid", "installed_json_not_object");
  if (!root.ok) return index === undefined ? root : fail(root.error.code, index);
  if (dataValue(root.value, "name").value !== expectedName) return fail("installed_name_mismatch", index);
  const version = dataValue(root.value, "version").value;
  if (typeof version !== "string" || !EXACT_VERSION.test(version)) return fail("installed_version_invalid", index);
  return { ok: true, value: Object.freeze({ name: expectedName, version }) };
}

// ---------------------------------------------------------------------------------------------
// Pure check of the declared list against the installed list
// ---------------------------------------------------------------------------------------------
function checkList(v: unknown): Result<readonly DependencyEntry[], RuntimeVersionFactsError> {
  const items = dataElements(v, MAX_DIRECT_DEPENDENCIES);
  if (items === undefined) return fail(Array.isArray(v) && v.length > MAX_DIRECT_DEPENDENCIES ? "too_many_dependencies" : "list_invalid");
  const out: DependencyEntry[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (!isPlainDataObject(item) || !hasExactKeys(item, ["name", "version"])) return fail("entry_invalid", i);
    const name = dataValue(item, "name").value;
    const version = dataValue(item, "version").value;
    if (!validName(name) || typeof version !== "string" || !EXACT_VERSION.test(version)) return fail("entry_invalid", i);
    if (isInternalName(name)) return fail("internal_dependency_listed", i);
    out.push({ name, version });
  }
  return { ok: true, value: out };
}

function indexByName(list: readonly DependencyEntry[], duplicate: RuntimeVersionFactsErrorCode, conflict: RuntimeVersionFactsErrorCode): Result<Map<string, string>, RuntimeVersionFactsError> {
  const byName = new Map<string, string>();
  for (let i = 0; i < list.length; i += 1) {
    const e = list[i] as DependencyEntry;
    const seen = byName.get(e.name);
    if (seen !== undefined) return fail(seen === e.version ? duplicate : conflict, i);
    byName.set(e.name, e.version);
  }
  return { ok: true, value: byName };
}

/**
 * Pure. `declared` and `installed` are lists of `{ name, version }`. Every declared name must be installed at exactly the declared
 * version, no installed name may be undeclared, and neither list may repeat a name (the same version twice is a duplicate, two versions
 * are a conflict). The result lists the INSTALLED versions sorted by name. The inputs are not changed.
 */
export function verifyDirectDependencies(declared: unknown, installed: unknown): Result<{ readonly [name: string]: string }, RuntimeVersionFactsError> {
  const d = checkList(declared);
  if (!d.ok) return d;
  const i = checkList(installed);
  if (!i.ok) return i;
  const declaredByName = indexByName(d.value, "declared_duplicate", "declared_conflict");
  if (!declaredByName.ok) return declaredByName;
  const installedByName = indexByName(i.value, "installed_duplicate", "installed_conflict");
  if (!installedByName.ok) return installedByName;
  if (declaredByName.value.size === 0) return fail("no_direct_dependencies");

  for (let k = 0; k < i.value.length; k += 1) {
    if (!declaredByName.value.has((i.value[k] as DependencyEntry).name)) return fail("installed_undeclared", k);
  }
  for (let k = 0; k < d.value.length; k += 1) {
    const entry = d.value[k] as DependencyEntry;
    const have = installedByName.value.get(entry.name);
    if (have === undefined) return fail("installed_missing", k);
    if (have !== entry.version) return fail("version_mismatch", k);
  }
  const names = [...installedByName.value.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const dependencies: { [name: string]: string } = {};
  for (const name of names) dependencies[name] = installedByName.value.get(name) as string;
  return { ok: true, value: Object.freeze(dependencies) };
}

// ---------------------------------------------------------------------------------------------
// Collection through the port
// ---------------------------------------------------------------------------------------------
interface ReadCodes {
  readonly absent: RuntimeVersionFactsErrorCode;
  readonly failed: RuntimeVersionFactsErrorCode;
  readonly invalid: RuntimeVersionFactsErrorCode;
}

/** One read. An exception, a shape that is not one of the three answers, and a non-string text are refused. */
function readOnce(call: () => unknown, codes: ReadCodes, index?: number): Result<string, RuntimeVersionFactsError> {
  let answer: unknown;
  try {
    answer = call();
  } catch {
    return fail(codes.failed, index);
  }
  if (!isPlainDataObject(answer)) return fail(codes.invalid, index);
  const kind = dataValue(answer, "kind").value;
  if (kind === "absent" && hasExactKeys(answer, ["kind"])) return fail(codes.absent, index);
  if (kind === "error" && hasExactKeys(answer, ["kind"])) return fail(codes.failed, index);
  if (kind === "ok" && hasExactKeys(answer, ["kind", "text"])) {
    const text = dataValue(answer, "text").value;
    return typeof text === "string" ? { ok: true, value: text } : fail(codes.invalid, index);
  }
  return fail(codes.invalid, index);
}

/**
 * Reads the Node.js version, the npm package file, the declared package file, and one installed package file per declared direct
 * dependency, then checks them. One read per file, no retry. Any failure refuses the whole collection; nothing partial is returned.
 */
export function collectRuntimeVersionFacts(port: RuntimeVersionReadPort): Result<RuntimeVersionFacts, RuntimeVersionFactsError> {
  let rawNode: unknown;
  try {
    rawNode = port.readNodeVersion();
  } catch {
    return fail("node_read_failed");
  }
  const node = parseNodeVersion(rawNode);
  if (!node.ok) return node;

  const npmText = readOnce(() => port.readNpmPackageJson(), { absent: "npm_read_absent", failed: "npm_read_failed", invalid: "npm_read_answer_invalid" });
  if (!npmText.ok) return npmText;
  const npm = parseNpmPackageJson(npmText.value);
  if (!npm.ok) return npm;

  const declaredText = readOnce(() => port.readDeclaredPackageJson(), { absent: "declared_read_absent", failed: "declared_read_failed", invalid: "declared_read_answer_invalid" });
  if (!declaredText.ok) return declaredText;
  const declared = parseDeclaredDependencies(declaredText.value);
  if (!declared.ok) return declared;
  if (declared.value.length === 0) return fail("no_direct_dependencies");

  const installed: DependencyEntry[] = [];
  for (let i = 0; i < declared.value.length; i += 1) {
    const name = (declared.value[i] as DependencyEntry).name;
    const text = readOnce(() => port.readInstalledPackageJson(name), { absent: "installed_read_absent", failed: "installed_read_failed", invalid: "installed_read_answer_invalid" }, i);
    if (!text.ok) return text;
    const entry = parseInstalledPackageJson(text.value, name, i);
    if (!entry.ok) return entry;
    installed.push(entry.value);
  }

  const dependencies = verifyDirectDependencies(declared.value, installed);
  if (!dependencies.ok) return dependencies;
  return { ok: true, value: Object.freeze({ node: node.value, npm: npm.value, dependencies: dependencies.value }) };
}
