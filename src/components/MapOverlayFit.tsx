"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MapContainer,
  Polyline,
  TileLayer,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeorefPair, TrackPoint } from "@/lib/types";
import {
  georefFromPlacement,
  initialOverlayPlacement,
  placementCorners,
  placementFromGeoref,
  rotatePlacement,
  scalePlacement,
  translatePlacement,
  type OverlayPlacement,
} from "@/lib/georef";
import RotatedImageOverlay from "./RotatedImageOverlay";

export interface OverlayTrack {
  id: string;
  name: string;
  color: string;
  points: TrackPoint[];
}

type EditTool = "pan-map" | "move" | "scale" | "rotate";

interface Props {
  mapUrl: string;
  mapWidth: number;
  mapHeight: number;
  tracks: OverlayTrack[];
  initialGeoref: GeorefPair[];
  onSave: (pairs: GeorefPair[]) => void | Promise<void>;
}

function FitTracks({
  tracks,
  placement,
}: {
  tracks: OverlayTrack[];
  placement: OverlayPlacement;
}) {
  const map = useMap();
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current) return;
    const pts = tracks.flatMap((t) => t.points);
    if (pts.length > 0) {
      const b = L.latLngBounds(
        pts.map((p) => [p.lat, p.lon] as [number, number])
      );
      map.fitBounds(b.pad(0.25), { animate: false });
      fitted.current = true;
      return;
    }
    const { tl, tr, bl, br } = placementCorners(placement);
    map.fitBounds(
      L.latLngBounds([
        [tl.lat, tl.lon],
        [tr.lat, tr.lon],
        [bl.lat, bl.lon],
        [br.lat, br.lon],
      ]),
      { padding: [40, 40], animate: false }
    );
    fitted.current = true;
  }, [map, tracks, placement]);
  return null;
}

function angleFromCenterDegCW(
  center: OverlayPlacement,
  latlng: L.LatLng
): number {
  const midLat = (center.centerLat + latlng.lat) / 2;
  const east =
    (latlng.lng - center.centerLon) *
    111_320 *
    Math.cos((midLat * Math.PI) / 180);
  const north = (latlng.lat - center.centerLat) * 111_320;
  // CW from north: 0 = north, 90 = east
  return (Math.atan2(east, north) * 180) / Math.PI;
}

function OverlayEditor({
  tool,
  placement,
  setPlacement,
}: {
  tool: EditTool;
  placement: OverlayPlacement;
  setPlacement: (p: OverlayPlacement) => void;
}) {
  const map = useMap();
  const drag = useRef<{
    start: L.LatLng;
    placement: OverlayPlacement;
    startAngle?: number;
  } | null>(null);

  useEffect(() => {
    if (tool === "pan-map") {
      map.dragging.enable();
      map.getContainer().style.cursor = "";
    } else {
      map.dragging.disable();
      map.getContainer().style.cursor =
        tool === "move" ? "move" : tool === "rotate" ? "crosshair" : "ns-resize";
    }
    return () => {
      map.dragging.enable();
      map.getContainer().style.cursor = "";
    };
  }, [map, tool]);

  useMapEvents({
    mousedown(e) {
      if (tool === "pan-map") return;
      drag.current = {
        start: e.latlng,
        placement,
        startAngle:
          tool === "rotate"
            ? angleFromCenterDegCW(placement, e.latlng)
            : undefined,
      };
      map.dragging.disable();
    },
    mousemove(e) {
      if (!drag.current || tool === "pan-map") return;
      const { start, placement: p0, startAngle } = drag.current;
      if (tool === "move") {
        setPlacement(
          translatePlacement(
            p0,
            e.latlng.lat - start.lat,
            e.latlng.lng - start.lng
          )
        );
      } else if (tool === "scale") {
        const midLat = p0.centerLat;
        const mLon = 111_320 * Math.cos((midLat * Math.PI) / 180);
        const startDist = Math.hypot(
          (start.lat - p0.centerLat) * 111_320,
          (start.lng - p0.centerLon) * mLon
        );
        const curDist = Math.hypot(
          (e.latlng.lat - p0.centerLat) * 111_320,
          (e.latlng.lng - p0.centerLon) * mLon
        );
        const base = Math.max(startDist, 20);
        const factor = Math.max(0.15, Math.min(6, curDist / base));
        setPlacement(scalePlacement(p0, factor));
      } else if (tool === "rotate" && startAngle != null) {
        const ang = angleFromCenterDegCW(p0, e.latlng);
        setPlacement(rotatePlacement(p0, ang - startAngle));
      }
    },
    mouseup() {
      drag.current = null;
    },
    mouseout() {
      drag.current = null;
    },
  });

  return null;
}

