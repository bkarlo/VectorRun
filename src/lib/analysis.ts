import { pathClimbM, pathDistanceM } from "./gpx";
import { mpsToPaceMinPerKm } from "./speed";
import {
  applyOffset,
  computeReferenceSync,
  findPunchIndex,
} from "./sync";
import { detectHesitations } from "./hesitation";
import { applyDecisionQuality } from "./decisionQuality";
import type {
  AnalysisCoursePhase,
  AnalysisLeg,
  AnalysisPayload,
  ControlRow,
  DayPhaseRow,
  LegSplit,
  ParticipantRow,
  SyncStrategy,
  TrackPoint,
  TrackRow,
} from "./types";

export interface RunnerTrack {
  participant: ParticipantRow;
  track: TrackRow;
  points: TrackPoint[];
}

function resolveOrderedControls(
  codes: string[],
  byCode: Map<string, ControlRow>
): ControlRow[] | null {
  const out: ControlRow[] = [];
  for (const code of codes) {
    const c = byCode.get(code);
    if (!c || c.lat == null || c.lon == null) return null;
    out.push(c);
  }
  return out.length >= 2 ? out : null;
}

function buildLegFromOrdered(
  synced: { runner: RunnerTrack; points: TrackPoint[] }[],
  from: ControlRow,
  to: ControlRow,
  /** Per-runner search cursor; advanced to after `to` punch when successful. */
  cursors: Record<string, number>
): AnalysisLeg {
  const fromCtrl = { lat: from.lat!, lon: from.lon! };
  const toCtrl = { lat: to.lat!, lon: to.lon! };
  const splits: LegSplit[] = [];
  const segments: Record<string, TrackPoint[]> = {};

  for (const { runner, points } of synced) {
    const id = runner.participant.id;
    const searchFrom = cursors[id] ?? 0;
    const fromIdx = findPunchIndex(points, fromCtrl, searchFrom);
    let punchedFrom = fromIdx >= 0;
    let punchedTo = false;
    let timeMs: number | null = null;
    let distanceM: number | null = null;
    let climbM: number | null = null;
    let hesitations = undefined as
      | ReturnType<typeof detectHesitations>
      | undefined;

    if (fromIdx >= 0) {
      const toIdx = findPunchIndex(points, toCtrl, fromIdx + 1);
      punchedTo = toIdx >= 0;
      if (toIdx > fromIdx) {
        const segment = points.slice(fromIdx, toIdx + 1);
        segments[id] = segment;
        timeMs = points[toIdx].time - points[fromIdx].time;
        distanceM = pathDistanceM(segment);
        climbM = pathClimbM(segment);
        const h = detectHesitations(segment);
        if (h.length) hesitations = h;
        cursors[id] = toIdx + 1;
      }
    }

    splits.push({
      participantId: id,
      participantName: runner.participant.name,
      color: runner.participant.color,
      fromSeq: from.sequence,
      toSeq: to.sequence,
      fromCode: from.code,
      toCode: to.code,
      timeMs,
      distanceM,
      climbM,
      punchedFrom,
      punchedTo,
      hesitations,
    });
  }

  applyDecisionQuality(splits, segments, toCtrl);

  splits.sort((a, b) => {
    if (a.timeMs == null && b.timeMs == null) return 0;
    if (a.timeMs == null) return 1;
    if (b.timeMs == null) return -1;
    return a.timeMs - b.timeMs;
  });

  return {
    fromSeq: from.sequence,
    toSeq: to.sequence,
    fromCode: from.code,
    toCode: to.code,
    splits,
  };
}

