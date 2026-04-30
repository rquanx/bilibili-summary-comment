import { getSchedulerStatus, openDatabase } from "../../../../scripts/lib/db/index";

export function createSchedulerStatusService({
  dbPath = "work/pipeline.sqlite3",
  heartbeatStaleMs = 90_000,
}: {
  dbPath?: string;
  heartbeatStaleMs?: number;
} = {}) {
  const db = openDatabase(dbPath);

  return {
    close() {
      db.close?.();
    },
    getStatus(schedulerKey = "main") {
      const row = getSchedulerStatus(db, schedulerKey);
      const currentTasks = parseJsonArray(row?.current_tasks_json ?? null);
      const lastHeartbeatAt = row?.last_heartbeat_at ?? null;
      const heartbeatAgeMs = lastHeartbeatAt ? Math.max(0, Date.now() - new Date(lastHeartbeatAt).getTime()) : null;
      const healthy = row?.status === "running" && heartbeatAgeMs !== null && heartbeatAgeMs <= heartbeatStaleMs;

      return {
        schedulerKey,
        status: row?.status ?? "unknown",
        healthy,
        mode: row?.mode ?? null,
        timezone: row?.timezone ?? null,
        pid: row?.pid ?? null,
        hostname: row?.hostname ?? null,
        summaryUsers: row?.summary_users ?? null,
        summaryConcurrency: row?.summary_concurrency ?? null,
        currentTasks,
        taskTimes: {
          summary: row?.last_summary_at ?? null,
          publish: row?.last_publish_at ?? null,
          "gap-check": row?.last_gap_check_at ?? null,
          refresh: row?.last_refresh_at ?? null,
          cleanup: row?.last_cleanup_at ?? null,
        },
        lastError: row?.last_error ?? null,
        startedAt: row?.started_at ?? null,
        lastHeartbeatAt,
        heartbeatAgeMs,
        updatedAt: row?.updated_at ?? null,
      };
    },
  };
}

function parseJsonArray(value: string | null): string[] {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return [];
  }

  try {
    const parsed = JSON.parse(normalized);
    return Array.isArray(parsed) ? parsed.map((item) => String(item ?? "").trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
}
