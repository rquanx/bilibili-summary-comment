import fs from "node:fs";
import { getTopComment } from "../bili/comment-utils.mjs";
import { deleteSummaryThread, postSummaryThread } from "../bili/comment-thread.mjs";
import { writeSummaryArtifacts } from "../summary/files.mjs";
import {
  clearVideoPublishRebuildNeeded,
  resetPublishedStateForVideo,
  updateVideoCommentThread,
} from "../db/index.mjs";

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
}) {
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

    const deletedThread = await deleteSummaryThread({
      client,
      oid,
      type,
      rootRpid: video.root_comment_rpid,
    });
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
    });
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
      deletedThread,
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
        deletedThread,
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
    },
  });
  progress?.log(`Publish complete, sent ${appended.createdComments?.length ?? 0} comments`);
  return appended;
}
