import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/infra/db/database";
import {
  getVideoByIdentity,
  listVideoParts,
  upsertVideo,
  upsertVideoPart,
} from "../src/infra/db/video-storage";
import {
  buildRecentReprocessCandidateKey,
  buildRecentReprocessCandidate,
  collectRecentReprocessCandidates,
  prepareRecentReprocessCandidate,
} from "../src/domains/scheduler/recent-reprocess";

test("buildRecentReprocessCandidate matches missing comment threads and paste.rs summaries", () => {
  const upload = {
    mid: 1,
    bvid: "BVRECENT1",
    aid: 1001,
    title: "Recent Video",
    createdAtUnix: 100,
    createdAt: new Date(100 * 1000).toISOString(),
    source: "1",
  };

  const candidate = buildRecentReprocessCandidate(
    upload,
    {
      id: 9,
      root_comment_rpid: null,
      publish_needs_rebuild: 1,
    },
    [
      {
        page_no: 1,
        summary_text_processed: "<1P>\nhttps://paste.rs/abc123",
      },
      {
        page_no: 2,
        summary_text_processed: null,
      },
    ],
  );

  assert.deepEqual(candidate?.reasons, [
    "missing-comment-thread",
    "paste-rs-processed-summary",
    "publish-rebuild-needed",
  ]);
  assert.deepEqual(candidate?.pastePages, [1]);
  assert.equal(candidate?.videoId, 9);
  assert.equal(candidate?.hadStoredVideo, true);
});

test("collectRecentReprocessCandidates detects paste.rs from the visible Bilibili thread even when processed summaries are empty", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-recent-reprocess-live-thread-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVRECENTLIVE1",
      aid: 1003,
      title: "Visible Thread Paste",
      pageCount: 3,
      rootCommentRpid: 8801,
      topCommentRpid: 8801,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 301,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P>\nraw page one",
      summaryHash: "hash-1",
      published: true,
      publishedCommentRpid: 8801,
      publishedAt: "2026-05-01T00:00:00.000Z",
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 2,
      cid: 302,
      partTitle: "P2",
      durationSec: 10,
      summaryText: "<2P>\nraw page two",
      summaryHash: "hash-2",
      published: true,
      publishedCommentRpid: 8801,
      publishedAt: "2026-05-01T00:00:00.000Z",
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 3,
      cid: 303,
      partTitle: "P3",
      durationSec: 10,
      summaryText: "<3P>\nraw page three",
      summaryHash: "hash-3",
      published: true,
      publishedCommentRpid: 8801,
      publishedAt: "2026-05-01T00:00:00.000Z",
      isDeleted: false,
    });

    const candidates = await collectRecentReprocessCandidates(db, [
      {
        mid: 1,
        bvid: "BVRECENTLIVE1",
        aid: 1003,
        title: "Visible Thread Paste",
        createdAtUnix: 100,
        createdAt: new Date(100 * 1000).toISOString(),
        source: "1",
      },
    ], {
      inspectVisibleThreadImpl: async () => ({
        oid: 1003,
        type: 1,
        expectedRootRpid: 8801,
        hasTopComment: true,
        topCommentRpid: 8801,
        topCommentMessage: "<1P>\nraw page one",
        matchesExpectedRoot: true,
        pastePages: [2, 3],
        pasteUrls: [
          "https://paste.rs/live-p02",
          "https://paste.rs/live-p03",
        ],
        scannedReplyCount: 3,
      }),
    });

    assert.equal(candidates.length, 1);
    assert.deepEqual(candidates[0]?.reasons, [
      "paste-rs-processed-summary",
    ]);
    assert.deepEqual(candidates[0]?.pastePages, [2, 3]);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("prepareRecentReprocessCandidate clears paste.rs processed summaries and resets missing comment publish state", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-recent-reprocess-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVRECENT2",
      aid: 1002,
      title: "Recent Reprocess",
      pageCount: 2,
      rootCommentRpid: null,
      topCommentRpid: null,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P>\nraw page one",
      processedSummaryText: "<1P>\nhttps://paste.rs/abc123",
      summaryHash: "hash-1",
      published: true,
      publishedCommentRpid: 7001,
      publishedAt: "2026-05-01T00:00:00.000Z",
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 2,
      cid: 202,
      partTitle: "P2",
      durationSec: 10,
      summaryText: "<2P>\nraw page two",
      summaryHash: "hash-2",
      published: true,
      publishedCommentRpid: 7001,
      publishedAt: "2026-05-01T00:00:00.000Z",
      isDeleted: false,
    });

    const result = prepareRecentReprocessCandidate(db, {
      mid: 1,
      bvid: "BVRECENT2",
      aid: 1002,
      title: "Recent Reprocess",
      createdAtUnix: 100,
      createdAt: new Date(100 * 1000).toISOString(),
      source: "1",
      videoId: video.id,
      hadStoredVideo: true,
      reasons: [
        "missing-comment-thread",
        "paste-rs-processed-summary",
      ],
      pastePages: [1],
    });

    assert.deepEqual(result, {
      videoId: video.id,
      clearedProcessedPages: [1],
      resetPublishedState: true,
      markedPublishRebuild: true,
    });

    const persistedVideo = getVideoByIdentity(db, { bvid: "BVRECENT2" });
    assert.equal(Number(persistedVideo?.publish_needs_rebuild), 1);
    assert.equal(persistedVideo?.publish_rebuild_reason, "recent-reprocess-paste-rs");
    assert.equal(persistedVideo?.root_comment_rpid, null);
    assert.equal(persistedVideo?.top_comment_rpid, null);

    const parts = listVideoParts(db, video.id);
    assert.equal(parts[0].summary_text_processed, null);
    assert.equal(Number(parts[0].published), 0);
    assert.equal(parts[0].published_comment_rpid, null);
    assert.equal(Number(parts[1].published), 0);
    assert.equal(parts[1].published_comment_rpid, null);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("buildRecentReprocessCandidateKey normalizes reason and page ordering", () => {
  const first = buildRecentReprocessCandidateKey({
    bvid: "BVRECENTKEY1",
    reasons: [
      "publish-rebuild-needed",
      "paste-rs-processed-summary",
    ],
    pastePages: [7, 3, 3],
  });
  const second = buildRecentReprocessCandidateKey({
    bvid: "BVRECENTKEY1",
    reasons: [
      "paste-rs-processed-summary",
      "publish-rebuild-needed",
      "paste-rs-processed-summary",
    ],
    pastePages: [3, 7],
  });

  assert.equal(first, second);
});
