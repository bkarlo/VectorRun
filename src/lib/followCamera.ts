import type { Map as LeafletMap } from "leaflet";
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

/** Pose at replay time only if t is inside the track's time span (no clamp). */
export function positionInTrackRange(
  points: TrackPoint[],
  replayMs: number
): { lat: number; lon: number } | null {
  if (points.length === 0) return null;
  if (replayMs < points[0].time || replayMs > points[points.length - 1].time) {
    return null;
  }
  const pos = interpolateAtTime(points, replayMs);
  if (!pos) return null;
  return { lat: pos.lat, lon: pos.lon };
}

/** Centroid + mean motion of several runners (peloton follow). */
export function pelotonPose(
  tracks: TrackPoint[][],
  replayMs: number
): RunnerPose | null {
  const poses: RunnerPose[] = [];
  for (const pts of tracks) {
    if (
      pts.length === 0 ||
      replayMs < pts[0].time ||
      replayMs > pts[pts.length - 1].time
    ) {
      continue;
    }
    const p = runnerPose(pts, replayMs);
    if (p) poses.push(p);
  }
  if (poses.length === 0) return null;
  if (poses.length === 1) return poses[0];

  let lat = 0;
  let lon = 0;
  let speed = 0;
  let sinB = 0;
  let cosB = 0;
  for (const p of poses) {
    lat += p.lat;
    lon += p.lon;
    speed += p.speedMps;
    sinB += Math.sin(p.bearing);
    cosB += Math.cos(p.bearing);
  }
  const n = poses.length;
  return {
    lat: lat / n,
    lon: lon / n,
    speedMps: speed / n,
    bearing: Math.atan2(sinB, cosB),
  };
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

export type DeadzoneOpts = {
  /** Fraction of map size for the comfort box (default 0.55). */
  deadzoneFrac?: number;
  /** Travel bearing (rad from north). When set with enough speed, bias framing forward. */
  bearing?: number;
  speedMps?: number;
  /**
   * Place the comfort box so the runner sits ~1/3 from the rear of the
   * frame along travel (2/3 of the view looks forward). Soft — still a deadzone.
   */
  preferForward?: boolean;
};

/**
 * If focus is outside the comfort deadzone, return the map center that
 * pulls focus just inside the box (minimum pan). Null = already framed.
 */
export function deadzoneDesiredCenter(
  map: LeafletMap,
  focus: { lat: number; lon: number },
  opts: DeadzoneOpts | number = 0.55
): { lat: number; lon: number } | null {
  const o: DeadzoneOpts =
    typeof opts === "number" ? { deadzoneFrac: opts } : opts;
  const deadzoneFrac = o.deadzoneFrac ?? 0.55;

  const size = map.getSize();
  if (size.x < 40 || size.y < 40) return null;

  const pt = map.latLngToContainerPoint([focus.lat, focus.lon]);
  const halfW = (size.x * deadzoneFrac) / 2;
  const halfH = (size.y * deadzoneFrac) / 2;

  // Default: box centered on map. With travel direction: shift box so ideal
  // runner position is ~1/3 from the back of the frame (more map ahead).
  let cx = size.x / 2;
  let cy = size.y / 2;
  if (
    o.preferForward !== false &&
    o.bearing != null &&
    (o.speedMps ?? 0) >= 0.4
  ) {
    const ahead = leadPoint(
      { lat: focus.lat, lon: focus.lon, bearing: o.bearing },
      40
    );
    const p1 = map.latLngToContainerPoint([ahead.lat, ahead.lon]);
    let fx = p1.x - pt.x;
    let fy = p1.y - pt.y;
    const len = Math.hypot(fx, fy);
    if (len > 1e-3) {
      fx /= len;
      fy /= len;
      // Ideal runner pixel: center shifted *against* forward (toward rear)
      // by ~16% of min dimension → roughly first third along travel axis.
      const shift = Math.min(size.x, size.y) * 0.16;
      const idealX = size.x / 2 - fx * shift;
      const idealY = size.y / 2 - fy * shift;
      // Comfort box centered on that ideal (not map center)
      cx = idealX;
      cy = idealY;
    }
  }

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

  const center = map.getCenter();
  const centerPt = map.latLngToContainerPoint(center);
  const desired = map.containerPointToLatLng([
    centerPt.x + dx,
    centerPt.y + dy,
  ]);
  return { lat: desired.lat, lon: desired.lng };
}

/** Map center that places focus at the forward-biased ideal (engage snap). */
export function forwardBiasSnapCenter(
  map: LeafletMap,
  focus: { lat: number; lon: number },
  bearing: number,
  speedMps: number
): { lat: number; lon: number } {
  if (speedMps < 0.4) return focus;
  const size = map.getSize();
  const pt = map.latLngToContainerPoint([focus.lat, focus.lon]);
  const ahead = leadPoint({ ...focus, bearing }, 40);
  const p1 = map.latLngToContainerPoint([ahead.lat, ahead.lon]);
  let fx = p1.x - pt.x;
  let fy = p1.y - pt.y;
  const len = Math.hypot(fx, fy);
  if (len < 1e-3) return focus;
  fx /= len;
  fy /= len;
  const shift = Math.min(size.x, size.y) * 0.16;
  // Want focus at (cx - fx*shift, cy - fy*shift). Pan so current focus moves there.
  const idealX = size.x / 2 - fx * shift;
  const idealY = size.y / 2 - fy * shift;
  const dx = pt.x - idealX;
  const dy = pt.y - idealY;
  const center = map.getCenter();
  const centerPt = map.latLngToContainerPoint(center);
  const desired = map.containerPointToLatLng([
    centerPt.x + dx,
    centerPt.y + dy,
  ]);
  return { lat: desired.lat, lon: desired.lng };
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
  map: LeafletMap,
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
