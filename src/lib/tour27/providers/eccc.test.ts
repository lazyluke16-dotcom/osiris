import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_OPTIONS, type DestinationIntelligenceQuery } from '../contract';
import { MemoryCache, silentLogger, TOUR27_USER_AGENT, type CacheStore, type ProviderDeps } from '../runtime';
import {
  candidatesKey, cellBBox, cellOf, createEcccProvider, ECCC_ALERTS_URL, ECCC_EMPTY_ZONE_TTL_SECONDS, ECCC_FRESH_SECONDS, ECCC_MAX_CACHED_CHARS,
  ECCC_MAX_REQUESTS_PER_MINUTE, ECCC_ZONE_TTL_SECONDS, ECCC_ZONE_URL_MARINE, ECCC_ZONE_URL_PUBLIC, isWithinEcccZoneExtent, toAlerts, validity, zonesKey,
} from './eccc';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const at = (s: number) => new Date(NOW.getTime() + s * 1000);
const TORONTO = { lat: 43.6532, lng: -79.3832 };
const q = (lat = TORONTO.lat, lng = TORONTO.lng): DestinationIntelligenceQuery => ({ latitude: lat, longitude: lng, ...DEFAULT_OPTIONS });
const AROUND = { type: 'Polygon', coordinates: [[[-79.5, 43.6], [-79.3, 43.6], [-79.3, 43.7], [-79.5, 43.7], [-79.5, 43.6]]] };
/** Same 0.05° cell as TORONTO but NOT containing it. */
const SAME_CELL_OTHER = { type: 'Polygon', coordinates: [[[-79.4, 43.65], [-79.385, 43.65], [-79.385, 43.7], [-79.4, 43.7], [-79.4, 43.65]]] };
const CELL = cellOf(TORONTO.lat, TORONTO.lng);

const feature = (id: string, props: Record<string, unknown> = {}, geometry: unknown = AROUND) => ({
  id, geometry,
  properties: {
    feature_id: 'fea1-1', alert_type: 'advisory', alert_name_en: 'frost advisory', alert_name_fr: 'avis de gel', alert_text_en: 'English text', alert_text_fr: 'Texte francais',
    feature_name_en: 'Zone', feature_name_fr: 'Zone fr', publication_datetime: '2026-09-20T11:00:00Z', validity_datetime: '2026-09-20T11:30:00Z',
    expiration_datetime: '2026-09-20T15:00:00Z', event_end_datetime: '2026-09-20T14:00:00Z', status_en: 'issued', status_fr: 'émis', risk_colour_en: 'yellow', province: 'ON', alert_code: 'frost', ...props,
  },
});
const zone = (geometry: unknown) => ({ id: 'z', geometry, properties: {} });
const fc = (features: unknown[], extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ type: 'FeatureCollection', features, numberMatched: features.length, numberReturned: features.length, ...extra }), { status: 200 });

interface Sources { alerts: unknown[] | Error; pub: unknown[] | Error; marine: unknown[] | Error; extra?: Record<string, unknown> }
function harness(src: Partial<Sources> = {}, cacheOverride?: CacheStore) {
  let clock = NOW.getTime();
  const cache = new MemoryCache(() => clock);
  const state: Sources = { alerts: [], pub: [zone(AROUND)], marine: [], ...src };
  const respond = (url: string): Response => {
    const pick = url.startsWith(ECCC_ALERTS_URL) ? state.alerts : url.startsWith(ECCC_ZONE_URL_PUBLIC) ? state.pub : url.startsWith(ECCC_ZONE_URL_MARINE) ? state.marine : new Error('unexpected url');
    if (pick instanceof Error) throw pick;
    return fc(pick, url.startsWith(ECCC_ALERTS_URL) ? state.extra : undefined);
  };
  const fetchMock = vi.fn(async (url: string) => respond(url));
  const set = vi.spyOn(cache, 'set');
  const deps: ProviderDeps = { fetch: fetchMock as any, cache: cacheOverride ?? cache, now: () => new Date(clock), env: () => undefined, logger: silentLogger };
  const calls = (prefix: string) => fetchMock.mock.calls.filter((c) => (c[0] as string).startsWith(prefix)).length;
  return { deps, fetchMock, cache, state, set, calls, advance: (s: number) => { clock += s * 1000; } };
}

