import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_OPTIONS, type DestinationIntelligenceQuery } from '../contract';
import { MemoryCache, silentLogger, TOUR27_USER_AGENT, type CacheStore, type ProviderDeps } from '../runtime';
import { createNwsProvider, FRESH_DEFAULT_SECONDS, FRESH_MAX_SECONDS, FRESH_MIN_SECONDS, nwsCacheKey, OUTSIDE_COVERAGE_TTL_SECONDS, toAlerts } from './nws';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const q = (lat = 43.6532, lng = -79.3832): DestinationIntelligenceQuery => ({ latitude: lat, longitude: lng, ...DEFAULT_OPTIONS });
const at = (s: number) => new Date(NOW.getTime() + s * 1000);
const POLY = { type: 'Polygon', coordinates: [[[-79.5, 43.6], [-79.3, 43.6], [-79.3, 43.7], [-79.5, 43.7], [-79.5, 43.6]]] };

function feature(id: string, props: Record<string, unknown> = {}, geometry: unknown = POLY) {
  return {
    id: `https://api.weather.gov/alerts/${id}`, geometry,
    properties: {
      id, '@id': `https://api.weather.gov/alerts/${id}`, areaDesc: 'Somewhere', geocode: { UGC: ['TXZ001'], SAME: ['048001'] }, affectedZones: ['https://api.weather.gov/zones/forecast/TXZ001'],
      status: 'Actual', messageType: 'Alert', category: 'Met', event: 'Flash Flood Warning', urgency: 'Immediate', severity: 'Severe', certainty: 'Likely', response: 'Shelter',
      sender: 'w-nws.webmaster@noaa.gov', senderName: 'NWS Test', headline: 'H', description: 'D', instruction: 'I', sent: '2026-09-20T11:00:00-05:00',
      effective: '2026-09-20T11:00:00-05:00', onset: null, expires: '2026-09-20T13:00:00+00:00', ends: '2026-09-20T18:00:00+00:00',
      references: [], parameters: { NWSheadline: ['HEADLINE'] }, eventCode: { NationalWeatherService: ['FFW'] }, ...props,
    },
  };
}

interface Harness { deps: ProviderDeps; fetchMock: ReturnType<typeof vi.fn>; cache: MemoryCache; set: { mock: { calls: any[][] } } }
function harness(responder: (url: string, init: RequestInit) => Response | Promise<Response>, cacheOverride?: CacheStore): Harness {
  let clock = NOW.getTime();
  const cache = new MemoryCache(() => clock);
  (cache as any).advance = (s: number) => { clock += s * 1000; };
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => responder(url, init ?? {}));
  const set = vi.spyOn(cache, 'set');
  const deps: ProviderDeps = { fetch: fetchMock as any, cache: cacheOverride ?? cache, now: () => NOW, env: () => undefined, logger: silentLogger };
  return { deps, fetchMock, cache, set };
}
const ok = (features: unknown[], headers: Record<string, string> = {}, extra: Record<string, unknown> = {}) =>
  new Response(JSON.stringify({ type: 'FeatureCollection', features, updated: '2026-09-20T11:59:00+00:00', ...extra }), { status: 200, headers });
const advance = (h: Harness, s: number) => (h.cache as any).advance(s);

