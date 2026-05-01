import {
  getSchedulerStatus,
  getPipelineRunStateById,
  listActivePipelineRunStates,
  openDatabase,
} from "../../../../scripts/lib/db/index";
import { getVideoPipelineLockSnapshot } from "../../../../scripts/lib/video/pipeline-lock";
import type { Db, PipelineRunStateRecord, SchedulerStatusRecord } from "../../../../scripts/lib/db/index";
import {
  createPipelineQueryService,
  type DashboardRunItem,
  type PipelineDetail,
  type PipelineEventItem,
} from "./pipeline-query-service";

export type {
  DashboardRunItem,
  PipelineDetail,
  PipelineEventItem,
} from "./pipeline-query-service";

export interface DashboardSummary {
  activeCount: number;
  failedCount24h: number;
  succeededCount24h: number;
  latestUpdatedAt: string | null;
}

export interface FailureQueueItem extends DashboardRunItem {
  failureCategory: string;
  resolution: "retryable" | "manual" | "inspect";
  resolutionReason: string;
  failureSignature: string;
}

export interface FailureGroupItem {
  key: string;
  failedStep: string | null;
  failureCategory: string;
  resolution: "retryable" | "manual" | "inspect";
  resolutionReason: string;
  count: number;
  latestRunId: string;
  latestBvid: string | null;
  latestVideoTitle: string | null;
  latestMessage: string | null;
  latestUpdatedAt: string;
}

export interface AttentionItem {
  kind: "scheduler-missing" | "scheduler-heartbeat" | "scheduler-status" | "stalled-run";
  severity: "warning" | "critical";
  title: string;
  message: string;
  runId: string | null;
  bvid: string | null;
  currentStage: string | null;
  status: string | null;
  updatedAt: string | null;
  staleForMs: number | null;
}

export interface DashboardHealthSnapshot {
  attentionCount: number;
  criticalCount: number;
  warningCount: number;
  staleRunningCount: number;
  schedulerHealthy: boolean;
  schedulerStatus: string;
  schedulerLastHeartbeatAt: string | null;
  schedulerHeartbeatAgeMs: number | null;
}

export interface RecoveryCandidateItem extends DashboardRunItem {
  staleForMs: number;
  lockExists: boolean;
  lockStale: boolean;
  lockPath: string;
  recoveryState: "missing-lock" | "orphaned-lock" | "stalled";
  recoveryReason: string;
  recommendedAction: "retry-now" | "cancel" | "inspect";
}