describe('ECCC — request shape', () => {
  it('asks GeoMet for the CELL bbox (not the point), json, limit 100, honest UA; never sends exact coordinates', async () => {
    const h = harness({ alerts: [feature('1_fea1-1')] });
    await createEcccProvider(h.deps)(q(43.653245123, -79.383251987), NOW);
    const [url, init] = h.fetchMock.mock.calls.find((c) => (c[0] as string).startsWith(ECCC_ALERTS_URL)) as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.searchParams.get('f')).toBe('json');
    expect(u.searchParams.get('limit')).toBe('100');
    expect(u.searchParams.get('bbox')).toBe(cellBBox(cellOf(43.653245123, -79.383251987)));
    expect(url).not.toContain('43.653245123');
    expect(url).not.toContain('79.383251987');
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(TOUR27_USER_AGENT);
  });

  it('cellBBox is west,south,east,north with plain decimals and stays within valid ranges', () => {
    expect(cellBBox({ i: -3600, j: 900 })).toMatch(/^-?\d+\.\d{7},-?\d+\.\d{7},-?\d+\.\d{7},-?\d+\.\d{7}$/);
    const [w, s, e, n] = cellBBox({ i: -3601, j: 1800 }).split(',').map(Number);
    expect(w).toBeGreaterThanOrEqual(-180); expect(n).toBeLessThanOrEqual(90); expect(e).toBeGreaterThan(w); expect(n).toBeGreaterThan(s);
    expect(cellBBox({ i: 1, j: 1 })).not.toMatch(/e/i);
  });
});

describe('ECCC — extent short-circuit (only the whole published extent)', () => {
  it.each([['Melbourne', -37.8136, 144.9631], ['London', 51.5, -0.12], ['far south', 30, -80], ['Iceland-east', 64.1, -10.0]])(
    '%s is outside the zone extent: outside-coverage with NO provider call and NO cache read', async (_n, lat, lng) => {
      const h = harness();
      const env = await createEcccProvider(h.deps)(q(lat, lng), NOW);
      expect(env).toMatchObject({ coverage: 'outside-coverage', alerts: [], officialWarnings: true });
      expect(h.fetchMock).not.toHaveBeenCalled();
    },
  );

  it('the extent boundary is inclusive', () => {
    expect(isWithinEcccZoneExtent(36.5, -172.17)).toBe(true);
    expect(isWithinEcccZoneExtent(83.6, -10.42)).toBe(true);
    expect(isWithinEcccZoneExtent(36.4999, -100)).toBe(false);
  });
});

describe('ECCC — exact applicability, shared retrieval', () => {
  it('a same-cell alert whose polygon does NOT contain the exact point is not returned', async () => {
    const h = harness({ alerts: [feature('1_fea1-1'), feature('2_fea1-2', {}, SAME_CELL_OTHER)] });
    const env = await createEcccProvider(h.deps)(q(), NOW);
    expect(env.alerts.map((a) => a.id)).toEqual(['1_fea1-1']);
  });

  it('two GPS-jittered points in one cell share ONE provider retrieval but get their own exact answer', async () => {
    const h = harness({ alerts: [feature('1_fea1-1'), feature('2_fea1-2', {}, SAME_CELL_OTHER)] });
    const p = createEcccProvider(h.deps);
    const inSmall = await p(q(43.66, -79.39), NOW);
    const notInSmall = await p(q(43.66, -79.383), NOW);
    expect(h.calls(ECCC_ALERTS_URL)).toBe(1);
    expect(inSmall.alerts.map((a) => a.id).sort()).toEqual(['1_fea1-1', '2_fea1-2']);
    expect(notInSmall.alerts.map((a) => a.id)).toEqual(['1_fea1-1']);
    expect(inSmall.query).toEqual({ latitude: 43.66, longitude: -79.39 });
  });

  it('one hundred jittered points inside a cell cost ONE alert request', async () => {
    const h = harness({ alerts: [feature('1_fea1-1')] });
    const p = createEcccProvider(h.deps);
    for (let k = 0; k < 100; k++) await p(q(43.652 + (k % 10) * 0.0004, -79.395 + (k % 7) * 0.0006), NOW);
    expect(h.calls(ECCC_ALERTS_URL)).toBe(1);
  });

  it('cache keys contain the cell, never exact coordinates', () => {
    expect(candidatesKey(cellOf(43.6532451, -79.383251))).toMatch(/^official-alerts:eccc:cell:-?\d+:-?\d+$/);
    expect(zonesKey(cellOf(43.6532451, -79.383251))).toMatch(/^official-alerts:eccc:zones:-?\d+:-?\d+$/);
  });
});

