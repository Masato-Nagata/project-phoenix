// Re-validation of the Launcher attestation `/run/lease/isolation-attestation.json` (design item 6). Pure.
// Only what the existing attestation (`Get-MountInspection`) can show is accepted as evidence. The runtime does not trust `ok` alone.
// Task 4.2 does NOT claim that this attestation belongs to this container beyond the container name derived from `deps.runId`
// (residual risks `mount_inspection_run_binding_weak` and `mount_inspection_pre_start_snapshot`; the binding is checked in task 4.9).
import type { FailureCode } from "./types.js";

/** The complete mount table of the `run` profile (design, "Mounts (the complete list)"; M6 `/run/channel/` is not part of M4). */
export const EXPECTED_RUN_MOUNT_DESTINATIONS: readonly string[] = Object.freeze(
  [
    "/repo/docs/ai-input-allowlist.json",
    "/repo/docs/ai-input-allowlist.md",
    "/repo/legacy/sql/schema.sql",
    "/repo/legacy/sql/seed.sql",
    "/repo/legacy/src/db.php",
    "/repo/legacy/src/index.php",
    "/repo/legacy/src/orders.php",
    "/repo/legacy/src/products.php",
    "/repo/legacy/src/utils.php",
    "/run/config/audit-config.json",
    "/run/config/run-config.json",
    "/run/lease",
    "/run/out",
  ].sort(),
);
export const EXPECTED_NETWORKS: readonly string[] = Object.freeze(["phoenix-discovery-lab"]);
export const ATTESTATION_KEYS: readonly string[] = Object.freeze(["check", "container", "mounts", "networks", "ok", "problems", "profile"]);
export const RUN_ID_PATTERN = /^run-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{12}$/;

export const containerNameOf = (runId: string): string => `phoenix-discovery-${runId}`;

export type AttestationVerdict =
  | { readonly ok: true; readonly mountCount: number; readonly networkCount: number }
  | { readonly ok: false; readonly reasons: readonly FailureCode[] };

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");
const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

export function validateAttestation(json: unknown, runId: string): AttestationVerdict {
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { ok: false, reasons: ["attestation_invalid"] };
  const o = json as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.length !== ATTESTATION_KEYS.length || keys.some((k, i) => k !== ATTESTATION_KEYS[i])) return { ok: false, reasons: ["attestation_invalid"] };
  if (o["check"] !== "mount_inspection" || typeof o["container"] !== "string" || typeof o["profile"] !== "string" || typeof o["ok"] !== "boolean") {
    return { ok: false, reasons: ["attestation_invalid"] };
  }
  const mounts = o["mounts"];
  const networks = o["networks"];
  const problems = o["problems"];
  if (!isStringArray(mounts) || !isStringArray(networks) || !isStringArray(problems)) return { ok: false, reasons: ["attestation_invalid"] };
  const reasons: FailureCode[] = [];
  if (o["profile"] !== "run") reasons.push("profile_mismatch");
  if (o["ok"] !== true || problems.length > 0) reasons.push("launcher_not_ok");
  if (!sameSet(mounts, EXPECTED_RUN_MOUNT_DESTINATIONS) || new Set(mounts).size !== mounts.length) reasons.push("mounts_differ");
  if (!sameSet(networks, EXPECTED_NETWORKS) || new Set(networks).size !== networks.length) reasons.push("networks_differ");
  if (!RUN_ID_PATTERN.test(runId) || o["container"] !== containerNameOf(runId)) reasons.push("container_mismatch");
  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, mountCount: mounts.length, networkCount: networks.length };
}
