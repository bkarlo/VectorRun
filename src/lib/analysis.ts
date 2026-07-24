import { pathClimbM, pathDistanceM } from "./gpx";
import { mpsToPaceMinPerKm } from "./speed";
import {
  collectAllCodes,
  courseDefFromCodes,
  legTemplatesFromCourse,
  type CourseDef,
  type CourseLegTemplate,
} from "./courseDef";
import {
  applyOffset,
  computeReferenceSync,
  findPunchIndex,
  matchCourseGraph,
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
  RealizedRunnerPath,
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

function phaseCourseDef(phase: DayPhaseRow): CourseDef | null {
  if (phase.courseDef?.steps.length) return phase.courseDef;
  if (phase.controlCodes.length >= 2) {
    return courseDefFromCodes(phase.controlCodes);
  }
  return null;
}

function runnerTakesLeg(
  realized: RealizedRunnerPath | undefined,
  tmpl: CourseLegTemplate
): number {
  if (!realized?.codes.length) return -1;
  if (tmpl.forkId && tmpl.armId) {
    const chosen = realized.forks[tmpl.forkId];
    if (!chosen) return -1;
    if (chosen.includes(",")) {
      if (!chosen.split(",").includes(tmpl.armId)) return -1;
    } else if (chosen !== tmpl.armId) {
      return -1;
    }
  }
  for (let i = 0; i < realized.codes.length - 1; i++) {
    if (
      realized.codes[i] === tmpl.fromCode &&
      realized.codes[i + 1] === tmpl.toCode
    ) {
      return i;
    }
  }
  return -1;
}

function buildLegFromTemplate(
  synced: { runner: RunnerTrack; points: TrackPoint[] }[],
  tmpl: CourseLegTemplate,
  byCode: Map<string, ControlRow>,
  realizedPath: Record<string, RealizedRunnerPath>
): AnalysisLeg {
  const from = byCode.get(tmpl.fromCode);
  const to = byCode.get(tmpl.toCode);
  const fromSeq = from?.sequence ?? 0;
  const toSeq = to?.sequence ?? 0;
  const toCtrl =
    to?.lat != null && to?.lon != null
      ? { lat: to.lat, lon: to.lon }
      : { lat: 0, lon: 0 };

  const splits: LegSplit[] = [];
  const segments: Record<string, TrackPoint[]> = {};

  for (const { runner, points } of synced) {
    const id = runner.participant.id;
    const realized = realizedPath[id];
    const codeIdx = runnerTakesLeg(realized, tmpl);
    let punchedFrom = false;
    let punchedTo = false;
    let timeMs: number | null = null;
    let distanceM: number | null = null;
    let climbM: number | null = null;
    let hesitations = undefined as
      | ReturnType<typeof detectHesitations>
      | undefined;

    if (codeIdx >= 0 && realized) {
      const fromIdx = realized.punchIndices[codeIdx];
      const toIdx = realized.punchIndices[codeIdx + 1];
      punchedFrom = fromIdx != null && fromIdx >= 0;
      punchedTo = toIdx != null && toIdx >= 0;
      if (
        punchedFrom &&
        punchedTo &&
        toIdx > fromIdx &&
        fromIdx < points.length &&
        toIdx < points.length
      ) {
        const segment = points.slice(fromIdx, toIdx + 1);
        segments[id] = segment;
        timeMs = points[toIdx].time - points[fromIdx].time;
        distanceM = pathDistanceM(segment);
        climbM = pathClimbM(segment);
        const h = detectHesitations(segment);
        if (h.length) hesitations = h;
      }
    }

    splits.push({
      participantId: id,
      participantName: runner.participant.name,
      color: runner.participant.color,
      fromSeq,
      toSeq,
      fromCode: tmpl.fromCode,
      toCode: tmpl.toCode,
      timeMs,
      distanceM,
      climbM,
      punchedFrom,
      punchedTo,
      hesitations,
    });
  }

  // Decision quality only among runners who actually ran this leg
  applyDecisionQuality(splits, segments, toCtrl);

  splits.sort((a, b) => {
    if (a.timeMs == null && b.timeMs == null) return 0;
    if (a.timeMs == null) return 1;
    if (b.timeMs == null) return -1;
    return a.timeMs - b.timeMs;
  });

  return {
    fromSeq,
    toSeq,
    fromCode: tmpl.fromCode,
    toCode: tmpl.toCode,
    forkId: tmpl.forkId,
    forkLabel: tmpl.forkLabel,
    armId: tmpl.armId,
    armLabel: tmpl.armLabel,
    splits,
  };
}

function buildOverallFromRealized(
  synced: { runner: RunnerTrack; points: TrackPoint[] }[],
  realizedPath: Record<string, RealizedRunnerPath>,
  byCode: Map<string, ControlRow>
): AnalysisLeg {
  const splits: LegSplit[] = [];
  const segments: Record<string, TrackPoint[]> = {};
  let fromCode = "S";
  let toCode = "F";
  let fromSeq = 0;
  let toSeq = 0;

  for (const { runner, points } of synced) {
    const id = runner.participant.id;
    const realized = realizedPath[id];
    let punchedFrom = false;
    let punchedTo = false;
    let timeMs: number | null = null;
    let distanceM: number | null = null;
    let climbM: number | null = null;
    let hesitations = undefined as
      | ReturnType<typeof detectHesitations>
      | undefined;

    if (realized && realized.punchIndices.length >= 2 && points.length >= 2) {
      const fromIdx = realized.punchIndices[0];
      const toIdx = realized.punchIndices[realized.punchIndices.length - 1];
      fromCode = realized.codes[0] ?? fromCode;
      toCode = realized.codes[realized.codes.length - 1] ?? toCode;
      fromSeq = byCode.get(fromCode)?.sequence ?? 0;
      toSeq = byCode.get(toCode)?.sequence ?? 0;
      punchedFrom = true;
      punchedTo = true;
      if (toIdx > fromIdx && toIdx < points.length) {
        const segment = points.slice(fromIdx, toIdx + 1);
        segments[id] = segment;
        timeMs = points[toIdx].time - points[fromIdx].time;
        distanceM = pathDistanceM(segment);
        climbM = pathClimbM(segment);
        const h = detectHesitations(segment);
        if (h.length) hesitations = h;
      }
    }

    splits.push({
      participantId: id,
      participantName: runner.participant.name,
      color: runner.participant.color,
      fromSeq,
      toSeq,
      fromCode,
      toCode,
      timeMs,
      distanceM,
      climbM,
      punchedFrom,
      punchedTo,
      hesitations,
    });
  }

  const lastCtrl = byCode.get(toCode);
  const toCtrl =
    lastCtrl?.lat != null && lastCtrl?.lon != null
      ? { lat: lastCtrl.lat, lon: lastCtrl.lon }
      : { lat: 0, lon: 0 };
  applyDecisionQuality(splits, segments, toCtrl);

  splits.sort((a, b) => {
    if (a.timeMs == null && b.timeMs == null) return 0;
    if (a.timeMs == null) return 1;
    if (b.timeMs == null) return -1;
    return a.timeMs - b.timeMs;
  });

  return {
    fromSeq,
    toSeq,
    fromCode,
    toCode,
    splits,
  };
}

function emptyCoursePhase(
  phase: DayPhaseRow,
  runners: RunnerTrack[],
  def: CourseDef | null
): AnalysisCoursePhase {
  const syncOffsets: Record<string, number> = {};
  const syncDeltasMs: Record<string, number> = {};
  for (const r of runners) {
    syncOffsets[r.participant.id] = 0;
    syncDeltasMs[r.participant.id] = 0;
  }
  return {
    id: phase.id,
    name: phase.name,
    sortOrder: phase.sort_order,
    controlCodes: def ? collectAllCodes(def) : phase.controlCodes,
    courseDef: def,
    overall: null,
    legs: [],
    syncOffsets,
    syncDeltasMs,
    referenceId: null,
    referenceWallTimeMs: null,
    windows: {},
    realizedPath: {},
  };
}

/**
 * Analyze event using the day plan:
 * 1) Match each course graph on real GPS time (exclusive forks → best arm).
 * 2) Sync + analyze each course independently on realized slices.
 */
export function analyzeEvent(
  referenceId: string | null,
  controls: ControlRow[],
  runners: RunnerTrack[],
  dayPhases: DayPhaseRow[]
): AnalysisPayload {
  const byCode = new Map(controls.map((c) => [c.code, c]));
  const geoByCode = new Map(
    controls
      .filter((c) => c.lat != null && c.lon != null)
      .map((c) => [c.code, { lat: c.lat!, lon: c.lon! }])
  );

  const rawCursors: Record<string, number> = {};
  for (const r of runners) rawCursors[r.participant.id] = 0;

  const coursePhases: AnalysisCoursePhase[] = [];

  for (const phase of dayPhases) {
    if (phase.kind !== "course") continue;
    const def = phaseCourseDef(phase);
    if (!def) {
      coursePhases.push(emptyCoursePhase(phase, runners, null));
      continue;
    }

    const allCodes = collectAllCodes(def);
    const orderedForSync = resolveOrderedControls(allCodes, byCode);
    if (!orderedForSync) {
      coursePhases.push(emptyCoursePhase(phase, runners, def));
      continue;
    }

    const windows: Record<string, { fromIdx: number; toIdx: number }> = {};
    const realizedPath: Record<string, RealizedRunnerPath> = {};
    const sliced: { runner: RunnerTrack; points: TrackPoint[] }[] = [];

    for (const runner of runners) {
      const id = runner.participant.id;
      const searchFrom = rawCursors[id] ?? 0;
      const win = matchCourseGraph(
        runner.points,
        def,
        geoByCode,
        searchFrom
      );
      if (!win) {
        sliced.push({ runner, points: [] });
        continue;
      }
      rawCursors[id] = win.toIdx + 1;
      windows[id] = { fromIdx: win.fromIdx, toIdx: win.toIdx };
      realizedPath[id] = {
        codes: win.codes,
        forks: win.forks,
        punchIndices: win.punchIndices.map((i) => i - win.fromIdx),
      };
      sliced.push({
        runner,
        points: runner.points.slice(win.fromIdx, win.toIdx + 1),
      });
    }

    // Sync controls: prefer spine start (first control step) for punch strategies
    const firstSpine = def.steps.find((s) => s.type === "control");
    const syncControls =
      firstSpine && firstSpine.type === "control"
        ? resolveOrderedControls(
            [
              firstSpine.code,
              ...allCodes.filter((c) => c !== firstSpine.code),
            ],
            byCode
          ) ?? orderedForSync
        : orderedForSync;

    const sync = computeReferenceSync(
      referenceId,
      sliced.map(({ runner, points }) => ({
        id: runner.participant.id,
        points,
        strategy: (runner.participant.sync_strategy ||
          "motion_start") as SyncStrategy,
        manualDeltaMs: runner.track.start_offset_ms,
      })),
      syncControls
    );

    const synced = sliced.map(({ runner, points }) => ({
      runner,
      points: applyOffset(points, sync.offsets[runner.participant.id] ?? 0),
    }));

    const templates = legTemplatesFromCourse(def);
    const legs = templates.map((tmpl) =>
      buildLegFromTemplate(synced, tmpl, byCode, realizedPath)
    );
    const overall = buildOverallFromRealized(synced, realizedPath, byCode);

    coursePhases.push({
      id: phase.id,
      name: phase.name,
      sortOrder: phase.sort_order,
      controlCodes: allCodes,
      courseDef: def,
      overall,
      legs,
      syncOffsets: sync.offsets,
      syncDeltasMs: sync.deltasMs,
      referenceId: sync.referenceId,
      referenceWallTimeMs: sync.referenceWallTimeMs,
      windows,
      realizedPath,
    });
  }

  const first = coursePhases[0];
  return {
    coursePhases,
    overall: first?.overall ?? null,
    legs: first?.legs ?? [],
    syncOffsets: first?.syncOffsets ?? {},
    syncDeltasMs: first?.syncDeltasMs ?? {},
    referenceId: first?.referenceId ?? referenceId,
    referenceWallTimeMs: first?.referenceWallTimeMs ?? null,
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
    // Fixed locale so SSR HTML matches the client (avoid hydration mismatch).
    return new Date(ms).toLocaleString("en-GB", {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });
  } catch {
    return "—";
  }
}