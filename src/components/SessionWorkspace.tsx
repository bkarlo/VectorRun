"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type {
  AnalysisPayload,
  ControlRow,
  DayPhaseRow,
  EventRow,
  MapRow,
  ParticipantRow,
  SyncStrategy,
  TrackPoint,
  TrackRow,
} from "@/lib/types";
import { SYNC_STRATEGY_HINTS, SYNC_STRATEGY_LABELS } from "@/lib/types";
import { fitAffine, imageOverlayBounds } from "@/lib/georef";
import { DEFAULT_MAP_BOUNDS } from "@/lib/geoDefaults";
import {
  applyOffset,
  computeRaceWindow,
  computeReferenceSync,
  findPunchIndex,
  legSegmentPoints,
} from "@/lib/sync";
import { pelotonPose, runnerPose } from "@/lib/followCamera";
import {
  formatSplitTime,
  formatWallTime,
  formatSignedDuration,
  parseSignedDurationToSec,
  formatLegPace,
  medalForRank,
} from "@/lib/analysis";
import { isExtraDistanceFlag, isNotableComeBack } from "@/lib/decisionQuality";
import { haversineM } from "@/lib/gpx";
import {
  actionAppendGpxToRunner,
  actionClearPunchOverride,
  actionDeleteParticipant,
  actionFillTrackPrefix,
  actionMergeRunnerTracks,
  actionRenameParticipant,
  actionSaveDisplayOptions,
  actionSetPunchOverride,
  actionSetReference,
  actionSetRunnerDelta,
  actionSetRunnerSyncStrategy,
  actionTrimRunnerTrack,
} from "@/app/actions";
import dynamic from "next/dynamic";
import SpeedChart from "./SpeedChart";
import {
  averageSpeedMps,
  fillPreviewVertices,
  mpsToPaceMinPerKm,
  paceMinPerKmToMps,
} from "@/lib/trackRepair";

const SessionMap = dynamic(() => import("./SessionMap"), { ssr: false });

const PLAYBACK_SPEED_MIN = 1;
const PLAYBACK_SPEED_MAX = 300;

function speedToSlider(speed: number): number {
  const s = Math.min(PLAYBACK_SPEED_MAX, Math.max(PLAYBACK_SPEED_MIN, speed));
  return (
    Math.log(s / PLAYBACK_SPEED_MIN) /
    Math.log(PLAYBACK_SPEED_MAX / PLAYBACK_SPEED_MIN)
  );
}

function sliderToSpeed(t: number): number {
  const raw =
    PLAYBACK_SPEED_MIN *
    Math.pow(
      PLAYBACK_SPEED_MAX / PLAYBACK_SPEED_MIN,
      Math.min(1, Math.max(0, t))
    );
  return Math.max(1, Math.round(raw));
}

function PlaybackSpeedSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <label className="flex items-center gap-1.5 text-sm text-forest-700 min-w-0">
      <span className="text-[10px] uppercase tracking-wide text-forest-500 hidden sm:inline">
        Speed
      </span>
      <input
        type="range"
        min={0}
        max={1000}
        step={1}
        value={Math.round(speedToSlider(value) * 1000)}
        onChange={(e) => onChange(sliderToSpeed(Number(e.target.value) / 1000))}
        className="w-24 sm:w-32 accent-forest-700"
        aria-label="Playback speed"
      />
      <span className="font-mono text-xs tabular-nums w-10 shrink-0">
        {value}×
      </span>
    </label>
  );
}

type FillLegRow = { controlId: string; paceMinPerKm: string };
export interface SessionTrack {
  participant: ParticipantRow;
  track: TrackRow | null;
  points: TrackPoint[];
}

interface Props {
  event: EventRow;
  map: MapRow | null;
  controls: ControlRow[];
  dayPhases: DayPhaseRow[];
  tracks: SessionTrack[];
  analysis: AnalysisPayload;
  punchOverrides?: Record<string, Record<string, number>>;
  initialCourseId?: string | null;
  canSetup?: boolean;
}

