import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { migrate as migrateDrizzle } from "drizzle-orm/better-sqlite3/migrator";
import { getRepoRoot } from "../../shared/runtime-tools";
import { getDrizzleDb } from "./orm";
import type { Db } from "./types";

const DRIZZLE_MIGRATIONS_TABLE = "__drizzle_migrations";

interface MigrationJournalEntry {
  idx: number;
  when: number;
  tag: string;
  breakpoints: boolean;
}

interface MigrationJournal {
  entries: MigrationJournalEntry[];
}

export function migrateDatabase(db: Db) {
  const hasPipelineTables = hasAnyPipelineTable(db);
  const hasDrizzleMigrationsTable = hasTable(db, DRIZZLE_MIGRATIONS_TABLE);

  if (hasPipelineTables && !hasDrizzleMigrationsTable) {
    migrateLegacyDatabase(db);
    markLegacyBaselineMigrationAsApplied(db);
  }

  migrateDrizzle(getDrizzleDb(db), {
    migrationsFolder: getDrizzleMigrationsFolder(),
  });

  // Old builds could leave this obsolete index behind; keep startup idempotent.
  db.exec("DROP INDEX IF EXISTS idx_video_parts_video_active_page");
}

function getDrizzleMigrationsFolder(): string {
  return path.join(getRepoRoot(), "drizzle");
}

function hasAnyPipelineTable(db: Db): boolean {
  return [
    "videos",
    "video_parts",
    "pipeline_events",
    "gap_notifications",
    "recent_reprocess_runs",
  ].some((tableName) => hasTable(db, tableName));
}

function hasTable(db: Db, tableName: string): boolean {
  const table = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = ?
  `).get(tableName);
  return Boolean(table);
}

function markLegacyBaselineMigrationAsApplied(db: Db) {
  const baselineMigration = readBaselineMigration();
  if (!baselineMigration) {
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${DRIZZLE_MIGRATIONS_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      hash TEXT NOT NULL,
      created_at NUMERIC
    )
  `);

  const existingMigration = db.prepare(`
    SELECT id
    FROM ${DRIZZLE_MIGRATIONS_TABLE}
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get();

  if (existingMigration) {
    return;
  }

  db.prepare(`
    INSERT INTO ${DRIZZLE_MIGRATIONS_TABLE} (hash, created_at)
    VALUES (?, ?)
  `).run(baselineMigration.hash, baselineMigration.createdAt);
}

function readBaselineMigration(): { hash: string; createdAt: number } | null {
  const migrationsFolder = getDrizzleMigrationsFolder();
  const journalPath = path.join(migrationsFolder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    return null;
  }

  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8")) as MigrationJournal;
  const baselineEntry = [...(journal.entries ?? [])]
    .sort((left, right) => left.idx - right.idx)[0];
  if (!baselineEntry) {
    return null;
  }

  const migrationPath = path.join(migrationsFolder, `${baselineEntry.tag}.sql`);
  const migrationSql = fs.readFileSync(migrationPath, "utf8");
  return {
    hash: crypto.createHash("sha256").update(migrationSql).digest("hex"),
    createdAt: baselineEntry.when,
  };
}

function migrateLegacyDatabase(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bvid TEXT NOT NULL UNIQUE,
      aid INTEGER NOT NULL UNIQUE,
      title TEXT NOT NULL,
      owner_mid INTEGER,
      owner_name TEXT,
      owner_dir_name TEXT,
      work_dir_name TEXT,
      page_count INTEGER NOT NULL DEFAULT 0,
      root_comment_rpid INTEGER,
      top_comment_rpid INTEGER,
      publish_needs_rebuild INTEGER NOT NULL DEFAULT 0,
      publish_rebuild_reason TEXT,
      last_scan_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  ensureVideoColumn(db, "owner_mid", "INTEGER");
  ensureVideoColumn(db, "owner_name", "TEXT");
  ensureVideoColumn(db, "owner_dir_name", "TEXT");
  ensureVideoColumn(db, "work_dir_name", "TEXT");
  ensureVideoColumn(db, "publish_needs_rebuild", "INTEGER NOT NULL DEFAULT 0");
  ensureVideoColumn(db, "publish_rebuild_reason", "TEXT");

  migrateLegacyVideoPartsTable(db);
  ensureVideoPartColumn(db, "summary_text_processed", "TEXT");
  ensureVideoPartColumn(db, "subtitle_text", "TEXT");
  ensureVideoPartColumn(db, "prompt_text", "TEXT");
  createPipelineEventsTable(db);
  createGapNotificationsTable(db);
  createRecentReprocessRunsTable(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_video_parts_video_id ON video_parts(video_id);
    CREATE INDEX IF NOT EXISTS idx_video_parts_video_page ON video_parts(video_id, page_no);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_parts_video_cid ON video_parts(video_id, cid);
    CREATE INDEX IF NOT EXISTS idx_pipeline_events_created_at ON pipeline_events(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_pipeline_events_bvid_created_at ON pipeline_events(bvid, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_pipeline_events_run_id ON pipeline_events(run_id, created_at DESC, id DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_gap_notifications_gap_key ON gap_notifications(gap_key);
    CREATE INDEX IF NOT EXISTS idx_gap_notifications_bvid_notified_at ON gap_notifications(bvid, notified_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_recent_reprocess_runs_candidate_status
      ON recent_reprocess_runs(candidate_key, status, finished_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_recent_reprocess_runs_bvid_created_at
      ON recent_reprocess_runs(bvid, created_at DESC, id DESC);
  `);
}

