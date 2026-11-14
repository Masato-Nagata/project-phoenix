// The two Node.js adapters (task 2.15 and 2.17): the `LeasePort` adapter against a temporary directory, and the `HttpPort`
// adapter against a local fake server (loopback only, inside the container with --network none).
// R9.4, R9.14, R9.16, R24.9; design "Runtime-side lease watcher and adapters".
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  AddressNotAllowedError, HttpAbortedError, HttpTimeoutError, HttpTransportError, checkLeaseTiming, createFsLeaseView, createHttpPort, createLeasePort,
  type LeaseReason, type LeaseState,
} from "../src/index.js";
import { FakeTime, NONCE, RUN_ID, leaseJsonOf, timingOf } from "./helpers/leaseFixtures.js";
import { scan, violations } from "./helpers/importGraph.js";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));
const FIXTURES = fileURLToPath(new URL("./fixtures/adapterLeak/", import.meta.url));
const timing = timingOf(1000, 4000, 100); // P = 500, U = 2000

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) await (cleanup.pop() as () => void | Promise<void>)();
});

// ------------------------------------------------------------------------------------------------ LeasePort adapter

function tmpLease(files: { leaseJson?: string; heartbeat?: string; revoked?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "lease-test-"));
  cleanup.push(() => {
    chmodSync(dir, 0o755);
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, "lease.json"), files.leaseJson ?? leaseJsonOf());
  writeFileSync(join(dir, "heartbeat"), files.heartbeat ?? "1");
  if (files.revoked === true) writeFileSync(join(dir, "revoked"), "");
  return dir;
}

/** A clock that doubles as the sleeper and plays the Launcher: it renews the heartbeat file every H while it sleeps. */
class LauncherSleeper extends FakeTime {
  private readonly file: string;
  private counter = 1;
  private nextBeat = 1000;
  constructor(dir: string) {
    super();
    this.file = join(dir, "heartbeat");
  }
  override async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await super.sleep(ms, signal);
    while (this.t >= this.nextBeat) {
      this.counter += 1;
      writeFileSync(this.file, String(this.counter));
      this.nextBeat += 1000;
    }
  }
}

function portOf(dir: string, time: FakeTime = new FakeTime(), over: Partial<{ runId: string; nonce: string }> = {}) {
  return { time, port: createLeasePort({ directory: dir, runId: over.runId ?? RUN_ID, nonce: over.nonce ?? NONCE, timing, clock: time, sleeper: time }) };
}
const reasonOf = (s: LeaseState): LeaseReason | "valid" => (s.valid ? "valid" : s.reason);

