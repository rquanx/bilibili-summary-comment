import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../scripts/lib/db/database";
import { getVideoByIdentity, listVideoParts, upsertVideo, upsertVideoPart } from "../scripts/lib/db/video-storage";
import { postSummaryThread } from "../scripts/lib/bili/comment-thread";

test("postSummaryThread keeps publishing when pinning a new root comment fails", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-thread-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVcomment123456",
      aid: 123456789,
      title: "Comment Thread Test",
      pageCount: 2,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P>\nfirst page",
      summaryHash: "hash-1",
      published: false,
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 2,
      cid: 202,
      partTitle: "P2",
      durationSec: 10,
      summaryText: "<2P>\nsecond page",
      summaryHash: "hash-2",
      published: false,
      isDeleted: false,
    });

    const calls = [];
    let nextRpid = 800001;
    const topError = Object.assign(new Error("啥都木有"), {
      code: -404,
      statusCode: 200,
      path: "https://api.bilibili.com/x/v2/reply/top",
      method: "post",
      rawResponse: {
        data: {
          code: -404,
          message: "啥都木有",
        },
      },
    });
    const client = {
      reply: {
        async add(payload) {
          calls.push({ type: "add", payload });
          return {
            rpid: nextRpid++,
          };
        },
        async top(payload) {
          calls.push({ type: "top", payload });
          throw topError;
        },
      },
    };

    const result = await postSummaryThread({
      client,
      oid: video.aid,
      type: 1,
      message: ["<1P>", "first page", "", "<2P>", "second page"].join("\n"),
      db,
      videoId: video.id,
      topCommentState: {
        hasTopComment: false,
        topComment: null,
      },
    });

    assert.equal(result.rootCommentRpid, 800001);
    assert.equal(result.createdComments.length, 2);
    assert.deepEqual(result.createdComments.map((item) => item.rpid), [800001, 800002]);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].step, "top-root-comment");
    assert.equal(result.warnings[0].code, -404);
    assert.deepEqual(result.warnings[0].responseData, {
      code: -404,
      message: "啥都木有",
    });

    const topCalls = calls.filter((entry) => entry.type === "top");
    assert.equal(topCalls.length, 2);

    const persistedVideo = getVideoByIdentity(db, { bvid: "BVcomment123456" });
    assert.equal(persistedVideo?.root_comment_rpid, 800001);
    assert.equal(persistedVideo?.top_comment_rpid, 800001);

    const parts = listVideoParts(db, video.id);
    assert.deepEqual(parts.map((part) => part.published), [1, 1]);
    assert.deepEqual(parts.map((part) => part.published_comment_rpid), [800001, 800001]);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
