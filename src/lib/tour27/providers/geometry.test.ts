import { describe, it, expect } from 'vitest';
import type { OfficialAlertGeometry } from '../contract';
import { isWellFormedGeometry, pointInGeometry } from './geometry';

// GeoJSON order is [lng, lat]. Square: lng -10..10, lat -10..10.
const SQUARE: OfficialAlertGeometry = { type: 'Polygon', coordinates: [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]]] };
const WITH_HOLE: OfficialAlertGeometry = {
  type: 'Polygon',
  coordinates: [[[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]], [[-2, -2], [2, -2], [2, 2], [-2, 2], [-2, -2]]],
};
const MULTI: OfficialAlertGeometry = {
  type: 'MultiPolygon',
  coordinates: [[[[-10, -10], [-5, -10], [-5, -5], [-10, -5], [-10, -10]]], [[[5, 5], [10, 5], [10, 10], [5, 10], [5, 5]]]],
};

describe('pointInGeometry (lat, lng)', () => {
  it('uses GeoJSON [lng, lat] order: lat is the FIRST argument', () => {
    expect(pointInGeometry(5, 0, SQUARE)).toBe(true);
    const tall: OfficialAlertGeometry = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 50], [0, 50], [0, 0]]] };
    expect(pointInGeometry(25, 0.5, tall)).toBe(true); // lat 25, lng 0.5
    expect(pointInGeometry(0.5, 25, tall)).toBe(false); // swapped would be outside
  });

  it('inside / outside a simple polygon', () => {
    expect(pointInGeometry(0, 0, SQUARE)).toBe(true);
    expect(pointInGeometry(11, 0, SQUARE)).toBe(false);
    expect(pointInGeometry(0, -11, SQUARE)).toBe(false);
  });

  it('boundary and vertex count as INSIDE (never under-report a warning)', () => {
    expect(pointInGeometry(0, 10, SQUARE)).toBe(true); // on the east edge
    expect(pointInGeometry(-10, -10, SQUARE)).toBe(true); // vertex
    expect(pointInGeometry(10, 5, SQUARE)).toBe(true); // on the north edge
  });

  it('honours holes: inside a hole is NOT covered; on the hole edge IS covered', () => {
    expect(pointInGeometry(0, 0, WITH_HOLE)).toBe(false);
    expect(pointInGeometry(0, 2, WITH_HOLE)).toBe(true);
    expect(pointInGeometry(5, 5, WITH_HOLE)).toBe(true);
  });

  it('MultiPolygon: inside any member, outside the gaps', () => {
    expect(pointInGeometry(-7, -7, MULTI)).toBe(true);
    expect(pointInGeometry(7, 7, MULTI)).toBe(true);
    expect(pointInGeometry(0, 0, MULTI)).toBe(false);
  });

  it('null / unsupported / malformed geometry never covers a point', () => {
    expect(pointInGeometry(0, 0, null)).toBe(false);
    expect(pointInGeometry(0, 0, { type: 'Point', coordinates: [0, 0] } as never)).toBe(false);
    expect(pointInGeometry(0, 0, { type: 'Polygon', coordinates: [] })).toBe(false);
    expect(pointInGeometry(0, 0, { type: 'Polygon', coordinates: [[[0, 0], [1, 1]]] })).toBe(false);
    expect(pointInGeometry(0, 0, { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [NaN, 0], [0, 0]]] })).toBe(false);
    expect(pointInGeometry(0, 0, { type: 'MultiPolygon', coordinates: [] })).toBe(false);
  });
});

describe('isWellFormedGeometry', () => {
  it('accepts valid polygons and multipolygons', () => {
    expect(isWellFormedGeometry(SQUARE)).toBe(true);
    expect(isWellFormedGeometry(WITH_HOLE)).toBe(true);
    expect(isWellFormedGeometry(MULTI)).toBe(true);
  });

  it.each([
    [null], [undefined], ['x'], [42], [{}], [{ type: 'Polygon' }], [{ type: 'Polygon', coordinates: [] }], [{ type: 'Polygon', coordinates: [[]] }],
    [{ type: 'Polygon', coordinates: [[[0, 0], [1, 1], [0, 0]]] }], // ring of 3
    [{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], ['a', 0], [0, 0]]] }],
    [{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [Infinity, 0], [0, 0]]] }],
    [{ type: 'Polygon', coordinates: [[[0], [1, 0], [1, 1], [0, 1], [0]]] }], // positions with < 2 values
    [{ type: 'MultiPolygon', coordinates: [] }], [{ type: 'MultiPolygon', coordinates: [[]] }], [{ type: 'Point', coordinates: [0, 0] }], [{ type: 'LineString', coordinates: [[0, 0], [1, 1]] }],
  ])('rejects malformed geometry %p', (g) => {
    expect(isWellFormedGeometry(g)).toBe(false);
  });
});
