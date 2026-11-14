'use strict';
// Network probe of the Discovery_Override isolation test (task 4.15, brought forward before 2.19). It runs inside a short-lived
// container started with the runtime's network flags (or, for the positive control, on a legacy network). It only opens TCP
// connections, sends fixed HTTP requests to the given targets, and runs DNS lookups; it writes nothing but one result line to stdout.
// Classification: connect -> "connected"; ECONNREFUSED -> "closed"; timeout -> "blocked"; EHOSTUNREACH/ENETUNREACH/EACCES/EPERM ->
// "unreachable"; ENOTFOUND/EAI_AGAIN (name targets only) -> "dns_unresolved"; anything else -> "error:<code>".
const net = require('net');
const dns = require('dns').promises;

const plan = JSON.parse(process.env.PHOENIX_PROBE_PLAN || '{}');

function classify(err) {
  const c = (err && err.code) || 'unknown';
  if (c === 'ECONNREFUSED') return 'closed';
  if (c === 'ETIMEDOUT') return 'blocked';
  if (c === 'EHOSTUNREACH' || c === 'ENETUNREACH' || c === 'EACCES' || c === 'EPERM') return 'unreachable';
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN' || c === 'EAI_NODATA') return 'dns_unresolved';
  return 'error:' + c;
}

function tcp(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, family: 4 });
    let done = false;
    const end = (r) => { if (!done) { done = true; s.destroy(); resolve(r); } };
    s.setTimeout(timeoutMs, () => end('blocked'));
    s.once('connect', () => end('connected'));
    s.once('error', (e) => end(classify(e)));
  });
}

function http(host, port, request, timeoutMs) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, family: 4 });
    let buf = '';
    let done = false;
    const end = (r) => { if (!done) { done = true; s.destroy(); resolve(r); } };
    s.setTimeout(timeoutMs, () => end({ result: buf ? 'partial' : 'blocked', status: 0, appJson: false, nginxDefault: false, bytes: buf.length }));
    s.once('connect', () => s.write(request));
    s.on('data', (d) => { buf += d.toString('utf8'); if (buf.length > 4096) s.end(); });
    s.once('error', (e) => end({ result: classify(e), status: 0, appJson: false, nginxDefault: false, bytes: buf.length }));
    s.once('end', () => {
      const m = /^HTTP\/\d\.\d (\d{3})/.exec(buf);
      end({ result: 'response', status: m ? Number(m[1]) : 0, appJson: /"success"\s*:\s*(true|false)/.test(buf), dbOk: /"db"\s*:\s*"ok"/.test(buf), nginxDefault: /Welcome to nginx/.test(buf), bytes: buf.length });
    });
  });
}

async function lookup(name, timeoutMs) {
  const t = new Promise((r) => setTimeout(() => r({ result: 'blocked', addresses: [] }), timeoutMs));
  const q = dns.lookup(name, { all: true, family: 4 }).then(
    (a) => ({ result: 'resolved', addresses: a.map((x) => x.address) }),
    (e) => ({ result: classify(e), addresses: [] }),
  );
  return Promise.race([t, q]);
}

async function pool(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

async function main() {
  if (plan.startDelayMs) await new Promise((r) => setTimeout(r, plan.startDelayMs));
  const result = { tcp: {}, dns: {}, http: {}, scan: null };
  for (const t of plan.tcp || []) result.tcp[t.id] = await tcp(t.host, t.port, t.timeoutMs || 3000);
  for (const d of plan.dns || []) result.dns[d.id] = await lookup(d.name, d.timeoutMs || 3000);
  for (const h of plan.http || []) result.http[h.id] = await http(h.host, h.port, h.request, h.timeoutMs || 5000);
  if (plan.scan) {
    const r = await pool(plan.scan.ports, plan.scan.concurrency || 32, (p) => tcp(plan.scan.host, p, plan.scan.timeoutMs || 1500));
    const open = []; const counts = {};
    plan.scan.ports.forEach((p, k) => { counts[r[k]] = (counts[r[k]] || 0) + 1; if (r[k] === 'connected') open.push(p); });
    result.scan = { host: plan.scan.host, scanned: plan.scan.ports.length, open, counts };
  }
  process.stdout.write('PROBE-RESULT ' + JSON.stringify(result) + '\n');
}

main().then(() => { process.exitCode = 0; }, (e) => { process.stdout.write('PROBE-ERROR ' + String(e && e.message) + '\n'); process.exitCode = 1; });