// Task 4.1, acceptance item G1: a refused start-up leaves the output directories as they were, byte for byte.
//
// SCOPE. These tests show that stage A (`validateRunConfig`) and stage B (`checkStartupRefusals`, with the real adapters over temporary directories)
// create, change and delete nothing. They do NOT start the Launcher, do NOT create a Run_Volume, and do NOT show that R15.11 ("an invalid configuration
// creates no Run_Volume") holds for the whole system: that guarantee belongs to the Launcher and is verified with tasks 4.9 and 4.14.
// Synthetic data only; every directory is a temporary one.
import fc from "fast-check";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkStartupRefusals, validateRunConfig, type RunConfig, type StartupRefusal } from "../src/index.js";
import { makeTempDir, syntheticAuditConfig, toBytes } from "./support/startupAdapters.js";
import { scene, snapshotDirs, type Scene, type SceneOptions } from "./support/startupWorld.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const config = (over: Record<string, unknown> = {}): RunConfig => {
  const r = validateRunConfig({
    schemaVersion: 1, provider: "mock", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames: ["EXAMPLE_ONE"], ...over,
  });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const narrowed = (): unknown => {
  const raw = JSON.parse(readFileSync(new URL("../../verifier/data/policy-config.json", import.meta.url), "utf8")) as Any;
  raw.limits.requests = 5;
  raw.limits.bodyBytes = 4096;
  return raw;
};
/** Everything the runtime may touch is compared, except the heartbeat, which the Launcher (here: the fake sleeper) writes. */
const ignoreHeartbeat = (label: string, relative: string): boolean => label === "lease" && relative === "heartbeat";

interface Case {
  readonly name: string;
  readonly codes: readonly string[]; // codes that must be among the refusals
  readonly options: SceneOptions;
  readonly cfg?: () => RunConfig;
  readonly ports?: (s: Scene) => Any;
}
const KIRO = (): RunConfig => config({ provider: "kiro-cli" });
const CASES: readonly Case[] = [
  { name: "policy narrowed below the configuration", codes: ["above_policy_limit"], options: { policy: narrowed } },
  { name: "policy invalid", codes: ["policy_invalid"], options: { policy: () => ({ schemaVersion: 1 }) } },
  { name: "preparation table invalid", codes: ["preparation_table_invalid"], options: { table: () => ({ schemaVersion: 2 }) } },
  { name: "audit configuration missing", codes: ["audit_config_missing"], options: { audit: () => undefined } },
  { name: "audit configuration invalid", codes: ["audit_config_invalid"], options: { audit: () => new TextEncoder().encode("not json") } },
  { name: "credential unset and no provider (kiro-cli)", codes: ["credential_unset", "provider_not_available"], options: { env: { PHOENIX_RUN_ID: "run-synthetic-0001", PHOENIX_LEASE_NONCE: "synthetic-nonce-0001", PHOENIX_LEASE_D_MS: "50" } }, cfg: KIRO },
  { name: "no destination list (kiro-cli)", codes: ["sandbox_destinations_undetermined"], options: {}, cfg: KIRO },
  { name: "lease variables missing", codes: ["lease_env_missing"], options: { env: { PHOENIX_LEASE_D_MS: "50" } } },
  { name: "lease timing invalid", codes: ["lease_timing_invalid"], options: { env: { PHOENIX_RUN_ID: "run-synthetic-0001", PHOENIX_LEASE_NONCE: "synthetic-nonce-0001" } } },
  { name: "lease heartbeat stale (the proof ran and refused)", codes: ["lease_invalid"], options: { beat: false } },
  { name: "lease revoked", codes: ["lease_invalid"], options: { revoked: true } },
  { name: "volume not empty (existing files must survive)", codes: ["run_volume_not_empty"], options: { volume: "populated" } },
  { name: "volume missing (it must not be created)", codes: ["run_volume_missing"], options: { volume: "missing" } },
  { name: "an extra config file", codes: ["config_files_unexpected"], options: { configFiles: ["run-config.json", "audit-config.json", "other.json"] } },
  { name: "a missing config file", codes: ["config_files_unexpected"], options: { configFiles: ["run-config.json"] } },
  { name: "config directory missing (it must not be created)", codes: ["io_unreadable"], options: { configFiles: "missing" } },
  {
    name: "a port that throws",
    codes: ["port_failed"],
    options: {},
    ports: (s) => ({ ...s.ports, policy: { load: () => { throw new Error("synthetic failure"); } } }),
  },
  {
    name: "several refusals at once",
    codes: ["above_policy_limit", "audit_config_missing", "run_volume_not_empty", "config_files_unexpected"],
    options: { policy: narrowed, audit: () => undefined, volume: "populated", configFiles: ["run-config.json", "audit-config.json", "extra.json"] },
  },
];

