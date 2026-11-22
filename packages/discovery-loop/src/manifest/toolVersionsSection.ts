// Run_Manifest `toolVersions` section builder (task 4.6, work unit W3-A).
//
// Pure: no I/O, no clock, no environment, and no acquisition. The Node.js version, the package manager version, the direct dependency
// versions and the runtime image identifier are EXPLICIT inputs (how they are obtained is task 4.6 W4 and later); this module checks the
// form only and records nothing that was not given. Every version is an exact version (no range, no tag such as `latest`). The runtime image
// identifier is the local image id that the Launcher reads (`sha256:` and 64 hex characters). Every error is a closed code (and a position
// for a dependency); no name and no value is echoed. The input is never changed and never aliased; the output lists dependencies sorted by name.
import type { Result } from "../schema/types.js";
import { dataValue, hasExactKeys, isPlainDataObject, sectionFail, type SectionError } from "./plainData.js";

const RUNTIME_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const EXACT_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
const PACKAGE_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const MAX_NAME_LENGTH = 214;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;

export interface ToolVersionsSection {
  readonly node: string;
  readonly npm: string;
  readonly dependencies: { readonly [name: string]: string };
  readonly runtimeImageDigest: string;
}

export type ToolVersionsSectionErrorCode =
  | "input_not_plain_object"
  | "input_keys"
  | "node_invalid"
  | "npm_invalid"
  | "dependencies_not_plain_object"
  | "dependencies_empty"
  | "dependency_name_invalid"
  | "dependency_version_invalid"
  | "image_digest_invalid";
export type ToolVersionsSectionError = SectionError<ToolVersionsSectionErrorCode>;

const fail = (code: ToolVersionsSectionErrorCode, index?: number): Result<never, ToolVersionsSectionError> => sectionFail(code, index);

/** Input: `{ node, npm, dependencies, runtimeImageDigest }`. `node` and `npm` are `major.minor.patch` without a leading `v`. */
export function buildToolVersionsSection(input: unknown): Result<ToolVersionsSection, ToolVersionsSectionError> {
  if (!isPlainDataObject(input)) return fail("input_not_plain_object");
  if (!hasExactKeys(input, ["node", "npm", "dependencies", "runtimeImageDigest"])) return fail("input_keys");

  const node = dataValue(input, "node").value;
  if (typeof node !== "string" || !RUNTIME_VERSION.test(node)) return fail("node_invalid");
  const npm = dataValue(input, "npm").value;
  if (typeof npm !== "string" || !RUNTIME_VERSION.test(npm)) return fail("npm_invalid");

  const deps = dataValue(input, "dependencies").value;
  if (!isPlainDataObject(deps)) return fail("dependencies_not_plain_object");
  const names = Object.keys(deps);
  if (names.length === 0) return fail("dependencies_empty");
  const picked: [string, string][] = [];
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i] as string;
    if (name.length > MAX_NAME_LENGTH || !PACKAGE_NAME.test(name)) return fail("dependency_name_invalid", i);
    const version = dataValue(deps, name).value;
    if (typeof version !== "string" || !EXACT_VERSION.test(version)) return fail("dependency_version_invalid", i);
    picked.push([name, version]);
  }
  picked.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const dependencies: { [name: string]: string } = {};
  for (const [name, version] of picked) dependencies[name] = version;

  const digest = dataValue(input, "runtimeImageDigest").value;
  if (typeof digest !== "string" || !IMAGE_ID.test(digest)) return fail("image_digest_invalid");
  return { ok: true, value: { node, npm, dependencies, runtimeImageDigest: digest } };
}