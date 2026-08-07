import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildCommentStallNotification,
  evaluateCommentPublishStallState,
  getLatestCommentPublishActivityAt,
  getLatestSuccessfulCommentAt,
  listPendingCommentCandidates,
  runCommentPublishStallAlert,
} from "../src/domains/scheduler/comment-stall-alert";
import { insertPipelineEvent, openDatabase, upsertVideo, upsertVideoPart } from "../src/infra/db/index";

test("evaluateCommentPublishStallState alerts after one hour and deduplicates the incident", () => {
  const now = new Date("2026-08-04T12:00:00.000Z");
  const candidates = [{
    videoId: 1,
    bvid: "BVSTALL001",
    title: "Stalled Video",
    ownerMid: 1,
    pendingSummaryParts: 1,
    pendingPublishParts: 0,
    publishNeedsRebuild: false,
    firstPendingAt: "2026-08-04T10:30:00.000Z",
  }];

  const first = evaluateCommentPublishStallState({
    candidates,
    previousState: null,
    latestSuccessfulCommentAt: null,
    thresholdMinutes: 60,
    now,
  });
  assert.equal(first.shouldNotify, true);
  assert.equal(first.reason, "stalled");
  assert.equal(first.stalledMinutes, 90);

  const duplicate = evaluateCommentPublishStallState({
    candidates,
    previousState: {
      ...first.state!,
      notifiedAt: "2026-08-04T12:00:00.000Z",
    },
    latestSuccessfulCommentAt: null,
    thresholdMinutes: 60,
    now: new Date("2026-08-04T12:30:00.000Z"),
  });
  assert.equal(duplicate.shouldNotify, false);
  assert.equal(duplicate.reason, "already-notified");
});

test("a successful new comment resets the one-hour stall window", () => {
  const candidates = [{
    videoId: 1,
    bvid: "BVSTALL002",
    title: "Recovering Video",
    ownerMid: 1,
    pendingSummaryParts: 0,
    pendingPublishParts: 1,
    publishNeedsRebuild: false,
    firstPendingAt: "2026-08-04T10:00:00.000Z",
  }];

  const evaluation = evaluateCommentPublishStallState({
    candidates,
    previousState: {
      pendingSince: "2026-08-04T10:00:00.000Z",
      pendingBvids: ["BVSTALL002"],
      notifiedAt: "2026-08-04T11:00:00.000Z",
      lastSuccessfulCommentAt: null,
      lastPublishActivityAt: null,
      updatedAt: "2026-08-04T11:00:00.000Z",
    },
    latestSuccessfulCommentAt: "2026-08-04T11:45:00.000Z",
    thresholdMinutes: 60,
    now: new Date("2026-08-04T12:00:00.000Z"),
  });

  assert.equal(evaluation.shouldNotify, false);
  assert.equal(evaluation.reason, "within-threshold");
  assert.equal(evaluation.stalledMinutes, 15);
  assert.equal(evaluation.state?.notifiedAt, null);
});

test("pending candidates and successful comment events are read from SQLite", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-stall-storage-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVSTALL003",
      aid: 3003,
      title: "Database Candidate",
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 30031,
      partTitle: "P1",
      durationSec: 60,
      isDeleted: false,
    });

    const candidates = listPendingCommentCandidates(db);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].pendingSummaryParts, 1);

    insertPipelineEvent(db, {
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "publish",
      action: "comment-thread",
      status: "succeeded",
      details: {
        createdComments: 1,
      },
    });
    assert.ok(getLatestSuccessfulCommentAt(db));
    assert.ok(getLatestCommentPublishActivityAt(db));
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("recent publish activity resets the stall window even without a successful comment", () => {
  const evaluation = evaluateCommentPublishStallState({
    candidates: [{
      videoId: 1,
      bvid: "BVSTALLACTIVE",
      title: "Active Publish",
      ownerMid: 1,
      pendingSummaryParts: 0,
      pendingPublishParts: 1,
      publishNeedsRebuild: false,
      firstPendingAt: "2026-08-04T08:00:00.000Z",
    }],
    previousState: null,
    latestSuccessfulCommentAt: "2026-08-04T08:00:00.000Z",
    latestPublishActivityAt: "2026-08-04T11:55:00.000Z",
    thresholdMinutes: 120,
    now: new Date("2026-08-04T12:00:00.000Z"),
  });

  assert.equal(evaluation.shouldNotify, false);
  assert.equal(evaluation.reason, "within-threshold");
  assert.equal(evaluation.stalledMinutes, 5);
});

test("runCommentPublishStallAlert sends once and persists notification state", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-stall-run-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVSTALL004",
      aid: 4004,
      title: "Notification Candidate",
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 40041,
      partTitle: "P1",
      durationSec: 60,
      isDeleted: false,
    });
    db.prepare("UPDATE video_parts SET created_at = ? WHERE video_id = ?")
      .run("2026-08-04T10:00:00.000Z", video.id);
  } finally {
    db.close?.();
  }

  const sentTitles: string[] = [];
  const sendNotificationImpl = async ({ title }: { title: string }) => {
    sentTitles.push(title);
    return { ok: true, skipped: false } as const;
  };

  try {
    const first = await runCommentPublishStallAlert({
      dbPath,
      workRoot: "work",
      repoRoot: tempRoot,
      thresholdMinutes: 60,
      now: new Date("2026-08-04T12:00:00.000Z"),
      sendNotificationImpl,
    });
    assert.equal(first.notified, true);

    const second = await runCommentPublishStallAlert({
      dbPath,
      workRoot: "work",
      repoRoot: tempRoot,
      thresholdMinutes: 60,
      now: new Date("2026-08-04T12:10:00.000Z"),
      sendNotificationImpl,
    });
    assert.equal(second.notified, false);
    assert.equal(second.reason, "already-notified");
    assert.equal(sentTitles.length, 1);

    const payload = buildCommentStallNotification({
      candidates: first.candidates,
      state: first.state!,
      stalledMinutes: first.stalledMinutes,
    });
    assert.match(payload.desp, /BVSTALL004/u);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
