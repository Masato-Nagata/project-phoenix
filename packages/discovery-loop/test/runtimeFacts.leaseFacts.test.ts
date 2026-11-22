// Task 4.6 W4-A: the reading and the checking of lease.json (`src/runtimeFacts/leaseFacts.ts`). Deterministic and offline.
// Every lease value below (run id, nonce, process id, ticks, limits) is a SYNTHETIC test value. No real lease file is read, and no file at
// all is touched: the port is a fake that answers from memory.
// **Validates: Requirements 24.7, 24.9, 22.3**
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RUN_ID_PATTERN } from "../src/isolation/attestation.js";
import {
  LEASE_JSON_KEYS,
  LEASE_JSON_MAX_BYTES,
  compareLeaseFactsSnapshots,
  confirmLeaseFactsUnchanged,
  createLeaseFactsSnapshot,
  isLeaseFactsSnapshot,
  parseLeaseJsonText,
  readLeaseFactsSnapshot,
  type LeaseFactsErrorCode,
  type LeaseJsonReadAnswer,
  type LeaseJsonReadPort,
} from "../src/runtimeFacts/leaseFacts.js";

const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
const RUN_ID = "run-20300101T000000Z-0123456789ab";
const NONCE = "canary-nonce-91x-synthetic";
const NONCE_SHA = sha(NONCE);
const H = 1000;
const S = 4000;

const goodObject = (): Record<string, unknown> => ({
  heartbeat_interval_ms: H,
  issued_by: "launcher",
  launcher_pid: 4242,
  launcher_start_ticks: "630000000000000000",
  nonce_sha256: NONCE_SHA,
  run_id: RUN_ID,
  stale_after_ms: S,
});
const textOf = (o: Record<string, unknown>): string => JSON.stringify(o);
const goodText = (): string => textOf(goodObject());
const withField = (k: string, v: unknown): string => textOf({ ...goodObject(), [k]: v });
const without = (k: string): string => {
  const o = goodObject();
  delete o[k];
  return textOf(o);
};
const expectation = (): Record<string, unknown> => ({ runId: RUN_ID, nonce: NONCE, heartbeatIntervalMs: H, staleAfterMs: S });

const codeOf = (r: { ok: boolean; error?: { code: string } }): string | undefined => (r.ok ? undefined : r.error?.code);
const snap = (text = goodText()) => {
  const r = createLeaseFactsSnapshot(text, expectation());
  if (!r.ok) throw new Error("test setup: " + r.error.code);
  return r.value;
};

/** A fake port: answers from a script, one answer per call (the last repeats), and counts the calls. */
function fakePort(...answers: Array<LeaseJsonReadAnswer | "throw" | unknown>): LeaseJsonReadPort & { calls: number } {
  const port = {
    calls: 0,
    readLeaseJson(): LeaseJsonReadAnswer {
      const a = answers[Math.min(port.calls, answers.length - 1)];
      port.calls += 1;
      if (a === "throw") throw new Error(NONCE);
      return a as LeaseJsonReadAnswer;
    },
  };
  return port;
}
const ok = (text: string): LeaseJsonReadAnswer => ({ kind: "ok", text });

