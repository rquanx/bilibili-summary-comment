import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUTH_FILE, readCookieStringFromAuthFile } from "../bili/auth";
import { createClient } from "../bili/comment-utils";
import { hasGapNotification, openDatabase, saveGapNotification } from "../db/index";
import { getRepoRoot } from "../shared/runtime-tools";
import { formatErrorMessage } from "../subtitle/utils";
import { sendServerChanNotification } from "../subtitle/notifier";
import { fetchVideoSnapshot } from "../video/index";
import { EAST_8_TIMEZONE, compareTimestampDesc, formatDateInTimeZone, formatEast8Timestamp } from "../shared/time";
import { collectRecentUploadsFromUsers } from "./uploads";

const PART_TIMESTAMP_RE = /^(?<title>.*?)(?<date>\d{4}\.\d{2}\.\d{2})\s+(?<time>\d{2}\.\d{2}\.\d{2})\s*$/u;

export const DEFAULT_GAP_CHECK_SINCE_HOURS = 24;
export const DEFAULT_GAP_THRESHOLD_SECONDS = 5;

interface GapCheckVideoPart {
  pageNo: number;
  cid: number;
  partTitle: string;
  durationSec: number;
}

interface ParsedGapCheckPart extends GapCheckVideoPart {
  startAtMs: number;
  startAtText: string;
  endAtMs: number;
  endAtText: string;
}

export interface GapRecord {
  gapKey: string;
  bvid: string;
  title: string;
  fromPageNo: number;
  fromCid: number;
  fromPartTitle: string;
  fromEndAt: string;
  toPageNo: number;
  toCid: number;
  toPartTitle: string;
  toStartAt: string;
  gapSeconds: number;
}

export interface GapCheckDailyVideoRecord {
  bvid: string;
  title: string;
  checkedAt: string;
  gapCount: number;
  gaps: GapRecord[];
  error?: string | null;
}

export interface GapCheckDailySnapshot {
  date: string;
  updatedAt: string;
  videos: GapCheckDailyVideoRecord[];
}

interface GapCheckRunResult {
  summaryUsers: Array<{ mid: number; source: string }>;
  uploads: Array<{ bvid: string; title: string; mid: number; createdAt: string }>;
  checkedVideos: GapCheckDailyVideoRecord[];
  newGaps: GapRecord[];
  alreadyNotifiedGapCount: number;
  notifiedGapCount: number;
  notificationSent: boolean;
  snapshotPath: string | null;
}

interface RunRecentVideoGapCheckOptions {
  summaryUsers?: unknown;
  authFile?: string;
  cookieFile?: string;
  dbPath?: string;
  workRoot?: string;
  sinceHours?: number;
  gapThresholdSeconds?: number;
  timezone?: string | null;
  onLog?: (message: string) => void;
  now?: Date;
  repoRoot?: string;
  collectRecentUploadsImpl?: typeof collectRecentUploadsFromUsers;
  readCookieStringFromAuthFileImpl?: typeof readCookieStringFromAuthFile;
  createClientImpl?: typeof createClient;
  fetchVideoSnapshotImpl?: typeof fetchVideoSnapshot;
  openDatabaseImpl?: typeof openDatabase;
  hasGapNotificationImpl?: typeof hasGapNotification;
  saveGapNotificationImpl?: typeof saveGapNotification;
  notifyNewGapsImpl?: typeof notifyGapCheckReport;
  upsertDailySnapshotImpl?: typeof upsertGapCheckDailySnapshot;
}

interface DailySnapshotUpdateOptions {
  workRoot?: string;
  repoRoot?: string;
  timezone?: string | null;
  now?: Date;
  videoRecord: GapCheckDailyVideoRecord;
  existsSync?: typeof fs.existsSync;
  readFileSync?: typeof fs.readFileSync;
  mkdirSync?: typeof fs.mkdirSync;
  writeFileSync?: typeof fs.writeFileSync;
}

