import type { DestinationIntelligenceQuery, FireHazardEvent, HazardEventEnvelope } from '../contract';
import { providerFetch, ProviderError, type ProviderDeps } from '../runtime';
import { parseCsv } from './csv';
import { boundingBoxes, haversineKm, type BoundingBox } from './geo';

/**
 * NASA FIRMS thermal detections (official LANCE FIRMS Area API) — port of the merged Tour 27 implementation.
 *  - A detection is a satellite THERMAL ANOMALY, not a confirmed wildfire (it can be an industrial flare,
 *    a volcano or another heat source). It is never labelled a confirmed fire and no severity is derived.
 *  - Nothing is decimated, rounded or fabricated (the old OSIRIS `/api/fires` sampled to ~2000 points,
 *    rounded coordinates to 3 d.p. and injected volcanoes with invented brightness/power values).
 *  - MAP_KEY (`NASA_FIRMS_MAP_KEY`) is read from the environment, sits in the provider URL path, and is
 *    NEVER logged, returned or embedded in an error (errors are rebuilt from status/name only).
 *  - NOAA-21 and NOAA-20 only (Suomi-NPP delivery ends 1 November 2026).
 *  - A partial sensor failure is `degraded` (cached 60 s, never as the stale copy); all sensors failing
 *    is a provider failure. Observation stale policy: fresh 10 min; on failure a copy up to 60 min old
 *    is served FLAGGED `stale: true`; with no copy the provider is unavailable.
 */
export const FIRMS_AREA_URL = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const FIRMS_MAP_URL = 'https://firms.modaps.eosdis.nasa.gov/map/';
const REQUEST_TIMEOUT_MS = 10_000;
export const FIRMS_SENSORS = ['VIIRS_NOAA21_NRT', 'VIIRS_NOAA20_NRT'] as const;
type FirmsSensor = (typeof FIRMS_SENSORS)[number];
export const FIRMS_MAP_KEY_ENV = 'NASA_FIRMS_MAP_KEY';
export const FIRMS_FRESH_SECONDS = 10 * 60;
export const FIRMS_STALE_SECONDS = 60 * 60;
export const FIRMS_DEGRADED_SECONDS = 60;
const REQUIRED_COLUMNS = ['latitude', 'longitude', 'acq_date', 'acq_time'];

interface CachedFirePayload { events: FireHazardEvent[]; generatedAt: string; degraded: boolean }

/** Exact query semantics; never logged (contains coordinates). */
export const firmsCacheKey = (bucket: 'fresh' | 'stale', q: DestinationIntelligenceQuery): string =>
  ['hazards', 'fires', bucket, String(q.latitude), String(q.longitude), String(q.fires.radiusKm), String(q.fires.lookbackDays)].join(':');

