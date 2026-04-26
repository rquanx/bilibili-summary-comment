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
  guestPageSize = 20,
  omitGuestPageCount = false,
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

  async function guestReplyListImpl(params: any = {}) {
    const visibleRoots = [...comments.values()]
      .filter((comment) => comment.visible && comment.root === comment.rpid)
      .sort((left, right) => left.rpid - right.rpid);
    const pinned = pinnedRootRpid ? visibleRoots.find((comment) => comment.rpid === pinnedRootRpid) ?? null : null;
    const topReplies = pinned ? [createCommentNode(pinned)] : [];
    const replies = visibleRoots
      .filter((comment) => comment.rpid !== pinnedRootRpid)
      .map(createCommentNode);
    const pageNo = Number(params.pn ?? 1);
    const pageSize = guestPageSize;
    const startIndex = Math.max(0, (pageNo - 1) * pageSize);
    const pagedReplies = replies.slice(startIndex, startIndex + pageSize);
    const hasMore = startIndex + pageSize < replies.length;

    return {
      page: omitGuestPageCount
        ? {}
        : {
          count: visibleRoots.length,
        },
      cursor: {
        is_begin: pageNo === 1,
        prev: Math.max(0, pageNo - 1),
        next: pageNo + 1,
        is_end: !hasMore,
        pagination_reply: {
          next_offset: hasMore ? `offset-${pageNo + 1}` : "",
        },
        all_count: replies.length,
      },
      upper: {
        top: pinned ? createCommentNode(pinned) : null,
      },
      top_replies: topReplies,
      replies: pagedReplies,
    };
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
    guestReplyListImpl,
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
      guestReplyListImpl: harness.guestReplyListImpl as never,
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

test("postSummaryThread keeps scanning guest pages when top-level count is omitted", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-thread-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const summaryMessage = "<1P>\n1#00:00 cursor pagination summary";

  try {
    const video = upsertVideo(db, {
      bvid: "BVcommentCursorPaging",
      aid: 123456791,
      title: "Comment Cursor Pagination Test",
      pageCount: 1,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: summaryMessage,
      summaryHash: "hash-1",
      published: false,
      isDeleted: false,
    });

    const harness = createGuestCommentHarness({
      startRpid: 900001,
      guestPageSize: 1,
      omitGuestPageCount: true,
    });
    await harness.client.reply.add({
      oid: video.aid,
      type: 1,
      message: "existing root 1",
      plat: 1,
    });
    await harness.client.reply.add({
      oid: video.aid,
      type: 1,
      message: "existing root 2",
      plat: 1,
    });

    const topError = Object.assign(new Error("鍟ラ兘鏈ㄦ湁"), {
      rawResponse: {
        data: {
          message: "鍟ラ兘鏈ㄦ湁",
        },
      },
    });
    harness.client.reply.top = async () => {
      throw topError;
    };

    const result = await postSummaryThread({
      client: harness.client,
      oid: video.aid,
      type: 1,
      message: summaryMessage,
      db,
      videoId: video.id,
      topCommentState: {
        hasTopComment: false,
        topComment: null,
      },
      sleepImpl: async () => {},
      guestReplyListImpl: harness.guestReplyListImpl as never,
      fetchImpl: harness.fetchImpl as typeof fetch,
    });

    assert.equal(result.rootCommentRpid, 900003);
    assert.equal(result.createdComments.length, 1);
    assert.equal(result.createdComments[0].rpid, 900003);
    assert.equal(result.warnings[0]?.step, "top-root-comment");

    const parts = listVideoParts(db, video.id);
    assert.deepEqual(parts.map((part) => part.published), [1]);
    assert.deepEqual(parts.map((part) => part.published_comment_rpid), [900003]);
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
      guestReplyListImpl: harness.guestReplyListImpl as never,
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

test.skip("postSummaryThread replaces invisible timepoint lines with paste links and stores processed summaries", async () => {
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
      guestReplyListImpl: harness.guestReplyListImpl as never,
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

test.skip("postSummaryThread confirms the initial comment is guest-visible before accepting duplicate-probe recovery", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-thread-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const fullMessage = "<1P>\n1#20:36 single chunk summary";

  try {
    const video = upsertVideo(db, {
      bvid: "BVcommentDuplicateProbe",
      aid: 123450005,
      title: "Duplicate Probe Recovery Test",
      pageCount: 1,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: fullMessage,
      summaryHash: "hash-1",
      published: false,
      isDeleted: false,
    });

    const harness = createGuestCommentHarness({
      startRpid: 970001,
      visibilityRule() {
        return false;
      },
    });
    const originalAdd = harness.client.reply.add;
    harness.client.reply.add = async (payload) => {
      const existingRoot = [...harness.comments.values()].find((comment) => comment.root === comment.rpid && comment.message === payload.message);
      if (existingRoot) {
        harness.setCommentVisible(existingRoot.rpid, true);
        throw Object.assign(new Error("重复评论，请勿刷屏"), {
          rawResponse: {
            data: {
              message: "重复评论，请勿刷屏",
            },
          },
        });
      }
      return originalAdd(payload as never);
    };

    const result = await postSummaryThread({
      client: harness.client,
      oid: video.aid,
      type: 1,
      message: fullMessage,
      db,
      videoId: video.id,
      topCommentState: {
        hasTopComment: false,
        topComment: null,
      },
      sleepImpl: async () => {},
      guestReplyListImpl: harness.guestReplyListImpl as never,
      fetchImpl: harness.fetchImpl as typeof fetch,
    });

    assert.equal(result.rootCommentRpid, 970001);
    assert.equal(result.createdComments.length, 1);
    assert.equal(result.createdComments[0].rpid, 970001);
    assert.equal(
      result.warnings.some((item) => item.step === "duplicate-probe-confirmed-visible-root-comment"),
      true,
    );

    const persistedVideo = getVideoByIdentity(db, { bvid: "BVcommentDuplicateProbe" });
    assert.equal(persistedVideo?.root_comment_rpid, 970001);
    assert.equal(persistedVideo?.top_comment_rpid, 970001);

    const parts = listVideoParts(db, video.id);
    assert.deepEqual(parts.map((part) => part.published), [1]);
    assert.deepEqual(parts.map((part) => part.published_comment_rpid), [970001]);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test.skip("postSummaryThread rejects duplicate-probe recovery when the initial comment is still not guest-visible", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-thread-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const fullMessage = "<1P>\n1#20:36 single chunk summary";

  try {
    const video = upsertVideo(db, {
      bvid: "BVcommentDuplicateProbeInvisible",
      aid: 123450006,
      title: "Duplicate Probe Invisible Test",
      pageCount: 1,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: fullMessage,
      summaryHash: "hash-1",
      published: false,
      isDeleted: false,
    });

    const harness = createGuestCommentHarness({
      startRpid: 980001,
      visibilityRule() {
        return false;
      },
    });
    const originalAdd = harness.client.reply.add;
    harness.client.reply.add = async (payload) => {
      const rootMessageExists = [...harness.comments.values()].some((comment) => comment.root === comment.rpid && comment.message === payload.message);
      if (rootMessageExists) {
        throw Object.assign(new Error("duplicate comment"), {
          rawResponse: {
            data: {
              message: "重复评论，请勿刷屏",
            },
          },
        });
      }
      return originalAdd(payload as never);
    };

    await assert.rejects(
      postSummaryThread({
        client: harness.client,
        oid: video.aid,
        type: 1,
        message: fullMessage,
        db,
        videoId: video.id,
        topCommentState: {
          hasTopComment: false,
          topComment: null,
        },
        sleepImpl: async () => {},
        guestReplyListImpl: harness.guestReplyListImpl as never,
        fetchImpl: harness.fetchImpl as typeof fetch,
      }),
      /Published comment is not visible to guests/,
    );

    const persistedVideo = getVideoByIdentity(db, { bvid: "BVcommentDuplicateProbeInvisible" });
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

test("postSummaryThread replaces an invisible comment chunk with a paste link and stores processed summaries", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-thread-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const rawSummary = [
    "<1P>",
    "1#10:53 invisible summary line A",
    "1#15:52 invisible summary line B",
    "1#20:59 visible summary line C",
  ].join("\n");

  try {
    const video = upsertVideo(db, {
      bvid: "BVcommentInvisibleWholePaste",
      aid: 123450103,
      title: "Invisible Comment Whole Paste Test",
      pageCount: 1,
    });

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
      startRpid: 990101,
      visibilityRule(message) {
        return message.includes("https://paste.rs/");
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
      guestReplyListImpl: harness.guestReplyListImpl as never,
      fetchImpl: harness.fetchImpl as typeof fetch,
    });

    assert.equal(result.rootCommentRpid, 990102);
    assert.equal(result.createdComments.length, 1);
    assert.equal(result.createdComments[0].rpid, 990102);
    assert.equal(result.warnings.some((item) => item.step === "guest-visible-root-comment"), true);

    const parts = listVideoParts(db, video.id);
    assert.equal(parts[0].summary_text, rawSummary);
    assert.equal(parts[0].summary_text_processed, "<1P>\nhttps://paste.rs/3c31503e");
    assert.equal(parts[0].published, 1);
    assert.equal(parts[0].published_comment_rpid, 990102);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("postSummaryThread retries once with a paste link instead of probe comments when the initial comment is invisible", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-thread-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const fullMessage = "<1P>\n1#20:36 single chunk summary";

  try {
    const video = upsertVideo(db, {
      bvid: "BVcommentPasteRetry",
      aid: 123450104,
      title: "Paste Retry Test",
      pageCount: 1,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: fullMessage,
      summaryHash: "hash-1",
      published: false,
      isDeleted: false,
    });

    const harness = createGuestCommentHarness({
      startRpid: 990201,
      visibilityRule(message) {
        return message.includes("https://paste.rs/");
      },
    });
    const addCalls = [];
    const originalAdd = harness.client.reply.add;
    harness.client.reply.add = async (payload) => {
      addCalls.push(payload.message);
      return originalAdd(payload as never);
    };

    const result = await postSummaryThread({
      client: harness.client,
      oid: video.aid,
      type: 1,
      message: fullMessage,
      db,
      videoId: video.id,
      topCommentState: {
        hasTopComment: false,
        topComment: null,
      },
      sleepImpl: async () => {},
      guestReplyListImpl: harness.guestReplyListImpl as never,
      fetchImpl: harness.fetchImpl as typeof fetch,
    });

    assert.equal(result.rootCommentRpid, 990202);
    assert.equal(result.createdComments.length, 1);
    assert.equal(result.createdComments[0].rpid, 990202);
    assert.deepEqual(addCalls, [fullMessage, "<1P>\nhttps://paste.rs/3c31503e"]);
    assert.equal(result.warnings.some((item) => item.step === "guest-visible-root-comment"), true);

    const persistedVideo = getVideoByIdentity(db, { bvid: "BVcommentPasteRetry" });
    assert.equal(persistedVideo?.root_comment_rpid, 990202);
    assert.equal(persistedVideo?.top_comment_rpid, 990202);

    const parts = listVideoParts(db, video.id);
    assert.deepEqual(parts.map((part) => part.published), [1]);
    assert.deepEqual(parts.map((part) => part.published_comment_rpid), [990202]);
    assert.equal(parts[0].summary_text_processed, "<1P>\nhttps://paste.rs/3c31503e");
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("postSummaryThread compacts multi-page paste fallbacks into a single page range in comments", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-thread-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const fullMessage = [
    "<1P>",
    "1#00:00 first page summary",
    "",
    "<2P>",
    "2#00:00 second page summary",
    "",
    "<3P>",
    "3#00:00 third page summary",
    "",
    "<4P>",
    "4#00:00 fourth page summary",
    "",
    "<5P>",
    "5#00:00 fifth page summary",
  ].join("\n");

  try {
    const video = upsertVideo(db, {
      bvid: "BVcommentPasteRetryRange",
      aid: 123450106,
      title: "Paste Retry Range Test",
      pageCount: 5,
    });

    for (let pageNo = 1; pageNo <= 5; pageNo += 1) {
      upsertVideoPart(db, {
        videoId: video.id,
        pageNo,
        cid: 100 + pageNo,
        partTitle: `P${pageNo}`,
        durationSec: 10,
        summaryText: `<${pageNo}P>\n${pageNo}#00:00 page ${pageNo} summary`,
        summaryHash: `hash-${pageNo}`,
        published: false,
        isDeleted: false,
      });
    }

    const harness = createGuestCommentHarness({
      startRpid: 990401,
      visibilityRule(message) {
        return message.includes("https://paste.rs/");
      },
    });
    const addCalls = [];
    const originalAdd = harness.client.reply.add;
    harness.client.reply.add = async (payload) => {
      addCalls.push(payload.message);
      return originalAdd(payload as never);
    };

    const result = await postSummaryThread({
      client: harness.client,
      oid: video.aid,
      type: 1,
      message: fullMessage,
      db,
      videoId: video.id,
      topCommentState: {
        hasTopComment: false,
        topComment: null,
      },
      sleepImpl: async () => {},
      guestReplyListImpl: harness.guestReplyListImpl as never,
      fetchImpl: harness.fetchImpl as typeof fetch,
    });

    assert.equal(result.rootCommentRpid, 990402);
    assert.equal(result.createdComments.length, 1);
    assert.deepEqual(result.createdComments[0].pages, [1, 2, 3, 4, 5]);
    assert.deepEqual(addCalls, [fullMessage, "<1P> ~ <5P>\nhttps://paste.rs/3c31503e"]);

    const parts = listVideoParts(db, video.id);
    assert.deepEqual(
      parts.map((part) => part.summary_text_processed),
      [
        "<1P>\nhttps://paste.rs/3c31503e",
        "<2P>\nhttps://paste.rs/3c31503e",
        "<3P>\nhttps://paste.rs/3c31503e",
        "<4P>\nhttps://paste.rs/3c31503e",
        "<5P>\nhttps://paste.rs/3c31503e",
      ],
    );
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("postSummaryThread fails when the paste-link retry is still not guest-visible", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-thread-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const fullMessage = "<1P>\n1#20:36 single chunk summary";

  try {
    const video = upsertVideo(db, {
      bvid: "BVcommentPasteRetryInvisible",
      aid: 123450105,
      title: "Paste Retry Invisible Test",
      pageCount: 1,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: fullMessage,
      summaryHash: "hash-1",
      published: false,
      isDeleted: false,
    });

    const harness = createGuestCommentHarness({
      startRpid: 990301,
      visibilityRule() {
        return false;
      },
    });
    const addCalls = [];
    const originalAdd = harness.client.reply.add;
    harness.client.reply.add = async (payload) => {
      addCalls.push(payload.message);
      return originalAdd(payload as never);
    };

    await assert.rejects(
      postSummaryThread({
        client: harness.client,
        oid: video.aid,
        type: 1,
        message: fullMessage,
        db,
        videoId: video.id,
        topCommentState: {
          hasTopComment: false,
          topComment: null,
        },
        sleepImpl: async () => {},
        guestReplyListImpl: harness.guestReplyListImpl as never,
        fetchImpl: harness.fetchImpl as typeof fetch,
      }),
      /Published comment is not visible to guests/,
    );

    const persistedVideo = getVideoByIdentity(db, { bvid: "BVcommentPasteRetryInvisible" });
    assert.equal(persistedVideo?.root_comment_rpid, null);
    assert.equal(persistedVideo?.top_comment_rpid, null);

    const parts = listVideoParts(db, video.id);
    assert.deepEqual(parts.map((part) => part.published), [0]);
    assert.deepEqual(parts.map((part) => part.published_comment_rpid), [null]);
    assert.deepEqual(addCalls, [fullMessage, "<1P>\nhttps://paste.rs/3c31503e"]);
    assert.equal(parts[0].summary_text_processed, null);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("postSummaryThread adopts an existing matching top comment instead of posting a duplicate reply", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "comment-thread-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const fullMessage = [
    "<1P>",
    "1#20:36 first page summary",
    "",
    "<2P>",
    "2#00:00 second page summary",
  ].join("\n");

  try {
    const video = upsertVideo(db, {
      bvid: "BVcommentAdoptTopRoot",
      aid: 123450004,
      title: "Existing Top Comment Adoption Test",
      pageCount: 2,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P>\n1#20:36 first page summary",
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
      summaryText: "<2P>\n2#00:00 second page summary",
      summaryHash: "hash-2",
      published: false,
      isDeleted: false,
    });

    let addCalls = 0;
    let topCalls = 0;
    const client = {
      reply: {
        async add() {
          addCalls += 1;
          throw new Error("reply.add should not be called when matching top comment is adopted");
        },
        async delete() {
          throw new Error("reply.delete should not be called when matching top comment is adopted");
        },
        async top() {
          topCalls += 1;
          throw new Error("reply.top should not be called when matching top comment is already pinned");
        },
      },
    };

    const result = await postSummaryThread({
      client: client as never,
      oid: video.aid,
      type: 1,
      message: fullMessage,
      db,
      videoId: video.id,
      topCommentState: {
        hasTopComment: true,
        topComment: {
          rpid: 990001,
          message: fullMessage,
        },
      },
      sleepImpl: async () => {},
      fetchImpl: async () => {
        throw new Error("fetch should not be called when no comment is posted");
      },
    });

    assert.equal(result.rootCommentRpid, 990001);
    assert.equal(result.action, "adopt-existing-root-comment-thread");
    assert.equal(result.reusedExistingRootComment, true);
    assert.deepEqual(result.createdComments, []);
    assert.equal(addCalls, 0);
    assert.equal(topCalls, 0);

    const persistedVideo = getVideoByIdentity(db, { bvid: "BVcommentAdoptTopRoot" });
    assert.equal(persistedVideo?.root_comment_rpid, 990001);
    assert.equal(persistedVideo?.top_comment_rpid, 990001);

    const parts = listVideoParts(db, video.id);
    assert.deepEqual(parts.map((part) => part.published), [1, 1]);
    assert.deepEqual(parts.map((part) => part.published_comment_rpid), [990001, 990001]);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
