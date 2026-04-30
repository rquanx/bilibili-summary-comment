import { runPendingVideoPublishSweep } from "../../../../scripts/lib/scheduler/publish";

export function createPublishService({
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
}: {
  dbPath?: string;
  workRoot?: string;
} = {}) {
  return {
    runPendingSweep({
      summaryUsers,
      authFile,
      logDay = null,
      logGroup = null,
      logger = null,
      onLog,
    }: {
      summaryUsers?: unknown;
      authFile?: string;
      logDay?: string | null;
      logGroup?: string | null;
      logger?: any;
      onLog?: (message: string) => void;
    } = {}) {
      return runPendingVideoPublishSweep({
        summaryUsers,
        authFile,
        dbPath,
        workRoot,
        logDay,
        logGroup,
        logger,
        onLog,
      });
    },
  };
}
