import { haversineM, pathDistanceM } from "./gpx";
import type { TrackPoint } from "./types";

const JUNCTION_NEAR_M = 5;
const JUNCTION_NEAR_MS = 2000;
const DEFAULT_AVG_SPEED_MPS = 2.5;
const DEFAULT_SAMPLE_HZ = 1;

export interface MergeStats {
  pointCountA: number;
  pointCountB: number;
  pointCountMerged: number;
  junctionGapM: number;
  junctionGapMs: number;
  overlapped: boolean;
}

export interface MergeResult {
  points: TrackPoint[];
  stats: MergeStats;
}

export interface LatLon {
  lat: number;
  lon: number;
}

function isNearDuplicate(a: TrackPoint, b: TrackPoint): boolean {
  const dt = Math.abs(a.time - b.time);
  if (dt <= JUNCTION_NEAR_MS && haversineM(a, b) <= JUNCTION_NEAR_M) {
    return true;
  }
  if (a.time === b.time) return true;
  return false;
}

/** Drop B's first point when it duplicates A's last (splice only). */
function concatAtJunction(a: TrackPoint[], b: TrackPoint[]): TrackPoint[] {
  if (a.length === 0) return [...b];
  if (b.length === 0) return [...a];
  if (isNearDuplicate(a[a.length - 1], b[0])) {
    return [...a, ...b.slice(1)];
  }
  return [...a, ...b];
}

/**
 * Merge two tracks into one continuous point array.
 * Earlier-starting segment comes first; on time overlap, keep the longer run.
 */
export function mergeTrackPoints(
  a: TrackPoint[],
  b: TrackPoint[]
): MergeResult {
  const emptyStats = (points: TrackPoint[]): MergeResult => ({
    points,
    stats: {
      pointCountA: a.length,
      pointCountB: b.length,
      pointCountMerged: points.length,
      junctionGapM: 0,
      junctionGapMs: 0,
      overlapped: false,
    },
  });

  if (a.length === 0) return emptyStats([...b]);
  if (b.length === 0) return emptyStats([...a]);

  const [earlier, later] =
    a[0].time <= b[0].time ? [a, b] : [b, a];

  const earlierEnd = earlier[earlier.length - 1].time;
  const laterStart = later[0].time;
  const laterEnd = later[later.length - 1].time;

  let points: TrackPoint[];
  let junctionGapM = 0;
  let junctionGapMs = 0;
  let overlapped = false;

  if (laterStart >= earlierEnd) {
    junctionGapMs = laterStart - earlierEnd;
    junctionGapM = haversineM(earlier[earlier.length - 1], later[0]);
    points = concatAtJunction(earlier, later);
  } else {
    overlapped = true;
    const durEarlier = earlierEnd - earlier[0].time;
    const durLater = laterEnd - later[0].time;
    const keepEarlierInOverlap = durEarlier >= durLater;

    if (keepEarlierInOverlap) {
      const tail = later.filter((p) => p.time > earlierEnd);
      const junctionFrom = earlier[earlier.length - 1];
      const junctionTo = tail[0] ?? later[later.length - 1];
      junctionGapMs = Math.max(0, junctionTo.time - junctionFrom.time);
      junctionGapM = haversineM(junctionFrom, junctionTo);
      points = concatAtJunction(earlier, tail);
    } else {
      const prefix = earlier.filter((p) => p.time < laterStart);
      const junctionFrom = prefix[prefix.length - 1] ?? earlier[0];
      const junctionTo = later[0];
      junctionGapMs = Math.max(0, junctionTo.time - junctionFrom.time);
      junctionGapM = haversineM(junctionFrom, junctionTo);
      points = concatAtJunction(prefix, later);
    }
  }

  return {
    points,
    stats: {
      pointCountA: a.length,
      pointCountB: b.length,
      pointCountMerged: points.length,
      junctionGapM,
      junctionGapMs,
      overlapped,
    },
  };
}

/** Average ground speed of a track; fallback when too short. */
export function averageSpeedMps(
  points: TrackPoint[],
  fallback = DEFAULT_AVG_SPEED_MPS
): number {
  if (points.length < 2) return fallback;
  const dtSec = (points[points.length - 1].time - points[0].time) / 1000;
  if (dtSec <= 0) return fallback;
  const dist = pathDistanceM(points);
  if (dist <= 0) return fallback;
  const speed = dist / dtSec;
  if (!Number.isFinite(speed) || speed <= 0) return fallback;
  return speed;
}

/** Orienteering pace (min/km) → m/s. */
export function paceMinPerKmToMps(paceMinPerKm: number): number {
  if (!Number.isFinite(paceMinPerKm) || paceMinPerKm <= 0) {
    return DEFAULT_AVG_SPEED_MPS;
  }
  return 1000 / (paceMinPerKm * 60);
}

