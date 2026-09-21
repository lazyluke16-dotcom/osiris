import {
  ECCC_ATTRIBUTION,
  ECCC_AUTHORITY,
  OFFICIAL_ALERTS_DISCLAIMER,
  type DestinationIntelligenceQuery,
  type OfficialAlert,
  type OfficialAlertGeometry,
  type OfficialAlertsEnvelope,
  type OfficialAlertTranslation,
} from '../contract';
import { providerFetch, ProviderError, RequestBudget, SingleFlight, type ProviderDeps } from '../runtime';
import { isWellFormedGeometry, pointInGeometry } from './geometry';

/**
 * Environment and Climate Change Canada official warnings (MSC GeoMet) — port of the FINAL MERGED
 * Tour 27 implementation (tour27-backend 22fa69b, merge acb2321). Preserved hardening:
 *  - GeoMet `weather-alerts` is the active-warning source; coverage is PROVEN by ECCC public + marine
 *    forecast zones (never a coarse Canada envelope);
 *  - 0.05-degree candidate CELLS decide what is fetched/cached; the caller's EXACT coordinates decide
 *    applicability (exact point-in-polygon, no truncation);
 *  - CURRENT alerts are obtained BEFORE any cached geography: an applicable alert is always
 *    `covered` and can never be overridden by a cached zone/outside verdict; zones decide covered vs
 *    outside only when ZERO alerts apply; alert-fetch failure => unavailable; zone failure when needed
 *    => unavailable; only a point outside the WHOLE published zone extent short-circuits;
 *  - top-level GeoMet feature id required; `properties.feature_id` (the ZONE) is never an alert id;
 *  - malformed geometry, unverifiable features, truncated/paginated sets fail safe (unavailable);
 *  - validUntil = LATER of expiration_datetime and event_end_datetime; status ended/cancelled dropped;
 *  - English primary, French in translations[]; providerUpdatedAt is null (GeoMet `timeStamp` is
 *    response-generation time, not data freshness);
 *  - 60 s fresh candidates, no stale fallback, 24 h non-empty / 1 h empty zone cache, 40 req/min
 *    per-process budget that fails closed, bounded cache entry size.
 */
export const ECCC_ALERTS_URL = 'https://api.weather.gc.ca/collections/weather-alerts/items';
export const ECCC_ZONE_URL_PUBLIC = 'https://api.weather.gc.ca/collections/public-standard-forecast-zones/items';
export const ECCC_ZONE_URL_MARINE = 'https://api.weather.gc.ca/collections/marine-standard-forecast-zones/items';
const REQUEST_TIMEOUT_MS = 10_000;
const PAGE_LIMIT = 100;
export const ECCC_MAX_REQUESTS_PER_MINUTE = 40;
export const ECCC_FRESH_SECONDS = 60;
export const ECCC_ZONE_TTL_SECONDS = 24 * 60 * 60;
/** Empty zone answers are re-checked after 1 h; subordinate to alerts, so they can only affect the covered/outside LABEL of a zero-alert response. */
export const ECCC_EMPTY_ZONE_TTL_SECONDS = 60 * 60;
/** Largest single cache entry (UTF-16 chars); bigger answers are returned but not cached. */
export const ECCC_MAX_CACHED_CHARS = 400_000;

/** Spatial extent published by GeoMet for the forecast-zone collections. Outside it no ECCC zone can exist. */
export const ECCC_ZONE_EXTENT = { minLat: 36.5, maxLat: 83.6, minLng: -172.17, maxLng: -10.42 } as const;
export const isWithinEcccZoneExtent = (lat: number, lng: number): boolean =>
  lat >= ECCC_ZONE_EXTENT.minLat && lat <= ECCC_ZONE_EXTENT.maxLat && lng >= ECCC_ZONE_EXTENT.minLng && lng <= ECCC_ZONE_EXTENT.maxLng;

