import { haversineM } from "./gpx";
import type { TrackPoint } from "./types";

export interface SpeedSample {
  time: number; // synced timeline ms
  speedMps: number;
}

/**
 * Instantaneous speed samples from consecutive GPS points.
 * Drops absurd spikes (GPS jumps) and gaps.
 */
export function speedProfile(
  points: TrackPoint[],
  opts?: { maxSpeedMps?: number; maxGapMs?: number }
): SpeedSample[] {
  const maxSpeed = opts?.maxSpeedMps ?? 8; // ~28.8 km/h
  const maxGap = opts?.maxGapMs ?? 15_000;
  const out: SpeedSample[] = [];

  for (let i = 1; i < points.length; i++) {
    const dt = points[i].time - points[i - 1].time;
    if (dt <= 0 || dt > maxGap) continue;
    const dist = haversineM(points[i - 1], points[i]);
    const speed = dist / (dt / 1000);
    if (!Number.isFinite(speed) || speed < 0 || speed > maxSpeed) continue;
    out.push({ time: points[i].time, speedMps: speed });
  }

  return smoothSpeed(out, 5);
}

/** Simple moving-average smooth (odd window). */
function smoothSpeed(samples: SpeedSample[], window: number): SpeedSample[] {
  if (samples.length === 0 || window < 3) return samples;
  const half = Math.floor(window / 2);
  return samples.map((s, i) => {
    let sum = 0;
    let n = 0;
    for (let j = i - half; j <= i + half; j++) {
      if (j < 0 || j >= samples.length) continue;
      sum += samples[j].speedMps;
      n += 1;
    }
    return { time: s.time, speedMps: n ? sum / n : s.speedMps };
  });
}

export function speedAtTime(
  samples: SpeedSample[],
  t: number
): number | null {
  if (samples.length === 0) return null;
  if (t <= samples[0].time) return samples[0].speedMps;
  if (t >= samples[samples.length - 1].time) {
    return samples[samples.length - 1].speedMps;
  }
  let lo = 0;
  let hi = samples.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (samples[mid].time <= t) lo = mid;
    else hi = mid;
  }
  const a = samples[lo];
  const b = samples[hi];
  const span = b.time - a.time || 1;
  const u = (t - a.time) / span;
  return a.speedMps + (b.speedMps - a.speedMps) * u;
}

export function mpsToKmh(mps: number): number {
  return mps * 3.6;
}

/** Orienteering-style pace min/km from m/s; null if nearly stopped. */
export function mpsToPaceMinPerKm(mps: number): string | null {
  if (mps < 0.3) return null;
  const secPerKm = 1000 / mps;
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