/** m/s → orienteering pace (min/km). */
export function mpsToPaceMinPerKm(mps: number): number {
  const speed =
    Number.isFinite(mps) && mps > 0 ? mps : DEFAULT_AVG_SPEED_MPS;
  return 1000 / (speed * 60);
}

function lerpEle(
  a: number | null | undefined,
  b: number | null | undefined,
  u: number
): number | null {
  if (a != null && b != null && Number.isFinite(a) && Number.isFinite(b)) {
    return a + (b - a) * u;
  }
  return null;
}

/**
 * Build synthetic prefix points along straight legs ending at firstGps.
 * `waypoints` are intermediate/control points; `speedsMps[i]` is speed from
 * waypoints[i] to waypoints[i+1] (or to firstGps for the last).
 * Timestamps are computed backward from firstGps.time.
 */
export function fillPrefixFromLegs(
  waypoints: LatLon[],
  speedsMps: number[],
  firstGps: TrackPoint,
  sampleHz = DEFAULT_SAMPLE_HZ
): TrackPoint[] {
  if (waypoints.length === 0) {
    throw new Error("At least one waypoint is required");
  }
  if (speedsMps.length !== waypoints.length) {
    throw new Error("speedsMps length must match waypoints length");
  }
  for (const s of speedsMps) {
    if (!Number.isFinite(s) || s <= 0) {
      throw new Error("Each speed must be a positive number");
    }
  }

  const vertices: LatLon[] = [...waypoints, { lat: firstGps.lat, lon: firstGps.lon }];
  const hz = sampleHz > 0 ? sampleHz : DEFAULT_SAMPLE_HZ;
  const stepMs = 1000 / hz;

  // Per-leg distance & duration (ms)
  const legDists: number[] = [];
  const legDursMs: number[] = [];
  for (let i = 0; i < waypoints.length; i++) {
    const dist = haversineM(vertices[i], vertices[i + 1]);
    const speed = speedsMps[i];
    const durMs = dist <= 0 ? 0 : (dist / speed) * 1000;
    legDists.push(dist);
    legDursMs.push(durMs);
  }

  const totalDurMs = legDursMs.reduce((s, d) => s + d, 0);
  let t = firstGps.time - totalDurMs;

  const prefix: TrackPoint[] = [];
  const startEle = firstGps.ele; // only known end elev; start stays null unless both known

  for (let i = 0; i < waypoints.length; i++) {
    const from = vertices[i];
    const to = vertices[i + 1];
    const dist = legDists[i];
    const durMs = legDursMs[i];
    const isLastLeg = i === waypoints.length - 1;

    // Always emit the start of the first leg; subsequent legs start where previous ended
    if (i === 0) {
      prefix.push({
        lat: from.lat,
        lon: from.lon,
        ele: null,
        time: Math.round(t),
      });
    }

    if (durMs <= 0 || dist <= 0) {
      // Zero-length: just advance time (already at `to` spatially via next push)
      t += durMs;
      if (!isLastLeg) {
        prefix.push({
          lat: to.lat,
          lon: to.lon,
          ele: null,
          time: Math.round(t),
        });
      }
      continue;
    }

    const endT = t + durMs;
    // Sample interior points at hz; do not include the leg end if last leg
    // (firstGps is kept from the real track).
    for (let sampleT = t + stepMs; sampleT < endT - 0.5; sampleT += stepMs) {
      const u = (sampleT - t) / durMs;
      prefix.push({
        lat: from.lat + (to.lat - from.lat) * u,
        lon: from.lon + (to.lon - from.lon) * u,
        ele: isLastLeg ? lerpEle(null, startEle, u) : null,
        time: Math.round(sampleT),
      });
    }

    t = endT;
    if (!isLastLeg) {
      prefix.push({
        lat: to.lat,
        lon: to.lon,
        ele: null,
        time: Math.round(t),
      });
    }
  }

  // Ensure last synthetic point is just before firstGps (continuity without dup)
  if (prefix.length > 0) {
    const last = prefix[prefix.length - 1];
    if (last.time >= firstGps.time) {
      last.time = firstGps.time - 1;
    }
  }

  return prefix;
}

/** Prepend filled prefix onto existing track (skips duplicating first GPS). */
export function prependPrefix(
  prefix: TrackPoint[],
  existing: TrackPoint[]
): TrackPoint[] {
  if (existing.length === 0) return [...prefix];
  if (prefix.length === 0) return [...existing];
  // Prefer keeping the real GPS junction point
  if (isNearDuplicate(prefix[prefix.length - 1], existing[0])) {
    return [...prefix.slice(0, -1), ...existing];
  }
  return [...prefix, ...existing];
}

/** Polyline vertices for map preview: waypoints + first GPS. */
export function fillPreviewVertices(
  waypoints: LatLon[],
  firstGps: LatLon
): LatLon[] {
  return [...waypoints, firstGps];
}
