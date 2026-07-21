import { haversineM, pathDistanceM } from "./gpx";
import type {
  ComeBackEvent,
  DetourEvent,
  LegSplit,
  TrackPoint,
  VsBestInfo,
} from "./types";

const COMEBACK_RISE_M = 40;
const EXTRA_DIST_RATIO = 1.15;
const DETOUR_DEV_M = 60;
const DETOUR_MIN_MS = 8_000;
const DETOUR_MIN_PATH_M = 80;
/** Min path meters beyond the fastest runner to keep a solo come-back. */
const COMEBACK_MIN_EXTRA_VS_BEST_M = 40;
/** Min geometric out-and-back to keep a solo come-back. */
const COMEBACK_MIN_EXTRA_M = 80;
/** If turnaround is this close to the fastest path, treat as shared corridor. */
const COMEBACK_NEAR_BEST_M = 50;

export function detectComeBack(
  segment: TrackPoint[],
  toCtrl: { lat: number; lon: number }
): ComeBackEvent | undefined {
  if (segment.length < 5) return undefined;

  const dists = segment.map((p) => haversineM(p, toCtrl));
  let closestSoFar = dists[0];
  let closestIdx = 0;
  let peakIdx = -1;
  let peakDist = -1;
  let peakRise = 0;
  let closestIdxAtPeak = 0;

  for (let i = 1; i < dists.length; i++) {
    const d = dists[i];
    if (d < closestSoFar) {
      closestSoFar = d;
      closestIdx = i;
    }
    const rise = d - closestSoFar;
    if (rise >= COMEBACK_RISE_M && rise >= peakRise) {
      peakRise = rise;
      peakIdx = i;
      peakDist = d;
      closestIdxAtPeak = closestIdx;
    }
  }

  if (peakIdx < 0 || peakRise < COMEBACK_RISE_M) return undefined;

  // Must approach again after the peak (classic wrong-spur then back)
  let returnIdx = -1;
  for (let i = peakIdx + 1; i < dists.length; i++) {
    if (dists[i] <= peakDist - COMEBACK_RISE_M) {
      returnIdx = i;
      break;
    }
  }
  if (returnIdx < 0) return undefined;

  const leaveIdx = closestIdxAtPeak;
  const extraM = Math.max(
    peakRise * 2,
    pathDistanceM(segment.slice(leaveIdx, returnIdx + 1))
  );

  const p = segment[peakIdx];
  return {
    atMs: p.time,
    lat: p.lat,
    lon: p.lon,
    extraM: Math.round(extraM),
  };
}

function distToPolylineM(
  point: { lat: number; lon: number },
  poly: TrackPoint[]
): number {
  let best = Infinity;
  for (const q of poly) {
    const d = haversineM(point, q);
    if (d < best) best = d;
  }
  return best;
}

export function detectDetours(
  segment: TrackPoint[],
  anchorPoly: TrackPoint[]
): DetourEvent[] {
  if (segment.length < 3 || anchorPoly.length < 2) return [];

  // Sample anchor every ~10 m worth of points for speed
  const step = Math.max(1, Math.floor(anchorPoly.length / 80));
  const sampled: TrackPoint[] = [];
  for (let i = 0; i < anchorPoly.length; i += step) {
    sampled.push(anchorPoly[i]);
  }
  if (sampled[sampled.length - 1] !== anchorPoly[anchorPoly.length - 1]) {
    sampled.push(anchorPoly[anchorPoly.length - 1]);
  }

  const deviations = segment.map((p) => distToPolylineM(p, sampled));
  const events: DetourEvent[] = [];

  let i = 0;
  while (i < deviations.length) {
    if (deviations[i] < DETOUR_DEV_M) {
      i += 1;
      continue;
    }
    const startI = i;
    let peakI = i;
    let peakDev = deviations[i];
    while (i + 1 < deviations.length && deviations[i + 1] >= DETOUR_DEV_M) {
      i += 1;
      if (deviations[i] > peakDev) {
        peakDev = deviations[i];
        peakI = i;
      }
    }
    const endI = i;
    const durationMs = segment[endI].time - segment[startI].time;
    const pathM = pathDistanceM(segment.slice(startI, endI + 1));
    if (durationMs >= DETOUR_MIN_MS || pathM >= DETOUR_MIN_PATH_M) {
      const p = segment[peakI];
      events.push({
        startMs: segment[startI].time,
        endMs: segment[endI].time,
        lat: p.lat,
        lon: p.lon,
        maxDeviationM: Math.round(peakDev),
      });
    }
    i += 1;
  }

  return events;
}

