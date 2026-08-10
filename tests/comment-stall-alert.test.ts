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

test("runCommentPublishStallAlert ignores videos that only need summaries", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-stall-summary-only-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVSTALLSUMMARY",
      aid: 4003,
      title: "Summary Only Candidate",
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 40031,
      partTitle: "P1",
      durationSec: 60,
      isDeleted: false,
    });
    db.prepare("UPDATE video_parts SET created_at = ? WHERE video_id = ?")
      .run("2026-08-04T10:00:00.000Z", video.id);
  } finally {
    db.close?.();
  }

  let notificationCount = 0;
  try {
    const result = await runCommentPublishStallAlert({
      dbPath,
      workRoot: "work",
      repoRoot: tempRoot,
      thresholdMinutes: 60,
      now: new Date("2026-08-04T12:00:00.000Z"),
      sendNotificationImpl: async () => {
        notificationCount += 1;
        return { ok: true, skipped: false } as const;
      },
    });

    assert.equal(result.notified, false);
    assert.equal(result.reason, "no-pending-videos");
    assert.deepEqual(result.candidates, []);
    assert.equal(notificationCount, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("runCommentPublishStallAlert restarts timing when a failure cooldown expires", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-stall-cooldown-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVSTALLCOOLDOWN",
      aid: 4005,
      title: "Cooldown Candidate",
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 40051,
      partTitle: "P1",
      durationSec: 60,
      summaryText: "<1P>\n1#00:00 ready to retry",
      summaryHash: "hash-40051",
      published: false,
      isDeleted: false,
    });
    db.prepare("UPDATE video_parts SET created_at = ? WHERE video_id = ?")
      .run("2026-08-04T01:00:00.000Z", video.id);
    insertPipelineEvent(db, {
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      scope: "publish",
      action: "comment-thread",
      status: "failed",
      message: "已经被删除了",
      details: {
        code: 12022,
        failedStep: "publish",
        failedScope: "publish",
        failedAction: "comment-thread",
      },
    });
    db.prepare(`
      UPDATE pipeline_events
      SET created_at = ?
      WHERE bvid = ? AND scope = 'publish' AND action = 'comment-thread'
    `).run("2026-08-04T05:00:00.000Z", video.bvid);
  } finally {
    db.close?.();
  }

  let notificationCount = 0;
  const sendNotificationImpl = async () => {
    notificationCount += 1;
    return { ok: true, skipped: false } as const;
  };

  try {
    const justExpired = await runCommentPublishStallAlert({
      dbPath,
      workRoot: "work",
      repoRoot: tempRoot,
      thresholdMinutes: 120,
      now: new Date("2026-08-04T11:01:00.000Z"),
      sendNotificationImpl,
    });
    assert.equal(justExpired.notified, false);
    assert.equal(justExpired.reason, "within-threshold");
    assert.equal(justExpired.stalledMinutes, 1);
    assert.equal(justExpired.state?.pendingSince, "2026-08-04T11:00:00.000Z");

    const thresholdReached = await runCommentPublishStallAlert({
      dbPath,
      workRoot: "work",
      repoRoot: tempRoot,
      thresholdMinutes: 120,
      now: new Date("2026-08-04T13:00:00.000Z"),
      sendNotificationImpl,
    });
    assert.equal(thresholdReached.notified, true);
    assert.equal(thresholdReached.stalledMinutes, 120);
    assert.equal(notificationCount, 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
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
      summaryText: "<1P>\n1#00:00 ready to publish",
      summaryHash: "hash-40041",
      published: false,
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
