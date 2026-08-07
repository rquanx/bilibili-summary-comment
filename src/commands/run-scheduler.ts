import cron from "node-cron";
import { resolveSchedulerConfig } from "../infra/config/app-config";
import {
  addDatabaseOption,
  addWorkRootOption,
  createCliCommand,
  parsePositiveIntegerArg,
  runCli,
} from "../shared/cli/tools";
import {
  getLastAuthUpdateAt,
  loadBiliAuthBundle,
  refreshBiliCookie,
  resolveBiliAuthFile,
  resolveBiliCookieFile,
} from "../domains/bili/auth";
import {
  createCoalescedRunner,
  requestDetachedRun,
} from "../domains/scheduler/coalesced-runner";
import {
  createPriorityTaskLimiter,
  PIPELINE_TASK_PRIORITY,
} from "../domains/scheduler/priority-task-limiter";
import {
  cleanupOldWorkDirectories,
  runCommentPublishStallAlert,
  runHistoricalSummaryBackfill,
  runPendingVideoPublishSweep,
  runRecentVideoGapCheck,
  syncSummaryUsersRecentVideos,
} from "../domains/scheduler/index";
import { createLogGroupName, createWorkFileLogger, formatLogDay } from "../shared/logger";
import { cleanupStaleRuntimeLocks } from "../shared/runtime-locks";
import type { LogLevel } from "../shared/logger";
import { formatEast8Time } from "../shared/time";

const command = addWorkRootOption(
  addDatabaseOption(
    createCliCommand({
      name: "run-scheduler",
      description: "Run the recurring refresh, summary, historical backfill, publish, and cleanup scheduler.",
    })
      .option("--cookie-file <path>", "Optional. Cookie file path.")
      .option("--auth-file <path>", "Optional. TV auth file path.")
      .option("--summary-users <users>", "Optional. Comma-separated Bilibili space URLs or user ids.")
      .option("--summary-since-hours <hours>", "Optional. Recent upload window in hours.", parsePositiveIntegerArg)
      .option("--pipeline-concurrency <count>", "Optional. Shared recent and historical pipeline concurrency. Default: 2", parsePositiveIntegerArg)
      .option("--summary-concurrency <count>", "Legacy alias for --pipeline-concurrency.", parsePositiveIntegerArg)
      .option("--historical-summary-daily-limit <count>", "Optional. Historical pipeline starts per calendar day. Default: 200", parsePositiveIntegerArg)
      .option("--historical-summary-concurrency <count>", "Legacy alias for --pipeline-concurrency.", parsePositiveIntegerArg)
      .option("--historical-request-delay-ms <ms>", "Optional. Minimum delay between historical Bilibili requests. Default: 2000")
      .option("--comment-stall-alert-minutes <minutes>", "Optional. Alert after this many minutes without a successful new comment. Default: 60", parsePositiveIntegerArg)
      .option("--refresh-days <days>", "Optional. Refresh auth when older than this many days.", parsePositiveIntegerArg)
      .option("--cleanup-days <days>", "Optional. Remove work dirs older than this many days.", parsePositiveIntegerArg)
      .option("--timezone <timezone>", "Optional. Cron timezone.")
      .option("--run-on-start", "Optional. Run due tasks once before entering the scheduler loop.")
      .option("--once <task>", "Optional. Run one task and exit: refresh | summary | historical-summary | publish | comment-stall-alert | gap-check | cleanup | all."),
  ),
);

