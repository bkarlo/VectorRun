"use client";

import { useMemo, useRef } from "react";
import type { TrackPoint } from "@/lib/types";
import {
  mpsToKmh,
  mpsToPaceMinPerKm,
  speedAtTime,
  speedProfile,
  type SpeedSample,
} from "@/lib/speed";

interface RunnerSeries {
  id: string;
  name: string;
  color: string;
  points: TrackPoint[];
}

interface Props {
  runners: RunnerSeries[];
  timeMin: number;
  timeMax: number;
  replayMs: number;
  onSeek: (t: number) => void;
}

const W = 600;
const H = 88;
const PAD = { top: 8, right: 8, bottom: 4, left: 28 };

export default function SpeedChart({
  runners,
  timeMin,
  timeMax,
  replayMs,
  onSeek,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const duration = Math.max(1, timeMax - timeMin);

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
    // Round up to nice km/h bucket
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
    <div className="border-t border-forest-100 pt-2">
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
          (e.target as Element).setPointerCapture?.(e.pointerId);
          onPointer(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) onPointer(e.clientX);
        }}
      >
        {/* grid */}
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

        {/* playhead */}
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
    </div>
  );
}
