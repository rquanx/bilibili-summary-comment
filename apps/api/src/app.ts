import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import {
  createConfigService,
  createDashboardService,
  createOperationsService,
  createPipelineQueryService,
  createSchedulerStatusService,
} from "../../../packages/core/src/index";
import { getRepoRoot } from "../../../scripts/lib/shared/runtime-tools";

const activePipelinesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const recentRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  status: z.string().trim().optional(),
});

const runsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: z.string().trim().optional(),
  bvid: z.string().trim().optional(),
});

const failureQueueQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  resolution: z.string().trim().optional(),
  sinceHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
});

const failureGroupsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  sinceHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
});

const dashboardHealthQuerySchema = z.object({
  attentionLimit: z.coerce.number().int().min(1).max(100).optional(),
  heartbeatStaleMs: z.coerce.number().int().min(1_000).max(24 * 3600 * 1000).optional(),
  runStaleMs: z.coerce.number().int().min(10_000).max(7 * 24 * 3600 * 1000).optional(),
});

const recoveryCandidatesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  staleMs: z.coerce.number().int().min(60_000).max(7 * 24 * 3600 * 1000).optional(),
  state: z.string().trim().optional(),
});

const pipelineDetailParamsSchema = z.object({
  bvid: z.string().trim().min(1),
});

const pipelineDetailQuerySchema = z.object({
  runLimit: z.coerce.number().int().min(1).max(100).optional(),
  eventLimit: z.coerce.number().int().min(1).max(500).optional(),
});

const pipelineTimelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

const eventStreamQuerySchema = z.object({
  bvid: z.string().trim().optional(),
  afterId: z.coerce.number().int().min(0).optional(),
  pollMs: z.coerce.number().int().min(1000).max(10000).optional(),
});

const actionBodySchema = z.object({
  summaryUsers: z.string().trim().optional(),
  authFile: z.string().trim().optional(),
  reason: z.string().trim().optional(),
  confirm: z.boolean().optional(),
  forceSummary: z.boolean().optional(),
  staleMs: z.coerce.number().int().min(60_000).max(7 * 24 * 3600 * 1000).optional(),
  retry: z.boolean().optional(),
});

