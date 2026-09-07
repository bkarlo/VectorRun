import type { TrackPoint } from "./types";

export function parseGpx(xml: string): TrackPoint[] {
  const points: TrackPoint[] = [];

  // Prefer track points; fall back to route points
  const trkRegex =
    /<trkpt\s+([^>]+)>([\s\S]*?)<\/trkpt>/gi;
  const rteRegex =
    /<rtept\s+([^>]+)>([\s\S]*?)<\/rtept>/gi;

  let matches = [...xml.matchAll(trkRegex)];
  if (matches.length === 0) {
    matches = [...xml.matchAll(rteRegex)];
  }

  for (const m of matches) {
    const attrs = m[1];
    const body = m[2];
    const latM = attrs.match(/lat=["']([^"']+)["']/i);
    const lonM = attrs.match(/lon=["']([^"']+)["']/i);
    if (!latM || !lonM) continue;

    const lat = parseFloat(latM[1]);
    const lon = parseFloat(lonM[1]);
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;

    const eleM = body.match(/<ele>\s*([^<]+)\s*<\/ele>/i);
    const timeM = body.match(/<time>\s*([^<]+)\s*<\/time>/i);

    const ele = eleM ? parseFloat(eleM[1]) : null;
    const time = timeM ? Date.parse(timeM[1].trim()) : NaN;

    points.push({
      lat,
      lon,
      ele: ele !== null && !Number.isNaN(ele) ? ele : null,
      time: Number.isNaN(time) ? 0 : time,
    });
  }

  // If no timestamps, invent 1 Hz timeline
  if (points.length > 0 && points.every((p) => p.time === 0)) {
    const base = Date.UTC(2024, 0, 1, 10, 0, 0);
    for (let i = 0; i < points.length; i++) {
      points[i].time = base + i * 1000;
    }
  }

  return points;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Rebuild a simple GPX 1.1 track from stored points (original file is not kept). */
export function serializeGpx(
  points: TrackPoint[],
  opts?: { name?: string }
): string {
  const name = escapeXml(opts?.name?.trim() || "VectorRun track");
  const trkpts = points
    .map((p) => {
      const ele =
        p.ele != null && Number.isFinite(p.ele)
          ? `\n        <ele>${p.ele}</ele>`
          : "";
      const time =
        p.time > 0
          ? `\n        <time>${new Date(p.time).toISOString()}</time>`
          : "";
      return `      <trkpt lat="${p.lat}" lon="${p.lon}">${ele}${time}\n      </trkpt>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="VectorRun" xmlns="http://www.topografix.com/GPX/1/1">
  <trk>
    <name>${name}</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>
`;
}

export function haversineM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function pathDistanceM(points: TrackPoint[]): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) {
    d += haversineM(points[i - 1], points[i]);
  }
  return d;
}

export function pathClimbM(points: TrackPoint[]): number {
  let climb = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].ele;
    const b = points[i].ele;
    if (a == null || b == null) continue;
    const delta = b - a;
    if (delta > 0) climb += delta;
  }
  return climb;
}

export function interpolateAtTime(
  points: TrackPoint[],
  t: number
): TrackPoint | null {
  if (points.length === 0) return null;
  if (t <= points[0].time) return points[0];
  if (t >= points[points.length - 1].time) return points[points.length - 1];

  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].time <= t) lo = mid;
    else hi = mid;
  }
  const a = points[lo];
  const b = points[hi];
  const span = b.time - a.time || 1;
  const u = (t - a.time) / span;
  return {
    lat: a.lat + (b.lat - a.lat) * u,
    lon: a.lon + (b.lon - a.lon) * u,
    ele:
      a.ele != null && b.ele != null
        ? a.ele + (b.ele - a.ele) * u
        : a.ele ?? b.ele,
    time: t,
  };
}

/** Points at or before t, ending at the interpolated position at t (for trail reveal). */
/** Nearest sample to `timeMs` at or after `fromIndex` (monotonic tracks). */
export function indexNearestTime(
  points: TrackPoint[],
  timeMs: number,
  fromIndex = 0
): number {
  if (points.length === 0) return -1;
  const start = Math.min(Math.max(0, fromIndex), points.length - 1);
  let best = start;
  let bestAbs = Math.abs(points[start].time - timeMs);
  for (let i = start; i < points.length; i++) {
    const d = Math.abs(points[i].time - timeMs);
    if (d < bestAbs) {
      bestAbs = d;
      best = i;
    }
    if (points[i].time >= timeMs && i > start) break;
  }
  return best;
}

export function trackUpToTime(
  points: TrackPoint[],
  t: number
): TrackPoint[] {
  if (points.length === 0) return [];
  if (t < points[0].time) return [];
  const out: TrackPoint[] = [];
  for (const p of points) {
    if (p.time <= t) out.push(p);
    else break;
  }
  const tip = interpolateAtTime(points, t);
  if (tip && (out.length === 0 || out[out.length - 1].time < t - 0.5)) {
    out.push(tip);
  }
  return out;
}
