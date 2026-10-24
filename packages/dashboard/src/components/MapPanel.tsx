import type { DashboardState, Resource } from "@ever/core";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Protocol } from "pmtiles";
import { useEffect, useMemo, useRef, useState } from "react";
import { FOCUS_LABEL, matchingPlaces, placeLook, type PlaceLook } from "../lib/format";
import { offlineStyle, offlineTilesAvailable, onlineStyle } from "../lib/mapStyle";

// MapLibre 6 keeps its worker in a separate file; it is served from /vendor/maplibre/ (see scripts/copy-maplibre.mjs).
maplibregl.setWorkerUrl(`${import.meta.env.BASE_URL}vendor/maplibre/maplibre-gl-worker.mjs`);
// Lets MapLibre read tiles straight out of the local .pmtiles file.
maplibregl.addProtocol("pmtiles", new Protocol().tile);

const SAN_JOSE: [number, number] = [-121.8863, 37.3382];
const TILT = 58;
const BEARING = -17;

function placeElement(r: Resource, look: PlaceLook): HTMLDivElement {
  const el = document.createElement("div");
  const off = look === "off" || look === "match-off";
  el.className = `place place--${look}`;
  el.textContent = off ? "×" : String(r.capacity);
  el.title = `${r.name}: ${off ? (r.hasPower ? "full" : "no power") : `${r.capacity} ${r.capacityUnit} left`}`;
  el.style.zIndex = look === "match" ? "3" : look === "dim" ? "1" : "2";
  return el;
}

type Basemap = "loading" | "offline" | "online";

