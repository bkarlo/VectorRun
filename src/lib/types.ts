export type ExerciseType =
  | "normal"
  | "route_choice"
  | "compass"
  | "corridor"
  | "one_man_relay"
  | "memory_o";

export type SyncStrategy =
  | "motion_start"
  | "recording_start"
  | "track_match"
  | "first_control"
  | "start_punch"
  | "best_fit"
  | "manual";

/** @deprecated Prefer SyncStrategy + reference runner */
export type SyncMode = SyncStrategy;

export const SYNC_STRATEGY_LABELS: Record<SyncStrategy, string> = {
  motion_start: "Motion",
  recording_start: "Record",
  track_match: "Match",
  first_control: "Control",
  start_punch: "Start",
  best_fit: "Best fit",
  manual: "Manual",
};

/** @deprecated */
export const SYNC_MODE_LABELS = SYNC_STRATEGY_LABELS;

export interface GeoPoint {
  lat: number;
  lon: number;
}

export interface MapPixel {
  x: number;
  y: number;
}

export interface GeorefPair {
  map: MapPixel;
  gps: GeoPoint;
}

export interface AffineTransform {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
  ia: number;
  ib: number;
  ic: number;
  id: number;
  ie: number;
  if: number;
}

export interface TrackPoint {
  lat: number;
  lon: number;
  ele: number | null;
  time: number;
}

export interface EventRow {
  id: string;
  name: string;
  exercise_type: ExerciseType;
  /** Kept for DB compat; sync is per-runner now */
  sync_mode: string;
  reference_participant_id: string | null;
  created_at: string;
}

export interface MapRow {
  id: string;
  event_id: string;
  image_path: string;
  width: number;
  height: number;
  georef_json: string;
  /** Session overlay opacity 0–1 (placement UI has its own slider). */
  opacity: number;
}

export interface ControlRow {
  id: string;
  event_id: string;
  code: string;
  sequence: number;
  lat: number | null;
  lon: number | null;
  map_x: number | null;
  map_y: number | null;
}

export interface ParticipantRow {
  id: string;
  event_id: string;
  name: string;
  color: string;
  sync_strategy: SyncStrategy;
  sort_order: number;
}

export interface TrackRow {
  id: string;
  participant_id: string;
  source_filename: string;
  points_path: string;
  /** For manual strategy: delta ms = offset_other - offset_ref (clock gap on shared timeline) */
  start_offset_ms: number;
}

export interface AnalysisCacheRow {
  event_id: string;
  payload_json: string;
  updated_at: string;
}

export interface HesitationEvent {
  startMs: number;
  endMs: number;
  durationMs: number;
  lat: number;
  lon: number;
}

export interface ComeBackEvent {
  atMs: number;
  lat: number;
  lon: number;
  /** Estimated wasted out-and-back meters */
  extraM: number;
  /**
   * Peer rating: only set when this retour is an outlier
   * (fastest did not, exactly one runner did, and they paid extra meters).
   */
  rating?: "outlier";
}

export interface VsBestInfo {
  anchorParticipantId: string;
  anchorName: string;
  distanceRatio: number;
  timeLossMs: number;
}

export interface DetourEvent {
  startMs: number;
  endMs: number;
  lat: number;
  lon: number;
  maxDeviationM: number;
}

export interface LegSplit {
  participantId: string;
  participantName: string;
  color: string;
  fromSeq: number;
  toSeq: number;
  fromCode: string;
  toCode: string;
  timeMs: number | null;
  distanceM: number | null;
  climbM: number | null;
  punchedFrom: boolean;
  punchedTo: boolean;
  hesitations?: HesitationEvent[];
  comeBack?: ComeBackEvent;
  vsBest?: VsBestInfo;
  detours?: DetourEvent[];
}

export interface AnalysisPayload {
  legs: {
    fromSeq: number;
    toSeq: number;
    fromCode: string;
    toCode: string;
    splits: LegSplit[];
  }[];
  syncOffsets: Record<string, number>;
  syncDeltasMs: Record<string, number>;
  referenceId: string | null;
  referenceWallTimeMs: number | null;
}

export const RUNNER_COLORS = [
  "#e74c3c",
  "#3498db",
  "#2ecc71",
  "#f39c12",
  "#9b59b6",
  "#1abc9c",
  "#e67e22",
  "#34495e",
  "#e91e63",
  "#00bcd4",
];

export const EXERCISE_LABELS: Record<ExerciseType, string> = {
  normal: "Normal course",
  route_choice: "Route choice",
  compass: "Compass",
  corridor: "Corridor",
  one_man_relay: "One-man relay",
  memory_o: "Memory-O",
};