export async function runRecentVideoGapCheck({
  summaryUsers,
  authFile = DEFAULT_AUTH_FILE,
  cookieFile = undefined,
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
  sinceHours = DEFAULT_GAP_CHECK_SINCE_HOURS,
  gapThresholdSeconds = DEFAULT_GAP_THRESHOLD_SECONDS,
  timezone = null,
  onLog = () => {},
  now = new Date(),
  repoRoot = getRepoRoot(),
  collectRecentUploadsImpl = collectRecentUploadsFromUsers,
  readCookieStringFromAuthFileImpl = readCookieStringFromAuthFile,
  createClientImpl = createClient,
  fetchVideoSnapshotImpl = fetchVideoSnapshot,
  openDatabaseImpl = openDatabase,
  hasGapNotificationImpl = hasGapNotification,
  saveGapNotificationImpl = saveGapNotification,
  notifyNewGapsImpl = notifyGapCheckReport,
  upsertDailySnapshotImpl = upsertGapCheckDailySnapshot,
}: RunRecentVideoGapCheckOptions = {}): Promise<GapCheckRunResult> {
  const collected = await collectRecentUploadsImpl({
    summaryUsers,
    authFile,
    cookieFile,
    sinceHours,
    onLog,
  });
  if (collected.summaryUsers.length === 0) {
    return {
      summaryUsers: [],
      uploads: [],
      checkedVideos: [],
      newGaps: [],
      alreadyNotifiedGapCount: 0,
      notifiedGapCount: 0,
      notificationSent: false,
      snapshotPath: null,
    };
  }

  if (collected.uploads.length === 0) {
    onLog("No uploads found within the recent gap-check window");
    return {
      summaryUsers: collected.summaryUsers,
      uploads: [],
      checkedVideos: [],
      newGaps: [],
      alreadyNotifiedGapCount: 0,
      notifiedGapCount: 0,
      notificationSent: false,
      snapshotPath: null,
    };
  }

  const db = openDatabaseImpl(path.resolve(repoRoot, dbPath));
  const checkedVideos: GapCheckDailyVideoRecord[] = [];
  const newGaps: GapRecord[] = [];
  let alreadyNotifiedGapCount = 0;
  let snapshotPath: string | null = null;
  const clientCache = new Map<string, ReturnType<typeof createClient>>();

  try {
    for (const upload of collected.uploads) {
      onLog(`Checking recent upload for missing gaps: ${upload.bvid} (${upload.title || "untitled"})`);
      const uploadAuthFile = String(upload.authFile ?? authFile).trim();
      const clientKey = `auth:${uploadAuthFile}`;
      let client = clientCache.get(clientKey);
      if (!client) {
        client = createClientImpl(readCookieStringFromAuthFileImpl(uploadAuthFile));
        clientCache.set(clientKey, client);
      }

      let videoRecord: GapCheckDailyVideoRecord;
      try {
        const snapshot = await fetchVideoSnapshotImpl(client, {
          bvid: upload.bvid,
        });
        const gaps = detectGapsFromVideoSnapshot(snapshot, gapThresholdSeconds);
        for (const gap of gaps) {
          if (hasGapNotificationImpl(db, gap.gapKey)) {
            alreadyNotifiedGapCount += 1;
            continue;
          }

          newGaps.push(gap);
        }

        videoRecord = {
          bvid: snapshot.bvid,
          title: String(snapshot.title ?? "").trim() || upload.title || upload.bvid,
          checkedAt: formatEast8Timestamp(now),
          gapCount: gaps.length,
          gaps,
        };
        onLog(
          gaps.length > 0
            ? `Detected ${gaps.length} gap(s) for ${snapshot.bvid}`
            : `No gaps detected for ${snapshot.bvid}`,
        );
      } catch (error) {
        const message = formatErrorMessage(error);
        onLog(`Gap check failed for ${upload.bvid}: ${message}`);
        videoRecord = {
          bvid: upload.bvid,
          title: String(upload.title ?? "").trim() || upload.bvid,
          checkedAt: formatEast8Timestamp(now),
          gapCount: 0,
          gaps: [],
          error: message,
        };
      }

      snapshotPath = upsertDailySnapshotImpl({
        workRoot,
        repoRoot,
        timezone,
        now,
        videoRecord,
      });
      checkedVideos.push(videoRecord);
    }

    let notificationSent = false;
    let notifiedGapCount = 0;
    if (newGaps.length > 0) {
      const notifyResult = await notifyNewGapsImpl({
        gaps: newGaps,
        onLog,
      });
      notificationSent = notifyResult.sent;
      if (notifyResult.sent) {
        for (const gap of newGaps) {
          saveGapNotificationImpl(db, {
            gapKey: gap.gapKey,
            bvid: gap.bvid,
            videoTitle: gap.title,
            fromPageNo: gap.fromPageNo,
            fromCid: gap.fromCid,
            toPageNo: gap.toPageNo,
            toCid: gap.toCid,
            gapStartAt: gap.fromEndAt,
            gapEndAt: gap.toStartAt,
            gapSeconds: gap.gapSeconds,
          });
          notifiedGapCount += 1;
        }
      }
    } else {
      onLog("No newly discovered gaps need notifications");
    }

    return {
      summaryUsers: collected.summaryUsers,
      uploads: collected.uploads.map((upload) => ({
        bvid: upload.bvid,
        title: upload.title,
        mid: upload.mid,
        createdAt: upload.createdAt,
      })),
      checkedVideos,
      newGaps,
      alreadyNotifiedGapCount,
      notifiedGapCount,
      notificationSent,
      snapshotPath,
    };
  } finally {
    db.close?.();
  }
}

