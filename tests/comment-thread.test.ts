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
  const firstPageText = `first page ${"A".repeat(640)}`;
  const secondPageText = `second page ${"B".repeat(640)}`;

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
      summaryText: `<1P>\n${firstPageText}`,
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
      summaryText: `<2P>\n${secondPageText}`,
      summaryHash: "hash-2",
      published: false,
      isDeleted: false,
    });

    const calls = [];
    let nextRpid = 800001;
    const topError = Object.assign(new Error("\u5565\u90fd\u6728\u6709"), {
      code: -404,
      statusCode: 200,
      path: "https://api.bilibili.com/x/v2/reply/top",
      method: "post",
      rawResponse: {
        data: {
          code: -404,
          message: "\u5565\u90fd\u6728\u6709",
        },
      },
    });
    const client = {
      reply: {
        async list() {
          calls.push({ type: "list" });
          return {
            page: {
              count: 1,
            },
            replies: [
              {
                rpid: 800001,
                count: 1,
                replies: [
                  {
                    rpid: 800002,
                  },
                ],
              },
            ],
          };
        },
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
      message: ["<1P>", firstPageText, "", "<2P>", secondPageText].join("\n"),
      db,
      videoId: video.id,
      topCommentState: {
        hasTopComment: false,
        topComment: null,
      },
      sleepImpl: async () => {},
    });

    assert.equal(result.rootCommentRpid, 800001);
    assert.equal(result.createdComments.length, 2);
    assert.deepEqual(result.createdComments.map((item) => item.rpid), [800001, 800002]);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].step, "top-root-comment");
    assert.equal(result.warnings[0].code, -404);
    assert.deepEqual(result.warnings[0].responseData, {
      code: -404,
      message: "\u5565\u90fd\u6728\u6709",
    });

    const topCalls = calls.filter((entry) => entry.type === "top");
    assert.equal(topCalls.length, 2);
    assert.equal(calls.filter((entry) => entry.type === "list").length, 3);

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

test("postSummaryThread splits comments so each payload stays within 700 characters", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-thread-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const firstPageText = `first page ${"A".repeat(340)}`;
  const secondPageText = `second page ${"B".repeat(340)}`;

  try {
    const video = upsertVideo(db, {
      bvid: "BVcomment700limit",
      aid: 123456790,
      title: "Comment Thread 700 Limit Test",
      pageCount: 2,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: `<1P>\n${firstPageText}`,
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
      summaryText: `<2P>\n${secondPageText}`,
      summaryHash: "hash-2",
      published: false,
      isDeleted: false,
    });

    const addCalls = [];
    let nextRpid = 830001;
    const client = {
      reply: {
        async list() {
          return {
            page: {
              count: 1,
            },
            replies: [
              {
                rpid: 830001,
                count: 1,
                replies: [
                  {
                    rpid: 830002,
                  },
                ],
              },
            ],
          };
        },
        async add(payload) {
          addCalls.push(payload);
          return {
            rpid: nextRpid++,
          };
        },
        async top() {
          return {
            ok: true,
          };
        },
      },
    };

    const result = await postSummaryThread({
      client,
      oid: video.aid,
      type: 1,
      message: ["<1P>", firstPageText, "", "<2P>", secondPageText].join("\n"),
      db,
      videoId: video.id,
      topCommentState: {
        hasTopComment: false,
        topComment: null,
      },
      sleepImpl: async () => {},
    });

    assert.equal(result.createdComments.length, 2);
    assert.deepEqual(result.createdComments.map((item) => item.pages), [[1], [2]]);
    assert.equal(addCalls.length, 2);
    assert.ok(addCalls.every((payload) => payload.message.length <= 700));
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("postSummaryThread does not mark parts published when the new comment thread is not visible", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-thread-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVcommentInvisible",
      aid: 123450001,
      title: "Invisible Comment Thread Test",
      pageCount: 1,
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

    const client = {
      reply: {
        async list() {
          return {
            page: {
              count: 0,
            },
            replies: null,
            upper: {
              top: null,
            },
            top: null,
          };
        },
        async add() {
          return {
            rpid: 910001,
          };
        },
        async top() {
          return {
            ok: true,
          };
        },
      },
    };

    await assert.rejects(
      () =>
        postSummaryThread({
          client,
          oid: video.aid,
          type: 1,
          message: "<1P>\nfirst page",
          db,
          videoId: video.id,
          topCommentState: {
            hasTopComment: false,
            topComment: null,
          },
          sleepImpl: async () => {},
        }),
      (error) => {
        assert.ok(error && typeof error === "object");
        const candidate = error as { message?: unknown; details?: Record<string, unknown> };
        assert.equal(candidate.message, "Published comment thread is not visible on the video page");
        assert.equal(candidate.details?.rootRpid, 910001);
        assert.equal(candidate.details?.pageCount, 0);
        assert.equal(candidate.details?.foundRootComment, false);
        return true;
      },
    );

    const persistedVideo = getVideoByIdentity(db, { bvid: "BVcommentInvisible" });
    assert.equal(persistedVideo?.root_comment_rpid, null);
    assert.equal(persistedVideo?.top_comment_rpid, null);

    const parts = listVideoParts(db, video.id);
    assert.deepEqual(parts.map((part) => part.published), [0]);
    assert.deepEqual(parts.map((part) => part.published_comment_rpid), [null]);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("postSummaryThread rejects threads that disappear before the final visibility check", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-thread-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  let listCallCount = 0;

  try {
    const video = upsertVideo(db, {
      bvid: "BVcommentTransient",
      aid: 123450002,
      title: "Transient Comment Thread Test",
      pageCount: 1,
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

    const client = {
      reply: {
        async list() {
          listCallCount += 1;
          if (listCallCount === 1) {
            return {
              page: {
                count: 1,
              },
              upper: {
                top: {
                  rpid: 920001,
                  count: 0,
                },
              },
            };
          }

          return {
            page: {
              count: 0,
            },
            replies: null,
            upper: {
              top: null,
            },
            top: null,
          };
        },
        async add() {
          return {
            rpid: 920001,
          };
        },
        async top() {
          return {
            ok: true,
          };
        },
      },
    };

    await assert.rejects(
      () =>
        postSummaryThread({
          client,
          oid: video.aid,
          type: 1,
          message: "<1P>\nfirst page",
          db,
          videoId: video.id,
          topCommentState: {
            hasTopComment: false,
            topComment: null,
          },
          sleepImpl: async () => {},
        }),
      /Published comment thread is not visible on the video page/u,
    );

    const persistedVideo = getVideoByIdentity(db, { bvid: "BVcommentTransient" });
    assert.equal(persistedVideo?.root_comment_rpid, null);
    assert.equal(persistedVideo?.top_comment_rpid, null);
    assert.equal(listCallCount, 3);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
