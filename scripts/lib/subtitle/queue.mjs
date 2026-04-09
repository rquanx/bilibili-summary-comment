import fs from "node:fs";
import path from "node:path";
import { getRepoRoot } from "../shared/runtime-tools.mjs";
import { delay, formatQueueOwnerLabel } from "./utils.mjs";

const TRANSCRIPTION_QUEUE_LOCK_NAME = "videocaptioner-asr.lock";
const TRANSCRIPTION_QUEUE_HEARTBEAT_MS = 60_000;
const TRANSCRIPTION_QUEUE_WAIT_MS = 5_000;
const TRANSCRIPTION_QUEUE_STALE_MS = 2 * 60 * 60 * 1000;

export async function withTranscriptionQueueLock(
  { workRoot, progress, bvid, videoTitle, pageNo, partTitle, engine, eventLogger, cid },
  task,
) {
  const release = await acquireTranscriptionQueueLock({
    workRoot,
    progress,
    bvid,
    videoTitle,
    pageNo,
    partTitle,
    engine,
    eventLogger,
    cid,
  });

  try {
    return await task();
  } finally {
    release();
  }
}

async function acquireTranscriptionQueueLock({ workRoot, progress, bvid, videoTitle, pageNo, partTitle, engine, eventLogger, cid }) {
  const lockRoot = path.join(getRepoRoot(), workRoot, ".locks");
  const lockPath = path.join(lockRoot, TRANSCRIPTION_QUEUE_LOCK_NAME);
  fs.mkdirSync(lockRoot, { recursive: true });

  let waitLogged = false;

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      const ownerPath = path.join(lockPath, "owner.json");
      const writeHeartbeat = () => {
        fs.writeFileSync(ownerPath, `${JSON.stringify({
          pid: process.pid,
          engine,
          bvid,
          videoTitle,
          pageNo,
          partTitle,
          updatedAt: new Date().toISOString(),
        }, null, 2)}\n`, "utf8");
      };

      writeHeartbeat();
      const heartbeat = setInterval(() => {
        try {
          writeHeartbeat();
        } catch {
          // Ignore heartbeat failures; stale cleanup will handle abandoned locks.
        }
      }, TRANSCRIPTION_QUEUE_HEARTBEAT_MS);

      return () => {
        clearInterval(heartbeat);
        fs.rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      if (isStaleTranscriptionQueueLock(lockPath)) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }

      if (!waitLogged) {
        const owner = readTranscriptionQueueOwner(lockPath);
        const ownerLabel = formatQueueOwnerLabel(owner);
        eventLogger?.log({
          scope: "subtitle",
          action: "queue",
          status: "waiting",
          pageNo,
          cid,
          partTitle,
          message: ownerLabel
            ? `ASR ${engine} is waiting for the transcription queue; current owner ${ownerLabel}`
            : `ASR ${engine} is waiting for the transcription queue`,
          details: {
            engine,
            owner,
          },
        });
        progress?.logPartStage?.(
          pageNo,
          "Subtitle",
          ownerLabel
            ? `ASR ${engine} is waiting for the transcription queue, current owner ${ownerLabel}`
            : `ASR ${engine} is waiting for the transcription queue`,
        );
        waitLogged = true;
      }

      await delay(TRANSCRIPTION_QUEUE_WAIT_MS);
    }
  }
}

function isStaleTranscriptionQueueLock(lockPath) {
  const owner = readTranscriptionQueueOwner(lockPath);
  if (owner?.pid && !isProcessAlive(owner.pid)) {
    return true;
  }

  const ownerPath = path.join(lockPath, "owner.json");
  const statTarget = fs.existsSync(ownerPath) ? ownerPath : lockPath;

  try {
    const stats = fs.statSync(statTarget);
    return Date.now() - stats.mtimeMs > TRANSCRIPTION_QUEUE_STALE_MS;
  } catch {
    return false;
  }
}

function readTranscriptionQueueOwner(lockPath) {
  const ownerPath = path.join(lockPath, "owner.json");
  if (!fs.existsSync(ownerPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(ownerPath, "utf8");
    const parsed = JSON.parse(raw);
    const pid = Number(parsed?.pid);
    return {
      ...parsed,
      pid: Number.isInteger(pid) && pid > 0 ? pid : null,
    };
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "EPERM") {
      return true;
    }

    return false;
  }
}
