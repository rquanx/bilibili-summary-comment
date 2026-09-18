import path from "node:path";
import type { PostgresDb } from "./postgres-database";
import type {
  VideoIdentity,
  VideoInsert,
  VideoPartRecord,
  VideoPartUpsert,
  VideoRecord,
} from "./types";
import { getPreferredSummaryText, normalizeStoredSummaryText } from "./summary-text";
import { isPublishableSummaryText } from "../../shared/summary-quality";

function normalizeStoredPartText(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

export async function pgGetVideoByIdentity(
  db: PostgresDb,
  { bvid = null, aid = null }: VideoIdentity,
): Promise<VideoRecord | null> {
  if (bvid) {
    const rows = await db.query<VideoRecord>(
      "SELECT * FROM videos WHERE bvid = $1 LIMIT 1",
      [bvid],
    );
    if (rows[0]) {
      return rows[0];
    }
  }
  if (aid !== null && aid !== undefined) {
    const rows = await db.query<VideoRecord>(
      "SELECT * FROM videos WHERE aid = $1 LIMIT 1",
      [aid],
    );
    return rows[0] ?? null;
  }
  return null;
}

export async function pgGetVideoById(db: PostgresDb, videoId: number): Promise<VideoRecord | null> {
  const rows = await db.query<VideoRecord>(
    "SELECT * FROM videos WHERE id = $1 LIMIT 1",
    [videoId],
  );
  return rows[0] ?? null;
}

export function pgListVideos(db: PostgresDb): Promise<VideoRecord[]> {
  return db.query<VideoRecord>(
    "SELECT * FROM videos ORDER BY updated_at DESC, id DESC",
  );
}

export async function pgListVideosPendingPublish(db: PostgresDb): Promise<VideoRecord[]> {
  const rows = await db.query<VideoRecord & {
    pending_summary_text: string | null;
    pending_summary_text_processed: string | null;
  }>(`
    SELECT v.*,
           p.summary_text AS pending_summary_text,
           p.summary_text_processed AS pending_summary_text_processed
    FROM videos v
    LEFT JOIN video_parts p
      ON p.video_id = v.id
      AND p.is_deleted = 0
      AND p.published = 0
      AND (
        (p.summary_text_processed IS NOT NULL AND TRIM(p.summary_text_processed) <> '')
        OR (p.summary_text IS NOT NULL AND TRIM(p.summary_text) <> '')
      )
    WHERE v.source_type = 'bili'
      AND v.publish_enabled = 1
      AND (v.publish_needs_rebuild = 1 OR p.id IS NOT NULL)
    ORDER BY v.aid DESC, v.created_at DESC, v.id DESC, p.page_no ASC
  `);

  const candidates = new Map<number, {
    video: VideoRecord;
    hasPublishablePart: boolean;
  }>();
  for (const row of rows) {
    const candidate = candidates.get(row.id) ?? {
      video: row,
      hasPublishablePart: false,
    };
    if (!candidate.hasPublishablePart) {
      candidate.hasPublishablePart = isPublishableSummaryText(getPreferredSummaryText({
        summary_text: row.pending_summary_text,
        summary_text_processed: row.pending_summary_text_processed,
      }));
    }
    candidates.set(row.id, candidate);
  }
  return [...candidates.values()]
    .filter(({ video, hasPublishablePart }) => (
      Number(video.publish_needs_rebuild) === 1 || hasPublishablePart
    ))
    .map(({ video }) => video);
}

export function pgListVideosOlderThan(
  db: PostgresDb,
  cutoffIso: string,
): Promise<VideoRecord[]> {
  return db.query<VideoRecord>(`
    SELECT *
    FROM videos
    WHERE COALESCE(last_scan_at, updated_at, created_at) < $1
    ORDER BY COALESCE(last_scan_at, updated_at, created_at) ASC, id ASC
  `, [cutoffIso]);
}

export async function pgUpsertVideo(db: PostgresDb, video: VideoInsert): Promise<VideoRecord> {
  const now = new Date().toISOString();
  const rows = await db.query<VideoRecord>(`
    INSERT INTO videos (
      bvid, aid, title, owner_mid, owner_name, owner_dir_name, work_dir_name,
      source_type, publish_enabled, page_count, root_comment_rpid,
      top_comment_rpid, preserved_top_comment_rpid, last_scan_at,
      created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $14, $14
    )
    ON CONFLICT (bvid) DO UPDATE SET
      aid = EXCLUDED.aid,
      title = EXCLUDED.title,
      owner_mid = COALESCE(EXCLUDED.owner_mid, videos.owner_mid),
      owner_name = COALESCE(EXCLUDED.owner_name, videos.owner_name),
      owner_dir_name = COALESCE(videos.owner_dir_name, EXCLUDED.owner_dir_name),
      work_dir_name = COALESCE(videos.work_dir_name, EXCLUDED.work_dir_name),
      source_type = EXCLUDED.source_type,
      publish_enabled = EXCLUDED.publish_enabled,
      page_count = EXCLUDED.page_count,
      preserved_top_comment_rpid = COALESCE(
        EXCLUDED.preserved_top_comment_rpid,
        videos.preserved_top_comment_rpid
      ),
      updated_at = EXCLUDED.updated_at,
      last_scan_at = EXCLUDED.last_scan_at
    RETURNING *
  `, [
    video.bvid,
    video.aid,
    video.title,
    video.ownerMid ?? null,
    video.ownerName ?? null,
    video.ownerDirName ?? null,
    video.workDirName ?? null,
    video.sourceType ?? "bili",
    video.publishEnabled === undefined ? 1 : video.publishEnabled ? 1 : 0,
    video.pageCount,
    video.rootCommentRpid ?? null,
    video.topCommentRpid ?? null,
    video.preservedTopCommentRpid ?? null,
    now,
  ]);
  return rows[0];
}

export async function pgReplaceVideoSubtitlePathPrefix(
  db: PostgresDb,
  videoId: number,
  fromPrefix: string,
  toPrefix: string,
) {
  const resolvedFromPrefix = path.resolve(fromPrefix);
  const resolvedToPrefix = path.resolve(toPrefix);
  const rows = await pgListAllVideoParts(db, videoId);
  const now = new Date().toISOString();

  await db.transaction(async () => {
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
      await db.execute(
        "UPDATE video_parts SET subtitle_path = $1, updated_at = $2 WHERE id = $3",
        [nextSubtitlePath, now, row.id],
      );
    }
  });
}

