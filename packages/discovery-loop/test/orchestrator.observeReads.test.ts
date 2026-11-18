// Task 4.4, unit U3: the read observer of the Source_Bundler file system (`src/orchestrator/observeReads.ts`).
// Deterministic and offline: every file system is an in-memory object with scripted answers and a call log; no real file is read. Paths of the
// evaluation locations are taken from `PROBE_LOCATIONS` and are only strings here.
// **Validates: Requirements 15.6, 15.13, 19.7**
import { describe, expect, it } from "vitest";
import { buildSourceBundle } from "../../analyzer/src/bundle/index.js";
import { PROBE_LOCATIONS, detectIsolationViolation } from "../src/isolation/index.js";
import type { IsolationViolation } from "../src/isolation/index.js";
import * as observeModule from "../src/orchestrator/observeReads.js";
import { createReadObserver, observeAnalysisReads } from "../src/orchestrator/observeReads.js";
import type { ReadAccess, ReadObserver } from "../src/orchestrator/observeReads.js";
import type { AnalysisFsPort } from "../src/orchestrator/types.js";

type Stat = Awaited<ReturnType<AnalysisFsPort["lstat"]>>;
type Answer = { readonly kind: "ok"; readonly value: unknown } | { readonly kind: "fail"; readonly error: unknown };
interface Call {
  readonly method: "readFile" | "lstat";
  readonly path: unknown;
}

const ok = (value: unknown): Answer => ({ kind: "ok", value });
const fail = (error: unknown): Answer => ({ kind: "fail", error });
const errno = (code: string, message = "scripted failure"): Error & { code: string } => Object.assign(new Error(message), { code });
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const probe = (i: number): { readonly id: string; readonly path: string } => {
  const l = PROBE_LOCATIONS[i];
  if (l === undefined) throw new Error("no such probe location");
  return l;
};

/** In-memory file system. A call without a scripted answer rejects with ENOENT. A scripted failure rejects with the exact scripted value. */
function makeFs(answers: Readonly<Record<string, Answer>>): { readonly fs: AnalysisFsPort; readonly calls: Call[] } {
  const calls: Call[] = [];
  const answer = async (method: Call["method"], path: unknown): Promise<unknown> => {
    calls.push({ method, path });
    const a = answers[`${method}:${String(path)}`];
    if (a === undefined) throw errno("ENOENT");
    if (a.kind === "fail") throw a.error;
    return a.value;
  };
  const fs: AnalysisFsPort = {
    readFile: (path) => answer("readFile", path) as Promise<Uint8Array>,
    lstat: (path) => answer("lstat", path) as Promise<Stat>,
  };
  return { fs, calls };
}

function spyObserver(): { readonly observer: ReadObserver; readonly reports: unknown[] } {
  const reports: unknown[] = [];
  const observer: ReadObserver = {
    report: (a) => {
      reports.push(a);
    },
    firstViolation: () => undefined,
  };
  return { observer, reports };
}

/** The rejection value of a promise (also `null`, `undefined` and strings). A promise that resolves is a test failure. */
async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection, the promise resolved");
}

function withCallback(): { readonly observer: ReadObserver; readonly seen: IsolationViolation[] } {
  const seen: IsolationViolation[] = [];
  const observer = createReadObserver({
    onFirstViolation: (v) => {
      seen.push(v);
    },
  });
  return { observer, seen };
}

