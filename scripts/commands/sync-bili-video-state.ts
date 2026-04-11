import {
  createClient,
  readCookie,
} from "../lib/bili/comment-utils";
import {
  addCookieOptions,
  addDatabaseOption,
  addVideoIdentityOptions,
  createCliCommand,
  runCli,
} from "../lib/cli/tools";
import { openDatabase } from "../lib/db/index";
import { fetchVideoSnapshot, syncVideoSnapshotToDb } from "../lib/video/index";

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

await runCli({
  command,
  async handler(args) {
    const cookie = readCookie(args);
    const client = createClient(cookie);
    const dbPath = typeof args.db === "string" && args.db.trim() ? args.db : "work/pipeline.sqlite3";
    const db = openDatabase(dbPath);
    const snapshot = await fetchVideoSnapshot(client, args);
    const state = syncVideoSnapshotToDb(db, snapshot);

    return {
      ok: true,
      dbPath,
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
    };
  },
});
