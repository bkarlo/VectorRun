import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";
import { analyzeEvent, type RunnerTrack } from "./analysis";
import {
  collectAllCodes,
  courseDefFromCodes,
  parseCourseDef,
  type CourseDef,
} from "./courseDef";
import { getDb, getTracksDir, getUploadsDir } from "./db";
import { defaultSyncStrategy } from "./sync";
import type {
  AnalysisPayload,
  ControlRow,
  DayPhaseKind,
  DayPhaseRow,
  EventRow,
  ExerciseType,
  GeorefPair,
  MapRow,
  ParticipantRow,
  SyncStrategy,
  TrackPoint,
  TrackRow,
} from "./types";
import { RUNNER_COLORS } from "./types";

function normalizeParticipant(row: ParticipantRow): ParticipantRow {
  return {
    ...row,
    sync_strategy: (row.sync_strategy || "motion_start") as SyncStrategy,
    sort_order: row.sort_order ?? 0,
  };
}

function normalizeEvent(row: EventRow): EventRow {
  const raw = row as unknown as {
    reference_participant_id?: string | null;
    race_window_enabled?: number | boolean;
    playback_trail_enabled?: number | boolean;
  };
  return {
    ...row,
    reference_participant_id: raw.reference_participant_id ?? null,
    race_window_enabled:
      raw.race_window_enabled === false || raw.race_window_enabled === 0
        ? false
        : true,
    playback_trail_enabled:
      raw.playback_trail_enabled === false || raw.playback_trail_enabled === 0
        ? false
        : true,
  };
}

export function listEvents(): EventRow[] {
  return (
    getDb()
      .prepare("SELECT * FROM events ORDER BY created_at DESC")
      .all() as EventRow[]
  ).map(normalizeEvent);
}

export function getEvent(id: string): EventRow | undefined {
  const row = getDb().prepare("SELECT * FROM events WHERE id = ?").get(id) as
    | EventRow
    | undefined;
  return row ? normalizeEvent(row) : undefined;
}

export function createEvent(name: string, exerciseType: ExerciseType): EventRow {
  const id = uuid();
  const created_at = new Date().toISOString();
  getDb()
    .prepare(
      `INSERT INTO events (id, name, exercise_type, sync_mode, reference_participant_id, created_at)
       VALUES (?, ?, ?, 'motion_start', NULL, ?)`
    )
    .run(id, name, exerciseType, created_at);
  return getEvent(id)!;
}

export function updateEvent(
  id: string,
  patch: Partial<
    Pick<EventRow, "name" | "exercise_type" | "sync_mode" | "reference_participant_id">
  >
) {
  const event = getEvent(id);
  if (!event) throw new Error("Event not found");
  getDb()
    .prepare(
      `UPDATE events SET name = ?, exercise_type = ?, sync_mode = ?, reference_participant_id = ? WHERE id = ?`
    )
    .run(
      patch.name ?? event.name,
      patch.exercise_type ?? event.exercise_type,
      patch.sync_mode ?? event.sync_mode,
      patch.reference_participant_id !== undefined
        ? patch.reference_participant_id
        : event.reference_participant_id,
      id
    );
  invalidateAnalysis(id);
  return getEvent(id)!;
}

