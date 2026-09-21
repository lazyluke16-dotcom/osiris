import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_OPTIONS, WEATHER_ATTRIBUTION, type DestinationIntelligenceQuery } from '../contract';
import { MemoryCache, silentLogger, TOUR27_USER_AGENT, type ProviderDeps } from '../runtime';
import { createMetnoProvider, METNO_COMPACT_URL, METNO_FALLBACK_FRESH_SECONDS, METNO_STALE_WINDOW_SECONDS, metnoCacheKey, normalizeCoordinate, parseForecast } from './metno';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const q = (over: Partial<DestinationIntelligenceQuery> = {}): DestinationIntelligenceQuery => ({ latitude: 59.9139, longitude: 10.7522, ...DEFAULT_OPTIONS, ...over });
const at = (s: number) => new Date(NOW.getTime() + s * 1000);
const iso = (s: number) => at(s).toISOString();

const step = (offsetHours: number, over: Record<string, unknown> = {}) => ({
  time: new Date(NOW.getTime() + offsetHours * 3_600_000).toISOString(),
  data: {
    instant: { details: { air_temperature: 8.1, relative_humidity: 80, air_pressure_at_sea_level: 1012.3, cloud_area_fraction: 50, wind_speed: 3.2, wind_from_direction: 200, wind_speed_of_gust: 7.1 } },
    next_1_hours: { summary: { symbol_code: 'cloudy' }, details: { precipitation_amount: 0.2, probability_of_precipitation: 30, probability_of_thunder: 1 } },
    ...over,
  },
});
const body = (steps: unknown[], updated = '2026-09-20T11:00:00Z') => ({ properties: { meta: { updated_at: updated }, timeseries: steps } });
const ok = (b: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(b), { status: 200, headers });

function harness(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  let clock = NOW.getTime();
  const cache = new MemoryCache(() => clock);
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => responder(url, init ?? {}));
  const set = vi.spyOn(cache, 'set');
  const deps: ProviderDeps = { fetch: fetchMock as any, cache, now: () => NOW, env: () => undefined, logger: silentLogger };
  return { deps, fetchMock, cache, set, advance: (s: number) => { clock += s * 1000; } };
}

describe('normalizeCoordinate — truncation, not rounding', () => {
  it.each([
    [59.91399999, 59.9139], [59.91391, 59.9139], [-59.91399, -59.9139], [10.7522999, 10.7522], [0.29, 0.29], [1.0, 1], [-0.00004, 0], [0.00009, 0], [-0.0, 0],
  ])('%d -> %d', (input, expected) => { expect(normalizeCoordinate(input)).toBe(expected); });

  it('never yields -0 and is stable on float-hostile values (0.29 * 100 = 28.999...)', () => {
    expect(Object.is(normalizeCoordinate(-0.00001), -0)).toBe(false);
    expect(normalizeCoordinate(0.2899)).toBe(0.2899);
    expect(normalizeCoordinate(43.6532)).toBe(43.6532);
  });
});

