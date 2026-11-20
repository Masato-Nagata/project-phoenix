// Task 4.4, unit U5: the AI-call helper (`src/orchestrator/providerCall.ts`). Deterministic and offline: the REAL RunSession on a scripted monotonic
// clock, a hand-fired fake TimerPort, and in-memory fakes of the writer, the audit port, the provider and the response gate. All fakes append to ONE
// call log, so the ORDER of the calls across the ports can be asserted. Nothing waits on real time; all data is synthetic.
// **Validates: Requirements 2.1, 2.3, 3.8, 3.9, 4.9, 11.10, 11.12, 11.15, 12.14, 17.8**
import * as fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { MIN_REARM_MS } from "../src/orchestrator/deadline.js";
import { RECORDS_UNAVAILABLE_MESSAGE, callProvider, type ProviderCallInput } from "../src/orchestrator/providerCall.js";
import type { RecordWriter } from "../src/orchestrator/recordWriter.js";
import { createRunSession } from "../src/orchestrator/session.js";
import type { StoredPartRef, TimerPort } from "../src/orchestrator/types.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

// ---------------------------------------------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------------------------------------------
function clockAt(start: number): { nowMs(): number; set(v: number): void; add(ms: number): void; throwing: boolean } {
  let t = start;
  const c = {
    throwing: false,
    nowMs: (): number => {
      if (c.throwing) throw new Error("clock failed");
      return t;
    },
    set: (v: number): void => {
      t = v;
    },
    add: (ms: number): void => {
      t += ms;
    },
  };
  return c;
}

interface TimerEntry {
  readonly delay: number;
  readonly fire: () => void;
  cancelled: number;
}
interface TimerOpts {
  readonly throwAt?: number;
  readonly noCancelFrom?: number;
  readonly syncFire?: boolean;
}
function fakeTimers(o: TimerOpts = {}): { timers: TimerPort; calls: TimerEntry[]; fireLast(): void } {
  const calls: TimerEntry[] = [];
  const timers: TimerPort = {
    schedule(delay, onFire) {
      const n = calls.length + 1;
      if (o.throwAt === n) throw new Error("schedule failed");
      const entry: TimerEntry = { delay, fire: onFire, cancelled: 0 };
      calls.push(entry);
      if (o.syncFire === true) onFire();
      if (o.noCancelFrom !== undefined && n >= o.noCancelFrom) return {} as Loose;
      return {
        cancel: () => {
          entry.cancelled += 1;
        },
      };
    },
  };
  return {
    timers,
    calls,
    fireLast: () => {
      const last = calls.at(-1);
      if (last === undefined) throw new Error("nothing scheduled");
      last.fire();
    },
  };
}

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const okBytes = (s = '{"x":1}'): Loose => ({ ok: true, value: enc(s) });
const errR = (reason: string, detail = "detail"): Loose => ({ ok: false, error: { reason, detail } });
const SHA = "a".repeat(64);
const passAudit = (): Loose => ({
  result: "pass",
  payloadSha256: SHA,
  bytesWithheld: false,
  auditedBytes: new Uint8Array([1, 2, 3]),
  checks: [{ id: "A01", outcome: "pass" }],
  matches: [],
});
const withheldPass = (): Loose => ({ result: "pass", payloadSha256: SHA, bytesWithheld: true, checks: [{ id: "A05", outcome: "pass", detail: "ok" }], matches: [] });
const blockedAudit = (): Loose => ({
  result: "blocked",
  payloadSha256: SHA,
  bytesWithheld: true,
  checks: [{ id: "A05", outcome: "fail", detail: "restricted_path_prefix" }],
  matches: [{ checkId: "A05", matchId: "restricted_path_prefix:0" }],
});
const unparseable = (): Loose => ({
  kind: "failed_call",
  reason: "unparseable",
  retryable: true,
  source: "gate",
  gate: { reason: "invalid_json", issues: [{ code: "invalid_json", path: "" }], toolCallLike: false, sha256: SHA, byteLength: 7 },
  toolCall: false,
});

interface Opts {
  readonly retries?: number;
  readonly callSeconds?: number;
  readonly limits?: Loose;
  readonly kind?: string;
  readonly stored?: StoredPartRef[];
  readonly seed?: { id: string; kind: string; payload: Loose }[];
  readonly prepare?: (input: Loose, n: number) => Loose;
  readonly audit?: (n: number) => Loose;
  readonly provider?: (n: number, req: Loose, opts: Loose) => Loose;
  readonly gate?: (n: number, result: Loose) => Loose;
  readonly failAt?: (key: string, nth: number) => string | undefined;
  readonly recordsUnavailable?: boolean;
  readonly onRecords?: () => void;
  readonly timers?: TimerOpts;
}

