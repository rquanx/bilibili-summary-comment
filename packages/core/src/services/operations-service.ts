import {
  getVideoByIdentity,
  insertOperationAudit,
  listOperationAudits,
  markVideoPublishRebuildNeeded,
  openDatabase,
  updateOperationAudit,
} from "../../../../scripts/lib/db/index";
import { createPipelineService } from "./pipeline-service";
import { createPublishService } from "./publish-service";
import { createSchedulerControlService } from "./scheduler-control-service";

export function createOperationsService({
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
}: {
  dbPath?: string;
  workRoot?: string;
} = {}) {
  const db = openDatabase(dbPath);
  const pipelineService = createPipelineService({
    dbPath,
    workRoot,
  });
  const publishService = createPublishService({
    dbPath,
    workRoot,
  });
  const schedulerControlService = createSchedulerControlService({
    dbPath,
    workRoot,
  });

  return {
    close() {
      db.close?.();
    },
    listAudits({
      bvid = null,
      limit = 50,
    }: {
      bvid?: string | null;
      limit?: number;
    } = {}) {
      return listOperationAudits(db, { bvid, limit }).map(mapAuditRecord);
    },
    async runSummarySweep({
      summaryUsers,
      authFile,
    }: {
      summaryUsers?: unknown;
      authFile?: string;
    } = {}) {
      return executeAuditedOperation(db, {
        action: "summary-sweep",
        scope: "scheduler",
        request: {
          summaryUsers: normalizeText(summaryUsers),
          authFile: normalizeText(authFile),
        },
        run() {
          return schedulerControlService.runSummarySweep({
            summaryUsers,
            authFile,
            triggerSource: "web",
          });
        },
      });
    },
    async runPublishSweep({
      summaryUsers,
      authFile,
      confirm = false,
    }: {
      summaryUsers?: unknown;
      authFile?: string;
      confirm?: boolean;
    } = {}) {
      ensureConfirmed(confirm, "publish sweep");
      return executeAuditedOperation(db, {
        action: "publish-sweep",
        scope: "scheduler",
        request: {
          summaryUsers: normalizeText(summaryUsers),
          authFile: normalizeText(authFile),
          confirm: true,
        },
        run() {
          ensureConfirmed(confirm, "publish sweep");
          return publishService.runPendingSweep({
            summaryUsers,
            authFile,
            triggerSource: "web",
          });
        },
      });
    },
    async retryPipeline({
      bvid,
      publish = true,
      forceSummary = false,
    }: {
      bvid: string;
      publish?: boolean;
      forceSummary?: boolean;
    }) {
      return executeAuditedOperation(db, {
        action: "pipeline-retry",
        scope: "pipeline",
        bvid,
        request: {
          bvid,
          publish: Boolean(publish),
          forceSummary: Boolean(forceSummary),
        },
        run() {
          return pipelineService.runPipeline({
            bvid,
            publish,
            forceSummary,
            triggerSource: "web",
          });
        },
      });
    },
    async publishPipeline({
      bvid,
      confirm = false,
    }: {
      bvid: string;
      confirm?: boolean;
    }) {
      return executeAuditedOperation(db, {
        action: "pipeline-publish",
        scope: "pipeline",
        bvid,
        request: {
          bvid,
          confirm: true,
        },
        run() {
          ensureConfirmed(confirm, "single pipeline publish");
          return pipelineService.runPipeline({
            bvid,
            publish: true,
            triggerSource: "web",
          });
        },
      });
    },
    async rebuildPublishThread({
      bvid,
      confirm = false,
      reason = "manual-web-rebuild",
    }: {
      bvid: string;
      confirm?: boolean;
      reason?: string;
    }) {
      return executeAuditedOperation(db, {
        action: "rebuild-publish-thread",
        scope: "publish",
        bvid,
        request: {
          bvid,
          confirm: true,
          reason,
        },
        run() {
          ensureConfirmed(confirm, "publish thread rebuild");
          const video = getVideoByIdentity(db, { bvid, aid: null });
          if (!video) {
            throw new Error(`Unknown bvid: ${bvid}`);
          }

          markVideoPublishRebuildNeeded(db, video.id, reason);
          return {
            ok: true,
            bvid,
            marked: true,
            reason,
          };
        },
      });
    },
  };
}

async function executeAuditedOperation(
  db: ReturnType<typeof openDatabase>,
  {
    action,
    scope,
    bvid = null,
    request = null,
    run,
  }: {
    action: string;
    scope: string;
    bvid?: string | null;
    request?: unknown;
    run: () => Promise<unknown> | unknown;
  },
) {
  const audit = insertOperationAudit(db, {
    action,
    scope,
    triggerSource: "web",
    bvid,
    request,
    status: "started",
  });

  try {
    const result = await run();
    const inferredRunId = inferRunId(result);
    updateOperationAudit(db, audit.id, {
      status: "succeeded",
      runId: inferredRunId,
      result,
    });

    return {
      ok: true,
      auditId: audit.id,
      action,
      scope,
      bvid,
      runId: inferredRunId,
      result,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    updateOperationAudit(db, audit.id, {
      status: "failed",
      errorMessage,
      result: {
        errorMessage,
      },
    });

    return {
      ok: false,
      auditId: audit.id,
      action,
      scope,
      bvid,
      errorMessage,
    };
  }
}

function mapAuditRecord(record: {
  id: number;
  action: string;
  scope: string;
  trigger_source: string;
  bvid: string | null;
  run_id: string | null;
  request_json: string | null;
  status: string;
  result_json: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
}) {
  return {
    id: record.id,
    action: record.action,
    scope: record.scope,
    triggerSource: record.trigger_source,
    bvid: record.bvid,
    runId: record.run_id,
    request: parseJson(record.request_json),
    status: record.status,
    result: parseJson(record.result_json),
    errorMessage: record.error_message,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function inferRunId(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const candidate = result as { runId?: unknown; result?: { runId?: unknown } };
  const directRunId = normalizeText(candidate.runId);
  if (directRunId) {
    return directRunId;
  }

  return normalizeText(candidate.result?.runId);
}

function parseJson(value: string | null): unknown {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }

  try {
    return JSON.parse(normalized);
  } catch {
    return normalized;
  }
}

function ensureConfirmed(confirm: boolean, label: string) {
  if (confirm) {
    return;
  }

  throw new Error(`Confirmation required for ${label}`);
}

function normalizeText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}
