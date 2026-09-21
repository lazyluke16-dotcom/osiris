import { describe, it, expect, vi } from 'vitest';
import golden from './fixtures/destination-intelligence.golden.json';
import { DEFAULT_OPTIONS, type DestinationIntelligenceQuery } from './contract';
import { DestinationIntelligenceGateway, NOT_IMPLEMENTED_REASON, PROVIDER_UNAVAILABLE_REASON, type GatewayProviders } from './gateway';
import type { Logger } from './runtime';

const NOW = new Date(golden.generatedAt);
const QUERY: DestinationIntelligenceQuery = { latitude: 43.6532, longitude: -79.3832, ...DEFAULT_OPTIONS };
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

function logger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m) };
}

function fullProviders(): Required<GatewayProviders> {
  const g = clone(golden) as any;
  return {
    usgs: vi.fn(async () => g.observations.earthquakes.data),
    firms: vi.fn(async () => g.observations.fires.data),
    metno: vi.fn(async () => g.forecast.data),
    eonet: vi.fn(async () => g.environmentalEvents.data),
    nws: vi.fn(async () => g.officialWarnings[0].result.data),
    eccc: vi.fn(async () => g.officialWarnings[1].result.data),
  };
}

describe('DestinationIntelligenceGateway', () => {
  it('assembles one response from six providers, in the contract order, with untouched provider envelopes', async () => {
    const p = fullProviders();
    const res = await new DestinationIntelligenceGateway(p, logger()).getDestinationIntelligence(QUERY, NOW);
    expect(res.contractVersion).toBe('1.0');
    expect(res.observations.earthquakes.status).toBe('ok');
    expect(res.officialWarnings.map((w) => w.provider)).toEqual(['NWS', 'ECCC']);
    for (const fn of Object.values(p)) expect(fn).toHaveBeenCalledWith(QUERY, NOW);
  });

  it('a provider that is not implemented is reported unavailable — never faked and never empty', async () => {
    const res = await new DestinationIntelligenceGateway({}, logger()).getDestinationIntelligence(QUERY, NOW);
    const all = [res.observations.earthquakes, res.observations.fires, res.forecast, res.environmentalEvents, ...res.officialWarnings.map((w) => w.result)];
    for (const r of all) expect(r).toEqual({ status: 'unavailable', reason: NOT_IMPLEMENTED_REASON });
    expect(res.providers.filter((p) => p.state === 'UNAVAILABLE').map((p) => p.provider).sort()).toEqual(['ECCC', 'MET_NORWAY', 'NASA_EONET', 'NASA_FIRMS', 'NWS', 'USGS']);
  });

  it('a failing provider becomes explicit unavailable while the others still answer', async () => {
    const p = fullProviders();
    p.eccc = vi.fn(async () => { throw new Error('GeoMet exploded at https://api.weather.gc.ca/x?bbox=43.6532,-79.3832 with key SECRET123'); });
    const log = logger();
    const res = await new DestinationIntelligenceGateway(p, log).getDestinationIntelligence(QUERY, NOW);
    expect(res.officialWarnings[1].result).toEqual({ status: 'unavailable', reason: PROVIDER_UNAVAILABLE_REASON });
    expect(res.officialWarnings[0].result.status).toBe('ok');
    expect(res.observations.earthquakes.status).toBe('ok');
    // Error text (which may embed URLs with coordinates or secrets) never reaches the log or the response.
    expect(log.lines.join('\n') + JSON.stringify(res)).not.toMatch(/SECRET123|exploded|api\.weather\.gc\.ca/);
    // The response echoes the query (by contract), but the LOG never carries coordinates.
    expect(log.lines.join('\n')).not.toMatch(/43\.6532|79\.3832/);
  });

  it('health: one miss is DEGRADED, three consecutive UNAVAILABLE, a success recovers', async () => {
    const p = fullProviders();
    let fail = true;
    p.nws = vi.fn(async () => { if (fail) throw new Error('down'); return (clone(golden) as any).officialWarnings[0].result.data; });
    const gw = new DestinationIntelligenceGateway(p, logger());
    const st = async () => (await gw.getDestinationIntelligence(QUERY, NOW)).providers.find((x) => x.provider === 'NWS')!.state;
    expect(await st()).toBe('DEGRADED');
    expect(await st()).toBe('DEGRADED');
    expect(await st()).toBe('UNAVAILABLE');
    fail = false;
    expect(await st()).toBe('HEALTHY');
  });

  it('BOM and MeteoAlarm appear only as pending registry entries, never as warning results', async () => {
    const res = await new DestinationIntelligenceGateway(fullProviders(), logger()).getDestinationIntelligence(QUERY, NOW);
    expect(res.providers.find((p) => p.provider === 'BOM')!.state).toBe('LICENCE_PENDING');
    expect(res.providers.find((p) => p.provider === 'METEOALARM')!.state).toBe('TOKEN_PENDING');
    expect(res.officialWarnings.map((w) => w.provider)).toEqual(['NWS', 'ECCC']);
  });
});