function harness(o: Opts = {}) {
  const log: string[] = [];
  const clock = clockAt(1_000);
  const made = createRunSession({ clock, runSeconds: 3600 });
  if (!made.ok) throw new Error("setup failed");
  const session = made.value;
  const tf = fakeTimers(o.timers);
  const recs: { id: string; kind: string; payload: Loose }[] = [...(o.seed ?? [])];
  const counts = new Map<string, number>();
  const snapshots: Loose[] = [];
  const outputs: Uint8Array[] = [];
  const blobs: Uint8Array[] = [];
  let seq = recs.length;
  const nextId = (): string => `rec-${String(++seq).padStart(6, "0")}`;
  const failFor = (key: string): string | undefined => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const c = o.failAt?.(key, n);
    if (c !== undefined) log.push(`fail:${key}`);
    return c;
  };
  const fail = (c: string): Loose => ({ ok: false, error: { code: c } });
  const writer = {
    append: async (kind: string, payload: Loose): Promise<Loose> => {
      log.push(`append:${kind}`);
      const c = failFor(`append:${kind}`);
      if (c !== undefined) return fail(c);
      const r = { id: nextId(), kind, payload: JSON.parse(JSON.stringify(payload)) };
      recs.push(r);
      return { ok: true, value: { id: r.id, kind } };
    },
    putBlob: async (data: Uint8Array): Promise<Loose> => {
      log.push("putBlob");
      const c = failFor("putBlob");
      if (c !== undefined) return fail(c);
      blobs.push(data);
      return { ok: true, value: { blob: `blob-${blobs.length}`, bytes: data.length } };
    },
    putAiOutput: async (data: Uint8Array): Promise<Loose> => {
      log.push("putAiOutput");
      const c = failFor("putAiOutput");
      if (c !== undefined) return fail(c);
      outputs.push(data);
      const r = { id: nextId(), kind: "ai_output", payload: {} };
      recs.push(r);
      return { ok: true, value: { record: { id: r.id }, blob: { blob: `out-${outputs.length}`, bytes: data.length } } };
    },
    drain: async (): Promise<void> => {
      log.push("drain");
    },
    state: () => ({ down: false, sealed: false, terminationWritten: false, secretRejections: 0 }),
    records: (): Loose => {
      log.push("records");
      o.onRecords?.();
      if (o.recordsUnavailable === true) return { ok: false, error: { code: "records_unavailable" } };
      const snap = Object.freeze(recs.map((r) => Object.freeze({ id: r.id, kind: r.kind, payload: r.payload })));
      snapshots.push(snap);
      return { ok: true, value: snap };
    },
  } as Loose as RecordWriter;

  const prepareCalls: Loose[] = [];
  let prepN = 0;
  let auditN = 0;
  const audit = {
    prepareAudit(input: Loose): Loose {
      log.push("prepare");
      prepN += 1;
      prepareCalls.push(input);
      return o.prepare !== undefined ? o.prepare(input, prepN) : { ok: true, value: { bytes: new Uint8Array([1, 2, 3]), ctx: { handle: true } } };
    },
    auditPayload(): Loose {
      log.push("audit");
      auditN += 1;
      return o.audit !== undefined ? o.audit(auditN) : { audit: passAudit(), request: { req: auditN } };
    },
  };
  const completeCalls: { req: Loose; opts: Loose }[] = [];
  const provider = {
    identity: { id: "mock", version: "1", model: "not_applicable" },
    complete(req: Loose, opts: Loose): Loose {
      log.push("complete");
      completeCalls.push({ req, opts });
      return o.provider !== undefined ? o.provider(completeCalls.length, req, opts) : Promise.resolve(okBytes());
    },
  };
  const gateCalls: { kind: string; result: Loose; limits: Loose; validator: Loose }[] = [];
  const responseGate = {
    gateProviderResult(kind: string, result: Loose, limits: Loose, validator: Loose): Loose {
      log.push("gate");
      gateCalls.push({ kind, result, limits, validator });
      if (o.gate !== undefined) return o.gate(gateCalls.length, result);
      if (result.ok === true) return { kind: "accepted", result: { parsed: true } };
      const r: string = result.error.reason;
      return { kind: "failed_call", reason: r === "timeout" ? "timeout" : "error", retryable: true, source: "provider", providerReason: r, toolCall: r === "tool_call_detected" };
    },
    gateResponse: (): Loose => undefined,
    resolveResponseLimits: (): Loose => ({ ok: true, value: {} }),
  };
  const input = {
    session,
    writer,
    clock,
    timers: tf.timers,
    provider,
    audit,
    auditConfig: { cfg: true },
    responseGate,
    responseLimits: { lim: 1 },
    validator: { v: 1 },
    bundle: { b: 1 },
    kind: o.kind ?? "hypothesis_generation",
    templateId: "tpl-1",
    stored: o.stored ?? [],
    limits: o.limits ?? { providerCallSeconds: o.callSeconds ?? 30, providerRetries: o.retries ?? 0 },
  } as Loose as ProviderCallInput<unknown, unknown>;
  return {
    session,
    clock,
    tf,
    log,
    recs,
    snapshots,
    outputs,
    blobs,
    prepareCalls,
    completeCalls,
    gateCalls,
    writer,
    input,
    auditCalls: () => auditN,
    run: () => callProvider(input),
    of: (k: string) => recs.filter((r) => r.kind === k),
    status: () => session.terminationStatus(),
    count: (entry: string) => log.filter((l) => l === entry).length,
  };
}
type H = ReturnType<typeof harness>;

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 2000 && !cond(); i += 1) await Promise.resolve();
  if (!cond()) throw new Error("condition not reached");
}
const tick = async (n = 60): Promise<void> => {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
};
const stopped = { kind: "stopped" };
const pendingWith = (reason: string): Loose => ({ state: "pending", reason });
const waitCalls = (h: H, n: number): Promise<void> => until(() => h.completeCalls.length >= n);
/** Reaches the per-call limit of the n-th call: the clock moves by the whole limit and the last timer fires. */
async function timeoutCall(h: H, n: number): Promise<void> {
  await waitCalls(h, n);
  h.clock.add(30_000);
  h.tf.fireLast();
}
const neverResolves = (): Promise<never> => new Promise<never>(() => undefined);