describe("G1: a refused start-up leaves the directories byte-identical (stage B, real adapters, temporary directories)", () => {
  for (const c of CASES) {
    it(`${c.name}: refused, and no name, kind or byte changed`, async () => {
      const s = scene(c.options);
      try {
        const before = snapshotDirs(s.dirs);
        const r = await checkStartupRefusals((c.cfg ?? (() => config()))(), c.ports === undefined ? s.ports : c.ports(s));
        expect(r.ok, c.name).toBe(false);
        const codes = r.ok ? [] : r.error.map((e: StartupRefusal) => e.code);
        for (const code of c.codes) expect(codes, c.name).toContain(code);
        const after = snapshotDirs(s.dirs);
        expect(after, c.name).toEqual(before);
        // the volume and the config directory in particular
        if (c.options.volume === "missing") expect(after["root:volume"]).toBeUndefined();
        if (c.options.configFiles === "missing") expect(after["root:config"]).toBeUndefined();
        if (c.options.volume === "populated") {
          expect(after["root:volume/left-over.bin"]).toMatchObject({ type: "file", size: 5 });
          expect(after["root:volume/sub/deep/records.jsonl"]).toMatchObject({ type: "file" });
        }
      } finally {
        s.cleanup();
      }
    });
  }

  it("a configuration that stage A did not return is refused and nothing is touched", async () => {
    const s = scene();
    try {
      const before = snapshotDirs(s.dirs);
      const r = await checkStartupRefusals({ ...config() }, s.ports);
      expect(r.ok).toBe(false);
      expect(r.ok ? [] : r.error.map((e) => e.code)).toEqual(["config_not_validated"]);
      expect(snapshotDirs(s.dirs)).toEqual(before);
    } finally {
      s.cleanup();
    }
  });

  it("CONTROL (success): an approval is issued, and the volume and the config files are still byte-identical; only the heartbeat of the Launcher changed", async () => {
    const s = scene();
    try {
      const before = snapshotDirs(s.dirs, ignoreHeartbeat);
      const beforeHeartbeat = snapshotDirs({ lease: s.lease.directory })["lease:heartbeat"];
      const r = await checkStartupRefusals(config(), s.ports);
      expect(r.ok, JSON.stringify(r.ok ? "" : r.error)).toBe(true);
      expect(snapshotDirs(s.dirs, ignoreHeartbeat)).toEqual(before);
      expect(snapshotDirs({ lease: s.lease.directory })["lease:heartbeat"]).not.toEqual(beforeHeartbeat); // the fake Launcher beat during the proof
      expect(before["root:volume"]).toEqual({ type: "dir" });
      expect(Object.keys(before).filter((k) => k.startsWith("root:volume/"))).toEqual([]); // the volume is empty, and stage B wrote no Run record into it
    } finally {
      s.cleanup();
    }
  });
});

