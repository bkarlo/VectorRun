export type ExerciseType =
  | "normal"
  | "route_choice"
  | "compass"
  | "corridor"
  | "one_man_relay"
  | "memory_o"
  | "multi_course";

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
  first_control: "Control 1",
  start_punch: "Start (S)",
  best_fit: "Best fit",
  manual: "Manual",
};

/** Short hints for UI tooltips (warm-up / sync guidance). */
export const SYNC_STRATEGY_HINTS: Record<SyncStrategy, string> = {
  motion_start: "Align when sustained running begins (can catch warm-up jogging).",
  recording_start: "Align first GPS points — poor if warm-up lengths differ.",
  track_match: "Slide tracks to best spatial overlap.",
  first_control: "Align on control 1 (after start punch). Good with warm-up in GPX.",
  start_punch: "Align on the first course control (start triangle). Best with warm-up in GPX.",
  best_fit: "Prefer control 1, else track match.",
  manual: "Set Δ vs reference yourself.",
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
  /** When true, map timeline scopes to first→last control (default on). */
  race_window_enabled: boolean;
  /**
   * When true, map only shows each runner's track up to the playhead
   * (trail draws as they move). Default on.
   */
  playback_trail_enabled: boolean;
  /** Optional trainer notes (who set the course, training goal, …). */
  description: string;
  /** Punch detection circle in metres (default 15). */
  punch_radius_m: number;
  /** Show OSM/satellite tiles under the orienteering map. */
  show_basemap: boolean;
  /** Draw VectorRun control circles (turn off when the map already has them). */
  show_control_symbols: boolean;
  /** Scale of overlay control symbols (1 = ~30 m on the ground). */
  control_symbol_scale: number;
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

export interface AnalysisLeg {
  fromSeq: number;
  toSeq: number;
  fromCode: string;
  toCode: string;
  /** Present when this leg is on (or exits) a fork arm. */
  forkId?: string;
  forkLabel?: string;
  armId?: string;
  armLabel?: string;
  splits: LegSplit[];
}

export type DayPhaseKind = "transit" | "rest" | "course";

export interface DayPhaseRow {
  id: string;
  event_id: string;
  kind: DayPhaseKind;
  name: string;
  sort_order: number;
  /**
   * Compat / projection: all codes used in the course (spine + fork arms).
   * Prefer `courseDef` for structure.
   */
  controlCodes: string[];
  /** Course AST; null for transit/rest. Linear courses are control-only steps. */
  courseDef: import("./courseDef").CourseDef | null;
}

export interface RealizedRunnerPath {
  codes: string[];
  /** forkId → chosen armId */
  forks: Record<string, string>;
  /** Punch indices into the course-synced slice (aligned with codes). */
  punchIndices: number[];
}

export interface AnalysisCoursePhase {
  id: string;
  name: string;
  sortOrder: number;
  /** All codes used (compat). */
  controlCodes: string[];
  courseDef: import("./courseDef").CourseDef | null;
  overall: AnalysisLeg | null;
  legs: AnalysisLeg[];
  /** Sync for this course only (independent of other courses). */
  syncOffsets: Record<string, number>;
  syncDeltasMs: Record<string, number>;
  referenceId: string | null;
  referenceWallTimeMs: number | null;
  /** Real-time raw-track indices (fromIdx→toIdx) per participant for this course. */
  windows: Record<string, { fromIdx: number; toIdx: number }>;
  /** Per-runner realized linear path after fork choice. */
  realizedPath: Record<string, RealizedRunnerPath>;
}

export interface AnalysisPayload {
  /** Orienteering attempts in day order (repeats allowed). */
  coursePhases: AnalysisCoursePhase[];
  /**
   * Compat: first course phase overall/legs (or null/[] if none).
   * Prefer coursePhases in new UI.
   */
  overall: AnalysisLeg | null;
  legs: AnalysisLeg[];
  /** Compat: first course sync. Prefer coursePhases[i].sync*. */
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
  multi_course: "Multi-course",
};