describe("passing reads", () => {
  it("readFile returns the very same Uint8Array and the underlying call received the same argument", async () => {
    const bytes = enc("hello");
    const { fs, calls } = makeFs({ "readFile:/a/b.php": ok(bytes) });
    const observer = createReadObserver();
    const got = await observeAnalysisReads(fs, observer).readFile("/a/b.php");
    expect(got).toBe(bytes);
    expect(calls).toEqual([{ method: "readFile", path: "/a/b.php" }]);
  });
  it("lstat returns the very same object and the underlying call received the same argument", async () => {
    const stat: Stat = { kind: "file", nlink: 1 };
    const { fs, calls } = makeFs({ "lstat:/a/b.php": ok(stat) });
    const got = await observeAnalysisReads(fs, createReadObserver()).lstat("/a/b.php");
    expect(got).toBe(stat);
    expect(calls).toEqual([{ method: "lstat", path: "/a/b.php" }]);
  });
  it("does not copy the data: a change of the returned buffer is visible in the original buffer", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { fs } = makeFs({ "readFile:/x": ok(bytes) });
    const got = await observeAnalysisReads(fs, createReadObserver()).readFile("/x");
    got[0] = 9;
    expect(bytes[0]).toBe(9);
  });
  it("makes no report on success, and nothing is latched", async () => {
    const { fs } = makeFs({ "readFile:/x": ok(enc("t")), "lstat:/x": ok({ kind: "file", nlink: 1 }) });
    const spy = spyObserver();
    const real = withCallback();
    for (const observer of [spy.observer, real.observer]) {
      const wrapped = observeAnalysisReads(fs, observer);
      await wrapped.readFile("/x");
      await wrapped.lstat("/x");
    }
    expect(spy.reports).toEqual([]);
    expect(real.observer.firstViolation()).toBeUndefined();
    expect(real.seen).toEqual([]);
  });
});

describe("order, duplicates and no extra calls", () => {
  const A = "/r/a.php";
  const B = "/r/b.php";
  const answers = {
    [`lstat:${A}`]: ok({ kind: "file", nlink: 1 }),
    [`lstat:${B}`]: ok({ kind: "file", nlink: 1 }),
    [`readFile:${A}`]: ok(enc("a")),
    [`readFile:${B}`]: ok(enc("b")),
  };
  it("a mixed sequence produces exactly the same underlying call sequence", async () => {
    const { fs, calls } = makeFs(answers);
    const wrapped = observeAnalysisReads(fs, createReadObserver());
    await wrapped.lstat(A);
    await wrapped.readFile(B);
    await wrapped.lstat(B);
    await wrapped.readFile(B);
    await wrapped.readFile(A);
    expect(calls).toEqual([
      { method: "lstat", path: A },
      { method: "readFile", path: B },
      { method: "lstat", path: B },
      { method: "readFile", path: B },
      { method: "readFile", path: A },
    ]);
  });
  it("the same path read twice is two underlying calls (no cache, no dedupe)", async () => {
    const { fs, calls } = makeFs(answers);
    const wrapped = observeAnalysisReads(fs, createReadObserver());
    await wrapped.readFile(A);
    await wrapped.readFile(A);
    await wrapped.lstat(A);
    await wrapped.lstat(A);
    expect(calls).toHaveLength(4);
  });
  it("each wrapper call makes exactly one underlying call, also when it fails", async () => {
    const { fs, calls } = makeFs({ ...answers, [`readFile:${A}`]: fail(errno("EACCES")), [`lstat:${B}`]: fail(errno("EIO")) });
    const wrapped = observeAnalysisReads(fs, createReadObserver());
    const steps: readonly (() => Promise<unknown>)[] = [() => wrapped.lstat(A), () => wrapped.readFile(B), () => wrapped.readFile(A).catch(() => undefined), () => wrapped.lstat(B).catch(() => undefined)];
    let expected = 0;
    for (const step of steps) {
      await step();
      expected += 1;
      expect(calls).toHaveLength(expected);
    }
  });
});

