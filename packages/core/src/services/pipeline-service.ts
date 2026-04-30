import { runPipelineForBvid } from "../../../../scripts/lib/scheduler/pipeline-runner";

export function createPipelineService({
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
}: {
  dbPath?: string;
  workRoot?: string;
} = {}) {
  return {
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
      return runPipelineForBvid({
        authFile,
        cookieFile,
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
  };
}