describe("parseLeaseJsonText", () => {
  it("accepts the seven keys the Launcher writes and returns frozen declared values", () => {
    const r = parseLeaseJsonText(goodText());
    expect(r).toEqual({
      ok: true,
      value: { runId: RUN_ID, launcherPid: 4242, launcherStartTicks: "630000000000000000", nonceSha256: NONCE_SHA, heartbeatIntervalMs: H, staleAfterMs: S },
    });
    if (r.ok) expect(Object.isFrozen(r.value)).toBe(true);
    expect([...LEASE_JSON_KEYS]).toEqual(Object.keys(goodObject()).sort());
  });

  it("refuses an input that is not a string", () => {
    for (const v of [undefined, null, 5, {}, [], Buffer.from(goodText())]) expect(codeOf(parseLeaseJsonText(v))).toBe("lease_json_not_string");
  });

  it("refuses invalid JSON, a BOM, a duplicate key and a root that is not an object", () => {
    for (const bad of ["", "{", "{\"a\":}", "\uFEFF" + goodText(), goodText().replace("}", ",\"run_id\":\"x\"}")]) {
      expect(codeOf(parseLeaseJsonText(bad)), bad).toBe("lease_json_invalid_json");
    }
    for (const bad of ["[]", "null", "42", "\"x\"", "true"]) expect(codeOf(parseLeaseJsonText(bad)), bad).toBe("lease_json_not_object");
  });

  it("refuses a text over the size bound, measured in bytes", () => {
    const pad = " ".repeat(LEASE_JSON_MAX_BYTES);
    expect(codeOf(parseLeaseJsonText(goodText() + pad))).toBe("lease_json_too_large");
    const multibyte = "\u00e9".repeat(LEASE_JSON_MAX_BYTES / 2 + 1); // 2 bytes each, more than the bound in bytes, fewer in characters
    expect(codeOf(parseLeaseJsonText(withField("pad", multibyte)))).toBe("lease_json_too_large");
  });

  it("refuses a missing field, whichever one is missing", () => {
    for (const k of LEASE_JSON_KEYS) expect(codeOf(parseLeaseJsonText(without(k))), k).toBe("field_missing");
  });

  it("refuses an extra field, including a prototype-looking key", () => {
    expect(codeOf(parseLeaseJsonText(withField("extra", 1)))).toBe("field_unknown");
    expect(codeOf(parseLeaseJsonText(goodText().replace("{", "{\"__proto__\":1,")))).toBe("field_unknown");
    expect(codeOf(parseLeaseJsonText(without("run_id").replace("{", "{\"extra\":1,")))).toBe("field_missing");
  });

  it("refuses an issuer other than the Launcher", () => {
    for (const v of ["Launcher", "runtime", "", null, 1]) expect(codeOf(parseLeaseJsonText(withField("issued_by", v))), String(v)).toBe("issued_by_invalid");
  });

  it("refuses a run id that is not the Launcher format", () => {
    for (const v of ["", "run-1", RUN_ID + "\n", RUN_ID.toUpperCase(), RUN_ID + "0", null, 5]) {
      expect(codeOf(parseLeaseJsonText(withField("run_id", v))), String(v)).toBe("run_id_invalid");
    }
  });

  it("refuses a launcher_pid that is not a positive integer within 32 bits", () => {
    for (const v of [0, -1, 1.5, 4294967296, "4242", null, true]) {
      expect(codeOf(parseLeaseJsonText(withField("launcher_pid", v))), String(v)).toBe("launcher_pid_invalid");
    }
    expect(parseLeaseJsonText(withField("launcher_pid", 1)).ok).toBe(true);
    expect(parseLeaseJsonText(withField("launcher_pid", 4294967295)).ok).toBe(true);
  });

  it("checks launcher_start_ticks as decimal text of .NET ticks, and nothing more", () => {
    for (const v of ["", "0", "01", "-1", "1.5", "abc", " 1", "1 ", "1e5", "3155378976000000000", "10000000000000000000", 5, null]) {
      expect(codeOf(parseLeaseJsonText(withField("launcher_start_ticks", v))), String(v)).toBe("launcher_start_ticks_invalid");
    }
    for (const v of ["1", "3155378975999999999"]) expect(parseLeaseJsonText(withField("launcher_start_ticks", v)).ok, v).toBe(true);
  });

  it("refuses an integer lexeme outside the safe range as invalid JSON (the strict parser), never as a number", () => {
    expect(codeOf(parseLeaseJsonText(goodText().replace("4242", "630000000000000000")))).toBe("lease_json_invalid_json");
  });

  it("refuses a nonce hash that is not 64 lowercase hex characters, and the all-zero value", () => {
    for (const v of ["", NONCE_SHA.toUpperCase(), NONCE_SHA.slice(1), NONCE_SHA + "0", "0".repeat(64), "g".repeat(64), null, 1]) {
      expect(codeOf(parseLeaseJsonText(withField("nonce_sha256", v))), String(v)).toBe("nonce_hash_invalid");
    }
  });

  it("refuses limits that are not positive integers, and a stale limit that is not above the heartbeat", () => {
    for (const v of [0, -1, 1.5, "1000", null]) {
      expect(codeOf(parseLeaseJsonText(withField("heartbeat_interval_ms", v))), String(v)).toBe("heartbeat_invalid");
      expect(codeOf(parseLeaseJsonText(withField("stale_after_ms", v))), String(v)).toBe("stale_invalid");
    }
    expect(codeOf(parseLeaseJsonText(withField("stale_after_ms", H)))).toBe("stale_not_above_heartbeat");
    expect(codeOf(parseLeaseJsonText(withField("stale_after_ms", H - 1)))).toBe("stale_not_above_heartbeat");
    expect(parseLeaseJsonText(withField("stale_after_ms", H + 1)).ok).toBe(true);
  });
});

