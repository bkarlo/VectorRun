/** Default map center when no tracks/controls yet (Nagykovácsi, Hungary). */
export const DEFAULT_MAP_CENTER = {
  lat: 47.576,
  lon: 18.878,
} as const;

export const DEFAULT_MAP_CENTER_TUPLE: [number, number] = [
  DEFAULT_MAP_CENTER.lat,
  DEFAULT_MAP_CENTER.lon,
];

/** Small bounds around the default center (~1–2 km). */
export const DEFAULT_MAP_BOUNDS: [[number, number], [number, number]] = [
  [DEFAULT_MAP_CENTER.lat - 0.01, DEFAULT_MAP_CENTER.lon - 0.015],
  [DEFAULT_MAP_CENTER.lat + 0.01, DEFAULT_MAP_CENTER.lon + 0.015],
];