function normalize(sensor: FirmsSensor, row: string[], col: (row: string[], name: string) => string | null): FireHazardEvent | null {
  const latRaw = col(row, 'latitude');
  const lngRaw = col(row, 'longitude');
  const date = col(row, 'acq_date');
  const time = col(row, 'acq_time');
  const latitude = Number(latRaw);
  const longitude = Number(lngRaw);
  if (!latRaw || !lngRaw || !date || !time || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;

  // acq_time is HHMM in UTC (FIRMS documentation), zero-padded to 4 digits.
  const hhmm = time.padStart(4, '0');
  const occurred = new Date(`${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00.000Z`);
  if (Number.isNaN(occurred.getTime())) return null;

  const num = (name: string): number | null => {
    const v = col(row, name);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    id: `firms:${sensor}:${latRaw}:${lngRaw}:${date}:${hhmm}`,
    type: 'fire',
    title: 'NASA FIRMS active-fire hotspot',
    latitude,
    longitude,
    occurredAt: occurred.toISOString(),
    source: 'NASA_FIRMS',
    sourceUrl: FIRMS_MAP_URL,
    details: {
      product: sensor,
      satellite: col(row, 'satellite'),
      instrument: col(row, 'instrument'),
      confidence: col(row, 'confidence'),
      fireRadiativePowerMw: num('frp'),
      brightnessTi4Kelvin: num('bright_ti4'),
      brightnessTi5Kelvin: num('bright_ti5'),
      scanKm: num('scan'),
      trackKm: num('track'),
      acquisitionDate: date,
      acquisitionTimeUtc: hhmm,
      dayNight: col(row, 'daynight'),
      productVersion: col(row, 'version'),
    },
  };
}

export function parseFirms(sensor: FirmsSensor, body: unknown): FireHazardEvent[] {
  if (typeof body !== 'string') throw new ProviderError(`FIRMS ${sensor} returned a malformed response`);
  const rows = parseCsv(body);
  const header = rows[0];
  // FIRMS reports some errors (bad key, exhausted quota) as plain text.
  if (!header || REQUIRED_COLUMNS.some((c) => !header.includes(c))) throw new ProviderError(`FIRMS ${sensor} returned an unexpected response`);

  const col = (row: string[], name: string): string | null => {
    const i = header.indexOf(name);
    const v = i >= 0 ? row[i] : undefined;
    return v === undefined || v === '' ? null : v;
  };

  const dataRows = rows.slice(1);
  const events: FireHazardEvent[] = [];
  for (const row of dataRows) {
    const event = normalize(sensor, row, col);
    if (event) events.push(event);
  }
  if (dataRows.length > 0 && events.length === 0) throw new ProviderError(`FIRMS ${sensor} returned no parseable detections`);
  return events;
}

async function fetchSensorBox(deps: ProviderDeps, mapKey: string, sensor: FirmsSensor, box: BoundingBox, lookbackDays: number): Promise<FireHazardEvent[]> {
  const url = `${FIRMS_AREA_URL}/${mapKey}/${sensor}/${box.west},${box.south},${box.east},${box.north}/${lookbackDays}`;
  let res: Response;
  try {
    res = await providerFetch(deps, url, { timeoutMs: REQUEST_TIMEOUT_MS });
  } catch {
    // Never propagate the raw error: it carries the MAP_KEY URL.
    throw new ProviderError(`FIRMS ${sensor} request failed`);
  }
  if (!res.ok) throw new ProviderError(`FIRMS ${sensor} request failed (HTTP ${res.status})`, res.status);
  return parseFirms(sensor, await res.text());
}

async function fetchFires(deps: ProviderDeps, q: DestinationIntelligenceQuery): Promise<{ events: FireHazardEvent[]; degraded: boolean }> {
  const mapKey = deps.env(FIRMS_MAP_KEY_ENV);
  if (!mapKey) {
    deps.logger.warn(`${FIRMS_MAP_KEY_ENV} is not configured`);
    throw new ProviderError('NASA FIRMS is not configured');
  }
  const { latitude: lat, longitude: lng } = q;
  const boxes = boundingBoxes(lat, lng, q.fires.radiusKm);

  const settled = await Promise.allSettled(
    FIRMS_SENSORS.map(async (sensor) => (await Promise.all(boxes.map((box) => fetchSensorBox(deps, mapKey, sensor, box, q.fires.lookbackDays)))).flat()),
  );

  const events = new Map<string, FireHazardEvent>();
  let failed = 0;
  settled.forEach((result, i) => {
    if (result.status === 'rejected') {
      failed++;
      deps.logger.warn(`FIRMS sensor ${FIRMS_SENSORS[i]} failed`);
      return;
    }
    for (const event of result.value) {
      if (haversineKm(lat, lng, event.latitude, event.longitude) <= q.fires.radiusKm) events.set(event.id, event);
    }
  });
  if (failed === FIRMS_SENSORS.length) throw new ProviderError('All NASA FIRMS sensor requests failed');
  return { events: [...events.values()], degraded: failed > 0 };
}

const validPayload = (p: unknown): p is CachedFirePayload => {
  const x = p as CachedFirePayload | null;
  return !!x && Array.isArray(x.events) && typeof x.generatedAt === 'string' && typeof x.degraded === 'boolean';
};

export function createFirmsProvider(deps: ProviderDeps) {
  const read = async (key: string): Promise<CachedFirePayload | null> => {
    try {
      const raw = await deps.cache.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return validPayload(parsed) ? parsed : null;
    } catch {
      deps.logger.warn('cache read failed for hazards:fires; continuing');
      return null;
    }
  };
  const write = async (key: string, ttl: number, value: string): Promise<void> => {
    try { await deps.cache.set(key, value, ttl); } catch { deps.logger.warn('cache write failed for hazards:fires; returning live FIRMS data'); }
  };
  const envelope = (p: CachedFirePayload, stale: boolean): HazardEventEnvelope<FireHazardEvent> => ({ events: p.events, source: 'NASA_FIRMS', generatedAt: p.generatedAt, stale, degraded: p.degraded });

  return async function firms(query: DestinationIntelligenceQuery, now: Date): Promise<HazardEventEnvelope<FireHazardEvent>> {
    const freshKey = firmsCacheKey('fresh', query);
    const staleKey = firmsCacheKey('stale', query);

    const fresh = await read(freshKey);
    if (fresh) return envelope(fresh, false);

    let result: { events: FireHazardEvent[]; degraded: boolean };
    const started = Date.now();
    try {
      result = await fetchFires(deps, query);
    } catch (error) {
      const stale = await read(staleKey);
      if (stale) {
        deps.logger.warn('serving stale hazards:fires fallback (flagged stale)');
        return envelope(stale, true);
      }
      throw error; // no cached copy: the provider is unavailable — never an empty list
    }

    const payload: CachedFirePayload = { events: result.events, generatedAt: now.toISOString(), degraded: result.degraded };
    const serialized = JSON.stringify(payload);
    await write(freshKey, result.degraded ? FIRMS_DEGRADED_SECONDS : FIRMS_FRESH_SECONDS, serialized);
    if (!result.degraded) await write(staleKey, FIRMS_STALE_SECONDS, serialized);
    deps.logger.info(`FIRMS provider fetch succeeded in ${Date.now() - started}ms, ${result.events.length} event(s)${result.degraded ? ' (degraded: partial sensor coverage)' : ''}`);
    return envelope(payload, false);
  };
}
