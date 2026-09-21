/**
 * Tour 27 Destination Intelligence contract v1.0 — OSIRIS (producer) side.
 *
 * This file MIRRORS the consumer contract in tour27-backend
 * (apps/apigateway/src/destination-intelligence/destination-intelligence.contract.ts). The two are kept
 * in lock-step by a shared golden fixture (see contract.test.ts). Do not change one without the other.
 *
 * Safety rules baked into the shape:
 *  - the four truth classes are never merged;
 *  - every provider result is `ok` (with the provider's own envelope, unchanged) or `unavailable`
 *    (with a reason) — a failed provider is NEVER an empty result, and an absent warning is never safety;
 *  - there is no Tour 27 risk score, unified severity or "safe" flag anywhere.
 */

export const CONTRACT_VERSION = '1.0' as const;

export type TruthClass = 'OBSERVATION' | 'FORECAST' | 'ENVIRONMENTAL_CONTEXT' | 'OFFICIAL_WARNING';
export type ProviderId = 'USGS' | 'NASA_FIRMS' | 'NASA_EONET' | 'MET_NORWAY' | 'NWS' | 'ECCC' | 'BOM' | 'METEOALARM';
export type OfficialWarningProviderId = 'NWS' | 'ECCC' | 'BOM' | 'METEOALARM';
export type ProviderState = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE' | 'LICENCE_PENDING' | 'TOKEN_PENDING';

export type ProviderResult<T> = { status: 'ok'; data: T } | { status: 'unavailable'; reason: string };

export interface ProviderStatus {
  provider: ProviderId;
  capability: string;
  truthClass: TruthClass;
  state: ProviderState;
  /** Names the secret, never its value. */
  requiredSecret: string | null;
  licenceStatus: string;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  freshnessSeconds: number | null;
}

// ── observations ────────────────────────────────────────────────────────────
export interface EarthquakeHazardDetails {
  place: string;
  magnitude: number | null;
  magnitudeType: string | null;
  depthKm: number | null;
  tsunami: boolean;
  alert: string | null;
  significance: number | null;
  status: string | null;
  feltReports: number | null;
}

/** A FIRMS detection is a satellite thermal anomaly, NOT a confirmed wildfire. */
export interface FireHazardDetails {
  product: string;
  satellite: string | null;
  instrument: string | null;
  confidence: string | null;
  fireRadiativePowerMw: number | null;
  brightnessTi4Kelvin: number | null;
  brightnessTi5Kelvin: number | null;
  scanKm: number | null;
  trackKm: number | null;
  acquisitionDate: string;
  acquisitionTimeUtc: string;
  dayNight: string | null;
  productVersion: string | null;
}

interface BaseHazardEvent<T extends 'earthquake' | 'fire', S extends 'USGS' | 'NASA_FIRMS', D> {
  id: string;
  type: T;
  title: string;
  latitude: number;
  longitude: number;
  occurredAt: string;
  source: S;
  sourceUrl: string;
  details: D;
}

export interface EarthquakeHazardEvent extends BaseHazardEvent<'earthquake', 'USGS', EarthquakeHazardDetails> {
  updatedAt: string;
}

/** FIRMS publishes no separate update timestamp, so none is fabricated. */
export interface FireHazardEvent extends BaseHazardEvent<'fire', 'NASA_FIRMS', FireHazardDetails> {
  updatedAt?: undefined;
}

export interface HazardEventEnvelope<E extends EarthquakeHazardEvent | FireHazardEvent> {
  events: E[];
  source: E['source'];
  generatedAt: string;
  stale: boolean;
  degraded?: boolean;
}

// ── forecast ────────────────────────────────────────────────────────────────
export interface WeatherForecastItem {
  time: string;
  airTemperatureC: number | null;
  relativeHumidityPercent: number | null;
  airPressureAtSeaLevelHpa: number | null;
  cloudAreaFractionPercent: number | null;
  windSpeedMps: number | null;
  windFromDirectionDegrees: number | null;
  windGustMps: number | null;
  symbolCode: string | null;
  precipitationAmountMm: number | null;
  precipitationPeriodHours: number | null;
  probabilityOfPrecipitationPercent: number | null;
  probabilityOfThunderPercent: number | null;
}

export interface WeatherForecastEnvelope {
  source: 'MET_NORWAY';
  generatedAt: string;
  providerUpdatedAt: string | null;
  stale: boolean;
  attribution: string;
  location: { latitude: number; longitude: number };
  forecast: WeatherForecastItem[];
}

export const WEATHER_ATTRIBUTION = 'Data from MET Norway';

// ── environmental context ───────────────────────────────────────────────────
export interface EonetCategory { id: string | null; title: string | null }
export interface EonetSource { id: string | null; url: string | null }
export interface EonetGeometry {
  type: 'Point' | 'Polygon';
  date: string | null;
  coordinates: unknown;
  magnitudeValue: number | null;
  magnitudeUnit: string | null;
  magnitudeDescription: string | null;
}
export type EonetSpatialBasis = 'point-distance' | 'provider-bbox-polygon';
export interface EonetSpatialMatch { basis: EonetSpatialBasis; nearestPointDistanceKm: number | null }

export interface EnvironmentalEvent {
  id: string;
  title: string | null;
  description: string | null;
  sourceUrl: string | null;
  closedAt: string | null;
  categories: EonetCategory[];
  sources: EonetSource[];
  geometries: EonetGeometry[];
  magnitudeValue: number | null;
  magnitudeUnit: string | null;
  magnitudeDescription: string | null;
  spatialMatch: EonetSpatialMatch;
}

