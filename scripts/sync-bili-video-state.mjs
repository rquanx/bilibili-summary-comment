import {
  createClient,
  printErrorJson,
  printJson,
  readCookie,
} from "./lib/bili-comment-utils.mjs";
import {
  addCookieOptions,
  addDatabaseOption,
  addVideoIdentityOptions,
  createCliCommand,
  parseCliArgs,
} from "./lib/cli-tools.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";
import { openDatabase } from "./lib/storage.mjs";
import { fetchVideoSnapshot, syncVideoSnapshotToDb } from "./lib/video-state.mjs";

loadDotEnvIfPresent();

const command = addDatabaseOption(
  addVideoIdentityOptions(
    addCookieOptions(
      createCliCommand({
        name: "sync-bili-video-state",
        description: "Sync video and part metadata from Bilibili into SQLite.",
      }),
      { required: true },
    ),
  ),
);

async function main() {
  const args = parseCliArgs(command);

  const cookie = readCookie(args);
  const client = createClient(cookie);
  const db = openDatabase(args.db ?? "work/pipeline.sqlite3");
  const snapshot = await fetchVideoSnapshot(client, args);
  const state = syncVideoSnapshotToDb(db, snapshot);

  printJson({
    ok: true,
    dbPath: args.db ?? "work/pipeline.sqlite3",
    video: {
      id: state.video.id,
      bvid: state.video.bvid,
      aid: state.video.aid,
      title: state.video.title,
      pageCount: state.video.page_count,
      rootCommentRpid: state.video.root_comment_rpid,
      topCommentRpid: state.video.top_comment_rpid,
      publishNeedsRebuild: Boolean(state.video.publish_needs_rebuild),
      publishRebuildReason: state.video.publish_rebuild_reason ?? null,
    },
    parts: state.parts.map((part) => ({
      pageNo: part.page_no,
      cid: part.cid,
      partTitle: part.part_title,
      durationSec: part.duration_sec,
      hasSummary: Boolean(part.summary_text),
      published: Boolean(part.published),
    })),
    pendingSummaryPages: state.pendingSummaryParts.map((part) => part.page_no),
    pendingPublishPages: state.pendingPublishParts.map((part) => part.page_no),
    changeSet: state.changeSet,
  });
}

main().catch((error) => {
  printErrorJson(error);
});
