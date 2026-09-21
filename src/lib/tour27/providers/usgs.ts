import type { DestinationIntelligenceQuery, EarthquakeHazardEvent, HazardEventEnvelope } from '../contract';
import { providerFetch, ProviderError, type ProviderDeps } from '../runtime';

/**
 * USGS earthquakes (official FDSN Event Web Service) — port of the merged Tour 27 implementation.
 * Observation semantics: point + radius + minimum magnitude + lookback window sent to USGS; raw
 * provider facts preserved (magnitude, PAGER alert, significance, status, ...); NO severity or risk
 * derived. Cache policy (observations only — never used for official warnings): fresh 5 min; on a
 * provider failure a copy up to 30 min old is served FLAGGED `stale: true`; with no copy the provider
 * is unavailable. The old OSIRIS `/api/earthquakes` (global list, false-empty on failure) is NOT used.
 */
export const USGS_QUERY_URL = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const REQUEST_TIMEOUT_MS = 5000;
export const USGS_FRESH_SECONDS = 5 * 60;
export const USGS_STALE_SECONDS = 30 * 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any; // untrusted provider JSON

interface CachedHazardPayload { events: EarthquakeHazardEvent[]; generatedAt: string }

/** Exact numeric query semantics, mirrored from Tour 27 (String() is canonical without collapsing distinct decimals). */
export const usgsCacheKey = (bucket: 'fresh' | 'stale', q: DestinationIntelligenceQuery): string =>
  ['hazards', 'earthquakes', bucket, String(q.latitude), String(q.longitude), String(q.earthquakes.radiusKm), String(q.earthquakes.minMagnitude), String(q.earthquakes.lookbackHours)].join(':');

function normalize(feature: J): EarthquakeHazardEvent {
  const props = feature?.properties;
  const coords = feature?.geometry?.coordinates;
  if (!props || !Array.isArray(coords) || coords.length < 2 || typeof feature.id !== 'string') throw new ProviderError('USGS returned an unusable feature');
  const [longitude, latitude, depthKm] = coords as number[];
  if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) throw new ProviderError('USGS returned an unusable feature');
  const occurredAt = new Date(props.time);
  const updatedAt = new Date(props.updated);
  if (Number.isNaN(occurredAt.getTime()) || Number.isNaN(updatedAt.getTime())) throw new ProviderError('USGS returned an unusable feature');

  return {
    id: feature.id,
    type: 'earthquake',
    title: props.title || props.place || feature.id,
    latitude,
    longitude,
    occurredAt: occurredAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    source: 'USGS',
    sourceUrl: props.url || `https://earthquake.usgs.gov/earthquakes/eventpage/${feature.id}`,
    details: {
      place: props.place || '',
      magnitude: props.mag ?? null,
      magnitudeType: props.magType ?? null,
      depthKm: depthKm ?? null,
      tsunami: Boolean(props.tsunami),
      alert: props.alert ?? null,
      significance: props.sig ?? null,
      status: props.status ?? null,
      feltReports: props.felt ?? null,
    },
  };
}

async function fetchEarthquakes(deps: ProviderDeps, q: DestinationIntelligenceQuery, now: Date): Promise<EarthquakeHazardEvent[]> {
  const params = new URLSearchParams({
    format: 'geojson',
    latitude: String(q.latitude),
    longitude: String(q.longitude),
    maxradiuskm: String(q.earthquakes.radiusKm),
    minmagnitude: String(q.earthquakes.minMagnitude),
    starttime: new Date(now.getTime() - q.earthquakes.lookbackHours * 3_600_000).toISOString(),
    endtime: now.toISOString(),
  });
  let res: Response;
  try {
    res = await providerFetch(deps, `${USGS_QUERY_URL}?${params.toString()}`, { timeoutMs: REQUEST_TIMEOUT_MS });
  } catch (error) {
    throw new ProviderError(`USGS earthquake feed request failed (${error instanceof Error ? error.name : 'error'})`);
  }
  if (!res.ok) throw new ProviderError(`USGS earthquake feed request failed (HTTP ${res.status})`, res.status);
  let body: J = null;
  try { body = JSON.parse(await res.text()); } catch { body = null; }
  if (!body || !Array.isArray(body.features)) throw new ProviderError('USGS earthquake feed returned a malformed response');
  return body.features.map(normalize); // any unusable feature fails the whole answer (never silently dropped)
}

const validPayload = (p: unknown): p is CachedHazardPayload => {
  const x = p as CachedHazardPayload | null;
  return !!x && Array.isArray(x.events) && typeof x.generatedAt === 'string';
};

export function createUsgsProvider(deps: ProviderDeps) {
  const read = async (key: string): Promise<CachedHazardPayload | null> => {
    try {
      const raw = await deps.cache.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return validPayload(parsed) ? parsed : null;
    } catch {
      deps.logger.warn('cache read failed for hazards:earthquakes; continuing');
      return null;
    }
  };
  const write = async (key: string, ttl: number, value: string): Promise<void> => {
    try { await deps.cache.set(key, value, ttl); } catch { deps.logger.warn('cache write failed for hazards:earthquakes; returning live USGS data'); }
  };
  const envelope = (p: CachedHazardPayload, stale: boolean): HazardEventEnvelope<EarthquakeHazardEvent> => ({ events: p.events, source: 'USGS', generatedAt: p.generatedAt, stale });

  return async function usgs(query: DestinationIntelligenceQuery, now: Date): Promise<HazardEventEnvelope<EarthquakeHazardEvent>> {
    const freshKey = usgsCacheKey('fresh', query);
    const staleKey = usgsCacheKey('stale', query);

    const fresh = await read(freshKey);
    if (fresh) return envelope(fresh, false);

    let events: EarthquakeHazardEvent[];
    const started = Date.now();
    try {
      events = await fetchEarthquakes(deps, query, now);
    } catch (error) {
      const stale = await read(staleKey);
      if (stale) {
        deps.logger.warn('serving stale hazards:earthquakes fallback (flagged stale)');
        return envelope(stale, true);
      }
      throw error; // no cached copy: the provider is unavailable — never an empty list
    }

    const payload: CachedHazardPayload = { events, generatedAt: now.toISOString() };
    const serialized = JSON.stringify(payload);
    await write(freshKey, USGS_FRESH_SECONDS, serialized);
    await write(staleKey, USGS_STALE_SECONDS, serialized);
    deps.logger.info(`USGS provider fetch succeeded in ${Date.now() - started}ms, ${events.length} event(s)`);
    return envelope(payload, false);
  };
}
