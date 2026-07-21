import { haversineM } from "./gpx";
import type { HesitationEvent, TrackPoint } from "./types";

const SLOW_MPS = 1.0;
const MIN_DURATION_MS = 4_000;
const MERGE_GAP_MS = 2_000;
const MAX_PER_LEG = 5;
const MAX_GAP_MS = 15_000;
const MAX_SPEED_MPS = 8;

interface SlowSpan {
  startI: number;
  endI: number;
  startMs: number;
  endMs: number;
}

/**
 * Detect low-speed clusters on a leg segment.
 * Speed &lt; ~1 m/s for ≥ ~4 s; merge gaps ≤ 2 s; keep up to 5 longest.
 */
export function detectHesitations(segment: TrackPoint[]): HesitationEvent[] {
  if (segment.length < 2) return [];

  // Point i (i≥1) is "slow" if speed from i-1→i is below threshold
  const slow: boolean[] = new Array(segment.length).fill(false);
  for (let i = 1; i < segment.length; i++) {
    const dt = segment[i].time - segment[i - 1].time;
    if (dt <= 0 || dt > MAX_GAP_MS) continue;
    const speed = haversineM(segment[i - 1], segment[i]) / (dt / 1000);
    if (Number.isFinite(speed) && speed >= 0 && speed <= MAX_SPEED_MPS) {
      slow[i] = speed < SLOW_MPS;
    }
  }

  const raw: SlowSpan[] = [];
  let i = 1;
  while (i < segment.length) {
    if (!slow[i]) {
      i += 1;
      continue;
    }
    const startI = i - 1; // include prior point of first slow edge
    let endI = i;
    while (endI + 1 < segment.length && slow[endI + 1]) {
      endI += 1;
    }
    raw.push({
      startI,
      endI,
      startMs: segment[startI].time,
      endMs: segment[endI].time,
    });
    i = endI + 1;
  }

  // Merge spans separated by ≤ MERGE_GAP_MS
  const merged: SlowSpan[] = [];
  for (const span of raw) {
    const prev = merged[merged.length - 1];
    if (prev && span.startMs - prev.endMs <= MERGE_GAP_MS) {
      prev.endI = span.endI;
      prev.endMs = span.endMs;
    } else {
      merged.push({ ...span });
    }
  }

  const events: HesitationEvent[] = [];
  for (const span of merged) {
    const durationMs = span.endMs - span.startMs;
    if (durationMs < MIN_DURATION_MS) continue;

    let latSum = 0;
    let lonSum = 0;
    let n = 0;
    for (let j = span.startI; j <= span.endI; j++) {
      latSum += segment[j].lat;
      lonSum += segment[j].lon;
      n += 1;
    }
    if (n === 0) continue;

    events.push({
      startMs: span.startMs,
      endMs: span.endMs,
      durationMs,
      lat: latSum / n,
      lon: lonSum / n,
    });
  }

  events.sort((a, b) => b.durationMs - a.durationMs);
  return events.slice(0, MAX_PER_LEG);
}