export async function pgUpdateVideoCommentThread(
  db: PostgresDb,
  videoId: number,
  {
    rootCommentRpid = null,
    topCommentRpid = null,
  }: {
    rootCommentRpid?: number | null;
    topCommentRpid?: number | null;
  },
): Promise<VideoRecord | null> {
  const rows = await db.query<VideoRecord>(`
    UPDATE videos
    SET root_comment_rpid = $1,
        top_comment_rpid = $2,
        updated_at = $3
    WHERE id = $4
    RETURNING *
  `, [rootCommentRpid, topCommentRpid, new Date().toISOString(), videoId]);
  return rows[0] ?? null;
}

export async function pgUpdateVideoPreservedTopComment(
  db: PostgresDb,
  videoId: number,
  preservedTopCommentRpid: number | null,
): Promise<VideoRecord | null> {
  const normalizedRpid = Number(preservedTopCommentRpid);
  const nextRpid = Number.isInteger(normalizedRpid) && normalizedRpid > 0 ? normalizedRpid : null;
  const rows = await db.query<VideoRecord>(`
    UPDATE videos
    SET preserved_top_comment_rpid = $1,
        top_comment_rpid = CASE
          WHEN $1::bigint IS NOT NULL THEN $1
          WHEN top_comment_rpid = preserved_top_comment_rpid THEN NULL
          ELSE top_comment_rpid
        END,
        updated_at = $2
    WHERE id = $3
    RETURNING *
  `, [nextRpid, new Date().toISOString(), videoId]);
  return rows[0] ?? null;
}

export async function pgMarkVideoPublishRebuildNeeded(
  db: PostgresDb,
  videoId: number,
  reason: string | null | undefined,
): Promise<VideoRecord | null> {
  const rows = await db.query<VideoRecord>(`
    UPDATE videos
    SET publish_needs_rebuild = 1,
        publish_rebuild_reason = $1,
        updated_at = $2
    WHERE id = $3
    RETURNING *
  `, [
    String(reason ?? "").trim() || "structural-part-change",
    new Date().toISOString(),
    videoId,
  ]);
  return rows[0] ?? null;
}

export async function pgClearVideoPublishRebuildNeeded(
  db: PostgresDb,
  videoId: number,
): Promise<VideoRecord | null> {
  const rows = await db.query<VideoRecord>(`
    UPDATE videos
    SET publish_needs_rebuild = 0,
        publish_rebuild_reason = NULL,
        updated_at = $1
    WHERE id = $2
    RETURNING *
  `, [new Date().toISOString(), videoId]);
  return rows[0] ?? null;
}

