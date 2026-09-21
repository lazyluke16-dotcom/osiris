import {
  WEATHER_ATTRIBUTION,
  type DestinationIntelligenceQuery,
  type WeatherForecastEnvelope,
  type WeatherForecastItem,
} from '../contract';
import { providerFetch, ProviderError, type ProviderDeps } from '../runtime';

/**
 * MET Norway Locationforecast 2.0 (compact) — port of the merged Tour 27 implementation. This is a real
 * FORECAST (context), unrelated to the old OSIRIS `/api/weather` route (which merges environmental events
 * and alerts). Preserved behaviour:
 *  - honest User-Agent; no API key;
 *  - coordinates truncated toward zero to 4 decimals (MET Norway's request), on the decimal string, and
 *    used identically for the provider call and the cache key;
 *  - the provider's `Expires` is honoured EXACTLY (no upstream call before it); a missing/invalid/past
 *    Expires falls back to a bounded 10 minutes;
 *  - conditional requests via `If-Modified-Since`; a 304 confirms the cached payload;
 *  - stale policy: after freshness ends a payload may serve as a provider-failure fallback FLAGGED
 *    `stale: true` for at most 6 h measured from `expiresAt`; with nothing usable the provider is unavailable;
 *  - the response is windowed by timestamp to [now, now + forecastHours].
 */
export const METNO_COMPACT_URL = 'https://api.met.no/weatherapi/locationforecast/2.0/compact';
const REQUEST_TIMEOUT_MS = 10_000;
/** Used only when the provider supplies no usable (valid, future) Expires header. */
export const METNO_FALLBACK_FRESH_SECONDS = 10 * 60;
export const METNO_STALE_WINDOW_SECONDS = 6 * 60 * 60;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any; // untrusted provider JSON

interface ProviderForecast { providerUpdatedAt: string | null; items: WeatherForecastItem[] }
interface CachedForecast {
  forecast: ProviderForecast;
  lastModified: string | null;
  /** Exact provider Expires (or bounded fallback): no upstream call before this instant. */
  expiresAt: string;
  /** Last time the payload was confirmed current by the provider (200 or 304). */
  fetchedAt: string;
}

/** Truncate (never round) to 4 decimals on the decimal string; avoids float artefacts and "-0". */
export function normalizeCoordinate(value: number): number {
  const [whole, fraction = ''] = Math.abs(value).toFixed(10).split('.');
  const truncated = Number(`${whole}.${fraction.slice(0, 4)}`);
  if (truncated === 0) return 0;
  return value < 0 ? -truncated : truncated;
}

export const metnoCacheKey = (lat: number, lng: number): string => ['weather', 'forecast', String(lat), String(lng)].join(':');

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function parseForecast(body: J): ProviderForecast {
  const series = body?.properties?.timeseries;
  if (!Array.isArray(series)) throw new ProviderError('MET Norway response has no timeseries');

  const items: WeatherForecastItem[] = [];
  for (const step of series) {
    const parsed = Date.parse(step?.time);
    if (Number.isNaN(parsed)) continue;
    const d = step?.data?.instant?.details ?? {};
    // Forward period resolution changes along the series (1h, then 6h, then 12h).
    const periods: Array<[number, J]> = [[1, step?.data?.next_1_hours], [6, step?.data?.next_6_hours], [12, step?.data?.next_12_hours]];
    const found = periods.find(([, p]) => p && (p.summary || p.details));
    const periodHours = found ? found[0] : null;
    const period = found ? found[1] : null;
    items.push({
      time: new Date(parsed).toISOString(),
      airTemperatureC: num(d.air_temperature),
      relativeHumidityPercent: num(d.relative_humidity),
      airPressureAtSeaLevelHpa: num(d.air_pressure_at_sea_level),
      cloudAreaFractionPercent: num(d.cloud_area_fraction),
      windSpeedMps: num(d.wind_speed),
      windFromDirectionDegrees: num(d.wind_from_direction),
      windGustMps: num(d.wind_speed_of_gust),
      symbolCode: typeof period?.summary?.symbol_code === 'string' ? period.summary.symbol_code : null,
      precipitationAmountMm: num(period?.details?.precipitation_amount),
      precipitationPeriodHours: periodHours,
      probabilityOfPrecipitationPercent: num(period?.details?.probability_of_precipitation),
      probabilityOfThunderPercent: num(period?.details?.probability_of_thunder),
    });
  }
  const updatedMs = Date.parse(body?.properties?.meta?.updated_at);
  return { providerUpdatedAt: Number.isNaN(updatedMs) ? null : new Date(updatedMs).toISOString(), items };
}

type MetnoResult =
  | { status: 'ok'; forecast: ProviderForecast; lastModified: string | null; expires: string | null }
  | { status: 'not-modified'; lastModified: string | null; expires: string | null };