describe('ECCC — coverage is provider-proven', () => {
  it('an applicable alert proves coverage WITHOUT any zone lookup', async () => {
    const h = harness({ alerts: [feature('1_fea1-1')] });
    expect((await createEcccProvider(h.deps)(q(), NOW)).coverage).toBe('covered');
    expect(h.calls(ECCC_ZONE_URL_PUBLIC)).toBe(0);
  });

  it('zero alerts + a containing ECCC zone => covered + [] (public and marine both consulted)', async () => {
    const h = harness({ alerts: [], pub: [], marine: [zone(AROUND)] });
    const env = await createEcccProvider(h.deps)(q(), NOW);
    expect(env).toMatchObject({ coverage: 'covered', alerts: [] });
    expect(h.calls(ECCC_ZONE_URL_PUBLIC)).toBe(1);
    expect(h.calls(ECCC_ZONE_URL_MARINE)).toBe(1);
  });

  it('inside the extent but in NO zone (Seattle-like) is outside-coverage, never covered + []', async () => {
    const h = harness({ alerts: [], pub: [], marine: [] });
    const env = await createEcccProvider(h.deps)(q(47.6062, -122.3321), NOW);
    expect(env).toMatchObject({ coverage: 'outside-coverage', alerts: [] });
  });

  it('a same-cell alert that does not contain the point does NOT prove coverage; zones decide', async () => {
    const h = harness({ alerts: [feature('2_fea1-2', {}, SAME_CELL_OTHER)], pub: [] });
    expect((await createEcccProvider(h.deps)(q(), NOW)).coverage).toBe('outside-coverage');
  });

  it('zone lookup failure when needed => provider throws (unavailable), nothing is guessed or cached', async () => {
    const h = harness({ alerts: [], pub: new Error('zones down') });
    await expect(createEcccProvider(h.deps)(q(), NOW)).rejects.toThrow();
    expect(await h.cache.get(zonesKey(CELL))).toBeNull();
  });

  it('non-empty zones cache 24 h; EMPTY zones cache only 1 h', async () => {
    const a = harness({ alerts: [], pub: [zone(AROUND)] });
    await createEcccProvider(a.deps)(q(), NOW);
    expect(a.set.mock.calls.find((c) => c[0] === zonesKey(CELL))![2]).toBe(ECCC_ZONE_TTL_SECONDS);
    const b = harness({ alerts: [], pub: [], marine: [] });
    await createEcccProvider(b.deps)(q(), NOW);
    expect(b.set.mock.calls.find((c) => c[0] === zonesKey(CELL))![2]).toBe(ECCC_EMPTY_ZONE_TTL_SECONDS);
    expect(ECCC_EMPTY_ZONE_TTL_SECONDS).toBe(3600);
  });
});

