import type {
  Db,
  VideoIdentity,
  VideoInsert,
  VideoPartRecord,
  VideoPartUpsert,
  VideoRecord,
} from "./types";

export function getVideoByIdentity(db: Db, { bvid = null, aid = null }: VideoIdentity): VideoRecord | null {
  if (bvid) {
    const row = db.prepare("SELECT * FROM videos WHERE bvid = ?").get(bvid) as unknown as VideoRecord | undefined;
    if (row) {
      return row;
    }
  }

  if (aid !== null && aid !== undefined) {
    return (db.prepare("SELECT * FROM videos WHERE aid = ?").get(aid) as unknown as VideoRecord | undefined) ?? null;
  }

  return null;
}

export function listVideos(db: Db): VideoRecord[] {
  return db.prepare("SELECT * FROM videos ORDER BY updated_at DESC, id DESC").all() as unknown as VideoRecord[];
}

export function listVideosOlderThan(db: Db, cutoffIso: string): VideoRecord[] {
  return db.prepare(`
    SELECT *
    FROM videos
    WHERE COALESCE(last_scan_at, updated_at, created_at) < ?
    ORDER BY COALESCE(last_scan_at, updated_at, created_at) ASC, id ASC
  `).all(cutoffIso) as unknown as VideoRecord[];
}

export function upsertVideo(db: Db, video: VideoInsert): VideoRecord {
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

export function updateVideoCommentThread(
  db: Db,
  videoId: number,
  { rootCommentRpid = null, topCommentRpid = null }: { rootCommentRpid?: number | null; topCommentRpid?: number | null },
): VideoRecord | null {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE videos
    SET root_comment_rpid = ?,
        top_comment_rpid = ?,
        updated_at = ?
    WHERE id = ?
  `).run(rootCommentRpid, topCommentRpid, now, videoId);

  return (db.prepare("SELECT * FROM videos WHERE id = ?").get(videoId) as unknown as VideoRecord | undefined) ?? null;
}

export function markVideoPublishRebuildNeeded(db: Db, videoId: number, reason: string | null | undefined): VideoRecord | null {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE videos
    SET publish_needs_rebuild = 1,
        publish_rebuild_reason = ?,
        updated_at = ?
    WHERE id = ?
  `).run(String(reason ?? "").trim() || "structural-part-change", now, videoId);

  return (db.prepare("SELECT * FROM videos WHERE id = ?").get(videoId) as unknown as VideoRecord | undefined) ?? null;
}

export function clearVideoPublishRebuildNeeded(db: Db, videoId: number): VideoRecord | null {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE videos
    SET publish_needs_rebuild = 0,
        publish_rebuild_reason = NULL,
        updated_at = ?
    WHERE id = ?
  `).run(now, videoId);

  return (db.prepare("SELECT * FROM videos WHERE id = ?").get(videoId) as unknown as VideoRecord | undefined) ?? null;
}

export function upsertVideoPart(db: Db, part: VideoPartUpsert): VideoPartRecord | null {
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

export function listVideoParts(db: Db, videoId: number): VideoPartRecord[] {
  return db.prepare(`
    SELECT *
    FROM video_parts
    WHERE video_id = ?
      AND is_deleted = 0
    ORDER BY page_no ASC, id ASC
  `).all(videoId) as unknown as VideoPartRecord[];
}

export function listAllVideoParts(db: Db, videoId: number): VideoPartRecord[] {
  return db.prepare(`
    SELECT *
    FROM video_parts
    WHERE video_id = ?
    ORDER BY is_deleted ASC, page_no ASC, id ASC
  `).all(videoId) as unknown as VideoPartRecord[];
}

export function getVideoPartByCid(db: Db, videoId: number, cid: number): VideoPartRecord | null {
  return ((db.prepare(`
    SELECT *
    FROM video_parts
    WHERE video_id = ?
      AND cid = ?
    LIMIT 1
  `).get(videoId, cid) as unknown as VideoPartRecord | undefined) ?? null);
}

export function getActiveVideoPartByPageNo(db: Db, videoId: number, pageNo: number): VideoPartRecord | null {
  return ((db.prepare(`
    SELECT *
    FROM video_parts
    WHERE video_id = ?
      AND page_no = ?
      AND is_deleted = 0
    LIMIT 1
  `).get(videoId, pageNo) as unknown as VideoPartRecord | undefined) ?? null);
}

export function listPendingSummaryParts(db: Db, videoId: number): VideoPartRecord[] {
  return db.prepare(`
    SELECT * FROM video_parts
    WHERE video_id = ?
      AND is_deleted = 0
      AND (summary_text IS NULL OR TRIM(summary_text) = '')
    ORDER BY page_no ASC
  `).all(videoId) as unknown as VideoPartRecord[];
}

export function listPendingPublishParts(db: Db, videoId: number): VideoPartRecord[] {
  return db.prepare(`
    SELECT * FROM video_parts
    WHERE video_id = ?
      AND is_deleted = 0
      AND summary_text IS NOT NULL
      AND TRIM(summary_text) <> ''
      AND published = 0
    ORDER BY page_no ASC
  `).all(videoId) as unknown as VideoPartRecord[];
}

export function savePartSummary(
  db: Db,
  videoId: number,
  pageNo: number,
  { summaryText, summaryHash }: { summaryText: string; summaryHash: string },
): VideoPartRecord | null {
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

export function savePartSubtitle(
  db: Db,
  videoId: number,
  pageNo: number,
  { subtitlePath, subtitleSource, subtitleLang = null }: { subtitlePath: string; subtitleSource: string; subtitleLang?: string | null },
): VideoPartRecord | null {
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

export function markPartsPublished(db: Db, videoId: number, pageNos: number[], publishedCommentRpid: number | null) {
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

export function resetPublishedStateForVideo(db: Db, videoId: number) {
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
