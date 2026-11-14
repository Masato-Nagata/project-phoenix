// Feature: discovery-loop, Property 34: The Run_Lease gates every request
// **Validates: Requirements 9.4, 9.5, 24.9, 24.12, 24.15**
//
// Over generated settings (H, S inside their ranges and the three rules for a generated D), a fake monotonic clock and scripted
// beat sequences:
//   - a healthy writer (beats at most H apart, delays up to D, jitter up to J) is never judged invalid, at the start-up proof or later;
//   - a writer that was already stopped at start never passes the proof, and no request is sent;
//   - a writer that stops is judged invalid no earlier than S and no later than S + P after the last change the runtime saw;
//   - a counter decrease is `malformed` and the lease never becomes valid again;
//   - a reading failure shorter than U never ends the Run and never lets a request through before the reading is determinate;
//   - an indeterminate reading for U ends the Run as `unreadable` (`lease_unavailable`), exactly at U, with no request sent.
// Reproducibility record: SEED = 340034, NUM_RUNS = 200. The model of the writer is described at `worldArb`.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { JITTER_ALLOWANCE_MS, LeaseWatcher, RunLease, checkLeaseTiming, terminationReasonOf, type LeaseState, type LeaseTiming } from "../src/index.js";
import { ERROR, FakeLeaseDir, FakeTime, NONCE, RUN_ID, leaseJsonOf, ok, ABSENT } from "./helpers/leaseFixtures.js";

const SEED = 340034;
const NUM_RUNS = 200;
const TIMEOUT_MS = 120_000;
const BEATS = 120;

interface World {
  timing: LeaseTiming;
  /** Phase of the first beat before the container starts: the first beat was visible `phase` ms before t = 0. */
  phase: number;
  jitter: number[];
  delay: number[];
}

/**
 * The writer: beat k (k = 1, 2, ...) is written at w_k = -phase + (k - 1) H + j_k (jitter j_k in [0, J], j_1 = 0) and becomes visible
 * at w_k + d_k (delay d_k in [0, D], d_1 = 0). The runtime reads the largest k visible at its time, for k up to `lastBeat`.
 */
function counterAt(w: World, t: number, lastBeat: number): number {
  let best = 1;
  for (let k = 1; k <= Math.min(lastBeat, BEATS); k += 1) {
    const visible = -w.phase + (k - 1) * w.timing.heartbeatIntervalMs + (k === 1 ? 0 : (w.jitter[k - 1] ?? 0) + (w.delay[k - 1] ?? 0));
    if (visible <= t) best = Math.max(best, k);
  }
  return best;
}

const worldArb: fc.Arbitrary<World> = fc
  .integer({ min: 500, max: 2000 })
  .chain((h) =>
    fc.integer({ min: 3 * h, max: 6000 }).chain((s) => {
      const p = Math.min(500, h / 2);
      const maxD = Math.max(0, Math.floor(Math.min(s - h - 2 * p - JITTER_ALLOWANCE_MS, 10000 - s - p - 2000)));
      return fc.tuple(
        fc.integer({ min: 0, max: maxD }),
        fc.integer({ min: 0, max: h - 1 }),
        fc.array(fc.integer({ min: 0, max: JITTER_ALLOWANCE_MS }), { minLength: BEATS, maxLength: BEATS }),
        fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: BEATS, maxLength: BEATS }),
      ).map(([d, phase, jitter, delayUnit]): World => {
        const timing = checkLeaseTiming({ heartbeatIntervalMs: h, staleAfterMs: s }, d);
        if (!timing.ok) throw new Error(`generated timing is invalid: ${timing.error.join(",")}`);
        return { timing: timing.value, phase, jitter, delay: delayUnit.map((u) => Math.floor(u * d)) };
      });
    }),
  );

