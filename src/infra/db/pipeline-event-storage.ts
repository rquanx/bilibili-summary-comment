import { sql } from "drizzle-orm";
import { withDatabaseWriteLock } from "./database";
import { getDrizzleDb } from "./orm";
import { pipelineEvents } from "./schema";
import type { Db, PipelineEventInput, PipelineEventRecord } from "./types";

export function insertPipelineEvent(db: Db, event: PipelineEventInput): PipelineEventRecord | null {
  const orm = getDrizzleDb(db);
  const createdAt = new Date().toISOString();
  return withDatabaseWriteLock(db, () => {
    orm.run(sql`
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
      VALUES (
        ${normalizeNullableText(event.runId)},
        ${normalizeNullableInteger(event.videoId)},
        ${normalizeNullableText(event.bvid)},
        ${normalizeNullableText(event.videoTitle)},
        ${normalizeNullableInteger(event.pageNo)},
        ${normalizeNullableInteger(event.cid)},
        ${normalizeNullableText(event.partTitle)},
        ${requirePipelineEventField(event.scope, "scope")},
        ${requirePipelineEventField(event.action, "action")},
        ${requirePipelineEventField(event.status, "status")},
        ${normalizeNullableText(event.message)},
        ${serializePipelineEventDetails(event.details)},
        ${createdAt}
      )
    `);

    return orm.get<PipelineEventRecord>(sql`
      SELECT *
      FROM ${pipelineEvents}
      WHERE ${pipelineEvents.id} = last_insert_rowid()
    `) ?? null;
  });
}

export function listPipelineEvents(
  db: Db,
  { bvid = null, sinceIso = null, limit = 100 }: { bvid?: string | null; sinceIso?: string | null; limit?: number } = {},
): PipelineEventRecord[] {
  const safeLimit = Math.max(1, Number(limit) || 100);
  return getDrizzleDb(db).all<PipelineEventRecord>(sql`
    SELECT *
    FROM ${pipelineEvents}
    WHERE (${normalizeNullableText(bvid)} IS NULL OR ${pipelineEvents.bvid} = ${normalizeNullableText(bvid)})
      AND (${normalizeNullableText(sinceIso)} IS NULL OR ${pipelineEvents.created_at} >= ${normalizeNullableText(sinceIso)})
    ORDER BY created_at DESC, id DESC
    LIMIT ${safeLimit}
  `);
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