describe("denied reads", () => {
  it("EACCES and EPERM on readFile: op read, the original error is rethrown, the first denial is latched with the probe id", async () => {
    for (const code of ["EACCES", "EPERM"]) {
      const p = probe(3);
      const original = errno(code);
      const { fs } = makeFs({ [`readFile:${p.path}`]: fail(original) });
      const { observer, seen } = withCallback();
      const wrapped = observeAnalysisReads(fs, observer);
      expect(await rejection(wrapped.readFile(p.path))).toBe(original);
      expect(observer.firstViolation()).toEqual({ code: "isolation_violation", op: "read", errorCode: code, locationId: p.id });
      expect(observer.firstViolation()).toEqual(detectIsolationViolation({ op: "read", path: p.path, errorCode: code }));
      expect(seen).toHaveLength(1);
    }
  });
  it("EACCES and EPERM on lstat: op stat, the original error is rethrown, the first denial is latched with the probe id", async () => {
    for (const code of ["EACCES", "EPERM"]) {
      const p = probe(0);
      const original = errno(code);
      const { fs } = makeFs({ [`lstat:${p.path}`]: fail(original) });
      const { observer, seen } = withCallback();
      const wrapped = observeAnalysisReads(fs, observer);
      expect(await rejection(wrapped.lstat(p.path))).toBe(original);
      expect(observer.firstViolation()).toEqual({ code: "isolation_violation", op: "stat", errorCode: code, locationId: p.id });
      expect(seen).toHaveLength(1);
    }
  });
  it("the identity of the thrown value is kept for a plain object with a code and for a thrown string", async () => {
    const plain = { code: "EACCES" };
    const text = "just a string";
    const { fs } = makeFs({ "readFile:/plain": fail(plain), "lstat:/plain": fail(plain), "readFile:/text": fail(text), "lstat:/text": fail(text) });
    const { observer } = withCallback();
    const wrapped = observeAnalysisReads(fs, observer);
    expect(await rejection(wrapped.readFile("/text"))).toBe(text);
    expect(await rejection(wrapped.lstat("/text"))).toBe(text);
    expect(observer.firstViolation()).toBeUndefined(); // a string has no code
    expect(await rejection(wrapped.readFile("/plain"))).toBe(plain);
    expect(await rejection(wrapped.lstat("/plain"))).toBe(plain);
    expect(observer.firstViolation()).toEqual({ code: "isolation_violation", op: "read", errorCode: "EACCES", locationId: "unlisted" });
  });
  it("the location id is `unlisted` for any path that is not an exact probe path (no normalization)", async () => {
    const base = probe(0).path;
    const exact = withCallback();
    const control = makeFs({ [`lstat:${base}`]: fail(errno("EACCES")) });
    await rejection(observeAnalysisReads(control.fs, exact.observer).lstat(base));
    expect(exact.observer.firstViolation()?.locationId).toBe(probe(0).id);
    for (const path of [`${base}/`, `${base}/../evaluation`, "/repo/evaluation/./", "/repo//evaluation", "/srv/other/file.php", "relative/path.php"]) {
      const { fs } = makeFs({ [`lstat:${path}`]: fail(errno("EACCES")) });
      const { observer } = withCallback();
      await rejection(observeAnalysisReads(fs, observer).lstat(path));
      expect(observer.firstViolation(), path).toEqual({ code: "isolation_violation", op: "stat", errorCode: "EACCES", locationId: "unlisted" });
    }
  });
  it("the violation is frozen, has exactly four keys, and contains no path (also for a probe path)", async () => {
    for (const path of [probe(3).path, "/srv/other/file.php"]) {
      const { fs } = makeFs({ [`readFile:${path}`]: fail(errno("EACCES")) });
      const { observer, seen } = withCallback();
      await rejection(observeAnalysisReads(fs, observer).readFile(path));
      const v = observer.firstViolation();
      expect(v).toBeDefined();
      expect(Object.isFrozen(v)).toBe(true);
      expect(Object.keys(v as object).sort()).toEqual(["code", "errorCode", "locationId", "op"]);
      expect(JSON.stringify(v)).not.toContain(path);
      expect(JSON.stringify(seen)).not.toContain(path);
    }
  });
  it("a call whose path is not a string is forwarded unchanged, and is reported with an empty path (`unlisted`)", async () => {
    const original = errno("EACCES");
    const { fs, calls } = makeFs({ "readFile:42": fail(original) });
    const { observer } = withCallback();
    const wrapped = observeAnalysisReads(fs, observer);
    const loose = wrapped.readFile as unknown as (p: unknown) => Promise<Uint8Array>;
    expect(await rejection(loose(42))).toBe(original);
    expect(calls).toEqual([{ method: "readFile", path: 42 }]);
    expect(observer.firstViolation()).toEqual({ code: "isolation_violation", op: "read", errorCode: "EACCES", locationId: "unlisted" });
  });
});

