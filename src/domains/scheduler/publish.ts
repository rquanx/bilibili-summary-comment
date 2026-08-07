import { createHash } from "node:crypto";
import { DEFAULT_AUTH_FILE } from "../bili/auth";
import {
  getPreferredSummaryText,
  getVideoByIdentity,
  insertPipelineEvent,
  listPendingPublishParts,
  listPipelineEvents,
  listVideosPendingPublish,
  openDatabase,
} from "../../infra/db/index";
import { findAuthFileForUser } from "./auth-files";
import { runPipelineForBvid } from "./pipeline-runner";
import { withCommentPublishQueueLock } from "./publish-queue";
import { parseSummaryUsers } from "./user-targets";
import { collectRecentUploadsFromUsers } from "./uploads";
import type { FileLogger } from "../../shared/logger";
import type { VideoRecord } from "../../infra/db/index";

const PUBLISH_APPEND_COOLDOWN_MIN_MS = 15_000;
const PUBLISH_APPEND_COOLDOWN_MAX_MS = 30_000;
const PUBLISH_REBUILD_COOLDOWN_MIN_MS = 15_000;
const PUBLISH_REBUILD_COOLDOWN_MAX_MS = 30_000;
const DEFAULT_PUBLISH_HEALTHCHECK_SINCE_HOURS = 24;
const PUBLISH_SWEEP_MAX_CONCURRENCY = 2;
const TERMINAL_PUBLISH_FAILURE_COOLDOWN_MS = 6 * 60 * 60_000;
const terminalPublishFailureCooldowns = new Map<string, {
  queueRevision: string;
  retryAfterMs: number;
}>();

export interface PendingPublishTask {
  video: VideoRecord;
  authFile: string;
  publishMode: "append" | "rebuild";
  uploadedAtUnix: number | null;
  queueRevision: string;
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
  logger = null,
  onLog = () => {},
  listVideosPendingPublishImpl = listVideosPendingPublish,
  findAuthFileForUserImpl = findAuthFileForUser,
  parseSummaryUsersImpl = parseSummaryUsers,
  runPipelineForBvidImpl = runPipelineForBvid,
  withCommentPublishQueueLockImpl = withCommentPublishQueueLock,
  collectRecentUploadsImpl = collectRecentUploadsFromUsers,
  getVideoByIdentityImpl = getVideoByIdentity,
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
  withCommentPublishQueueLockImpl?: typeof withCommentPublishQueueLock;
  collectRecentUploadsImpl?: typeof collectRecentUploadsFromUsers;
  getVideoByIdentityImpl?: typeof getVideoByIdentity;
  computePublishCooldownMsImpl?: (publishMode: "append" | "rebuild") => number;
  sleepImpl?: (timeoutMs: number) => Promise<void>;
} = {}) {
  const targets = parseSummaryUsersImpl(summaryUsers);
  const authFileByMid = buildAuthFileByMid(targets, authFile, findAuthFileForUserImpl);
  const fallbackAuthFile = authFileByMid.size === 1 ? [...authFileByMid.values()][0] : null;
  const db = openDatabase(dbPath);
  let tasks: PendingPublishTask[] = [];

  try {
    const videos = listVideosPendingPublishImpl(db);

    tasks = buildPendingPublishTasks({
      db,
      videos,
      authFileByMid,
      fallbackAuthFile,
      onLog,
    });

    const taskByBvid = new Map(tasks.map((task) => [task.video.bvid, task]));
    const recentUploads = await collectRecentUploadsImpl({
      summaryUsers,
      authFile,
      sinceHours: DEFAULT_PUBLISH_HEALTHCHECK_SINCE_HOURS,
    });

    for (const upload of recentUploads.uploads) {
      if (!upload?.bvid) {
        continue;
      }

      const queuedTask = taskByBvid.get(upload.bvid);
      if (queuedTask) {
        queuedTask.uploadedAtUnix = upload.createdAtUnix;
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
        uploadedAtUnix: upload.createdAtUnix,
        queueRevision: `healthcheck:${upload.createdAtUnix}:${video.updated_at}`,
      });
      taskByBvid.set(video.bvid, tasks[tasks.length - 1]);
    }
  } finally {
    db.close?.();
  }

  tasks.sort(comparePendingPublishTasks);

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
    logger,
    onLog,
    runs,
    failures,
    runPipelineForBvidImpl,
    withCommentPublishQueueLockImpl,
    computePublishCooldownMsImpl,
    sleepImpl,
    refreshPendingTasks: () => {
      const refreshDb = openDatabase(dbPath);
      try {
        return buildPendingPublishTasks({
          db: refreshDb,
          videos: listVideosPendingPublishImpl(refreshDb),
          authFileByMid,
          fallbackAuthFile,
          onLog,
        });
      } finally {
        refreshDb.close?.();
      }
    },
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

