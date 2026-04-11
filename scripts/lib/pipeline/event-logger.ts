import { randomUUID } from "node:crypto";
import { insertPipelineEvent } from "../db/index";
import { formatBiliVideoUrlSuffix } from "../bili/video-url";
import type { Db, PipelineEventInput, PipelineEventLogger, VideoRecord } from "../db/index";

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
    const payload = {
      ...sharedContext,
      ...event,
    };

    try {
      return insertPipelineEvent(db, payload);
    } catch (error) {
      if (isSqliteLockedError(error)) {
        const action = `${String(payload.scope ?? "pipeline")}/${String(payload.action ?? "event")}`;
        const message = String(payload.message ?? "").trim();
        const suffix = message ? `: ${message}` : "";
        const videoSuffix = formatBiliVideoUrlSuffix({ bvid: sharedContext.bvid });
        console.warn(`Skipping pipeline event log because the database is locked (${action}${suffix})${videoSuffix}`);
        return null;
      }

      throw error;
    }
  }

  return {
    runId,
    log,
  };
}

function isSqliteLockedError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as { code?: unknown; errcode?: unknown; errstr?: unknown; message?: unknown };
  const message = String(candidate.message ?? candidate.errstr ?? "").toLowerCase();
  return candidate.code === "ERR_SQLITE_ERROR" && (candidate.errcode === 5 || message.includes("database is locked"));
}
