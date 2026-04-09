import { randomUUID } from "node:crypto";
import { insertPipelineEvent } from "./storage.mjs";

export function createPipelineEventLogger({ db, video, runId = randomUUID() }) {
  const sharedContext = {
    runId,
    videoId: video?.id ?? null,
    bvid: video?.bvid ?? null,
    videoTitle: video?.title ?? null,
  };

  function log(event = {}) {
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
