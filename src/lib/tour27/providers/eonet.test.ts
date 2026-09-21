import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_OPTIONS, EONET_ATTRIBUTION, EONET_DISCLAIMER, type DestinationIntelligenceQuery } from '../contract';
import { MemoryCache, silentLogger, TOUR27_USER_AGENT, type ProviderDeps } from '../runtime';
import { createEonetProvider, EONET_DEGRADED_SECONDS, EONET_EVENTS_URL, EONET_FRESH_SECONDS, EONET_STALE_SECONDS, eonetCacheKey, toEvent } from './eonet';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const q = (over: Partial<DestinationIntelligenceQuery> = {}): DestinationIntelligenceQuery => ({ latitude: 37.5, longitude: 15.0, ...DEFAULT_OPTIONS, ...over });

const point = (lng: number, lat: number, extra: Record<string, unknown> = {}) => ({ type: 'Point', date: '2026-09-19T00:00:00Z', coordinates: [lng, lat], ...extra });
const event = (id: string, geometry: unknown[], extra: Record<string, unknown> = {}) => ({
  id, title: `Event ${id}`, description: null, link: `https://eonet.gsfc.nasa.gov/api/v3/events/${id}`, closed: null,
  categories: [{ id: 'volcanoes', title: 'Volcanoes' }], sources: [{ id: 'SIVolcano', url: 'https://volcano.si.edu/x' }], geometry, ...extra,
});
const ok = (events: unknown[], contentType = 'application/rss+xml') => new Response(JSON.stringify({ title: 'EONET Events', events }), { status: 200, headers: { 'content-type': contentType } });

function harness(responder: (url: string) => Response | Promise<Response>) {
  let clock = NOW.getTime();
  const cache = new MemoryCache(() => clock);
  const fetchMock = vi.fn(async (url: string, _i?: RequestInit) => responder(url));
  const set = vi.spyOn(cache, 'set');
  const deps: ProviderDeps = { fetch: fetchMock as any, cache, now: () => NOW, env: () => undefined, logger: silentLogger };
  return { deps, fetchMock, cache, set, advance: (s: number) => { clock += s * 1000; } };
}