export function detectGapsFromVideoSnapshot(
  snapshot: {
    bvid: string;
    title: string;
    pages: GapCheckVideoPart[];
  },
  gapThresholdSeconds = DEFAULT_GAP_THRESHOLD_SECONDS,
): GapRecord[] {
  const thresholdMs = Math.max(0, Number(gapThresholdSeconds) || DEFAULT_GAP_THRESHOLD_SECONDS) * 1000;
  const parsedParts = (Array.isArray(snapshot.pages) ? snapshot.pages : [])
    .map((page) => parseGapCheckPart(page))
    .sort((left, right) => left.startAtMs - right.startAtMs || left.pageNo - right.pageNo);
  const gaps: GapRecord[] = [];

  for (let index = 0; index < parsedParts.length - 1; index += 1) {
    const current = parsedParts[index];
    const next = parsedParts[index + 1];
    const gapMs = next.startAtMs - current.endAtMs;
    if (gapMs <= thresholdMs) {
      continue;
    }

    const gapSeconds = Math.floor(gapMs / 1000);
    gaps.push({
      gapKey: createGapKey({
        bvid: snapshot.bvid,
        fromCid: current.cid,
        toCid: next.cid,
        gapStartAt: current.endAtText,
        gapEndAt: next.startAtText,
        gapSeconds,
      }),
      bvid: snapshot.bvid,
      title: String(snapshot.title ?? "").trim() || snapshot.bvid,
      fromPageNo: current.pageNo,
      fromCid: current.cid,
      fromPartTitle: current.partTitle,
      fromEndAt: current.endAtText,
      toPageNo: next.pageNo,
      toCid: next.cid,
      toPartTitle: next.partTitle,
      toStartAt: next.startAtText,
      gapSeconds,
    });
  }

  return gaps;
}

export function parseGapCheckPart(part: GapCheckVideoPart): ParsedGapCheckPart {
  const pageNo = normalizePositiveInteger(part.pageNo, "pageNo");
  const cid = normalizePositiveInteger(part.cid, "cid");
  const partTitle = String(part.partTitle ?? "").trim();
  const durationSec = normalizeNonNegativeInteger(part.durationSec, "durationSec");
  const parsedTimestamp = parsePartTitleTimestamp(partTitle);
  const endAtMs = parsedTimestamp.startAtMs + durationSec * 1000;

  return {
    pageNo,
    cid,
    partTitle,
    durationSec,
    startAtMs: parsedTimestamp.startAtMs,
    startAtText: parsedTimestamp.formattedText,
    endAtMs,
    endAtText: formatTimestampMs(endAtMs),
  };
}

export function createGapKey({
  bvid,
  fromCid,
  toCid,
  gapStartAt,
  gapEndAt,
  gapSeconds,
}: {
  bvid: string;
  fromCid: number;
  toCid: number;
  gapStartAt: string;
  gapEndAt: string;
  gapSeconds: number;
}) {
  return [
    String(bvid ?? "").trim(),
    normalizePositiveInteger(fromCid, "fromCid"),
    normalizePositiveInteger(toCid, "toCid"),
    String(gapStartAt ?? "").trim(),
    String(gapEndAt ?? "").trim(),
    normalizeNonNegativeInteger(gapSeconds, "gapSeconds"),
  ].join("|");
}

