import fs from "node:fs";
import {
  createClient,
  fail,
  getTopComment,
  getType,
  parseArgs,
  printJson,
  readCookie,
  resolveOid,
  showUsage,
} from "./lib/bili-comment-utils.mjs";
import {
  clearVideoPublishRebuildNeeded,
  listPendingPublishParts,
  openDatabase,
  resetPublishedStateForVideo,
  updateVideoCommentThread,
} from "./lib/storage.mjs";
import { fetchVideoSnapshot, syncVideoSnapshotToDb } from "./lib/video-state.mjs";
import { deleteSummaryThread, postSummaryThread } from "./lib/comment-thread.mjs";
import { writeSummaryArtifacts } from "./lib/summary-files.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";

loadDotEnvIfPresent();

function usage() {
  showUsage([
    "Usage:",
    "  node scripts/publish-pending-summaries.mjs --cookie-file cookie.txt --bvid BVxxxx",
    "  node scripts/publish-pending-summaries.mjs --cookie-file cookie.txt --url https://www.bilibili.com/video/BVxxxx",
    "",
    "Options:",
    "  --cookie / --cookie-file   Required. Bilibili cookie string or cookie file path.",
    "  --oid / --aid              Optional. Video aid.",
    "  --bvid / --url             Optional. Video bvid or url.",
    "  --db                       Optional. SQLite path. Default: work/pipeline.sqlite3",
    "  --root-rpid                Optional. Force replies into the specified root comment.",
    "  --type                     Comment type, default 1.",
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
  const type = getType(args);
  const oid = await resolveOid(client, args);
  const dbPath = args.db ?? "work/pipeline.sqlite3";
  const db = openDatabase(dbPath);
  const snapshot = await fetchVideoSnapshot(client, args);
  const state = syncVideoSnapshotToDb(db, snapshot);
  const pendingParts = listPendingPublishParts(db, state.video.id);
  const artifacts = writeSummaryArtifacts(db, state.video);
  const needsRebuildPublish = Boolean(state.video.publish_needs_rebuild);

  if (pendingParts.length === 0 && !needsRebuildPublish) {
    printJson({
      ok: true,
      dbPath,
      oid,
      type,
      message: "No pending summaries to publish.",
      pendingPublishPages: [],
    });
      return;
  }

  const pendingMessage = pendingParts.map((part) => part.summary_text).join("\n\n").trim();
  const fullMessage = artifacts.summaryPath ? fs.readFileSync(artifacts.summaryPath, "utf8").trim() : "";
  let result;

  if (needsRebuildPublish) {
    if (!fullMessage) {
      fail("Rebuild publish requires full summary content, but summary.md is empty", {
        summaryPath: artifacts.summaryPath,
      });
    }

    const deletedThread = await deleteSummaryThread({
      client,
      oid,
      type,
      rootRpid: state.video.root_comment_rpid,
    });
    resetPublishedStateForVideo(db, state.video.id);
    updateVideoCommentThread(db, state.video.id, {
      rootCommentRpid: null,
      topCommentRpid: null,
    });

    result = await postSummaryThread({
      client,
      oid,
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
    writeSummaryArtifacts(db, {
      ...state.video,
      publish_needs_rebuild: 0,
    });
    result = {
      ...result,
      rebuild: true,
      deletedThread,
    };
  } else {
    if (!pendingMessage) {
      fail("Pending summary rows do not contain summary_text", {
        pendingPublishPages: pendingParts.map((part) => part.page_no),
      });
    }

    const topCommentState = await getTopComment(client, { oid, type });
    result = await postSummaryThread({
      client,
      oid,
      type,
      message: pendingMessage,
      db,
      videoId: state.video.id,
      topCommentState,
      existingRootRpid: state.video.root_comment_rpid,
      forcedRootRpid: parseOptionalPositiveInteger(args["root-rpid"]),
    });
    writeSummaryArtifacts(db, state.video);
  }

  printJson({
    ok: true,
    action: result.action,
    dbPath,
    oid,
    type,
    rootCommentRpid: result.rootCommentRpid,
    rebuild: Boolean(result.rebuild),
    pendingPublishPages: pendingParts.map((part) => part.page_no),
    coveredPagesFromMessage: result.coveredPagesFromMessage,
    createdComments: result.createdComments,
  });
}

function parseOptionalPositiveInteger(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    fail("Invalid --root-rpid, expected a positive integer", { received: value });
  }

  return parsed;
}

main().catch((error) => {
  printJson({
    ok: false,
    message: error?.message ?? "Unknown error",
    stack: error?.stack,
  });
  process.exitCode = 1;
});
