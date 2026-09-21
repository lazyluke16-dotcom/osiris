import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_OPTIONS, type DestinationIntelligenceQuery } from '../contract';
import { MemoryCache, silentLogger, TOUR27_USER_AGENT, type Logger, type ProviderDeps } from '../runtime';
import { createFirmsProvider, FIRMS_AREA_URL, FIRMS_DEGRADED_SECONDS, FIRMS_FRESH_SECONDS, FIRMS_MAP_KEY_ENV, FIRMS_SENSORS, FIRMS_STALE_SECONDS, firmsCacheKey, parseFirms } from './firms';

const NOW = new Date('2026-09-20T12:00:00.000Z');
const KEY = 'SECRETMAPKEY0123456789abcdef';
const q = (over: Partial<DestinationIntelligenceQuery> = {}): DestinationIntelligenceQuery => ({ latitude: -33.8688, longitude: 151.2093, ...DEFAULT_OPTIONS, ...over });

const HEADER = 'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight';
const row = (lat: string, lng: string, time = '145', extra: Partial<Record<string, string>> = {}) =>
  [lat, lng, '330.5', '0.4', '0.37', '2026-09-20', time, extra.satellite ?? 'N21', 'VIIRS', extra.confidence ?? 'n', '2.0NRT', '290.1', extra.frp ?? '3.2', 'D'].join(',');
const csv = (...rows: string[]) => [HEADER, ...rows].join('\n');

function harness(responder: (url: string) => Response | Promise<Response>, env: Record<string, string | undefined> = { [FIRMS_MAP_KEY_ENV]: KEY }, logger: Logger = silentLogger) {
  let clock = NOW.getTime();
  const cache = new MemoryCache(() => clock);
  const fetchMock = vi.fn(async (url: string, _i?: RequestInit) => responder(url));
  const set = vi.spyOn(cache, 'set');
  const deps: ProviderDeps = { fetch: fetchMock as any, cache, now: () => NOW, env: (n) => env[n], logger };
  return { deps, fetchMock, cache, set, advance: (s: number) => { clock += s * 1000; } };
}
const okCsv = (text: string) => new Response(text, { status: 200 });

