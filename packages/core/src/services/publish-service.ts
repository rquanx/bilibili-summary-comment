import { runPendingVideoPublishSweep } from "../../../../scripts/lib/scheduler/publish";
import { resolveSchedulerConfig } from "../../../../scripts/lib/config/app-config";

export function createPublishService({
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
}: {
  dbPath?: string;
  workRoot?: string;
} = {}) {
  return {
    close() {},
    runPendingSweep({
      summaryUsers,
      authFile,
      logDay = null,
      logGroup = null,
      triggerSource = "web",
      logger = null,
      onLog,
    }: {
      summaryUsers?: unknown;
      authFile?: string;
      logDay?: string | null;
      logGroup?: string | null;
      triggerSource?: string;
      logger?: any;
      onLog?: (message: string) => void;
    } = {}) {
      const config = resolveSchedulerConfig({
        db: dbPath,
        "work-root": workRoot,
      });
      return runPendingVideoPublishSweep({
        summaryUsers,
        authFile: authFile ?? config.authFile,
        dbPath,
        workRoot,
        logDay,
        logGroup,
        triggerSource,
        logger,
        onLog,
      });
    },
  };
}
