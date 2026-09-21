import { describe, it, expect } from 'vitest';
import { DestinationIntelligenceGateway } from './gateway';
import { silentLogger } from './runtime';
import { DEFAULT_OPTIONS } from './contract';

const q = { latitude: 43.6532, longitude: -79.3832, ...DEFAULT_OPTIONS };

/** Producer-side mirror of the consumer invariant: contract v1.0 always carries exactly one NWS and one ECCC entry. */
describe('officialWarnings invariant (producer)', () => {
  const providersOf = (gw: DestinationIntelligenceGateway) => gw.getDestinationIntelligence(q, new Date('2026-09-21T00:00:00Z')).then((r) => r.officialWarnings.map((w) => w.provider));

  it('no providers wired: NWS and ECCC are still present, as explicit unavailable', async () => {
    const gw = new DestinationIntelligenceGateway({}, silentLogger);
    expect(await providersOf(gw)).toEqual(['NWS', 'ECCC']);
    const r = await gw.getDestinationIntelligence(q, new Date('2026-09-21T00:00:00Z'));
    expect(r.officialWarnings.every((w) => w.result.status === 'unavailable')).toBe(true);
  });

  it('every provider throwing: still exactly one NWS and one ECCC, never empty', async () => {
    const boom = async () => { throw new Error('down'); };
    const gw = new DestinationIntelligenceGateway({ usgs: boom, firms: boom, metno: boom, eonet: boom, nws: boom, eccc: boom } as any, silentLogger);
    const names = await providersOf(gw);
    expect(names).toEqual(['NWS', 'ECCC']);
    expect(new Set(names).size).toBe(names.length);
  });
});
