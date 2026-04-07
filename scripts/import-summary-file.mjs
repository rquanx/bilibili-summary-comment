import fs from "node:fs";
import { createHash } from "node:crypto";
import {
  createClient,
  fail,
  parseArgs,
  printJson,
  readCookie,
  showUsage,
} from "./lib/bili-comment-utils.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";
import { groupSummaryBlocksByPage, normalizeSummaryMarkers } from "./lib/summary-format.mjs";
import { openDatabase, savePartSummary } from "./lib/storage.mjs";
import { fetchVideoSnapshot, syncVideoSnapshotToDb } from "./lib/video-state.mjs";

loadDotEnvIfPresent();

function usage() {
  showUsage([
    "Usage:",
    "  node scripts/import-summary-file.mjs --cookie-file cookie.txt --bvid BVxxxx --summary-file work/BVxxxx/summary.md",
    "",
    "Options:",
    "  --cookie / --cookie-file   Required. Bilibili cookie string or cookie file path.",
    "  --oid / --aid              Optional. Video aid.",
    "  --bvid / --url             Optional. Video bvid or url.",
    "  --summary-file             Required. Summary markdown/text path.",
    "  --db                       Optional. SQLite path. Default: work/pipeline.sqlite3",
    "  --help                     Show this help.",
  ]);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    usage();
    return;
  }

  const summaryFile = args["summary-file"];
  if (typeof summaryFile !== "string" || !summaryFile.trim()) {
    fail("Missing required option: --summary-file");
  }

  const cookie = readCookie(args);
  const client = createClient(cookie);
  const db = openDatabase(args.db ?? "work/pipeline.sqlite3");
  const snapshot = await fetchVideoSnapshot(client, args);
  const state = syncVideoSnapshotToDb(db, snapshot);

  const summaryText = normalizeSummaryMarkers(fs.readFileSync(summaryFile, "utf8"));
  const pageGroups = groupSummaryBlocksByPage(summaryText);
  if (pageGroups.length === 0) {
    fail("No page markers found in summary file", { summaryFile });
  }

  const savedPages = [];
  for (const group of pageGroups) {
    const saved = savePartSummary(db, state.video.id, group.page, {
      summaryText: group.text,
      summaryHash: createHash("sha1").update(group.text).digest("hex"),
    });

    if (saved) {
      savedPages.push(group.page);
    }
  }

  printJson({
    ok: true,
    dbPath: args.db ?? "work/pipeline.sqlite3",
    summaryFile,
    video: {
      id: state.video.id,
      bvid: state.video.bvid,
      aid: state.video.aid,
      title: state.video.title,
    },
    savedPages,
  });
}

main().catch((error) => {
  printJson({
    ok: false,
    message: error?.message ?? "Unknown error",
    stack: error?.stack,
  });
  process.exitCode = 1;
});