export async function notifyGapCheckReport({
  gaps,
  onLog = () => {},
}: {
  gaps: GapRecord[];
  onLog?: (message: string) => void;
}) {
  if (!Array.isArray(gaps) || gaps.length === 0) {
    return {
      sent: false,
      skipped: true,
      reason: "empty-gaps",
    } as const;
  }

  const payload = buildGapCheckNotification(gaps);
  try {
    const result = await sendServerChanNotification(payload);
    if (result.skipped) {
      onLog("SERVER_CHAN_SEND_KEY is not configured, skipping gap-check notification");
      return {
        sent: false,
        skipped: true,
        reason: "missing-send-key",
      } as const;
    }

    onLog(`Sent gap-check notification for ${gaps.length} new gap(s)`);
    return {
      sent: true,
      skipped: false,
    } as const;
  } catch (error) {
    onLog(`Failed to send gap-check notification: ${formatErrorMessage(error)}`);
    return {
      sent: false,
      skipped: false,
      reason: "send-failed",
      error,
    } as const;
  }
}

export function buildGapCheckNotification(gaps: GapRecord[]) {
  const videos = new Map<string, GapRecord[]>();
  for (const gap of gaps) {
    const key = `${gap.bvid}\n${gap.title}`;
    const bucket = videos.get(key) ?? [];
    bucket.push(gap);
    videos.set(key, bucket);
  }

  const title = `稿件缺段提醒 ${videos.size}稿 ${gaps.length}处`;
  const lines: string[] = [
    `发现 ${videos.size} 条稿件存在新的缺段，共 ${gaps.length} 处。`,
    "",
  ];

  for (const [videoKey, videoGaps] of videos.entries()) {
    const [bvid, titleText] = videoKey.split("\n");
    lines.push(`## ${titleText}`);
    lines.push(`- 稿件: ${bvid}`);
    for (const gap of videoGaps) {
      lines.push(
        `- 缺段 ${formatDurationSeconds(gap.gapSeconds)} | P${gap.fromPageNo} ${gap.fromEndAt} -> P${gap.toPageNo} ${gap.toStartAt}`,
      );
    }
    lines.push("");
  }

  return {
    title,
    desp: lines.join("\n").trim(),
  };
}

export function upsertGapCheckDailySnapshot({
  workRoot = "work",
  repoRoot = getRepoRoot(),
  timezone = null,
  now = new Date(),
  videoRecord,
  existsSync = fs.existsSync,
  readFileSync = fs.readFileSync,
  mkdirSync = fs.mkdirSync,
  writeFileSync = fs.writeFileSync,
}: DailySnapshotUpdateOptions) {
  const date = formatDateKey(now, timezone);
  const snapshotPath = path.join(repoRoot, workRoot, "logs", "gap-check", `${date}.json`);
  const snapshotDir = path.dirname(snapshotPath);
  mkdirSync(snapshotDir, { recursive: true });

  const snapshot = readGapCheckDailySnapshot(snapshotPath, date, {
    existsSync,
    readFileSync,
  });
  const videos = new Map(snapshot.videos.map((item) => [item.bvid, item] as const));
  videos.set(videoRecord.bvid, normalizeDailyVideoRecord(videoRecord));

  const nextSnapshot: GapCheckDailySnapshot = {
    date,
    updatedAt: formatEast8Timestamp(now),
    videos: Array.from(videos.values()).sort((left, right) => {
      const checkedAtDiff = compareTimestampDesc(left.checkedAt, right.checkedAt);
      if (checkedAtDiff !== 0) {
        return checkedAtDiff;
      }

      return left.bvid.localeCompare(right.bvid);
    }),
  };
  writeFileSync(snapshotPath, `${JSON.stringify(nextSnapshot, null, 2)}\n`, "utf8");
  return snapshotPath;
}