export function setRaceWindowEnabled(eventId: string, enabled: boolean) {
  getDb()
    .prepare(`UPDATE events SET race_window_enabled = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, eventId);
  return getEvent(eventId)!;
}

export function setPlaybackTrailEnabled(eventId: string, enabled: boolean) {
  getDb()
    .prepare(`UPDATE events SET playback_trail_enabled = ? WHERE id = ?`)
    .run(enabled ? 1 : 0, eventId);
  return getEvent(eventId)!;
}

export function setReferenceParticipant(
  eventId: string,
  participantId: string
) {
  updateEvent(eventId, { reference_participant_id: participantId });
}

export function setParticipantSyncStrategy(
  participantId: string,
  strategy: SyncStrategy
) {
  const participant = getDb()
    .prepare(`SELECT * FROM participants WHERE id = ?`)
    .get(participantId) as ParticipantRow | undefined;
  if (!participant) return;
  getDb()
    .prepare(`UPDATE participants SET sync_strategy = ? WHERE id = ?`)
    .run(strategy, participantId);
  invalidateAnalysis(participant.event_id);
}

/** Store manual delta (ms vs reference timeline start) and set strategy to manual. */
export function setManualDelta(participantId: string, deltaMs: number) {
  const participant = getDb()
    .prepare(`SELECT * FROM participants WHERE id = ?`)
    .get(participantId) as ParticipantRow | undefined;
  if (!participant) return;
  getDb()
    .prepare(
      `UPDATE participants SET sync_strategy = 'manual' WHERE id = ?`
    )
    .run(participantId);
  getDb()
    .prepare(`UPDATE tracks SET start_offset_ms = ? WHERE participant_id = ?`)
    .run(deltaMs, participantId);
  invalidateAnalysis(participant.event_id);
}

export function deleteEvent(id: string) {
  const map = getMap(id);
  if (map) {
    const full = path.join(getUploadsDir(), path.basename(map.image_path));
    if (fs.existsSync(full)) fs.unlinkSync(full);
  }
  const parts = listParticipants(id);
  for (const p of parts) {
    const track = getTrackForParticipant(p.id);
    if (track && fs.existsSync(track.points_path)) {
      fs.unlinkSync(track.points_path);
    }
  }
  getDb().prepare("DELETE FROM events WHERE id = ?").run(id);
}

export function getMap(eventId: string): MapRow | undefined {
  const row = getDb()
    .prepare("SELECT * FROM maps WHERE event_id = ?")
    .get(eventId) as MapRow | undefined;
  if (!row) return undefined;
  return {
    ...row,
    opacity:
      typeof row.opacity === "number" && Number.isFinite(row.opacity)
        ? row.opacity
        : 0.55,
  };
}

export function saveMapImage(
  eventId: string,
  filename: string,
  buffer: Buffer,
  width: number,
  height: number
): MapRow {
  const ext = path.extname(filename) || ".png";
  const stored = `${eventId}${ext}`;
  const dest = path.join(getUploadsDir(), stored);
  fs.writeFileSync(dest, buffer);

  const existing = getMap(eventId);
  if (existing) {
    getDb()
      .prepare(
        `UPDATE maps SET image_path = ?, width = ?, height = ? WHERE event_id = ?`
      )
      .run(stored, width, height, eventId);
  } else {
    getDb()
      .prepare(
        `INSERT INTO maps (id, event_id, image_path, width, height, georef_json)
         VALUES (?, ?, ?, ?, ?, '[]')`
      )
      .run(uuid(), eventId, stored, width, height);
  }
  return getMap(eventId)!;
}

export function saveGeoref(eventId: string, pairs: GeorefPair[]) {
  getDb()
    .prepare(`UPDATE maps SET georef_json = ? WHERE event_id = ?`)
    .run(JSON.stringify(pairs), eventId);
}

export function saveMapOpacity(eventId: string, opacity: number) {
  const clamped = Math.min(0.95, Math.max(0.1, opacity));
  getDb()
    .prepare(`UPDATE maps SET opacity = ? WHERE event_id = ?`)
    .run(clamped, eventId);
}

export function listControls(eventId: string): ControlRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM controls WHERE event_id = ? ORDER BY sequence ASC`
    )
    .all(eventId) as ControlRow[];
}