describe('ECCC — CURRENT alerts are checked BEFORE cached geography (final review defect)', () => {
  it('REGRESSION: cached EMPTY zones + no candidate cache + a NEW alert now containing the point => provider IS called, covered + warning', async () => {
    const h = harness({ alerts: [feature('9_fea1-9')] });
    await h.cache.set(zonesKey(CELL), JSON.stringify({ geometries: [], checkedAt: at(-300).toISOString() }), 3600);
    const env = await createEcccProvider(h.deps)(q(), NOW);
    expect(h.calls(ECCC_ALERTS_URL)).toBe(1);
    expect(env.coverage).toBe('covered');
    expect(env.alerts.map((a) => a.id)).toEqual(['9_fea1-9']);
    expect(h.calls(ECCC_ZONE_URL_PUBLIC)).toBe(0);
  });

  it('cached zones excluding the point + a fresh cached applicable alert => covered + warning', async () => {
    const h = harness({});
    await h.cache.set(zonesKey(CELL), JSON.stringify({ geometries: [SAME_CELL_OTHER], checkedAt: at(-5000).toISOString() }), 3600);
    await h.cache.set(candidatesKey(CELL), JSON.stringify({ alerts: toAlerts([feature('1_fea1-1')]), fetchedAt: at(-20).toISOString() }), 60);
    const env = await createEcccProvider(h.deps)(q(), NOW);
    expect(env).toMatchObject({ coverage: 'covered' });
    expect(env.alerts).toHaveLength(1);
  });

  it('cached zones excluding the point + zero current alerts => outside-coverage, with the alert set still checked', async () => {
    const h = harness({ alerts: [] });
    await h.cache.set(zonesKey(CELL), JSON.stringify({ geometries: [SAME_CELL_OTHER], checkedAt: at(-5000).toISOString() }), 3600);
    const env = await createEcccProvider(h.deps)(q(), NOW);
    expect(env).toMatchObject({ coverage: 'outside-coverage', alerts: [], generatedAt: at(-5000).toISOString() });
    expect(h.calls(ECCC_ALERTS_URL)).toBe(1);
    expect(h.calls(ECCC_ZONE_URL_PUBLIC)).toBe(0);
  });

  it('cached zones excluding the point + provider failure => THROWS (unavailable), NEVER outside-coverage', async () => {
    const h = harness({ alerts: new Error('GeoMet down') });
    await h.cache.set(zonesKey(CELL), JSON.stringify({ geometries: [], checkedAt: at(-300).toISOString() }), 3600);
    await expect(createEcccProvider(h.deps)(q(), NOW)).rejects.toThrow();
  });

  it('cached zones containing the point + zero current alerts => covered + []', async () => {
    const h = harness({ alerts: [] });
    await h.cache.set(zonesKey(CELL), JSON.stringify({ geometries: [AROUND], checkedAt: at(-10).toISOString() }), 3600);
    expect(await createEcccProvider(h.deps)(q(), NOW)).toMatchObject({ coverage: 'covered', alerts: [] });
  });

  it('a cached-empty zone entry cannot hide an alert issued AFTER it was cached (two calls)', async () => {
    const h = harness({ alerts: [], pub: [], marine: [] });
    const p = createEcccProvider(h.deps);
    expect((await p(q(), NOW)).coverage).toBe('outside-coverage');
    h.advance(300); // 60 s candidate freshness elapsed; the 1 h empty-zone entry is still cached
    h.state.alerts = [feature('7_fea1-7')];
    const env = await p(q(), at(300));
    expect(env.coverage).toBe('covered');
    expect(env.alerts.map((a) => a.id)).toEqual(['7_fea1-7']);
  });
});