// ── search cells ────────────────────────────────────────────────────────────
export const ECCC_CELL_SIZE_DEGREES = 0.05;
const CELL_MARGIN_DEGREES = 0.000001;
export interface EcccCell { i: number; j: number }
export const cellOf = (lat: number, lng: number): EcccCell => ({ i: Math.floor(lng / ECCC_CELL_SIZE_DEGREES), j: Math.floor(lat / ECCC_CELL_SIZE_DEGREES) });
/** OGC `bbox` = west,south,east,north (plain decimals, never exponent notation), clamped to valid ranges. */
export function cellBBox(cell: EcccCell): string {
  const west = Math.max(-180, cell.i * ECCC_CELL_SIZE_DEGREES - CELL_MARGIN_DEGREES);
  const south = Math.max(-90, cell.j * ECCC_CELL_SIZE_DEGREES - CELL_MARGIN_DEGREES);
  const east = Math.min(180, (cell.i + 1) * ECCC_CELL_SIZE_DEGREES + CELL_MARGIN_DEGREES);
  const north = Math.min(90, (cell.j + 1) * ECCC_CELL_SIZE_DEGREES + CELL_MARGIN_DEGREES);
  return [west, south, east, north].map((n) => n.toFixed(7)).join(',');
}
export const cellId = (cell: EcccCell): string => `${cell.i}:${cell.j}`;
export const candidatesKey = (cell: EcccCell): string => ['official-alerts', 'eccc', 'cell', cellId(cell)].join(':');
export const zonesKey = (cell: EcccCell): string => ['official-alerts', 'eccc', 'zones', cellId(cell)].join(':');

// ── mapping ─────────────────────────────────────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any; // untrusted provider JSON

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);
function iso(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}
/** Provider geometry, or null when absent OR structurally malformed (never silently "not covering"). */
const geometryOf = (g: J): OfficialAlertGeometry | null => (isWellFormedGeometry(g) ? { type: g.type, coordinates: g.coordinates } : null);

/** In force until the LATER of expiry and end; null only when neither is known. */
export function validity(expires: string | null, ends: string | null): { validUntil: string | null; validUntilBasis: 'ends' | 'expires' | null } {
  if (expires && ends) return Date.parse(ends) > Date.parse(expires) ? { validUntil: ends, validUntilBasis: 'ends' } : { validUntil: expires, validUntilBasis: 'expires' };
  if (expires) return { validUntil: expires, validUntilBasis: 'expires' };
  if (ends) return { validUntil: ends, validUntilBasis: 'ends' };
  return { validUntil: null, validUntilBasis: null };
}

function toAlert(f: J): OfficialAlert | null {
  const p = f?.properties;
  if (!p || typeof p !== 'object') return null;
  // The alert's own feature id is required. `properties.feature_id` is only the ZONE, shared by every alert in it.
  const id = str(f.id);
  const geometry = geometryOf(f.geometry);
  if (!id || !geometry) return null;

  const expires = iso(p.expiration_datetime);
  const ends = iso(p.event_end_datetime);
  const parameters: Record<string, string[]> = {};
  const add = (k: string, v: unknown) => { if (str(v)) parameters[k] = [String(v)]; };
  // The GeoMet id is "<ECCC alert-event id>_<zone feature id>". It is NOT a CAP identifier.
  add('identifier_scheme', 'ECCC-GeoMet-feature-id');
  const m = /^(\d+)_(fea[\w-]+)$/.exec(id);
  if (m && m[2] === str(p.feature_id)) add('alert_event_id', m[1]);
  add('alert_type', p.alert_type);
  add('status', p.status_en);
  add('status_fr', p.status_fr);
  add('risk_colour', p.risk_colour_en);
  add('risk_colour_fr', p.risk_colour_fr);
  add('confidence', p.confidence_en);
  add('confidence_fr', p.confidence_fr);
  add('impact', p.impact_en);
  add('impact_fr', p.impact_fr);
  add('alert_short_name', p.alert_short_name_en);
  add('alert_short_name_fr', p.alert_short_name_fr);
  add('province', p.province);
  add('feature_id', p.feature_id);
  add('validity_datetime', iso(p.validity_datetime));

  const translations: OfficialAlertTranslation[] = [];
  if (str(p.alert_name_fr) || str(p.alert_text_fr) || str(p.feature_name_fr)) {
    translations.push({ language: 'fr-CA', event: str(p.alert_name_fr), headline: null, description: str(p.alert_text_fr), instruction: null, areaDescription: str(p.feature_name_fr) });
  }

  return {
    id,
    authority: ECCC_AUTHORITY,
    sourceUrl: null,
    status: null,
    messageType: null,
    scope: null,
    categories: [],
    event: str(p.alert_name_en),
    urgency: null,
    severity: null,
    certainty: null,
    responseTypes: [],
    sender: null,
    senderName: null,
    headline: null,
    description: str(p.alert_text_en),
    instruction: null,
    language: 'en-CA',
    translations,
    sent: iso(p.publication_datetime),
    effective: iso(p.validity_datetime),
    onset: null,
    expires,
    ends,
    ...validity(expires, ends),
    areas: [{ description: str(p.feature_name_en), geocodes: {}, geometry, regionLinks: [] }],
    references: [],
    parameters,
    eventCodes: str(p.alert_code) ? { 'ECCC:alert_code': [String(p.alert_code)] } : {},
    note: null,
  };
}

