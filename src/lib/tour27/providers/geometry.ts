import type { OfficialAlertGeometry } from '../contract';

type Ring = number[][];

const isRing = (r: unknown): r is Ring =>
  Array.isArray(r) && r.length >= 4 && r.every((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));

/**
 * Is this a structurally valid Polygon/MultiPolygon (non-empty, every ring of >= 4 finite [lng, lat]
 * positions)? Callers use it to REJECT unusable provider geometry: point-in-polygon treats malformed
 * geometry as "not covering", which would silently hide an alert.
 */
export function isWellFormedGeometry(g: unknown): g is OfficialAlertGeometry {
  const geometry = g as OfficialAlertGeometry | null;
  if (!geometry || typeof geometry !== 'object') return false;
  const polygonOk = (rings: unknown) => Array.isArray(rings) && rings.length > 0 && rings.every(isRing);
  if (geometry.type === 'Polygon') return polygonOk(geometry.coordinates);
  if (geometry.type === 'MultiPolygon') {
    const polys = geometry.coordinates;
    return Array.isArray(polys) && polys.length > 0 && polys.every(polygonOk);
  }
  return false;
}

/** Point exactly on the segment a-b (planar, GeoJSON [lng, lat]). */
function onSegment(x: number, y: number, a: number[], b: number[]): boolean {
  const cross = (y - a[1]) * (b[0] - a[0]) - (x - a[0]) * (b[1] - a[1]);
  if (Math.abs(cross) > 1e-12) return false;
  return x >= Math.min(a[0], b[0]) - 1e-12 && x <= Math.max(a[0], b[0]) + 1e-12 &&
    y >= Math.min(a[1], b[1]) - 1e-12 && y <= Math.max(a[1], b[1]) + 1e-12;
}

/** 'boundary' | 'inside' | 'outside' for one ring (even-odd ray casting). */
function locate(x: number, y: number, ring: Ring): 'boundary' | 'inside' | 'outside' {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j];
    const b = ring[i];
    if (onSegment(x, y, a, b)) return 'boundary';
    if ((b[1] > y) !== (a[1] > y) && x < ((a[0] - b[0]) * (y - b[1])) / (a[1] - b[1]) + b[0]) inside = !inside;
  }
  return inside ? 'inside' : 'outside';
}

function inPolygon(x: number, y: number, rings: unknown): boolean {
  if (!Array.isArray(rings) || rings.length === 0 || !rings.every(isRing)) return false;
  const [outer, ...holes] = rings as Ring[];
  const o = locate(x, y, outer);
  if (o === 'outside') return false;
  if (o === 'boundary') return true; // on the outer edge counts as applicable
  for (const hole of holes) {
    const h = locate(x, y, hole);
    if (h === 'inside') return false; // inside a hole: NOT covered
    if (h === 'boundary') return true; // on a hole edge counts as applicable
  }
  return true;
}

/**
 * Does the lat/lng point fall inside a GeoJSON Polygon/MultiPolygon (planar, [lng, lat])?
 * Holes are honoured; points exactly on an edge count as inside (never under-report a warning).
 * Malformed geometry is never treated as covering the point. No antimeridian handling: callers
 * whose authority geography crosses 180 degrees must not rely on this.
 */
export function pointInGeometry(lat: number, lng: number, geometry: OfficialAlertGeometry | null): boolean {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') return inPolygon(lng, lat, geometry.coordinates);
  if (geometry.type === 'MultiPolygon') {
    const polys = geometry.coordinates;
    return Array.isArray(polys) && polys.some((p) => inPolygon(lng, lat, p));
  }
  return false;
}
