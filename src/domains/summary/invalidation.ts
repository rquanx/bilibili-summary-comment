import { runInTransaction } from "../../infra/db/database";
import type { Db, VideoRecord } from "../../infra/db/index";
import { getVideoByIdentity, listVideoParts, listVideos } from "../../infra/db/index";

const DEFAULT_INVALIDATION_REASON = "summary-input-upgrade-2026-05-05";

export interface InvalidateSummariesOptions {
  all?: boolean;
  bvid?: string | null;
  aid?: number | null;
  recentDays?: number | null;
  fromIso?: string | null;
  toIso?: string | null;
  reason?: string | null;
  dryRun?: boolean;
  now?: Date;
}

export interface InvalidatedVideoSummary {
  videoId: number;
  bvid: string;
  title: string;
  activePartCount: number;
  matchedPartCount: number;
  affectedPartCount: number;
}

export interface InvalidateSummariesResult {
  scope: "all" | "single";
  dryRun: boolean;
  reason: string;
  fromIso: string | null;
  toIso: string | null;
  videoCount: number;
  affectedVideoCount: number;
  activePartCount: number;
  matchedPartCount: number;
  affectedPartCount: number;
  videos: InvalidatedVideoSummary[];
}

export function invalidateSummaries(
  db: Db,
  {
    all = false,
    bvid = null,
    aid = null,
    recentDays = null,
    fromIso = null,
    toIso = null,
    reason = DEFAULT_INVALIDATION_REASON,
    dryRun = false,
    now = new Date(),
  }: InvalidateSummariesOptions,
): InvalidateSummariesResult {
  const targetVideos = resolveTargetVideos(db, {
    all,
    bvid,
    aid,
  });
  const normalizedReason = String(reason ?? "").trim() || DEFAULT_INVALIDATION_REASON;
  const timeWindow = resolveTimeWindow({
    recentDays,
    fromIso,
    toIso,
    now,
  });
  const perVideo = targetVideos.map((video) => inspectVideoSummaryState(db, video, timeWindow));

  const result: InvalidateSummariesResult = {
    scope: all || (!bvid && aid === null) ? "all" : "single",
    dryRun,
    reason: normalizedReason,
    fromIso: timeWindow.fromIso,
    toIso: timeWindow.toIso,
    videoCount: perVideo.length,
    affectedVideoCount: perVideo.filter((item) => item.affectedPartCount > 0).length,
    activePartCount: perVideo.reduce((sum, item) => sum + item.activePartCount, 0),
    matchedPartCount: perVideo.reduce((sum, item) => sum + item.matchedPartCount, 0),
    affectedPartCount: perVideo.reduce((sum, item) => sum + item.affectedPartCount, 0),
    videos: perVideo,
  };

  if (dryRun || perVideo.length === 0) {
    return result;
  }

  const invalidatedAtIso = now.toISOString();
  runInTransaction(db, () => {
    for (const item of perVideo) {
      if (item.affectedPartCount === 0) {
        continue;
      }

      for (const partId of item.partIds) {
        db.prepare(`
          UPDATE video_parts
          SET prompt_text = NULL,
              summary_text = NULL,
              summary_text_processed = NULL,
              summary_hash = NULL,
              published = 0,
              published_comment_rpid = NULL,
              published_at = NULL,
              updated_at = ?
          WHERE id = ?
        `).run(invalidatedAtIso, partId);
      }

      db.prepare(`
        UPDATE videos
        SET publish_needs_rebuild = 1,
            publish_rebuild_reason = ?,
            updated_at = ?
        WHERE id = ?
      `).run(normalizedReason, invalidatedAtIso, item.videoId);
    }
  });

  return result;
}

