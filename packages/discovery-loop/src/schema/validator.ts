// Validator wrapper: strict parse stage, then Ajv (JSON Schema 2020-12) with defined-fields-only.
// Schemas are compiled once. Compilation uses strict mode, so an unknown keyword in a schema fails at start.
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { SCHEMAS } from "./schemas.js";
import { strictParse } from "./strictParse.js";
import {
  DEFAULT_PARSE_LIMITS,
  SCHEMA_NAMES,
  type Issue,
  type IssueCode,
  type Json,
  type ParseLimits,
  type Result,
  type SchemaName,
} from "./types.js";

// ajv-formats is CommonJS; under NodeNext its callable is the `default` property of the namespace.
type AddFormats = (ajv: Ajv2020) => Ajv2020;
const addFormats: AddFormats =
  (addFormatsModule as unknown as { default?: AddFormats }).default ?? (addFormatsModule as unknown as AddFormats);

function pointerToken(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

function toIssue(e: ErrorObject): Issue {
  const params = e.params as Record<string, unknown>;
  let code: IssueCode;
  let path = e.instancePath;
  switch (e.keyword) {
    case "additionalProperties":
      code = "undefined_field";
      path = `${path}/${pointerToken(String(params["additionalProperty"]))}`;
      break;
    case "required":
      code = "missing_field";
      path = `${path}/${pointerToken(String(params["missingProperty"]))}`;
      break;
    case "type":
      code = "bad_type";
      break;
    case "enum":
    case "const":
    case "pattern":
    case "format":
    case "minimum":
    case "maximum":
    case "minLength":
    case "maxLength":
    case "minItems":
    case "maxItems":
    case "maxProperties":
      code = "bad_value";
      break;
    default:
      code = "schema_violation";
  }
  return { code, path, message: e.message ?? e.keyword, keyword: e.keyword };
}

/** Sorts issues so output does not depend on Ajv's traversal order. */
function sortIssues(issues: Issue[]): Issue[] {
  return issues.sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
}

export interface SchemaValidator {
  /** Validates an already parsed value. Pure: no I/O, no mutation of the value. */
  validate(name: SchemaName, value: unknown): Result<Json, Issue[]>;
  /** Strict parse (size, UTF-8, depth, duplicate keys) and then validate. A parse failure is a single issue. */
  parseAndValidate(name: SchemaName, input: string | Uint8Array, limits?: ParseLimits): Result<Json, Issue[]>;
}

/** Builds the validator. Throws only if a schema in this package is itself invalid (a programming error). */
export function createSchemaValidator(): SchemaValidator {
  const ajv = new Ajv2020({
    strict: true,
    // The if/then forms (kind-specific required fields) name properties that the parent schema defines.
    strictRequired: false,
    allErrors: true,
    allowUnionTypes: true,
    discriminator: true,
    useDefaults: false,
    coerceTypes: false,
    removeAdditional: false,
  });
  addFormats(ajv);
  for (const name of SCHEMA_NAMES) ajv.addSchema(SCHEMAS[name]);
  const compiled = new Map<SchemaName, ValidateFunction>();
  for (const name of SCHEMA_NAMES) {
    const id = SCHEMAS[name]["$id"] as string;
    const fn = ajv.getSchema(id);
    if (fn === undefined) throw new Error(`schema ${id} did not compile`);
    compiled.set(name, fn);
  }

  const validate: SchemaValidator["validate"] = (name, value) => {
    const fn = compiled.get(name);
    if (fn === undefined) throw new Error(`unknown schema ${name}`);
    if (fn(value)) return { ok: true, value: value as Json };
    return { ok: false, error: sortIssues((fn.errors ?? []).map(toIssue)) };
  };

  return {
    validate,
    parseAndValidate(name, input, limits = DEFAULT_PARSE_LIMITS) {
      const parsed = strictParse(input, limits);
      if (!parsed.ok) return { ok: false, error: [parsed.error] };
      return validate(name, parsed.value);
    },
  };
}
