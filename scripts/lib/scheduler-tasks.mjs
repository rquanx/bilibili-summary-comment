import fs from "node:fs";
import path from "node:path";
import { createClient } from "./bili-comment-utils.mjs";
import { getRepoRoot, runCommand } from "./runtime-tools.mjs";

const SUMMARY_PIPELINE_MAX_CONCURRENCY = 3;

export function parseSummaryUsers(summaryUsers) {
  const raw = String(summaryUsers ?? "");
  if (!raw.trim()) {
    return [];
  }

  const targets = [];
  const seen = new Set();

  for (const entry of raw.split(/[,\r\n]+/)) {
    const input = entry.trim();
    if (!input) {
      continue;
    }

    const mid = extractBiliMid(input);
    if (!mid || seen.has(mid)) {
      continue;
    }

    seen.add(mid);
    targets.push({
      mid,
      source: input,
    });
  }

  return targets;
}

export async function collectRecentUploadsFromUsers({
  summaryUsers,
  cookieFile = "cookie.txt",
  sinceHours = 24,
  onLog = () => {},
} = {}) {
  const targets = parseSummaryUsers(summaryUsers);
  if (targets.length === 0) {
    return {
      summaryUsers: [],
      uploads: [],
    };
  }

  const cookie = readCookieString(cookieFile);
  const client = createClient(cookie);
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
} = {}) {
  const collected = await collectRecentUploadsFromUsers({
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
  const { runs, failures } = await runPipelinesWithConcurrency({
    uploads: collected.uploads,
    maxConcurrent: SUMMARY_PIPELINE_MAX_CONCURRENCY,
    userKeyForUpload(upload) {
      return String(upload.mid ?? "");
    },
    async runUpload(upload) {
      onLog(`Running pipeline for ${upload.bvid} (${upload.title || "untitled"}) [user ${upload.mid}]`);
      return runPipelineForBvid({
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

export async function runPipelinesWithConcurrency({
  uploads,
  maxConcurrent = SUMMARY_PIPELINE_MAX_CONCURRENCY,
  userKeyForUpload = (upload) => String(upload?.mid ?? ""),
  runUpload,
} = {}) {
  const queue = Array.isArray(uploads)
    ? uploads.map((upload, index) => ({
        upload,
        index,
      }))
    : [];
  const safeMaxConcurrent = Math.max(1, Number(maxConcurrent) || SUMMARY_PIPELINE_MAX_CONCURRENCY);
  const runResults = new Array(queue.length);
  const failureResults = new Array(queue.length);
  const activeUsers = new Set();
  let activeCount = 0;

  if (typeof runUpload !== "function" || queue.length === 0) {
    return {
      runs: [],
      failures: [],
    };
  }

  return new Promise((resolve) => {
    const maybeResolve = () => {
      if (queue.length > 0 || activeCount > 0) {
        return false;
      }

      resolve({
        runs: runResults.filter(Boolean),
        failures: failureResults.filter(Boolean),
      });
      return true;
    };

    const scheduleNext = () => {
      while (activeCount < safeMaxConcurrent) {
        const nextIndex = queue.findIndex((item) => {
          const userKey = normalizePipelineUserKey(userKeyForUpload(item.upload));
          return !activeUsers.has(userKey);
        });
        if (nextIndex === -1) {
          break;
        }

        const [{ upload, index }] = queue.splice(nextIndex, 1);
        const userKey = normalizePipelineUserKey(userKeyForUpload(upload));
        activeCount += 1;
        activeUsers.add(userKey);

        Promise.resolve()
          .then(() => runUpload(upload))
          .then((result) => {
            runResults[index] = {
              ...upload,
              result,
            };
          })
          .catch((error) => {
            failureResults[index] = {
              ...upload,
              message: error?.message ?? "Unknown error",
            };
          })
          .finally(() => {
            activeCount -= 1;
            activeUsers.delete(userKey);
            if (!maybeResolve()) {
              scheduleNext();
            }
          });
      }

      maybeResolve();
    };

    scheduleNext();
  });
}

export async function cleanupOldWorkDirectories({
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
  olderThanDays = 2,
  onLog = () => {},
} = {}) {
  const { listVideosOlderThan, openDatabase } = await import("./storage.mjs");
  const db = openDatabase(dbPath);
  try {
    const cutoffDate = new Date(Date.now() - Math.max(1, Number(olderThanDays) || 2) * 24 * 3600 * 1000);
    const candidates = listVideosOlderThan(db, cutoffDate.toISOString());
    const workRootPath = path.resolve(getRepoRoot(), workRoot);
    const removedDirectories = [];
    const missingDirectories = [];

    for (const video of candidates) {
      const targetDir = path.resolve(workRootPath, video.bvid);
      if (!isSafeWorkSubpath(workRootPath, targetDir)) {
        continue;
      }

      if (!fs.existsSync(targetDir)) {
        missingDirectories.push(targetDir);
        continue;
      }

      onLog(`Removing old work directory ${targetDir}`);
      fs.rmSync(targetDir, { recursive: true, force: true });
      removedDirectories.push(targetDir);
    }

    return {
      cutoffIso: cutoffDate.toISOString(),
      removedDirectories,
      missingDirectories,
      candidates: candidates.map((item) => ({
        bvid: item.bvid,
        title: item.title,
        lastScanAt: item.last_scan_at,
        updatedAt: item.updated_at,
      })),
    };
  } finally {
    db.close?.();
  }
}

async function runPipelineForBvid({
  cookieFile,
  dbPath,
  workRoot,
  bvid,
  publish = true,
}) {
  const scriptPath = path.join(getRepoRoot(), "scripts", "run-video-pipeline.mjs");
  const args = [
    scriptPath,
    "--cookie-file",
    path.resolve(getRepoRoot(), cookieFile),
    "--bvid",
    bvid,
    "--db",
    path.resolve(getRepoRoot(), dbPath),
    "--work-root",
    workRoot,
  ];
  if (publish) {
    args.push("--publish");
  }
  const result = await runCommand(process.execPath, args, {
    streamOutput: true,
    outputStream: process.stderr,
  });

  try {
    return JSON.parse(result.stdout);
  } catch {
    return {
      ok: result.code === 0,
      rawStdout: result.stdout.trim(),
    };
  }
}

function readCookieString(cookieFile) {
  const resolvedPath = path.resolve(getRepoRoot(), cookieFile);
  return fs.readFileSync(resolvedPath, "utf8").trim();
}

function normalizePipelineUserKey(value) {
  const normalized = String(value ?? "").trim();
  return normalized || "__default__";
}

function extractBiliMid(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) {
    return null;
  }

  const directMatch = trimmed.match(/^\d+$/);
  if (directMatch) {
    return Number(directMatch[0]);
  }

  const urlMatch = trimmed.match(/space\.bilibili\.com\/(\d+)/i) ?? trimmed.match(/\/(\d+)(?:[/?#]|$)/);
  if (!urlMatch) {
    return null;
  }

  return Number(urlMatch[1]);
}

function isSafeWorkSubpath(workRootPath, targetPath) {
  const relativePath = path.relative(workRootPath, targetPath);
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}