export function createDashboardService({
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
}: {
  dbPath?: string;
  workRoot?: string;
} = {}) {
  const db = openDatabase(dbPath);
  const pipelineQueryService = createPipelineQueryService({
    dbPath,
  });

  return {
    close() {
      pipelineQueryService.close?.();
      db.close?.();
    },
    getSummary(): DashboardSummary {
      return getDashboardSummary(db);
    },
    listActivePipelines(limit = 50): DashboardRunItem[] {
      return listActivePipelineRunStates(db, limit).map(mapRunStateToItem);
    },
    listRecentRuns({
      limit = 50,
      statuses = null,
    }: {
      limit?: number;
      statuses?: string[] | null;
    } = {}): DashboardRunItem[] {
      return pipelineQueryService.listRuns({
        limit,
        statuses,
      });
    },
    getPipelineDetail(bvid: string, {
      runLimit = 10,
      eventLimit = 100,
    }: {
      runLimit?: number;
      eventLimit?: number;
    } = {}): PipelineDetail {
      return pipelineQueryService.getPipelineDetail(bvid, {
        runLimit,
        eventLimit,
      });
    },
    listRecentEvents({
      bvid = null,
      sinceIso = null,
      limit = 100,
    }: {
      bvid?: string | null;
      sinceIso?: string | null;
      limit?: number;
    } = {}): PipelineEventItem[] {
      return pipelineQueryService.listEvents({
        bvid,
        sinceIso,
        limit,
      });
    },
    listEventsAfterId({
      afterId = 0,
      bvid = null,
      limit = 100,
    }: {
      afterId?: number;
      bvid?: string | null;
      limit?: number;
    } = {}) {
      return listEventsAfterId(db, {
        afterId,
        bvid,
        limit,
      });
    },
    listFailureQueue({
      limit = 50,
      resolutions = null,
      sinceHours = 168,
    }: {
      limit?: number;
      resolutions?: Array<FailureQueueItem["resolution"]> | null;
      sinceHours?: number;
    } = {}): FailureQueueItem[] {
      const recentFailedRuns = pipelineQueryService.listRuns({
        limit: Math.max(50, Math.max(1, Number(limit) || 50) * 4),
        statuses: ["failed"],
      })
        .filter((item) => isWithinRecentHours(item.updatedAt, sinceHours))
        .map((item) => mapRunStateToFailureItem(item));

      if (!resolutions || resolutions.length === 0) {
        return recentFailedRuns.slice(0, Math.max(1, Number(limit) || 50));
      }

      const allowedResolutions = new Set(resolutions);
      return recentFailedRuns
        .filter((item) => allowedResolutions.has(item.resolution))
        .slice(0, Math.max(1, Number(limit) || 50));
    },
    listFailureGroups({
      limit = 20,
      sinceHours = 168,
    }: {
      limit?: number;
      sinceHours?: number;
    } = {}): FailureGroupItem[] {
      const failedRuns = pipelineQueryService.listRuns({
        limit: 500,
        statuses: ["failed"],
      })
        .filter((item) => isWithinRecentHours(item.updatedAt, sinceHours))
        .map((item) => mapRunStateToFailureItem(item));

      const grouped = new Map<string, FailureGroupItem>();
      for (const item of failedRuns) {
        const existing = grouped.get(item.failureSignature);
        if (existing) {
          existing.count += 1;
          continue;
        }

        grouped.set(item.failureSignature, {
          key: item.failureSignature,
          failedStep: item.failedStep,
          failureCategory: item.failureCategory,
          resolution: item.resolution,
          resolutionReason: item.resolutionReason,
          count: 1,
          latestRunId: item.runId,
          latestBvid: item.bvid,
          latestVideoTitle: item.videoTitle,
          latestMessage: item.lastErrorMessage || item.lastMessage,
          latestUpdatedAt: item.updatedAt,
        });
      }

      return Array.from(grouped.values())
        .sort((left, right) => {
          if (right.count !== left.count) {
            return right.count - left.count;
          }

          return right.latestUpdatedAt.localeCompare(left.latestUpdatedAt);
        })
        .slice(0, Math.max(1, Number(limit) || 20));
    },
    listRecoveryCandidates({
      limit = 20,
      staleMs = 15 * 60 * 1000,
      states = null,
    }: {
      limit?: number;
      staleMs?: number;
      states?: Array<RecoveryCandidateItem["recoveryState"]> | null;
    } = {}): RecoveryCandidateItem[] {
      const candidates = listActivePipelineRunStates(db, Math.max(50, Math.max(1, Number(limit) || 20) * 4))
        .map(mapRunStateToItem)
        .map((item) => mapRunStateToRecoveryCandidate(item, {
          workRoot,
          staleMs,
        }))
        .filter((item): item is RecoveryCandidateItem => item !== null);

      if (!states || states.length === 0) {
        return candidates.slice(0, Math.max(1, Number(limit) || 20));
      }

      const allowedStates = new Set(states);
      return candidates
        .filter((item) => allowedStates.has(item.recoveryState))
        .slice(0, Math.max(1, Number(limit) || 20));
    },
    getOperationalHealth({
      schedulerKey = "main",
      heartbeatStaleMs = 90_000,
      runStaleMs = 15 * 60 * 1000,
      attentionLimit = 20,
    }: {
      schedulerKey?: string;
      heartbeatStaleMs?: number;
      runStaleMs?: number;
      attentionLimit?: number;
    } = {}) {
      const attentionItems = collectAttentionItems(db, {
        schedulerKey,
        heartbeatStaleMs,
        runStaleMs,
      }).slice(0, Math.max(1, Number(attentionLimit) || 20));
      const schedulerStatus = getSchedulerStatus(db, schedulerKey);
      const schedulerHeartbeatAgeMs = getAgeMs(schedulerStatus?.last_heartbeat_at ?? null);
      const criticalCount = attentionItems.filter((item) => item.severity === "critical").length;
      const warningCount = attentionItems.length - criticalCount;
      const staleRunningCount = attentionItems.filter((item) => item.kind === "stalled-run").length;
      const schedulerHealthy = isSchedulerHealthy(schedulerStatus, heartbeatStaleMs);

      return {
        snapshot: {
          attentionCount: attentionItems.length,
          criticalCount,
          warningCount,
          staleRunningCount,
          schedulerHealthy,
          schedulerStatus: schedulerStatus?.status ?? "unknown",
          schedulerLastHeartbeatAt: schedulerStatus?.last_heartbeat_at ?? null,
          schedulerHeartbeatAgeMs,
        } satisfies DashboardHealthSnapshot,
        items: attentionItems,
      };
    },
    getRunState(runId: string): DashboardRunItem | null {
      const state = getPipelineRunStateById(db, runId);
      return state ? mapRunStateToItem(state) : null;
    },
  };
}

