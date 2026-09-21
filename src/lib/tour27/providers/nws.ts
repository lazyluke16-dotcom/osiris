import {
  NWS_ATTRIBUTION,
  NWS_AUTHORITY,
  OFFICIAL_ALERTS_DISCLAIMER,
  type DestinationIntelligenceQuery,
  type OfficialAlert,
  type OfficialAlertArea,
  type OfficialAlertCoverage,
  type OfficialAlertGeometry,
  type OfficialAlertReference,
  type OfficialAlertsEnvelope,
} from '../contract';
import { providerFetch, ProviderError, SingleFlight, type ProviderDeps } from '../runtime';

/**
 * NOAA/NWS official warnings (api.weather.gov, CAP 1.2 GeoJSON) — port of the FINAL MERGED Tour 27
 * implementation (tour27-backend df7091b). Every safety invariant is preserved:
 *  - exact point, sent and cached at full supplied precision (no truncation, no rounding);
 *  - CAP enumerations and text verbatim; no Tour 27 severity or risk;
 *  - validUntil = ends ?? expires (message `expires` often passes while the hazard `ends` is ahead);
 *  - only ACTUAL Update/Cancel messages supersede what they reference; Test/Exercise/Draft can never
 *    suppress an Actual alert; cancelled, non-actual, superseded and duplicate alerts are dropped;
 *  - strict freshness: a fresh cache entry may be served; missing/expired => live NWS; failure => the
 *    provider is unavailable (NEVER a stale set and NEVER a false all-clear);
 *  - HTTP 400 "point out of bounds" is `outside-coverage` (distinct from an empty covered answer);
 *  - alerts past validUntil are removed at READ time, even from a fresh cache entry.
 */
export const NWS_ALERTS_URL = 'https://api.weather.gov/alerts/active';
const REQUEST_TIMEOUT_MS = 10_000;
export const FRESH_MIN_SECONDS = 5;
export const FRESH_MAX_SECONDS = 60;
export const FRESH_DEFAULT_SECONDS = 30;
export const OUTSIDE_COVERAGE_TTL_SECONDS = 60 * 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any; // untrusted provider JSON: every read below is defensively typed by the helpers

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** Provider instants arrive with local offsets; an instant is normalised to UTC ISO-8601. */
function iso(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function stringList(v: unknown): string[] {
  if (typeof v === 'string') return v === '' ? [] : [v];
  if (!Array.isArray(v)) return [];
  return v.filter((x) => typeof x === 'string' || typeof x === 'number').map(String);
}

function stringRecord(v: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = stringList(val);
  }
  return out;
}

function geometryOf(g: J): OfficialAlertGeometry | null {
  if (g && (g.type === 'Polygon' || g.type === 'MultiPolygon') && Array.isArray(g.coordinates)) {
    return { type: g.type, coordinates: g.coordinates };
  }
  return null;
}

function toAlert(f: J): OfficialAlert | null {
  const p = f?.properties;
  if (!p || typeof p !== 'object') return null;
  const id = str(p.id) ?? str(f.id);
  if (!id) return null;

  const ends = iso(p.ends);
  const expires = iso(p.expires);
  const area: OfficialAlertArea = {
    description: str(p.areaDesc),
    geocodes: stringRecord(p.geocode),
    geometry: geometryOf(f.geometry),
    regionLinks: stringList(p.affectedZones),
  };
  const references: OfficialAlertReference[] = (Array.isArray(p.references) ? p.references : []).map((r: J) => ({
    identifier: str(r?.identifier),
    sender: str(r?.sender),
    sent: iso(r?.sent),
  }));

  return {
    id,
    authority: NWS_AUTHORITY,
    sourceUrl: str(p['@id']) ?? str(f.id),
    status: str(p.status),
    messageType: str(p.messageType),
    scope: str(p.scope),
    categories: stringList(p.category),
    event: str(p.event),
    urgency: str(p.urgency),
    severity: str(p.severity),
    certainty: str(p.certainty),
    responseTypes: stringList(p.response),
    sender: str(p.sender),
    senderName: str(p.senderName),
    headline: str(p.headline),
    description: str(p.description),
    instruction: str(p.instruction),
    language: str(p.language),
    translations: [],
    sent: iso(p.sent),
    effective: iso(p.effective),
    onset: iso(p.onset),
    expires,
    ends,
    validUntil: ends ?? expires,
    validUntilBasis: ends ? 'ends' : expires ? 'expires' : null,
    areas: [area],
    references,
    parameters: stringRecord(p.parameters),
    eventCodes: stringRecord(p.eventCode),
    note: str(p.note),
  };
}

