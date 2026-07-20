import type { AffineTransform, GeoPoint, GeorefPair, MapPixel } from "./types";

/**
 * Fit an affine transform from map pixels to WGS84 using least squares.
 * Requires >= 3 georeference pairs.
 */
export function fitAffine(pairs: GeorefPair[]): AffineTransform | null {
  if (pairs.length < 3) return null;

  // Solve for lon = a*x + b*y + c and lat = d*x + e*y + f
  const n = pairs.length;
  // Build normal equations for 3 unknowns using sum products
  const lon = solveAffineParams(
    pairs.map((p) => [p.map.x, p.map.y, p.gps.lon] as [number, number, number])
  );
  const lat = solveAffineParams(
    pairs.map((p) => [p.map.x, p.map.y, p.gps.lat] as [number, number, number])
  );
  if (!lon || !lat) return null;

  const [a, b, c] = lon;
  const [d, e, f] = lat;

  // Inverse of 2x2 matrix [[a,b],[d,e]]
  const det = a * e - b * d;
  if (Math.abs(det) < 1e-18) return null;

  const ia = e / det;
  const ib = -b / det;
  const id = -d / det;
  const ie = a / det;
  // For x = ia*(lon-c) + ib*(lat-f), y = id*(lon-c) + ie*(lat-f)
  // x = ia*lon + ib*lat + ic where ic = -ia*c - ib*f
  const ic = -ia * c - ib * f;
  const iff = -id * c - ie * f;

  void n;
  return { a, b, c, d, e, f, ia, ib, ic, id, ie, if: iff };
}

function solveAffineParams(
  samples: [number, number, number][]
): [number, number, number] | null {
  // Least squares: [x y 1] * [a b c]^T = z
  let sxx = 0,
    sxy = 0,
    sx = 0,
    syy = 0,
    sy = 0,
    n = 0,
    sxz = 0,
    syz = 0,
    sz = 0;

  for (const [x, y, z] of samples) {
    sxx += x * x;
    sxy += x * y;
    sx += x;
    syy += y * y;
    sy += y;
    n += 1;
    sxz += x * z;
    syz += y * z;
    sz += z;
  }

  // 3x3 system
  const A = [
    [sxx, sxy, sx],
    [sxy, syy, sy],
    [sx, sy, n],
  ];
  const B = [sxz, syz, sz];
  return solve3(A, B);
}

function solve3(
  A: number[][],
  B: number[]
): [number, number, number] | null {
  const M = A.map((row, i) => [...row, B[i]]);
  const n = 3;
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[pivot][col])) pivot = row;
    }
    if (Math.abs(M[pivot][col]) < 1e-18) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const div = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= div;
    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = M[row][col];
      for (let j = col; j <= n; j++) M[row][j] -= factor * M[col][j];
    }
  }
  return [M[0][3], M[1][3], M[2][3]];
}

export function mapToGps(t: AffineTransform, p: MapPixel): GeoPoint {
  return {
    lon: t.a * p.x + t.b * p.y + t.c,
    lat: t.d * p.x + t.e * p.y + t.f,
  };
}

export function gpsToMap(t: AffineTransform, g: GeoPoint): MapPixel {
  return {
    x: t.ia * g.lon + t.ib * g.lat + t.ic,
    y: t.id * g.lon + t.ie * g.lat + t.if,
  };
}

/** Leaflet ImageOverlay bounds from affine + image size (SW/NE corners). */
export function imageOverlayBounds(
  t: AffineTransform,
  width: number,
  height: number
): [[number, number], [number, number]] {
  const corners = imageCornerGps(t, width, height);
  const lats = corners.map((c) => c.lat);
  const lons = corners.map((c) => c.lon);
  return [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ];
}

export function imageCornerGps(
  t: AffineTransform,
  width: number,
  height: number
): [GeoPoint, GeoPoint, GeoPoint, GeoPoint] {
  return [
    mapToGps(t, { x: 0, y: 0 }),
    mapToGps(t, { x: width, y: 0 }),
    mapToGps(t, { x: 0, y: height }),
    mapToGps(t, { x: width, y: height }),
  ];
}