await runCli({
  command,
  printResult: false,
  async handler(args) {
    const config = resolveSchedulerConfig(args);
    config.authFile = resolveBiliAuthFile(config.authFile);
    const resolvedCookieFile = config.cookieFile ? resolveBiliCookieFile(config.cookieFile) : null;
    const runningTasks = new Set<string>();
    const pipelineTaskLimiter = createPriorityTaskLimiter({
      maxConcurrent: config.pipelineConcurrency,
    });
    const schedulerLogger = createWorkFileLogger({
      workRoot: config.workRoot,
      name: "scheduler",
      context: {
        scope: "scheduler",
        cookieFile: resolvedCookieFile,
        dbPath: config.dbPath,
      },
    });

    function getErrorMessage(error: unknown) {
      return error instanceof Error ? error.message : "Unknown error";
    }

    function log(message, {
      level = "progress",
      details = undefined,
      console = true,
    }: {
      level?: LogLevel;
      details?: Record<string, unknown> | undefined;
      console?: boolean;
    } = {}) {
      schedulerLogger.log(level, message, details);
      if (console) {
        writeConsole(message);
      }
    }

    function writeConsole(message: string) {
      process.stderr.write(`[scheduler ${formatEast8Time()}] ${message}\n`);
    }

    log(`Detailed log: ${schedulerLogger.filePath}`);
    const startupLockCleanup = cleanupStaleRuntimeLocks({
      workRoot: config.workRoot,
      dbPath: config.dbPath,
    });
    if (startupLockCleanup.removed.length > 0) {
      log(
        `Startup lock cleanup removed ${startupLockCleanup.removed.length} stale lock(s): ${startupLockCleanup.removed.map((entry) => `${entry.name}:${entry.reason}`).join(", ")}`,
        {
          level: "warn",
          details: {
            removedLocks: startupLockCleanup.removed,
          },
        },
      );
    }

    async function runRefreshTask({ force = false } = {}) {
      const bundle = loadBiliAuthBundle(config.authFile);
      if (!bundle) {
        log(`Skip cookie refresh: auth file not found at ${config.authFile}`);
        return {
          action: "skip-refresh",
          reason: "auth-file-missing",
        };
      }

      const lastUpdatedAt = getLastAuthUpdateAt(bundle);
      const refreshDue = force || isOlderThanDays(lastUpdatedAt, config.refreshDays);
      if (!refreshDue) {
        log(`Skip cookie refresh: auth bundle is newer than ${config.refreshDays} days`);
        return {
          action: "skip-refresh",
          reason: "not-due",
          lastUpdatedAt,
        };
      }

      log("Refreshing Bilibili cookie via TV refresh token");
      const result = await refreshBiliCookie({
        authFile: config.authFile,
        cookieFile: resolvedCookieFile,
      });
      log(`Cookie refresh completed: ${result.bundle.updatedAt}`);
      return {
        action: "refresh",
        updatedAt: result.bundle.updatedAt,
      };
    }

    async function runSummaryTask() {
      const startedAt = new Date();
      const logDay = formatLogDay(startedAt);
      const logGroup = createLogGroupName("summary", null, startedAt);
      const summaryLogger = createWorkFileLogger({
        workRoot: config.workRoot,
        name: "scheduler",
        label: "summary",
        day: logDay,
        group: logGroup,
        context: {
          scope: "scheduler",
          task: "summary",
          schedulerLogPath: schedulerLogger.filePath,
        },
      });
      log(`[summary] run log: ${summaryLogger.filePath}`);
      summaryLogger.progress("Scanning SUMMARY_USERS recent uploads");
      writeConsole("Scanning SUMMARY_USERS recent uploads");
      const result = await syncSummaryUsersRecentVideos({
        summaryUsers: config.summaryUsers,
        authFile: config.authFile,
        cookieFile: resolvedCookieFile ?? undefined,
        sinceHours: config.summarySinceHours,
        maxConcurrent: config.pipelineConcurrency,
        dbPath: config.dbPath,
        workRoot: config.workRoot,
        logDay,
        logGroup,
        publish: false,
        runPipelineTask(task) {
          return pipelineTaskLimiter.run(PIPELINE_TASK_PRIORITY.recent, task);
        },
        logger: summaryLogger,
        onLog(message) {
          summaryLogger.progress(message);
          writeConsole(`[summary] ${message}`);
        },
        onPipelineSucceeded({ upload }) {
          const label = upload.title || upload.bvid || "untitled";
          log(`Summary pipeline completed for ${upload.bvid} (${label}); requesting immediate publish sweep`);
          requestDetachedRun({
            task: publishRunner,
            onFailure(error) {
              log(`Failed to request publish after recent summary: ${getErrorMessage(error)}`, {
                level: "error",
              });
            },
          });
        },
      });
      summaryLogger.info("Summary sweep finished", {
        uploads: result.uploads.length,
        failures: result.failures.length,
        runs: result.runs.length,
      });
      log(`Summary sweep finished: uploads=${result.uploads.length}, failures=${result.failures.length}`, {
        details: {
          task: "summary",
          logPath: summaryLogger.filePath,
        },
      });
      if (result.failures.length > 0) {
        for (const failure of result.failures) {
          summaryLogger.error("Summary failure", {
            failure,
            formattedFailure: formatSummaryFailure(failure),
          });
          writeConsole(`[summary] failure: ${formatSummaryFailure(failure)}`);
        }
      }
      return {
        action: "summary",
        uploads: result.uploads.length,
        runs: result.runs.length,
        failures: result.failures.length,
        failureDetails: result.failures.map((failure) => formatSummaryFailure(failure)),
      };
    }

    async function runPublishTask() {
      const startedAt = new Date();
      const logDay = formatLogDay(startedAt);
      const logGroup = createLogGroupName("publish", null, startedAt);
      const publishLogger = createWorkFileLogger({
        workRoot: config.workRoot,
        name: "scheduler",
        label: "publish",
        day: logDay,
        group: logGroup,
        context: {
          scope: "scheduler",
          task: "publish",
          schedulerLogPath: schedulerLogger.filePath,
        },
      });
      log(`[publish] run log: ${publishLogger.filePath}`);
      publishLogger.progress("Scanning queued video publish tasks");
      writeConsole("Scanning queued video publish tasks");
      const result = await runPendingVideoPublishSweep({
        summaryUsers: config.summaryUsers,
        authFile: config.authFile,
        dbPath: config.dbPath,
        workRoot: config.workRoot,
        logDay,
        logGroup,
        logger: publishLogger,
        onLog(message) {
          publishLogger.progress(message);
          writeConsole(`[publish] ${message}`);
        },
      });
      publishLogger.info("Publish sweep finished", {
        queued: result.tasks.length,
        published: result.runs.length,
        failures: result.failures.length,
        aborted: result.aborted,
      });
      log(
        `Publish sweep finished: queued=${result.tasks.length}, published=${result.runs.length}, failures=${result.failures.length}${result.aborted ? ", aborted=true" : ""}`,
        {
          details: {
            task: "publish",
            logPath: publishLogger.filePath,
          },
        },
      );
      if (result.failures.length > 0) {
        for (const failure of result.failures) {
          publishLogger.error("Publish failure", {
            failure,
          });
          writeConsole(`[publish] failure: ${failure.bvid} (${failure.title || "untitled"}) [${failure.publishMode}] ${failure.message}`);
        }
      }
      return {
        action: "publish",
        queued: result.tasks.length,
        runs: result.runs.length,
        failures: result.failures.length,
        aborted: result.aborted,
      };
    }

    async function runHistoricalSummaryTask() {
      const startedAt = new Date();
      const logDay = formatLogDay(startedAt);
      const logGroup = createLogGroupName("historical-summary", null, startedAt);
      const historicalLogger = createWorkFileLogger({
        workRoot: config.workRoot,
        name: "scheduler",
        label: "historical-summary",
        day: logDay,
        group: logGroup,
        context: {
          scope: "scheduler",
          task: "historical-summary",
          schedulerLogPath: schedulerLogger.filePath,
        },
      });
      log(`[historical-summary] run log: ${historicalLogger.filePath}`);
      const result = await runHistoricalSummaryBackfill({
        summaryUsers: config.summaryUsers,
        authFile: config.authFile,
        dbPath: config.dbPath,
        workRoot: config.workRoot,
        timezone: config.timezone ?? null,
        dailyLimit: config.historicalSummaryDailyLimit,
        maxConcurrent: config.pipelineConcurrency,
        maxPipelineStartsPerRun: config.pipelineConcurrency,
        requestDelayMs: config.historicalRequestDelayMs,
        runPipelineTask(task) {
          return pipelineTaskLimiter.run(PIPELINE_TASK_PRIORITY.historical, task);
        },
        logDay,
        logGroup,
        logger: historicalLogger,
        onLog(message) {
          historicalLogger.progress(message);
          writeConsole(`[historical-summary] ${message}`);
        },
      });
      historicalLogger.info("Historical summary sweep finished", {
        targetDate: result.targetDate,
        uploads: result.uploads.length,
        processed: result.runs.length,
        skippedPinnedSummary: result.skippedPinnedSummary.length,
        failures: result.failures.length,
        blockedMids: result.blockedMids,
        advanced: result.advanced,
        quotaUsed: result.quotaUsed,
        dailyLimit: result.dailyLimit,
        cursorPath: result.cursorPath,
      });
      log(
        `Historical summary sweep finished: processed=${result.runs.length}, pinned=${result.skippedPinnedSummary.length}, failures=${result.failures.length}, quota=${result.quotaUsed}/${result.dailyLimit}`,
      );
      if (result.runs.length > 0) {
        log("Historical summaries generated; requesting one publish sweep");
        requestDetachedRun({
          task: publishRunner,
          onFailure(error) {
            log(`Failed to request publish after historical summary: ${getErrorMessage(error)}`, {
              level: "error",
            });
          },
        });
      }
      return {
        action: "historical-summary",
        targetDate: result.targetDate,
        uploads: result.uploads.length,
        runs: result.runs.length,
        skippedPinnedSummary: result.skippedPinnedSummary.length,
        failures: result.failures.length,
        blockedMids: result.blockedMids,
        advanced: result.advanced,
        quotaUsed: result.quotaUsed,
        dailyLimit: result.dailyLimit,
        cursorPath: result.cursorPath,
      };
    }

    async function runCleanupTask() {
      if (runningTasks.has("summary") || runningTasks.has("historical-summary") || runningTasks.has("publish")) {
        log("Skip work cleanup: summary, historical-summary, or publish task is still running");
        return {
          action: "skip-cleanup",
          reason: "pipeline-or-publish-running",
        };
      }

      log("Cleaning old work directories");
      const result = await cleanupOldWorkDirectories({
        dbPath: config.dbPath,
        workRoot: config.workRoot,
        olderThanDays: config.cleanupDays,
        onLog(message) {
          log(`[cleanup] ${message}`);
        },
      });
      log(`Work cleanup finished: removed=${result.removedDirectories.length}`);
      return {
        action: "cleanup",
        removed: result.removedDirectories.length,
      };
    }

    async function runGapCheckTask() {
      log("Checking recent uploads for missing video gaps");
      const result = await runRecentVideoGapCheck({
        summaryUsers: config.summaryUsers,
        authFile: config.authFile,
        cookieFile: resolvedCookieFile ?? undefined,
        dbPath: config.dbPath,
        workRoot: config.workRoot,
        timezone: config.timezone ?? null,
        onLog(message) {
          log(`[gap-check] ${message}`);
        },
      });
      log(
        `Gap check finished: checked=${result.checkedVideos.length}, newGaps=${result.newGaps.length}, notified=${result.notifiedGapCount}`,
        {
          details: {
            task: "gap-check",
            snapshotPath: result.snapshotPath,
          },
        },
      );
      return {
        action: "gap-check",
        checkedVideos: result.checkedVideos.length,
        newGaps: result.newGaps.length,
        notifiedGaps: result.notifiedGapCount,
        alreadyNotifiedGaps: result.alreadyNotifiedGapCount,
        snapshotPath: result.snapshotPath,
      };
    }

    async function runCommentStallAlertTask() {
      const result = await runCommentPublishStallAlert({
        dbPath: config.dbPath,
        workRoot: config.workRoot,
        summaryUsers: config.summaryUsers,
        authFile: config.authFile,
        thresholdMinutes: config.commentStallAlertMinutes,
        onLog(message) {
          log(`[comment-stall-alert] ${message}`, {
            level: message.startsWith("Failed") ? "error" : "warn",
          });
        },
      });

      if (result.notified) {
        log(
          `Comment stall alert sent: pending=${result.candidates.length}, stalled=${result.stalledMinutes}m`,
          {
            level: "warn",
            details: {
              task: "comment-stall-alert",
              statePath: result.statePath,
              pendingBvids: result.candidates.map((candidate) => candidate.bvid),
            },
          },
        );
      }

      return {
        action: "comment-stall-alert",
        notified: result.notified,
        reason: result.reason,
        pending: result.candidates.length,
        stalledMinutes: result.stalledMinutes,
        statePath: result.statePath,
      };
    }

    const runExclusive = (name, task) => async () => {
      if (runningTasks.has(name)) {
        log(`Skip ${name}: previous run still in progress`);
        return null;
      }

      runningTasks.add(name);
      try {
        return await task();
      } catch (error) {
        log(`${name} failed: ${getErrorMessage(error)}`, {
          level: "error",
          details: {
            task: name,
            error,
          },
        });
        return {
          action: `${name}-failed`,
          message: getErrorMessage(error),
        };
      } finally {
        runningTasks.delete(name);
      }
    };

    const refreshRunner = runExclusive("refresh", runRefreshTask);
    const publishRunner = createCoalescedRunner({
      name: "publish",
      runningTasks,
      task: runPublishTask,
      onLog(message) {
        log(message);
      },
      onFailure(error) {
        const message = getErrorMessage(error);
        log(`publish failed: ${message}`, {
          level: "error",
          details: {
            task: "publish",
            error,
          },
        });
        return {
          action: "publish-failed",
          queued: 0,
          runs: 0,
          failures: 1,
          aborted: true,
          message,
        };
      },
    });
    const summaryRunner = createCoalescedRunner({
      name: "summary",
      runningTasks,
      task: runSummaryTask,
      onLog(message) {
        log(message);
      },
      onFailure(error) {
        const message = getErrorMessage(error);
        log(`summary failed: ${message}`, {
          level: "error",
          details: {
            task: "summary",
            error,
          },
        });
        return {
          action: "summary-failed",
          uploads: 0,
          runs: 0,
          failures: 1,
          failureDetails: [message],
          message,
        };
      },
    });
    const historicalSummaryRunner = runExclusive("historical-summary", runHistoricalSummaryTask);
    const cleanupRunner = runExclusive("cleanup", runCleanupTask);
    const gapCheckRunner = runExclusive("gap-check", runGapCheckTask);
    const commentStallAlertRunner = runExclusive("comment-stall-alert", runCommentStallAlertTask);

    if (args.once) {
      const result = await runOnce(args.once, {
        refreshRunner,
        summaryRunner,
        historicalSummaryRunner,
        publishRunner,
        gapCheckRunner,
        commentStallAlertRunner,
        cleanupRunner,
      });
      return {
        ok: true,
        mode: "once",
        task: args.once,
        result,
      };
    }

    const scheduledTasks = [
      cron.schedule("0,15,30,45 * * * *", summaryRunner, buildCronOptions(config.timezone)),
      cron.schedule("5 * * * *", publishRunner, buildCronOptions(config.timezone)),
      cron.schedule("2-59/5 * * * *", commentStallAlertRunner, buildCronOptions(config.timezone)),
      cron.schedule("10 * * * *", gapCheckRunner, buildCronOptions(config.timezone)),
      cron.schedule("0,15,30,45 * * * *", historicalSummaryRunner, buildCronOptions(config.timezone)),
      cron.schedule("15 3 * * *", refreshRunner, buildCronOptions(config.timezone)),
      cron.schedule("45 3 * * *", cleanupRunner, buildCronOptions(config.timezone)),
    ];

    log(`Scheduler started with timezone=${config.timezone ?? "system"}`);
    log(
      `Pipeline slots: total=${pipelineTaskLimiter.capacity}, shared-by=recent+historical, priority=recent-first`,
    );
    log("Cron plan: summary=every15min, publish=hourly@minute5, comment-stall-alert=every5min@minute2, gap-check=hourly@minute10, refresh=daily@03:15 when due, cleanup=daily@03:45, historical-summary=every15min with recent-video pipeline priority");
    attachSignalHandlers(scheduledTasks, log);

    if (args["run-on-start"]) {
      await refreshRunner();
      await summaryRunner();
      await publishRunner();
      await commentStallAlertRunner();
      await gapCheckRunner();
      await cleanupRunner();
    }

    return {
      ok: true,
      mode: "daemon",
      timezone: config.timezone ?? "system",
      summaryUsers: config.summaryUsers,
      pipelineConcurrency: config.pipelineConcurrency,
      historicalSummaryDailyLimit: config.historicalSummaryDailyLimit,
      historicalRequestDelayMs: config.historicalRequestDelayMs,
      commentStallAlertMinutes: config.commentStallAlertMinutes,
      publishTask: "max-concurrency-2-newest-first",
      refreshDays: config.refreshDays,
      cleanupDays: config.cleanupDays,
    };
  },
});