describe('NWS provider — request', () => {
  it('sends the EXACT untruncated point, status=actual, geo+json, and the honest User-Agent', async () => {
    const h = harness(() => ok([]));
    await createNwsProvider(h.deps)(q(43.653245123456, -79.383251987654), NOW);
    const [url, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://api.weather.gov/alerts/active');
    expect(u.searchParams.get('status')).toBe('actual');
    expect(u.searchParams.get('point')).toBe('43.653245123456,-79.383251987654');
    const headers = init.headers as Record<string, string>;
    expect(headers.Accept).toBe('application/geo+json');
    expect(headers['User-Agent']).toBe(TOUR27_USER_AGENT);
    expect(init.redirect).toBe('error');
  });

  it('parses the body as JSON regardless of Content-Type', async () => {
    const h = harness(() => new Response(JSON.stringify({ features: [feature('a')] }), { status: 200, headers: { 'content-type': 'text/plain' } }));
    expect((await createNwsProvider(h.deps)(q(), NOW)).alerts).toHaveLength(1);
  });
});

describe('NWS provider — official values reproduced verbatim', () => {
  it('preserves CAP enumerations, text, geocodes, parameters and normalises instants to UTC', async () => {
    const h = harness(() => ok([feature('urn:oid:1')]));
    const env = await createNwsProvider(h.deps)(q(), NOW);
    expect(env).toMatchObject({ source: 'NOAA_NWS', officialWarnings: true, coverage: 'covered', providerUpdatedAt: '2026-09-20T11:59:00.000Z', query: { latitude: 43.6532, longitude: -79.3832 } });
    expect(env.alerts[0]).toMatchObject({
      id: 'urn:oid:1', status: 'Actual', messageType: 'Alert', categories: ['Met'], event: 'Flash Flood Warning', urgency: 'Immediate',
      severity: 'Severe', certainty: 'Likely', responseTypes: ['Shelter'], headline: 'H', description: 'D', instruction: 'I', sent: '2026-09-20T16:00:00.000Z',
      areas: [{ description: 'Somewhere', geocodes: { UGC: ['TXZ001'], SAME: ['048001'] }, geometry: POLY }], parameters: { NWSheadline: ['HEADLINE'] }, eventCodes: { NationalWeatherService: ['FFW'] }, translations: [],
    });
    expect(JSON.stringify(env)).not.toMatch(/riskScore|unifiedSeverity/i);
  });
});

describe('NWS provider — validUntil = ends ?? expires', () => {
  it.each([
    ['ends present', { ends: '2026-09-20T18:00:00+00:00', expires: '2026-09-20T13:00:00+00:00' }, '2026-09-20T18:00:00.000Z', 'ends'],
    ['ends absent', { ends: null, expires: '2026-09-20T13:00:00+00:00' }, '2026-09-20T13:00:00.000Z', 'expires'],
    ['both absent', { ends: null, expires: null }, null, null],
  ])('%s', async (_n, props, validUntil, basis) => {
    const [a] = toAlerts([feature('x', props)]);
    expect(a.validUntil).toBe(validUntil);
    expect(a.validUntilBasis).toBe(basis);
  });

  it('removes expired alerts at READ time even from a fresh cache entry; keeps unknown validUntil', async () => {
    const h = harness(() => ok([feature('gone', { ends: '2026-09-20T12:30:00+00:00' }), feature('unknown', { ends: null, expires: null })], { 'cache-control': 'public, max-age=60' }));
    const provider = createNwsProvider(h.deps);
    expect((await provider(q(), NOW)).alerts.map((a) => a.id)).toEqual(['gone', 'unknown']);
    const later = await provider(q(), at(31 * 60)); // still inside the 60 s fresh TTL? no: read-time filter uses `now`
    expect(later.alerts.map((a) => a.id)).toEqual(['unknown']);
  });
});

describe('NWS provider — lifecycle (Update / Cancel / Test / Exercise)', () => {
  it('an ACTUAL Update or Cancel removes the alert it references, and a Cancel itself is never shown', () => {
    const alerts = toAlerts([
      feature('old'), feature('upd', { messageType: 'Update', references: [{ identifier: 'old', sender: 's', sent: '2026-09-20T10:00:00+00:00' }] }),
      feature('victim'), feature('cxl', { messageType: 'Cancel', references: [{ identifier: 'victim' }] }),
    ]);
    expect(alerts.map((a) => a.id)).toEqual(['upd']);
  });

  it.each(['Test', 'Exercise', 'Draft', 'System', 'Actual '])('a %p message can NEVER suppress an Actual alert', (status) => {
    const alerts = toAlerts([
      feature('real'), feature('fake-cancel', { status, messageType: 'Cancel', references: [{ identifier: 'real' }] }),
      feature('fake-update', { status, messageType: 'Update', references: [{ identifier: 'real' }] }),
    ]);
    expect(alerts.map((a) => a.id)).toContain('real');
  });

  it('non-actual and duplicate alerts are dropped', () => {
    const alerts = toAlerts([feature('a'), feature('a'), feature('t', { status: 'Test' }), feature('e', { status: 'Exercise' })]);
    expect(alerts.map((a) => a.id)).toEqual(['a']);
  });

  it('a malformed feature is skipped without hiding the good ones', () => {
    expect(toAlerts([null, {}, { properties: null }, { properties: {} }, feature('good')] as any).map((a) => a.id)).toEqual(['good']);
  });
});

describe('NWS provider — coverage', () => {
  const oob = () => new Response(JSON.stringify({ type: 'https://api.weather.gov/problems/InvalidParameter', detail: 'Invalid point: out of bounds' }), { status: 400 });

  it('HTTP 400 "point out of bounds" is outside-coverage with NO alerts (distinct from covered + none), cached for 1 h', async () => {
    const h = harness(oob);
    const env = await createNwsProvider(h.deps)(q(-37.8136, 144.9631), NOW);
    expect(env).toMatchObject({ coverage: 'outside-coverage', alerts: [] });
    expect(h.set.mock.calls[0][2]).toBe(OUTSIDE_COVERAGE_TTL_SECONDS);
  });

  it('a covered point with no alerts is covered + [] (not outside-coverage)', async () => {
    const h = harness(() => ok([]));
    expect(await createNwsProvider(h.deps)(q(), NOW)).toMatchObject({ coverage: 'covered', alerts: [] });
  });

  it('any OTHER HTTP 400 is a failure, not coverage', async () => {
    const h = harness(() => new Response(JSON.stringify({ type: 'x/BadRequest', detail: 'nope' }), { status: 400 }));
    await expect(createNwsProvider(h.deps)(q(), NOW)).rejects.toThrow('HTTP 400');
  });
});

describe('NWS provider — failure is unavailable, never a false all-clear', () => {
  it.each([[500], [503], [429], [404], [302]])('HTTP %i throws', async (status) => {
    const h = harness(() => new Response('x', { status }));
    await expect(createNwsProvider(h.deps)(q(), NOW)).rejects.toThrow();
  });

  it.each([['not json'], ['null'], ['{}'], ['{"features":"nope"}'], ['[]']])('malformed body %p throws (never an empty list)', async (body) => {
    const h = harness(() => new Response(body, { status: 200 }));
    await expect(createNwsProvider(h.deps)(q(), NOW)).rejects.toThrow('malformed');
  });

  it('a network error throws a sanitised error that carries no URL or coordinates', async () => {
    const h = harness(() => { throw new TypeError('fetch failed for https://api.weather.gov/alerts/active?point=43.6532,-79.3832'); });
    const err = await createNwsProvider(h.deps)(q(), NOW).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toMatch(/43\.6532|79\.3832|api\.weather\.gov/);
  });
});

describe('NWS provider — freshness and NO stale fallback', () => {
  it('serves a fresh cache entry without calling NWS', async () => {
    const h = harness(() => ok([feature('a')]));
    const p = createNwsProvider(h.deps);
    await p(q(), NOW);
    await p(q(), at(1));
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('after the fresh TTL a live NWS confirmation is REQUIRED', async () => {
    const h = harness(() => ok([feature('a')]));
    const p = createNwsProvider(h.deps);
    await p(q(), NOW);
    advance(h, FRESH_DEFAULT_SECONDS + 1);
    await p(q(), at(FRESH_DEFAULT_SECONDS + 1));
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('once the entry expired and NWS is down the provider FAILS — the old warning set is never returned', async () => {
    let down = false;
    const h = harness(() => (down ? new Response('x', { status: 503 }) : ok([feature('a')])));
    const p = createNwsProvider(h.deps);
    await p(q(), NOW);
    advance(h, FRESH_DEFAULT_SECONDS + 1);
    down = true;
    await expect(p(q(), at(FRESH_DEFAULT_SECONDS + 1))).rejects.toThrow();
  });

  it.each([[undefined, FRESH_DEFAULT_SECONDS], ['public, max-age=1', FRESH_MIN_SECONDS], ['public, max-age=5, s-maxage=5', 5], ['max-age=30', 30], ['public, max-age=3600', FRESH_MAX_SECONDS], ['no-cache', FRESH_DEFAULT_SECONDS]])(
    'fresh TTL follows Cache-Control %p, clamped => %i s', async (cc, expected) => {
      const h = harness(() => ok([], cc ? { 'cache-control': cc } : {}));
      await createNwsProvider(h.deps)(q(), NOW);
      expect(h.set.mock.calls[0][2]).toBe(expected);
    },
  );

  it('concurrent misses share ONE provider call', async () => {
    const h = harness(async () => { await Promise.resolve(); return ok([feature('a')]); });
    const p = createNwsProvider(h.deps);
    const [a, b, c] = await Promise.all([p(q(), NOW), p(q(), NOW), p(q(), NOW)]);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b); expect(b).toEqual(c);
  });

  it('the cache key contains the exact coordinates (different points never share an entry)', () => {
    expect(nwsCacheKey(43.6532, -79.3832)).not.toBe(nwsCacheKey(43.65, -79.38));
  });

  it('a cache write failure still returns the live data; corrupt cache entries are treated as a miss', async () => {
    const broken: CacheStore = { get: async () => '{corrupt', set: async () => { throw new Error('redis down'); } };
    const h = harness(() => ok([feature('a')]), broken);
    expect((await createNwsProvider(h.deps)(q(), NOW)).alerts).toHaveLength(1);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });

  it('a structurally invalid cached payload is a miss (never trusted)', async () => {
    const bad: CacheStore = { get: async () => JSON.stringify({ coverage: 'safe', alerts: [], fetchedAt: 'x' }), set: async () => {} };
    const h = harness(() => ok([]), bad);
    await createNwsProvider(h.deps)(q(), NOW);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });
});
