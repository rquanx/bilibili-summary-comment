import type { Db, RecentReprocessRunInsert, RecentReprocessRunRecord } from "./types";

export function saveRecentReprocessRun(db: Db, input: RecentReprocessRunInsert): RecentReprocessRunRecord {
  const now = new Date().toISOString();
  const finishedAt = normalizeOptionalString(input.finishedAt) ?? now;
  db.prepare(`
    INSERT INTO recent_reprocess_runs (
      video_id,
      bvid,
      video_title,
      candidate_key,
      reasons_json,
      paste_pages_json,
      status,
      error_message,
      details_json,
      created_at,
      updated_at,
      finished_at
    )
    VALUES (
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?,
      ?
    )
  `).run(
    normalizeNullableNumber(input.videoId),
    String(input.bvid ?? "").trim(),
    normalizeOptionalString(input.videoTitle),
    String(input.candidateKey ?? "").trim(),
    JSON.stringify(normalizeStringList(input.reasons)),
    JSON.stringify(normalizeNumberList(input.pastePages)),
    input.status,
    normalizeOptionalString(input.errorMessage),
    input.details === undefined ? null : JSON.stringify(input.details),
    now,
    now,
    finishedAt,
  );

  return db.prepare(`
    SELECT
      id,
      video_id,
      bvid,
      video_title,
      candidate_key,
      reasons_json,
      paste_pages_json,
      status,
      error_message,
      details_json,
      created_at,
      updated_at,
      finished_at
    FROM recent_reprocess_runs
    WHERE id = last_insert_rowid()
  `).get() as unknown as RecentReprocessRunRecord;
}

export function getLatestSuccessfulRecentReprocessRunByCandidateKey(
  db: Db,
  candidateKey: string,
): RecentReprocessRunRecord | null {
  const normalizedCandidateKey = String(candidateKey ?? "").trim();
  if (!normalizedCandidateKey) {
    return null;
  }

  return db.prepare(`
    SELECT
      id,
      video_id,
      bvid,
      video_title,
      candidate_key,
      reasons_json,
      paste_pages_json,
      status,
      error_message,
      details_json,
      created_at,
      updated_at,
      finished_at
    FROM recent_reprocess_runs
    WHERE candidate_key = ?
      AND status = 'success'
    ORDER BY
      COALESCE(finished_at, updated_at, created_at) DESC,
      id DESC
    LIMIT 1
  `).get(normalizedCandidateKey) as unknown as RecentReprocessRunRecord | null;
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function normalizeNullableNumber(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function normalizeStringList(values: unknown): string[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => String(value ?? "").trim())
    .filter(Boolean);
}

function normalizeNumberList(values: unknown): number[] {
  if (!Array.isArray(values)) {
    return [];
  }

  return values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}