export default function MapOverlayFit({
  mapUrl,
  mapWidth,
  mapHeight,
  tracks,
  initialGeoref,
  onSave,
}: Props) {
  const allPts = useMemo(() => tracks.flatMap((t) => t.points), [tracks]);

  const [placement, setPlacement] = useState<OverlayPlacement>(() => {
    const fromGeoref = placementFromGeoref(
      initialGeoref,
      mapWidth,
      mapHeight
    );
    if (fromGeoref) return fromGeoref;
    return initialOverlayPlacement(allPts, mapWidth, mapHeight);
  });

  const [tool, setTool] = useState<EditTool>("move");
  const [opacity, setOpacity] = useState(0.5);
  const [status, setStatus] = useState("");
  const [saving, setSaving] = useState(false);

  const corners = useMemo(() => placementCorners(placement), [placement]);

  const resetToTracks = useCallback(() => {
    setPlacement(initialOverlayPlacement(allPts, mapWidth, mapHeight));
    setStatus("Reset over tracks");
  }, [allPts, mapWidth, mapHeight]);

  const nudgeScale = (factor: number) => {
    setPlacement((p) => scalePlacement(p, factor));
  };

  const nudgeRotate = (delta: number) => {
    setPlacement((p) => rotatePlacement(p, delta));
  };

  const save = async () => {
    setSaving(true);
    try {
      const pairs = georefFromPlacement(placement, mapWidth, mapHeight);
      await onSave(pairs);
      setStatus("Saved map placement");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center text-sm">
        <div className="flex rounded-lg border border-forest-200 overflow-hidden">
          {(
            [
              ["pan-map", "Pan map"],
              ["move", "Move"],
              ["scale", "Scale"],
              ["rotate", "Rotate"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`px-3 py-1.5 ${
                tool === id ? "bg-forest-100 font-medium" : "bg-white"
              }`}
              onClick={() => setTool(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="rounded-lg border border-forest-200 px-2.5 py-1.5 bg-white"
          onClick={() => nudgeScale(1 / 1.08)}
          title="Shrink"
        >
          −
        </button>
        <button
          type="button"
          className="rounded-lg border border-forest-200 px-2.5 py-1.5 bg-white"
          onClick={() => nudgeScale(1.08)}
          title="Enlarge"
        >
          +
        </button>
        <button
          type="button"
          className="rounded-lg border border-forest-200 px-2.5 py-1.5 bg-white"
          onClick={() => nudgeRotate(-2)}
          title="Rotate counter-clockwise"
        >
          ↺
        </button>
        <button
          type="button"
          className="rounded-lg border border-forest-200 px-2.5 py-1.5 bg-white"
          onClick={() => nudgeRotate(2)}
          title="Rotate clockwise"
        >
          ↻
        </button>
        <span className="font-mono text-xs text-forest-600 w-14">
          {placement.rotationDeg.toFixed(1)}°
        </span>
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
          onClick={resetToTracks}
        >
          Reset over tracks
        </button>
        <button
          type="button"
          disabled={saving || mapWidth <= 0}
          className="rounded-lg bg-forest-700 text-white px-4 py-1.5 font-medium hover:bg-forest-800 disabled:opacity-40"
          onClick={() => void save()}
        >
          {saving ? "Saving…" : "Save placement"}
        </button>
        {status && (
          <span className="text-forest-600 font-mono text-xs">{status}</span>
        )}
      </div>

      <p className="text-sm text-forest-600">
        Align the map with GPS tracks: Move, Scale (drag from center), or
        Rotate (drag around center / ↺↻). Then save. Opacity defaults to 50%.
      </p>

      <div className="rounded-xl overflow-hidden border border-forest-200 h-[min(70vh,560px)] relative">
        <MapContainer
          center={[placement.centerLat, placement.centerLon]}
          zoom={14}
          className="h-full w-full"
          zoomControl
        >
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitTracks tracks={tracks} placement={placement} />
          <OverlayEditor
            tool={tool}
            placement={placement}
            setPlacement={setPlacement}
          />
          <RotatedImageOverlay
            url={mapUrl}
            topLeft={[corners.tl.lat, corners.tl.lon]}
            topRight={[corners.tr.lat, corners.tr.lon]}
            bottomLeft={[corners.bl.lat, corners.bl.lon]}
            opacity={opacity}
          />
          {tracks.map((t) => (
            <Polyline
              key={t.id}
              positions={t.points.map(
                (p) => [p.lat, p.lon] as [number, number]
              )}
              pathOptions={{ color: t.color, weight: 3, opacity: 0.85 }}
            />
          ))}
        </MapContainer>
      </div>
    </div>
  );
}
