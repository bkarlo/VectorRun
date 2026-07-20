import { pathClimbM, pathDistanceM } from "./gpx";
import { applyOffset, computeReferenceSync, findPunchIndex } from "./sync";
import type {
  AnalysisPayload,
  ControlRow,
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

export function analyzeEvent(
  referenceId: string | null,
  controls: ControlRow[],
  runners: RunnerTrack[]
): AnalysisPayload {
  const sorted = [...controls]
    .filter((c) => c.lat != null && c.lon != null)
    .sort((a, b) => a.sequence - b.sequence);

  const sync = computeReferenceSync(
    referenceId,
    runners.map((r) => ({
      id: r.participant.id,
      points: r.points,
      strategy: (r.participant.sync_strategy || "motion_start") as SyncStrategy,
      manualDeltaMs: r.track.start_offset_ms,
    })),
    sorted
  );

  const synced: { runner: RunnerTrack; points: TrackPoint[] }[] = [];
  for (const runner of runners) {
    const finalOffset = sync.offsets[runner.participant.id] ?? 0;
    synced.push({
      runner,
      points: applyOffset(runner.points, finalOffset),
    });
  }

  const legs: AnalysisPayload["legs"] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const from = sorted[i];
    const to = sorted[i + 1];
    const splits: LegSplit[] = [];

    for (const { runner, points } of synced) {
      const fromIdx = findPunchIndex(points, {
        lat: from.lat!,
        lon: from.lon!,
      });
      let toIdx = -1;
      if (fromIdx >= 0) {
        toIdx = findPunchIndex(
          points,
          { lat: to.lat!, lon: to.lon! },
          fromIdx + 1
        );
      }

      const punchedFrom = fromIdx >= 0;
      const punchedTo = toIdx >= 0;
      let timeMs: number | null = null;
      let distanceM: number | null = null;
      let climbM: number | null = null;

      if (punchedFrom && punchedTo && toIdx > fromIdx) {
        const segment = points.slice(fromIdx, toIdx + 1);
        timeMs = points[toIdx].time - points[fromIdx].time;
        distanceM = pathDistanceM(segment);
        climbM = pathClimbM(segment);
      }

      splits.push({
        participantId: runner.participant.id,
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
      });
    }

    splits.sort((a, b) => {
      if (a.timeMs == null && b.timeMs == null) return 0;
      if (a.timeMs == null) return 1;
      if (b.timeMs == null) return -1;
      return a.timeMs - b.timeMs;
    });

    legs.push({
      fromSeq: from.sequence,
      toSeq: to.sequence,
      fromCode: from.code,
      toCode: to.code,
      splits,
    });
  }

  return {
    legs,
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

  // Plain seconds: -241, +12, 12s
  const plain = raw.match(/^([+-]?)(\d+)\s*s?$/i);
  if (plain) {
    const n = parseInt(plain[2], 10);
    return plain[1] === "-" ? -n : n;
  }

  // m:ss or -m:ss
  const colon = raw.match(/^([+-]?)(\d+):(\d{1,2})$/);
  if (colon) {
    const n = parseInt(colon[2], 10) * 60 + parseInt(colon[3], 10);
    return colon[1] === "-" ? -n : n;
  }

  // -4m 1s / +4m1s / 4m
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