const auditsQuerySchema = z.object({
  bvid: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const settingsBodySchema = z.object({
  scheduler: z.object({
    authFile: z.string().trim().min(1).optional(),
    cookieFile: z.string().trim().nullable().optional(),
    timezone: z.string().trim().nullable().optional(),
    summaryUsers: z.string().optional(),
    summarySinceHours: z.coerce.number().int().min(1).optional(),
    summaryConcurrency: z.coerce.number().int().min(1).optional(),
    retryFailuresLimit: z.coerce.number().int().min(1).optional(),
    retryFailuresSinceHours: z.coerce.number().int().min(1).optional(),
    retryFailuresMaxRecent: z.coerce.number().int().min(0).optional(),
    retryFailuresWindowHours: z.coerce.number().int().min(1).optional(),
    zombieRecoveryEnabled: z.boolean().optional(),
    zombieRecoveryStaleMs: z.coerce.number().int().min(60_000).optional(),
    zombieRecoveryLimit: z.coerce.number().int().min(1).optional(),
    zombieRecoveryMaxRecent: z.coerce.number().int().min(0).optional(),
    zombieRecoveryWindowHours: z.coerce.number().int().min(1).optional(),
    zombieRecoveryRetry: z.boolean().optional(),
    zombieRecoveryStates: z.string().trim().min(1).optional(),
    refreshDays: z.coerce.number().int().min(1).optional(),
    cleanupDays: z.coerce.number().int().min(1).optional(),
    gapCheckSinceHours: z.coerce.number().int().min(1).optional(),
    gapThresholdSeconds: z.coerce.number().int().min(1).optional(),
    summaryCron: z.string().trim().min(1).optional(),
    publishCron: z.string().trim().min(1).optional(),
    gapCheckCron: z.string().trim().min(1).optional(),
    retryFailuresCron: z.string().trim().min(1).optional(),
    zombieRecoveryCron: z.string().trim().min(1).optional(),
    refreshCron: z.string().trim().min(1).optional(),
    cleanupCron: z.string().trim().min(1).optional(),
  }).optional(),
  summary: z.object({
    model: z.string().trim().min(1).optional(),
    apiBaseUrl: z.string().trim().url().optional(),
    apiFormat: z.enum(["auto", "responses", "openai-chat", "anthropic-messages"]).optional(),
    promptConfigPath: z.string().trim().nullable().optional(),
    promptConfigContent: z.string().trim().nullable().optional(),
  }).optional(),
  publish: z.object({
    appendCooldownMinMs: z.coerce.number().int().min(1).optional(),
    appendCooldownMaxMs: z.coerce.number().int().min(1).optional(),
    rebuildCooldownMinMs: z.coerce.number().int().min(1).optional(),
    rebuildCooldownMaxMs: z.coerce.number().int().min(1).optional(),
    maxConcurrent: z.coerce.number().int().min(1).optional(),
    healthcheckSinceHours: z.coerce.number().int().min(1).optional(),
    includeRecentPublishedHealthcheck: z.boolean().optional(),
    stopOnFirstFailure: z.boolean().optional(),
    rebuildPriority: z.enum(["append-first", "rebuild-first"]).optional(),
    cooldownOnlyWhenCommentsCreated: z.boolean().optional(),
  }).optional(),
});

const settingsHistoryQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const settingsRollbackBodySchema = z.object({
  auditId: z.coerce.number().int().positive(),
});

export async function buildApiServer({
  dbPath = process.env.PIPELINE_DB_PATH ?? "work/pipeline.sqlite3",
  webDistDir = path.join(getRepoRoot(), "apps", "web", "dist"),
  logger = false,
  services = {},
}: {
  dbPath?: string;
  webDistDir?: string;
  logger?: boolean;
  services?: {
    configService?: ReturnType<typeof createConfigService>;
    dashboardService?: ReturnType<typeof createDashboardService>;
    operationsService?: ReturnType<typeof createOperationsService>;
    pipelineQueryService?: ReturnType<typeof createPipelineQueryService>;
    schedulerStatusService?: ReturnType<typeof createSchedulerStatusService>;
  };
} = {}) {
  const app = Fastify({
    logger,
  });
  const dashboardService = services.dashboardService ?? createDashboardService({
    dbPath,
  });
  const configService = services.configService ?? createConfigService({
    dbPath,
  });
  const operationsService = services.operationsService ?? createOperationsService({
    dbPath,
  });
  const pipelineQueryService = services.pipelineQueryService ?? createPipelineQueryService({
    dbPath,
  });
  const schedulerStatusService = services.schedulerStatusService ?? createSchedulerStatusService({
    dbPath,
  });

  app.addHook("onClose", async () => {
    configService.close?.();
    dashboardService.close?.();
    operationsService.close?.();
    pipelineQueryService.close?.();
    schedulerStatusService.close?.();
  });

  await app.register(cors, {
    origin: true,
  });

  app.get("/api/health", async () => ({
    ok: true,
    dbPath,
    now: new Date().toISOString(),
  }));

  app.get("/api/dashboard/summary", async () => ({
    ok: true,
    summary: dashboardService.getSummary(),
  }));

  app.get("/api/dashboard/active-pipelines", async (request) => {
    const query = activePipelinesQuerySchema.parse(request.query ?? {});
    return {
      ok: true,
      items: dashboardService.listActivePipelines(query.limit ?? 50),
      summary: dashboardService.getSummary(),
    };
  });

  app.get("/api/dashboard/recent-runs", async (request) => {
    const query = recentRunsQuerySchema.parse(request.query ?? {});
    const statuses = query.status
      ? query.status.split(",").map((item) => item.trim()).filter(Boolean)
      : null;

    return {
      ok: true,
      items: dashboardService.listRecentRuns({
        limit: query.limit ?? 50,
        statuses,
      }),
    };
  });

  app.get("/api/dashboard/runs", async (request) => {
    const query = runsQuerySchema.parse(request.query ?? {});
    const statuses = query.status
      ? query.status.split(",").map((item) => item.trim()).filter(Boolean)
      : null;
    const limit = query.limit ?? 25;
    const offset = query.offset ?? 0;
    const items = pipelineQueryService.listRuns({
      limit,
      offset,
      statuses,
      bvid: query.bvid ?? null,
    });
    const total = pipelineQueryService.countRuns({
      statuses,
      bvid: query.bvid ?? null,
    });

    return {
      ok: true,
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  });

  app.get("/api/dashboard/failure-queue", async (request) => {
    const query = failureQueueQuerySchema.parse(request.query ?? {});
    const resolutions = query.resolution
      ? query.resolution.split(",").map((item) => item.trim()).filter(Boolean) as Array<"retryable" | "manual" | "inspect">
      : null;

    return {
      ok: true,
      items: dashboardService.listFailureQueue({
        limit: query.limit ?? 50,
        resolutions,
        sinceHours: query.sinceHours ?? 24 * 7,
      }),
    };
  });

  app.get("/api/dashboard/failure-groups", async (request) => {
    const query = failureGroupsQuerySchema.parse(request.query ?? {});
    return {
      ok: true,
      items: dashboardService.listFailureGroups({
        limit: query.limit ?? 12,
        sinceHours: query.sinceHours ?? 24 * 7,
      }),
    };
  });

  app.get("/api/dashboard/health", async (request) => {
    const query = dashboardHealthQuerySchema.parse(request.query ?? {});
    const health = dashboardService.getOperationalHealth({
      attentionLimit: query.attentionLimit ?? 20,
      heartbeatStaleMs: query.heartbeatStaleMs ?? 90_000,
      runStaleMs: query.runStaleMs ?? 15 * 60 * 1000,
    });

    return {
      ok: true,
      ...health,
    };
  });

  app.get("/api/dashboard/recovery-candidates", async (request) => {
    const query = recoveryCandidatesQuerySchema.parse(request.query ?? {});
    const states = query.state
      ? query.state.split(",").map((item) => item.trim()).filter(Boolean) as Array<"missing-lock" | "orphaned-lock" | "stalled">
      : null;

    return {
      ok: true,
      items: dashboardService.listRecoveryCandidates({
        limit: query.limit ?? 20,
        staleMs: query.staleMs ?? 15 * 60 * 1000,
        states,
      }),
    };
  });

  app.get("/api/settings", async () => ({
    ok: true,
    ...configService.getConfig(),
  }));

  app.get("/api/settings/history", async (request) => {
    const query = settingsHistoryQuerySchema.parse(request.query ?? {});
    return {
      ok: true,
      items: configService.listHistory({
        limit: query.limit ?? 20,
      }),
    };
  });

  app.put("/api/settings", async (request, reply) => {
    const body = settingsBodySchema.parse(request.body ?? {});
    const result = await configService.updateSettings({
      patch: body,
    });

    if (!result.ok) {
      reply.code(400);
    }

    return result;
  });

  app.post("/api/settings/rollback", async (request, reply) => {
    const body = settingsRollbackBodySchema.parse(request.body ?? {});
    const result = await configService.rollbackToAudit({
      auditId: body.auditId,
    });

    if (!result.ok) {
      reply.code(String(result.errorMessage ?? "").includes("Unknown config audit") ? 404 : 400);
    }

    return result;
  });

  app.post("/api/scheduler/restart", async (request, reply) => {
    const body = z.object({
      confirm: z.boolean().optional(),
    }).parse(request.body ?? {});
    const result = await operationsService.restartScheduler({
      confirm: Boolean(body.confirm),
    });

    if (!result.ok) {
      const errorMessage = String(result.errorMessage ?? "");
      reply.code(
        errorMessage.includes("Confirmation required")
          ? 400
          : errorMessage.includes("not running")
            || errorMessage.includes("daemon mode")
            || errorMessage.includes("unavailable")
            || errorMessage.includes("status not found")
            ? 409
            : 500,
      );
    }

    return result;
  });

  app.get("/api/actions/audits", async (request) => {
    const query = auditsQuerySchema.parse(request.query ?? {});
    return {
      ok: true,
      items: operationsService.listAudits({
        bvid: query.bvid ?? null,
        limit: query.limit ?? 50,
      }),
    };
  });

  app.post("/api/actions/summary-sweep", async (request, reply) => {
    const body = actionBodySchema.parse(request.body ?? {});
    const result = await operationsService.runSummarySweep({
      summaryUsers: body.summaryUsers,
      authFile: body.authFile,
    });

    if (!result.ok) {
      reply.code(500);
    }

    return result;
  });

  app.post("/api/actions/publish-sweep", async (request, reply) => {
    const body = actionBodySchema.parse(request.body ?? {});
    const result = await operationsService.runPublishSweep({
      summaryUsers: body.summaryUsers,
      authFile: body.authFile,
      confirm: Boolean(body.confirm),
    });

    if (!result.ok) {
      reply.code(String(result.errorMessage ?? "").includes("Confirmation required") ? 400 : 500);
    }

    return result;
  });

  app.post("/api/actions/pipeline/:bvid/retry", async (request, reply) => {
    const params = pipelineDetailParamsSchema.parse(request.params ?? {});
    const body = actionBodySchema.parse(request.body ?? {});
    const result = await operationsService.retryPipeline({
      bvid: params.bvid,
      publish: true,
      forceSummary: Boolean(body.forceSummary),
    });

    if (!result.ok) {
      reply.code(String(result.errorMessage ?? "").includes("already running") ? 409 : 500);
    }

    return result;
  });

  app.post("/api/actions/pipeline/:bvid/cancel", async (request, reply) => {
    const params = pipelineDetailParamsSchema.parse(request.params ?? {});
    const body = actionBodySchema.parse(request.body ?? {});
    const result = await operationsService.cancelPipeline({
      bvid: params.bvid,
      reason: body.reason ?? "manual-cancel",
    });

    if (!result.ok) {
      reply.code(String(result.errorMessage ?? "").includes("No running pipeline") ? 409 : 500);
    }

    return result;
  });

  app.post("/api/actions/pipeline/:bvid/recover-zombie", async (request, reply) => {
    const params = pipelineDetailParamsSchema.parse(request.params ?? {});
    const body = actionBodySchema.parse(request.body ?? {});
    const result = await operationsService.recoverZombiePipeline({
      bvid: params.bvid,
      staleMs: body.staleMs ?? 15 * 60 * 1000,
      confirm: Boolean(body.confirm),
      retry: body.retry !== false,
      reason: body.reason ?? "manual-zombie-recovery",
    });

    if (!result.ok) {
      const errorMessage = String(result.errorMessage ?? "");
      reply.code(
        errorMessage.includes("Confirmation required")
          ? 400
          : errorMessage.includes("No running pipeline") || errorMessage.includes("No recoverable zombie pipeline")
            ? 409
            : 500,
      );
    }

    return result;
  });

  app.post("/api/actions/retry-failures", async (request, reply) => {
    const body = actionBodySchema.extend({
      limit: z.coerce.number().int().min(1).max(50).optional(),
      sinceHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
      maxRecentRetries: z.coerce.number().int().min(0).max(20).optional(),
      retryWindowHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
    }).parse(request.body ?? {});
    const result = await operationsService.retryRetryableFailures({
      confirm: Boolean(body.confirm),
      limit: body.limit ?? 5,
      sinceHours: body.sinceHours ?? 24 * 7,
      maxRecentRetries: body.maxRecentRetries ?? 1,
      retryWindowHours: body.retryWindowHours ?? 6,
    });

    if (!result.ok) {
      reply.code(String(result.errorMessage ?? "").includes("Confirmation required") ? 400 : 500);
    }

    return result;
  });

  app.post("/api/actions/recover-zombies", async (request, reply) => {
    const body = actionBodySchema.extend({
      limit: z.coerce.number().int().min(1).max(50).optional(),
      maxRecentRecoveries: z.coerce.number().int().min(0).max(20).optional(),
      recoveryWindowHours: z.coerce.number().int().min(1).max(24 * 30).optional(),
      states: z.array(z.enum(["missing-lock", "orphaned-lock", "stalled"])).optional(),
    }).parse(request.body ?? {});
    const result = await operationsService.recoverZombiePipelines({
      confirm: Boolean(body.confirm),
      staleMs: body.staleMs ?? 15 * 60 * 1000,
      limit: body.limit ?? 3,
      maxRecentRecoveries: body.maxRecentRecoveries ?? 1,
      recoveryWindowHours: body.recoveryWindowHours ?? 6,
      retry: body.retry !== false,
      states: body.states ?? ["missing-lock", "orphaned-lock"],
    });

    if (!result.ok) {
      reply.code(String(result.errorMessage ?? "").includes("Confirmation required") ? 400 : 500);
    }

    return result;
  });

  app.post("/api/actions/pipeline/:bvid/publish", async (request, reply) => {
    const params = pipelineDetailParamsSchema.parse(request.params ?? {});
    const body = actionBodySchema.parse(request.body ?? {});
    const result = await operationsService.publishPipeline({
      bvid: params.bvid,
      confirm: Boolean(body.confirm),
    });

    if (!result.ok) {
      const errorMessage = String(result.errorMessage ?? "");
      reply.code(errorMessage.includes("Confirmation required") ? 400 : errorMessage.includes("already running") ? 409 : 500);
    }

    return result;
  });

  app.post("/api/actions/pipeline/:bvid/rebuild-publish-thread", async (request, reply) => {
    const params = pipelineDetailParamsSchema.parse(request.params ?? {});
    const body = actionBodySchema.parse(request.body ?? {});
    const result = await operationsService.rebuildPublishThread({
      bvid: params.bvid,
      confirm: Boolean(body.confirm),
    });

    if (!result.ok) {
      reply.code(String(result.errorMessage ?? "").includes("Confirmation required") ? 400 : 500);
    }

    return result;
  });

  app.get("/api/scheduler/status", async () => ({
    ok: true,
    status: schedulerStatusService.getStatus(),
  }));

  app.get("/api/dashboard/pipeline/:bvid", async (request, reply) => {
    const params = pipelineDetailParamsSchema.parse(request.params ?? {});
    const query = pipelineDetailQuerySchema.parse(request.query ?? {});
    const detail = dashboardService.getPipelineDetail(params.bvid, {
      runLimit: query.runLimit ?? 10,
      eventLimit: query.eventLimit ?? 100,
    });

    if (!detail.video && detail.recentRuns.length === 0 && detail.recentEvents.length === 0) {
      reply.code(404);
      return {
        ok: false,
        message: `Pipeline not found: ${params.bvid}`,
      };
    }

    return {
      ok: true,
      detail,
    };
  });

  app.get("/api/dashboard/pipeline/:bvid/runs", async (request, reply) => {
    const params = pipelineDetailParamsSchema.parse(request.params ?? {});
    const query = pipelineTimelineQuerySchema.parse(request.query ?? {});
    const limit = query.limit ?? 10;
    const offset = query.offset ?? 0;
    const detail = pipelineQueryService.getPipelineDetail(params.bvid, {
      runLimit: 1,
      eventLimit: 1,
    });
    const items = pipelineQueryService.listRuns({
      bvid: params.bvid,
      limit,
      offset,
    });
    const total = pipelineQueryService.countRuns({
      bvid: params.bvid,
    });

    if (!detail.video && total === 0) {
      reply.code(404);
      return {
        ok: false,
        message: `Pipeline not found: ${params.bvid}`,
      };
    }

    return {
      ok: true,
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  });

  app.get("/api/dashboard/pipeline/:bvid/events", async (request, reply) => {
    const params = pipelineDetailParamsSchema.parse(request.params ?? {});
    const query = pipelineTimelineQuerySchema.parse(request.query ?? {});
    const limit = query.limit ?? 25;
    const offset = query.offset ?? 0;
    const detail = pipelineQueryService.getPipelineDetail(params.bvid, {
      runLimit: 1,
      eventLimit: 1,
    });
    const items = pipelineQueryService.listEvents({
      bvid: params.bvid,
      limit,
      offset,
    });
    const total = pipelineQueryService.countEvents({
      bvid: params.bvid,
    });

    if (!detail.video && total === 0) {
      reply.code(404);
      return {
        ok: false,
        message: `Pipeline not found: ${params.bvid}`,
      };
    }

    return {
      ok: true,
      items,
      total,
      limit,
      offset,
      hasMore: offset + items.length < total,
    };
  });

  app.get("/api/dashboard/events/stream", async (request, reply) => {
    const query = eventStreamQuerySchema.parse(request.query ?? {});
    const pollMs = query.pollMs ?? 2000;
    let afterId = query.afterId ?? 0;
    let timer: NodeJS.Timeout | null = null;
    let closed = false;

    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    });
    reply.raw.flushHeaders?.();

    const writeEvent = (eventName: string, payload: Record<string, unknown>) => {
      if (closed) {
        return;
      }

      reply.raw.write(`event: ${eventName}\n`);
      reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    const flushEvents = () => {
      if (closed) {
        return;
      }

      const items = dashboardService.listEventsAfterId({
        afterId,
        bvid: query.bvid ?? null,
        limit: 100,
      });
      if (items.length === 0) {
        reply.raw.write(`: heartbeat ${Date.now()}\n\n`);
        return;
      }

      afterId = Number(items[items.length - 1]?.id ?? afterId);
      writeEvent("events", {
        items,
        afterId,
      });
    };

    const closeStream = () => {
      if (closed) {
        return;
      }

      closed = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      reply.raw.end();
    };

    request.raw.on("close", closeStream);
    request.raw.on("error", closeStream);
    writeEvent("ready", {
      afterId,
      pollMs,
    });
    flushEvents();
    timer = setInterval(flushEvents, pollMs);
  });

  if (fs.existsSync(webDistDir)) {
    await app.register(fastifyStatic, {
      root: webDistDir,
      prefix: "/",
      decorateReply: true,
      wildcard: false,
    });

    app.get("/*", async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        reply.code(404);
        return {
          ok: false,
          message: `Route not found: ${request.url}`,
        };
      }

      return reply.sendFile("index.html");
    });
  }

  return app;
}
