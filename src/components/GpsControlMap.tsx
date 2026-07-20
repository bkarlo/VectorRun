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
import type { TrackPoint } from "@/lib/types";
import { trackTouchesControl } from "@/lib/sync";

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
}: Props) {
  const touchByControl = useMemo(() => {
    const map = new Map<number, { hit: number; total: number; runners: { name: string; color: string; hit: boolean }[] }>();
    for (const c of controls) {
      const runners = tracks.map((t) => ({
        name: t.name,
        color: t.color,
        hit: trackTouchesControl(t.points, c),
      }));
      map.set(c.sequence, {
        hit: runners.filter((r) => r.hit).length,
        total: runners.length,
        runners,
      });
    }
    return map;
  }, [controls, tracks]);

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
      />
      <ClickHandler onPlace={onPlace} />
      <FitView controls={controls} tracks={tracks} />

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