function setup(w: World, lastBeat: number, extra: Partial<ConstructorParameters<typeof FakeLeaseDir>[1]> = {}) {
  const time = new FakeTime();
  const dir = new FakeLeaseDir(time, {
    leaseJson: ok(leaseJsonOf({}, w.timing.heartbeatIntervalMs, w.timing.staleAfterMs)),
    heartbeat: (t) => ok(String(counterAt(w, t, lastBeat))),
    ...extra,
  });
  const watcher = new LeaseWatcher({ view: dir, clock: time, runId: RUN_ID, nonce: NONCE, timing: w.timing });
  const lease = new RunLease({ watcher, clock: time, sleeper: time, timing: w.timing });
  /** A request is sent only if the lease says valid; the count is what the property talks about. */
  const sends: number[] = [];
  const trySend = async (): Promise<LeaseState> => {
    const state = await lease.check();
    if (state.valid) sends.push(time.t);
    return state;
  };
  return { time, dir, lease, sends, trySend };
}

describe(`Property 34: the Run_Lease gates every request (seed ${SEED}, numRuns ${NUM_RUNS})`, () => {
  it("a healthy writer is never judged invalid: the proof passes and every later check is valid", async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, fc.array(fc.nat(), { minLength: 40, maxLength: 80 }), async (w, jumps) => {
        const { time, lease, sends, trySend } = setup(w, BEATS);
        const first = await trySend();
        expect(first).toEqual({ valid: true });
        expect(lease.isProven).toBe(true);
        // The proof ends at the first change seen: no later than H + J + D + P after the start.
        expect(time.t).toBeLessThanOrEqual(w.timing.heartbeatIntervalMs + JITTER_ALLOWANCE_MS + w.timing.propagationDelayMs + w.timing.watchIntervalMs);
        for (const j of jumps) {
          time.t += 1 + (j % (2 * w.timing.watchIntervalMs)); // checks at irregular times, up to 2 P apart
          const state = await trySend();
          expect(state, `at t = ${time.t}`).toEqual({ valid: true });
        }
        expect(sends.length).toBe(jumps.length + 1);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("a writer that was already stopped at start never passes the proof, and no request is sent", async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, async (w) => {
        const { time, lease, sends, trySend } = setup(w, 1); // only the first beat ever existed
        const state = await trySend();
        expect(state.valid).toBe(false);
        if (state.valid) return;
        expect(state.reason).toBe("heartbeat_stale");
        expect(terminationReasonOf(state)).toBe("launcher_killed");
        expect(sends).toEqual([]);
        expect(lease.isProven).toBe(false);
        expect(time.t).toBeGreaterThanOrEqual(w.timing.staleAfterMs);
        expect(time.t).toBeLessThanOrEqual(w.timing.staleAfterMs + w.timing.watchIntervalMs);
        expect((await trySend()).valid).toBe(false); // refused for good
        expect(sends).toEqual([]);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("a writer that stops is judged invalid no earlier than S and no later than S + P after the last change that was seen", async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, fc.integer({ min: 2, max: 30 }), async (w, lastBeat) => {
        const { time, dir, lease, sends, trySend } = setup(w, lastBeat);
        // Remember when each counter value was first read.
        const firstRead = new Map<string, number>();
        const inner = dir.heartbeat;
        dir.heartbeat = (t) => {
          const r = typeof inner === "function" ? inner(t) : inner;
          if (r.kind === "ok" && !firstRead.has(r.text)) firstRead.set(r.text, t);
          return r;
        };
        // lastBeat >= 2 means the proof can pass: a change comes within H + J + D + P of the start.
        const start = await trySend();
        expect(start).toEqual({ valid: true });
        let invalidAt: number | undefined;
        const P = w.timing.watchIntervalMs;
        for (let i = 0; i < 400 && invalidAt === undefined; i += 1) {
          time.t += P; // the watcher polls every P
          const state = await trySend();
          if (!state.valid) {
            invalidAt = time.t;
            expect(state.reason).toBe("heartbeat_stale");
          }
        }
        expect(invalidAt).toBeDefined();
        const last = String(counterAt(w, 10 * 60 * 1000, lastBeat));
        const lastSeen = firstRead.get(last) as number;
        expect(invalidAt as number - lastSeen).toBeGreaterThanOrEqual(w.timing.staleAfterMs);
        expect(invalidAt as number - lastSeen).toBeLessThanOrEqual(w.timing.staleAfterMs + P);
        // No request was sent after the lease became invalid.
        expect(sends.every((t) => t < (invalidAt as number))).toBe(true);
        expect(lease.isProven).toBe(true);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("a counter decrease is malformed (counter_decreased), and the lease never becomes valid again", async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, fc.integer({ min: 1, max: 5000 }), async (w, after) => {
        const { time, dir, lease, trySend } = setup(w, BEATS);
        expect(await trySend()).toEqual({ valid: true });
        const dropAt = time.t + after;
        const inner = dir.heartbeat;
        dir.heartbeat = (t) => {
          const r = typeof inner === "function" ? inner(t) : inner;
          if (t < dropAt || r.kind !== "ok") return r;
          return ok("1"); // below every value seen so far (the proof saw a change, so the highest value seen is at least 2)
        };
        let seenInvalid: LeaseState | undefined;
        for (let i = 0; i < 400 && seenInvalid === undefined; i += 1) {
          time.t += w.timing.watchIntervalMs;
          const state = await trySend();
          if (!state.valid) seenInvalid = state;
        }
        expect(seenInvalid).toMatchObject({ valid: false, reason: "malformed", cause: "counter_decreased" });
        // The files recover; the lease does not.
        dir.heartbeat = (t) => ok(String(counterAt(w, t, BEATS) + 1000));
        for (let i = 0; i < 5; i += 1) {
          time.t += 100;
          expect((await lease.check()).valid).toBe(false);
        }
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("a reading failure shorter than U never ends the Run, and no request is sent before the reading is determinate", async () => {
    await fc.assert(
      fc.asyncProperty(
        worldArb,
        fc.constantFrom("leaseJson", "revoked"),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.integer({ min: 0, max: 3000 }),
        async (w, file, unit, gap) => {
          const { time, dir, lease, sends, trySend } = setup(w, BEATS);
          expect(await trySend()).toEqual({ valid: true });
          time.t += gap;
          const U = w.timing.holdLimitMs;
          const start = time.t;
          const len = 1 + Math.floor(unit * (U - 2)); // 1 .. U - 1
          const sound = file === "leaseJson" ? ok(leaseJsonOf({}, w.timing.heartbeatIntervalMs, w.timing.staleAfterMs)) : ABSENT;
          const source = (t: number) => (t < start + len ? ERROR : sound);
          if (file === "leaseJson") dir.leaseJson = source;
          else dir.revoked = source;
          const sendsBefore = sends.length;
          const state = await trySend();
          expect(state).toEqual({ valid: true });
          expect(sends.length).toBe(sendsBefore + 1);
          expect(sends[sends.length - 1] as number).toBeGreaterThanOrEqual(start + len); // held until the reading was determinate
          expect(time.t).toBeLessThanOrEqual(start + len + Math.max(100, w.timing.watchIntervalMs));
          expect(lease.isProven).toBe(true);
        },
      ),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);

  it("an indeterminate reading for U ends the Run as unreadable (lease_unavailable), exactly at U, with no request sent", async () => {
    await fc.assert(
      fc.asyncProperty(worldArb, fc.constantFrom("leaseJson", "revoked"), fc.integer({ min: 0, max: 3000 }), async (w, file, gap) => {
        const { time, dir, sends, trySend } = setup(w, BEATS);
        expect(await trySend()).toEqual({ valid: true });
        time.t += gap;
        const start = time.t;
        if (file === "leaseJson") dir.leaseJson = ERROR;
        else dir.revoked = ERROR;
        const before = sends.length;
        const state = await trySend();
        expect(state).toMatchObject({ valid: false, reason: "unreadable", cause: "read_hold_expired" });
        if (state.valid) return;
        expect(terminationReasonOf(state)).toBe("lease_unavailable");
        expect(time.t).toBe(start + w.timing.holdLimitMs);
        expect(sends.length).toBe(before);
        expect((await trySend()).valid).toBe(false);
        expect(sends.length).toBe(before);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  }, TIMEOUT_MS);
});