describe("first denial wins", () => {
  it("a second denial (other op, path and code) changes nothing and does not call the callback again", async () => {
    const first = errno("EPERM");
    const second = errno("EACCES");
    const { fs } = makeFs({ [`lstat:${probe(0).path}`]: fail(first), [`readFile:${probe(3).path}`]: fail(second) });
    const { observer, seen } = withCallback();
    const wrapped = observeAnalysisReads(fs, observer);
    expect(await rejection(wrapped.lstat(probe(0).path))).toBe(first);
    const latched = observer.firstViolation();
    expect(await rejection(wrapped.readFile(probe(3).path))).toBe(second); // the second error still reaches the caller
    expect(observer.firstViolation()).toBe(latched);
    expect(latched).toEqual({ code: "isolation_violation", op: "stat", errorCode: "EPERM", locationId: probe(0).id });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(latched);
  });
  it("the callback runs synchronously, before the original error reaches the caller of the wrapper", async () => {
    const events: string[] = [];
    const observer = createReadObserver({
      onFirstViolation: () => {
        events.push("callback");
      },
    });
    const { fs } = makeFs({ "readFile:/p": fail(errno("EACCES")) });
    const settled = observeAnalysisReads(fs, observer)
      .readFile("/p")
      .then(
        () => {
          events.push("resolved");
        },
        () => {
          events.push("rejected");
        },
      );
    await settled;
    expect(events).toEqual(["callback", "rejected"]);
    // at the level of the observer: the callback has run when `report` returns
    const direct: string[] = [];
    const o2 = createReadObserver({
      onFirstViolation: () => {
        direct.push("callback");
      },
    });
    o2.report({ op: "read", path: "/p", errorCode: "EACCES" });
    direct.push("returned");
    expect(direct).toEqual(["callback", "returned"]);
  });
  it("a callback that throws does not change the thrown error, and the violation stays latched", async () => {
    const original = errno("EACCES");
    const { fs } = makeFs({ "lstat:/p": fail(original) });
    let calls = 0;
    const observer = createReadObserver({
      onFirstViolation: () => {
        calls += 1;
        throw new Error("callback failed");
      },
    });
    expect(await rejection(observeAnalysisReads(fs, observer).lstat("/p"))).toBe(original);
    expect(calls).toBe(1);
    expect(observer.firstViolation()).toEqual({ code: "isolation_violation", op: "stat", errorCode: "EACCES", locationId: "unlisted" });
    expect(() => observer.report({ op: "read", path: "/q", errorCode: "EPERM" })).not.toThrow();
    expect(calls).toBe(1);
  });
});

describe("failures that are not a denial", () => {
  it("ENOENT, ENOTDIR, EISDIR, EIO and ETIMEDOUT are not violations; the original rejection is rethrown unchanged", async () => {
    for (const code of ["ENOENT", "ENOTDIR", "EISDIR", "EIO", "ETIMEDOUT"]) {
      const original = errno(code);
      const { fs } = makeFs({ "readFile:/p": fail(original), "lstat:/p": fail(original) });
      const { observer, seen } = withCallback();
      const wrapped = observeAnalysisReads(fs, observer);
      expect(await rejection(wrapped.readFile("/p")), code).toBe(original);
      expect(await rejection(wrapped.lstat("/p")), code).toBe(original);
      expect(observer.firstViolation(), code).toBeUndefined();
      expect(seen, code).toEqual([]);
    }
  });
  it("a rejection without a usable string code is rethrown unchanged and is not even reported", async () => {
    const hostile = {
      get code(): string {
        throw new Error("getter failed");
      },
    };
    const values: readonly unknown[] = [new Error("no code"), hostile, { code: 13 }, { code: undefined }, null, undefined, "EACCES", 13];
    for (const value of values) {
      const { fs } = makeFs({ "readFile:/p": fail(value), "lstat:/p": fail(value) });
      const spy = spyObserver();
      const real = withCallback();
      for (const observer of [spy.observer, real.observer]) {
        const wrapped = observeAnalysisReads(fs, observer);
        expect(await rejection(wrapped.readFile("/p"))).toBe(value);
        expect(await rejection(wrapped.lstat("/p"))).toBe(value);
      }
      expect(spy.reports).toEqual([]);
      expect(real.observer.firstViolation()).toBeUndefined();
      expect(real.seen).toEqual([]);
    }
  });
});