function listEventsAfterId(
  db: Db,
  {
    afterId,
    bvid,
    limit,
  }: {
    afterId: number;
    bvid: string | null;
    limit: number;
  },
) {
  return db.prepare(`
    SELECT *
    FROM pipeline_events
    WHERE id > ?
      AND (? IS NULL OR bvid = ?)
    ORDER BY id ASC
    LIMIT ?
  `).all(
    Math.max(0, Number(afterId) || 0),
    bvid,
    bvid,
    Math.max(1, Number(limit) || 100),
  ).map((event: any) => ({
    id: event.id,
    runId: event.run_id,
    bvid: event.bvid,
    videoTitle: event.video_title,
    pageNo: event.page_no,
    cid: event.cid,
    partTitle: event.part_title,
    scope: event.scope,
    action: event.action,
    status: event.status,
    message: event.message,
    details: parseDetails(event.details_json),
    createdAt: event.created_at,
  }));
}

function getDashboardSummary(db: Db): DashboardSummary {
  const activeCount = Number(
    ((db.prepare("SELECT COUNT(*) AS count FROM pipeline_runs WHERE status = 'running'").get() as { count?: number } | undefined)?.count) ?? 0,
  );
  const succeededCount24h = Number(
    ((db.prepare(`
      SELECT COUNT(*) AS count
      FROM pipeline_runs
      WHERE status = 'succeeded'
        AND updated_at >= ?
    `).get(getRecentIsoHours(24)) as { count?: number } | undefined)?.count) ?? 0,
  );
  const failedCount24h = Number(
    ((db.prepare(`
      SELECT COUNT(*) AS count
      FROM pipeline_runs
      WHERE status = 'failed'
        AND updated_at >= ?
    `).get(getRecentIsoHours(24)) as { count?: number } | undefined)?.count) ?? 0,
  );
  const latestUpdatedAt = ((db.prepare("SELECT MAX(updated_at) AS updated_at FROM pipeline_run_state").get() as { updated_at?: string } | undefined)?.updated_at) ?? null;

  return {
    activeCount,
    failedCount24h,
    succeededCount24h,
    latestUpdatedAt,
  };
}

function mapRunStateToItem(state: PipelineRunStateRecord): DashboardRunItem {
  return {
    runId: state.run_id,
    bvid: state.bvid,
    videoTitle: state.video_title,
    triggerSource: state.trigger_source,
    runStatus: state.run_status,
    currentStage: state.current_stage,
    currentScope: state.current_scope,
    currentAction: state.current_action,
    currentStatus: state.current_status,
    currentPageNo: state.current_page_no,
    currentPartTitle: state.current_part_title,
    lastMessage: state.last_message,
    lastErrorMessage: state.last_error_message,
    failedStep: state.failed_step,
    startedAt: state.started_at,
    finishedAt: state.finished_at,
    updatedAt: state.updated_at,
    logPath: state.log_path,
    summaryPath: state.summary_path,
    pendingSummaryPath: state.pending_summary_path,
  };
}

function mapRunStateToFailureItem(item: DashboardRunItem): FailureQueueItem {
  const failure = classifyFailure(item);
  return {
    ...item,
    failureCategory: failure.failureCategory,
    resolution: failure.resolution,
    resolutionReason: failure.resolutionReason,
    failureSignature: failure.failureSignature,
  };
}

