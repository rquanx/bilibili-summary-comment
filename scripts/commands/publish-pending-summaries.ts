import {
  createClient,
  getType,
  readCookie,
  resolveOid,
} from "../lib/bili/comment-utils";
import {
  addCommentTypeOption,
  addCookieOptions,
  addDatabaseOption,
  addVideoIdentityOptions,
  createCliCommand,
  parseOptionalPositiveInteger,
  runCli,
} from "../lib/cli/tools";
import { writeSummaryArtifacts } from "../lib/summary/files";
import { runPublishStage } from "../lib/pipeline/publish-stage";
import { listPendingPublishParts, openDatabase } from "../lib/db/index";
import { fetchVideoSnapshot, syncVideoSnapshotToDb } from "../lib/video/index";

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

await runCli({
  command,
  async handler(args) {
    const cookie = readCookie(args);
    const client = createClient(cookie);
    const type = getType(args);
    const oid = await resolveOid(client, args);
    const dbPath = typeof args.db === "string" && args.db.trim() ? args.db : "work/pipeline.sqlite3";
    const db = openDatabase(dbPath);
    try {
      const snapshot = await fetchVideoSnapshot(client, args);
      const state = syncVideoSnapshotToDb(db, snapshot);
      const pendingParts = listPendingPublishParts(db, state.video.id);
      const artifacts = writeSummaryArtifacts(db, state.video);
      const needsRebuildPublish = Boolean(state.video.publish_needs_rebuild);

      if (pendingParts.length === 0 && !needsRebuildPublish) {
        return {
          ok: true,
          dbPath,
          oid,
          type,
          message: "No pending summaries to publish.",
          pendingPublishPages: [],
        };
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

      return {
        ok: true,
        action: result.action,
        dbPath,
        oid,
        type,
        rootCommentRpid: result.rootCommentRpid ?? null,
        rebuild: Boolean(result.rebuild),
        pendingPublishPages: pendingParts.map((part) => part.page_no),
        coveredPagesFromMessage: result.coveredPagesFromMessage ?? [],
        createdComments: result.createdComments ?? [],
      };
    } finally {
      db.close?.();
    }
  },
});
