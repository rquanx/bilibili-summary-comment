import cron from "node-cron";
import { fail, parseArgs, printJson, showUsage } from "./lib/bili-comment-utils.mjs";
import {
  getLastAuthUpdateAt,
  loadBiliAuthBundle,
  refreshBiliCookie,
  resolveBiliAuthFile,
  resolveBiliCookieFile,
} from "./lib/bili-auth.mjs";
import { loadDotEnvIfPresent } from "./lib/runtime-tools.mjs";
import { cleanupOldWorkDirectories, syncSummaryUsersRecentVideos } from "./lib/scheduler-tasks.mjs";

loadDotEnvIfPresent();

function usage() {
  showUsage([
    "Usage:",
    "  node scripts/run-scheduler.mjs [--run-on-start]",
    "  node scripts/run-scheduler.mjs --once summary",
    "",
    "Options:",
    "  --cookie-file             Optional. Cookie file path. Default: cookie.txt or BILI_COOKIE_FILE",
    "  --auth-file               Optional. TV auth file path. Default: work/bili-auth.json or BILI_AUTH_FILE",
    "  --summary-users           Optional. Comma-separated Bilibili space URLs or user ids. Default: SUMMARY_USERS",
    "  --summary-since-hours     Optional. Recent upload window. Default: 24",
    "  --refresh-days            Optional. Refresh auth when older than this many days. Default: 30",
    "  --cleanup-days            Optional. Remove work dirs older than this many days. Default: 2",
    "  --db                      Optional. SQLite path. Default: work/pipeline.sqlite3",
    "  --work-root               Optional. Work root. Default: work",
    "  --timezone                Optional. Cron timezone. Default: system timezone",
    "  --run-on-start            Optional. Run due tasks once before entering the scheduler loop.",
    "  --once                    Optional. Run one task and exit: refresh | summary | cleanup | all",
    "  --help                    Show this help.",
  ]);
}

async function main() {
  const args = parseArgs();
  if (args.help) {
    usage();
    return;
  }

  const config = {
    cookieFile: args["cookie-file"] ?? process.env.BILI_COOKIE_FILE ?? "cookie.txt",
    authFile: resolveBiliAuthFile(args["auth-file"]),
    summaryUsers: args["summary-users"] ?? process.env.SUMMARY_USERS ?? "",
    summarySinceHours: Number(args["summary-since-hours"] ?? process.env.SUMMARY_SINCE_HOURS ?? 24),
    refreshDays: Number(args["refresh-days"] ?? process.env.BILI_REFRESH_DAYS ?? 30),
    cleanupDays: Number(args["cleanup-days"] ?? process.env.WORK_CLEANUP_DAYS ?? 2),
    dbPath: args.db ?? process.env.PIPELINE_DB_PATH ?? "work/pipeline.sqlite3",
    workRoot: args["work-root"] ?? process.env.WORK_ROOT ?? "work",
    timezone: args.timezone ?? process.env.CRON_TIMEZONE ?? undefined,
  };
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
    printJson({
      ok: true,
      mode: "once",
      task: args.once,
      result,
    });
    return;
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

  printJson({
    ok: true,
    mode: "daemon",
    timezone: config.timezone ?? "system",
    summaryUsers: config.summaryUsers,
    refreshDays: config.refreshDays,
    cleanupDays: config.cleanupDays,
  });
}

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

main().catch((error) => {
  fail(error?.message ?? "Unknown error", {
    stack: error?.stack,
  });
});
