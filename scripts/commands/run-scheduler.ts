import os from "node:os";
import cron from "node-cron";
import { resolveSchedulerConfig } from "../lib/config/app-config";
import {
  addDatabaseOption,
  addWorkRootOption,
  createCliCommand,
  parsePositiveIntegerArg,
  runCli,
} from "../lib/cli/tools";
import {
  getLastAuthUpdateAt,
  loadBiliAuthBundle,
  refreshBiliCookie,
  resolveBiliAuthFile,
  resolveBiliCookieFile,
} from "../lib/bili/auth";
import { createCoalescedRunner } from "../lib/scheduler/coalesced-runner";
import {
  cleanupOldWorkDirectories,
  runPendingVideoPublishSweep,
  runRecentVideoGapCheck,
  syncSummaryUsersRecentVideos,
} from "../lib/scheduler/index";
import { openDatabase, upsertSchedulerStatus } from "../lib/db/index";
import { createLogGroupName, createWorkFileLogger, formatLogDay } from "../lib/shared/logger";
import type { LogLevel } from "../lib/shared/logger";
import { formatEast8Time } from "../lib/shared/time";
import { createOperationsService } from "../../packages/core/src/index";

const command = addWorkRootOption(
  addDatabaseOption(
    createCliCommand({
      name: "run-scheduler",
      description: "Run the recurring refresh, summary, and cleanup scheduler.",
    })
      .option("--cookie-file <path>", "Optional. Cookie file path.")
      .option("--auth-file <path>", "Optional. TV auth file path.")
      .option("--summary-users <users>", "Optional. Comma-separated Bilibili space URLs or user ids.")
      .option("--summary-since-hours <hours>", "Optional. Recent upload window in hours.", parsePositiveIntegerArg)
      .option("--summary-concurrency <count>", "Optional. Max concurrent pipelines. Default: 3", parsePositiveIntegerArg)
      .option("--retry-failures-limit <count>", "Optional. Max retryable failures to retrigger per sweep. Default: 3", parsePositiveIntegerArg)
      .option("--retry-failures-since-hours <hours>", "Optional. How far back the retry sweep scans failed runs.", parsePositiveIntegerArg)
      .option("--retry-failures-max-recent <count>", "Optional. Max recent retries allowed per bvid in the retry window.", parsePositiveIntegerArg)
      .option("--retry-failures-window-hours <hours>", "Optional. Recent retry window for duplicate suppression.", parsePositiveIntegerArg)
      .option("--refresh-days <days>", "Optional. Refresh auth when older than this many days.", parsePositiveIntegerArg)
      .option("--cleanup-days <days>", "Optional. Remove work dirs older than this many days.", parsePositiveIntegerArg)
      .option("--timezone <timezone>", "Optional. Cron timezone.")
      .option("--run-on-start", "Optional. Run due tasks once before entering the scheduler loop.")
      .option("--once <task>", "Optional. Run one task and exit: refresh | summary | publish | gap-check | retry-failures | cleanup | all."),
  ),
);

