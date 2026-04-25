import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../scripts/lib/db/database";
import { listVideoParts, upsertVideo, upsertVideoPart } from "../scripts/lib/db/video-storage";
import { createSummaryHash, detectSnapshotChanges, reindexSummaryText } from "../scripts/lib/video/change-detection";
import { syncVideoSnapshotToDb } from "../scripts/lib/video/state-sync";
import * as videoState from "../scripts/lib/video/index";
import { fetchVideoSnapshot } from "../scripts/lib/video/snapshot";

test("detectSnapshotChanges identifies reorders that require rebuild", () => {
  const previousActiveParts = [
    { cid: 11, page_no: 1 },
    { cid: 22, page_no: 2 },
  ];
  const nextPages = [
    { cid: 22, pageNo: 1 },
    { cid: 11, pageNo: 2 },
  ];

  const changeSet = detectSnapshotChanges(previousActiveParts, nextPages);

  assert.equal(changeSet.requiresRebuild, true);
  assert.deepEqual(changeSet.moved, [
    { cid: 11, fromPageNo: 1, toPageNo: 2 },
    { cid: 22, fromPageNo: 2, toPageNo: 1 },
  ]);
});

test("reindexSummaryText rewrites page markers, inline page indexes, and createSummaryHash is stable", () => {
  const text = "<1P>\n1#00:10 hello\n\n<1P> 1#00:20 world";
  const reindexed = reindexSummaryText(text, 2);

  assert.equal(reindexed, "<2P>\n2#00:10 hello\n\n<2P> 2#00:20 world");
  assert.equal(createSummaryHash(reindexed), createSummaryHash("<2P>\n2#00:10 hello\n\n<2P> 2#00:20 world\n"));
});

test("syncVideoSnapshotToDb reindexes moved summaries and clears published flags", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-state-sync-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVstate123456",
      aid: 123001,
      title: "Video State Test",
      pageCount: 2,
      rootCommentRpid: 777,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P>\nold one",
      summaryHash: createSummaryHash("<1P>\nold one"),
      published: true,
      publishedCommentRpid: 777,
      publishedAt: "2026-01-01T00:00:00.000Z",
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 2,
      cid: 202,
      partTitle: "P2",
      durationSec: 10,
      summaryText: "<2P>\nold two",
      summaryHash: createSummaryHash("<2P>\nold two"),
      published: true,
      publishedCommentRpid: 777,
      publishedAt: "2026-01-01T00:00:00.000Z",
      isDeleted: false,
    });

    const state = syncVideoSnapshotToDb(db, {
      bvid: "BVstate123456",
      aid: 123001,
      title: "Video State Test",
      pageCount: 2,
      pages: [
        { pageNo: 1, cid: 202, partTitle: "P2", durationSec: 10 },
        { pageNo: 2, cid: 101, partTitle: "P1", durationSec: 10 },
      ],
    });

    assert.equal(state.changeSet.requiresRebuild, true);
    const parts = listVideoParts(db, video.id);
    assert.equal(parts[0].cid, 202);
    assert.equal(parts[0].summary_text, "<1P>\nold two");
    assert.equal(parts[0].published, 0);
    assert.equal(parts[0].published_comment_rpid, null);
    assert.equal(parts[1].cid, 101);
    assert.equal(parts[1].summary_text, "<2P>\nold one");
    assert.equal(parts[1].published, 0);
    assert.equal(Number(state.video.publish_needs_rebuild), 1);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("syncVideoSnapshotToDb keeps moved summary page indexes in sync after deleting an earlier part", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-state-delete-shift-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVstateDelete001",
      aid: 223344,
      title: "Delete Shift Test",
      pageCount: 3,
      rootCommentRpid: 999,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 111,
      partTitle: "P1",
      durationSec: 10,
      summaryText: "<1P> 1#00:00 first",
      summaryHash: createSummaryHash("<1P> 1#00:00 first"),
      published: true,
      publishedCommentRpid: 999,
      publishedAt: "2026-01-01T00:00:00.000Z",
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 2,
      cid: 222,
      partTitle: "P2",
      durationSec: 10,
      summaryText: "<2P> 2#00:00 second",
      summaryHash: createSummaryHash("<2P> 2#00:00 second"),
      published: true,
      publishedCommentRpid: 999,
      publishedAt: "2026-01-01T00:00:00.000Z",
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 3,
      cid: 333,
      partTitle: "P3",
      durationSec: 10,
      summaryText: "<3P>\n3#00:00 third",
      summaryHash: createSummaryHash("<3P>\n3#00:00 third"),
      published: true,
      publishedCommentRpid: 999,
      publishedAt: "2026-01-01T00:00:00.000Z",
      isDeleted: false,
    });

    const state = syncVideoSnapshotToDb(db, {
      bvid: "BVstateDelete001",
      aid: 223344,
      title: "Delete Shift Test",
      pageCount: 2,
      pages: [
        { pageNo: 1, cid: 222, partTitle: "P2", durationSec: 10 },
        { pageNo: 2, cid: 333, partTitle: "P3", durationSec: 10 },
      ],
    });

    assert.equal(state.changeSet.requiresRebuild, true);
    const parts = listVideoParts(db, video.id);
    assert.equal(parts[0].cid, 222);
    assert.equal(parts[0].summary_text, "<1P> 1#00:00 second");
    assert.equal(parts[1].cid, 333);
    assert.equal(parts[1].summary_text, "<2P>\n2#00:00 third");
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("video-state barrel re-exports the split modules", () => {
  assert.equal(videoState.fetchVideoSnapshot, fetchVideoSnapshot);
  assert.equal(videoState.syncVideoSnapshotToDb, syncVideoSnapshotToDb);
});

test("fetchVideoSnapshot includes owner metadata when available", async () => {
  const snapshot = await fetchVideoSnapshot({
    video: {
      async detail() {
        return {
          View: {
            bvid: "BVowner123456",
            aid: 456789,
            title: "Owner Test",
            owner: {
              mid: 3690976520440286,
              name: "知识主播",
            },
            pages: [
              {
                page: 1,
                cid: 1001,
                part: "P1",
                duration: 90,
              },
            ],
          },
        };
      },
    },
  } as any, {
    bvid: "BVowner123456",
  });

  assert.equal(snapshot.ownerMid, 3690976520440286);
  assert.equal(snapshot.ownerName, "知识主播");
});
