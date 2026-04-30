import {
  getPipelineRunStateById,
  listActivePipelineRunStates,
  listPipelineEvents,
  listRecentPipelineRunStates,
  listVideoParts,
  listVideos,
  openDatabase,
} from "../../../../scripts/lib/db/index";
import type { Db, PipelineRunStateRecord, VideoPartRecord, VideoRecord } from "../../../../scripts/lib/db/index";

export interface DashboardSummary {
  activeCount: number;
  failedCount24h: number;
  succeededCount24h: number;
  latestUpdatedAt: string | null;
}

export interface DashboardRunItem {
  runId: string;
  bvid: string | null;
  videoTitle: string | null;
  triggerSource: string | null;
  runStatus: string;
  currentStage: string | null;
  currentScope: string | null;
  currentAction: string | null;
  currentStatus: string | null;
  currentPageNo: number | null;
  currentPartTitle: string | null;
  lastMessage: string | null;
  lastErrorMessage: string | null;
  failedStep: string | null;
  startedAt: string;
  finishedAt: string | null;
  updatedAt: string;
  logPath: string | null;
  summaryPath: string | null;
  pendingSummaryPath: string | null;
}

export interface PipelineDetail {
  video: VideoRecord | null;
  parts: VideoPartRecord[];
  latestRun: DashboardRunItem | null;
  recentRuns: DashboardRunItem[];
  recentEvents: Array<Record<string, unknown>>;
}

export function createDashboardService({
  dbPath = "work/pipeline.sqlite3",
}: {
  dbPath?: string;
} = {}) {
  const db = openDatabase(dbPath);

  return {
    close() {
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
      return listRecentPipelineRunStates(db, { limit, statuses }).map(mapRunStateToItem);
    },
    getPipelineDetail(bvid: string, {
      runLimit = 10,
      eventLimit = 100,
    }: {
      runLimit?: number;
      eventLimit?: number;
    } = {}): PipelineDetail {
      return getPipelineDetail(db, bvid, {
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
    } = {}) {
      return listPipelineEvents(db, { bvid, sinceIso, limit }).map((event) => ({
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

function getPipelineDetail(
  db: Db,
  bvid: string,
  {
    runLimit,
    eventLimit,
  }: {
    runLimit: number;
    eventLimit: number;
  },
): PipelineDetail {
  const videos = listVideos(db);
  const video = videos.find((item) => item.bvid === bvid) ?? null;
  const parts = video ? listVideoParts(db, video.id) : [];
  const recentRuns = listRecentPipelineRunStates(db, { limit: Math.max(1, runLimit * 4) })
    .filter((item) => item.bvid === bvid)
    .slice(0, Math.max(1, runLimit))
    .map(mapRunStateToItem);
  const recentEvents = listPipelineEvents(db, {
    bvid,
    limit: Math.max(1, eventLimit),
  }).map((event) => ({
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

  return {
    video,
    parts,
    latestRun: recentRuns[0] ?? null,
    recentRuns,
    recentEvents,
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
