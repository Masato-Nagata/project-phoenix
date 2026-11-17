// Pure errno classification (design item 2). `absent` and `denied` are separate classes and are counted separately (item 3).
import type { ErrnoClass, ProbeOutcome } from "./types.js";

const DENIED = new Set(["EACCES", "EPERM"]);
const ABSENT = new Set(["ENOENT", "ENOTDIR"]);

export function classifyCode(code: string): ErrnoClass {
  if (DENIED.has(code)) return "denied";
  if (ABSENT.has(code)) return "absent";
  return "unexpected";
}

/** Any value that is not a well-formed ProbeOutcome is `unexpected` (a wrong port shape never passes). */
export function classifyOutcome(o: unknown): ErrnoClass {
  if (typeof o !== "object" || o === null) return "unexpected";
  const r = o as { kind?: unknown; code?: unknown };
  if (r.kind === "ok") return "readable";
  if (r.kind === "error" && typeof r.code === "string") return classifyCode(r.code);
  return "unexpected";
}

export function isProbeOutcome(o: unknown): o is ProbeOutcome {
  if (typeof o !== "object" || o === null) return false;
  const r = o as { kind?: unknown; code?: unknown };
  return r.kind === "ok" || (r.kind === "error" && typeof r.code === "string");
}
