import { haversineM } from "./gpx";
import type { TrackPoint } from "./types";

export interface SpeedSample {
  time: number; // synced timeline ms
  speedMps: number;
}

/** Don't linearly blend speed across gaps longer than this. */
const MAX_INTERP_MS = 6_000;
/** Half-window for time-based moving average on the profile. */
const SMOOTH_HALF_MS = 5_000;

/**
 * Instantaneous speed samples from consecutive GPS points.
 * Drops absurd spikes. Long gaps (standing still / GPS pause) are filled
 * with zero so the chart doesn't hold the previous running speed.
 */
export function speedProfile(
  points: TrackPoint[],
  opts?: { maxSpeedMps?: number; maxGapMs?: number; smoothHalfMs?: number }
): SpeedSample[] {
  const maxSpeed = opts?.maxSpeedMps ?? 8; // ~28.8 km/h
  const maxGap = opts?.maxGapMs ?? 15_000;
  const smoothHalf = opts?.smoothHalfMs ?? SMOOTH_HALF_MS;
  const out: SpeedSample[] = [];

  for (let i = 1; i < points.length; i++) {
    const dt = points[i].time - points[i - 1].time;
    if (dt <= 0) continue;

    if (dt > maxGap) {
      // No usable motion sample across this gap — mark as stopped
      const t0 = points[i - 1].time;
      const t1 = points[i].time;
      out.push({ time: t0 + Math.min(500, dt / 3), speedMps: 0 });
      out.push({ time: t1 - Math.min(500, dt / 3), speedMps: 0 });
      continue;
    }

    const dist = haversineM(points[i - 1], points[i]);
    const speed = dist / (dt / 1000);
    if (!Number.isFinite(speed) || speed < 0 || speed > maxSpeed) continue;
    out.push({ time: points[i].time, speedMps: speed });
  }

  return smoothSpeedByTime(out, smoothHalf);
}

/**
 * Time-windowed moving average: each sample is averaged with neighbors
 * within ±halfWindowMs (ignores distant GPS holes).
 */
function smoothSpeedByTime(
  samples: SpeedSample[],
  halfWindowMs: number
): SpeedSample[] {
  if (samples.length === 0 || halfWindowMs <= 0) return samples;
  const n = samples.length;
  const out: SpeedSample[] = new Array(n);

  let lo = 0;
  let hi = 0;
  let sum = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    const t = samples[i].time;
    while (hi < n && samples[hi].time <= t + halfWindowMs) {
      sum += samples[hi].speedMps;
      count += 1;
      hi += 1;
    }
    while (lo < hi && samples[lo].time < t - halfWindowMs) {
      sum -= samples[lo].speedMps;
      count -= 1;
      lo += 1;
    }
    out[i] = {
      time: t,
      speedMps: count > 0 ? sum / count : samples[i].speedMps,
    };
  }
  return out;
}

/**
 * Interpolated speed at time t. Across short gaps, blends; across longer
 * holes, holds the nearer sample (avoids blinking 0 / null in the UI).
 */
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

  if (span > MAX_INTERP_MS) {
    // Hold nearer endpoint instead of dropping to 0 (less indicator flash)
    return t - a.time <= b.time - t ? a.speedMps : b.speedMps;
  }

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
