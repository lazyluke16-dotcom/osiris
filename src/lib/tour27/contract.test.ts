import { describe, it, expect, vi } from 'vitest';
import golden from './fixtures/destination-intelligence.golden.json';
import { CONTRACT_VERSION, DEFAULT_OPTIONS, type DestinationIntelligenceQuery } from './contract';
import { DestinationIntelligenceGateway } from './gateway';
import { silentLogger } from './runtime';

/**
 * The golden fixture is shared byte-for-byte with tour27-backend, whose validator must accept it
 * (destination-intelligence.golden.spec.ts). This test proves the PRODUCER emits exactly that shape,
 * so the two repositories cannot drift apart silently.
 */
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v));
const g = golden as any;
const QUERY: DestinationIntelligenceQuery = { latitude: 43.6532, longitude: -79.3832, ...DEFAULT_OPTIONS };

describe('contract golden fixture (producer side)', () => {
  it('the gateway response deep-equals the golden fixture (exact shape and values)', async () => {
    const gw = new DestinationIntelligenceGateway({
      usgs: vi.fn(async () => clone(g.observations.earthquakes.data)),
      firms: vi.fn(async () => clone(g.observations.fires.data)),
      metno: vi.fn(async () => clone(g.forecast.data)),
      eonet: vi.fn(async () => clone(g.environmentalEvents.data)),
      nws: vi.fn(async () => clone(g.officialWarnings[0].result.data)),
      eccc: vi.fn(async () => clone(g.officialWarnings[1].result.data)),
    }, silentLogger);
    const res = JSON.parse(JSON.stringify(await gw.getDestinationIntelligence(QUERY, new Date(g.generatedAt))));
    expect(res).toEqual(golden);
  });

  it('declares the shared contract version', () => {
    expect(CONTRACT_VERSION).toBe('1.0');
    expect(golden.contractVersion).toBe(CONTRACT_VERSION);
  });

  it('carries no risk score, unified severity or "safe" flag anywhere (recursive key scan)', () => {
    const banned = /^(risk|riskscore|risklevel|severityscore|unifiedseverity|safe|issafe|threatlevel|overallstatus|allclear)$/i;
    const walk = (v: unknown, path: string): string[] => {
      if (Array.isArray(v)) return v.flatMap((x, i) => walk(x, `${path}[${i}]`));
      if (v && typeof v === 'object') return Object.entries(v as object).flatMap(([k, x]) => [...(banned.test(k) ? [`${path}.${k}`] : []), ...walk(x, `${path}.${k}`)]);
      return [];
    };
    expect(walk(golden, '$')).toEqual([]);
  });

  it('official-warning envelopes never carry a stale flag; hazard/forecast/context envelopes state it explicitly', () => {
    for (const w of g.officialWarnings) expect('stale' in w.result.data).toBe(false);
    expect(g.observations.earthquakes.data.stale).toBe(false);
    expect(g.forecast.data.stale).toBe(false);
    expect(g.environmentalEvents.data.stale).toBe(false);
  });

  it('the environmental-context envelope is informational only', () => {
    expect(g.environmentalEvents.data.informationalOnly).toBe(true);
  });
});
