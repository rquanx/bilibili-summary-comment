import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import { z } from "zod";
import { createDashboardService } from "../../../packages/core/src/index";
import { getRepoRoot } from "../../../scripts/lib/shared/runtime-tools";

const activePipelinesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const recentRunsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  status: z.string().trim().optional(),
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

export async function buildApiServer({
  dbPath = process.env.PIPELINE_DB_PATH ?? "work/pipeline.sqlite3",
  webDistDir = path.join(getRepoRoot(), "apps", "web", "dist"),
  logger = false,
}: {
  dbPath?: string;
  webDistDir?: string;
  logger?: boolean;
} = {}) {
  const app = Fastify({
    logger,
  });
  const dashboardService = createDashboardService({
    dbPath,
  });

  app.addHook("onClose", async () => {
    dashboardService.close();
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
