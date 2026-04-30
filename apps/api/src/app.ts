import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import {
  createDashboardService,
  createOperationsService,
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

const pipelineDetailParamsSchema = z.object({
  bvid: z.string().trim().min(1),
});

const pipelineDetailQuerySchema = z.object({
  runLimit: z.coerce.number().int().min(1).max(100).optional(),
  eventLimit: z.coerce.number().int().min(1).max(500).optional(),
});

const eventStreamQuerySchema = z.object({
  bvid: z.string().trim().optional(),
  afterId: z.coerce.number().int().min(0).optional(),
  pollMs: z.coerce.number().int().min(1000).max(10000).optional(),
});

const actionBodySchema = z.object({
  summaryUsers: z.string().trim().optional(),
  authFile: z.string().trim().optional(),
  confirm: z.boolean().optional(),
  forceSummary: z.boolean().optional(),
});

const auditsQuerySchema = z.object({
  bvid: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
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
    dashboardService?: ReturnType<typeof createDashboardService>;
    operationsService?: ReturnType<typeof createOperationsService>;
    schedulerStatusService?: ReturnType<typeof createSchedulerStatusService>;
  };
} = {}) {
  const app = Fastify({
    logger,
  });
  const dashboardService = services.dashboardService ?? createDashboardService({
    dbPath,
  });
  const operationsService = services.operationsService ?? createOperationsService({
    dbPath,
  });
  const schedulerStatusService = services.schedulerStatusService ?? createSchedulerStatusService({
    dbPath,
  });

  app.addHook("onClose", async () => {
    dashboardService.close?.();
    operationsService.close?.();
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
      reply.code(500);
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

  app.post("/api/actions/pipeline/:bvid/publish", async (request, reply) => {
    const params = pipelineDetailParamsSchema.parse(request.params ?? {});
    const body = actionBodySchema.parse(request.body ?? {});
    const result = await operationsService.publishPipeline({
      bvid: params.bvid,
      confirm: Boolean(body.confirm),
    });

    if (!result.ok) {
      reply.code(String(result.errorMessage ?? "").includes("Confirmation required") ? 400 : 500);
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
