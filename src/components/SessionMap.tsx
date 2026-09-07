"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  CircleMarker,
  MapContainer,
  Marker,
  Polyline,
  Tooltip,
  useMap,
  useMapEvents,
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
  forwardBiasSnapCenter,
  leadMeters,
  leadPoint,
  panExceedsEpsilon,
} from "@/lib/followCamera";
import RotatedImageOverlay from "./RotatedImageOverlay";
import BasemapTiles, { type BasemapKind } from "./BasemapTiles";

/** ~5–6 mm on a 1:10k map ≈ 50–60 m on the ground (scaled −30%). */
const CONTROL_RADIUS_M = 31.5;
const CONTROL_COLOR = "#AB5DD9";
const CONTROL_HOT = "#c084fc";

function metersPerPixel(lat: number, zoom: number): number {
  return (
    (40075016.686 * Math.abs(Math.cos((lat * Math.PI) / 180))) /
    Math.pow(2, zoom + 8)
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Orienteering-style control: circle + code beside it; size tracks map scale. */
function controlSymbolIcon(
  code: string,
  radiusPx: number,
  hot: boolean
): L.DivIcon {
  const r = Math.max(3, radiusPx);
  const stroke = Math.max(1.25, Math.min(3.2, r * 0.16));
  const font = Math.max(8, Math.min(17, r * 0.9));
  const gap = Math.max(3, r * 0.22);
  const labelW = Math.ceil(font * Math.max(1.1, code.length * 0.62));
  const w = Math.ceil(r * 2 + gap + labelW + 6);
  const h = Math.ceil(Math.max(r * 2, font * 1.35) + 4);
  const cx = r + stroke;
  const cy = h / 2;
  const ring = hot ? CONTROL_HOT : CONTROL_COLOR;
  const fill = hot ? "rgba(192, 132, 252, 0.45)" : "rgba(255,255,255,0.12)";
  const label = escapeHtml(code);

  return L.divIcon({
    className: "o-control-symbol",
    iconSize: [w, h],
    iconAnchor: [cx, cy],
    html: `<div style="position:relative;width:${w}px;height:${h}px;pointer-events:none">
      <div style="
        position:absolute;left:${cx - r}px;top:${cy - r}px;
        width:${r * 2}px;height:${r * 2}px;border-radius:50%;
        border:${stroke}px solid ${ring};
        background:${fill};
        box-sizing:border-box;
      "></div>
      <div style="
        position:absolute;left:${cx + r + gap}px;top:50%;
        transform:translateY(-50%);
        font:${hot ? 700 : 600} ${font}px/1.1 ui-sans-serif, system-ui, sans-serif;
        color:${ring};
        text-shadow:
          0 0 2px #fff,
          0 0 3px #fff,
          1px 0 0 #fff,
          -1px 0 0 #fff,
          0 1px 0 #fff,
          0 -1px 0 #fff;
        white-space:nowrap;
        letter-spacing:-0.02em;
      ">${label}</div>
    </div>`,
  });
}

function useMapZoom(): number {
  const map = useMap();
  const [zoom, setZoom] = useState(() => map.getZoom());
  useMapEvents({
    zoom() {
      setZoom(map.getZoom());
    },
    zoomend() {
      setZoom(map.getZoom());
    },
  });
  return zoom;
}

function ControlSymbols({
  controls,
  hotIds,
  scale = 0.7,
}: {
  controls: ControlRow[];
  hotIds: Set<string>;
  scale?: number;
}) {
  const map = useMap();
  const zoom = useMapZoom();
  const [paneReady, setPaneReady] = useState(
    () => !!map.getPane("controlSymbolPane")
  );

  useLayoutEffect(() => {
    if (!map.getPane("controlSymbolPane")) {
      map.createPane("controlSymbolPane");
    }
    const pane = map.getPane("controlSymbolPane");
    if (pane) {
      // Above tracks (overlay 400), below runner avatars (marker 600)
      pane.style.zIndex = "450";
      pane.style.pointerEvents = "none";
    }
    setPaneReady(true);
  }, [map]);

  if (!paneReady) return null;

  return (
    <>
      {controls
        .filter((c) => c.lat != null && c.lon != null)
        .map((c) => {
          const mpp = metersPerPixel(c.lat!, zoom);
          // Soft min so symbols stay readable when fully zoomed out
          const radiusPx = Math.max(
            3.5,
            (CONTROL_RADIUS_M * scale) / Math.max(mpp, 1e-6)
          );
          const icon = controlSymbolIcon(
            c.code,
            radiusPx,
            hotIds.has(c.id)
          );
          return (
            <Marker
              key={c.id}
              position={[c.lat!, c.lon!]}
              icon={icon}
              pane="controlSymbolPane"
              interactive={false}
              keyboard={false}
            />
          );
        })}
    </>
  );
}

/** Expanding punch ring scaled like the control circle. */
function PunchRipples({
  items,
  scale = 0.7,
}: {
  items: {
    key: string;
    lat: number;
    lon: number;
    color: string;
    progress: number;
  }[];
  scale?: number;
}) {
  const zoom = useMapZoom();

  return (
    <>
      {items.map((fx) => {
        const ease = 1 - Math.pow(1 - fx.progress, 2);
        const mpp = metersPerPixel(fx.lat, zoom);
        const baseR = Math.max(
          3.5,
          (CONTROL_RADIUS_M * scale) / Math.max(mpp, 1e-6)
        );
        const radius = baseR + ease * baseR * 2.4;
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
              weight: Math.max(1.5, Math.min(3, baseR * 0.12)),
            }}
          />
        );
      })}
    </>
  );
}

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
   * When set, deadzone camera follows this focus (raw runner / peloton pose).
   * Prefer this over focusBounds while following.
   */
  followTarget?: {
    lat: number;
    lon: number;
    speedMps?: number;
    bearing?: number;
  } | null;
  /** True when following the pack centroid (All) — looser deadzone. */
  followPack?: boolean;
  /** Playback running — enables ground-speed look-ahead. */
  followPlaying?: boolean;
  resizeToken?: string | number;
  mapOpacity?: number;
  /** Dashed polyline for planned missing-start fill (control legs → first GPS). */
  fillPreview?: { lat: number; lon: number }[] | null;
  showBasemap?: boolean;
  showControlSymbols?: boolean;
  controlSymbolScale?: number;
  punchRadiusM?: number;
  /** When set, clicking the map reports lat/lon (punch override). */
  onTrackClick?: (lat: number, lon: number) => void;
}

