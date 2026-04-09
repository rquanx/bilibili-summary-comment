import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(databasePath) {
  const resolvedPath = path.resolve(databasePath);
  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  const db = new DatabaseSync(resolvedPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  migrate(db);
  return db;
}

export function getVideoByIdentity(db, { bvid = null, aid = null }) {
  if (bvid) {
    const row = db.prepare("SELECT * FROM videos WHERE bvid = ?").get(bvid);
    if (row) {
      return row;
    }
  }

  if (aid) {
    return db.prepare("SELECT * FROM videos WHERE aid = ?").get(aid) ?? null;
  }

  return null;
}

export function listVideos(db) {
  return db.prepare("SELECT * FROM videos ORDER BY updated_at DESC, id DESC").all();
}

export function listVideosOlderThan(db, cutoffIso) {
  return db.prepare(`
    SELECT *
    FROM videos
    WHERE COALESCE(last_scan_at, updated_at, created_at) < ?
    ORDER BY COALESCE(last_scan_at, updated_at, created_at) ASC, id ASC
  `).all(cutoffIso);
}

export function upsertVideo(db, video) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO videos (
      bvid,
      aid,
      title,
      page_count,
      root_comment_rpid,
      top_comment_rpid,
      last_scan_at,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(bvid) DO UPDATE SET
      aid = excluded.aid,
      title = excluded.title,
      page_count = excluded.page_count,
      updated_at = excluded.updated_at,
      last_scan_at = excluded.last_scan_at
  `).run(
    video.bvid,
    video.aid,
    video.title,
    video.pageCount,
    video.rootCommentRpid ?? null,
    video.topCommentRpid ?? null,
    now,
    now,
    now,
  );

  return getVideoByIdentity(db, { bvid: video.bvid, aid: video.aid });
}

export function updateVideoCommentThread(db, videoId, { rootCommentRpid = null, topCommentRpid = null }) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE videos
    SET root_comment_rpid = ?,
        top_comment_rpid = ?,
        updated_at = ?
    WHERE id = ?
  `).run(rootCommentRpid, topCommentRpid, now, videoId);

  return db.prepare("SELECT * FROM videos WHERE id = ?").get(videoId) ?? null;
}

export function markVideoPublishRebuildNeeded(db, videoId, reason) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE videos
    SET publish_needs_rebuild = 1,
        publish_rebuild_reason = ?,
        updated_at = ?
    WHERE id = ?
  `).run(String(reason ?? "").trim() || "structural-part-change", now, videoId);

  return db.prepare("SELECT * FROM videos WHERE id = ?").get(videoId) ?? null;
}

export function clearVideoPublishRebuildNeeded(db, videoId) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE videos
    SET publish_needs_rebuild = 0,
        publish_rebuild_reason = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(now, videoId);

  return db.prepare("SELECT * FROM videos WHERE id = ?").get(videoId) ?? null;
}

export function upsertVideoPart(db, part) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO video_parts (
      video_id,
      page_no,
      cid,
      part_title,
      duration_sec,
      subtitle_path,
      subtitle_source,
      subtitle_lang,
      summary_text,
      summary_hash,
      published,
      published_comment_rpid,
      published_at,
      is_deleted,
      deleted_at,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id, cid) DO UPDATE SET
      page_no = excluded.page_no,
      part_title = excluded.part_title,
      duration_sec = excluded.duration_sec,
      subtitle_path = excluded.subtitle_path,
      subtitle_source = excluded.subtitle_source,
      subtitle_lang = excluded.subtitle_lang,
      summary_text = excluded.summary_text,
      summary_hash = excluded.summary_hash,
      published = excluded.published,
      published_comment_rpid = excluded.published_comment_rpid,
      published_at = excluded.published_at,
      is_deleted = excluded.is_deleted,
      deleted_at = excluded.deleted_at,
      updated_at = excluded.updated_at
  `).run(
    part.videoId,
    part.pageNo,
    part.cid,
    part.partTitle,
    part.durationSec,
    part.subtitlePath ?? null,
    part.subtitleSource ?? null,
    part.subtitleLang ?? null,
    part.summaryText ?? null,
    part.summaryHash ?? null,
    part.published ? 1 : 0,
    part.publishedCommentRpid ?? null,
    part.publishedAt ?? null,
    part.isDeleted ? 1 : 0,
    part.deletedAt ?? null,
    now,
    now,
  );

  return getVideoPartByCid(db, part.videoId, part.cid);
}

