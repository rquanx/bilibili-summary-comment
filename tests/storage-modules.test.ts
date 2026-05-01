import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../src/infra/db/database";
import { getGapNotificationByKey, hasGapNotification, saveGapNotification } from "../src/infra/db/gap-notification-storage";
import { insertPipelineEvent, listPipelineEvents } from "../src/infra/db/pipeline-event-storage";
import {
  getVideoByIdentity,
  listPendingPublishParts,
  listPendingSummaryParts,
  savePartSummary,
  upsertVideo,
  upsertVideoPart,
} from "../src/infra/db/video-storage";
import * as storage from "../src/infra/db/index";

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

test("gap notification storage deduplicates notifications by gap key", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-gap-storage-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const first = saveGapNotification(db, {
      gapKey: "BV1gap|101|202|2026-04-12 01:00:00|2026-04-12 01:00:15|15",
      bvid: "BV1gap",
      videoTitle: "Gap Storage Test",
      fromPageNo: 1,
      fromCid: 101,
      toPageNo: 2,
      toCid: 202,
      gapStartAt: "2026-04-12 01:00:00",
      gapEndAt: "2026-04-12 01:00:15",
      gapSeconds: 15,
      notifiedAt: "2026-04-12T02:00:00.000Z",
    });
    const second = saveGapNotification(db, {
      gapKey: "BV1gap|101|202|2026-04-12 01:00:00|2026-04-12 01:00:15|15",
      bvid: "BV1gap",
      videoTitle: "Gap Storage Test Updated",
      fromPageNo: 1,
      fromCid: 101,
      toPageNo: 2,
      toCid: 202,
      gapStartAt: "2026-04-12 01:00:00",
      gapEndAt: "2026-04-12 01:00:15",
      gapSeconds: 15,
      notifiedAt: "2026-04-12T03:00:00.000Z",
    });

    assert.equal(first?.gap_key, second?.gap_key);
    assert.equal(hasGapNotification(db, first?.gap_key ?? ""), true);
    assert.equal(getGapNotificationByKey(db, first?.gap_key ?? "")?.video_title, "Gap Storage Test Updated");
    assert.equal(getGapNotificationByKey(db, first?.gap_key ?? "")?.notified_at, "2026-04-12T03:00:00.000Z");
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("storage barrel re-exports the split modules", () => {
  assert.equal(storage.openDatabase, openDatabase);
  assert.equal(storage.upsertVideo, upsertVideo);
  assert.equal(storage.insertPipelineEvent, insertPipelineEvent);
  assert.equal(storage.saveGapNotification, saveGapNotification);
});
