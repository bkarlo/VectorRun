"use client";

import { useMemo, useRef, useState } from "react";
import type { TrackPoint } from "@/lib/types";
import {
  mpsToKmh,
  mpsToPaceMinPerKm,
  speedAtTime,
  speedProfile,
  type SpeedSample,
} from "@/lib/speed";
import { findPunchIndex } from "@/lib/sync";

interface RunnerSeries {
  id: string;
  name: string;
  color: string;
  points: TrackPoint[];
}

export interface SpeedChartControl {
  code: string;
  sequence: number;
  lat: number;
  lon: number;
}

export interface SpeedChartStoryMark {
  key: string;
  timeMs: number;
  kind: "hesitation" | "comeback" | "detour";
  label: string;
  color: string;
}

interface PunchDot {
  key: string;
  runnerId: string;
  runnerName: string;
  color: string;
  code: string;
  timeMs: number;
  speedMps: number;
  x: number;
  y: number;
}

interface Props {
  runners: RunnerSeries[];
  timeMin: number;
  timeMax: number;
  replayMs: number;
  onSeek: (t: number) => void;
  /** Course controls with GPS — punches drawn on every runner's line */
  controls?: SpeedChartControl[];
  /** Hesitation / decision markers (seekable) */
  storyMarks?: SpeedChartStoryMark[];
}

const W = 600;
const H = 88;
const PAD = { top: 8, right: 8, bottom: 4, left: 28 };

const STORY_FILL = {
  hesitation: "#d97706",
  comeback: "#7c3aed",
  detour: "#6d28d9",
} as const;

