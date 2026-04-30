import { syncSummaryUsersRecentVideos } from "../../../../scripts/lib/scheduler/uploads";
import { cleanupOldWorkDirectories } from "../../../../scripts/lib/scheduler/cleanup";
import { runRecentVideoGapCheck } from "../../../../scripts/lib/scheduler/gap-check";

export function createSchedulerControlService({
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
}: {
  dbPath?: string;
  workRoot?: string;
} = {}) {
  return {
    runSummarySweep(options: Record<string, unknown> = {}) {
      return syncSummaryUsersRecentVideos({
        ...options,
        triggerSource: String(options.triggerSource ?? "web").trim() || "web",
        dbPath,
        workRoot,
      });
    },
    runGapCheck(options: Record<string, unknown> = {}) {
      return runRecentVideoGapCheck({
        ...options,
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
  };
}
