import {
  createClient,
  getType,
  printJson,
  readCookie,
} from "../bili/comment-utils";
import { attachVideoContextToError } from "../bili/video-url";
import { errorToJson, extractErrorDetails } from "../cli/errors";
import { createPipelineEventLogger } from "../pipeline/event-logger";
import { runGenerationStage } from "../pipeline/generation-stage";
import { createProgressReporter, trimCommandOutput } from "../pipeline/progress";
import { runPublishStage } from "../pipeline/publish-stage";
import { resolveSummaryConfig } from "../summary/index";
import { openDatabase } from "../db/index";
import { fetchVideoSnapshot, syncVideoSnapshotToDb } from "./index";
import type { PipelineEventLogger } from "../db/index";
import type { CommandError } from "../shared/runtime-tools";

interface VideoPipelineArgs extends Record<string, unknown> {
  db?: string;
  ["work-root"]?: string;
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
  onEventLogger?.(eventLogger);
  const summaryConfig = resolveSummaryConfig(args);
  const forceSummary = Boolean(args["force-summary"]);
  const needsRebuildPublish = Boolean(state.video.publish_needs_rebuild);
  const totalParts = state.video.page_count ?? snapshot?.pages?.length ?? 0;
  const pendingPartCount = forceSummary ? state.parts.length : state.pendingSummaryParts.length;
  const progress = createProgressReporter(state.video, pendingPartCount);

  eventLogger.log({
    scope: "pipeline",
    action: "run",
    status: "started",
    message: `Pipeline started for ${state.video.bvid}`,
    details: {
      totalParts,
      pendingParts: state.pendingSummaryParts.length,
      forceSummary,
      publishRequested: Boolean(args.publish),
      changeSet: state.changeSet,
    },
  });

  progress.log(`Video synced: ${state.video.title} (total parts: ${totalParts}, pending: ${state.pendingSummaryParts.length})`);
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

  try {
    const generation = await runGenerationStage({
      client,
      db,
      video: state.video,
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
    let publishResult = null;

    if (args.publish) {
      try {
        publishResult = await runPublishStage({
          client,
          db,
          video: state.video,
          artifacts: generation.artifacts,
          oid: state.video.aid,
          type: getType(args),
          workRoot,
          forcedRootRpid: null,
          eventLogger,
          progress,
        });
      } catch (error) {
        attachVideoContextToError(error, {
          bvid: state.video.bvid,
          aid: state.video.aid,
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

    progress.log(`Pipeline complete, generated ${generation.summaryResults.length} summaries`);
    const finalPublishNeedsRebuild = needsRebuildPublish && !publishResult?.rebuild ? true : false;
    eventLogger.log({
      scope: "pipeline",
      action: "run",
      status: "succeeded",
      message: `Pipeline completed for ${state.video.bvid}`,
      details: {
        generatedPages: generation.summaryResults.map((item) => item.pageNo),
        publishRequested: Boolean(args.publish),
        publishNeedsRebuild: finalPublishNeedsRebuild,
      },
    });

    return {
      ok: true,
      dbPath,
      video: {
        id: state.video.id,
        bvid: state.video.bvid,
        aid: state.video.aid,
        title: state.video.title,
        pageCount: state.video.page_count,
      },
      generatedPages: generation.summaryResults.map((item) => item.pageNo),
      changeSet: state.changeSet,
      publishNeedsRebuild: finalPublishNeedsRebuild,
      publishRebuildReason: finalPublishNeedsRebuild ? state.video.publish_rebuild_reason ?? null : null,
      subtitleResults: generation.subtitleResults,
      summaryResults: generation.summaryResults,
      reusedSummaryFrom: generation.reusedSummarySource
        ? {
            bvid: generation.reusedSummarySource.video.bvid,
            title: generation.reusedSummarySource.video.title,
            reusedPages: generation.reusedSummarySource.reusedPages,
          }
        : null,
      artifacts: generation.artifacts,
      publishResult,
    };
  } catch (error) {
    attachVideoContextToError(error, {
      bvid: state.video.bvid,
      aid: state.video.aid,
    });
    throw error;
  }
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
      console.warn(`Failed to write pipeline failure event: ${logMessage}`);
    }
  }
  printJson({
    ...errorToJson(error),
    stderr: trimCommandOutput(commandError.stderr),
    stdout: trimCommandOutput(commandError.stdout),
  });
}
