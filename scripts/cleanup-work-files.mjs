import { fail, parseArgs, printJson, showUsage } from "./lib/bili-comment-utils.mjs";
import { cleanupOldWorkDirectories } from "./lib/scheduler-tasks.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";

loadDotEnvIfPresent();

function usage() {
  showUsage([
    "Usage:",
    "  node scripts/cleanup-work-files.mjs",
    "",
    "Options:",
    "  --db                      Optional. SQLite path. Default: work/pipeline.sqlite3",
    "  --work-root               Optional. Work root. Default: work",
    "  --cleanup-days            Optional. Remove files older than this many days. Default: 2",
    "  --help                    Show this help.",
  ]);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    usage();
    return;
  }

  const result = await cleanupOldWorkDirectories({
    dbPath: args.db ?? process.env.PIPELINE_DB_PATH ?? "work/pipeline.sqlite3",
    workRoot: args["work-root"] ?? process.env.WORK_ROOT ?? "work",
    olderThanDays: Number(args["cleanup-days"] ?? process.env.WORK_CLEANUP_DAYS ?? 2),
    onLog(message) {
      process.stderr.write(`[cleanup-work] ${message}\n`);
    },
  });

  printJson({
    ok: true,
    cutoffIso: result.cutoffIso,
    candidateCount: result.candidates.length,
    removedCount: result.removedDirectories.length,
    missingCount: result.missingDirectories.length,
    removedDirectories: result.removedDirectories,
  });
}

main().catch((error) => {
  fail(error?.message ?? "Unknown error", {
    stack: error?.stack,
  });
});
