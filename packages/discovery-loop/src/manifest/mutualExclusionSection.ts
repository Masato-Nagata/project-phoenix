// Run_Manifest `mutualExclusion` section builder (task 4.6, work unit W3-A).
//
// Pure: no I/O, no clock, no environment, and no acquisition. The facts of the Launcher (nonce hash, Launcher process id, heartbeat and stale
// limits) or the human attestation (approver, timestamp) are EXPLICIT inputs. This module checks the form and the agreement of the mode with
// its fields; it cannot prove that the Launcher held the locks, and it never creates an attestation. A `mechanical` input carries `lease` and
// no `attestation`; an `attestation` input carries `attestation` and no `lease`. Every error is a closed code, never an input value.
// The input is never changed and never aliased.
import type { Result } from "../schema/types.js";
import { SHA256_HEX, dataValue, hasExactKeys, isPlainDataObject, sectionFail, type SectionError } from "./plainData.js";

const MAX_APPROVER_LENGTH = 256;
// ISO 8601 date-time with an offset; the ranges are checked below (no clock and no Date object is used).
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?(Z|[+-](\d{2}):(\d{2}))$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export type MutualExclusionSection =
  | {
      readonly mode: "mechanical";
      readonly lease: { readonly nonceSha256: string; readonly launcherPid: number; readonly heartbeatIntervalMs: number; readonly staleAfterMs: number };
    }
  | { readonly mode: "attestation"; readonly attestation: { readonly approver: string; readonly timestamp: string } };

export type MutualExclusionSectionErrorCode =
  | "input_not_plain_object"
  | "input_keys"
  | "mode_invalid"
  | "lease_not_plain_object"
  | "lease_keys"
  | "nonce_invalid"
  | "pid_invalid"
  | "heartbeat_invalid"
  | "stale_invalid"
  | "stale_not_above_heartbeat"
  | "attestation_not_plain_object"
  | "attestation_keys"
  | "approver_invalid"
  | "timestamp_invalid";
export type MutualExclusionSectionError = SectionError<MutualExclusionSectionErrorCode>;

const fail = (code: MutualExclusionSectionErrorCode): Result<never, MutualExclusionSectionError> => sectionFail(code);
const posInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;

function timestampOk(v: unknown): v is string {
  if (typeof v !== "string") return false;
  const m = TIMESTAMP.exec(v);
  if (m === null) return false;
  const [, , mo, d, h, mi, s, , , oh, om] = m;
  const n = (x: string | undefined): number => Number(x);
  if (n(mo) < 1 || n(mo) > 12 || n(d) < 1 || n(d) > 31 || n(h) > 23 || n(mi) > 59 || n(s) > 59) return false;
  return oh === undefined || (n(oh) <= 23 && n(om) <= 59);
}

/** Input: `{ mode: "mechanical", lease }` or `{ mode: "attestation", attestation }`. */
export function buildMutualExclusionSection(input: unknown): Result<MutualExclusionSection, MutualExclusionSectionError> {
  if (!isPlainDataObject(input)) return fail("input_not_plain_object");
  const mode = dataValue(input, "mode").value;
  if (mode !== "mechanical" && mode !== "attestation") return fail("mode_invalid");

  if (mode === "mechanical") {
    if (!hasExactKeys(input, ["mode", "lease"])) return fail("input_keys");
    const lease = dataValue(input, "lease").value;
    if (!isPlainDataObject(lease)) return fail("lease_not_plain_object");
    if (!hasExactKeys(lease, ["nonceSha256", "launcherPid", "heartbeatIntervalMs", "staleAfterMs"])) return fail("lease_keys");
    const nonce = dataValue(lease, "nonceSha256").value;
    if (typeof nonce !== "string" || !SHA256_HEX.test(nonce)) return fail("nonce_invalid");
    const pid = dataValue(lease, "launcherPid").value;
    if (!posInt(pid)) return fail("pid_invalid");
    const heartbeat = dataValue(lease, "heartbeatIntervalMs").value;
    if (!posInt(heartbeat)) return fail("heartbeat_invalid");
    const stale = dataValue(lease, "staleAfterMs").value;
    if (!posInt(stale)) return fail("stale_invalid");
    if (stale <= heartbeat) return fail("stale_not_above_heartbeat");
    return { ok: true, value: { mode, lease: { nonceSha256: nonce, launcherPid: pid, heartbeatIntervalMs: heartbeat, staleAfterMs: stale } } };
  }

  if (!hasExactKeys(input, ["mode", "attestation"])) return fail("input_keys");
  const att = dataValue(input, "attestation").value;
  if (!isPlainDataObject(att)) return fail("attestation_not_plain_object");
  if (!hasExactKeys(att, ["approver", "timestamp"])) return fail("attestation_keys");
  const approver = dataValue(att, "approver").value;
  if (typeof approver !== "string" || approver.length < 1 || approver.length > MAX_APPROVER_LENGTH || approver.trim() !== approver || CONTROL.test(approver)) {
    return fail("approver_invalid");
  }
  const timestamp = dataValue(att, "timestamp").value;
  if (!timestampOk(timestamp)) return fail("timestamp_invalid");
  return { ok: true, value: { mode, attestation: { approver, timestamp } } };
}