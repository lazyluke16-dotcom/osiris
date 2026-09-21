import {
  EONET_ATTRIBUTION,
  EONET_DISCLAIMER,
  type DestinationIntelligenceQuery,
  type EnvironmentalEvent,
  type EnvironmentalEventsEnvelope,
  type EonetGeometry,
  type EonetSpatialMatch,
} from '../contract';
import { providerFetch, ProviderError, type ProviderDeps } from '../runtime';
import { boundingBoxes, haversineKm, type BoundingBox } from './geo';

/**
 * NASA EONET environmental-event CONTEXT (API v3 only; v2.1 is deprecated) — port of the merged Tour 27
 * implementation. EONET is curated INFORMATIONAL context: not an official warning, no Tour 27 severity,
 * risk or emergency status, and linked third-party source content is never fetched.
 *  - Point geometry is distance-filtered (haversine); Polygon-only events are matched on the provider
 *    bounding box and flagged `provider-bbox-polygon` (no distance is fabricated); events with no usable
 *    geometry are excluded.
 *  - Antimeridian-safe search boxes; the provider box is expanded outward to 4 decimals so it never shrinks.
 *  - The response body is parsed as JSON regardless of Content-Type (EONET may label JSON as rss+xml).
 *  - Duplicate ids across boxes collapse. A partial box failure is `degraded` (cached 60 s, never stale copy);
 *    all boxes failing is a provider failure. Stale policy: fresh 15 min; on failure a copy up to 2 h old is
 *    served FLAGGED `stale: true`; with no copy the provider is unavailable.
 * Not the old OSIRIS `/api/weather` + `/api/fires` EONET handling (stealth fetch, no radius/lookback,
 * volcanoes injected into fires).
 */
export const EONET_EVENTS_URL = 'https://eonet.gsfc.nasa.gov/api/v3/events';
const REQUEST_TIMEOUT_MS = 10_000;
export const EONET_FRESH_SECONDS = 15 * 60;
export const EONET_STALE_SECONDS = 2 * 60 * 60;
export const EONET_DEGRADED_SECONDS = 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any; // untrusted provider JSON

interface CachedEventsPayload { events: EnvironmentalEvent[]; generatedAt: string; degraded: boolean }

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
/** Expand outward to four decimals so the provider box never shrinks the search area. */
const floor4 = (v: number, min: number) => Math.max(min, Math.floor(v * 1e4) / 1e4);
const ceil4 = (v: number, max: number) => Math.min(max, Math.ceil(v * 1e4) / 1e4);

export const eonetCacheKey = (bucket: 'fresh' | 'stale', q: DestinationIntelligenceQuery): string =>
  ['environmental-events', 'eonet', bucket, String(q.latitude), String(q.longitude), String(q.environmentalEvents.radiusKm), String(q.environmentalEvents.lookbackDays)].join(':');

/**
 * Point geometry present: at least one Point must be within radiusKm (exact haversine). Polygon-only:
 * accepted on the provider bounding-box match and labelled as such. No usable geometry: excluded.
 */
