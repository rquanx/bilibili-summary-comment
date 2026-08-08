import fs from "node:fs";
import path from "node:path";
import {
  insertPipelineEvent,
  listPendingPublishParts,
  listVideosPendingPublish,
  openDatabase,
} from "../../infra/db/index";
import type { Db, VideoRecord } from "../../infra/db/index";
import { getRepoRoot } from "../../shared/runtime-tools";
import { sendServerChanNotification } from "../subtitle/notifier";
import { findAuthFileForUser } from "./auth-files";
import { listTerminalPublishFailureCooldowns } from "./publish";
import { parseSummaryUsers } from "./user-targets";

export const DEFAULT_COMMENT_STALL_ALERT_MINUTES = 120;
export const COMMENT_STALL_ALERT_STATE_FILE = "comment-publish-stall-alert.json";

interface PendingSummaryRow {
  video_id: number;
  bvid: string;
  title: string;
  owner_mid: number | null;
  pending_summary_parts: number;
  first_pending_at: string;
}

export interface PendingCommentCandidate {
  videoId: number;
  bvid: string;
  title: string;
  ownerMid: number | null;
  pendingSummaryParts: number;
  pendingPublishParts: number;
  publishNeedsRebuild: boolean;
  firstPendingAt: string;
}

export interface CommentStallAlertState {
  pendingSince: string;
  pendingBvids: string[];
  notifiedAt: string | null;
  lastSuccessfulCommentAt: string | null;
  lastPublishActivityAt: string | null;
  updatedAt: string;
}

export interface CommentStallEvaluation {
  state: CommentStallAlertState | null;
  shouldNotify: boolean;
  reason: "no-pending-videos" | "within-threshold" | "already-notified" | "stalled";
  stalledMinutes: number;
}

export async function runCommentPublishStallAlert({
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
  summaryUsers,
  authFile,
  thresholdMinutes = DEFAULT_COMMENT_STALL_ALERT_MINUTES,
  now = new Date(),
  repoRoot = getRepoRoot(),
  onLog = () => {},
  sendNotificationImpl = sendServerChanNotification,
}: {
  dbPath?: string;
  workRoot?: string;
  summaryUsers?: unknown;
  authFile?: string;
  thresholdMinutes?: number;
  now?: Date;
  repoRoot?: string;
  onLog?: (message: string) => void;
  sendNotificationImpl?: typeof sendServerChanNotification;
} = {}) {
  const statePath = resolveCommentStallAlertStatePath({ repoRoot, workRoot });
  const db = openDatabase(dbPath);
  let candidates: PendingCommentCandidate[];
  let latestSuccessfulCommentAt: string | null;
  let latestPublishActivityAt: string | null;

  try {
    candidates = listPendingCommentCandidates(db);
    candidates = filterActionableCommentCandidates({
      db,
      candidates,
      summaryUsers,
      authFile,
      repoRoot,
      nowMs: now.getTime(),
    });
    latestSuccessfulCommentAt = getLatestSuccessfulCommentAt(db);
    latestPublishActivityAt = getLatestCommentPublishActivityAt(db);
  } finally {
    db.close?.();
  }

  const evaluation = evaluateCommentPublishStallState({
    candidates,
    previousState: readCommentStallAlertState(statePath),
    latestSuccessfulCommentAt,
    latestPublishActivityAt,
    thresholdMinutes,
    now,
  });

  if (!evaluation.state) {
    clearCommentStallAlertState(statePath);
    return {
      notified: false,
      candidates,
      statePath,
      ...evaluation,
    };
  }

  persistCommentStallAlertState(statePath, evaluation.state);
  if (!evaluation.shouldNotify) {
    return {
      notified: false,
      candidates,
      statePath,
      ...evaluation,
    };
  }

  try {
    const result = await sendNotificationImpl(buildCommentStallNotification({
      candidates,
      state: evaluation.state,
      stalledMinutes: evaluation.stalledMinutes,
    }));
    if (result.skipped) {
      onLog("SERVER_CHAN_SEND_KEY is not configured, skipping comment stall notification");
      return {
        notified: false,
        skipped: true,
        candidates,
        statePath,
        ...evaluation,
      };
    }

    const notifiedAt = now.toISOString();
    const notifiedState = {
      ...evaluation.state,
      notifiedAt,
      updatedAt: notifiedAt,
    };
    persistCommentStallAlertState(statePath, notifiedState);
    recordCommentStallAlertEvent({
      dbPath,
      candidates,
      state: notifiedState,
      stalledMinutes: evaluation.stalledMinutes,
    });
    onLog(
      `Sent ServerChan comment stall notification for ${candidates.length} pending video(s) after ${evaluation.stalledMinutes} minute(s)`,
    );

    return {
      notified: true,
      skipped: false,
      candidates,
      statePath,
      ...evaluation,
      state: notifiedState,
    };
  } catch (error) {
    onLog(`Failed to send comment stall notification: ${formatErrorMessage(error)}`);
    return {
      notified: false,
      skipped: false,
      candidates,
      statePath,
      ...evaluation,
      error,
    };
  }
}

