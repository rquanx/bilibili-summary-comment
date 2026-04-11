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
import { cleanupOldWorkDirectories, syncSummaryUsersRecentVideos } from "../lib/scheduler/index";
import { createLogGroupName, createWorkFileLogger, formatLogDay } from "../lib/shared/logger";
import type { LogLevel } from "../lib/shared/logger";

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
      .option("--refresh-days <days>", "Optional. Refresh auth when older than this many days.", parsePositiveIntegerArg)
      .option("--cleanup-days <days>", "Optional. Remove work dirs older than this many days.", parsePositiveIntegerArg)
      .option("--timezone <timezone>", "Optional. Cron timezone.")
      .option("--run-on-start", "Optional. Run due tasks once before entering the scheduler loop.")
      .option("--once <task>", "Optional. Run one task and exit: refresh | summary | cleanup | all."),
  ),
);

await runCli({
  command,
  printResult: false,
  async handler(args) {
    const config = resolveSchedulerConfig(args);
    config.authFile = resolveBiliAuthFile(config.authFile);
    const resolvedCookieFile = resolveBiliCookieFile(config.cookieFile);
    const runningTasks = new Set<string>();
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
      process.stderr.write(`[scheduler ${new Date().toISOString()}] ${message}\n`);
    }

    log(`Detailed log: ${schedulerLogger.filePath}`);

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
        cookieFile: resolvedCookieFile,
        sinceHours: config.summarySinceHours,
        maxConcurrent: config.summaryConcurrency,
        dbPath: config.dbPath,
        workRoot: config.workRoot,
        logDay,
        logGroup,
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

    async function runCleanupTask() {
      if (runningTasks.has("summary")) {
        log("Skip work cleanup: summary task is still running");
        return {
          action: "skip-cleanup",
          reason: "summary-running",
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
    const cleanupRunner = runExclusive("cleanup", runCleanupTask);

    if (args.once) {
      const result = await runOnce(args.once, {
        refreshRunner,
        summaryRunner,
        cleanupRunner,
      });
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
      await cleanupRunner();
    }

    const scheduledTasks = [
      cron.schedule("0 * * * *", summaryRunner, buildCronOptions(config.timezone)),
      cron.schedule("15 3 * * *", refreshRunner, buildCronOptions(config.timezone)),
      cron.schedule("45 3 * * *", cleanupRunner, buildCronOptions(config.timezone)),
    ];

    log(`Scheduler started with timezone=${config.timezone ?? "system"}`);
    log("Cron plan: summary=hourly@minute0, refresh=daily@03:15 when due, cleanup=daily@03:45");

    attachSignalHandlers(scheduledTasks, log);

    return {
      ok: true,
      mode: "daemon",
      timezone: config.timezone ?? "system",
      summaryUsers: config.summaryUsers,
      summaryConcurrency: config.summaryConcurrency,
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
    case "cleanup":
      return [await runners.cleanupRunner()];
    case "all":
      return [
        await runners.refreshRunner(),
        await runners.summaryRunner(),
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
