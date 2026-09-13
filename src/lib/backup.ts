import Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import JSZip from "jszip";
import {
  SCHEMA_USER_VERSION,
  closeDb,
  getDataDir,
  getDb,
  getTracksDir,
  getUploadsDir,
  openDatabaseAt,
} from "./db";

export const BACKUP_FORMAT = "vectorrun-backup";
export const BACKUP_FORMAT_VERSION = 1;

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  version: number;
  user_version: number;
  created_at: string;
  scope: "all";
  event_count: number;
  event_ids: string[];
};

function assertSafeZipPath(name: string): string {
  const n = name.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!n || n.includes("..") || n.startsWith("/") || n.includes(":")) {
    throw new Error(`Unsafe path in backup archive: ${name}`);
  }
  return n;
}

function listFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      const full = path.join(dir, name);
      return fs.statSync(full).isFile();
    });
}

async function sqliteSnapshot(database: Database.Database): Promise<Buffer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vr-bak-"));
  const tmp = path.join(dir, "db.sqlite");
  try {
    await database.backup(tmp);
    const snap = new Database(tmp);
    try {
      snap.exec("DELETE FROM analysis_cache");
      snap.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      snap.close();
    }
    for (const extra of [`${tmp}-wal`, `${tmp}-shm`]) {
      if (fs.existsSync(extra)) fs.unlinkSync(extra);
    }
    return fs.readFileSync(tmp);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function readManifest(json: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error("Backup manifest is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new Error("Backup manifest is invalid");
  }
  const m = parsed as Record<string, unknown>;
  if (m.format !== BACKUP_FORMAT) {
    throw new Error("Not a VectorRun backup file");
  }
  if (m.version !== BACKUP_FORMAT_VERSION) {
    throw new Error(
      `Unsupported backup format version (${String(m.version)}). Update VectorRun and try again.`
    );
  }
  if (typeof m.user_version !== "number") {
    throw new Error("Backup is missing schema version");
  }
  if (m.user_version > SCHEMA_USER_VERSION) {
    throw new Error(
      `This backup was made with a newer VectorRun (schema ${m.user_version}). Update this copy, then restore.`
    );
  }
  if (m.scope !== "all") {
    throw new Error(
      "This archive is not a full-instance backup (event packs are not implemented yet)."
    );
  }
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    user_version: m.user_version,
    created_at: typeof m.created_at === "string" ? m.created_at : "",
    scope: "all",
    event_count: typeof m.event_count === "number" ? m.event_count : 0,
    event_ids: Array.isArray(m.event_ids)
      ? m.event_ids.filter((id): id is string => typeof id === "string")
      : [],
  };
}

export async function createBackupArchive(opts: {
  database: Database.Database;
  uploadsDir: string;
  tracksDir: string;
}): Promise<Buffer> {
  const eventRows = opts.database
    .prepare("SELECT id FROM events ORDER BY created_at DESC")
    .all() as { id: string }[];
  const userVersion = Number(
    opts.database.pragma("user_version", { simple: true }) ?? 0
  );
  const manifest: BackupManifest = {
    format: BACKUP_FORMAT,
    version: BACKUP_FORMAT_VERSION,
    user_version: userVersion,
    created_at: new Date().toISOString(),
    scope: "all",
    event_count: eventRows.length,
    event_ids: eventRows.map((r) => r.id),
  };

  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  zip.file("db.sqlite", await sqliteSnapshot(opts.database));

  for (const name of listFiles(opts.uploadsDir)) {
    zip.file(
      `uploads/${name}`,
      fs.readFileSync(path.join(opts.uploadsDir, name))
    );
  }
  for (const name of listFiles(opts.tracksDir)) {
    zip.file(
      `tracks/${name}`,
      fs.readFileSync(path.join(opts.tracksDir, name))
    );
  }

  return zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
}

export function rewriteTrackPaths(
  database: Database.Database,
  tracksDir: string
) {
  const rows = database
    .prepare("SELECT id, participant_id FROM tracks")
    .all() as { id: string; participant_id: string }[];
  const upd = database.prepare(
    "UPDATE tracks SET points_path = ? WHERE id = ?"
  );
  const tx = database.transaction(() => {
    for (const row of rows) {
      upd.run(path.join(tracksDir, `${row.participant_id}.json`), row.id);
    }
  });
  tx();
}

