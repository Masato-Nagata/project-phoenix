// Test support for task 4.2 (design item 3, "Meaning of the Run-internal result"; tasks.md 4.11 (c)).
// `assertDenialWithControl(runtimeRun, evaluatorRun)` is a PURE helper: a runtime-rights denial counts as test evidence only if a control run
// with evaluator rights used the same `probeSetSha256`, probed the same locations and operations, and found EVERY probe `readable`.
// Without that control, "not found" or "denied" could come from a wrong path or a missing file.
// UNVERIFIED: this helper is exercised here with fakes only. The independent real-container verification (evaluator-rights container,
// real mounts) belongs to task 4.11 and has NOT been done. Synthetic data only; no access to evaluation/.
import { classifyOutcome } from "../../src/isolation/classify.js";
import type { ProbeOutcome } from "../../src/isolation/types.js";

export interface ProbeRecord {
  readonly locationId: string;
  readonly op: "stat" | "list" | "read";
  readonly outcome: ProbeOutcome;
}

export interface ProbeRunRecord {
  readonly probeSetSha256: string;
  readonly probes: readonly ProbeRecord[];
}

export interface DenialAssessment {
  /** True only if the control is valid and every runtime probe is `denied` or `absent`. */
  readonly counts: boolean;
  /** Probes with class `denied` (an `absent` probe is never counted as a denial). */
  readonly deniedCount: number;
  readonly reasons: readonly string[];
}

const keyOf = (p: ProbeRecord): string => `${p.locationId}\t${p.op}`;
const isRun = (r: unknown): r is ProbeRunRecord =>
  typeof r === "object" &&
  r !== null &&
  typeof (r as ProbeRunRecord).probeSetSha256 === "string" &&
  Array.isArray((r as ProbeRunRecord).probes) &&
  (r as ProbeRunRecord).probes.every((p) => typeof p === "object" && p !== null && typeof p.locationId === "string" && typeof p.op === "string");

export function assertDenialWithControl(runtimeRun: ProbeRunRecord, evaluatorRun: ProbeRunRecord): DenialAssessment {
  const reasons: string[] = [];
  if (!isRun(runtimeRun) || !isRun(evaluatorRun)) return { counts: false, deniedCount: 0, reasons: ["malformed_run"] };
  if (runtimeRun.probes.length === 0) reasons.push("runtime_run_empty");
  if (evaluatorRun.probes.length === 0) reasons.push("control_run_empty");
  if (runtimeRun.probeSetSha256 !== evaluatorRun.probeSetSha256) reasons.push("probe_set_differs");
  const controlKeys = new Set(evaluatorRun.probes.map(keyOf));
  if (!runtimeRun.probes.every((p) => controlKeys.has(keyOf(p)))) reasons.push("control_does_not_cover_probes");
  if (!evaluatorRun.probes.every((p) => classifyOutcome(p.outcome) === "readable")) reasons.push("control_not_readable");
  let deniedCount = 0;
  for (const p of runtimeRun.probes) {
    const cls = classifyOutcome(p.outcome);
    if (cls === "denied") deniedCount++;
    else if (cls !== "absent") reasons.push(`runtime_probe_${cls}`);
  }
  const unique = [...new Set(reasons)];
  return { counts: unique.length === 0, deniedCount: unique.length === 0 ? deniedCount : 0, reasons: unique };
}
