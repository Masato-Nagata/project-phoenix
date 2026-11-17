// The fixed probe locations of `read_denial`, as data (design item 1), with `probeSetSha256`.
// These paths are the ONLY place of the runtime source that names evaluation locations; a string-literal scan of the sources (task 4.11)
// must list this file in its approved exception list. The run time does not scan string literals (item 7).
import { createHash } from "node:crypto";

export type ProbeOp = "stat" | "list" | "read";
export const PROBE_OPS: readonly ProbeOp[] = Object.freeze(["stat", "list", "read"] as const);

export interface ProbeLocation {
  readonly id: string;
  readonly path: string;
}

export const PROBE_LOCATIONS: readonly ProbeLocation[] = Object.freeze([
  Object.freeze({ id: "repo_evaluation", path: "/repo/evaluation" }),
  Object.freeze({ id: "root_evaluation", path: "/evaluation" }),
  Object.freeze({ id: "repo_ground_truth_dir", path: "/repo/evaluation/ground-truth" }),
  Object.freeze({ id: "repo_ground_truth_file", path: "/repo/evaluation/ground-truth/ground-truth.json" }),
]);

/** Canonical text of the probe set: one line per location, `id TAB path TAB ops`. Changing any probe changes the hash. */
export function probeSetText(): string {
  return PROBE_LOCATIONS.map((l) => `${l.id}\t${l.path}\t${PROBE_OPS.join(",")}\n`).join("");
}

export const PROBE_SET_SHA256: string = createHash("sha256").update(probeSetText(), "utf8").digest("hex");

/** The location id of a path, or `unlisted` (R15.6: a violation report never carries a free path). */
export function locationIdOf(path: string): string {
  for (const l of PROBE_LOCATIONS) if (l.path === path) return l.id;
  return "unlisted";
}
