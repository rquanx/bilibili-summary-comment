import { randomUUID } from "node:crypto";
import { insertPipelineEvent } from "../db/index.js";
import type { Db, PipelineEventInput, PipelineEventLogger, VideoRecord } from "../db/index.js";

export function createPipelineEventLogger({
  db,
  video,
  runId = randomUUID(),
}: {
  db: Db;
  video: VideoRecord | null | undefined;
  runId?: string;
}): PipelineEventLogger {
  const sharedContext = {
    runId,
    videoId: video?.id ?? null,
    bvid: video?.bvid ?? null,
    videoTitle: video?.title ?? null,
  };

  function log(event: PipelineEventInput) {
    return insertPipelineEvent(db, {
      ...sharedContext,
      ...event,
    });
  }

  return {
    runId,
    log,
  };
}