export function replaceControls(
  eventId: string,
  controls: Omit<ControlRow, "id" | "event_id">[]
) {
  const db = getDb();
  const del = db.prepare(`DELETE FROM controls WHERE event_id = ?`);
  const ins = db.prepare(
    `INSERT INTO controls (id, event_id, code, sequence, lat, lon, map_x, map_y)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction(() => {
    del.run(eventId);
    for (const c of controls) {
      ins.run(
        uuid(),
        eventId,
        c.code,
        c.sequence,
        c.lat,
        c.lon,
        c.map_x,
        c.map_y
      );
    }
  });
  tx();
  ensureDayPlan(eventId);
  invalidateAnalysis(eventId);
}

export function listDayPhases(eventId: string): DayPhaseRow[] {
  ensureDayPlan(eventId);
  const phases = getDb()
    .prepare(
      `SELECT * FROM day_phases WHERE event_id = ? ORDER BY sort_order ASC`
    )
    .all(eventId) as {
    id: string;
    event_id: string;
    kind: DayPhaseKind;
    name: string;
    sort_order: number;
    course_json?: string | null;
  }[];

  const codesStmt = getDb().prepare(
    `SELECT control_code FROM phase_controls WHERE phase_id = ? ORDER BY sequence ASC`
  );

  return phases.map((p) => {
    const legacyCodes =
      p.kind === "course"
        ? (codesStmt.all(p.id) as { control_code: string }[]).map(
            (r) => r.control_code
          )
        : [];

    let courseDef: CourseDef | null = null;
    if (p.kind === "course") {
      if (p.course_json) {
        try {
          courseDef = parseCourseDef(JSON.parse(p.course_json));
        } catch {
          courseDef = null;
        }
      }
      if (!courseDef && legacyCodes.length > 0) {
        courseDef = courseDefFromCodes(legacyCodes);
      }
    }

    return {
      id: p.id,
      event_id: p.event_id,
      kind: p.kind,
      name: p.name,
      sort_order: p.sort_order,
      controlCodes: courseDef ? collectAllCodes(courseDef) : legacyCodes,
      courseDef,
    };
  });
}

/**
 * If no day plan exists, create a single Course phase from current controls
 * (ordered by sequence). Safe to call repeatedly.
 */
export function ensureDayPlan(eventId: string) {
  const db = getDb();
  const count = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM day_phases WHERE event_id = ?`)
      .get(eventId) as { n: number }
  ).n;
  if (count > 0) return;

  const controls = listControls(eventId);
  const geoCodes = controls
    .filter((c) => c.lat != null && c.lon != null)
    .sort((a, b) => a.sequence - b.sequence)
    .map((c) => c.code);
  if (geoCodes.length < 2) return;

  const phaseId = uuid();
  const def = courseDefFromCodes(geoCodes);
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO day_phases (id, event_id, kind, name, sort_order, course_json)
       VALUES (?, ?, 'course', 'Course', 0, ?)`
    ).run(phaseId, eventId, JSON.stringify(def));
    const ins = db.prepare(
      `INSERT INTO phase_controls (phase_id, sequence, control_code)
       VALUES (?, ?, ?)`
    );
    geoCodes.forEach((code, i) => ins.run(phaseId, i, code));
  });
  tx();
}

export function replaceDayPlan(
  eventId: string,
  phases: {
    kind: DayPhaseKind;
    name: string;
    controlCodes?: string[];
    courseDef?: CourseDef | null;
  }[]
) {
  const db = getDb();
  const tx = db.transaction(() => {
    const existing = db
      .prepare(`SELECT id FROM day_phases WHERE event_id = ?`)
      .all(eventId) as { id: string }[];
    for (const row of existing) {
      db.prepare(`DELETE FROM phase_controls WHERE phase_id = ?`).run(row.id);
    }
    db.prepare(`DELETE FROM day_phases WHERE event_id = ?`).run(eventId);

    const insPhase = db.prepare(
      `INSERT INTO day_phases (id, event_id, kind, name, sort_order, course_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insCtrl = db.prepare(
      `INSERT INTO phase_controls (phase_id, sequence, control_code)
       VALUES (?, ?, ?)`
    );

    phases.forEach((p, i) => {
      const id = uuid();
      const name =
        p.name.trim() ||
        (p.kind === "course"
          ? `Course ${i + 1}`
          : p.kind === "rest"
            ? "Rest"
            : "Transit");

      let courseJson: string | null = null;
      let projection: string[] = [];
      if (p.kind === "course") {
        const def =
          p.courseDef ??
          (p.controlCodes?.length
            ? courseDefFromCodes(p.controlCodes)
            : emptyCourseDefSafe(p.controlCodes));
        courseJson = JSON.stringify(def);
        projection = collectAllCodes(def);
      }

      insPhase.run(id, eventId, p.kind, name, i, courseJson);
      projection.forEach((code, j) => insCtrl.run(id, j, code));
    });
  });
  tx();
  invalidateAnalysis(eventId);
}

function emptyCourseDefSafe(codes?: string[]): CourseDef {
  return courseDefFromCodes(codes ?? []);
}

export function listParticipants(eventId: string): ParticipantRow[] {
  return (
    getDb()
      .prepare(
        `SELECT * FROM participants WHERE event_id = ? ORDER BY sort_order ASC, name ASC`
      )
      .all(eventId) as ParticipantRow[]
  ).map(normalizeParticipant);
}

