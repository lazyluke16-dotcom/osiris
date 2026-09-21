import { DEFAULT_OPTIONS, type DestinationIntelligenceQuery } from './contract';

export type QueryParse = { ok: true; query: DestinationIntelligenceQuery } | { ok: false; error: string };

/** Strict decimal number: rejects '', ' ', '0x10', '1e2', 'NaN', 'Infinity' and anything non-numeric. */
function num(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const s = raw.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return Number.NaN;
  return Number(s);
}

interface Bound { name: string; param: string; min: number; max: number }

/**
 * Parses and validates the gateway query. Bounds equal the direct Tour 27 DTO limits, so DIRECT and
 * OSIRIS accept and reject exactly the same requests. Coordinates are kept at FULL precision: nothing
 * is rounded or truncated (official-warning applicability depends on the exact point).
 */
export function parseQuery(params: URLSearchParams): QueryParse {
  const lat = num(params.get('lat'));
  const lng = num(params.get('lng'));
  if (lat === undefined || lng === undefined) return { ok: false, error: 'lat and lng are required' };
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, error: 'lat must be a number between -90 and 90' };
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { ok: false, error: 'lng must be a number between -180 and 180' };

  const q: DestinationIntelligenceQuery = {
    latitude: lat,
    longitude: lng,
    earthquakes: { ...DEFAULT_OPTIONS.earthquakes },
    fires: { ...DEFAULT_OPTIONS.fires },
    environmentalEvents: { ...DEFAULT_OPTIONS.environmentalEvents },
    forecast: { ...DEFAULT_OPTIONS.forecast },
  };

  const optional: Array<Bound & { set: (v: number) => void }> = [
    { name: 'eqRadiusKm', param: 'eqRadiusKm', min: 1, max: 1000, set: (v) => (q.earthquakes.radiusKm = v) },
    { name: 'eqMinMagnitude', param: 'eqMinMagnitude', min: 0, max: 10, set: (v) => (q.earthquakes.minMagnitude = v) },
    { name: 'eqLookbackHours', param: 'eqLookbackHours', min: 1, max: 168, set: (v) => (q.earthquakes.lookbackHours = v) },
    { name: 'fireRadiusKm', param: 'fireRadiusKm', min: 1, max: 500, set: (v) => (q.fires.radiusKm = v) },
    { name: 'fireLookbackDays', param: 'fireLookbackDays', min: 1, max: 5, set: (v) => (q.fires.lookbackDays = v) },
    { name: 'eventRadiusKm', param: 'eventRadiusKm', min: 1, max: 2000, set: (v) => (q.environmentalEvents.radiusKm = v) },
    { name: 'eventLookbackDays', param: 'eventLookbackDays', min: 1, max: 90, set: (v) => (q.environmentalEvents.lookbackDays = v) },
    { name: 'forecastHours', param: 'forecastHours', min: 1, max: 168, set: (v) => (q.forecast.forecastHours = v) },
  ];
  for (const o of optional) {
    const v = num(params.get(o.param));
    if (v === undefined) continue;
    if (!Number.isFinite(v) || v < o.min || v > o.max) return { ok: false, error: `${o.name} must be a number between ${o.min} and ${o.max}` };
    o.set(v);
  }
  return { ok: true, query: q };
}