describe('ECCC — lifecycle and validity', () => {
  it.each([
    ['expiry AFTER end', '2026-09-20T15:59:40Z', '2026-09-20T15:00:00Z', '2026-09-20T15:59:40.000Z', 'expires'],
    ['expiry BEFORE end', '2026-09-21T05:21:33Z', '2026-09-21T14:00:00Z', '2026-09-21T14:00:00.000Z', 'ends'],
    ['equal instants', '2026-09-20T15:00:00Z', '2026-09-20T15:00:00Z', '2026-09-20T15:00:00.000Z', 'expires'],
  ])('validUntil is the LATER of expiration and end (%s)', (_n, exp, end, until, basis) => {
    const [a] = toAlerts([feature('1_fea1-1', { expiration_datetime: exp, event_end_datetime: end })]);
    expect(a.validUntil).toBe(until);
    expect(a.validUntilBasis).toBe(basis);
    expect(a.expires).toBe(new Date(exp).toISOString());
    expect(a.ends).toBe(new Date(end).toISOString());
  });

  it('validity handles a single known instant and none', () => {
    expect(validity('2026-09-20T15:00:00.000Z', null)).toEqual({ validUntil: '2026-09-20T15:00:00.000Z', validUntilBasis: 'expires' });
    expect(validity(null, '2026-09-20T15:00:00.000Z')).toEqual({ validUntil: '2026-09-20T15:00:00.000Z', validUntilBasis: 'ends' });
    expect(validity(null, null)).toEqual({ validUntil: null, validUntilBasis: null });
  });

  it('an alert stays visible while EITHER instant is still ahead, and is removed at READ time after both', async () => {
    const h = harness({ alerts: [feature('1_fea1-1', { expiration_datetime: '2026-09-20T12:10:00Z', event_end_datetime: '2026-09-20T13:00:00Z' })] });
    const p = createEcccProvider(h.deps);
    expect((await p(q(), NOW)).alerts).toHaveLength(1);
    expect((await p(q(), at(30 * 60))).alerts).toHaveLength(1); // expiry passed, end still ahead
    expect((await p(q(), at(61 * 60))).alerts).toHaveLength(0);
  });

  it.each(['ended', 'Ended', 'cancelled', 'CANCELLED'])('status %p is filtered (ECCC keeps ended alerts listed)', (status) => {
    expect(toAlerts([feature('1_fea1-1', { status_en: status }), feature('2_fea1-2', { status_en: 'continued' })]).map((a) => a.id)).toEqual(['2_fea1-2']);
  });

  it('the top-level feature id is REQUIRED; properties.feature_id (the zone) is never used as an alert id', () => {
    expect(() => toAlerts([{ geometry: AROUND, properties: { feature_id: 'fea1-1' } }])).toThrow('unusable alert feature');
    const two = toAlerts([feature('1_fea1-1'), feature('2_fea1-1')]); // same ZONE, different alerts
    expect(two.map((a) => a.id)).toEqual(['1_fea1-1', '2_fea1-1']);
  });

  it('duplicate alert ids are collapsed', () => {
    expect(toAlerts([feature('1_fea1-1'), feature('1_fea1-1')])).toHaveLength(1);
  });

  it('exposes the id scheme (not a CAP id) and the alert-event id only for the proven shape', () => {
    const [good] = toAlerts([feature('15194_fea1-1')]);
    expect(good.parameters.identifier_scheme).toEqual(['ECCC-GeoMet-feature-id']);
    expect(good.parameters.alert_event_id).toEqual(['15194']);
    const [odd] = toAlerts([feature('weird-id')]);
    expect(odd.parameters.alert_event_id).toBeUndefined();
  });
});

