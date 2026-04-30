import type {
  Db,
  PipelineEventInput,
  PipelineEventRecord,
  PipelineRunRecord,
  PipelineRunStateRecord,
} from "./types";

export function syncPipelineRunReadModels(db: Db) {
  const latestEventId = Number(
    ((db.prepare("SELECT MAX(latest_event_id) AS latest_event_id FROM pipeline_run_state").get() as { latest_event_id?: number } | undefined)
      ?.latest_event_id) ?? 0,
  );
  const pendingEvents = db.prepare(`
    SELECT *
    FROM pipeline_events
    WHERE id > ?
    ORDER BY id ASC
  `).all(latestEventId) as unknown as PipelineEventRecord[];
  const runCache = new Map<string, PipelineRunRecord>();
  const stateCache = new Map<string, PipelineRunStateRecord>();

  if (pendingEvents.length <= 0) {
    return;
  }

  db.exec("BEGIN");
  try {
    for (const event of pendingEvents) {
      applyPipelineRunStateMutation(db, event, null, {
        runCache,
        stateCache,
      });
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function upsertPipelineRunStateFromEvent(
  db: Db,
  eventRecord: PipelineEventRecord,
  eventInput: PipelineEventInput | null,
): PipelineRunStateRecord | null {
  return applyPipelineRunStateMutation(db, eventRecord, eventInput);
}

function applyPipelineRunStateMutation(
  db: Db,
  eventRecord: PipelineEventRecord,
  eventInput: PipelineEventInput | null,
  cache: {
    runCache?: Map<string, PipelineRunRecord>;
    stateCache?: Map<string, PipelineRunStateRecord>;
  } = {},
): PipelineRunStateRecord | null {
  const runId = normalizeText(eventRecord.run_id ?? eventInput?.runId);
  if (!runId) {
    return null;
  }

  const details = parseDetails(eventRecord.details_json);
  const existingRun = cache.runCache?.get(runId) ?? getPipelineRunById(db, runId);
  const existingState = cache.stateCache?.get(runId) ?? getPipelineRunStateById(db, runId);
  const createdAt = normalizeText(eventRecord.created_at) ?? new Date().toISOString();
  const nextTriggerSource = normalizeText(eventInput?.triggerSource) ?? existingState?.trigger_source ?? existingRun?.trigger_source ?? "cli";
  const nextRunStatus = deriveRunStatus(existingRun?.status, eventRecord);
  const nextStartedAt = existingRun?.started_at ?? existingState?.started_at ?? createdAt;
  const nextFinishedAt = isTerminalRunEvent(eventRecord) ? createdAt : existingRun?.finished_at ?? existingState?.finished_at ?? null;
  const nextStage = deriveStageLabel(eventRecord);
  const nextLogPath = normalizeText(details?.logPath) ?? existingState?.log_path ?? null;
  const nextSummaryPath = normalizeText(details?.summaryPath) ?? existingState?.summary_path ?? null;
  const nextPendingSummaryPath = normalizeText(details?.pendingSummaryPath) ?? existingState?.pending_summary_path ?? null;
  const nextFailedScope = normalizeText(details?.failedScope) ?? (eventRecord.status === "failed" ? normalizeText(eventRecord.scope) : existingState?.failed_scope) ?? null;
  const nextFailedAction = normalizeText(details?.failedAction) ?? (eventRecord.status === "failed" ? normalizeText(eventRecord.action) : existingState?.failed_action) ?? null;
  const nextFailedStep = normalizeText(details?.failedStep) ?? buildFailedStep(nextFailedScope, nextFailedAction) ?? existingState?.failed_step ?? null;
  const nextLastErrorMessage = eventRecord.status === "failed"
    ? normalizeText(eventRecord.message) ?? existingState?.last_error_message ?? null
    : existingState?.last_error_message ?? null;

  db.prepare(`
    INSERT INTO pipeline_runs (
      run_id,
      video_id,
      bvid,
      video_title,
      trigger_source,
      status,
      started_at,
      finished_at,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      video_id = COALESCE(excluded.video_id, pipeline_runs.video_id),
      bvid = COALESCE(excluded.bvid, pipeline_runs.bvid),
      video_title = COALESCE(excluded.video_title, pipeline_runs.video_title),
      trigger_source = COALESCE(excluded.trigger_source, pipeline_runs.trigger_source),
      status = excluded.status,
      started_at = COALESCE(pipeline_runs.started_at, excluded.started_at),
      finished_at = excluded.finished_at,
      updated_at = excluded.updated_at
  `).run(
    runId,
    normalizeInteger(eventRecord.video_id),
    normalizeText(eventRecord.bvid),
    normalizeText(eventRecord.video_title),
    nextTriggerSource,
    nextRunStatus,
    nextStartedAt,
    nextFinishedAt,
    existingRun?.created_at ?? createdAt,
    createdAt,
  );

  db.prepare(`
    INSERT INTO pipeline_run_state (
      run_id,
      latest_event_id,
      video_id,
      bvid,
      video_title,
      trigger_source,
      run_status,
      current_scope,
      current_action,
      current_status,
      current_stage,
      current_page_no,
      current_cid,
      current_part_title,
      last_message,
      last_error_message,
      failed_scope,
      failed_action,
      failed_step,
      log_path,
      summary_path,
      pending_summary_path,
      started_at,
      finished_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(run_id) DO UPDATE SET
      latest_event_id = excluded.latest_event_id,
      video_id = COALESCE(excluded.video_id, pipeline_run_state.video_id),
      bvid = COALESCE(excluded.bvid, pipeline_run_state.bvid),
      video_title = COALESCE(excluded.video_title, pipeline_run_state.video_title),
      trigger_source = COALESCE(excluded.trigger_source, pipeline_run_state.trigger_source),
      run_status = excluded.run_status,
      current_scope = excluded.current_scope,
      current_action = excluded.current_action,
      current_status = excluded.current_status,
      current_stage = excluded.current_stage,
      current_page_no = COALESCE(excluded.current_page_no, pipeline_run_state.current_page_no),
      current_cid = COALESCE(excluded.current_cid, pipeline_run_state.current_cid),
      current_part_title = COALESCE(excluded.current_part_title, pipeline_run_state.current_part_title),
      last_message = excluded.last_message,
      last_error_message = COALESCE(excluded.last_error_message, pipeline_run_state.last_error_message),
      failed_scope = COALESCE(excluded.failed_scope, pipeline_run_state.failed_scope),
      failed_action = COALESCE(excluded.failed_action, pipeline_run_state.failed_action),
      failed_step = COALESCE(excluded.failed_step, pipeline_run_state.failed_step),
      log_path = COALESCE(excluded.log_path, pipeline_run_state.log_path),
      summary_path = COALESCE(excluded.summary_path, pipeline_run_state.summary_path),
      pending_summary_path = COALESCE(excluded.pending_summary_path, pipeline_run_state.pending_summary_path),
      started_at = COALESCE(pipeline_run_state.started_at, excluded.started_at),
      finished_at = excluded.finished_at,
      updated_at = excluded.updated_at
  `).run(
    runId,
    eventRecord.id,
    normalizeInteger(eventRecord.video_id),
    normalizeText(eventRecord.bvid),
    normalizeText(eventRecord.video_title),
    nextTriggerSource,
    nextRunStatus,
    normalizeText(eventRecord.scope),
    normalizeText(eventRecord.action),
    normalizeText(eventRecord.status),
    nextStage,
    normalizeInteger(eventRecord.page_no),
    normalizeInteger(eventRecord.cid),
    normalizeText(eventRecord.part_title),
    normalizeText(eventRecord.message),
    nextLastErrorMessage,
    nextFailedScope,
    nextFailedAction,
    nextFailedStep,
    nextLogPath,
    nextSummaryPath,
    nextPendingSummaryPath,
    nextStartedAt,
    nextFinishedAt,
    createdAt,
  );

  const nextRun: PipelineRunRecord = {
    run_id: runId,
    video_id: normalizeInteger(eventRecord.video_id) ?? existingRun?.video_id ?? existingState?.video_id ?? null,
    bvid: normalizeText(eventRecord.bvid) ?? existingRun?.bvid ?? existingState?.bvid ?? null,
    video_title: normalizeText(eventRecord.video_title) ?? existingRun?.video_title ?? existingState?.video_title ?? null,
    trigger_source: nextTriggerSource,
    status: nextRunStatus,
    started_at: nextStartedAt,
    finished_at: nextFinishedAt,
    created_at: existingRun?.created_at ?? createdAt,
    updated_at: createdAt,
  };
  const nextState: PipelineRunStateRecord = {
    run_id: runId,
    latest_event_id: eventRecord.id,
    video_id: normalizeInteger(eventRecord.video_id) ?? existingState?.video_id ?? existingRun?.video_id ?? null,
    bvid: normalizeText(eventRecord.bvid) ?? existingState?.bvid ?? existingRun?.bvid ?? null,
    video_title: normalizeText(eventRecord.video_title) ?? existingState?.video_title ?? existingRun?.video_title ?? null,
    trigger_source: nextTriggerSource,
    run_status: nextRunStatus,
    current_scope: normalizeText(eventRecord.scope),
    current_action: normalizeText(eventRecord.action),
    current_status: normalizeText(eventRecord.status),
    current_stage: nextStage,
    current_page_no: normalizeInteger(eventRecord.page_no) ?? existingState?.current_page_no ?? null,
    current_cid: normalizeInteger(eventRecord.cid) ?? existingState?.current_cid ?? null,
    current_part_title: normalizeText(eventRecord.part_title) ?? existingState?.current_part_title ?? null,
    last_message: normalizeText(eventRecord.message),
    last_error_message: nextLastErrorMessage,
    failed_scope: nextFailedScope,
    failed_action: nextFailedAction,
    failed_step: nextFailedStep,
    log_path: nextLogPath,
    summary_path: nextSummaryPath,
    pending_summary_path: nextPendingSummaryPath,
    started_at: nextStartedAt,
    finished_at: nextFinishedAt,
    updated_at: createdAt,
  };

  if (cache.runCache) {
    cache.runCache.set(runId, nextRun);
  }
  if (cache.stateCache) {
    cache.stateCache.set(runId, nextState);
  }

  return nextState;
}

export function getPipelineRunById(db: Db, runId: string): PipelineRunRecord | null {
  return (db.prepare("SELECT * FROM pipeline_runs WHERE run_id = ?").get(runId) as unknown as PipelineRunRecord | undefined) ?? null;
}

export function getPipelineRunStateById(db: Db, runId: string): PipelineRunStateRecord | null {
  return (db.prepare("SELECT * FROM pipeline_run_state WHERE run_id = ?").get(runId) as unknown as PipelineRunStateRecord | undefined) ?? null;
}

export function listActivePipelineRunStates(db: Db, limit = 50): PipelineRunStateRecord[] {
  return db.prepare(`
    SELECT state.*
    FROM pipeline_run_state state
    JOIN pipeline_runs runs ON runs.run_id = state.run_id
    WHERE runs.status = 'running'
    ORDER BY state.updated_at DESC, state.latest_event_id DESC
    LIMIT ?
  `).all(Math.max(1, Number(limit) || 50)) as unknown as PipelineRunStateRecord[];
}

export function listRecentPipelineRunStates(
  db: Db,
  {
    limit = 50,
    statuses = null,
  }: {
    limit?: number;
    statuses?: string[] | null;
  } = {},
): PipelineRunStateRecord[] {
  const safeStatuses = Array.isArray(statuses)
    ? [...new Set(statuses.map((item) => normalizeText(item)).filter(Boolean))]
    : [];
  const query = safeStatuses.length > 0
    ? `
      SELECT state.*
      FROM pipeline_run_state state
      JOIN pipeline_runs runs ON runs.run_id = state.run_id
      WHERE runs.status IN (${safeStatuses.map(() => "?").join(", ")})
      ORDER BY state.updated_at DESC, state.latest_event_id DESC
      LIMIT ?
    `
    : `
      SELECT state.*
      FROM pipeline_run_state state
      ORDER BY state.updated_at DESC, state.latest_event_id DESC
      LIMIT ?
    `;
  const params = safeStatuses.length > 0
    ? [...safeStatuses, Math.max(1, Number(limit) || 50)]
    : [Math.max(1, Number(limit) || 50)];

  return db.prepare(query).all(...params) as unknown as PipelineRunStateRecord[];
}

function deriveRunStatus(previousStatus: string | null | undefined, eventRecord: PipelineEventRecord): string {
  if (isRunStartedEvent(eventRecord)) {
    return "running";
  }

  if (isRunSucceededEvent(eventRecord)) {
    return "succeeded";
  }

  if (isRunFailedEvent(eventRecord)) {
    return "failed";
  }

  return previousStatus ?? "running";
}

function isRunStartedEvent(eventRecord: Pick<PipelineEventRecord, "scope" | "action" | "status">): boolean {
  return eventRecord.scope === "pipeline" && eventRecord.action === "run" && eventRecord.status === "started";
}

function isRunSucceededEvent(eventRecord: Pick<PipelineEventRecord, "scope" | "action" | "status">): boolean {
  return eventRecord.scope === "pipeline" && eventRecord.action === "run" && eventRecord.status === "succeeded";
}

function isRunFailedEvent(eventRecord: Pick<PipelineEventRecord, "scope" | "action" | "status">): boolean {
  return eventRecord.scope === "pipeline" && eventRecord.action === "run" && eventRecord.status === "failed";
}

function isTerminalRunEvent(eventRecord: Pick<PipelineEventRecord, "scope" | "action" | "status">): boolean {
  return isRunSucceededEvent(eventRecord) || isRunFailedEvent(eventRecord);
}

function deriveStageLabel(eventRecord: Pick<PipelineEventRecord, "scope" | "action" | "status">): string {
  if (eventRecord.scope === "pipeline" && eventRecord.action === "run") {
    if (eventRecord.status === "started") {
      return "pipeline-start";
    }

    if (eventRecord.status === "succeeded") {
      return "pipeline-complete";
    }

    if (eventRecord.status === "failed") {
      return "pipeline-failed";
    }
  }

  if (eventRecord.scope === "pipeline" && eventRecord.action === "generation") {
    return "generation";
  }

  if (eventRecord.scope === "pipeline" && eventRecord.action === "artifacts") {
    return "artifacts";
  }

  if (eventRecord.scope === "subtitle" && eventRecord.action === "queue") {
    return "subtitle-queue";
  }

  if (eventRecord.scope === "subtitle" && eventRecord.action === "asr") {
    return "subtitle-asr";
  }

  if (eventRecord.scope === "subtitle" && eventRecord.action === "finalize") {
    return "subtitle-finalize";
  }

  if (eventRecord.scope === "summary" && (eventRecord.action === "llm" || eventRecord.action === "llm-fallback")) {
    return "summary-llm";
  }

  if (eventRecord.scope === "summary" && eventRecord.action === "reuse") {
    return "summary-reuse";
  }

  if (eventRecord.scope === "publish" && eventRecord.action === "comment-thread") {
    return "publish";
  }

  if (eventRecord.scope === "publish" && eventRecord.action === "comment-thread-healthcheck") {
    return "publish-healthcheck";
  }

  return `${eventRecord.scope}/${eventRecord.action}`;
}

function buildFailedStep(scope: string | null, action: string | null): string | null {
  if (!scope && !action) {
    return null;
  }

  if (scope && action) {
    return `${scope}/${action}`;
  }

  return scope || action;
}

function parseDetails(detailsJson: string | null | undefined): Record<string, unknown> | null {
  const normalized = normalizeText(detailsJson);
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

function normalizeInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) ? normalized : null;
}