await runCli({
  command,
  printResult: false,
  async handler(args) {
    function readSchedulerConfig() {
      const nextConfig = resolveSchedulerConfig(args);
      nextConfig.authFile = resolveBiliAuthFile(nextConfig.authFile);
      nextConfig.cookieFile = nextConfig.cookieFile ? resolveBiliCookieFile(nextConfig.cookieFile) : null;
      return nextConfig;
    }

    let runtimeConfig = readSchedulerConfig();
    const runningTasks = new Set<string>();
    const schedulerStatusDb = openDatabase(runtimeConfig.dbPath);
    const operationsService = createOperationsService({
      dbPath: runtimeConfig.dbPath,
      workRoot: runtimeConfig.workRoot,
      triggerSource: "scheduler",
    });
    const schedulerStartedAt = new Date().toISOString();
    let schedulerHeartbeat: NodeJS.Timeout | null = null;
    const schedulerLogger = createWorkFileLogger({
      workRoot: runtimeConfig.workRoot,
      name: "scheduler",
      context: {
        scope: "scheduler",
        cookieFile: runtimeConfig.cookieFile,
        dbPath: runtimeConfig.dbPath,
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

    function updateSchedulerStatus({
      status = "running",
      currentTasks = [...runningTasks],
      lastSummaryAt = null,
      lastPublishAt = null,
      lastGapCheckAt = null,
      lastRetryFailuresAt = null,
      lastRefreshAt = null,
      lastCleanupAt = null,
      lastError = null,
    }: {
      status?: string;
      currentTasks?: string[];
      lastSummaryAt?: string | null;
      lastPublishAt?: string | null;
      lastGapCheckAt?: string | null;
      lastRetryFailuresAt?: string | null;
      lastRefreshAt?: string | null;
      lastCleanupAt?: string | null;
      lastError?: string | null;
    } = {}) {
      upsertSchedulerStatus(schedulerStatusDb, {
        schedulerKey: "main",
        status,
        mode: args.once ? "once" : "daemon",
        timezone: runtimeConfig.timezone ?? null,
        pid: process.pid,
        hostname: os.hostname(),
        summaryUsers: runtimeConfig.summaryUsers,
        summaryConcurrency: runtimeConfig.summaryConcurrency,
        currentTasks,
        lastSummaryAt,
        lastPublishAt,
        lastGapCheckAt,
        lastRetryFailuresAt,
        lastRefreshAt,
        lastCleanupAt,
        lastError,
        startedAt: schedulerStartedAt,
        lastHeartbeatAt: new Date().toISOString(),
      });
    }

    function markTaskHeartbeat() {
      updateSchedulerStatus();
    }

    function markTaskResult(taskName: string, {
      errorMessage = null,
    }: {
      errorMessage?: string | null;
    } = {}) {
      const now = new Date().toISOString();
      updateSchedulerStatus({
        ...(taskName === "summary" ? { lastSummaryAt: now } : {}),
        ...(taskName === "publish" ? { lastPublishAt: now } : {}),
        ...(taskName === "gap-check" ? { lastGapCheckAt: now } : {}),
        ...(taskName === "retry-failures" ? { lastRetryFailuresAt: now } : {}),
        ...(taskName === "refresh" ? { lastRefreshAt: now } : {}),
        ...(taskName === "cleanup" ? { lastCleanupAt: now } : {}),
        ...(errorMessage ? { lastError: `${taskName}: ${errorMessage}` } : {}),
      });
    }

    log(`Detailed log: ${schedulerLogger.filePath}`);
    updateSchedulerStatus({
      status: "running",
    });
    schedulerHeartbeat = setInterval(markTaskHeartbeat, 5_000);

    async function runTrackedTask<T>(taskName: string, task: () => Promise<T>) {
      updateSchedulerStatus({
        status: "running",
      });

      try {
        const result = await task();
        markTaskResult(taskName);
        return result;
      } catch (error) {
        markTaskResult(taskName, {
          errorMessage: getErrorMessage(error),
        });
        throw error;
      }
    }

    async function runRefreshTask({ force = false } = {}) {
      runtimeConfig = readSchedulerConfig();
      const bundle = loadBiliAuthBundle(runtimeConfig.authFile);
      if (!bundle) {
        log(`Skip cookie refresh: auth file not found at ${runtimeConfig.authFile}`);
        return {
          action: "skip-refresh",
          reason: "auth-file-missing",
        };
      }

      const lastUpdatedAt = getLastAuthUpdateAt(bundle);
      const refreshDue = force || isOlderThanDays(lastUpdatedAt, runtimeConfig.refreshDays);
      if (!refreshDue) {
        log(`Skip cookie refresh: auth bundle is newer than ${runtimeConfig.refreshDays} days`);
        return {
          action: "skip-refresh",
          reason: "not-due",
          lastUpdatedAt,
        };
      }

      log("Refreshing Bilibili cookie via TV refresh token");
      const result = await refreshBiliCookie({
        authFile: runtimeConfig.authFile,
        cookieFile: runtimeConfig.cookieFile,
      });
      log(`Cookie refresh completed: ${result.bundle.updatedAt}`);
      return {
        action: "refresh",
        updatedAt: result.bundle.updatedAt,
      };
    }

    async function runSummaryTask() {
      runtimeConfig = readSchedulerConfig();
      const startedAt = new Date();
      const logDay = formatLogDay(startedAt);
      const logGroup = createLogGroupName("summary", null, startedAt);
      const summaryLogger = createWorkFileLogger({
        workRoot: runtimeConfig.workRoot,
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
        summaryUsers: runtimeConfig.summaryUsers,
        authFile: runtimeConfig.authFile,
        cookieFile: runtimeConfig.cookieFile ?? undefined,
        sinceHours: runtimeConfig.summarySinceHours,
        maxConcurrent: runtimeConfig.summaryConcurrency,
        dbPath: runtimeConfig.dbPath,
        workRoot: runtimeConfig.workRoot,
        logDay,
        logGroup,
        publish: false,
        logger: summaryLogger,
        onLog(message) {
          summaryLogger.progress(message);
          writeConsole(`[summary] ${message}`);
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
      runtimeConfig = readSchedulerConfig();
      const startedAt = new Date();
      const logDay = formatLogDay(startedAt);
      const logGroup = createLogGroupName("publish", null, startedAt);
      const publishLogger = createWorkFileLogger({
        workRoot: runtimeConfig.workRoot,
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
        summaryUsers: runtimeConfig.summaryUsers,
        authFile: runtimeConfig.authFile,
        dbPath: runtimeConfig.dbPath,
        workRoot: runtimeConfig.workRoot,
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

    async function runCleanupTask() {
      runtimeConfig = readSchedulerConfig();
      if (runningTasks.has("summary") || runningTasks.has("publish")) {
        log("Skip work cleanup: summary or publish task is still running");
        return {
          action: "skip-cleanup",
          reason: "summary-or-publish-running",
        };
      }

      log("Cleaning old work directories");
      const result = await cleanupOldWorkDirectories({
        dbPath: runtimeConfig.dbPath,
        workRoot: runtimeConfig.workRoot,
        olderThanDays: runtimeConfig.cleanupDays,
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
      runtimeConfig = readSchedulerConfig();
      log("Checking recent uploads for missing video gaps");
      const result = await runRecentVideoGapCheck({
        summaryUsers: runtimeConfig.summaryUsers,
        authFile: runtimeConfig.authFile,
        cookieFile: runtimeConfig.cookieFile ?? undefined,
        dbPath: runtimeConfig.dbPath,
        workRoot: runtimeConfig.workRoot,
        sinceHours: runtimeConfig.gapCheckSinceHours,
        gapThresholdSeconds: runtimeConfig.gapThresholdSeconds,
        timezone: runtimeConfig.timezone ?? null,
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

    async function runRetryFailuresTask() {
      runtimeConfig = readSchedulerConfig();
      log("Scanning retryable failure queue");
      const result = await operationsService.retryRetryableFailures({
        confirm: true,
        limit: runtimeConfig.retryFailuresLimit,
        sinceHours: runtimeConfig.retryFailuresSinceHours,
        maxRecentRetries: runtimeConfig.retryFailuresMaxRecent,
        retryWindowHours: runtimeConfig.retryFailuresWindowHours,
      });
      const payload = result.result && typeof result.result === "object"
        ? result.result as {
          triggered?: number;
          skipped?: number;
          failed?: number;
          scanned?: number;
        }
        : null;
      log(
        `Retry failure sweep finished: triggered=${String(payload?.triggered ?? 0)}, skipped=${String(payload?.skipped ?? 0)}, failed=${String(payload?.failed ?? 0)}`,
        {
          details: {
            task: "retry-failures",
            scanned: payload?.scanned ?? null,
          },
        },
      );
      return {
        action: "retry-failures",
        triggered: payload?.triggered ?? 0,
        skipped: payload?.skipped ?? 0,
        failed: payload?.failed ?? 0,
        scanned: payload?.scanned ?? 0,
      };
    }

    const runExclusive = (name, task) => async () => {
      if (runningTasks.has(name)) {
        log(`Skip ${name}: previous run still in progress`);
        return null;
      }

      runningTasks.add(name);
      markTaskHeartbeat();
      try {
        return await runTrackedTask(name, task);
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
        markTaskHeartbeat();
      }
    };

    const refreshRunner = runExclusive("refresh", runRefreshTask);
    const publishRunner = createCoalescedRunner({
      name: "publish",
      runningTasks,
      task: () => runTrackedTask("publish", runPublishTask),
      onLog(message) {
        log(message);
      },
      onStateChange() {
        markTaskHeartbeat();
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
      task: () => runTrackedTask("summary", runSummaryTask),
      onLog(message) {
        log(message);
      },
      onStateChange() {
        markTaskHeartbeat();
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
      onAfterSuccess(result) {
        if ((result?.uploads ?? 0) <= 0) {
          return;
        }

        log("Summary sweep finished with recent uploads; requesting immediate publish sweep");
        void publishRunner();
      },
    });
    const cleanupRunner = runExclusive("cleanup", runCleanupTask);
    const gapCheckRunner = runExclusive("gap-check", runGapCheckTask);
    const retryFailuresRunner = runExclusive("retry-failures", runRetryFailuresTask);

    if (args.once) {
      const result = await runOnce(args.once, {
        refreshRunner,
        summaryRunner,
        publishRunner,
        gapCheckRunner,
        retryFailuresRunner,
        cleanupRunner,
      });
      if (schedulerHeartbeat) {
        clearInterval(schedulerHeartbeat);
        schedulerHeartbeat = null;
      }
      updateSchedulerStatus({
        status: "idle",
        currentTasks: [],
      });
      operationsService.close();
      schedulerStatusDb.close?.();
      return {
        ok: true,
        mode: "once",
        task: args.once,
        result,
      };
    }

    if (args["run-on-start"]) {
      await refreshRunner();
      await summaryRunner();
      await publishRunner();
      await gapCheckRunner();
      await retryFailuresRunner();
      await cleanupRunner();
    }

    const scheduledTasks = [
      cron.schedule(runtimeConfig.summaryCron, summaryRunner, buildCronOptions(runtimeConfig.timezone)),
      cron.schedule(runtimeConfig.publishCron, publishRunner, buildCronOptions(runtimeConfig.timezone)),
      cron.schedule(runtimeConfig.gapCheckCron, gapCheckRunner, buildCronOptions(runtimeConfig.timezone)),
      cron.schedule(runtimeConfig.retryFailuresCron, retryFailuresRunner, buildCronOptions(runtimeConfig.timezone)),
      cron.schedule(runtimeConfig.refreshCron, refreshRunner, buildCronOptions(runtimeConfig.timezone)),
      cron.schedule(runtimeConfig.cleanupCron, cleanupRunner, buildCronOptions(runtimeConfig.timezone)),
    ];

    log(`Scheduler started with timezone=${runtimeConfig.timezone ?? "system"}`);
    log(
      `Cron plan: summary=${runtimeConfig.summaryCron}, publish=${runtimeConfig.publishCron}, gap-check=${runtimeConfig.gapCheckCron}, retry-failures=${runtimeConfig.retryFailuresCron}, refresh=${runtimeConfig.refreshCron}, cleanup=${runtimeConfig.cleanupCron}`,
    );

    attachSignalHandlers(scheduledTasks, log, () => {
      if (schedulerHeartbeat) {
        clearInterval(schedulerHeartbeat);
        schedulerHeartbeat = null;
      }
      updateSchedulerStatus({
        status: "stopped",
        currentTasks: [],
      });
      operationsService.close();
      schedulerStatusDb.close?.();
    });

    return {
      ok: true,
      mode: "daemon",
      timezone: runtimeConfig.timezone ?? "system",
      summaryUsers: runtimeConfig.summaryUsers,
      summaryConcurrency: runtimeConfig.summaryConcurrency,
      publishTask: "serial",
      retryFailuresLimit: runtimeConfig.retryFailuresLimit,
      refreshDays: runtimeConfig.refreshDays,
      cleanupDays: runtimeConfig.cleanupDays,
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
    case "publish":
      return [await runners.publishRunner()];
    case "gap-check":
      return [await runners.gapCheckRunner()];
    case "retry-failures":
      return [await runners.retryFailuresRunner()];
    case "cleanup":
      return [await runners.cleanupRunner()];
    case "all":
      return [
        await runners.refreshRunner(),
        await runners.summaryRunner(),
        await runners.publishRunner(),
        await runners.gapCheckRunner(),
        await runners.retryFailuresRunner(),
        await runners.cleanupRunner(),
      ];
    default:
      throw new Error(`Invalid --once target: ${target}`);
  }
}

function attachSignalHandlers(scheduledTasks, log, onShutdown = () => {}) {
  const shutdown = (signal) => {
    log(`Received ${signal}, stopping scheduler`);
    for (const task of scheduledTasks) {
      task.stop();
      task.destroy();
    }
    onShutdown();
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
