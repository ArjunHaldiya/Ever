import type { LatLng } from "./types";

const EARTH_RADIUS_MILES = 3958.8;

export type ZipCentroids = Record<string, LatLng>;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function haversineMiles(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Round to 3 decimal places (~110 m) before storing a resident's location. */
export function roundCoord(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function roundLatLng(p: LatLng): LatLng {
  return { lat: roundCoord(p.lat), lng: roundCoord(p.lng) };
}

const ZIP_RE = /\b(\d{5})(?:-\d{4})?\b/;

export function extractZip(text: string): string | null {
  return ZIP_RE.exec(text)?.[1] ?? null;
}

/** Fallback geocoder: ZIP -> centroid from the seeded table. */
export function lookupZip(centroids: ZipCentroids, zip: string): LatLng | null {
  return centroids[zip] ?? null;
}