const M_PER_DEG_LAT = 111_320;

function metersPerDegLon(lat: number): number {
  return M_PER_DEG_LAT * Math.cos((lat * Math.PI) / 180);
}

/** Similarity placement: translate + uniform-ish scale + rotation (degrees clockwise). */
export interface OverlayPlacement {
  centerLat: number;
  centerLon: number;
  /** Ground width of the full image (meters). */
  widthM: number;
  /** Ground height of the full image (meters). */
  heightM: number;
  /** Clockwise degrees from north-up (image top = north at 0). */
  rotationDeg: number;
}

function rotateEastNorth(
  east: number,
  north: number,
  rotationDegCW: number
): [number, number] {
  const r = (rotationDegCW * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  return [east * cos + north * sin, -east * sin + north * cos];
}

function offsetToGps(
  centerLat: number,
  centerLon: number,
  eastM: number,
  northM: number
): GeoPoint {
  return {
    lat: centerLat + northM / M_PER_DEG_LAT,
    lon: centerLon + eastM / metersPerDegLon(centerLat),
  };
}

function gpsDeltaMeters(
  from: GeoPoint,
  to: GeoPoint
): { east: number; north: number } {
  const midLat = (from.lat + to.lat) / 2;
  return {
    east: (to.lon - from.lon) * metersPerDegLon(midLat),
    north: (to.lat - from.lat) * M_PER_DEG_LAT,
  };
}

/** Image corners in GPS from placement (TL, TR, BL, BR). */
export function placementCorners(p: OverlayPlacement): {
  tl: GeoPoint;
  tr: GeoPoint;
  bl: GeoPoint;
  br: GeoPoint;
} {
  const hw = p.widthM / 2;
  const hh = p.heightM / 2;
  const corners = [
    rotateEastNorth(-hw, hh, p.rotationDeg),
    rotateEastNorth(hw, hh, p.rotationDeg),
    rotateEastNorth(-hw, -hh, p.rotationDeg),
    rotateEastNorth(hw, -hh, p.rotationDeg),
  ];
  const [tl, tr, bl, br] = corners.map(([e, n]) =>
    offsetToGps(p.centerLat, p.centerLon, e, n)
  );
  return { tl, tr, bl, br };
}

export function georefFromPlacement(
  p: OverlayPlacement,
  width: number,
  height: number
): GeorefPair[] {
  const { tl, tr, bl, br } = placementCorners(p);
  return [
    { map: { x: 0, y: 0 }, gps: tl },
    { map: { x: width, y: 0 }, gps: tr },
    { map: { x: 0, y: height }, gps: bl },
    { map: { x: width, y: height }, gps: br },
  ];
}

export function placementFromGeoref(
  pairs: GeorefPair[],
  width: number,
  height: number
): OverlayPlacement | null {
  const t = fitAffine(pairs);
  if (!t || width <= 0 || height <= 0) return null;
  const tl = mapToGps(t, { x: 0, y: 0 });
  const tr = mapToGps(t, { x: width, y: 0 });
  const bl = mapToGps(t, { x: 0, y: height });
  const c = mapToGps(t, { x: width / 2, y: height / 2 });
  const top = gpsDeltaMeters(tl, tr);
  const left = gpsDeltaMeters(tl, bl);
  const widthM = Math.hypot(top.east, top.north);
  const heightM = Math.hypot(left.east, left.north);
  if (widthM < 1e-3 || heightM < 1e-3) return null;
  // Top edge at 0° points east; CW rotation = -atan2(north, east)
  const rotationDeg =
    (-Math.atan2(top.north, top.east) * 180) / Math.PI;
  return {
    centerLat: c.lat,
    centerLon: c.lon,
    widthM,
    heightM,
    rotationDeg,
  };
}

/** Place image over track extent, north-up, preserving aspect ratio. */
export function initialOverlayPlacement(
  trackPoints: { lat: number; lon: number }[],
  width: number,
  height: number,
  pad = 1.35
): OverlayPlacement {
  if (width <= 0 || height <= 0) {
    return {
      centerLat: 59.33,
      centerLon: 18.065,
      widthM: 500,
      heightM: 500,
      rotationDeg: 0,
    };
  }

  let minLat = Infinity,
    maxLat = -Infinity,
    minLon = Infinity,
    maxLon = -Infinity;

  if (trackPoints.length === 0) {
    minLat = 59.32;
    maxLat = 59.34;
    minLon = 18.05;
    maxLon = 18.08;
  } else {
    for (const p of trackPoints) {
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
    }
  }

  const cLat = (minLat + maxLat) / 2;
  const cLon = (minLon + maxLon) / 2;
  const mLon = metersPerDegLon(cLat);
  const trackH = Math.max((maxLat - minLat) * M_PER_DEG_LAT, 80);
  const trackW = Math.max((maxLon - minLon) * mLon, 80);
  const aspect = width / height;

  let heightM = trackH * pad;
  let widthM = heightM * aspect;
  if (widthM < trackW * pad) {
    widthM = trackW * pad;
    heightM = widthM / aspect;
  }

  return {
    centerLat: cLat,
    centerLon: cLon,
    widthM,
    heightM,
    rotationDeg: 0,
  };
}

export function scalePlacement(
  p: OverlayPlacement,
  factor: number
): OverlayPlacement {
  const f = Math.max(0.05, Math.min(20, factor));
  return { ...p, widthM: p.widthM * f, heightM: p.heightM * f };
}

export function translatePlacement(
  p: OverlayPlacement,
  dLat: number,
  dLon: number
): OverlayPlacement {
  return {
    ...p,
    centerLat: p.centerLat + dLat,
    centerLon: p.centerLon + dLon,
  };
}

export function rotatePlacement(
  p: OverlayPlacement,
  deltaDegCW: number
): OverlayPlacement {
  return { ...p, rotationDeg: p.rotationDeg + deltaDegCW };
}

/** @deprecated Prefer OverlayPlacement + georefFromPlacement */
export type OverlayBounds = [[number, number], [number, number]];

export function georefFromOverlayBounds(
  bounds: OverlayBounds,
  width: number,
  height: number
): GeorefPair[] {
  const [[south, west], [north, east]] = bounds;
  return [
    { map: { x: 0, y: 0 }, gps: { lat: north, lon: west } },
    { map: { x: width, y: 0 }, gps: { lat: north, lon: east } },
    { map: { x: 0, y: height }, gps: { lat: south, lon: west } },
    { map: { x: width, y: height }, gps: { lat: south, lon: east } },
  ];
}

export function overlayBoundsFromGeoref(
  pairs: GeorefPair[],
  width: number,
  height: number
): OverlayBounds | null {
  const t = fitAffine(pairs);
  if (!t || width <= 0 || height <= 0) return null;
  return imageOverlayBounds(t, width, height);
}

export function initialOverlayBounds(
  trackPoints: { lat: number; lon: number }[],
  width: number,
  height: number,
  pad = 1.35
): OverlayBounds {
  const p = initialOverlayPlacement(trackPoints, width, height, pad);
  const { tl, br } = placementCorners(p);
  // AABB approx for legacy callers
  const lats = [tl.lat, br.lat];
  const lons = [tl.lon, br.lon];
  return [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ];
}

export function scaleOverlayBounds(
  bounds: OverlayBounds,
  factor: number
): OverlayBounds {
  const [[south, west], [north, east]] = bounds;
  const cLat = (south + north) / 2;
  const cLon = (west + east) / 2;
  const halfLat = ((north - south) / 2) * factor;
  const halfLon = ((east - west) / 2) * factor;
  return [
    [cLat - halfLat, cLon - halfLon],
    [cLat + halfLat, cLon + halfLon],
  ];
}

export function translateOverlayBounds(
  bounds: OverlayBounds,
  dLat: number,
  dLon: number
): OverlayBounds {
  const [[south, west], [north, east]] = bounds;
  return [
    [south + dLat, west + dLon],
    [north + dLat, east + dLon],
  ];
}