function ensureVideoColumn(db: Db, columnName: string, definition: string) {
  const columns = db.prepare("PRAGMA table_info(videos)").all() as Array<{ name?: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE videos ADD COLUMN ${columnName} ${definition}`);
}

function migrateLegacyVideoPartsTable(db: Db) {
  if (!hasTable(db, "video_parts")) {
    createVideoPartsTable(db);
    return;
  }

  const columns = db.prepare("PRAGMA table_info(video_parts)").all() as Array<{ name?: string }>;
  const hasDeletedColumns = columns.some((column) => column.name === "is_deleted");
  const indexes = db.prepare("PRAGMA index_list(video_parts)").all() as Array<{ name?: string; unique?: number }>;
  const hasCidUniqueIndex = indexes.some((index) => {
    if (!index.unique || !index.name) {
      return false;
    }

    const indexColumns = db.prepare(`PRAGMA index_info(${quoteSqlLiteral(index.name)})`).all() as Array<{ name?: string }>;
    return indexColumns.length === 2 && indexColumns[0]?.name === "video_id" && indexColumns[1]?.name === "cid";
  });

  if (hasDeletedColumns && hasCidUniqueIndex) {
    return;
  }

  db.exec("BEGIN");
  try {
    db.exec("ALTER TABLE video_parts RENAME TO video_parts_legacy");
    createVideoPartsTable(db);
    db.exec(`
      INSERT INTO video_parts (
        id,
        video_id,
        page_no,
        cid,
        part_title,
        duration_sec,
        subtitle_path,
        subtitle_source,
        subtitle_lang,
        subtitle_text,
        prompt_text,
        summary_text,
        summary_text_processed,
        summary_hash,
        published,
        published_comment_rpid,
        published_at,
        is_deleted,
        deleted_at,
        created_at,
        updated_at
      )
      SELECT
        id,
        video_id,
        page_no,
        cid,
        part_title,
        duration_sec,
        subtitle_path,
        subtitle_source,
        subtitle_lang,
        NULL,
        NULL,
        summary_text,
        NULL,
        summary_hash,
        published,
        published_comment_rpid,
        published_at,
        0,
        NULL,
        created_at,
        updated_at
      FROM video_parts_legacy
    `);
    db.exec("DROP TABLE video_parts_legacy");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function createVideoPartsTable(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS video_parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL,
      page_no INTEGER NOT NULL,
      cid INTEGER NOT NULL,
      part_title TEXT NOT NULL,
      duration_sec INTEGER NOT NULL DEFAULT 0,
      subtitle_path TEXT,
      subtitle_source TEXT,
      subtitle_lang TEXT,
      subtitle_text TEXT,
      prompt_text TEXT,
      summary_text TEXT,
      summary_text_processed TEXT,
      summary_hash TEXT,
      published INTEGER NOT NULL DEFAULT 0,
      published_comment_rpid INTEGER,
      published_at TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
    )
  `);
}

function ensureVideoPartColumn(db: Db, columnName: string, definition: string) {
  const columns = db.prepare("PRAGMA table_info(video_parts)").all() as Array<{ name?: string }>;
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE video_parts ADD COLUMN ${columnName} ${definition}`);
}

function createPipelineEventsTable(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pipeline_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT,
      video_id INTEGER,
      bvid TEXT,
      video_title TEXT,
      page_no INTEGER,
      cid INTEGER,
      part_title TEXT,
      scope TEXT NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
    )
  `);
}

function createGapNotificationsTable(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS gap_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      gap_key TEXT NOT NULL,
      bvid TEXT NOT NULL,
      video_title TEXT,
      from_page_no INTEGER NOT NULL,
      from_cid INTEGER NOT NULL,
      to_page_no INTEGER NOT NULL,
      to_cid INTEGER NOT NULL,
      gap_start_at TEXT NOT NULL,
      gap_end_at TEXT NOT NULL,
      gap_seconds INTEGER NOT NULL,
      notified_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);
}

function createRecentReprocessRunsTable(db: Db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recent_reprocess_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER,
      bvid TEXT NOT NULL,
      video_title TEXT,
      candidate_key TEXT NOT NULL,
      reasons_json TEXT NOT NULL,
      paste_pages_json TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL,
      error_message TEXT,
      details_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT,
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE SET NULL
    )
  `);
}

function quoteSqlLiteral(value: string) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}
