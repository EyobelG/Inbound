import type { LngLat } from "@/types/domain";

const EARTH_RADIUS_M = 6_371_000;

/**
 * Boston's street grid is not a grid. Straight-line distance underestimates a
 * real walk by roughly a third; this factor converts one to the other and is
 * the same constant the SQL helpers use. Keep them in sync.
 */
export const STREET_DETOUR_FACTOR = 1.35;

/** Comfortable urban pace, metres per minute. */
export const WALK_SPEED_M_PER_MIN = 80;

export function haversineMeters(a: LngLat, b: LngLat): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function walkingMinutes(straightLineMeters: number): number {
  return Math.max(
    1,
    Math.ceil((straightLineMeters * STREET_DETOUR_FACTOR) / WALK_SPEED_M_PER_MIN),
  );
}

/** PostGIS returns `POINT(lng lat)` in WKT or GeoJSON depending on the cast. */
export function parsePoint(value: unknown): LngLat {
  if (value && typeof value === "object" && "coordinates" in value) {
    const coords = (value as { coordinates: unknown }).coordinates;
    if (Array.isArray(coords) && coords.length >= 2) {
      return { lng: Number(coords[0]), lat: Number(coords[1]) };
    }
  }
  if (typeof value === "string") {
    const match = /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(value);
    if (match?.[1] && match[2]) {
      return { lng: Number(match[1]), lat: Number(match[2]) };
    }
  }
  throw new Error(`Unparseable PostGIS point: ${JSON.stringify(value)}`);
}

export function toGeoJsonPoint(p: LngLat): GeoJSON.Point {
  return { type: "Point", coordinates: [p.lng, p.lat] };
}
