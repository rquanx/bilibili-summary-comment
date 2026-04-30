import {
  createClient,
  getTopComment,
  getType,
  printJson,
  readCookie,
} from "../bili/comment-utils";
import { attachVideoContextToError } from "../bili/video-url";
import { attachErrorDetails, errorToJson, extractErrorDetails } from "../cli/errors";
import { createPipelineEventLogger } from "../pipeline/event-logger";
import { runGenerationStage } from "../pipeline/generation-stage";
import { shouldRebuildMissingStoredRootCommentThread } from "../pipeline/publish-stage";
import { createProgressReporter, formatBlockingErrorDetail, trimCommandOutput, writeTerminalMessage } from "../pipeline/progress";
import { runPublishStage } from "../pipeline/publish-stage";
import { resolveSummaryConfig } from "../summary/index";
import { markVideoPublishRebuildNeeded, openDatabase } from "../db/index";
import { createWorkFileLogger } from "../shared/logger";
import { fetchVideoSnapshot, syncVideoSnapshotToDb } from "./index";
import { withVideoPipelineLock } from "./pipeline-lock";
import type { PipelineEventLogger } from "../db/index";
import type { CommandError } from "../shared/runtime-tools";

interface VideoPipelineArgs extends Record<string, unknown> {
  db?: string;
  ["work-root"]?: string;
  ["log-day"]?: string;
  ["log-group"]?: string;
  ["venv-path"]?: string;
  asr?: string;
  ["cookie-file"]?: string;
  publish?: boolean;
  ["force-summary"]?: boolean;
}

