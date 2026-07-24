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
import { interpolateAtTime, trackUpToTime } from "@/lib/gpx";
import { findPunchIndex, splitTrackByTimeWindow } from "@/lib/sync";
import {
  deadzoneDesiredCenter,
  expSmooth,
  leadMeters,
  leadPoint,
  panExceedsEpsilon,
} from "@/lib/followCamera";
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

export interface StoryMarker {
  key: string;
  lat: number;
  lon: number;
  kind: "hesitation" | "comeback" | "detour";
  label: string;
  color: string;
  atMs?: number;
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
  /** Active-leg corridor polylines (bold). When set, full tracks are dimmed. */
  legTracks?: TrackLayer[];
  storyMarkers?: StoryMarker[];
  replayMs: number;
  highlightLeg: { fromSeq: number; toSeq: number } | null;
  /** When set, warm-up/cool-down outside this window are drawn dim. */
  raceWindow?: { min: number; max: number } | null;
  /**
   * Only draw each track up to the playhead (trail appears as runners move).
   * Avatars still show at replayMs.
   */
  trailReveal?: boolean;
  /**
   * When set, deadzone camera follows this focus (raw runner pose).
   * Prefer this over focusBounds while following a runner.
   */
  followTarget?: {
    lat: number;
    lon: number;
    speedMps?: number;
    bearing?: number;
  } | null;
  /** Playback running — enables ground-speed look-ahead. */
  followPlaying?: boolean;
  resizeToken?: string | number;
  mapOpacity?: number;
  /** Dashed polyline for planned missing-start fill (control legs → first GPS). */
  fillPreview?: { lat: number; lon: number }[] | null;
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
  disabled,
}: {
  bounds: [[number, number], [number, number]] | null | undefined;
  disabled?: boolean;
}) {
  const map = useMap();
  const lastKey = useRef<string>("");
  useEffect(() => {
    if (disabled || !bounds) return;
    const key = bounds.flat().map((n) => n.toFixed(6)).join(",");
    if (key === lastKey.current) return;
    lastKey.current = key;
    map.fitBounds(bounds, {
      padding: [56, 56],
      maxZoom: 16,
      animate: true,
      duration: 0.85,
    });
  }, [map, bounds, disabled]);
  return null;
}

/** Deadzone follow-cam: hold still in-frame; dt-damped pan only at edges. */
function FollowCamera({
  focus,
  active,
  playing = false,
}: {
  focus:
    | {
        lat: number;
        lon: number;
        speedMps?: number;
        bearing?: number;
      }
    | null
    | undefined;
  active: boolean;
  /** When false (scrub/pause), look-ahead is zero. */
  playing?: boolean;
}) {
  const map = useMap();
  const smoothed = useRef<{ lat: number; lon: number } | null>(null);
  const engaged = useRef(false);
  const raf = useRef<number | null>(null);
  const lastTs = useRef<number>(0);
  const latestFocus = useRef(focus);
  const latestPlaying = useRef(playing);

  latestFocus.current = focus;
  latestPlaying.current = playing;

  useEffect(() => {
    if (!active) {
      smoothed.current = null;
      engaged.current = false;
      lastTs.current = 0;
      if (raf.current != null) cancelAnimationFrame(raf.current);
      raf.current = null;
      return;
    }

    const tick = (now: number) => {
      const f = latestFocus.current;
      if (!f || !Number.isFinite(f.lat)) {
        raf.current = requestAnimationFrame(tick);
        return;
      }

      const dt =
        lastTs.current === 0
          ? 1 / 60
          : Math.min(0.1, (now - lastTs.current) / 1000);
      lastTs.current = now;

      const speed = f.speedMps ?? 0;
      const bearing = f.bearing ?? 0;
      const leadM = leadMeters(speed, latestPlaying.current);
      const focusPt = leadPoint(
        { lat: f.lat, lon: f.lon, bearing },
        leadM
      );

      // One-shot snap on engage: center on runner, lock zoom as-is
      if (!engaged.current) {
        map.setView([focusPt.lat, focusPt.lon], map.getZoom(), {
          animate: false,
        });
        smoothed.current = { lat: focusPt.lat, lon: focusPt.lon };
        engaged.current = true;
        raf.current = requestAnimationFrame(tick);
        return;
      }

      const desired = deadzoneDesiredCenter(map, focusPt, 0.55);
      if (!desired) {
        // Inside deadzone — hold camera (no setView → no shake)
        raf.current = requestAnimationFrame(tick);
        return;
      }

      const cur =
        smoothed.current ??
        ({ lat: map.getCenter().lat, lon: map.getCenter().lng } as const);
      const next = expSmooth(cur, desired, dt, 0.32);
      smoothed.current = next;

      if (panExceedsEpsilon(map, cur, next, 0.5)) {
        map.setView([next.lat, next.lon], map.getZoom(), { animate: false });
      }

      raf.current = requestAnimationFrame(tick);
    };

    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current != null) cancelAnimationFrame(raf.current);
      raf.current = null;
      lastTs.current = 0;
    };
  }, [active, map]);

  return null;
}

