import { haversineM, interpolateAtTime } from "./gpx";
import type { ControlRow, SyncStrategy, TrackPoint } from "./types";

export const PUNCH_RADIUS_M = 25;

/** Punch indices for a leg (from → to). Null if either punch missing. */
export function legSegmentIndices(
  points: TrackPoint[],
  fromCtrl: { lat: number; lon: number },
  toCtrl: { lat: number; lon: number },
  radiusM = PUNCH_RADIUS_M
): { fromIdx: number; toIdx: number } | null {
  const fromIdx = findPunchIndex(points, fromCtrl, 0, radiusM);
  if (fromIdx < 0) return null;
  const toIdx = findPunchIndex(points, toCtrl, fromIdx + 1, radiusM);
  if (toIdx < 0 || toIdx <= fromIdx) return null;
  return { fromIdx, toIdx };
}

/**
 * Full-course segment following controls in order (S→1→…→F).
 * Required when start and finish are co-located — a direct S→F punch
 * would collapse to a few meters at the start triangle.
 * Start uses departure (leave base); later controls / F use arrival.
 */
export function courseSegmentIndices(
  points: TrackPoint[],
  controls: { lat: number; lon: number }[],
  radiusM = PUNCH_RADIUS_M
): { fromIdx: number; toIdx: number; punchIndices: number[] } | null {
  if (controls.length < 2 || points.length < 2) return null;
  const punchIndices: number[] = [];
  let searchFrom = 0;
  for (let i = 0; i < controls.length; i++) {
    const prefer: PunchPrefer = i === 0 ? "depart" : "arrive";
    const idx = findPunchIndex(points, controls[i], searchFrom, radiusM, prefer);
    if (idx < 0) return null;
    punchIndices.push(idx);
    searchFrom = idx + 1;
  }
  const fromIdx = punchIndices[0];
  const toIdx = punchIndices[punchIndices.length - 1];
  if (toIdx <= fromIdx) return null;
  return { fromIdx, toIdx, punchIndices };
}

/** Inclusive slice along the ordered course (all controls). */
export function courseSegmentPoints(
  points: TrackPoint[],
  controls: { lat: number; lon: number }[],
  radiusM = PUNCH_RADIUS_M
): TrackPoint[] | null {
  const idx = courseSegmentIndices(points, controls, radiusM);
  if (!idx) return null;
  return points.slice(idx.fromIdx, idx.toIdx + 1);
}

/** Inclusive slice of points between from/to punches. */
export function legSegmentPoints(
  points: TrackPoint[],
  fromCtrl: { lat: number; lon: number },
  toCtrl: { lat: number; lon: number },
  radiusM = PUNCH_RADIUS_M
): TrackPoint[] | null {
  const idx = legSegmentIndices(points, fromCtrl, toCtrl, radiusM);
  if (!idx) return null;
  return points.slice(idx.fromIdx, idx.toIdx + 1);
}

/** Soft punch radius when the tight radius never hits. */
const SOFT_PUNCH_M = 80;
/** Max dwell considered for an arrive punch (avoids next-course triangle). */
const ARRIVE_MAX_STAY_MS = 45_000;
/** Points within this of the closest approach count as "at the control". */
const NEAR_BEST_M = 3;

export type PunchPrefer = "arrive" | "depart";

/**
 * Punch index for a control.
 * - arrive (default): among the visit, pick the *latest* sample near the
 *   closest approach to the control (runner has found the flag, about to leave).
 * - depart: leave the control circle — course start after rest at base.
 */
export function findPunchIndex(
  points: TrackPoint[],
  control: { lat: number; lon: number },
  fromIndex = 0,
  radiusM = PUNCH_RADIUS_M,
  prefer: PunchPrefer = "arrive"
): number {
  if (prefer === "depart") {
    return findDeparturePunchIndex(points, control, fromIndex, radiusM);
  }
  return findArrivalPunchIndex(points, control, fromIndex, radiusM);
}

