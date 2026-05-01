import {
  getActivePipelineRunStateByBvid,
  getVideoByIdentity,
  insertPipelineEvent,
  insertOperationAudit,
  listOperationAudits,
  markVideoPublishRebuildNeeded,
  openDatabase,
  updateOperationAudit,
} from "../../../../scripts/lib/db/index";
import { terminateVideoPipelineLockOwner } from "../../../../scripts/lib/video/pipeline-lock";
import { createDashboardService } from "./dashboard-service";
import { createPipelineService } from "./pipeline-service";
import { createPublishService } from "./publish-service";
import { createSchedulerControlService } from "./scheduler-control-service";

export function createOperationsService({
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
  triggerSource = "web",
  services = {},
  runtime = {},
}: {
  dbPath?: string;
  workRoot?: string;
  triggerSource?: string;
  services?: {
    dashboardService?: ReturnType<typeof createDashboardService>;
    pipelineService?: ReturnType<typeof createPipelineService>;
    publishService?: ReturnType<typeof createPublishService>;
    schedulerControlService?: ReturnType<typeof createSchedulerControlService>;
  };
  runtime?: {
    terminateVideoPipelineLockOwner?: typeof terminateVideoPipelineLockOwner;
  };
} = {}) {
  const db = openDatabase(dbPath);
  const dashboardService = services.dashboardService ?? createDashboardService({
    dbPath,
  });
  const pipelineService = services.pipelineService ?? createPipelineService({
    dbPath,
    workRoot,
  });
  const publishService = services.publishService ?? createPublishService({
    dbPath,
    workRoot,
  });
  const schedulerControlService = services.schedulerControlService ?? createSchedulerControlService({
    dbPath,
    workRoot,
  });
  const terminatePipelineOwner = runtime?.terminateVideoPipelineLockOwner ?? terminateVideoPipelineLockOwner;

  return {
    close() {
      closeService(dashboardService);
      closeService(pipelineService);
      closeService(publishService);
      closeService(schedulerControlService);
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
        triggerSource,
        request: {
          summaryUsers: normalizeText(summaryUsers),
          authFile: normalizeText(authFile),
        },
        run() {
          return schedulerControlService.runSummarySweep({
            summaryUsers,
            authFile,
            triggerSource,
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
        triggerSource,
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
            triggerSource,
          });
        },
      });
    },
    async restartScheduler({
      confirm = false,
    }: {
      confirm?: boolean;
    } = {}) {
      return executeAuditedOperation(db, {
        action: "scheduler-restart",
        scope: "scheduler",
        triggerSource,
        request: {
          confirm: true,
        },
        run() {
          ensureConfirmed(confirm, "scheduler restart");
          return schedulerControlService.requestRestart();
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
      return executePipelineRetryOperation(db, pipelineService, {
        bvid,
        publish,
        forceSummary,
        triggerSource,
        beforeRun() {
          ensurePipelineNotActive(db, bvid, "retry");
        },
      });
    },
    async retryRetryableFailures({
      limit = 5,
      sinceHours = 24 * 7,
      maxRecentRetries = 1,
      retryWindowHours = 6,
      confirm = false,
    }: {
      limit?: number;
      sinceHours?: number;
      maxRecentRetries?: number;
      retryWindowHours?: number;
      confirm?: boolean;
    } = {}) {
      ensureConfirmed(confirm, "retryable failure sweep");
      return executeAuditedOperation(db, {
        action: "retry-failure-queue",
        scope: "pipeline",
        triggerSource,
        request: {
          confirm: true,
          limit: Math.max(1, Number(limit) || 5),
          sinceHours: Math.max(1, Number(sinceHours) || 24 * 7),
          maxRecentRetries: Math.max(0, Number(maxRecentRetries) || 1),
          retryWindowHours: Math.max(1, Number(retryWindowHours) || 6),
        },
        async run() {
          const safeLimit = Math.max(1, Number(limit) || 5);
          const safeSinceHours = Math.max(1, Number(sinceHours) || 24 * 7);
          const safeMaxRecentRetries = Math.max(0, Number(maxRecentRetries) || 1);
          const safeRetryWindowHours = Math.max(1, Number(retryWindowHours) || 6);
          const candidates = dashboardService.listFailureQueue({
            limit: Math.max(20, safeLimit * 4),
            sinceHours: safeSinceHours,
            resolutions: ["retryable"],
          });
          const activeBvids = new Set(
            dashboardService.listActivePipelines(200)
              .map((item) => normalizeText(item.bvid))
              .filter(Boolean),
          );
          const recentRetries = listOperationAudits(db, {
            limit: 500,
          }).filter((audit) =>
            audit.action === "pipeline-retry"
            && isWithinRecentHours(audit.created_at, safeRetryWindowHours),
          );
          const selected = uniqueByBvid(candidates);
          const items = [];
          let triggered = 0;
          let skipped = 0;
          let failed = 0;

          for (const candidate of selected) {
            if (triggered >= safeLimit) {
              break;
            }

            const bvid = normalizeText(candidate.bvid);
            if (!bvid) {
              skipped += 1;
              items.push({
                bvid: candidate.bvid,
                runId: candidate.runId,
                status: "skipped",
                reason: "missing-bvid",
              });
              continue;
            }

            if (activeBvids.has(bvid)) {
              skipped += 1;
              items.push({
                bvid,
                runId: candidate.runId,
                status: "skipped",
                reason: "already-running",
              });
              continue;
            }

            const recentRetryCount = recentRetries.filter((audit) => audit.bvid === bvid).length;
            if (recentRetryCount >= safeMaxRecentRetries) {
              skipped += 1;
              items.push({
                bvid,
                runId: candidate.runId,
                status: "skipped",
                reason: "recently-retried",
                recentRetryCount,
              });
              continue;
            }

            const result = await executePipelineRetryOperation(db, pipelineService, {
              bvid,
              publish: true,
              forceSummary: candidate.failureCategory === "summary",
              triggerSource,
            });
            const runId = inferRunId(result);
            recentRetries.push({
              id: -1,
              action: "pipeline-retry",
              scope: "pipeline",
              trigger_source: triggerSource,
              bvid,
              run_id: runId,
              request_json: null,
              status: result.ok ? "succeeded" : "failed",
              result_json: null,
              error_message: normalizeText(result.errorMessage),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });

            if (isResultOk(result)) {
              triggered += 1;
              items.push({
                bvid,
                runId: runId ?? candidate.runId,
                status: "triggered",
                failureCategory: candidate.failureCategory,
              });
              continue;
            }

            failed += 1;
            items.push({
              bvid,
              runId: runId ?? candidate.runId,
              status: "failed",
              failureCategory: candidate.failureCategory,
              errorMessage: extractResultErrorMessage(result),
            });
          }

          return {
            selected: selected.length,
            scanned: candidates.length,
            triggered,
            skipped,
            failed,
            items,
          };
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
        triggerSource,
        request: {
          bvid,
          confirm: true,
        },
        run() {
          ensureConfirmed(confirm, "single pipeline publish");
          ensurePipelineNotActive(db, bvid, "publish");
          return pipelineService.runPipeline({
            bvid,
            publish: true,
            triggerSource,
          });
        },
      });
    },
    async cancelPipeline({
      bvid,
      reason = "manual-cancel",
    }: {
      bvid: string;
      reason?: string;
    }) {
      return executeAuditedOperation(db, {
        action: "pipeline-cancel",
        scope: "pipeline",
        bvid,
        triggerSource,
        request: {
          bvid,
          reason: normalizeText(reason) ?? "manual-cancel",
        },
        run() {
          const activeRun = getActivePipelineRunStateByBvid(db, bvid);
          if (!activeRun) {
            throw new Error(`No running pipeline for ${bvid}`);
          }

          const termination = terminatePipelineOwner({
            workRoot,
            bvid,
          });
          if (!termination.signalSent) {
            throw new Error(`Failed to signal running pipeline for ${bvid}`);
          }

          return {
            ok: true,
            bvid,
            runId: activeRun.run_id,
            reason: normalizeText(reason) ?? "manual-cancel",
            signalSent: true,
            ownerPid: termination.owner?.pid ?? null,
          };
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
        triggerSource,
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
    async recoverZombiePipeline({
      bvid,
      staleMs = 15 * 60 * 1000,
      confirm = false,
      retry = true,
      reason = "manual-zombie-recovery",
    }: {
      bvid: string;
      staleMs?: number;
      confirm?: boolean;
      retry?: boolean;
      reason?: string;
    }) {
      ensureConfirmed(confirm, "zombie pipeline recovery");
      return executeZombieRecoveryOperation(db, dashboardService, pipelineService, {
        bvid,
        staleMs,
        triggerSource,
        retry,
        reason,
      });
    },
    async recoverZombiePipelines({
      staleMs = 15 * 60 * 1000,
      limit = 3,
      maxRecentRecoveries = 1,
      recoveryWindowHours = 6,
      retry = true,
      states = ["missing-lock", "orphaned-lock"],
      confirm = false,
    }: {
      staleMs?: number;
      limit?: number;
      maxRecentRecoveries?: number;
      recoveryWindowHours?: number;
      retry?: boolean;
      states?: Array<"missing-lock" | "orphaned-lock" | "stalled">;
      confirm?: boolean;
    } = {}) {
      ensureConfirmed(confirm, "zombie recovery sweep");
      return executeAuditedOperation(db, {
        action: "recover-zombie-queue",
        scope: "pipeline",
        triggerSource,
        request: {
          confirm: true,
          staleMs: Math.max(60_000, Number(staleMs) || 15 * 60 * 1000),
          limit: Math.max(1, Number(limit) || 3),
          maxRecentRecoveries: Math.max(0, Number(maxRecentRecoveries) || 1),
          recoveryWindowHours: Math.max(1, Number(recoveryWindowHours) || 6),
          retry: Boolean(retry),
          states,
        },
        async run() {
          const safeStaleMs = Math.max(60_000, Number(staleMs) || 15 * 60 * 1000);
          const safeLimit = Math.max(1, Number(limit) || 3);
          const safeMaxRecentRecoveries = Math.max(0, Number(maxRecentRecoveries) || 1);
          const safeRecoveryWindowHours = Math.max(1, Number(recoveryWindowHours) || 6);
          const safeStates: Array<"missing-lock" | "orphaned-lock" | "stalled"> = Array.isArray(states) && states.length > 0
            ? states
            : ["missing-lock", "orphaned-lock"];
          const candidates = dashboardService.listRecoveryCandidates({
            limit: Math.max(20, safeLimit * 4),
            staleMs: safeStaleMs,
            states: safeStates,
          });
          const recentRecoveries = listOperationAudits(db, {
            limit: 500,
          }).filter((audit) =>
            audit.action === "pipeline-recover-zombie"
            && isWithinRecentHours(audit.created_at, safeRecoveryWindowHours),
          );
          const selected = uniqueByBvid(candidates);
          const items = [];
          let recovered = 0;
          let skipped = 0;
          let failed = 0;

          for (const candidate of selected) {
            if (recovered >= safeLimit) {
              break;
            }

            const bvid = normalizeText(candidate.bvid);
            if (!bvid) {
              skipped += 1;
              items.push({
                bvid: candidate.bvid,
                runId: candidate.runId,
                status: "skipped",
                reason: "missing-bvid",
              });
              continue;
            }

            const recentRecoveryCount = recentRecoveries.filter((audit) => audit.bvid === bvid).length;
            if (recentRecoveryCount >= safeMaxRecentRecoveries) {
              skipped += 1;
              items.push({
                bvid,
                runId: candidate.runId,
                status: "skipped",
                reason: "recently-recovered",
                recentRecoveryCount,
              });
              continue;
            }

            const result = await executeZombieRecoveryOperation(db, dashboardService, pipelineService, {
              bvid,
              staleMs: safeStaleMs,
              triggerSource,
              retry,
              reason: "scheduler-zombie-recovery",
            });
            recentRecoveries.push({
              id: -1,
              action: "pipeline-recover-zombie",
              scope: "pipeline",
              trigger_source: triggerSource,
              bvid,
              run_id: inferRunId(result) ?? candidate.runId,
              request_json: null,
              status: result.ok ? "succeeded" : "failed",
              result_json: null,
              error_message: normalizeText(result.errorMessage),
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            });

            if (isResultOk(result)) {
              recovered += 1;
              items.push({
                bvid,
                runId: inferRunId(result) ?? candidate.runId,
                status: "recovered",
                recoveryState: candidate.recoveryState,
              });
              continue;
            }

            failed += 1;
            items.push({
              bvid,
              runId: candidate.runId,
              status: "failed",
              recoveryState: candidate.recoveryState,
              errorMessage: extractResultErrorMessage(result),
            });
          }

          return {
            selected: selected.length,
            scanned: candidates.length,
            recovered,
            skipped,
            failed,
            items,
          };
        },
      });
    },
  };
}

function executePipelineRetryOperation(
  db: ReturnType<typeof openDatabase>,
  pipelineService: ReturnType<typeof createPipelineService>,
  {
    bvid,
    publish,
    forceSummary,
    triggerSource,
    beforeRun = null,
  }: {
    bvid: string;
    publish: boolean;
    forceSummary: boolean;
    triggerSource: string;
    beforeRun?: (() => void) | null;
  },
) {
  return executeAuditedOperation(db, {
    action: "pipeline-retry",
    scope: "pipeline",
    bvid,
    triggerSource,
    request: {
      bvid,
      publish: Boolean(publish),
      forceSummary: Boolean(forceSummary),
    },
    run() {
      beforeRun?.();
      return pipelineService.runPipeline({
        bvid,
        publish,
        forceSummary,
        triggerSource,
      });
    },
  });
}

function executeZombieRecoveryOperation(
  db: ReturnType<typeof openDatabase>,
  dashboardService: ReturnType<typeof createDashboardService>,
  pipelineService: ReturnType<typeof createPipelineService>,
  {
    bvid,
    staleMs,
    triggerSource,
    retry,
    reason,
  }: {
    bvid: string;
    staleMs: number;
    triggerSource: string;
    retry: boolean;
    reason?: string;
  },
) {
  return executeAuditedOperation(db, {
    action: "pipeline-recover-zombie",
    scope: "pipeline",
    bvid,
    triggerSource,
    request: {
      bvid,
      staleMs: Math.max(60_000, Number(staleMs) || 15 * 60 * 1000),
      retry: Boolean(retry),
      reason: normalizeText(reason) ?? "manual-zombie-recovery",
    },
    async run() {
      const activeRun = getActivePipelineRunStateByBvid(db, bvid);
      if (!activeRun) {
        throw new Error(`No running pipeline for ${bvid}`);
      }

      const candidate = findRecoveryCandidate(dashboardService, bvid, staleMs, ["missing-lock", "orphaned-lock"]);
      if (!candidate) {
        throw new Error(`No recoverable zombie pipeline found for ${bvid}`);
      }

      const syntheticEvent = insertPipelineEvent(db, {
        runId: activeRun.run_id,
        triggerSource,
        videoId: activeRun.video_id,
        bvid: activeRun.bvid,
        videoTitle: activeRun.video_title,
        pageNo: activeRun.current_page_no,
        cid: activeRun.current_cid,
        partTitle: activeRun.current_part_title,
        scope: "pipeline",
        action: "run",
        status: "failed",
        message: `Recovered zombie pipeline: ${candidate.recoveryReason}`,
        details: {
          failedScope: "pipeline",
          failedAction: "stale-recovery",
          failedStep: "pipeline/stale-recovery",
          recoveryReason: normalizeText(reason) ?? "manual-zombie-recovery",
          previousRunId: activeRun.run_id,
          staleForMs: candidate.staleForMs,
          lockExists: candidate.lockExists,
          lockStale: candidate.lockStale,
        },
      });

      let retryResult: unknown = null;
      if (retry) {
        retryResult = await pipelineService.runPipeline({
          bvid,
          publish: true,
          forceSummary: false,
          triggerSource,
        });
      }

      return {
        ok: true,
        bvid,
        previousRunId: activeRun.run_id,
        recoveryState: candidate.recoveryState,
        staleForMs: candidate.staleForMs,
        syntheticEventId: syntheticEvent?.id ?? null,
        retryQueued: retry ? isResultOk(retryResult) : false,
        retryRunId: retry ? inferRunId(retryResult) : null,
        retryResult,
      };
    },
  });
}

async function executeAuditedOperation(
  db: ReturnType<typeof openDatabase>,
  {
    action,
    scope,
    bvid = null,
    triggerSource = "web",
    request = null,
    run,
  }: {
    action: string;
    scope: string;
    bvid?: string | null;
    triggerSource?: string;
    request?: unknown;
    run: () => Promise<unknown> | unknown;
  },
) {
  const audit = insertOperationAudit(db, {
    action,
    scope,
    triggerSource,
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

function isResultOk(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return true;
  }

  const candidate = result as { ok?: unknown };
  return candidate.ok !== false;
}

function extractResultErrorMessage(result: unknown): string | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const candidate = result as { errorMessage?: unknown; result?: { errorMessage?: unknown } };
  return normalizeText(candidate.errorMessage) ?? normalizeText(candidate.result?.errorMessage);
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

function uniqueByBvid<T extends { bvid: string | null }>(items: T[]): T[] {
  const seen = new Set<string>();
  const output: T[] = [];

  for (const item of items) {
    const bvid = normalizeText(item.bvid);
    if (!bvid || seen.has(bvid)) {
      continue;
    }

    seen.add(bvid);
    output.push(item);
  }

  return output;
}

function isWithinRecentHours(value: string, hours: number): boolean {
  const threshold = Date.now() - Math.max(1, Number(hours) || 1) * 3600 * 1000;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp >= threshold;
}

function findRecoveryCandidate(
  dashboardService: ReturnType<typeof createDashboardService>,
  bvid: string,
  staleMs: number,
  states: Array<"missing-lock" | "orphaned-lock" | "stalled">,
) {
  return dashboardService.listRecoveryCandidates({
    limit: 200,
    staleMs: Math.max(60_000, Number(staleMs) || 15 * 60 * 1000),
    states,
  }).find((item) => item.bvid === bvid) ?? null;
}

function ensurePipelineNotActive(db: ReturnType<typeof openDatabase>, bvid: string, actionLabel: string) {
  if (!getActivePipelineRunStateByBvid(db, bvid)) {
    return;
  }

  throw new Error(`Cannot ${actionLabel} pipeline while it is already running: ${bvid}`);
}

function closeService(target: unknown) {
  if (!target || typeof target !== "object" || !("close" in target)) {
    return;
  }

  const close = (target as { close?: unknown }).close;
  if (typeof close === "function") {
    close.call(target);
  }
}
