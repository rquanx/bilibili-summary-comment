import { createClient } from "./bili-comment-utils.mjs";
import { runPipelinesWithConcurrency, SUMMARY_PIPELINE_MAX_CONCURRENCY } from "./scheduler-concurrency.mjs";
import { runPipelineForBvid, readCookieString } from "./scheduler-pipeline-runner.mjs";
import { parseSummaryUsers } from "./scheduler-user-targets.mjs";

export async function collectRecentUploadsFromUsers({
  summaryUsers,
  cookieFile = "cookie.txt",
  sinceHours = 24,
  onLog = () => {},
  readCookieStringImpl = readCookieString,
  createClientImpl = createClient,
} = {}) {
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
  const uploadMap = new Map();

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
} = {}) {
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