describe("a failing observer cannot change the outcome", () => {
  it("with a `report` that throws: the original result or the original error still comes out", async () => {
    const bytes = enc("x");
    const denied = errno("EACCES");
    const other = errno("EIO");
    const { fs } = makeFs({ "readFile:/ok": ok(bytes), "readFile:/denied": fail(denied), "lstat:/other": fail(other) });
    const observer: ReadObserver = {
      report: () => {
        throw new Error("observer down");
      },
      firstViolation: () => undefined,
    };
    const wrapped = observeAnalysisReads(fs, observer);
    expect(await wrapped.readFile("/ok")).toBe(bytes);
    expect(await rejection(wrapped.readFile("/denied"))).toBe(denied);
    expect(await rejection(wrapped.lstat("/other"))).toBe(other);
  });
  it("with an observer that has no `report` function: the same", async () => {
    const denied = errno("EPERM");
    const { fs } = makeFs({ "lstat:/denied": fail(denied) });
    const wrapped = observeAnalysisReads(fs, {} as unknown as ReadObserver);
    expect(await rejection(wrapped.lstat("/denied"))).toBe(denied);
  });
  it("`report` never throws on hostile input and a throwing report input latches nothing", () => {
    const observer = createReadObserver();
    const badOp = { get op(): string { throw new Error("x"); }, path: "/p", errorCode: "EACCES" };
    const badCode = { op: "read", path: "/p", get errorCode(): string { throw new Error("x"); } };
    for (const input of [badOp, badCode, null, undefined, 5, "EACCES"]) {
      expect(() => observer.report(input as unknown as ReadAccess)).not.toThrow();
    }
    expect(observer.firstViolation()).toBeUndefined();
  });
});

describe("observer isolation", () => {
  it("only `op`, `path` and `errorCode`, all strings, ever reach the observer; no data of the file", async () => {
    const MSG = "MESSAGE_CANARY_41";
    const BYTES = "BYTES_CANARY_52";
    const denied = errno("EACCES", MSG);
    const { fs } = makeFs({ "readFile:/good": ok(enc(BYTES)), "readFile:/bad": fail(denied), "lstat:/bad": fail(errno("EPERM", MSG)) });
    const { observer, reports } = spyObserver();
    const wrapped = observeAnalysisReads(fs, observer);
    await wrapped.readFile("/good");
    await rejection(wrapped.readFile("/bad"));
    await rejection(wrapped.lstat("/bad"));
    expect(reports).toHaveLength(2);
    for (const r of reports) {
      expect(Object.keys(r as object).sort()).toEqual(["errorCode", "op", "path"]);
      for (const v of Object.values(r as Record<string, unknown>)) expect(typeof v).toBe("string");
      expect(JSON.stringify(r)).not.toContain(MSG);
      expect(JSON.stringify(r)).not.toContain(BYTES);
    }
    expect(reports).toEqual([
      { op: "read", path: "/bad", errorCode: "EACCES" },
      { op: "stat", path: "/bad", errorCode: "EPERM" },
    ]);
  });
  it("the observer keeps no list: its members are exactly `report` and `firstViolation`, and it is frozen", () => {
    const observer = createReadObserver();
    expect(Object.keys(observer)).toEqual(["report", "firstViolation"]);
    expect(Object.isFrozen(observer)).toBe(true);
    expect(Object.getOwnPropertySymbols(observer)).toEqual([]);
    expect(Object.values(observer).every((v) => typeof v === "function")).toBe(true);
    expect(JSON.stringify(observer)).toBe("{}");
  });
  it("two observers and two wrapped file systems do not share state", async () => {
    const one = withCallback();
    const two = withCallback();
    const a = makeFs({ "readFile:/p": fail(errno("EACCES")) });
    const b = makeFs({ "readFile:/p": ok(enc("fine")) });
    const wa = observeAnalysisReads(a.fs, one.observer);
    const wb = observeAnalysisReads(b.fs, two.observer);
    await rejection(wa.readFile("/p"));
    await wb.readFile("/p");
    expect(one.observer.firstViolation()).toBeDefined();
    expect(two.observer.firstViolation()).toBeUndefined();
    expect(one.seen).toHaveLength(1);
    expect(two.seen).toHaveLength(0);
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });
  it("the wrapped file system is a new frozen object with exactly `readFile` and `lstat`, and exposes neither the original nor the observer", async () => {
    const bytes = enc("t");
    const { fs } = makeFs({ "readFile:/p": ok(bytes) });
    const observer = createReadObserver();
    const wrapped = observeAnalysisReads(fs, observer);
    expect(wrapped).not.toBe(fs);
    expect(Object.isFrozen(wrapped)).toBe(true);
    expect(Object.keys(wrapped)).toEqual(["readFile", "lstat"]);
    expect(Object.getOwnPropertyNames(wrapped).sort()).toEqual(["lstat", "readFile"]);
    expect(Object.getOwnPropertySymbols(wrapped)).toEqual([]);
    expect(Object.values(wrapped).some((v) => (v as unknown) === fs || (v as unknown) === observer)).toBe(false);
    expect("fs" in wrapped || "observer" in wrapped).toBe(false);
    expect(JSON.stringify(wrapped)).toBe("{}");
    const { readFile } = wrapped; // the methods do not depend on `this`
    expect(await readFile("/p")).toBe(bytes);
  });
  it("the module exports exactly the two runtime names", () => {
    expect(Object.keys(observeModule).sort()).toEqual(["createReadObserver", "observeAnalysisReads"]);
  });
});

