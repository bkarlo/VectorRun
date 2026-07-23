"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { DayPhaseKind, GeorefPair, TrackPoint } from "@/lib/types";
import {
  collectAllCodes,
  courseDefFromCodes,
  type CourseDef,
  validateCourseDef,
} from "@/lib/courseDef";
import CourseChainEditor from "./CourseChainEditor";
import {
  actionSaveGeoref,
  actionSaveControls,
  actionSaveDayPlan,
  actionSaveMapOpacity,
  actionSaveRaceWindow,
} from "@/app/actions";
import { fitAffine, gpsToMap } from "@/lib/georef";
import { trackTouchesControl } from "@/lib/sync";

const GpsControlMap = dynamic(() => import("./GpsControlMap"), { ssr: false });
const MapOverlayFit = dynamic(() => import("./MapOverlayFit"), { ssr: false });

interface ControlDraft {
  code: string;
  sequence: number;
  lat: number | null;
  lon: number | null;
  map_x: number | null;
  map_y: number | null;
}

export interface SetupTrack {
  id: string;
  name: string;
  color: string;
  points: TrackPoint[];
}

interface Props {
  eventId: string;
  eventName: string;
  exerciseType: string;
  hasMap: boolean;
  mapWidth: number;
  mapHeight: number;
  initialGeoref: GeorefPair[];
  initialControls: ControlDraft[];
  tracks: SetupTrack[];
  initialMapOpacity?: number;
  initialRaceWindowEnabled?: boolean;
  initialDayPhases?: {
    kind: DayPhaseKind;
    name: string;
    controlCodes: string[];
    courseDef?: CourseDef | null;
  }[];
}

type Mode = "place" | "points" | "controls" | "day";

interface DayPhaseDraft {
  kind: DayPhaseKind;
  name: string;
  courseDef: CourseDef;
}

function draftFromInitial(p: {
  kind: DayPhaseKind;
  name: string;
  controlCodes: string[];
  courseDef?: CourseDef | null;
}): DayPhaseDraft {
  const courseDef =
    p.kind === "course"
      ? p.courseDef?.steps.length
        ? p.courseDef
        : courseDefFromCodes(p.controlCodes)
      : { version: 1 as const, steps: [] };
  return { kind: p.kind, name: p.name, courseDef };
}

