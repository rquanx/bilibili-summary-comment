import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
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

    const service = createDashboardService({
      dbPath,
    });

    try {
      const active = service.listActivePipelines();
      const recent = service.listRecentRuns({
        statuses: ["failed"],
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

      assert.equal(recent.length, 1);
      assert.equal(recent[0].runId, "run-failed");
      assert.equal(recent[0].failedStep, "summary");
      assert.equal(recent[0].lastErrorMessage, "LLM blocked");

      assert.equal(detail.video?.bvid, "BV1DASHBOARD");
      assert.equal(detail.parts.length, 1);
      assert.equal(detail.recentRuns.length >= 2, true);
      assert.equal(detail.recentEvents.length >= 4, true);

      assert.equal(summary.activeCount, 1);
      assert.equal(summary.failedCount24h, 1);
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