export default function SessionWorkspace({
  event,
  map,
  controls,
  dayPhases: _dayPhases,
  tracks: initialTracks,
  analysis,
  punchOverrides = {},
  initialCourseId = null,
  canSetup = true,
}: Props) {
  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const s: Record<string, boolean> = {};
    for (const t of initialTracks) s[t.participant.id] = true;
    return s;
  });
  const coursePhases = analysis.coursePhases ?? [];
  const [coursePhaseIndex, setCoursePhaseIndex] = useState(() => {
    if (!initialCourseId) return 0;
    const i = coursePhases.findIndex((p) => p.id === initialCourseId);
    return i >= 0 ? i : 0;
  });
  const [analysisIndex, setAnalysisIndex] = useState(-1); // -1 = Overall S→F
  const [playing, setPlaying] = useState(false);
  const [replayMs, setReplayMs] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(10);
  const [followRunnerId, setFollowRunnerId] = useState<string>("");
  const [uploadStatus, setUploadStatus] = useState("");
  const [mobileTab, setMobileTab] = useState<"map" | "runners" | "splits">(
    "map"
  );
  const [mapFullscreen, setMapFullscreen] = useState(false);
  const [repairTargetId, setRepairTargetId] = useState("");
  const [mergeSourceId, setMergeSourceId] = useState("");
  const [fillLegs, setFillLegs] = useState<FillLegRow[]>([]);
  const [fillOpen, setFillOpen] = useState(false);
  const [repairPanelOpen, setRepairPanelOpen] = useState(false);
  const [repairStatus, setRepairStatus] = useState("");
  const [repairBusy, setRepairBusy] = useState(false);
  const [punchEditId, setPunchEditId] = useState("");
  const [punchEditCode, setPunchEditCode] = useState("");
  const [showBasemap, setShowBasemap] = useState(event.show_basemap !== false);
  const [showControlSymbols, setShowControlSymbols] = useState(
    event.show_control_symbols !== false
  );
  const [controlSymbolScale, setControlSymbolScale] = useState(
    event.control_symbol_scale ?? 0.7
  );
  const [showCourseLine, setShowCourseLine] = useState(
    event.show_course_line !== false
  );
  const [courseLineWeight, setCourseLineWeight] = useState(
    event.course_line_weight ?? 2
  );
  const [controlStrokeScale, setControlStrokeScale] = useState(
    event.control_stroke_scale ?? 1
  );
  const [runnerMarkerScale, setRunnerMarkerScale] = useState(
    event.runner_marker_scale ?? 1
  );
  const [trackWeight, setTrackWeight] = useState(event.track_weight ?? 3);
  const [trailTailMs, setTrailTailMs] = useState(event.trail_tail_ms ?? 0);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(1);
  const appendInputRef = useRef<HTMLInputElement>(null);
  const playRef = useRef<number | null>(null);

  const activeCourse =
    coursePhases[
      Math.min(Math.max(0, coursePhaseIndex), Math.max(0, coursePhases.length - 1))
    ] ?? null;

  const referenceId =
    activeCourse?.referenceId ??
    analysis.referenceId ??
    event.reference_participant_id ??
    initialTracks[0]?.participant.id ??
    null;

  const hasGeoControls = controls.some((c) => c.lat != null && c.lon != null);

  const affine = useMemo(() => {
    if (!map) return null;
    return fitAffine(JSON.parse(map.georef_json));
  }, [map]);

  /** Per-course sync on real-time course slices (independent Δ per course). */
  const syncedTracks = useMemo(() => {
    const withPoints = initialTracks.filter((t) => t.points.length > 0);
    const windows = activeCourse?.windows ?? {};
    const hasWindows = Object.keys(windows).length > 0;

    const slicedInputs = withPoints.map((t) => {
      const w = windows[t.participant.id];
      const points =
        w && w.toIdx >= w.fromIdx
          ? t.points.slice(w.fromIdx, w.toIdx + 1)
          : hasWindows
            ? []
            : t.points;
      return { t, points };
    });

    const offsets = activeCourse?.syncOffsets;
    const deltas = activeCourse?.syncDeltasMs;
    const sync =
      offsets && Object.keys(offsets).length > 0 && deltas !== undefined
        ? { offsets, deltasMs: deltas }
        : computeReferenceSync(
            referenceId,
            slicedInputs.map(({ t, points }) => ({
              id: t.participant.id,
              points,
              strategy: t.participant.sync_strategy,
              manualDeltaMs: t.track?.start_offset_ms ?? 0,
            })),
            controls
          );

    return slicedInputs.map(({ t, points }) => {
      const offset = sync.offsets[t.participant.id] ?? 0;
      const refOffset = referenceId ? (sync.offsets[referenceId] ?? 0) : 0;
      const deltaMs =
        t.participant.id === referenceId
          ? 0
          : (deltas?.[t.participant.id] ?? offset - refOffset);
      return {
        ...t,
        syncedPoints: applyOffset(points, offset),
        offset,
        deltaMs,
      };
    });
  }, [initialTracks, activeCourse, referenceId, controls]);

  const fullTimeRange = useMemo(() => {
    let min = Infinity;
    let max = -Infinity;
    for (const t of syncedTracks) {
      if (!selected[t.participant.id]) continue;
      if (t.syncedPoints.length === 0) continue;
      min = Math.min(min, t.syncedPoints[0].time);
      max = Math.max(max, t.syncedPoints[t.syncedPoints.length - 1].time);
    }
    if (!Number.isFinite(min)) return { min: 0, max: 1 };
    return { min, max: Math.max(max, min + 1) };
  }, [syncedTracks, selected]);

  const raceTimeRange = useMemo(() => {
    if (event.race_window_enabled === false) return null;
    // Synced tracks are already sliced to the active course window
    if (
      activeCourse &&
      Object.keys(activeCourse.windows ?? {}).length > 0
    ) {
      if (
        !Number.isFinite(fullTimeRange.min) ||
        fullTimeRange.max <= fullTimeRange.min
      ) {
        return null;
      }
      return { min: fullTimeRange.min, max: fullTimeRange.max + 1_000 };
    }
    if (!activeCourse?.controlCodes.length) return null;
    const byCode = new Map(controls.map((c) => [c.code, c]));
    const ordered: ControlRow[] = [];
    for (const code of activeCourse.controlCodes) {
      const c = byCode.get(code);
      if (c && c.lat != null && c.lon != null) ordered.push(c);
    }
    if (ordered.length < 2) return null;
    const tracks = syncedTracks
      .filter((t) => selected[t.participant.id] && t.syncedPoints.length > 0)
      .map((t) => ({ points: t.syncedPoints }));
    return computeRaceWindow(tracks, ordered);
  }, [
    syncedTracks,
    selected,
    controls,
    activeCourse,
    event.race_window_enabled,
    fullTimeRange,
  ]);

  /** Map / fullscreen timeline: active course (race window when enabled). */
  const mapTimeRange = raceTimeRange ?? fullTimeRange;

  const hasOverall = activeCourse?.overall != null;
  const activeLegs = activeCourse?.legs ?? [];
  const minAnalysisIndex = hasOverall ? -1 : 0;
  const maxAnalysisIndex =
    activeLegs.length > 0 ? activeLegs.length - 1 : minAnalysisIndex;
  const viewingOverall = analysisIndex < 0 && hasOverall;
  const currentView = viewingOverall
    ? activeCourse!.overall!
    : activeLegs[Math.max(0, analysisIndex)] ?? null;

  const currentLegCtrl = useMemo(() => {
    if (!currentView) return null;
    const from =
      controls.find((c) => c.code === currentView.fromCode) ??
      controls.find((c) => c.sequence === currentView.fromSeq);
    const to =
      controls.find((c) => c.code === currentView.toCode) ??
      controls.find((c) => c.sequence === currentView.toSeq);
    if (
      !from ||
      !to ||
      from.lat == null ||
      from.lon == null ||
      to.lat == null ||
      to.lon == null
    ) {
      return null;
    }
    return {
      from: { lat: from.lat, lon: from.lon },
      to: { lat: to.lat, lon: to.lon },
      fromCode: currentView.fromCode,
      toCode: currentView.toCode,
      armId: currentView.armId,
      forkId: currentView.forkId,
    };
  }, [currentView, controls]);

  /** Prefer realized path points for a runner (fork-aware). */
  const pointsForView = (
    participantId: string,
    syncedPoints: TrackPoint[]
  ): TrackPoint[] | null => {
    const realized = activeCourse?.realizedPath?.[participantId];
    if (viewingOverall) {
      if (realized && realized.punchIndices.length >= 2) {
        const a = realized.punchIndices[0];
        const b = realized.punchIndices[realized.punchIndices.length - 1];
        if (b > a) return syncedPoints.slice(a, b + 1);
      }
      return syncedPoints.length ? syncedPoints : null;
    }
    if (!currentView || !realized) {
      if (!currentLegCtrl) return null;
      return legSegmentPoints(
        syncedPoints,
        currentLegCtrl.from,
        currentLegCtrl.to
      );
    }
    if (
      currentView.forkId &&
      currentView.armId &&
      realized.forks[currentView.forkId] !== currentView.armId &&
      !String(realized.forks[currentView.forkId] ?? "")
        .split(",")
        .includes(currentView.armId)
    ) {
      return null;
    }
    for (let i = 0; i < realized.codes.length - 1; i++) {
      if (
        realized.codes[i] === currentView.fromCode &&
        realized.codes[i + 1] === currentView.toCode
      ) {
        const a = realized.punchIndices[i];
        const b = realized.punchIndices[i + 1];
        if (a != null && b != null && b > a) {
          return syncedPoints.slice(a, b + 1);
        }
      }
    }
    return null;
  };

  /** Zoomed window for current analysis view (overall or leg). */
  const viewTimeRange = useMemo(() => {
    let minFrom = Infinity;
    let maxTo = -Infinity;
    for (const t of syncedTracks) {
      if (!selected[t.participant.id]) continue;
      const pts = pointsForView(t.participant.id, t.syncedPoints);
      if (!pts?.length) continue;
      minFrom = Math.min(minFrom, pts[0].time);
      maxTo = Math.max(maxTo, pts[pts.length - 1].time);
    }
    if (!Number.isFinite(minFrom) || !Number.isFinite(maxTo) || maxTo <= minFrom) {
      return null;
    }
    return { min: minFrom, max: maxTo };
  }, [
    viewingOverall,
    currentView,
    currentLegCtrl,
    syncedTracks,
    selected,
    activeCourse,
  ]);

  /** Control points along a realized path (follow runner or first match). */
  const courseCtrlPoints = useMemo(() => {
    const byCode = new Map(controls.map((c) => [c.code, c]));
    const realized = activeCourse?.realizedPath ?? {};
    const id =
      (followRunnerId && realized[followRunnerId]
        ? followRunnerId
        : Object.keys(realized).find((k) => realized[k]?.codes.length)) || "";
    const codes = id
      ? realized[id].codes
      : (activeCourse?.controlCodes ?? []);
    const pts: { lat: number; lon: number }[] = [];
    for (const code of codes) {
      const c = byCode.get(code);
      if (c?.lat != null && c.lon != null) pts.push({ lat: c.lat, lon: c.lon });
    }
    return pts;
  }, [activeCourse, controls, followRunnerId]);

  const splitsPlayback =
    mobileTab === "splits" && viewTimeRange != null;
  const playbackRange = splitsPlayback ? viewTimeRange! : mapTimeRange;

  useEffect(() => {
    setReplayMs(mapTimeRange.min);
  }, [mapTimeRange.min]);

  useEffect(() => {
    if (!splitsPlayback || !viewTimeRange) return;
    setReplayMs(viewTimeRange.min);
    setPlaying(false);
  }, [splitsPlayback, viewTimeRange?.min, analysisIndex]);

  useEffect(() => {
    if (!playing) {
      if (playRef.current) cancelAnimationFrame(playRef.current);
      return;
    }
    let last = performance.now();
    const tick = (now: number) => {
      const dt = now - last;
      last = now;
      setReplayMs((t) => {
        const next = t + dt * playbackSpeed;
        if (next >= playbackRange.max) {
          setPlaying(false);
          return playbackRange.max;
        }
        return next;
      });
      playRef.current = requestAnimationFrame(tick);
    };
    playRef.current = requestAnimationFrame(tick);
    return () => {
      if (playRef.current) cancelAnimationFrame(playRef.current);
    };
  }, [playing, playbackRange.max, playbackSpeed]);

  useEffect(() => {
    if (!mapFullscreen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMapFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [mapFullscreen]);

  const bounds = useMemo(() => {
    if (affine && map) {
      return imageOverlayBounds(affine, map.width, map.height);
    }
    const pts: { lat: number; lon: number }[] = [];
    for (const c of controls) {
      if (c.lat != null && c.lon != null) pts.push({ lat: c.lat, lon: c.lon });
    }
    for (const t of syncedTracks) {
      for (const p of t.syncedPoints.slice(0, 5)) pts.push(p);
    }
    if (pts.length === 0) {
      return DEFAULT_MAP_BOUNDS;
    }
    const lats = pts.map((p) => p.lat);
    const lons = pts.map((p) => p.lon);
    return [
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)],
    ] as [[number, number], [number, number]];
  }, [affine, map, controls, syncedTracks]);

  const onGpxUpload = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploadStatus("Uploading…");
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.set("eventId", event.id);
      fd.set("file", file);
      fd.set("runnerName", file.name.replace(/\.gpx$/i, ""));
      const res = await fetch("/api/gpx/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setUploadStatus(err.error || "Upload failed");
        return;
      }
    }
    setUploadStatus("Uploaded — refreshing…");
    window.location.reload();
  };

  const geoControls = useMemo(
    () => controls.filter((c) => c.lat != null && c.lon != null),
    [controls]
  );

  const repairTarget = useMemo(() => {
    const id =
      repairTargetId ||
      initialTracks.find((t) => t.points.length > 0)?.participant.id ||
      "";
    return initialTracks.find((t) => t.participant.id === id) ?? null;
  }, [repairTargetId, initialTracks]);

  useEffect(() => {
    setTrimStart(0);
    setTrimEnd(1);
  }, [repairTarget?.participant.id]);

  const suggestedPaceMinPerKm = useMemo(() => {
    if (!repairTarget || repairTarget.points.length < 2) return "6.5";
    const pace = mpsToPaceMinPerKm(averageSpeedMps(repairTarget.points));
    return pace.toFixed(1);
  }, [repairTarget]);

  const fillPreview = useMemo(() => {
    if (
      !repairPanelOpen ||
      !fillOpen ||
      !repairTarget?.points.length ||
      fillLegs.length === 0
    ) {
      return null;
    }
    const waypoints: { lat: number; lon: number }[] = [];
    for (const leg of fillLegs) {
      const c = geoControls.find((x) => x.id === leg.controlId);
      if (!c || c.lat == null || c.lon == null) return null;
      waypoints.push({ lat: c.lat, lon: c.lon });
    }
    const first = repairTarget.points[0];
    return fillPreviewVertices(waypoints, { lat: first.lat, lon: first.lon });
  }, [repairPanelOpen, fillOpen, fillLegs, repairTarget, geoControls]);

  const openFillEditor = () => {
    setFillOpen(true);
    setFillLegs([{ controlId: geoControls[0]?.id ?? "", paceMinPerKm: suggestedPaceMinPerKm }]);
    setRepairStatus("");
  };

  const onAppendGpx = async (files: FileList | null) => {
    if (!files?.length || !repairTarget) return;
    const file = files[0];
    setRepairBusy(true);
    setRepairStatus("Appending…");
    try {
      const text = await file.text();
      const res = await actionAppendGpxToRunner(
        event.id,
        repairTarget.participant.id,
        text,
        file.name
      );
      if (!res.ok) {
        setRepairStatus(res.error);
        setRepairBusy(false);
        return;
      }
      setRepairStatus(`Merged (${res.pointCount} pts) — refreshing…`);
      window.location.reload();
    } catch (e) {
      setRepairStatus(e instanceof Error ? e.message : "Append failed");
      setRepairBusy(false);
    }
  };

  const onMergeRunner = async () => {
    if (!repairTarget || !mergeSourceId) return;
    const source = initialTracks.find(
      (t) => t.participant.id === mergeSourceId
    );
    const sourceName = source?.participant.name ?? "other runner";
    const targetName = repairTarget.participant.name;
    if (
      !window.confirm(
        `Merge into ${targetName} and remove ${sourceName}?`
      )
    ) {
      return;
    }
    setRepairBusy(true);
    setRepairStatus("Merging…");
    const res = await actionMergeRunnerTracks(
      event.id,
      repairTarget.participant.id,
      mergeSourceId
    );
    if (!res.ok) {
      setRepairStatus(res.error);
      setRepairBusy(false);
      return;
    }
    setRepairStatus(`Merged (${res.pointCount} pts) — refreshing…`);
    window.location.reload();
  };

  const onApplyFill = async () => {
    if (!repairTarget || fillLegs.length === 0) return;
    const controlIds: string[] = [];
    const speedsMps: number[] = [];
    for (const leg of fillLegs) {
      if (!leg.controlId) {
        setRepairStatus("Select a control for each leg");
        return;
      }
      const pace = Number(leg.paceMinPerKm);
      if (!Number.isFinite(pace) || pace <= 0) {
        setRepairStatus("Each leg needs a positive pace (min/km)");
        return;
      }
      controlIds.push(leg.controlId);
      speedsMps.push(paceMinPerKmToMps(pace));
    }
    setRepairBusy(true);
    setRepairStatus("Filling…");
    const res = await actionFillTrackPrefix(
      event.id,
      repairTarget.participant.id,
      controlIds,
      speedsMps
    );
    if (!res.ok) {
      setRepairStatus(res.error);
      setRepairBusy(false);
      return;
    }
    setRepairStatus(`Filled (${res.pointCount} pts) — refreshing…`);
    window.location.reload();
  };

  const onTrimTrack = async () => {
    if (!repairTarget) return;
    const a = Math.min(trimStart, trimEnd);
    const b = Math.max(trimStart, trimEnd);
    if (b - a < 0.02) {
      setRepairStatus("Keep a longer slice of the track");
      return;
    }
    setRepairBusy(true);
    setRepairStatus("Trimming…");
    const res = await actionTrimRunnerTrack(
      event.id,
      repairTarget.participant.id,
      a,
      b
    );
    if (!res.ok) {
      setRepairStatus(res.error);
      setRepairBusy(false);
      return;
    }
    setRepairStatus(`Trimmed (${res.pointCount} pts) — refreshing…`);
    window.location.reload();
  };

  const duration = playbackRange.max - playbackRange.min;
  const relMs = Math.max(0, replayMs - playbackRange.min);

  /**
   * Follow target: selected runner always; peloton centroid only while playing
   * (paused All leaves course/leg FocusBounds alone).
   */
  const followTarget = useMemo(() => {
    if (followRunnerId) {
      const track = syncedTracks.find(
        (t) => t.participant.id === followRunnerId
      );
      if (!track?.syncedPoints.length) return null;
      return runnerPose(track.syncedPoints, replayMs);
    }
    if (!playing) return null;
    const tracks = syncedTracks
      .filter((t) => selected[t.participant.id] && t.syncedPoints.length > 0)
      .map((t) => t.syncedPoints);
    if (tracks.length === 0) return null;
    return pelotonPose(tracks, replayMs);
  }, [followRunnerId, syncedTracks, replayMs, selected, playing]);

  const followPack = !followRunnerId && playing && !!followTarget;

  // Follow mode: advance leg within the active course phase
  useEffect(() => {
    if (!followRunnerId || activeLegs.length === 0 || !courseCtrlPoints.length)
      return;
    const track = syncedTracks.find(
      (t) => t.participant.id === followRunnerId
    );
    if (!track?.syncedPoints.length) return;

    const punchTimeBySeq = new Map<number, number>();
    let fromIdx = 0;
    for (const pt of courseCtrlPoints) {
      const idx = findPunchIndex(
        track.syncedPoints,
        pt,
        fromIdx,
        event.punch_radius_m
      );
      if (idx < 0) continue;
      const ctrl = controls.find(
        (c) =>
          c.lat != null &&
          c.lon != null &&
          Math.abs(c.lat - pt.lat) < 1e-9 &&
          Math.abs(c.lon - pt.lon) < 1e-9
      );
      if (ctrl) punchTimeBySeq.set(ctrl.sequence, track.syncedPoints[idx].time);
      fromIdx = idx + 1;
    }

    let active = 0;
    for (let i = 0; i < activeLegs.length; i++) {
      const leg = activeLegs[i];
      const tFrom = punchTimeBySeq.get(leg.fromSeq);
      const tTo = punchTimeBySeq.get(leg.toSeq);
      if (tFrom == null) continue;
      if (replayMs < tFrom) {
        active = i;
        break;
      }
      if (tTo == null || replayMs < tTo) {
        active = i;
        break;
      }
      active = Math.min(i + 1, activeLegs.length - 1);
    }

    setAnalysisIndex((prev) => (prev === active ? prev : active));
  }, [
    followRunnerId,
    replayMs,
    activeLegs,
    courseCtrlPoints,
    syncedTracks,
    controls,
    event.punch_radius_m,
  ]);

  useEffect(() => {
    setAnalysisIndex(-1);
  }, [coursePhaseIndex]);

  const legTracks = useMemo(() => {
    return syncedTracks
      .filter((t) => selected[t.participant.id])
      .map((t) => {
        const pts = pointsForView(t.participant.id, t.syncedPoints);
        if (!pts?.length) return null;
        return {
          id: t.participant.id,
          name: t.participant.name,
          color: t.participant.color,
          points: pts,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x != null);
  }, [
    viewingOverall,
    currentView,
    currentLegCtrl,
    syncedTracks,
    selected,
    activeCourse,
  ]);

  /** All-leg story marks (hesitation / come-back / detour); not leg-scoped. */
  const allStoryMarkers = useMemo(() => {
    const marks: {
      key: string;
      lat: number;
      lon: number;
      kind: "hesitation" | "comeback" | "detour";
      label: string;
      color: string;
      atMs?: number;
    }[] = [];

    // All legs so marks persist when switching; skip overall (would duplicate).
    const sources =
      activeLegs.length > 0
        ? activeLegs
        : activeCourse?.overall
          ? [activeCourse.overall]
          : [];

    for (const view of sources) {
      for (const s of view.splits) {
        if (!selected[s.participantId]) continue;
        for (const h of s.hesitations ?? []) {
          marks.push({
            key: `h-${s.participantId}-${h.startMs}`,
            lat: h.lat,
            lon: h.lon,
            kind: "hesitation",
            label: `${s.participantName}: hesitation ${Math.round(h.durationMs / 1000)}s`,
            color: s.color,
            atMs: h.startMs,
          });
        }
        if (isNotableComeBack(s.comeBack) && s.comeBack) {
          marks.push({
            key: `cb-${s.participantId}-${s.comeBack.atMs}`,
            lat: s.comeBack.lat,
            lon: s.comeBack.lon,
            kind: "comeback",
            label: `${s.participantName}: come-back ~${s.comeBack.extraM}m`,
            color: s.color,
            atMs: s.comeBack.atMs,
          });
        }
        for (const d of s.detours ?? []) {
          marks.push({
            key: `d-${s.participantId}-${d.startMs}`,
            lat: d.lat,
            lon: d.lon,
            kind: "detour",
            label: `${s.participantName}: detour ${d.maxDeviationM}m off best`,
            color: s.color,
            atMs: d.startMs,
          });
        }
      }
    }
    return marks;
  }, [activeCourse?.overall, activeLegs, selected]);

  /** Map: only events at or before the playhead (like the drawn trail). */
  const storyMarkers = useMemo(
    () =>
      allStoryMarkers.filter(
        (m) => m.atMs == null || m.atMs <= replayMs
      ),
    [allStoryMarkers, replayMs]
  );

  /** Speed chart: current-leg marks on the time axis (full leg, including ahead). */
  const speedStoryMarks = useMemo(() => {
    if (!currentView) return [];
    const marks: {
      key: string;
      timeMs: number;
      kind: "hesitation" | "comeback" | "detour";
      label: string;
      color: string;
    }[] = [];
    for (const s of currentView.splits) {
      if (!selected[s.participantId]) continue;
      for (const h of s.hesitations ?? []) {
        marks.push({
          key: `h-${s.participantId}-${h.startMs}`,
          timeMs: h.startMs,
          kind: "hesitation",
          label: `${s.participantName}: hesitation ${Math.round(h.durationMs / 1000)}s`,
          color: s.color,
        });
      }
      if (isNotableComeBack(s.comeBack) && s.comeBack) {
        marks.push({
          key: `cb-${s.participantId}-${s.comeBack.atMs}`,
          timeMs: s.comeBack.atMs,
          kind: "comeback",
          label: `${s.participantName}: come-back ~${s.comeBack.extraM}m`,
          color: s.color,
        });
      }
      for (const d of s.detours ?? []) {
        marks.push({
          key: `d-${s.participantId}-${d.startMs}`,
          timeMs: d.startMs,
          kind: "detour",
          label: `${s.participantName}: detour ${d.maxDeviationM}m off best`,
          color: s.color,
        });
      }
    }
    return marks;
  }, [currentView, selected]);

  const legFocusBounds = useMemo(() => {
    const pts: { lat: number; lon: number }[] = [];
    if (viewingOverall) {
      pts.push(...courseCtrlPoints);
    } else if (currentLegCtrl) {
      pts.push(currentLegCtrl.from, currentLegCtrl.to);
    } else {
      return null;
    }

    for (const t of syncedTracks) {
      if (followRunnerId) {
        if (t.participant.id !== followRunnerId) continue;
      } else if (!selected[t.participant.id]) {
        continue;
      }
      const seg = pointsForView(t.participant.id, t.syncedPoints);
      if (!seg?.length) continue;
      const step = Math.max(1, Math.floor(seg.length / 40));
      for (let i = 0; i < seg.length; i += step) {
        pts.push(seg[i]);
      }
      pts.push(seg[seg.length - 1]);
    }

    if (pts.length === 0) return null;
    const lats = pts.map((p) => p.lat);
    const lons = pts.map((p) => p.lon);
    return [
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)],
    ] as [[number, number], [number, number]];
  }, [
    viewingOverall,
    courseCtrlPoints,
    currentLegCtrl,
    syncedTracks,
    selected,
    followRunnerId,
  ]);

  const speedControlMarks = useMemo(() => {
    return [...controls]
      .filter((c) => c.lat != null && c.lon != null)
      .sort((a, b) => a.sequence - b.sequence)
      .map((c) => ({
        code: c.code,
        sequence: c.sequence,
        lat: c.lat!,
        lon: c.lon!,
      }));
  }, [controls]);

  const refWallTime =
    analysis.referenceWallTimeMs ??
    initialTracks.find((t) => t.participant.id === referenceId)?.points[0]
      ?.time ??
    null;

  const strategyOptions = (
    Object.keys(SYNC_STRATEGY_LABELS) as SyncStrategy[]
  ).filter((k) => {
    if (k === "manual") return true;
    if (
      !hasGeoControls &&
      (k === "first_control" || k === "start_punch" || k === "best_fit")
    ) {
      return false;
    }
    return true;
  });

  const handleMapPunchClick = (lat: number, lon: number) => {
    if (!canSetup || !punchEditId || !punchEditCode) return;
    const track = initialTracks.find((t) => t.participant.id === punchEditId);
    if (!track || track.points.length === 0) return;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < track.points.length; i++) {
      const d = haversineM(track.points[i], { lat, lon });
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    if (bestD > 80) return;
    void actionSetPunchOverride(
      event.id,
      punchEditId,
      punchEditCode,
      track.points[best].time
    );
  };

  const sessionMapExtras = {
    showBasemap,
    showControlSymbols,
    controlSymbolScale,
    controlStrokeScale,
    showCourseLine,
    courseLineWeight,
    courseLine: courseCtrlPoints.map(
      (p) => [p.lat, p.lon] as [number, number]
    ),
    runnerMarkerScale,
    trackWeight,
    trailTailMs,
    punchRadiusM: event.punch_radius_m,
    onTrackClick:
      canSetup && punchEditId && punchEditCode ? handleMapPunchClick : undefined,
  };

  return (
    <div className="h-[100dvh] flex flex-col">
      <header
        className={`shrink-0 border-b border-forest-200 bg-white/80 backdrop-blur px-3 sm:px-4 py-2 flex items-center gap-3 justify-between ${
          mapFullscreen ? "hidden" : ""
        }`}
      >
        <div className="flex items-center gap-2 sm:gap-3 min-w-0 flex-1">
          <Link
            href={coursePhases.length > 1 ? `/events/${event.id}` : "/"}
            className="font-display text-base sm:text-lg text-forest-900 shrink-0"
          >
            VectorRun
          </Link>
          <span className="text-forest-300 hidden sm:inline">/</span>
          <h1 className="truncate font-medium text-forest-800 text-sm sm:text-base min-w-0">
            {event.name}
          </h1>
          {coursePhases.length > 1 && (
            <>
              <span className="text-forest-300 shrink-0">/</span>
              <select
                className="min-w-0 max-w-[40vw] sm:max-w-[12rem] truncate rounded-md border border-forest-200 bg-white px-1.5 sm:px-2 py-1 text-sm text-forest-800 font-medium"
                value={Math.min(
                  coursePhaseIndex,
                  Math.max(0, coursePhases.length - 1)
                )}
                onChange={(e) => setCoursePhaseIndex(Number(e.target.value))}
                aria-label="Select course"
              >
                {coursePhases.map((ph, i) => (
                  <option key={ph.id} value={i}>
                    {ph.name}
                  </option>
                ))}
              </select>
            </>
          )}
        </div>
        {canSetup ? (
        <Link
          href={`/events/${event.id}/setup`}
          className="text-sm px-2.5 sm:px-3 py-1.5 rounded-lg border border-forest-200 hover:bg-forest-50 shrink-0"
        >
          Setup
        </Link>
        ) : null}
      </header>

      {/* Mobile tabs */}
      <nav
        className={`lg:hidden shrink-0 flex border-b border-forest-200 bg-white ${
          mapFullscreen ? "hidden" : ""
        }`}
      >
        {(
          [
            ["map", "Map"],
            ["runners", "Runners"],
            ["splits", "Results"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setMobileTab(id)}
            className={`flex-1 py-2.5 text-sm font-medium ${
              mobileTab === id
                ? "text-forest-800 border-b-2 border-forest-700"
                : "text-forest-500"
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      {!mapFullscreen && (
      <div
        className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[minmax(260px,340px)_1fr_minmax(300px,400px)]"
      >
        <aside
          className={`border-r border-forest-200 bg-white/70 min-h-0 ${
            mobileTab === "runners" ? "flex flex-col" : "hidden"
          } lg:flex lg:flex-col`}
        >
          <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-forest-600">
            Runners
          </h2>
          <ul className="space-y-1">
            {initialTracks.length === 0 && (
              <li className="text-sm text-forest-600 py-2">
                No runners yet. Upload GPX files to get started.
              </li>
            )}
            {initialTracks.map((t) => {
              const synced = syncedTracks.find(
                (s) => s.participant.id === t.participant.id
              );
              const isRef = t.participant.id === referenceId;
              const deltaSec = synced
                ? Math.round(synced.deltaMs / 1000)
                : Math.round(
                    (activeCourse?.syncDeltasMs?.[t.participant.id] ??
                      analysis.syncDeltasMs?.[t.participant.id] ??
                      0) / 1000
                  );

              return (
                <li
                  key={t.participant.id}
                  className={`flex flex-col gap-1 rounded-lg border px-1.5 py-1.5 group min-w-0 ${
                    isRef
                      ? "border-forest-400 bg-forest-50/80"
                      : "border-forest-200 bg-white/80"
                  }`}
                >
                  <div className="flex items-center gap-1 min-w-0">
                  <form action={actionSetReference} className="shrink-0">
                    <input type="hidden" name="event_id" value={event.id} />
                    <input
                      type="hidden"
                      name="participant_id"
                      value={t.participant.id}
                    />
                    <button
                      type="submit"
                      title={isRef ? "Reference runner" : "Make reference"}
                      className={`w-4 h-4 text-[11px] leading-none ${
                        isRef
                          ? "text-amber-600 font-bold"
                          : "text-forest-300 hover:text-amber-500"
                      }`}
                    >
                      ★
                    </button>
                  </form>
                  <input
                    type="checkbox"
                    className="shrink-0"
                    checked={!!selected[t.participant.id]}
                    onChange={(e) =>
                      setSelected((s) => ({
                        ...s,
                        [t.participant.id]: e.target.checked,
                      }))
                    }
                  />
                  <span
                    className="w-2 h-2 rounded-full shrink-0"
                    style={{ background: t.participant.color }}
                  />
                  <form
                    action={actionRenameParticipant}
                    className="min-w-0 flex-1"
                  >
                    <input type="hidden" name="event_id" value={event.id} />
                    <input
                      type="hidden"
                      name="participant_id"
                      value={t.participant.id}
                    />
                    <input
                      name="name"
                      defaultValue={t.participant.name}
                      className="w-full min-w-0 text-sm font-medium bg-transparent border-b border-transparent hover:border-forest-200 focus:border-forest-500 outline-none px-0.5 py-0.5 truncate"
                      readOnly={!canSetup}
                      onBlur={(e) => {
                        if (!canSetup) return;
                        if (
                          e.target.value.trim() &&
                          e.target.value.trim() !== t.participant.name
                        ) {
                          e.target.form?.requestSubmit();
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          (e.target as HTMLInputElement).blur();
                        }
                      }}
                      aria-label="Runner name"
                    />
                  </form>
                  </div>

                  <div className="flex items-center gap-1 min-w-0 flex-wrap">

                  {isRef ? (
                    <span
                      className="font-mono text-[10px] text-forest-600 shrink-0 tabular-nums max-w-[7.5rem] truncate"
                      title="Reference start (wall clock)"
                    >
                      {t.points.length
                        ? formatWallTime(
                            analysis.referenceWallTimeMs ?? t.points[0].time
                          )
                        : "—"}
                    </span>
                  ) : (
                    <>
                      <form
                        action={actionSetRunnerSyncStrategy}
                        className="shrink-0"
                      >
                        <input type="hidden" name="event_id" value={event.id} />
                        <input
                          type="hidden"
                          name="participant_id"
                          value={t.participant.id}
                        />
                        <select
                          name="sync_strategy"
                          defaultValue={t.participant.sync_strategy}
                          className="w-[5.75rem] rounded border border-forest-200 px-0.5 py-0.5 text-[10px] bg-white"
                          onChange={(e) =>
                            e.currentTarget.form?.requestSubmit()
                          }
                          title={`Sync vs reference: ${SYNC_STRATEGY_HINTS[t.participant.sync_strategy as SyncStrategy] ?? ""}`}
                        >
                          {strategyOptions.map((k) => (
                            <option
                              key={k}
                              value={k}
                              title={SYNC_STRATEGY_HINTS[k]}
                            >
                              {SYNC_STRATEGY_LABELS[k]}
                            </option>
                          ))}
                        </select>
                      </form>
                      {t.points.length > 0 && (
                        <form
                          action={actionSetRunnerDelta}
                          className="flex items-center shrink-0"
                          title="Δ vs reference clocks. Edit as −4m 1s or −241. Editing sets Manual."
                          onSubmit={(e) => {
                            const form = e.currentTarget;
                            const display = form.elements.namedItem(
                              "delta_display"
                            ) as HTMLInputElement | null;
                            const hidden = form.elements.namedItem(
                              "delta_sec"
                            ) as HTMLInputElement | null;
                            if (!display || !hidden) return;
                            const parsed = parseSignedDurationToSec(
                              display.value
                            );
                            if (parsed == null) {
                              e.preventDefault();
                              display.value = formatSignedDuration(
                                deltaSec * 1000
                              );
                              return;
                            }
                            if (parsed === deltaSec) {
                              e.preventDefault();
                              display.value = formatSignedDuration(
                                deltaSec * 1000
                              );
                              return;
                            }
                            hidden.value = String(parsed);
                          }}
                        >
                          <input
                            type="hidden"
                            name="event_id"
                            value={event.id}
                          />
                          <input
                            type="hidden"
                            name="participant_id"
                            value={t.participant.id}
                          />
                          <input type="hidden" name="delta_sec" defaultValue={deltaSec} />
                          <input
                            name="delta_display"
                            type="text"
                            defaultValue={formatSignedDuration(deltaSec * 1000)}
                            key={`${t.participant.id}-Δ-${deltaSec}-${t.participant.sync_strategy}`}
                            className="w-[4.25rem] rounded border border-forest-200 px-0.5 py-0.5 font-mono text-[11px] tabular-nums text-right"
                            onBlur={(e) => {
                              const parsed = parseSignedDurationToSec(
                                e.target.value
                              );
                              if (parsed == null) {
                                e.target.value = formatSignedDuration(
                                  deltaSec * 1000
                                );
                                return;
                              }
                              if (parsed !== deltaSec) {
                                e.target.form?.requestSubmit();
                              } else {
                                e.target.value = formatSignedDuration(
                                  deltaSec * 1000
                                );
                              }
                            }}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                (e.target as HTMLInputElement).blur();
                              }
                            }}
                          />
                        </form>
                      )}
                    </>
                  )}

                  {t.points.length > 0 && (
                    <a
                      href={`/api/gpx/${t.participant.id}`}
                      download
                      className="shrink-0 text-forest-500 hover:text-forest-800 p-0.5 opacity-70 group-hover:opacity-100"
                      title="Download GPX"
                      aria-label={`Download GPX for ${t.participant.name}`}
                    >
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                        <polyline points="7 10 12 15 17 10" />
                        <line x1="12" y1="15" x2="12" y2="3" />
                      </svg>
                    </a>
                  )}

                  {canSetup && t.points.length > 0 ? (
                    <button
                      type="button"
                      onClick={() => {
                        setPunchEditId(
                          punchEditId === t.participant.id
                            ? ""
                            : t.participant.id
                        );
                        setPunchEditCode("");
                      }}
                      className="text-[10px] text-forest-600 hover:underline shrink-0"
                      title="Override punch times"
                    >
                      Punches
                    </button>
                  ) : null}

                  {canSetup ? (
                  <form action={actionDeleteParticipant} className="shrink-0">
                    <input type="hidden" name="event_id" value={event.id} />
                    <input
                      type="hidden"
                      name="participant_id"
                      value={t.participant.id}
                    />
                    <button
                      type="submit"
                      className="opacity-0 group-hover:opacity-100 text-red-600 text-xs px-0.5"
                      title="Remove runner"
                    >
                      ×
                    </button>
                  </form>
                  ) : null}
                  </div>
                </li>
              );
            })}
          </ul>

          {canSetup ? (
            <>
          <label className="block rounded-lg border border-dashed border-forest-300 p-3 text-center text-sm cursor-pointer hover:bg-forest-50">
            Upload GPX
            <input
              type="file"
              accept=".gpx,application/gpx+xml,text/xml"
              multiple
              className="hidden"
              onChange={(e) => void onGpxUpload(e.target.files)}
            />
          </label>
          {uploadStatus && (
            <p className="text-xs text-forest-600 font-mono">{uploadStatus}</p>
          )}
            </>
          ) : null}

          {canSetup && punchEditId ? (
            <div className="rounded-lg border border-forest-200 bg-white p-3 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-forest-600">
                  Punch times ·{" "}
                  {initialTracks.find((t) => t.participant.id === punchEditId)
                    ?.participant.name ?? "runner"}
                </h3>
                <button
                  type="button"
                  className="text-xs text-forest-500"
                  onClick={() => {
                    setPunchEditId("");
                    setPunchEditCode("");
                  }}
                >
                  Close
                </button>
              </div>
              <p className="text-[11px] text-forest-600 leading-snug">
                Select a control, then Set at playhead or click the GPX on the
                map where they actually punched.
              </p>
              <ul className="space-y-1 max-h-40 overflow-auto">
                {(activeCourse?.controlCodes.length
                  ? activeCourse.controlCodes
                  : controls.map((c) => c.code)
                ).map((code) => {
                  const overridden = punchOverrides[punchEditId]?.[code];
                  const runner = syncedTracks.find(
                    (t) => t.participant.id === punchEditId
                  );
                  const realized =
                    activeCourse?.realizedPath?.[punchEditId];
                  const codeIdx = realized?.codes.indexOf(code) ?? -1;
                  const autoIdx =
                    codeIdx >= 0 ? realized?.punchIndices[codeIdx] : undefined;
                  const autoTime =
                    autoIdx != null &&
                    autoIdx >= 0 &&
                    runner?.syncedPoints[autoIdx]
                      ? runner.syncedPoints[autoIdx].time
                      : null;
                  return (
                    <li
                      key={code}
                      className={`flex items-center gap-2 text-xs ${
                        punchEditCode === code ? "font-medium" : ""
                      }`}
                    >
                      <button
                        type="button"
                        className={`rounded px-1.5 py-0.5 border ${
                          punchEditCode === code
                            ? "border-forest-600 bg-forest-100"
                            : "border-forest-200"
                        }`}
                        onClick={() => setPunchEditCode(code)}
                      >
                        {code}
                      </button>
                      <span className="font-mono text-forest-600">
                        {overridden != null
                          ? `manual ${formatWallTime(overridden)}`
                          : autoTime != null
                            ? formatSplitTime(
                                autoTime - playbackRange.min
                              )
                            : "—"}
                      </span>
                      <button
                        type="button"
                        className="ml-auto text-forest-700 hover:underline disabled:opacity-40"
                        disabled={punchEditCode !== code}
                        onClick={() => {
                          const tr = syncedTracks.find(
                            (x) => x.participant.id === punchEditId
                          );
                          if (!tr) return;
                          const raw = replayMs - tr.offset;
                          void actionSetPunchOverride(
                            event.id,
                            punchEditId,
                            code,
                            raw
                          );
                        }}
                      >
                        Set at playhead
                      </button>
                      {overridden != null ? (
                        <button
                          type="button"
                          className="text-red-600 hover:underline"
                          onClick={() =>
                            void actionClearPunchOverride(
                              event.id,
                              punchEditId,
                              code
                            )
                          }
                        >
                          Clear
                        </button>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
          </div>

          {initialTracks.some((t) => t.points.length > 0) && canSetup && (
            <div className="shrink-0 border-t border-forest-200 bg-white/90 p-2 space-y-2">
              {repairPanelOpen && (
                <div className="rounded-lg border border-forest-200 bg-white p-3 space-y-2.5 max-h-[50dvh] overflow-auto">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="text-xs font-semibold uppercase tracking-wider text-forest-600">
                      Repair track
                    </h3>
                    <button
                      type="button"
                      onClick={() => {
                        setRepairPanelOpen(false);
                        setFillOpen(false);
                        setFillLegs([]);
                        setRepairStatus("");
                      }}
                      className="text-forest-500 hover:text-forest-800 text-xs px-1"
                      title="Close repair"
                      aria-label="Close repair"
                    >
                      ×
                    </button>
                  </div>
                  <label className="block text-xs text-forest-600 space-y-1">
                    Runner
                    <select
                      className="w-full rounded-md border border-forest-200 bg-white px-2 py-1.5 text-sm text-forest-800"
                      value={
                        repairTargetId ||
                        initialTracks.find((t) => t.points.length > 0)
                          ?.participant.id ||
                        ""
                      }
                      onChange={(e) => {
                        setRepairTargetId(e.target.value);
                        setFillOpen(false);
                        setMergeSourceId("");
                        setRepairStatus("");
                      }}
                      disabled={repairBusy}
                    >
                      {initialTracks
                        .filter((t) => t.points.length > 0)
                        .map((t) => (
                          <option
                            key={t.participant.id}
                            value={t.participant.id}
                          >
                            {t.participant.name}
                          </option>
                        ))}
                    </select>
                  </label>

                  {repairTarget && repairTarget.points.length >= 2 ? (
                    <div className="rounded-md border border-forest-100 bg-forest-50/60 p-2 space-y-1.5">
                      <p className="text-[10px] uppercase tracking-wide text-forest-600">
                        Trim start / end
                      </p>
                      <label className="block text-xs text-forest-700 space-y-0.5">
                        <span className="flex justify-between gap-2">
                          <span>Keep from</span>
                          <span className="font-mono text-[10px] tabular-nums">
                            {formatWallTime(
                              repairTarget.points[0].time +
                                (repairTarget.points[
                                  repairTarget.points.length - 1
                                ].time -
                                  repairTarget.points[0].time) *
                                  Math.min(trimStart, trimEnd)
                            )}
                          </span>
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={1000}
                          step={1}
                          value={Math.round(trimStart * 1000)}
                          onChange={(e) =>
                            setTrimStart(Number(e.target.value) / 1000)
                          }
                          className="w-full accent-forest-700"
                          aria-label="Trim start"
                        />
                      </label>
                      <label className="block text-xs text-forest-700 space-y-0.5">
                        <span className="flex justify-between gap-2">
                          <span>Keep until</span>
                          <span className="font-mono text-[10px] tabular-nums">
                            {formatWallTime(
                              repairTarget.points[0].time +
                                (repairTarget.points[
                                  repairTarget.points.length - 1
                                ].time -
                                  repairTarget.points[0].time) *
                                  Math.max(trimStart, trimEnd)
                            )}
                          </span>
                        </span>
                        <input
                          type="range"
                          min={0}
                          max={1000}
                          step={1}
                          value={Math.round(trimEnd * 1000)}
                          onChange={(e) =>
                            setTrimEnd(Number(e.target.value) / 1000)
                          }
                          className="w-full accent-forest-700"
                          aria-label="Trim end"
                        />
                      </label>
                      <button
                        type="button"
                        disabled={repairBusy}
                        onClick={() => void onTrimTrack()}
                        className="w-full rounded-md bg-forest-700 text-white px-2 py-1.5 text-sm font-medium disabled:opacity-50"
                      >
                        Apply trim
                      </button>
                    </div>
                  ) : null}

                  <div className="flex flex-col gap-1.5">
                    <button
                      type="button"
                      disabled={repairBusy || !repairTarget}
                      onClick={() => appendInputRef.current?.click()}
                      className="rounded-md border border-forest-200 px-2 py-1.5 text-sm text-forest-800 hover:bg-forest-50 disabled:opacity-50"
                    >
                      Append GPX file…
                    </button>
                    <input
                      ref={appendInputRef}
                      type="file"
                      accept=".gpx,application/gpx+xml,text/xml"
                      className="hidden"
                      onChange={(e) => {
                        void onAppendGpx(e.target.files);
                        e.target.value = "";
                      }}
                    />

                    <div className="flex gap-1.5 items-stretch">
                      <select
                        className="min-w-0 flex-1 rounded-md border border-forest-200 bg-white px-2 py-1.5 text-sm text-forest-800"
                        value={mergeSourceId}
                        onChange={(e) => setMergeSourceId(e.target.value)}
                        disabled={repairBusy}
                        aria-label="Merge from runner"
                      >
                        <option value="">Merge from runner…</option>
                        {initialTracks
                          .filter(
                            (t) =>
                              t.points.length > 0 &&
                              t.participant.id !==
                                repairTarget?.participant.id
                          )
                          .map((t) => (
                            <option
                              key={t.participant.id}
                              value={t.participant.id}
                            >
                              {t.participant.name}
                            </option>
                          ))}
                      </select>
                      <button
                        type="button"
                        disabled={
                          repairBusy || !mergeSourceId || !repairTarget
                        }
                        onClick={() => void onMergeRunner()}
                        className="shrink-0 rounded-md bg-forest-700 text-white px-2.5 py-1.5 text-sm font-medium disabled:opacity-50"
                      >
                        Merge
                      </button>
                    </div>

                    {!fillOpen ? (
                      <button
                        type="button"
                        disabled={
                          repairBusy ||
                          !repairTarget ||
                          geoControls.length === 0
                        }
                        onClick={openFillEditor}
                        className="rounded-md border border-forest-200 px-2 py-1.5 text-sm text-forest-800 hover:bg-forest-50 disabled:opacity-50"
                        title={
                          geoControls.length === 0
                            ? "Place controls on the map first"
                            : undefined
                        }
                      >
                        Fill missing start…
                      </button>
                    ) : (
                      <div className="space-y-2 rounded-md border border-dashed border-teal-300 bg-teal-50/40 p-2">
                        <p className="text-[11px] text-forest-600 leading-snug">
                          Straight legs from controls to the first GPS point.
                          Pace in min/km. Dashed preview on the map.
                        </p>
                        {fillLegs.map((leg, i) => (
                          <div key={i} className="flex gap-1 items-center">
                            <select
                              className="min-w-0 flex-1 rounded border border-forest-200 bg-white px-1.5 py-1 text-xs"
                              value={leg.controlId}
                              onChange={(e) =>
                                setFillLegs((rows) =>
                                  rows.map((r, j) =>
                                    j === i
                                      ? { ...r, controlId: e.target.value }
                                      : r
                                  )
                                )
                              }
                              disabled={repairBusy}
                              aria-label={`Waypoint ${i + 1} control`}
                            >
                              <option value="">Control…</option>
                              {geoControls.map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.code}
                                </option>
                              ))}
                            </select>
                            <input
                              type="number"
                              min={1}
                              step={0.1}
                              className="w-[4.25rem] rounded border border-forest-200 px-1 py-1 text-xs font-mono tabular-nums"
                              value={leg.paceMinPerKm}
                              onChange={(e) =>
                                setFillLegs((rows) =>
                                  rows.map((r, j) =>
                                    j === i
                                      ? {
                                          ...r,
                                          paceMinPerKm: e.target.value,
                                        }
                                      : r
                                  )
                                )
                              }
                              disabled={repairBusy}
                              aria-label={`Pace min/km for leg ${i + 1}`}
                              title="min/km"
                            />
                            <span className="text-[10px] text-forest-500 shrink-0">
                              ′/km
                            </span>
                            <button
                              type="button"
                              className="text-red-600 text-xs px-0.5 disabled:opacity-40"
                              disabled={repairBusy || fillLegs.length <= 1}
                              onClick={() =>
                                setFillLegs((rows) =>
                                  rows.filter((_, j) => j !== i)
                                )
                              }
                              title="Remove leg"
                            >
                              ×
                            </button>
                          </div>
                        ))}
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            disabled={repairBusy}
                            onClick={() =>
                              setFillLegs((rows) => [
                                ...rows,
                                {
                                  controlId: geoControls[0]?.id ?? "",
                                  paceMinPerKm: suggestedPaceMinPerKm,
                                },
                              ])
                            }
                            className="rounded border border-forest-200 px-2 py-1 text-xs hover:bg-white"
                          >
                            Add leg
                          </button>
                          <button
                            type="button"
                            disabled={repairBusy}
                            onClick={() => {
                              setFillOpen(false);
                              setFillLegs([]);
                            }}
                            className="rounded border border-forest-200 px-2 py-1 text-xs hover:bg-white"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            disabled={repairBusy}
                            onClick={() => void onApplyFill()}
                            className="rounded bg-teal-700 text-white px-2 py-1 text-xs font-medium disabled:opacity-50"
                          >
                            Apply fill
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  {repairStatus && (
                    <p className="text-xs text-forest-600 font-mono">
                      {repairStatus}
                    </p>
                  )}
                </div>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() =>
                    setRepairPanelOpen((open) => {
                      if (open) {
                        setFillOpen(false);
                        setFillLegs([]);
                        setRepairStatus("");
                      }
                      return !open;
                    })
                  }
                  className={`rounded-lg border p-2 transition-colors ${
                    repairPanelOpen
                      ? "border-forest-400 bg-forest-100 text-forest-900"
                      : "border-forest-200 bg-white text-forest-600 hover:bg-forest-50 hover:text-forest-800"
                  }`}
                  title="Repair track"
                  aria-label="Repair track"
                  aria-expanded={repairPanelOpen}
                >
                  <svg
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden
                  >
                    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
                  </svg>
                </button>
              </div>
            </div>
          )}
        </aside>

        <div
          className={`relative min-h-0 flex-col ${
            mobileTab === "map" ? "flex min-h-[50dvh]" : "hidden"
          } lg:flex`}
        >
          <div className="relative flex-1 min-h-[40dvh] lg:min-h-0">
            <SessionMap
              bounds={bounds}
              focusBounds={followTarget ? null : legFocusBounds}
              followTarget={followTarget}
              followPack={followPack}
              followPlaying={playing}
              mapUrl={map ? `/api/maps/${event.id}` : null}
              mapAffine={affine}
              mapWidth={map?.width ?? 0}
              mapHeight={map?.height ?? 0}
              controls={controls}
              tracks={syncedTracks
                .filter((t) => selected[t.participant.id])
                .map((t) => ({
                  id: t.participant.id,
                  name: t.participant.name,
                  color: t.participant.color,
                  points: t.syncedPoints,
                }))}
              legTracks={legTracks}
              storyMarkers={storyMarkers}
              replayMs={replayMs}
              highlightLeg={
                currentView && !viewingOverall
                  ? { fromSeq: currentView.fromSeq, toSeq: currentView.toSeq }
                  : null
              }
              raceWindow={raceTimeRange}
              trailReveal={event.playback_trail_enabled !== false}
              resizeToken={`${mobileTab}-${mapFullscreen}`}
              mapOpacity={map?.opacity ?? 1}
              fillPreview={fillPreview}
              {...sessionMapExtras}
            />
            <div className="absolute top-3 right-3 z-[1000] flex flex-col items-end gap-2">
              <button
                type="button"
                onClick={() => setMapFullscreen(true)}
                className="rounded-lg bg-white/95 border border-forest-200 shadow px-2.5 py-1.5 text-xs font-medium text-forest-800 hover:bg-forest-50"
                title="Fullscreen map"
              >
                Fullscreen
              </button>
              <div className="rounded-lg bg-white/95 border border-forest-200 shadow px-2 py-1.5 flex flex-col gap-1 text-[11px] text-forest-800">
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showBasemap}
                    onChange={(e) => setShowBasemap(e.target.checked)}
                  />
                  Background map
                </label>
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={showControlSymbols}
                    onChange={(e) => setShowControlSymbols(e.target.checked)}
                  />
                  Control circles
                </label>
                {showControlSymbols ? (
                  <>
                    <label className="flex items-center gap-1.5">
                      Size
                      <input
                        type="range"
                        min={0.4}
                        max={1.4}
                        step={0.05}
                        value={controlSymbolScale}
                        onChange={(e) =>
                          setControlSymbolScale(parseFloat(e.target.value))
                        }
                        className="w-16"
                      />
                    </label>
                    <label className="flex items-center gap-1.5">
                      Stroke
                      <input
                        type="range"
                        min={0.4}
                        max={2.5}
                        step={0.05}
                        value={controlStrokeScale}
                        onChange={(e) =>
                          setControlStrokeScale(parseFloat(e.target.value))
                        }
                        className="w-16"
                      />
                    </label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showCourseLine}
                        onChange={(e) => setShowCourseLine(e.target.checked)}
                      />
                      Course line
                    </label>
                    {showCourseLine ? (
                      <label className="flex items-center gap-1.5">
                        Line
                        <input
                          type="range"
                          min={0.5}
                          max={6}
                          step={0.25}
                          value={courseLineWeight}
                          onChange={(e) =>
                            setCourseLineWeight(parseFloat(e.target.value))
                          }
                          className="w-16"
                        />
                      </label>
                    ) : null}
                  </>
                ) : null}
                <label className="flex items-center gap-1.5">
                  Blob
                  <input
                    type="range"
                    min={0.5}
                    max={2}
                    step={0.05}
                    value={runnerMarkerScale}
                    onChange={(e) =>
                      setRunnerMarkerScale(parseFloat(e.target.value))
                    }
                    className="w-16"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  Track
                  <input
                    type="range"
                    min={1}
                    max={8}
                    step={0.25}
                    value={trackWeight}
                    onChange={(e) => setTrackWeight(parseFloat(e.target.value))}
                    className="w-16"
                  />
                </label>
                <label className="flex items-center gap-1.5">
                  Tail
                  <input
                    type="range"
                    min={0}
                    max={180}
                    step={5}
                    value={Math.round(trailTailMs / 1000)}
                    onChange={(e) =>
                      setTrailTailMs(parseInt(e.target.value, 10) * 1000)
                    }
                    className="w-16"
                    title="Fade the trail after N seconds (0 = keep full path)"
                  />
                  <span className="font-mono text-[10px] w-8">
                    {trailTailMs <= 0 ? "all" : `${Math.round(trailTailMs / 1000)}s`}
                  </span>
                </label>
                {canSetup ? (
                  <button
                    type="button"
                    className="text-[10px] text-forest-600 hover:underline text-left"
                    onClick={() =>
                      void actionSaveDisplayOptions(event.id, {
                        show_basemap: showBasemap,
                        show_control_symbols: showControlSymbols,
                        control_symbol_scale: controlSymbolScale,
                        show_course_line: showCourseLine,
                        course_line_weight: courseLineWeight,
                        control_stroke_scale: controlStrokeScale,
                        runner_marker_scale: runnerMarkerScale,
                        track_weight: trackWeight,
                        trail_tail_ms: trailTailMs,
                      })
                    }
                  >
                    Save as default
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="shrink-0 border-t border-forest-200 bg-white/90 px-3 sm:px-4 py-2.5 sm:py-3 space-y-2">
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                className="rounded-lg bg-forest-700 text-white px-3 py-1.5 text-sm font-medium min-w-[72px]"
              >
                {playing ? "Pause" : "Play"}
              </button>
              <PlaybackSpeedSlider
                value={playbackSpeed}
                onChange={setPlaybackSpeed}
              />
              <label className="flex items-center gap-1.5 text-sm text-forest-700">
                <span className="text-[10px] uppercase tracking-wide text-forest-500 hidden sm:inline">
                  Follow
                </span>
                <select
                  value={followRunnerId}
                  onChange={(e) => setFollowRunnerId(e.target.value)}
                  className="rounded-lg border border-forest-200 bg-white px-2 py-1.5 text-sm max-w-[140px]"
                  aria-label="Follow runner"
                  title="Follow one runner, or All for the peloton"
                >
                  <option value="">All</option>
                  {syncedTracks.map((t) => (
                    <option key={t.participant.id} value={t.participant.id}>
                      {t.participant.name}
                    </option>
                  ))}
                </select>
              </label>
              <span className="font-mono text-sm text-forest-800 tabular-nums">
                {formatSplitTime(relMs)}
                <span className="text-forest-400"> / </span>
                {formatSplitTime(duration)}
              </span>
              {raceTimeRange && !splitsPlayback && (
                <span
                  className="text-[10px] uppercase tracking-wide text-forest-500"
                  title="Timeline is first course start → last course finish"
                >
                  Race
                </span>
              )}
              {refWallTime != null && (
                <span className="text-[10px] sm:text-xs text-forest-500 ml-auto font-mono truncate max-w-[40vw] sm:max-w-none">
                  Ref {formatWallTime(refWallTime)}
                </span>
              )}
            </div>
            <input
              type="range"
              min={mapTimeRange.min}
              max={mapTimeRange.max}
              step={100}
              value={Math.min(
                mapTimeRange.max,
                Math.max(mapTimeRange.min, replayMs)
              )}
              onChange={(e) => {
                setPlaying(false);
                setReplayMs(Number(e.target.value));
              }}
              className="w-full accent-forest-700"
            />
            <div className="hidden sm:block">
              <SpeedChart
                runners={syncedTracks
                  .filter((t) => selected[t.participant.id])
                  .map((t) => ({
                    id: t.participant.id,
                    name: t.participant.name,
                    color: t.participant.color,
                    points: t.syncedPoints,
                  }))}
                timeMin={mapTimeRange.min}
                timeMax={mapTimeRange.max}
                replayMs={replayMs}
                controls={speedControlMarks}
                storyMarks={speedStoryMarks}
                onSeek={(t) => {
                  setPlaying(false);
                  setReplayMs(t);
                }}
              />
            </div>
          </div>
        </div>

        <aside
          className={`border-l border-forest-200 bg-white/70 min-h-0 ${
            mobileTab === "splits"
              ? "flex flex-col overflow-hidden"
              : "hidden"
          } lg:flex lg:flex-col lg:overflow-auto`}
        >
          {/* Mobile: leg corridor map + zoomed replay */}
          {mobileTab === "splits" &&
            (activeLegs.length > 0 || hasOverall) && (
            <div className="lg:hidden shrink-0 flex flex-col border-b border-forest-200 bg-forest-50">
              <div className="relative h-[34dvh] min-h-[180px] max-h-[300px]">
                <SessionMap
                  bounds={legFocusBounds ?? bounds}
                  focusBounds={followTarget ? null : legFocusBounds}
                  followTarget={followTarget}
                  followPack={followPack}
                  followPlaying={playing}
                  mapUrl={map ? `/api/maps/${event.id}` : null}
                  mapAffine={affine}
                  mapWidth={map?.width ?? 0}
                  mapHeight={map?.height ?? 0}
                  controls={controls}
                  tracks={syncedTracks
                    .filter((t) => selected[t.participant.id])
                    .map((t) => ({
                      id: t.participant.id,
                      name: t.participant.name,
                      color: t.participant.color,
                      points: t.syncedPoints,
                    }))}
                  legTracks={legTracks}
                  storyMarkers={storyMarkers}
                  replayMs={replayMs}
                  highlightLeg={
                    currentView && !viewingOverall
                      ? {
                          fromSeq: currentView.fromSeq,
                          toSeq: currentView.toSeq,
                        }
                      : null
                  }
                  raceWindow={raceTimeRange}
                  trailReveal={event.playback_trail_enabled !== false}
                  resizeToken={`splits-${mobileTab}-${analysisIndex}`}
                  mapOpacity={map?.opacity ?? 1}
                  fillPreview={fillPreview}
              {...sessionMapExtras}
                />
              </div>
              <div className="bg-white/95 px-3 py-2 space-y-1.5 border-t border-forest-100">
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => setPlaying((p) => !p)}
                    className="rounded-lg bg-forest-700 text-white px-3 py-1.5 text-sm font-medium min-w-[72px]"
                  >
                    {playing ? "Pause" : "Play"}
                  </button>
                  <PlaybackSpeedSlider
                    value={playbackSpeed}
                    onChange={setPlaybackSpeed}
                  />
                  <span className="font-mono text-xs text-forest-800 tabular-nums">
                    {formatSplitTime(relMs)}
                    <span className="text-forest-400"> / </span>
                    {formatSplitTime(duration)}
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-forest-500 ml-auto">
                    {viewingOverall ? "Overall" : "Leg window"}
                  </span>
                </div>
                <input
                  type="range"
                  min={playbackRange.min}
                  max={playbackRange.max}
                  step={100}
                  value={Math.min(
                    playbackRange.max,
                    Math.max(playbackRange.min, replayMs)
                  )}
                  onChange={(e) => {
                    setPlaying(false);
                    setReplayMs(Number(e.target.value));
                  }}
                  className="w-full accent-forest-700"
                  aria-label="Leg timeline"
                />
              </div>
            </div>
          )}

          <div className="flex-1 min-h-0 overflow-auto p-3 space-y-3">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-forest-600">
              Analysis
            </h2>
            {activeLegs.length === 0 && !hasOverall ? (
              <p className="text-sm text-forest-600">
                {initialTracks.some((t) => t.points.length > 0)
                  ? "Tracks are ready. Add controls and define the day (Setup) to see results."
                  : "Upload GPX tracks to overlay routes. Map image is optional."}
              </p>
            ) : (
              <>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    aria-label="Previous"
                    disabled={analysisIndex <= minAnalysisIndex}
                    onClick={() =>
                      setAnalysisIndex((i) => Math.max(minAnalysisIndex, i - 1))
                    }
                    className="shrink-0 w-9 h-9 rounded-lg border border-forest-200 bg-white text-forest-800 text-lg leading-none disabled:opacity-35 disabled:pointer-events-none hover:bg-forest-50"
                  >
                    ‹
                  </button>
                  <select
                    className="min-w-0 flex-1 rounded-lg border border-forest-200 px-2 py-2 text-sm"
                    value={viewingOverall ? -1 : Math.max(0, analysisIndex)}
                    onChange={(e) => setAnalysisIndex(Number(e.target.value))}
                    aria-label="Select overall or leg"
                  >
                    {hasOverall && activeCourse?.overall && (
                      <option value={-1}>
                        Overall · {activeCourse.overall.fromCode} →{" "}
                        {activeCourse.overall.toCode}
                      </option>
                    )}
                    {activeLegs.map((leg, i) => (
                      <option key={i} value={i}>
                        {leg.armLabel ? `${leg.armLabel}: ` : ""}
                        {leg.fromCode} → {leg.toCode}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    aria-label="Next"
                    disabled={analysisIndex >= maxAnalysisIndex}
                    onClick={() =>
                      setAnalysisIndex((i) =>
                        Math.min(maxAnalysisIndex, i + 1)
                      )
                    }
                    className="shrink-0 w-9 h-9 rounded-lg border border-forest-200 bg-white text-forest-800 text-lg leading-none disabled:opacity-35 disabled:pointer-events-none hover:bg-forest-50"
                  >
                    ›
                  </button>
                </div>

                {currentView && (
                  <div className="space-y-2">
                    {currentView.splits.map((s, rank) => {
                      const pace = formatLegPace(s.timeMs, s.distanceM);
                      const medal = medalForRank(rank, s.timeMs != null);
                      const hesMs = (s.hesitations ?? []).reduce(
                        (sum, h) => sum + h.durationMs,
                        0
                      );
                      const extraDist = isExtraDistanceFlag(s.vsBest);
                      const notableCb = isNotableComeBack(s.comeBack);
                      return (
                        <div
                          key={s.participantId}
                          className="rounded-lg border border-forest-100 bg-white/80 px-2.5 py-2"
                        >
                          <div className="flex items-baseline gap-2 min-w-0">
                            <span className="font-mono text-xs text-forest-500 tabular-nums shrink-0 w-8">
                              {s.timeMs != null
                                ? `${medal ? `${medal} ` : ""}${rank + 1}`
                                : "—"}
                            </span>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium text-forest-900">
                              <span
                                className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle"
                                style={{ background: s.color }}
                              />
                              {s.participantName}
                              {!viewingOverall &&
                                currentView?.armLabel &&
                                s.timeMs != null && (
                                  <span className="ml-1.5 rounded bg-amber-100 text-amber-900 px-1 py-0.5 text-[10px] font-mono font-semibold align-middle">
                                    {currentView.armLabel}
                                  </span>
                                )}
                              {viewingOverall &&
                                (() => {
                                  const forks =
                                    activeCourse?.realizedPath?.[s.participantId]
                                      ?.forks;
                                  if (!forks || !activeCourse?.courseDef)
                                    return null;
                                  const labels: string[] = [];
                                  for (const step of activeCourse.courseDef
                                    .steps) {
                                    if (step.type !== "fork") continue;
                                    const armId = forks[step.id];
                                    if (!armId) continue;
                                    const arm = step.arms.find(
                                      (a) =>
                                        a.id === armId ||
                                        armId.split(",").includes(a.id)
                                    );
                                    if (arm) labels.push(arm.label);
                                  }
                                  if (!labels.length) return null;
                                  return (
                                    <span className="ml-1.5 rounded bg-amber-100 text-amber-900 px-1 py-0.5 text-[10px] font-mono font-semibold align-middle">
                                      {labels.join("·")}
                                    </span>
                                  );
                                })()}
                            </span>
                            <span className="font-mono text-sm tabular-nums text-forest-900 shrink-0">
                              {formatSplitTime(s.timeMs)}
                            </span>
                          </div>

                          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 pl-7 text-[11px] font-mono text-forest-600 tabular-nums">
                            <span>{pace ? `${pace}/km` : "—"}</span>
                            <span>
                              {s.distanceM != null
                                ? `${Math.round(s.distanceM)}\u00a0m`
                                : "—"}
                            </span>
                            <span>
                              {s.climbM != null
                                ? `↑${Math.round(s.climbM)}\u00a0m`
                                : "—"}
                            </span>
                          </div>

                          {(hesMs > 0 ||
                            notableCb ||
                            extraDist ||
                            (s.detours?.length ?? 0) > 0) && (
                            <div className="mt-1.5 flex flex-wrap gap-1 pl-7">
                              {hesMs > 0 && (
                                <span
                                  className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 text-amber-900 leading-none"
                                  title="Total hesitation on this leg"
                                >
                                  hes {Math.round(hesMs / 1000)}s
                                </span>
                              )}
                              {notableCb && s.comeBack && (
                                <span
                                  className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-violet-100 text-violet-900 leading-none"
                                  title="Unique come-back vs peers (fastest did not)"
                                >
                                  come-back +{s.comeBack.extraM}m
                                </span>
                              )}
                              {extraDist && s.vsBest && (
                                <span
                                  className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-rose-100 text-rose-900 leading-none"
                                  title={`vs ${s.vsBest.anchorName}`}
                                >
                                  ×{s.vsBest.distanceRatio.toFixed(2)} dist
                                </span>
                              )}
                              {(s.detours?.length ?? 0) > 0 && (
                                <span
                                  className="rounded px-1.5 py-0.5 text-[10px] font-medium bg-purple-100 text-purple-900 leading-none"
                                  title="Off the fastest runner's corridor"
                                >
                                  detour
                                </span>
                              )}
                            </div>
                          )}

                          {s.vsBest && (
                            <div
                              className="mt-1 pl-7 text-[10px] text-forest-500 font-mono truncate"
                              title={`vs ${s.vsBest.anchorName}: ${formatSignedDuration(s.vsBest.timeLossMs)}, ${
                                s.vsBest.distanceRatio >= 1
                                  ? `+${Math.round((s.vsBest.distanceRatio - 1) * 100)}%`
                                  : `${Math.round((s.vsBest.distanceRatio - 1) * 100)}%`
                              } dist`}
                            >
                              vs {s.vsBest.anchorName} (
                              {formatSignedDuration(s.vsBest.timeLossMs)},{" "}
                              {s.vsBest.distanceRatio >= 1
                                ? `+${Math.round((s.vsBest.distanceRatio - 1) * 100)}%`
                                : `${Math.round((s.vsBest.distanceRatio - 1) * 100)}%`}{" "}
                              dist)
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </aside>
      </div>
      )}

      {mapFullscreen && (
        <div className="fixed inset-0 z-[2000] bg-forest-950 flex flex-col">
          <div className="relative flex-1 min-h-0">
            <SessionMap
              bounds={bounds}
              focusBounds={followTarget ? null : legFocusBounds}
              followTarget={followTarget}
              followPack={followPack}
              followPlaying={playing}
              mapUrl={map ? `/api/maps/${event.id}` : null}
              mapAffine={affine}
              mapWidth={map?.width ?? 0}
              mapHeight={map?.height ?? 0}
              controls={controls}
              tracks={syncedTracks
                .filter((t) => selected[t.participant.id])
                .map((t) => ({
                  id: t.participant.id,
                  name: t.participant.name,
                  color: t.participant.color,
                  points: t.syncedPoints,
                }))}
              legTracks={legTracks}
              storyMarkers={storyMarkers}
              replayMs={replayMs}
              highlightLeg={
                currentView && !viewingOverall
                  ? { fromSeq: currentView.fromSeq, toSeq: currentView.toSeq }
                  : null
              }
              raceWindow={raceTimeRange}
              trailReveal={event.playback_trail_enabled !== false}
              resizeToken={`fs-${mapFullscreen}`}
              mapOpacity={map?.opacity ?? 1}
              fillPreview={fillPreview}
              {...sessionMapExtras}
            />
            <button
              type="button"
              onClick={() => setMapFullscreen(false)}
              className="absolute top-3 right-3 z-[1000] rounded-lg bg-white shadow-lg px-3 py-2 text-sm font-medium text-forest-900"
            >
              Exit
            </button>
          </div>
          <div className="shrink-0 bg-white px-3 py-3 space-y-2 safe-pb">
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                className="rounded-lg bg-forest-700 text-white px-3 py-2 text-sm font-medium min-w-[72px]"
              >
                {playing ? "Pause" : "Play"}
              </button>
              <PlaybackSpeedSlider
                value={playbackSpeed}
                onChange={setPlaybackSpeed}
              />
              <select
                value={followRunnerId}
                onChange={(e) => setFollowRunnerId(e.target.value)}
                className="rounded-lg border border-forest-200 bg-white px-2 py-2 text-sm max-w-[140px]"
                aria-label="Follow runner"
              >
                <option value="">Follow: All</option>
                {syncedTracks.map((t) => (
                  <option key={t.participant.id} value={t.participant.id}>
                    {t.participant.name}
                  </option>
                ))}
              </select>
              <span className="font-mono text-sm text-forest-800 tabular-nums">
                {formatSplitTime(relMs)}
                <span className="text-forest-400"> / </span>
                {formatSplitTime(duration)}
              </span>
              {raceTimeRange && (
                <span
                  className="text-[10px] uppercase tracking-wide text-forest-500"
                  title="Timeline is first control → last control"
                >
                  Race
                </span>
              )}
            </div>
            <input
              type="range"
              min={mapTimeRange.min}
              max={mapTimeRange.max}
              step={100}
              value={Math.min(
                mapTimeRange.max,
                Math.max(mapTimeRange.min, replayMs)
              )}
              onChange={(e) => {
                setPlaying(false);
                setReplayMs(Number(e.target.value));
              }}
              className="w-full accent-forest-700"
            />
          </div>
        </div>
      )}
    </div>
  );
}
