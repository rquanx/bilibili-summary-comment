import { syncSummaryUsersRecentVideos } from "../../../../scripts/lib/scheduler/uploads";
import { cleanupOldWorkDirectories } from "../../../../scripts/lib/scheduler/cleanup";
import { runRecentVideoGapCheck } from "../../../../scripts/lib/scheduler/gap-check";
import { resolveSchedulerConfig, resolveSummaryUsersConfig } from "../../../../scripts/lib/config/app-config";
import { getSchedulerStatus, openDatabase } from "../../../../scripts/lib/db/index";

export function createSchedulerControlService({
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
  runtime = {},
}: {
  dbPath?: string;
  workRoot?: string;
  runtime?: {
    signalProcess?: (pid: number, signal: NodeJS.Signals | number) => void;
  };
} = {}) {
  const db = openDatabase(dbPath);
  const signalProcess = runtime.signalProcess ?? ((pid: number, signal: NodeJS.Signals | number) => {
    process.kill(pid, signal);
  });

  return {
    close() {
      db.close?.();
    },
    runSummarySweep(options: Record<string, unknown> = {}) {
      const runtimeOptions = options as {
        summaryUsers?: unknown;
        authFile?: string;
        cookieFile?: string | null;
        sinceHours?: number;
        maxConcurrent?: number;
        triggerSource?: unknown;
      };
      const config = resolveSummaryUsersConfig({
        db: dbPath,
        "work-root": workRoot,
        ...options,
      });
      return syncSummaryUsersRecentVideos({
        ...config,
        ...options,
        summaryUsers: runtimeOptions.summaryUsers ?? config.summaryUsers,
        authFile: runtimeOptions.authFile ?? config.authFile,
        cookieFile: runtimeOptions.cookieFile ?? config.cookieFile ?? undefined,
        sinceHours: runtimeOptions.sinceHours ?? config.sinceHours,
        maxConcurrent: runtimeOptions.maxConcurrent ?? config.summaryConcurrency,
        triggerSource: String(runtimeOptions.triggerSource ?? "web").trim() || "web",
        dbPath,
        workRoot,
      });
    },
    runGapCheck(options: Record<string, unknown> = {}) {
      const runtimeOptions = options as {
        summaryUsers?: unknown;
        authFile?: string;
        cookieFile?: string | null;
        sinceHours?: number;
        gapThresholdSeconds?: number;
        timezone?: string | null;
      };
      const config = resolveSchedulerConfig({
        db: dbPath,
        "work-root": workRoot,
        ...options,
      });
      return runRecentVideoGapCheck({
        ...config,
        ...options,
        summaryUsers: runtimeOptions.summaryUsers ?? config.summaryUsers,
        authFile: runtimeOptions.authFile ?? config.authFile,
        cookieFile: runtimeOptions.cookieFile ?? config.cookieFile ?? undefined,
        sinceHours: runtimeOptions.sinceHours ?? config.gapCheckSinceHours,
        gapThresholdSeconds: runtimeOptions.gapThresholdSeconds ?? config.gapThresholdSeconds,
        timezone: runtimeOptions.timezone ?? config.timezone,
        dbPath,
        workRoot,
      });
    },
    cleanupOldWork(options: Record<string, unknown> = {}) {
      return cleanupOldWorkDirectories({
        ...options,
        dbPath,
        workRoot,
      });
    },
    requestRestart({
      schedulerKey = "main",
      signal = "SIGTERM",
    }: {
      schedulerKey?: string;
      signal?: NodeJS.Signals | number;
    } = {}) {
      const normalizedSchedulerKey = normalizeText(schedulerKey) ?? "main";
      const status = getSchedulerStatus(db, normalizedSchedulerKey);
      if (!status) {
        throw new Error(`Scheduler status not found: ${normalizedSchedulerKey}`);
      }

      if (normalizeText(status.mode) !== "daemon") {
        throw new Error(`Scheduler is not running in daemon mode: ${normalizedSchedulerKey}`);
      }

      if (normalizeText(status.status) !== "running") {
        throw new Error(`Scheduler is not running: ${normalizedSchedulerKey}`);
      }

      const ownerPid = normalizePositiveInteger(status.pid);
      if (!ownerPid) {
        throw new Error(`Scheduler process id is unavailable for ${normalizedSchedulerKey}`);
      }

      ensureProcessAvailable(signalProcess, ownerPid, normalizedSchedulerKey);

      try {
        signalProcess(ownerPid, signal);
      } catch (error) {
        if (isMissingProcessError(error)) {
          throw new Error(`Scheduler process is not running: ${normalizedSchedulerKey} (pid ${ownerPid})`);
        }

        throw error;
      }

      return {
        ok: true,
        schedulerKey: normalizedSchedulerKey,
        status: status.status,
        mode: status.mode,
        ownerPid,
        hostname: status.hostname ?? null,
        signal: typeof signal === "number" ? signal : String(signal),
        signalSent: true,
        restartExpected: true,
        requiresSupervisor: true,
      };
    },
  };
}

function ensureProcessAvailable(
  signalProcess: (pid: number, signal: NodeJS.Signals | number) => void,
  pid: number,
  schedulerKey: string,
) {
  try {
    signalProcess(pid, 0);
  } catch (error) {
    if (isMissingProcessError(error)) {
      throw new Error(`Scheduler process is not running: ${schedulerKey} (pid ${pid})`);
    }

    throw error;
  }
}

function normalizeText(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function normalizePositiveInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function isMissingProcessError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ESRCH");
}