function findArrivalPunchIndex(
  points: TrackPoint[],
  control: { lat: number; lon: number },
  fromIndex: number,
  radiusM: number
): number {
  const entry = firstEnterIndex(points, control, fromIndex, radiusM);
  if (entry >= 0) {
    return latestNearClosestInStay(
      points,
      control,
      entry,
      radiusM,
      ARRIVE_MAX_STAY_MS
    );
  }
  const soft = firstEnterIndex(points, control, fromIndex, SOFT_PUNCH_M);
  if (soft < 0) return -1;
  return latestNearClosestInStay(
    points,
    control,
    soft,
    SOFT_PUNCH_M,
    ARRIVE_MAX_STAY_MS
  );
}

/**
 * Within one visit: find closest approach, then take the *latest* sample
 * still very near that closest distance (true punch before heading out).
 */
function latestNearClosestInStay(
  points: TrackPoint[],
  control: { lat: number; lon: number },
  entry: number,
  radiusM: number,
  maxStayMs: number
): number {
  const t0 = points[entry].time;
  let end = entry;
  for (let i = entry; i < points.length; i++) {
    if (points[i].time - t0 > maxStayMs) break;
    if (haversineM(points[i], control) > radiusM) break;
    end = i;
  }

  let bestDist = Infinity;
  for (let i = entry; i <= end; i++) {
    const d = haversineM(points[i], control);
    if (d < bestDist) bestDist = d;
  }
  const thresh = Math.max(bestDist + NEAR_BEST_M, bestDist * 1.2);

  let latest = entry;
  for (let i = entry; i <= end; i++) {
    if (haversineM(points[i], control) <= thresh) latest = i;
  }
  return latest;
}

function findDeparturePunchIndex(
  points: TrackPoint[],
  control: { lat: number; lon: number },
  fromIndex: number,
  radiusM: number
): number {
  if (fromIndex >= points.length) return -1;

  // Already inside (e.g. resting at base after F): punch = last point before exit
  if (haversineM(points[fromIndex], control) <= radiusM) {
    return lastInRadius(points, control, fromIndex, radiusM);
  }

  // Outside: enter, then leave — start punch is departure of that stay
  const entry = firstEnterIndex(points, control, fromIndex, radiusM);
  if (entry >= 0) {
    return lastInRadius(points, control, entry, radiusM);
  }

  const soft = firstEnterIndex(points, control, fromIndex, SOFT_PUNCH_M);
  if (soft < 0) return -1;
  return lastInRadius(points, control, soft, SOFT_PUNCH_M);
}

function firstEnterIndex(
  points: TrackPoint[],
  control: { lat: number; lon: number },
  fromIndex: number,
  radiusM: number
): number {
  for (let i = fromIndex; i < points.length; i++) {
    if (haversineM(points[i], control) <= radiusM) return i;
  }
  return -1;
}

function lastInRadius(
  points: TrackPoint[],
  control: { lat: number; lon: number },
  fromIndex: number,
  radiusM: number
): number {
  let last = fromIndex;
  for (let i = fromIndex; i < points.length; i++) {
    if (haversineM(points[i], control) <= radiusM) last = i;
    else break;
  }
  return last;
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

  if (kind === "start_punch") {
    const target = geo[0];
    if (target.lat == null || target.lon == null) return null;
    const idx = findPunchIndex(
      points,
      { lat: target.lat, lon: target.lon },
      0,
      PUNCH_RADIUS_M,
      "depart"
    );
    return idx >= 0 ? points[idx].time : null;
  }

  // first_control: prefer control seq 1 (else 2nd geo), searched AFTER start
  // punch when possible so warm-up near that control is ignored.
  const start = geo[0];
  const target =
    geo.find((c) => c.sequence === 1) ?? geo[1] ?? geo[0];
  if (!target || target.lat == null || target.lon == null) return null;

  let fromIndex = 0;
  if (
    start &&
    start.id !== target.id &&
    start.lat != null &&
    start.lon != null
  ) {
    const startIdx = findPunchIndex(points, {
      lat: start.lat,
      lon: start.lon,
    });
    if (startIdx >= 0) fromIndex = startIdx + 1;
  }

  const idx = findPunchIndex(
    points,
    { lat: target.lat, lon: target.lon },
    fromIndex
  );
  return idx >= 0 ? points[idx].time : null;
}

