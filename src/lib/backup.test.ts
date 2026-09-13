import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import JSZip from "jszip";
import { openDatabaseAt } from "./db";
import {
  BACKUP_FORMAT,
  backupFilename,
  createBackupArchive,
  restoreBackupArchive,
} from "./backup";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vr-bak-test-"));
}

function seedMiniInstance(root: string) {
  const uploads = path.join(root, "uploads");
  const tracks = path.join(root, "tracks");
  fs.mkdirSync(uploads, { recursive: true });
  fs.mkdirSync(tracks, { recursive: true });
  const db = openDatabaseAt(path.join(root, "vectorrun.db"));
  const eventId = "evt-1";
  const participantId = "p-1";
  const created = "2026-09-13T12:00:00.000Z";
  db.prepare(
    `INSERT INTO events (id, name, exercise_type, sync_mode, reference_participant_id, created_at, occurred_on)
     VALUES (?, ?, 'normal', 'motion_start', NULL, ?, ?)`
  ).run(eventId, "Night-O", created, "2026-09-12");
  db.prepare(
    `INSERT INTO maps (id, event_id, image_path, width, height, georef_json, opacity)
     VALUES (?, ?, ?, 10, 10, '[]', 1)`
  ).run("map-1", eventId, `${eventId}.png`);
  db.prepare(
    `INSERT INTO participants (id, event_id, name, color)
     VALUES (?, ?, 'Ada', '#c00')`
  ).run(participantId, eventId);
  const oldPath = path.join("/old/machine/data/tracks", `${participantId}.json`);
  db.prepare(
    `INSERT INTO tracks (id, participant_id, source_filename, points_path, start_offset_ms)
     VALUES (?, ?, 'ada.gpx', ?, 0)`
  ).run("trk-1", participantId, oldPath);
  db.prepare(
    `INSERT INTO analysis_cache (event_id, payload_json, updated_at)
     VALUES (?, '{}', ?)`
  ).run(eventId, created);

  fs.writeFileSync(path.join(uploads, `${eventId}.png`), Buffer.from([137, 80, 78, 71]));
  fs.writeFileSync(
    path.join(tracks, `${participantId}.json`),
    JSON.stringify([{ lat: 47.1, lon: 19.2, ele: null, time: 1000 }])
  );
  return { db, uploads, tracks, eventId, participantId };
}

describe("backupFilename", () => {
  it("uses UTC date", () => {
    assert.equal(
      backupFilename(new Date("2026-09-13T23:30:00Z")),
      "vectorrun-backup-2026-09-13.vrbak"
    );
  });
});

describe("backup archive", () => {
  it("round-trips events, map image, and tracks with rewritten paths", async () => {
    const src = tmpDir();
    const { db, uploads, tracks, eventId, participantId } = seedMiniInstance(src);
    const archive = await createBackupArchive({
      database: db,
      uploadsDir: uploads,
      tracksDir: tracks,
    });
    db.close();

    const zip = await JSZip.loadAsync(archive);
    assert.ok(zip.file("manifest.json"));
    assert.ok(zip.file("db.sqlite"));
    const snapBytes = Buffer.from(await zip.file("db.sqlite")!.async("nodebuffer"));
    const snapPath = path.join(src, "snap.sqlite");
    fs.writeFileSync(snapPath, snapBytes);
    const snap = new Database(snapPath, { fileMustExist: true });
    const cacheN = (
      snap.prepare("SELECT count(*) AS n FROM analysis_cache").get() as { n: number }
    ).n;
    snap.close();
    assert.equal(cacheN, 0);

    const dest = tmpDir();
    // Existing dest data should be replaced.
    fs.mkdirSync(path.join(dest, "uploads"), { recursive: true });
    fs.writeFileSync(path.join(dest, "uploads", "stale.png"), "x");

    const manifest = await restoreBackupArchive(archive, dest);
    assert.equal(manifest.format, BACKUP_FORMAT);
    assert.equal(manifest.scope, "all");
    assert.equal(manifest.event_count, 1);
    assert.deepEqual(manifest.event_ids, [eventId]);

    const destDb = openDatabaseAt(path.join(dest, "vectorrun.db"));
    const ev = destDb
      .prepare("SELECT name, occurred_on FROM events WHERE id = ?")
      .get(eventId) as { name: string; occurred_on: string };
    assert.equal(ev.name, "Night-O");
    assert.equal(ev.occurred_on, "2026-09-12");
    const track = destDb
      .prepare("SELECT points_path FROM tracks WHERE participant_id = ?")
      .get(participantId) as { points_path: string };
    const expectedPath = path.join(dest, "tracks", `${participantId}.json`);
    assert.equal(track.points_path, expectedPath);
    const points = JSON.parse(fs.readFileSync(expectedPath, "utf8")) as {
      lat: number;
    }[];
    assert.equal(points[0].lat, 47.1);
    assert.ok(fs.existsSync(path.join(dest, "uploads", `${eventId}.png`)));
    assert.equal(fs.existsSync(path.join(dest, "uploads", "stale.png")), false);
    destDb.close();
  });

  it("rejects archives that are not VectorRun backups", async () => {
    const zip = new JSZip();
    zip.file("readme.txt", "nope");
    const buf = await zip.generateAsync({ type: "nodebuffer" });
    await assert.rejects(
      () => restoreBackupArchive(buf, tmpDir()),
      /missing manifest|Not a VectorRun/i
    );
  });
});