/** Map provider features to OfficialAlerts and apply the lifecycle hygiene described above. */
export function toAlerts(features: J[]): OfficialAlert[] {
  const mapped: OfficialAlert[] = [];
  for (const f of features) {
    const alert = toAlert(f);
    if (alert) mapped.push(alert);
  }

  // Only ACTUAL messages may supersede anything (a test/exercise message must not hide a real alert).
  const superseded = new Set<string>();
  for (const a of mapped) {
    const type = a.messageType?.toLowerCase();
    const actual = !a.status || a.status.toLowerCase() === 'actual';
    if (actual && (type === 'update' || type === 'cancel')) {
      for (const r of a.references) if (r.identifier) superseded.add(r.identifier);
    }
  }
  const seen = new Set<string>();
  const out: OfficialAlert[] = [];
  for (const a of mapped) {
    if (a.status && a.status.toLowerCase() !== 'actual') continue;
    if (a.messageType && a.messageType.toLowerCase() === 'cancel') continue;
    if (superseded.has(a.id)) continue;
    if (seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(a);
  }
  return out;
}

const isOutOfCoverage = (body: J): boolean => {
  const type = typeof body?.type === 'string' ? body.type : '';
  const detail = typeof body?.detail === 'string' ? body.detail : '';
  return /InvalidParameter/i.test(type) && /point/i.test(detail) && /out of bounds/i.test(detail);
};

const maxAge = (cacheControl: string | null): number | null => {
  if (typeof cacheControl !== 'string') return null;
  const m = /(?:^|[\s,])(?:s-maxage|max-age)=(\d+)/i.exec(cacheControl);
  return m ? Number(m[1]) : null;
};

/** Accept a parsed object or text; the Content-Type header is never relied upon. */
function parseBody(text: string): J {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

type NwsResult =
  | { status: 'ok'; alerts: OfficialAlert[]; providerUpdatedAt: string | null; maxAgeSeconds: number | null }
  | { status: 'outside-coverage' };

interface CachedNwsPayload {
  coverage: OfficialAlertCoverage;
  alerts: OfficialAlert[];
  providerUpdatedAt: string | null;
  /** When Tour 27 last confirmed this data with NWS. */
  fetchedAt: string;
}

async function fetchActive(deps: ProviderDeps, lat: number, lng: number): Promise<NwsResult> {
  // status=actual excludes test/exercise/draft/system messages at the source. The point is sent exactly as validated.
  const url = `${NWS_ALERTS_URL}?${new URLSearchParams({ status: 'actual', point: `${lat},${lng}` }).toString()}`;
  let res: Response;
  try {
    res = await providerFetch(deps, url, { timeoutMs: REQUEST_TIMEOUT_MS, headers: { Accept: 'application/geo+json' } });
  } catch (error) {
    // Never propagate the raw error: it can embed the request URL (which carries the coordinates).
    throw new ProviderError(`NWS request failed (${error instanceof Error ? error.name : 'error'})`);
  }
  // 400 is inspected: "point out of bounds" means outside NWS coverage, not an outage.
  if (res.status !== 200 && res.status !== 400) throw new ProviderError(`NWS request failed (HTTP ${res.status})`, res.status);

  const body = parseBody(await res.text());
  if (res.status === 400) {
    if (isOutOfCoverage(body)) return { status: 'outside-coverage' };
    throw new ProviderError('NWS rejected the request (HTTP 400)', 400);
  }
  const features = body?.features;
  if (!Array.isArray(features)) throw new ProviderError('NWS returned a malformed response');
  return { status: 'ok', alerts: toAlerts(features), providerUpdatedAt: iso(body?.updated), maxAgeSeconds: maxAge(res.headers.get('cache-control')) };
}

const freshTtl = (m: number | null): number =>
  m === null || !Number.isFinite(m) ? FRESH_DEFAULT_SECONDS : Math.min(FRESH_MAX_SECONDS, Math.max(FRESH_MIN_SECONDS, Math.floor(m)));

/** Read-time lifecycle filter: only alerts still in force (validUntil unknown = cannot prove expired). */
const inForce = (alerts: OfficialAlert[], now: Date): OfficialAlert[] => {
  const t = now.getTime();
  return alerts.filter((a) => a.validUntil === null || Date.parse(a.validUntil) > t);
};

/** Cache key uses the exact coordinates as sent to NWS (never logged). */
export const nwsCacheKey = (lat: number, lng: number): string => ['official-alerts', 'nws', String(lat), String(lng)].join(':');

export function createNwsProvider(deps: ProviderDeps) {
  const flights = new SingleFlight();

  const envelope = (entry: CachedNwsPayload, lat: number, lng: number, now: Date): OfficialAlertsEnvelope => ({
    source: 'NOAA_NWS',
    authority: NWS_AUTHORITY,
    officialWarnings: true,
    generatedAt: entry.fetchedAt,
    providerUpdatedAt: entry.providerUpdatedAt,
    coverage: entry.coverage,
    attribution: NWS_ATTRIBUTION,
    disclaimer: OFFICIAL_ALERTS_DISCLAIMER,
    query: { latitude: lat, longitude: lng },
    alerts: inForce(entry.alerts, now),
  });

  async function readCache(key: string): Promise<CachedNwsPayload | null> {
    try {
      const raw = await deps.cache.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedNwsPayload;
      if (!parsed || !Array.isArray(parsed.alerts) || typeof parsed.fetchedAt !== 'string' ||
          (parsed.coverage !== 'covered' && parsed.coverage !== 'outside-coverage')) return null;
      return parsed;
    } catch {
      deps.logger.warn('cache read failed for official-alerts:nws; continuing');
      return null;
    }
  }

  async function safeSet(key: string, ttl: number, payload: CachedNwsPayload): Promise<void> {
    try {
      await deps.cache.set(key, JSON.stringify(payload), ttl);
    } catch {
      deps.logger.warn('cache write failed for official-alerts:nws; returning live NWS data');
    }
  }

  return async function nws(query: DestinationIntelligenceQuery, now: Date): Promise<OfficialAlertsEnvelope> {
    // The validated coordinates are used exactly as supplied: no truncation or rounding.
    const lat = query.latitude;
    const lng = query.longitude;
    const key = nwsCacheKey(lat, lng);

    const fresh = await readCache(key);
    if (fresh) return envelope(fresh, lat, lng, now);

    return flights.run(key, async () => {
      const started = Date.now();
      const result = await fetchActive(deps, lat, lng); // failure => ProviderError => provider unavailable
      if (result.status === 'outside-coverage') {
        const payload: CachedNwsPayload = { coverage: 'outside-coverage', alerts: [], providerUpdatedAt: null, fetchedAt: now.toISOString() };
        await safeSet(key, OUTSIDE_COVERAGE_TTL_SECONDS, payload);
        return envelope(payload, lat, lng, now);
      }
      const payload: CachedNwsPayload = { coverage: 'covered', alerts: result.alerts, providerUpdatedAt: result.providerUpdatedAt, fetchedAt: now.toISOString() };
      await safeSet(key, freshTtl(result.maxAgeSeconds), payload);
      deps.logger.info(`NWS provider fetch succeeded in ${Date.now() - started}ms, ${result.alerts.length} alert(s)`);
      return envelope(payload, lat, lng, now);
    });
  };
}