export async function pgUpsertVideoPart(
  db: PostgresDb,
  part: VideoPartUpsert,
): Promise<VideoPartRecord | null> {
  const now = new Date().toISOString();
  const rows = await db.query<VideoPartRecord>(`
    INSERT INTO video_parts (
      video_id, page_no, cid, part_title, duration_sec, subtitle_path,
      subtitle_source, subtitle_lang, source_path, subtitle_text, prompt_text,
      summary_text, summary_text_processed, summary_hash, published,
      published_comment_rpid, published_at, is_deleted, deleted_at,
      created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
      $15, $16, $17, $18, $19, $20, $20
    )
    ON CONFLICT (video_id, cid) DO UPDATE SET
      page_no = EXCLUDED.page_no,
      part_title = EXCLUDED.part_title,
      duration_sec = EXCLUDED.duration_sec,
      subtitle_path = EXCLUDED.subtitle_path,
      subtitle_source = EXCLUDED.subtitle_source,
      subtitle_lang = EXCLUDED.subtitle_lang,
      source_path = EXCLUDED.source_path,
      subtitle_text = EXCLUDED.subtitle_text,
      prompt_text = EXCLUDED.prompt_text,
      summary_text = EXCLUDED.summary_text,
      summary_text_processed = EXCLUDED.summary_text_processed,
      summary_hash = EXCLUDED.summary_hash,
      published = EXCLUDED.published,
      published_comment_rpid = EXCLUDED.published_comment_rpid,
      published_at = EXCLUDED.published_at,
      is_deleted = EXCLUDED.is_deleted,
      deleted_at = EXCLUDED.deleted_at,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `, [
    part.videoId,
    part.pageNo,
    part.cid,
    part.partTitle,
    part.durationSec,
    part.subtitlePath ?? null,
    part.subtitleSource ?? null,
    part.subtitleLang ?? null,
    part.sourcePath ?? null,
    normalizeStoredPartText(part.subtitleText),
    normalizeStoredPartText(part.promptText),
    part.summaryText ?? null,
    normalizeStoredSummaryText(part.processedSummaryText),
    part.summaryHash ?? null,
    part.published ? 1 : 0,
    part.publishedCommentRpid ?? null,
    part.publishedAt ?? null,
    part.isDeleted ? 1 : 0,
    part.deletedAt ?? null,
    now,
  ]);
  return rows[0] ?? null;
}

export function pgListVideoParts(db: PostgresDb, videoId: number): Promise<VideoPartRecord[]> {
  return db.query<VideoPartRecord>(`
    SELECT *
    FROM video_parts
    WHERE video_id = $1 AND is_deleted = 0
    ORDER BY page_no ASC, id ASC
  `, [videoId]);
}

export function pgListAllVideoParts(db: PostgresDb, videoId: number): Promise<VideoPartRecord[]> {
  return db.query<VideoPartRecord>(`
    SELECT *
    FROM video_parts
    WHERE video_id = $1
    ORDER BY is_deleted ASC, page_no ASC, id ASC
  `, [videoId]);
}

export async function pgGetVideoPartByCid(
  db: PostgresDb,
  videoId: number,
  cid: number,
): Promise<VideoPartRecord | null> {
  const rows = await db.query<VideoPartRecord>(
    "SELECT * FROM video_parts WHERE video_id = $1 AND cid = $2 LIMIT 1",
    [videoId, cid],
  );
  return rows[0] ?? null;
}

export async function pgGetActiveVideoPartByPageNo(
  db: PostgresDb,
  videoId: number,
  pageNo: number,
): Promise<VideoPartRecord | null> {
  const rows = await db.query<VideoPartRecord>(`
    SELECT *
    FROM video_parts
    WHERE video_id = $1 AND page_no = $2 AND is_deleted = 0
    LIMIT 1
  `, [videoId, pageNo]);
  return rows[0] ?? null;
}

export function pgListPendingSummaryParts(
  db: PostgresDb,
  videoId: number,
): Promise<VideoPartRecord[]> {
  return db.query<VideoPartRecord>(`
    SELECT *
    FROM video_parts
    WHERE video_id = $1
      AND is_deleted = 0
      AND (summary_text IS NULL OR TRIM(summary_text) = '')
    ORDER BY page_no ASC
  `, [videoId]);
}

export async function pgListPendingPublishParts(
  db: PostgresDb,
  videoId: number,
): Promise<VideoPartRecord[]> {
  const rows = await db.query<VideoPartRecord>(`
    SELECT p.*
    FROM video_parts p
    WHERE p.video_id = $1
      AND EXISTS (
        SELECT 1
        FROM videos v
        WHERE v.id = p.video_id
          AND v.source_type = 'bili'
          AND v.publish_enabled = 1
      )
      AND p.is_deleted = 0
      AND (
        (p.summary_text_processed IS NOT NULL AND TRIM(p.summary_text_processed) <> '')
        OR (p.summary_text IS NOT NULL AND TRIM(p.summary_text) <> '')
      )
      AND p.published = 0
    ORDER BY p.page_no ASC
  `, [videoId]);
  return rows.filter((part) => isPublishableSummaryText(getPreferredSummaryText(part)));
}

