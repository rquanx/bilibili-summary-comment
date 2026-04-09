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
import {
  clearVideoPublishRebuildNeeded,
  listVideoParts,
  openDatabase,
  resetPublishedStateForVideo,
  updateVideoCommentThread,
} from "./lib/storage.mjs";
import { fetchVideoSnapshot, syncVideoSnapshotToDb } from "./lib/video-state.mjs";
import { ensureSubtitleForPart } from "./lib/subtitle-pipeline.mjs";
import { resolveSummaryConfig, summarizePartFromSubtitle } from "./lib/summarizer.mjs";
import { deleteSummaryThread, postSummaryThread } from "./lib/comment-thread.mjs";
import { findReusableSummarySource, reusePartSummaries } from "./lib/live-session-reuse.mjs";
import { createPipelineEventLogger } from "./lib/pipeline-event-logger.mjs";
import { writePartSummaryArtifact, writeSummaryArtifacts } from "./lib/summary-files.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";

loadDotEnvIfPresent();
let activeEventLogger = null;

function createProgressReporter(video, totalParts) {
  const outputStream = process.stderr;
  const safeTotalParts = Math.max(totalParts, 1);
  const videoPrefix = formatVideoPrefix(video);

  return {
    outputStream,
    log(message) {
      outputStream.write(`[${formatProgressTime()}] ${videoPrefix} ${message}\n`);
    },
    logPart(index, part, stage, detail = "") {
      const partLabel = formatPartLabel(part.page_no, part.part_title);
      const suffix = detail ? `: ${detail}` : "";
      outputStream.write(
        `[${formatProgressTime()}] ${videoPrefix} [${index}/${safeTotalParts}] ${partLabel} ${stage}${suffix}\n`,
      );
    },
    logPartStage(pageNo, stage, detail = "") {
      const suffix = detail ? `: ${detail}` : "";
      outputStream.write(`[${formatProgressTime()}] ${videoPrefix} [P${pageNo}] ${stage}${suffix}\n`);
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

function formatVideoPrefix(video) {
  const bvid = String(video?.bvid ?? "").trim();
  const title = String(video?.title ?? "").trim();
  const label = [bvid, title].filter(Boolean).join(" | ");
  return label ? `[${label}]` : "[video]";
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
    "  --asr                      Optional. VideoCaptioner ASR engine. Default: faster-whisper (local model first)",
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
  const asr = args.asr ?? "faster-whisper";
  const db = openDatabase(dbPath);

  const snapshot = await fetchVideoSnapshot(client, args);
  const state = syncVideoSnapshotToDb(db, snapshot);
  const eventLogger = createPipelineEventLogger({
    db,
    video: state.video,
  });
  activeEventLogger = eventLogger;
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
  const progress = createProgressReporter(state.video, targetParts.length);
  const needsRebuildPublish = Boolean(state.video.publish_needs_rebuild);

  eventLogger.log({
    scope: "pipeline",
    action: "run",
    status: "started",
    message: `Pipeline started for ${state.video.bvid}`,
    details: {
      totalParts,
      pendingParts: targetParts.length,
      forceSummary,
      publishRequested: Boolean(args.publish),
      changeSet: state.changeSet,
    },
  });

  progress.log(`Video synced: ${state.video.title} (total parts: ${totalParts}, pending: ${targetParts.length})`);
  if (reusedSummarySource) {
    eventLogger.log({
      scope: "summary",
      action: "reuse",
      status: "succeeded",
      message: `Reused summaries from ${reusedSummarySource.video.bvid}`,
      details: {
        sourceBvid: reusedSummarySource.video.bvid,
        sourceTitle: reusedSummarySource.video.title,
        reusedPages: reusedSummarySource.reusedPages,
      },
    });
    progress.log(
      `Reused ${reusedSummarySource.reusedPages.length} summaries from ${reusedSummarySource.video.bvid} (${reusedSummarySource.video.title})`,
    );
  }
  if (needsRebuildPublish) {
    eventLogger.log({
      scope: "publish",
      action: "rebuild-flag",
      status: "started",
      message: "Publish thread is marked for rebuild",
      details: {
        reason: state.video.publish_rebuild_reason || "structural-part-change",
      },
    });
    progress.log(`Publish thread marked for rebuild: ${state.video.publish_rebuild_reason || "structural-part-change"}`);
  }
  if (targetParts.length === 0) {
    eventLogger.log({
      scope: "pipeline",
      action: "generation",
      status: "skipped",
      message: "All parts already have summaries",
    });
    progress.log("All parts already have summaries, skipping subtitle and summary generation");
  }

  const subtitleResults = [];
  const summaryResults = [];

  for (const [index, part] of targetParts.entries()) {
    const currentIndex = index + 1;
    eventLogger.log({
      scope: "pipeline",
      action: "part",
      status: "started",
      pageNo: part.page_no,
      cid: part.cid,
      partTitle: part.part_title,
      message: `Starting work for P${part.page_no}`,
      details: {
        index: currentIndex,
        totalPendingParts: targetParts.length,
      },
    });
    progress.logPart(currentIndex, part, "Started");

    const subtitleResult = await ensureSubtitleForPart({
      client,
      db,
      videoId: state.video.id,
      bvid: state.video.bvid,
      videoTitle: state.video.title,
      pageNo: part.page_no,
      cid: part.cid,
      partTitle: part.part_title,
      existingSubtitlePath: part.subtitle_path ?? null,
      cookie,
      cookieFile: args["cookie-file"] ?? null,
      durationSec: part.duration_sec,
      workRoot,
      venvPath,
      asr,
      progress,
      eventLogger,
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
      cid: part.cid,
      eventLogger,
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
  eventLogger.log({
    scope: "pipeline",
    action: "artifacts",
    status: "succeeded",
    message: "Summary artifacts written",
    details: {
      summaryPath: artifacts.summaryPath,
      pendingSummaryPath: artifacts.pendingSummaryPath,
    },
  });
  let publishResult = null;

  if (args.publish) {
    try {
      const fullMessage = artifacts.summaryPath ? fs.readFileSync(artifacts.summaryPath, "utf8").trim() : "";
      const pendingMessage = artifacts.pendingSummaryPath ? fs.readFileSync(artifacts.pendingSummaryPath, "utf8").trim() : "";
      if (needsRebuildPublish) {
        eventLogger.log({
          scope: "publish",
          action: "comment-thread",
          status: "started",
          message: "Starting publish rebuild",
          details: {
            publishMode: "rebuild",
            pendingLength: pendingMessage.length,
            fullLength: fullMessage.length,
          },
        });
        progress.log("Rebuilding published summary thread");
        if (!fullMessage) {
          publishResult = {
            action: "skip-rebuild-publish",
            reason: "No full summary content available for rebuild.",
          };
          eventLogger.log({
            scope: "publish",
            action: "comment-thread",
            status: "skipped",
            message: publishResult.reason,
            details: {
              publishMode: "rebuild",
            },
          });
          progress.log("No full summary content available, skipping rebuild publish");
        } else {
          const type = getType(args);
          const deletedThread = await deleteSummaryThread({
            client,
            oid: state.video.aid,
            type,
            rootRpid: state.video.root_comment_rpid,
          });
          resetPublishedStateForVideo(db, state.video.id);
          updateVideoCommentThread(db, state.video.id, {
            rootCommentRpid: null,
            topCommentRpid: null,
          });

          publishResult = await postSummaryThread({
            client,
            oid: state.video.aid,
            type,
            message: fullMessage,
            db,
            videoId: state.video.id,
            topCommentState: {
              hasTopComment: false,
              topComment: null,
            },
            existingRootRpid: null,
            forcedRootRpid: null,
          });
          clearVideoPublishRebuildNeeded(db, state.video.id);
          writeSummaryArtifacts(
            db,
            {
              ...state.video,
              publish_needs_rebuild: 0,
            },
            workRoot,
          );
          publishResult = {
            ...publishResult,
            rebuild: true,
            deletedThread,
          };
          eventLogger.log({
            scope: "publish",
            action: "comment-thread",
            status: "succeeded",
            message: "Publish rebuild complete",
            details: {
              publishMode: "rebuild",
              rootCommentRpid: publishResult.rootCommentRpid,
              createdComments: publishResult.createdComments?.length ?? 0,
              deletedThread,
            },
          });
          progress.log(`Rebuild publish complete, sent ${publishResult.createdComments?.length ?? 0} comments`);
        }
      } else if (pendingMessage) {
        eventLogger.log({
          scope: "publish",
          action: "comment-thread",
          status: "started",
          message: "Starting publish append",
          details: {
            publishMode: "append",
            pendingLength: pendingMessage.length,
          },
        });
        progress.log("Publishing pending summaries");
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
        eventLogger.log({
          scope: "publish",
          action: "comment-thread",
          status: "succeeded",
          message: "Publish append complete",
          details: {
            publishMode: "append",
            rootCommentRpid: publishResult.rootCommentRpid,
            createdComments: publishResult.createdComments?.length ?? 0,
          },
        });
        progress.log(`Publish complete, sent ${publishResult.createdComments?.length ?? 0} comments`);
      } else {
        publishResult = {
          action: "skip-publish",
          reason: "No pending summaries to publish.",
        };
        eventLogger.log({
          scope: "publish",
          action: "comment-thread",
          status: "skipped",
          message: publishResult.reason,
          details: {
            publishMode: "append",
          },
        });
        progress.log("No pending content to publish, skipping publish step");
      }
    } catch (error) {
      eventLogger.log({
        scope: "publish",
        action: "comment-thread",
        status: "failed",
        message: error?.message ?? "Unknown publish error",
        details: {
          publishMode: needsRebuildPublish ? "rebuild" : "append",
        },
      });
      throw error;
    }
  } else {
    eventLogger.log({
      scope: "publish",
      action: "comment-thread",
      status: "skipped",
      message: "Publish step was not requested",
    });
  }

  progress.log(`Pipeline complete, generated ${summaryResults.length} summaries`);
  const finalPublishNeedsRebuild = needsRebuildPublish && !publishResult?.rebuild ? true : false;
  eventLogger.log({
    scope: "pipeline",
    action: "run",
    status: "succeeded",
    message: `Pipeline completed for ${state.video.bvid}`,
    details: {
      generatedPages: summaryResults.map((item) => item.pageNo),
      publishRequested: Boolean(args.publish),
      publishNeedsRebuild: finalPublishNeedsRebuild,
    },
  });

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
    changeSet: state.changeSet,
    publishNeedsRebuild: finalPublishNeedsRebuild,
    publishRebuildReason: finalPublishNeedsRebuild ? state.video.publish_rebuild_reason ?? null : null,
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
  if (activeEventLogger) {
    activeEventLogger.log({
      scope: "pipeline",
      action: "run",
      status: "failed",
      message: error?.message ?? "Unknown error",
      details: {
        stderr: trimCommandOutput(error?.stderr),
        stdout: trimCommandOutput(error?.stdout),
      },
    });
  }
  printJson({
    ok: false,
    message: error?.message ?? "Unknown error",
    stderr: trimCommandOutput(error?.stderr),
    stdout: trimCommandOutput(error?.stdout),
    stack: error?.stack,
  });
  process.exitCode = 1;
});

function trimCommandOutput(output, maxLength = 4000) {
  if (typeof output !== "string") {
    return undefined;
  }

  const trimmed = output.trim();
  if (!trimmed) {
    return undefined;
  }

  return trimmed.length > maxLength ? `${trimmed.slice(0, maxLength)}...` : trimmed;
}
