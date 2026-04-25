import fs from "node:fs";
import path from "node:path";
import { getRepoRoot } from "../shared/runtime-tools";

const COMMENT_PUBLISH_QUEUE_LOCK_NAME = "bili-comment-publish.lock";
const COMMENT_PUBLISH_QUEUE_HEARTBEAT_MS = 60_000;
const COMMENT_PUBLISH_QUEUE_WAIT_MS = 5_000;
const COMMENT_PUBLISH_QUEUE_STALE_MS = 6 * 60 * 60 * 1000;

export async function withCommentPublishQueueLock(
  {
    workRoot,
    queueName = "comment publish",
    onLog = () => {},
    ownerDetails = {},
  }: {
    workRoot: string;
    queueName?: string;
    onLog?: (message: string) => void;
    ownerDetails?: Record<string, unknown>;
  },
  task: () => Promise<unknown>,
) {
  const release = await acquireCommentPublishQueueLock({
    workRoot,
    queueName,
    onLog,
    ownerDetails,
  });

  try {
    return await task();
  } finally {
    release();
  }
}

async function acquireCommentPublishQueueLock({
  workRoot,
  queueName,
  onLog,
  ownerDetails,
}: {
  workRoot: string;
  queueName: string;
  onLog: (message: string) => void;
  ownerDetails: Record<string, unknown>;
}) {
  const lockRoot = path.join(getRepoRoot(), workRoot, ".locks");
  const lockPath = path.join(lockRoot, COMMENT_PUBLISH_QUEUE_LOCK_NAME);
  fs.mkdirSync(lockRoot, { recursive: true });

  let waitLogged = false;

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      const ownerPath = path.join(lockPath, "owner.json");
      const writeHeartbeat = () => {
        fs.writeFileSync(ownerPath, `${JSON.stringify({
          pid: process.pid,
          queueName,
          updatedAt: new Date().toISOString(),
          ...ownerDetails,
        }, null, 2)}\n`, "utf8");
      };

      writeHeartbeat();
      const heartbeat = setInterval(() => {
        try {
          writeHeartbeat();
        } catch {
          // Ignore heartbeat failures; stale cleanup handles abandoned locks.
        }
      }, COMMENT_PUBLISH_QUEUE_HEARTBEAT_MS);

      return () => {
        clearInterval(heartbeat);
        fs.rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }

      if (isStaleCommentPublishQueueLock(lockPath)) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }

      if (!waitLogged) {
        const owner = readCommentPublishQueueOwner(lockPath);
        const ownerLabel = formatQueueOwnerLabel(owner);
        onLog(ownerLabel
          ? `${queueName} is waiting for the publish queue; current owner ${ownerLabel}`
          : `${queueName} is waiting for the publish queue`);
        waitLogged = true;
      }

      await delay(COMMENT_PUBLISH_QUEUE_WAIT_MS);
    }
  }
}

function isStaleCommentPublishQueueLock(lockPath: string) {
  const owner = readCommentPublishQueueOwner(lockPath);
  const ownerPid = Number(owner?.pid ?? 0);
  if (Number.isInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid)) {
    return true;
  }

  const ownerPath = path.join(lockPath, "owner.json");
  const statTarget = fs.existsSync(ownerPath) ? ownerPath : lockPath;

  try {
    const stats = fs.statSync(statTarget);
    return Date.now() - stats.mtimeMs > COMMENT_PUBLISH_QUEUE_STALE_MS;
  } catch {
    return false;
  }
}

function readCommentPublishQueueOwner(lockPath: string): Record<string, unknown> | null {
  const ownerPath = path.join(lockPath, "owner.json");
  if (!fs.existsSync(ownerPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(ownerPath, "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const pid = Number(parsed?.pid);
    return {
      ...parsed,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    };
  } catch {
    return null;
  }
}

function formatQueueOwnerLabel(owner: Record<string, unknown> | null) {
  if (!owner) {
    return "";
  }

  const pid = Number(owner.pid);
  const labelParts = [
    typeof owner.task === "string" ? owner.task : "",
    typeof owner.bvid === "string" ? owner.bvid : "",
    Number.isInteger(pid) && pid > 0 ? `pid ${pid}` : "",
  ].filter(Boolean);

  return labelParts.join(", ");
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
