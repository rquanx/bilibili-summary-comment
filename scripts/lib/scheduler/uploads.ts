import { createClient } from "../bili/comment-utils";
import { runPipelinesWithConcurrency, SUMMARY_PIPELINE_MAX_CONCURRENCY } from "./concurrency";
import { runPipelineForBvid, readCookieString } from "./pipeline-runner";
import { parseSummaryUsers } from "./user-targets";
import type { PipelineUpload } from "./concurrency";
import type { PipelineRunResult, PipelineFailureResult } from "./concurrency";
import type { PipelineProcessResult } from "./pipeline-runner";
import type { SummaryUserTarget } from "./user-targets";

export interface RecentUpload extends PipelineUpload {
  mid: number;
  bvid: string;
  aid: number | null;
  title: string;
  createdAtUnix: number;
  createdAt: string;
  source: string;
}

export interface CollectedUploadsResult {
  summaryUsers: SummaryUserTarget[];
  uploads: RecentUpload[];
}

type UploadTitleVariant = "clean" | "plain" | "danmu";

interface CollectRecentUploadsOptions {
  summaryUsers?: unknown;
  cookieFile?: string;
  sinceHours?: number;
  onLog?: (message: string) => void;
  readCookieStringImpl?: (cookieFile: string) => string;
  createClientImpl?: typeof createClient;
}

interface SyncSummaryUsersRecentVideosOptions extends CollectRecentUploadsOptions {
  dbPath?: string;
  workRoot?: string;
  publish?: boolean;
  maxConcurrent?: number;
  collectRecentUploadsImpl?: (options: CollectRecentUploadsOptions) => Promise<CollectedUploadsResult>;
  runPipelinesWithConcurrencyImpl?: (
    options: Parameters<typeof runPipelinesWithConcurrency<RecentUpload, PipelineProcessResult>>[0],
  ) => Promise<{
    runs: Array<PipelineRunResult<RecentUpload, PipelineProcessResult>>;
    failures: Array<PipelineFailureResult<RecentUpload>>;
  }>;
  runPipelineForBvidImpl?: typeof runPipelineForBvid;
}

export async function collectRecentUploadsFromUsers({
  summaryUsers,
  cookieFile = "cookie.txt",
  sinceHours = 24,
  onLog = () => {},
  readCookieStringImpl = readCookieString,
  createClientImpl = createClient,
}: CollectRecentUploadsOptions = {}): Promise<CollectedUploadsResult> {
  const targets = parseSummaryUsers(summaryUsers);
  if (targets.length === 0) {
    return {
      summaryUsers: [],
      uploads: [],
    };
  }

  const cookie = readCookieStringImpl(cookieFile);
  const client = createClientImpl(cookie);
  const cutoffUnix = Math.floor(Date.now() / 1000) - Math.max(1, Number(sinceHours) || 24) * 3600;
  const uploadMap = new Map<string, RecentUpload>();

  for (const target of targets) {
    onLog(`Fetching recent uploads for uid ${target.mid}`);
    const response = await client.user.getVideos({
      mid: target.mid,
      pn: 1,
      ps: 30,
      order: "pubdate",
    });

    const videos = Array.isArray(response?.list?.vlist) ? response.list.vlist : [];
    for (const video of videos) {
      const createdAtUnix = Number(video?.created ?? 0);
      const bvid = String(video?.bvid ?? "").trim();
      if (!bvid || createdAtUnix < cutoffUnix) {
        continue;
      }

      if (isOnlySelfVisibleVideo(video)) {
        onLog(`Skip only-self-visible video ${bvid} (${String(video?.title ?? "").trim() || "untitled"})`);
        continue;
      }

      const existing = uploadMap.get(bvid);
      if (existing && existing.createdAtUnix >= createdAtUnix) {
        continue;
      }

      uploadMap.set(bvid, {
        mid: target.mid,
        bvid,
        aid: Number(video?.aid ?? 0) || null,
        title: String(video?.title ?? "").trim(),
        createdAtUnix,
        createdAt: new Date(createdAtUnix * 1000).toISOString(),
        source: target.source,
      });
    }
  }

  const uploads = Array.from(uploadMap.values()).sort((left, right) => right.createdAtUnix - left.createdAtUnix);
  return {
    summaryUsers: targets,
    uploads,
  };
}

