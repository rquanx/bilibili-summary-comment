import type { Db, GapNotificationInsert, GapNotificationRecord } from "./types";

export function getGapNotificationByKey(db: Db, gapKey: string): GapNotificationRecord | null {
  const normalizedKey = normalizeGapKey(gapKey);
  if (!normalizedKey) {
    return null;
  }

  return ((db.prepare(`
    SELECT *
    FROM gap_notifications
    WHERE gap_key = ?
    LIMIT 1
  `).get(normalizedKey) as unknown as GapNotificationRecord | undefined) ?? null);
}

export function hasGapNotification(db: Db, gapKey: string): boolean {
  return Boolean(getGapNotificationByKey(db, gapKey));
}

export function saveGapNotification(db: Db, notification: GapNotificationInsert): GapNotificationRecord | null {
  const now = new Date().toISOString();
  const gapKey = requireGapKey(notification.gapKey);
  const notifiedAt = normalizeNullableText(notification.notifiedAt) ?? now;

  db.prepare(`
    INSERT INTO gap_notifications (
      gap_key,
      bvid,
      video_title,
      from_page_no,
      from_cid,
      to_page_no,
      to_cid,
      gap_start_at,
      gap_end_at,
      gap_seconds,
      notified_at,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(gap_key) DO UPDATE SET
      video_title = excluded.video_title,
      from_page_no = excluded.from_page_no,
      from_cid = excluded.from_cid,
      to_page_no = excluded.to_page_no,
      to_cid = excluded.to_cid,
      gap_start_at = excluded.gap_start_at,
      gap_end_at = excluded.gap_end_at,
      gap_seconds = excluded.gap_seconds,
      notified_at = excluded.notified_at,
      updated_at = excluded.updated_at
  `).run(
    gapKey,
    requireText(notification.bvid, "bvid"),
    normalizeNullableText(notification.videoTitle),
    requirePositiveInteger(notification.fromPageNo, "fromPageNo"),
    requirePositiveInteger(notification.fromCid, "fromCid"),
    requirePositiveInteger(notification.toPageNo, "toPageNo"),
    requirePositiveInteger(notification.toCid, "toCid"),
    requireText(notification.gapStartAt, "gapStartAt"),
    requireText(notification.gapEndAt, "gapEndAt"),
    requireNonNegativeInteger(notification.gapSeconds, "gapSeconds"),
    notifiedAt,
    now,
    now,
  );

  return getGapNotificationByKey(db, gapKey);
}

function normalizeGapKey(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeNullableText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function requireGapKey(value: unknown): string {
  const normalized = normalizeGapKey(value);
  if (!normalized) {
    throw new Error("Missing required gap notification field: gapKey");
  }

  return normalized;
}

function requireText(value: unknown, fieldName: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`Missing required gap notification field: ${fieldName}`);
  }

  return normalized;
}

function requirePositiveInteger(value: unknown, fieldName: string): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid positive integer gap notification field: ${fieldName}`);
  }

  return normalized;
}

function requireNonNegativeInteger(value: unknown, fieldName: string): number {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`Invalid non-negative integer gap notification field: ${fieldName}`);
  }

  return normalized;
}
