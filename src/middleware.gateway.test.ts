import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware, config } from './middleware';

/* Tour 27 gateway mode + a regression guard for the upstream analytics matcher. The upstream
   middleware.test.ts (map runtime assets) is intentionally left untouched. */
const TOKEN = 'mw-test-token-123';
const event = { waitUntil: vi.fn() } as any;
const call = (path: string, init: { method?: string; auth?: string } = {}) =>
  middleware(new NextRequest(`http://gateway.internal${path}`, { method: init.method ?? 'GET', headers: init.auth ? { authorization: init.auth } : {} }), event);

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => { fetchSpy = vi.fn(async () => new Response('{}')); vi.stubGlobal('fetch', fetchSpy); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('middleware — gateway mode', () => {
  const gateway = () => { vi.stubEnv('OSIRIS_DEPLOYMENT_MODE', 'tour27-gateway'); vi.stubEnv('OSIRIS_SERVICE_TOKEN', TOKEN); };

  it('serves the gateway route only with the bearer token, and never sends analytics', async () => {
    gateway();
    expect((await call('/api/tour27/destination-intelligence', { auth: `Bearer ${TOKEN}` })).status).toBe(200);
    expect((await call('/api/tour27/destination-intelligence')).status).toBe(401);
    expect((await call('/api/tour27/destination-intelligence', { auth: 'Bearer nope' })).status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled(); // no umami/analytics fan-out, no visitor IPs forwarded anywhere
  });

  it.each(['/', '/api/cctv/proxy', '/api/arcgis', '/api/aircraft', '/api/earthquakes', '/api/weather'])('%s is 404 (upstream dashboard/proxy routes are unreachable)', async (path) => {
    gateway();
    const res = await call(path, { auth: `Bearer ${TOKEN}` });
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('probes are open, mutating methods are 405', async () => {
    gateway();
    expect((await call('/api/health')).status).toBe(200);
    expect((await call('/api/ready')).status).toBe(200);
    expect((await call('/api/tour27/health', { method: 'POST', auth: `Bearer ${TOKEN}` })).status).toBe(405);
  });

  it('fails closed (503) when the token is not configured', async () => {
    vi.stubEnv('OSIRIS_DEPLOYMENT_MODE', 'tour27-gateway');
    vi.stubEnv('OSIRIS_SERVICE_TOKEN', '');
    expect((await call('/api/tour27/destination-intelligence', { auth: `Bearer ${TOKEN}` })).status).toBe(503);
  });

  it('the denial body never contains the token', async () => {
    gateway();
    expect(await (await call('/api/tour27/health', { auth: 'Bearer nope' })).text()).not.toContain(TOKEN);
  });
});

describe('middleware — normal (upstream) mode is unchanged', () => {
  it('API paths pass straight through without analytics (as before, when they were unmatched)', async () => {
    const res = await call('/api/tour27/destination-intelligence');
    expect(res.status).toBe(200);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('page views still send the two analytics events', async () => {
    expect((await call('/')).status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('the matcher gained /api/:path* (needed for the guard) and still excludes static assets', () => {
    expect(config.matcher).toContain('/api/:path*');
    expect(config.matcher.some((m) => m.includes('_next/static'))).toBe(true);
  });
});
