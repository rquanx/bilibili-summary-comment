import {
  listVideoParts,
  listVideos,
  openDatabase,
} from "../../../../scripts/lib/db/index";
import type {
  Db,
  PipelineRunStateRecord,
  VideoPartRecord,
  VideoRecord,
} from "../../../../scripts/lib/db/index";

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

export interface PipelineEventItem {
  id: number;
  runId: string | null;
  bvid: string | null;
  videoTitle: string | null;
  pageNo: number | null;
  cid: number | null;
  partTitle: string | null;
  scope: string;
  action: string;
  status: string;
  message: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface PipelineDetail {
  video: VideoRecord | null;
  parts: VideoPartRecord[];
  latestRun: DashboardRunItem | null;
  recentRuns: DashboardRunItem[];
  recentEvents: PipelineEventItem[];
}

export function createPipelineQueryService({
  dbPath = "work/pipeline.sqlite3",
}: {
  dbPath?: string;
} = {}) {
  const db = openDatabase(dbPath);

  return {
    close() {
      db.close?.();
    },
    listRuns({
      limit = 50,
      offset = 0,
      statuses = null,
      bvid = null,
    }: {
      limit?: number;
      offset?: number;
      statuses?: string[] | null;
      bvid?: string | null;
    } = {}): DashboardRunItem[] {
      return listRuns(db, {
        limit,
        offset,
        statuses,
        bvid,
      });
    },
    countRuns({
      statuses = null,
      bvid = null,
    }: {
      statuses?: string[] | null;
      bvid?: string | null;
    } = {}): number {
      return countRuns(db, {
        statuses,
        bvid,
      });
    },
    listEvents({
      bvid = null,
      sinceIso = null,
      limit = 100,
      offset = 0,
    }: {
      bvid?: string | null;
      sinceIso?: string | null;
      limit?: number;
      offset?: number;
    } = {}): PipelineEventItem[] {
      return listEvents(db, {
        bvid,
        sinceIso,
        limit,
        offset,
      });
    },
    countEvents({
      bvid = null,
      sinceIso = null,
    }: {
      bvid?: string | null;
      sinceIso?: string | null;
    } = {}): number {
      return countEvents(db, {
        bvid,
        sinceIso,
      });
    },
    getPipelineDetail(bvid: string, {
      runLimit = 10,
      eventLimit = 100,
    }: {
      runLimit?: number;
      eventLimit?: number;
    } = {}): PipelineDetail {
      const video = findVideoByBvid(db, bvid);
      const parts = video ? listVideoParts(db, video.id) : [];
      const recentRuns = listRuns(db, {
        bvid,
        limit: runLimit,
        offset: 0,
        statuses: null,
      });
      const recentEvents = listEvents(db, {
        bvid,
        limit: eventLimit,
        offset: 0,
        sinceIso: null,
      });

      return {
        video,
        parts,
        latestRun: recentRuns[0] ?? null,
        recentRuns,
        recentEvents,
      };
    },
  };
}

function listRuns(
  db: Db,
  {
    limit,
    offset,
    statuses,
    bvid,
  }: {
    limit: number;
    offset: number;
    statuses: string[] | null;
    bvid: string | null;
  },
): DashboardRunItem[] {
  const { whereClause, params } = buildRunFilter({
    statuses,
    bvid,
  });

  return db.prepare(`
    SELECT state.*
    FROM pipeline_run_state state
    JOIN pipeline_runs runs ON runs.run_id = state.run_id
    ${whereClause}
    ORDER BY state.updated_at DESC, state.latest_event_id DESC
    LIMIT ?
    OFFSET ?
  `).all(
    ...params,
    normalizeLimit(limit, 50, 200),
    normalizeOffset(offset),
  ).map((row: any) => mapRunStateToItem(row as PipelineRunStateRecord));
}

function countRuns(
  db: Db,
  {
    statuses,
    bvid,
  }: {
    statuses: string[] | null;
    bvid: string | null;
  },
): number {
  const { whereClause, params } = buildRunFilter({
    statuses,
    bvid,
  });

  return Number(
    ((db.prepare(`
      SELECT COUNT(*) AS count
      FROM pipeline_run_state state
      JOIN pipeline_runs runs ON runs.run_id = state.run_id
      ${whereClause}
    `).get(...params) as { count?: number } | undefined)?.count) ?? 0,
  );
}

function buildRunFilter({
  statuses,
  bvid,
}: {
  statuses: string[] | null;
  bvid: string | null;
}) {
  const clauses: string[] = [];
  const params: Array<string> = [];
  const safeStatuses = Array.isArray(statuses)
    ? [...new Set(statuses.map((item) => normalizeText(item)).filter((item): item is string => Boolean(item)))]
    : [];
  const safeBvid = normalizeText(bvid);

  if (safeStatuses.length > 0) {
    clauses.push(`runs.status IN (${safeStatuses.map(() => "?").join(", ")})`);
    params.push(...safeStatuses);
  }

  if (safeBvid) {
    clauses.push("state.bvid = ?");
    params.push(safeBvid);
  }

  return {
    whereClause: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "",
    params,
  };
}

function listEvents(
  db: Db,
  {
    bvid,
    sinceIso,
    limit,
    offset,
  }: {
    bvid: string | null;
    sinceIso: string | null;
    limit: number;
    offset: number;
  },
): PipelineEventItem[] {
  return db.prepare(`
    SELECT *
    FROM pipeline_events
    WHERE (? IS NULL OR bvid = ?)
      AND (? IS NULL OR created_at >= ?)
    ORDER BY created_at DESC, id DESC
    LIMIT ?
    OFFSET ?
  `).all(
    normalizeText(bvid),
    normalizeText(bvid),
    normalizeText(sinceIso),
    normalizeText(sinceIso),
    normalizeLimit(limit, 100, 500),
    normalizeOffset(offset),
  ).map((row: any) => mapPipelineEvent(row));
}

function countEvents(
  db: Db,
  {
    bvid,
    sinceIso,
  }: {
    bvid: string | null;
    sinceIso: string | null;
  },
): number {
  return Number(
    ((db.prepare(`
      SELECT COUNT(*) AS count
      FROM pipeline_events
      WHERE (? IS NULL OR bvid = ?)
        AND (? IS NULL OR created_at >= ?)
    `).get(
      normalizeText(bvid),
      normalizeText(bvid),
      normalizeText(sinceIso),
      normalizeText(sinceIso),
    ) as { count?: number } | undefined)?.count) ?? 0,
  );
}

function findVideoByBvid(db: Db, bvid: string): VideoRecord | null {
  const safeBvid = normalizeText(bvid);
  if (!safeBvid) {
    return null;
  }

  const videos = listVideos(db);
  return videos.find((item) => item.bvid === safeBvid) ?? null;
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

function mapPipelineEvent(event: {
  id: number;
  run_id: string | null;
  bvid: string | null;
  video_title: string | null;
  page_no: number | null;
  cid: number | null;
  part_title: string | null;
  scope: string;
  action: string;
  status: string;
  message: string | null;
  details_json: string | null;
  created_at: string;
}): PipelineEventItem {
  return {
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

function normalizeText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizeLimit(value: number, fallback: number, max: number): number {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return fallback;
  }

  return Math.min(max, Math.max(1, Math.trunc(normalized)));
}

function normalizeOffset(value: number): number {
  const normalized = Number(value);
  if (!Number.isFinite(normalized)) {
    return 0;
  }

  return Math.max(0, Math.trunc(normalized));
}
