import cron from "node-cron";
import { resolveSchedulerConfig } from "../lib/config/app-config.js";
import {
  addDatabaseOption,
  addWorkRootOption,
  createCliCommand,
  parsePositiveIntegerArg,
  runCli,
} from "../lib/cli/tools.js";
import {
  getLastAuthUpdateAt,
  loadBiliAuthBundle,
  refreshBiliCookie,
  resolveBiliAuthFile,
  resolveBiliCookieFile,
} from "../lib/bili/auth.js";
import { cleanupOldWorkDirectories, syncSummaryUsersRecentVideos } from "../lib/scheduler/index.js";

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
      .option("--refresh-days <days>", "Optional. Refresh auth when older than this many days.", parsePositiveIntegerArg)
      .option("--cleanup-days <days>", "Optional. Remove work dirs older than this many days.", parsePositiveIntegerArg)
      .option("--timezone <timezone>", "Optional. Cron timezone.")
      .option("--run-on-start", "Optional. Run due tasks once before entering the scheduler loop.")
      .option("--once <task>", "Optional. Run one task and exit: refresh | summary | cleanup | all."),
  ),
);

await runCli({
  command,
  async handler(args) {
    const config = resolveSchedulerConfig(args);
    config.authFile = resolveBiliAuthFile(config.authFile);
    const resolvedCookieFile = resolveBiliCookieFile(config.cookieFile);
    const runningTasks = new Set();

    function log(message) {
      process.stderr.write(`[scheduler ${new Date().toISOString()}] ${message}\n`);
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
      log("Scanning SUMMARY_USERS recent uploads");
      const result = await syncSummaryUsersRecentVideos({
        summaryUsers: config.summaryUsers,
        cookieFile: resolvedCookieFile,
        sinceHours: config.summarySinceHours,
        dbPath: config.dbPath,
        workRoot: config.workRoot,
        onLog(message) {
          log(`[summary] ${message}`);
        },
      });
      log(`Summary sweep finished: uploads=${result.uploads.length}, failures=${result.failures.length}`);
      return {
        action: "summary",
        uploads: result.uploads.length,
        runs: result.runs.length,
        failures: result.failures.length,
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
        log(`${name} failed: ${error?.message ?? "Unknown error"}`);
        return {
          action: `${name}-failed`,
          message: error?.message ?? "Unknown error",
        };
      } finally {
        runningTasks.delete(name);
      }
    };

    const refreshRunner = runExclusive("refresh", runRefreshTask);
    const summaryRunner = runExclusive("summary", runSummaryTask);
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
