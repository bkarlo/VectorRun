import { haversineM, interpolateAtTime } from "./gpx";
import type { ControlRow, SyncStrategy, TrackPoint } from "./types";

export const PUNCH_RADIUS_M = 25;

export function findPunchIndex(
  points: TrackPoint[],
  control: { lat: number; lon: number },
  fromIndex = 0,
  radiusM = PUNCH_RADIUS_M
): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = fromIndex; i < points.length; i++) {
    const d = haversineM(points[i], control);
    if (d <= radiusM && d < bestDist) {
      best = i;
      bestDist = d;
      if (i > fromIndex + 5 && d > bestDist + 5) break;
    }
    if (best >= 0 && d > radiusM) break;
  }
  if (best >= 0) return best;

  for (let i = fromIndex; i < points.length; i++) {
    const d = haversineM(points[i], control);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return bestDist <= 80 ? best : -1;
}

/** Whether a track comes within punch radius of a control (any point). */
export function trackTouchesControl(
  points: TrackPoint[],
  control: { lat: number; lon: number },
  radiusM = PUNCH_RADIUS_M
): boolean {
  return findPunchIndex(points, control, 0, radiusM) >= 0;
}

export function recordingStartAbs(points: TrackPoint[]): number {
  return points.length ? points[0].time : 0;
}

/** Absolute timestamp when sustained movement begins. */
export function motionStartAbs(points: TrackPoint[]): number {
  if (points.length < 3) return recordingStartAbs(points);
  const SPEED_MPS = 1.2;
  const NEED = 3;
  let streak = 0;
  for (let i = 1; i < points.length; i++) {
    const dt = (points[i].time - points[i - 1].time) / 1000;
    if (dt <= 0 || dt > 30) {
      streak = 0;
      continue;
    }
    const speed = haversineM(points[i - 1], points[i]) / dt;
    if (speed >= SPEED_MPS) {
      streak += 1;
      if (streak >= NEED) return points[i - NEED + 1].time;
    } else {
      streak = 0;
    }
  }
  return recordingStartAbs(points);
}

function controlPunchAbs(
  points: TrackPoint[],
  controls: ControlRow[],
  kind: "start_punch" | "first_control"
): number | null {
  const geo = controls
    .filter((c) => c.lat != null && c.lon != null)
    .sort((a, b) => a.sequence - b.sequence);
  if (geo.length === 0) return null;

  const target =
    kind === "start_punch"
      ? geo[0]
      : (geo.find((c) => c.sequence === 1) ?? geo[1] ?? geo[0]);
  if (!target || target.lat == null || target.lon == null) return null;
  const idx = findPunchIndex(points, { lat: target.lat, lon: target.lon });
  return idx >= 0 ? points[idx].time : null;
}

function relativeTrack(points: TrackPoint[]): TrackPoint[] {
  if (points.length === 0) return [];
  const t0 = points[0].time;
  return points.map((p) => ({ ...p, time: p.time - t0 }));
}

function trackDuration(points: TrackPoint[]): number {
  if (points.length < 2) return 0;
  return points[points.length - 1].time - points[0].time;
}

function overlapScore(
  refRel: TrackPoint[],
  otherRel: TrackPoint[],
  shiftMs: number,
  sampleMs = 2000
): number {
  const refDur = trackDuration(refRel);
  const otherDur = trackDuration(otherRel);
  const start = Math.max(0, shiftMs);
  const end = Math.min(refDur, shiftMs + otherDur);
  const span = end - start;
  if (span < 15_000) return Number.POSITIVE_INFINITY;

  let sum = 0;
  let n = 0;
  for (let t = start; t <= end; t += sampleMs) {
    const a = interpolateAtTime(refRel, t);
    const b = interpolateAtTime(otherRel, t - shiftMs);
    if (!a || !b) continue;
    sum += haversineM(a, b);
    n += 1;
  }
  if (n < 5) return Number.POSITIVE_INFINITY;
  return sum / n - Math.min(span, 300_000) / 1_000_000;
}

export function findTrackMatchShift(
  refPoints: TrackPoint[],
  otherPoints: TrackPoint[]
): number {
  const refRel = relativeTrack(refPoints);
  const otherRel = relativeTrack(otherPoints);
  const refDur = trackDuration(refRel);
  const otherDur = trackDuration(otherRel);
  if (refDur < 10_000 || otherDur < 10_000) return 0;

  let bestS = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  const coarse = 5000;
  const minS = -otherDur + 20_000;
  const maxS = refDur - 20_000;
  for (let s = minS; s <= maxS; s += coarse) {
    const score = overlapScore(refRel, otherRel, s, 3000);
    if (score < bestScore) {
      bestScore = score;
      bestS = s;
    }
  }
  for (let s = bestS - coarse; s <= bestS + coarse; s += 500) {
    const score = overlapScore(refRel, otherRel, s, 2000);
    if (score < bestScore) {
      bestScore = score;
      bestS = s;
    }
  }
  return bestS;
}

