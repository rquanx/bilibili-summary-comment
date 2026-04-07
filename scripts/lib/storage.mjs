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
    SET root_comment_rpid = COALESCE(?, root_comment_rpid),
        top_comment_rpid = COALESCE(?, top_comment_rpid),
        updated_at = ?
    WHERE id = ?
  `).run(rootCommentRpid, topCommentRpid, now, videoId);

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
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(video_id, page_no) DO UPDATE SET
      cid = excluded.cid,
      part_title = excluded.part_title,
      duration_sec = excluded.duration_sec,
      subtitle_path = COALESCE(excluded.subtitle_path, video_parts.subtitle_path),
      subtitle_source = COALESCE(excluded.subtitle_source, video_parts.subtitle_source),
      subtitle_lang = COALESCE(excluded.subtitle_lang, video_parts.subtitle_lang),
      summary_text = COALESCE(excluded.summary_text, video_parts.summary_text),
      summary_hash = COALESCE(excluded.summary_hash, video_parts.summary_hash),
      published = excluded.published,
      published_comment_rpid = COALESCE(excluded.published_comment_rpid, video_parts.published_comment_rpid),
      published_at = COALESCE(excluded.published_at, video_parts.published_at),
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
    now,
    now,
  );

  return db.prepare("SELECT * FROM video_parts WHERE video_id = ? AND page_no = ?").get(part.videoId, part.pageNo) ?? null;
}

export function listVideoParts(db, videoId) {
  return db.prepare("SELECT * FROM video_parts WHERE video_id = ? ORDER BY page_no ASC").all(videoId);
}

export function listPendingSummaryParts(db, videoId) {
  return db.prepare(`
    SELECT * FROM video_parts
    WHERE video_id = ?
      AND (summary_text IS NULL OR TRIM(summary_text) = '')
    ORDER BY page_no ASC
  `).all(videoId);
}

export function listPendingPublishParts(db, videoId) {
  return db.prepare(`
    SELECT * FROM video_parts
    WHERE video_id = ?
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
  `).run(summaryText, summaryHash, summaryHash, summaryHash, summaryHash, now, videoId, pageNo);

  return db.prepare("SELECT * FROM video_parts WHERE video_id = ? AND page_no = ?").get(videoId, pageNo) ?? null;
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
  `).run(subtitlePath, subtitleSource, subtitleLang, now, videoId, pageNo);

  return db.prepare("SELECT * FROM video_parts WHERE video_id = ? AND page_no = ?").get(videoId, pageNo) ?? null;
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
      last_scan_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(video_id, page_no),
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_video_parts_video_id ON video_parts(video_id);
    CREATE INDEX IF NOT EXISTS idx_video_parts_video_page ON video_parts(video_id, page_no);
  `);
}