export async function runVideoPipeline(
  args: VideoPipelineArgs,
  { onEventLogger }: { onEventLogger?: (eventLogger: PipelineEventLogger) => void } = {},
) {
  const cookie = readCookie(args);
  const client = createClient(cookie);
  const commentType = getType(args);
  const dbPath = args.db ?? "work/pipeline.sqlite3";
  const workRoot = args["work-root"] ?? "work";
  const logDay = args["log-day"] ?? process.env.PIPELINE_LOG_DAY ?? null;
  const logGroup = args["log-group"] ?? process.env.PIPELINE_LOG_GROUP ?? null;
  const venvPath = args["venv-path"] ?? ".3.11";
  const asr = args.asr ?? "faster-whisper";
  const db = openDatabase(dbPath);

  const snapshot = await fetchVideoSnapshot(client, args);
  const state = syncVideoSnapshotToDb(db, snapshot);
  const logger = createWorkFileLogger({
    workRoot,
    name: "pipeline",
    label: buildPipelineLogLabel(state.video),
    day: typeof logDay === "string" ? logDay : null,
    group: typeof logGroup === "string" ? logGroup : null,
    context: {
      scope: "pipeline",
      bvid: state.video.bvid,
      aid: state.video.aid,
      videoTitle: state.video.title,
    },
  });
  const eventLogger = createPipelineEventLogger({
    db,
    video: state.video,
    logger,
  });
  onEventLogger?.(eventLogger);
  const summaryConfig = resolveSummaryConfig(args);
  const forceSummary = Boolean(args["force-summary"]);
  const totalParts = state.video.page_count ?? snapshot?.pages?.length ?? 0;
  const pendingPartCount = forceSummary ? state.parts.length : state.pendingSummaryParts.length;
  const progress = createProgressReporter(state.video, pendingPartCount, {
    logger,
  });

  logger.info("Pipeline logger initialized", {
    logPath: logger.filePath,
    totalParts,
    pendingPartCount,
    forceSummary,
    publishRequested: Boolean(args.publish),
  });
  progress.info(`Detailed log: ${logger.filePath}`);

  eventLogger.log({
    scope: "pipeline",
    action: "run",
    status: "started",
    message: `Pipeline started for ${state.video.bvid}`,
      details: {
        logPath: logger.filePath,
        totalParts,
        pendingParts: state.pendingSummaryParts.length,
        forceSummary,
        publishRequested: Boolean(args.publish),
      changeSet: state.changeSet,
    },
  });

  progress.info(`Video synced: (total parts: ${totalParts}, pending: ${state.pendingSummaryParts.length})`);
  if (!args.publish) {
    await probePublishedCommentThreadHealth({
      client,
      db,
      video: state.video,
      oid: state.video.aid,
      type: commentType,
      eventLogger,
      progress,
    });
  }
  const needsRebuildPublish = Boolean(state.video.publish_needs_rebuild);
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
    progress.warn(`Publish thread marked for rebuild: ${state.video.publish_rebuild_reason || "structural-part-change"}`);
  }

  try {
    return await withVideoPipelineLock({
      workRoot,
      bvid: state.video.bvid,
      videoTitle: state.video.title ?? null,
      publishRequested: Boolean(args.publish),
      progress,
      eventLogger,
    }, async () => {
      let generation;
      try {
        generation = await runGenerationStage({
          client,
          db,
          video: state.video,
          summaryOwnerMid: snapshot.ownerMid ?? null,
          summaryOwnerName: snapshot.ownerName ?? null,
          cookie,
          cookieFile: args["cookie-file"] ?? null,
          workRoot,
          venvPath,
          asr,
          summaryConfig,
          forceSummary,
          eventLogger,
          progress,
        });
      } catch (error) {
        attachErrorDetails(error, {
          bvid: state.video.bvid,
          aid: state.video.aid,
          failedStep: "generation",
          failedScope: "pipeline",
          failedAction: "generation",
        });
        throw error;
      }
      let publishResult = null;

      if (args.publish) {
        try {
          publishResult = await runPublishStage({
            client,
            db,
            video: state.video,
            artifacts: generation.artifacts,
            oid: state.video.aid,
            type: commentType,
            workRoot,
            forcedRootRpid: null,
            eventLogger,
            progress,
          });
        } catch (error) {
          progress.error(`Publish blocked: ${formatBlockingErrorDetail(error)}`);
          attachVideoContextToError(error, {
            bvid: state.video.bvid,
            aid: state.video.aid,
          });
          attachErrorDetails(error, {
            bvid: state.video.bvid,
            aid: state.video.aid,
            failedStep: "publish",
            failedScope: "publish",
            failedAction: "comment-thread",
          });
          eventLogger.log({
            scope: "publish",
            action: "comment-thread",
            status: "failed",
            message: error?.message ?? "Unknown publish error",
            details: {
              publishMode: needsRebuildPublish ? "rebuild" : "append",
              ...extractErrorDetails(error),
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

      const reusedSummaryFrom = generation.reusedSummarySource
        ? {
            bvid: generation.reusedSummarySource.video.bvid,
            title: generation.reusedSummarySource.video.title,
            reusedPages: generation.reusedSummarySource.reusedPages,
          }
        : null;
      if (reusedSummaryFrom) {
        progress.success(
          `Same-session reuse source: ${reusedSummaryFrom.bvid} (${reusedSummaryFrom.title}), pages=${reusedSummaryFrom.reusedPages.join(",")}`,
        );
      }

      if (generation.skippedSummaryResults.length > 0) {
        progress.warn(
          `Skipped summary pages: ${generation.skippedSummaryResults.map((item) => `P${item.pageNo}`).join(", ")}`,
        );
      }
      progress.success(
        `Pipeline complete, generated ${generation.summaryResults.length} summaries`
        + (generation.skippedSummaryResults.length > 0
          ? `, skipped ${generation.skippedSummaryResults.length} content-filtered part${generation.skippedSummaryResults.length > 1 ? "s" : ""}`
          : ""),
      );
      const finalPublishNeedsRebuild = needsRebuildPublish && !publishResult?.rebuild ? true : false;
      eventLogger.log({
        scope: "pipeline",
        action: "run",
        status: "succeeded",
        message: `Pipeline completed for ${state.video.bvid}`,
        details: {
          generatedPages: generation.summaryResults.map((item) => item.pageNo),
          skippedSummaryPages: generation.skippedSummaryResults.map((item) => item.pageNo),
          reusedSummaryFrom,
          publishRequested: Boolean(args.publish),
          publishNeedsRebuild: finalPublishNeedsRebuild,
        },
      });

      return {
        ok: true,
        logPath: logger.filePath,
        dbPath,
        video: {
          id: state.video.id,
          bvid: state.video.bvid,
          aid: state.video.aid,
          title: state.video.title,
          pageCount: state.video.page_count,
        },
        generatedPages: generation.summaryResults.map((item) => item.pageNo),
        skippedSummaryPages: generation.skippedSummaryResults.map((item) => item.pageNo),
        skippedSummaryResults: generation.skippedSummaryResults,
        changeSet: state.changeSet,
        publishNeedsRebuild: finalPublishNeedsRebuild,
        publishRebuildReason: finalPublishNeedsRebuild ? state.video.publish_rebuild_reason ?? null : null,
        subtitleResults: generation.subtitleResults,
        summaryResults: generation.summaryResults,
        reusedSummaryFrom,
        artifacts: generation.artifacts,
        publishResult,
      };
    });
  } catch (error) {
    attachVideoContextToError(error, {
      bvid: state.video.bvid,
      aid: state.video.aid,
    });
    attachErrorDetails(error, {
      logPath: logger.filePath,
    });
    progress.error(`Pipeline failed: ${formatBlockingErrorDetail(error)}`);
    logger.error("Pipeline failed", {
      error,
      stderr: trimCommandOutput((error as CommandError | undefined)?.stderr, 20_000),
      stdout: trimCommandOutput((error as CommandError | undefined)?.stdout, 20_000),
    });
    throw error;
  }
}

export async function probePublishedCommentThreadHealth({
  client,
  db,
  video,
  oid,
  type,
  eventLogger = null,
  progress = null,
  getTopCommentImpl = getTopComment,
}: {
  client: Parameters<typeof getTopComment>[0];
  db: ReturnType<typeof openDatabase>;
  video: {
    id: number;
    bvid: string;
    aid: number;
    title: string | null;
    root_comment_rpid: number | null;
    publish_needs_rebuild: number;
    publish_rebuild_reason: string | null;
  };
  oid: number;
  type: number;
  eventLogger?: PipelineEventLogger | null;
  progress?: { warn?: (message: string) => void } | null;
  getTopCommentImpl?: typeof getTopComment;
}) {
  if (Number(video.root_comment_rpid ?? 0) <= 0 || Number(video.publish_needs_rebuild) === 1) {
    return {
      checked: false,
      needsRebuild: Boolean(video.publish_needs_rebuild),
      topCommentState: null,
    };
  }

  const topCommentState = await getTopCommentImpl(client, { oid, type });
  const needsRebuild = shouldRebuildMissingStoredRootCommentThread(video, topCommentState);
  if (!needsRebuild) {
    return {
      checked: true,
      needsRebuild: false,
      topCommentState,
    };
  }

  const rebuildReason = "missing-root-comment-thread";
  markVideoPublishRebuildNeeded(db, video.id, rebuildReason);
  video.publish_needs_rebuild = 1;
  video.publish_rebuild_reason = rebuildReason;
  eventLogger?.log({
    scope: "publish",
    action: "comment-thread-healthcheck",
    status: "failed",
    message: "Stored root comment thread is missing or no longer pinned",
    details: {
      storedRootCommentRpid: video.root_comment_rpid ?? null,
      liveTopCommentRpid: topCommentState.topComment?.rpid ?? null,
      hasTopComment: topCommentState.hasTopComment,
      markedForRebuild: true,
    },
  });
  progress?.warn?.("Stored root comment thread is missing, marked for rebuild on the next publish run");

  return {
    checked: true,
    needsRebuild: true,
    topCommentState,
  };
}

export function printPipelineFailure(error: CommandError | Error | unknown, activeEventLogger: PipelineEventLogger | null = null) {
  const commandError = (typeof error === "object" && error !== null ? error : {}) as CommandError;
  const errorDetails = extractErrorDetails(error);
  if (activeEventLogger) {
    try {
      activeEventLogger.log({
        scope: "pipeline",
        action: "run",
        status: "failed",
        message: commandError.message ?? "Unknown error",
        details: {
          stderr: trimCommandOutput(commandError.stderr),
          stdout: trimCommandOutput(commandError.stdout),
          ...errorDetails,
        },
      });
    } catch (logError) {
      const logMessage = logError instanceof Error ? logError.message : String(logError ?? "Unknown logging error");
      writeTerminalMessage(process.stderr, "warn", `Failed to write pipeline failure event: ${logMessage}`);
    }
  }
  printJson({
    ...errorToJson(error),
    stderr: trimCommandOutput(commandError.stderr),
    stdout: trimCommandOutput(commandError.stdout),
  });
}

function buildPipelineLogLabel(video: { work_dir_name?: string | null; title?: string | null; bvid?: string | null }): string {
  const workDirName = String(video.work_dir_name ?? "").trim();
  if (workDirName) {
    return workDirName;
  }

  const title = String(video.title ?? "").trim();
  const bvid = String(video.bvid ?? "").trim();
  if (title && bvid) {
    return `${title}__${bvid}`;
  }

  return title || bvid || "pipeline";
}
