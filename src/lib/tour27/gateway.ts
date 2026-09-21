import {
  CONTRACT_VERSION,
  type DestinationIntelligenceQuery,
  type DestinationIntelligenceResponse,
  type EarthquakeHazardEvent,
  type EnvironmentalEventsEnvelope,
  type FireHazardEvent,
  type HazardEventEnvelope,
  type OfficialAlertsEnvelope,
  type OfficialWarningResult,
  type ProviderId,
  type ProviderResult,
  type WeatherForecastEnvelope,
} from './contract';
import { ProviderHealthTracker } from './registry';
import type { Logger } from './runtime';

export const NOT_IMPLEMENTED_REASON = 'provider not implemented in this gateway build';
export const PROVIDER_UNAVAILABLE_REASON = 'provider unavailable';

type Fn<T> = (query: DestinationIntelligenceQuery, now: Date) => Promise<T>;

/** Each provider is an injected function; an absent one is reported as `unavailable`, never faked. */
export interface GatewayProviders {
  usgs?: Fn<HazardEventEnvelope<EarthquakeHazardEvent>>;
  firms?: Fn<HazardEventEnvelope<FireHazardEvent>>;
  metno?: Fn<WeatherForecastEnvelope>;
  eonet?: Fn<EnvironmentalEventsEnvelope>;
  nws?: Fn<OfficialAlertsEnvelope>;
  eccc?: Fn<OfficialAlertsEnvelope>;
}

export class DestinationIntelligenceGateway {
  private readonly health = new ProviderHealthTracker();

  constructor(private readonly providers: GatewayProviders, private readonly logger: Logger) {}

  implemented(): ReadonlySet<ProviderId> {
    const map: Array<[keyof GatewayProviders, ProviderId]> = [
      ['usgs', 'USGS'], ['firms', 'NASA_FIRMS'], ['metno', 'MET_NORWAY'], ['eonet', 'NASA_EONET'], ['nws', 'NWS'], ['eccc', 'ECCC'],
    ];
    return new Set(map.filter(([k]) => typeof this.providers[k] === 'function').map(([, id]) => id));
  }

  providerStatus(now: Date) {
    return this.health.snapshot(now, this.implemented());
  }

  /** One call per provider, in parallel. A failing provider becomes an explicit `unavailable`, never empty. */
  async getDestinationIntelligence(query: DestinationIntelligenceQuery, now: Date): Promise<DestinationIntelligenceResponse> {
    const [earthquakes, fires, forecast, environmentalEvents, nws, eccc] = await Promise.all([
      this.run('USGS', this.providers.usgs, query, now),
      this.run('NASA_FIRMS', this.providers.firms, query, now),
      this.run('MET_NORWAY', this.providers.metno, query, now),
      this.run('NASA_EONET', this.providers.eonet, query, now),
      this.run('NWS', this.providers.nws, query, now),
      this.run('ECCC', this.providers.eccc, query, now),
    ]);
    const officialWarnings: OfficialWarningResult[] = [
      { provider: 'NWS', result: nws },
      { provider: 'ECCC', result: eccc },
    ];
    return {
      contractVersion: CONTRACT_VERSION,
      query,
      generatedAt: now.toISOString(),
      observations: { earthquakes, fires },
      forecast,
      environmentalEvents,
      officialWarnings,
      providers: this.providerStatus(now),
    };
  }

  private async run<T>(provider: ProviderId, fn: Fn<T> | undefined, query: DestinationIntelligenceQuery, now: Date): Promise<ProviderResult<T>> {
    if (!fn) return { status: 'unavailable', reason: NOT_IMPLEMENTED_REASON };
    try {
      const data = await fn(query, now);
      this.health.record(provider, true, now);
      return { status: 'ok', data };
    } catch (error) {
      this.health.record(provider, false, now);
      // Class name only: provider errors may embed URLs (which carry coordinates) or secrets.
      this.logger.warn(`provider ${provider} unavailable (${error instanceof Error ? error.name : 'error'})`);
      return { status: 'unavailable', reason: PROVIDER_UNAVAILABLE_REASON };
    }
  }
}
