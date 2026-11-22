// Run_Manifest `envVarsRead` section (task 4.6, work unit W2).
//
// Pure: no I/O, no clock, no randomness, no environment access. It receives NAMES and set flags only (the flags of the configured
// `envNames` and the credential references of `checkProviderCredentials`), never a value, and returns the one list that the
// Run_Manifest records (R19.3): `{ name, set }` per variable, each name once.
//
// Rules (decisions of 2026-11, task 4.6 W2):
//   1. the same name with the same state, in or across the two lists, becomes ONE entry (the position of its first occurrence);
//   2. the same name with a different state is REFUSED (`state_conflict`): the two sources contradict each other and neither is trusted;
//   3. a credential is recorded as `set: true` only; an unset credential is refused (`credential_unset`), because a Run with an
//      unset credential cannot have been approved;
//   4. every input is validated (plain data objects with exactly `name` and `set`, a name of the environment-name grammar, a boolean);
//   5. an error carries a closed code, the list and the position, never a variable name or a value.
// The input is never mutated and never aliased: the result holds fresh objects.
import type { Result } from "../schema/types.js";

/** Same grammar as `ENV_NAME_PATTERN` of `config/limits.ts` and `ENV_NAME` of `config/startup.ts` (a test pins the equality). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export interface EnvSectionEntry {
  readonly name: string;
  readonly set: boolean;
}

export type EnvSectionList = "flags" | "credentials";

export type EnvSectionErrorCode =
  | "list_not_array"
  | "entry_not_plain_object"
  | "entry_keys"
  | "name_invalid"
  | "set_not_boolean"
  | "credential_unset"
  | "state_conflict";

/** `list` and `index` locate the entry; no name and no value is ever echoed. */
export interface EnvSectionError {
  readonly code: EnvSectionErrorCode;
  readonly list: EnvSectionList;
  readonly index?: number;
}

const fail = (code: EnvSectionErrorCode, list: EnvSectionList, index?: number): Result<never, EnvSectionError> =>
  index === undefined ? { ok: false, error: { code, list } } : { ok: false, error: { code, list, index } };

/** A plain object with only own enumerable string-keyed data properties (no accessor, no symbol key). */
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

const valueOf = (o: object, key: string): unknown => {
  const d = Object.getOwnPropertyDescriptor(o, key);
  return d !== undefined && "value" in d ? d.value : undefined;
};

/**
 * `flags`: the names of `envNames` with their set flag. `credentials`: the credential references (names with `set: true`).
 * The result lists the flags first, then the credentials whose name is not already listed.
 */
export function buildEnvSection(flags: unknown, credentials: unknown): Result<{ name: string; set: boolean }[], EnvSectionError> {
  const out: { name: string; set: boolean }[] = [];
  const state = new Map<string, boolean>();

  const lists: readonly { list: EnvSectionList; value: unknown }[] = [
    { list: "flags", value: flags },
    { list: "credentials", value: credentials },
  ];
  for (const { list, value } of lists) {
    if (!Array.isArray(value)) return fail("list_not_array", list);
    for (let i = 0; i < value.length; i += 1) {
      const slot = Object.getOwnPropertyDescriptor(value, String(i));
      if (slot === undefined || !("value" in slot)) return fail("entry_not_plain_object", list, i);
      const entry: unknown = slot.value;
      if (!isPlainDataObject(entry)) return fail("entry_not_plain_object", list, i);

      const keys = Object.keys(entry);
      if (keys.length !== 2 || !keys.includes("name") || !keys.includes("set")) return fail("entry_keys", list, i);

      const name = valueOf(entry, "name");
      if (typeof name !== "string" || !ENV_NAME.test(name)) return fail("name_invalid", list, i);
      const set = valueOf(entry, "set");
      if (typeof set !== "boolean") return fail("set_not_boolean", list, i);
      if (list === "credentials" && set !== true) return fail("credential_unset", list, i);

      const known = state.get(name);
      if (known === undefined) {
        state.set(name, set);
        out.push({ name, set });
      } else if (known !== set) {
        return fail("state_conflict", list, i);
      }
    }
  }
  return { ok: true, value: out };
}
