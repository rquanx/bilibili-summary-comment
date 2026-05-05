import path from "node:path";
import { sql } from "drizzle-orm";
import { withDatabaseWriteLock } from "./database";
import { getDrizzleDb } from "./orm";
import { videoParts, videos } from "./schema";
import type {
  Db,
  VideoIdentity,
  VideoInsert,
  VideoPartRecord,
  VideoPartUpsert,
  VideoRecord,
} from "./types";
import { getPreferredSummaryText, normalizeStoredSummaryText } from "./summary-text";

function normalizeStoredPartText(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export function getVideoByIdentity(db: Db, { bvid = null, aid = null }: VideoIdentity): VideoRecord | null {
  const orm = getDrizzleDb(db);
  if (bvid) {
    const row = orm.get<VideoRecord>(sql`
      SELECT *
      FROM ${videos}
      WHERE ${videos.bvid} = ${bvid}
    `) ?? null;
    if (row) {
      return row;
    }
  }

  if (aid !== null && aid !== undefined) {
    return orm.get<VideoRecord>(sql`
      SELECT *
      FROM ${videos}
      WHERE ${videos.aid} = ${aid}
    `) ?? null;
  }

  return null;
}

export function getVideoById(db: Db, videoId: number): VideoRecord | null {
  return getDrizzleDb(db).get<VideoRecord>(sql`
    SELECT *
    FROM ${videos}
    WHERE ${videos.id} = ${videoId}
  `) ?? null;
}

export function listVideos(db: Db): VideoRecord[] {
  return getDrizzleDb(db).all<VideoRecord>(sql`
    SELECT *
    FROM ${videos}
    ORDER BY ${videos.updated_at} DESC, ${videos.id} DESC
  `);
}

export function listVideosPendingPublish(db: Db): VideoRecord[] {
  return getDrizzleDb(db).all<VideoRecord>(sql`
    SELECT v.*
    FROM ${videos} v
    WHERE v.publish_needs_rebuild = 1
      OR EXISTS (
        SELECT 1
        FROM ${videoParts} p
        WHERE p.video_id = v.id
          AND p.is_deleted = 0
          AND (
            (p.summary_text_processed IS NOT NULL AND TRIM(p.summary_text_processed) <> '')
            OR (p.summary_text IS NOT NULL AND TRIM(p.summary_text) <> '')
          )
          AND p.published = 0
      )
    ORDER BY
      CASE WHEN v.publish_needs_rebuild = 1 THEN 1 ELSE 0 END ASC,
      COALESCE(v.last_scan_at, v.updated_at, v.created_at) ASC,
      v.id ASC
  `);
}

export function listVideosOlderThan(db: Db, cutoffIso: string): VideoRecord[] {
  return getDrizzleDb(db).all<VideoRecord>(sql`
    SELECT *
    FROM ${videos}
    WHERE COALESCE(${videos.last_scan_at}, ${videos.updated_at}, ${videos.created_at}) < ${cutoffIso}
    ORDER BY COALESCE(${videos.last_scan_at}, ${videos.updated_at}, ${videos.created_at}) ASC, ${videos.id} ASC
  `);
}

export function upsertVideo(db: Db, video: VideoInsert): VideoRecord {
  const orm = getDrizzleDb(db);
  const now = new Date().toISOString();
  withDatabaseWriteLock(db, () => {
    orm.run(sql`
      INSERT INTO videos (
        bvid,
        aid,
        title,
        owner_mid,
        owner_name,
        owner_dir_name,
        work_dir_name,
        page_count,
        root_comment_rpid,
        top_comment_rpid,
        last_scan_at,
        created_at,
        updated_at
      )
      VALUES (
        ${video.bvid},
        ${video.aid},
        ${video.title},
        ${video.ownerMid ?? null},
        ${video.ownerName ?? null},
        ${video.ownerDirName ?? null},
        ${video.workDirName ?? null},
        ${video.pageCount},
        ${video.rootCommentRpid ?? null},
        ${video.topCommentRpid ?? null},
        ${now},
        ${now},
        ${now}
      )
      ON CONFLICT(bvid) DO UPDATE SET
        aid = excluded.aid,
        title = excluded.title,
        owner_mid = COALESCE(excluded.owner_mid, owner_mid),
        owner_name = COALESCE(excluded.owner_name, owner_name),
        owner_dir_name = COALESCE(owner_dir_name, excluded.owner_dir_name),
        work_dir_name = COALESCE(work_dir_name, excluded.work_dir_name),
        page_count = excluded.page_count,
        updated_at = excluded.updated_at,
        last_scan_at = excluded.last_scan_at
    `);
  });

  return getVideoByIdentity(db, { bvid: video.bvid, aid: video.aid });
}

export function replaceVideoSubtitlePathPrefix(db: Db, videoId: number, fromPrefix: string, toPrefix: string) {
  const resolvedFromPrefix = path.resolve(fromPrefix);
  const resolvedToPrefix = path.resolve(toPrefix);
  const rows = listAllVideoParts(db, videoId);
  const orm = getDrizzleDb(db);
  const now = new Date().toISOString();

  withDatabaseWriteLock(db, () => {
    db.exec("BEGIN");
    try {
      for (const row of rows) {
        const currentSubtitlePath = String(row.subtitle_path ?? "").trim();
        if (!currentSubtitlePath) {
          continue;
        }

        const resolvedSubtitlePath = path.resolve(currentSubtitlePath);
        if (
          resolvedSubtitlePath !== resolvedFromPrefix
          && !resolvedSubtitlePath.startsWith(`${resolvedFromPrefix}${path.sep}`)
        ) {
          continue;
        }

        const relativeSubtitlePath = path.relative(resolvedFromPrefix, resolvedSubtitlePath);
        const nextSubtitlePath = path.resolve(resolvedToPrefix, relativeSubtitlePath);
        orm.run(sql`
          UPDATE ${videoParts}
          SET subtitle_path = ${nextSubtitlePath},
              updated_at = ${now}
          WHERE ${videoParts.id} = ${row.id}
        `);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

export function updateVideoCommentThread(
  db: Db,
  videoId: number,
  { rootCommentRpid = null, topCommentRpid = null }: { rootCommentRpid?: number | null; topCommentRpid?: number | null },
): VideoRecord | null {
  const orm = getDrizzleDb(db);
  const now = new Date().toISOString();
  withDatabaseWriteLock(db, () => {
    orm.run(sql`
      UPDATE ${videos}
      SET root_comment_rpid = ${rootCommentRpid},
          top_comment_rpid = ${topCommentRpid},
          updated_at = ${now}
      WHERE ${videos.id} = ${videoId}
    `);
  });

  return orm.get<VideoRecord>(sql`
    SELECT *
    FROM ${videos}
    WHERE ${videos.id} = ${videoId}
  `) ?? null;
}

export function markVideoPublishRebuildNeeded(db: Db, videoId: number, reason: string | null | undefined): VideoRecord | null {
  const orm = getDrizzleDb(db);
  const now = new Date().toISOString();
  withDatabaseWriteLock(db, () => {
    orm.run(sql`
      UPDATE ${videos}
      SET publish_needs_rebuild = 1,
          publish_rebuild_reason = ${String(reason ?? "").trim() || "structural-part-change"},
          updated_at = ${now}
      WHERE ${videos.id} = ${videoId}
    `);
  });

  return orm.get<VideoRecord>(sql`
    SELECT *
    FROM ${videos}
    WHERE ${videos.id} = ${videoId}
  `) ?? null;
}

export function clearVideoPublishRebuildNeeded(db: Db, videoId: number): VideoRecord | null {
  const orm = getDrizzleDb(db);
  const now = new Date().toISOString();
  withDatabaseWriteLock(db, () => {
    orm.run(sql`
      UPDATE ${videos}
      SET publish_needs_rebuild = 0,
          publish_rebuild_reason = NULL,
          updated_at = ${now}
      WHERE ${videos.id} = ${videoId}
    `);
  });

  return orm.get<VideoRecord>(sql`
    SELECT *
    FROM ${videos}
    WHERE ${videos.id} = ${videoId}
  `) ?? null;
}

export function upsertVideoPart(db: Db, part: VideoPartUpsert): VideoPartRecord | null {
  const orm = getDrizzleDb(db);
  const now = new Date().toISOString();
  withDatabaseWriteLock(db, () => {
    orm.run(sql`
      INSERT INTO video_parts (
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
      VALUES (
        ${part.videoId},
        ${part.pageNo},
        ${part.cid},
        ${part.partTitle},
        ${part.durationSec},
        ${part.subtitlePath ?? null},
        ${part.subtitleSource ?? null},
        ${part.subtitleLang ?? null},
        ${normalizeStoredPartText(part.subtitleText)},
        ${normalizeStoredPartText(part.promptText)},
        ${part.summaryText ?? null},
        ${normalizeStoredSummaryText(part.processedSummaryText)},
        ${part.summaryHash ?? null},
        ${part.published ? 1 : 0},
        ${part.publishedCommentRpid ?? null},
        ${part.publishedAt ?? null},
        ${part.isDeleted ? 1 : 0},
        ${part.deletedAt ?? null},
        ${now},
        ${now}
      )
      ON CONFLICT(video_id, cid) DO UPDATE SET
        page_no = excluded.page_no,
        part_title = excluded.part_title,
        duration_sec = excluded.duration_sec,
        subtitle_path = excluded.subtitle_path,
        subtitle_source = excluded.subtitle_source,
        subtitle_lang = excluded.subtitle_lang,
        subtitle_text = excluded.subtitle_text,
        prompt_text = excluded.prompt_text,
        summary_text = excluded.summary_text,
        summary_text_processed = excluded.summary_text_processed,
        summary_hash = excluded.summary_hash,
        published = excluded.published,
        published_comment_rpid = excluded.published_comment_rpid,
        published_at = excluded.published_at,
        is_deleted = excluded.is_deleted,
        deleted_at = excluded.deleted_at,
        updated_at = excluded.updated_at
    `);
  });

  return getVideoPartByCid(db, part.videoId, part.cid);
}

export function listVideoParts(db: Db, videoId: number): VideoPartRecord[] {
  return getDrizzleDb(db).all<VideoPartRecord>(sql`
    SELECT *
    FROM ${videoParts}
    WHERE ${videoParts.video_id} = ${videoId}
      AND is_deleted = 0
    ORDER BY page_no ASC, id ASC
  `);
}

export function listAllVideoParts(db: Db, videoId: number): VideoPartRecord[] {
  return getDrizzleDb(db).all<VideoPartRecord>(sql`
    SELECT *
    FROM ${videoParts}
    WHERE ${videoParts.video_id} = ${videoId}
    ORDER BY is_deleted ASC, page_no ASC, id ASC
  `);
}

export function getVideoPartByCid(db: Db, videoId: number, cid: number): VideoPartRecord | null {
  return getDrizzleDb(db).get<VideoPartRecord>(sql`
    SELECT *
    FROM ${videoParts}
    WHERE ${videoParts.video_id} = ${videoId}
      AND ${videoParts.cid} = ${cid}
    LIMIT 1
  `) ?? null;
}

export function getActiveVideoPartByPageNo(db: Db, videoId: number, pageNo: number): VideoPartRecord | null {
  return getDrizzleDb(db).get<VideoPartRecord>(sql`
    SELECT *
    FROM ${videoParts}
    WHERE ${videoParts.video_id} = ${videoId}
      AND ${videoParts.page_no} = ${pageNo}
      AND is_deleted = 0
    LIMIT 1
  `) ?? null;
}

export function listPendingSummaryParts(db: Db, videoId: number): VideoPartRecord[] {
  return getDrizzleDb(db).all<VideoPartRecord>(sql`
    SELECT * FROM video_parts
    WHERE video_id = ${videoId}
      AND is_deleted = 0
      AND (summary_text IS NULL OR TRIM(summary_text) = '')
    ORDER BY page_no ASC
  `);
}

export function listPendingPublishParts(db: Db, videoId: number): VideoPartRecord[] {
  return getDrizzleDb(db).all<VideoPartRecord>(sql`
    SELECT * FROM video_parts
    WHERE video_id = ${videoId}
      AND is_deleted = 0
      AND (
        (summary_text_processed IS NOT NULL AND TRIM(summary_text_processed) <> '')
        OR (summary_text IS NOT NULL AND TRIM(summary_text) <> '')
      )
      AND published = 0
    ORDER BY page_no ASC
  `);
}

export function savePartSummary(
  db: Db,
  videoId: number,
  pageNo: number,
  {
    summaryText,
    summaryHash,
    processedSummaryText = null,
  }: {
    summaryText: string;
    summaryHash: string;
    processedSummaryText?: string | null;
  },
): VideoPartRecord | null {
  const orm = getDrizzleDb(db);
  const now = new Date().toISOString();
  const normalizedProcessedSummaryText = normalizeStoredSummaryText(processedSummaryText);
  withDatabaseWriteLock(db, () => {
    orm.run(sql`
      UPDATE ${videoParts}
      SET summary_text = ${summaryText},
          summary_text_processed = CASE
            WHEN COALESCE(summary_hash, '') <> COALESCE(${summaryHash}, '') THEN ${normalizedProcessedSummaryText}
            ELSE COALESCE(${normalizedProcessedSummaryText}, summary_text_processed)
          END,
          summary_hash = ${summaryHash},
          published = CASE
            WHEN COALESCE(summary_hash, '') <> COALESCE(${summaryHash}, '') THEN 0
            ELSE published
          END,
          published_comment_rpid = CASE
            WHEN COALESCE(summary_hash, '') <> COALESCE(${summaryHash}, '') THEN NULL
            ELSE published_comment_rpid
          END,
          published_at = CASE
            WHEN COALESCE(summary_hash, '') <> COALESCE(${summaryHash}, '') THEN NULL
            ELSE published_at
          END,
          updated_at = ${now}
      WHERE ${videoParts.video_id} = ${videoId}
        AND ${videoParts.page_no} = ${pageNo}
        AND is_deleted = 0
    `);
  });

  return getActiveVideoPartByPageNo(db, videoId, pageNo);
}

export function savePartProcessedSummary(
  db: Db,
  videoId: number,
  pageNo: number,
  processedSummaryText: string | null | undefined,
): VideoPartRecord | null {
  const orm = getDrizzleDb(db);
  const now = new Date().toISOString();
  const normalizedProcessedSummaryText = normalizeStoredSummaryText(processedSummaryText);
  withDatabaseWriteLock(db, () => {
    orm.run(sql`
      UPDATE ${videoParts}
      SET summary_text_processed = ${normalizedProcessedSummaryText},
          updated_at = ${now}
      WHERE ${videoParts.video_id} = ${videoId}
        AND ${videoParts.page_no} = ${pageNo}
        AND is_deleted = 0
    `);
  });

  return getActiveVideoPartByPageNo(db, videoId, pageNo);
}

export function savePartSubtitle(
  db: Db,
  videoId: number,
  pageNo: number,
  {
    subtitlePath,
    subtitleSource,
    subtitleLang = null,
    subtitleText = null,
  }: {
    subtitlePath: string;
    subtitleSource: string;
    subtitleLang?: string | null;
    subtitleText?: string | null;
  },
): VideoPartRecord | null {
  const orm = getDrizzleDb(db);
  const now = new Date().toISOString();
  const normalizedSubtitleText = normalizeStoredPartText(subtitleText);
  withDatabaseWriteLock(db, () => {
    orm.run(sql`
      UPDATE ${videoParts}
      SET subtitle_path = ${subtitlePath},
          subtitle_source = ${subtitleSource},
          subtitle_lang = ${subtitleLang},
          subtitle_text = COALESCE(${normalizedSubtitleText}, subtitle_text),
          updated_at = ${now}
      WHERE ${videoParts.video_id} = ${videoId}
        AND ${videoParts.page_no} = ${pageNo}
        AND is_deleted = 0
    `);
  });

  return getActiveVideoPartByPageNo(db, videoId, pageNo);
}

export function savePartPrompt(
  db: Db,
  videoId: number,
  pageNo: number,
  promptText: string | null | undefined,
): VideoPartRecord | null {
  const orm = getDrizzleDb(db);
  const now = new Date().toISOString();
  const normalizedPromptText = normalizeStoredPartText(promptText);
  withDatabaseWriteLock(db, () => {
    orm.run(sql`
      UPDATE ${videoParts}
      SET prompt_text = ${normalizedPromptText},
          updated_at = ${now}
      WHERE ${videoParts.video_id} = ${videoId}
        AND ${videoParts.page_no} = ${pageNo}
        AND is_deleted = 0
    `);
  });

  return getActiveVideoPartByPageNo(db, videoId, pageNo);
}

export function markPartsPublished(db: Db, videoId: number, pageNos: number[], publishedCommentRpid: number | null) {
  if (!Array.isArray(pageNos) || pageNos.length === 0) {
    return;
  }

  const orm = getDrizzleDb(db);
  const now = new Date().toISOString();

  withDatabaseWriteLock(db, () => {
    db.exec("BEGIN");
    try {
      for (const pageNo of pageNos) {
        orm.run(sql`
          UPDATE ${videoParts}
          SET published = 1,
              published_comment_rpid = COALESCE(${publishedCommentRpid ?? null}, published_comment_rpid),
              published_at = ${now},
              updated_at = ${now}
          WHERE ${videoParts.video_id} = ${videoId}
            AND ${videoParts.page_no} = ${pageNo}
            AND is_deleted = 0
        `);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  });
}

export function resetPublishedStateForVideo(db: Db, videoId: number) {
  const orm = getDrizzleDb(db);
  const now = new Date().toISOString();
  withDatabaseWriteLock(db, () => {
    orm.run(sql`
      UPDATE ${videoParts}
      SET published = 0,
          published_comment_rpid = NULL,
          published_at = NULL,
          updated_at = ${now}
      WHERE ${videoParts.video_id} = ${videoId}
    `);
  });
}

export function getPreferredSummaryTextForPart(part: Pick<VideoPartRecord, "summary_text" | "summary_text_processed"> | null | undefined): string {
  return getPreferredSummaryText(part);
}