describe('ECCC — bilingual model and provider timestamp', () => {
  it('English is primary, French is a translation of the SAME alert (never a duplicate), verbatim', async () => {
    const [a] = toAlerts([feature('1_fea1-1', { status_fr: 'contradictory-fr' })]);
    expect(a.language).toBe('en-CA');
    expect(a.event).toBe('frost advisory');
    expect(a.description).toBe('English text');
    expect(a.translations).toEqual([{ language: 'fr-CA', event: 'avis de gel', headline: null, description: 'Texte francais', instruction: null, areaDescription: 'Zone fr' }]);
    expect(a.parameters.status).toEqual(['issued']);
    expect(a.parameters.status_fr).toEqual(['contradictory-fr']); // contradictory bilingual fields preserved
  });

  it('providerUpdatedAt is ALWAYS null (GeoMet timeStamp is response-generation time)', async () => {
    const h = harness({ alerts: [feature('1_fea1-1')], extra: { timeStamp: '2026-09-20T11:59:59Z' } });
    expect((await createEcccProvider(h.deps)(q(), NOW)).providerUpdatedAt).toBeNull();
  });

  it('no Tour 27 severity/risk is derived', async () => {
    const h = harness({ alerts: [feature('1_fea1-1')] });
    const [a] = (await createEcccProvider(h.deps)(q(), NOW)).alerts;
    expect(a.severity).toBeNull(); expect(a.urgency).toBeNull(); expect(a.certainty).toBeNull();
    expect(a.parameters.risk_colour).toEqual(['yellow']);
  });
});

describe('ECCC — fails safe (never an all-clear)', () => {
  it.each([
    ['a next link', { links: [{ rel: 'next', href: 'x' }] }],
    ['numberMatched > returned', { numberMatched: 5 }],
  ])('a partial page with %s is rejected', async (_n, extra) => {
    const h = harness({ alerts: [feature('1_fea1-1')], extra });
    await expect(createEcccProvider(h.deps)(q(), NOW)).rejects.toThrow('partial');
  });

  it('a FULL page (100 features) is rejected as possibly truncated', async () => {
    const h = harness({ alerts: Array.from({ length: 100 }, (_v, i) => feature(`${i}_fea1-${i}`)) });
    await expect(createEcccProvider(h.deps)(q(), NOW)).rejects.toThrow('partial');
  });

  it.each([
    ['null geometry', [feature('1_fea1-1', {}, null)]],
    ['a Point geometry', [feature('1_fea1-1', {}, { type: 'Point', coordinates: [0, 0] })]],
    ['a malformed ring', [feature('1_fea1-1', {}, { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] })]],
    ['no id', [{ geometry: AROUND, properties: {} }]],
    ['not an object', [null]],
  ])('an unverifiable feature (%s) raises instead of being dropped', async (_n, alerts) => {
    const h = harness({ alerts: alerts as unknown[] });
    await expect(createEcccProvider(h.deps)(q(), NOW)).rejects.toThrow();
  });

  it('a zone without usable geometry raises', async () => {
    const h = harness({ alerts: [], pub: [zone(null)] });
    await expect(createEcccProvider(h.deps)(q(), NOW)).rejects.toThrow('unusable zone');
  });

  it.each([[500], [503], [429], [404]])('HTTP %i raises', async (status) => {
    const h = harness();
    h.fetchMock.mockImplementation(async () => new Response('x', { status }));
    await expect(createEcccProvider(h.deps)(q(), NOW)).rejects.toThrow();
  });

  it.each([['not json'], ['{}'], ['{"features":"x"}']])('malformed body %p raises', async (body) => {
    const h = harness();
    h.fetchMock.mockImplementation(async () => new Response(body, { status: 200 }));
    await expect(createEcccProvider(h.deps)(q(), NOW)).rejects.toThrow('malformed');
  });

  it('a network error raises a sanitised error with no URL or coordinates', async () => {
    const h = harness();
    h.fetchMock.mockImplementation(async () => { throw new TypeError('fetch failed https://api.weather.gc.ca/x?bbox=-79.4,43.6'); });
    const err = await createEcccProvider(h.deps)(q(), NOW).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/api\.weather\.gc\.ca|79\.4|43\.6/);
  });
});

