import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase, insertPipelineEvent, upsertVideo, upsertVideoPart } from "../scripts/lib/db/index";
import { createDashboardService } from "../packages/core/src/index";
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
