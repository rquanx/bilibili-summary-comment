import { withDatabaseWriteLock } from "./database";
import type { Db, SchedulerStatusRecord } from "./types";

export function upsertSchedulerStatus(
  db: Db,
  {
    schedulerKey = "main",
    status,
    mode = null,
    timezone = null,
    pid = null,
    hostname = null,
    summaryUsers = null,
    summaryConcurrency = null,
    currentTasks = null,
    lastSummaryAt = null,
    lastPublishAt = null,
    lastGapCheckAt = null,
    lastRetryFailuresAt = null,
    lastRefreshAt = null,
    lastCleanupAt = null,
    lastError = null,
    startedAt = null,
    lastHeartbeatAt = null,
  }: {
    schedulerKey?: string;
    status: string;
    mode?: string | null;
    timezone?: string | null;
    pid?: number | null;
    hostname?: string | null;
    summaryUsers?: string | null;
    summaryConcurrency?: number | null;
    currentTasks?: string[] | null;
    lastSummaryAt?: string | null;
    lastPublishAt?: string | null;
    lastGapCheckAt?: string | null;
    lastRetryFailuresAt?: string | null;
    lastRefreshAt?: string | null;
    lastCleanupAt?: string | null;
    lastError?: string | null;
    startedAt?: string | null;
    lastHeartbeatAt?: string | null;
  },
): SchedulerStatusRecord | null {
  const now = new Date().toISOString();

  return withDatabaseWriteLock(db, () => {
    db.prepare(`
      INSERT INTO scheduler_status (
        scheduler_key,
        status,
        mode,
        timezone,
        pid,
        hostname,
        summary_users,
        summary_concurrency,
        current_tasks_json,
        last_summary_at,
        last_publish_at,
        last_gap_check_at,
        last_retry_failures_at,
        last_refresh_at,
        last_cleanup_at,
        last_error,
        started_at,
        last_heartbeat_at,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scheduler_key) DO UPDATE SET
        status = excluded.status,
        mode = COALESCE(excluded.mode, scheduler_status.mode),
        timezone = COALESCE(excluded.timezone, scheduler_status.timezone),
        pid = COALESCE(excluded.pid, scheduler_status.pid),
        hostname = COALESCE(excluded.hostname, scheduler_status.hostname),
        summary_users = COALESCE(excluded.summary_users, scheduler_status.summary_users),
        summary_concurrency = COALESCE(excluded.summary_concurrency, scheduler_status.summary_concurrency),
        current_tasks_json = COALESCE(excluded.current_tasks_json, scheduler_status.current_tasks_json),
        last_summary_at = COALESCE(excluded.last_summary_at, scheduler_status.last_summary_at),
        last_publish_at = COALESCE(excluded.last_publish_at, scheduler_status.last_publish_at),
        last_gap_check_at = COALESCE(excluded.last_gap_check_at, scheduler_status.last_gap_check_at),
        last_retry_failures_at = COALESCE(excluded.last_retry_failures_at, scheduler_status.last_retry_failures_at),
        last_refresh_at = COALESCE(excluded.last_refresh_at, scheduler_status.last_refresh_at),
        last_cleanup_at = COALESCE(excluded.last_cleanup_at, scheduler_status.last_cleanup_at),
        last_error = COALESCE(excluded.last_error, scheduler_status.last_error),
        started_at = COALESCE(excluded.started_at, scheduler_status.started_at),
        last_heartbeat_at = COALESCE(excluded.last_heartbeat_at, scheduler_status.last_heartbeat_at),
        updated_at = excluded.updated_at
    `).run(
      normalizeText(schedulerKey) ?? "main",
      requireText(status, "status"),
      normalizeText(mode),
      normalizeText(timezone),
      normalizeInteger(pid),
      normalizeText(hostname),
      normalizeText(summaryUsers),
      normalizeInteger(summaryConcurrency),
      serializeCurrentTasks(currentTasks),
      normalizeText(lastSummaryAt),
      normalizeText(lastPublishAt),
      normalizeText(lastGapCheckAt),
      normalizeText(lastRetryFailuresAt),
      normalizeText(lastRefreshAt),
      normalizeText(lastCleanupAt),
      normalizeText(lastError),
      normalizeText(startedAt),
      normalizeText(lastHeartbeatAt) ?? now,
      now,
      now,
    );

    return getSchedulerStatus(db, schedulerKey);
  });
}

export function getSchedulerStatus(db: Db, schedulerKey = "main"): SchedulerStatusRecord | null {
  return (db.prepare("SELECT * FROM scheduler_status WHERE scheduler_key = ?").get(normalizeText(schedulerKey) ?? "main") as unknown as SchedulerStatusRecord | undefined) ?? null;
}

function serializeCurrentTasks(currentTasks: string[] | null): string | null {
  if (!Array.isArray(currentTasks)) {
    return null;
  }

  return `${JSON.stringify([...new Set(currentTasks.map((item) => String(item).trim()).filter(Boolean))])}\n`;
}

function normalizeText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function requireText(value: unknown, fieldName: string): string {
  const normalized = normalizeText(value);
  if (!normalized) {
    throw new Error(`Missing required scheduler status field: ${fieldName}`);
  }

  return normalized;
}

function normalizeInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) ? normalized : null;
}