function buildPendingPublishTasks({
  db,
  videos,
  authFileByMid,
  fallbackAuthFile,
  onLog,
}: {
  db: ReturnType<typeof openDatabase>;
  videos: VideoRecord[];
  authFileByMid: Map<number, string>;
  fallbackAuthFile: string | null;
  onLog: (message: string) => void;
}): PendingPublishTask[] {
  const failureCooldownByBvid = listTerminalPublishFailureCooldowns(db);

  return videos.flatMap((video) => {
    const retryAfterMs = failureCooldownByBvid.get(video.bvid);
    if (retryAfterMs && retryAfterMs > Date.now()) {
      onLog(
        `Skip publish for ${video.bvid}: recent terminal comment failure is cooling down until ${new Date(retryAfterMs).toISOString()}`,
      );
      return [];
    }

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
      uploadedAtUnix: null,
      queueRevision: createPublishQueueRevision(db, video),
    }];
  });
}

function listTerminalPublishFailureCooldowns(db: ReturnType<typeof openDatabase>) {
  const cutoffMs = Date.now() - TERMINAL_PUBLISH_FAILURE_COOLDOWN_MS;
  const events = listPipelineEvents(db, {
    sinceIso: new Date(cutoffMs).toISOString(),
    limit: 5_000,
  });
  const latestEventByBvid = new Map<string, (typeof events)[number]>();

  for (const event of events) {
    const bvid = String(event.bvid ?? "").trim();
    if (
      !bvid
      || latestEventByBvid.has(bvid)
      || event.scope !== "publish"
      || event.action !== "comment-thread"
    ) {
      continue;
    }
    latestEventByBvid.set(bvid, event);
  }

  const cooldownByBvid = new Map<string, number>();
  for (const [bvid, event] of latestEventByBvid) {
    if (event.status !== "failed") {
      continue;
    }

    const details = parsePipelineFailurePayload(event.details_json);
    if (!isTerminalCommentPublishFailure({
      message: event.message,
      code: details?.code,
      stdout: JSON.stringify({
        ...details,
        message: event.message,
      }),
    }) && !isPublishPipelineTimeoutFailure({
      message: event.message,
      code: details?.code,
      timedOut: details?.timedOut,
    })) {
      continue;
    }

    const failedAtMs = Date.parse(event.created_at);
    if (!Number.isFinite(failedAtMs)) {
      continue;
    }
    cooldownByBvid.set(bvid, failedAtMs + TERMINAL_PUBLISH_FAILURE_COOLDOWN_MS);
  }

  return cooldownByBvid;
}

function createPublishQueueRevision(
  db: ReturnType<typeof openDatabase>,
  video: VideoRecord,
) {
  const pendingParts = listPendingPublishParts(db, video.id);
  return JSON.stringify({
    publishMode: Number(video.publish_needs_rebuild) === 1 ? "rebuild" : "append",
    rebuildReason: video.publish_rebuild_reason,
    rebuildUpdatedAt: Number(video.publish_needs_rebuild) === 1 ? video.updated_at : null,
    parts: pendingParts.map((part) => [
      part.id,
      part.page_no,
      part.cid,
      part.summary_hash,
      createHash("sha256").update(getPreferredSummaryText(part)).digest("hex"),
    ]),
  });
}