function buildOverallFromOrdered(
  synced: { runner: RunnerTrack; points: TrackPoint[] }[],
  ordered: ControlRow[],
  /** Cursor at start of this course phase; advanced past finish on success. */
  cursors: Record<string, number>
): AnalysisLeg {
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const coursePts = ordered.map((c) => ({ lat: c.lat!, lon: c.lon! }));
  const toCtrl = coursePts[coursePts.length - 1];
  const splits: LegSplit[] = [];
  const segments: Record<string, TrackPoint[]> = {};

  for (const { runner, points } of synced) {
    const id = runner.participant.id;
    const searchFrom = cursors[id] ?? 0;
    // Walk controls from cursor without mutating global until complete
    let from = searchFrom;
    const punchIndices: number[] = [];
    let ok = true;
    for (const pt of coursePts) {
      const idx = findPunchIndex(points, pt, from);
      if (idx < 0) {
        ok = false;
        break;
      }
      punchIndices.push(idx);
      from = idx + 1;
    }

    let punchedFrom = false;
    let punchedTo = false;
    let timeMs: number | null = null;
    let distanceM: number | null = null;
    let climbM: number | null = null;
    let hesitations = undefined as
      | ReturnType<typeof detectHesitations>
      | undefined;

    if (ok && punchIndices.length >= 2) {
      const fromIdx = punchIndices[0];
      const toIdx = punchIndices[punchIndices.length - 1];
      punchedFrom = true;
      punchedTo = true;
      const segment = points.slice(fromIdx, toIdx + 1);
      segments[id] = segment;
      timeMs = points[toIdx].time - points[fromIdx].time;
      distanceM = pathDistanceM(segment);
      climbM = pathClimbM(segment);
      const h = detectHesitations(segment);
      if (h.length) hesitations = h;
      cursors[id] = toIdx + 1;
    } else {
      const fromIdx = findPunchIndex(points, coursePts[0], searchFrom);
      punchedFrom = fromIdx >= 0;
      punchedTo = false;
    }

    splits.push({
      participantId: id,
      participantName: runner.participant.name,
      color: runner.participant.color,
      fromSeq: first.sequence,
      toSeq: last.sequence,
      fromCode: first.code,
      toCode: last.code,
      timeMs,
      distanceM,
      climbM,
      punchedFrom,
      punchedTo,
      hesitations,
    });
  }

  applyDecisionQuality(splits, segments, toCtrl);

  splits.sort((a, b) => {
    if (a.timeMs == null && b.timeMs == null) return 0;
    if (a.timeMs == null) return 1;
    if (b.timeMs == null) return -1;
    return a.timeMs - b.timeMs;
  });

  return {
    fromSeq: first.sequence,
    toSeq: last.sequence,
    fromCode: first.code,
    toCode: last.code,
    splits,
  };
}

/**
 * Analyze event using the day plan. Course phases are matched time-forward
 * so the same control order can appear twice as separate attempts.
 */