/** Real-time window for one course attempt on a raw (unsynced) track. */
export interface CourseWindow {
  phaseId: string;
  fromIdx: number;
  toIdx: number;
  tStart: number;
  tEnd: number;
}

/**
 * Split a raw GPX into course windows using day-plan control order.
 * Uses real GPS timestamps only — no sync offsets. Walks time-forward so
 * the same control loop can appear as separate courses.
 */
export function splitDayIntoCourseWindows(
  points: TrackPoint[],
  dayPhases: { id: string; kind: string; controlCodes: string[] }[],
  controls: ControlRow[]
): CourseWindow[] {
  const byCode = new Map(
    controls
      .filter((c) => c.lat != null && c.lon != null)
      .map((c) => [c.code, { lat: c.lat!, lon: c.lon! }])
  );
  const out: CourseWindow[] = [];
  if (points.length < 2) return out;

  let searchFrom = 0;
  for (const phase of dayPhases) {
    if (phase.kind !== "course" || (phase.controlCodes?.length ?? 0) < 2) {
      continue;
    }

    const coursePts: { lat: number; lon: number }[] = [];
    let codesOk = true;
    for (const code of phase.controlCodes) {
      const pt = byCode.get(code);
      if (!pt) {
        codesOk = false;
        break;
      }
      coursePts.push(pt);
    }
    if (!codesOk) continue;

    const punchIndices: number[] = [];
    let from = searchFrom;
    let complete = true;
    for (let ci = 0; ci < coursePts.length; ci++) {
      const prefer: PunchPrefer = ci === 0 ? "depart" : "arrive";
      const idx = findPunchIndex(points, coursePts[ci], from, PUNCH_RADIUS_M, prefer);
      if (idx < 0) {
        complete = false;
        break;
      }
      punchIndices.push(idx);
      from = idx + 1;
    }

    if (punchIndices.length > 0) {
      searchFrom = punchIndices[punchIndices.length - 1] + 1;
    }
    if (!complete || punchIndices.length < 2) continue;

    const fromIdx = punchIndices[0];
    const toIdx = punchIndices[punchIndices.length - 1];
    if (toIdx <= fromIdx) continue;

    out.push({
      phaseId: phase.id,
      fromIdx,
      toIdx,
      tStart: points[fromIdx].time,
      tEnd: points[toIdx].time,
    });
  }

  return out;
}

/**
 * Match one course (ordered controls) on a raw track starting at fromIndex.
 * Advances only within this call; caller owns the day-level cursor.
 */
export function matchCourseWindow(
  points: TrackPoint[],
  orderedControls: { lat: number; lon: number }[],
  fromIndex = 0
): { fromIdx: number; toIdx: number; punchIndices: number[] } | null {
  if (orderedControls.length < 2 || points.length < 2) return null;
  const punchIndices: number[] = [];
  let searchFrom = fromIndex;
  for (let i = 0; i < orderedControls.length; i++) {
    const prefer: PunchPrefer = i === 0 ? "depart" : "arrive";
    const idx = findPunchIndex(
      points,
      orderedControls[i],
      searchFrom,
      PUNCH_RADIUS_M,
      prefer
    );
    if (idx < 0) return null;
    punchIndices.push(idx);
    searchFrom = idx + 1;
  }
  const fromIdx = punchIndices[0];
  const toIdx = punchIndices[punchIndices.length - 1];
  if (toIdx <= fromIdx) return null;
  return { fromIdx, toIdx, punchIndices };
}

export interface CourseGraphMatch {
  fromIdx: number;
  toIdx: number;
  punchIndices: number[];
  codes: string[];
  forks: Record<string, string>;
}

/**
 * Match a CourseDef (controls + exclusive forks) on a raw track.
 * At each exclusive fork, picks the arm whose first control punches earliest.
 */