export function listPendingCommentCandidates(db: Db): PendingCommentCandidate[] {
  const candidates = new Map<number, PendingCommentCandidate>();
  const pendingSummaryRows = db.prepare(`
    SELECT
      v.id AS video_id,
      v.bvid,
      v.title,
      v.owner_mid,
      COUNT(*) AS pending_summary_parts,
      MIN(p.created_at) AS first_pending_at
    FROM videos v
    JOIN video_parts p ON p.video_id = v.id
    WHERE p.is_deleted = 0
      AND (p.summary_text IS NULL OR TRIM(p.summary_text) = '')
    GROUP BY v.id, v.bvid, v.title
  `).all() as PendingSummaryRow[];

  for (const row of pendingSummaryRows) {
    candidates.set(row.video_id, {
      videoId: row.video_id,
      bvid: row.bvid,
      title: row.title,
      ownerMid: row.owner_mid,
      pendingSummaryParts: Number(row.pending_summary_parts) || 0,
      pendingPublishParts: 0,
      publishNeedsRebuild: false,
      firstPendingAt: normalizeIsoTimestamp(row.first_pending_at) ?? new Date().toISOString(),
    });
  }

  for (const video of listVideosPendingPublish(db)) {
    const pendingParts = listPendingPublishParts(db, video.id);
    const firstPendingAt = resolvePublishCandidateFirstPendingAt(video, pendingParts);
    const existing = candidates.get(video.id);

    candidates.set(video.id, {
      videoId: video.id,
      bvid: video.bvid,
      title: video.title,
      ownerMid: video.owner_mid,
      pendingSummaryParts: existing?.pendingSummaryParts ?? 0,
      pendingPublishParts: pendingParts.length,
      publishNeedsRebuild: Number(video.publish_needs_rebuild) === 1,
      firstPendingAt: earliestIsoTimestamp(existing?.firstPendingAt, firstPendingAt),
    });
  }

  return [...candidates.values()].sort((left, right) => {
    const timeDiff = timestampMs(left.firstPendingAt) - timestampMs(right.firstPendingAt);
    return timeDiff || left.videoId - right.videoId;
  });
}

export function getLatestSuccessfulCommentAt(db: Db): string | null {
  const rows = db.prepare(`
    SELECT details_json, created_at
    FROM pipeline_events
    WHERE scope = 'publish'
      AND action = 'comment-thread'
      AND status = 'succeeded'
    ORDER BY created_at DESC, id DESC
    LIMIT 500
  `).all() as Array<{ details_json: string | null; created_at: string }>;

  for (const row of rows) {
    try {
      const details = JSON.parse(String(row.details_json ?? "{}")) as { createdComments?: unknown };
      if (Number(details.createdComments ?? 0) > 0) {
        return normalizeIsoTimestamp(row.created_at);
      }
    } catch {
      // Ignore malformed historical event details.
    }
  }

  return null;
}

export function getLatestCommentPublishActivityAt(db: Db): string | null {
  const row = db.prepare(`
    SELECT created_at
    FROM pipeline_events
    WHERE scope = 'publish'
      AND action = 'comment-thread'
      AND status IN ('started', 'succeeded', 'failed')
    ORDER BY created_at DESC, id DESC
    LIMIT 1
  `).get() as { created_at?: string } | undefined;

  return normalizeIsoTimestamp(row?.created_at);
}

