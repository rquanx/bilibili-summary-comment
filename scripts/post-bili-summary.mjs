import {
  createClient,
  getTopComment,
  getType,
  printErrorJson,
  printJson,
  readCookie,
  readMessage,
  resolveOid,
} from "./lib/bili-comment-utils.mjs";
import {
  addCommentTypeOption,
  addCookieOptions,
  addDatabaseOption,
  addMessageOptions,
  addVideoIdentityOptions,
  createCliCommand,
  parseCliArgs,
  parseOptionalPositiveInteger,
} from "./lib/cli-tools.mjs";
import { postSummaryThread } from "./lib/comment-thread.mjs";
import { openDatabase } from "./lib/storage.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";
import { fetchVideoSnapshot, syncVideoSnapshotToDb } from "./lib/video-state.mjs";

loadDotEnvIfPresent();

const command = addCommentTypeOption(
  addDatabaseOption(
    addMessageOptions(
      addVideoIdentityOptions(
        addCookieOptions(
          createCliCommand({
            name: "post-bili-summary",
            description: "Post a summary into a Bilibili comment thread.",
          }),
          { required: true },
        ),
      ),
    ),
  ),
)
  .option("--root-rpid <rpid>", "Optional. Force replies into the specified root comment.");

async function main() {
  const args = parseCliArgs(command);
  const cookie = readCookie(args);
  const message = readMessage(args);

  const client = createClient(cookie);
  const type = getType(args);
  const oid = await resolveOid(client, args);
  const dbPath = args.db ?? "work/pipeline.sqlite3";
  const db = openDatabase(dbPath);
  const snapshot = await fetchVideoSnapshot(client, args);
  const state = syncVideoSnapshotToDb(db, snapshot);
  const topCommentState = await getTopComment(client, { oid, type });
  const forcedRootRpid = parseOptionalPositiveInteger(args["root-rpid"], "--root-rpid");
  const result = await postSummaryThread({
    client,
    oid,
    type,
    message,
    db,
    videoId: state.video.id,
    topCommentState,
    existingRootRpid: state.video.root_comment_rpid,
    forcedRootRpid,
  });

  printJson({
    ok: true,
    action: result.action,
    dbPath,
    oid,
    type,
    hasTopComment: topCommentState.hasTopComment,
    rootCommentRpid: result.rootCommentRpid,
    topComment: {
      rpid: topCommentState.topComment?.rpid ?? null,
      uname: topCommentState.topComment?.uname ?? null,
      message: topCommentState.topComment?.message ?? null,
    },
    coveredPagesFromMessage: result.coveredPagesFromMessage,
    createdComments: result.createdComments,
  });
}

main().catch((error) => {
  printErrorJson(error);
});
