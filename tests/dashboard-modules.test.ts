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
  createConfigService,
  createDashboardService,
  createOperationsService,
  createSchedulerControlService,
  createSchedulerStatusService,
} from "../packages/core/src/index";
import { buildApiServer } from "../apps/api/src/app";
import { resolveSchedulerConfig } from "../scripts/lib/config/app-config";
import { resolveSummaryConfig } from "../scripts/lib/summary/config";

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

test("operations service can cancel a running pipeline and records audits", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-operations-cancel-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BV1CANCEL",
      aid: 30002,
      title: "Cancelable Video",
      ownerMid: 790,
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 10003,
      partTitle: "P1",
      durationSec: 10,
      isDeleted: false,
    });

    insertPipelineEvent(db, {
      runId: "run-cancel",
      triggerSource: "scheduler",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "pipeline",
      action: "run",
      status: "started",
      message: "Pipeline started",
    });

    const terminateCalls: Array<{ workRoot: string; bvid: string }> = [];
    const service = createOperationsService({
      dbPath,
      workRoot: "work",
      runtime: {
        terminateVideoPipelineLockOwner(args) {
          terminateCalls.push({
            workRoot: args.workRoot,
            bvid: args.bvid,
          });
          return {
            lockPath: path.join(tempRoot, "work", ".locks", "video-pipeline-BV1CANCEL.lock"),
            exists: true,
            stale: false,
            signalSent: true,
            owner: {
              pid: 123,
              bvid: args.bvid,
              videoTitle: "Cancelable Video",
              publishRequested: false,
              updatedAt: new Date().toISOString(),
            },
          };
        },
      },
    });

    try {
      const result = await service.cancelPipeline({
        bvid: "BV1CANCEL",
        reason: "manual-cancel",
      });

      assert.equal(result.ok, true);
      assert.equal(result.runId, "run-cancel");
      assert.deepEqual(terminateCalls, [{
        workRoot: "work",
        bvid: "BV1CANCEL",
      }]);
      assert.equal((result.result as { signalSent?: boolean }).signalSent, true);
      assert.equal((result.result as { ownerPid?: number | null }).ownerPid, 123);

      const audits = service.listAudits({
        bvid: "BV1CANCEL",
        limit: 10,
      });
      assert.equal(audits.length, 1);
      assert.equal(audits[0].action, "pipeline-cancel");
      assert.equal(audits[0].status, "succeeded");
    } finally {
      service.close();
    }
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("operations service blocks duplicate retry and publish actions while a pipeline is active", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-operations-idempotency-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BV1ACTIVE",
      aid: 30003,
      title: "Active Video",
      ownerMid: 791,
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 10004,
      partTitle: "P1",
      durationSec: 10,
      isDeleted: false,
    });

    insertPipelineEvent(db, {
      runId: "run-active-ops",
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
      runId: "run-active-ops",
      triggerSource: "scheduler",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "subtitle",
      action: "asr",
      status: "started",
      message: "ASR started",
    });

    let pipelineRuns = 0;
    const service = createOperationsService({
      dbPath,
      services: {
        pipelineService: {
          runPipeline() {
            pipelineRuns += 1;
            return {
              ok: true,
              runId: "should-not-run",
            };
          },
        } as any,
      },
    });

    try {
      const retryResult = await service.retryPipeline({
        bvid: "BV1ACTIVE",
      });
      const publishResult = await service.publishPipeline({
        bvid: "BV1ACTIVE",
        confirm: true,
      });

      assert.equal(retryResult.ok, false);
      assert.match(String(retryResult.errorMessage), /already running/u);
      assert.equal(publishResult.ok, false);
      assert.match(String(publishResult.errorMessage), /already running/u);
      assert.equal(pipelineRuns, 0);

      const audits = service.listAudits({
        bvid: "BV1ACTIVE",
        limit: 10,
      });
      assert.equal(audits.length, 2);
      assert.equal(audits.every((item) => item.status === "failed"), true);
      assert.equal(
        audits.some((item) => item.action === "pipeline-retry" && String(item.errorMessage).includes("already running")),
        true,
      );
      assert.equal(
        audits.some((item) => item.action === "pipeline-publish" && String(item.errorMessage).includes("already running")),
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

test("dashboard service surfaces cancelled runs in recent and detail views", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-dashboard-cancelled-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BV1CANCELLED",
      aid: 50010,
      title: "Cancelled Video",
      ownerMid: 1004,
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 18001,
      partTitle: "P1",
      durationSec: 10,
      isDeleted: false,
    });

    insertPipelineEvent(db, {
      runId: "run-cancelled",
      triggerSource: "web",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "pipeline",
      action: "run",
      status: "started",
      message: "Pipeline started",
    });
    insertPipelineEvent(db, {
      runId: "run-cancelled",
      triggerSource: "web",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "pipeline",
      action: "run",
      status: "cancelled",
      message: "Pipeline cancelled by SIGTERM",
    });

    const service = createDashboardService({
      dbPath,
    });

    try {
      const recent = service.listRecentRuns({
        statuses: ["cancelled"],
      });
      const detail = service.getPipelineDetail("BV1CANCELLED");

      assert.equal(recent.length, 1);
      assert.equal(recent[0].runId, "run-cancelled");
      assert.equal(recent[0].runStatus, "cancelled");
      assert.equal(recent[0].currentStage, "pipeline-cancelled");

      assert.equal(detail.latestRun?.runId, "run-cancelled");
      assert.equal(detail.latestRun?.runStatus, "cancelled");
      assert.equal(detail.latestRun?.currentStage, "pipeline-cancelled");
    } finally {
      service.close();
    }
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("config service persists managed settings and runtime resolvers consume database overrides", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-config-service-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");

  const service = createConfigService({
    dbPath,
  });

  try {
    const updateResult = await service.updateSettings({
      patch: {
        scheduler: {
          summaryUsers: "123,456",
          summaryConcurrency: 7,
          summarySinceHours: 36,
          timezone: "Asia/Shanghai",
          summaryCron: "15 * * * *",
          publishCron: "25 * * * *",
        },
        summary: {
          model: "gpt-config-test",
          promptConfigPath: "config/custom-prompts.json",
        },
        publish: {
          appendCooldownMinMs: 1000,
          appendCooldownMaxMs: 2000,
          rebuildCooldownMinMs: 3000,
          rebuildCooldownMaxMs: 4500,
        },
      },
    });

    assert.equal(updateResult.ok, true);
    assert.equal(
      (updateResult.result as { changedKeys?: string[] }).changedKeys?.includes("scheduler.summaryUsers"),
      true,
    );

    const config = service.getConfig();
    assert.equal(config.settings.scheduler.summaryUsers, "123,456");
    assert.equal(config.settings.scheduler.summaryConcurrency, 7);
    assert.equal(config.settings.scheduler.summaryCron, "15 * * * *");
    assert.equal(config.settings.summary.model, "gpt-config-test");
    assert.equal(config.settings.publish.appendCooldownMinMs, 1000);
    assert.equal(config.schedule.timezone, "Asia/Shanghai");
    assert.equal(config.schedule.tasks.length >= 6, true);
    assert.equal(config.schedule.tasks.find((item) => item.key === "summary")?.cron, "15 * * * *");

    const schedulerConfig = resolveSchedulerConfig({
      db: dbPath,
    });
    assert.equal(schedulerConfig.summaryUsers, "123,456");
    assert.equal(schedulerConfig.summaryConcurrency, 7);
    assert.equal(schedulerConfig.summarySinceHours, 36);
    assert.equal(schedulerConfig.timezone, "Asia/Shanghai");
    assert.equal(schedulerConfig.summaryCron, "15 * * * *");
    assert.equal(schedulerConfig.publishCron, "25 * * * *");

    const summaryConfig = resolveSummaryConfig({
      db: dbPath,
    }, {
      SUMMARY_API_KEY: "key-123",
    });
    assert.equal(summaryConfig.model, "gpt-config-test");
    assert.equal(summaryConfig.promptConfigPath, "config/custom-prompts.json");
    assert.equal(summaryConfig.apiKey, "key-123");

    const auditDb = openDatabase(dbPath);
    try {
      const audits = auditDb.prepare("SELECT COUNT(*) AS count FROM operation_audits WHERE action = 'config-update'").get() as { count: number };
      assert.equal(audits.count >= 1, true);
    } finally {
      auditDb.close?.();
    }
  } finally {
    service.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("config service exposes config history and can roll back to an earlier snapshot", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-config-rollback-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const service = createConfigService({
    dbPath,
  });

  try {
    const first = await service.updateSettings({
      patch: {
        scheduler: {
          summaryConcurrency: 3,
        },
        summary: {
          model: "gpt-first",
        },
      },
    });
    const second = await service.updateSettings({
      patch: {
        scheduler: {
          summaryConcurrency: 8,
        },
        summary: {
          model: "gpt-second",
        },
      },
    });

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);

    const rollback = await service.rollbackToAudit({
      auditId: first.auditId,
    });
    assert.equal(rollback.ok, true);
    assert.equal((rollback.result as { restoredFromAuditId?: number | null }).restoredFromAuditId, first.auditId);

    const schedulerConfig = resolveSchedulerConfig({
      db: dbPath,
    });
    const summaryConfig = resolveSummaryConfig({
      db: dbPath,
    }, {
      SUMMARY_API_KEY: "key-123",
    });
    assert.equal(schedulerConfig.summaryConcurrency, 3);
    assert.equal(summaryConfig.model, "gpt-first");

    const history = service.listHistory({
      limit: 10,
    });
    assert.equal(history.length >= 3, true);
    assert.equal(history[0].action, "config-rollback");
    assert.equal(history.some((item) => item.id === first.auditId && item.action === "config-update"), true);
  } finally {
    service.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("scheduler control service requests daemon restart by signaling the recorded pid", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-scheduler-restart-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    upsertSchedulerStatus(db, {
      schedulerKey: "main",
      status: "running",
      mode: "daemon",
      pid: 4321,
      hostname: "host",
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    });

    const signals: Array<{ pid: number; signal: NodeJS.Signals | number }> = [];
    const service = createSchedulerControlService({
      dbPath,
      runtime: {
        signalProcess(pid, signal) {
          signals.push({
            pid,
            signal,
          });
        },
      },
    });

    try {
      const result = service.requestRestart();
      assert.equal(result.ok, true);
      assert.equal(result.ownerPid, 4321);
      assert.equal(result.signalSent, true);
      assert.deepEqual(signals, [
        {
          pid: 4321,
          signal: 0,
        },
        {
          pid: 4321,
          signal: "SIGTERM",
        },
      ]);
    } finally {
      service.close();
    }
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("scheduler status storage refreshes started_at when the daemon restarts", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-scheduler-started-at-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const firstStartedAt = "2026-05-01T00:00:00.000Z";
    const secondStartedAt = "2026-05-01T01:00:00.000Z";

    upsertSchedulerStatus(db, {
      schedulerKey: "main",
      status: "running",
      mode: "daemon",
      pid: 111,
      startedAt: firstStartedAt,
      lastHeartbeatAt: firstStartedAt,
    });
    const row = upsertSchedulerStatus(db, {
      schedulerKey: "main",
      status: "running",
      mode: "daemon",
      pid: 222,
      startedAt: secondStartedAt,
      lastHeartbeatAt: secondStartedAt,
    });

    assert.equal(row?.started_at, secondStartedAt);
    assert.equal(row?.pid, 222);
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
      configService: {
        close() {},
        getConfig() {
          return {
            settings: {
              scheduler: {
                authFile: ".auth/bili-auth.json",
                cookieFile: null,
                timezone: "Asia/Shanghai",
                summaryUsers: "",
                summarySinceHours: 24,
                summaryConcurrency: 1,
                retryFailuresLimit: 3,
                retryFailuresSinceHours: 168,
                retryFailuresMaxRecent: 1,
                retryFailuresWindowHours: 6,
                refreshDays: 30,
                cleanupDays: 2,
                gapCheckSinceHours: 24,
                gapThresholdSeconds: 5,
              },
              summary: {
                model: "gpt-test",
                apiBaseUrl: "https://api.openai.com/v1",
                apiFormat: "auto",
                promptConfigPath: "config/summary-prompts.json",
              },
              publish: {
                appendCooldownMinMs: 15000,
                appendCooldownMaxMs: 30000,
                rebuildCooldownMinMs: 15000,
                rebuildCooldownMaxMs: 30000,
              },
            },
            definitions: [],
            schedule: {
              timezone: "Asia/Shanghai",
              tasks: [],
            },
          };
        },
        listHistory() {
          return [];
        },
        updateSettings() {
          return Promise.resolve({ ok: true, auditId: 10, action: "config-update", scope: "config", result: {} });
        },
        rollbackToAudit() {
          return Promise.resolve({ ok: true, auditId: 11, action: "config-rollback", scope: "config", result: {} });
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
        restartScheduler({ confirm }: { confirm?: boolean }) {
          if (!confirm) {
            return Promise.resolve({
              ok: false,
              auditId: 7,
              action: "scheduler-restart",
              scope: "scheduler",
              errorMessage: "Confirmation required for scheduler restart",
            });
          }

          return Promise.resolve({
            ok: true,
            auditId: 7,
            action: "scheduler-restart",
            scope: "scheduler",
            result: {
              signalSent: true,
              ownerPid: 2468,
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

    const restartResponse = await app.inject({
      method: "POST",
      url: "/api/scheduler/restart",
      payload: {
        confirm: true,
      },
    });
    assert.equal(restartResponse.statusCode, 200);
    assert.equal(restartResponse.json().ok, true);
    assert.equal(restartResponse.json().result.ownerPid, 2468);
  } finally {
    await app.close();
  }
});

test("api exposes cancel action and maps running-pipeline conflicts to 409", async () => {
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
      configService: {
        close() {},
        getConfig() {
          return {
            settings: {
              scheduler: {
                authFile: ".auth/bili-auth.json",
                cookieFile: null,
                timezone: "Asia/Shanghai",
                summaryUsers: "",
                summarySinceHours: 24,
                summaryConcurrency: 1,
                retryFailuresLimit: 3,
                retryFailuresSinceHours: 168,
                retryFailuresMaxRecent: 1,
                retryFailuresWindowHours: 6,
                refreshDays: 30,
                cleanupDays: 2,
                gapCheckSinceHours: 24,
                gapThresholdSeconds: 5,
              },
              summary: {
                model: "gpt-test",
                apiBaseUrl: "https://api.openai.com/v1",
                apiFormat: "auto",
                promptConfigPath: "config/summary-prompts.json",
              },
              publish: {
                appendCooldownMinMs: 15000,
                appendCooldownMaxMs: 30000,
                rebuildCooldownMinMs: 15000,
                rebuildCooldownMaxMs: 30000,
              },
            },
            definitions: [],
            schedule: {
              timezone: "Asia/Shanghai",
              tasks: [],
            },
          };
        },
        listHistory() {
          return [];
        },
        updateSettings() {
          return Promise.resolve({ ok: true, auditId: 10, action: "config-update", scope: "config", result: {} });
        },
        rollbackToAudit() {
          return Promise.resolve({ ok: true, auditId: 11, action: "config-rollback", scope: "config", result: {} });
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
          return Promise.resolve({
            ok: false,
            auditId: 3,
            action: "pipeline-retry",
            scope: "pipeline",
            errorMessage: "Cannot retry pipeline while it is already running: BV1CONFLICT",
          });
        },
        cancelPipeline() {
          return Promise.resolve({
            ok: true,
            auditId: 4,
            action: "pipeline-cancel",
            scope: "pipeline",
            result: {
              signalSent: true,
              ownerPid: 321,
            },
          });
        },
        retryRetryableFailures() {
          return Promise.resolve({
            ok: true,
            auditId: 5,
            action: "retry-failure-queue",
            scope: "pipeline",
            result: {
              triggered: 1,
              skipped: 0,
              failed: 0,
            },
          });
        },
        publishPipeline() {
          return Promise.resolve({
            ok: false,
            auditId: 6,
            action: "pipeline-publish",
            scope: "pipeline",
            errorMessage: "Cannot publish pipeline while it is already running: BV1CONFLICT",
          });
        },
        rebuildPublishThread() {
          return Promise.resolve({ ok: true, auditId: 7, action: "rebuild-publish-thread", scope: "publish" });
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
    const cancelResponse = await app.inject({
      method: "POST",
      url: "/api/actions/pipeline/BV1CONFLICT/cancel",
      payload: {
        reason: "manual-cancel",
      },
    });
    assert.equal(cancelResponse.statusCode, 200);
    assert.equal(cancelResponse.json().ok, true);
    assert.equal(cancelResponse.json().result.ownerPid, 321);

    const retryResponse = await app.inject({
      method: "POST",
      url: "/api/actions/pipeline/BV1CONFLICT/retry",
      payload: {},
    });
    assert.equal(retryResponse.statusCode, 409);

    const publishResponse = await app.inject({
      method: "POST",
      url: "/api/actions/pipeline/BV1CONFLICT/publish",
      payload: {
        confirm: true,
      },
    });
    assert.equal(publishResponse.statusCode, 409);
  } finally {
    await app.close();
  }
});

test("api exposes managed settings routes with validation and persistence", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-settings-api-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const app = await buildApiServer({
    dbPath,
    logger: false,
    webDistDir: path.join(tempRoot, "missing-web-dist"),
  });

  try {
    const initialResponse = await app.inject({
      method: "GET",
      url: "/api/settings",
    });
    assert.equal(initialResponse.statusCode, 200);
    assert.equal(initialResponse.json().ok, true);
    assert.equal(Array.isArray(initialResponse.json().definitions), true);
    assert.equal(Array.isArray(initialResponse.json().schedule.tasks), true);

    const invalidResponse = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        publish: {
          appendCooldownMinMs: 5000,
          appendCooldownMaxMs: 1000,
        },
        scheduler: {
          summaryCron: "not-a-cron",
        },
      },
    });
    assert.equal(invalidResponse.statusCode, 400);
    assert.equal(invalidResponse.json().ok, false);

    const updateResponse = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        scheduler: {
          summaryUsers: "123,456",
          summaryConcurrency: 9,
          timezone: "Asia/Shanghai",
          summaryCron: "12 * * * *",
        },
        summary: {
          model: "gpt-settings-api",
        },
      },
    });
    assert.equal(updateResponse.statusCode, 200);
    assert.equal(updateResponse.json().ok, true);
    assert.equal(updateResponse.json().result.settings.scheduler.summaryConcurrency, 9);
    assert.equal(updateResponse.json().result.schedule.tasks.find((item: { key: string; cron: string }) => item.key === "summary")?.cron, "12 * * * *");
    const firstAuditId = updateResponse.json().auditId;

    const secondUpdateResponse = await app.inject({
      method: "PUT",
      url: "/api/settings",
      payload: {
        scheduler: {
          summaryConcurrency: 4,
        },
        summary: {
          model: "gpt-settings-api-v2",
        },
      },
    });
    assert.equal(secondUpdateResponse.statusCode, 200);
    assert.equal(secondUpdateResponse.json().ok, true);

    const afterResponse = await app.inject({
      method: "GET",
      url: "/api/settings",
    });
    assert.equal(afterResponse.statusCode, 200);
    assert.equal(afterResponse.json().settings.scheduler.summaryUsers, "123,456");
    assert.equal(afterResponse.json().settings.summary.model, "gpt-settings-api-v2");
    assert.equal(afterResponse.json().schedule.timezone, "Asia/Shanghai");
    assert.equal(afterResponse.json().schedule.tasks.find((item: { key: string; cron: string }) => item.key === "summary")?.cron, "12 * * * *");

    const historyResponse = await app.inject({
      method: "GET",
      url: "/api/settings/history?limit=10",
    });
    assert.equal(historyResponse.statusCode, 200);
    assert.equal(historyResponse.json().ok, true);
    assert.equal(historyResponse.json().items.length >= 2, true);

    const rollbackResponse = await app.inject({
      method: "POST",
      url: "/api/settings/rollback",
      payload: {
        auditId: firstAuditId,
      },
    });
    assert.equal(rollbackResponse.statusCode, 200);
    assert.equal(rollbackResponse.json().ok, true);

    const afterRollbackResponse = await app.inject({
      method: "GET",
      url: "/api/settings",
    });
    assert.equal(afterRollbackResponse.statusCode, 200);
    assert.equal(afterRollbackResponse.json().settings.scheduler.summaryConcurrency, 9);
    assert.equal(afterRollbackResponse.json().settings.summary.model, "gpt-settings-api");
  } finally {
    await app.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
