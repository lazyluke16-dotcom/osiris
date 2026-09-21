import { describe, it, expect, vi } from 'vitest';
import { DestinationIntelligenceGateway } from './gateway';
import { handleDestinationIntelligence, handleProviderHealth, handleReadiness } from './handlers';
import { silentLogger } from './runtime';

const NOW = new Date('2026-09-21T00:00:00Z');
const req = (qs: string) => new Request(`http://gateway.internal/api/tour27/destination-intelligence?${qs}`);

describe('handleDestinationIntelligence', () => {
  it('returns 400 for an invalid query, with no-store, and never calls a provider', async () => {
    const usgs = vi.fn();
    const gw = new DestinationIntelligenceGateway({ usgs } as any, silentLogger);
    const res = await handleDestinationIntelligence(req('lat=abc&lng=1'), gw, NOW);
    expect(res.status).toBe(400);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(usgs).not.toHaveBeenCalled();
    expect(await res.json()).toEqual({ error: 'lat must be a number between -90 and 90' });
  });

  it('returns 200 + no-store + the contract even when every provider is unavailable (status is per provider)', async () => {
    const res = await handleDestinationIntelligence(req('lat=43.6532&lng=-79.3832'), new DestinationIntelligenceGateway({}, silentLogger), NOW);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = await res.json();
    expect(body.contractVersion).toBe('1.0');
    expect(body.forecast.status).toBe('unavailable');
  });

  it('passes the exact untruncated coordinates and the parsed options to the providers', async () => {
    const nws = vi.fn(async (_q: unknown, _now: unknown) => { throw new Error('x'); });
    const gw = new DestinationIntelligenceGateway({ nws }, silentLogger);
    await handleDestinationIntelligence(req('lat=43.653245123&lng=-79.383251987&eqRadiusKm=50'), gw, NOW);
    expect(nws.mock.calls[0][0]).toMatchObject({ latitude: 43.653245123, longitude: -79.383251987, earthquakes: { radiusKm: 50 } });
  });
});

describe('handleProviderHealth', () => {
  it('lists the registry, impaired and pending providers with no-store', async () => {
    const gw = new DestinationIntelligenceGateway({ usgs: vi.fn(async () => { throw new Error('x'); }) } as any, silentLogger);
    await gw.getDestinationIntelligence({ latitude: 1, longitude: 1, earthquakes: { radiusKm: 1, minMagnitude: 0, lookbackHours: 1 }, fires: { radiusKm: 1, lookbackDays: 1 }, environmentalEvents: { radiusKm: 1, lookbackDays: 1 }, forecast: { forecastHours: 1 } }, NOW);
    const res = handleProviderHealth(gw, NOW);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.providers).toHaveLength(8);
    expect(body.summary.impaired).toContain('USGS');
    expect(body.summary.pending.sort()).toEqual(['BOM', 'METEOALARM']);
  });
});

describe('handleReadiness', () => {
  it('is ready outside gateway mode', async () => {
    expect((await handleReadiness(() => undefined).json())).toEqual({ ready: true });
  });

  it('in gateway mode without a service token it is NOT ready (503) and names only the missing variable', async () => {
    const res = handleReadiness((n) => (n === 'OSIRIS_DEPLOYMENT_MODE' ? 'tour27-gateway' : undefined));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ready: false, missing: ['OSIRIS_SERVICE_TOKEN'] });
  });

  it('in gateway mode with a token it is ready, and never echoes the token', async () => {
    const res = handleReadiness((n) => ({ OSIRIS_DEPLOYMENT_MODE: 'tour27-gateway', OSIRIS_SERVICE_TOKEN: 'super-secret-value' } as Record<string, string>)[n]);
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain('super-secret-value');
  });
});
