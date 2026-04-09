import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../scripts/lib/database.mjs";
import { listVideoParts, upsertVideo, upsertVideoPart } from "../scripts/lib/video-storage.mjs";
import { createSummaryHash, detectSnapshotChanges, reindexSummaryText } from "../scripts/lib/video-change-detection.mjs";
import { syncVideoSnapshotToDb } from "../scripts/lib/video-state-sync.mjs";
import * as videoState from "../scripts/lib/video-state.mjs";
import { fetchVideoSnapshot } from "../scripts/lib/video-snapshot.mjs";

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

test("reindexSummaryText rewrites page markers and createSummaryHash is stable", () => {
  const text = "<1P>\n00:10 hello";
  const reindexed = reindexSummaryText(text, 2);

  assert.equal(reindexed, "<2P>\n00:10 hello");
  assert.equal(createSummaryHash(reindexed), createSummaryHash("<2P>\n00:10 hello\n"));
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

test("video-state barrel re-exports the split modules", () => {
  assert.equal(videoState.fetchVideoSnapshot, fetchVideoSnapshot);
  assert.equal(videoState.syncVideoSnapshotToDb, syncVideoSnapshotToDb);
});