describe("the LeasePort adapter against a temporary directory", () => {
  it("a lease that the Launcher renews is valid: the first check is the start-up proof, then each check reads the directory", async () => {
    const dir = tmpLease();
    const time = new LauncherSleeper(dir);
    const { port } = portOf(dir, time);
    expect(await port.check()).toEqual({ valid: true });
    expect(time.t).toBe(1000);
    time.t += 2500;
    writeFileSync(join(dir, "heartbeat"), "9");
    expect(await port.check()).toEqual({ valid: true });
  });

  it("each state of the lease from the files: missing, malformed, wrong Run identifier, wrong nonce, revoked, stale heartbeat", async () => {
    const dirNoFile = mkdtempSync(join(tmpdir(), "lease-test-"));
    cleanup.push(() => rmSync(dirNoFile, { recursive: true, force: true }));
    const cases: [string, string, LeaseReason][] = [
      ["no lease.json", dirNoFile, "missing"],
      ["a directory that does not exist", join(dirNoFile, "nowhere"), "missing"],
      ["garbage in lease.json", tmpLease({ leaseJson: "not json" }), "malformed"],
      ["another Run identifier", tmpLease({ leaseJson: leaseJsonOf({ run_id: "run-9999" }) }), "run_mismatch"],
      ["another nonce", tmpLease({ leaseJson: leaseJsonOf({ nonce_sha256: "0".repeat(64) }) }), "nonce_mismatch"],
      ["revoked", tmpLease({ revoked: true }), "revoked"],
      ["a heartbeat that does not change", tmpLease(), "heartbeat_stale"],
    ];
    for (const [name, dir, reason] of cases) {
      const { time, port } = portOf(dir);
      expect(reasonOf(await port.check()), name).toBe(reason);
      if (reason !== "heartbeat_stale") expect(time.t, name).toBe(0); // refused without waiting
    }
  });

  it("a lease.json that is a directory, a link, or too large cannot be read: the check is held and ends as unreadable at U", async () => {
    const asDir = tmpLease();
    rmSync(join(asDir, "lease.json"));
    mkdirSync(join(asDir, "lease.json"));
    const asLink = tmpLease();
    rmSync(join(asLink, "lease.json"));
    symlinkSync(join(asLink, "heartbeat"), join(asLink, "lease.json"));
    const big = tmpLease({ leaseJson: "x".repeat(5000) });
    for (const dir of [asDir, asLink, big]) {
      const { time, port } = portOf(dir);
      const state = await port.check();
      expect(state).toMatchObject({ valid: false, reason: "unreadable", cause: "read_hold_expired" });
      expect(time.t).toBe(2000);
    }
  });

  it("a heartbeat that cannot be read is only 'no observation': the lease ends as stale, not as unreadable", async () => {
    const dir = tmpLease();
    rmSync(join(dir, "heartbeat"));
    mkdirSync(join(dir, "heartbeat"));
    const { time, port } = portOf(dir);
    expect(reasonOf(await port.check())).toBe("heartbeat_stale");
    expect(time.t).toBe(4000);
  });

  it("revoked is a file of any kind: its presence ends the lease", async () => {
    const dir = tmpLease();
    mkdirSync(join(dir, "revoked"));
    expect(reasonOf(await portOf(dir).port.check())).toBe("revoked");
  });

  it("a lease.json that is replaced after the proof ends the lease as malformed", async () => {
    const dir = tmpLease();
    const time = new LauncherSleeper(dir);
    const { port } = portOf(dir, time);
    expect(await port.check()).toEqual({ valid: true });
    writeFileSync(join(dir, "lease.json"), leaseJsonOf({ launcher_pid: 1 }));
    expect(await port.check()).toMatchObject({ valid: false, reason: "malformed", cause: "lease_json_changed" });
  });

  it("never writes: the directory is unchanged by any check, including checks that end as stale or revoked", async () => {
    const snapshot = (dir: string): string =>
      readdirSync(dir).sort().map((n) => { const st = lstatSync(join(dir, n)); return `${n}:${st.size}:${st.mtimeMs}:${st.mode}`; }).join("|");
    for (const files of [{}, { revoked: true }, { leaseJson: "garbage" }]) {
      const dir = tmpLease(files);
      for (const n of readdirSync(dir)) chmodSync(join(dir, n), 0o444);
      chmodSync(dir, 0o555);
      const before = snapshot(dir);
      const { port } = portOf(dir);
      await port.check();
      await port.check();
      expect(snapshot(dir)).toBe(before);
    }
    // The adapter file imports only the reading operations.
    const source = readFileSync(resolve(SRC, "lease/fsLeaseView.ts"), "utf8");
    expect(source).toMatch(/import \{ lstatSync, readFileSync \} from "node:fs";/);
  });

  it("createFsLeaseView reads the three files and treats 'absent' and 'error' differently", () => {
    const dir = tmpLease();
    const view = createFsLeaseView(dir);
    expect(view.readHeartbeat()).toEqual({ kind: "ok", text: "1" });
    expect(view.readRevoked()).toEqual({ kind: "absent" });
    expect(createFsLeaseView(join(dir, "nowhere")).readLeaseJson()).toEqual({ kind: "absent" });
    mkdirSync(join(dir, "revoked"));
    expect(view.readRevoked()).toEqual({ kind: "ok", text: "" });
  });

  it("refuses a timing that breaks the rules before an adapter can be used (the Launcher and the runtime check the same three rules)", () => {
    expect(checkLeaseTiming({ heartbeatIntervalMs: 1000, staleAfterMs: 4000 }, 2000).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------- HttpPort adapter

interface Fake {
  origin: string;
  hits: { method: string; url: string; headers: IncomingMessage["headers"]; body: string }[];
}

async function fakeServer(handler: (req: IncomingMessage, res: ServerResponse, body: string) => void): Promise<Fake> {
  const hits: Fake["hits"] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      hits.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      handler(req, res, body);
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

const signalOf = (): AbortSignal => new AbortController().signal;

describe("the HttpPort adapter against a local fake server", () => {
  it("sends a request to the configured origin and returns the status and the body text", async () => {
    const fake = await fakeServer((_req, res) => {
      res.writeHead(201, { "content-type": "application/json" });
      res.end('{"success":true}');
    });
    const port = createHttpPort({ origin: fake.origin });
    expect(await port.send({ method: "GET", path: "/orders/5" }, 2000, signalOf())).toEqual({ status: 201, body: '{"success":true}' });
    expect(fake.hits.map((h) => `${h.method} ${h.url}`)).toEqual(["GET /orders/5"]);
    expect(fake.hits[0]?.headers["host"]).toBe(new URL(fake.origin).host);
    expect(fake.hits[0]?.headers["connection"]).toBe("close");
  });

  it("sends the headers and the body as given, with the length of the bytes", async () => {
    const fake = await fakeServer((_req, res, body) => {
      res.writeHead(200);
      res.end(body);
    });
    const port = createHttpPort({ origin: fake.origin });
    const body = '{"name":"é"}';
    const r = await port.send({ method: "POST", path: "/orders", headers: { "content-type": "application/json", accept: "application/json" }, body }, 2000, signalOf());
    expect(r).toEqual({ status: 200, body });
    expect(fake.hits[0]?.headers["content-length"]).toBe(String(Buffer.byteLength(body, "utf8")));
    expect(fake.hits[0]?.headers["content-type"]).toBe("application/json");
    expect(fake.hits[0]?.body).toBe(body);
  });

  it("times out at the limit: HttpTimeoutError, and the connection is dropped", async () => {
    const fake = await fakeServer(() => undefined);
    const port = createHttpPort({ origin: fake.origin });
    const started = Date.now();
    await expect(port.send({ method: "GET", path: "/slow" }, 80, signalOf())).rejects.toBeInstanceOf(HttpTimeoutError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(60);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("honors the AbortSignal: HttpAbortedError, also when it is already aborted (then nothing is sent)", async () => {
    const fake = await fakeServer(() => undefined);
    const port = createHttpPort({ origin: fake.origin });
    const controller = new AbortController();
    const pending = port.send({ method: "GET", path: "/slow" }, 5000, controller.signal);
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toBeInstanceOf(HttpAbortedError);

    const before = fake.hits.length;
    const done = new AbortController();
    done.abort();
    await expect(port.send({ method: "GET", path: "/x" }, 1000, done.signal)).rejects.toBeInstanceOf(HttpAbortedError);
    expect(fake.hits.length).toBe(before);
  });

  it("a time limit that is not positive is a timeout, and nothing is sent", async () => {
    const fake = await fakeServer((_q, res) => res.end("x"));
    const port = createHttpPort({ origin: fake.origin });
    for (const ms of [0, -1, Number.NaN]) await expect(port.send({ method: "GET", path: "/x" }, ms, signalOf())).rejects.toBeInstanceOf(HttpTimeoutError);
    expect(fake.hits).toEqual([]);
  });

  it("sends nothing for a target outside the configured origin: AddressNotAllowedError", async () => {
    const fake = await fakeServer((_q, res) => res.end("x"));
    const port = createHttpPort({ origin: fake.origin });
    for (const path of ["//evil.example/x", "http://evil.example/x", "/a/../b", "/orders?x=1", "/%2e%2e/x", "\\x", "x", ""]) {
      await expect(port.send({ method: "GET", path }, 1000, signalOf()), JSON.stringify(path)).rejects.toBeInstanceOf(AddressNotAllowedError);
    }
    expect(fake.hits).toEqual([]);
  });

  it("does not follow a redirect", async () => {
    const fake = await fakeServer((_q, res) => {
      res.writeHead(302, { location: "http://evil.example/x" });
      res.end("moved");
    });
    const port = createHttpPort({ origin: fake.origin });
    expect(await port.send({ method: "GET", path: "/r" }, 2000, signalOf())).toEqual({ status: 302, body: "moved" });
    expect(fake.hits.length).toBe(1);
  });

  it("a response larger than the limit is a transport error", async () => {
    const fake = await fakeServer((_q, res) => res.end("y".repeat(3000)));
    expect((await createHttpPort({ origin: fake.origin }).send({ method: "GET", path: "/b" }, 2000, signalOf())).body.length).toBe(3000);
    await expect(createHttpPort({ origin: fake.origin, maxResponseBytes: 1000 }).send({ method: "GET", path: "/b" }, 2000, signalOf())).rejects.toBeInstanceOf(HttpTransportError);
  });

  it("a refused connection is a transport error", async () => {
    const fake = await fakeServer((_q, res) => res.end("x"));
    const origin = fake.origin;
    await Promise.all(cleanup.splice(0).map((f) => f())); // close the server
    await expect(createHttpPort({ origin }).send({ method: "GET", path: "/x" }, 1000, signalOf())).rejects.toBeInstanceOf(HttpTransportError);
  });
});

// ------------------------------------------------------------------------------------------------------ isolation

/** Source text without comments, so that words in comments are not mistaken for code. */
function code(file: string): string {
  return readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const FORBIDDEN_IDENTIFIERS =
  /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|rm|rmSync|rmdir|unlink|unlinkSync|rename|renameSync|copyFile|truncate|chmod|chown|symlink|createWriteStream|openSync|spawn|spawnSync|exec|execSync|execFile|fork|child_process|worker_threads|docker|git)\b/;

describe("the adapters expose no file-write, process, Docker, or Git operation", () => {
  it("the lease module reaches only node:crypto, node:fs (reading), and node:path", () => {
    const graph = scan(resolve(SRC, "lease/index.ts"));
    expect(violations(graph, SRC, ["node:crypto", "node:fs", "node:path"])).toEqual([]);
    for (const f of graph.files) expect(code(f), f).not.toMatch(FORBIDDEN_IDENTIFIERS);
  });

  it("the HttpPort adapter reaches only node:http", () => {
    const graph = scan(resolve(SRC, "runner/httpAdapter.ts"));
    // Type-only imports of the runner types pull the identity module (node:crypto) into the graph; the adapter itself imports node:http only.
    expect(violations(graph, SRC, ["node:http", "node:crypto"])).toEqual([]);
    for (const f of graph.files) expect(code(f), f).not.toMatch(FORBIDDEN_IDENTIFIERS);
  });

  it("positive control: a module that imports a process API and a file-write API is reported, and the identifier scan sees it", () => {
    const entry = resolve(FIXTURES, "entry.ts");
    const found = violations(scan(entry), FIXTURES, ["node:crypto"]);
    expect(found.some((v) => v.includes("node:child_process"))).toBe(true);
    expect(found.some((v) => v.includes("node:fs"))).toBe(true);
    expect(code(entry)).toMatch(FORBIDDEN_IDENTIFIERS);
  });
});