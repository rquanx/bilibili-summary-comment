import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../scripts/lib/db/database";
import { getVideoByIdentity, upsertVideo } from "../scripts/lib/db/video-storage";
import { probePublishedCommentThreadHealth } from "../scripts/lib/video/pipeline-runner";

test("probePublishedCommentThreadHealth marks a missing stored root thread for rebuild", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-healthcheck-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const loggedEvents: Array<Record<string, unknown>> = [];
  const progressMessages: string[] = [];

  try {
    const video = upsertVideo(db, {
      bvid: "BVHEALTHCHECKMISS",
      aid: 123456,
      title: "Healthcheck Missing Root",
      pageCount: 1,
      rootCommentRpid: 300001,
      topCommentRpid: 300001,
    });

    const result = await probePublishedCommentThreadHealth({
      client: {} as never,
      db,
      video,
      oid: video.aid,
      type: 1,
      eventLogger: {
        log(event) {
          loggedEvents.push(event as Record<string, unknown>);
        },
      } as never,
      progress: {
        warn(message: string) {
          progressMessages.push(message);
        },
      } as never,
      getTopCommentImpl: async () => ({
        oid: video.aid,
        type: 1,
        hasTopComment: false,
        topComment: null,
        raw: null,
      }),
    });

    assert.equal(result.checked, true);
    assert.equal(result.needsRebuild, true);
    assert.equal(video.publish_needs_rebuild, 1);
    assert.equal(video.publish_rebuild_reason, "missing-root-comment-thread");

    const persistedVideo = getVideoByIdentity(db, { bvid: video.bvid, aid: video.aid });
    assert.equal(Number(persistedVideo?.publish_needs_rebuild), 1);
    assert.equal(persistedVideo?.publish_rebuild_reason, "missing-root-comment-thread");

    assert.equal(loggedEvents.length, 1);
    assert.equal(loggedEvents[0].action, "comment-thread-healthcheck");
    assert.equal(loggedEvents[0].status, "failed");
    assert.deepEqual(progressMessages, [
      "Stored root comment thread is missing, marked for rebuild on the next publish run",
    ]);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("probePublishedCommentThreadHealth skips videos without a stored root thread", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-healthcheck-skip-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  let called = false;

  try {
    const video = upsertVideo(db, {
      bvid: "BVHEALTHCHECKSKIP",
      aid: 123457,
      title: "Healthcheck Skip",
      pageCount: 1,
      rootCommentRpid: null,
      topCommentRpid: null,
    });

    const result = await probePublishedCommentThreadHealth({
      client: {} as never,
      db,
      video,
      oid: video.aid,
      type: 1,
      getTopCommentImpl: async () => {
        called = true;
        return {
          oid: video.aid,
          type: 1,
          hasTopComment: false,
          topComment: null,
          raw: null,
        };
      },
    });

    assert.equal(result.checked, false);
    assert.equal(result.needsRebuild, false);
    assert.equal(called, false);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