export function evaluateCommentPublishStallState({
  candidates,
  previousState,
  latestSuccessfulCommentAt,
  latestPublishActivityAt,
  thresholdMinutes = DEFAULT_COMMENT_STALL_ALERT_MINUTES,
  now = new Date(),
}: {
  candidates: PendingCommentCandidate[];
  previousState?: CommentStallAlertState | null;
  latestSuccessfulCommentAt?: string | null;
  latestPublishActivityAt?: string | null;
  thresholdMinutes?: number;
  now?: Date;
}): CommentStallEvaluation {
  if (candidates.length === 0) {
    return {
      state: null,
      shouldNotify: false,
      reason: "no-pending-videos",
      stalledMinutes: 0,
    };
  }

  const nowMs = now.getTime();
  const candidateBvids = candidates.map((candidate) => candidate.bvid).sort();
  const previousBvids = new Set(previousState?.pendingBvids ?? []);
  const continuesPreviousIncident = candidateBvids.some((bvid) => previousBvids.has(bvid));
  const oldestCandidateAt = candidates.reduce(
    (oldest, candidate) => Math.min(oldest, timestampMs(candidate.firstPendingAt)),
    nowMs,
  );
  let pendingSinceMs = continuesPreviousIncident
    ? timestampMs(previousState?.pendingSince)
    : oldestCandidateAt;
  if (!Number.isFinite(pendingSinceMs) || pendingSinceMs > nowMs) {
    pendingSinceMs = nowMs;
  }

  const latestSuccessMs = timestampMs(latestSuccessfulCommentAt);
  if (Number.isFinite(latestSuccessMs) && latestSuccessMs > pendingSinceMs && latestSuccessMs <= nowMs) {
    pendingSinceMs = latestSuccessMs;
  }
  const latestActivityMs = timestampMs(latestPublishActivityAt);
  if (Number.isFinite(latestActivityMs) && latestActivityMs > pendingSinceMs && latestActivityMs <= nowMs) {
    pendingSinceMs = latestActivityMs;
  }

  const pendingSince = new Date(pendingSinceMs).toISOString();
  const previousNotifiedMs = timestampMs(previousState?.notifiedAt);
  const notifiedAt = continuesPreviousIncident
    && Number.isFinite(previousNotifiedMs)
    && previousNotifiedMs >= pendingSinceMs
      ? previousState?.notifiedAt ?? null
      : null;
  const safeThresholdMinutes = Math.max(1, Math.floor(Number(thresholdMinutes) || DEFAULT_COMMENT_STALL_ALERT_MINUTES));
  const stalledMinutes = Math.max(0, Math.floor((nowMs - pendingSinceMs) / 60_000));
  const state: CommentStallAlertState = {
    pendingSince,
    pendingBvids: candidateBvids,
    notifiedAt,
    lastSuccessfulCommentAt: normalizeIsoTimestamp(latestSuccessfulCommentAt),
    lastPublishActivityAt: normalizeIsoTimestamp(latestPublishActivityAt),
    updatedAt: now.toISOString(),
  };

  if (stalledMinutes < safeThresholdMinutes) {
    return {
      state,
      shouldNotify: false,
      reason: "within-threshold",
      stalledMinutes,
    };
  }

  if (notifiedAt) {
    return {
      state,
      shouldNotify: false,
      reason: "already-notified",
      stalledMinutes,
    };
  }

  return {
    state,
    shouldNotify: true,
    reason: "stalled",
    stalledMinutes,
  };
}

export function buildCommentStallNotification({
  candidates,
  state,
  stalledMinutes,
}: {
  candidates: PendingCommentCandidate[];
  state: CommentStallAlertState;
  stalledMinutes: number;
}) {
  const lines = [
    `存在 ${candidates.length} 个需要总结或发布评论的视频，已经连续 ${stalledMinutes} 分钟没有成功发出一条新评论。`,
    "",
    `- 持续开始时间: ${state.pendingSince}`,
    `- 最近成功评论: ${state.lastSuccessfulCommentAt ?? "无记录"}`,
    "",
    "## 待处理视频",
  ];

  for (const candidate of candidates.slice(0, 10)) {
    const pendingLabels = [
      candidate.pendingSummaryParts > 0 ? `待总结 ${candidate.pendingSummaryParts}P` : "",
      candidate.pendingPublishParts > 0 ? `待发布 ${candidate.pendingPublishParts}P` : "",
      candidate.publishNeedsRebuild ? "需重建评论串" : "",
    ].filter(Boolean);
    lines.push(`- ${candidate.title || candidate.bvid} (${candidate.bvid}) - ${pendingLabels.join("，")}`);
    lines.push(`  https://www.bilibili.com/video/${candidate.bvid}`);
  }

  if (candidates.length > 10) {
    lines.push(`- 另有 ${candidates.length - 10} 个视频未展开`);
  }

  return {
    title: `评论发布停滞告警：${candidates.length} 个视频`,
    desp: lines.join("\n"),
  };
}

export function resolveCommentStallAlertStatePath({
  repoRoot = getRepoRoot(),
  workRoot = "work",
}: {
  repoRoot?: string;
  workRoot?: string;
} = {}) {
  return path.resolve(repoRoot, workRoot, "state", COMMENT_STALL_ALERT_STATE_FILE);
}