function resolveTargetVideos(
  db: Db,
  {
    all,
    bvid,
    aid,
  }: {
    all: boolean;
    bvid: string | null;
    aid: number | null;
  },
): VideoRecord[] {
  if (all) {
    return listVideos(db);
  }

  if (!String(bvid ?? "").trim() && aid === null) {
    return listVideos(db);
  }

  const video = getVideoByIdentity(db, {
    bvid: String(bvid ?? "").trim() || null,
    aid,
  });
  if (!video) {
    throw new Error("No matching video found. Provide --all or a valid --bvid/--aid.");
  }

  return [video];
}

function inspectVideoSummaryState(
  db: Db,
  video: VideoRecord,
  timeWindow: { fromMs: number | null; toMs: number | null; fromIso: string | null; toIso: string | null },
): InvalidatedVideoSummary & { partIds: number[] } {
  const activeParts = listVideoParts(db, video.id);
  const matchedParts = activeParts.filter((part) => partMatchesTimeWindow(part.updated_at, timeWindow));
  const affectedParts = matchedParts.filter((part) => hasStoredSummaryState(part));

  return {
    videoId: video.id,
    bvid: video.bvid,
    title: video.title,
    activePartCount: activeParts.length,
    matchedPartCount: matchedParts.length,
    affectedPartCount: affectedParts.length,
    partIds: affectedParts.map((part) => part.id),
  };
}

function hasStoredSummaryState(part: {
  prompt_text?: string | null;
  summary_text?: string | null;
  summary_text_processed?: string | null;
  summary_hash?: string | null;
  published?: number | null;
  published_comment_rpid?: number | null;
  published_at?: string | null;
}) {
  return Boolean(String(part.prompt_text ?? "").trim())
    || Boolean(String(part.summary_text ?? "").trim())
    || Boolean(String(part.summary_text_processed ?? "").trim())
    || Boolean(String(part.summary_hash ?? "").trim())
    || Boolean(Number(part.published))
    || Boolean(part.published_comment_rpid)
    || Boolean(part.published_at);
}

function resolveTimeWindow({
  recentDays,
  fromIso,
  toIso,
  now,
}: {
  recentDays: number | null;
  fromIso: string | null;
  toIso: string | null;
  now: Date;
}) {
  const normalizedRecentDays = Number.isFinite(recentDays) && Number(recentDays) > 0
    ? Number(recentDays)
    : null;
  let fromMs = parseOptionalBoundary(fromIso, "start");
  let toMs = parseOptionalBoundary(toIso, "end");

  if (normalizedRecentDays !== null) {
    const recentFromMs = now.getTime() - normalizedRecentDays * 24 * 60 * 60 * 1000;
    fromMs = fromMs === null ? recentFromMs : Math.max(fromMs, recentFromMs);
  }

  if (fromMs !== null && toMs !== null && fromMs > toMs) {
    throw new Error("Invalid time window: --from must be earlier than or equal to --to.");
  }

  return {
    fromMs,
    toMs,
    fromIso: fromMs === null ? null : new Date(fromMs).toISOString(),
    toIso: toMs === null ? null : new Date(toMs).toISOString(),
  };
}

function parseOptionalBoundary(value: string | null, mode: "start" | "end") {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/u.test(normalized)) {
    const suffix = mode === "start" ? "T00:00:00.000Z" : "T23:59:59.999Z";
    return Date.parse(`${normalized}${suffix}`);
  }

  const parsed = Date.parse(normalized);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid ${mode === "start" ? "--from" : "--to"} value: ${normalized}`);
  }

  return parsed;
}

function partMatchesTimeWindow(
  updatedAt: string | null | undefined,
  timeWindow: { fromMs: number | null; toMs: number | null },
) {
  if (timeWindow.fromMs === null && timeWindow.toMs === null) {
    return true;
  }

  const parsed = Date.parse(String(updatedAt ?? "").trim());
  if (Number.isNaN(parsed)) {
    return false;
  }

  if (timeWindow.fromMs !== null && parsed < timeWindow.fromMs) {
    return false;
  }

  if (timeWindow.toMs !== null && parsed > timeWindow.toMs) {
    return false;
  }

  return true;
}
