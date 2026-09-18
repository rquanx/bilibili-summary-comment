import { runInTransaction } from "./database";
import { isPostgresDatabase } from "./postgres-database";
import type { Db } from "./types";

export interface PendingSummaryRow {
  video_id: number;
  bvid: string;
  title: string;
  owner_mid: number | null;
  pending_summary_parts: number;
  first_pending_at: string;
}

export interface CommentEventRow {
  details_json: string | null;
  created_at: string;
}

export interface SummaryInvalidationBatch {
  videoId: number;
  partIds: number[];
}

export async function listPendingSummaryRows(db: Db): Promise<PendingSummaryRow[]> {
  const query = `
    SELECT
      v.id AS video_id,
      v.bvid,
      v.title,
      v.owner_mid,
      COUNT(*) AS pending_summary_parts,
      MIN(p.created_at) AS first_pending_at
    FROM videos v
    JOIN video_parts p ON p.video_id = v.id
    WHERE p.is_deleted = 0
      AND (p.summary_text IS NULL OR TRIM(p.summary_text) = '')
    GROUP BY v.id, v.bvid, v.title, v.owner_mid
  `;

  if (isPostgresDatabase(db)) {
    return db.query<PendingSummaryRow>(query);
  }

  return db.prepare(query).all() as PendingSummaryRow[];
}

export async function listRecentSuccessfulCommentEvents(
  db: Db,
  limit = 500,
): Promise<CommentEventRow[]> {
  const safeLimit = Math.max(1, Math.floor(Number(limit) || 500));
  const query = `
    SELECT details_json, created_at
    FROM pipeline_events
    WHERE scope = 'publish'
      AND action = 'comment-thread'
      AND status = 'succeeded'
    ORDER BY created_at DESC, id DESC
    LIMIT ${safeLimit}
  `;

  if (isPostgresDatabase(db)) {
    return db.query<CommentEventRow>(query);
  }

  return db.prepare(query).all() as CommentEventRow[];
}

export async function getLatestCommentPublishActivityRow(
  db: Db,
): Promise<{ created_at?: string } | null> {
  const query = `
    SELECT created_at
    FROM pipeline_events
    WHERE scope = 'publish'
      AND action = 'comment-thread'
      AND status IN ('started', 'succeeded', 'failed')
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `;

  if (isPostgresDatabase(db)) {
    const rows = await db.query<{ created_at?: string }>(query);
    return rows[0] ?? null;
  }

  return db.prepare(query).get() as { created_at?: string } | undefined ?? null;
}

export async function invalidateStoredSummaries(
  db: Db,
  batches: SummaryInvalidationBatch[],
  reason: string,
  invalidatedAtIso: string,
): Promise<void> {
  if (isPostgresDatabase(db)) {
    await runInTransaction(db, async () => {
      for (const batch of batches) {
        if (batch.partIds.length === 0) {
          continue;
        }
        await db.execute(`
          UPDATE video_parts
          SET prompt_text = NULL,
              summary_text = NULL,
              summary_text_processed = NULL,
              summary_hash = NULL,
              published = 0,
              published_comment_rpid = NULL,
              published_at = NULL,
              updated_at = $1
          WHERE id = ANY($2::bigint[])
        `, [invalidatedAtIso, batch.partIds]);
        await db.execute(`
          UPDATE videos
          SET publish_needs_rebuild = 1,
              publish_rebuild_reason = $1,
              updated_at = $2
          WHERE id = $3
        `, [reason, invalidatedAtIso, batch.videoId]);
      }
    });
    return;
  }

  runInTransaction(db, () => {
    const clearPart = db.prepare(`
      UPDATE video_parts
      SET prompt_text = NULL,
          summary_text = NULL,
          summary_text_processed = NULL,
          summary_hash = NULL,
          published = 0,
          published_comment_rpid = NULL,
          published_at = NULL,
          updated_at = ?
      WHERE id = ?
    `);
    const markVideo = db.prepare(`
      UPDATE videos
      SET publish_needs_rebuild = 1,
          publish_rebuild_reason = ?,
          updated_at = ?
      WHERE id = ?
    `);

    for (const batch of batches) {
      if (batch.partIds.length === 0) {
        continue;
      }
      for (const partId of batch.partIds) {
        clearPart.run(invalidatedAtIso, partId);
      }
      markVideo.run(reason, invalidatedAtIso, batch.videoId);
    }
  });
}
