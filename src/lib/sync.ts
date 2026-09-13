import { haversineM, indexNearestTime, interpolateAtTime } from "./gpx";
import {
  enumerateLinearCoursePaths,
  type CourseDef,
} from "./courseDef";
import type { ControlRow, SyncStrategy, TrackPoint } from "./types";

/** Stored on analysis payloads so punch-mapping changes invalidate cache. */
export const COURSE_ALIGN_VERSION = 1;

/** Tight punch circle (metres). Overridable per event. */
export const PUNCH_RADIUS_M = 15;

export type PunchOptions = {
  radiusM?: number;
  /** Control code → original GPS time (ms) for manual punch overrides. */
  punchTimesByCode?: Record<string, number>;
  /** If true, alignment must punch every course code (used for full-course slices). */
  requireAll?: boolean;
};

export function effectivePunchRadiusM(opts?: PunchOptions): number {
  const r = opts?.radiusM;
  if (typeof r === "number" && Number.isFinite(r) && r > 0) {
    return Math.min(80, Math.max(5, r));
  }
  return PUNCH_RADIUS_M;
}

function softPunchRadiusM(radiusM: number): number {
  return Math.min(40, radiusM * 1.4);
}

export function punchIndexForControl(
  points: TrackPoint[],
  control: { lat: number; lon: number },
  fromIndex: number,
  prefer: PunchPrefer,
  opts?: PunchOptions,
  code?: string
): number {
  if (code && opts?.punchTimesByCode?.[code] != null) {
    return indexNearestTime(points, opts.punchTimesByCode[code], fromIndex);
  }
  return findPunchIndex(
    points,
    control,
    fromIndex,
    effectivePunchRadiusM(opts),
    prefer
  );
}

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
  const codes = controls.map((_, i) => `#${i}`);
  const byCode = new Map(codes.map((c, i) => [c, controls[i]]));
  const aligned = alignCourseVisits(points, codes, byCode, 0, {
    radiusM,
    requireAll: true,
  });
  if (!aligned) return null;
  return {
    fromIdx: aligned.fromIdx,
    toIdx: aligned.toIdx,
    punchIndices: aligned.punchIndices,
  };
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

/** Max dwell considered for an arrive punch (avoids next-course triangle). */
const ARRIVE_MAX_STAY_MS = 45_000;
/** Points within this of the closest approach count as "at the control". */
const NEAR_BEST_M = 3;

export type PunchPrefer = "arrive" | "depart";