export function listVideoParts(db, videoId) {
  return db.prepare(`
    SELECT *
    FROM video_parts
    WHERE video_id = ?
      AND is_deleted = 0
    ORDER BY page_no ASC, id ASC
  `).all(videoId);
}

export function listAllVideoParts(db, videoId) {
  return db.prepare(`
    SELECT *
    FROM video_parts
    WHERE video_id = ?
    ORDER BY is_deleted ASC, page_no ASC, id ASC
  `).all(videoId);
}

export function getVideoPartByCid(db, videoId, cid) {
  return db.prepare(`
    SELECT *
    FROM video_parts
    WHERE video_id = ?
      AND cid = ?
    LIMIT 1
  `).get(videoId, cid) ?? null;
}

export function getActiveVideoPartByPageNo(db, videoId, pageNo) {
  return db.prepare(`
    SELECT *
    FROM video_parts
    WHERE video_id = ?
      AND page_no = ?
      AND is_deleted = 0
    LIMIT 1
  `).get(videoId, pageNo) ?? null;
}

export function listPendingSummaryParts(db, videoId) {
  return db.prepare(`
    SELECT * FROM video_parts
    WHERE video_id = ?
      AND is_deleted = 0
      AND (summary_text IS NULL OR TRIM(summary_text) = '')
    ORDER BY page_no ASC
  `).all(videoId);
}

export function listPendingPublishParts(db, videoId) {
  return db.prepare(`
    SELECT * FROM video_parts
    WHERE video_id = ?
      AND is_deleted = 0
      AND summary_text IS NOT NULL
      AND TRIM(summary_text) <> ''
      AND published = 0
    ORDER BY page_no ASC
  `).all(videoId);
}

export function savePartSummary(db, videoId, pageNo, { summaryText, summaryHash }) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE video_parts
    SET summary_text = ?,
        summary_hash = ?,
        published = CASE
          WHEN COALESCE(summary_hash, '') <> COALESCE(?, '') THEN 0
          ELSE published
        END,
        published_comment_rpid = CASE
          WHEN COALESCE(summary_hash, '') <> COALESCE(?, '') THEN NULL
          ELSE published_comment_rpid
        END,
        published_at = CASE
          WHEN COALESCE(summary_hash, '') <> COALESCE(?, '') THEN NULL
          ELSE published_at
        END,
        updated_at = ?
    WHERE video_id = ?
      AND page_no = ?
      AND is_deleted = 0
  `).run(summaryText, summaryHash, summaryHash, summaryHash, summaryHash, now, videoId, pageNo);

  return getActiveVideoPartByPageNo(db, videoId, pageNo);
}

export function savePartSubtitle(db, videoId, pageNo, { subtitlePath, subtitleSource, subtitleLang = null }) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE video_parts
    SET subtitle_path = ?,
        subtitle_source = ?,
        subtitle_lang = ?,
        updated_at = ?
    WHERE video_id = ?
      AND page_no = ?
      AND is_deleted = 0
  `).run(subtitlePath, subtitleSource, subtitleLang, now, videoId, pageNo);

  return getActiveVideoPartByPageNo(db, videoId, pageNo);
}

