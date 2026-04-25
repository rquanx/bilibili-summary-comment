import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../scripts/lib/db/database";
import { getVideoByIdentity, listVideoParts, upsertVideo, upsertVideoPart } from "../scripts/lib/db/video-storage";
import { createSummaryHash } from "../scripts/lib/video/change-detection";
import { runPublishStage } from "../scripts/lib/pipeline/publish-stage";

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

function createGuestFetchHarness(startRpid) {
  const comments = new Map();
  let nextRpid = startRpid;
  let pinnedRootRpid = null;

  function buildRootNode(comment) {
    return {
      rpid: comment.rpid,
      count: [...comments.values()].filter((item) => item.root === comment.rpid && item.rpid !== comment.rpid).length,
      content: {
        message: comment.message,
      },
      replies: [...comments.values()]
        .filter((item) => item.root === comment.rpid && item.rpid !== comment.rpid)
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

  const client = {
    reply: {
      async list() {
        const visibleRoots = [...comments.values()]
          .filter((comment) => comment.root === comment.rpid)
          .sort((left, right) => left.rpid - right.rpid);
        return {
          upper: {
            top: pinnedRootRpid ? buildRootNode(comments.get(pinnedRootRpid)) : null,
          },
          replies: visibleRoots.filter((comment) => comment.rpid !== pinnedRootRpid).map(buildRootNode),
        };
      },
      async add(payload) {
        const rpid = nextRpid++;
        const root = Number(payload.root ?? rpid);
        comments.set(rpid, {
          rpid,
          root,
          parent: Number(payload.parent ?? root),
          message: payload.message,
        });
        return {
          rpid,
        };
      },
      async top(payload) {
        pinnedRootRpid = Number(payload.rpid);
        return { ok: true };
      },
      async delete(payload) {
        comments.delete(Number(payload.rpid));
        if (pinnedRootRpid === Number(payload.rpid)) {
          pinnedRootRpid = null;
        }
        return { ok: true };
      },
    },
  };

  const fetchImpl = async (url) => {
    const normalizedUrl = new URL(String(url));
    if (normalizedUrl.pathname === "/x/v2/reply") {
      const visibleRoots = [...comments.values()]
        .filter((comment) => comment.root === comment.rpid)
        .sort((left, right) => left.rpid - right.rpid);
      return createJsonFetchResponse({
        page: {
          count: visibleRoots.length,
        },
        upper: {
          top: pinnedRootRpid ? buildRootNode(comments.get(pinnedRootRpid)) : null,
        },
        replies: visibleRoots.filter((comment) => comment.rpid !== pinnedRootRpid).map(buildRootNode),
      });
    }

    if (normalizedUrl.pathname === "/x/v2/reply/reply") {
      const rootRpid = Number(normalizedUrl.searchParams.get("root"));
      const rootComment = comments.get(rootRpid);
      const replies = [...comments.values()]
        .filter((comment) => comment.root === rootRpid && comment.rpid !== rootRpid)
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
          count: replies.length,
        },
        root: rootComment ? buildRootNode(rootComment) : null,
        replies,
      });
    }

    throw new Error(`Unexpected fetch url: ${normalizedUrl.toString()}`);
  };

  return {
    client,
    fetchImpl,
    comments,
  };
}

