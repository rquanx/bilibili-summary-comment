import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../scripts/lib/db/database";
import { getVideoByIdentity, listVideoParts, upsertVideo, upsertVideoPart } from "../scripts/lib/db/video-storage";
import { postSummaryThread } from "../scripts/lib/bili/comment-thread";

function createJsonFetchResponse(data) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        code: 0,
        data,
      };
    },
  };
}

function createGuestCommentHarness({
  startRpid,
  visibilityRule = (_message) => true,
}) {
  const comments = new Map();
  let nextRpid = startRpid;
  let pinnedRootRpid = null;

  function setCommentVisible(rpid, visible) {
    const comment = comments.get(rpid);
    if (!comment) {
      return;
    }

    comment.visible = visible;
  }

  function createCommentNode(comment) {
    return {
      rpid: comment.rpid,
      count: [...comments.values()].filter((item) => item.visible && item.root === comment.rpid && item.rpid !== comment.rpid).length,
      content: {
        message: comment.message,
      },
      replies: [...comments.values()]
        .filter((item) => item.visible && item.root === comment.rpid && item.rpid !== comment.rpid)
        .map((item) => ({
          rpid: item.rpid,
          root: item.root,
          parent: item.parent,
          content: {
            message: item.message,
          },
        })),
    };
  }

  async function fetchImpl(url, options: any = {}) {
    const normalizedUrl = new URL(String(url));
    if (normalizedUrl.hostname === "paste.rs" && String(options.method ?? "GET").toUpperCase() === "POST") {
      const bodyText = String(options.body ?? "");
      return {
        ok: true,
        status: 200,
        async text() {
          if (bodyText.includes("哈哈哈")) {
            return "https://paste.rs/hahaha";
          }
          if (bodyText.includes("啊啊啊")) {
            return "https://paste.rs/aaaaaa";
          }
          return `https://paste.rs/${Buffer.from(bodyText).toString("hex").slice(0, 8)}`;
        },
      };
    }

    if (normalizedUrl.pathname === "/x/v2/reply") {
      const visibleRoots = [...comments.values()]
        .filter((comment) => comment.visible && comment.root === comment.rpid)
        .sort((left, right) => left.rpid - right.rpid);
      const pinned = pinnedRootRpid ? visibleRoots.find((comment) => comment.rpid === pinnedRootRpid) ?? null : null;
      const replies = visibleRoots
        .filter((comment) => comment.rpid !== pinnedRootRpid)
        .map(createCommentNode);
      return createJsonFetchResponse({
        page: {
          count: visibleRoots.length,
        },
        upper: {
          top: pinned ? createCommentNode(pinned) : null,
        },
        replies,
      });
    }

    if (normalizedUrl.pathname === "/x/v2/reply/reply") {
      const rootRpid = Number(normalizedUrl.searchParams.get("root"));
      const rootComment = comments.get(rootRpid);
      const childReplies = [...comments.values()]
        .filter((comment) => comment.visible && comment.root === rootRpid && comment.rpid !== rootRpid)
        .sort((left, right) => left.rpid - right.rpid)
        .map((comment) => ({
          rpid: comment.rpid,
          root: comment.root,
          parent: comment.parent,
          content: {
            message: comment.message,
          },
        }));
      return createJsonFetchResponse({
        page: {
          count: childReplies.length,
        },
        root: rootComment && rootComment.visible ? createCommentNode(rootComment) : null,
        replies: childReplies,
      });
    }

    throw new Error(`Unexpected fetch url: ${normalizedUrl.toString()}`);
  }

  const client = {
    reply: {
      async add(payload) {
        const rpid = nextRpid++;
        const normalizedRoot = Number(payload.root ?? rpid);
        comments.set(rpid, {
          rpid,
          root: normalizedRoot,
          parent: Number(payload.parent ?? normalizedRoot),
          message: payload.message,
          visible: Boolean(visibilityRule(payload.message)),
        });
        return {
          rpid,
        };
      },
      async delete(payload) {
        comments.delete(Number(payload.rpid));
        if (pinnedRootRpid === Number(payload.rpid)) {
          pinnedRootRpid = null;
        }
        return {
          ok: true,
        };
      },
      async top(payload) {
        pinnedRootRpid = Number(payload.rpid);
        return {
          ok: true,
        };
      },
    },
  };

  return {
    client,
    fetchImpl,
    comments,
    setCommentVisible,
  };
}

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

    const harness = createGuestCommentHarness({
      startRpid: 800001,
    });
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
    const topCalls = [];
    harness.client.reply.top = async (payload) => {
      topCalls.push(payload);
      throw topError;
    };

    const result = await postSummaryThread({
      client: harness.client,
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
      fetchImpl: harness.fetchImpl as typeof fetch,
    });

    assert.equal(result.rootCommentRpid, 800001);
    assert.equal(result.createdComments.length, 2);
    assert.deepEqual(result.createdComments.map((item) => item.rpid), [800001, 800002]);
    assert.equal(result.warnings.length, 1);
    assert.equal(result.warnings[0].step, "top-root-comment");
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

    const harness = createGuestCommentHarness({
      startRpid: 830001,
    });
    const addCalls = [];
    const originalAdd = harness.client.reply.add;
    harness.client.reply.add = async (payload) => {
      addCalls.push(payload);
      return originalAdd(payload as never);
    };

    const result = await postSummaryThread({
      client: harness.client,
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
      fetchImpl: harness.fetchImpl as typeof fetch,
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

test("postSummaryThread replaces invisible timepoint lines with paste links and stores processed summaries", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-thread-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVcommentInvisibleFix",
      aid: 123450003,
      title: "Invisible Comment Recovery Test",
      pageCount: 1,
    });

    const rawSummary = [
      "<1P>",
      "1#10:53 开场回顾",
      "1#15:52 哈哈哈",
      "1#20:59 继续分析",
      "1#30:58 啊啊啊",
      "1#35:57 结尾总结",
    ].join("\n");
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: rawSummary,
      summaryHash: "hash-1",
      published: false,
      isDeleted: false,
    });

    const harness = createGuestCommentHarness({
      startRpid: 950001,
      visibilityRule(message) {
        return !message.includes("哈哈哈") && !message.includes("啊啊啊");
      },
    });

    const result = await postSummaryThread({
      client: harness.client,
      oid: video.aid,
      type: 1,
      message: rawSummary,
      db,
      videoId: video.id,
      topCommentState: {
        hasTopComment: false,
        topComment: null,
      },
      sleepImpl: async () => {},
      fetchImpl: harness.fetchImpl as typeof fetch,
    });

    assert.ok(result.rootCommentRpid > 950001);
    assert.equal(result.createdComments.length, 1);
    assert.equal(result.warnings.some((item) => item.step === "guest-visible-root-comment"), true);

    const parts = listVideoParts(db, video.id);
    assert.equal(parts[0].summary_text, rawSummary);
    assert.equal(
      parts[0].summary_text_processed,
      [
        "<1P>",
        "1#10:53 开场回顾",
        "1#15:52 https://paste.rs/hahaha",
        "1#20:59 继续分析",
        "1#30:58 https://paste.rs/aaaaaa",
        "1#35:57 结尾总结",
      ].join("\n"),
    );
    assert.equal(parts[0].published, 1);
    assert.equal(parts[0].published_comment_rpid, result.rootCommentRpid);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
