import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_OPTIONS, type DestinationIntelligenceQuery } from '../contract';
import { MemoryCache, silentLogger, TOUR27_USER_AGENT, type ProviderDeps } from '../runtime';
import { createUsgsProvider, USGS_FRESH_SECONDS, USGS_QUERY_URL, USGS_STALE_SECONDS, usgsCacheKey } from './usgs';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const q = (over: Partial<DestinationIntelligenceQuery> = {}): DestinationIntelligenceQuery => ({ latitude: 35.6895, longitude: 139.6917, ...DEFAULT_OPTIONS, ...over });

const feature = (id: string, over: Record<string, unknown> = {}, coords: unknown = [139.7, 35.7, 10.5]) => ({
  id, geometry: { coordinates: coords },
  properties: { mag: 4.6, place: '10 km N of Testville', title: 'M 4.6 - 10 km N of Testville', time: Date.parse('2026-09-20T10:00:00Z'), updated: Date.parse('2026-09-20T10:05:00Z'), url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}`, felt: 12, alert: 'green', status: 'reviewed', tsunami: 0, sig: 326, magType: 'mb', ...over },
});
const body = (features: unknown[]) => new Response(JSON.stringify({ type: 'FeatureCollection', features }), { status: 200 });

function harness(responder: () => Response | Promise<Response>) {
  let clock = NOW.getTime();
  const cache = new MemoryCache(() => clock);
  const fetchMock = vi.fn(async (_u: string, _i?: RequestInit) => responder());
  const set = vi.spyOn(cache, 'set');
  const deps: ProviderDeps = { fetch: fetchMock as any, cache, now: () => NOW, env: () => undefined, logger: silentLogger };
  return { deps, fetchMock, cache, set, advance: (s: number) => { clock += s * 1000; } };
}

describe('USGS provider — request', () => {
  it('sends point, radius, min magnitude and the exact lookback window with the honest User-Agent', async () => {
    const h = harness(() => body([]));
    await createUsgsProvider(h.deps)(q({ latitude: 35.689512, longitude: 139.691712, earthquakes: { radiusKm: 120, minMagnitude: 3.5, lookbackHours: 48 } }), NOW);
    const [url, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(USGS_QUERY_URL);
    expect(Object.fromEntries(u.searchParams)).toEqual({
      format: 'geojson', latitude: '35.689512', longitude: '139.691712', maxradiuskm: '120', minmagnitude: '3.5',
      starttime: '2026-09-18T12:00:00.000Z', endtime: '2026-09-20T12:00:00.000Z',
    });
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(TOUR27_USER_AGENT);
  });
});

describe('USGS provider — mapping (raw facts, no derived risk)', () => {
  it('preserves USGS facts verbatim and normalises instants to UTC', async () => {
    const h = harness(() => body([feature('us7000')]));
    const env = await createUsgsProvider(h.deps)(q(), NOW);
    expect(env).toMatchObject({ source: 'USGS', stale: false, generatedAt: NOW.toISOString() });
    expect(env.events[0]).toEqual({
      id: 'us7000', type: 'earthquake', title: 'M 4.6 - 10 km N of Testville', latitude: 35.7, longitude: 139.7, occurredAt: '2026-09-20T10:00:00.000Z', updatedAt: '2026-09-20T10:05:00.000Z',
      source: 'USGS', sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000',
      details: { place: '10 km N of Testville', magnitude: 4.6, magnitudeType: 'mb', depthKm: 10.5, tsunami: false, alert: 'green', significance: 326, status: 'reviewed', feltReports: 12 },
    });
    expect(JSON.stringify(env)).not.toMatch(/risk|severity/i);
  });

  it('coordinate order is [lng, lat, depth]; missing optional values become null; title falls back', async () => {
    const h = harness(() => body([feature('x1', { title: null, place: null, mag: null, magType: null, alert: null, sig: null, felt: null, status: null, tsunami: 1, url: null }, [10, 20])]));
    const [e] = (await createUsgsProvider(h.deps)(q(), NOW)).events;
    expect(e).toMatchObject({ latitude: 20, longitude: 10, title: 'x1', sourceUrl: 'https://earthquake.usgs.gov/earthquakes/eventpage/x1' });
    expect(e.details).toMatchObject({ place: '', magnitude: null, magnitudeType: null, depthKm: null, alert: null, significance: null, feltReports: null, status: null, tsunami: true });
  });
});

describe('USGS provider — failure is never an empty result', () => {
  it.each([[500], [503], [400], [429]])('HTTP %i with no cached copy throws', async (status) => {
    const h = harness(() => new Response('x', { status }));
    await expect(createUsgsProvider(h.deps)(q(), NOW)).rejects.toThrow('USGS');
  });

  it.each([['not json'], ['null'], ['{}'], ['{"features":"x"}']])('malformed body %p throws', async (b) => {
    const h = harness(() => new Response(b, { status: 200 }));
    await expect(createUsgsProvider(h.deps)(q(), NOW)).rejects.toThrow('malformed');
  });

  it.each([
    ['no geometry', { id: 'a', properties: {} }], ['no id', { geometry: { coordinates: [1, 2] }, properties: { time: 1, updated: 1 } }],
    ['NaN coordinate', feature('b', {}, ['x', 2])], ['bad time', feature('c', { time: 'nope' })], ['null', null],
  ])('one unusable feature (%s) fails the whole answer instead of being dropped', async (_n, f) => {
    const h = harness(() => body([feature('good'), f]));
    await expect(createUsgsProvider(h.deps)(q(), NOW)).rejects.toThrow('unusable');
  });

  it('a network error is sanitised (no URL, no coordinates)', async () => {
    const h = harness(() => { throw new TypeError('fetch failed https://earthquake.usgs.gov/?latitude=35.6895&longitude=139.6917'); });
    const err = await createUsgsProvider(h.deps)(q(), NOW).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/35\.6895|139\.6917|usgs\.gov/);
  });
});

describe('USGS provider — cache and the flagged stale policy (observations only)', () => {
  it('serves a fresh copy (5 min) without calling USGS; writes fresh + stale copies', async () => {
    const h = harness(() => body([feature('a')]));
    const p = createUsgsProvider(h.deps);
    await p(q(), NOW);
    await p(q(), NOW);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    expect(h.set.mock.calls.map((c) => [c[0], c[2]])).toEqual([[usgsCacheKey('fresh', q()), USGS_FRESH_SECONDS], [usgsCacheKey('stale', q()), USGS_STALE_SECONDS]]);
    expect([USGS_FRESH_SECONDS, USGS_STALE_SECONDS]).toEqual([300, 1800]);
  });

  it('after freshness a live call is made; on failure the stale copy is served FLAGGED stale:true', async () => {
    let down = false;
    const h = harness(() => (down ? new Response('x', { status: 503 }) : body([feature('a')])));
    const p = createUsgsProvider(h.deps);
    await p(q(), NOW);
    h.advance(301);
    down = true;
    const env = await p(q(), new Date(NOW.getTime() + 301_000));
    expect(env.stale).toBe(true);
    expect(env.events.map((e) => e.id)).toEqual(['a']);
    expect(env.generatedAt).toBe(NOW.toISOString()); // the ORIGINAL fetch time, not now
  });

  it('once the stale copy is also gone the provider is unavailable', async () => {
    let down = false;
    const h = harness(() => (down ? new Response('x', { status: 503 }) : body([feature('a')])));
    const p = createUsgsProvider(h.deps);
    await p(q(), NOW);
    h.advance(1801);
    down = true;
    await expect(p(q(), new Date(NOW.getTime() + 1_801_000))).rejects.toThrow();
  });

  it('cache keys use the exact numeric query (distinct decimals never collapse; 1 and 1.0 are the same)', () => {
    expect(usgsCacheKey('fresh', q({ latitude: 35.6895 }))).not.toBe(usgsCacheKey('fresh', q({ latitude: 35.68951 })));
    expect(usgsCacheKey('fresh', q({ latitude: 1 }))).toBe(usgsCacheKey('fresh', q({ latitude: 1.0 })));
  });

  it('a corrupt cache entry is a miss; a cache write failure still returns live data', async () => {
    const h = harness(() => body([feature('a')]));
    await h.cache.set(usgsCacheKey('fresh', q()), '{corrupt', 300);
    expect((await createUsgsProvider(h.deps)(q(), NOW)).events).toHaveLength(1);
    const broken = { ...h.deps, cache: { get: async () => null, set: async () => { throw new Error('down'); } } };
    expect((await createUsgsProvider(broken)(q(), NOW)).events).toHaveLength(1);
  });
});