describe("createLeaseFactsSnapshot", () => {
  it("issues a frozen snapshot of Launcher-declared values with the hash of the exact text", () => {
    const text = goodText();
    const r = createLeaseFactsSnapshot(text, expectation());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.declaredBy).toBe("launcher");
    expect(r.value.textSha256).toBe(sha(text));
    expect(r.value.facts.launcherPid).toBe(4242);
    expect(Object.isFrozen(r.value)).toBe(true);
    expect(Object.isFrozen(r.value.facts)).toBe(true);
    expect(isLeaseFactsSnapshot(r.value)).toBe(true);
  });

  it("does not recognize a copy, a frozen clone or a look-alike as a snapshot", () => {
    const s = snap();
    for (const fake of [{ ...s }, structuredClone(s), Object.freeze({ declaredBy: "launcher", facts: s.facts, textSha256: s.textSha256 }), null, undefined, "x", 1]) {
      expect(isLeaseFactsSnapshot(fake)).toBe(false);
    }
  });

  it("refuses a run id that differs from PHOENIX_RUN_ID", () => {
    const other = { ...expectation(), runId: "run-20300101T000000Z-ba9876543210" };
    expect(codeOf(createLeaseFactsSnapshot(goodText(), other))).toBe("run_id_mismatch");
  });

  it("refuses a nonce hash that is not the SHA-256 of PHOENIX_LEASE_NONCE", () => {
    expect(codeOf(createLeaseFactsSnapshot(goodText(), { ...expectation(), nonce: NONCE + "x" }))).toBe("nonce_mismatch");
    expect(codeOf(createLeaseFactsSnapshot(withField("nonce_sha256", sha("other")), expectation()))).toBe("nonce_mismatch");
  });

  it("refuses limits that differ from the approved ones", () => {
    expect(codeOf(createLeaseFactsSnapshot(goodText(), { ...expectation(), heartbeatIntervalMs: H + 1 }))).toBe("heartbeat_mismatch");
    expect(codeOf(createLeaseFactsSnapshot(goodText(), { ...expectation(), staleAfterMs: S + 1 }))).toBe("stale_mismatch");
    expect(codeOf(createLeaseFactsSnapshot(withField("heartbeat_interval_ms", H + 1), expectation()))).toBe("heartbeat_mismatch");
  });

  it("refuses a bad expectation before it reads the text", () => {
    const cases: Array<[unknown, LeaseFactsErrorCode]> = [
      [null, "expectation_not_plain_object"],
      [[], "expectation_not_plain_object"],
      [{ ...expectation(), extra: 1 }, "expectation_keys"],
      [{ runId: RUN_ID, nonce: NONCE, heartbeatIntervalMs: H }, "expectation_keys"],
      [{ ...expectation(), runId: "run-x" }, "expectation_run_id_invalid"],
      [{ ...expectation(), nonce: "" }, "expectation_nonce_invalid"],
      [{ ...expectation(), nonce: 5 }, "expectation_nonce_invalid"],
      [{ ...expectation(), nonce: "n".repeat(1025) }, "expectation_nonce_invalid"],
      [{ ...expectation(), heartbeatIntervalMs: 0 }, "expectation_timing_invalid"],
      [{ ...expectation(), staleAfterMs: H }, "expectation_timing_invalid"],
      [{ ...expectation(), staleAfterMs: "4000" }, "expectation_timing_invalid"],
    ];
    for (const [e, code] of cases) expect(codeOf(createLeaseFactsSnapshot("not json", e)), code).toBe(code);
  });

  it("never runs a getter of the expectation", () => {
    let ran = 0;
    const e = expectation();
    for (const k of Object.keys(e)) {
      const copy: Record<string, unknown> = { ...e };
      Object.defineProperty(copy, k, { enumerable: true, get: () => { ran += 1; return e[k]; } });
      expect(codeOf(createLeaseFactsSnapshot(goodText(), copy)), k).toBe("expectation_not_plain_object");
    }
    expect(ran).toBe(0);
  });

  it("does not change the expectation (also when it is frozen) and does not alias it", () => {
    const e = Object.freeze(expectation());
    const before = JSON.stringify(e);
    const r = createLeaseFactsSnapshot(goodText(), e);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(e)).toBe(before);
    if (r.ok) expect(Object.values(r.value.facts)).not.toContain(e);
  });

  it("never puts the raw nonce or an input value into a result or an error", () => {
    const results = [
      createLeaseFactsSnapshot(goodText(), expectation()),
      createLeaseFactsSnapshot(goodText(), { ...expectation(), nonce: NONCE + "x" }),
      createLeaseFactsSnapshot(withField("run_id", NONCE), expectation()),
      createLeaseFactsSnapshot(withField("launcher_pid", NONCE), expectation()),
      createLeaseFactsSnapshot(withField("extra_" + NONCE, 1), expectation()),
      createLeaseFactsSnapshot(NONCE, expectation()),
      createLeaseFactsSnapshot(goodText(), { ...expectation(), runId: NONCE }),
      createLeaseFactsSnapshot(goodText(), { ...expectation(), nonce: 5, extra: NONCE }),
    ];
    for (const r of results) {
      const json = JSON.stringify(r);
      expect(json).not.toContain(NONCE);
      if (!r.ok) expect(Object.keys(r.error)).toEqual(["code"]);
    }
  });
});