export default function SpeedChart({
  runners,
  timeMin,
  timeMax,
  replayMs,
  onSeek,
  controls = [],
  storyMarks = [],
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const duration = Math.max(1, timeMax - timeMin);
  const [tip, setTip] = useState<{
    code: string;
    runnerName: string;
    x: number;
    y: number;
  } | null>(null);

  const series = useMemo(() => {
    return runners.map((r) => ({
      ...r,
      samples: speedProfile(r.points),
    }));
  }, [runners]);

  const maxSpeed = useMemo(() => {
    let m = 1;
    for (const s of series) {
      for (const p of s.samples) m = Math.max(m, p.speedMps);
    }
    const kmh = mpsToKmh(m);
    const nice = Math.ceil(kmh / 2) * 2 || 2;
    return nice / 3.6;
  }, [series]);

  const xScale = (t: number) =>
    PAD.left + ((t - timeMin) / duration) * (W - PAD.left - PAD.right);
  const yScale = (mps: number) =>
    PAD.top +
    (1 - Math.min(1, mps / maxSpeed)) * (H - PAD.top - PAD.bottom);

  const toPolyline = (samples: SpeedSample[]) => {
    const pts = samples.filter(
      (s) => s.time >= timeMin - 1000 && s.time <= timeMax + 1000
    );
    if (pts.length === 0) return "";
    return pts
      .map((s, i) => {
        const x = xScale(s.time);
        const y = yScale(s.speedMps);
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
  };

  const punchDots = useMemo(() => {
    if (controls.length === 0) return [] as PunchDot[];
    const geo = [...controls].sort((a, b) => a.sequence - b.sequence);
    const dots: PunchDot[] = [];

    for (const s of series) {
      if (s.points.length === 0) continue;
      let fromIdx = 0;
      for (const c of geo) {
        const idx = findPunchIndex(
          s.points,
          { lat: c.lat, lon: c.lon },
          fromIdx
        );
        if (idx < 0) continue;
        const timeMs = s.points[idx].time;
        if (timeMs < timeMin || timeMs > timeMax) {
          fromIdx = idx + 1;
          continue;
        }
        const mps = speedAtTime(s.samples, timeMs) ?? 0;
        dots.push({
          key: `${s.id}-${c.sequence}-${c.code}`,
          runnerId: s.id,
          runnerName: s.name,
          color: s.color,
          code: c.code,
          timeMs,
          speedMps: mps,
          x: xScale(timeMs),
          y: yScale(mps),
        });
        fromIdx = idx + 1;
      }
    }
    return dots;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, controls, timeMin, timeMax, maxSpeed, duration]);

  const playheadX = xScale(Math.min(timeMax, Math.max(timeMin, replayMs)));

  const currentSpeeds = series.map((s) => ({
    id: s.id,
    name: s.name,
    color: s.color,
    mps: speedAtTime(s.samples, replayMs),
  }));

  const onPointer = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * W;
    const u = (x - PAD.left) / (W - PAD.left - PAD.right);
    const t = timeMin + Math.min(1, Math.max(0, u)) * duration;
    onSeek(t);
  };

  const yTicks = [0, 0.5, 1].map((f) => ({
    mps: maxSpeed * f,
    y: yScale(maxSpeed * f),
    label: `${Math.round(mpsToKmh(maxSpeed * f))}`,
  }));

  if (series.every((s) => s.samples.length === 0)) {
    return (
      <div className="h-[88px] flex items-center justify-center text-xs text-forest-500 border-t border-forest-100">
        No speed data
      </div>
    );
  }

  return (
    <div className="border-t border-forest-100 pt-2 relative">
      <div className="flex items-center justify-between gap-2 mb-1 px-0.5">
        <span className="text-[10px] uppercase tracking-wider text-forest-500 font-semibold">
          Speed
        </span>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono text-forest-600">
          {currentSpeeds.map((s) => {
            if (s.mps == null) return null;
            const kmh = mpsToKmh(s.mps);
            const pace = mpsToPaceMinPerKm(s.mps);
            return (
              <span key={s.id} className="inline-flex items-center gap-1">
                <span
                  className="w-1.5 h-1.5 rounded-full"
                  style={{ background: s.color }}
                />
                {kmh < 1
                  ? "—"
                  : `${kmh.toFixed(1)} km/h${pace ? ` · ${pace}/km` : ""}`}
              </span>
            );
          })}
        </div>
        <span className="text-[10px] text-forest-400 shrink-0">km/h</span>
      </div>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-[88px] cursor-crosshair select-none"
        preserveAspectRatio="none"
        onPointerDown={(e) => {
          if ((e.target as Element).closest?.("[data-punch]")) return;
          (e.target as Element).setPointerCapture?.(e.pointerId);
          onPointer(e.clientX);
          setTip(null);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1 && !(e.target as Element).closest?.("[data-punch]")) {
            onPointer(e.clientX);
          }
        }}
      >
        {yTicks.map((tick) => (
          <g key={tick.label}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={tick.y}
              y2={tick.y}
              stroke="#c5d6bf"
              strokeWidth={0.5}
              strokeDasharray={tick.mps === 0 ? undefined : "2 2"}
            />
            <text
              x={PAD.left - 4}
              y={tick.y + 3}
              textAnchor="end"
              fill="#729966"
              fontSize={8}
              fontFamily="ui-monospace, monospace"
            >
              {tick.label}
            </text>
          </g>
        ))}

        {series.map((s) => (
          <path
            key={s.id}
            d={toPolyline(s.samples)}
            fill="none"
            stroke={s.color}
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={0.9}
            vectorEffect="non-scaling-stroke"
          />
        ))}

        {/* Punch dots on each runner's line */}
        {punchDots.map((d) => (
          <g
            key={d.key}
            data-punch
            className="cursor-pointer"
            onPointerDown={(e) => {
              e.stopPropagation();
              onSeek(d.timeMs);
              setTip({
                code: d.code,
                runnerName: d.runnerName,
                x: d.x,
                y: d.y,
              });
            }}
          >
            {/* larger hit target */}
            <circle cx={d.x} cy={d.y} r={8} fill="transparent" />
            <circle
              cx={d.x}
              cy={d.y}
              r={3.5}
              fill={d.color}
              stroke="#fff"
              strokeWidth={1.25}
              vectorEffect="non-scaling-stroke"
            >
              <title>
                {d.code} · {d.runnerName}
              </title>
            </circle>
          </g>
        ))}

        {/* Hesitation / come-back / detour ticks */}
        {storyMarks
          .filter((m) => m.timeMs >= timeMin && m.timeMs <= timeMax)
          .map((m) => {
            const x = xScale(m.timeMs);
            const fill = STORY_FILL[m.kind];
            return (
              <g
                key={m.key}
                data-punch
                className="cursor-pointer"
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onSeek(m.timeMs);
                  setTip({
                    code: m.label,
                    runnerName: "",
                    x,
                    y: PAD.top + 6,
                  });
                }}
              >
                <line
                  x1={x}
                  x2={x}
                  y1={PAD.top}
                  y2={H - PAD.bottom}
                  stroke={fill}
                  strokeWidth={1}
                  strokeDasharray="2 2"
                  opacity={0.7}
                />
                <circle
                  cx={x}
                  cy={PAD.top + 4}
                  r={3}
                  fill={fill}
                  stroke="#fff"
                  strokeWidth={1}
                >
                  <title>{m.label}</title>
                </circle>
              </g>
            );
          })}

        <line
          x1={playheadX}
          x2={playheadX}
          y1={PAD.top}
          y2={H - PAD.bottom}
          stroke="#243522"
          strokeWidth={1.25}
          opacity={0.55}
        />
      </svg>

      {tip && (
        <div
          className="absolute z-10 pointer-events-none -translate-x-1/2 -translate-y-full px-2 py-1 rounded bg-forest-900 text-white text-[10px] font-mono shadow whitespace-nowrap"
          style={{
            left: `${(tip.x / W) * 100}%`,
            top: `${(tip.y / H) * 100}%`,
            marginTop: -6,
          }}
        >
          <span className="font-bold">{tip.code}</span>
          {tip.runnerName ? (
            <span className="opacity-80"> · {tip.runnerName}</span>
          ) : null}
        </div>
      )}
    </div>
  );
}
