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
  computeDayRaceWindow,
  computeReferenceSync,
  courseSegmentIndices,
  courseSegmentPoints,
  findPunchIndex,
  legSegmentIndices,
  legSegmentPoints,
} from "@/lib/sync";
import {
  formatSplitTime,
  formatWallTime,
  formatSignedDuration,
  parseSignedDurationToSec,
  formatLegPace,
  medalForRank,
} from "@/lib/analysis";
import { isExtraDistanceFlag, isNotableComeBack } from "@/lib/decisionQuality";
import {
  actionDeleteParticipant,
  actionRenameParticipant,
  actionSetReference,
  actionSetRunnerDelta,
  actionSetRunnerSyncStrategy,
} from "@/app/actions";
import dynamic from "next/dynamic";
import SpeedChart from "./SpeedChart";

const SessionMap = dynamic(() => import("./SessionMap"), { ssr: false });

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
}

export default function SessionWorkspace({
  event,
  map,
  controls,
  dayPhases,
  tracks: initialTracks,
  analysis,
}: Props) {
  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const s: Record<string, boolean> = {};
    for (const t of initialTracks) s[t.participant.id] = true;
    return s;
  });
  const [coursePhaseIndex, setCoursePhaseIndex] = useState(0);
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
  const playRef = useRef<number | null>(null);
  const PLAYBACK_SPEEDS = [1, 2, 5, 10, 30, 60, 120, 300] as const;

  const referenceId =
    analysis.referenceId ??
    event.reference_participant_id ??
    initialTracks[0]?.participant.id ??
    null;

  const hasGeoControls = controls.some((c) => c.lat != null && c.lon != null);

  const affine = useMemo(() => {
    if (!map) return null;
    return fitAffine(JSON.parse(map.georef_json));
  }, [map]);

  const syncedTracks = useMemo(() => {
    const withPoints = initialTracks.filter((t) => t.points.length > 0);
    const sync =
      Object.keys(analysis.syncOffsets).length > 0 &&
      analysis.syncDeltasMs !== undefined
        ? {
            offsets: analysis.syncOffsets,
            deltasMs: analysis.syncDeltasMs,
          }
        : computeReferenceSync(
            referenceId,
            withPoints.map((t) => ({
              id: t.participant.id,
              points: t.points,
              strategy: t.participant.sync_strategy,
              manualDeltaMs: t.track?.start_offset_ms ?? 0,
            })),
            controls
          );

    return withPoints.map((t) => {
      const offset = sync.offsets[t.participant.id] ?? 0;
      const refOffset = referenceId
        ? (sync.offsets[referenceId] ?? 0)
        : 0;
      // Version 2: relative clock remap vs reference (e.g. −10 min if other started 10 min later)
      const deltaMs =
        t.participant.id === referenceId ? 0 : offset - refOffset;
      return {
        ...t,
        syncedPoints: applyOffset(t.points, offset),
        offset,
        deltaMs,
      };
    });
  }, [
    initialTracks,
    analysis.syncOffsets,
    analysis.syncDeltasMs,
    referenceId,
    controls,
  ]);

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
    const tracks = syncedTracks
      .filter((t) => selected[t.participant.id] && t.syncedPoints.length > 0)
      .map((t) => ({ points: t.syncedPoints }));
    return computeDayRaceWindow(tracks, controls, dayPhases);
  }, [syncedTracks, selected, controls, dayPhases, event.race_window_enabled]);

  /** Map / fullscreen timeline: race window when enabled + punches, else full GPX. */
  const mapTimeRange = raceTimeRange ?? fullTimeRange;

  const coursePhases = analysis.coursePhases ?? [];
  const activeCourse =
    coursePhases[
      Math.min(Math.max(0, coursePhaseIndex), Math.max(0, coursePhases.length - 1))
    ] ?? null;

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
    const from = controls.find((c) => c.sequence === currentView.fromSeq);
    const to = controls.find((c) => c.sequence === currentView.toSeq);
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
    };
  }, [currentView, controls]);

  const courseCtrlPoints = useMemo(() => {
    if (!activeCourse?.controlCodes.length) return [];
    const byCode = new Map(controls.map((c) => [c.code, c]));
    const pts: { lat: number; lon: number }[] = [];
    for (const code of activeCourse.controlCodes) {
      const c = byCode.get(code);
      if (c?.lat != null && c.lon != null) pts.push({ lat: c.lat, lon: c.lon });
    }
    return pts;
  }, [activeCourse, controls]);

  /** Zoomed window for current analysis view (overall or leg). */
  const viewTimeRange = useMemo(() => {
    let minFrom = Infinity;
    let maxTo = -Infinity;
    for (const t of syncedTracks) {
      if (!selected[t.participant.id]) continue;
      const idx = viewingOverall
        ? courseSegmentIndices(t.syncedPoints, courseCtrlPoints)
        : currentLegCtrl
          ? legSegmentIndices(
              t.syncedPoints,
              currentLegCtrl.from,
              currentLegCtrl.to
            )
          : null;
      if (!idx) continue;
      minFrom = Math.min(minFrom, t.syncedPoints[idx.fromIdx].time);
      maxTo = Math.max(maxTo, t.syncedPoints[idx.toIdx].time);
    }
    if (!Number.isFinite(minFrom) || !Number.isFinite(maxTo) || maxTo <= minFrom) {
      return null;
    }
    return { min: minFrom, max: maxTo };
  }, [
    viewingOverall,
    courseCtrlPoints,
    currentLegCtrl,
    syncedTracks,
    selected,
  ]);

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

  const duration = playbackRange.max - playbackRange.min;
  const relMs = Math.max(0, replayMs - playbackRange.min);

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
      const idx = findPunchIndex(track.syncedPoints, pt, fromIdx);
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
  ]);

  useEffect(() => {
    setAnalysisIndex(-1);
  }, [coursePhaseIndex]);

  const legTracks = useMemo(() => {
    return syncedTracks
      .filter((t) => selected[t.participant.id])
      .map((t) => {
        const pts = viewingOverall
          ? courseSegmentPoints(t.syncedPoints, courseCtrlPoints)
          : currentLegCtrl
            ? legSegmentPoints(
                t.syncedPoints,
                currentLegCtrl.from,
                currentLegCtrl.to
              )
            : null;
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
    courseCtrlPoints,
    currentLegCtrl,
    syncedTracks,
    selected,
  ]);

  const storyMarkers = useMemo(() => {
    if (!currentView) return [];
    const marks: {
      key: string;
      lat: number;
      lon: number;
      kind: "hesitation" | "comeback" | "detour";
      label: string;
      color: string;
      atMs?: number;
    }[] = [];

    for (const s of currentView.splits) {
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
    return marks;
  }, [currentView, selected]);

  const speedStoryMarks = useMemo(
    () =>
      storyMarkers
        .filter((m) => m.atMs != null)
        .map((m) => ({
          key: m.key,
          timeMs: m.atMs!,
          kind: m.kind,
          label: m.label,
          color: m.color,
        })),
    [storyMarkers]
  );

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
      const seg = viewingOverall
        ? courseSegmentPoints(t.syncedPoints, courseCtrlPoints)
        : currentLegCtrl
          ? legSegmentPoints(
              t.syncedPoints,
              currentLegCtrl.from,
              currentLegCtrl.to
            )
          : null;
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

  return (
    <div className="h-[100dvh] flex flex-col">
      <header
        className={`shrink-0 border-b border-forest-200 bg-white/80 backdrop-blur px-3 sm:px-4 py-2 flex items-center gap-3 justify-between ${
          mapFullscreen ? "hidden" : ""
        }`}
      >
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <Link
            href="/"
            className="font-display text-base sm:text-lg text-forest-900 shrink-0"
          >
            VectorRun
          </Link>
          <span className="text-forest-300 hidden sm:inline">/</span>
          <h1 className="truncate font-medium text-forest-800 text-sm sm:text-base">
            {event.name}
          </h1>
        </div>
        <Link
          href={`/events/${event.id}/setup`}
          className="text-sm px-2.5 sm:px-3 py-1.5 rounded-lg border border-forest-200 hover:bg-forest-50 shrink-0"
        >
          Setup
        </Link>
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
          className={`border-r border-forest-200 bg-white/70 overflow-auto p-3 space-y-3 ${
            mobileTab === "runners" ? "flex flex-col" : "hidden"
          } lg:flex lg:flex-col`}
        >
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
                    (analysis.syncDeltasMs?.[t.participant.id] ?? 0) / 1000
                  );

              return (
                <li
                  key={t.participant.id}
                  className={`flex items-center gap-1 rounded-lg border px-1.5 py-1 group min-w-0 ${
                    isRef
                      ? "border-forest-400 bg-forest-50/80"
                      : "border-forest-200 bg-white/80"
                  }`}
                >
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
                      onBlur={(e) => {
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
                </li>
              );
            })}
          </ul>

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
        </aside>

        <div
          className={`relative min-h-0 flex-col ${
            mobileTab === "map" ? "flex min-h-[50dvh]" : "hidden"
          } lg:flex`}
        >
          <div className="relative flex-1 min-h-[40dvh] lg:min-h-0">
            <SessionMap
              bounds={bounds}
              focusBounds={legFocusBounds}
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
              resizeToken={`${mobileTab}-${mapFullscreen}`}
              mapOpacity={map?.opacity ?? 0.55}
            />
            <button
              type="button"
              onClick={() => setMapFullscreen(true)}
              className="absolute top-3 right-3 z-[1000] rounded-lg bg-white/95 border border-forest-200 shadow px-2.5 py-1.5 text-xs font-medium text-forest-800 hover:bg-forest-50"
              title="Fullscreen map"
            >
              Fullscreen
            </button>
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
              <label className="flex items-center gap-1.5 text-sm text-forest-700">
                <span className="text-[10px] uppercase tracking-wide text-forest-500 hidden sm:inline">
                  Speed
                </span>
                <select
                  value={playbackSpeed}
                  onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                  className="rounded-lg border border-forest-200 bg-white px-2 py-1.5 text-sm font-mono"
                  aria-label="Playback speed"
                >
                  {PLAYBACK_SPEEDS.map((s) => (
                    <option key={s} value={s}>
                      {s}×
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-sm text-forest-700">
                <span className="text-[10px] uppercase tracking-wide text-forest-500 hidden sm:inline">
                  Follow
                </span>
                <select
                  value={followRunnerId}
                  onChange={(e) => setFollowRunnerId(e.target.value)}
                  className="rounded-lg border border-forest-200 bg-white px-2 py-1.5 text-sm max-w-[140px]"
                  aria-label="Follow runner"
                  title="Map gently focuses each leg as this runner punches"
                >
                  <option value="">Off</option>
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
                  focusBounds={legFocusBounds}
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
                  resizeToken={`splits-${mobileTab}-${analysisIndex}`}
                  mapOpacity={map?.opacity ?? 0.55}
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
                  <select
                    value={playbackSpeed}
                    onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                    className="rounded-lg border border-forest-200 bg-white px-2 py-1.5 text-sm font-mono"
                    aria-label="Playback speed"
                  >
                    {PLAYBACK_SPEEDS.map((s) => (
                      <option key={s} value={s}>
                        {s}×
                      </option>
                    ))}
                  </select>
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
                {coursePhases.length > 0 && (
                  <select
                    className="w-full rounded-lg border border-forest-200 px-2 py-2 text-sm"
                    value={Math.min(
                      coursePhaseIndex,
                      Math.max(0, coursePhases.length - 1)
                    )}
                    onChange={(e) =>
                      setCoursePhaseIndex(Number(e.target.value))
                    }
                    aria-label="Select course phase"
                  >
                    {coursePhases.map((ph, i) => (
                      <option key={ph.id} value={i}>
                        {ph.name}
                        {ph.controlCodes.length
                          ? ` · ${ph.controlCodes.join("→")}`
                          : ""}
                      </option>
                    ))}
                  </select>
                )}

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
              focusBounds={legFocusBounds}
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
              resizeToken={`fs-${mapFullscreen}`}
              mapOpacity={map?.opacity ?? 0.55}
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
              <select
                value={playbackSpeed}
                onChange={(e) => setPlaybackSpeed(Number(e.target.value))}
                className="rounded-lg border border-forest-200 bg-white px-2 py-2 text-sm font-mono"
                aria-label="Playback speed"
              >
                {PLAYBACK_SPEEDS.map((s) => (
                  <option key={s} value={s}>
                    {s}×
                  </option>
                ))}
              </select>
              <select
                value={followRunnerId}
                onChange={(e) => setFollowRunnerId(e.target.value)}
                className="rounded-lg border border-forest-200 bg-white px-2 py-2 text-sm max-w-[140px]"
                aria-label="Follow runner"
              >
                <option value="">Follow: Off</option>
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
