import fs from "node:fs";
import { getTopComment } from "../bili/comment-utils";
import { deleteSummaryThread, postSummaryThread } from "../bili/comment-thread";
import { writeSummaryArtifacts } from "../summary/files";
import {
  clearVideoPublishRebuildNeeded,
  resetPublishedStateForVideo,
  updateVideoCommentThread,
} from "../db/index";
import type { Db, PipelineEventLogger, SummaryArtifacts, VideoRecord } from "../db/index";

export interface PublishStageResult {
  action: string;
  reason?: string;
  normalizedMessage?: string;
  coveredPagesFromMessage?: number[];
  rootCommentRpid?: number | null;
  recoveredFromDeletedRoot?: boolean;
  replacedRootCommentRpid?: number | null;
  createdComments?: Array<Record<string, unknown>>;
  warnings?: Array<Record<string, unknown>>;
  rebuild?: boolean;
  deletedThread?: { rootRpid?: number; deleted?: boolean; reason?: string; alreadyMissing?: boolean; ok?: boolean };
  deletedThreads?: Array<{ rootRpid?: number; deleted?: boolean; reason?: string; alreadyMissing?: boolean; ok?: boolean }>;
}

function collectRebuildDeleteCandidates(
  video: Pick<VideoRecord, "root_comment_rpid" | "top_comment_rpid">,
  topCommentState: { topComment?: { rpid?: number | null } | null } | null,
): number[] {
  return [...new Set([
    Number(video.root_comment_rpid ?? 0),
    Number(video.top_comment_rpid ?? 0),
    Number(topCommentState?.topComment?.rpid ?? 0),
  ].filter((rpid) => Number.isInteger(rpid) && rpid > 0))];
}

export async function runPublishStage({
  client,
  db,
  video,
  artifacts,
  oid,
  type,
  workRoot = "work",
  forcedRootRpid = null,
  eventLogger = null,
  progress = null,
  sleepImpl = undefined,
  fetchImpl = undefined,
  uploadToPasteImpl = undefined,
}: {
  client: Parameters<typeof postSummaryThread>[0]["client"];
  db: Db;
  video: VideoRecord;
  artifacts: SummaryArtifacts;
  oid: number;
  type: number;
  workRoot?: string;
  forcedRootRpid?: number | null;
  eventLogger?: PipelineEventLogger | null;
  progress?: { log?: (message: string) => void } | null;
  sleepImpl?: Parameters<typeof postSummaryThread>[0]["sleepImpl"];
  fetchImpl?: Parameters<typeof postSummaryThread>[0]["fetchImpl"];
  uploadToPasteImpl?: Parameters<typeof postSummaryThread>[0]["uploadToPasteImpl"];
}): Promise<PublishStageResult> {
  const needsRebuildPublish = Boolean(video.publish_needs_rebuild);
  const fullMessage = artifacts.summaryPath ? fs.readFileSync(artifacts.summaryPath, "utf8").trim() : "";
  const pendingMessage = artifacts.pendingSummaryPath ? fs.readFileSync(artifacts.pendingSummaryPath, "utf8").trim() : "";

  if (needsRebuildPublish) {
    eventLogger?.log({
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
    progress?.log("Rebuilding published summary thread");

    if (!fullMessage) {
      const skipped = {
        action: "skip-rebuild-publish",
        reason: "No full summary content available for rebuild.",
      };
      eventLogger?.log({
        scope: "publish",
        action: "comment-thread",
        status: "skipped",
        message: skipped.reason,
        details: {
          publishMode: "rebuild",
        },
      });
      progress?.log("No full summary content available, skipping rebuild publish");
      return skipped;
    }

    const topCommentState = await getTopComment(client, { oid, type });
    const deleteCandidates = collectRebuildDeleteCandidates(video, topCommentState);

    resetPublishedStateForVideo(db, video.id);
    updateVideoCommentThread(db, video.id, {
      rootCommentRpid: null,
      topCommentRpid: null,
    });

    const rebuilt = await postSummaryThread({
      client,
      oid,
      type,
      message: fullMessage,
      db,
      videoId: video.id,
      topCommentState: {
        hasTopComment: false,
        topComment: null,
      },
      existingRootRpid: null,
      forcedRootRpid: null,
      sleepImpl,
      fetchImpl,
      uploadToPasteImpl,
    });

    const deletedThreads: Array<{ rootRpid?: number; deleted?: boolean; reason?: string; alreadyMissing?: boolean; ok?: boolean }> = [];
    for (const rootRpid of deleteCandidates) {
      if (rootRpid === rebuilt.rootCommentRpid) {
        continue;
      }

      deletedThreads.push(await deleteSummaryThread({
        client,
        oid,
        type,
        rootRpid,
      }));
    }

    clearVideoPublishRebuildNeeded(db, video.id);
    writeSummaryArtifacts(
      db,
      {
        ...video,
        publish_needs_rebuild: 0,
      },
      workRoot,
    );

    const result = {
      ...rebuilt,
      rebuild: true,
      deletedThread: deletedThreads[0] ?? {
        ok: true,
        deleted: false,
        reason: "no-previous-thread",
      },
      deletedThreads,
    };
    eventLogger?.log({
      scope: "publish",
      action: "comment-thread",
      status: "succeeded",
      message: "Publish rebuild complete",
      details: {
        publishMode: "rebuild",
        rootCommentRpid: result.rootCommentRpid,
        createdComments: result.createdComments?.length ?? 0,
        deletedThreads,
        warnings: result.warnings ?? [],
      },
    });
    progress?.log(`Rebuild publish complete, sent ${result.createdComments?.length ?? 0} comments`);
    return result;
  }

  if (!pendingMessage) {
    const skipped = {
      action: "skip-publish",
      reason: "No pending summaries to publish.",
    };
    eventLogger?.log({
      scope: "publish",
      action: "comment-thread",
      status: "skipped",
      message: skipped.reason,
      details: {
        publishMode: "append",
      },
    });
    progress?.log("No pending content to publish, skipping publish step");
    return skipped;
  }

  eventLogger?.log({
    scope: "publish",
    action: "comment-thread",
    status: "started",
    message: "Starting publish append",
    details: {
      publishMode: "append",
      pendingLength: pendingMessage.length,
    },
  });
  progress?.log("Publishing pending summaries");

  const topCommentState = await getTopComment(client, { oid, type });
  const appended = await postSummaryThread({
    client,
    oid,
    type,
    message: pendingMessage,
    db,
    videoId: video.id,
    topCommentState,
    existingRootRpid: video.root_comment_rpid,
    forcedRootRpid,
    sleepImpl,
    fetchImpl,
    uploadToPasteImpl,
  });
  writeSummaryArtifacts(db, video, workRoot);
  eventLogger?.log({
    scope: "publish",
    action: "comment-thread",
    status: "succeeded",
    message: "Publish append complete",
    details: {
      publishMode: "append",
      rootCommentRpid: appended.rootCommentRpid,
      createdComments: appended.createdComments?.length ?? 0,
      warnings: appended.warnings ?? [],
    },
  });
  progress?.log(`Publish complete, sent ${appended.createdComments?.length ?? 0} comments`);
  return appended;
}
