import type { PostgresDb } from "./postgres-database";
import type { PipelineEventInput, PipelineEventRecord } from "./types";

export async function pgInsertPipelineEvent(
  db: PostgresDb,
  event: PipelineEventInput,
): Promise<PipelineEventRecord | null> {
  const rows = await db.query<PipelineEventRecord>(`
    INSERT INTO pipeline_events (
      run_id, video_id, bvid, video_title, page_no, cid, part_title,
      scope, action, status, message, details_json, created_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
    )
    RETURNING *
  `, [
    event.runId ?? null,
    event.videoId ?? null,
    event.bvid ?? null,
    event.videoTitle ?? null,
    event.pageNo ?? null,
    event.cid ?? null,
    event.partTitle ?? null,
    event.scope,
    event.action,
    event.status,
    event.message ?? null,
    event.details === undefined ? null : JSON.stringify(event.details),
    new Date().toISOString(),
  ]);
  return rows[0] ?? null;
}

export async function pgListPipelineEvents(
  db: PostgresDb,
  {
    bvid = null,
    sinceIso = null,
    limit = 200,
  }: {
    bvid?: string | null;
    sinceIso?: string | null;
    limit?: number;
  } = {},
): Promise<PipelineEventRecord[]> {
  const safeLimit = Math.max(1, Math.min(5_000, Math.floor(Number(limit) || 200)));
  return db.query<PipelineEventRecord>(`
    SELECT *
    FROM pipeline_events
    WHERE ($1::text IS NULL OR bvid = $1)
      AND ($2::text IS NULL OR created_at >= $2)
    ORDER BY created_at DESC, id DESC
    LIMIT $3
  `, [bvid, sinceIso, safeLimit]);
}