function buildCronOptions(timezone) {
  return timezone ? { timezone } : undefined;
}

function isOlderThanDays(timestamp, days) {
  if (!timestamp) {
    return true;
  }

  const createdAt = new Date(timestamp);
  if (Number.isNaN(createdAt.getTime())) {
    return true;
  }

  return Date.now() - createdAt.getTime() >= Math.max(1, Number(days) || 30) * 24 * 3600 * 1000;
}

async function runOnce(target, runners) {
  switch (String(target).trim()) {
    case "refresh":
      return [await runners.refreshRunner()];
    case "summary":
      return [await runners.summaryRunner()];
    case "historical-summary":
      return [await runners.historicalSummaryRunner()];
    case "publish":
      return [await runners.publishRunner()];
    case "comment-stall-alert":
      return [await runners.commentStallAlertRunner()];
    case "gap-check":
      return [await runners.gapCheckRunner()];
    case "cleanup":
      return [await runners.cleanupRunner()];
    case "all":
      return [
        await runners.refreshRunner(),
        await runners.summaryRunner(),
        await runners.historicalSummaryRunner(),
        await runners.publishRunner(),
        await runners.commentStallAlertRunner(),
        await runners.gapCheckRunner(),
        await runners.cleanupRunner(),
      ];
    default:
      throw new Error(`Invalid --once target: ${target}`);
  }
}

