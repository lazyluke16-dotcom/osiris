const EARTH_RADIUS_KM = 6371;

export interface BoundingBox { west: number; south: number; east: number; north: number }

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Great-circle distance in kilometres (haversine). */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Bounding box(es) that fully contain the circle of `radiusKm` around a point. Returns two boxes when
 * the circle crosses the antimeridian, and a full-longitude band when the circle contains or
 * approaches a pole. Callers must still post-filter by true distance (see `haversineKm`).
 */
export function boundingBoxes(lat: number, lng: number, radiusKm: number): BoundingBox[] {
  const angular = radiusKm / EARTH_RADIUS_KM;
  const dLatDeg = toDeg(angular);
  const south = Math.max(-90, lat - dLatDeg);
  const north = Math.min(90, lat + dLatDeg);

  const poleReached = lat + dLatDeg >= 90 || lat - dLatDeg <= -90;
  const sinRatio = Math.sin(angular) / Math.cos(toRad(lat));
  if (poleReached || !Number.isFinite(sinRatio) || sinRatio >= 1) return [{ west: -180, south, east: 180, north }];

  const dLngDeg = toDeg(Math.asin(sinRatio));
  const west = lng - dLngDeg;
  const east = lng + dLngDeg;

  if (west < -180) return [{ west: west + 360, south, east: 180, north }, { west: -180, south, east, north }];
  if (east > 180) return [{ west, south, east: 180, north }, { west: -180, south, east: east - 360, north }];
  return [{ west, south, east, north }];
}