describe('EONET provider — request', () => {
  it('uses API v3, status=open, days, the west,north,east,south bbox, honest UA', async () => {
    const h = harness(() => ok([]));
    await createEonetProvider(h.deps)(q({ environmentalEvents: { radiusKm: 100, lookbackDays: 7 } }), NOW);
    const [url, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(EONET_EVENTS_URL);
    expect(EONET_EVENTS_URL).toContain('/api/v3/');
    expect(u.searchParams.get('status')).toBe('open');
    expect(u.searchParams.get('days')).toBe('7');
    const [w, n, e, s] = u.searchParams.get('bbox')!.split(',').map(Number);
    expect(w).toBeLessThan(15); expect(e).toBeGreaterThan(15); expect(n).toBeGreaterThan(37.5); expect(s).toBeLessThan(37.5);
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(TOUR27_USER_AGENT);
  });

  it('an antimeridian-spanning search issues two boxes', async () => {
    const h = harness(() => ok([]));
    await createEonetProvider(h.deps)(q({ latitude: 0, longitude: 179.9, environmentalEvents: { radiusKm: 300, lookbackDays: 30 } }), NOW);
    expect(h.fetchMock.mock.calls.length).toBe(2);
  });

  it('parses the body as JSON even when labelled application/rss+xml', async () => {
    const h = harness(() => ok([event('EONET_1', [point(15.0, 37.6)])], 'application/rss+xml'));
    expect((await createEonetProvider(h.deps)(q(), NOW)).events).toHaveLength(1);
  });
});

describe('EONET provider — envelope is informational context only', () => {
  it('is informationalOnly with attribution + disclaimer, and derives no severity/risk/emergency status', async () => {
    const h = harness(() => ok([event('EONET_1', [point(15.0, 37.6, { magnitudeValue: 40, magnitudeUnit: 'kts', magnitudeDescription: 'Wind' })])]));
    const env = await createEonetProvider(h.deps)(q(), NOW);
    expect(env).toMatchObject({ source: 'NASA_EONET', informationalOnly: true, stale: false, degraded: false, attribution: EONET_ATTRIBUTION, disclaimer: EONET_DISCLAIMER, query: { latitude: 37.5, longitude: 15.0, radiusKm: 500, lookbackDays: 30 } });
    expect(env.disclaimer).toMatch(/not an official warning/i);
    expect(JSON.stringify(env)).not.toMatch(/"(risk|severity|emergency)/i);
  });
});

describe('EONET provider — spatial rules', () => {
  it('a Point within the radius matches by point-distance with a rounded distance; one beyond is excluded', () => {
    const near = toEvent(event('a', [point(15.0, 37.6)]), 37.5, 15.0, 100, );
    expect(near!.spatialMatch.basis).toBe('point-distance');
    expect(near!.spatialMatch.nearestPointDistanceKm).toBeCloseTo(11.1, 0);
    expect(toEvent(event('b', [point(15.0, 40.5)]), 37.5, 15.0, 100)).toBeNull();
  });

  it('uses the NEAREST of several points', () => {
    const e = toEvent(event('a', [point(15.0, 39.0), point(15.0, 37.51)]), 37.5, 15.0, 50)!;
    expect(e.spatialMatch.nearestPointDistanceKm).toBeLessThan(2);
  });

  it('a Polygon-only event is accepted on the provider bounding-box match and LABELLED as such (no fabricated distance)', () => {
    const poly = { type: 'Polygon', date: '2026-09-19T00:00:00Z', coordinates: [[[14, 37], [16, 37], [16, 38], [14, 38], [14, 37]]] };
    const e = toEvent(event('a', [poly]), 37.5, 15.0, 100)!;
    expect(e.spatialMatch).toEqual({ basis: 'provider-bbox-polygon', nearestPointDistanceKm: null });
  });

  it('an event with no usable geometry or no id is excluded', () => {
    expect(toEvent(event('a', []), 37.5, 15.0, 100)).toBeNull();
    expect(toEvent(event('a', [{ type: 'LineString', coordinates: [] }]), 37.5, 15.0, 100)).toBeNull();
    expect(toEvent({ title: 'x', geometry: [point(15, 37.5)] }, 37.5, 15.0, 100)).toBeNull();
  });

  it('takes the most recent geometry that carries a magnitude; otherwise null', () => {
    const e = toEvent(event('a', [point(15, 37.5, { date: '2026-09-18T00:00:00Z', magnitudeValue: 10, magnitudeUnit: 'kts' }), point(15, 37.5, { date: '2026-09-19T00:00:00Z', magnitudeValue: 20, magnitudeUnit: 'kts' })]), 37.5, 15.0, 100)!;
    expect(e.magnitudeValue).toBe(20);
    expect(toEvent(event('b', [point(15, 37.5)]), 37.5, 15.0, 100)!.magnitudeValue).toBeNull();
  });

  it('keeps provenance links as strings only (nothing is fetched) and closed events\' closedAt', () => {
    const e = toEvent(event('a', [point(15, 37.5)], { closed: '2026-09-19T05:00:00Z' }), 37.5, 15.0, 100)!;
    expect(e.closedAt).toBe('2026-09-19T05:00:00Z');
    expect(e.sources).toEqual([{ id: 'SIVolcano', url: 'https://volcano.si.edu/x' }]);
  });

  it('duplicate ids across boxes collapse', async () => {
    const h = harness(() => ok([event('EONET_1', [point(179.95, 0.1)])]));
    const env = await createEonetProvider(h.deps)(q({ latitude: 0, longitude: 179.9, environmentalEvents: { radiusKm: 300, lookbackDays: 30 } }), NOW);
    expect(env.events).toHaveLength(1);
  });
});

describe('EONET provider — failure and cache policy', () => {
  it.each([[500], [503], [404], [429]])('HTTP %i with no cached copy throws (never empty)', async (status) => {
    const h = harness(() => new Response('x', { status }));
    await expect(createEonetProvider(h.deps)(q(), NOW)).rejects.toThrow();
  });

  it.each([['not json'], ['null'], ['{}'], ['{"events":"x"}']])('malformed body %p throws', async (b) => {
    const h = harness(() => new Response(b, { status: 200 }));
    // A malformed box is a failed box; with every box failed the provider fails (same as Tour 27).
    await expect(createEonetProvider(h.deps)(q(), NOW)).rejects.toThrow('All NASA EONET requests failed');
  });

  it('one box failing => degraded:true, cached 60 s, never the stale copy', async () => {
    let n = 0;
    const h = harness(() => (n++ === 0 ? new Response('x', { status: 500 }) : ok([event('EONET_1', [point(179.95, 0.1)])])));
    const env = await createEonetProvider(h.deps)(q({ latitude: 0, longitude: 179.9, environmentalEvents: { radiusKm: 300, lookbackDays: 30 } }), NOW);
    expect(env.degraded).toBe(true);
    expect(h.set.mock.calls.map((c) => [c[0], c[2]])).toEqual([[eonetCacheKey('fresh', q({ latitude: 0, longitude: 179.9, environmentalEvents: { radiusKm: 300, lookbackDays: 30 } })), EONET_DEGRADED_SECONDS]]);
  });

  it('healthy answer: fresh 15 min + stale 2 h; on failure the stale copy is served FLAGGED stale:true', async () => {
    let down = false;
    const h = harness(() => (down ? new Response('x', { status: 503 }) : ok([event('EONET_1', [point(15, 37.6)])])));
    const p = createEonetProvider(h.deps);
    await p(q(), NOW);
    expect(h.set.mock.calls.map((c) => c[2])).toEqual([EONET_FRESH_SECONDS, EONET_STALE_SECONDS]);
    expect([EONET_FRESH_SECONDS, EONET_STALE_SECONDS, EONET_DEGRADED_SECONDS]).toEqual([900, 7200, 60]);
    h.advance(901);
    down = true;
    const env = await p(q(), new Date(NOW.getTime() + 901_000));
    expect(env.stale).toBe(true);
    expect(env.informationalOnly).toBe(true);
    expect(env.events).toHaveLength(1);
  });

  it('a fresh hit does not call EONET; a corrupt cache entry is a miss', async () => {
    const h = harness(() => ok([]));
    const p = createEonetProvider(h.deps);
    await p(q(), NOW); await p(q(), NOW);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    await h.cache.set(eonetCacheKey('fresh', q()), '{corrupt', 900);
    await p(q(), NOW);
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a network error is sanitised (no URL, no coordinates)', async () => {
    const h = harness(() => { throw new TypeError('fetch failed https://eonet.gsfc.nasa.gov/api/v3/events?bbox=14,38,16,37'); });
    const err = await createEonetProvider(h.deps)(q(), NOW).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/eonet\.gsfc|bbox|14,38/);
  });
});