describe("no secret or payload leaves through the observer", () => {
  const PATH_CANARY = "PATH_CANARY_77";
  const MSG_CANARY = "MSG_CANARY_88";
  const BYTES_CANARY = "BYTES_CANARY_99";
  it("canaries in the path, the message and the bytes appear neither in the violation nor in the callback argument nor in the observer", async () => {
    const path = `/srv/${PATH_CANARY}/a.php`;
    const { fs } = makeFs({ [`readFile:${path}`]: fail(errno("EACCES", `denied ${MSG_CANARY}`)), "readFile:/good": ok(enc(BYTES_CANARY)) });
    const { observer, seen } = withCallback();
    const wrapped = observeAnalysisReads(fs, observer);
    await wrapped.readFile("/good");
    await rejection(wrapped.readFile(path));
    const texts = [JSON.stringify(observer.firstViolation()), JSON.stringify(seen), JSON.stringify(observer)];
    for (const t of texts) for (const c of [PATH_CANARY, MSG_CANARY, BYTES_CANARY]) expect(t).not.toContain(c);
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0] as object).sort()).toEqual(["code", "errorCode", "locationId", "op"]);
    expect(observer.firstViolation()?.errorCode).toBe("EACCES");
  });
  it("an unusual code string that equals a canary is not a denial: nothing is latched", async () => {
    const original = errno(PATH_CANARY, MSG_CANARY);
    const { fs } = makeFs({ "readFile:/p": fail(original), "lstat:/p": fail(original) });
    const { observer, seen } = withCallback();
    const wrapped = observeAnalysisReads(fs, observer);
    expect(await rejection(wrapped.readFile("/p"))).toBe(original);
    expect(await rejection(wrapped.lstat("/p"))).toBe(original);
    expect(observer.firstViolation()).toBeUndefined();
    expect(seen).toEqual([]);
  });
});