function MapClickNotify({
  onClick,
}: {
  onClick?: (lat: number, lon: number) => void;
}) {
  useMapEvents({
    click(e) {
      onClick?.(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
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

/** Deadzone follow-cam: hold still in-frame; dt-damped pan only at edges.
 *  Pack mode uses the same logic on the peloton centroid (looser deadzone).
 */
function FollowCamera({
  focus,
  active,
  playing = false,
  pack = false,
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
  /** Follow pack centroid with a slightly larger comfort box. */
  pack?: boolean;
}) {
  const map = useMap();
  const smoothed = useRef<{ lat: number; lon: number } | null>(null);
  const engaged = useRef(false);
  const raf = useRef<number | null>(null);
  const lastTs = useRef<number>(0);
  const latestFocus = useRef(focus);
  const latestPlaying = useRef(playing);
  const latestPack = useRef(pack);
  /** Rising edge of follow+play → re-snap and nudge zoom in. */
  const followPlayLatched = useRef(false);
  const bumpZoomOnEngage = useRef(false);
  const zoomAnimating = useRef(false);

  latestFocus.current = focus;
  latestPlaying.current = playing;
  latestPack.current = pack;

  // On Play (while following), zoom in a notch so the deadzone cam feels right
  useEffect(() => {
    if (active && playing) {
      if (!followPlayLatched.current) {
        followPlayLatched.current = true;
        engaged.current = false;
        bumpZoomOnEngage.current = true;
      }
    } else {
      followPlayLatched.current = false;
    }
  }, [active, playing]);

  // Pack ↔ single: re-snap with the right framing
  const prevPack = useRef(pack);
  useEffect(() => {
    if (prevPack.current === pack) return;
    prevPack.current = pack;
    if (!active) return;
    engaged.current = false;
    bumpZoomOnEngage.current = playing;
  }, [pack, active, playing]);

  useEffect(() => {
    if (!active) {
      smoothed.current = null;
      engaged.current = false;
      lastTs.current = 0;
      bumpZoomOnEngage.current = false;
      zoomAnimating.current = false;
      if (raf.current != null) cancelAnimationFrame(raf.current);
      raf.current = null;
      return;
    }

    const onZoomEnd = () => {
      zoomAnimating.current = false;
    };
    map.on("zoomend", onZoomEnd);

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

      const isPack = latestPack.current;
      const speed = f.speedMps ?? 0;
      const bearing = f.bearing ?? 0;
      const leadM = leadMeters(speed, latestPlaying.current);
      const focusPt = leadPoint(
        { lat: f.lat, lon: f.lon, bearing },
        leadM
      );
      const deadzoneOpts = {
        // Pack: larger comfort box so the group breathes without constant pan
        deadzoneFrac: isPack ? 0.68 : 0.55,
        bearing,
        speedMps: speed,
        preferForward: true,
      };

      // One-shot snap on engage: runner/pack toward rear third, look ahead
      if (!engaged.current) {
        const snap = forwardBiasSnapCenter(map, focusPt, bearing, speed);
        const fromZoom = map.getZoom();
        let zoom = fromZoom;
        if (bumpZoomOnEngage.current) {
          bumpZoomOnEngage.current = false;
          // Pack a bit wider than solo so more of the group is visible
          const COMFORT = isPack ? 15.5 : 16.5;
          if (zoom < COMFORT - 0.05) {
            zoom = Math.min(COMFORT, zoom + 1.35);
          }
        }
        const animating = zoom > fromZoom + 0.05;
        if (animating) zoomAnimating.current = true;
        map.setView([snap.lat, snap.lon], zoom, {
          animate: animating,
          duration: 0.55,
        });
        smoothed.current = { lat: snap.lat, lon: snap.lon };
        engaged.current = true;
        raf.current = requestAnimationFrame(tick);
        return;
      }

      // Don't fight Leaflet's play-start zoom animation
      if (zoomAnimating.current) {
        raf.current = requestAnimationFrame(tick);
        return;
      }

      const desired = deadzoneDesiredCenter(map, focusPt, deadzoneOpts);
      if (!desired) {
        raf.current = requestAnimationFrame(tick);
        return;
      }

      const cur =
        smoothed.current ??
        ({ lat: map.getCenter().lat, lon: map.getCenter().lng } as const);
      const next = expSmooth(cur, desired, dt, isPack ? 0.4 : 0.32);
      smoothed.current = next;

      if (panExceedsEpsilon(map, cur, next, 0.5)) {
        map.setView([next.lat, next.lon], map.getZoom(), { animate: false });
      }

      raf.current = requestAnimationFrame(tick);
    };

    raf.current = requestAnimationFrame(tick);
    return () => {
      map.off("zoomend", onZoomEnd);
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
  followPack = false,
  followPlaying = false,
  resizeToken,
  mapOpacity = 0.55,
  fillPreview = null,
  showBasemap = true,
  showControlSymbols = true,
  controlSymbolScale = 0.7,
  punchRadiusM,
  onTrackClick,
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
  const [basemap, setBasemap] = useState<BasemapKind>("osm");

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
          searchFrom,
          punchRadiusM
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
  }, [tracks, controls, replayMs, punchRadiusM]);

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
    <div className="relative h-full w-full">
    <MapContainer
      center={[
        (bounds[0][0] + bounds[1][0]) / 2,
        (bounds[0][1] + bounds[1][1]) / 2,
      ]}
      zoom={14}
      className="h-full w-full"
      zoomControl
    >
      <BasemapTiles
        kind={basemap}
        visible={showBasemap}
        opacity={hasMap ? 0.4 : 1}
      />
      {onTrackClick ? <MapClickNotify onClick={onTrackClick} /> : null}
      <FitBounds bounds={bounds} />
      <FocusBounds bounds={focusBounds} disabled={following} />
      <FollowCamera
        focus={followTarget}
        active={following}
        playing={followPlaying}
        pack={followPack}
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

      {showControlSymbols ? (
        <ControlSymbols
          controls={controls}
          hotIds={hotControlIds}
          scale={controlSymbolScale}
        />
      ) : null}

      {/* Expanding rings when a runner punches */}
      <PunchRipples items={punchFx} scale={controlSymbolScale} />

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
          <Marker key={`av-${t.id}`} position={[pos.lat, pos.lon]} icon={icon} zIndexOffset={800}>
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
      {showBasemap ? (
        <div className="absolute bottom-3 left-3 z-[1000] flex rounded-lg border border-forest-200 overflow-hidden bg-white/95 shadow text-xs">
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
      ) : null}
    </div>
  );
}
