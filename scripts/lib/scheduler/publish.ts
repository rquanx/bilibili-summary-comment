import { DEFAULT_AUTH_FILE } from "../bili/auth";
import { listVideosPendingPublish, openDatabase } from "../db/index";
import { findAuthFileForUser } from "./auth-files";
import { runPipelineForBvid } from "./pipeline-runner";
import { withCommentPublishQueueLock } from "./publish-queue";
import { parseSummaryUsers } from "./user-targets";
import type { FileLogger } from "../shared/logger";
import type { VideoRecord } from "../db/index";

const PUBLISH_APPEND_COOLDOWN_MIN_MS = 60_000;
const PUBLISH_APPEND_COOLDOWN_MAX_MS = 180_000;
const PUBLISH_REBUILD_COOLDOWN_MIN_MS = 180_000;
const PUBLISH_REBUILD_COOLDOWN_MAX_MS = 600_000;

export interface PendingPublishTask {
  video: VideoRecord;
  authFile: string;
  publishMode: "append" | "rebuild";
}

export interface PendingPublishFailure {
  bvid: string;
  title: string;
  message: string;
  publishMode: "append" | "rebuild";
}

export async function runPendingVideoPublishSweep({
  summaryUsers,
  authFile = DEFAULT_AUTH_FILE,
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
  logDay = null,
  logGroup = null,
  logger = null,
  onLog = () => {},
  listVideosPendingPublishImpl = listVideosPendingPublish,
  findAuthFileForUserImpl = findAuthFileForUser,
  parseSummaryUsersImpl = parseSummaryUsers,
  runPipelineForBvidImpl = runPipelineForBvid,
  computePublishCooldownMsImpl = computePublishCooldownMs,
  sleepImpl = delay,
}: {
  summaryUsers?: unknown;
  authFile?: string;
  dbPath?: string;
  workRoot?: string;
  logDay?: string | null;
  logGroup?: string | null;
  logger?: FileLogger | null;
  onLog?: (message: string) => void;
  listVideosPendingPublishImpl?: typeof listVideosPendingPublish;
  findAuthFileForUserImpl?: typeof findAuthFileForUser;
  parseSummaryUsersImpl?: typeof parseSummaryUsers;
  runPipelineForBvidImpl?: typeof runPipelineForBvid;
  computePublishCooldownMsImpl?: (publishMode: "append" | "rebuild") => number;
  sleepImpl?: (timeoutMs: number) => Promise<void>;
} = {}) {
  const targets = parseSummaryUsersImpl(summaryUsers);
  const db = openDatabase(dbPath);
  let tasks: PendingPublishTask[] = [];

  try {
    const authFileByMid = buildAuthFileByMid(targets, authFile, findAuthFileForUserImpl);
    const fallbackAuthFile = authFileByMid.size === 1 ? [...authFileByMid.values()][0] : null;
    const videos = listVideosPendingPublishImpl(db);

    tasks = videos.flatMap((video) => {
      const resolvedAuthFile = resolveAuthFileForVideo(video, authFileByMid, fallbackAuthFile);
      if (!resolvedAuthFile) {
        onLog(
          `Skip publish for ${video.bvid} (${video.title || "untitled"}): no auth file mapped for owner ${String(video.owner_mid ?? "unknown")}`,
        );
        return [];
      }

      return [{
        video,
        authFile: resolvedAuthFile,
        publishMode: Number(video.publish_needs_rebuild) === 1 ? "rebuild" : "append",
      }];
    });
  } finally {
    db.close?.();
  }

  if (tasks.length === 0) {
    onLog("No videos are waiting for publish");
    return {
      tasks: [],
      runs: [],
      failures: [],
      aborted: false,
    };
  }

  const runs: Array<Record<string, unknown>> = [];
  const failures: PendingPublishFailure[] = [];
  let aborted = false;

  await withCommentPublishQueueLock({
    workRoot,
    queueName: "Bilibili comment publish",
    onLog,
    ownerDetails: {
      task: "publish-sweep",
      dbPath,
    },
  }, async () => {
    onLog(`Publishing ${tasks.length} queued video(s) serially`);

    for (const [index, task] of tasks.entries()) {
      const scopedLogger = logger?.child({
        task: "publish",
        bvid: task.video.bvid,
        publishMode: task.publishMode,
      }) ?? null;

      onLog(
        `Publishing ${task.video.bvid} (${task.video.title || "untitled"}) [${task.publishMode}] ${index + 1}/${tasks.length}`,
      );

      try {
        const result = await runPipelineForBvidImpl({
          authFile: task.authFile,
          cookieFile: null,
          dbPath,
          workRoot,
          bvid: task.video.bvid,
          logDay,
          logGroup,
          publish: true,
          logger: scopedLogger,
        });

        runs.push({
          bvid: task.video.bvid,
          title: task.video.title,
          publishMode: task.publishMode,
          result,
        });

        if (index < tasks.length - 1) {
          const cooldownMs = computePublishCooldownMsImpl(task.publishMode);
          onLog(`Cooling down ${Math.round(cooldownMs / 1000)}s before the next publish task`);
          await sleepImpl(cooldownMs);
        }
      } catch (error) {
        failures.push({
          bvid: task.video.bvid,
          title: task.video.title,
          message: error instanceof Error ? error.message : "Unknown error",
          publishMode: task.publishMode,
        });
        aborted = true;
        onLog(`Publish failed for ${task.video.bvid}; stopping the remaining queue to avoid repeated write pressure`);
        break;
      }
    }
  });

  return {
    tasks,
    runs,
    failures,
    aborted,
  };
}

function buildAuthFileByMid(
  targets: Array<{ mid: number; source: string }>,
  authFile: string,
  findAuthFileForUserImpl: typeof findAuthFileForUser,
) {
  const authFileByMid = new Map<number, string>();

  for (const [index, target] of targets.entries()) {
    const resolvedAuthFile = findAuthFileForUserImpl(authFile, index + 1);
    if (resolvedAuthFile) {
      authFileByMid.set(target.mid, resolvedAuthFile);
    }
  }

  return authFileByMid;
}

function resolveAuthFileForVideo(
  video: Pick<VideoRecord, "owner_mid">,
  authFileByMid: Map<number, string>,
  fallbackAuthFile: string | null,
) {
  const ownerMid = Number(video.owner_mid ?? 0);
  if (Number.isInteger(ownerMid) && ownerMid > 0 && authFileByMid.has(ownerMid)) {
    return authFileByMid.get(ownerMid) ?? null;
  }

  return fallbackAuthFile;
}

function computePublishCooldownMs(publishMode: "append" | "rebuild") {
  if (publishMode === "rebuild") {
    return randomIntBetween(PUBLISH_REBUILD_COOLDOWN_MIN_MS, PUBLISH_REBUILD_COOLDOWN_MAX_MS);
  }

  return randomIntBetween(PUBLISH_APPEND_COOLDOWN_MIN_MS, PUBLISH_APPEND_COOLDOWN_MAX_MS);
}

function randomIntBetween(minValue: number, maxValue: number) {
  const min = Math.max(0, Math.floor(minValue));
  const max = Math.max(min, Math.floor(maxValue));
  return min + Math.floor(Math.random() * (max - min + 1));
}

function delay(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
