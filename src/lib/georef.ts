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
  const corners = [
    mapToGps(t, { x: 0, y: 0 }),
    mapToGps(t, { x: width, y: 0 }),
    mapToGps(t, { x: 0, y: height }),
    mapToGps(t, { x: width, y: height }),
  ];
  const lats = corners.map((c) => c.lat);
  const lons = corners.map((c) => c.lon);
  return [
    [Math.min(...lats), Math.min(...lons)],
    [Math.max(...lats), Math.max(...lons)],
  ];
}
