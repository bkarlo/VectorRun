/**
 * Seed a demo event with a synthetic map, controls, and three GPX tracks.
 * Usage: npm run seed
 */
import fs from "fs";
import path from "path";
import { deflateSync } from "zlib";
import { v4 as uuid } from "uuid";
import Database from "better-sqlite3";

const ROOT = process.cwd();
const DATA = process.env.DATA_DIR?.trim() || path.join(ROOT, "data");
const UPLOADS = path.join(DATA, "uploads");
const TRACKS = path.join(DATA, "tracks");
const DB_PATH = path.join(DATA, "vectorrun.db");

const EVENT_ID = "00000000-0000-4000-8000-000000000001";
const MAP_W = 800;
const MAP_H = 600;

// Map bounds (lat/lon)
const SOUTH = 59.33;
const NORTH = 59.336;
const WEST = 18.06;
const EAST = 18.07;

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcBuf), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** Simple RGB PNG of a forest-green map with grid + control marks */
function createDemoMapPng(controls: { x: number; y: number; code: string }[]): Buffer {
  const width = MAP_W;
  const height = MAP_H;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const i = row + 1 + x * 3;
      // base terrain
      let r = 180 + ((x * 3 + y * 5) % 40);
      let g = 200 + ((x + y * 2) % 30);
      let b = 150 + ((x * 2 + y) % 25);
      // paths
      if (Math.abs(y - height * 0.4) < 3 || Math.abs(x - width * 0.55) < 2) {
        r = 210;
        g = 190;
        b = 140;
      }
      // grid
      if (x % 80 === 0 || y % 80 === 0) {
        r = Math.floor(r * 0.85);
        g = Math.floor(g * 0.85);
        b = Math.floor(b * 0.85);
      }
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  // draw control circles
  for (const c of controls) {
    const cx = Math.round(c.x);
    const cy = Math.round(c.y);
    for (let dy = -10; dy <= 10; dy++) {
      for (let dx = -10; dx <= 10; dx++) {
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > 9 && dist < 11) {
          const x = cx + dx;
          const y = cy + dy;
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const row = y * (width * 3 + 1);
          const i = row + 1 + x * 3;
          raw[i] = 200;
          raw[i + 1] = 40;
          raw[i + 2] = 40;
        }
      }
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const compressed = deflateSync(raw);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function mapToGps(x: number, y: number) {
  const lon = WEST + (x / MAP_W) * (EAST - WEST);
  const lat = NORTH - (y / MAP_H) * (NORTH - SOUTH); // y down
  return { lat, lon };
}

function gpsToMap(lat: number, lon: number) {
  const x = ((lon - WEST) / (EAST - WEST)) * MAP_W;
  const y = ((NORTH - lat) / (NORTH - SOUTH)) * MAP_H;
  return { x, y };
}

function iso(t: number) {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

function makeGpx(
  name: string,
  points: { lat: number; lon: number; ele: number; time: number }[]
): string {
  const trkpts = points
    .map(
      (p) =>
        `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}"><ele>${p.ele.toFixed(1)}</ele><time>${iso(p.time)}</time></trkpt>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="VectorRun-seed">
  <trk><name>${name}</name><trkseg>
${trkpts}
  </trkseg></trk>
</gpx>`;
}

function interpolateRoute(
  waypoints: { lat: number; lon: number }[],
  startTime: number,
  speedMs: number,
  noise = 0
) {
  const points: { lat: number; lon: number; ele: number; time: number }[] = [];
  let t = startTime;
  let ele = 40;
  for (let i = 0; i < waypoints.length - 1; i++) {
    const a = waypoints[i];
    const b = waypoints[i + 1];
    const dist = Math.hypot(
      (b.lat - a.lat) * 111320,
      (b.lon - a.lon) * 111320 * Math.cos((a.lat * Math.PI) / 180)
    );
    const steps = Math.max(8, Math.round(dist / 8));
    for (let s = 0; s < steps; s++) {
      const u = s / steps;
      const lat =
        a.lat +
        (b.lat - a.lat) * u +
        (Math.random() - 0.5) * noise;
      const lon =
        a.lon +
        (b.lon - a.lon) * u +
        (Math.random() - 0.5) * noise;
      ele += (Math.random() - 0.45) * 0.4;
      points.push({ lat, lon, ele, time: t });
      t += (dist / steps / speedMs) * 1000;
    }
  }
  const last = waypoints[waypoints.length - 1];
  points.push({ lat: last.lat, lon: last.lon, ele, time: t });
  return points;
}

function migrate(db: Database.Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      exercise_type TEXT NOT NULL DEFAULT 'normal',
      sync_mode TEXT NOT NULL DEFAULT 'track_match',
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
  `);
}

function main() {
  fs.mkdirSync(UPLOADS, { recursive: true });
  fs.mkdirSync(TRACKS, { recursive: true });
  fs.mkdirSync(path.join(DATA, "fixtures"), { recursive: true });

  const controlsDef = [
    { code: "S", sequence: 0, lat: 59.3312, lon: 18.0615 },
    { code: "1", sequence: 1, lat: 59.3328, lon: 18.0648 },
    { code: "2", sequence: 2, lat: 59.3345, lon: 18.0672 },
    { code: "3", sequence: 3, lat: 59.3352, lon: 18.064 },
    { code: "F", sequence: 4, lat: 59.3335, lon: 18.0618 },
  ].map((c) => {
    const m = gpsToMap(c.lat, c.lon);
    return { ...c, map_x: m.x, map_y: m.y };
  });

  const png = createDemoMapPng(
    controlsDef.map((c) => ({ x: c.map_x, y: c.map_y, code: c.code }))
  );
  const mapFile = `${EVENT_ID}.png`;
  fs.writeFileSync(path.join(UPLOADS, mapFile), png);

  const georef = [
    { map: { x: 0, y: MAP_H }, gps: { lat: SOUTH, lon: WEST } },
    { map: { x: MAP_W, y: MAP_H }, gps: { lat: SOUTH, lon: EAST } },
    { map: { x: 0, y: 0 }, gps: { lat: NORTH, lon: WEST } },
    { map: { x: MAP_W, y: 0 }, gps: { lat: NORTH, lon: EAST } },
  ];

  // Routes: left, straight-ish, right
  const base = controlsDef.map((c) => ({ lat: c.lat, lon: c.lon }));
  const left = [
    base[0],
    { lat: 59.3318, lon: 18.061 },
    { lat: 59.333, lon: 18.0625 },
    base[1],
    { lat: 59.3335, lon: 18.0665 },
    base[2],
    { lat: 59.335, lon: 18.0655 },
    base[3],
    base[4],
  ];
  const mid = [
    base[0],
    base[1],
    base[2],
    base[3],
    base[4],
  ];
  const right = [
    base[0],
    { lat: 59.3315, lon: 18.0635 },
    { lat: 59.3325, lon: 18.0655 },
    base[1],
    { lat: 59.3338, lon: 18.068 },
    base[2],
    { lat: 59.3355, lon: 18.066 },
    base[3],
    { lat: 59.3342, lon: 18.0625 },
    base[4],
  ];

  const t0 = Date.UTC(2024, 5, 15, 10, 0, 0);
  const runners = [
    {
      name: "Peter",
      color: "#e74c3c",
      points: interpolateRoute(left, t0, 3.2, 0.00001),
      file: "peter.gpx",
    },
    {
      name: "Anna",
      color: "#3498db",
      points: interpolateRoute(mid, t0 + 45_000, 3.5, 0.000008),
      file: "anna.gpx",
    },
    {
      name: "Tom",
      color: "#2ecc71",
      points: interpolateRoute(right, t0 + 90_000, 3.0, 0.000012),
      file: "tom.gpx",
    },
  ];

  for (const r of runners) {
    const gpx = makeGpx(r.name, r.points);
    fs.writeFileSync(path.join(DATA, "fixtures", r.file), gpx);
  }

  const db = new Database(DB_PATH);
  db.pragma("foreign_keys = ON");
  migrate(db);

  db.prepare(`DELETE FROM events WHERE id = ?`).run(EVENT_ID);

  db.prepare(
    `INSERT INTO events (id, name, exercise_type, sync_mode, created_at)
     VALUES (?, ?, 'route_choice', 'track_match', ?)`
  ).run(EVENT_ID, "Demo · Nacka training", new Date().toISOString());

  db.prepare(
    `INSERT INTO maps (id, event_id, image_path, width, height, georef_json)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(uuid(), EVENT_ID, mapFile, MAP_W, MAP_H, JSON.stringify(georef));

  const insControl = db.prepare(
    `INSERT INTO controls (id, event_id, code, sequence, lat, lon, map_x, map_y)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const c of controlsDef) {
    insControl.run(
      uuid(),
      EVENT_ID,
      c.code,
      c.sequence,
      c.lat,
      c.lon,
      c.map_x,
      c.map_y
    );
  }

  for (const r of runners) {
    const pid = uuid();
    db.prepare(
      `INSERT INTO participants (id, event_id, name, color) VALUES (?, ?, ?, ?)`
    ).run(pid, EVENT_ID, r.name, r.color);
    const pointsPath = path.join(TRACKS, `${pid}.json`);
    fs.writeFileSync(pointsPath, JSON.stringify(r.points));
    db.prepare(
      `INSERT INTO tracks (id, participant_id, source_filename, points_path, start_offset_ms)
       VALUES (?, ?, ?, ?, 0)`
    ).run(uuid(), pid, r.file, pointsPath);
  }

  db.close();
  console.log("Demo event seeded.");
  console.log(`Open: http://localhost:3000/events/${EVENT_ID}`);
  void mapToGps;
}

main();