function clearComeBacks(splits: LegSplit[]): void {
  for (const s of splits) {
    delete s.comeBack;
  }
}

/**
 * Keep come-back only when it is a peer outlier:
 * - Fastest runner does NOT show the same geometric pattern (else it's the route).
 * - Exactly one runner has a come-back.
 * - That runner paid extra meters vs the fastest path.
 * - Turnaround is not sitting on the fastest corridor.
 */
function rateComeBacks(
  splits: LegSplit[],
  segments: Record<string, TrackPoint[]>
): void {
  const punched = splits.filter(
    (s) => s.punchedFrom && s.punchedTo && s.timeMs != null && s.distanceM != null
  );

  if (punched.length < 2) {
    // No peer rating → don't surface solo geometric "come-backs"
    clearComeBacks(splits);
    return;
  }

  const byTime = [...punched].sort(
    (a, b) => (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity)
  );
  const anchor = byTime[0];
  const anchorSeg = segments[anchor.participantId];

  // Fastest also has the pattern → shared route geometry, nothing to flag
  if (anchor.comeBack) {
    clearComeBacks(splits);
    return;
  }

  const withCb = punched.filter((s) => s.comeBack);
  if (withCb.length !== 1) {
    // 0 or shared among several non-anchor runners → not a unique retour story
    clearComeBacks(splits);
    return;
  }

  const only = withCb[0];
  const cb = only.comeBack!;
  const extraVsBest =
    (only.distanceM ?? 0) - (anchor.distanceM ?? 0);

  if (
    extraVsBest < COMEBACK_MIN_EXTRA_VS_BEST_M &&
    cb.extraM < COMEBACK_MIN_EXTRA_M
  ) {
    clearComeBacks(splits);
    return;
  }

  if (anchorSeg?.length) {
    const nearBest = distToPolylineM(cb, anchorSeg);
    if (nearBest < COMEBACK_NEAR_BEST_M) {
      clearComeBacks(splits);
      return;
    }
  }

  // Keep only this outlier; clear any stray flags
  for (const s of splits) {
    if (s.participantId === only.participantId) {
      s.comeBack = { ...cb, rating: "outlier" };
    } else {
      delete s.comeBack;
    }
  }
}

/**
 * Attach peer-anchored decision signals to punched splits.
 * Mutates `splits` in place. `segments` keyed by participantId.
 */
export function applyDecisionQuality(
  splits: LegSplit[],
  segments: Record<string, TrackPoint[]>,
  toCtrl: { lat: number; lon: number }
): void {
  const punched = splits.filter(
    (s) => s.punchedFrom && s.punchedTo && s.timeMs != null && s.distanceM != null
  );

  for (const s of punched) {
    const seg = segments[s.participantId];
    if (!seg?.length) continue;
    const cb = detectComeBack(seg, toCtrl);
    if (cb) s.comeBack = cb;
  }

  rateComeBacks(splits, segments);

  if (punched.length < 2) return;

  punched.sort((a, b) => (a.timeMs ?? Infinity) - (b.timeMs ?? Infinity));
  const anchor = punched[0];
  const anchorSeg = segments[anchor.participantId];
  if (!anchorSeg?.length || !anchor.distanceM || anchor.distanceM < 1) return;

  for (const s of punched) {
    if (s.participantId === anchor.participantId) continue;
    if (s.distanceM == null || s.timeMs == null) continue;

    const distanceRatio = s.distanceM / anchor.distanceM;
    const vsBest: VsBestInfo = {
      anchorParticipantId: anchor.participantId,
      anchorName: anchor.participantName,
      distanceRatio,
      timeLossMs: s.timeMs - (anchor.timeMs ?? 0),
    };
    s.vsBest = vsBest;

    const seg = segments[s.participantId];
    if (!seg?.length) continue;
    const detours = detectDetours(seg, anchorSeg);
    if (detours.length) s.detours = detours;
  }
}

/** Whether vsBest is "noticeably longer" than the time anchor. */
export function isExtraDistanceFlag(vsBest: VsBestInfo | undefined): boolean {
  return !!vsBest && vsBest.distanceRatio >= EXTRA_DIST_RATIO;
}

/** Come-back worth showing in UI (peer-rated outlier). */
export function isNotableComeBack(
  comeBack: ComeBackEvent | undefined
): boolean {
  return !!comeBack && comeBack.rating === "outlier";
}
