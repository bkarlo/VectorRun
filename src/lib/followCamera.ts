import type L from "leaflet";
import { haversineM, interpolateAtTime } from "./gpx";
import type { TrackPoint } from "./types";

const EARTH_R = 6_371_000;

export type RunnerPose = {
  lat: number;
  lon: number;
  /** Ground speed m/s from short finite difference along the track. */
  speedMps: number;
  /** Bearing radians clockwise from north; 0 if unknown. */
  bearing: number;
};

/** Pose at replay time + local speed/bearing from nearby samples. */
export function runnerPose(
  points: TrackPoint[],
  replayMs: number
): RunnerPose | null {
  const pos = interpolateAtTime(points, replayMs);
  if (!pos) return null;

  const dtLook = 1_500; // ms of track time for velocity estimate
  const a = interpolateAtTime(points, replayMs - dtLook / 2);
  const b = interpolateAtTime(points, replayMs + dtLook / 2);
  if (!a || !b || b.time <= a.time) {
    return { lat: pos.lat, lon: pos.lon, speedMps: 0, bearing: 0 };
  }

  const dist = haversineM(a, b);
  const speedMps = dist / ((b.time - a.time) / 1000);
  const bearing = bearingRad(a.lat, a.lon, b.lat, b.lon);
  return { lat: pos.lat, lon: pos.lon, speedMps, bearing };
}

/** Lead point along bearing by leadM meters. */
export function leadPoint(
  pose: { lat: number; lon: number; bearing: number },
  leadM: number
): { lat: number; lon: number } {
  if (leadM <= 0.5) return { lat: pose.lat, lon: pose.lon };
  const lat1 = (pose.lat * Math.PI) / 180;
  const lon1 = (pose.lon * Math.PI) / 180;
  const ang = leadM / EARTH_R;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(ang) +
      Math.cos(lat1) * Math.sin(ang) * Math.cos(pose.bearing)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(pose.bearing) * Math.sin(ang) * Math.cos(lat1),
      Math.cos(ang) - Math.sin(lat1) * Math.sin(lat2)
    );
  return { lat: (lat2 * 180) / Math.PI, lon: (lon2 * 180) / Math.PI };
}

/** Ground-speed look-ahead distance (meters). */
export function leadMeters(speedMps: number, playing: boolean): number {
  if (!playing || speedMps < 0.3) return 0;
  return Math.min(40, Math.max(0, speedMps * 2.5));
}

/**
 * If focus is outside the center deadzone, return the map center that
 * pulls focus just inside the box (minimum pan). Null = already framed.
 */
export function deadzoneDesiredCenter(
  map: L.Map,
  focus: { lat: number; lon: number },
  deadzoneFrac = 0.55
): { lat: number; lon: number } | null {
  const size = map.getSize();
  if (size.x < 40 || size.y < 40) return null;

  const pt = map.latLngToContainerPoint([focus.lat, focus.lon]);
  const halfW = (size.x * deadzoneFrac) / 2;
  const halfH = (size.y * deadzoneFrac) / 2;
  const cx = size.x / 2;
  const cy = size.y / 2;

  const left = cx - halfW;
  const right = cx + halfW;
  const top = cy - halfH;
  const bottom = cy + halfH;

  let dx = 0;
  let dy = 0;
  if (pt.x < left) dx = pt.x - left;
  else if (pt.x > right) dx = pt.x - right;
  if (pt.y < top) dy = pt.y - top;
  else if (pt.y > bottom) dy = pt.y - bottom;

  if (dx === 0 && dy === 0) return null;

  // Pan map so focus moves by (-dx, -dy) in container space
  const center = map.getCenter();
  const centerPt = map.latLngToContainerPoint(center);
  const desiredPt = LPoint(centerPt.x + dx, centerPt.y + dy);
  const desired = map.containerPointToLatLng(desiredPt);
  return { lat: desired.lat, lon: desired.lng };
}

function LPoint(x: number, y: number): L.Point {
  // Avoid importing Point constructor issues — use map's point via leaflet global shape
  return { x, y } as L.Point;
}

/** Exponential ease toward desired; tauSeconds is time to ~63% of the gap. */
export function expSmooth(
  current: { lat: number; lon: number },
  desired: { lat: number; lon: number },
  dtSec: number,
  tauSeconds = 0.35
): { lat: number; lon: number } {
  const dt = Math.max(0, Math.min(dtSec, 0.1));
  const alpha = 1 - Math.exp(-dt / Math.max(0.05, tauSeconds));
  return {
    lat: current.lat + (desired.lat - current.lat) * alpha,
    lon: current.lon + (desired.lon - current.lon) * alpha,
  };
}

/** True if pan is large enough to bother Leaflet (~0.5 px). */
export function panExceedsEpsilon(
  map: L.Map,
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  epsilonPx = 0.5
): boolean {
  const a = map.latLngToContainerPoint([from.lat, from.lon]);
  const b = map.latLngToContainerPoint([to.lat, to.lon]);
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy > epsilonPx * epsilonPx;
}

function bearingRad(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δλ = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x =
    Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return Math.atan2(y, x);
}
