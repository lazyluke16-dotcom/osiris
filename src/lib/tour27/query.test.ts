import { describe, it, expect } from 'vitest';
import { parseQuery } from './query';

const p = (s: string) => parseQuery(new URLSearchParams(s));

describe('parseQuery', () => {
  it('applies the direct Tour 27 defaults', () => {
    const r = p('lat=43.6532&lng=-79.3832');
    expect(r).toMatchObject({ ok: true });
    if (!r.ok) return;
    expect(r.query).toEqual({
      latitude: 43.6532, longitude: -79.3832,
      earthquakes: { radiusKm: 250, minMagnitude: 2.5, lookbackHours: 24 },
      fires: { radiusKm: 100, lookbackDays: 1 },
      environmentalEvents: { radiusKm: 500, lookbackDays: 30 },
      forecast: { forecastHours: 24 },
    });
  });

  it('keeps coordinates at FULL precision (no rounding or truncation)', () => {
    const r = p('lat=43.653245123456&lng=-79.383251987654');
    expect(r.ok && r.query.latitude).toBe(43.653245123456);
    expect(r.ok && r.query.longitude).toBe(-79.383251987654);
  });

  it('accepts and applies every option at its bounds', () => {
    const r = p('lat=90&lng=-180&eqRadiusKm=1000&eqMinMagnitude=0&eqLookbackHours=168&fireRadiusKm=500&fireLookbackDays=5&eventRadiusKm=2000&eventLookbackDays=90&forecastHours=168');
    expect(r.ok && r.query.earthquakes).toEqual({ radiusKm: 1000, minMagnitude: 0, lookbackHours: 168 });
    expect(r.ok && r.query.fires).toEqual({ radiusKm: 500, lookbackDays: 5 });
    expect(r.ok && r.query.environmentalEvents).toEqual({ radiusKm: 2000, lookbackDays: 90 });
    expect(r.ok && r.query.forecast).toEqual({ forecastHours: 168 });
    expect(r.ok && r.query.latitude).toBe(90);
    expect(r.ok && r.query.longitude).toBe(-180);
  });

  it.each([
    [''], ['lat=1'], ['lng=1'], ['lat=&lng=1'], ['lat=abc&lng=1'], ['lat=1&lng=abc'], ['lat=91&lng=0'], ['lat=-90.0001&lng=0'], ['lat=0&lng=180.5'], ['lat=0&lng=-181'],
    ['lat=0x10&lng=1'], ['lat=1e2&lng=1'], ['lat=NaN&lng=1'], ['lat=Infinity&lng=1'], ['lat=1,5&lng=1'], ['lat= &lng=1'], ['lat=1&lng=--1'], ['lat=%2B1&lng=1'],
  ])('rejects invalid coordinates %p', (qs) => {
    expect(p(qs).ok).toBe(false);
  });

  it.each([
    ['eqRadiusKm=0'], ['eqRadiusKm=1001'], ['eqMinMagnitude=-0.1'], ['eqMinMagnitude=10.1'], ['eqLookbackHours=0'], ['eqLookbackHours=169'],
    ['fireRadiusKm=501'], ['fireLookbackDays=6'], ['fireLookbackDays=0'], ['eventRadiusKm=2001'], ['eventLookbackDays=91'], ['forecastHours=169'], ['forecastHours=abc'],
  ])('rejects out-of-range/invalid option %p', (opt) => {
    expect(p(`lat=1&lng=1&${opt}`).ok).toBe(false);
  });
});
