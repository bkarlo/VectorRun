import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

/** Override with DATA_DIR=/data on Railway (persistent volume). */
const DATA_DIR =
  process.env.DATA_DIR?.trim() || path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "vectorrun.db");

export function getDataDir() {
  return DATA_DIR;
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "uploads"), { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, "tracks"), { recursive: true });

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

function tableColumns(database: Database.Database, table: string): Set<string> {
  const rows = database.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return new Set(rows.map((r) => r.name));
}

function migrate(database: Database.Database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      exercise_type TEXT NOT NULL DEFAULT 'normal',
      sync_mode TEXT NOT NULL DEFAULT 'motion_start',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS maps (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
      image_path TEXT NOT NULL,
      width INTEGER NOT NULL,
      height INTEGER NOT NULL,
      georef_json TEXT NOT NULL DEFAULT '[]'
    );

    CREATE TABLE IF NOT EXISTS controls (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      code TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      lat REAL,
      lon REAL,
      map_x REAL,
      map_y REAL
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id TEXT PRIMARY KEY,
      participant_id TEXT NOT NULL UNIQUE REFERENCES participants(id) ON DELETE CASCADE,
      source_filename TEXT NOT NULL,
      points_path TEXT NOT NULL,
      start_offset_ms INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS analysis_cache (
      event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
      payload_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_controls_event ON controls(event_id, sequence);
    CREATE INDEX IF NOT EXISTS idx_participants_event ON participants(event_id);
  `);

  const eventCols = tableColumns(database, "events");
  if (!eventCols.has("reference_participant_id")) {
    database.exec(
      `ALTER TABLE events ADD COLUMN reference_participant_id TEXT`
    );
  }
  if (!eventCols.has("race_window_enabled")) {
    database.exec(
      `ALTER TABLE events ADD COLUMN race_window_enabled INTEGER NOT NULL DEFAULT 1`
    );
  }
  if (!eventCols.has("playback_trail_enabled")) {
    database.exec(
      `ALTER TABLE events ADD COLUMN playback_trail_enabled INTEGER NOT NULL DEFAULT 1`
    );
  }
  if (!eventCols.has("description")) {
    database.exec(`ALTER TABLE events ADD COLUMN description TEXT NOT NULL DEFAULT ''`);
  }
  if (!eventCols.has("punch_radius_m")) {
    database.exec(
      `ALTER TABLE events ADD COLUMN punch_radius_m REAL NOT NULL DEFAULT 15`
    );
  }
  if (!eventCols.has("show_basemap")) {
    database.exec(
      `ALTER TABLE events ADD COLUMN show_basemap INTEGER NOT NULL DEFAULT 1`
    );
  }
  if (!eventCols.has("show_control_symbols")) {
    database.exec(
      `ALTER TABLE events ADD COLUMN show_control_symbols INTEGER NOT NULL DEFAULT 1`
    );
  }
  if (!eventCols.has("control_symbol_scale")) {
    database.exec(
      `ALTER TABLE events ADD COLUMN control_symbol_scale REAL NOT NULL DEFAULT 0.7`
    );
  }
  if (!eventCols.has("occurred_on")) {
    database.exec(
      `ALTER TABLE events ADD COLUMN occurred_on TEXT NOT NULL DEFAULT ''`
    );
    database.exec(
      `UPDATE events SET occurred_on = substr(created_at, 1, 10) WHERE occurred_on = ''`
    );
  }
  if (!eventCols.has("show_course_line")) {
    database.exec(
      `ALTER TABLE events ADD COLUMN show_course_line INTEGER NOT NULL DEFAULT 1`
    );
  }
  if (!eventCols.has("course_line_weight")) {
    database.exec(
      `ALTER TABLE events ADD COLUMN course_line_weight REAL NOT NULL DEFAULT 2`
    );
  }
  if (!eventCols.has("control_stroke_scale")) {
    database.exec(
      `ALTER TABLE events ADD COLUMN control_stroke_scale REAL NOT NULL DEFAULT 1`
    );
  }
  if (!eventCols.has("runner_marker_scale")) {
    database.exec(
      `ALTER TABLE events ADD COLUMN runner_marker_scale REAL NOT NULL DEFAULT 1`
    );
  }
  if (!eventCols.has("track_weight")) {
    database.exec(
      `ALTER TABLE events ADD COLUMN track_weight REAL NOT NULL DEFAULT 3`
    );
  }
  if (!eventCols.has("trail_tail_ms")) {
    database.exec(
      `ALTER TABLE events ADD COLUMN trail_tail_ms INTEGER NOT NULL DEFAULT 0`
    );
  }

  const partCols = tableColumns(database, "participants");
  if (!partCols.has("sync_strategy")) {
    database.exec(
      `ALTER TABLE participants ADD COLUMN sync_strategy TEXT NOT NULL DEFAULT 'motion_start'`
    );
  }
  if (!partCols.has("sort_order")) {
    database.exec(
      `ALTER TABLE participants ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0`
    );
    // Backfill stable order from rowid
    database.exec(`
      UPDATE participants SET sort_order = (
        SELECT COUNT(*) FROM participants AS p2
        WHERE p2.event_id = participants.event_id AND p2.rowid <= participants.rowid
      )
    `);
  }

  const mapCols = tableColumns(database, "maps");
  if (!mapCols.has("opacity")) {
    database.exec(
      `ALTER TABLE maps ADD COLUMN opacity REAL NOT NULL DEFAULT 1`
    );
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS day_phases (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS phase_controls (
      phase_id TEXT NOT NULL REFERENCES day_phases(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      control_code TEXT NOT NULL,
      PRIMARY KEY (phase_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_day_phases_event ON day_phases(event_id, sort_order);
  `);

  const dayPhaseCols = tableColumns(database, "day_phases");
  if (!dayPhaseCols.has("course_json")) {
    database.exec(`ALTER TABLE day_phases ADD COLUMN course_json TEXT`);
  }

  database.exec(`
    CREATE TABLE IF NOT EXISTS punch_overrides (
      participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
      control_code TEXT NOT NULL,
      time_ms INTEGER NOT NULL,
      PRIMARY KEY (participant_id, control_code)
    );
  `);

  // Bump cache when analysis payload semantics change
  const userVersion = Number(
    database.pragma("user_version", { simple: true }) ?? 0
  );
  if (userVersion < 13) {
    database.exec(`DELETE FROM analysis_cache`);
    database.pragma("user_version = 13");
  }
  if (userVersion < 14) {
    // Playback trail default is now on
    database.exec(`UPDATE events SET playback_trail_enabled = 1`);
    database.pragma("user_version = 14");
  }
  if (userVersion < 15) {
    // Arrive punch = latest near-closest (analysis times change)
    database.exec(`DELETE FROM analysis_cache`);
    database.pragma("user_version = 15");
  }
  if (userVersion < 16) {
    // Tighter punch radius + closest-visit matching
    database.exec(`DELETE FROM analysis_cache`);
    database.pragma("user_version = 16");
  }
}

export function getUploadsDir() {
  const dir = path.join(DATA_DIR, "uploads");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function getTracksDir() {
  const dir = path.join(DATA_DIR, "tracks");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