/**
 * Map GeoMet features to candidates. A feature whose applicability cannot be verified (not an object,
 * no id, no usable geometry) raises an error rather than being dropped: dropping could hide a warning.
 */
export function toAlerts(features: J[]): OfficialAlert[] {
  const out: OfficialAlert[] = [];
  const seen = new Set<string>();
  for (const f of features) {
    const alert = toAlert(f);
    if (!alert) throw new ProviderError('ECCC returned an unusable alert feature');
    if (seen.has(alert.id)) continue;
    // Observed live: ECCC keeps an ended alert listed with status `ended`; never show one as current.
    const status = (alert.parameters.status?.[0] ?? '').toLowerCase();
    if (status === 'ended' || status === 'cancelled') continue;
    seen.add(alert.id);
    out.push(alert);
  }
  return out;
}

// ── provider ────────────────────────────────────────────────────────────────
interface CachedCandidates { alerts: OfficialAlert[]; fetchedAt: string }
interface CachedZones { geometries: OfficialAlertGeometry[]; checkedAt: string }

export function createEcccProvider(deps: ProviderDeps) {
  const flights = new SingleFlight();
  const budget = new RequestBudget(ECCC_MAX_REQUESTS_PER_MINUTE, () => deps.now().getTime());

  async function fetchPage(url: string, cell: EcccCell): Promise<J[]> {
    if (!budget.reserve()) throw new ProviderError('ECCC request budget exhausted'); // fail closed, never exceed the usage policy
    const target = `${url}?${new URLSearchParams({ f: 'json', bbox: cellBBox(cell), limit: String(PAGE_LIMIT) }).toString()}`;
    let res: Response;
    try {
      res = await providerFetch(deps, target, { timeoutMs: REQUEST_TIMEOUT_MS, headers: { Accept: 'application/geo+json, application/json' } });
    } catch (error) {
      throw new ProviderError(`ECCC request failed (${error instanceof Error ? error.name : 'error'})`);
    }
    if (res.status !== 200) throw new ProviderError(`ECCC request failed (HTTP ${res.status})`, res.status);
    let body: J = null;
    try { body = JSON.parse(await res.text()); } catch { body = null; }
    const features = body?.features;
    if (!Array.isArray(features)) throw new ProviderError('ECCC returned a malformed response');
    // A truncated page could hide an applicable warning, so it is never accepted.
    const hasNext = Array.isArray(body.links) && body.links.some((l: J) => l?.rel === 'next');
    const shortOfTotal = typeof body.numberMatched === 'number' && body.numberMatched > features.length;
    if (hasNext || shortOfTotal || features.length >= PAGE_LIMIT) throw new ProviderError('ECCC returned a partial response');
    return features;
  }

  async function fetchZoneGeometries(cell: EcccCell): Promise<OfficialAlertGeometry[]> {
    const out: OfficialAlertGeometry[] = [];
    for (const url of [ECCC_ZONE_URL_PUBLIC, ECCC_ZONE_URL_MARINE]) {
      for (const z of await fetchPage(url, cell)) {
        const geometry = geometryOf(z?.geometry);
        if (!geometry) throw new ProviderError('ECCC returned an unusable zone');
        out.push(geometry);
      }
    }
    return out;
  }

  async function safeSet(key: string, ttl: number, payload: CachedCandidates | CachedZones): Promise<void> {
    try {
      const json = JSON.stringify(payload);
      if (json.length > ECCC_MAX_CACHED_CHARS) { deps.logger.warn('cache entry for official-alerts:eccc exceeds the size cap and was not cached'); return; }
      await deps.cache.set(key, json, ttl);
    } catch {
      deps.logger.warn('cache write failed for official-alerts:eccc; returning live ECCC data');
    }
  }

  async function readCandidates(key: string): Promise<CachedCandidates | null> {
    try {
      const raw = await deps.cache.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedCandidates;
      if (!parsed || !Array.isArray(parsed.alerts) || typeof parsed.fetchedAt !== 'string') return null;
      // A corrupt cached alert could hide or invent a warning: any unusable alert voids the entry.
      if (!parsed.alerts.every((a) => a && typeof a.id === 'string' && isWellFormedGeometry(a.areas?.[0]?.geometry))) return null;
      return parsed;
    } catch {
      deps.logger.warn('cache read failed for official-alerts:eccc; continuing');
      return null;
    }
  }

  async function readZones(key: string): Promise<CachedZones | null> {
    try {
      const raw = await deps.cache.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedZones;
      if (!parsed || !Array.isArray(parsed.geometries) || typeof parsed.checkedAt !== 'string') return null;
      if (!parsed.geometries.every((g) => isWellFormedGeometry(g))) return null; // corrupt geometry must never become a false outside-coverage
      return parsed;
    } catch {
      deps.logger.warn('zone cache read failed for official-alerts:eccc; continuing');
      return null;
    }
  }

  /** Fresh cached candidate set for the cell, or one coalesced provider fetch. Failure => throws (unavailable). */
  function candidates(cell: EcccCell, now: Date): Promise<CachedCandidates> {
    const key = candidatesKey(cell);
    return flights.run(key, async () => {
      const fresh = await readCandidates(key);
      if (fresh) return fresh;
      const started = Date.now();
      const alerts = toAlerts(await fetchPage(ECCC_ALERTS_URL, cell));
      const payload: CachedCandidates = { alerts, fetchedAt: now.toISOString() };
      await safeSet(key, ECCC_FRESH_SECONDS, payload);
      deps.logger.info(`ECCC provider fetch succeeded in ${Date.now() - started}ms, ${alerts.length} candidate alert(s)`);
      return payload;
    });
  }

  /** Cached ECCC zone geometries for the cell (24 h; 1 h when empty), or one coalesced provider fetch. */
  function zones(cell: EcccCell, now: Date): Promise<CachedZones> {
    const key = zonesKey(cell);
    return flights.run(key, async () => {
      const cached = await readZones(key);
      if (cached) return cached;
      const geometries = await fetchZoneGeometries(cell);
      const payload: CachedZones = { geometries, checkedAt: now.toISOString() };
      await safeSet(key, geometries.length === 0 ? ECCC_EMPTY_ZONE_TTL_SECONDS : ECCC_ZONE_TTL_SECONDS, payload);
      return payload;
    });
  }

  const inForce = (alerts: OfficialAlert[], now: Date): OfficialAlert[] => {
    const t = now.getTime();
    return alerts.filter((a) => a.validUntil === null || Date.parse(a.validUntil) > t);
  };

  const envelope = (coverage: OfficialAlertsEnvelope['coverage'], alerts: OfficialAlert[], generatedAt: string, lat: number, lng: number): OfficialAlertsEnvelope => ({
    source: 'ECCC',
    authority: ECCC_AUTHORITY,
    officialWarnings: true,
    generatedAt,
    providerUpdatedAt: null,
    coverage,
    attribution: ECCC_ATTRIBUTION,
    disclaimer: OFFICIAL_ALERTS_DISCLAIMER,
    query: { latitude: lat, longitude: lng },
    alerts,
  });

  return async function eccc(query: DestinationIntelligenceQuery, now: Date): Promise<OfficialAlertsEnvelope> {
    const lat = query.latitude;
    const lng = query.longitude;

    // Cannot lie in any ECCC zone: nothing is asked of ECCC and nothing is assessed. No reassurance implied.
    if (!isWithinEcccZoneExtent(lat, lng)) return envelope('outside-coverage', [], now.toISOString(), lat, lng);

    const cell = cellOf(lat, lng);

    // ORDER MATTERS: operational alerts first. No cached geographic fact may be consulted before the
    // current alert set, or it could suppress a newly issued warning.
    const cand = await candidates(cell, now);
    const applicable = cand.alerts.filter((a) => pointInGeometry(lat, lng, a.areas[0].geometry));

    // An applicable alert polygon proves coverage and is never overridden by the zone cache; only with
    // zero applicable alerts do ECCC's (cached or fetched) zones decide covered vs outside-coverage.
    if (applicable.length === 0) {
      const z = await zones(cell, now);
      if (!z.geometries.some((g) => pointInGeometry(lat, lng, g))) return envelope('outside-coverage', [], z.checkedAt, lat, lng);
    }
    return envelope('covered', inForce(applicable, now), cand.fetchedAt, lat, lng);
  };
}