function comparePendingPublishTasks(left: PendingPublishTask, right: PendingPublishTask) {
  const leftUploadedAt = Number(left.uploadedAtUnix ?? 0);
  const rightUploadedAt = Number(right.uploadedAtUnix ?? 0);
  if (leftUploadedAt > 0 || rightUploadedAt > 0) {
    if (leftUploadedAt <= 0) {
      return 1;
    }
    if (rightUploadedAt <= 0) {
      return -1;
    }
    if (leftUploadedAt !== rightUploadedAt) {
      return rightUploadedAt - leftUploadedAt;
    }
  }

  const aidDiff = Number(right.video.aid ?? 0) - Number(left.video.aid ?? 0);
  if (aidDiff !== 0) {
    return aidDiff;
  }

  const createdAtDiff = Date.parse(right.video.created_at) - Date.parse(left.video.created_at);
  if (Number.isFinite(createdAtDiff) && createdAtDiff !== 0) {
    return createdAtDiff;
  }

  return right.video.id - left.video.id;
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

async function runPendingPublishTasksWithConcurrency({
  tasks,
  workRoot,
  dbPath,
  logDay,
  logGroup,
  logger,
  onLog,
  runs,
  failures,
  runPipelineForBvidImpl,
  withCommentPublishQueueLockImpl,
  computePublishCooldownMsImpl,
  sleepImpl,
  refreshPendingTasks,
  onAbort,
}: {
  tasks: PendingPublishTask[];
  workRoot: string;
  dbPath: string;
  logDay: string | null;
  logGroup: string | null;
  logger: FileLogger | null;
  onLog: (message: string) => void;
  runs: Array<Record<string, unknown>>;
  failures: PendingPublishFailure[];
  runPipelineForBvidImpl: typeof runPipelineForBvid;
  withCommentPublishQueueLockImpl: typeof withCommentPublishQueueLock;
  computePublishCooldownMsImpl: (publishMode: "append" | "rebuild") => number;
  sleepImpl: (timeoutMs: number) => Promise<void>;
  refreshPendingTasks: () => PendingPublishTask[];
  onAbort: () => void;
}) {
  const maxConcurrent = Math.min(PUBLISH_SWEEP_MAX_CONCURRENCY, tasks.length);
  const pendingTasks = [...tasks];
  const queuedBvids = new Set(pendingTasks.map((task) => task.video.bvid));
  const activeBvids = new Set<string>();
  const completedRevisionByBvid = new Map<string, string>();
  let completedTaskCount = 0;
  let stopScheduling = false;

  onLog(`Publishing ${tasks.length} queued video(s) with up to ${maxConcurrent} concurrent task(s), newest first`);

  const worker = async () => {
    while (true) {
      if (stopScheduling) {
        return;
      }

      for (const refreshedTask of refreshPendingTasks()) {
        const bvid = refreshedTask.video.bvid;
        if (
          activeBvids.has(bvid)
          || queuedBvids.has(bvid)
          || completedRevisionByBvid.get(bvid) === refreshedTask.queueRevision
        ) {
          continue;
        }
        pendingTasks.push(refreshedTask);
        tasks.push(refreshedTask);
        queuedBvids.add(bvid);
      }

      pendingTasks.sort(comparePendingPublishTasks);
      tasks.sort(comparePendingPublishTasks);

      const task = pendingTasks.shift();
      if (!task) {
        return;
      }
      queuedBvids.delete(task.video.bvid);

      const failureCooldown = terminalPublishFailureCooldowns.get(task.video.bvid);
      if (
        failureCooldown
        && failureCooldown.queueRevision === task.queueRevision
        && failureCooldown.retryAfterMs > Date.now()
      ) {
        completedRevisionByBvid.set(task.video.bvid, task.queueRevision);
        onLog(
          `Skip publish for ${task.video.bvid}: terminal comment failure is cooling down until ${new Date(failureCooldown.retryAfterMs).toISOString()}`,
        );
        continue;
      }
      if (failureCooldown) {
        terminalPublishFailureCooldowns.delete(task.video.bvid);
      }

      activeBvids.add(task.video.bvid);
      completedTaskCount += 1;
      const scopedLogger = logger?.child({
        task: "publish",
        bvid: task.video.bvid,
        publishMode: task.publishMode,
      }) ?? null;

      onLog(
        `Publishing ${task.video.bvid} (${task.video.title || "untitled"}) [${task.publishMode}] ${completedTaskCount}/${tasks.length}`,
      );

      try {
        const result = await withCommentPublishQueueLockImpl({
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
          publish: true,
          logger: scopedLogger,
        }));

        runs.push({
          bvid: task.video.bvid,
          title: task.video.title,
          publishMode: task.publishMode,
          result,
        });
        completedRevisionByBvid.set(task.video.bvid, task.queueRevision);

        if (didPublishCreateComments(result) && !stopScheduling) {
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

        if (isTerminalCommentPublishFailure(error)) {
          completedRevisionByBvid.set(task.video.bvid, task.queueRevision);
          terminalPublishFailureCooldowns.set(task.video.bvid, {
            queueRevision: task.queueRevision,
            retryAfterMs: Date.now() + TERMINAL_PUBLISH_FAILURE_COOLDOWN_MS,
          });
          onLog(
            `Publish failed for ${task.video.bvid} because the comment was deleted or remained invisible; skipping this video and continuing the queue`,
          );
          continue;
        }

        if (isPublishPipelineTimeoutFailure(error)) {
          completedRevisionByBvid.set(task.video.bvid, task.queueRevision);
          terminalPublishFailureCooldowns.set(task.video.bvid, {
            queueRevision: task.queueRevision,
            retryAfterMs: Date.now() + TERMINAL_PUBLISH_FAILURE_COOLDOWN_MS,
          });
          persistPublishTimeoutFailure({
            dbPath,
            task,
            error,
          });
          onLog(
            `Publish timed out for ${task.video.bvid}; cooling down this video and continuing the queue`,
          );
          continue;
        }

        stopScheduling = true;
        onAbort();
        onLog(`Publish failed for ${task.video.bvid}; stopping the remaining queue to avoid repeated write pressure`);
        return;
      } finally {
        activeBvids.delete(task.video.bvid);
      }
    }
  };

  await Promise.all(Array.from({ length: maxConcurrent }, () => worker()));
}

function isPublishPipelineTimeoutFailure(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    message?: unknown;
    code?: unknown;
    timedOut?: unknown;
  };
  return candidate.timedOut === true
    || String(candidate.code ?? "").toUpperCase() === "ETIMEDOUT"
    || String(candidate.message ?? "").toLowerCase().includes("command timed out");
}

