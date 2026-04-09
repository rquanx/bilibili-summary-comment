import { createClient } from "../bili/comment-utils.ts";
import { runPipelinesWithConcurrency, SUMMARY_PIPELINE_MAX_CONCURRENCY } from "./concurrency.ts";
import { runPipelineForBvid, readCookieString } from "./pipeline-runner.ts";
import { parseSummaryUsers } from "./user-targets.ts";
import type { PipelineUpload } from "./concurrency.ts";
import type { PipelineRunResult, PipelineFailureResult } from "./concurrency.ts";
import type { PipelineProcessResult } from "./pipeline-runner.ts";
import type { SummaryUserTarget } from "./user-targets.ts";

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

  if (collected.summaryUsers.length === 0) {
    return {
      ...collected,
      runs: [],
      failures: [],
    };
  }

  if (collected.uploads.length === 0) {
    onLog("No uploads found within the recent time window");
    return {
      ...collected,
      runs: [],
      failures: [],
    };
  }

  onLog(
    `Running up to ${SUMMARY_PIPELINE_MAX_CONCURRENCY} pipelines concurrently with per-user concurrency capped at 1`,
  );
  const { runs, failures } = await runPipelinesWithConcurrencyImpl({
    uploads: collected.uploads,
    maxConcurrent: SUMMARY_PIPELINE_MAX_CONCURRENCY,
    userKeyForUpload(upload) {
      return String(upload.mid ?? "");
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
    ...collected,
    runs,
    failures,
  };
}