function mapRunStateToRecoveryCandidate(
  item: DashboardRunItem,
  {
    workRoot,
    staleMs,
  }: {
    workRoot: string;
    staleMs: number;
  },
): RecoveryCandidateItem | null {
  const staleForMs = getAgeMs(item.updatedAt);
  if (staleForMs === null || staleForMs <= staleMs) {
    return null;
  }

  const bvid = normalizeText(item.bvid);
  if (!bvid) {
    return null;
  }

  const lock = getVideoPipelineLockSnapshot({
    workRoot,
    bvid,
  });
  const recoveryState = !lock.exists
    ? "missing-lock"
    : lock.stale
      ? "orphaned-lock"
      : "stalled";
  const recoveryReason = recoveryState === "missing-lock"
    ? "Run state is still marked running but the pipeline lock is missing."
    : recoveryState === "orphaned-lock"
      ? "Run state is still marked running but the pipeline lock is stale."
      : "Run still holds a live lock but has stopped updating for too long.";
  const recommendedAction = recoveryState === "stalled"
    ? "cancel"
    : "retry-now";

  return {
    ...item,
    staleForMs,
    lockExists: lock.exists,
    lockStale: lock.stale,
    lockPath: lock.lockPath,
    recoveryState,
    recoveryReason,
    recommendedAction,
  };
}

