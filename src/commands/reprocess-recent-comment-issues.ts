import { resolveSummaryUsersConfig } from "../infra/config/app-config";
import {
  addDatabaseOption,
  addWorkRootOption,
  createCliCommand,
  parsePositiveIntegerArg,
  runCli,
} from "../shared/cli/tools";
import {
  getLatestSuccessfulRecentReprocessRunByCandidateKey,
  getVideoByIdentity,
  openDatabase,
  saveRecentReprocessRun,
} from "../infra/db/index";
import {
  buildRecentReprocessCandidateKey,
  collectRecentReprocessCandidates,
  formatRecentReprocessReason,
  prepareRecentReprocessCandidate,
} from "../domains/scheduler/recent-reprocess";
import {
  collectRecentUploadsFromUsers,
  runRecentUploadsPipelines,
} from "../domains/scheduler/uploads";
import { createLogGroupName, createWorkFileLogger, formatLogDay } from "../shared/logger";
import type { RecentUpload } from "../domains/scheduler/uploads";

const DEFAULT_RECENT_REPROCESS_HOURS = 15 * 24;

const command = addWorkRootOption(
  addDatabaseOption(
    createCliCommand({
      name: "reprocess-recent-comment-issues",
      description: "Reprocess recent uploads whose published comments are missing or still use paste.rs.",
    })
      .option("--auth-file <path>", "Optional. Auth file path.")
      .option("--bvids <bvids>", "Optional. Comma-separated BV ids to process exclusively.")
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
    const requestedBvids = parseRequestedBvids(args.bvids);
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
        requestedBvidCount: requestedBvids.length,
      },
    });
    process.stderr.write(`[reprocess-recent-comment-issues] Detailed log: ${logger.filePath}\n`);

    const db = openDatabase(config.dbPath);
    try {
      const collected = requestedBvids.length > 0
        ? {
          summaryUsers: [],
          uploads: buildRequestedUploads({
            db,
            requestedBvids,
            authFile: config.authFile,
          }),
        }
        : await collectRecentUploadsFromUsers({
          summaryUsers: config.summaryUsers,
          authFile: config.authFile,
          sinceHours: config.sinceHours,
          onLog(message) {
            logger.progress(message);
            process.stderr.write(`[reprocess-recent-comment-issues] ${message}\n`);
          },
        });

      if (requestedBvids.length > 0) {
        process.stderr.write(
          `[reprocess-recent-comment-issues] Using explicit BV filter (${requestedBvids.length}): ${requestedBvids.join(", ")}\n`,
        );
      } else {
        process.stderr.write(
          `[reprocess-recent-comment-issues] Scanning recent uploads within ${config.sinceHours} hours\n`,
        );
      }

      const candidates = await collectRecentReprocessCandidates(db, collected.uploads);
      const skipped = candidates.flatMap((candidate) => {
        const candidateKey = buildRecentReprocessCandidateKey(candidate);
        const processed = getLatestSuccessfulRecentReprocessRunByCandidateKey(db, candidateKey);
        if (!processed) {
          return [];
        }

        logger.info("Skip already successful recent reprocess candidate", {
          bvid: candidate.bvid,
          title: candidate.title,
          candidateKey,
          previousRunId: processed.id,
          previousFinishedAt: processed.finished_at,
        });
        return [{
          bvid: candidate.bvid,
          title: candidate.title,
          candidateKey,
          reasons: candidate.reasons,
          pastePages: candidate.pastePages,
          previousRunId: processed.id,
          previousFinishedAt: processed.finished_at,
        }];
      });
      const skippedBvidSet = new Set(skipped.map((item) => item.bvid));
      const pendingCandidates = candidates.filter((candidate) => !skippedBvidSet.has(candidate.bvid));

      for (const candidate of pendingCandidates) {
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
          `[reprocess-recent-comment-issues] Dry run matched ${pendingCandidates.length} videos and skipped ${skipped.length} previously successful candidates\n`,
        );
        console.log(JSON.stringify(buildResultPayload({
          config,
          collected,
          candidates: pendingCandidates,
          skipped,
          prepared: [],
          runs: [],
          failures: [],
          dryRun: true,
        }), null, 2));
        return;
      }

      const prepared = pendingCandidates.map((candidate) => ({
        bvid: candidate.bvid,
        candidateKey: buildRecentReprocessCandidateKey(candidate),
        reasons: candidate.reasons,
        pastePages: candidate.pastePages,
        ...prepareRecentReprocessCandidate(db, candidate),
      }));
      const candidateByBvid = new Map(
        pendingCandidates.map((candidate) => [candidate.bvid, candidate] as const),
      );
      const preparedBvidSet = new Set(pendingCandidates.map((candidate) => candidate.bvid));
      const rerunResult = await runRecentUploadsPipelines({
        uploads: collected.uploads.filter((upload) => preparedBvidSet.has(upload.bvid)),
        dbPath: config.dbPath,
        workRoot: config.workRoot,
        logDay,
        logGroup,
        maxConcurrent: config.summaryConcurrency,
        forceFreshThread: true,
        logger,
        onLog(message) {
          logger.progress(message);
          process.stderr.write(`[reprocess-recent-comment-issues] ${message}\n`);
        },
      });

      const finishedAt = new Date().toISOString();
      for (const run of rerunResult.runs) {
        const candidate = candidateByBvid.get(run.bvid);
        if (!candidate || run.result?.ok === false) {
          continue;
        }

        saveRecentReprocessRun(db, {
          videoId: candidate.videoId,
          bvid: candidate.bvid,
          videoTitle: candidate.title,
          candidateKey: buildRecentReprocessCandidateKey(candidate),
          reasons: candidate.reasons,
          pastePages: candidate.pastePages,
          status: "success",
          details: {
            generatedPages: Array.isArray(run.result?.generatedPages) ? run.result.generatedPages : [],
            publishResult: run.result?.publishResult ?? null,
          },
          finishedAt,
        });
      }

      for (const failure of rerunResult.failures) {
        const candidate = candidateByBvid.get(failure.bvid);
        if (!candidate) {
          continue;
        }

        saveRecentReprocessRun(db, {
          videoId: candidate.videoId,
          bvid: candidate.bvid,
          videoTitle: candidate.title,
          candidateKey: buildRecentReprocessCandidateKey(candidate),
          reasons: candidate.reasons,
          pastePages: candidate.pastePages,
          status: "failed",
          errorMessage: failure.message,
          details: failure.details ?? null,
          finishedAt,
        });
      }

      if (rerunResult.failures.length > 0) {
        process.exitCode = 1;
      }

      process.stderr.write(
        `[reprocess-recent-comment-issues] Finished: matched=${pendingCandidates.length}, skipped=${skipped.length}, success=${rerunResult.runs.length}, failures=${rerunResult.failures.length}\n`,
      );
      console.log(JSON.stringify(buildResultPayload({
        config,
        collected,
        candidates: pendingCandidates,
        skipped,
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
  skipped,
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
  skipped: Array<{
    bvid: string;
    title: string;
    candidateKey: string;
    reasons: string[];
    pastePages: number[];
    previousRunId: number;
    previousFinishedAt: string | null;
  }>;
  prepared: Array<{
    bvid: string;
    candidateKey: string;
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
    skippedCount: skipped.length,
    successCount: runs.length,
    failureCount: failures.length,
    summaryConcurrency: config.summaryConcurrency,
    skipped: skipped.map((item) => ({
      bvid: item.bvid,
      title: item.title,
      candidateKey: item.candidateKey,
      reasons: item.reasons.map(formatRecentReprocessReason),
      pastePages: item.pastePages,
      previousRunId: item.previousRunId,
      previousFinishedAt: item.previousFinishedAt,
    })),
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

function parseRequestedBvids(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  return [...new Set(
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  )];
}

function buildRequestedUploads({
  db,
  requestedBvids,
  authFile,
}: {
  db: Parameters<typeof getVideoByIdentity>[0];
  requestedBvids: string[];
  authFile: string;
}): RecentUpload[] {
  const now = Date.now();
  return requestedBvids.map((bvid, index) => {
    const video = getVideoByIdentity(db, { bvid, aid: null });
    const createdAt = normalizeCreatedAt(video?.created_at, now + index * 1000);
    return {
      mid: Number(video?.owner_mid ?? 0),
      bvid,
      aid: Number(video?.aid ?? 0) || null,
      title: String(video?.title ?? "").trim() || bvid,
      authFile,
      createdAtUnix: Math.floor(Date.parse(createdAt) / 1000),
      createdAt,
      source: "manual-bvids",
    };
  });
}

function normalizeCreatedAt(value: unknown, fallbackMs: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized) {
    const parsed = Date.parse(normalized);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }

  return new Date(fallbackMs).toISOString();
}
