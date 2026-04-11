import { resolveSummaryUsersConfig } from "../lib/config/app-config";
import {
  addDatabaseOption,
  addWorkRootOption,
  createCliCommand,
  parsePositiveIntegerArg,
  runCli,
} from "../lib/cli/tools";
import { syncSummaryUsersRecentVideos } from "../lib/scheduler/index";
import { createLogGroupName, createWorkFileLogger, formatLogDay } from "../lib/shared/logger";
import type { PipelineProcessResult } from "../lib/scheduler/pipeline-runner";

const command = addWorkRootOption(
  addDatabaseOption(
    createCliCommand({
      name: "sync-summary-users",
      description: "Scan recent uploads from configured users and run the pipeline.",
    })
      .option("--cookie-file <path>", "Optional. Cookie file path.")
      .option("--summary-users <users>", "Optional. Comma-separated Bilibili space URLs or user ids.")
      .option("--summary-since-hours <hours>", "Optional. How many recent hours to scan.", parsePositiveIntegerArg)
      .option("--summary-concurrency <count>", "Optional. Max concurrent pipelines. Default: 3", parsePositiveIntegerArg),
  ),
);

await runCli({
  command,
  printResult: false,
  async handler(args) {
    const config = resolveSummaryUsersConfig(args);
    const startedAt = new Date();
    const logDay = formatLogDay(startedAt);
    const logGroup = createLogGroupName("summary", "sync-summary-users", startedAt);
    const logger = createWorkFileLogger({
      workRoot: config.workRoot,
      name: "sync-summary-users",
      day: logDay,
      group: logGroup,
      context: {
        scope: "sync-summary-users",
        dbPath: config.dbPath,
      },
    });
    process.stderr.write(`[sync-summary-users] Detailed log: ${logger.filePath}\n`);

    const result = await syncSummaryUsersRecentVideos({
      summaryUsers: config.summaryUsers,
      cookieFile: config.cookieFile,
      sinceHours: config.sinceHours,
      maxConcurrent: config.summaryConcurrency,
      dbPath: config.dbPath,
      workRoot: config.workRoot,
      logDay,
      logGroup,
      logger,
      onLog(message) {
        logger.progress(message);
        process.stderr.write(`[sync-summary-users] ${message}\n`);
      },
    });

    if (result.failures.length > 0) {
      process.exitCode = 1;
    }

    process.stderr.write(
      `[sync-summary-users] Finished: uploads=${result.uploads.length}, success=${result.runs.length}, failures=${result.failures.length}\n`,
    );

    return {
      ok: result.failures.length === 0,
      logPath: logger.filePath,
      summaryUsers: result.summaryUsers,
      uploadCount: result.uploads.length,
      successCount: result.runs.length,
      failureCount: result.failures.length,
      summaryConcurrency: config.summaryConcurrency,
      runs: result.runs.map((item) => ({
        mid: item.mid,
        bvid: item.bvid,
        title: item.title,
        createdAt: item.createdAt,
        generatedPages: (item.result as PipelineProcessResult | undefined)?.generatedPages ?? [],
        reusedSummaryFrom: (item.result as PipelineProcessResult | undefined)?.reusedSummaryFrom ?? null,
      })),
      failures: result.failures,
    };
  },
});
