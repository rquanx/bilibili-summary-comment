import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDatabase } from "../scripts/lib/db/database";
import { listVideoParts, savePartSummary, upsertVideo, upsertVideoPart } from "../scripts/lib/db/video-storage";
import { runGenerationStage } from "../scripts/lib/pipeline/generation-stage";
import { writePartSummaryArtifact } from "../scripts/lib/summary/files";
import { createSummaryHash } from "../scripts/lib/video/change-detection";

test("runGenerationStage skips content-filtered summary pages and continues later parts", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "generation-stage-"));
  const dbPath = path.join(tempRoot, "pipeline.sqlite3");
  const workRoot = path.join(".tmp-tests", path.basename(tempRoot)).replace(/\\/gu, "/");
  const repoWorkRoot = path.join(process.cwd(), workRoot);
  const db = openDatabase(dbPath);
  const progressMessages: string[] = [];

  try {
    const video = upsertVideo(db, {
      bvid: "BVskipcontent1",
      aid: 123001,
      title: "Generation Stage Skip Test",
      pageCount: 2,
    });

    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 1,
      cid: 101,
      partTitle: "P1",
      durationSec: 60,
      isDeleted: false,
    });
    upsertVideoPart(db, {
      videoId: video.id,
      pageNo: 2,
      cid: 202,
      partTitle: "P2",
      durationSec: 60,
      isDeleted: false,
    });

    const result = await runGenerationStage({
      client: {},
      db,
      video,
      cookie: "SESSDATA=fake",
      workRoot,
      summaryConfig: {
        model: "gpt-test",
        apiKey: "key-123",
        apiBaseUrl: "https://example.com/v1",
        apiFormat: "openai-chat",
        promptConfigPath: null,
      },
      progress: {
        info(message) {
          progressMessages.push(`info:${message}`);
        },
        warn(message) {
          progressMessages.push(`warn:${message}`);
        },
        logPart(index, part, stage, detail = "") {
          progressMessages.push(`part:${index}:P${part.page_no}:${stage}:${detail}`);
        },
      },
      ensureSubtitleForPartImpl: async ({ pageNo }) => {
        const subtitlePath = path.join(tempRoot, `p${pageNo}.srt`);
        fs.writeFileSync(subtitlePath, [
          "1",
          "00:00:00,000 --> 00:00:02,000",
          `subtitle ${pageNo}`,
          "",
        ].join("\n"), "utf8");
        return {
          subtitlePath,
          subtitleSource: "local",
          subtitleLang: "zh-CN",
          reused: false,
          durationSec: 60,
        };
      },
      summarizePartFromSubtitleImpl: async ({ db, videoId, bvid, pageNo, workRoot }) => {
        if (pageNo === 1) {
          throw new Error("Summary request failed: 400 Bad Request\n{\"error\":{\"message\":\"Error from provider: Provider returned error\",\"metadata\":{\"raw\":\"{\\\"error\\\":{\\\"code\\\":400,\\\"message\\\":\\\"The request was rejected because it was considered high risk\\\",\\\"param\\\":\\\"prompt\\\",\\\"type\\\":\\\"content_filter\\\"}}\"}}}");
        }

        const summaryText = "<2P> 2#00:00 successful summary";
        const summaryHash = createSummaryHash(summaryText);
        savePartSummary(db, videoId, pageNo, {
          summaryText,
          summaryHash,
        });
        const summaryPath = writePartSummaryArtifact({
          db,
          video,
          pageNo,
          summaryText,
          workRoot,
        });
        const dbRow = listVideoParts(db, videoId).find((part) => part.page_no === pageNo) ?? null;
        return {
          pageNo,
          summaryText,
          summaryHash,
          promptPath: null,
          summaryPath,
          dbRow,
          modelUsed: "gpt-test",
          fallbackUsed: false,
        };
      },
    });

    assert.deepEqual(result.summaryResults.map((item) => item.pageNo), [2]);
    assert.deepEqual(result.skippedSummaryResults.map((item) => item.pageNo), [1]);
    assert.match(
      progressMessages.join("\n"),
      /Summary skipped/u,
    );
    assert.match(
      fs.readFileSync(result.artifacts.summaryPath, "utf8").trim(),
      /<2P> 2#00:00 successful summary/u,
    );
    assert.match(
      fs.readFileSync(result.artifacts.pendingSummaryPath, "utf8").trim(),
      /<2P> 2#00:00 successful summary/u,
    );

    const parts = listVideoParts(db, video.id);
    assert.equal(String(parts[0].summary_text ?? "").trim(), "");
    assert.equal(parts[1].summary_text, "<2P> 2#00:00 successful summary");
  } finally {
    db.close?.();
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(repoWorkRoot, { recursive: true, force: true });
  }
});
