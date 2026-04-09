import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../scripts/lib/db/database.js";
import { insertPipelineEvent, listPipelineEvents } from "../scripts/lib/db/pipeline-event-storage.js";
import {
  getVideoByIdentity,
  listPendingPublishParts,
  listPendingSummaryParts,
  savePartSummary,
  upsertVideo,
  upsertVideoPart,
} from "../scripts/lib/db/video-storage.js";
import * as storage from "../scripts/lib/db/index.js";

test("storage modules preserve video and event workflows after the split", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-storage-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BV1test123456",
      aid: 123456,
      title: "Storage Split Test",
      pageCount: 1,
    });

    const part = upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 999001,
      partTitle: "P1",
      durationSec: 42,
      isDeleted: false,
    });

    assert.equal(getVideoByIdentity(db, { bvid: "BV1test123456" }).id, video.id);
    assert.equal(listPendingSummaryParts(db, video.id).length, 1);
    assert.equal(part.page_no, 1);

    savePartSummary(db, video.id, 1, {
      summaryText: "<1P> test summary",
      summaryHash: "hash-1",
    });

    assert.equal(listPendingSummaryParts(db, video.id).length, 0);
    assert.equal(listPendingPublishParts(db, video.id).length, 1);

    insertPipelineEvent(db, {
      runId: "run-1",
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      pageNo: 1,
      cid: 999001,
      partTitle: "P1",
      scope: "summary",
      action: "llm",
      status: "succeeded",
      message: "summary ready",
      details: { model: "test-model" },
    });

    const events = listPipelineEvents(db, { bvid: video.bvid, limit: 5 });
    assert.equal(events.length, 1);
    assert.match(events[0].details_json, /test-model/);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("storage barrel re-exports the split modules", () => {
  assert.equal(storage.openDatabase, openDatabase);
  assert.equal(storage.upsertVideo, upsertVideo);
  assert.equal(storage.insertPipelineEvent, insertPipelineEvent);
});
