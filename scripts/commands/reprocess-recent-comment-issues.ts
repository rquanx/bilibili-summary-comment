import { resolveSummaryUsersConfig } from "../lib/config/app-config";
import {
  addDatabaseOption,
  addWorkRootOption,
  createCliCommand,
  parsePositiveIntegerArg,
  runCli,
} from "../lib/cli/tools";
import { openDatabase } from "../lib/db/index";
import {
  collectRecentReprocessCandidates,
  formatRecentReprocessReason,
  prepareRecentReprocessCandidate,
} from "../lib/scheduler/recent-reprocess";
import { collectRecentUploadsFromUsers, syncSummaryUsersRecentVideos } from "../lib/scheduler/uploads";
import { createLogGroupName, createWorkFileLogger, formatLogDay } from "../lib/shared/logger";

const DEFAULT_RECENT_REPROCESS_HOURS = 15 * 24;

const command = addWorkRootOption(
  addDatabaseOption(
    createCliCommand({
      name: "reprocess-recent-comment-issues",
      description: "Reprocess recent uploads whose published comments are missing or still use paste.rs.",
    })
      .option("--auth-file <path>", "Optional. Auth file path.")
      .option("--summary-users <users>", "Optional. Comma-separated Bilibili space URLs or user ids.")
      .option("--summary-since-hours <hours>", `Optional. Recent upload window in hours. Default: ${DEFAULT_RECENT_REPROCESS_HOURS}`, parsePositiveIntegerArg)
      .option("--summary-concurrency <count>", "Optional. Max concurrent pipelines. Default: 3", parsePositiveIntegerArg)
      .option("--dry-run", "Optional. Only print matched videos without modifying the database or running pipelines."),
  ),
);

await runCli({
  command,
  printResult: false,
  async handler(args) {
    const effectiveArgs = {
      ...args,
      "summary-since-hours": args["summary-since-hours"] ?? DEFAULT_RECENT_REPROCESS_HOURS,
    };
    const config = resolveSummaryUsersConfig(effectiveArgs);
    const startedAt = new Date();
    const logDay = formatLogDay(startedAt);
    const logGroup = createLogGroupName("summary", "reprocess-recent-comment-issues", startedAt);
    const logger = createWorkFileLogger({
      workRoot: config.workRoot,
      name: "reprocess-recent-comment-issues",
      day: logDay,
      group: logGroup,
      context: {
        scope: "reprocess-recent-comment-issues",
        dbPath: config.dbPath,
        sinceHours: config.sinceHours,
      },
    });
    process.stderr.write(`[reprocess-recent-comment-issues] Detailed log: ${logger.filePath}\n`);
    process.stderr.write(
      `[reprocess-recent-comment-issues] Scanning recent uploads within ${config.sinceHours} hours\n`,
    );

    const collected = await collectRecentUploadsFromUsers({
      summaryUsers: config.summaryUsers,
      authFile: config.authFile,
      sinceHours: config.sinceHours,
      onLog(message) {
        logger.progress(message);
        process.stderr.write(`[reprocess-recent-comment-issues] ${message}\n`);
      },
    });

    const db = openDatabase(config.dbPath);
    try {
      const candidates = collectRecentReprocessCandidates(db, collected.uploads);
      for (const candidate of candidates) {
        logger.info("Matched recent reprocess candidate", {
          bvid: candidate.bvid,
          title: candidate.title,
          reasons: candidate.reasons,
          pastePages: candidate.pastePages,
          hadStoredVideo: candidate.hadStoredVideo,
        });
      }

      if (Boolean(args["dry-run"])) {
        process.stderr.write(
          `[reprocess-recent-comment-issues] Dry run matched ${candidates.length} videos\n`,
        );
        console.log(JSON.stringify(buildResultPayload({
          config,
          collected,
          candidates,
          prepared: [],
          runs: [],
          failures: [],
          dryRun: true,
        }), null, 2));
        return;
      }

      const prepared = candidates.map((candidate) => ({
        bvid: candidate.bvid,
        reasons: candidate.reasons,
        pastePages: candidate.pastePages,
        ...prepareRecentReprocessCandidate(db, candidate),
      }));

      const preparedBvidSet = new Set(candidates.map((candidate) => candidate.bvid));
      const rerunResult = await syncSummaryUsersRecentVideos({
        summaryUsers: config.summaryUsers,
        authFile: config.authFile,
        sinceHours: config.sinceHours,
        maxConcurrent: config.summaryConcurrency,
        dbPath: config.dbPath,
        workRoot: config.workRoot,
        logDay,
        logGroup,
        logger,
        collectRecentUploadsImpl: async () => ({
          summaryUsers: collected.summaryUsers,
          uploads: collected.uploads.filter((upload) => preparedBvidSet.has(upload.bvid)),
        }),
        onLog(message) {
          logger.progress(message);
          process.stderr.write(`[reprocess-recent-comment-issues] ${message}\n`);
        },
      });

      if (rerunResult.failures.length > 0) {
        process.exitCode = 1;
      }

      process.stderr.write(
        `[reprocess-recent-comment-issues] Finished: matched=${candidates.length}, success=${rerunResult.runs.length}, failures=${rerunResult.failures.length}\n`,
      );
      console.log(JSON.stringify(buildResultPayload({
        config,
        collected,
        candidates,
        prepared,
        runs: rerunResult.runs,
        failures: rerunResult.failures,
        dryRun: false,
      }), null, 2));
    } finally {
      db.close?.();
    }
  },
});

function buildResultPayload({
  config,
  collected,
  candidates,
  prepared,
  runs,
  failures,
  dryRun,
}: {
  config: {
    sinceHours: number;
    summaryConcurrency: number;
  };
  collected: {
    summaryUsers: unknown[];
    uploads: Array<{ bvid: string }>;
  };
  candidates: Array<{
    bvid: string;
    title: string;
    createdAt: string;
    reasons: string[];
    pastePages: number[];
    hadStoredVideo: boolean;
  }>;
  prepared: Array<{
    bvid: string;
    reasons: string[];
    pastePages: number[];
    videoId: number | null;
    clearedProcessedPages: number[];
    resetPublishedState: boolean;
    markedPublishRebuild: boolean;
  }>;
  runs: Array<{
    bvid: string;
    title?: string;
    result?: {
      generatedPages?: unknown;
      publishResult?: unknown;
    };
  }>;
  failures: unknown[];
  dryRun: boolean;
}) {
  return {
    ok: failures.length === 0,
    dryRun,
    sinceHours: config.sinceHours,
    scannedUploadCount: collected.uploads.length,
    matchedCount: candidates.length,
    successCount: runs.length,
    failureCount: failures.length,
    summaryConcurrency: config.summaryConcurrency,
    candidates: candidates.map((candidate) => ({
      bvid: candidate.bvid,
      title: candidate.title,
      createdAt: candidate.createdAt,
      reasons: candidate.reasons.map(formatRecentReprocessReason),
      pastePages: candidate.pastePages,
      hadStoredVideo: candidate.hadStoredVideo,
    })),
    prepared,
    runs: runs.map((item) => ({
      bvid: item.bvid,
      title: item.title ?? null,
      generatedPages: Array.isArray(item.result?.generatedPages) ? item.result.generatedPages : [],
      publishResult: item.result?.publishResult ?? null,
    })),
    failures,
  };
}
