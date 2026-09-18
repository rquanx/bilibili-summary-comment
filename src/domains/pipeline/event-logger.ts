import { randomUUID } from "node:crypto";
import { insertPipelineEvent, isPostgresDatabase } from "../../infra/db/index";
import { formatBiliVideoUrlSuffix } from "../bili/video-url";
import { writeTerminalMessage } from "./progress";
import type { Db, PipelineEventInput, PipelineEventLogger, VideoRecord } from "../../infra/db/index";
import type { FileLogger } from "../../shared/logger";

export function createPipelineEventLogger({
  db,
  video,
  runId = randomUUID(),
  logger = null,
}: {
  db: Db;
  video: VideoRecord | null | undefined;
  runId?: string;
  logger?: FileLogger | null;
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
    logger?.debug("pipeline-event", payload);

    try {
      const result = insertPipelineEvent(db, payload);
      if (isPostgresDatabase(db)) {
        return db.track(Promise.resolve(result).catch((error) => {
          reportEventLogFailure(error, payload);
          return null;
        }));
      }
      return result;
    } catch (error) {
      return reportEventLogFailure(error, payload);
    }
  }

  function reportEventLogFailure(error: unknown, payload: PipelineEventInput) {
    if (isSqliteLockedError(error)) {
      const action = `${String(payload.scope ?? "pipeline")}/${String(payload.action ?? "event")}`;
      const message = String(payload.message ?? "").trim();
      const suffix = message ? `: ${message}` : "";
      const videoSuffix = formatBiliVideoUrlSuffix({ bvid: sharedContext.bvid });
      logger?.warn("Skipping pipeline event log because the database is locked", {
        ...payload,
        actionLabel: action,
        error,
      });
      writeTerminalMessage(
        process.stderr,
        "warn",
        `Skipping pipeline event log because the database is locked (${action}${suffix})${videoSuffix}`,
      );
      return null;
    }

    logger?.error("Failed to persist pipeline event", {
      ...payload,
      error,
    });
    writeTerminalMessage(
      process.stderr,
      "warn",
      `Failed to persist pipeline event: ${error instanceof Error ? error.message : "unknown database error"}`,
    );
    return null;
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