function attachSignalHandlers(scheduledTasks, log) {
  const shutdown = (signal) => {
    log(`Received ${signal}, stopping scheduler`);
    for (const task of scheduledTasks) {
      task.stop();
      task.destroy();
    }
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function formatSummaryFailure(failure) {
  const bvid = String(failure?.bvid ?? "").trim() || "unknown-bvid";
  const title = String(failure?.title ?? "").trim() || "untitled";
  const message = String(failure?.message ?? "").trim() || "Unknown error";
  const details = failure?.details && typeof failure.details === "object" ? failure.details : {};
  const step = formatFailureStep(details);
  const pageNo = normalizePositiveInteger(details.pageNo);
  const segments = [`${bvid} (${title})`];

  if (pageNo !== null) {
    segments.push(`P${pageNo}`);
  }

  if (step) {
    segments.push(`step=${step}`);
  }

  return `${segments.join(" ")}: ${message}`;
}

function formatFailureStep(details) {
  const explicitStep = String(details?.failedStep ?? "").trim();
  if (explicitStep) {
    return explicitStep;
  }

  const scope = String(details?.failedScope ?? "").trim();
  const action = String(details?.failedAction ?? "").trim();
  if (scope && action) {
    return `${scope}/${action}`;
  }

  return scope || action;
}

function normalizePositiveInteger(value) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}