export interface EnvironmentalEventsEnvelope {
  source: 'NASA_EONET';
  generatedAt: string;
  stale: boolean;
  degraded: boolean;
  informationalOnly: true;
  attribution: string;
  disclaimer: string;
  query: { latitude: number; longitude: number; radiusKm: number; lookbackDays: number };
  events: EnvironmentalEvent[];
}

export const EONET_ATTRIBUTION = 'Event metadata from NASA EONET (Earth Observatory Natural Event Tracker)';
export const EONET_DISCLAIMER =
  'Informational context only, provided for visualisation and general information. ' +
  'Event locations and extents may be approximate. This is not an official warning ' +
  'and no severity, risk or emergency status is implied. Not endorsed by NASA.';

// ── official warnings (CAP-shaped, reproduced as issued) ────────────────────
export interface OfficialAlertAuthority { id: string; name: string; country: string | null }
export interface OfficialAlertGeometry { type: 'Polygon' | 'MultiPolygon'; coordinates: unknown }
export interface OfficialAlertArea {
  description: string | null;
  geocodes: Record<string, string[]>;
  geometry: OfficialAlertGeometry | null;
  regionLinks: string[];
}
export interface OfficialAlertReference { identifier: string | null; sender: string | null; sent: string | null }
export interface OfficialAlertTranslation {
  language: string;
  event: string | null;
  headline: string | null;
  description: string | null;
  instruction: string | null;
  areaDescription: string | null;
}

export interface OfficialAlert {
  id: string;
  authority: OfficialAlertAuthority;
  sourceUrl: string | null;
  status: string | null;
  messageType: string | null;
  scope: string | null;
  categories: string[];
  event: string | null;
  urgency: string | null;
  severity: string | null;
  certainty: string | null;
  responseTypes: string[];
  sender: string | null;
  senderName: string | null;
  headline: string | null;
  description: string | null;
  instruction: string | null;
  language: string | null;
  translations: OfficialAlertTranslation[];
  sent: string | null;
  effective: string | null;
  onset: string | null;
  expires: string | null;
  ends: string | null;
  /** Chosen by each authority adapter (NWS: ends ?? expires; ECCC: later of expires and ends). */
  validUntil: string | null;
  validUntilBasis: 'ends' | 'expires' | null;
  areas: OfficialAlertArea[];
  references: OfficialAlertReference[];
  parameters: Record<string, string[]>;
  eventCodes: Record<string, string[]>;
  note: string | null;
}

export type OfficialAlertCoverage = 'covered' | 'outside-coverage';

export interface OfficialAlertsEnvelope {
  source: string;
  authority: OfficialAlertAuthority;
  officialWarnings: true;
  generatedAt: string;
  providerUpdatedAt: string | null;
  /** outside-coverage: NOTHING was assessed, so an empty `alerts` list carries NO reassurance. */
  coverage: OfficialAlertCoverage;
  attribution: string;
  disclaimer: string;
  query: { latitude: number; longitude: number };
  alerts: OfficialAlert[];
}

export const NWS_AUTHORITY: OfficialAlertAuthority = { id: 'NWS', name: 'NOAA National Weather Service', country: 'US' };
export const NWS_ATTRIBUTION = 'Alerts issued by the U.S. National Weather Service (NOAA)';
export const ECCC_AUTHORITY: OfficialAlertAuthority = {
  id: 'ECCC',
  name: 'Environment and Climate Change Canada (Meteorological Service of Canada)',
  country: 'CA',
};
export const ECCC_ATTRIBUTION =
  'Source: Environment and Climate Change Canada. Contains information licensed under the Open Government Licence – Canada.';
export const OFFICIAL_ALERTS_DISCLAIMER =
  'Official alerts are reproduced as issued by the authority; Tour 27 does not create, upgrade, ' +
  'downgrade or reinterpret them. The absence of an alert does not mean there is no hazard, and an ' +
  'alert may lag the authority by a short time. Always follow the instructions of local authorities. ' +
  'Not endorsed by the issuing authority.';

// ── the unified response ────────────────────────────────────────────────────
export interface DestinationIntelligenceQuery {
  latitude: number;
  longitude: number;
  earthquakes: { radiusKm: number; minMagnitude: number; lookbackHours: number };
  fires: { radiusKm: number; lookbackDays: number };
  environmentalEvents: { radiusKm: number; lookbackDays: number };
  forecast: { forecastHours: number };
}

/** Defaults equal the direct Tour 27 endpoint defaults. */
export const DEFAULT_OPTIONS: Omit<DestinationIntelligenceQuery, 'latitude' | 'longitude'> = {
  earthquakes: { radiusKm: 250, minMagnitude: 2.5, lookbackHours: 24 },
  fires: { radiusKm: 100, lookbackDays: 1 },
  environmentalEvents: { radiusKm: 500, lookbackDays: 30 },
  forecast: { forecastHours: 24 },
};

export interface OfficialWarningResult {
  provider: OfficialWarningProviderId;
  result: ProviderResult<OfficialAlertsEnvelope>;
}

export interface DestinationIntelligenceResponse {
  contractVersion: typeof CONTRACT_VERSION;
  query: DestinationIntelligenceQuery;
  generatedAt: string;
  observations: {
    earthquakes: ProviderResult<HazardEventEnvelope<EarthquakeHazardEvent>>;
    fires: ProviderResult<HazardEventEnvelope<FireHazardEvent>>;
  };
  forecast: ProviderResult<WeatherForecastEnvelope>;
  environmentalEvents: ProviderResult<EnvironmentalEventsEnvelope>;
  officialWarnings: OfficialWarningResult[];
  providers: ProviderStatus[];
}