export interface SyncRunnerInput {
  id: string;
  points: TrackPoint[];
  /** Sync strategy for non-reference runners */
  strategy: SyncStrategy;
  /** For manual: delta ms = offset_other - offset_ref */
  manualDeltaMs?: number;
}

export interface ReferenceSyncResult {
  offsets: Record<string, number>;
  /** Delta of each runner's timeline start vs reference (ms). Reference = 0. */
  deltasMs: Record<string, number>;
  referenceId: string | null;
  /** Wall-clock time of reference's first GPS point */
  referenceWallTimeMs: number | null;
}

/**
 * Anchor the shared timeline on the reference runner (first GPS → t=0).
 * Each other runner is aligned to the reference using their own strategy.
 *
 * deltasMs = offset_other - offset_ref
 * (relative remapping of the two watches onto the shared timeline).
 * For Record sync this equals firstGPS_ref - firstGPS_other
 * e.g. ref 9:55 / other 10:05 → −10 minutes.
 */
export function computeReferenceSync(
  referenceId: string | null,
  runners: SyncRunnerInput[],
  controls: ControlRow[]
): ReferenceSyncResult {
  const offsets: Record<string, number> = {};
  const deltasMs: Record<string, number> = {};
  const withPoints = runners.filter((r) => r.points.length > 0);

  if (withPoints.length === 0) {
    return {
      offsets,
      deltasMs,
      referenceId: null,
      referenceWallTimeMs: null,
    };
  }

  const ref =
    (referenceId && withPoints.find((r) => r.id === referenceId)) ||
    withPoints[0];

  const refOffset = -ref.points[0].time;
  offsets[ref.id] = refOffset;
  deltasMs[ref.id] = 0;
  const refWall = ref.points[0].time;

  for (const r of withPoints) {
    if (r.id === ref.id) continue;

    if (r.strategy === "manual") {
      const raw = r.manualDeltaMs ?? 0;
      const delta = Math.abs(raw) > 86_400_000 ? 0 : raw;
      // offset_other = offset_ref + delta
      offsets[r.id] = refOffset + delta;
      deltasMs[r.id] = delta;
      continue;
    }

    const offset = offsetForStrategy(ref, r, refOffset, controls);
    offsets[r.id] = offset;
    deltasMs[r.id] = offset - refOffset;
  }

  for (const r of runners) {
    if (offsets[r.id] === undefined) {
      offsets[r.id] = 0;
      deltasMs[r.id] = 0;
    }
  }

  return {
    offsets,
    deltasMs,
    referenceId: ref.id,
    referenceWallTimeMs: refWall,
  };
}

function offsetForStrategy(
  ref: SyncRunnerInput,
  other: SyncRunnerInput,
  refOffset: number,
  controls: ControlRow[]
): number {
  const strategy = other.strategy;

  if (strategy === "manual") {
    const delta = other.manualDeltaMs ?? 0;
    const shift = Math.abs(delta) > 86_400_000 ? 0 : delta;
    return refOffset + shift;
  }

  if (strategy === "recording_start") {
    // Align first GPS points → both at t=0
    return -other.points[0].time;
  }

  if (strategy === "motion_start") {
    const refAbs = motionStartAbs(ref.points);
    const otherAbs = motionStartAbs(other.points);
    return refAbs + refOffset - otherAbs;
  }

  if (strategy === "track_match") {
    const shift = findTrackMatchShift(ref.points, other.points);
    return -other.points[0].time + shift;
  }

  if (strategy === "start_punch" || strategy === "first_control") {
    const refPunch = controlPunchAbs(ref.points, controls, strategy);
    const otherPunch = controlPunchAbs(other.points, controls, strategy);
    if (refPunch != null && otherPunch != null) {
      return refPunch + refOffset - otherPunch;
    }
    // Fall back to motion start when punches missing
    const refAbs = motionStartAbs(ref.points);
    const otherAbs = motionStartAbs(other.points);
    return refAbs + refOffset - otherAbs;
  }

  if (strategy === "best_fit") {
    // Align on first control if possible, else track match
    const refPunch = controlPunchAbs(ref.points, controls, "first_control");
    const otherPunch = controlPunchAbs(other.points, controls, "first_control");
    if (refPunch != null && otherPunch != null) {
      return refPunch + refOffset - otherPunch;
    }
    const shift = findTrackMatchShift(ref.points, other.points);
    return -other.points[0].time + shift;
  }

  return -other.points[0].time;
}

export function applyOffset(
  points: TrackPoint[],
  offsetMs: number
): TrackPoint[] {
  return points.map((p) => ({ ...p, time: p.time + offsetMs }));
}

export function defaultSyncStrategy(hasGeoControls: boolean): SyncStrategy {
  return hasGeoControls ? "first_control" : "motion_start";
}
