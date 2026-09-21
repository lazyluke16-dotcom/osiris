import { describe, it, expect } from 'vitest';
import { parseCsv } from './csv';
import { boundingBoxes, haversineKm } from './geo';

describe('haversineKm', () => {
  it('is zero for identical points and ~111 km per degree of latitude', () => {
    expect(haversineKm(10, 20, 10, 20)).toBe(0);
    expect(haversineKm(0, 0, 1, 0)).toBeCloseTo(111.19, 1);
  });
  it('is symmetric and handles the antimeridian by the short way', () => {
    expect(haversineKm(0, 179.5, 0, -179.5)).toBeCloseTo(haversineKm(0, -179.5, 0, 179.5), 9);
    expect(haversineKm(0, 179.5, 0, -179.5)).toBeCloseTo(111.19, 1);
  });
});

describe('boundingBoxes', () => {
  it('returns a single box that contains the circle for an ordinary point', () => {
    const [b] = boundingBoxes(35, 139, 100);
    expect(boundingBoxes(35, 139, 100)).toHaveLength(1);
    expect(b.west).toBeLessThan(139); expect(b.east).toBeGreaterThan(139); expect(b.south).toBeLessThan(35); expect(b.north).toBeGreaterThan(35);
  });
  it('splits into two boxes across the antimeridian (both directions)', () => {
    expect(boundingBoxes(0, 179.9, 300)).toHaveLength(2);
    expect(boundingBoxes(0, -179.9, 300)).toHaveLength(2);
    const [a, b] = boundingBoxes(0, 179.9, 300);
    expect(a.east).toBe(180); expect(b.west).toBe(-180);
  });
  it('returns a full-longitude band near a pole, and clamps latitude', () => {
    const [b] = boundingBoxes(89.5, 10, 300);
    expect(b).toMatchObject({ west: -180, east: 180, north: 90 });
  });
  it('every point inside the radius lies inside some box (no under-coverage)', () => {
    for (const [lat, lng, r] of [[35, 139, 250], [0, 179.9, 500], [60, -100, 1000], [-45, 170, 400]] as const) {
      const boxes = boundingBoxes(lat, lng, r);
      for (let bearing = 0; bearing < 360; bearing += 15) {
        const dLat = (r * 0.99 / 111.19) * Math.cos((bearing * Math.PI) / 180);
        const dLng = (r * 0.99 / (111.19 * Math.cos((lat * Math.PI) / 180))) * Math.sin((bearing * Math.PI) / 180);
        let pLng = lng + dLng; if (pLng > 180) pLng -= 360; if (pLng < -180) pLng += 360;
        const pLat = lat + dLat;
        if (haversineKm(lat, lng, pLat, pLng) > r) continue;
        expect(boxes.some((b) => pLat >= b.south && pLat <= b.north && pLng >= b.west && pLng <= b.east)).toBe(true);
      }
    }
  });
});

describe('parseCsv', () => {
  it('parses plain rows with LF and CRLF, skipping blank lines', () => {
    expect(parseCsv('a,b\r\n1,2\n\n3,4\n')).toEqual([['a', 'b'], ['1', '2'], ['3', '4']]);
  });
  it('handles quoted fields, embedded commas/newlines and escaped quotes', () => {
    expect(parseCsv('a,b\n"x,y","he said ""hi"""\n"line1\nline2",z')).toEqual([['a', 'b'], ['x,y', 'he said "hi"'], ['line1\nline2', 'z']]);
  });
  it('keeps empty fields and handles a final row without a trailing newline', () => {
    expect(parseCsv('a,b,c\n1,,3')).toEqual([['a', 'b', 'c'], ['1', '', '3']]);
    expect(parseCsv('')).toEqual([]);
  });
});
