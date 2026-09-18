import type { PostgresDb } from "./postgres-database";
import type { GapNotificationInsert, GapNotificationRecord } from "./types";

export async function pgGetGapNotificationByKey(
  db: PostgresDb,
  gapKey: string,
): Promise<GapNotificationRecord | null> {
  const rows = await db.query<GapNotificationRecord>(
    "SELECT * FROM gap_notifications WHERE gap_key = $1 LIMIT 1",
    [gapKey],
  );
  return rows[0] ?? null;
}

export async function pgHasGapNotification(db: PostgresDb, gapKey: string): Promise<boolean> {
  const rows = await db.query<{ found: boolean }>(
    "SELECT EXISTS(SELECT 1 FROM gap_notifications WHERE gap_key = $1) AS found",
    [gapKey],
  );
  return Boolean(rows[0]?.found);
}

export async function pgSaveGapNotification(
  db: PostgresDb,
  notification: GapNotificationInsert,
): Promise<GapNotificationRecord | null> {
  const now = new Date().toISOString();
  const notifiedAt = notification.notifiedAt ?? now;
  const rows = await db.query<GapNotificationRecord>(`
    INSERT INTO gap_notifications (
      gap_key, bvid, video_title, from_page_no, from_cid, to_page_no,
      to_cid, gap_start_at, gap_end_at, gap_seconds, notified_at,
      created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12
    )
    ON CONFLICT (gap_key) DO UPDATE SET
      bvid = EXCLUDED.bvid,
      video_title = EXCLUDED.video_title,
      from_page_no = EXCLUDED.from_page_no,
      from_cid = EXCLUDED.from_cid,
      to_page_no = EXCLUDED.to_page_no,
      to_cid = EXCLUDED.to_cid,
      gap_start_at = EXCLUDED.gap_start_at,
      gap_end_at = EXCLUDED.gap_end_at,
      gap_seconds = EXCLUDED.gap_seconds,
      notified_at = EXCLUDED.notified_at,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `, [
    notification.gapKey,
    notification.bvid,
    notification.videoTitle ?? null,
    notification.fromPageNo,
    notification.fromCid,
    notification.toPageNo,
    notification.toCid,
    notification.gapStartAt,
    notification.gapEndAt,
    notification.gapSeconds,
    notifiedAt,
    now,
  ]);
  return rows[0] ?? null;
}