export async function pgSavePartSummary(
  db: PostgresDb,
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
): Promise<VideoPartRecord | null> {
  const processed = normalizeStoredSummaryText(processedSummaryText);
  const rows = await db.query<VideoPartRecord>(`
    UPDATE video_parts
    SET summary_text = $1,
        summary_text_processed = CASE
          WHEN COALESCE(summary_hash, '') <> COALESCE($2, '') THEN $3
          ELSE COALESCE($3, summary_text_processed)
        END,
        summary_hash = $2,
        published = CASE
          WHEN COALESCE(summary_hash, '') <> COALESCE($2, '') THEN 0
          ELSE published
        END,
        published_comment_rpid = CASE
          WHEN COALESCE(summary_hash, '') <> COALESCE($2, '') THEN NULL
          ELSE published_comment_rpid
        END,
        published_at = CASE
          WHEN COALESCE(summary_hash, '') <> COALESCE($2, '') THEN NULL
          ELSE published_at
        END,
        updated_at = $4
    WHERE video_id = $5 AND page_no = $6 AND is_deleted = 0
    RETURNING *
  `, [
    summaryText,
    summaryHash,
    processed,
    new Date().toISOString(),
    videoId,
    pageNo,
  ]);
  return rows[0] ?? null;
}

export async function pgSavePartProcessedSummary(
  db: PostgresDb,
  videoId: number,
  pageNo: number,
  processedSummaryText: string | null | undefined,
): Promise<VideoPartRecord | null> {
  const rows = await db.query<VideoPartRecord>(`
    UPDATE video_parts
    SET summary_text_processed = $1, updated_at = $2
    WHERE video_id = $3 AND page_no = $4 AND is_deleted = 0
    RETURNING *
  `, [
    normalizeStoredSummaryText(processedSummaryText),
    new Date().toISOString(),
    videoId,
    pageNo,
  ]);
  return rows[0] ?? null;
}

export async function pgSavePartSubtitle(
  db: PostgresDb,
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
): Promise<VideoPartRecord | null> {
  const rows = await db.query<VideoPartRecord>(`
    UPDATE video_parts
    SET subtitle_path = $1,
        subtitle_source = $2,
        subtitle_lang = $3,
        subtitle_text = COALESCE($4, subtitle_text),
        updated_at = $5
    WHERE video_id = $6 AND page_no = $7 AND is_deleted = 0
    RETURNING *
  `, [
    subtitlePath,
    subtitleSource,
    subtitleLang,
    normalizeStoredPartText(subtitleText),
    new Date().toISOString(),
    videoId,
    pageNo,
  ]);
  return rows[0] ?? null;
}

export async function pgSavePartPrompt(
  db: PostgresDb,
  videoId: number,
  pageNo: number,
  promptText: string | null | undefined,
): Promise<VideoPartRecord | null> {
  const rows = await db.query<VideoPartRecord>(`
    UPDATE video_parts
    SET prompt_text = $1, updated_at = $2
    WHERE video_id = $3 AND page_no = $4 AND is_deleted = 0
    RETURNING *
  `, [
    normalizeStoredPartText(promptText),
    new Date().toISOString(),
    videoId,
    pageNo,
  ]);
  return rows[0] ?? null;
}

export async function pgMarkPartsPublished(
  db: PostgresDb,
  videoId: number,
  pageNos: number[],
  publishedCommentRpid: number | null,
) {
  if (!Array.isArray(pageNos) || pageNos.length === 0) {
    return;
  }
  const now = new Date().toISOString();
  await db.execute(`
    UPDATE video_parts
    SET published = 1,
        published_comment_rpid = COALESCE($1, published_comment_rpid),
        published_at = $2,
        updated_at = $2
    WHERE video_id = $3
      AND page_no = ANY($4::integer[])
      AND is_deleted = 0
  `, [publishedCommentRpid, now, videoId, pageNos]);
}

export async function pgResetPublishedStateForVideo(db: PostgresDb, videoId: number) {
  await db.execute(`
    UPDATE video_parts
    SET published = 0,
        published_comment_rpid = NULL,
        published_at = NULL,
        updated_at = $1
    WHERE video_id = $2
  `, [new Date().toISOString(), videoId]);
}