export function markPartsPublished(db, videoId, pageNos, publishedCommentRpid) {
  if (!Array.isArray(pageNos) || pageNos.length === 0) {
    return;
  }

  const now = new Date().toISOString();
  const update = db.prepare(`
    UPDATE video_parts
    SET published = 1,
        published_comment_rpid = COALESCE(?, published_comment_rpid),
        published_at = ?,
        updated_at = ?
    WHERE video_id = ?
      AND page_no = ?
      AND is_deleted = 0
  `);

  db.exec("BEGIN");
  try {
    for (const pageNo of pageNos) {
      update.run(publishedCommentRpid ?? null, now, now, videoId, pageNo);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function resetPublishedStateForVideo(db, videoId) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE video_parts
    SET published = 0,
        published_comment_rpid = NULL,
        published_at = NULL,
        updated_at = ?
    WHERE video_id = ?
  `).run(now, videoId);
}

export function insertPipelineEvent(db, event) {
  const createdAt = new Date().toISOString();
  db.prepare(`
    INSERT INTO pipeline_events (
      run_id,
      video_id,
      bvid,
      video_title,
      page_no,
      cid,
      part_title,
      scope,
      action,
      status,
      message,
      details_json,
      created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    normalizeNullableText(event.runId),
    normalizeNullableInteger(event.videoId),
    normalizeNullableText(event.bvid),
    normalizeNullableText(event.videoTitle),
    normalizeNullableInteger(event.pageNo),
    normalizeNullableInteger(event.cid),
    normalizeNullableText(event.partTitle),
    requirePipelineEventField(event.scope, "scope"),
    requirePipelineEventField(event.action, "action"),
    requirePipelineEventField(event.status, "status"),
    normalizeNullableText(event.message),
    serializePipelineEventDetails(event.details),
    createdAt,
  );

  return db.prepare("SELECT * FROM pipeline_events WHERE id = last_insert_rowid()").get() ?? null;
}

export function listPipelineEvents(db, { bvid = null, sinceIso = null, limit = 100 } = {}) {
  const safeLimit = Math.max(1, Number(limit) || 100);
  return db.prepare(`
    SELECT *
    FROM pipeline_events
    WHERE (? IS NULL OR bvid = ?)
      AND (? IS NULL OR created_at >= ?)
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(
    normalizeNullableText(bvid),
    normalizeNullableText(bvid),
    normalizeNullableText(sinceIso),
    normalizeNullableText(sinceIso),
    safeLimit,
  );
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bvid TEXT NOT NULL UNIQUE,
      aid INTEGER NOT NULL UNIQUE,
      title TEXT NOT NULL,
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

  ensureVideoColumn(db, "publish_needs_rebuild", "INTEGER NOT NULL DEFAULT 0");
  ensureVideoColumn(db, "publish_rebuild_reason", "TEXT");

  migrateVideoPartsTable(db);
  createPipelineEventsTable(db);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_video_parts_video_id ON video_parts(video_id);
    CREATE INDEX IF NOT EXISTS idx_video_parts_video_page ON video_parts(video_id, page_no);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_video_parts_video_cid ON video_parts(video_id, cid);
    CREATE INDEX IF NOT EXISTS idx_pipeline_events_created_at ON pipeline_events(created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_pipeline_events_bvid_created_at ON pipeline_events(bvid, created_at DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_pipeline_events_run_id ON pipeline_events(run_id, created_at DESC, id DESC);
  `);
  db.exec("DROP INDEX IF EXISTS idx_video_parts_video_active_page");
}

function ensureVideoColumn(db, columnName, definition) {
  const columns = db.prepare("PRAGMA table_info(videos)").all();
  if (columns.some((column) => column.name === columnName)) {
    return;
  }

  db.exec(`ALTER TABLE videos ADD COLUMN ${columnName} ${definition}`);
}

function migrateVideoPartsTable(db) {
  const table = db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name = 'video_parts'
  `).get();

  if (!table) {
    createVideoPartsTable(db);
    return;
  }

  const columns = db.prepare("PRAGMA table_info(video_parts)").all();
  const hasDeletedColumns = columns.some((column) => column.name === "is_deleted");
  const indexes = db.prepare("PRAGMA index_list(video_parts)").all();
  const hasCidUniqueIndex = indexes.some((index) => {
    if (!index.unique) {
      return false;
    }

    const indexColumns = db.prepare(`PRAGMA index_info(${quoteSqlLiteral(index.name)})`).all();
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
        summary_text,
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
        summary_text,
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

function createVideoPartsTable(db) {
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
      summary_text TEXT,
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

function createPipelineEventsTable(db) {
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

function requirePipelineEventField(value, fieldName) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`Missing required pipeline event field: ${fieldName}`);
  }

  return normalized;
}

function normalizeNullableText(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeNullableInteger(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) ? normalized : null;
}

function serializePipelineEventDetails(details) {
  if (details === undefined || details === null) {
    return null;
  }

  return `${JSON.stringify(details)}\n`;
}

function quoteSqlLiteral(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}
