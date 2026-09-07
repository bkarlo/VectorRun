"use client";

import { useEffect, useMemo, useState } from "react";
import {
  MapContainer,
  Marker,
  Polyline,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeorefPair, TrackPoint } from "@/lib/types";
import { fitAffine, mapToGps } from "@/lib/georef";
import { DEFAULT_MAP_CENTER_TUPLE } from "@/lib/geoDefaults";
import { trackTouchesControl } from "@/lib/sync";
import RotatedImageOverlay from "./RotatedImageOverlay";
import BasemapTiles, { type BasemapKind } from "./BasemapTiles";

export interface GpsControlMarker {
  code: string;
  sequence: number;
  lat: number;
  lon: number;
}

export interface GpsTrackLayer {
  id: string;
  name: string;
  color: string;
  points: TrackPoint[];
}

interface Props {
  controls: GpsControlMarker[];
  tracks?: GpsTrackLayer[];
  selectedSequence?: number;
  onPlace: (lat: number, lon: number) => void;
  center?: [number, number];
  /** Georeferenced orienteering map (shown under tracks) */
  mapUrl?: string | null;
  mapWidth?: number;
  mapHeight?: number;
  georef?: GeorefPair[];
  mapOpacity?: number;
}

function ClickHandler({
  onPlace,
}: {
  onPlace: (lat: number, lon: number) => void;
}) {
  useMapEvents({
    click(e) {
      onPlace(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function FitView({
  controls,
  tracks,
}: {
  controls: GpsControlMarker[];
  tracks: GpsTrackLayer[];
}) {
  const map = useMap();
  useEffect(() => {
    const pts: [number, number][] = [];
    for (const c of controls) pts.push([c.lat, c.lon]);
    for (const t of tracks) {
      for (const p of t.points) pts.push([p.lat, p.lon]);
    }
    if (pts.length === 0) return;
    if (pts.length === 1) {
      map.setView(pts[0], 15);
      return;
    }
    map.fitBounds(L.latLngBounds(pts), { padding: [40, 40] });
  }, [map, controls, tracks]);
  return null;
}

function controlPinIcon(
  code: string,
  selected: boolean,
  color: string
): L.DivIcon {
  const size = selected ? 22 : 18;
  const label = code.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return L.divIcon({
    className: "georef-pin-icon",
    html: `<div style="width:${size}px;height:${size + 12}px;position:relative;">
      <div style="
        position:absolute;left:1px;top:0;
        width:${size - 2}px;height:${size - 2}px;border-radius:50% 50% 50% 0;
        background:${color};
        border:2px solid #fff;
        box-shadow:0 1px 3px rgba(0,0,0,.35);
        transform:rotate(-45deg);
      "></div>
      <div style="
        position:absolute;left:${size + 4}px;top:0;
        font:700 11px/1.2 ui-sans-serif,system-ui,sans-serif;
        color:${color};
        text-shadow:0 0 2px #fff,1px 0 0 #fff,-1px 0 0 #fff,0 1px 0 #fff,0 -1px 0 #fff;
        white-space:nowrap;
      ">${label}</div>
    </div>`,
    iconSize: [size, size + 12],
    iconAnchor: [size / 2, size + 8],
  });
}

export default function GpsControlMap({
  controls,
  tracks = [],
  selectedSequence,
  onPlace,
  center = DEFAULT_MAP_CENTER_TUPLE,
  mapUrl = null,
  mapWidth = 0,
  mapHeight = 0,
  georef = [],
  mapOpacity = 0.55,
}: Props) {
  const touchByControl = useMemo(() => {
    const out = new Map<
      number,
      {
        hit: number;
        total: number;
        runners: { name: string; color: string; hit: boolean }[];
      }
    >();
    for (const c of controls) {
      const runners = tracks.map((t) => ({
        name: t.name,
        color: t.color,
        hit: trackTouchesControl(t.points, c),
      }));
      out.set(c.sequence, {
        hit: runners.filter((r) => r.hit).length,
        total: runners.length,
        runners,
      });
    }
    return out;
  }, [controls, tracks]);

  const overlayCorners = useMemo(() => {
    if (!mapUrl || mapWidth <= 0 || mapHeight <= 0 || georef.length < 3) {
      return null;
    }
    const affine = fitAffine(georef);
    if (!affine) return null;
    const tl = mapToGps(affine, { x: 0, y: 0 });
    const tr = mapToGps(affine, { x: mapWidth, y: 0 });
    const bl = mapToGps(affine, { x: 0, y: mapHeight });
    return {
      topLeft: [tl.lat, tl.lon] as [number, number],
      topRight: [tr.lat, tr.lon] as [number, number],
      bottomLeft: [bl.lat, bl.lon] as [number, number],
    };
  }, [mapUrl, mapWidth, mapHeight, georef]);

  const hasMap = !!(mapUrl && overlayCorners);
  const [basemap, setBasemap] = useState<BasemapKind>("osm");

  return (
    <div className="relative h-full w-full min-h-[420px]">
    <MapContainer
      center={center}
      zoom={14}
      className="h-full w-full min-h-[420px] cursor-crosshair"
      zoomControl
    >
      <BasemapTiles kind={basemap} opacity={hasMap ? 0.45 : 1} />
      <ClickHandler onPlace={onPlace} />
      <FitView controls={controls} tracks={tracks} />

      {hasMap && mapUrl && overlayCorners && (
        <RotatedImageOverlay
          url={mapUrl}
          topLeft={overlayCorners.topLeft}
          topRight={overlayCorners.topRight}
          bottomLeft={overlayCorners.bottomLeft}
          opacity={mapOpacity}
        />
      )}

      {tracks.map((t) => (
        <Polyline
          key={t.id}
          positions={t.points.map((p) => [p.lat, p.lon] as [number, number])}
          pathOptions={{ color: t.color, weight: 3, opacity: 0.85 }}
        />
      ))}

      {controls.map((c) => {
        const touch = touchByControl.get(c.sequence);
        const selected = selectedSequence === c.sequence;
        const allHit = touch && touch.total > 0 && touch.hit === touch.total;
        const noneHit = touch && touch.total > 0 && touch.hit === 0;
        const color = noneHit ? "#b45309" : allHit ? "#15803d" : "#c0392b";
        return (
          <Marker
            key={`${c.sequence}-${c.code}`}
            position={[c.lat, c.lon]}
            icon={controlPinIcon(c.code || "?", selected, color)}
            interactive={false}
          >
            {touch && touch.total > 0 ? (
              <Tooltip permanent direction="right" offset={[10, -8]}>
                <span className="opacity-80">
                  {touch.hit}/{touch.total}
                </span>
              </Tooltip>
            ) : null}
          </Marker>
        );
      })}
    </MapContainer>
      <div className="absolute top-3 right-3 z-[1000] flex rounded-lg border border-forest-200 overflow-hidden bg-white/95 shadow text-xs">
        <button
          type="button"
          className={`px-2.5 py-1.5 ${
            basemap === "osm" ? "bg-forest-100 font-medium" : ""
          }`}
          onClick={() => setBasemap("osm")}
        >
          Map
        </button>
        <button
          type="button"
          className={`px-2.5 py-1.5 ${
            basemap === "satellite" ? "bg-forest-100 font-medium" : ""
          }`}
          onClick={() => setBasemap("satellite")}
        >
          Satellite
        </button>
      </div>
    </div>
  );
}
