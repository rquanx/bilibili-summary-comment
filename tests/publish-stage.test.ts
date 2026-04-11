import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../scripts/lib/db/database";
import { getVideoByIdentity, listVideoParts, upsertVideo, upsertVideoPart } from "../scripts/lib/db/video-storage";
import { createSummaryHash } from "../scripts/lib/video/change-detection";
import { runPublishStage } from "../scripts/lib/pipeline/publish-stage";

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

    const calls = [];
    let nextRpid = 900001;
    let listCallCount = 0;
    const client = {
      reply: {
        async list() {
          calls.push({ type: "list" });
          listCallCount += 1;
          if (listCallCount === 1) {
            return {
              upper: {
                top: {
                  rpid: 555002,
                  content: {
                    message: "old top thread",
                  },
                },
              },
            };
          }

          return {
            page: {
              count: 1,
            },
            upper: {
              top: {
                rpid: 900001,
                count: 1,
                replies: [
                  {
                    rpid: 900002,
                  },
                ],
                content: {
                  message: "new top thread",
                },
              },
            },
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
          return { ok: true };
        },
        async delete(payload) {
          calls.push({ type: "delete", payload });
          return { ok: true };
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
    });

    assert.equal(result.rebuild, true);
    assert.equal(result.rootCommentRpid, 900001);
    assert.deepEqual(
      result.deletedThreads.map((item) => item.rootRpid).sort((a, b) => a - b),
      [555001, 555002],
    );

    const callTypes = calls.map((entry) => entry.type);
    assert.deepEqual(callTypes, ["list", "add", "top", "list", "list", "list", "delete", "delete"]);
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