describe('ECCC — freshness, no stale fallback', () => {
  it('serves a fresh candidate set without calling ECCC and caches for 60 s', async () => {
    const h = harness({ alerts: [feature('1_fea1-1')] });
    const p = createEcccProvider(h.deps);
    await p(q(), NOW);
    await p(q(), at(10));
    expect(h.calls(ECCC_ALERTS_URL)).toBe(1);
    expect(h.set.mock.calls.find((c) => c[0] === candidatesKey(CELL))![2]).toBe(ECCC_FRESH_SECONDS);
    expect(ECCC_FRESH_SECONDS).toBe(60);
  });

  it('after freshness expires ECCC must confirm; if it is down the old set is NEVER returned', async () => {
    const h = harness({ alerts: [feature('1_fea1-1')] });
    const p = createEcccProvider(h.deps);
    await p(q(), NOW);
    h.advance(61);
    h.state.alerts = new Error('down');
    await expect(p(q(), at(61))).rejects.toThrow();
  });

  it('concurrent misses share one alert request', async () => {
    const h = harness({ alerts: [feature('1_fea1-1')] });
    const p = createEcccProvider(h.deps);
    await Promise.all([p(q(), NOW), p(q(), NOW), p(q(), NOW)]);
    expect(h.calls(ECCC_ALERTS_URL)).toBe(1);
  });

  it.each([
    ['not json'], ['null'], ['{"alerts":"x","fetchedAt":"t"}'], ['{"alerts":[]}'],
    ['{"alerts":[{"id":"x","areas":[{"geometry":{"type":"Polygon","coordinates":[[[0,0],[1,1]]]}}]}],"fetchedAt":"t"}'],
  ])('a corrupt candidate cache entry (%s) is a miss and is never trusted', async (raw) => {
    const h = harness({ alerts: [feature('1_fea1-1')] });
    await h.cache.set(candidatesKey(CELL), raw, 60);
    expect((await createEcccProvider(h.deps)(q(), NOW)).alerts).toHaveLength(1);
    expect(h.calls(ECCC_ALERTS_URL)).toBe(1);
  });

  it.each([
    ['not json'], ['{"geometries":"x","checkedAt":"t"}'], ['{"geometries":[]}'],
    ['{"geometries":[{"type":"Polygon","coordinates":[[[0,0],[1,1]]]}],"checkedAt":"t"}'],
  ])('a corrupt zone cache entry (%s) can NEVER produce a false outside-coverage', async (raw) => {
    const h = harness({ alerts: [], pub: [zone(AROUND)] });
    await h.cache.set(zonesKey(CELL), raw, 3600);
    expect((await createEcccProvider(h.deps)(q(), NOW)).coverage).toBe('covered');
    expect(h.calls(ECCC_ZONE_URL_PUBLIC)).toBe(1);
  });

  it('an oversized entry is returned but NOT cached; a cache write failure still returns live data', async () => {
    const big = feature('1_fea1-1', { alert_text_en: 'x'.repeat(ECCC_MAX_CACHED_CHARS) });
    const h = harness({ alerts: [big] });
    expect((await createEcccProvider(h.deps)(q(), NOW)).alerts).toHaveLength(1);
    expect(await h.cache.get(candidatesKey(CELL))).toBeNull();
    const broken: CacheStore = { get: async () => null, set: async () => { throw new Error('redis down'); } };
    const h2 = harness({ alerts: [feature('1_fea1-1')] }, broken);
    expect((await createEcccProvider(h2.deps)(q(), NOW)).alerts).toHaveLength(1);
  });
});

describe('ECCC — provider request budget fails closed', () => {
  it('after 40 provider requests in a minute further requests fail instead of exceeding the usage policy', async () => {
    const h = harness({ alerts: [] });
    const p = createEcccProvider(h.deps);
    expect(ECCC_MAX_REQUESTS_PER_MINUTE).toBe(40);
    // Each distinct far-apart cell needs its own alert request (+ zone requests): drive the budget down.
    let failed = 0;
    for (let k = 0; k < 60 && failed === 0; k++) {
      try { await p(q(40 + k * 0.5, -100), NOW); } catch { failed++; }
    }
    expect(failed).toBe(1);
    expect(h.fetchMock.mock.calls.length).toBeLessThanOrEqual(ECCC_MAX_REQUESTS_PER_MINUTE);
  });
});