export async function restoreBackupArchive(
  archive: Buffer,
  dataDir: string
): Promise<BackupManifest> {
  const zip = await JSZip.loadAsync(archive);
  const manifestFile = zip.file("manifest.json");
  const dbFile = zip.file("db.sqlite");
  if (!manifestFile || !dbFile) {
    throw new Error("Backup is missing manifest.json or db.sqlite");
  }
  const manifest = readManifest(await manifestFile.async("string"));
  const dbBytes = Buffer.from(await dbFile.async("nodebuffer"));

  const incoming = fs.mkdtempSync(path.join(os.tmpdir(), "vr-restore-in-"));
  const incomingDb = path.join(incoming, "vectorrun.db");
  const incomingUploads = path.join(incoming, "uploads");
  const incomingTracks = path.join(incoming, "tracks");
  fs.mkdirSync(incomingUploads, { recursive: true });
  fs.mkdirSync(incomingTracks, { recursive: true });
  fs.writeFileSync(incomingDb, dbBytes);

  try {
    for (const [name, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const safe = assertSafeZipPath(name);
      if (safe === "manifest.json" || safe === "db.sqlite") continue;
      const buf = Buffer.from(await entry.async("nodebuffer"));
      if (safe.startsWith("uploads/")) {
        const base = path.basename(safe);
        fs.writeFileSync(path.join(incomingUploads, base), buf);
      } else if (safe.startsWith("tracks/")) {
        const base = path.basename(safe);
        fs.writeFileSync(path.join(incomingTracks, base), buf);
      }
    }

    // Fail fast if sqlite cannot open.
    const probe = new Database(incomingDb, { fileMustExist: true });
    try {
      probe.prepare("SELECT count(*) AS n FROM events").get();
    } finally {
      probe.close();
    }

    applyIncomingToDataDir(incoming, dataDir);
    return manifest;
  } finally {
    fs.rmSync(incoming, { recursive: true, force: true });
  }
}

function applyIncomingToDataDir(incomingDir: string, dataDir: string) {
  fs.mkdirSync(dataDir, { recursive: true });
  const uploadsDir = path.join(dataDir, "uploads");
  const tracksDir = path.join(dataDir, "tracks");
  const dbPath = path.join(dataDir, "vectorrun.db");
  const rollback = fs.mkdtempSync(path.join(os.tmpdir(), "vr-restore-old-"));

  const moveIfExists = (from: string, to: string) => {
    if (!fs.existsSync(from)) return;
    fs.renameSync(from, to);
  };

  try {
    moveIfExists(dbPath, path.join(rollback, "vectorrun.db"));
    moveIfExists(`${dbPath}-wal`, path.join(rollback, "vectorrun.db-wal"));
    moveIfExists(`${dbPath}-shm`, path.join(rollback, "vectorrun.db-shm"));
    moveIfExists(uploadsDir, path.join(rollback, "uploads"));
    moveIfExists(tracksDir, path.join(rollback, "tracks"));

    fs.copyFileSync(
      path.join(incomingDir, "vectorrun.db"),
      dbPath
    );
    copyDirContents(path.join(incomingDir, "uploads"), uploadsDir);
    copyDirContents(path.join(incomingDir, "tracks"), tracksDir);

    const restored = openDatabaseAt(dbPath);
    try {
      restored.exec("DELETE FROM analysis_cache");
      rewriteTrackPaths(restored, tracksDir);
    } finally {
      restored.close();
    }
  } catch (err) {
    try {
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      for (const extra of [`${dbPath}-wal`, `${dbPath}-shm`]) {
        if (fs.existsSync(extra)) fs.unlinkSync(extra);
      }
      if (fs.existsSync(uploadsDir)) {
        fs.rmSync(uploadsDir, { recursive: true, force: true });
      }
      if (fs.existsSync(tracksDir)) {
        fs.rmSync(tracksDir, { recursive: true, force: true });
      }
      moveIfExists(path.join(rollback, "vectorrun.db"), dbPath);
      moveIfExists(path.join(rollback, "vectorrun.db-wal"), `${dbPath}-wal`);
      moveIfExists(path.join(rollback, "vectorrun.db-shm"), `${dbPath}-shm`);
      moveIfExists(path.join(rollback, "uploads"), uploadsDir);
      moveIfExists(path.join(rollback, "tracks"), tracksDir);
    } catch {
      /* keep original error */
    }
    throw err;
  } finally {
    fs.rmSync(rollback, { recursive: true, force: true });
  }
}

function copyDirContents(from: string, to: string) {
  fs.mkdirSync(to, { recursive: true });
  if (!fs.existsSync(from)) return;
  for (const name of fs.readdirSync(from)) {
    fs.copyFileSync(path.join(from, name), path.join(to, name));
  }
}

export async function createLiveBackupArchive(): Promise<Buffer> {
  return createBackupArchive({
    database: getDb(),
    uploadsDir: getUploadsDir(),
    tracksDir: getTracksDir(),
  });
}

/** Replace this instance's data directory with the archive (full restore). */
export async function restoreLiveBackup(archive: Buffer): Promise<BackupManifest> {
  const dataDir = getDataDir();
  closeDb();
  const manifest = await restoreBackupArchive(archive, dataDir);
  getDb();
  return manifest;
}

export function backupFilename(now = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `vectorrun-backup-${y}-${m}-${d}.vrbak`;
}
