import { DEFAULT_AUTH_FILE } from "../bili/auth";
import { resolvePublishRuntimeConfig } from "../config/app-config";
import { getVideoByIdentity, listVideosPendingPublish, openDatabase } from "../db/index";
import { findAuthFileForUser } from "./auth-files";
import { runPipelineForBvid } from "./pipeline-runner";
import { withCommentPublishQueueLock } from "./publish-queue";
import { parseSummaryUsers } from "./user-targets";
import { collectRecentUploadsFromUsers } from "./uploads";
import type { FileLogger } from "../shared/logger";
import type { VideoRecord } from "../db/index";

const DEFAULT_PUBLISH_HEALTHCHECK_SINCE_HOURS = 24;
const PUBLISH_SWEEP_HARD_MAX_CONCURRENCY = 4;

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

function didPublishCreateComments(result: unknown) {
  if (!result || typeof result !== "object") {
    return false;
  }

  const publishResult = (result as { publishResult?: unknown }).publishResult;
  if (!publishResult || typeof publishResult !== "object") {
    return false;
  }

  const createdComments = (publishResult as { createdComments?: unknown }).createdComments;
  return Array.isArray(createdComments) && createdComments.length > 0;
}

export async function runPendingVideoPublishSweep({
  summaryUsers,
  authFile = DEFAULT_AUTH_FILE,
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
  logDay = null,
  logGroup = null,
  triggerSource = "scheduler",
  logger = null,
  onLog = () => {},
  listVideosPendingPublishImpl = listVideosPendingPublish,
  findAuthFileForUserImpl = findAuthFileForUser,
  parseSummaryUsersImpl = parseSummaryUsers,
  runPipelineForBvidImpl = runPipelineForBvid,
  collectRecentUploadsImpl = collectRecentUploadsFromUsers,
  getVideoByIdentityImpl = getVideoByIdentity,
  computePublishCooldownMsImpl,
  sleepImpl = delay,
}: {
  summaryUsers?: unknown;
  authFile?: string;
  dbPath?: string;
  workRoot?: string;
  logDay?: string | null;
  logGroup?: string | null;
  triggerSource?: string;
  logger?: FileLogger | null;
  onLog?: (message: string) => void;
  listVideosPendingPublishImpl?: typeof listVideosPendingPublish;
  findAuthFileForUserImpl?: typeof findAuthFileForUser;
  parseSummaryUsersImpl?: typeof parseSummaryUsers;
  runPipelineForBvidImpl?: typeof runPipelineForBvid;
  collectRecentUploadsImpl?: typeof collectRecentUploadsFromUsers;
  getVideoByIdentityImpl?: typeof getVideoByIdentity;
  computePublishCooldownMsImpl?: (publishMode: "append" | "rebuild") => number;
  sleepImpl?: (timeoutMs: number) => Promise<void>;
} = {}) {
  const publishRuntimeConfig = resolvePublishRuntimeConfig({
    db: dbPath,
  });
  const effectiveComputePublishCooldownMs = computePublishCooldownMsImpl ?? ((publishMode: "append" | "rebuild") => computePublishCooldownMs(publishMode, publishRuntimeConfig));
  const targets = parseSummaryUsersImpl(summaryUsers);
  const db = openDatabase(dbPath);
  let tasks: PendingPublishTask[] = [];

  try {
    const authFileByMid = buildAuthFileByMid(targets, authFile, findAuthFileForUserImpl);
    const fallbackAuthFile = authFileByMid.size === 1 ? [...authFileByMid.values()][0] : null;
    const videos = listVideosPendingPublishImpl(db);
    const orderedVideos = orderPendingPublishVideos(videos, publishRuntimeConfig.rebuildPriority);

    tasks = orderedVideos.flatMap((video) => {
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

    const queuedBvids = new Set(tasks.map((task) => task.video.bvid));
    if (publishRuntimeConfig.includeRecentPublishedHealthcheck) {
      const recentUploads = await collectRecentUploadsImpl({
        summaryUsers,
        authFile,
        sinceHours: publishRuntimeConfig.healthcheckSinceHours || DEFAULT_PUBLISH_HEALTHCHECK_SINCE_HOURS,
      });

      for (const upload of recentUploads.uploads) {
        if (!upload?.bvid || queuedBvids.has(upload.bvid)) {
          continue;
        }

        const video = getVideoByIdentityImpl(db, { bvid: upload.bvid, aid: upload.aid ?? null });
        if (!video || Number(video.root_comment_rpid ?? 0) <= 0 || Number(video.publish_needs_rebuild) === 1) {
          continue;
        }

        const resolvedAuthFile = String(upload.authFile ?? "").trim() || resolveAuthFileForVideo(video, authFileByMid, fallbackAuthFile);
        if (!resolvedAuthFile) {
          onLog(
            `Skip publish healthcheck for ${video.bvid} (${video.title || "untitled"}): no auth file mapped for owner ${String(video.owner_mid ?? "unknown")}`,
          );
          continue;
        }

        tasks.push({
          video,
          authFile: resolvedAuthFile,
          publishMode: "append",
        });
        queuedBvids.add(video.bvid);
      }
    }
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

  await runPendingPublishTasksWithConcurrency({
    tasks,
    workRoot,
    dbPath,
    logDay,
    logGroup,
    triggerSource,
    logger,
    onLog,
    runs,
    failures,
    runPipelineForBvidImpl,
    computePublishCooldownMsImpl: effectiveComputePublishCooldownMs,
    maxConcurrent: publishRuntimeConfig.maxConcurrent,
    stopOnFirstFailure: publishRuntimeConfig.stopOnFirstFailure,
    cooldownOnlyWhenCommentsCreated: publishRuntimeConfig.cooldownOnlyWhenCommentsCreated,
    sleepImpl,
    onAbort() {
      aborted = true;
    },
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

function computePublishCooldownMs(
  publishMode: "append" | "rebuild",
  config: {
    appendCooldownMinMs: number;
    appendCooldownMaxMs: number;
    rebuildCooldownMinMs: number;
    rebuildCooldownMaxMs: number;
  },
) {
  if (publishMode === "rebuild") {
    return randomIntBetween(config.rebuildCooldownMinMs, config.rebuildCooldownMaxMs);
  }

  return randomIntBetween(config.appendCooldownMinMs, config.appendCooldownMaxMs);
}

function randomIntBetween(minValue: number, maxValue: number) {
  const min = Math.max(0, Math.floor(minValue));
  const max = Math.max(min, Math.floor(maxValue));
  return min + Math.floor(Math.random() * (max - min + 1));
}

function orderPendingPublishVideos(
  videos: VideoRecord[],
  rebuildPriority: "append-first" | "rebuild-first",
) {
  if (rebuildPriority !== "rebuild-first") {
    return videos;
  }

  return [...videos].sort((left, right) => {
    const leftPriority = Number(left.publish_needs_rebuild) === 1 ? 0 : 1;
    const rightPriority = Number(right.publish_needs_rebuild) === 1 ? 0 : 1;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    return 0;
  });
}

function delay(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}

async function runPendingPublishTasksWithConcurrency({
  tasks,
  workRoot,
  dbPath,
  logDay,
  logGroup,
  triggerSource,
  logger,
  onLog,
  runs,
  failures,
  runPipelineForBvidImpl,
  computePublishCooldownMsImpl,
  maxConcurrent,
  stopOnFirstFailure,
  cooldownOnlyWhenCommentsCreated,
  sleepImpl,
  onAbort,
}: {
  tasks: PendingPublishTask[];
  workRoot: string;
  dbPath: string;
  logDay: string | null;
  logGroup: string | null;
  triggerSource: string;
  logger: FileLogger | null;
  onLog: (message: string) => void;
  runs: Array<Record<string, unknown>>;
  failures: PendingPublishFailure[];
  runPipelineForBvidImpl: typeof runPipelineForBvid;
  computePublishCooldownMsImpl: (publishMode: "append" | "rebuild") => number;
  maxConcurrent: number;
  stopOnFirstFailure: boolean;
  cooldownOnlyWhenCommentsCreated: boolean;
  sleepImpl: (timeoutMs: number) => Promise<void>;
  onAbort: () => void;
}) {
  const safeMaxConcurrent = Math.min(PUBLISH_SWEEP_HARD_MAX_CONCURRENCY, Math.max(1, Number(maxConcurrent) || 1), tasks.length);
  let nextTaskIndex = 0;
  let stopScheduling = false;

  onLog(`Publishing ${tasks.length} queued video(s) with up to ${safeMaxConcurrent} concurrent task(s)`);

  const worker = async () => {
    while (true) {
      if (stopScheduling) {
        return;
      }

      const index = nextTaskIndex;
      if (index >= tasks.length) {
        return;
      }
      nextTaskIndex += 1;

      const task = tasks[index];
      const scopedLogger = logger?.child({
        task: "publish",
        bvid: task.video.bvid,
        publishMode: task.publishMode,
      }) ?? null;

      onLog(
        `Publishing ${task.video.bvid} (${task.video.title || "untitled"}) [${task.publishMode}] ${index + 1}/${tasks.length}`,
      );

      try {
        const result = await withCommentPublishQueueLock({
          workRoot,
          queueName: "Bilibili comment publish",
          onLog,
          ownerDetails: {
            task: "publish",
            dbPath,
            bvid: task.video.bvid,
            publishMode: task.publishMode,
          },
        }, async () => runPipelineForBvidImpl({
          authFile: task.authFile,
          cookieFile: null,
          dbPath,
          workRoot,
          bvid: task.video.bvid,
          logDay,
          logGroup,
          triggerSource,
          publish: true,
          logger: scopedLogger,
        }));

        runs.push({
          bvid: task.video.bvid,
          title: task.video.title,
          publishMode: task.publishMode,
          result,
        });

        if ((!cooldownOnlyWhenCommentsCreated || didPublishCreateComments(result)) && !stopScheduling) {
          const cooldownMs = computePublishCooldownMsImpl(task.publishMode);
          onLog(`Cooling down ${Math.round(cooldownMs / 1000)}s before the next publish task for ${task.video.bvid}`);
          await sleepImpl(cooldownMs);
        }
      } catch (error) {
        failures.push({
          bvid: task.video.bvid,
          title: task.video.title,
          message: error instanceof Error ? error.message : "Unknown error",
          publishMode: task.publishMode,
        });
        if (stopOnFirstFailure) {
          stopScheduling = true;
          onAbort();
          onLog(`Publish failed for ${task.video.bvid}; stopping the remaining queue to avoid repeated write pressure`);
        } else {
          onLog(`Publish failed for ${task.video.bvid}; continuing with the remaining queue`);
        }
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: safeMaxConcurrent }, () => worker()));
}
