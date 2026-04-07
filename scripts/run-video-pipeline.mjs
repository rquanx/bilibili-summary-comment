import fs from "node:fs";
import {
  createClient,
  getTopComment,
  getType,
  parseArgs,
  printJson,
  readCookie,
  showUsage,
} from "./lib/bili-comment-utils.mjs";
import { listVideoParts, openDatabase } from "./lib/storage.mjs";
import { fetchVideoSnapshot, syncVideoSnapshotToDb } from "./lib/video-state.mjs";
import { ensureSubtitleForPart } from "./lib/subtitle-pipeline.mjs";
import { resolveSummaryConfig, summarizePartFromSubtitle } from "./lib/summarizer.mjs";
import { postSummaryThread } from "./lib/comment-thread.mjs";
import { findReusableSummarySource, reusePartSummaries } from "./lib/live-session-reuse.mjs";
import { writePartSummaryArtifact, writeSummaryArtifacts } from "./lib/summary-files.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";

loadDotEnvIfPresent();

function createProgressReporter(totalParts) {
  const outputStream = process.stderr;
  const safeTotalParts = Math.max(totalParts, 1);

  return {
    outputStream,
    log(message) {
      outputStream.write(`[${formatProgressTime()}] ${message}\n`);
    },
    logPart(index, part, stage, detail = "") {
      const partLabel = formatPartLabel(part.page_no, part.part_title);
      const suffix = detail ? `: ${detail}` : "";
      outputStream.write(`[${formatProgressTime()}] [${index}/${safeTotalParts}] ${partLabel} ${stage}${suffix}\n`);
    },
    logPartStage(pageNo, stage, detail = "") {
      const suffix = detail ? `: ${detail}` : "";
      outputStream.write(`[${formatProgressTime()}] [P${pageNo}] ${stage}${suffix}\n`);
    },
  };
}

function formatProgressTime(date = new Date()) {
  return date.toTimeString().slice(0, 8);
}

function formatPartLabel(pageNo, partTitle) {
  const normalizedTitle = String(partTitle ?? "").trim();
  return normalizedTitle ? `P${pageNo} ${normalizedTitle}` : `P${pageNo}`;
}

function describeSubtitleResult(result) {
  if (result.reused) {
    return "Using local subtitle";
  }

  if (result.subtitleSource === "bili_ai") {
    return "Using Bilibili AI subtitle";
  }

  if (result.subtitleSource === "bili_subtitle") {
    return "Using Bilibili subtitle";
  }

  return "Using ASR transcription";
}

