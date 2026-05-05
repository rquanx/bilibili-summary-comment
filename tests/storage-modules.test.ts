import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { openDatabase } from "../src/infra/db/database";
import { getGapNotificationByKey, hasGapNotification, saveGapNotification } from "../src/infra/db/gap-notification-storage";
import { insertPipelineEvent, listPipelineEvents } from "../src/infra/db/pipeline-event-storage";
import { getLatestSuccessfulRecentReprocessRunByCandidateKey, saveRecentReprocessRun } from "../src/infra/db/recent-reprocess-storage";
import {
  getVideoByIdentity,
  listVideoParts,
  listPendingPublishParts,
  listPendingSummaryParts,
  savePartSummary,
  upsertVideo,
  upsertVideoPart,
} from "../src/infra/db/video-storage";
import * as storage from "../src/infra/db/index";
import { invalidateSummaries } from "../src/domains/summary/invalidation";

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

test("openDatabase upgrades a legacy schema and seeds drizzle migration history", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-legacy-storage-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const legacyDb = new BetterSqlite3(dbPath);

  legacyDb.exec(`
    CREATE TABLE videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bvid TEXT NOT NULL UNIQUE,
      aid INTEGER NOT NULL UNIQUE,
      title TEXT NOT NULL,
      page_count INTEGER NOT NULL DEFAULT 0,
      root_comment_rpid INTEGER,
      top_comment_rpid INTEGER,
      last_scan_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE video_parts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id INTEGER NOT NULL,
      page_no INTEGER NOT NULL,
      cid INTEGER NOT NULL,
      part_title TEXT NOT NULL,
      duration_sec INTEGER NOT NULL DEFAULT 0,
      subtitle_path TEXT,
      subtitle_source TEXT,
      subtitle_lang TEXT,
      summary_text TEXT,
      summary_hash TEXT,
      published INTEGER NOT NULL DEFAULT 0,
      published_comment_rpid INTEGER,
      published_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(video_id) REFERENCES videos(id) ON DELETE CASCADE
    );
    INSERT INTO videos (bvid, aid, title, page_count, created_at, updated_at)
    VALUES ('BVLEGACY001', 900001, 'Legacy Video', 1, '2026-05-05T00:00:00.000Z', '2026-05-05T00:00:00.000Z');
    INSERT INTO video_parts (
      video_id,
      page_no,
      cid,
      part_title,
      duration_sec,
      subtitle_path,
      subtitle_source,
      subtitle_lang,
      summary_text,
      summary_hash,
      published,
      created_at,
      updated_at
    )
    VALUES (
      1,
      1,
      990001,
      'Legacy P1',
      60,
      'legacy.srt',
      'local',
      'zh-CN',
      '<1P> legacy summary',
      'legacy-hash',
      1,
      '2026-05-05T00:00:00.000Z',
      '2026-05-05T00:00:00.000Z'
    );
  `);
  legacyDb.close();

  const db = openDatabase(dbPath);
  try {
    const video = getVideoByIdentity(db, { bvid: "BVLEGACY001" });
    const parts = listVideoParts(db, Number(video?.id));
    const videoPartColumns = db.prepare("PRAGMA table_info(video_parts)").all() as Array<{ name: string }>;
    const migrationRows = db.prepare("SELECT hash, created_at FROM __drizzle_migrations ORDER BY created_at ASC").all() as Array<{
      hash: string;
      created_at: number;
    }>;

    assert.equal(video?.title, "Legacy Video");
    assert.equal(parts.length, 1);
    assert.equal(parts[0].summary_text, "<1P> legacy summary");
    assert.equal(parts[0].summary_text_processed, null);
    assert.equal(parts[0].prompt_text, null);
    assert.equal(parts[0].subtitle_text, null);
    assert.equal(Number(parts[0].is_deleted), 0);
    assert.ok(videoPartColumns.some((column) => column.name === "is_deleted"));
    assert.ok(videoPartColumns.some((column) => column.name === "summary_text_processed"));
    assert.ok(videoPartColumns.some((column) => column.name === "subtitle_text"));
    assert.ok(videoPartColumns.some((column) => column.name === "prompt_text"));
    assert.equal(migrationRows.length, 1);
    assert.equal(typeof migrationRows[0]?.hash, "string");
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("recent reprocess run storage records successes and can query the latest successful candidate", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-reprocess-storage-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVREPROCESS1",
      aid: 888001,
      title: "Recent Reprocess Storage",
      pageCount: 1,
    });

    saveRecentReprocessRun(db, {
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      candidateKey: "{\"bvid\":\"BVREPROCESS1\",\"reasons\":[\"paste-rs-processed-summary\"],\"pastePages\":[8]}",
      reasons: ["paste-rs-processed-summary"],
      pastePages: [8],
      status: "failed",
      errorMessage: "temporary failure",
    });
    const success = saveRecentReprocessRun(db, {
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      candidateKey: "{\"bvid\":\"BVREPROCESS1\",\"reasons\":[\"paste-rs-processed-summary\"],\"pastePages\":[8]}",
      reasons: ["paste-rs-processed-summary"],
      pastePages: [8],
      status: "success",
      details: {
        generatedPages: [8],
      },
    });

    const latest = getLatestSuccessfulRecentReprocessRunByCandidateKey(
      db,
      "{\"bvid\":\"BVREPROCESS1\",\"reasons\":[\"paste-rs-processed-summary\"],\"pastePages\":[8]}",
    );
    assert.equal(latest?.id, success.id);
    assert.equal(latest?.status, "success");
    assert.match(String(latest?.details_json ?? ""), /generatedPages/);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("invalidateSummaries previews and clears stored summaries while marking publish rebuild", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-invalidate-summary-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVINVALID001",
      aid: 701001,
      title: "Invalidate Summary Test",
      pageCount: 2,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 801001,
      partTitle: "P1",
      durationSec: 120,
      promptText: "old prompt",
      summaryText: "<1P> old summary",
      processedSummaryText: "<1P> old summary processed",
      summaryHash: "hash-1",
      published: true,
      publishedCommentRpid: 998877,
      publishedAt: "2026-05-05T00:00:00.000Z",
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 2,
      cid: 801002,
      partTitle: "P2",
      durationSec: 120,
      isDeleted: false,
    });

    const preview = invalidateSummaries(db, {
      bvid: video.bvid,
      dryRun: true,
      reason: "summary-input-upgrade-2026-05-05",
    });
    assert.equal(preview.videoCount, 1);
    assert.equal(preview.affectedVideoCount, 1);
    assert.equal(preview.activePartCount, 2);
    assert.equal(preview.affectedPartCount, 1);

    const persistedBefore = listVideoParts(db, video.id);
    assert.equal(String(persistedBefore[0].summary_text ?? "").trim(), "<1P> old summary");
    assert.equal(Number(getVideoByIdentity(db, { bvid: video.bvid })?.publish_needs_rebuild ?? 0), 0);

    const applied = invalidateSummaries(db, {
      bvid: video.bvid,
      reason: "summary-input-upgrade-2026-05-05",
    });
    assert.equal(applied.affectedPartCount, 1);

    const persistedAfter = listVideoParts(db, video.id);
    assert.equal(persistedAfter[0].summary_text, null);
    assert.equal(persistedAfter[0].summary_text_processed, null);
    assert.equal(persistedAfter[0].summary_hash, null);
    assert.equal(persistedAfter[0].prompt_text, null);
    assert.equal(Number(persistedAfter[0].published), 0);
    assert.equal(persistedAfter[0].published_comment_rpid, null);
    assert.equal(persistedAfter[0].published_at, null);
    assert.equal(persistedAfter[1].summary_text, null);

    const persistedVideo = getVideoByIdentity(db, { bvid: video.bvid });
    assert.equal(Number(persistedVideo?.publish_needs_rebuild ?? 0), 1);
    assert.equal(persistedVideo?.publish_rebuild_reason, "summary-input-upgrade-2026-05-05");
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("invalidateSummaries can target only recently updated parts or a specific time window", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-invalidate-window-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const video = upsertVideo(db, {
      bvid: "BVINVALID002",
      aid: 701002,
      title: "Invalidate Summary Window Test",
      pageCount: 2,
    });

    const oldPart = upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 802001,
      partTitle: "P1",
      durationSec: 120,
      promptText: "old prompt",
      summaryText: "<1P> old summary",
      processedSummaryText: "<1P> old summary processed",
      summaryHash: "hash-old",
      isDeleted: false,
    });
    const recentPart = upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 2,
      cid: 802002,
      partTitle: "P2",
      durationSec: 120,
      promptText: "recent prompt",
      summaryText: "<2P> recent summary",
      processedSummaryText: "<2P> recent summary processed",
      summaryHash: "hash-recent",
      isDeleted: false,
    });

    db.prepare("UPDATE video_parts SET updated_at = ? WHERE id = ?").run("2026-04-01T00:00:00.000Z", oldPart.id);
    db.prepare("UPDATE video_parts SET updated_at = ? WHERE id = ?").run("2026-05-04T12:00:00.000Z", recentPart.id);

    const preview = invalidateSummaries(db, {
      recentDays: 3,
      dryRun: true,
      now: new Date("2026-05-05T12:00:00.000Z"),
    });
    assert.equal(preview.scope, "all");
    assert.equal(preview.videoCount, 1);
    assert.equal(preview.matchedPartCount, 1);
    assert.equal(preview.affectedPartCount, 1);
    assert.equal(preview.videos[0].matchedPartCount, 1);
    assert.equal(preview.videos[0].affectedPartCount, 1);

    const applied = invalidateSummaries(db, {
      recentDays: 3,
      now: new Date("2026-05-05T12:00:00.000Z"),
      reason: "summary-input-upgrade-2026-05-05",
    });
    assert.equal(applied.affectedPartCount, 1);

    const partsAfterRecent = listVideoParts(db, video.id);
    assert.equal(String(partsAfterRecent[0].summary_text ?? "").trim(), "<1P> old summary");
    assert.equal(partsAfterRecent[1].summary_text, null);

    const rangePreview = invalidateSummaries(db, {
      fromIso: "2026-03-31",
      toIso: "2026-04-02",
      dryRun: true,
    });
    assert.equal(rangePreview.matchedPartCount, 1);
    assert.equal(rangePreview.affectedPartCount, 1);

    invalidateSummaries(db, {
      fromIso: "2026-03-31",
      toIso: "2026-04-02",
      reason: "summary-input-upgrade-2026-05-05",
    });

    const partsAfterRange = listVideoParts(db, video.id);
    assert.equal(partsAfterRange[0].summary_text, null);
    assert.equal(partsAfterRange[1].summary_text, null);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
