import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getRepoRoot } from "./runtime-tools";

export const RUNTIME_LOCK_HEARTBEAT_MS = 30_000;
export const VIDEO_PIPELINE_LOCK_WAIT_MS = 5_000;
export const VIDEO_PIPELINE_LOCK_STALE_MS = 10 * 60_000;
export const TRANSCRIPTION_QUEUE_WAIT_MS = 5_000;
export const TRANSCRIPTION_QUEUE_STALE_MS = 10 * 60_000;
export const COMMENT_PUBLISH_QUEUE_WAIT_MS = 5_000;
export const COMMENT_PUBLISH_QUEUE_STALE_MS = 10 * 60_000;
export const DB_WRITE_LOCK_RETRY_MS = 100;
export const DB_WRITE_LOCK_TIMEOUT_MS = 60_000;
export const DB_WRITE_LOCK_STALE_MS = 2 * 60_000;
export const PASTE_RS_RATE_LIMIT_STALE_MS = Math.max(
  1_000,
  Number(process.env.PASTE_RS_RATE_LIMIT_STALE_MS) || 10_000,
);

interface LockCandidate {
  path: string;
  ownerPath: string;
  staleMs: number;
  name: string;
}

export interface RuntimeLockCleanupEntry {
  name: string;
  path: string;
  reason: "dead-pid" | "stale-age";
}

export interface ProcessLockOwner {
  pid: number | null;
  hostname: string;
}

export function createProcessLockOwner(): ProcessLockOwner {
  return {
    pid: Number.isInteger(process.pid) && process.pid > 0 ? process.pid : null,
    hostname: os.hostname(),
  };
}

export function isOwnerProcessAlive(
  owner: { pid?: unknown; hostname?: unknown } | null | undefined,
  {
    currentHostname = os.hostname(),
    isProcessAlive = defaultIsProcessAlive,
  }: {
    currentHostname?: string;
    isProcessAlive?: (pid: number) => boolean;
  } = {},
): boolean | null {
  const ownerPid = normalizePid(owner?.pid);
  if (!ownerPid) {
    return null;
  }

  const ownerHostname = normalizeHostname(owner?.hostname);
  if (ownerHostname && currentHostname && ownerHostname !== currentHostname) {
    return null;
  }

  return isProcessAlive(ownerPid);
}

export function cleanupStaleRuntimeLocks({
  repoRoot = getRepoRoot(),
  workRoot = "work",
  dbPath = path.join(workRoot, "pipeline.sqlite3"),
  currentHostname = os.hostname(),
  nowMs = Date.now(),
}: {
  repoRoot?: string;
  workRoot?: string;
  dbPath?: string;
  currentHostname?: string;
  nowMs?: number;
} = {}) {
  const lockRoot = path.join(repoRoot, workRoot, ".locks");
  const candidates: LockCandidate[] = [];

  if (fs.existsSync(lockRoot)) {
    for (const entry of fs.readdirSync(lockRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.endsWith(".lock")) {
        continue;
      }

      const staleMs = resolveWorkLockStaleMs(entry.name);
      if (!staleMs) {
        continue;
      }

      const lockPath = path.join(lockRoot, entry.name);
      candidates.push({
        path: lockPath,
        ownerPath: path.join(lockPath, "owner.json"),
        staleMs,
        name: entry.name,
      });
    }
  }

  const resolvedDbPath = path.resolve(repoRoot, dbPath);
  candidates.push({
    path: `${resolvedDbPath}.write-lock`,
    ownerPath: path.join(`${resolvedDbPath}.write-lock`, "owner.json"),
    staleMs: DB_WRITE_LOCK_STALE_MS,
    name: path.basename(`${resolvedDbPath}.write-lock`),
  });

  return cleanupLockCandidates(candidates, {
    currentHostname,
    nowMs,
  });
}

export function cleanupStaleDatabaseWriteLock(databasePath: string) {
  const resolvedPath = path.resolve(databasePath);
  return cleanupLockCandidates([{
    path: `${resolvedPath}.write-lock`,
    ownerPath: path.join(`${resolvedPath}.write-lock`, "owner.json"),
    staleMs: DB_WRITE_LOCK_STALE_MS,
    name: path.basename(`${resolvedPath}.write-lock`),
  }], {
    currentHostname: os.hostname(),
    nowMs: Date.now(),
  });
}

function cleanupLockCandidates(
  candidates: LockCandidate[],
  {
    currentHostname,
    nowMs,
  }: {
    currentHostname: string;
    nowMs: number;
  },
) {
  const removed: RuntimeLockCleanupEntry[] = [];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate.path)) {
      continue;
    }

    const reason = getStaleLockReason(candidate, {
      currentHostname,
      nowMs,
    });
    if (!reason) {
      continue;
    }

    fs.rmSync(candidate.path, { recursive: true, force: true });
    removed.push({
      name: candidate.name,
      path: candidate.path,
      reason,
    });
  }

  return {
    removed,
  };
}

function getStaleLockReason(
  candidate: LockCandidate,
  {
    currentHostname,
    nowMs,
  }: {
    currentHostname: string;
    nowMs: number;
  },
): RuntimeLockCleanupEntry["reason"] | null {
  const owner = readLockOwner(candidate.ownerPath);
  const ownerAlive = isOwnerProcessAlive(owner, { currentHostname });
  if (ownerAlive === false) {
    return "dead-pid";
  }

  const statTarget = fs.existsSync(candidate.ownerPath)
    ? candidate.ownerPath
    : candidate.path;

  try {
    const stats = fs.statSync(statTarget);
    return nowMs - stats.mtimeMs > candidate.staleMs ? "stale-age" : null;
  } catch {
    return null;
  }
}

function resolveWorkLockStaleMs(lockName: string): number | null {
  if (lockName === "videocaptioner-asr.lock") {
    return TRANSCRIPTION_QUEUE_STALE_MS;
  }

  if (lockName === "paste-rs-rate-limit.lock") {
    return PASTE_RS_RATE_LIMIT_STALE_MS;
  }

  if (lockName.startsWith("video-pipeline-")) {
    return VIDEO_PIPELINE_LOCK_STALE_MS;
  }

  if (lockName.startsWith("bili-comment-publish.")) {
    return COMMENT_PUBLISH_QUEUE_STALE_MS;
  }

  return null;
}

function readLockOwner(ownerPath: string): Record<string, unknown> | null {
  if (!fs.existsSync(ownerPath)) {
    return null;
  }

  try {
    const raw = fs.readFileSync(ownerPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function normalizePid(value: unknown): number | null {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function normalizeHostname(value: unknown): string {
  return String(value ?? "").trim();
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