function usage() {
  showUsage([
    "Usage:",
    "  node scripts/run-video-pipeline.mjs --cookie-file cookie.txt --bvid BVxxxx [--publish]",
    "  node scripts/run-video-pipeline.mjs --cookie-file cookie.txt --url https://www.bilibili.com/video/BVxxxx [--publish]",
    "",
    "Options:",
    "  --cookie / --cookie-file   Required. Bilibili cookie string or cookie file path.",
    "  --oid / --aid              Optional. Video aid.",
    "  --bvid / --url             Optional. Video bvid or url.",
    "  --db                       Optional. SQLite path. Default: work/pipeline.sqlite3",
    "  --work-root                Optional. Work root. Default: work",
    "  --venv-path                Optional. Python venv path. Default: .3.11",
    "  --asr                      Optional. VideoCaptioner ASR engine. Default: bijian",
    "  --model                    Optional. Summary model. Default: env or gpt-4o-mini",
    "  --api-key                  Optional. Summary API key. Default: SUMMARY_API_KEY / OPENAI_API_KEY",
    "  --api-base-url             Optional. Summary API base url. Default: SUMMARY_API_BASE_URL / OPENAI_BASE_URL / https://api.openai.com/v1",
    "  --api-format               Optional. Summary API format: auto | responses | openai-chat | anthropic-messages. Default: env or auto",
    "  --publish                  Optional. Publish pending summaries after generation.",
    "  --force-summary            Optional. Regenerate summaries even if already present.",
    "  --help                     Show this help.",
  ]);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    usage();
    return;
  }

  const cookie = readCookie(args);
  const client = createClient(cookie);
  const dbPath = args.db ?? "work/pipeline.sqlite3";
  const workRoot = args["work-root"] ?? "work";
  const venvPath = args["venv-path"] ?? ".3.11";
  const asr = args.asr ?? "bijian";
  const db = openDatabase(dbPath);

  const snapshot = await fetchVideoSnapshot(client, args);
  const state = syncVideoSnapshotToDb(db, snapshot);
  const summaryConfig = resolveSummaryConfig(args);
  const forceSummary = Boolean(args["force-summary"]);

  const totalParts = state.video.page_count ?? snapshot?.pages?.length ?? 0;
  let currentParts = listVideoParts(db, state.video.id);
  let reusedSummarySource = null;
  const hasPendingSummaries = currentParts.some((part) => !String(part.summary_text ?? "").trim());

  if (!forceSummary && hasPendingSummaries) {
    reusedSummarySource = findReusableSummarySource(db, state.video, currentParts);
    if (reusedSummarySource) {
      const reusedPages = reusePartSummaries(db, state.video.id, reusedSummarySource.parts);
      currentParts = listVideoParts(db, state.video.id);
      if (reusedPages.length > 0) {
        reusedSummarySource = {
          ...reusedSummarySource,
          reusedPages,
        };

        for (const part of currentParts) {
          if (!reusedPages.includes(part.page_no)) {
            continue;
          }

          writePartSummaryArtifact({
            bvid: state.video.bvid,
            pageNo: part.page_no,
            summaryText: part.summary_text,
            workRoot,
          });
        }
      } else {
        reusedSummarySource = null;
      }
    }
  }

  const targetParts = currentParts.filter((part) => forceSummary || !String(part.summary_text ?? "").trim());
  const progress = createProgressReporter(targetParts.length);

  progress.log(`Video synced: ${state.video.title} (total parts: ${totalParts}, pending: ${targetParts.length})`);
  if (reusedSummarySource) {
    progress.log(
      `Reused ${reusedSummarySource.reusedPages.length} summaries from ${reusedSummarySource.video.bvid} (${reusedSummarySource.video.title})`,
    );
  }
  if (targetParts.length === 0) {
    progress.log("All parts already have summaries, skipping subtitle and summary generation");
  }

  const subtitleResults = [];
  const summaryResults = [];

  for (const [index, part] of targetParts.entries()) {
    const currentIndex = index + 1;
    progress.logPart(currentIndex, part, "Started");

    const subtitleResult = await ensureSubtitleForPart({
      client,
      db,
      videoId: state.video.id,
      bvid: state.video.bvid,
      pageNo: part.page_no,
      cid: part.cid,
      cookie,
      cookieFile: args["cookie-file"] ?? null,
      durationSec: part.duration_sec,
      workRoot,
      venvPath,
      asr,
      progress,
    });
    progress.logPart(currentIndex, part, "Subtitle ready", describeSubtitleResult(subtitleResult));
    subtitleResults.push({
      pageNo: part.page_no,
      subtitlePath: subtitleResult.subtitlePath,
      subtitleSource: subtitleResult.subtitleSource,
      reused: subtitleResult.reused,
    });

    progress.logPart(currentIndex, part, "Generating summary", `model ${summaryConfig.model}`);
    const summaryResult = await summarizePartFromSubtitle({
      db,
      videoId: state.video.id,
      bvid: state.video.bvid,
      pageNo: part.page_no,
      partTitle: part.part_title,
      durationSec: part.duration_sec,
      subtitlePath: subtitleResult.subtitlePath,
      model: summaryConfig.model,
      apiKey: summaryConfig.apiKey,
      apiBaseUrl: summaryConfig.apiBaseUrl,
      apiFormat: summaryConfig.apiFormat,
      workRoot,
    });
    progress.logPart(currentIndex, part, "Summary ready", summaryResult.summaryPath);
    summaryResults.push({
      pageNo: part.page_no,
      summaryPath: summaryResult.summaryPath,
      summaryHash: summaryResult.summaryHash,
    });
  }

  progress.log("Writing summary artifacts");
  const artifacts = writeSummaryArtifacts(db, state.video, workRoot);
  let publishResult = null;

  if (args.publish) {
    progress.log("Publishing pending summaries");
    const pendingMessage = artifacts.pendingSummaryPath ? fs.readFileSync(artifacts.pendingSummaryPath, "utf8").trim() : "";
    if (pendingMessage) {
      const type = getType(args);
      const topCommentState = await getTopComment(client, { oid: state.video.aid, type });
      publishResult = await postSummaryThread({
        client,
        oid: state.video.aid,
        type,
        message: pendingMessage,
        db,
        videoId: state.video.id,
        topCommentState,
        existingRootRpid: state.video.root_comment_rpid,
        forcedRootRpid: null,
      });
      writeSummaryArtifacts(db, state.video, workRoot);
      progress.log(`Publish complete, sent ${publishResult.createdComments?.length ?? 0} comments`);
    } else {
      publishResult = {
        action: "skip-publish",
        reason: "No pending summaries to publish.",
      };
      progress.log("No pending content to publish, skipping publish step");
    }
  }

  progress.log(`Pipeline complete, generated ${summaryResults.length} summaries`);

  printJson({
    ok: true,
    dbPath,
    video: {
      id: state.video.id,
      bvid: state.video.bvid,
      aid: state.video.aid,
      title: state.video.title,
      pageCount: state.video.page_count,
    },
    generatedPages: summaryResults.map((item) => item.pageNo),
    subtitleResults,
    summaryResults,
    reusedSummaryFrom: reusedSummarySource
      ? {
          bvid: reusedSummarySource.video.bvid,
          title: reusedSummarySource.video.title,
          reusedPages: reusedSummarySource.reusedPages,
        }
      : null,
    artifacts,
    publishResult,
  });
}

main().catch((error) => {
  printJson({
    ok: false,
    message: error?.message ?? "Unknown error",
    stack: error?.stack,
  });
  process.exitCode = 1;
});
