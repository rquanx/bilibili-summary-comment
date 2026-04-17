import fs from "node:fs";
import path from "node:path";
import { replaceVideoSubtitlePathPrefix } from "../db/index";
import type { Db, VideoRecord } from "../db/index";
import { getRepoRoot } from "./runtime-tools";

const WINDOWS_RESERVED_SEGMENTS = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "COM1",
  "COM2",
  "COM3",
  "COM4",
  "COM5",
  "COM6",
  "COM7",
  "COM8",
  "COM9",
  "LPT1",
  "LPT2",
  "LPT3",
  "LPT4",
  "LPT5",
  "LPT6",
  "LPT7",
  "LPT8",
  "LPT9",
]);

type VideoWorkIdentity = Pick<VideoRecord, "bvid" | "title"> & Partial<Pick<VideoRecord, "id" | "owner_mid" | "owner_name" | "owner_dir_name" | "work_dir_name">>;

interface EnsureVideoWorkDirOptions {
  db?: Db | null;
  video: VideoWorkIdentity;
  workRoot?: string;
  repoRoot?: string;
  existsSync?: (targetPath: string) => boolean;
  mkdirSync?: (targetPath: string, options: { recursive: boolean }) => void;
  renameSync?: (fromPath: string, toPath: string) => void;
  replaceVideoSubtitlePathPrefixImpl?: typeof replaceVideoSubtitlePathPrefix;
}

export function sanitizeWorkPathSegment(value: unknown, fallback = "untitled", maxLength = 80): string {
  const normalized = String(value ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/[. ]+$/gu, "")
    .trim();

  const candidate = normalized || String(fallback ?? "").trim() || "untitled";
  let safeValue = candidate.slice(0, Math.max(1, maxLength)).replace(/[. ]+$/gu, "").trim();
  if (!safeValue) {
    safeValue = "untitled";
  }

  if (WINDOWS_RESERVED_SEGMENTS.has(safeValue.toUpperCase())) {
    safeValue = `${safeValue}_`;
  }

  return safeValue;
}

export function buildOwnerDirName({
  ownerName = null,
  ownerMid = null,
  existingOwnerDirName = null,
  existingVideos = [],
  currentVideoId = null,
}: {
  ownerName?: unknown;
  ownerMid?: unknown;
  existingOwnerDirName?: unknown;
  existingVideos?: Array<Partial<Pick<VideoRecord, "id" | "owner_mid" | "owner_name" | "owner_dir_name">>>;
  currentVideoId?: number | null;
} = {}): string {
  const persistedName = String(existingOwnerDirName ?? "").trim();
  if (persistedName) {
    return persistedName;
  }

  const normalizedMid = normalizeOwnerMid(ownerMid);
  const baseName = normalizedMid
    ? sanitizeWorkPathSegment(ownerName, `mid-${normalizedMid}`)
    : sanitizeWorkPathSegment(ownerName, "unknown-user");

  const hasConflict = existingVideos.some((video) => {
    if (Number(video.id ?? 0) === Number(currentVideoId ?? 0)) {
      return false;
    }

    return deriveComparableOwnerDirName(video) === baseName
      && normalizeOwnerMid(video.owner_mid) !== normalizedMid;
  });

  if (!hasConflict || !normalizedMid) {
    return baseName;
  }

  return sanitizeWorkPathSegment(`${baseName}__mid-${normalizedMid}`, `${baseName}-${normalizedMid}`);
}

export function buildVideoWorkDirName({
  title,
  bvid,
  ownerName = null,
  existingWorkDirName = null,
}: {
  title: unknown;
  bvid: unknown;
  ownerName?: unknown;
  existingWorkDirName?: unknown;
}): string {
  const persistedName = String(existingWorkDirName ?? "").trim();
  if (persistedName) {
    return persistedName;
  }

  const normalizedBvid = sanitizeWorkPathSegment(bvid, "unknown-bvid", 40);
  const compactTitle = normalizeVideoTitleSegment(stripOwnerPrefix(title, ownerName));
  return `${compactTitle || normalizedBvid}__${normalizedBvid}`;
}

