import { layers, namedFlavor } from "@protomaps/basemaps";
import type { LayerSpecification, StyleSpecification } from "maplibre-gl";

/**
 * Two basemaps:
 *  - offline: vector tiles from a local PMTiles file (Bay Area, from Protomaps / OpenStreetMap) with
 *    fonts and sprites served from /map-assets, so it works with no internet. Buildings are drawn as
 *    3D extrusions from their OpenStreetMap heights.
 *  - online: muted OpenStreetMap raster tiles, used only when the local file has not been created yet.
 */

export const TILES_FILE = "tiles/bayarea.pmtiles";
export const OFFLINE_ATTRIBUTION = "© OpenStreetMap contributors · Protomaps";

/** True only if the PMTiles file really exists. (The dev server answers unknown paths with index.html, so check the magic bytes.) */
export async function offlineTilesAvailable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl}${TILES_FILE}`, { headers: { Range: "bytes=0-6" } });
    if (!res.ok) return false;
    const magic = new TextDecoder().decode((await res.arrayBuffer()).slice(0, 7));
    return magic === "PMTiles";
  } catch {
    return false;
  }
}

export function offlineStyle(origin: string, baseUrl: string): StyleSpecification {
  const all = layers("protomaps", namedFlavor("light"), { lang: "en" }) as LayerSpecification[];
  const at = all.findIndex((l) => l.id === "buildings");
  const flat = all.filter((l) => l.id !== "buildings");

  // 3D buildings: height and min_height come from OpenStreetMap; many buildings have none, so assume a low-rise default.
  const extrusion: LayerSpecification = {
    id: "buildings-3d",
    type: "fill-extrusion",
    source: "protomaps",
    "source-layer": "buildings",
    minzoom: 13,
    paint: {
      "fill-extrusion-color": ["interpolate", ["linear"], ["coalesce", ["get", "height"], 9], 0, "#e9e9e4", 40, "#dcdcd6", 120, "#c8c8c2"],
      "fill-extrusion-height": ["coalesce", ["get", "height"], 9],
      "fill-extrusion-base": ["coalesce", ["get", "min_height"], 0],
      "fill-extrusion-opacity": 0.94,
      "fill-extrusion-vertical-gradient": true,
    },
  };
  const ordered = [...flat.slice(0, Math.max(at, 0)), extrusion, ...flat.slice(Math.max(at, 0))];

  return {
    version: 8,
    glyphs: `${origin}${baseUrl}map-assets/fonts/{fontstack}/{range}.pbf`,
    sprite: `${origin}${baseUrl}map-assets/sprites/v4/light`,
    sources: {
      protomaps: { type: "vector", url: `pmtiles://${origin}${baseUrl}${TILES_FILE}`, attribution: OFFLINE_ATTRIBUTION },
    },
    layers: ordered,
  };
}

export const ONLINE_ATTRIBUTION = "© OpenStreetMap contributors";

/** Only used until the offline tile file exists. OpenStreetMap's tiles need no key; muted to match the pale design. */
export function onlineStyle(): StyleSpecification {
  return {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: ONLINE_ATTRIBUTION,
        maxzoom: 19,
      },
    },
    layers: [
      { id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.88, "raster-contrast": -0.25, "raster-brightness-min": 0.22 } },
    ],
  };
}
