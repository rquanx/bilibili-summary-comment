import fs from "node:fs";
import path from "node:path";
import { getRepoRoot } from "../shared/runtime-tools";

const COMMENT_PUBLISH_QUEUE_LOCK_PREFIX = "bili-comment-publish";
const COMMENT_PUBLISH_QUEUE_MAX_CONCURRENCY = 2;
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
  fs.mkdirSync(lockRoot, { recursive: true });

  let waitLogged = false;

  while (true) {
    for (let slotIndex = 0; slotIndex < COMMENT_PUBLISH_QUEUE_MAX_CONCURRENCY; slotIndex += 1) {
      const lockPath = getCommentPublishQueueLockPath(lockRoot, slotIndex);
      try {
        fs.mkdirSync(lockPath);
        const ownerPath = path.join(lockPath, "owner.json");
        const writeHeartbeat = () => {
          fs.writeFileSync(ownerPath, `${JSON.stringify({
            pid: process.pid,
            queueName,
            slotIndex,
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
          slotIndex -= 1;
          continue;
        }
      }
    }

    if (!waitLogged) {
      const ownerLabel = formatQueueOwnerLabel(readCommentPublishQueueOwners(lockRoot));
      onLog(ownerLabel
        ? `${queueName} is waiting for the publish queue; current owners ${ownerLabel}`
        : `${queueName} is waiting for the publish queue`);
      waitLogged = true;
    }

    await delay(COMMENT_PUBLISH_QUEUE_WAIT_MS);
  }
}

function getCommentPublishQueueLockPath(lockRoot: string, slotIndex: number) {
  return path.join(lockRoot, `${COMMENT_PUBLISH_QUEUE_LOCK_PREFIX}.${slotIndex + 1}.lock`);
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

function readCommentPublishQueueOwners(lockRoot: string) {
  const owners: Record<string, unknown>[] = [];
  for (let slotIndex = 0; slotIndex < COMMENT_PUBLISH_QUEUE_MAX_CONCURRENCY; slotIndex += 1) {
    const owner = readCommentPublishQueueOwner(getCommentPublishQueueLockPath(lockRoot, slotIndex));
    if (owner) {
      owners.push(owner);
    }
  }
  return owners;
}

function formatQueueOwnerLabel(owners: Record<string, unknown>[] | Record<string, unknown> | null) {
  const normalizedOwners = Array.isArray(owners)
    ? owners
    : owners
      ? [owners]
      : [];
  if (normalizedOwners.length === 0) {
    return "";
  }

  return normalizedOwners.map((owner) => {
    const pid = Number(owner.pid);
    const slotIndex = Number(owner.slotIndex);
    const labelParts = [
      Number.isInteger(slotIndex) && slotIndex >= 0 ? `slot ${slotIndex + 1}` : "",
      typeof owner.task === "string" ? owner.task : "",
      typeof owner.bvid === "string" ? owner.bvid : "",
      Number.isInteger(pid) && pid > 0 ? `pid ${pid}` : "",
    ].filter(Boolean);
    return labelParts.join(", ");
  }).filter(Boolean).join("; ");
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
