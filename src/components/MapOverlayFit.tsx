"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeorefPair, MapPixel, TrackPoint } from "@/lib/types";
import { fitAffine, mapToGps } from "@/lib/georef";
import { DEFAULT_MAP_CENTER, DEFAULT_MAP_CENTER_TUPLE } from "@/lib/geoDefaults";
import RotatedImageOverlay from "./RotatedImageOverlay";

export interface OverlayTrack {
  id: string;
  name: string;
  color: string;
  points: TrackPoint[];
}

interface Props {
  mapUrl: string;
  mapWidth: number;
  mapHeight: number;
  tracks: OverlayTrack[];
  initialGeoref: GeorefPair[];
  onSave: (pairs: GeorefPair[]) => void | Promise<void>;
}

type PointId = "A" | "B" | "C";

interface ControlPoint {
  id: PointId;
  map: MapPixel | null;
  gps: { lat: number; lon: number } | null;
}

const POINT_IDS: PointId[] = ["A", "B", "C"];
const POINT_COLORS: Record<PointId, string> = {
  A: "#c0392b",
  B: "#2471a3",
  C: "#1e8449",
};

function pointIcon(id: PointId): L.DivIcon {
  const color = POINT_COLORS[id];
  return L.divIcon({
    className: "georef-point-icon",
    html: `<div style="
      width:28px;height:28px;border-radius:50%;
      background:${color};color:#fff;
      border:2px solid #fff;
      box-shadow:0 1px 4px rgba(0,0,0,.35);
      display:flex;align-items:center;justify-content:center;
      font:700 13px/1 ui-sans-serif,system-ui,sans-serif;
      cursor:grab;
    ">${id}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
}

function trackCentroid(
  tracks: OverlayTrack[]
): { lat: number; lon: number } | null {
  const pts = tracks.flatMap((t) => t.points);
  if (!pts.length) return null;
  let lat = 0,
    lon = 0;
  for (const p of pts) {
    lat += p.lat;
    lon += p.lon;
  }
  return { lat: lat / pts.length, lon: lon / pts.length };
}

function seedGpsAround(
  center: { lat: number; lon: number },
  index: number
): { lat: number; lon: number } {
  // ~80 m offsets so A/B/C are not stacked
  const dLat = 0.0007;
  const dLon = 0.001;
  const offsets = [
    { lat: dLat, lon: -dLon },
    { lat: dLat, lon: dLon },
    { lat: -dLat, lon: 0 },
  ];
  const o = offsets[index] ?? { lat: 0, lon: 0 };
  return { lat: center.lat + o.lat, lon: center.lon + o.lon };
}

function FitTracks({ tracks }: { tracks: OverlayTrack[] }) {
  const map = useMap();
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current) return;
    const pts = tracks.flatMap((t) => t.points);
    if (pts.length === 0) return;
    map.fitBounds(
      L.latLngBounds(pts.map((p) => [p.lat, p.lon] as [number, number])).pad(
        0.25
      ),
      { animate: false }
    );
    fitted.current = true;
  }, [map, tracks]);
  return null;
}

function pairsFromPoints(points: ControlPoint[]): GeorefPair[] | null {
  if (!points.every((p) => p.map && p.gps)) return null;
  return points.map((p) => ({
    map: p.map!,
    gps: p.gps!,
  }));
}

export default function MapOverlayFit({
  mapUrl,
  mapWidth,
  mapHeight,
  tracks,
  initialGeoref,
  onSave,
}: Props) {
  const [points, setPoints] = useState<ControlPoint[]>(() => {
    if (initialGeoref.length >= 3) {
      return POINT_IDS.map((id, i) => ({
        id,
        map: { ...initialGeoref[i].map },
        gps: { ...initialGeoref[i].gps },
      }));
    }
    return POINT_IDS.map((id) => ({ id, map: null, gps: null }));
  });

  const mapPicked = points.filter((p) => p.map).length;
  const allMapPicked = mapPicked === 3;
  const allPlaced = points.every((p) => p.map && p.gps);

  const [step, setStep] = useState<"pick-map" | "place-osm">(() =>
    initialGeoref.length >= 3 ? "place-osm" : "pick-map"
  );
  const [opacity, setOpacity] = useState(0.5);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);
  const imgRef = useRef<HTMLImageElement>(null);

  const nextPickId = POINT_IDS.find(
    (id) => !points.find((p) => p.id === id)?.map
  );

  // Defer overlay math so marker interaction stays responsive
  const deferredPoints = useDeferredValue(points);
  const affine = useMemo(() => {
    const pairs = pairsFromPoints(deferredPoints);
    if (!pairs) return null;
    return fitAffine(pairs);
  }, [deferredPoints]);

  const overlayCorners = useMemo(() => {
    if (!affine || mapWidth <= 0 || mapHeight <= 0) return null;
    const tl = mapToGps(affine, { x: 0, y: 0 });
    const tr = mapToGps(affine, { x: mapWidth, y: 0 });
    const bl = mapToGps(affine, { x: 0, y: mapHeight });
    return {
      topLeft: [tl.lat, tl.lon] as [number, number],
      topRight: [tr.lat, tr.lon] as [number, number],
      bottomLeft: [bl.lat, bl.lon] as [number, number],
    };
  }, [affine, mapWidth, mapHeight]);

  const onImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const img = imgRef.current;
    if (!img || !mapWidth || !nextPickId) return;
    const rect = img.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * mapWidth;
    const y = ((e.clientY - rect.top) / rect.height) * mapHeight;
    setPoints((prev) =>
      prev.map((p) =>
        p.id === nextPickId ? { ...p, map: { x, y } } : p
      )
    );
    setStatus(`Point ${nextPickId} on map image`);
  };

  const goPlaceOsm = useCallback(() => {
    if (!allMapPicked) return;
    const center =
      trackCentroid(tracks) ??
      points.find((p) => p.gps)?.gps ?? { ...DEFAULT_MAP_CENTER };

    setPoints((prev) =>
      prev.map((p, i) => ({
        ...p,
        gps: p.gps ?? seedGpsAround(center, i),
      }))
    );
    setStep("place-osm");
    setStatus("Drag A, B, C to the matching places on OSM / tracks");
  }, [allMapPicked, tracks, points]);

  // Auto-advance when third map point is picked
  useEffect(() => {
    if (step === "pick-map" && allMapPicked && !allPlaced) {
      // leave user to click Continue — don't surprise-jump
    }
  }, [step, allMapPicked, allPlaced]);

  const setGps = (id: PointId, lat: number, lon: number) => {
    setPoints((prev) =>
      prev.map((p) => (p.id === id ? { ...p, gps: { lat, lon } } : p))
    );
  };

  const repickMap = () => {
    setPoints(POINT_IDS.map((id) => ({ id, map: null, gps: null })));
    setStep("pick-map");
    setStatus("Click 3 characteristic points on the map image");
  };

  const save = async () => {
    const pairs = pairsFromPoints(points);
    if (!pairs) return;
    setSaving(true);
    try {
      await onSave(pairs);
      setStatus("Saved 3-point georeference");
    } finally {
      setSaving(false);
    }
  };

  const mapCenter: [number, number] = (() => {
    const c = trackCentroid(tracks);
    if (c) return [c.lat, c.lon];
    const g = points.find((p) => p.gps)?.gps;
    if (g) return [g.lat, g.lon];
    return DEFAULT_MAP_CENTER_TUPLE;
  })();

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center text-sm">
        <div className="flex rounded-lg border border-forest-200 overflow-hidden">
          <button
            type="button"
            className={`px-3 py-1.5 ${
              step === "pick-map" ? "bg-forest-100 font-medium" : "bg-white"
            }`}
            onClick={() => setStep("pick-map")}
          >
            1. Pick on map
          </button>
          <button
            type="button"
            disabled={!allMapPicked}
            className={`px-3 py-1.5 disabled:opacity-40 ${
              step === "place-osm" ? "bg-forest-100 font-medium" : "bg-white"
            }`}
            onClick={() => goPlaceOsm()}
          >
            2. Place on OSM
          </button>
        </div>
        <label className="flex items-center gap-2 text-forest-700">
          <span className="text-xs uppercase tracking-wide">Opacity</span>
          <input
            type="range"
            min={0.15}
            max={0.9}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(parseFloat(e.target.value))}
            className="w-24"
          />
          <span className="font-mono text-xs w-8">
            {Math.round(opacity * 100)}%
          </span>
        </label>
        <button
          type="button"
          className="rounded-lg border border-forest-200 px-3 py-1.5 bg-white hover:bg-forest-50"
          onClick={repickMap}
        >
          Reset points
        </button>
        <button
          type="button"
          disabled={saving || !allPlaced}
          className="rounded-lg bg-forest-700 text-white px-4 py-1.5 font-medium hover:bg-forest-800 disabled:opacity-40"
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save georef"}
        </button>
        {status && (
          <span className="text-forest-600 font-mono text-xs">{status}</span>
        )}
      </div>

      {step === "pick-map" ? (
        <>
          <p className="text-sm text-forest-600">
            Click <strong>3 characteristic points</strong> on the orienteering
            map (path junctions, buildings, clear corners — not the purple
            course circles unless you know their GPS). Order:{" "}
            <span className="font-mono text-red-700">A</span>,{" "}
            <span className="font-mono text-blue-700">B</span>,{" "}
            <span className="font-mono text-green-700">C</span>
            {nextPickId ? ` — next: ${nextPickId}` : " — done"}.
          </p>
          <div className="rounded-xl overflow-hidden border border-forest-200 relative bg-forest-100 max-h-[min(70vh,560px)] overflow-y-auto">
            <div className="relative w-full">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={imgRef}
                src={mapUrl}
                alt="Orienteering map"
                className="w-full h-auto cursor-crosshair select-none block"
                onClick={onImageClick}
                draggable={false}
              />
              {points
                .filter((p) => p.map)
                .map((p) => (
                  <div
                    key={p.id}
                    className="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
                    style={{
                      left: `${(p.map!.x / mapWidth) * 100}%`,
                      top: `${(p.map!.y / mapHeight) * 100}%`,
                    }}
                  >
                    <div
                      className="w-7 h-7 rounded-full border-2 border-white flex items-center justify-center text-xs font-bold text-white shadow"
                      style={{ background: POINT_COLORS[p.id] }}
                    >
                      {p.id}
                    </div>
                  </div>
                ))}
            </div>
          </div>
          {allMapPicked && (
            <button
              type="button"
              className="rounded-lg bg-forest-700 text-white px-4 py-2 text-sm font-medium"
              onClick={() => goPlaceOsm()}
            >
              Continue — place A, B, C on OSM →
            </button>
          )}
        </>
      ) : (
        <>
          <p className="text-sm text-forest-600">
            Drag markers <strong>A</strong>, <strong>B</strong>,{" "}
            <strong>C</strong> freely to the matching features on OSM. The map
            overlay updates when you release the marker. Tracks stay on top.
          </p>
          <div className="rounded-xl overflow-hidden border border-forest-200 h-[min(70vh,560px)] relative">
            <MapContainer
              center={mapCenter}
              zoom={15}
              className="h-full w-full"
              zoomControl
            >
              <TileLayer
                attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                opacity={0.85}
              />
              <FitTracks tracks={tracks} />
              {overlayCorners && (
                <RotatedImageOverlay
                  url={mapUrl}
                  topLeft={overlayCorners.topLeft}
                  topRight={overlayCorners.topRight}
                  bottomLeft={overlayCorners.bottomLeft}
                  opacity={opacity}
                />
              )}
              {tracks.map((t) => (
                <Polyline
                  key={t.id}
                  positions={t.points.map(
                    (p) => [p.lat, p.lon] as [number, number]
                  )}
                  pathOptions={{
                    color: t.color,
                    weight: 3.5,
                    opacity: 1,
                  }}
                />
              ))}
              {points.map(
                (p) =>
                  p.gps && (
                    <DraggableControlMarker
                      key={p.id}
                      id={p.id}
                      lat={p.gps.lat}
                      lon={p.gps.lon}
                      onCommit={setGps}
                    />
                  )
              )}
            </MapContainer>
          </div>
          <ul className="text-xs font-mono text-forest-600 flex flex-wrap gap-3">
            {points.map((p) => (
              <li key={p.id}>
                <span style={{ color: POINT_COLORS[p.id] }}>{p.id}</span>
                {p.map
                  ? ` map(${p.map.x.toFixed(0)},${p.map.y.toFixed(0)})`
                  : " —"}
                {p.gps
                  ? ` → ${p.gps.lat.toFixed(6)}, ${p.gps.lon.toFixed(6)}`
                  : ""}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * Leaflet owns the marker while dragging. React GPS/overlay update only on
 * dragend — updating state during `drag` re-renders and snaps the pin back.
 */
function DraggableControlMarker({
  id,
  lat,
  lon,
  onCommit,
}: {
  id: PointId;
  lat: number;
  lon: number;
  onCommit: (id: PointId, lat: number, lon: number) => void;
}) {
  const draggingRef = useRef(false);
  const [pos, setPos] = useState<[number, number]>([lat, lon]);
  const icon = useMemo(() => pointIcon(id), [id]);

  useEffect(() => {
    if (!draggingRef.current) {
      setPos([lat, lon]);
    }
  }, [lat, lon]);

  return (
    <Marker
      position={pos}
      icon={icon}
      draggable
      autoPan
      eventHandlers={{
        dragstart() {
          draggingRef.current = true;
        },
        dragend(e) {
          const ll = e.target.getLatLng();
          draggingRef.current = false;
          setPos([ll.lat, ll.lng]);
          // Overlay recalculates after release (deferred in parent)
          onCommit(id, ll.lat, ll.lng);
        },
      }}
    >
      <Tooltip permanent direction="top" offset={[0, -14]}>
        {id}
      </Tooltip>
    </Marker>
  );
}