describe("the real Source_Bundler through the wrapper", () => {
  const ROOT = "/fixture-root";
  const JSON_PATH = `${ROOT}/docs/ai-input-allowlist.json`;
  const MD_PATH = `${ROOT}/docs/ai-input-allowlist.md`;
  const FILE_PATH = `${ROOT}/legacy/src/a.php`;
  const JSON_DOC = JSON.stringify({ schema_version: 1, files: ["legacy/src/a.php"] });
  const MD_DOC = ["### Allowed", "", "| File | Reason |", "| --- | --- |", "| `legacy/src/a.php` | fixture entry |", ""].join("\n");
  const SRC_TEXT = "<?php\necho 1;\n";
  const answers = (extra: Readonly<Record<string, Answer>> = {}): Record<string, Answer> => ({
    [`readFile:${JSON_PATH}`]: ok(enc(JSON_DOC)),
    [`readFile:${MD_PATH}`]: ok(enc(MD_DOC)),
    [`lstat:${ROOT}/legacy`]: ok({ kind: "dir", nlink: 2 }),
    [`lstat:${ROOT}/legacy/src`]: ok({ kind: "dir", nlink: 2 }),
    [`lstat:${FILE_PATH}`]: ok({ kind: "file", nlink: 1 }),
    [`readFile:${FILE_PATH}`]: ok(enc(SRC_TEXT)),
    ...extra,
  });
  const errorCodeOf = (r: Awaited<ReturnType<typeof buildSourceBundle>>): string | undefined => (r.ok ? undefined : r.error.code);

  it("(a) the bundle builds through the wrapper, the underlying file system gets the bundler's calls in order, nothing is latched", async () => {
    const { fs, calls } = makeFs(answers());
    const { observer, seen } = withCallback();
    const result = await buildSourceBundle(observeAnalysisReads(fs, observer), ROOT);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.files).toEqual([{ path: "legacy/src/a.php", text: SRC_TEXT }]);
    expect(calls).toEqual([
      { method: "readFile", path: JSON_PATH },
      { method: "readFile", path: MD_PATH },
      { method: "lstat", path: `${ROOT}/legacy` },
      { method: "lstat", path: `${ROOT}/legacy/src` },
      { method: "lstat", path: FILE_PATH },
      { method: "readFile", path: FILE_PATH },
    ]);
    expect(observer.firstViolation()).toBeUndefined();
    expect(seen).toEqual([]);
  });
  it("(b1) a denied lstat of the allowlisted source: no bundle (fail closed), the violation is latched with op stat, the callback fired once", async () => {
    const { fs, calls } = makeFs(answers({ [`lstat:${FILE_PATH}`]: fail(errno("EACCES")) }));
    const { observer, seen } = withCallback();
    const result = await buildSourceBundle(observeAnalysisReads(fs, observer), ROOT);
    expect(result.ok).toBe(false);
    expect(errorCodeOf(result)).toBe("entry_unreadable");
    expect(observer.firstViolation()).toEqual({ code: "isolation_violation", op: "stat", errorCode: "EACCES", locationId: "unlisted" });
    expect(seen).toHaveLength(1);
    expect(calls).toHaveLength(5); // the source file itself was never read
  });
  it("(b2) a denied readFile of the allowlisted source: no bundle (fail closed), the violation is latched with op read, the callback fired once", async () => {
    const { fs, calls } = makeFs(answers({ [`readFile:${FILE_PATH}`]: fail(errno("EPERM")) }));
    const { observer, seen } = withCallback();
    const result = await buildSourceBundle(observeAnalysisReads(fs, observer), ROOT);
    expect(result.ok).toBe(false);
    expect(errorCodeOf(result)).toBe("entry_unreadable");
    expect(observer.firstViolation()).toEqual({ code: "isolation_violation", op: "read", errorCode: "EPERM", locationId: "unlisted" });
    expect(seen).toHaveLength(1);
    expect(calls).toHaveLength(6);
  });
  it("(c) the same denial on a probe path, asked of the wrapper directly, is mapped to the probe id", async () => {
    const p = probe(1);
    const { fs } = makeFs(answers({ [`lstat:${p.path}`]: fail(errno("EACCES")), [`readFile:${p.path}`]: fail(errno("EACCES")) }));
    for (const op of ["stat", "read"] as const) {
      const { observer } = withCallback();
      const wrapped = observeAnalysisReads(fs, observer);
      await rejection(op === "stat" ? wrapped.lstat(p.path) : wrapped.readFile(p.path));
      expect(observer.firstViolation()).toEqual({ code: "isolation_violation", op, errorCode: "EACCES", locationId: p.id });
    }
  });
  it("ENOENT keeps its meaning for the bundler (`entry_missing`) and is not a violation", async () => {
    const { fs } = makeFs(answers({ [`lstat:${FILE_PATH}`]: fail(errno("ENOENT")) }));
    const { observer, seen } = withCallback();
    const result = await buildSourceBundle(observeAnalysisReads(fs, observer), ROOT);
    expect(errorCodeOf(result)).toBe("entry_missing");
    expect(observer.firstViolation()).toBeUndefined();
    expect(seen).toEqual([]);
  });
  it("EIO keeps its meaning for the bundler (`entry_unreadable`) and is not a violation", async () => {
    const { fs } = makeFs(answers({ [`readFile:${FILE_PATH}`]: fail(errno("EIO")) }));
    const { observer, seen } = withCallback();
    const result = await buildSourceBundle(observeAnalysisReads(fs, observer), ROOT);
    expect(errorCodeOf(result)).toBe("entry_unreadable");
    expect(observer.firstViolation()).toBeUndefined();
    expect(seen).toEqual([]);
  });
});
