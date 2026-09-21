// Tour 27 gateway smoke harness. Exit 0 only if every check passes.
//
//   SMOKE_TARGET=process (default)  spawns .next/standalone/server.js on a free loopback port with a freshly
//                                   generated ephemeral token, and also proves restart + fail-closed readiness.
//   SMOKE_TARGET=url                BASE_URL + OSIRIS_SERVICE_TOKEN come from the environment (CI container run).
//                                   Optional LOG_FILE = container logs to scan for token/coordinate leaks.
//
// The token is generated here, held in memory only, and NEVER printed. The test point is a public landmark
// (Melbourne CBD); it is checked to be absent from the logs.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

const TEST_LAT = '-37.8136';
const TEST_LNG = '144.9631';
const ROUTE = `/api/tour27/destination-intelligence?lat=${TEST_LAT}&lng=${TEST_LNG}`;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` ${detail}`}`); };

const freePort = () => new Promise((resolve, reject) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); s.on('error', reject); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(base, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(`${base}/api/health`); if (r.status < 500) return true; } catch { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

function start(env) {
  const server = join(process.cwd(), '.next', 'standalone', 'server.js');
  if (!existsSync(server)) throw new Error('build first: .next/standalone/server.js not found');
  const logs = [];
  const child = spawn(process.execPath, [server], { env: { ...process.env, NODE_ENV: 'production', HOSTNAME: '127.0.0.1', NEXT_TELEMETRY_DISABLED: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => logs.push(String(d)));
  child.stderr.on('data', (d) => logs.push(String(d)));
  return { child, logs };
}
const stop = (child) => new Promise((resolve) => { child.once('exit', resolve); child.kill(); setTimeout(resolve, 5000); });

async function suite(base, token, label) {
  const get = (path, headers = {}, method = 'GET') => fetch(`${base}${path}`, { method, headers, redirect: 'manual' });
  const auth = { Authorization: `Bearer ${token}` };

  check(`${label} 1 /api/health works without a token`, (await get('/api/health')).status === 200);
  const ready = await get('/api/ready');
  check(`${label} 2 /api/ready is ready when configured`, ready.status === 200 && (await ready.json()).ready === true);
  check(`${label} 3 gateway route without a token => 401`, (await get(ROUTE)).status === 401);
  check(`${label} 4 wrong token => 401`, (await get(ROUTE, { Authorization: 'Bearer wrong-token-value' })).status === 401);

  const ok = await get(ROUTE, auth);
  let body = null;
  try { body = await ok.json(); } catch { /* checked below */ }
  check(`${label} 5 correct token accepted with a contract-v1.0 body`, ok.status === 200 && body?.contractVersion === '1.0' && Array.isArray(body?.officialWarnings) && body.officialWarnings.map((w) => w.provider).join() === 'NWS,ECCC', `status=${ok.status}`);
  check(`${label} 5b health route requires the token`, (await get('/api/tour27/health')).status === 401 && (await get('/api/tour27/health', auth)).status === 200);

  const oldRoutes = ['/', '/api/news', '/api/cctv', '/api/tour27', '/api/tour27/unknown', '/_next/static/x.js'];
  const statuses = await Promise.all(oldRoutes.map(async (p) => (await get(p, auth)).status));
  check(`${label} 6 non-allow-listed routes => 404`, statuses.every((s) => s === 404), JSON.stringify(statuses));

  const methods = await Promise.all(['POST', 'PUT', 'PATCH', 'DELETE'].map(async (m) => (await get(ROUTE, auth, m)).status));
  check(`${label} 7 mutating methods => 405`, methods.every((s) => s === 405), JSON.stringify(methods));
}

function scanLogs(text, token, label) {
  check(`${label} 11a logs contain no service token`, !text.includes(token));
  check(`${label} 11b logs contain no test coordinates`, !text.includes(TEST_LAT) && !text.includes(TEST_LNG) && !/-37\.81|144\.96/.test(text));
  check(`${label} 8 no analytics traffic attempted (no umami host in logs)`, !/umami/i.test(text));
}

async function main() {
  const target = process.env.SMOKE_TARGET ?? 'process';
  if (target === 'url') {
    const base = process.env.BASE_URL;
    const token = process.env.OSIRIS_SERVICE_TOKEN;
    if (!base || !token) throw new Error('BASE_URL and OSIRIS_SERVICE_TOKEN are required for SMOKE_TARGET=url');
    if (!(await waitFor(base))) throw new Error('gateway did not become healthy');
    await suite(base, token, '[url]');
    if (process.env.LOG_FILE) scanLogs(readFileSync(process.env.LOG_FILE, 'utf8'), token, '[url]');
  } else {
    const token = randomBytes(32).toString('hex');
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const env = { PORT: String(port), OSIRIS_DEPLOYMENT_MODE: 'tour27-gateway', OSIRIS_SERVICE_TOKEN: token };

    let run = start(env);
    if (!(await waitFor(base))) throw new Error('gateway did not become healthy');
    await suite(base, token, '[process]');
    await stop(run.child);

    // 10 restart succeeds and the same checks hold on the fresh process.
    run = start(env);
    check('[process] 10 restart succeeds', await waitFor(base));
    await suite(base, token, '[process/restart]');
    await stop(run.child);
    scanLogs(run.logs.join(''), token, '[process]');

    // Fail-closed: gateway mode without a token is NOT ready and refuses protected routes.
    const port2 = await freePort();
    const base2 = `http://127.0.0.1:${port2}`;
    const bare = start({ PORT: String(port2), OSIRIS_DEPLOYMENT_MODE: 'tour27-gateway', OSIRIS_SERVICE_TOKEN: '' });
    await waitFor(base2);
    check('[process] fail-closed: no token configured => /api/ready 503', (await fetch(`${base2}/api/ready`)).status === 503);
    check('[process] fail-closed: no token configured => protected route 503, never open', (await fetch(`${base2}${ROUTE}`)).status === 503);
    await stop(bare.child);
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`SMOKE_RESULT=${failed.length === 0 ? 'PASS' : 'FAIL'} (${results.length - failed.length}/${results.length})`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(`SMOKE_RESULT=FAIL (${e.message})`); process.exit(1); });