export function MapPanel({ state }: { state: DashboardState | null }) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markers = useRef(new Map<string, maplibregl.Marker>());
  const framedFor = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const [basemap, setBasemap] = useState<Basemap>("loading");
  const [tilted, setTilted] = useState(true);
  const [tilesFailed, setTilesFailed] = useState(false);

  const places = state?.places ?? [];
  const focus = state?.focus ?? null;
  const matches = useMemo(() => matchingPlaces(places, focus), [places, focus]);

  useEffect(() => {
    if (!container.current) return;
    let cancelled = false;
    let map: maplibregl.Map | null = null;
    let resizer: ResizeObserver | null = null;
    const placeMarkers = markers.current;

    (async () => {
      const base = import.meta.env.BASE_URL;
      const offline = await offlineTilesAvailable(base);
      if (cancelled || !container.current) return;
      setBasemap(offline ? "offline" : "online");

      map = new maplibregl.Map({
        container: container.current,
        style: offline ? offlineStyle(window.location.origin, base) : onlineStyle(),
        center: SAN_JOSE,
        zoom: 11.6,
        pitch: TILT,
        bearing: BEARING,
        maxPitch: 75,
        attributionControl: { compact: true },
      });
      map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

      // Basemap problems must never take the markers down with them.
      let tileErrors = 0;
      map.on("error", (e) => {
        const status = (e.error as { status?: number } | undefined)?.status;
        if (status !== undefined || (e as { sourceId?: string }).sourceId) {
          tileErrors += 1;
          if (tileErrors >= 3) setTilesFailed(true);
        }
      });

      const markReady = () => setReady(true);
      if (map.isStyleLoaded()) markReady();
      else map.once("style.load", markReady);
      mapRef.current = map;
      // The map's width changes when the side panel opens or closes.
      resizer = new ResizeObserver(() => map?.resize());
      resizer.observe(container.current);
    })();

    return () => {
      cancelled = true;
      resizer?.disconnect();
      placeMarkers.forEach((m) => m.remove());
      placeMarkers.clear();
      map?.remove();
      mapRef.current = null;
      setReady(false);
    };
  }, []);

  // Draw the places. Redrawn only when a place changes or the highlighted kind changes, not on every poll,
  // so the pulse animation on highlighted places is not restarted every two seconds.
  const signature = useMemo(
    () => places.map((p) => `${p.id}:${p.capacity}:${p.hasPower}`).join("|") + `#${focus?.needType ?? ""}`,
    [places, focus?.needType],
  );
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;
    const seen = new Set<string>();
    for (const r of places) {
      seen.add(r.id);
      markers.current.get(r.id)?.remove();
      markers.current.set(
        r.id,
        new maplibregl.Marker({ element: placeElement(r, placeLook(r, focus)), pitchAlignment: "viewport", rotationAlignment: "viewport" })
          .setLngLat([r.lng, r.lat])
          .addTo(map),
      );
    }
    for (const [id, m] of markers.current) {
      if (!seen.has(id)) {
        m.remove();
        markers.current.delete(id);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, ready]);

  const fitTo = (pts: Resource[], maxZoom: number, duration: number) => {
    const map = mapRef.current;
    if (!map || pts.length === 0) return;
    const first: [number, number] = [pts[0]!.lng, pts[0]!.lat];
    const bounds = pts.reduce((b, p) => b.extend([p.lng, p.lat]), new maplibregl.LngLatBounds(first, first));
    const { width, height } = map.getContainer().getBoundingClientRect();
    const pad = Math.max(20, Math.min(120, Math.floor(Math.min(width, height) / 5)));
    map.fitBounds(bounds, { padding: pad, maxZoom, duration, pitch: map.getPitch(), bearing: map.getBearing() });
  };

  // Bring the highlighted places into view whenever a new request changes what is highlighted,
  // and frame all places once at the start.
  useEffect(() => {
    if (!ready || places.length === 0) return;
    const key = focus ? `${focus.at}` : "all";
    if (framedFor.current === key) return;
    const firstFrame = framedFor.current === null;
    framedFor.current = key;
    fitTo(matches.length > 0 ? matches : places, matches.length > 0 ? 13 : 12.2, firstFrame ? 0 : 900);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, focus?.at, places.length]);

  const toggleTilt = () => {
    const map = mapRef.current;
    if (!map) return;
    const next = !tilted;
    setTilted(next);
    map.easeTo({ pitch: next ? TILT : 0, bearing: next ? BEARING : 0, duration: 600 });
  };

  return (
    <section className="map">
      <div ref={container} className="map__canvas" />

      <div className={`map__focus ${focus ? "map__focus--active" : ""}`}>
        {focus ? (
          <>
            <div className="label">WHERE TO SEND PEOPLE</div>
            <div className="map__focus-main">{FOCUS_LABEL[focus.needType]}</div>
            <div className="small muted">
              {matches.length} {matches.length === 1 ? "place" : "places"} open with power · stays until the next request
            </div>
          </>
        ) : (
          <>
            <div className="label">READY</div>
            <div className="map__focus-main map__focus-main--idle">WAITING FOR A REQUEST</div>
            <div className="small muted">Places that can help light up here.</div>
          </>
        )}
      </div>

      <div className="map__buttons">
        <button className="map__btn" onClick={() => fitTo(matches.length > 0 ? matches : places, 13, 700)}>
          {matches.length > 0 ? "SHOW THESE PLACES" : "SHOW ALL PLACES"}
        </button>
        <button className={`map__btn ${tilted ? "map__btn--on" : ""}`} onClick={toggleTilt} aria-pressed={tilted}>3D VIEW</button>
      </div>

      {basemap === "offline" && <div className="map__chip"><span className="dot dot--ok" />OFFLINE MAP · NO INTERNET NEEDED</div>}
      {basemap === "online" && !tilesFailed && <div className="map__chip map__chip--muted">ONLINE BASEMAP</div>}
      {tilesFailed && <div className="map__chip map__chip--warn">BASEMAP UNAVAILABLE · PLACES STILL LIVE</div>}

      <div className="legend">
        <div className="label">LEGEND</div>
        <div className="legend__row"><span className="swatch swatch--match" />Can help with this request</div>
        <div className="legend__row"><span className="swatch swatch--sq" />Open with power (seats left)</div>
        <div className="legend__row"><span className="swatch swatch--sq swatch--off" />No power or full</div>
      </div>
    </section>
  );
}