const PUNCH_FX_MS = 2_400;

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

const STORY_COLORS = {
  hesitation: "#d97706",
  comeback: "#7c3aed",
  detour: "#6d28d9",
} as const;

export default function SessionMap({
  bounds,
  focusBounds,
  mapUrl,
  mapAffine,
  mapWidth,
  mapHeight,
  controls,
  tracks,
  legTracks = [],
  storyMarkers = [],
  replayMs,
  highlightLeg,
  raceWindow = null,
  trailReveal = false,
  followTarget = null,
  followPlaying = false,
  resizeToken,
  mapOpacity = 0.55,
  fillPreview = null,
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
  const dimRace = !!highlightLeg && legTracks.length > 0;
  const useRaceSplit = !!raceWindow;
  const following = !!(followTarget && Number.isFinite(followTarget.lat));

  /** Recent control punches for ripple FX (age 0 = just punched). */
  const punchFx = useMemo(() => {
    const geo = controls.filter((c) => c.lat != null && c.lon != null);
    if (geo.length === 0 || tracks.length === 0) return [];
    const out: {
      key: string;
      lat: number;
      lon: number;
      color: string;
      code: string;
      progress: number;
    }[] = [];

    for (const t of tracks) {
      if (t.points.length < 2) continue;
      let searchFrom = 0;
      for (const c of geo) {
        const idx = findPunchIndex(
          t.points,
          { lat: c.lat!, lon: c.lon! },
          searchFrom
        );
        if (idx < 0) continue;
        searchFrom = idx + 1;
        const punchTime = t.points[idx].time;
        const age = replayMs - punchTime;
        if (age < 0 || age > PUNCH_FX_MS) continue;
        out.push({
          key: `fx-${t.id}-${c.id}-${punchTime}`,
          lat: c.lat!,
          lon: c.lon!,
          color: t.color,
          code: c.code,
          progress: age / PUNCH_FX_MS,
        });
      }
    }
    return out;
  }, [tracks, controls, replayMs]);

  const hotControlIds = useMemo(() => {
    const s = new Set<string>();
    for (const fx of punchFx) {
      if (fx.progress < 0.55) {
        const c = controls.find((x) => x.code === fx.code);
        if (c) s.add(c.id);
      }
    }
    return s;
  }, [punchFx, controls]);

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
      <FocusBounds bounds={focusBounds} disabled={following} />
      <FollowCamera
        focus={followTarget}
        active={following}
        playing={followPlaying}
      />
      <InvalidateSize token={resizeToken} />

      {hasMap && mapUrl && corners && (
        <RotatedImageOverlay
          url={mapUrl}
          topLeft={corners.topLeft}
          topRight={corners.topRight}
          bottomLeft={corners.bottomLeft}
          opacity={mapOpacity}
        />
      )}

      {controls
        .filter((c) => c.lat != null && c.lon != null)
        .map((c) => {
          const hot = hotControlIds.has(c.id);
          return (
            <CircleMarker
              key={c.id}
              center={[c.lat!, c.lon!]}
              radius={hot ? 14 : 10}
              pathOptions={{
                color: hot ? "#e11d48" : "#c0392b",
                fillColor: hot ? "#fecdd3" : "#fff",
                fillOpacity: hot ? 1 : 0.9,
                weight: hot ? 3 : 2,
              }}
            >
              <Tooltip permanent direction="center">
                {c.code}
              </Tooltip>
            </CircleMarker>
          );
        })}

      {/* Expanding rings when a runner punches */}
      {punchFx.map((fx) => {
        const ease = 1 - Math.pow(1 - fx.progress, 2);
        const radius = 10 + ease * 28;
        const opacity = Math.max(0, 0.85 * (1 - fx.progress));
        return (
          <CircleMarker
            key={fx.key}
            center={[fx.lat, fx.lon]}
            radius={radius}
            pathOptions={{
              color: fx.color,
              fillColor: fx.color,
              fillOpacity: opacity * 0.25,
              opacity,
              weight: 2.5,
            }}
          />
        );
      })}
      {/* Full tracks — with trail reveal, always keep the entire past path visible
          even when a leg is highlighted / follow advances to the next leg. */}
      {tracks.map((t) => {
        const source = trailReveal
          ? trackUpToTime(t.points, replayMs)
          : t.points;
        if (source.length < 2) return null;

        if (useRaceSplit && raceWindow && !trailReveal) {
          const { before, during, after } = splitTrackByTimeWindow(
            source,
            raceWindow
          );
          const raceOpacity = dimRace ? 0.28 : 0.95;
          const raceWeight = dimRace ? 2 : 3;
          const segs: {
            key: string;
            pts: TrackPoint[];
            opacity: number;
            weight: number;
          }[] = [
            { key: "before", pts: before, opacity: 0.14, weight: 2 },
            {
              key: "during",
              pts: during,
              opacity: raceOpacity,
              weight: raceWeight,
            },
            { key: "after", pts: after, opacity: 0.14, weight: 2 },
          ];
          return segs.map((seg) => {
            if (seg.pts.length < 2) return null;
            return (
              <Polyline
                key={`${t.id}-${seg.key}`}
                positions={seg.pts.map(
                  (p) => [p.lat, p.lon] as [number, number]
                )}
                pathOptions={{
                  color: t.color,
                  weight: seg.weight,
                  opacity: seg.opacity,
                }}
              />
            );
          });
        }

        let drawPts = source;
        if (useRaceSplit && raceWindow && trailReveal) {
          drawPts = source.filter(
            (p) => p.time >= raceWindow.min && p.time <= raceWindow.max
          );
          if (drawPts.length < 2) drawPts = source;
        }

        const latlngs = drawPts.map(
          (p) => [p.lat, p.lon] as [number, number]
        );
        if (latlngs.length < 2) return null;
        return (
          <Polyline
            key={`full-${t.id}`}
            positions={latlngs}
            pathOptions={{
              color: t.color,
              // Trail reveal: past stays fully visible; without it, dim under leg highlight
              weight: trailReveal ? 3 : dimRace ? 2 : 3,
              opacity: trailReveal ? 0.9 : dimRace ? 0.28 : 1,
            }}
          />
        );
      })}

      {/* Current leg emphasis on top (optional corridor) */}
      {legTracks.map((t) => {
        const pts = trailReveal ? trackUpToTime(t.points, replayMs) : t.points;
        if (pts.length < 2) return null;
        const latlngs = pts.map((p) => [p.lat, p.lon] as [number, number]);
        return (
          <Polyline
            key={`leg-${t.id}`}
            positions={latlngs}
            pathOptions={{
              color: t.color,
              weight: 4,
              opacity: 0.95,
            }}
          />
        );
      })}

      {fillPreview && fillPreview.length >= 2 && (
        <Polyline
          positions={fillPreview.map(
            (p) => [p.lat, p.lon] as [number, number]
          )}
          pathOptions={{
            color: "#0f766e",
            weight: 3,
            opacity: 0.85,
            dashArray: "8 6",
          }}
        />
      )}

      {/* Runner avatars at replay time */}
      {tracks.map((t) => {
        const pos = interpolateAtTime(t.points, replayMs);
        if (!pos) return null;
        const icon = runnerAvatarIcon(t.name, t.color);
        return (
          <Marker key={`av-${t.id}`} position={[pos.lat, pos.lon]} icon={icon}>
            <Tooltip direction="top" offset={[0, -16]}>
              {t.name}
            </Tooltip>
          </Marker>
        );
      })}

      {storyMarkers.map((m) => (
        <CircleMarker
          key={m.key}
          center={[m.lat, m.lon]}
          radius={m.kind === "hesitation" ? 7 : 8}
          pathOptions={{
            color: "#fff",
            fillColor: STORY_COLORS[m.kind],
            fillOpacity: 0.9,
            weight: 2,
          }}
        >
          <Tooltip direction="top" offset={[0, -6]}>
            {m.label}
          </Tooltip>
        </CircleMarker>
      ))}
    </MapContainer>
  );
}
