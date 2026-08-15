export interface LonLat {
  lon: number;
  lat: number;
}

/**
 * Straight-line distance (metres) between two points. Shared by MapView (route fallback
 * geometry / distance-when-routing-service-is-down) and anywhere else that needs a cheap
 * displacement number without calling out to the routing service — e.g. "how far has the
 * collector travelled since accepting" (HouseholdHome/CollectorHome), which is a net-displacement
 * measurement, not a real path length.
 */
export function haversineM(a: LonLat, b: LonLat): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export function formatDistance(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}