export default function SetupWizard(props: Props) {
  const [mapUrl, setMapUrl] = useState(
    props.hasMap ? `/api/maps/${props.eventId}?t=${Date.now()}` : null
  );
  const [mapSize, setMapSize] = useState({
    w: props.mapWidth || 0,
    h: props.mapHeight || 0,
  });
  const [tracks] = useState(props.tracks);
  const [mode, setMode] = useState<Mode>(() => {
    if (props.initialControls.some((c) => c.lat != null && c.lon != null)) {
      return "controls";
    }
    if (mapUrl) return "place";
    return "controls";
  });
  const [georef, setGeoref] = useState<GeorefPair[]>(props.initialGeoref);
  const [controls, setControls] = useState<ControlDraft[]>(
    props.initialControls
  );
  const [status, setStatus] = useState("");
  const [pendingGps, setPendingGps] = useState({ lat: "", lon: "" });
  const [focusCodeIndex, setFocusCodeIndex] = useState<number | null>(null);
  const [gpxStatus, setGpxStatus] = useState("");
  const [sessionMapOpacity, setSessionMapOpacity] = useState(
    props.initialMapOpacity ?? 0.55
  );
  const [opacityStatus, setOpacityStatus] = useState("");
  const [raceWindowEnabled, setRaceWindowEnabled] = useState(
    props.initialRaceWindowEnabled !== false
  );
  const [raceWindowStatus, setRaceWindowStatus] = useState("");
  const [dayPhases, setDayPhases] = useState<DayPhaseDraft[]>(() =>
    props.initialDayPhases?.length
      ? props.initialDayPhases.map(draftFromInitial)
      : []
  );
  const [dayStatus, setDayStatus] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);
  const codeInputRefs = useRef<(HTMLInputElement | null)[]>([]);

  useEffect(() => {
    if (focusCodeIndex == null) return;
    const el = codeInputRefs.current[focusCodeIndex];
    if (!el) return;
    el.focus();
    el.select();
    setFocusCodeIndex(null);
  }, [focusCodeIndex, controls.length]);

  const onUploadMap = async (file: File) => {
    setStatus("Uploading map…");
    const img = new Image();
    const url = URL.createObjectURL(file);
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("Invalid image"));
      img.src = url;
    });
    const fd = new FormData();
    fd.set("eventId", props.eventId);
    fd.set("file", file);
    fd.set("width", String(img.naturalWidth));
    fd.set("height", String(img.naturalHeight));
    const res = await fetch("/api/maps/upload", { method: "POST", body: fd });
    URL.revokeObjectURL(url);
    if (!res.ok) {
      setStatus("Upload failed");
      return;
    }
    setMapSize({ w: img.naturalWidth, h: img.naturalHeight });
    setMapUrl(`/api/maps/${props.eventId}?t=${Date.now()}`);
    setMode("place");
    setStatus(
      tracks.length
        ? "Map uploaded — pick 3 points on the image, then place them on OSM"
        : "Map uploaded — upload GPX tracks, then georeference with 3 points"
    );
  };

  const onUploadGpx = async (files: FileList | null) => {
    if (!files?.length) return;
    setGpxStatus("Uploading GPX…");
    for (const file of Array.from(files)) {
      const fd = new FormData();
      fd.set("eventId", props.eventId);
      fd.set("file", file);
      fd.set("runnerName", file.name.replace(/\.gpx$/i, ""));
      const res = await fetch("/api/gpx/upload", { method: "POST", body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setGpxStatus(err.error || "GPX upload failed");
        return;
      }
    }
    setGpxStatus(`Uploaded ${files.length} file(s). Reloading tracks…`);
    // Soft refresh so overlay sees new tracks
    window.location.reload();
  };

  const clickToMapPx = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const img = imgRef.current;
      if (!img || !mapSize.w) return null;
      const rect = img.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * mapSize.w;
      const y = ((e.clientY - rect.top) / rect.height) * mapSize.h;
      return { x, y };
    },
    [mapSize.w, mapSize.h]
  );

  const placeControlAtGps = (lat: number, lon: number) => {
    const transform = fitAffine(georef);
    const mapPx = transform ? gpsToMap(transform, { lat, lon }) : null;
    setControls((prev) => {
      const sequence =
        prev.length === 0
          ? 0
          : Math.max(...prev.map((c) => c.sequence), -1) + 1;
      const list = [
        ...prev,
        {
          code: "",
          sequence,
          lat,
          lon,
          map_x: mapPx?.x ?? null,
          map_y: mapPx?.y ?? null,
        },
      ];
      setFocusCodeIndex(list.length - 1);
      setStatus(`Point #${list.length} placed — type its number`);
      return list;
    });
  };

  const onImageClick = (e: React.MouseEvent<HTMLImageElement>) => {
    const px = clickToMapPx(e);
    if (!px) return;

    if (mode === "points") {
      const lat = parseFloat(pendingGps.lat);
      const lon = parseFloat(pendingGps.lon);
      if (Number.isNaN(lat) || Number.isNaN(lon)) {
        setStatus("Enter lat/lon for this georef point first");
        return;
      }
      const next = [...georef, { map: px, gps: { lat, lon } }];
      setGeoref(next);
      setPendingGps({ lat: "", lon: "" });
      setStatus(`Georef point ${next.length} added`);
    }
  };

  const saveOverlayGeoref = async (pairs: GeorefPair[]) => {
    setGeoref(pairs);
    await actionSaveGeoref(props.eventId, pairs);
    setStatus(`Saved map placement (${pairs.length} corners)`);
  };

  const saveGeoref = async () => {
    await actionSaveGeoref(props.eventId, georef);
    setStatus(`Saved ${georef.length} georef points`);
  };

  const saveControls = async () => {
    await actionSaveControls(props.eventId, controls);
    setStatus("Controls saved");
  };

  const saveDay = async () => {
    const geo = new Set(
      controls
        .filter((c) => c.code.trim() && c.lat != null && c.lon != null)
        .map((c) => c.code)
    );
    for (const p of dayPhases) {
      if (p.kind !== "course") continue;
      const err = validateCourseDef(p.courseDef, geo);
      if (err) {
        setDayStatus(`${p.name}: ${err}`);
        return;
      }
    }
    await actionSaveDayPlan(
      props.eventId,
      dayPhases.map((p) => ({
        kind: p.kind,
        name: p.name,
        courseDef: p.kind === "course" ? p.courseDef : null,
        controlCodes:
          p.kind === "course" ? collectAllCodes(p.courseDef) : [],
      }))
    );
    setDayStatus("Day plan saved");
  };

  const controlCodeOptions = controls
    .filter((c) => c.code.trim())
    .map((c) => c.code);

  const placedGpsControls = controls
    .filter((c) => c.lat != null && c.lon != null)
    .map((c) => ({
      code: c.code,
      sequence: c.sequence,
      lat: c.lat!,
      lon: c.lon!,
    }));

  return (
    <div className="space-y-6">
      <div className="panel rounded-xl p-4 border-forest-300 bg-forest-50/80">
        <h3 className="font-display text-lg text-forest-900 mb-1">
          Tracks first, map later
        </h3>
        <p className="text-sm text-forest-600 mb-3">
          Upload GPX anytime. When you add a map image, pick 3 clear features on
          the map and drag those points onto OSM/tracks to lock the georeference.
        </p>
        <div className="flex flex-wrap gap-2 items-center">
          <label className="rounded-lg bg-forest-700 text-white px-4 py-2 cursor-pointer hover:bg-forest-800 text-sm font-medium">
            Upload GPX
            <input
              type="file"
              accept=".gpx,application/gpx+xml,text/xml"
              multiple
              className="hidden"
              onChange={(e) => void onUploadGpx(e.target.files)}
            />
          </label>
          <label className="rounded-lg border border-forest-300 bg-white px-4 py-2 cursor-pointer hover:bg-forest-50 text-sm font-medium">
            {mapUrl ? "Replace map image" : "Upload map image"}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void onUploadMap(f);
              }}
            />
          </label>
          <Link
            href={`/events/${props.eventId}`}
            className="rounded-lg border border-forest-300 bg-white px-4 py-2 text-sm font-medium hover:bg-forest-50"
          >
            Open session →
          </Link>
          {tracks.length > 0 && (
            <span className="text-sm text-forest-600 font-mono">
              {tracks.length} track(s)
            </span>
          )}
          {gpxStatus && (
            <span className="text-sm text-forest-600 font-mono">{gpxStatus}</span>
          )}
        </div>
      </div>

      {mapUrl && (
        <div className="panel rounded-xl p-4 flex flex-wrap items-center gap-3">
          <div className="min-w-0">
            <h3 className="font-display text-base text-forest-900">
              Session map opacity
            </h3>
            <p className="text-xs text-forest-600">
              How strong the orienteering map appears in the session view
              (tracks stay on top).
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm text-forest-700 ml-auto">
            <input
              type="range"
              min={0.15}
              max={0.9}
              step={0.05}
              value={sessionMapOpacity}
              onChange={(e) =>
                setSessionMapOpacity(parseFloat(e.target.value))
              }
              className="w-36"
            />
            <span className="font-mono text-xs w-8">
              {Math.round(sessionMapOpacity * 100)}%
            </span>
          </label>
          <button
            type="button"
            className="rounded-lg bg-forest-700 text-white px-3 py-1.5 text-sm font-medium"
            onClick={() => {
              void actionSaveMapOpacity(props.eventId, sessionMapOpacity).then(
                () => setOpacityStatus("Saved")
              );
            }}
          >
            Save opacity
          </button>
          {opacityStatus && (
            <span className="text-xs font-mono text-forest-600">
              {opacityStatus}
            </span>
          )}
        </div>
      )}

      <div className="panel rounded-xl p-4 flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-base text-forest-900">
            Race window
          </h3>
          <p className="text-xs text-forest-600">
            Scope the session timeline from the first course start to the last
            course finish (includes rest between courses; dims walk-in/out).
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-forest-800 cursor-pointer">
          <input
            type="checkbox"
            className="rounded border-forest-300"
            checked={raceWindowEnabled}
            onChange={(e) => {
              const next = e.target.checked;
              setRaceWindowEnabled(next);
              void actionSaveRaceWindow(props.eventId, next).then(() =>
                setRaceWindowStatus(next ? "On" : "Off")
              );
            }}
          />
          <span className="font-medium">Enabled</span>
        </label>
        {raceWindowStatus && (
          <span className="text-xs font-mono text-forest-600">
            {raceWindowStatus}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        <div className="flex rounded-lg border border-forest-200 overflow-hidden text-sm">
          <button
            type="button"
            disabled={!mapUrl}
            className={`px-3 py-2 disabled:opacity-40 ${
              mode === "place" ? "bg-forest-100 font-medium" : "bg-white"
            }`}
            onClick={() => setMode("place")}
            title={!mapUrl ? "Upload a map image first" : undefined}
          >
            Place map
          </button>
          <button
            type="button"
            disabled={!mapUrl}
            className={`px-3 py-2 disabled:opacity-40 ${
              mode === "points" ? "bg-forest-100 font-medium" : "bg-white"
            }`}
            onClick={() => setMode("points")}
            title="Advanced: click lat/lon pairs"
          >
            Point georef
          </button>
          <button
            type="button"
            className={`px-3 py-2 ${
              mode === "controls" ? "bg-forest-100 font-medium" : "bg-white"
            }`}
            onClick={() => setMode("controls")}
          >
            Controls
          </button>
          <button
            type="button"
            className={`px-3 py-2 ${
              mode === "day" ? "bg-forest-100 font-medium" : "bg-white"
            }`}
            onClick={() => setMode("day")}
            title="Walk-in, courses, rest, walk-back"
          >
            Define the day
          </button>
        </div>
        {status && (
          <span className="text-sm text-forest-600 font-mono">{status}</span>
        )}
      </div>

      {mode === "day" ? (
        <div className="panel rounded-xl p-4 space-y-4">
          <div>
            <h3 className="font-display text-lg text-forest-900">
              Define the day
            </h3>
            <p className="text-sm text-forest-600 mt-1">
              Order the session as a timeline. Courses show as a compact chain
              (S → (1A|1B) → 2 → F); use Edit chain to reorder, add controls, or
              expand forks.
            </p>
          </div>

          {controlCodeOptions.length < 2 && (
            <p className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Add at least two named controls (with GPS) before creating course
              phases.
            </p>
          )}

          <ul className="space-y-3">
            {dayPhases.map((phase, i) => (
              <li
                key={i}
                className="rounded-lg border border-forest-200 bg-white p-3 space-y-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-forest-500 w-6">
                    {i + 1}.
                  </span>
                  <select
                    className="rounded border border-forest-200 px-2 py-1.5 text-sm"
                    value={phase.kind}
                    onChange={(e) => {
                      const kind = e.target.value as DayPhaseKind;
                      setDayPhases((prev) =>
                        prev.map((p, j) =>
                          j === i
                            ? {
                                ...p,
                                kind,
                                courseDef:
                                  kind === "course"
                                    ? p.courseDef.steps.length
                                      ? p.courseDef
                                      : courseDefFromCodes([])
                                    : { version: 1, steps: [] },
                              }
                            : p
                        )
                      );
                    }}
                  >
                    <option value="transit">Walk / transit</option>
                    <option value="rest">Rest at base</option>
                    <option value="course">Course</option>
                  </select>
                  <input
                    className="min-w-0 flex-1 rounded border border-forest-200 px-2 py-1.5 text-sm"
                    value={phase.name}
                    onChange={(e) => {
                      const name = e.target.value;
                      setDayPhases((prev) =>
                        prev.map((p, j) => (j === i ? { ...p, name } : p))
                      );
                    }}
                    placeholder="Name"
                  />
                  <button
                    type="button"
                    className="text-xs text-forest-600 px-2 py-1 disabled:opacity-30"
                    disabled={i === 0}
                    onClick={() =>
                      setDayPhases((prev) => {
                        if (i <= 0) return prev;
                        const next = [...prev];
                        const tmp = next[i - 1];
                        next[i - 1] = next[i];
                        next[i] = tmp;
                        return next;
                      })
                    }
                  >
                    Up
                  </button>
                  <button
                    type="button"
                    className="text-xs text-forest-600 px-2 py-1 disabled:opacity-30"
                    disabled={i >= dayPhases.length - 1}
                    onClick={() =>
                      setDayPhases((prev) => {
                        if (i >= prev.length - 1) return prev;
                        const next = [...prev];
                        const tmp = next[i];
                        next[i] = next[i + 1];
                        next[i + 1] = tmp;
                        return next;
                      })
                    }
                  >
                    Down
                  </button>
                  <button
                    type="button"
                    className="text-red-600 text-sm px-2"
                    onClick={() =>
                      setDayPhases((prev) => prev.filter((_, j) => j !== i))
                    }
                  >
                    ×
                  </button>
                </div>

                {phase.kind === "course" && (
                  <div className="pl-8 pt-0.5">
                    <CourseChainEditor
                      def={phase.courseDef}
                      controlCodes={controlCodeOptions}
                      onChange={(courseDef) =>
                        setDayPhases((prev) =>
                          prev.map((p, j) =>
                            j === i ? { ...p, courseDef } : p
                          )
                        )
                      }
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded-lg border border-forest-200 px-3 py-1.5 text-sm"
              onClick={() =>
                setDayPhases((prev) => [
                  ...prev,
                  {
                    kind: "transit",
                    name: "Walk there",
                    courseDef: { version: 1, steps: [] },
                  },
                ])
              }
            >
              + Walk
            </button>
            <button
              type="button"
              className="rounded-lg border border-forest-200 px-3 py-1.5 text-sm"
              onClick={() =>
                setDayPhases((prev) => [
                  ...prev,
                  {
                    kind: "rest",
                    name: "Rest",
                    courseDef: { version: 1, steps: [] },
                  },
                ])
              }
            >
              + Rest
            </button>
            <button
              type="button"
              className="rounded-lg border border-forest-200 px-3 py-1.5 text-sm"
              onClick={() =>
                setDayPhases((prev) => [
                  ...prev,
                  {
                    kind: "course",
                    name: `Course ${prev.filter((p) => p.kind === "course").length + 1}`,
                    courseDef: courseDefFromCodes([]),
                  },
                ])
              }
            >
              + Course
            </button>
            <button
              type="button"
              className="rounded-lg bg-forest-700 text-white px-4 py-1.5 text-sm font-medium ml-auto"
              onClick={() => void saveDay()}
            >
              Save day plan
            </button>
            {dayStatus && (
              <span className="text-xs font-mono text-forest-600 self-center">
                {dayStatus}
              </span>
            )}
          </div>
        </div>
      ) : mode === "place" && mapUrl && mapSize.w > 0 ? (
        <div className="panel rounded-xl p-4">
          <MapOverlayFit
            key={mapUrl}
            mapUrl={mapUrl}
            mapWidth={mapSize.w}
            mapHeight={mapSize.h}
            tracks={tracks}
            initialGeoref={georef}
            onSave={saveOverlayGeoref}
          />
          {tracks.length === 0 && (
            <p className="text-sm text-amber-800 mt-3 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              No tracks yet — upload GPX above so you can align the map to
              runners. You can still place and save a rough position.
            </p>
          )}
        </div>
      ) : (
        <div className="grid lg:grid-cols-[1fr_320px] gap-6">
          <div className="panel rounded-xl overflow-hidden relative min-h-[420px] bg-forest-100">
            {mode === "points" && mapUrl ? (
              <>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  ref={imgRef}
                  src={mapUrl}
                  alt="Orienteering map"
                  className="w-full h-auto cursor-crosshair select-none"
                  onClick={onImageClick}
                  draggable={false}
                />
                {mapSize.w > 0 && imgRef.current && (
                  <MapMarkers
                    georef={georef}
                    controls={controls}
                    mode={mode}
                    mapW={mapSize.w}
                    mapH={mapSize.h}
                    img={imgRef.current}
                  />
                )}
              </>
            ) : mode === "controls" ? (
              <GpsControlMap
                controls={placedGpsControls}
                tracks={tracks}
                onPlace={placeControlAtGps}
                mapUrl={mapUrl}
                mapWidth={mapSize.w}
                mapHeight={mapSize.h}
                georef={georef}
              />
            ) : (
              <div className="flex items-center justify-center h-[420px] text-forest-600 px-6 text-center">
                Upload a map image to place it over OSM, or stay on Controls.
              </div>
            )}
          </div>

          <aside className="space-y-4">
            {mode === "points" && mapUrl ? (
              <div className="panel rounded-xl p-4 space-y-3">
                <h3 className="font-display text-lg">Point georeference</h3>
                <p className="text-sm text-forest-600">
                  Advanced fallback: enter GPS, click the matching spot on the
                  map image. Prefer <em>Place map</em> when you have tracks.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <label className="text-xs">
                    Latitude
                    <input
                      className="mt-1 w-full rounded border border-forest-200 px-2 py-1.5"
                      value={pendingGps.lat}
                      onChange={(e) =>
                        setPendingGps((p) => ({ ...p, lat: e.target.value }))
                      }
                      placeholder="47.576"
                    />
                  </label>
                  <label className="text-xs">
                    Longitude
                    <input
                      className="mt-1 w-full rounded border border-forest-200 px-2 py-1.5"
                      value={pendingGps.lon}
                      onChange={(e) =>
                        setPendingGps((p) => ({ ...p, lon: e.target.value }))
                      }
                      placeholder="18.878"
                    />
                  </label>
                </div>
                <ul className="text-sm space-y-1 max-h-40 overflow-auto font-mono">
                  {georef.map((g, i) => (
                    <li key={i} className="flex justify-between gap-2">
                      <span>
                        #{i + 1} ({g.map.x.toFixed(0)},{g.map.y.toFixed(0)}) →{" "}
                        {g.gps.lat.toFixed(5)},{g.gps.lon.toFixed(5)}
                      </span>
                      <button
                        type="button"
                        className="text-red-600"
                        onClick={() =>
                          setGeoref((prev) => prev.filter((_, j) => j !== i))
                        }
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
                <button
                  type="button"
                  onClick={() => void saveGeoref()}
                  disabled={georef.length < 3}
                  className="w-full rounded-lg bg-forest-700 text-white py-2 disabled:opacity-40"
                >
                  Save georef ({georef.length}/3+)
                </button>
              </div>
            ) : (
              <div className="panel rounded-xl p-4 space-y-3">
                <h3 className="font-display text-lg">Course controls</h3>
                <p className="text-sm text-forest-600">
                  Click the map in course order (start → … → finish). After each
                  click, type the control number. Green/amber shows track hits.
                </p>
                <ControlList
                  controls={controls}
                  setControls={setControls}
                  tracks={tracks}
                  codeInputRefs={codeInputRefs}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="flex-1 rounded-lg border border-forest-200 py-2 text-sm"
                    onClick={() => {
                      setControls([]);
                      setStatus("Controls cleared — click map to place");
                    }}
                    disabled={controls.length === 0}
                  >
                    Clear all
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveControls()}
                    disabled={
                      controls.length === 0 ||
                      controls.some((c) => !c.code.trim())
                    }
                    className="flex-1 rounded-lg bg-forest-700 text-white py-2 text-sm disabled:opacity-40"
                  >
                    Save controls
                  </button>
                </div>
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function ControlList({
  controls,
  setControls,
  tracks,
  codeInputRefs,
}: {
  controls: ControlDraft[];
  setControls: React.Dispatch<React.SetStateAction<ControlDraft[]>>;
  tracks: SetupTrack[];
  codeInputRefs: React.MutableRefObject<(HTMLInputElement | null)[]>;
}) {
  if (controls.length === 0) {
    return (
      <p className="text-sm text-forest-500 italic">
        No controls yet — click the map to add the first point.
      </p>
    );
  }

  return (
    <ul className="space-y-2 max-h-[360px] overflow-auto">
      {controls.map((c, i) => {
        const touches =
          c.lat != null && c.lon != null && tracks.length > 0
            ? tracks.map((t) => ({
                id: t.id,
                name: t.name,
                color: t.color,
                hit: trackTouchesControl(t.points, {
                  lat: c.lat!,
                  lon: c.lon!,
                }),
              }))
            : [];
        const hitCount = touches.filter((t) => t.hit).length;

        return (
          <li
            key={`${c.sequence}-${i}`}
            className="rounded-lg border border-forest-200 p-2 flex gap-2 items-start"
          >
            <span className="text-xs text-forest-400 font-mono pt-2 w-5 shrink-0">
              {i + 1}.
            </span>
            <div className="flex-1 min-w-0 space-y-1">
              <input
                ref={(el) => {
                  codeInputRefs.current[i] = el;
                }}
                className="w-full rounded border border-forest-200 px-2 py-1.5 text-sm font-medium"
                placeholder="Control number (e.g. S, 31, F)"
                value={c.code}
                onChange={(e) =>
                  setControls((prev) =>
                    prev.map((x, j) =>
                      j === i ? { ...x, code: e.target.value } : x
                    )
                  )
                }
              />
              {touches.length > 0 && (
                <div className="flex flex-wrap items-center gap-1">
                  <span
                    className={`text-[10px] font-mono ${
                      hitCount === touches.length
                        ? "text-green-700"
                        : hitCount === 0
                          ? "text-amber-700"
                          : "text-forest-600"
                    }`}
                  >
                    {hitCount}/{touches.length}
                  </span>
                  {touches.map((t) => (
                    <span
                      key={t.id}
                      title={`${t.name}: ${t.hit ? "touches" : "miss"}`}
                      className={`inline-flex items-center gap-1 text-[10px] px-1 py-0.5 rounded ${
                        t.hit
                          ? "bg-green-50 text-green-800"
                          : "bg-amber-50 text-amber-800"
                      }`}
                    >
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: t.color }}
                      />
                      {t.hit ? "✓" : "✗"}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <button
              type="button"
              className="text-red-600 text-sm px-1 shrink-0"
              title="Remove"
              onClick={() => {
                setControls((prev) =>
                  prev
                    .filter((_, j) => j !== i)
                    .map((x, j) => ({ ...x, sequence: j }))
                );
              }}
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function MapMarkers({
  georef,
  controls,
  mode,
  mapW,
  mapH,
  img,
}: {
  georef: GeorefPair[];
  controls: ControlDraft[];
  mode: Mode;
  mapW: number;
  mapH: number;
  img: HTMLImageElement;
}) {
  const rect = img.getBoundingClientRect();
  const parent = img.parentElement?.getBoundingClientRect();
  if (!parent) return null;
  const scaleX = rect.width / mapW;
  const scaleY = rect.height / mapH;
  const offsetX = rect.left - parent.left;
  const offsetY = rect.top - parent.top;

  const dots =
    mode === "points"
      ? georef.map((g, i) => ({
          key: `g${i}`,
          x: g.map.x,
          y: g.map.y,
          label: String(i + 1),
          color: "#e74c3c",
        }))
      : controls
          .filter((c) => c.map_x != null && c.map_y != null)
          .map((c) => ({
            key: `c${c.sequence}`,
            x: c.map_x!,
            y: c.map_y!,
            label: c.code || "?",
            color: "#c0392b",
          }));

  return (
    <div className="pointer-events-none absolute inset-0">
      {dots.map((d) => (
        <div
          key={d.key}
          className="absolute -translate-x-1/2 -translate-y-1/2"
          style={{
            left: offsetX + d.x * scaleX,
            top: offsetY + d.y * scaleY,
          }}
        >
          <div
            className="w-6 h-6 rounded-full border-2 border-white flex items-center justify-center text-[10px] font-bold text-white shadow"
            style={{ background: d.color }}
          >
            {d.label}
          </div>
        </div>
      ))}
    </div>
  );
}
