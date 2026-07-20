"use client";

import { useEffect, useMemo, useRef } from "react";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import type { AffineTransform, ControlRow, TrackPoint } from "@/lib/types";
import { mapToGps } from "@/lib/georef";
import { interpolateAtTime } from "@/lib/gpx";
import RotatedImageOverlay from "./RotatedImageOverlay";

function runnerInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function runnerAvatarIcon(name: string, color: string): L.DivIcon {
  const initials = runnerInitials(name)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  const safeColor = color.replace(/[^#a-fA-F0-9(),.\s%]/g, "");
  const size = 32;
  return L.divIcon({
    className: "runner-avatar-icon",
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:#fff;
      border:2.5px solid ${safeColor};
      box-shadow:0 1px 4px rgba(0,0,0,.28), 0 0 0 1px rgba(255,255,255,.6);
      display:flex;align-items:center;justify-content:center;
      font:700 11px/1 ui-sans-serif,system-ui,sans-serif;
      color:${safeColor};
      letter-spacing:-0.02em;
      user-select:none;
    ">${initials}</div>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

interface TrackLayer {
  id: string;
  name: string;
  color: string;
  points: TrackPoint[];
}

interface Props {
  bounds: [[number, number], [number, number]];
  /** When set (e.g. selected leg), fly the map to this region. */
  focusBounds?: [[number, number], [number, number]] | null;
  mapUrl: string | null;
  mapAffine: AffineTransform | null;
  mapWidth: number;
  mapHeight: number;
  controls: ControlRow[];
  tracks: TrackLayer[];
  replayMs: number;
  highlightLeg: { fromSeq: number; toSeq: number } | null;
  resizeToken?: string | number;
}

function FitBounds({
  bounds,
}: {
  bounds: [[number, number], [number, number]];
}) {
  const map = useMap();
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    map.fitBounds(bounds, { padding: [24, 24] });
    done.current = true;
  }, [map, bounds]);
  return null;
}

function FocusBounds({
  bounds,
}: {
  bounds: [[number, number], [number, number]] | null | undefined;
}) {
  const map = useMap();
  useEffect(() => {
    if (!bounds) return;
    map.fitBounds(bounds, { padding: [48, 48], maxZoom: 17, animate: true });
  }, [map, bounds]);
  return null;
}

function InvalidateSize({ token }: { token?: string | number }) {
  const map = useMap();
  useEffect(() => {
    const id = window.setTimeout(() => {
      map.invalidateSize({ animate: false });
    }, 50);
    return () => window.clearTimeout(id);
  }, [map, token]);
  return null;
}

function TrackGroup({
  name,
  color,
  latlngs,
  pos,
  icon,
  emphasize,
}: {
  name: string;
  color: string;
  latlngs: [number, number][];
  pos: TrackPoint | null;
  icon: L.DivIcon;
  emphasize: boolean;
}) {
  return (
    <>
      <Polyline
        positions={latlngs}
        pathOptions={{
          color,
          weight: emphasize ? 3.5 : 3,
          opacity: 1,
        }}
      />
      {pos && (
        <Marker position={[pos.lat, pos.lon]} icon={icon}>
          <Tooltip direction="top" offset={[0, -16]}>
            {name}
          </Tooltip>
        </Marker>
      )}
    </>
  );
}

export default function SessionMap({
  bounds,
  focusBounds,
  mapUrl,
  mapAffine,
  mapWidth,
  mapHeight,
  controls,
  tracks,
  replayMs,
  highlightLeg,
  resizeToken,
}: Props) {
  const corners = useMemo(() => {
    if (!mapAffine || mapWidth <= 0 || mapHeight <= 0) return null;
    const tl = mapToGps(mapAffine, { x: 0, y: 0 });
    const tr = mapToGps(mapAffine, { x: mapWidth, y: 0 });
    const bl = mapToGps(mapAffine, { x: 0, y: mapHeight });
    return {
      topLeft: [tl.lat, tl.lon] as [number, number],
      topRight: [tr.lat, tr.lon] as [number, number],
      bottomLeft: [bl.lat, bl.lon] as [number, number],
    };
  }, [mapAffine, mapWidth, mapHeight]);

  const hasMap = !!(mapUrl && corners);

  return (
    <MapContainer
      center={[
        (bounds[0][0] + bounds[1][0]) / 2,
        (bounds[0][1] + bounds[1][1]) / 2,
      ]}
      zoom={14}
      className="h-full w-full"
      zoomControl
    >
      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        opacity={hasMap ? 0.4 : 1}
      />
      <FitBounds bounds={bounds} />
      <FocusBounds bounds={focusBounds} />
      <InvalidateSize token={resizeToken} />

      {hasMap && mapUrl && corners && (
        <RotatedImageOverlay
          url={mapUrl}
          topLeft={corners.topLeft}
          topRight={corners.topRight}
          bottomLeft={corners.bottomLeft}
          opacity={0.55}
        />
      )}

      {controls
        .filter((c) => c.lat != null && c.lon != null)
        .map((c) => (
          <CircleMarker
            key={c.id}
            center={[c.lat!, c.lon!]}
            radius={10}
            pathOptions={{
              color: "#c0392b",
              fillColor: "#fff",
              fillOpacity: 0.9,
              weight: 2,
            }}
          >
            <Tooltip permanent direction="center">
              {c.code}
            </Tooltip>
          </CircleMarker>
        ))}

      {tracks.map((t) => {
        const latlngs = t.points.map(
          (p) => [p.lat, p.lon] as [number, number]
        );
        const pos = interpolateAtTime(t.points, replayMs);
        const icon = runnerAvatarIcon(t.name, t.color);

        return (
          <TrackGroup
            key={t.id}
            name={t.name}
            color={t.color}
            latlngs={latlngs}
            pos={pos}
            icon={icon}
            emphasize={!!highlightLeg}
          />
        );
      })}
    </MapContainer>
  );
}