test("runPublishStage rebuild posts a new pinned root before deleting stale old threads", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "publish-stage-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const summaryPath = path.join(tempRoot, "summary.md");
  const pendingSummaryPath = path.join(tempRoot, "pending-summary.md");
  const workRoot = `work-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const repoWorkRoot = path.join(process.cwd(), workRoot);
  const db = openDatabase(dbPath);

  try {
    const fullMessage = ["<1P>", "first page", "", "<2P>", "second page"].join("\n");
    fs.writeFileSync(summaryPath, `${fullMessage}\n`, "utf8");
    fs.writeFileSync(pendingSummaryPath, "", "utf8");

    const video = upsertVideo(db, {
      bvid: "BVpublish123456",
      aid: 987001,
      title: "Publish Stage Test",
      pageCount: 2,
      rootCommentRpid: null,
      topCommentRpid: 555001,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P>\nfirst page",
      summaryHash: createSummaryHash("<1P>\nfirst page"),
      published: true,
      publishedCommentRpid: 555001,
      publishedAt: "2026-01-01T00:00:00.000Z",
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 2,
      cid: 202,
      partTitle: "P2",
      durationSec: 10,
      summaryText: "<2P>\nsecond page",
      summaryHash: createSummaryHash("<2P>\nsecond page"),
      published: true,
      publishedCommentRpid: 555001,
      publishedAt: "2026-01-01T00:00:00.000Z",
      isDeleted: false,
    });

    const harness = createGuestFetchHarness(900001);
    harness.comments.set(555001, {
      rpid: 555001,
      root: 555001,
      parent: 555001,
      message: "old root thread",
    });
    harness.comments.set(555002, {
      rpid: 555002,
      root: 555002,
      parent: 555002,
      message: "old top thread",
    });

    const calls = [];
    const originalClient = harness.client.reply;
    const client = {
      reply: {
        async list(...args) {
          calls.push({ type: "list", args });
          if (calls.filter((entry) => entry.type === "list").length === 1) {
            return {
              upper: {
                top: {
                  rpid: 555002,
                  content: {
                    message: "old top thread",
                  },
                },
              },
              replies: [
                {
                  rpid: 555001,
                  content: {
                    message: "old root thread",
                  },
                },
              ],
            };
          }
          return originalClient.list();
        },
        async add(payload) {
          calls.push({ type: "add", payload });
          return originalClient.add(payload);
        },
        async top(payload) {
          calls.push({ type: "top", payload });
          return originalClient.top(payload);
        },
        async delete(payload) {
          calls.push({ type: "delete", payload });
          return originalClient.delete(payload);
        },
      },
    };

    const result = await runPublishStage({
      client,
      db,
      video: {
        ...video,
        publish_needs_rebuild: 1,
      },
      artifacts: {
        summaryPath,
        pendingSummaryPath,
      },
      oid: video.aid,
      type: 1,
      workRoot,
      sleepImpl: async () => {},
      fetchImpl: harness.fetchImpl as typeof fetch,
    });

    assert.equal(result.rebuild, true);
    assert.equal(result.rootCommentRpid, 900001);
    assert.deepEqual(
      result.deletedThreads.map((item) => item.rootRpid).sort((a, b) => a - b),
      [555001, 555002],
    );

    const callTypes = calls.map((entry) => entry.type);
    assert.deepEqual(callTypes, ["list", "add", "top", "delete", "delete"]);
    assert.deepEqual(
      calls.filter((entry) => entry.type === "delete").map((entry) => entry.payload.rpid).sort((a, b) => a - b),
      [555001, 555002],
    );

    const persistedVideo = getVideoByIdentity(db, { bvid: "BVpublish123456" });
    assert.equal(persistedVideo.root_comment_rpid, 900001);
    assert.equal(persistedVideo.top_comment_rpid, 900001);
    assert.equal(Number(persistedVideo.publish_needs_rebuild), 0);

    const parts = listVideoParts(db, video.id);
    assert.deepEqual(parts.map((part) => part.published), [1, 1]);
    assert.deepEqual(parts.map((part) => part.published_comment_rpid), [900001, 900001]);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(repoWorkRoot, { recursive: true, force: true });
  }
});

test("runPublishStage rebuilds when stored root comment is missing even without pending summaries", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "publish-stage-missing-root-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const summaryPath = path.join(tempRoot, "summary.md");
  const pendingSummaryPath = path.join(tempRoot, "pending-summary.md");
  const workRoot = `work-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const repoWorkRoot = path.join(process.cwd(), workRoot);
  const db = openDatabase(dbPath);

  try {
    const fullMessage = ["<1P>", "first page", "", "<2P>", "second page"].join("\n");
    fs.writeFileSync(summaryPath, `${fullMessage}\n`, "utf8");
    fs.writeFileSync(pendingSummaryPath, "", "utf8");

    const video = upsertVideo(db, {
      bvid: "BVpublishMissing1",
      aid: 987002,
      title: "Publish Stage Missing Root Test",
      pageCount: 2,
      rootCommentRpid: 555001,
      topCommentRpid: 555001,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P>\nfirst page",
      summaryHash: createSummaryHash("<1P>\nfirst page"),
      published: true,
      publishedCommentRpid: 555001,
      publishedAt: "2026-01-01T00:00:00.000Z",
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 2,
      cid: 202,
      partTitle: "P2",
      durationSec: 10,
      summaryText: "<2P>\nsecond page",
      summaryHash: createSummaryHash("<2P>\nsecond page"),
      published: true,
      publishedCommentRpid: 555001,
      publishedAt: "2026-01-01T00:00:00.000Z",
      isDeleted: false,
    });

    const harness = createGuestFetchHarness(910001);
    const calls = [];
    const originalClient = harness.client.reply;
    const client = {
      reply: {
        async list(...args) {
          calls.push({ type: "list", args });
          return {
            upper: {
              top: null,
            },
            replies: [],
          };
        },
        async add(payload) {
          calls.push({ type: "add", payload });
          return originalClient.add(payload);
        },
        async top(payload) {
          calls.push({ type: "top", payload });
          return originalClient.top(payload);
        },
        async delete(payload) {
          calls.push({ type: "delete", payload });
          return originalClient.delete(payload);
        },
      },
    };

    const result = await runPublishStage({
      client,
      db,
      video,
      artifacts: {
        summaryPath,
        pendingSummaryPath,
      },
      oid: video.aid,
      type: 1,
      workRoot,
      sleepImpl: async () => {},
      fetchImpl: harness.fetchImpl as typeof fetch,
    });

    assert.equal(result.rebuild, true);
    assert.equal(result.rootCommentRpid, 910001);
    assert.equal(result.deletedThreads?.length, 1);
    assert.equal(result.deletedThreads?.[0]?.rootRpid, 555001);

    const persistedVideo = getVideoByIdentity(db, { bvid: "BVpublishMissing1" });
    assert.equal(persistedVideo.root_comment_rpid, 910001);
    assert.equal(persistedVideo.top_comment_rpid, 910001);

    const parts = listVideoParts(db, video.id);
    assert.deepEqual(parts.map((part) => part.published), [1, 1]);
    assert.deepEqual(parts.map((part) => part.published_comment_rpid), [910001, 910001]);

    assert.deepEqual(calls.map((entry) => entry.type), ["list", "add", "top", "delete"]);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(repoWorkRoot, { recursive: true, force: true });
  }
});
