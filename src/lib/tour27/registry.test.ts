import { describe, it, expect } from 'vitest';
import type { ProviderId } from './contract';
import { PROVIDER_REGISTRY, ProviderHealthTracker } from './registry';

const NOW = new Date('2026-09-21T00:00:00Z');
const ALL: ReadonlySet<ProviderId> = new Set(['USGS', 'NASA_FIRMS', 'NASA_EONET', 'MET_NORWAY', 'NWS', 'ECCC']);
const state = (t: ProviderHealthTracker, p: ProviderId, impl = ALL) => t.snapshot(NOW, impl).find((s) => s.provider === p)!;

describe('provider registry', () => {
  it('registers every provider once with a truth class, and secrets are NAMES not values', () => {
    const ids = PROVIDER_REGISTRY.map((p) => p.provider);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['USGS', 'NASA_FIRMS', 'NASA_EONET', 'MET_NORWAY', 'NWS', 'ECCC', 'BOM', 'METEOALARM']));
    for (const p of PROVIDER_REGISTRY) if (p.requiredSecret) expect(p.requiredSecret).toMatch(/^[A-Z0-9_]+$/);
  });

  it('preserves truth classes', () => {
    const by = Object.fromEntries(PROVIDER_REGISTRY.map((p) => [p.provider, p.truthClass]));
    expect(by).toMatchObject({ USGS: 'OBSERVATION', NASA_FIRMS: 'OBSERVATION', NASA_EONET: 'ENVIRONMENTAL_CONTEXT', MET_NORWAY: 'FORECAST', NWS: 'OFFICIAL_WARNING', ECCC: 'OFFICIAL_WARNING' });
  });

  it('BOM and MeteoAlarm are pending regardless of health or implementation', () => {
    const t = new ProviderHealthTracker();
    t.record('BOM', true, NOW); t.record('METEOALARM', true, NOW);
    expect(state(t, 'BOM').state).toBe('LICENCE_PENDING');
    expect(state(t, 'METEOALARM')).toMatchObject({ state: 'TOKEN_PENDING', requiredSecret: 'METEOALARM_API_TOKEN' });
  });

  it('an unimplemented provider is UNAVAILABLE (never reported healthy)', () => {
    expect(state(new ProviderHealthTracker(), 'ECCC', new Set(['USGS'])).state).toBe('UNAVAILABLE');
    expect(state(new ProviderHealthTracker(), 'USGS', new Set(['USGS'])).state).toBe('HEALTHY');
  });

  it('transitions: 1 miss DEGRADED, 3 consecutive UNAVAILABLE, a success resets', () => {
    const t = new ProviderHealthTracker();
    t.record('ECCC', false, NOW); expect(state(t, 'ECCC').state).toBe('DEGRADED');
    t.record('ECCC', false, NOW); expect(state(t, 'ECCC').state).toBe('DEGRADED');
    t.record('ECCC', false, NOW); expect(state(t, 'ECCC').state).toBe('UNAVAILABLE');
    t.record('ECCC', true, NOW); expect(state(t, 'ECCC')).toMatchObject({ state: 'HEALTHY', lastFailureAt: NOW.toISOString(), lastSuccessAt: NOW.toISOString() });
  });

  it('freshnessSeconds counts from the last success', () => {
    const t = new ProviderHealthTracker();
    t.record('NWS', true, new Date('2026-09-20T23:58:00Z'));
    expect(state(t, 'NWS').freshnessSeconds).toBe(120);
  });
});