export async function syncSummaryUsersRecentVideos({
  summaryUsers,
  cookieFile = "cookie.txt",
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
  sinceHours = 24,
  publish = true,
  maxConcurrent = SUMMARY_PIPELINE_MAX_CONCURRENCY,
  onLog = () => {},
  collectRecentUploadsImpl = collectRecentUploadsFromUsers,
  runPipelinesWithConcurrencyImpl = runPipelinesWithConcurrency,
  runPipelineForBvidImpl = runPipelineForBvid,
}: SyncSummaryUsersRecentVideosOptions = {}) {
  const collected = await collectRecentUploadsImpl({
    summaryUsers,
    cookieFile,
    sinceHours,
    onLog,
  });
  const deduplicatedUploads = orderRecentUploadsForVariantReuse(collected.uploads, onLog);
  const effectiveCollected = {
    ...collected,
    uploads: deduplicatedUploads,
  };

  if (effectiveCollected.summaryUsers.length === 0) {
    return {
      ...effectiveCollected,
      runs: [],
      failures: [],
    };
  }

  if (effectiveCollected.uploads.length === 0) {
    onLog("No uploads found within the recent time window");
    return {
      ...effectiveCollected,
      runs: [],
      failures: [],
    };
  }

  const safeMaxConcurrent = Math.max(1, Number(maxConcurrent) || SUMMARY_PIPELINE_MAX_CONCURRENCY);
  onLog(`Running up to ${safeMaxConcurrent} pipelines concurrently with variant-aware serialization`);
  const { runs, failures } = await runPipelinesWithConcurrencyImpl({
    uploads: effectiveCollected.uploads,
    maxConcurrent: safeMaxConcurrent,
    userKeyForUpload(upload) {
      return buildUploadSchedulingKey(upload);
    },
    async runUpload(upload) {
      onLog(`Running pipeline for ${upload.bvid} (${upload.title || "untitled"}) [user ${upload.mid}]`);
      return runPipelineForBvidImpl({
        cookieFile,
        dbPath,
        workRoot,
        bvid: upload.bvid,
        publish,
      });
    },
  });

  return {
    ...effectiveCollected,
    runs,
    failures,
  };
}

function orderRecentUploadsForVariantReuse(
  uploads: RecentUpload[],
  onLog: (message: string) => void = () => {},
): RecentUpload[] {
  if (!Array.isArray(uploads) || uploads.length < 2) {
    return Array.isArray(uploads) ? uploads : [];
  }

  const uploadsByGroup = new Map<string, Array<{ upload: RecentUpload; index: number }>>();
  for (const [index, upload] of uploads.entries()) {
    const groupKey = buildUploadSchedulingKey(upload);
    const bucket = uploadsByGroup.get(groupKey) ?? [];
    bucket.push({
      upload,
      index,
    });
    uploadsByGroup.set(groupKey, bucket);
  }

  const orderedGroups = [...uploadsByGroup.values()].sort((left, right) => {
    const leftIndex = Math.min(...left.map((item) => item.index));
    const rightIndex = Math.min(...right.map((item) => item.index));
    return leftIndex - rightIndex;
  });

  const orderedUploads: RecentUpload[] = [];
  for (const group of orderedGroups) {
    const sortedGroup = [...group].sort(compareUploadPreference);
    if (sortedGroup.length > 1) {
      const orderedBvids = sortedGroup.map((item) => item.upload.bvid).filter(Boolean);
      onLog(
        `Queue ${sortedGroup.length} same-session variants serially for summary/comment reuse: ${orderedBvids.join(" -> ")}`,
      );
    }

    orderedUploads.push(...sortedGroup.map((item) => item.upload));
  }

  return orderedUploads;
}

function buildUploadSchedulingKey(upload: Pick<RecentUpload, "mid" | "title" | "bvid">): string {
  const normalizedTitle = normalizeUploadTitleVariantKey(upload.title);
  return `${String(upload.mid ?? "")}\n${normalizedTitle || String(upload.bvid ?? "")}`;
}

function compareUploadPreference(
  left: { upload: RecentUpload; index: number },
  right: { upload: RecentUpload; index: number },
): number {
  const createdAtDiff = left.upload.createdAtUnix - right.upload.createdAtUnix;
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  const variantDiff = getUploadTitleVariantPriority(left.upload.title) - getUploadTitleVariantPriority(right.upload.title);
  if (variantDiff !== 0) {
    return variantDiff;
  }

  return left.index - right.index;
}

function getUploadTitleVariantPriority(title: unknown): number {
  switch (detectUploadTitleVariant(title)) {
    case "clean":
      return 0;
    case "plain":
      return 1;
    case "danmu":
      return 2;
    default:
      return 1;
  }
}

function detectUploadTitleVariant(title: unknown): UploadTitleVariant {
  const normalized = normalizeUploadTitle(title);
  if (CLEAN_TITLE_VARIANT_SUFFIX_PATTERN.test(normalized)) {
    return "clean";
  }

  if (DANMU_TITLE_VARIANT_SUFFIX_PATTERN.test(normalized)) {
    return "danmu";
  }

  return "plain";
}

function normalizeUploadTitleVariantKey(title: unknown): string {
  let normalized = normalizeUploadTitle(title);
  let previous = "";

  while (normalized && normalized !== previous) {
    previous = normalized;
    normalized = normalized.replace(TITLE_VARIANT_SUFFIX_PATTERN, "").trim();
  }

  return normalized;
}

function normalizeUploadTitle(title: unknown): string {
  return String(title ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function isOnlySelfVisibleVideo(video: unknown): boolean {
  if (!video || typeof video !== "object") {
    return false;
  }

  const candidate = video as Record<string, unknown>;
  return candidate.is_self_view === true || Number(candidate.is_only_self ?? 0) === 1;
}

const TITLE_VARIANT_SUFFIX_PATTERN =
  /(?:\s*[\[(（【]?\s*(?:纯净版|无弹幕版|无弹幕|弹幕版)\s*[\])）】]?\s*)+$/u;
const CLEAN_TITLE_VARIANT_SUFFIX_PATTERN =
  /\s*[\[(（【]?\s*(?:纯净版|无弹幕版|无弹幕)\s*[\])）】]?\s*$/u;
const DANMU_TITLE_VARIANT_SUFFIX_PATTERN = /\s*[\[(（【]?\s*弹幕版\s*[\])）】]?\s*$/u;