export function matchCourseGraph(
  points: TrackPoint[],
  def: import("./courseDef").CourseDef,
  byCode: Map<string, { lat: number; lon: number }>,
  fromIndex = 0
): CourseGraphMatch | null {
  if (points.length < 2 || def.steps.length === 0) return null;

  const punchIndices: number[] = [];
  const codes: string[] = [];
  const forks: Record<string, string> = {};
  let searchFrom = fromIndex;
  let isFirst = true;

  const punchControl = (code: string): number => {
    const pt = byCode.get(code);
    if (!pt) return -1;
    const prefer: PunchPrefer = isFirst ? "depart" : "arrive";
    const idx = findPunchIndex(points, pt, searchFrom, PUNCH_RADIUS_M, prefer);
    if (idx < 0) return -1;
    punchIndices.push(idx);
    codes.push(code);
    searchFrom = idx + 1;
    isFirst = false;
    return idx;
  };

  const matchArmSteps = (
    steps: import("./courseDef").CourseStep[],
    startFrom: number,
    firstPrefer: PunchPrefer
  ): { indices: number[]; codes: string[]; endFrom: number } | null => {
    let from = startFrom;
    const indices: number[] = [];
    const armCodes: string[] = [];
    let first = true;
    for (const s of steps) {
      if (s.type !== "control") return null; // nested forks not matched in v1
      const pt = byCode.get(s.code);
      if (!pt) return null;
      const prefer: PunchPrefer = first ? firstPrefer : "arrive";
      const idx = findPunchIndex(points, pt, from, PUNCH_RADIUS_M, prefer);
      if (idx < 0) return null;
      indices.push(idx);
      armCodes.push(s.code);
      from = idx + 1;
      first = false;
    }
    return { indices, codes: armCodes, endFrom: from };
  };

  for (const step of def.steps) {
    if (step.type === "control") {
      if (punchControl(step.code) < 0) return null;
      continue;
    }

    // Fork
    if (step.mode === "any_order") return null;

    if (step.mode === "sequence") {
      // One-man relay: do all arms in order
      for (const arm of step.arms) {
        const matched = matchArmSteps(
          arm.steps,
          searchFrom,
          isFirst ? "depart" : "arrive"
        );
        if (!matched) return null;
        punchIndices.push(...matched.indices);
        codes.push(...matched.codes);
        searchFrom = matched.endFrom;
        isFirst = false;
      }
      forks[step.id] = step.arms.map((a) => a.id).join(",");
      continue;
    }

    // exclusive: pick arm with earliest first punch
    type Cand = {
      armId: string;
      firstIdx: number;
      firstDist: number;
      indices: number[];
      codes: string[];
      endFrom: number;
    };
    const cands: Cand[] = [];
    for (const arm of step.arms) {
      const firstStep = arm.steps.find((s) => s.type === "control");
      if (!firstStep || firstStep.type !== "control") continue;
      const pt = byCode.get(firstStep.code);
      if (!pt) continue;
      const prefer: PunchPrefer = isFirst ? "depart" : "arrive";
      const firstIdx = findPunchIndex(
        points,
        pt,
        searchFrom,
        PUNCH_RADIUS_M,
        prefer
      );
      if (firstIdx < 0) continue;
      const matched = matchArmSteps(arm.steps, searchFrom, prefer);
      if (!matched) continue;
      cands.push({
        armId: arm.id,
        firstIdx,
        firstDist: haversineM(points[firstIdx], pt),
        indices: matched.indices,
        codes: matched.codes,
        endFrom: matched.endFrom,
      });
    }
    if (cands.length === 0) return null;
    cands.sort((a, b) => {
      if (a.firstIdx !== b.firstIdx) return a.firstIdx - b.firstIdx;
      return a.firstDist - b.firstDist;
    });
    const best = cands[0];
    forks[step.id] = best.armId;
    punchIndices.push(...best.indices);
    codes.push(...best.codes);
    searchFrom = best.endFrom;
    isFirst = false;
  }

  if (punchIndices.length < 2) return null;
  const fromIdx = punchIndices[0];
  const toIdx = punchIndices[punchIndices.length - 1];
  if (toIdx <= fromIdx) return null;
  return { fromIdx, toIdx, punchIndices, codes, forks };
}

/**
 * Race window for a training day: earliest first-control punch of the first
 * course phase → latest last-control punch of the last course phase
 * (time-forward across phases). Includes rest between courses; excludes
 * walk-in / walk-out outside that span.
 */