/**
 * Punch index for a single control (hunt / local search).
 * - arrive (default): among visits, pick the one that got *closest* to the
 *   flag (overshoot then return beats a distant first pass), then the latest
 *   sample near that closest approach.
 * - depart: leave the control circle — course start after rest at base.
 *
 * Do not walk a whole course with this: a later revisit after punching
 * other controls can steal the punch. Course matching uses alignCourseVisits.
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

function visitMinDist(
  points: TrackPoint[],
  control: { lat: number; lon: number },
  entry: number,
  exit: number
): number {
  let min = Infinity;
  for (let i = entry; i <= exit; i++) {
    min = Math.min(min, haversineM(points[i], control));
  }
  return min;
}

function collectVisits(
  points: TrackPoint[],
  control: { lat: number; lon: number },
  fromIndex: number,
  radiusM: number
): { entry: number; exit: number }[] {
  const visits: { entry: number; exit: number }[] = [];
  let i = fromIndex;
  while (i < points.length) {
    if (haversineM(points[i], control) <= radiusM) {
      const entry = i;
      while (i < points.length && haversineM(points[i], control) <= radiusM) {
        i++;
      }
      visits.push({ entry, exit: i - 1 });
    } else {
      i++;
    }
  }
  return visits;
}

function closestVisit(
  points: TrackPoint[],
  control: { lat: number; lon: number },
  visits: { entry: number; exit: number }[]
): { entry: number; exit: number } | null {
  if (visits.length === 0) return null;
  let best = visits[0];
  let bestDist = visitMinDist(points, control, best.entry, best.exit);
  for (let v = 1; v < visits.length; v++) {
    const d = visitMinDist(points, control, visits[v].entry, visits[v].exit);
    // Hunt: closer visit wins; if similar, prefer the later one (return after overshoot).
    if (d < bestDist - 0.75) {
      best = visits[v];
      bestDist = d;
    } else if (d <= bestDist + 0.75 && visits[v].entry > best.entry) {
      best = visits[v];
      bestDist = Math.min(bestDist, d);
    }
  }
  return best;
}

function findArrivalPunchIndex(
  points: TrackPoint[],
  control: { lat: number; lon: number },
  fromIndex: number,
  radiusM: number
): number {
  const tight = collectVisits(points, control, fromIndex, radiusM);
  const visit = closestVisit(points, control, tight);
  if (visit) {
    return latestNearClosestInStay(
      points,
      control,
      visit.entry,
      radiusM,
      ARRIVE_MAX_STAY_MS
    );
  }
  const softR = softPunchRadiusM(radiusM);
  const soft = collectVisits(points, control, fromIndex, softR);
  const softVisit = closestVisit(points, control, soft);
  if (!softVisit) return -1;
  return latestNearClosestInStay(
    points,
    control,
    softVisit.entry,
    softR,
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

  const softR = softPunchRadiusM(radiusM);
  const soft = firstEnterIndex(points, control, fromIndex, softR);
  if (soft < 0) return -1;
  return lastInRadius(points, control, soft, softR);
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

export type CourseVisitAlign = {
  codes: string[];
  punchIndices: number[];
  fromIdx: number;
  toIdx: number;
  matched: number;
  sumDist: number;
};

type CourseVisit = {
  code: string;
  entry: number;
  arriveIdx: number;
  departIdx: number;
  minDist: number;
};

type AlignCell = {
  matched: number;
  sumDist: number;
  firstPunch: number;
  lastPunch: number;
  prevCi: number;
  prevVi: number;
  takeVisit: number;
};

function alignBetter(a: AlignCell, b: AlignCell | undefined): boolean {
  if (!b) return true;
  if (a.matched !== b.matched) return a.matched > b.matched;
  if (Math.abs(a.sumDist - b.sumDist) > 0.75) return a.sumDist < b.sumDist;
  if (a.lastPunch !== b.lastPunch) return a.lastPunch < b.lastPunch;
  return a.firstPunch < b.firstPunch;
}

function collectCourseVisits(
  points: TrackPoint[],
  codes: string[],
  byCode: Map<string, { lat: number; lon: number }>,
  fromIndex: number,
  opts?: PunchOptions
): CourseVisit[] {
  const radius = effectivePunchRadiusM(opts);
  const softR = softPunchRadiusM(radius);
  const unique = [...new Set(codes)];
  const visits: CourseVisit[] = [];

  for (const code of unique) {
    const ctrl = byCode.get(code);
    if (!ctrl) continue;
    if (opts?.punchTimesByCode?.[code] != null) {
      const idx = indexNearestTime(
        points,
        opts.punchTimesByCode[code],
        fromIndex
      );
      if (idx >= 0) {
        visits.push({
          code,
          entry: idx,
          arriveIdx: idx,
          departIdx: idx,
          minDist: 0,
        });
      }
      continue;
    }

    let raw = collectVisits(points, ctrl, fromIndex, radius);
    if (raw.length === 0) {
      raw = collectVisits(points, ctrl, fromIndex, softR);
    }
    for (const v of raw) {
      visits.push({
        code,
        entry: v.entry,
        arriveIdx: latestNearClosestInStay(
          points,
          ctrl,
          v.entry,
          radius,
          ARRIVE_MAX_STAY_MS
        ),
        departIdx: lastInRadius(points, ctrl, v.entry, radius),
        minDist: visitMinDist(points, ctrl, v.entry, v.exit),
      });
    }
  }

  visits.sort((a, b) => a.entry - b.entry || a.minDist - b.minDist);
  return visits;
}

/**
 * Map a track onto a linear course.
 *
 * Hunt (same control, no other course punch yet): closest visit wins.
 * After the runner punches elsewhere and comes back: pick the assignment
 * that realizes the most of the course, then the closest punches.
 */
