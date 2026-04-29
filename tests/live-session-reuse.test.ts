import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../scripts/lib/db/database";
import { listVideoParts, savePartSubtitle, upsertVideo, upsertVideoPart } from "../scripts/lib/db/index";
import { resolveVideoWorkDir } from "../scripts/lib/shared/work-paths";
import { findReusableSummarySource, reusePartSummaries } from "../scripts/lib/summary/live-session-reuse";
import { ensureSubtitleForPart } from "../scripts/lib/subtitle/pipeline";

test("same-session summary reuse works across variants even when page counts differ", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-live-reuse-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const sourceVideo = upsertVideo(db, {
      bvid: "BVSOURCE16",
      aid: 116,
      title: "Anchor Session 2026.04.11 20.29.51",
      pageCount: 16,
    });
    const targetVideo = upsertVideo(db, {
      bvid: "BVTARGET09",
      aid: 209,
      title: "Anchor Session 2026.04.11 20.29.51",
      pageCount: 9,
    });

    const sharedParts = [
      "Anchor Session 2026.04.11 20.29.51",
      "Anchor Session 2026.04.11 21.29.50",
      "Anchor Session 2026.04.11 21.52.15",
    ];

    for (const [index, partTitle] of sharedParts.entries()) {
      upsertVideoPart(db, {
        videoId: sourceVideo.id,
        pageNo: index + 1,
        cid: 1000 + index,
        partTitle,
        durationSec: 60,
        summaryText: `summary-${index + 1}`,
        summaryHash: `hash-${index + 1}`,
        isDeleted: false,
      });
      upsertVideoPart(db, {
        videoId: targetVideo.id,
        pageNo: index + 1,
        cid: 2000 + index,
        partTitle,
        durationSec: 60,
        isDeleted: false,
      });
    }

    upsertVideoPart(db, {
      videoId: sourceVideo.id,
      pageNo: 4,
      cid: 1004,
      partTitle: "Anchor Session 2026.04.11 22.01.31",
      durationSec: 60,
      summaryText: "summary-4",
      summaryHash: "hash-4",
      isDeleted: false,
    });

    const targetParts = listVideoParts(db, targetVideo.id);
    const reuseSource = findReusableSummarySource(db, targetVideo, targetParts);
    assert.equal(reuseSource?.video.bvid, "BVSOURCE16");
    assert.deepEqual(reuseSource?.matchedPages, [1, 2, 3]);

    const reusedPages = reusePartSummaries(db, targetVideo.id, reuseSource?.parts ?? []);
    assert.deepEqual(reusedPages, [1, 2, 3]);

    const updatedTargetParts = listVideoParts(db, targetVideo.id);
    assert.deepEqual(
      updatedTargetParts.map((part) => String(part.summary_text ?? "").trim()),
      ["summary-1", "summary-2", "summary-3"],
    );
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("same-session summary reuse does not copy processed paste-link fallbacks into the target video", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-live-reuse-processed-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);

  try {
    const sourceVideo = upsertVideo(db, {
      bvid: "BVSOURCEPROC1",
      aid: 1016,
      title: "Anchor Session 2026.04.11 20.29.51",
      pageCount: 1,
    });
    const targetVideo = upsertVideo(db, {
      bvid: "BVTARGETPROC1",
      aid: 1209,
      title: "Anchor Session 2026.04.11 20.29.51",
      pageCount: 1,
    });

    upsertVideoPart(db, {
      videoId: sourceVideo.id,
      pageNo: 1,
      cid: 1100,
      partTitle: "Anchor Session 2026.04.11 20.29.51",
      durationSec: 60,
      summaryText: "<1P>\n1#00:00 original summary",
      processedSummaryText: "<1P>\nhttps://paste.rs/source01",
      summaryHash: "hash-source-1",
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: targetVideo.id,
      pageNo: 1,
      cid: 2100,
      partTitle: "Anchor Session 2026.04.11 20.29.51",
      durationSec: 60,
      isDeleted: false,
    });

    const targetParts = listVideoParts(db, targetVideo.id);
    const reuseSource = findReusableSummarySource(db, targetVideo, targetParts);
    assert.equal(reuseSource?.video.bvid, "BVSOURCEPROC1");

    const reusedPages = reusePartSummaries(db, targetVideo.id, reuseSource?.parts ?? []);
    assert.deepEqual(reusedPages, [1]);

    const [reusedPart] = listVideoParts(db, targetVideo.id);
    assert.equal(String(reusedPart?.summary_text ?? "").trim(), "<1P>\n1#00:00 original summary");
    assert.equal(reusedPart?.summary_text_processed, null);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("ensureSubtitleForPart reuses same-session subtitles across variants with different page counts", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-subtitle-reuse-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const relativeWorkRoot = path.join(".tmp-tests", path.basename(tempRoot));
  const repoWorkRoot = path.join(process.cwd(), relativeWorkRoot);

  try {
    const sourceVideo = upsertVideo(db, {
      bvid: "BVSUBSRC16",
      aid: 316,
      title: "Anchor Session 2026.04.11 20.29.51",
      ownerName: "Anchor Reuse",
      ownerMid: 101,
      ownerDirName: "Anchor Reuse",
      workDirName: "2026.04.11-20.29.51-clean__BVSUBSRC16",
      pageCount: 16,
    });
    const targetVideo = upsertVideo(db, {
      bvid: "BVSUBDST09",
      aid: 409,
      title: "Anchor Session 2026.04.11 20.29.51",
      ownerName: "Anchor Reuse",
      ownerMid: 101,
      ownerDirName: "Anchor Reuse",
      workDirName: "2026.04.11-20.29.51-danmu__BVSUBDST09",
      pageCount: 9,
    });

    upsertVideoPart(db, {
      videoId: sourceVideo.id,
      pageNo: 4,
      cid: 4100,
      partTitle: "Anchor Session 2026.04.11 22.01.31",
      durationSec: 60,
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: targetVideo.id,
      pageNo: 4,
      cid: 4200,
      partTitle: "Anchor Session 2026.04.11 22.01.31",
      durationSec: 60,
      isDeleted: false,
    });

    const sourceWorkDir = resolveVideoWorkDir(sourceVideo, relativeWorkRoot, process.cwd());
    fs.mkdirSync(sourceWorkDir, { recursive: true });
    const sourceSubtitlePath = path.join(sourceWorkDir, "cid-4100.srt");
    fs.writeFileSync(sourceSubtitlePath, "1\n00:00:00,000 --> 00:00:01,000\nsame subtitle\n", "utf8");
    savePartSubtitle(db, sourceVideo.id, 4, {
      subtitlePath: sourceSubtitlePath,
      subtitleSource: "asr",
      subtitleLang: "zh-CN",
    });

    const result = await ensureSubtitleForPart({
      client: null,
      db,
      video: targetVideo,
      videoId: targetVideo.id,
      bvid: targetVideo.bvid,
      videoTitle: targetVideo.title,
      pageNo: 4,
      cid: 4200,
      partTitle: "Anchor Session 2026.04.11 22.01.31",
      existingSubtitlePath: null,
      cookie: "",
      workRoot: relativeWorkRoot,
      progress: null,
      eventLogger: null,
    });

    const expectedSubtitlePath = path.join(resolveVideoWorkDir(targetVideo, relativeWorkRoot, process.cwd()), "cid-4200.srt");
    assert.equal(result.reused, true);
    assert.equal(result.subtitlePath, expectedSubtitlePath);
    assert.equal(result.subtitleSource, "asr");
    assert.equal(result.subtitleLang, "zh-CN");
    assert.equal(fs.existsSync(expectedSubtitlePath), true);
    assert.equal(fs.readFileSync(expectedSubtitlePath, "utf8"), fs.readFileSync(sourceSubtitlePath, "utf8"));

    const targetPart = listVideoParts(db, targetVideo.id).find((part) => part.page_no === 4);
    assert.equal(targetPart?.subtitle_path, expectedSubtitlePath);
    assert.equal(targetPart?.subtitle_source, "asr");
    assert.equal(targetPart?.subtitle_lang, "zh-CN");
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(repoWorkRoot, { recursive: true, force: true });
  }
});

test("ensureSubtitleForPart discards unusable local placeholder subtitles before falling back to ASR", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "video-pipeline-subtitle-quality-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const db = openDatabase(dbPath);
  const relativeWorkRoot = path.join(".tmp-tests", path.basename(tempRoot));
  const repoWorkRoot = path.join(process.cwd(), relativeWorkRoot);

  try {
    const video = upsertVideo(db, {
      bvid: "BVLOCALBAD1",
      aid: 510,
      title: "Bad Local Subtitle Test",
      ownerName: "Quality Check",
      ownerMid: 510,
      ownerDirName: "Quality Check",
      workDirName: "bad-local-subtitle-test__BVLOCALBAD1",
      pageCount: 1,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 5100,
      partTitle: "P1",
      durationSec: 60,
      isDeleted: false,
    });

    const workDir = resolveVideoWorkDir(video, relativeWorkRoot, process.cwd());
    fs.mkdirSync(workDir, { recursive: true });
    const subtitlePath = path.join(workDir, "cid-5100.srt");
    const audioPath = path.join(workDir, "cid-5100.m4a");
    fs.writeFileSync(subtitlePath, [
      "1",
      "00:00:00,000 --> 00:00:01,000",
      "字幕志愿者李宗盛",
      "",
      "2",
      "00:00:02,000 --> 00:00:03,000",
      "字幕志愿者",
      "",
      "3",
      "00:00:04,000 --> 00:00:05,000",
      "李宗盛",
      "",
    ].join("\n"), "utf8");
    fs.writeFileSync(audioPath, "", "utf8");

    let transcribeCalls = 0;
    const result = await ensureSubtitleForPart({
      client: null,
      db,
      video,
      videoId: video.id,
      bvid: video.bvid,
      videoTitle: video.title,
      pageNo: 1,
      cid: 5100,
      partTitle: "P1",
      existingSubtitlePath: subtitlePath,
      cookie: "",
      workRoot: relativeWorkRoot,
      progress: null,
      eventLogger: null,
      tryDownloadBiliSubtitleImpl: async () => null,
      transcribeWithRetriesImpl: async ({ subtitlePath: nextSubtitlePath }) => {
        transcribeCalls += 1;
        fs.writeFileSync(nextSubtitlePath, [
          "1",
          "00:00:00,000 --> 00:00:02,000",
          "retry transcription succeeded",
          "",
        ].join("\n"), "utf8");
      },
    });

    assert.equal(transcribeCalls, 1);
    assert.equal(result.subtitleSource, "asr");
    assert.equal(result.reused, false);
    assert.match(fs.readFileSync(subtitlePath, "utf8"), /retry transcription succeeded/u);

    const part = listVideoParts(db, video.id).find((item) => item.page_no === 1);
    assert.equal(part?.subtitle_source, "asr");
    assert.equal(part?.subtitle_path, subtitlePath);
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(repoWorkRoot, { recursive: true, force: true });
  }
});