export function readGapCheckDailySnapshot(
  snapshotPath: string,
  date: string,
  {
    existsSync = fs.existsSync,
    readFileSync = fs.readFileSync,
  }: {
    existsSync?: typeof fs.existsSync;
    readFileSync?: typeof fs.readFileSync;
  } = {},
): GapCheckDailySnapshot {
  if (!existsSync(snapshotPath)) {
    return {
      date,
      updatedAt: "",
      videos: [],
    };
  }

  try {
    const parsed = JSON.parse(readFileSync(snapshotPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || parsed.date !== date || !Array.isArray(parsed.videos)) {
      return {
        date,
        updatedAt: "",
        videos: [],
      };
    }

    return {
      date,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      videos: parsed.videos.map((item) => normalizeDailyVideoRecord(item)),
    };
  } catch {
    return {
      date,
      updatedAt: "",
      videos: [],
    };
  }
}

function normalizeDailyVideoRecord(value: unknown): GapCheckDailyVideoRecord {
  const candidate = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const gaps = Array.isArray(candidate.gaps)
    ? candidate.gaps
        .filter((item): item is GapRecord => Boolean(item && typeof item === "object"))
        .map((item) => ({
          gapKey: String(item.gapKey ?? "").trim(),
          bvid: String(item.bvid ?? "").trim(),
          title: String(item.title ?? "").trim(),
          fromPageNo: normalizePositiveInteger(item.fromPageNo, "fromPageNo"),
          fromCid: normalizePositiveInteger(item.fromCid, "fromCid"),
          fromPartTitle: String(item.fromPartTitle ?? "").trim(),
          fromEndAt: String(item.fromEndAt ?? "").trim(),
          toPageNo: normalizePositiveInteger(item.toPageNo, "toPageNo"),
          toCid: normalizePositiveInteger(item.toCid, "toCid"),
          toPartTitle: String(item.toPartTitle ?? "").trim(),
          toStartAt: String(item.toStartAt ?? "").trim(),
          gapSeconds: normalizeNonNegativeInteger(item.gapSeconds, "gapSeconds"),
        }))
    : [];

  return {
    bvid: String(candidate.bvid ?? "").trim(),
    title: String(candidate.title ?? "").trim(),
    checkedAt: String(candidate.checkedAt ?? "").trim(),
    gapCount: Number.isInteger(Number(candidate.gapCount)) ? Number(candidate.gapCount) : gaps.length,
    gaps,
    error: candidate.error === undefined || candidate.error === null ? null : String(candidate.error),
  };
}

function parsePartTitleTimestamp(partTitle: string) {
  const match = PART_TIMESTAMP_RE.exec(partTitle);
  if (!match?.groups) {
    throw new Error(`Unable to parse part title timestamp: ${partTitle || "<empty>"}`);
  }

  const datePart = match.groups.date;
  const timePart = match.groups.time;
  const [year, month, day] = datePart.split(".").map((value) => Number(value));
  const [hour, minute, second] = timePart.split(".").map((value) => Number(value));
  const startAtMs = Date.UTC(year, month - 1, day, hour, minute, second);
  if (Number.isNaN(startAtMs)) {
    throw new Error(`Invalid part title timestamp: ${partTitle || "<empty>"}`);
  }

  return {
    startAtMs,
    formattedText: `${datePart.replace(/\./g, "-")} ${timePart.replace(/\./g, ":")}`,
  };
}

function formatTimestampMs(timestampMs: number) {
  const date = new Date(timestampMs);
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-")
    + ` ${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`;
}

function formatDateKey(date: Date, timezone: string | null | undefined) {
  return formatDateInTimeZone(date, timezone || EAST_8_TIMEZONE);
}

function formatDurationSeconds(totalSeconds: number) {
  const normalized = Math.max(0, normalizeNonNegativeInteger(totalSeconds, "totalSeconds"));
  const hours = Math.floor(normalized / 3600);
  const minutes = Math.floor((normalized % 3600) / 60);
  const seconds = normalized % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function normalizePositiveInteger(value: unknown, fieldName: string) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Invalid positive integer field: ${fieldName}`);
  }

  return normalized;
}

function normalizeNonNegativeInteger(value: unknown, fieldName: string) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized < 0) {
    throw new Error(`Invalid non-negative integer field: ${fieldName}`);
  }

  return normalized;
}
