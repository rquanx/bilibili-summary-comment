import { resolveSummaryUsersConfig } from "../lib/config/app-config.mjs";
import {
  addDatabaseOption,
  addWorkRootOption,
  createCliCommand,
  parsePositiveIntegerArg,
  runCli,
} from "../lib/cli/tools.mjs";
import { syncSummaryUsersRecentVideos } from "../lib/scheduler/index.mjs";

const command = addWorkRootOption(
  addDatabaseOption(
    createCliCommand({
      name: "sync-summary-users",
      description: "Scan recent uploads from configured users and run the pipeline.",
    })
      .option("--cookie-file <path>", "Optional. Cookie file path.")
      .option("--summary-users <users>", "Optional. Comma-separated Bilibili space URLs or user ids.")
      .option("--summary-since-hours <hours>", "Optional. How many recent hours to scan.", parsePositiveIntegerArg),
  ),
);

await runCli({
  command,
  async handler(args) {
    const config = resolveSummaryUsersConfig(args);

    const result = await syncSummaryUsersRecentVideos({
      summaryUsers: config.summaryUsers,
      cookieFile: config.cookieFile,
      sinceHours: config.sinceHours,
      dbPath: config.dbPath,
      workRoot: config.workRoot,
      onLog(message) {
        process.stderr.write(`[sync-summary-users] ${message}\n`);
      },
    });

    if (result.failures.length > 0) {
      process.exitCode = 1;
    }

    return {
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
    };
  },
});