export function alignCourseVisits(
  points: TrackPoint[],
  codes: string[],
  byCode: Map<string, { lat: number; lon: number }>,
  fromIndex = 0,
  opts?: PunchOptions
): CourseVisitAlign | null {
  if (points.length < 2 || codes.length < 2) return null;
  const visits = collectCourseVisits(points, codes, byCode, fromIndex, opts);
  const m = codes.length;
  const n = visits.length;
  if (n === 0) return null;

  const empty: AlignCell = {
    matched: 0,
    sumDist: 0,
    firstPunch: -1,
    lastPunch: -1,
    prevCi: -1,
    prevVi: -1,
    takeVisit: -1,
  };
  const dp: (AlignCell | undefined)[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => undefined)
  );
  dp[0][0] = empty;

  const consider = (ci: number, vi: number, cell: AlignCell) => {
    if (alignBetter(cell, dp[ci][vi])) dp[ci][vi] = cell;
  };

  for (let ci = 0; ci <= m; ci++) {
    for (let vi = 0; vi <= n; vi++) {
      const cur = dp[ci][vi];
      if (!cur) continue;
      if (vi < n) {
        consider(ci, vi + 1, {
          ...cur,
          prevCi: ci,
          prevVi: vi,
          takeVisit: -1,
        });
      }
      if (ci < m) {
        consider(ci + 1, vi, {
          ...cur,
          prevCi: ci,
          prevVi: vi,
          takeVisit: -1,
        });
      }
      if (ci < m && vi < n && visits[vi].code === codes[ci]) {
        const punch =
          ci === 0 ? visits[vi].departIdx : visits[vi].arriveIdx;
        if (cur.lastPunch >= 0 && punch <= cur.lastPunch) continue;
        consider(ci + 1, vi + 1, {
          matched: cur.matched + 1,
          sumDist: cur.sumDist + visits[vi].minDist,
          firstPunch: cur.firstPunch >= 0 ? cur.firstPunch : punch,
          lastPunch: punch,
          prevCi: ci,
          prevVi: vi,
          takeVisit: vi,
        });
      }
    }
  }

  const best = dp[m][n];
  if (!best || best.matched < 2 || best.lastPunch <= best.firstPunch) {
    return null;
  }
  if (opts?.requireAll && best.matched !== m) return null;

  const punchByCode: { code: string; idx: number }[] = [];
  let ci = m;
  let vi = n;
  const seen = new Set<string>();
  while (ci > 0 || vi > 0) {
    const cell = dp[ci][vi];
    if (!cell) break;
    if (cell.prevCi < 0 && cell.prevVi < 0) break;
    const key = `${ci},${vi}`;
    if (seen.has(key)) break;
    seen.add(key);
    if (cell.takeVisit >= 0) {
      const visit = visits[cell.takeVisit];
      const courseIdx = cell.prevCi;
      const punch =
        courseIdx === 0 ? visit.departIdx : visit.arriveIdx;
      punchByCode.push({ code: codes[courseIdx], idx: punch });
    }
    ci = cell.prevCi;
    vi = cell.prevVi;
  }
  punchByCode.reverse();
  if (punchByCode.length < 2) return null;

  return {
    codes: punchByCode.map((p) => p.code),
    punchIndices: punchByCode.map((p) => p.idx),
    fromIdx: punchByCode[0].idx,
    toIdx: punchByCode[punchByCode.length - 1].idx,
    matched: best.matched,
    sumDist: best.sumDist,
  };
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
  controls: ControlRow[],
  opts?: PunchOptions
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
      const idx = punchIndexForControl(
        points,
        coursePts[ci],
        from,
        prefer,
        opts,
        phase.controlCodes[ci]
      );
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
  fromIndex = 0,
  opts?: PunchOptions
): { fromIdx: number; toIdx: number; punchIndices: number[] } | null {
  if (orderedControls.length < 2 || points.length < 2) return null;
  const codes = orderedControls.map((_, i) => `#${i}`);
  const byCode = new Map(codes.map((c, i) => [c, orderedControls[i]]));
  const aligned = alignCourseVisits(points, codes, byCode, fromIndex, {
    ...opts,
    requireAll: opts?.requireAll ?? true,
  });
  if (!aligned) return null;
  return {
    fromIdx: aligned.fromIdx,
    toIdx: aligned.toIdx,
    punchIndices: aligned.punchIndices,
  };
}

export interface CourseGraphMatch {
  fromIdx: number;
  toIdx: number;
  punchIndices: number[];
  codes: string[];
  forks: Record<string, string>;
}

/**
 * Match a CourseDef on a raw track by aligning visits to the course.
 * Exclusive forks: pick the linearization with the best alignment.
 */
export function matchCourseGraph(
  points: TrackPoint[],
  def: CourseDef,
  byCode: Map<string, { lat: number; lon: number }>,
  fromIndex = 0,
  opts?: PunchOptions
): CourseGraphMatch | null {
  if (points.length < 2 || def.steps.length === 0) return null;
  const paths = enumerateLinearCoursePaths(def);
  let best: { align: CourseVisitAlign; forks: Record<string, string> } | null =
    null;

  for (const path of paths) {
    const align = alignCourseVisits(points, path.codes, byCode, fromIndex, {
      ...opts,
      requireAll: false,
    });
    if (!align) continue;
    if (
      !best ||
      align.matched > best.align.matched ||
      (align.matched === best.align.matched &&
        (align.sumDist < best.align.sumDist - 0.75 ||
          (Math.abs(align.sumDist - best.align.sumDist) <= 0.75 &&
            align.fromIdx < best.align.fromIdx)))
    ) {
      best = { align, forks: path.forks };
    }
  }

  if (!best) return null;
  return {
    fromIdx: best.align.fromIdx,
    toIdx: best.align.toIdx,
    punchIndices: best.align.punchIndices,
    codes: best.align.codes,
    forks: best.forks,
  };
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
        const idx = punchIndexForControl(
          t.points,
          pt,
          searchFrom,
          prefer,
          undefined,
          course.controlCodes[ci]
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