export function addParticipant(eventId: string, name: string): ParticipantRow {
  const existing = listParticipants(eventId);
  const color = RUNNER_COLORS[existing.length % RUNNER_COLORS.length];
  const id = uuid();
  const controls = listControls(eventId);
  const hasGeo = controls.some((c) => c.lat != null && c.lon != null);
  const strategy = defaultSyncStrategy(hasGeo);
  const sort_order =
    existing.length === 0
      ? 1
      : Math.max(...existing.map((p) => p.sort_order), 0) + 1;

  getDb()
    .prepare(
      `INSERT INTO participants (id, event_id, name, color, sync_strategy, sort_order)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(id, eventId, name, color, strategy, sort_order);

  const event = getEvent(eventId);
  if (event && !event.reference_participant_id) {
    updateEvent(eventId, { reference_participant_id: id });
  }

  return normalizeParticipant(
    getDb()
      .prepare(`SELECT * FROM participants WHERE id = ?`)
      .get(id) as ParticipantRow
  );
}

export function renameParticipant(participantId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  const participant = getDb()
    .prepare(`SELECT * FROM participants WHERE id = ?`)
    .get(participantId) as ParticipantRow | undefined;
  if (!participant) return;
  getDb()
    .prepare(`UPDATE participants SET name = ? WHERE id = ?`)
    .run(trimmed, participantId);
  invalidateAnalysis(participant.event_id);
}

export function deleteParticipant(participantId: string) {
  const track = getTrackForParticipant(participantId);
  const participant = getDb()
    .prepare(`SELECT * FROM participants WHERE id = ?`)
    .get(participantId) as ParticipantRow | undefined;
  if (track && fs.existsSync(track.points_path)) {
    fs.unlinkSync(track.points_path);
  }
  getDb().prepare(`DELETE FROM participants WHERE id = ?`).run(participantId);
  if (participant) {
    const event = getEvent(participant.event_id);
    if (event?.reference_participant_id === participantId) {
      const remaining = listParticipants(participant.event_id);
      updateEvent(participant.event_id, {
        reference_participant_id: remaining[0]?.id ?? null,
      });
    }
    invalidateAnalysis(participant.event_id);
  }
}

/** Ensure event has a reference (first by sort_order). */
export function ensureReference(eventId: string): string | null {
  const event = getEvent(eventId);
  if (!event) return null;
  const parts = listParticipants(eventId);
  if (parts.length === 0) {
    if (event.reference_participant_id) {
      updateEvent(eventId, { reference_participant_id: null });
    }
    return null;
  }
  if (
    event.reference_participant_id &&
    parts.some((p) => p.id === event.reference_participant_id)
  ) {
    return event.reference_participant_id;
  }
  updateEvent(eventId, { reference_participant_id: parts[0].id });
  return parts[0].id;
}

export function getTrackForParticipant(
  participantId: string
): TrackRow | undefined {
  return getDb()
    .prepare(`SELECT * FROM tracks WHERE participant_id = ?`)
    .get(participantId) as TrackRow | undefined;
}

export function saveTrack(
  participantId: string,
  sourceFilename: string,
  points: TrackPoint[]
): TrackRow {
  const participant = getDb()
    .prepare(`SELECT * FROM participants WHERE id = ?`)
    .get(participantId) as ParticipantRow;
  const pointsPath = path.join(getTracksDir(), `${participantId}.json`);
  fs.writeFileSync(pointsPath, JSON.stringify(points));

  const existing = getTrackForParticipant(participantId);
  if (existing) {
    getDb()
      .prepare(
        `UPDATE tracks SET source_filename = ?, points_path = ?, start_offset_ms = 0 WHERE id = ?`
      )
      .run(sourceFilename, pointsPath, existing.id);
  } else {
    getDb()
      .prepare(
        `INSERT INTO tracks (id, participant_id, source_filename, points_path, start_offset_ms)
         VALUES (?, ?, ?, ?, 0)`
      )
      .run(uuid(), participantId, sourceFilename, pointsPath);
  }
  invalidateAnalysis(participant.event_id);
  return getTrackForParticipant(participantId)!;
}

export function setManualOffset(participantId: string, offsetMs: number) {
  setManualDelta(participantId, offsetMs);
}

export function loadTrackPoints(track: TrackRow): TrackPoint[] {
  if (!fs.existsSync(track.points_path)) return [];
  return JSON.parse(fs.readFileSync(track.points_path, "utf8")) as TrackPoint[];
}

export function invalidateAnalysis(eventId: string) {
  getDb().prepare(`DELETE FROM analysis_cache WHERE event_id = ?`).run(eventId);
}

export function getOrComputeAnalysis(eventId: string): AnalysisPayload {
  const event = getEvent(eventId);
  if (!event) throw new Error("Event not found");

  const referenceId = ensureReference(eventId);
  const controls = listControls(eventId);

  // Ensure non-ref runners have a sensible default strategy if still on control-based without controls
  const hasGeo = controls.some((c) => c.lat != null && c.lon != null);
  const participants = listParticipants(eventId);
  for (const p of participants) {
    if (p.id === referenceId) continue;
    if (
      !hasGeo &&
      (p.sync_strategy === "first_control" ||
        p.sync_strategy === "start_punch" ||
        p.sync_strategy === "best_fit")
    ) {
      setParticipantSyncStrategy(p.id, "motion_start");
    }
  }

  // Sanitize legacy absolute offsets mistakenly stored as manual deltas
  for (const p of listParticipants(eventId)) {
    const track = getTrackForParticipant(p.id);
    if (
      track &&
      Math.abs(track.start_offset_ms) > 86_400_000
    ) {
      getDb()
        .prepare(`UPDATE tracks SET start_offset_ms = 0 WHERE id = ?`)
        .run(track.id);
      invalidateAnalysis(eventId);
    }
  }

  const cached = getDb()
    .prepare(`SELECT * FROM analysis_cache WHERE event_id = ?`)
    .get(eventId) as { payload_json: string } | undefined;
  if (cached) {
    const payload = JSON.parse(cached.payload_json) as AnalysisPayload;
    // Old cache shape — recompute
    const firstPhase = payload.coursePhases?.[0];
    if (
      payload.syncDeltasMs === undefined ||
      payload.referenceId === undefined ||
      payload.coursePhases === undefined ||
      firstPhase?.syncOffsets === undefined ||
      firstPhase?.windows === undefined ||
      firstPhase?.realizedPath === undefined
    ) {
      invalidateAnalysis(eventId);
    } else {
      return payload;
    }
  }

  const runners: RunnerTrack[] = [];
  for (const p of listParticipants(eventId)) {
    const track = getTrackForParticipant(p.id);
    if (!track) continue;
    runners.push({
      participant: p,
      track,
      points: loadTrackPoints(track),
    });
  }

  const dayPhases = listDayPhases(eventId);
  const payload = analyzeEvent(referenceId, controls, runners, dayPhases);
  getDb()
    .prepare(
      `INSERT INTO analysis_cache (event_id, payload_json, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(event_id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`
    )
    .run(eventId, JSON.stringify(payload), new Date().toISOString());
  return payload;
}

export function getEventBundle(eventId: string) {
  const map = getMap(eventId);
  const controls = listControls(eventId);
  const dayPhases = listDayPhases(eventId);
  const participants = listParticipants(eventId);
  const tracks = participants.map((p) => {
    const track = getTrackForParticipant(p.id);
    const points = track ? loadTrackPoints(track) : [];
    return { participant: p, track, points };
  });
  const analysis = getOrComputeAnalysis(eventId);
  const event = getEvent(eventId);
  if (!event) return null;
  return { event, map, controls, dayPhases, tracks, analysis };
}

function downsamplePoints(points: TrackPoint[], max = 600): TrackPoint[] {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out: TrackPoint[] = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/** Lightweight tracks for setup (overlay fit) — downsampled for the client. */
export function listSetupTracks(eventId: string): {
  id: string;
  name: string;
  color: string;
  points: TrackPoint[];
}[] {
  return listParticipants(eventId).flatMap((p) => {
    const track = getTrackForParticipant(p.id);
    if (!track) return [];
    const points = downsamplePoints(loadTrackPoints(track));
    if (points.length === 0) return [];
    return [{ id: p.id, name: p.name, color: p.color, points }];
  });
}
