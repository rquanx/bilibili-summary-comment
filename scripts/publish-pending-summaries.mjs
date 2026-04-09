import {
  createClient,
  getType,
  printErrorJson,
  printJson,
  readCookie,
  resolveOid,
} from "./lib/bili-comment-utils.mjs";
import {
  addCommentTypeOption,
  addCookieOptions,
  addDatabaseOption,
  addVideoIdentityOptions,
  createCliCommand,
  parseCliArgs,
  parseOptionalPositiveInteger,
} from "./lib/cli-tools.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";
import { writeSummaryArtifacts } from "./lib/summary-files.mjs";
import { runPublishStage } from "./lib/pipeline-publish-stage.mjs";
import { listPendingPublishParts, openDatabase } from "./lib/storage.mjs";
import { fetchVideoSnapshot, syncVideoSnapshotToDb } from "./lib/video-state.mjs";

loadDotEnvIfPresent();

const command = addCommentTypeOption(
  addDatabaseOption(
    addVideoIdentityOptions(
      addCookieOptions(
        createCliCommand({
          name: "publish-pending-summaries",
          description: "Publish pending summaries into the Bilibili comment thread.",
        }),
        { required: true },
      ),
    ),
  ),
)
  .option("--root-rpid <rpid>", "Optional. Force replies into the specified root comment.");

async function main() {
  const args = parseCliArgs(command);
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

  const result = await runPublishStage({
    client,
    db,
    video: state.video,
    artifacts,
    oid,
    type,
    forcedRootRpid: parseOptionalPositiveInteger(args["root-rpid"], "--root-rpid"),
  });

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

main().catch((error) => {
  printErrorJson(error);
});
