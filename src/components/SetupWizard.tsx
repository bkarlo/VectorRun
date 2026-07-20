"use client";

import { useCallback, useRef, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import type { GeorefPair, TrackPoint } from "@/lib/types";
import { actionSaveGeoref, actionSaveControls } from "@/app/actions";
import { fitAffine, gpsToMap, mapToGps } from "@/lib/georef";
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
}

type Mode = "place" | "points" | "controls";

const defaultControls = (): ControlDraft[] => [
  { code: "S", sequence: 0, lat: null, lon: null, map_x: null, map_y: null },
  { code: "1", sequence: 1, lat: null, lon: null, map_x: null, map_y: null },
  { code: "2", sequence: 2, lat: null, lon: null, map_x: null, map_y: null },
  { code: "F", sequence: 3, lat: null, lon: null, map_x: null, map_y: null },
];

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
    props.initialControls.length ? props.initialControls : defaultControls()
  );
  const [status, setStatus] = useState("");
  const [pendingGps, setPendingGps] = useState({ lat: "", lon: "" });
  const [selectedControl, setSelectedControl] = useState(0);
  const [gpxStatus, setGpxStatus] = useState("");
  const imgRef = useRef<HTMLImageElement>(null);

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
    setControls((prev) =>
      prev.map((c, i) =>
        i === selectedControl
          ? {
              ...c,
              lat,
              lon,
              map_x: mapPx?.x ?? c.map_x,
              map_y: mapPx?.y ?? c.map_y,
            }
          : c
      )
    );
    setStatus(
      `Control ${controls[selectedControl]?.code} → ${lat.toFixed(5)}, ${lon.toFixed(5)}`
    );
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
    } else if (mode === "controls") {
      const transform = fitAffine(georef);
      const gps = transform ? mapToGps(transform, px) : null;
      setControls((prev) =>
        prev.map((c, i) =>
          i === selectedControl
            ? {
                ...c,
                map_x: px.x,
                map_y: px.y,
                lat: gps?.lat ?? c.lat,
                lon: gps?.lon ?? c.lon,
              }
            : c
        )
      );
      setStatus(
        gps
          ? `Control ${controls[selectedControl]?.code} placed (GPS derived)`
          : `Control ${controls[selectedControl]?.code} placed — enter GPS or place map first`
      );
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
        </div>
        {status && (
          <span className="text-sm text-forest-600 font-mono">{status}</span>
        )}
      </div>

      {mode === "place" && mapUrl && mapSize.w > 0 ? (
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
                selectedSequence={controls[selectedControl]?.sequence}
                onPlace={placeControlAtGps}
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
                      placeholder="59.3312"
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
                      placeholder="18.0649"
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
                  Select a control, click the OSM map (tracks shown). Green =
                  all tracks touch it; amber = none do. Saved controls reload
                  automatically.
                </p>
                <ControlList
                  controls={controls}
                  selectedControl={selectedControl}
                  setSelectedControl={setSelectedControl}
                  setControls={setControls}
                  tracks={tracks}
                />
                <div className="flex gap-2">
                  <button
                    type="button"
                    className="flex-1 rounded-lg border border-forest-200 py-2 text-sm"
                    onClick={() =>
                      setControls((prev) => [
                        ...prev,
                        {
                          code: String(prev.length),
                          sequence: prev.length,
                          lat: null,
                          lon: null,
                          map_x: null,
                          map_y: null,
                        },
                      ])
                    }
                  >
                    Add control
                  </button>
                  <button
                    type="button"
                    onClick={() => void saveControls()}
                    className="flex-1 rounded-lg bg-forest-700 text-white py-2 text-sm"
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
  selectedControl,
  setSelectedControl,
  setControls,
  tracks,
}: {
  controls: ControlDraft[];
  selectedControl: number;
  setSelectedControl: (i: number) => void;
  setControls: React.Dispatch<React.SetStateAction<ControlDraft[]>>;
  tracks: SetupTrack[];
}) {
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
          key={i}
          className={`rounded-lg border p-2 ${
            selectedControl === i
              ? "border-forest-500 bg-forest-50"
              : "border-forest-200"
          }`}
        >
          <button
            type="button"
            className="w-full text-left font-medium mb-1"
            onClick={() => setSelectedControl(i)}
          >
            {c.code}{" "}
            <span className="text-xs text-forest-500">seq {c.sequence}</span>
            {touches.length > 0 && (
              <span
                className={`ml-2 text-[10px] font-mono ${
                  hitCount === touches.length
                    ? "text-green-700"
                    : hitCount === 0
                      ? "text-amber-700"
                      : "text-forest-600"
                }`}
              >
                tracks {hitCount}/{touches.length}
              </span>
            )}
          </button>
          <div className="grid grid-cols-2 gap-1">
            <input
              className="rounded border border-forest-200 px-1.5 py-1 text-xs"
              placeholder="code"
              value={c.code}
              onChange={(e) =>
                setControls((prev) =>
                  prev.map((x, j) =>
                    j === i ? { ...x, code: e.target.value } : x
                  )
                )
              }
            />
            <input
              className="rounded border border-forest-200 px-1.5 py-1 text-xs"
              type="number"
              value={c.sequence}
              onChange={(e) =>
                setControls((prev) =>
                  prev.map((x, j) =>
                    j === i
                      ? { ...x, sequence: Number(e.target.value) }
                      : x
                  )
                )
              }
            />
            <input
              className="rounded border border-forest-200 px-1.5 py-1 text-xs"
              placeholder="lat"
              value={c.lat ?? ""}
              onChange={(e) =>
                setControls((prev) =>
                  prev.map((x, j) =>
                    j === i
                      ? {
                          ...x,
                          lat: e.target.value
                            ? parseFloat(e.target.value)
                            : null,
                        }
                      : x
                  )
                )
              }
            />
            <input
              className="rounded border border-forest-200 px-1.5 py-1 text-xs"
              placeholder="lon"
              value={c.lon ?? ""}
              onChange={(e) =>
                setControls((prev) =>
                  prev.map((x, j) =>
                    j === i
                      ? {
                          ...x,
                          lon: e.target.value
                            ? parseFloat(e.target.value)
                            : null,
                        }
                      : x
                  )
                )
              }
            />
          </div>
          <p className="text-[10px] text-forest-500 mt-1 font-mono">
            {c.lat != null && c.lon != null
              ? `${c.lat.toFixed(5)}, ${c.lon.toFixed(5)}`
              : c.map_x != null
                ? `map px ${c.map_x.toFixed(0)}, ${c.map_y?.toFixed(0)}`
                : "not placed"}
          </p>
          {touches.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-1.5">
              {touches.map((t) => (
                <span
                  key={t.id}
                  title={`${t.name}: ${t.hit ? "touches" : "miss"}`}
                  className={`inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded ${
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
            label: c.code,
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
