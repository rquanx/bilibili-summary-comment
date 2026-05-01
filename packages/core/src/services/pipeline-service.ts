import { runPipelineForBvid } from "../../../../scripts/lib/scheduler/pipeline-runner";
import { runVideoPipeline } from "../../../../scripts/lib/video/pipeline-runner";
import { resolveSchedulerConfig } from "../../../../scripts/lib/config/app-config";
import type { PipelineEventLogger } from "../../../../scripts/lib/db/index";

export function createPipelineService({
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
}: {
  dbPath?: string;
  workRoot?: string;
} = {}) {
  return {
    close() {},
    runPipeline({
      bvid,
      authFile = null,
      cookieFile = null,
      publish = true,
      forceSummary = false,
      logDay = null,
      logGroup = null,
      triggerSource = "web",
    }: {
      bvid: string;
      authFile?: string | null;
      cookieFile?: string | null;
      publish?: boolean;
      forceSummary?: boolean;
      logDay?: string | null;
      logGroup?: string | null;
      triggerSource?: string | null;
    }) {
      const config = resolveSchedulerConfig({
        db: dbPath,
        "work-root": workRoot,
      });
      return runPipelineForBvid({
        authFile: authFile ?? config.authFile,
        cookieFile: cookieFile ?? config.cookieFile ?? null,
        dbPath,
        workRoot,
        bvid,
        publish,
        forceSummary,
        logDay,
        logGroup,
        triggerSource,
      });
    },
    runPipelineDirect(
      args: Record<string, unknown>,
      {
        onEventLogger,
      }: {
        onEventLogger?: (eventLogger: PipelineEventLogger) => void;
      } = {},
    ) {
      return runVideoPipeline({
        ...args,
        db: typeof args.db === "string" && args.db.trim() ? args.db : dbPath,
        "work-root": typeof args["work-root"] === "string" && String(args["work-root"]).trim() ? String(args["work-root"]) : workRoot,
      }, {
        onEventLogger,
      });
    },
  };
}
