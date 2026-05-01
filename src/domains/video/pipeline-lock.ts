import fs from "node:fs";
import path from "node:path";
import { getRepoRoot } from "../../shared/runtime-tools";

const VIDEO_PIPELINE_LOCK_HEARTBEAT_MS = 60_000;
const VIDEO_PIPELINE_LOCK_WAIT_MS = 5_000;
const VIDEO_PIPELINE_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

interface VideoPipelineLockOwner {
  pid: number | null;
  bvid: string;
  videoTitle: string;
  publishRequested: boolean;
  updatedAt: string;
}

interface WithVideoPipelineLockOptions {
  workRoot: string;
  bvid: string;
  videoTitle?: string | null;
  publishRequested?: boolean;
  progress?: { warn?: (message: string) => void } | null;
  eventLogger?: { log?: (event: any) => unknown } | null;
  repoRoot?: string;
  waitMs?: number;
  heartbeatMs?: number;
  staleMs?: number;
}

export async function withVideoPipelineLock<T>(
  {
    workRoot,
    bvid,
    videoTitle = null,
    publishRequested = false,
    progress = null,
    eventLogger = null,
    repoRoot = getRepoRoot(),
    waitMs = VIDEO_PIPELINE_LOCK_WAIT_MS,
    heartbeatMs = VIDEO_PIPELINE_LOCK_HEARTBEAT_MS,
    staleMs = VIDEO_PIPELINE_LOCK_STALE_MS,
  }: WithVideoPipelineLockOptions,
  task: () => Promise<T>,
) {
  const release = await acquireVideoPipelineLock({
    workRoot,
    bvid,
    videoTitle,
    publishRequested,
    progress,
    eventLogger,
    repoRoot,
    waitMs,
    heartbeatMs,
    staleMs,
  });

  try {
    return await task();
  } finally {
    release();
  }
}

async function acquireVideoPipelineLock({
  workRoot,
  bvid,
  videoTitle,
  publishRequested,
  progress,
  eventLogger,
  repoRoot,
  waitMs,
  heartbeatMs,
  staleMs,
}: Required<Omit<WithVideoPipelineLockOptions, "progress" | "eventLogger">> & {
  progress: { warn?: (message: string) => void } | null;
  eventLogger: { log?: (event: any) => unknown } | null;
}) {
  const lockRoot = path.join(repoRoot, workRoot, ".locks");
  const lockPath = path.join(lockRoot, `video-pipeline-${String(bvid).trim() || "unknown"}.lock`);
  fs.mkdirSync(lockRoot, { recursive: true });

  let waitLogged = false;

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      const ownerPath = path.join(lockPath, "owner.json");
      const writeHeartbeat = () => {
        const owner: VideoPipelineLockOwner = {
          pid: Number.isInteger(process.pid) && process.pid > 0 ? process.pid : null,
          bvid: String(bvid ?? "").trim(),
          videoTitle: String(videoTitle ?? "").trim(),
          publishRequested: Boolean(publishRequested),
          updatedAt: new Date().toISOString(),
        };
        fs.writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, "utf8");
      };

      writeHeartbeat();
      const heartbeat = setInterval(() => {
        try {
          writeHeartbeat();
        } catch {
          // Ignore heartbeat failures; stale cleanup handles abandoned locks.
        }
      }, heartbeatMs);

      return () => {
        clearInterval(heartbeat);
        fs.rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }

      if (isStaleVideoPipelineLock(lockPath, staleMs)) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }

      if (!waitLogged) {
        const owner = readVideoPipelineLockOwner(lockPath);
        const ownerLabel = formatVideoPipelineLockOwner(owner);
        const message = ownerLabel
          ? `Another pipeline run is in progress for ${bvid}; waiting for ${ownerLabel}`
          : `Another pipeline run is in progress for ${bvid}; waiting for the existing lock`;
        eventLogger?.log?.({
          scope: "pipeline",
          action: "queue",
          status: "waiting",
          message,
          details: {
            bvid,
            owner,
            publishRequested,
          },
        });
        progress?.warn?.(message);
        waitLogged = true;
      }

      await delay(waitMs);
    }
  }
}

function isStaleVideoPipelineLock(lockPath: string, staleMs: number) {
  const owner = readVideoPipelineLockOwner(lockPath);
  const ownerPid = Number(owner?.pid ?? 0);
  if (Number.isInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid)) {
    return true;
  }

  const ownerPath = path.join(lockPath, "owner.json");
  const statTarget = fs.existsSync(ownerPath) ? ownerPath : lockPath;

  try {
    const stats = fs.statSync(statTarget);
    return Date.now() - stats.mtimeMs > staleMs;
  } catch {
    return false;
  }
}

function readVideoPipelineLockOwner(lockPath: string): VideoPipelineLockOwner | null {
  const ownerPath = path.join(lockPath, "owner.json");
  if (!fs.existsSync(ownerPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(ownerPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<VideoPipelineLockOwner>;
    const pid = Number(parsed?.pid);
    return {
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
      bvid: String(parsed?.bvid ?? "").trim(),
      videoTitle: String(parsed?.videoTitle ?? "").trim(),
      publishRequested: Boolean(parsed?.publishRequested),
      updatedAt: String(parsed?.updatedAt ?? "").trim(),
    };
  } catch {
    return null;
  }
}

function formatVideoPipelineLockOwner(owner: VideoPipelineLockOwner | null) {
  if (!owner) {
    return "";
  }

  const mode = owner.publishRequested ? "publish run" : "summary run";
  const pid = Number(owner.pid);
  const parts = [
    owner.bvid || "",
    owner.videoTitle || "",
    mode,
    Number.isInteger(pid) && pid > 0 ? `pid ${pid}` : "",
  ].filter(Boolean);
  return parts.join(" | ");
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "EPERM") {
      return true;
    }

    return false;
  }
}

function delay(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