describe('MET Norway provider — request', () => {
  it('sends TRUNCATED 4-decimal coordinates (same value as the cache key), honest UA, JSON accept; no key', async () => {
    const h = harness(() => ok(body([step(1)])));
    await createMetnoProvider(h.deps)(q({ latitude: 59.91399999, longitude: 10.75229999 }), NOW);
    const [url, init] = h.fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe(METNO_COMPACT_URL);
    expect(u.searchParams.get('lat')).toBe('59.9139');
    expect(u.searchParams.get('lon')).toBe('10.7522');
    const headers = init.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(TOUR27_USER_AGENT);
    expect(headers.Accept).toBe('application/json');
    expect(headers['If-Modified-Since']).toBeUndefined();
    expect(await h.cache.get(metnoCacheKey(59.9139, 10.7522))).not.toBeNull();
  });

  it('equivalent effective requests share ONE cache entry', async () => {
    const h = harness(() => ok(body([step(1)]), { expires: at(600).toUTCString() }));
    const p = createMetnoProvider(h.deps);
    await p(q({ latitude: 59.91391, longitude: 10.75221 }), NOW);
    await p(q({ latitude: 59.91399, longitude: 10.75229 }), NOW);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('MET Norway provider — mapping and windowing', () => {
  it('maps instant + forward-period values, normalises time to UTC, and reports providerUpdatedAt', async () => {
    const h = harness(() => ok(body([step(1)])));
    const env = await createMetnoProvider(h.deps)(q(), NOW);
    expect(env).toMatchObject({ source: 'MET_NORWAY', stale: false, attribution: WEATHER_ATTRIBUTION, providerUpdatedAt: '2026-09-20T11:00:00.000Z', location: { latitude: 59.9139, longitude: 10.7522 }, generatedAt: NOW.toISOString() });
    expect(env.forecast[0]).toEqual({
      time: '2026-09-20T13:00:00.000Z', airTemperatureC: 8.1, relativeHumidityPercent: 80, airPressureAtSeaLevelHpa: 1012.3, cloudAreaFractionPercent: 50, windSpeedMps: 3.2,
      windFromDirectionDegrees: 200, windGustMps: 7.1, symbolCode: 'cloudy', precipitationAmountMm: 0.2, precipitationPeriodHours: 1, probabilityOfPrecipitationPercent: 30, probabilityOfThunderPercent: 1,
    });
    expect(JSON.stringify(env)).not.toMatch(/risk|severity/i);
  });

  it('windows by TIMESTAMP to [now, now + forecastHours] (steps are not evenly hourly)', async () => {
    const h = harness(() => ok(body([step(-2), step(0), step(6, { next_1_hours: undefined, next_6_hours: { summary: { symbol_code: 'rain' }, details: { precipitation_amount: 3 } } }), step(24), step(25), step(72)])));
    const env = await createMetnoProvider(h.deps)(q({ forecast: { forecastHours: 24 } }), NOW);
    expect(env.forecast.map((i) => i.time)).toEqual([iso(0), iso(6 * 3600), iso(24 * 3600)]);
    expect(env.forecast[1]).toMatchObject({ precipitationPeriodHours: 6, symbolCode: 'rain', precipitationAmountMm: 3 });
  });

  it('missing values stay null (never invented); an unparseable step is skipped', () => {
    const p = parseForecast(body([{ time: 'nope', data: {} }, { time: '2026-09-20T13:00:00Z', data: {} }]));
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ airTemperatureC: null, symbolCode: null, precipitationPeriodHours: null, windGustMps: null });
  });

  it('a body without a timeseries is a failure; an invalid updated_at is null', () => {
    expect(() => parseForecast({})).toThrow('no timeseries');
    expect(parseForecast(body([], 'garbage')).providerUpdatedAt).toBeNull();
  });
});

describe('MET Norway provider — provider Expires and conditional requests', () => {
  it('honours a valid FUTURE Expires exactly: no upstream call before it', async () => {
    const h = harness(() => ok(body([step(1)]), { expires: at(1800).toUTCString() }));
    const p = createMetnoProvider(h.deps);
    await p(q(), NOW);
    await p(q(), at(1799));
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    h.advance(1801);
    await p(q(), at(1801));
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([[undefined], ['garbage'], [new Date(NOW.getTime() - 60_000).toUTCString()]])('a missing/invalid/past Expires (%p) falls back to a bounded 10 minutes', async (expires) => {
    const h = harness(() => ok(body([step(1)]), expires ? { expires } : {}));
    const p = createMetnoProvider(h.deps);
    await p(q(), NOW);
    await p(q(), at(METNO_FALLBACK_FRESH_SECONDS - 1));
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
    h.advance(METNO_FALLBACK_FRESH_SECONDS + 1);
    await p(q(), at(METNO_FALLBACK_FRESH_SECONDS + 1));
    expect(h.fetchMock).toHaveBeenCalledTimes(2);
    expect(METNO_FALLBACK_FRESH_SECONDS).toBe(600);
  });

  it('revalidates with If-Modified-Since; a 304 confirms the cached payload and refreshes fetchedAt/expiry', async () => {
    let call = 0;
    const h = harness((_u, init) => {
      call++;
      if (call === 1) return ok(body([step(30)]), { 'last-modified': 'Sun, 20 Sep 2026 11:00:00 GMT', expires: at(600).toUTCString() });
      expect((init.headers as Record<string, string>)['If-Modified-Since']).toBe('Sun, 20 Sep 2026 11:00:00 GMT');
      return new Response(null, { status: 304, headers: { expires: at(1500).toUTCString() } });
    });
    const p = createMetnoProvider(h.deps);
    await p(q({ forecast: { forecastHours: 48 } }), NOW);
    h.advance(601);
    const env = await p(q({ forecast: { forecastHours: 48 } }), at(601));
    expect(env.stale).toBe(false);
    expect(env.generatedAt).toBe(iso(601)); // confirmed current by the provider now
    expect(env.forecast).toHaveLength(1);
  });

  it('a 304 with no cached payload is a failure', async () => {
    const h = harness(() => new Response(null, { status: 304 }));
    await expect(createMetnoProvider(h.deps)(q(), NOW)).rejects.toThrow('304 without a cached payload');
  });
});

describe('MET Norway provider — flagged stale fallback, bounded from expiresAt', () => {
  it('after freshness ends and MET Norway fails, the cached payload is served FLAGGED stale:true', async () => {
    let down = false;
    const h = harness(() => (down ? new Response('x', { status: 503 }) : ok(body([step(1), step(20)]), { expires: at(600).toUTCString() })));
    const p = createMetnoProvider(h.deps);
    await p(q(), NOW);
    h.advance(601);
    down = true;
    const env = await p(q(), at(601));
    expect(env.stale).toBe(true);
    expect(env.generatedAt).toBe(NOW.toISOString()); // last provider confirmation, not now
    expect(env.forecast.length).toBeGreaterThan(0);
  });

  it('beyond the 6 h window after expiry there is NO fallback: the provider is unavailable', async () => {
    let down = false;
    const h = harness(() => (down ? new Response('x', { status: 503 }) : ok(body([step(1)]), { expires: at(600).toUTCString() })));
    const p = createMetnoProvider(h.deps);
    await p(q(), NOW);
    h.advance(600 + METNO_STALE_WINDOW_SECONDS + 5);
    down = true;
    await expect(p(q(), at(600 + METNO_STALE_WINDOW_SECONDS + 5))).rejects.toThrow();
    expect(METNO_STALE_WINDOW_SECONDS).toBe(21_600);
  });

  it.each([[500], [503], [429], [403], [404]])('HTTP %i with no cache throws (never an empty forecast)', async (status) => {
    const h = harness(() => new Response('x', { status }));
    await expect(createMetnoProvider(h.deps)(q(), NOW)).rejects.toThrow();
  });

  it('a network error is sanitised (no URL, no coordinates)', async () => {
    const h = harness(() => { throw new TypeError('fetch failed https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=59.9139&lon=10.7522'); });
    const err = await createMetnoProvider(h.deps)(q(), NOW).catch((e: Error) => e);
    expect((err as Error).message).not.toMatch(/59\.9139|10\.7522|api\.met\.no/);
  });

  it('a corrupt cache entry is a miss', async () => {
    const h = harness(() => ok(body([step(1)])));
    await h.cache.set(metnoCacheKey(59.9139, 10.7522), '{corrupt', 3600);
    expect((await createMetnoProvider(h.deps)(q(), NOW)).forecast).toHaveLength(1);
    expect(h.fetchMock).toHaveBeenCalledTimes(1);
  });
});