export function readCommentStallAlertState(statePath: string): CommentStallAlertState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<CommentStallAlertState>;
    const pendingSince = normalizeIsoTimestamp(parsed.pendingSince);
    if (!pendingSince) {
      return null;
    }

    return {
      pendingSince,
      pendingBvids: Array.isArray(parsed.pendingBvids)
        ? [...new Set(parsed.pendingBvids.map((value) => String(value ?? "").trim()).filter(Boolean))].sort()
        : [],
      notifiedAt: normalizeIsoTimestamp(parsed.notifiedAt),
      lastSuccessfulCommentAt: normalizeIsoTimestamp(parsed.lastSuccessfulCommentAt),
      lastPublishActivityAt: normalizeIsoTimestamp(parsed.lastPublishActivityAt),
      updatedAt: normalizeIsoTimestamp(parsed.updatedAt) ?? pendingSince,
    };
  } catch {
    return null;
  }
}

export function persistCommentStallAlertState(statePath: string, state: CommentStallAlertState) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const temporaryPath = `${statePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, statePath);
}

function clearCommentStallAlertState(statePath: string) {
  fs.rmSync(statePath, { force: true });
}

function resolvePublishCandidateFirstPendingAt(
  video: VideoRecord,
  parts: Array<{ created_at: string }>,
) {
  return parts.reduce(
    (earliest, part) => earliestIsoTimestamp(earliest, part.created_at),
    normalizeIsoTimestamp(video.updated_at) ?? normalizeIsoTimestamp(video.created_at) ?? new Date().toISOString(),
  );
}

function recordCommentStallAlertEvent({
  dbPath,
  candidates,
  state,
  stalledMinutes,
}: {
  dbPath: string;
  candidates: PendingCommentCandidate[];
  state: CommentStallAlertState;
  stalledMinutes: number;
}) {
  const db = openDatabase(dbPath);
  try {
    insertPipelineEvent(db, {
      scope: "scheduler",
      action: "comment-publish-stalled-alert",
      status: "succeeded",
      message: `ServerChan notified after ${stalledMinutes} minute(s) without a successful new comment`,
      details: {
        pendingSince: state.pendingSince,
        pendingBvids: state.pendingBvids,
        lastSuccessfulCommentAt: state.lastSuccessfulCommentAt,
        lastPublishActivityAt: state.lastPublishActivityAt,
        candidateCount: candidates.length,
      },
    });
  } finally {
    db.close?.();
  }
}

function filterActionableCommentCandidates({
  db,
  candidates,
  summaryUsers,
  authFile,
  repoRoot,
  nowMs,
}: {
  db: Db;
  candidates: PendingCommentCandidate[];
  summaryUsers: unknown;
  authFile: string | undefined;
  repoRoot: string;
  nowMs: number;
}) {
  const publishCandidates = candidates.filter(
    (candidate) => candidate.pendingPublishParts > 0 || candidate.publishNeedsRebuild,
  );
  const cooldowns = listTerminalPublishFailureCooldowns(db, nowMs);
  const candidatesOutsideCooldown = publishCandidates.filter((candidate) => {
    const retryAfterMs = cooldowns.get(candidate.bvid);
    return !retryAfterMs || retryAfterMs <= nowMs;
  });

  if (summaryUsers === undefined || !authFile) {
    return candidatesOutsideCooldown;
  }

  const authFileByMid = new Map<number, string>();
  for (const [index, target] of parseSummaryUsers(summaryUsers).entries()) {
    const resolvedAuthFile = findAuthFileForUser(authFile, index + 1, { repoRoot });
    if (resolvedAuthFile) {
      authFileByMid.set(target.mid, resolvedAuthFile);
    }
  }
  const fallbackAuthFile = authFileByMid.size === 1 ? [...authFileByMid.values()][0] : null;

  return candidatesOutsideCooldown.filter((candidate) => {
    const ownerMid = Number(candidate.ownerMid ?? 0);
    return (Number.isInteger(ownerMid) && ownerMid > 0 && authFileByMid.has(ownerMid))
      || Boolean(fallbackAuthFile);
  });
}

function earliestIsoTimestamp(left: unknown, right: unknown) {
  const leftIso = normalizeIsoTimestamp(left);
  const rightIso = normalizeIsoTimestamp(right);
  if (!leftIso) {
    return rightIso ?? new Date().toISOString();
  }
  if (!rightIso) {
    return leftIso;
  }
  return timestampMs(leftIso) <= timestampMs(rightIso) ? leftIso : rightIso;
}

function normalizeIsoTimestamp(value: unknown): string | null {
  const timestamp = new Date(String(value ?? "")).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function timestampMs(value: unknown) {
  const timestamp = new Date(String(value ?? "")).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NaN;
}

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown error";
}
