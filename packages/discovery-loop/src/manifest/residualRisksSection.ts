// Run_Manifest `residualRisks` section builder (task 4.6, work unit W3-A; design item 10).
//
// Pure and without input: the section is the six residual risks that the access-denial design names, then the seventh of R24.19, each
// `unresolved`, in a fixed order. No further identifier is added here (a new identifier needs a human decision), and none is ever recorded
// as `measured`. The seventh (human decision of 2026-11-27, task 4.7 step A3; R24.16, R24.19) states that the `Local\` mutex exclusion holds
// for one Windows logon session only; the exclusion across sessions is not measured and not claimed. The list is a local copy of
// `RESIDUAL_RISK_IDS` of the isolation module (this module may not import it); a test pins the equality.
export const RESIDUAL_RISK_ID_LIST: readonly string[] = Object.freeze([
  "read_denial_positive_control_unverified",
  "mount_inspection_source_kind_unmeasured",
  "mount_inspection_run_binding_weak",
  "mount_inspection_pre_start_snapshot",
  "import_analysis_self_attestation",
  "env_values_not_inspected",
  "mutual_exclusion_single_session_scope",
]);

export interface ResidualRiskEntry {
  readonly id: string;
  readonly status: "unresolved";
}

/** A fresh array of fresh entries on every call. */
export function buildResidualRisks(): ResidualRiskEntry[] {
  return RESIDUAL_RISK_ID_LIST.map((id) => ({ id, status: "unresolved" as const }));
}