async function fetchForecast(deps: ProviderDeps, lat: number, lng: number, ifModifiedSince: string | null): Promise<MetnoResult> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (ifModifiedSince) headers['If-Modified-Since'] = ifModifiedSince;
  const url = `${METNO_COMPACT_URL}?${new URLSearchParams({ lat: String(lat), lon: String(lng) }).toString()}`;
  let res: Response;
  try {
    res = await providerFetch(deps, url, { timeoutMs: REQUEST_TIMEOUT_MS, headers });
  } catch (error) {
    throw new ProviderError(`MET Norway request failed (${error instanceof Error ? error.name : 'error'})`);
  }
  if (res.status !== 200 && res.status !== 304) throw new ProviderError(`MET Norway request failed (HTTP ${res.status})`, res.status);
  const lastModified = res.headers.get('last-modified') || null;
  const expires = res.headers.get('expires') || null;
  if (res.status === 304) return { status: 'not-modified', lastModified, expires };
  let body: J = null;
  try { body = JSON.parse(await res.text()); } catch { body = null; }
  return { status: 'ok', forecast: parseForecast(body), lastModified, expires };
}

/** A valid future provider Expires is honoured exactly; otherwise a bounded fallback. */
function computeExpiry(expiresHeader: string | null, now: Date): string {
  const parsed = expiresHeader ? Date.parse(expiresHeader) : NaN;
  const nowMs = now.getTime();
  if (Number.isNaN(parsed) || parsed <= nowMs) return new Date(nowMs + METNO_FALLBACK_FRESH_SECONDS * 1000).toISOString();
  return new Date(parsed).toISOString();
}

const isProviderFresh = (e: CachedForecast, now: Date): boolean => Date.parse(e.expiresAt) > now.getTime();
/** Bounded: at most the stale window past the end of provider freshness. */
const withinStaleWindow = (e: CachedForecast, now: Date): boolean => {
  const expires = Date.parse(e.expiresAt);
  return !Number.isNaN(expires) && now.getTime() - expires <= METNO_STALE_WINDOW_SECONDS * 1000;
};
/** Cache TTL = remaining provider freshness + the bounded stale window. */
const cacheTtlSeconds = (e: CachedForecast, now: Date): number =>
  Math.max(0, Math.ceil((Date.parse(e.expiresAt) - now.getTime()) / 1000)) + METNO_STALE_WINDOW_SECONDS;

export function createMetnoProvider(deps: ProviderDeps) {
  const readCache = async (key: string): Promise<CachedForecast | null> => {
    try {
      const raw = await deps.cache.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CachedForecast;
      if (!parsed?.forecast?.items || !parsed.expiresAt || !parsed.fetchedAt) return null;
      return parsed;
    } catch {
      deps.logger.warn('cache read failed for weather:forecast; continuing to MET Norway');
      return null;
    }
  };
  const writeCache = async (key: string, entry: CachedForecast, now: Date): Promise<void> => {
    try { await deps.cache.set(key, JSON.stringify(entry), cacheTtlSeconds(entry, now)); } catch { deps.logger.warn('cache write failed for weather:forecast; returning live MET Norway data'); }
  };

  /** Window by timestamp; provider steps are not evenly hourly. */
  const envelope = (entry: CachedForecast, lat: number, lng: number, forecastHours: number, now: Date, stale: boolean): WeatherForecastEnvelope => {
    const from = now.getTime();
    const to = from + forecastHours * 3_600_000;
    return {
      source: 'MET_NORWAY',
      generatedAt: entry.fetchedAt,
      providerUpdatedAt: entry.forecast.providerUpdatedAt,
      stale,
      attribution: WEATHER_ATTRIBUTION,
      location: { latitude: lat, longitude: lng },
      forecast: entry.forecast.items.filter((item) => { const t = Date.parse(item.time); return t >= from && t <= to; }),
    };
  };

  return async function metno(query: DestinationIntelligenceQuery, now: Date): Promise<WeatherForecastEnvelope> {
    const lat = normalizeCoordinate(query.latitude);
    const lng = normalizeCoordinate(query.longitude);
    const key = metnoCacheKey(lat, lng);
    const hours = query.forecast.forecastHours;

    const cached = await readCache(key);
    // PROVIDER FRESH: takes precedence regardless of how old fetchedAt is.
    if (cached && isProviderFresh(cached, now)) return envelope(cached, lat, lng, hours, now, false);

    // STALE FALLBACK ELIGIBLE: provider freshness ended, still inside the bounded window.
    const usable = cached && withinStaleWindow(cached, now) ? cached : null;

    let entry: CachedForecast;
    try {
      const result = await fetchForecast(deps, lat, lng, usable?.lastModified ?? null);
      if (result.status === 'not-modified') {
        if (!usable) throw new ProviderError('MET Norway returned 304 without a cached payload');
        entry = { forecast: usable.forecast, lastModified: result.lastModified ?? usable.lastModified, expiresAt: computeExpiry(result.expires, now), fetchedAt: now.toISOString() };
      } else {
        entry = { forecast: result.forecast, lastModified: result.lastModified, expiresAt: computeExpiry(result.expires, now), fetchedAt: now.toISOString() };
      }
    } catch (error) {
      if (usable) {
        deps.logger.warn('serving stale weather:forecast fallback (flagged stale)');
        return envelope(usable, lat, lng, hours, now, true);
      }
      throw error; // nothing usable: the provider is unavailable — never an empty forecast
    }

    await writeCache(key, entry, now);
    return envelope(entry, lat, lng, hours, now, false);
  };
}
