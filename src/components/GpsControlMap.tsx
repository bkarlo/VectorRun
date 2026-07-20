"use client";

import { useEffect, useMemo } from "react";
import {
  CircleMarker,
  MapContainer,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { GeorefPair, TrackPoint } from "@/lib/types";
import { fitAffine, mapToGps } from "@/lib/georef";
import { trackTouchesControl } from "@/lib/sync";
import RotatedImageOverlay from "./RotatedImageOverlay";

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

export default function GpsControlMap({
  controls,
  tracks = [],
  selectedSequence,
  onPlace,
  center = [59.33, 18.065],
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

  return (
    <MapContainer
      center={center}
      zoom={14}
      className="h-full w-full min-h-[420px] cursor-crosshair"
      zoomControl
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        opacity={hasMap ? 0.4 : 1}
      />
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
        return (
          <CircleMarker
            key={`${c.sequence}-${c.code}`}
            center={[c.lat, c.lon]}
            radius={selected ? 14 : 10}
            pathOptions={{
              color: noneHit ? "#b45309" : allHit ? "#15803d" : "#c0392b",
              fillColor: "#fff",
              fillOpacity: 0.95,
              weight: selected ? 3 : 2,
            }}
          >
            <Tooltip permanent direction="top" offset={[0, -8]}>
              <span className="font-semibold">{c.code}</span>
              {touch && touch.total > 0 ? (
                <span className="ml-1 opacity-80">
                  · {touch.hit}/{touch.total}
                </span>
              ) : null}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}