describe("readLeaseFactsSnapshot (the start-up snapshot)", () => {
  it("reads once and returns the snapshot", () => {
    const port = fakePort(ok(goodText()));
    const r = readLeaseFactsSnapshot(port, expectation());
    expect(r.ok).toBe(true);
    expect(port.calls).toBe(1);
  });

  it("refuses an absent file, a failed read and a port that throws, with no retry", () => {
    for (const [answer, code] of [[{ kind: "absent" }, "lease_read_absent"], [{ kind: "error" }, "lease_read_failed"], ["throw", "lease_read_failed"]] as const) {
      const port = fakePort(answer, ok(goodText()));
      expect(codeOf(readLeaseFactsSnapshot(port, expectation())), code).toBe(code);
      expect(port.calls).toBe(1);
    }
  });

  it("refuses every answer that is not one of the three shapes", () => {
    let ran = 0;
    const getter = { kind: "ok" } as Record<string, unknown>;
    Object.defineProperty(getter, "text", { enumerable: true, get: () => { ran += 1; return goodText(); } });
    const bad: unknown[] = [undefined, null, "ok", 5, [], { kind: "ok" }, { kind: "ok", text: 5 }, { kind: "ok", text: null }, { kind: "x" }, { kind: "absent", text: "x" }, { kind: "error", extra: 1 }, { kind: "ok", text: goodText(), extra: 1 }, getter];
    bad.forEach((a, i) => expect(codeOf(readLeaseFactsSnapshot(fakePort(a), expectation())), `answer #${i}`).toBe("lease_read_answer_invalid"));
    expect(ran).toBe(0);
  });

  it("applies every check of the text to what it read", () => {
    expect(codeOf(readLeaseFactsSnapshot(fakePort(ok(without("run_id"))), expectation()))).toBe("field_missing");
    expect(codeOf(readLeaseFactsSnapshot(fakePort(ok(goodText())), { ...expectation(), nonce: "other" }))).toBe("nonce_mismatch");
  });
});