function parseDetails(detailsJson: string | null | undefined): Record<string, unknown> | null {
  const normalized = String(detailsJson ?? "").trim();
  if (!normalized) {
    return null;
  }

  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function getRecentIsoHours(hours: number): string {
  return new Date(Date.now() - Math.max(1, Number(hours) || 24) * 3600 * 1000).toISOString();
}

function collectAttentionItems(
  db: Db,
  {
    schedulerKey,
    heartbeatStaleMs,
    runStaleMs,
  }: {
    schedulerKey: string;
    heartbeatStaleMs: number;
    runStaleMs: number;
  },
): AttentionItem[] {
  const items: AttentionItem[] = [];
  const scheduler = getSchedulerStatus(db, schedulerKey);
  const activeRuns = listActivePipelineRunStates(db, 200).map(mapRunStateToItem);

  if (!scheduler) {
    items.push({
      kind: "scheduler-missing",
      severity: "critical",
      title: "Scheduler status is missing",
      message: "No scheduler heartbeat record exists yet.",
      runId: null,
      bvid: null,
      currentStage: null,
      status: "unknown",
      updatedAt: null,
      staleForMs: null,
    });
  } else {
    const heartbeatAgeMs = getAgeMs(scheduler.last_heartbeat_at);
    if (scheduler.status !== "running") {
      items.push({
        kind: "scheduler-status",
        severity: "warning",
        title: "Scheduler is not running",
        message: `Scheduler status is ${scheduler.status}.`,
        runId: null,
        bvid: null,
        currentStage: null,
        status: scheduler.status,
        updatedAt: scheduler.updated_at,
        staleForMs: heartbeatAgeMs,
      });
    } else if (heartbeatAgeMs === null || heartbeatAgeMs > heartbeatStaleMs) {
      items.push({
        kind: "scheduler-heartbeat",
        severity: "critical",
        title: "Scheduler heartbeat is stale",
        message: heartbeatAgeMs === null
          ? "Scheduler heartbeat timestamp is missing."
          : `Scheduler heartbeat is ${formatDurationText(heartbeatAgeMs)} old.`,
        runId: null,
        bvid: null,
        currentStage: null,
        status: scheduler.status,
        updatedAt: scheduler.last_heartbeat_at ?? scheduler.updated_at,
        staleForMs: heartbeatAgeMs,
      });
    }
  }

  for (const run of activeRuns) {
    const staleForMs = getAgeMs(run.updatedAt);
    if (staleForMs === null || staleForMs <= runStaleMs) {
      continue;
    }

    items.push({
      kind: "stalled-run",
      severity: staleForMs > runStaleMs * 2 ? "critical" : "warning",
      title: "Pipeline appears stalled",
      message: `${run.videoTitle || run.bvid || run.runId} has not updated for ${formatDurationText(staleForMs)}.`,
      runId: run.runId,
      bvid: run.bvid,
      currentStage: run.currentStage,
      status: run.runStatus,
      updatedAt: run.updatedAt,
      staleForMs,
    });
  }

  return items.sort((left, right) => {
    const severityRank = left.severity === right.severity ? 0 : left.severity === "critical" ? -1 : 1;
    if (severityRank !== 0) {
      return severityRank;
    }

    return Number(right.staleForMs ?? 0) - Number(left.staleForMs ?? 0);
  });
}

function isWithinRecentHours(updatedAt: string, hours: number): boolean {
  return updatedAt >= getRecentIsoHours(hours);
}

function classifyFailure(item: DashboardRunItem): {
  failureCategory: string;
  resolution: FailureQueueItem["resolution"];
  resolutionReason: string;
  failureSignature: string;
} {
  const failedStep = normalizeText(item.failedStep) ?? "unknown";
  const message = normalizeText(item.lastErrorMessage) ?? normalizeText(item.lastMessage) ?? "unknown";
  const combined = `${failedStep}\n${message}`.toLowerCase();

  if (/(auth|token|cookie|login|credential|permission|forbidden|denied|风控|blocked)/iu.test(combined)) {
    return buildFailureClassification(item, "auth", "manual", "Authentication, permission, or platform risk-control issue.");
  }

  if (/(429|quota|rate limit|too many requests|timeout|timed out|network|socket|econn|reset by peer|temporar|503|502|504|fetch failed)/iu.test(combined)) {
    return buildFailureClassification(item, "transient", "retryable", "Transient upstream or network failure; retry is usually safe.");
  }

  if (/(missing|not found|404|deleted|no subtitle|empty subtitle|artifact)/iu.test(combined)) {
    return buildFailureClassification(item, "artifact", "inspect", "Required input or generated artifact is missing.");
  }

  if (failedStep.startsWith("summary")) {
    return buildFailureClassification(item, "summary", "retryable", "Summary generation failed and is usually worth retrying.");
  }

  if (failedStep.startsWith("subtitle")) {
    return buildFailureClassification(item, "subtitle", "retryable", "Subtitle acquisition or ASR failed and may recover on retry.");
  }

  if (failedStep.startsWith("publish")) {
    return buildFailureClassification(item, "publish", "inspect", "Publishing failed; inspect thread state before retrying.");
  }

  return buildFailureClassification(item, "pipeline", "inspect", "Failure needs operator inspection before the next action.");
}

function buildFailureClassification(
  item: DashboardRunItem,
  failureCategory: string,
  resolution: FailureQueueItem["resolution"],
  resolutionReason: string,
) {
  const failedStep = normalizeText(item.failedStep) ?? "unknown";
  const normalizedMessage = normalizeFailureMessage(item.lastErrorMessage || item.lastMessage);

  return {
    failureCategory,
    resolution,
    resolutionReason,
    failureSignature: `${failureCategory}:${failedStep}:${normalizedMessage}`,
  };
}

function normalizeFailureMessage(value: string | null | undefined): string {
  const normalized = String(value ?? "")
    .toLowerCase()
    .replace(/bv[0-9a-z]+/giu, "<bvid>")
    .replace(/https?:\/\/\S+/giu, "<url>")
    .replace(/[0-9]{3,}/gu, "<n>")
    .replace(/[\\/][^\\/\s]+/gu, "<path>")
    .replace(/\s+/gu, " ")
    .trim();

  return normalized.slice(0, 80) || "unknown";
}

function normalizeText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function getAgeMs(value: string | null | undefined): number | null {
  const normalized = normalizeText(value);
  if (!normalized) {
    return null;
  }

  const timestamp = new Date(normalized).getTime();
  if (Number.isNaN(timestamp)) {
    return null;
  }

  return Math.max(0, Date.now() - timestamp);
}

function isSchedulerHealthy(row: SchedulerStatusRecord | null, heartbeatStaleMs: number): boolean {
  if (!row || row.status !== "running") {
    return false;
  }

  const ageMs = getAgeMs(row.last_heartbeat_at);
  return ageMs !== null && ageMs <= heartbeatStaleMs;
}

function formatDurationText(valueMs: number): string {
  if (valueMs < 1000) {
    return `${valueMs} ms`;
  }

  const seconds = valueMs / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)} s`;
  }

  const minutes = seconds / 60;
  if (minutes < 60) {
    return `${minutes.toFixed(1)} min`;
  }

  const hours = minutes / 60;
  return `${hours.toFixed(1)} h`;
}
