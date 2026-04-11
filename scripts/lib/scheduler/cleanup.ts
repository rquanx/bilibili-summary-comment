import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db/database";
import { listVideosOlderThan } from "../db/video-storage";
import { getRepoRoot } from "../shared/runtime-tools";
import type { VideoRecord } from "../db/types";

type CleanupCandidate = Pick<VideoRecord, "bvid" | "title" | "last_scan_at" | "updated_at">;

interface CleanupOldWorkDirectoriesOptions {
  dbPath?: string;
  workRoot?: string;
  olderThanDays?: number;
  onLog?: (message: string) => void;
  openDatabaseImpl?: (databasePath: string) => Pick<DatabaseSync, "close">;
  listVideosOlderThanImpl?: (db: Pick<DatabaseSync, "close">, cutoffIso: string) => CleanupCandidate[];
  repoRoot?: string;
  existsSync?: (targetPath: string) => boolean;
  rmSync?: (targetPath: string, options: { recursive: boolean; force: boolean }) => void;
}

export async function cleanupOldWorkDirectories({
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
  olderThanDays = 2,
  onLog = () => {},
  openDatabaseImpl = openDatabase,
  listVideosOlderThanImpl = listVideosOlderThan,
  repoRoot = getRepoRoot(),
  existsSync = fs.existsSync,
  rmSync = fs.rmSync,
}: CleanupOldWorkDirectoriesOptions = {}) {
  const db = openDatabaseImpl(dbPath);
  try {
    const cutoffDate = new Date(Date.now() - Math.max(1, Number(olderThanDays) || 2) * 24 * 3600 * 1000);
    const candidates = listVideosOlderThanImpl(db, cutoffDate.toISOString());
    const workRootPath = path.resolve(repoRoot, workRoot);
    const removedDirectories: string[] = [];
    const missingDirectories: string[] = [];

    for (const video of candidates) {
      const targetDir = path.resolve(workRootPath, video.bvid);
      if (!isSafeWorkSubpath(workRootPath, targetDir)) {
        continue;
      }

      if (!existsSync(targetDir)) {
        missingDirectories.push(targetDir);
        continue;
      }

      onLog(`Removing old work directory ${targetDir}`);
      rmSync(targetDir, { recursive: true, force: true });
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

export function isSafeWorkSubpath(workRootPath: string, targetPath: string): boolean {
  const relativePath = path.relative(workRootPath, targetPath);
  return relativePath && !relativePath.startsWith("..") && !path.isAbsolute(relativePath);
}
