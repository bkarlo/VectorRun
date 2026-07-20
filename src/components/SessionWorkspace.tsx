"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type {
  AnalysisPayload,
  ControlRow,
  EventRow,
  MapRow,
  ParticipantRow,
  SyncStrategy,
  TrackPoint,
  TrackRow,
} from "@/lib/types";
import { SYNC_STRATEGY_LABELS } from "@/lib/types";
import { fitAffine, imageOverlayBounds } from "@/lib/georef";
import { applyOffset, computeReferenceSync } from "@/lib/sync";
import { formatSplitTime, formatWallTime, formatSignedDuration, parseSignedDurationToSec } from "@/lib/analysis";
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
  tracks: SessionTrack[];
  analysis: AnalysisPayload;
}

export default function SessionWorkspace({
  event,
  map,
  controls,
  tracks: initialTracks,
  analysis,
}: Props) {
  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const s: Record<string, boolean> = {};
    for (const t of initialTracks) s[t.participant.id] = true;
    return s;
  });
  const [legIndex, setLegIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [replayMs, setReplayMs] = useState(0);
  const [uploadStatus, setUploadStatus] = useState("");
  const playRef = useRef<number | null>(null);

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

  const timeRange = useMemo(() => {
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

  useEffect(() => {
    setReplayMs(timeRange.min);
  }, [timeRange.min]);

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
        const next = t + dt * 4;
        if (next >= timeRange.max) {
          setPlaying(false);
          return timeRange.max;
        }
        return next;
      });
      playRef.current = requestAnimationFrame(tick);
    };
    playRef.current = requestAnimationFrame(tick);
    return () => {
      if (playRef.current) cancelAnimationFrame(playRef.current);
    };
  }, [playing, timeRange.max]);

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
      return [
        [59.32, 18.05],
        [59.34, 18.08],
      ] as [[number, number], [number, number]];
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

  const currentLeg = analysis.legs[legIndex];
  const duration = timeRange.max - timeRange.min;
  const relMs = replayMs - timeRange.min;

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
      <header className="shrink-0 border-b border-forest-200 bg-white/80 backdrop-blur px-4 py-2 flex items-center gap-4 justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            href="/"
            className="font-display text-lg text-forest-900 shrink-0"
          >
            VectorRun
          </Link>
          <span className="text-forest-300">/</span>
          <h1 className="truncate font-medium text-forest-800">{event.name}</h1>
        </div>
        <Link
          href={`/events/${event.id}/setup`}
          className="text-sm px-3 py-1.5 rounded-lg border border-forest-200 hover:bg-forest-50"
        >
          Setup
        </Link>
      </header>

      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-[380px_1fr_300px]">
        <aside className="border-r border-forest-200 bg-white/70 overflow-auto p-3 space-y-3">
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
                          title="Sync strategy vs reference"
                        >
                          {strategyOptions.map((k) => (
                            <option key={k} value={k}>
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

        <div className="relative min-h-[320px] flex flex-col">
          <div className="flex-1 min-h-0">
            <SessionMap
              bounds={bounds}
              mapUrl={map ? `/api/maps/${event.id}` : null}
              mapImageBounds={
                affine && map
                  ? imageOverlayBounds(affine, map.width, map.height)
                  : null
              }
              controls={controls}
              tracks={syncedTracks
                .filter((t) => selected[t.participant.id])
                .map((t) => ({
                  id: t.participant.id,
                  name: t.participant.name,
                  color: t.participant.color,
                  points: t.syncedPoints,
                }))}
              replayMs={replayMs}
              highlightLeg={
                currentLeg
                  ? { fromSeq: currentLeg.fromSeq, toSeq: currentLeg.toSeq }
                  : null
              }
            />
          </div>

          <div className="shrink-0 border-t border-forest-200 bg-white/90 px-4 py-3 space-y-2">
            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="button"
                onClick={() => setPlaying((p) => !p)}
                className="rounded-lg bg-forest-700 text-white px-3 py-1.5 text-sm font-medium min-w-[72px]"
              >
                {playing ? "Pause" : "Play"}
              </button>
              <span className="font-mono text-sm text-forest-800 tabular-nums">
                {formatSplitTime(relMs)}
                <span className="text-forest-400"> / </span>
                {formatSplitTime(duration)}
              </span>
              {refWallTime != null && (
                <span className="text-xs text-forest-500 ml-auto font-mono">
                  Ref start {formatWallTime(refWallTime)}
                </span>
              )}
            </div>
            <input
              type="range"
              min={timeRange.min}
              max={timeRange.max}
              step={100}
              value={replayMs}
              onChange={(e) => {
                setPlaying(false);
                setReplayMs(Number(e.target.value));
              }}
              className="w-full accent-forest-700"
            />
            <SpeedChart
              runners={syncedTracks
                .filter((t) => selected[t.participant.id])
                .map((t) => ({
                  id: t.participant.id,
                  name: t.participant.name,
                  color: t.participant.color,
                  points: t.syncedPoints,
                }))}
              timeMin={timeRange.min}
              timeMax={timeRange.max}
              replayMs={replayMs}
              onSeek={(t) => {
                setPlaying(false);
                setReplayMs(t);
              }}
            />
          </div>
        </div>

        <aside className="border-l border-forest-200 bg-white/70 overflow-auto p-3 space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-forest-600">
            Leg analysis
          </h2>
          {analysis.legs.length === 0 ? (
            <p className="text-sm text-forest-600">
              {initialTracks.some((t) => t.points.length > 0)
                ? "Tracks are ready. Add controls with GPS to see leg splits. Replay works without controls."
                : "Upload GPX tracks to overlay routes. Map image is optional."}
            </p>
          ) : (
            <>
              <select
                className="w-full rounded-lg border border-forest-200 px-2 py-1.5 text-sm"
                value={legIndex}
                onChange={(e) => setLegIndex(Number(e.target.value))}
              >
                {analysis.legs.map((leg, i) => (
                  <option key={i} value={i}>
                    {leg.fromCode} → {leg.toCode}
                  </option>
                ))}
              </select>

              {currentLeg && (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-forest-500 border-b border-forest-200">
                      <th className="py-1 pr-2">#</th>
                      <th className="py-1 pr-2">Runner</th>
                      <th className="py-1 pr-2">Time</th>
                      <th className="py-1 pr-2">Dist</th>
                      <th className="py-1">Climb</th>
                    </tr>
                  </thead>
                  <tbody>
                    {currentLeg.splits.map((s, rank) => (
                      <tr
                        key={s.participantId}
                        className="border-b border-forest-100"
                      >
                        <td className="py-1.5 pr-2 font-mono text-forest-500">
                          {s.timeMs != null ? rank + 1 : "—"}
                        </td>
                        <td className="py-1.5 pr-2">
                          <span
                            className="inline-block w-2 h-2 rounded-full mr-1.5"
                            style={{ background: s.color }}
                          />
                          {s.participantName}
                        </td>
                        <td className="py-1.5 pr-2 font-mono">
                          {formatSplitTime(s.timeMs)}
                        </td>
                        <td className="py-1.5 pr-2 font-mono">
                          {s.distanceM != null
                            ? `${Math.round(s.distanceM)} m`
                            : "—"}
                        </td>
                        <td className="py-1.5 font-mono">
                          {s.climbM != null
                            ? `${Math.round(s.climbM)} m`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