describe("G1: the snapshot is not blind (positive controls)", () => {
  const withDir = (fn: (dir: string) => void): void => {
    const dir = makeTempDir("phoenix-ctl-");
    try {
      mkdirSync(join(dir, "a", "b"), { recursive: true });
      writeFileSync(join(dir, "a", "one.bin"), Buffer.from([1, 2, 3]));
      writeFileSync(join(dir, "a", "b", "two.txt"), "two");
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const differs = (mutate: (dir: string) => void): boolean => {
    let result = false;
    withDir((dir) => {
      const before = snapshotDirs({ d: dir });
      expect(snapshotDirs({ d: dir })).toEqual(before); // unchanged: equal
      mutate(dir);
      result = JSON.stringify(snapshotDirs({ d: dir })) !== JSON.stringify(before);
    });
    return result;
  };
  it("detects a new file, a new empty directory, a changed byte, a same-size change, a deletion, a rename, and a truncation", () => {
    expect(differs((d) => writeFileSync(join(d, "new.txt"), "x"))).toBe(true);
    expect(differs((d) => mkdirSync(join(d, "empty-dir")))).toBe(true);
    expect(differs((d) => writeFileSync(join(d, "a", "one.bin"), Buffer.from([1, 2, 4])))).toBe(true);
    expect(differs((d) => writeFileSync(join(d, "a", "b", "two.txt"), "twO"))).toBe(true);
    expect(differs((d) => rmSync(join(d, "a", "b", "two.txt")))).toBe(true);
    expect(differs((d) => renameSync(join(d, "a", "one.bin"), join(d, "a", "uno.bin")))).toBe(true);
    expect(differs((d) => writeFileSync(join(d, "a", "one.bin"), Buffer.alloc(0)))).toBe(true);
  });
  it("reports a directory that appears or disappears as a change of the `absent` entry", () => {
    const dir = makeTempDir("phoenix-ctl-");
    try {
      const gone = join(dir, "later");
      const before = snapshotDirs({ d: gone });
      expect(before["d:"]).toEqual({ type: "absent" });
      mkdirSync(gone);
      expect(snapshotDirs({ d: gone })).not.toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it("a port that writes a Run record into the volume is caught by the same comparison (the check can observe a write)", async () => {
    const s = scene();
    try {
      const before = snapshotDirs(s.dirs);
      const writing = {
        ...s.ports,
        io: {
          ...s.ports.io,
          runVolume: () => {
            writeFileSync(join(s.volume, "records.jsonl"), '{"seq":1}\n'); // what a buggy port or a buggy stage B would do
            return { exists: true, writable: true, empty: true };
          },
        },
      };
      await checkStartupRefusals(config(), writing as Any);
      expect(snapshotDirs(s.dirs, ignoreHeartbeat)).not.toEqual(before);
    } finally {
      s.cleanup();
    }
  });
  it("a port that deletes an existing file in the volume is caught too", async () => {
    const s = scene({ volume: "populated" });
    try {
      const before = snapshotDirs(s.dirs);
      const deleting = { ...s.ports, io: { ...s.ports.io, runVolume: () => { rmSync(join(s.volume, "left-over.bin")); return { exists: true, writable: true, empty: false }; } } };
      await checkStartupRefusals(config(), deleting as Any);
      expect(snapshotDirs(s.dirs, ignoreHeartbeat)).not.toEqual(before);
    } finally {
      s.cleanup();
    }
  });
  it("an unreadable file does not make the snapshot lie: a mode change alone is not content, and content is what is compared", () => {
    withDir((dir) => {
      const before = snapshotDirs({ d: dir });
      try { chmodSync(join(dir, "a", "one.bin"), 0o600); } catch { /* not supported on every file system */ }
      expect(snapshotDirs({ d: dir })).toEqual(before);
    });
  });
});

describe("G1: property: no refused start-up changes any directory (stage B, composed refusals)", () => {
  const TWEAKS: readonly { name: string; apply: (o: SceneOptions) => void }[] = [
    { name: "policy", apply: (o) => { o.policy = narrowed; } },
    { name: "audit", apply: (o) => { o.audit = () => undefined; } },
    { name: "volume-populated", apply: (o) => { o.volume = "populated"; } },
    { name: "volume-missing", apply: (o) => { o.volume = "missing"; } },
    { name: "extra-file", apply: (o) => { o.configFiles = ["run-config.json", "audit-config.json", "x.json"]; } },
    { name: "no-config-dir", apply: (o) => { o.configFiles = "missing"; } },
    { name: "revoked", apply: (o) => { o.revoked = true; } },
    { name: "no-beat", apply: (o) => { o.beat = false; } },
    { name: "audit-invalid", apply: (o) => { o.audit = () => toBytes({ ...syntheticAuditConfig(), tokenizer: "other" }); } },
  ];
  it("whatever combination is applied, the directories are byte-identical afterwards, and an approval exists only with no tweak", async () => {
    await fc.assert(
      fc.asyncProperty(fc.subarray([...TWEAKS], { minLength: 0 }), async (chosen) => {
        const options: SceneOptions = {};
        for (const t of chosen) t.apply(options);
        const s = scene(options);
        try {
          const before = snapshotDirs(s.dirs, ignoreHeartbeat);
          const r = await checkStartupRefusals(config(), s.ports);
          expect(r.ok, chosen.map((t) => t.name).join(",")).toBe(chosen.length === 0);
          expect(snapshotDirs(s.dirs, ignoreHeartbeat)).toEqual(before);
        } finally {
          s.cleanup();
        }
      }),
      { seed: 410_401, numRuns: 60 },
    );
  }, 60_000);
});

describe("G1: stage A: a refused configuration changes no directory", () => {
  it("property: random refused configurations, with a watched directory that holds existing content", () => {
    const dir = makeTempDir("phoenix-a-");
    try {
      mkdirSync(join(dir, "out", "nested"), { recursive: true });
      writeFileSync(join(dir, "out", "keep.bin"), Buffer.from([9, 8, 7]));
      writeFileSync(join(dir, "out", "nested", "records.jsonl"), '{"seq":1}\n');
      const base = (): Any => ({ schemaVersion: 1, provider: "mock", limits: {}, testApi: { baseAddress: "http://reverse-proxy:8080" }, mask: { paths: [] }, envNames: [] });
      const breakers: ((c: Any) => void)[] = [
        (c) => { delete c.limits; },
        (c) => { c.limits = null; },
        (c) => { if (typeof c.limits === "object" && c.limits !== null) c.limits.runSeconds = 0; else c.limits = { runSeconds: 0 }; },
        (c) => { if (typeof c.limits === "object" && c.limits !== null) c.limits.runSeconds = 60; else c.limits = { runSeconds: 60 }; },
        (c) => { c.provider = "other"; },
        (c) => { if (typeof c.mask === "object" && c.mask !== null) c.mask.token = "x"; else c.mask = { paths: [], token: "x" }; },
        (c) => { c.unknown = 1; },
        (c) => { c.mockFixtureSet = null; },
        (c) => { c.envNames = ["bad name"]; },
        (c) => { if (typeof c.testApi === "object" && c.testApi !== null) c.testApi.baseAddress = "http://example.invalid"; else c.testApi = { baseAddress: "http://example.invalid" }; },
        (c) => { if (typeof c.limits === "object" && c.limits !== null) c.limits.claimsPerHypothesis = 51; else c.limits = { claimsPerHypothesis: 51 }; },
      ];
      fc.assert(
        fc.property(fc.subarray(breakers, { minLength: 1 }), (chosen) => {
          const before = snapshotDirs({ watched: dir });
          const cfg = base();
          for (const b of chosen) b(cfg);
          expect(validateRunConfig(cfg).ok).toBe(false);
          expect(snapshotDirs({ watched: dir })).toEqual(before);
        }),
        { seed: 410_402, numRuns: 150 },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});