function matchSpatially(geometries: EonetGeometry[], lat: number, lng: number, radiusKm: number): EonetSpatialMatch | null {
  const distances: number[] = [];
  for (const g of geometries) {
    if (g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
    const [pLng, pLat] = g.coordinates as number[];
    if (typeof pLat !== 'number' || typeof pLng !== 'number') continue;
    distances.push(haversineKm(lat, lng, pLat, pLng));
  }
  if (distances.length > 0) {
    const nearest = Math.min(...distances);
    if (nearest > radiusKm) return null;
    return { basis: 'point-distance', nearestPointDistanceKm: Math.round(nearest * 10) / 10 };
  }
  if (geometries.some((g) => g.type === 'Polygon')) return { basis: 'provider-bbox-polygon', nearestPointDistanceKm: null };
  return null;
}

export function toEvent(raw: J, lat: number, lng: number, radiusKm: number): EnvironmentalEvent | null {
  const id = str(raw?.id);
  if (!id) return null;

  const geometries: EonetGeometry[] = [];
  for (const g of Array.isArray(raw.geometry) ? raw.geometry : []) {
    if (g?.type !== 'Point' && g?.type !== 'Polygon') continue;
    geometries.push({
      type: g.type,
      date: str(g.date),
      coordinates: g.coordinates ?? null,
      magnitudeValue: num(g.magnitudeValue),
      magnitudeUnit: str(g.magnitudeUnit),
      magnitudeDescription: str(g.magnitudeDescription),
    });
  }

  const spatialMatch = matchSpatially(geometries, lat, lng, radiusKm);
  if (!spatialMatch) return null;

  const withMagnitude = geometries
    .filter((g) => g.magnitudeValue !== null)
    .sort((a, b) => Date.parse(b.date ?? '') - Date.parse(a.date ?? ''))[0];

  return {
    id,
    title: str(raw.title),
    description: str(raw.description),
    sourceUrl: str(raw.link),
    closedAt: str(raw.closed),
    categories: (Array.isArray(raw.categories) ? raw.categories : []).map((c: J) => ({ id: str(c?.id), title: str(c?.title) })),
    sources: (Array.isArray(raw.sources) ? raw.sources : []).map((s: J) => ({ id: str(s?.id), url: str(s?.url) })),
    geometries,
    magnitudeValue: withMagnitude?.magnitudeValue ?? null,
    magnitudeUnit: withMagnitude?.magnitudeUnit ?? null,
    magnitudeDescription: withMagnitude?.magnitudeDescription ?? null,
    spatialMatch,
  };
}

async function fetchBox(deps: ProviderDeps, box: BoundingBox, days: number): Promise<J[]> {
  // EONET bbox order: west, north, east, south.
  const bbox = [floor4(box.west, -180), ceil4(box.north, 90), ceil4(box.east, 180), floor4(box.south, -90)].join(',');
  const url = `${EONET_EVENTS_URL}?${new URLSearchParams({ status: 'open', days: String(days), bbox }).toString()}`;
  let res: Response;
  try {
    res = await providerFetch(deps, url, { timeoutMs: REQUEST_TIMEOUT_MS, headers: { Accept: 'application/json' } });
  } catch (error) {
    throw new ProviderError(`EONET request failed (${error instanceof Error ? error.name : 'error'})`);
  }
  if (!res.ok) throw new ProviderError(`EONET request failed (HTTP ${res.status})`, res.status);
  let body: J = null;
  try { body = JSON.parse(await res.text()); } catch { body = null; } // Content-Type is deliberately ignored
  const events = body && typeof body === 'object' ? body.events : undefined;
  if (!Array.isArray(events)) throw new ProviderError('EONET returned a malformed response (missing events array)');
  return events;
}

async function fetchEvents(deps: ProviderDeps, q: DestinationIntelligenceQuery): Promise<{ events: EnvironmentalEvent[]; degraded: boolean }> {
  const { latitude: lat, longitude: lng } = q;
  const { radiusKm, lookbackDays } = q.environmentalEvents;
  const boxes = boundingBoxes(lat, lng, radiusKm);
  const settled = await Promise.allSettled(boxes.map((box) => fetchBox(deps, box, lookbackDays)));

  const byId = new Map<string, J>();
  let failed = 0;
  settled.forEach((result, i) => {
    if (result.status === 'rejected') { failed++; deps.logger.warn(`EONET box ${i + 1}/${boxes.length} failed`); return; }
    for (const raw of result.value) {
      const id = str(raw?.id);
      if (id && !byId.has(id)) byId.set(id, raw);
    }
  });
  if (failed === boxes.length) throw new ProviderError('All NASA EONET requests failed');

  const events: EnvironmentalEvent[] = [];
  for (const raw of byId.values()) {
    const event = toEvent(raw, lat, lng, radiusKm);
    if (event) events.push(event);
  }
  return { events, degraded: failed > 0 };
}

const validPayload = (p: unknown): p is CachedEventsPayload => {
  const x = p as CachedEventsPayload | null;
  return !!x && Array.isArray(x.events) && typeof x.generatedAt === 'string' && typeof x.degraded === 'boolean';
};

export function createEonetProvider(deps: ProviderDeps) {
  const read = async (key: string): Promise<CachedEventsPayload | null> => {
    try {
      const raw = await deps.cache.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return validPayload(parsed) ? parsed : null;
    } catch {
      deps.logger.warn('cache read failed for environmental-events; continuing');
      return null;
    }
  };
  const write = async (key: string, ttl: number, value: string): Promise<void> => {
    try { await deps.cache.set(key, value, ttl); } catch { deps.logger.warn('cache write failed for environmental-events; returning live EONET data'); }
  };
  const envelope = (p: CachedEventsPayload, q: DestinationIntelligenceQuery, stale: boolean): EnvironmentalEventsEnvelope => ({
    source: 'NASA_EONET',
    generatedAt: p.generatedAt,
    stale,
    degraded: p.degraded,
    informationalOnly: true,
    attribution: EONET_ATTRIBUTION,
    disclaimer: EONET_DISCLAIMER,
    query: { latitude: q.latitude, longitude: q.longitude, radiusKm: q.environmentalEvents.radiusKm, lookbackDays: q.environmentalEvents.lookbackDays },
    events: p.events,
  });

  return async function eonet(query: DestinationIntelligenceQuery, now: Date): Promise<EnvironmentalEventsEnvelope> {
    const freshKey = eonetCacheKey('fresh', query);
    const staleKey = eonetCacheKey('stale', query);

    const fresh = await read(freshKey);
    if (fresh) return envelope(fresh, query, false);

    let result: { events: EnvironmentalEvent[]; degraded: boolean };
    const started = Date.now();
    try {
      result = await fetchEvents(deps, query);
    } catch (error) {
      const stale = await read(staleKey);
      if (stale) {
        deps.logger.warn('serving stale environmental-events fallback (flagged stale)');
        return envelope(stale, query, true);
      }
      throw error; // no cached copy: the provider is unavailable — never an empty list
    }

    const payload: CachedEventsPayload = { events: result.events, generatedAt: now.toISOString(), degraded: result.degraded };
    const serialized = JSON.stringify(payload);
    await write(freshKey, result.degraded ? EONET_DEGRADED_SECONDS : EONET_FRESH_SECONDS, serialized);
    if (!result.degraded) await write(staleKey, EONET_STALE_SECONDS, serialized);
    deps.logger.info(`EONET provider fetch succeeded in ${Date.now() - started}ms, ${result.events.length} event(s)${result.degraded ? ' (degraded: partial box coverage)' : ''}`);
    return envelope(payload, query, false);
  };
}
