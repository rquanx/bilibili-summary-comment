import type { Db, PipelineEventInput, PipelineEventRecord } from "./types";

export function insertPipelineEvent(db: Db, event: PipelineEventInput): PipelineEventRecord | null {
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

  return ((db.prepare("SELECT * FROM pipeline_events WHERE id = last_insert_rowid()").get()) as unknown as PipelineEventRecord | undefined) ?? null;
}

export function listPipelineEvents(
  db: Db,
  { bvid = null, sinceIso = null, limit = 100 }: { bvid?: string | null; sinceIso?: string | null; limit?: number } = {},
): PipelineEventRecord[] {
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
  ) as unknown as PipelineEventRecord[];
}

function requirePipelineEventField(value: unknown, fieldName: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`Missing required pipeline event field: ${fieldName}`);
  }

  return normalized;
}

function normalizeNullableText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeNullableInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) ? normalized : null;
}

function serializePipelineEventDetails(details: unknown): string | null {
  if (details === undefined || details === null) {
    return null;
  }

  return `${JSON.stringify(details)}\n`;
}
