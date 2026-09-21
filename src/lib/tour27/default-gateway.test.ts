import { describe, it, expect, vi } from 'vitest';
import { buildDefaultProviders } from './default-gateway';
import { DestinationIntelligenceGateway } from './gateway';
import { MemoryCache, silentLogger, type ProviderDeps } from './runtime';

const deps = (fetchImpl: ProviderDeps['fetch']): ProviderDeps => ({ fetch: fetchImpl, cache: new MemoryCache(), now: () => new Date('2026-09-21T00:00:00Z'), env: () => undefined, logger: silentLogger });

describe('default gateway wiring', () => {
  it('registers exactly the ported providers (kept in step as ports land)', () => {
    const gw = new DestinationIntelligenceGateway(buildDefaultProviders(deps(vi.fn() as any)), silentLogger);
    expect([...gw.implemented()].sort()).toEqual(['ECCC', 'NWS']);
  });

  it('end to end through the gateway: Melbourne is outside both authorities WITHOUT any provider call', async () => {
    const f = vi.fn();
    const gw = new DestinationIntelligenceGateway(buildDefaultProviders(deps(f as any)), silentLogger);
    const res = await gw.getDestinationIntelligence(
      { latitude: -37.8136, longitude: 144.9631, earthquakes: { radiusKm: 250, minMagnitude: 2.5, lookbackHours: 24 }, fires: { radiusKm: 100, lookbackDays: 1 }, environmentalEvents: { radiusKm: 500, lookbackDays: 30 }, forecast: { forecastHours: 24 } },
      new Date('2026-09-21T00:00:00Z'),
    );
    const eccc = res.officialWarnings.find((w) => w.provider === 'ECCC')!.result;
    expect(eccc.status).toBe('ok');
    if (eccc.status === 'ok') expect(eccc.data).toMatchObject({ coverage: 'outside-coverage', alerts: [] });
    // NWS is queried per exact point (no local extent): the fake fetch returns undefined => unavailable, never empty.
    expect(res.officialWarnings.find((w) => w.provider === 'NWS')!.result.status).toBe('unavailable');
  });
});
