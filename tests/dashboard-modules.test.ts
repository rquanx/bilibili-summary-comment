import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  insertOperationAudit,
  insertPipelineEvent,
  openDatabase,
  upsertSchedulerStatus,
  upsertVideo,
  upsertVideoPart,
} from "../scripts/lib/db/index";
import {
  createDashboardService,
  createOperationsService,
  createSchedulerStatusService,
} from "../packages/core/src/index";
import { buildApiServer } from "../apps/api/src/app";

test("dashboard service derives active and failed run snapshots from pipeline events", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-dashboard-service-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BV1DASHBOARD",
      aid: 10001,
      title: "Dashboard Video",
      ownerMid: 123,
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 9001,
      partTitle: "P1",
      durationSec: 10,
      isDeleted: false,
    });

    insertPipelineEvent(db, {
      runId: "run-active",
      triggerSource: "scheduler",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "pipeline",
      action: "run",
      status: "started",
      message: "Pipeline started",
      details: {
        logPath: path.join(tempRoot, "work", "logs", "active.jsonl"),
      },
    });
    insertPipelineEvent(db, {
      runId: "run-active",
      triggerSource: "scheduler",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      pageNo: 1,
      cid: 9001,
      partTitle: "P1",
      scope: "subtitle",
      action: "asr",
      status: "started",
      message: "ASR started",
    });
    db.prepare("UPDATE pipeline_runs SET updated_at = ? WHERE run_id = ?").run(
      new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      "run-active",
    );
    db.prepare("UPDATE pipeline_run_state SET updated_at = ? WHERE run_id = ?").run(
      new Date(Date.now() - 31 * 60 * 1000).toISOString(),
      "run-active",
    );

    insertPipelineEvent(db, {
      runId: "run-failed",
      triggerSource: "cli",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "pipeline",
      action: "run",
      status: "started",
      message: "Pipeline started",
    });
    insertPipelineEvent(db, {
      runId: "run-failed",
      triggerSource: "cli",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "pipeline",
      action: "run",
      status: "failed",
      message: "LLM blocked",
      details: {
        failedScope: "summary",
        failedAction: "llm",
        failedStep: "summary",
      },
    });
    insertPipelineEvent(db, {
      runId: "run-failed-2",
      triggerSource: "scheduler",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "pipeline",
      action: "run",
      status: "started",
      message: "Pipeline started",
    });
    insertPipelineEvent(db, {
      runId: "run-failed-2",
      triggerSource: "scheduler",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "pipeline",
      action: "run",
      status: "failed",
      message: "timeout while calling model",
      details: {
        failedScope: "summary",
        failedAction: "llm",
        failedStep: "summary",
      },
    });
    insertPipelineEvent(db, {
      runId: "run-auth-failed",
      triggerSource: "scheduler",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "pipeline",
      action: "run",
      status: "started",
      message: "Pipeline started",
    });
    insertPipelineEvent(db, {
      runId: "run-auth-failed",
      triggerSource: "scheduler",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "pipeline",
      action: "run",
      status: "failed",
      message: "cookie expired for publisher account",
      details: {
        failedScope: "publish",
        failedAction: "comment-thread",
        failedStep: "publish/comment-thread",
      },
    });
    upsertSchedulerStatus(db, {
      schedulerKey: "main",
      status: "running",
      mode: "daemon",
      currentTasks: ["summary"],
      lastHeartbeatAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });

    const service = createDashboardService({
      dbPath,
    });

    try {
      const active = service.listActivePipelines();
      const recent = service.listRecentRuns({
        statuses: ["failed"],
      });
      const failureQueue = service.listFailureQueue({
        limit: 10,
      });
      const retryableFailures = service.listFailureQueue({
        limit: 10,
        resolutions: ["retryable"],
      });
      const failureGroups = service.listFailureGroups({
        limit: 10,
      });
      const operationalHealth = service.getOperationalHealth({
        heartbeatStaleMs: 90_000,
        runStaleMs: 15 * 60 * 1000,
        attentionLimit: 10,
      });
      const detail = service.getPipelineDetail("BV1DASHBOARD");
      const summary = service.getSummary();

      assert.equal(active.length, 1);
      assert.equal(active[0].runId, "run-active");
      assert.equal(active[0].runStatus, "running");
      assert.equal(active[0].currentStage, "subtitle-asr");
      assert.equal(active[0].currentPageNo, 1);
      assert.equal(active[0].triggerSource, "scheduler");
      assert.match(String(active[0].logPath), /active\.jsonl/u);

      assert.equal(recent.length, 3);
      assert.equal(recent.some((item) => item.runId === "run-failed" && item.failedStep === "summary"), true);
      assert.equal(recent.some((item) => item.runId === "run-failed" && item.lastErrorMessage === "LLM blocked"), true);

      assert.equal(failureQueue.length, 3);
      assert.equal(failureQueue[0].resolution, "manual");
      assert.equal(failureQueue[0].failureCategory, "auth");
      assert.equal(retryableFailures.length, 1);
      assert.equal(retryableFailures[0].runId, "run-failed-2");

      assert.equal(failureGroups.length, 3);
      assert.equal(failureGroups[0].count, 1);
      assert.equal(
        failureGroups.some((item) => item.failureCategory === "transient" && item.resolution === "retryable"),
        true,
      );

      assert.equal(operationalHealth.snapshot.attentionCount, 2);
      assert.equal(operationalHealth.snapshot.criticalCount, 2);
      assert.equal(operationalHealth.snapshot.staleRunningCount, 1);
      assert.equal(
        operationalHealth.items.some((item) => item.kind === "scheduler-heartbeat" && item.severity === "critical"),
        true,
      );
      assert.equal(
        operationalHealth.items.some((item) => item.kind === "stalled-run" && item.runId === "run-active"),
        true,
      );

      assert.equal(detail.video?.bvid, "BV1DASHBOARD");
      assert.equal(detail.parts.length, 1);
      assert.equal(detail.recentRuns.length >= 2, true);
      assert.equal(detail.recentEvents.length >= 8, true);

      assert.equal(summary.activeCount, 1);
      assert.equal(summary.failedCount24h, 3);
      assert.equal(summary.succeededCount24h, 0);
    } finally {
      service.close();
    }
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("api exposes dashboard and pipeline detail endpoints from the shared service layer", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-dashboard-api-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BV1API",
      aid: 20001,
      title: "API Video",
      ownerMid: 456,
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 10001,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P>\nready",
      published: false,
      isDeleted: false,
    });

    insertPipelineEvent(db, {
      runId: "run-api",
      triggerSource: "scheduler",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "pipeline",
      action: "run",
      status: "started",
      message: "Pipeline started",
    });
    insertPipelineEvent(db, {
      runId: "run-api",
      triggerSource: "scheduler",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "pipeline",
      action: "run",
      status: "succeeded",
      message: "Pipeline complete",
    });
    insertPipelineEvent(db, {
      runId: "run-api-failed",
      triggerSource: "scheduler",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "pipeline",
      action: "run",
      status: "started",
      message: "Pipeline started",
    });
    insertPipelineEvent(db, {
      runId: "run-api-failed",
      triggerSource: "scheduler",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "pipeline",
      action: "run",
      status: "failed",
      message: "network timeout from upstream",
      details: {
        failedScope: "summary",
        failedAction: "llm",
        failedStep: "summary",
      },
    });
    upsertSchedulerStatus(db, {
      schedulerKey: "main",
      status: "running",
      currentTasks: ["summary"],
      lastHeartbeatAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    });

    const app = await buildApiServer({
      dbPath,
      logger: false,
      webDistDir: path.join(tempRoot, "missing-web-dist"),
    });

    try {
      const activeResponse = await app.inject({
        method: "GET",
        url: "/api/dashboard/active-pipelines",
      });
      assert.equal(activeResponse.statusCode, 200);
      assert.equal(activeResponse.json().ok, true);

      const recentResponse = await app.inject({
        method: "GET",
        url: "/api/dashboard/recent-runs?status=succeeded",
      });
      assert.equal(recentResponse.statusCode, 200);
      assert.equal(recentResponse.json().items.length, 1);

      const failureQueueResponse = await app.inject({
        method: "GET",
        url: "/api/dashboard/failure-queue?limit=10",
      });
      assert.equal(failureQueueResponse.statusCode, 200);
      assert.equal(failureQueueResponse.json().items.length, 1);
      assert.equal(failureQueueResponse.json().items[0].resolution, "retryable");

      const failureGroupsResponse = await app.inject({
        method: "GET",
        url: "/api/dashboard/failure-groups?limit=10",
      });
      assert.equal(failureGroupsResponse.statusCode, 200);
      assert.equal(failureGroupsResponse.json().items.length, 1);

      const healthResponse = await app.inject({
        method: "GET",
        url: "/api/dashboard/health?attentionLimit=10&heartbeatStaleMs=90000&runStaleMs=60000",
      });
      assert.equal(healthResponse.statusCode, 200);
      assert.equal(healthResponse.json().snapshot.attentionCount >= 1, true);
      assert.equal(
        healthResponse.json().items.some((item: { kind?: string }) => item.kind === "scheduler-heartbeat"),
        true,
      );

      const detailResponse = await app.inject({
        method: "GET",
        url: "/api/dashboard/pipeline/BV1API",
      });
      assert.equal(detailResponse.statusCode, 200);
      assert.equal(detailResponse.json().detail.video.bvid, "BV1API");
      assert.equal(detailResponse.json().detail.parts.length, 1);
    } finally {
      await app.close();
    }
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("operations service records audits and enforces confirmation for risky actions", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-operations-service-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BV1OPS",
      aid: 30001,
      title: "Operations Video",
      ownerMid: 789,
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 10002,
      partTitle: "P1",
      durationSec: 10,
      isDeleted: false,
    });

    const service = createOperationsService({
      dbPath,
    });

    try {
      const rebuildWithoutConfirm = await service.rebuildPublishThread({
        bvid: "BV1OPS",
        confirm: false,
      });
      assert.equal(rebuildWithoutConfirm.ok, false);
      assert.match(String(rebuildWithoutConfirm.errorMessage), /Confirmation required/u);

      const rebuildWithConfirm = await service.rebuildPublishThread({
        bvid: "BV1OPS",
        confirm: true,
      });
      assert.equal(rebuildWithConfirm.ok, true);

      const audits = service.listAudits({
        bvid: "BV1OPS",
        limit: 10,
      });
      assert.equal(audits.length, 2);
      assert.equal(audits[0].action, "rebuild-publish-thread");
      assert.equal(audits[0].status, "succeeded");
      assert.equal(audits[1].status, "failed");
    } finally {
      service.close();
    }
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("operations service retries only eligible retryable failures in batch mode", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-operations-retry-batch-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const videos = [
      upsertVideo(db, {
        bvid: "BV1RETRYA",
        aid: 50001,
        title: "Retry A",
        ownerMid: 1001,
        pageCount: 1,
      }),
      upsertVideo(db, {
        bvid: "BV1RETRYB",
        aid: 50002,
        title: "Retry B",
        ownerMid: 1002,
        pageCount: 1,
      }),
      upsertVideo(db, {
        bvid: "BV1RETRYC",
        aid: 50003,
        title: "Retry C",
        ownerMid: 1003,
        pageCount: 1,
      }),
    ];
    for (const video of videos) {
      upsertVideoPart(db, {
        videoId: video.id,
        pageNo: 1,
        cid: video.id + 8000,
        partTitle: "P1",
        durationSec: 10,
        isDeleted: false,
      });
    }

    insertPipelineEvent(db, {
      runId: "run-retry-a",
      triggerSource: "scheduler",
      videoId: videos[0].id,
      bvid: videos[0].bvid,
      videoTitle: videos[0].title,
      scope: "pipeline",
      action: "run",
      status: "started",
      message: "Pipeline started",
    });
    insertPipelineEvent(db, {
      runId: "run-retry-a",
      triggerSource: "scheduler",
      videoId: videos[0].id,
      bvid: videos[0].bvid,
      videoTitle: videos[0].title,
      scope: "pipeline",
      action: "run",
      status: "failed",
      message: "network timeout from upstream",
      details: {
        failedScope: "summary",
        failedAction: "llm",
        failedStep: "summary",
      },
    });

    insertPipelineEvent(db, {
      runId: "run-retry-b",
      triggerSource: "scheduler",
      videoId: videos[1].id,
      bvid: videos[1].bvid,
      videoTitle: videos[1].title,
      scope: "pipeline",
      action: "run",
      status: "started",
      message: "Pipeline started",
    });
    insertPipelineEvent(db, {
      runId: "run-retry-b",
      triggerSource: "scheduler",
      videoId: videos[1].id,
      bvid: videos[1].bvid,
      videoTitle: videos[1].title,
      scope: "pipeline",
      action: "run",
      status: "failed",
      message: "network timeout from upstream",
      details: {
        failedScope: "summary",
        failedAction: "llm",
        failedStep: "summary",
      },
    });

    insertPipelineEvent(db, {
      runId: "run-failed-c",
      triggerSource: "scheduler",
      videoId: videos[2].id,
      bvid: videos[2].bvid,
      videoTitle: videos[2].title,
      scope: "pipeline",
      action: "run",
      status: "started",
      message: "Pipeline started",
    });
    insertPipelineEvent(db, {
      runId: "run-failed-c",
      triggerSource: "scheduler",
      videoId: videos[2].id,
      bvid: videos[2].bvid,
      videoTitle: videos[2].title,
      scope: "pipeline",
      action: "run",
      status: "failed",
      message: "network timeout from upstream",
      details: {
        failedScope: "summary",
        failedAction: "llm",
        failedStep: "summary",
      },
    });

    insertPipelineEvent(db, {
      runId: "run-active-c",
      triggerSource: "scheduler",
      videoId: videos[2].id,
      bvid: videos[2].bvid,
      videoTitle: videos[2].title,
      scope: "pipeline",
      action: "run",
      status: "started",
      message: "Pipeline started",
    });
    insertPipelineEvent(db, {
      runId: "run-active-c",
      triggerSource: "scheduler",
      videoId: videos[2].id,
      bvid: videos[2].bvid,
      videoTitle: videos[2].title,
      scope: "subtitle",
      action: "asr",
      status: "started",
      message: "ASR started",
    });

    insertOperationAudit(db, {
      action: "pipeline-retry",
      scope: "pipeline",
      triggerSource: "web",
      bvid: "BV1RETRYB",
      status: "succeeded",
      request: {
        bvid: "BV1RETRYB",
      },
    });

    const triggeredBvids: string[] = [];
    const service = createOperationsService({
      dbPath,
      services: {
        pipelineService: {
          runPipeline({ bvid }: { bvid: string }) {
            triggeredBvids.push(bvid);
            return {
              ok: true,
              runId: `retry-${bvid}`,
            };
          },
        } as any,
      },
    });

    try {
      const result = await service.retryRetryableFailures({
        confirm: true,
        limit: 5,
        sinceHours: 24 * 7,
        maxRecentRetries: 1,
        retryWindowHours: 6,
      });

      assert.equal(result.ok, true);
      assert.deepEqual(triggeredBvids, ["BV1RETRYA"]);
      assert.equal((result.result as { triggered: number }).triggered, 1);
      assert.equal((result.result as { skipped: number }).skipped, 2);
      assert.equal(
        Array.isArray((result.result as { items: Array<{ reason?: string }> }).items),
        true,
      );
      assert.equal(
        ((result.result as { items: Array<{ reason?: string; status: string }> }).items).some((item) => item.reason === "recently-retried" && item.status === "skipped"),
        true,
      );
      assert.equal(
        ((result.result as { items: Array<{ reason?: string; status: string }> }).items).some((item) => item.reason === "already-running" && item.status === "skipped"),
        true,
      );
      assert.equal(
        service.listAudits({
          bvid: "BV1RETRYA",
          limit: 20,
        }).some((item) => item.action === "pipeline-retry"),
        true,
      );
    } finally {
      service.close();
    }
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("scheduler status service parses heartbeat health and current tasks", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-scheduler-status-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    upsertSchedulerStatus(db, {
      schedulerKey: "main",
      status: "running",
      mode: "daemon",
      timezone: "Asia/Shanghai",
      pid: 1234,
      hostname: "host",
      summaryUsers: "123,456",
      summaryConcurrency: 3,
      currentTasks: ["summary", "publish"],
      startedAt: new Date(Date.now() - 10_000).toISOString(),
      lastRetryFailuresAt: new Date(Date.now() - 5_000).toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    });

    const service = createSchedulerStatusService({
      dbPath,
      heartbeatStaleMs: 60_000,
    });

    try {
      const status = service.getStatus();
      assert.equal(status.status, "running");
      assert.equal(status.healthy, true);
      assert.deepEqual(status.currentTasks, ["summary", "publish"]);
      assert.equal(status.summaryConcurrency, 3);
      assert.equal(typeof status.taskTimes["retry-failures"], "string");
    } finally {
      service.close();
    }
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("api exposes action routes and scheduler status", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-actions-api-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BV1ACTAPI",
      aid: 40001,
      title: "Action API Video",
      ownerMid: 999,
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 11001,
      partTitle: "P1",
      durationSec: 10,
      isDeleted: false,
    });
    upsertSchedulerStatus(db, {
      schedulerKey: "main",
      status: "running",
      mode: "daemon",
      currentTasks: ["summary"],
      lastHeartbeatAt: new Date().toISOString(),
    });

    const app = await buildApiServer({
      dbPath,
      logger: false,
      webDistDir: path.join(tempRoot, "missing-web-dist"),
    });

    try {
      const schedulerResponse = await app.inject({
        method: "GET",
        url: "/api/scheduler/status",
      });
      assert.equal(schedulerResponse.statusCode, 200);
      assert.equal(schedulerResponse.json().status.healthy, true);

      const rebuildResponse = await app.inject({
        method: "POST",
        url: "/api/actions/pipeline/BV1ACTAPI/rebuild-publish-thread",
        payload: {
          confirm: true,
        },
      });
      assert.equal(rebuildResponse.statusCode, 200);
      assert.equal(rebuildResponse.json().ok, true);

      const auditsResponse = await app.inject({
        method: "GET",
        url: "/api/actions/audits?bvid=BV1ACTAPI",
      });
      assert.equal(auditsResponse.statusCode, 200);
      assert.equal(auditsResponse.json().items.length >= 1, true);
    } finally {
      await app.close();
    }
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("api exposes retry-failure batch action route", async () => {
  const app = await buildApiServer({
    logger: false,
    webDistDir: path.join(os.tmpdir(), "missing-web-dist"),
    services: {
      dashboardService: {
        close() {},
        getSummary() {
          return {
            activeCount: 0,
            failedCount24h: 0,
            succeededCount24h: 0,
            latestUpdatedAt: null,
          };
        },
        listActivePipelines() {
          return [];
        },
        listRecentRuns() {
          return [];
        },
        listFailureQueue() {
          return [];
        },
        listFailureGroups() {
          return [];
        },
        getOperationalHealth() {
          return {
            snapshot: {
              attentionCount: 0,
              criticalCount: 0,
              warningCount: 0,
              staleRunningCount: 0,
              schedulerHealthy: true,
              schedulerStatus: "running",
              schedulerLastHeartbeatAt: null,
              schedulerHeartbeatAgeMs: null,
            },
            items: [],
          };
        },
        getRunState() {
          return null;
        },
        getPipelineDetail() {
          return {
            video: null,
            parts: [],
            latestRun: null,
            recentRuns: [],
            recentEvents: [],
          };
        },
        listEventsAfterId() {
          return [];
        },
      } as any,
      operationsService: {
        close() {},
        listAudits() {
          return [];
        },
        runSummarySweep() {
          return Promise.resolve({ ok: true, auditId: 1, action: "summary-sweep", scope: "scheduler" });
        },
        runPublishSweep() {
          return Promise.resolve({ ok: true, auditId: 2, action: "publish-sweep", scope: "scheduler" });
        },
        retryPipeline() {
          return Promise.resolve({ ok: true, auditId: 3, action: "pipeline-retry", scope: "pipeline" });
        },
        retryRetryableFailures() {
          return Promise.resolve({
            ok: true,
            auditId: 4,
            action: "retry-failure-queue",
            scope: "pipeline",
            result: {
              triggered: 2,
              skipped: 1,
              failed: 0,
            },
          });
        },
        publishPipeline() {
          return Promise.resolve({ ok: true, auditId: 5, action: "pipeline-publish", scope: "pipeline" });
        },
        rebuildPublishThread() {
          return Promise.resolve({ ok: true, auditId: 6, action: "rebuild-publish-thread", scope: "publish" });
        },
      } as any,
      schedulerStatusService: {
        close() {},
        getStatus() {
          return {
            schedulerKey: "main",
            status: "running",
            healthy: true,
            mode: "daemon",
            timezone: "Asia/Shanghai",
            pid: 1,
            hostname: "test",
            summaryUsers: null,
            summaryConcurrency: 1,
            currentTasks: [],
            taskTimes: {},
            lastError: null,
            startedAt: null,
            lastHeartbeatAt: null,
            heartbeatAgeMs: null,
            updatedAt: null,
          };
        },
      } as any,
    },
  });

  try {
    const response = await app.inject({
      method: "POST",
      url: "/api/actions/retry-failures",
      payload: {
        confirm: true,
        limit: 5,
      },
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().ok, true);
    assert.equal(response.json().result.triggered, 2);
  } finally {
    await app.close();
  }
});
