import { fail, parseArgs, printJson, showUsage } from "./lib/bili-comment-utils.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";
import { syncSummaryUsersRecentVideos } from "./lib/scheduler-tasks.mjs";

loadDotEnvIfPresent();

function usage() {
  showUsage([
    "Usage:",
    "  node scripts/sync-summary-users.mjs --cookie-file cookie.txt",
    "  node scripts/sync-summary-users.mjs --cookie-file cookie.txt --summary-users \"https://space.bilibili.com/1,https://space.bilibili.com/2\"",
    "",
    "Options:",
    "  --cookie-file             Optional. Cookie file path. Default: cookie.txt or BILI_COOKIE_FILE",
    "  --summary-users           Optional. Comma-separated Bilibili space URLs or user ids. Default: SUMMARY_USERS",
    "  --summary-since-hours     Optional. How many recent hours to scan. Default: 24",
    "  --db                      Optional. SQLite path. Default: work/pipeline.sqlite3",
    "  --work-root               Optional. Work root. Default: work",
    "  --help                    Show this help.",
  ]);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    usage();
    return;
  }

  const result = await syncSummaryUsersRecentVideos({
    summaryUsers: args["summary-users"] ?? process.env.SUMMARY_USERS ?? "",
    cookieFile: args["cookie-file"] ?? process.env.BILI_COOKIE_FILE ?? "cookie.txt",
    sinceHours: Number(args["summary-since-hours"] ?? process.env.SUMMARY_SINCE_HOURS ?? 24),
    dbPath: args.db ?? process.env.PIPELINE_DB_PATH ?? "work/pipeline.sqlite3",
    workRoot: args["work-root"] ?? process.env.WORK_ROOT ?? "work",
    onLog(message) {
      process.stderr.write(`[sync-summary-users] ${message}\n`);
    },
  });

  if (result.failures.length > 0) {
    process.exitCode = 1;
  }

  printJson({
    ok: result.failures.length === 0,
    summaryUsers: result.summaryUsers,
    uploadCount: result.uploads.length,
    successCount: result.runs.length,
    failureCount: result.failures.length,
    runs: result.runs.map((item) => ({
      mid: item.mid,
      bvid: item.bvid,
      title: item.title,
      createdAt: item.createdAt,
      generatedPages: item.result?.generatedPages ?? [],
      reusedSummaryFrom: item.result?.reusedSummaryFrom ?? null,
    })),
    failures: result.failures,
  });
}

main().catch((error) => {
  fail(error?.message ?? "Unknown error", {
    stack: error?.stack,
  });
});