describe("compareLeaseFactsSnapshots and confirmLeaseFactsUnchanged (the re-read before sealing)", () => {
  it("two snapshots of the same text are the same", () => {
    expect(compareLeaseFactsSnapshots(snap(), snap())).toEqual({ ok: true, value: true });
    const s = snap();
    expect(compareLeaseFactsSnapshots(s, s).ok).toBe(true);
  });

  it("a text that differs only in white space is a different text (the hash is of the exact text)", () => {
    expect(codeOf(compareLeaseFactsSnapshots(snap(), snap(goodText() + "\n")))).toBe("lease_json_changed");
  });

  it("a look-alike is not accepted on either side", () => {
    const s = snap();
    expect(codeOf(compareLeaseFactsSnapshots(s, { ...s }))).toBe("snapshot_not_issued");
    expect(codeOf(compareLeaseFactsSnapshots({ ...s }, s))).toBe("snapshot_not_issued");
    expect(codeOf(compareLeaseFactsSnapshots(null, undefined))).toBe("snapshot_not_issued");
  });

  it("an unchanged file confirms and returns the start-up snapshot itself", () => {
    const start = snap();
    const port = fakePort(ok(goodText()));
    const r = confirmLeaseFactsUnchanged(port, expectation(), start);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe(start);
    expect(port.calls).toBe(1);
  });

  it("refuses a change of any field", () => {
    const start = snap();
    const changes: Record<string, unknown> = {
      launcher_pid: 4243,
      launcher_start_ticks: "630000000000000001",
      run_id: "run-20300101T000000Z-ba9876543210",
      nonce_sha256: sha("other"),
      heartbeat_interval_ms: H + 1,
      stale_after_ms: S + 1,
    };
    for (const [k, v] of Object.entries(changes)) {
      expect(codeOf(confirmLeaseFactsUnchanged(fakePort(ok(withField(k, v))), expectation(), start)), k).toBe("lease_json_changed");
    }
  });

  it("refuses a change to white space, to a removed field, an added field, invalid JSON and an empty text", () => {
    const start = snap();
    for (const t of [goodText() + " ", without("issued_by"), withField("x", 1), "{", ""]) {
      expect(codeOf(confirmLeaseFactsUnchanged(fakePort(ok(t)), expectation(), start)), t).toBe("lease_json_changed");
    }
  });

  it("refuses a read that fails at the re-read, with one read and no retry", () => {
    const start = snap();
    for (const [answer, code] of [[{ kind: "error" }, "lease_read_failed"], [{ kind: "absent" }, "lease_read_absent"], ["throw", "lease_read_failed"], [{ kind: "nope" }, "lease_read_answer_invalid"]] as const) {
      const port = fakePort(answer, ok(goodText()));
      expect(codeOf(confirmLeaseFactsUnchanged(port, expectation(), start)), code).toBe(code);
      expect(port.calls).toBe(1);
    }
  });

  it("refuses a start value that is not a snapshot, without reading", () => {
    const s = snap();
    const port = fakePort(ok(goodText()));
    expect(codeOf(confirmLeaseFactsUnchanged(port, expectation(), { ...s }))).toBe("snapshot_not_issued");
    expect(port.calls).toBe(0);
  });

  it("checks the unchanged text against the expectation again", () => {
    const start = snap();
    expect(codeOf(confirmLeaseFactsUnchanged(fakePort(ok(goodText())), { ...expectation(), nonce: "other" }, start))).toBe("nonce_mismatch");
  });

  it("puts neither the nonce nor a file text into any error", () => {
    const start = snap();
    for (const a of [ok(NONCE), ok(withField("run_id", NONCE)), "throw", { kind: "error" }]) {
      const r = confirmLeaseFactsUnchanged(fakePort(a), expectation(), start);
      expect(JSON.stringify(r)).not.toContain(NONCE);
      if (!r.ok) expect(Object.keys(r.error)).toEqual(["code"]);
    }
  });
});

describe("pins", () => {
  it("the run id format equals the one of the isolation module", () => {
    const src = readFileSync(new URL("../src/runtimeFacts/leaseFacts.ts", import.meta.url), "utf8");
    expect(src).toContain(`const RUN_ID = /${RUN_ID_PATTERN.source}/;`);
  });

  it("the module imports only what it needs and touches no environment, clock, file, process or network", () => {
    const code = readFileSync(new URL("../src/runtimeFacts/leaseFacts.ts", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*") && !l.trimStart().startsWith("/*"))
      .join("\n");
    const specifiers = [...code.matchAll(/from\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specifiers).toEqual(["node:crypto", "../schema/strictParse.js", "../schema/types.js"]);
    expect(code).not.toMatch(/process\.|\bDate\b|performance|Math\.random|\brequire\s*\(|\beval\b|\bFunction\b|\bimport\s*\(|console|setTimeout|node:(fs|net|http|child_process|os)/);
  });

  it("the module does not import the manifest/ folder (the module boundary of W3-A)", () => {
    const src = readFileSync(new URL("../src/runtimeFacts/leaseFacts.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from\s*["']\.\.\/manifest\//);
  });

  it("the module is not exported from the package entry (it is internal until the composition root uses it)", () => {
    const index = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
    expect(index).not.toContain("runtimeFacts");
  });
});