describe('FIRMS provider — request and secrets', () => {
  it('queries NOAA-21 and NOAA-20 only (never Suomi-NPP) with the honest User-Agent', async () => {
    const h = harness(() => okCsv(csv()));
    await createFirmsProvider(h.deps)(q(), NOW);
    const urls = h.fetchMock.mock.calls.map((c) => c[0] as string);
    expect(FIRMS_SENSORS).toEqual(['VIIRS_NOAA21_NRT', 'VIIRS_NOAA20_NRT']);
    expect(urls.some((u) => u.includes('SNPP'))).toBe(false);
    for (const s of FIRMS_SENSORS) expect(urls.some((u) => u.startsWith(`${FIRMS_AREA_URL}/${KEY}/${s}/`))).toBe(true);
    expect(((h.fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>)['User-Agent']).toBe(TOUR27_USER_AGENT);
  });

  it('a missing MAP_KEY is a provider failure and nothing is requested', async () => {
    const h = harness(() => okCsv(csv()), {});
    await expect(createFirmsProvider(h.deps)(q(), NOW)).rejects.toThrow('not configured');
    expect(h.fetchMock).not.toHaveBeenCalled();
  });

  it('the MAP_KEY never appears in logs, errors or the response (it lives in the URL path)', async () => {
    const lines: string[] = [];
    const logger: Logger = { info: (m) => lines.push(m), warn: (m) => lines.push(m) };
    const h = harness(() => { throw new TypeError(`fetch failed for https://firms.modaps.eosdis.nasa.gov/api/area/csv/${KEY}/VIIRS_NOAA21_NRT/1,2,3,4/1`); }, undefined, logger);
    const err = await createFirmsProvider(h.deps)(q(), NOW).catch((e: Error) => e);
    expect(String((err as Error).message) + lines.join('\n')).not.toContain(KEY);

    const ok = harness(() => okCsv(csv(row('-33.86', '151.2'))), undefined, logger);
    const env = await createFirmsProvider(ok.deps)(q(), NOW);
    expect(JSON.stringify(env) + lines.join('\n')).not.toContain(KEY);
  });

  it('an HTTP error status is sanitised (status only, no URL)', async () => {
    const h = harness(() => new Response('x', { status: 403 }));
    const err = await createFirmsProvider(h.deps)(q(), NOW).catch((e: Error) => e);
    expect((err as Error).message).toMatch(/All NASA FIRMS sensor requests failed/);
    expect((err as Error).message).not.toContain(KEY);
  });
});

describe('FIRMS provider — thermal detections, nothing fabricated', () => {
  it('maps a detection with full precision, verbatim provider fields, and a thermal-anomaly title (not a confirmed fire)', async () => {
    const h = harness(() => okCsv(csv(row('-33.8412345', '151.2098765'))));
    const env = await createFirmsProvider(h.deps)(q(), NOW);
    expect(env).toMatchObject({ source: 'NASA_FIRMS', stale: false, degraded: false });
    const e = env.events[0];
    expect(e).toMatchObject({ latitude: -33.8412345, longitude: 151.2098765, occurredAt: '2026-09-20T01:45:00.000Z', type: 'fire', sourceUrl: 'https://firms.modaps.eosdis.nasa.gov/map/' });
    expect(e.id).toBe('firms:VIIRS_NOAA21_NRT:-33.8412345:151.2098765:2026-09-20:0145');
    expect(e.details).toEqual({
      product: 'VIIRS_NOAA21_NRT', satellite: 'N21', instrument: 'VIIRS', confidence: 'n', fireRadiativePowerMw: 3.2, brightnessTi4Kelvin: 330.5, brightnessTi5Kelvin: 290.1,
      scanKm: 0.4, trackKm: 0.37, acquisitionDate: '2026-09-20', acquisitionTimeUtc: '0145', dayNight: 'D', productVersion: '2.0NRT',
    });
    expect(e.updatedAt).toBeUndefined(); // FIRMS publishes no update timestamp; none is fabricated
    expect(e.title).not.toMatch(/confirmed|wildfire is/i);
    expect(JSON.stringify(env)).not.toMatch(/risk|severity/i);
  });

  it('is NOT decimated: every detection inside the radius is returned (well over 2000)', async () => {
    const rows = Array.from({ length: 2500 }, (_v, i) => row((-33.8688 + (i % 50) * 0.0001).toFixed(4), (151.2093 + Math.floor(i / 50) * 0.0001).toFixed(4), String(100 + (i % 50))));
    const h = harness((url) => okCsv(url.includes('NOAA21') ? csv(...rows) : csv()));
    expect((await createFirmsProvider(h.deps)(q(), NOW)).events).toHaveLength(2500);
  });

  it('post-filters by true distance: a detection in the bounding box but outside the radius is dropped', async () => {
    const h = harness((url) => okCsv(url.includes('NOAA21') ? csv(row('-33.86', '151.21'), row('-33.10', '151.21')) : csv()));
    const env = await createFirmsProvider(h.deps)(q({ fires: { radiusKm: 20, lookbackDays: 1 } }), NOW);
    expect(env.events.map((e) => e.latitude)).toEqual([-33.86]);
  });

  it('the same detection reported by both sensors keeps one entry per sensor id; identical ids collapse', async () => {
    const h = harness(() => okCsv(csv(row('-33.86', '151.2'), row('-33.86', '151.2'))));
    const env = await createFirmsProvider(h.deps)(q(), NOW);
    expect(env.events).toHaveLength(2); // one per sensor (ids differ by sensor); duplicate rows within a sensor collapse
  });

  it('pads acq_time to HHMM and rejects rows with unusable coordinates/time without inventing values', () => {
    const events = parseFirms('VIIRS_NOAA21_NRT', csv(row('-1', '1', '5'), row('abc', '1'), row('', '1'), row('1', '1', '9999')));
    expect(events.map((e) => e.details.acquisitionTimeUtc)).toEqual(['0005']);
  });

  it.each([['not,csv,with,wrong,header\n1,2,3,4,5'], ['Invalid MAP_KEY.'], ['']])('a plain-text/unexpected response (%p) is a failure, never "no fires"', (text) => {
    expect(() => parseFirms('VIIRS_NOAA21_NRT', text)).toThrow('unexpected response');
  });

  it('a header with rows but none parseable is a failure; a header-only file is a valid empty answer', () => {
    expect(() => parseFirms('VIIRS_NOAA21_NRT', csv(row('abc', 'def')))).toThrow('no parseable detections');
    expect(parseFirms('VIIRS_NOAA21_NRT', csv())).toEqual([]);
  });
});

describe('FIRMS provider — degraded and failure semantics', () => {
  it('one sensor failing => degraded:true results, cached only 60 s and NEVER written as the stale copy', async () => {
    const h = harness((url) => (url.includes('NOAA20') ? new Response('x', { status: 500 }) : okCsv(csv(row('-33.86', '151.2')))));
    const env = await createFirmsProvider(h.deps)(q(), NOW);
    expect(env).toMatchObject({ degraded: true, stale: false });
    expect(h.set.mock.calls.map((c) => [c[0], c[2]])).toEqual([[firmsCacheKey('fresh', q()), FIRMS_DEGRADED_SECONDS]]);
  });

  it('all sensors failing with no cached copy => the provider throws (never an empty list)', async () => {
    const h = harness(() => new Response('x', { status: 503 }));
    await expect(createFirmsProvider(h.deps)(q(), NOW)).rejects.toThrow('All NASA FIRMS sensor requests failed');
  });

  it('healthy answer: fresh 10 min + stale 60 min copies; on total failure the stale copy is served flagged stale:true', async () => {
    let down = false;
    const h = harness(() => (down ? new Response('x', { status: 503 }) : okCsv(csv(row('-33.86', '151.2')))));
    const p = createFirmsProvider(h.deps);
    await p(q(), NOW);
    expect(h.set.mock.calls.map((c) => c[2])).toEqual([FIRMS_FRESH_SECONDS, FIRMS_STALE_SECONDS]);
    expect([FIRMS_FRESH_SECONDS, FIRMS_STALE_SECONDS, FIRMS_DEGRADED_SECONDS]).toEqual([600, 3600, 60]);
    h.advance(601);
    down = true;
    const env = await p(q(), new Date(NOW.getTime() + 601_000));
    expect(env).toMatchObject({ stale: true, degraded: false });
    expect(env.events).toHaveLength(2);
  });

  it('a fresh cache hit does not call FIRMS', async () => {
    const h = harness(() => okCsv(csv()));
    const p = createFirmsProvider(h.deps);
    await p(q(), NOW);
    const before = h.fetchMock.mock.calls.length;
    await p(q(), NOW);
    expect(h.fetchMock.mock.calls.length).toBe(before);
  });

  it('an antimeridian-spanning radius issues two boxes per sensor', async () => {
    const h = harness(() => okCsv(csv()));
    await createFirmsProvider(h.deps)(q({ latitude: 0, longitude: 179.9, fires: { radiusKm: 300, lookbackDays: 1 } }), NOW);
    expect(h.fetchMock.mock.calls.length).toBe(FIRMS_SENSORS.length * 2);
  });
});