function persistPublishTimeoutFailure({
  dbPath,
  task,
  error,
}: {
  dbPath: string;
  task: PendingPublishTask;
  error: unknown;
}) {
  const candidate = error && typeof error === "object"
    ? error as { message?: unknown; code?: unknown; timedOut?: unknown; timeoutMs?: unknown }
    : {};
  const db = openDatabase(dbPath);
  try {
    insertPipelineEvent(db, {
      runId: `publish-timeout-${Date.now()}`,
      videoId: task.video.id,
      bvid: task.video.bvid,
      videoTitle: task.video.title,
      scope: "publish",
      action: "comment-thread",
      status: "failed",
      message: String(candidate.message ?? "Publish pipeline timed out"),
      details: {
        code: candidate.code ?? "ETIMEDOUT",
        timedOut: true,
        timeoutMs: Number(candidate.timeoutMs ?? 0) || null,
        publishMode: task.publishMode,
        queueRevision: task.queueRevision,
      },
    });
  } finally {
    db.close?.();
  }
}

function isTerminalCommentPublishFailure(error: unknown) {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    message?: unknown;
    stdout?: unknown;
    code?: unknown;
  };
  const payload = parsePipelineFailurePayload(candidate.stdout);
  const responseData = payload?.responseData && typeof payload.responseData === "object"
    ? payload.responseData as Record<string, unknown>
    : null;
  const code = Number(payload?.code ?? responseData?.code ?? candidate.code);
  const messages = [
    candidate.message,
    payload?.message,
    responseData?.message,
  ].map((value) => String(value ?? "").trim()).filter(Boolean);

  return code === 12022 || messages.some((message) =>
    message.includes("已经被删除")
    || message.includes("Published comment is not visible to guests")
  );
}

function parsePipelineFailurePayload(value: unknown): Record<string, unknown> | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }

  try {
    const parsed = JSON.parse(normalized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