export function resolveVideoWorkDir(video: VideoWorkIdentity, workRoot = "work", repoRoot = getRepoRoot()): string {
  const ownerDirName = String(video.owner_dir_name ?? "").trim()
    || buildOwnerDirName({
      ownerName: video.owner_name,
      ownerMid: video.owner_mid,
    });
  const workDirName = String(video.work_dir_name ?? "").trim()
    || buildVideoWorkDirName({
      title: video.title,
      bvid: video.bvid,
      ownerName: video.owner_name,
    });
  return path.join(repoRoot, workRoot, ownerDirName, workDirName);
}

export function listVideoWorkDirCandidates(video: VideoWorkIdentity, workRoot = "work", repoRoot = getRepoRoot()): string[] {
  const targetDir = resolveVideoWorkDir(video, workRoot, repoRoot);
  const legacyDirs = [
    path.join(repoRoot, workRoot, String(video.bvid ?? "").trim()),
    String(video.work_dir_name ?? "").trim() ? path.join(repoRoot, workRoot, String(video.work_dir_name).trim()) : null,
  ];

  return [...new Set([targetDir, ...legacyDirs].filter((item): item is string => Boolean(item)))];
}

export function ensureVideoWorkDir({
  db = null,
  video,
  workRoot = "work",
  repoRoot = getRepoRoot(),
  existsSync = fs.existsSync,
  mkdirSync = fs.mkdirSync,
  renameSync = fs.renameSync,
  replaceVideoSubtitlePathPrefixImpl = replaceVideoSubtitlePathPrefix,
}: EnsureVideoWorkDirOptions): string {
  const targetDir = resolveVideoWorkDir(video, workRoot, repoRoot);
  if (existsSync(targetDir)) {
    return targetDir;
  }

  mkdirSync(path.dirname(targetDir), { recursive: true });
  for (const candidateDir of listVideoWorkDirCandidates(video, workRoot, repoRoot)) {
    if (!candidateDir || samePath(candidateDir, targetDir) || !existsSync(candidateDir)) {
      continue;
    }

    renameSync(candidateDir, targetDir);
    if (db && Number(video.id ?? 0) > 0) {
      replaceVideoSubtitlePathPrefixImpl(db, Number(video.id), candidateDir, targetDir);
    }
    return targetDir;
  }

  mkdirSync(targetDir, { recursive: true });
  return targetDir;
}

function deriveComparableOwnerDirName(video: Partial<Pick<VideoRecord, "owner_mid" | "owner_name" | "owner_dir_name">>): string {
  return String(video.owner_dir_name ?? "").trim()
    || buildOwnerDirName({
      ownerName: video.owner_name,
      ownerMid: video.owner_mid,
    });
}

function normalizeOwnerMid(value: unknown): number | null {
  const numericValue = Number(value);
  return Number.isInteger(numericValue) && numericValue > 0 ? numericValue : null;
}

function stripOwnerPrefix(title: unknown, ownerName: unknown): string {
  const normalizedTitle = String(title ?? "").trim();
  const normalizedOwner = String(ownerName ?? "").trim();
  if (!normalizedOwner || !normalizedTitle.startsWith(normalizedOwner)) {
    return normalizedTitle;
  }

  return normalizedTitle
    .slice(normalizedOwner.length)
    .replace(/^[\s._-]+/u, "")
    .trim();
}

function normalizeVideoTitleSegment(value: unknown): string {
  const sanitized = sanitizeWorkPathSegment(value, "untitled-video");
  return sanitized
    .replace(/\s+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^[-.]+|[-.]+$/gu, "");
}

function samePath(leftPath: string, rightPath: string): boolean {
  return path.resolve(leftPath) === path.resolve(rightPath);
}
