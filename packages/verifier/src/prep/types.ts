// Runner-owned preparation table (design: "Runner-owned preparation table", "Numbered line parameters and the single definition";
// R7.3, R9.10, R9.12; task 2.15). The table is the only definition of preparation kinds and their parameters.

export type PrepScalar = number | string | boolean;

/** A parameter rule: the closed vocabulary of the policy (type and range), plus the name the value has in the request body. */
export interface PrepParamRule {
  readonly type: "integer" | "string" | "boolean";
  readonly optional?: boolean;
  readonly min?: number;
  readonly max?: number;
  readonly maxLength?: number;
  readonly enum?: readonly string[];
  /** The field name in the request body that the table assembles. */
  readonly body: string;
}

/** A group of numbered scalar parameters `<field>_<n>`, n = 1 to k, that the table assembles into a list in the request body. */
export interface PrepNumbered {
  readonly name: string;
  /** The list field in the request body. */
  readonly bodyList: string;
  readonly fields: Readonly<Record<string, PrepParamRule>>;
  readonly min: number;
  readonly max: number;
}

export interface PrepOperation {
  readonly method: "GET" | "POST";
  /** A path template; the only placeholder is `{bound}`, the value captured by an earlier operation of the same kind. */
  readonly path: string;
  /** `assembled`: the body is built by `buildStepBody` from the step. */
  readonly body?: "assembled";
  readonly expect: number;
  readonly capture?: { readonly bindTo: "step.bind"; /** A dotted path in the JSON response. */ readonly fromResponse: string };
}

export interface PrepKind {
  readonly kind: string;
  readonly params: Readonly<Record<string, PrepParamRule>>;
  readonly numbered?: PrepNumbered;
  readonly translate: readonly PrepOperation[];
}

export interface PrepInternalOperation {
  readonly method: "GET" | "POST";
  readonly path: string;
}

export interface PrepTable {
  readonly schemaVersion: 1;
  readonly internalOperations: readonly PrepInternalOperation[];
  readonly steps: readonly PrepKind[];
}

/** A preparation step as the Experiment carries it (content is untrusted; `validatePreparationStep` checks it). */
export interface PrepStepInput {
  readonly kind: string;
  readonly bind?: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export interface ValidatedStep {
  readonly kind: PrepKind;
  readonly bind?: string;
  /** Fixed parameters by parameter name. */
  readonly fixed: Readonly<Record<string, PrepScalar>>;
  /** The numbered lines in numeric order, each by field name. */
  readonly lines: readonly Readonly<Record<string, PrepScalar>>[];
}

/** The largest number of numbered lines (design: a prepared state has at most 5 lines, OD-13). */
export const NUMBERED_LINES_MAX = 5;
/** The M1 limit of parameters of one preparation step. */
export const STEP_PARAMS_MAX = 16;