export function analyzeEvent(
  referenceId: string | null,
  controls: ControlRow[],
  runners: RunnerTrack[],
  dayPhases: DayPhaseRow[]
): AnalysisPayload {
  const byCode = new Map(controls.map((c) => [c.code, c]));
  const geoForSync = [...controls]
    .filter((c) => c.lat != null && c.lon != null)
    .sort((a, b) => a.sequence - b.sequence);

  // Prefer first course phase order for sync punch strategies
  const firstCourse = dayPhases.find((p) => p.kind === "course");
  const syncControls =
    firstCourse && firstCourse.controlCodes.length >= 1
      ? (resolveOrderedControls(firstCourse.controlCodes, byCode) ?? geoForSync)
      : geoForSync;

  const sync = computeReferenceSync(
    referenceId,
    runners.map((r) => ({
      id: r.participant.id,
      points: r.points,
      strategy: (r.participant.sync_strategy || "motion_start") as SyncStrategy,
      manualDeltaMs: r.track.start_offset_ms,
    })),
    syncControls
  );

  const synced: { runner: RunnerTrack; points: TrackPoint[] }[] = [];
  for (const runner of runners) {
    const finalOffset = sync.offsets[runner.participant.id] ?? 0;
    synced.push({
      runner,
      points: applyOffset(runner.points, finalOffset),
    });
  }

  const cursors: Record<string, number> = {};
  for (const s of synced) cursors[s.runner.participant.id] = 0;

  const coursePhases: AnalysisCoursePhase[] = [];

  for (const phase of dayPhases) {
    if (phase.kind !== "course") continue;
    const ordered = resolveOrderedControls(phase.controlCodes, byCode);
    if (!ordered) {
      coursePhases.push({
        id: phase.id,
        name: phase.name,
        sortOrder: phase.sort_order,
        controlCodes: phase.controlCodes,
        overall: null,
        legs: [],
      });
      continue;
    }

    // Snapshot cursors before legs so overall uses same phase window start;
    // then advance via overall (full course walk). Legs use independent
    // per-leg punches within the phase by temporarily walking from phase start.
    const phaseStart: Record<string, number> = { ...cursors };

    const legs: AnalysisLeg[] = [];
    const legCursors = { ...phaseStart };
    for (let i = 0; i < ordered.length - 1; i++) {
      legs.push(
        buildLegFromOrdered(synced, ordered[i], ordered[i + 1], legCursors)
      );
    }

    const overall = buildOverallFromOrdered(synced, ordered, cursors);

    coursePhases.push({
      id: phase.id,
      name: phase.name,
      sortOrder: phase.sort_order,
      controlCodes: phase.controlCodes,
      overall,
      legs,
    });
  }

  // Compat: first course phase
  const first = coursePhases[0];
  return {
    coursePhases,
    overall: first?.overall ?? null,
    legs: first?.legs ?? [],
    syncOffsets: sync.offsets,
    syncDeltasMs: sync.deltasMs,
    referenceId: sync.referenceId,
    referenceWallTimeMs: sync.referenceWallTimeMs,
  };
}

export function formatSplitTime(ms: number | null): string {
  if (ms == null || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Pace min/km from leg time + distance; null if missing/invalid. */
export function formatLegPace(
  timeMs: number | null,
  distanceM: number | null
): string | null {
  if (timeMs == null || distanceM == null || timeMs <= 0 || distanceM < 5) {
    return null;
  }
  const mps = distanceM / (timeMs / 1000);
  return mpsToPaceMinPerKm(mps);
}

export function medalForRank(rank: number, hasTime: boolean): string {
  if (!hasTime) return "";
  if (rank === 0) return "🥇";
  if (rank === 1) return "🥈";
  if (rank === 2) return "🥉";
  return "";
}

/** Signed duration for sync Δ, e.g. "−4m 1s", "+12s", "0s". */
export function formatSignedDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec === 0) return "0s";
  const sign = totalSec < 0 ? "−" : "+";
  const abs = Math.abs(totalSec);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  if (m === 0) return `${sign}${s}s`;
  if (s === 0) return `${sign}${m}m`;
  return `${sign}${m}m ${s}s`;
}

/**
 * Parse "−4m 1s", "+12s", "-241", "4:01" → seconds (signed).
 * Returns null if unparseable.
 */
export function parseSignedDurationToSec(text: string): number | null {
  const raw = text.trim().replace(/−/g, "-").replace(/\s+/g, " ");
  if (!raw) return null;

  const plain = raw.match(/^([+-]?)(\d+)\s*s?$/i);
  if (plain) {
    const n = parseInt(plain[2], 10);
    return plain[1] === "-" ? -n : n;
  }

  const colon = raw.match(/^([+-]?)(\d+):(\d{1,2})$/);
  if (colon) {
    const n = parseInt(colon[2], 10) * 60 + parseInt(colon[3], 10);
    return colon[1] === "-" ? -n : n;
  }

  const ms = raw.match(/^([+-]?)(\d+)\s*m(?:\s*(\d+)\s*s?)?$/i);
  if (ms) {
    const n = parseInt(ms[2], 10) * 60 + (ms[3] ? parseInt(ms[3], 10) : 0);
    return ms[1] === "-" ? -n : n;
  }

  return null;
}

export function formatDelta(ms: number): string {
  return formatSignedDuration(ms);
}

export function formatWallTime(ms: number | null): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "—";
  }
}