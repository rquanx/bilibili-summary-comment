import type { PostgresDb } from "./postgres-database";
import type {
  RecentReprocessRunInsert,
  RecentReprocessRunRecord,
} from "./types";

export async function pgSaveRecentReprocessRun(
  db: PostgresDb,
  input: RecentReprocessRunInsert,
): Promise<RecentReprocessRunRecord> {
  const now = new Date().toISOString();
  const rows = await db.query<RecentReprocessRunRecord>(`
    INSERT INTO recent_reprocess_runs (
      video_id, bvid, video_title, candidate_key, reasons_json,
      paste_pages_json, status, error_message, details_json,
      created_at, updated_at, finished_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10, $11
    )
    RETURNING *
  `, [
    input.videoId ?? null,
    input.bvid,
    input.videoTitle ?? null,
    input.candidateKey,
    JSON.stringify(input.reasons),
    JSON.stringify(input.pastePages ?? []),
    input.status,
    input.errorMessage ?? null,
    input.details === undefined ? null : JSON.stringify(input.details),
    now,
    input.finishedAt ?? now,
  ]);
  return rows[0];
}

export async function pgGetLatestSuccessfulRecentReprocessRunByCandidateKey(
  db: PostgresDb,
  candidateKey: string,
): Promise<RecentReprocessRunRecord | null> {
  const rows = await db.query<RecentReprocessRunRecord>(`
    SELECT *
    FROM recent_reprocess_runs
    WHERE candidate_key = $1
      AND status = 'success'
    ORDER BY finished_at DESC NULLS LAST, id DESC
    LIMIT 1
  `, [candidateKey]);
  return rows[0] ?? null;
}