// ---------------------------------------------------------------------------------------------------------------------------------
// The accepted path
// ---------------------------------------------------------------------------------------------------------------------------------
describe("the accepted path", () => {
  it("runs the ports in the fixed order and returns the gate result with the id of the stored response", async () => {
    const h = harness();
    const res = await h.run();
    expect(h.log).toEqual(["drain", "records", "prepare", "audit", "putBlob", "append:payload_audit", "complete", "putAiOutput", "append:ai_call", "gate"]);
    expect(res).toEqual({ kind: "accepted", result: { parsed: true }, aiOutputRecordId: h.of("ai_output")[0]?.id, attempt: 1 });
    expect(h.status()).toEqual({ state: "none" });
    expect(h.gateCalls[0]?.kind).toBe("hypothesis_generation");
    expect(h.gateCalls[0]?.limits).toEqual({ lim: 1 });
    expect(h.gateCalls[0]?.validator).toEqual({ v: 1 });
    expect(h.of("ai_call")[0]?.payload).toEqual({
      requestKind: "hypothesis_generation",
      attempt: 1,
      payloadAuditRecordId: h.of("payload_audit")[0]?.id,
      provider: { id: "mock", version: "1", model: "not_applicable" },
      requestSha256: SHA,
      outcome: "response",
      responseSha256: "out-1",
      responseBytes: 7,
      aiOutputRecordId: h.of("ai_output")[0]?.id,
    });
  });
  it("hands the provider the audited request, the per-call time limit and its own signal", async () => {
    const h = harness({ callSeconds: 45 });
    await h.run();
    const c = h.completeCalls[0];
    expect(c?.req).toEqual({ req: 1 });
    expect(c?.opts.timeoutMs).toBe(45_000);
    expect(c?.opts.signal).toBeInstanceOf(AbortSignal);
    expect(c?.opts.signal).not.toBe(h.session.signal);
    expect(c?.opts.signal.aborted).toBe(false);
  });
  it("the audited bytes become a blob only when the auditor returned them", async () => {
    const withBytes = harness();
    await withBytes.run();
    expect(withBytes.count("putBlob")).toBe(1);
    expect(withBytes.of("payload_audit")[0]?.payload.blob).toEqual({ blob: "blob-1", bytes: 3 });
    const withheld = harness({ audit: () => ({ audit: withheldPass(), request: { req: 1 } }) });
    const res = await withheld.run();
    expect(res.kind).toBe("accepted");
    expect(withheld.count("putBlob")).toBe(0);
    expect("blob" in (withheld.of("payload_audit")[0]?.payload ?? {})).toBe(false);
    expect(withheld.of("payload_audit")[0]?.payload.bytesWithheld).toBe(true);
  });
  it("the writer handed in is a plain RecordWriter: no channel member", () => {
    const h = harness();
    expect(Object.keys(h.writer).sort()).toEqual(["append", "drain", "putAiOutput", "putBlob", "records", "state"]);
  });
  it("cancels the timer and removes the abort listener after the result", async () => {
    const h = harness();
    const add = vi.spyOn(h.session.signal, "addEventListener");
    const remove = vi.spyOn(h.session.signal, "removeEventListener");
    await h.run();
    expect(h.tf.calls).toHaveLength(1);
    expect(h.tf.calls[0]?.cancelled).toBe(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0]?.[1]).toBe(add.mock.calls[0]?.[1]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The audit and the writes before the call
// ---------------------------------------------------------------------------------------------------------------------------------
describe("the audit and the mandatory writes before the call", () => {
  it("a blocked audit writes the payload_audit record, makes no call, raises payload_audit_blocked and is not retried", async () => {
    const h = harness({ retries: 2, audit: () => ({ audit: blockedAudit() }) });
    expect(await h.run()).toEqual(stopped);
    expect(h.completeCalls).toHaveLength(0);
    expect(h.of("payload_audit")[0]?.payload.result).toBe("blocked");
    expect(h.of("payload_audit")[0]?.payload.matches).toEqual([{ checkId: "A05", matchId: "restricted_path_prefix:0" }]);
    expect(h.status()).toEqual(pendingWith("payload_audit_blocked"));
    expect(h.count("prepare")).toBe(1);
    expect(h.session.providerRetryCount).toBe(0);
  });
  it.each(["io_failure", "store_failed", "writer_down", "secret_rejected", "invalid_record", "admission_closed"])(
    "a failed payload_audit write (%s) raises error and the provider is never called",
    async (code) => {
      const h = harness({ retries: 2, failAt: (k) => (k === "append:payload_audit" ? code : undefined) });
      expect(await h.run()).toEqual(stopped);
      expect(h.completeCalls).toHaveLength(0);
      expect(h.status()).toEqual(pendingWith("error"));
      expect(h.count("prepare")).toBe(1);
    },
  );
  it("positive control: the same Run without a write failure calls the provider once", async () => {
    const h = harness();
    await h.run();
    expect(h.completeCalls).toHaveLength(1);
  });
  it("a failed blob write stops before the payload_audit record: no record, no call", async () => {
    const h = harness({ failAt: (k) => (k === "putBlob" ? "io_failure" : undefined) });
    expect(await h.run()).toEqual(stopped);
    expect(h.count("append:payload_audit")).toBe(0);
    expect(h.completeCalls).toHaveLength(0);
    expect(h.status()).toEqual(pendingWith("error"));
  });
  it("an unreadable snapshot raises error synchronously after records(), throws the one fixed message and prepares nothing", async () => {
    let seen: unknown;
    const h: H = harness({
      recordsUnavailable: true,
      onRecords: () => queueMicrotask(() => (seen = h.session.terminationStatus())),
    });
    await expect(h.run()).rejects.toThrow(new Error(RECORDS_UNAVAILABLE_MESSAGE));
    expect(RECORDS_UNAVAILABLE_MESSAGE).toBe("run records unavailable");
    expect(seen).toEqual(pendingWith("error")); // the microtask queued inside records() ran before any continuation of the helper
    expect(h.count("prepare")).toBe(0);
    expect(h.auditCalls()).toBe(0);
    expect(h.completeCalls).toHaveLength(0);
    expect(h.status()).toEqual(pendingWith("error"));
  });
  it("prepareAudit receives the SAME array that records() returned", async () => {
    const h = harness();
    await h.run();
    expect(h.prepareCalls[0].records).toBe(h.snapshots[0]);
    expect(h.prepareCalls[0]).toMatchObject({ bundle: { b: 1 }, kind: "hypothesis_generation", templateId: "tpl-1", stored: [] });
  });
  it("a stored reference must exist with the matching kind and a permitted type; otherwise error, never payload_audit_blocked", async () => {
    const seed = [{ id: "rec-x", kind: "hypothesis_revision", payload: {} }];
    const ref = (type: string, recordId = "rec-x"): StoredPartRef[] => [{ partId: "p1", type, recordId }];
    for (const stored of [ref("hypothesis_revision", "rec-missing"), ref("experiment"), ref("source_file")]) {
      const h = harness({ seed, stored });
      expect(await h.run()).toEqual(stopped);
      expect(h.count("prepare")).toBe(0);
      expect(h.status()).toEqual(pendingWith("error"));
    }
    // positive control
    const ok = harness({ seed, stored: ref("hypothesis_revision") });
    expect((await ok.run()).kind).toBe("accepted");
    expect(ok.prepareCalls[0].stored).toEqual(ref("hypothesis_revision"));
  });
  it.each([
    ["not ok", () => ({ ok: false, error: { code: "prepare_failed" } })],
    ["throws", () => { throw new Error("prepare exploded"); }],
    ["malformed", () => ({ ok: true, value: { bytes: "not bytes", ctx: {} } })],
  ])("prepareAudit that %s raises error and auditPayload is not called", async (_n, prepare) => {
    const h = harness({ prepare });
    expect(await h.run()).toEqual(stopped);
    expect(h.auditCalls()).toBe(0);
    expect(h.completeCalls).toHaveLength(0);
    expect(h.status()).toEqual(pendingWith("error"));
  });
  it.each([
    ["throws", () => { throw new Error("audit exploded"); }],
    ["is malformed", () => ({ audit: { result: "pass" }, request: {} })],
    ["is not an object", () => undefined],
    ["passes without a request", () => ({ audit: passAudit() })],
    ["returns bytes that are marked withheld", () => ({ audit: { ...passAudit(), bytesWithheld: true }, request: {} })],
  ])("an audit that %s raises error: nothing is written and nothing is called", async (_n, audit) => {
    const h = harness({ audit });
    expect(await h.run()).toEqual(stopped);
    expect(h.count("append:payload_audit")).toBe(0);
    expect(h.completeCalls).toHaveLength(0);
    expect(h.status()).toEqual(pendingWith("error"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Pre-checks and limits
// ---------------------------------------------------------------------------------------------------------------------------------
describe("pre-checks and limits", () => {
  it("a cause that is already latched stops the call without raising anything else", async () => {
    const h = harness();
    h.session.raise("no_further_experiments");
    expect(await h.run()).toEqual(stopped);
    expect(h.log).toEqual([]);
    expect(h.status()).toEqual(pendingWith("no_further_experiments"));
  });
  it("a reached deadline raises time_limit_reached; a clock fault (non-finite or throwing) raises error; none of them calls the provider", async () => {
    const late = harness();
    late.clock.set(5_000_000);
    expect(await late.run()).toEqual(stopped);
    expect(late.status()).toEqual(pendingWith("time_limit_reached"));
    const nan = harness();
    nan.clock.set(Number.NaN);
    expect(await nan.run()).toEqual(stopped);
    expect(nan.status()).toEqual(pendingWith("error"));
    const thrown = harness();
    thrown.clock.throwing = true;
    expect(await thrown.run()).toEqual(stopped);
    expect(thrown.status()).toEqual(pendingWith("error"));
    for (const h of [late, nan, thrown]) {
      expect(h.completeCalls).toHaveLength(0);
      expect(h.count("append:ai_call")).toBe(0);
    }
  });
  it.each([
    [{ providerCallSeconds: 0, providerRetries: 0 }],
    [{ providerCallSeconds: 601, providerRetries: 0 }],
    [{ providerCallSeconds: 1.5, providerRetries: 0 }],
    [{ providerCallSeconds: 30, providerRetries: -1 }],
    [{ providerCallSeconds: 30, providerRetries: 11 }],
    [{ providerCallSeconds: 30, providerRetries: 0.5 }],
  ])("invalid limits %j raise error and make no call", async (limits) => {
    const h = harness({ limits });
    expect(await h.run()).toEqual(stopped);
    expect(h.log).toEqual([]);
    expect(h.status()).toEqual(pendingWith("error"));
  });
  it("the limits at the edges are accepted", async () => {
    for (const limits of [{ providerCallSeconds: 1, providerRetries: 0 }, { providerCallSeconds: 600, providerRetries: 10 }]) {
      const h = harness({ limits });
      expect((await h.run()).kind).toBe("accepted");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The per-call timer and the retries
// ---------------------------------------------------------------------------------------------------------------------------------
describe("the per-call timer and the retries", () => {
  it.each([[0], [2], [10]])("a provider that never answers is timed out %i + 1 times, each attempt fully redone, then provider_failure", async (retries) => {
    const h = harness({ retries, provider: neverResolves });
    const p = h.run();
    for (let n = 1; n <= retries + 1; n += 1) await timeoutCall(h, n);
    expect(await p).toEqual(stopped);
    const attempts = retries + 1;
    expect(h.completeCalls).toHaveLength(attempts);
    expect(h.snapshots).toHaveLength(attempts);
    expect(h.count("prepare")).toBe(attempts);
    expect(h.auditCalls()).toBe(attempts);
    expect(h.of("payload_audit")).toHaveLength(attempts);
    expect(h.of("ai_call")).toHaveLength(attempts);
    expect(h.of("ai_rejected")).toHaveLength(attempts);
    expect(h.of("ai_call").map((r) => r.payload.attempt)).toEqual(Array.from({ length: attempts }, (_v, i) => i + 1));
    expect(h.of("ai_call")[0]?.payload).toMatchObject({ outcome: "timeout", timeoutBy: "orchestrator" });
    expect("providerReason" in (h.of("ai_call")[0]?.payload ?? {})).toBe(false);
    expect(h.of("ai_rejected")[0]?.payload).toMatchObject({ reason: "timeout", source: "orchestrator", attempt: 1, toolCall: false, aiCallRecordId: h.of("ai_call")[0]?.id });
    expect(h.status()).toEqual(pendingWith("provider_failure"));
    expect(h.session.providerRetryCount).toBe(retries);
    expect(h.completeCalls.every((c) => c.opts.timeoutMs === 30_000)).toBe(true);
    expect(h.tf.calls.every((t) => t.cancelled === 1)).toBe(true);
  });
  it("a late response after the per-call timeout is not stored, not recorded and not gated", async () => {
    let release: (v: unknown) => void = () => undefined;
    const h = harness({ provider: () => new Promise((r) => (release = r)) });
    const p = h.run();
    await timeoutCall(h, 1);
    expect(await p).toEqual(stopped);
    release(okBytes("LATE-RESPONSE"));
    await tick();
    expect(h.count("putAiOutput")).toBe(0);
    expect(h.gateCalls).toHaveLength(1);
    expect(h.gateCalls[0]?.result.ok).toBe(false);
    expect(h.of("ai_call")).toHaveLength(1);
    expect(JSON.stringify(h.recs)).not.toContain("LATE-RESPONSE");
  });
  it("an early fire with clock progress re-arms with the remaining time; the later fire then times the call out", async () => {
    const h = harness({ provider: neverResolves });
    const p = h.run();
    await waitCalls(h, 1);
    expect(h.tf.calls[0]?.delay).toBe(30_000);
    h.clock.add(10_000);
    h.tf.calls[0]?.fire();
    expect(h.tf.calls).toHaveLength(2);
    expect(h.tf.calls[1]?.delay).toBe(20_000);
    expect(h.tf.calls[1]?.delay).toBeGreaterThanOrEqual(MIN_REARM_MS);
    h.clock.add(20_000);
    h.tf.fireLast();
    expect(await p).toEqual(stopped);
    expect(h.of("ai_call")[0]?.payload).toMatchObject({ outcome: "timeout", timeoutBy: "orchestrator" });
    expect(h.status()).toEqual(pendingWith("provider_failure"));
  });
  it("a re-armed wait is never shorter than MIN_REARM_MS", async () => {
    const h = harness({ provider: neverResolves });
    const p = h.run();
    await waitCalls(h, 1);
    h.clock.add(29_990);
    h.tf.fireLast();
    expect(h.tf.calls[1]?.delay).toBe(MIN_REARM_MS);
    h.clock.add(MIN_REARM_MS);
    h.tf.fireLast();
    expect(await p).toEqual(stopped);
  });
  it("an early fire without clock progress is an error, not a timeout, and no ai_call is written", async () => {
    const h = harness({ provider: neverResolves });
    const p = h.run();
    await waitCalls(h, 1);
    h.tf.fireLast();
    expect(await p).toEqual(stopped);
    expect(h.status()).toEqual(pendingWith("error"));
    expect(h.count("append:ai_call")).toBe(0);
    expect(h.tf.calls[0]?.cancelled).toBe(1);
  });
  it("a timer that fires inside schedule is an error and the provider is not called", async () => {
    const h = harness({ timers: { syncFire: true } });
    expect(await h.run()).toEqual(stopped);
    expect(h.status()).toEqual(pendingWith("error"));
    expect(h.completeCalls).toHaveLength(0);
  });
  it("a clock that is not finite or throws at the fire is an error, never time_limit_reached", async () => {
    for (const breakIt of [(h: H) => h.clock.set(Number.NaN), (h: H) => { h.clock.throwing = true; }]) {
      const h = harness({ provider: neverResolves });
      const p = h.run();
      await waitCalls(h, 1);
      breakIt(h);
      h.tf.fireLast();
      expect(await p).toEqual(stopped);
      expect(h.status()).toEqual(pendingWith("error"));
      expect(h.count("append:ai_call")).toBe(0);
    }
  });
  it("a schedule that throws, or returns no usable handle, is an error and the provider is not called", async () => {
    for (const timers of [{ throwAt: 1 }, { noCancelFrom: 1 }]) {
      const h = harness({ timers });
      expect(await h.run()).toEqual(stopped);
      expect(h.status()).toEqual(pendingWith("error"));
      expect(h.completeCalls).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Run abort and the other causes
// ---------------------------------------------------------------------------------------------------------------------------------
describe("Run abort", () => {
  it("a provider that ignores the abort is left behind: the helper stops at once with the latched cause and records interrupted", async () => {
    const h = harness({ retries: 2, provider: neverResolves });
    const p = h.run();
    await waitCalls(h, 1);
    expect(h.completeCalls[0]?.opts.signal.aborted).toBe(false);
    h.session.raise("time_limit_reached");
    expect(await p).toEqual(stopped);
    expect(h.completeCalls[0]?.opts.signal.aborted).toBe(true);
    expect(h.completeCalls).toHaveLength(1);
    expect(h.status()).toEqual(pendingWith("time_limit_reached"));
    expect(h.of("ai_call")[0]?.payload.outcome).toBe("interrupted");
    expect(h.count("append:ai_rejected")).toBe(0);
    expect(h.count("gate")).toBe(0);
    expect(h.session.providerRetryCount).toBe(0);
    expect(h.tf.calls[0]?.cancelled).toBe(1);
  });
  it("Run abort and per-call timeout together: the session cause wins, in either order", async () => {
    const abortFirst = harness({ provider: neverResolves });
    const p1 = abortFirst.run();
    await waitCalls(abortFirst, 1);
    abortFirst.clock.add(30_000);
    abortFirst.session.raise("lease_unavailable");
    abortFirst.tf.fireLast();
    expect(await p1).toEqual(stopped);
    expect(abortFirst.status()).toEqual(pendingWith("lease_unavailable"));
    const timerFirst = harness({ provider: neverResolves });
    const p2 = timerFirst.run();
    await waitCalls(timerFirst, 1);
    timerFirst.clock.add(30_000);
    timerFirst.tf.fireLast(); // the timer settles the call ...
    timerFirst.session.raise("time_limit_reached"); // ... and in the same synchronous block the Run cause arrives, before the helper continues
    expect(await p2).toEqual(stopped);
    expect(timerFirst.status()).toEqual(pendingWith("time_limit_reached"));
    for (const h of [abortFirst, timerFirst]) {
      expect(h.of("ai_call").map((r) => r.payload.outcome)).toEqual(["interrupted"]);
      expect(h.count("append:ai_rejected")).toBe(0);
      expect(h.count("gate")).toBe(0);
    }
  });
  it("a Mock-like abort answer while the Run is aborted is interrupted, not a failed call, and is not retried", async () => {
    const h: H = harness({
      retries: 2,
      provider: async () => {
        h.session.raise("time_limit_reached");
        return errR("error", "aborted");
      },
    });
    expect(await h.run()).toEqual(stopped);
    expect(h.completeCalls).toHaveLength(1);
    expect(h.of("ai_call")[0]?.payload.outcome).toBe("interrupted");
    expect(h.count("gate")).toBe(0);
    expect(h.status()).toEqual(pendingWith("time_limit_reached"));
  });
  it("an interrupted ai_call that the closed writer refuses is not an extra error", async () => {
    const h = harness({ provider: neverResolves, failAt: (k) => (k === "append:ai_call" ? "admission_closed" : undefined) });
    const p = h.run();
    await waitCalls(h, 1);
    h.session.raise("time_limit_reached");
    expect(await p).toEqual(stopped);
    expect(h.status()).toEqual(pendingWith("time_limit_reached"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Failed writes after the call
// ---------------------------------------------------------------------------------------------------------------------------------
describe("failed writes after the call", () => {
  it("a failed putAiOutput raises error: no ai_call, no gate, the response is dropped", async () => {
    const h = harness({ retries: 2, failAt: (k) => (k === "putAiOutput" ? "io_failure" : undefined) });
    expect(await h.run()).toEqual(stopped);
    expect(h.count("append:ai_call")).toBe(0);
    expect(h.count("gate")).toBe(0);
    expect(h.completeCalls).toHaveLength(1);
    expect(h.status()).toEqual(pendingWith("error"));
  });
  it("a failed ai_call write raises error: the gate is not called and there is no retry", async () => {
    const h = harness({ retries: 2, failAt: (k) => (k === "append:ai_call" ? "invalid_record" : undefined) });
    expect(await h.run()).toEqual(stopped);
    expect(h.count("gate")).toBe(0);
    expect(h.completeCalls).toHaveLength(1);
    expect(h.status()).toEqual(pendingWith("error"));
  });
  it("a failed ai_rejected write raises error and no further attempt is made", async () => {
    const h = harness({ retries: 2, gate: () => unparseable(), failAt: (k) => (k === "append:ai_rejected" ? "store_failed" : undefined) });
    expect(await h.run()).toEqual(stopped);
    expect(h.completeCalls).toHaveLength(1);
    expect(h.status()).toEqual(pendingWith("error"));
    expect(h.session.providerRetryCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Audit violations
// ---------------------------------------------------------------------------------------------------------------------------------
describe("audit violations", () => {
  const violation = {
    code: "already_used",
    requestKind: "hypothesis_generation",
    claimedSha256: "c".repeat(64),
    auditedSha256: "d".repeat(64),
    recomputedSha256: "e".repeat(64),
    extra: "LEAK-EXTRA-KEY",
  };
  const expectedViolation = { code: "already_used", requestKind: "hypothesis_generation", claimedSha256: "c".repeat(64), auditedSha256: "d".repeat(64), recomputedSha256: "e".repeat(64) };
  it("a violation reported by the provider guard writes an error record with hashes only, no ai_call, raises error and is neither counted nor retried", async () => {
    const h = harness({ retries: 2, provider: async () => ({ ok: false, error: { reason: "audit_violation", detail: "LEAK-DETAIL", violation } }) });
    expect(await h.run()).toEqual(stopped);
    expect(h.completeCalls).toHaveLength(1);
    expect(h.count("append:ai_call")).toBe(0);
    expect(h.count("gate")).toBe(0);
    expect(h.of("error")).toHaveLength(1);
    expect(h.of("error")[0]?.payload).toEqual({
      code: "audit_violation",
      requestKind: "hypothesis_generation",
      attempt: 1,
      payloadAuditRecordId: h.of("payload_audit")[0]?.id,
      violation: expectedViolation,
    });
    expect(JSON.stringify(h.recs)).not.toContain("LEAK");
    expect(h.status()).toEqual(pendingWith("error"));
    expect(h.session.providerRetryCount).toBe(0);
  });
  it("a violation reported by the gate is handled the same way (the ai_call of the call already exists)", async () => {
    const h = harness({ retries: 2, gate: () => ({ kind: "audit_violation", retryable: false, stopRun: true, violation }) });
    expect(await h.run()).toEqual(stopped);
    expect(h.completeCalls).toHaveLength(1);
    expect(h.of("error")[0]?.payload.violation).toEqual(expectedViolation);
    expect(h.status()).toEqual(pendingWith("error"));
    expect(h.session.providerRetryCount).toBe(0);
    expect(JSON.stringify(h.recs)).not.toContain("LEAK");
  });
  it("a violation code outside the closed list still raises error but writes no record", async () => {
    const h = harness({ provider: async () => ({ ok: false, error: { reason: "audit_violation", detail: "x", violation: { code: "made_up" } } }) });
    expect(await h.run()).toEqual(stopped);
    expect(h.of("error")).toHaveLength(0);
    expect(h.status()).toEqual(pendingWith("error"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Provider failures and what is recorded
// ---------------------------------------------------------------------------------------------------------------------------------
describe("provider failures", () => {
  const CANARY = "CANARY-DETAIL-9f3";
  const PATH = "C:\\Users\\fictional\\secret\\path.txt";
  it.each(["error", "timeout", "unmatched_request", "tool_call_detected", "undeterminable"])(
    "a provider error with reason %s is recorded with its closed reason and no detail, then gated as a failed call",
    async (reason) => {
      const h = harness({ provider: async () => errR(reason, `${CANARY} ${PATH}`) });
      expect(await h.run()).toEqual(stopped);
      const call = h.of("ai_call")[0]?.payload;
      if (reason === "timeout") {
        expect(call).toMatchObject({ outcome: "timeout", timeoutBy: "provider" });
        expect("providerReason" in call).toBe(false);
      } else {
        expect(call).toMatchObject({ outcome: "provider_error", providerReason: reason });
        expect("timeoutBy" in call).toBe(false);
      }
      expect(h.of("ai_rejected")[0]?.payload).toMatchObject({ reason: reason === "timeout" ? "timeout" : "error", source: "provider", toolCall: reason === "tool_call_detected", providerReason: reason });
      const all = JSON.stringify(h.recs);
      expect(all).not.toContain(CANARY);
      expect(all).not.toContain("secret");
      expect(h.status()).toEqual(pendingWith("provider_failure"));
    },
  );
  it("a provider that throws or rejects is a provider error `error`; an unknown reason or a malformed result is normalized", async () => {
    const cases: [string, () => Loose, string][] = [
      ["throws", () => { throw new Error(`${CANARY}`); }, "error"],
      ["rejects", () => Promise.reject(new Error(`${CANARY}`)), "error"],
      ["unknown reason", () => Promise.resolve(errR("made_up", CANARY)), "error"],
      ["malformed", () => Promise.resolve({ ok: true, value: "not bytes" }), "undeterminable"],
      ["undefined", () => Promise.resolve(undefined), "undeterminable"],
    ];
    for (const [name, provider, reason] of cases) {
      const h = harness({ provider });
      expect(await h.run(), name).toEqual(stopped);
      expect(h.of("ai_call")[0]?.payload, name).toMatchObject({ outcome: "provider_error", providerReason: reason });
      expect(JSON.stringify(h.recs), name).not.toContain(CANARY);
    }
  });
  it("a gate rejection is recorded with codes and hashes only; the response bytes are never in a record payload", async () => {
    const SECRET = "sk-FAKE-SECRET-1234567890";
    const h = harness({ provider: async () => okBytes(`{"leak":"${SECRET} ${PATH}"}`), gate: () => unparseable() });
    expect(await h.run()).toEqual(stopped);
    expect(h.of("ai_rejected")[0]?.payload).toMatchObject({
      reason: "unparseable",
      source: "gate",
      toolCall: false,
      gate: { reason: "invalid_json", issues: [{ code: "invalid_json", path: "" }], toolCallLike: false, sha256: SHA, byteLength: 7 },
    });
    const all = JSON.stringify(h.recs);
    expect(all).not.toContain(SECRET);
    expect(all).not.toContain("secret");
    expect(new TextDecoder().decode(h.outputs[0])).toContain(SECRET); // the bytes are only in the blob path
  });
  it("the gate issues are limited to twenty", async () => {
    const many = Array.from({ length: 30 }, (_v, i) => ({ code: "bad_type", path: `/p${i}` }));
    const rejection = { ...unparseable(), gate: { ...unparseable().gate, issues: many } };
    const h = harness({ gate: () => rejection });
    await h.run();
    expect(h.of("ai_rejected")[0]?.payload.gate.issues).toHaveLength(20);
  });
  it("a malformed gate outcome raises error", async () => {
    for (const gate of [() => undefined, () => ({ kind: "weird" }), () => ({ kind: "failed_call", reason: "made_up", retryable: true, source: "gate", toolCall: false }), () => { throw new Error("gate exploded"); }]) {
      const h = harness({ gate });
      expect(await h.run()).toEqual(stopped);
      expect(h.status()).toEqual(pendingWith("error"));
      expect(h.count("append:ai_rejected")).toBe(0);
    }
  });
  it("a retry after a failed call uses a new snapshot, a new audit and a new payload_audit, and can end accepted", async () => {
    const h = harness({ retries: 1, provider: (n) => Promise.resolve(n === 1 ? errR("error") : okBytes()) });
    const res = await h.run();
    expect(res).toMatchObject({ kind: "accepted", attempt: 2 });
    expect(h.snapshots).toHaveLength(2);
    expect(h.snapshots[1]).not.toBe(h.snapshots[0]);
    expect(h.of("payload_audit").map((r) => r.payload.attempt)).toEqual([1, 2]);
    expect(h.session.providerRetryCount).toBe(1);
    expect(h.status()).toEqual({ state: "none" });
  });
});

describe("the helper never throws except for the unreadable snapshot", () => {
  it("a missing or malformed input raises error and resolves", async () => {
    const h = harness();
    expect(await callProvider({ ...h.input, writer: undefined } as Loose)).toEqual(stopped);
    expect(h.status()).toEqual(pendingWith("error"));
    const g = harness();
    expect(await callProvider({ ...g.input, kind: "something_else" } as Loose)).toEqual(stopped);
    expect(g.status()).toEqual(pendingWith("error"));
    const m = harness();
    expect(await callProvider({ ...m.input, provider: { identity: { id: 1 }, complete: () => Promise.resolve(okBytes()) } } as Loose)).toEqual(stopped);
    expect(m.status()).toEqual(pendingWith("error"));
    expect(await callProvider(undefined as Loose)).toEqual(stopped);
  });
  it("a writer whose drain rejects or whose records() throws ends with error and a resolved promise", async () => {
    const a = harness();
    (a.input.writer as Loose).drain = (): Promise<void> => Promise.reject(new Error("drain failed"));
    expect(await callProvider(a.input)).toEqual(stopped);
    expect(a.status()).toEqual(pendingWith("error"));
    const b = harness();
    (b.input.writer as Loose).records = (): never => {
      throw new Error("records exploded");
    };
    expect(await callProvider(b.input)).toEqual(stopped);
    expect(b.status()).toEqual(pendingWith("error"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------------------------------------------------------------
describe("property: calls, writes and attempts", () => {
  interface Script {
    readonly retries: number;
    readonly audits: readonly ("pass" | "blocked")[];
    readonly providers: readonly ("bytes" | "error" | "timeoutError" | "violation")[];
    readonly gates: readonly ("accept" | "unparseable")[];
    readonly failPayloadAudit: readonly boolean[];
    readonly failPutAiOutput: readonly boolean[];
    readonly failAiCall: readonly boolean[];
    readonly failAiRejected: readonly boolean[];
  }
  const N = 11;
  const arr = <T>(a: fc.Arbitrary<T>): fc.Arbitrary<readonly T[]> => fc.array(a, { minLength: N, maxLength: N });
  // a write failure is rare in a script, so that long sequences of attempts are also explored
  const rare = (): fc.Arbitrary<readonly boolean[]> => arr(fc.constantFrom(false, false, false, false, true));
  const arbitrary: fc.Arbitrary<Script> = fc.record({
    retries: fc.integer({ min: 0, max: 10 }),
    audits: arr(fc.constantFrom("pass" as const, "pass" as const, "pass" as const, "blocked" as const)),
    providers: arr(fc.constantFrom("bytes" as const, "error" as const, "timeoutError" as const, "violation" as const)),
    gates: arr(fc.constantFrom("accept" as const, "unparseable" as const)),
    failPayloadAudit: rare(),
    failPutAiOutput: rare(),
    failAiCall: rare(),
    failAiRejected: rare(),
  });
  it("the provider is called at most once per attempt, only after a passed audit and a written payload_audit, and never after a failed write", async () => {
    await fc.assert(
      fc.asyncProperty(arbitrary, async (s) => {
        const h = harness({
          retries: s.retries,
          audit: (n) => (s.audits[n - 1] === "blocked" ? { audit: blockedAudit() } : { audit: passAudit(), request: { req: n } }),
          provider: (n) => {
            const k = s.providers[n - 1];
            if (k === "bytes") return Promise.resolve(okBytes());
            if (k === "error") return Promise.resolve(errR("error"));
            if (k === "timeoutError") return Promise.resolve(errR("timeout"));
            return Promise.resolve({ ok: false, error: { reason: "audit_violation", detail: "d", violation: { code: "hash_mismatch" } } });
          },
          gate: (n, result) => {
            if (result.ok === true) return s.gates[n - 1] === "unparseable" ? unparseable() : { kind: "accepted", result: { parsed: true } };
            return { kind: "failed_call", reason: result.error.reason === "timeout" ? "timeout" : "error", retryable: true, source: "provider", providerReason: result.error.reason, toolCall: false };
          },
          failAt: (key, nth) => {
            const flags: Record<string, readonly boolean[]> = {
              "append:payload_audit": s.failPayloadAudit,
              putAiOutput: s.failPutAiOutput,
              "append:ai_call": s.failAiCall,
              "append:ai_rejected": s.failAiRejected,
            };
            return flags[key]?.[nth - 1] === true ? "io_failure" : undefined;
          },
        });
        const res = await h.run();
        const calls = h.completeCalls.length;
        const passedAudits = h.of("payload_audit").filter((r) => r.payload.result === "pass").length;
        expect(calls).toBeLessThanOrEqual(s.retries + 1);
        expect(calls).toBeLessThanOrEqual(passedAudits);
        expect(h.of("ai_call").length).toBeLessThanOrEqual(calls);
        const firstFail = h.log.findIndex((l) => l.startsWith("fail:"));
        if (firstFail >= 0) expect(h.log.slice(firstFail).includes("complete")).toBe(false);
        const violations = h.of("error").length;
        if (firstFail < 0 && violations === 0) expect(h.of("ai_call").length).toBe(calls);
        if (res.kind === "accepted") expect(h.status()).toEqual({ state: "none" });
        else expect(h.status().state).not.toBe("none");
        expect(h.of("ai_rejected").length).toBeLessThanOrEqual(h.of("ai_call").length);
      }),
      { numRuns: 100 },
    );
  });
});