export function computeDayRaceWindow(
  tracks: { points: TrackPoint[] }[],
  controls: ControlRow[],
  dayPhases: { kind: string; controlCodes: string[] }[]
): { min: number; max: number } | null {
  const byCode = new Map(
    controls
      .filter((c) => c.lat != null && c.lon != null)
      .map((c) => [c.code, { lat: c.lat!, lon: c.lon! }])
  );
  const courses = dayPhases.filter(
    (p) => p.kind === "course" && (p.controlCodes?.length ?? 0) >= 2
  );
  if (courses.length === 0 || tracks.length === 0) return null;

  let minFrom = Infinity;
  let maxTo = -Infinity;

  for (const t of tracks) {
    if (t.points.length < 2) continue;
    let searchFrom = 0;
    let firstPunch = -1;
    let lastPunch = -1;
    let ok = true;
    for (const course of courses) {
      for (let ci = 0; ci < course.controlCodes.length; ci++) {
        const pt = byCode.get(course.controlCodes[ci]);
        if (!pt) {
          ok = false;
          break;
        }
        const prefer: PunchPrefer = ci === 0 ? "depart" : "arrive";
        const idx = findPunchIndex(
          t.points,
          pt,
          searchFrom,
          PUNCH_RADIUS_M,
          prefer
        );
        if (idx < 0) {
          ok = false;
          break;
        }
        if (firstPunch < 0) firstPunch = idx;
        lastPunch = idx;
        searchFrom = idx + 1;
      }
      if (!ok) break;
    }
    if (!ok || firstPunch < 0 || lastPunch <= firstPunch) continue;
    minFrom = Math.min(minFrom, t.points[firstPunch].time);
    maxTo = Math.max(maxTo, t.points[lastPunch].time);
  }

  if (!Number.isFinite(minFrom) || !Number.isFinite(maxTo) || maxTo <= minFrom) {
    return null;
  }
  return { min: minFrom, max: maxTo + 1_000 };
}

/**
 * Shared race window on the synced timeline (legacy single-course helper).
 * Prefer computeDayRaceWindow when a day plan exists.
 */
export function computeRaceWindow(
  tracks: { points: TrackPoint[] }[],
  controls: ControlRow[]
): { min: number; max: number } | null {
  const geo = controls
    .filter((c) => c.lat != null && c.lon != null)
    .sort((a, b) => a.sequence - b.sequence);
  if (geo.length < 2 || tracks.length === 0) return null;

  const course = geo.map((c) => ({ lat: c.lat!, lon: c.lon! }));
  let minFrom = Infinity;
  let maxTo = -Infinity;

  for (const t of tracks) {
    if (t.points.length < 2) continue;
    const idx = courseSegmentIndices(t.points, course);
    if (!idx) continue;
    minFrom = Math.min(minFrom, t.points[idx.fromIdx].time);
    maxTo = Math.max(maxTo, t.points[idx.toIdx].time);
  }

  if (!Number.isFinite(minFrom) || !Number.isFinite(maxTo) || maxTo <= minFrom) {
    return null;
  }
  const pad = 1_000;
  return { min: minFrom, max: maxTo + pad };
}

/** Split a track into before / during / after a time window (inclusive). */
export function splitTrackByTimeWindow(
  points: TrackPoint[],
  window: { min: number; max: number }
): {
  before: TrackPoint[];
  during: TrackPoint[];
  after: TrackPoint[];
} {
  if (points.length === 0) {
    return { before: [], during: [], after: [] };
  }
  const before: TrackPoint[] = [];
  const during: TrackPoint[] = [];
  const after: TrackPoint[] = [];
  for (const p of points) {
    if (p.time < window.min) before.push(p);
    else if (p.time > window.max) after.push(p);
    else during.push(p);
  }
  // Bridge gaps so polylines connect at window edges
  if (before.length && during.length) {
    during.unshift(before[before.length - 1]);
  } else if (before.length && !during.length && after.length) {
    // no points inside window — leave empty during
  }
  if (during.length && after.length) {
    after.unshift(during[during.length - 1]);
  }
  return { before, during, after };
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
