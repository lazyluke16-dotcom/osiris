import type { ProviderId, ProviderState, ProviderStatus, TruthClass } from './contract';

/**
 * Machine-readable provider registry: the single source of truth for provider metadata. Health,
 * diagnostics, ATLAS monitoring, generated docs and any future admin UI read THIS. Adding a new
 * authority (JMA, Met Office, ...) is one entry here plus its adapter — no Tour 27 architecture change.
 */
export interface ProviderDefinition {
  provider: ProviderId;
  capability: string;
  truthClass: TruthClass;
  /** Name of the required secret (never a value); null when none is needed. */
  requiredSecret: string | null;
  licenceStatus: string;
  /** Set for providers that are not live yet; overrides runtime health. */
  pendingState: Extract<ProviderState, 'LICENCE_PENDING' | 'TOKEN_PENDING'> | null;
  coverage: string;
}

export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = [
  { provider: 'USGS', capability: 'earthquakes', truthClass: 'OBSERVATION', requiredSecret: null, licenceStatus: 'OPEN (attribution per USGS terms)', pendingState: null, coverage: 'global' },
  { provider: 'NASA_FIRMS', capability: 'thermal-detections', truthClass: 'OBSERVATION', requiredSecret: 'NASA_FIRMS_MAP_KEY', licenceStatus: 'OPEN (NASA data policy; MAP_KEY registration)', pendingState: null, coverage: 'global' },
  { provider: 'NASA_EONET', capability: 'environmental-events', truthClass: 'ENVIRONMENTAL_CONTEXT', requiredSecret: null, licenceStatus: 'OPEN (attribution)', pendingState: null, coverage: 'global' },
  { provider: 'MET_NORWAY', capability: 'forecast', truthClass: 'FORECAST', requiredSecret: null, licenceStatus: 'OPEN (attribution "Data from MET Norway"; honest User-Agent required)', pendingState: null, coverage: 'global' },
  { provider: 'NWS', capability: 'official-warnings-us', truthClass: 'OFFICIAL_WARNING', requiredSecret: null, licenceStatus: 'OPEN (US Government; honest User-Agent required)', pendingState: null, coverage: 'United States' },
  { provider: 'ECCC', capability: 'official-warnings-ca', truthClass: 'OFFICIAL_WARNING', requiredSecret: null, licenceStatus: 'OPEN (Open Government Licence - Canada; attribution)', pendingState: null, coverage: 'Canada (public + marine forecast zones)' },
  { provider: 'BOM', capability: 'official-warnings-au', truthClass: 'OFFICIAL_WARNING', requiredSecret: null, licenceStatus: 'LICENCE_PENDING (commercial licence not yet obtained)', pendingState: 'LICENCE_PENDING', coverage: 'Australia' },
  { provider: 'METEOALARM', capability: 'official-warnings-eu', truthClass: 'OFFICIAL_WARNING', requiredSecret: 'METEOALARM_API_TOKEN', licenceStatus: 'TOKEN_PENDING (API token not yet issued; applicability unproven)', pendingState: 'TOKEN_PENDING', coverage: 'Europe (38 NMHS)' },
];

/** Consecutive-failure thresholds: one transient miss must not raise an incident. */
export const DEGRADED_AFTER_FAILURES = 1;
export const UNAVAILABLE_AFTER_FAILURES = 3;

interface Tracked {
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
}

export class ProviderHealthTracker {
  private readonly tracked = new Map<ProviderId, Tracked>();

  record(provider: ProviderId, ok: boolean, now: Date): void {
    const t = this.tracked.get(provider) ?? { consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null };
    if (ok) {
      t.consecutiveFailures = 0;
      t.lastSuccessAt = now.toISOString();
    } else {
      t.consecutiveFailures += 1;
      t.lastFailureAt = now.toISOString();
    }
    this.tracked.set(provider, t);
  }

  /** `implemented` lists providers this gateway actually serves; an unimplemented provider is UNAVAILABLE. */
  snapshot(now: Date, implemented: ReadonlySet<ProviderId>): ProviderStatus[] {
    return PROVIDER_REGISTRY.map((def) => {
      const t = this.tracked.get(def.provider);
      let state: ProviderState;
      if (def.pendingState) state = def.pendingState;
      else if (!implemented.has(def.provider)) state = 'UNAVAILABLE';
      else if (!t) state = 'HEALTHY'; // not yet exercised: no evidence of a problem
      else if (t.consecutiveFailures >= UNAVAILABLE_AFTER_FAILURES) state = 'UNAVAILABLE';
      else if (t.consecutiveFailures >= DEGRADED_AFTER_FAILURES) state = 'DEGRADED';
      else state = 'HEALTHY';
      return {
        provider: def.provider,
        capability: def.capability,
        truthClass: def.truthClass,
        state,
        requiredSecret: def.requiredSecret,
        licenceStatus: def.licenceStatus,
        lastSuccessAt: t?.lastSuccessAt ?? null,
        lastFailureAt: t?.lastFailureAt ?? null,
        freshnessSeconds: t?.lastSuccessAt ? Math.max(0, Math.round((now.getTime() - Date.parse(t.lastSuccessAt)) / 1000)) : null,
      };
    });
  }
}
