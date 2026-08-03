import fs from "node:fs";
import path from "node:path";
import { getGuestTopComment } from "../bili/comment-thread";
import { createClient } from "../bili/comment-utils";
import { DEFAULT_AUTH_FILE, readCookieStringFromAuthFile } from "../bili/auth";
import { parseSummaryBlocks } from "../summary/format";
import { formatErrorMessage } from "../subtitle/utils";
import { formatDateInTimeZone, EAST_8_TIMEZONE } from "../../shared/time";
import { getRepoRoot } from "../../shared/runtime-tools";
import {
  createProcessLockOwner,
  isOwnerProcessAlive,
  RUNTIME_LOCK_HEARTBEAT_MS,
  resolveHeartbeatLockStaleMs,
} from "../../shared/runtime-locks";
import { buildAuthFileCandidates, findAuthFileForUser } from "./auth-files";
import { runPipelinesWithConcurrency } from "./concurrency";
import type { PipelineTaskRunner } from "./concurrency";
import { runPipelineForBvid } from "./pipeline-runner";
import { parseSummaryUsers } from "./user-targets";
import type { FileLogger } from "../../shared/logger";
import type { PipelineProcessResult } from "./pipeline-runner";
import type { RecentUpload } from "./uploads";
import type { SummaryUserTarget } from "./user-targets";

export const DEFAULT_HISTORICAL_SUMMARY_DAILY_LIMIT = 200;
export const DEFAULT_HISTORICAL_SUMMARY_CONCURRENCY = 2;
export const DEFAULT_HISTORICAL_REQUEST_DELAY_MS = 2_000;
const HISTORICAL_UPLOAD_PAGE_SIZE = 30;
const HISTORICAL_MAX_PAGES_PER_USER = 200;
const HISTORICAL_CURSOR_VERSION = 2;
const HISTORICAL_LOCK_STALE_MS = 10 * 60_000;
const BILI_RISK_CONTROL_CODE = -352;

interface HistoricalSummaryCursor {
  version: number;
  targetDate: string;
  pageHints: Record<string, number>;
  nextPageHints: Record<string, number>;
  pendingUploads: HistoricalCursorUpload[] | null;
  completedBvids: string[];
  quotaDate: string;
  quotaUsed: number;
  nextProcessAt: string | null;
  updatedAt: string;
}

interface HistoricalCursorUpload {
  mid: number;
  bvid: string;
  aid: number | null;
  title: string;
  authFile: string | null;
  createdAtUnix: number;
  createdAt: string;
  source: string;
}

interface HistoricalUserScan {
  target: SummaryUserTarget;
  authFile: string;
  client: ReturnType<typeof createClient>;
  page: number;
  pagesFetched: number;
  firstTargetPage: number | null;
  firstOlderPage: number | null;
  done: boolean;
  blocked: boolean;
}

interface HistoricalScanResult {
  uploads: RecentUpload[];
  blockedMids: number[];
  currentPageHints: Record<string, number>;
  nextPageHints: Record<string, number>;
}

interface HistoricalPipelineResult {
  status: "processed" | "pinned-summary" | "quota-exhausted";
  upload: RecentUpload;
  result?: PipelineProcessResult;
  topCommentRpid?: number | null;
}

interface RunHistoricalSummaryBackfillOptions {
  summaryUsers?: unknown;
  authFile?: string;
  dbPath?: string;
  workRoot?: string;
  cursorPath?: string | null;
  timezone?: string | null;
  dailyLimit?: number;
  maxConcurrent?: number;
  requestDelayMs?: number;
  maxPipelineStartsPerRun?: number;
  logDay?: string | null;
  logGroup?: string | null;
  logger?: FileLogger | null;
  onLog?: (message: string) => void;
  now?: Date;
  repoRoot?: string;
  findAuthFileForUserImpl?: typeof findAuthFileForUser;
  readCookieStringFromAuthFileImpl?: typeof readCookieStringFromAuthFile;
  createClientImpl?: typeof createClient;
  getGuestTopCommentImpl?: typeof getGuestTopComment;
  runPipelineForBvidImpl?: typeof runPipelineForBvid;
  runPipelineTask?: PipelineTaskRunner;
  sleepImpl?: (timeoutMs: number) => Promise<void>;
}

export async function runHistoricalSummaryBackfill({
  ...options
}: RunHistoricalSummaryBackfillOptions = {}) {
  const repoRoot = options.repoRoot ?? getRepoRoot();
  const workRoot = options.workRoot ?? "work";
  const resolvedCursorPath = resolveHistoricalCursorPath({
    cursorPath: options.cursorPath ?? null,
    workRoot,
    repoRoot,
  });
  const releaseLock = acquireHistoricalSummaryLock(resolvedCursorPath);

  try {
    return await runHistoricalSummaryBackfillUnlocked({
      ...options,
      repoRoot,
      workRoot,
      cursorPath: resolvedCursorPath,
    });
  } finally {
    releaseLock();
  }
}

async function runHistoricalSummaryBackfillUnlocked({
  summaryUsers,
  authFile = DEFAULT_AUTH_FILE,
  dbPath = "work/pipeline.sqlite3",
  workRoot = "work",
  cursorPath = null,
  timezone = EAST_8_TIMEZONE,
  dailyLimit = DEFAULT_HISTORICAL_SUMMARY_DAILY_LIMIT,
  maxConcurrent = DEFAULT_HISTORICAL_SUMMARY_CONCURRENCY,
  requestDelayMs = DEFAULT_HISTORICAL_REQUEST_DELAY_MS,
  maxPipelineStartsPerRun = 1,
  logDay = null,
  logGroup = null,
  logger = null,
  onLog = () => {},
  now = new Date(),
  repoRoot = getRepoRoot(),
  findAuthFileForUserImpl = findAuthFileForUser,
  readCookieStringFromAuthFileImpl = readCookieStringFromAuthFile,
  createClientImpl = createClient,
  getGuestTopCommentImpl = getGuestTopComment,
  runPipelineForBvidImpl = runPipelineForBvid,
  runPipelineTask = (task) => task(),
  sleepImpl = delay,
}: RunHistoricalSummaryBackfillOptions = {}) {
  const targets = parseSummaryUsers(summaryUsers);
  const resolvedCursorPath = resolveHistoricalCursorPath({
    cursorPath,
    workRoot,
    repoRoot,
  });
  const today = formatDateInTimeZone(now, timezone || EAST_8_TIMEZONE);
  const safeDailyLimit = Math.max(1, Math.floor(Number(dailyLimit) || DEFAULT_HISTORICAL_SUMMARY_DAILY_LIMIT));
  const safeMaxConcurrent = Math.max(
    1,
    Math.floor(Number(maxConcurrent) || DEFAULT_HISTORICAL_SUMMARY_CONCURRENCY),
  );
  const safeRequestDelayMs = Math.max(0, Math.floor(Number(requestDelayMs) || 0));
  const safeMaxPipelineStartsPerRun = Math.max(
    1,
    Math.floor(Number(maxPipelineStartsPerRun) || 1),
  );
  const cursor = readHistoricalSummaryCursor(resolvedCursorPath, today);

  if (cursor.quotaDate !== today) {
    cursor.quotaDate = today;
    cursor.quotaUsed = 0;
    cursor.nextProcessAt = null;
    persistHistoricalSummaryCursor(resolvedCursorPath, cursor);
  }

  if (targets.length === 0) {
    return {
      targetDate: cursor.targetDate,
      cursorPath: resolvedCursorPath,
      dailyLimit: safeDailyLimit,
      quotaUsed: cursor.quotaUsed,
      uploads: [],
      runs: [],
      failures: [],
      skippedPinnedSummary: [],
      blockedMids: [],
      advanced: false,
    };
  }

  if (cursor.quotaUsed >= safeDailyLimit) {
    onLog(`Historical daily limit already reached: ${cursor.quotaUsed}/${safeDailyLimit}`);
    return {
      targetDate: cursor.targetDate,
      cursorPath: resolvedCursorPath,
      dailyLimit: safeDailyLimit,
      quotaUsed: cursor.quotaUsed,
      uploads: [],
      runs: [],
      failures: [],
      skippedPinnedSummary: [],
      blockedMids: [],
      advanced: false,
    };
  }

  const nextProcessAtMs = Date.parse(String(cursor.nextProcessAt ?? ""));
  if (Number.isFinite(nextProcessAtMs) && now.getTime() < nextProcessAtMs) {
    onLog(`Historical pacing gate: next video is eligible at ${cursor.nextProcessAt}`);
    return {
      targetDate: cursor.targetDate,
      cursorPath: resolvedCursorPath,
      dailyLimit: safeDailyLimit,
      quotaUsed: cursor.quotaUsed,
      uploads: [],
      runs: [],
      failures: [],
      skippedPinnedSummary: [],
      blockedMids: [],
      advanced: false,
    };
  }

  onLog(
    `Scanning historical uploads for ${cursor.targetDate}; daily quota ${cursor.quotaUsed}/${safeDailyLimit}`,
  );
  const requestGate = createRequestGate(safeRequestDelayMs, sleepImpl);
  let blockedMids: number[] = [];
  if (!cursor.pendingUploads) {
    const scan = await collectHistoricalUploadsForDate({
      targets,
      authFile,
      targetDate: cursor.targetDate,
      pageHints: cursor.pageHints,
      timezone: timezone || EAST_8_TIMEZONE,
      requestGate,
      onLog,
      findAuthFileForUserImpl,
      readCookieStringFromAuthFileImpl,
      createClientImpl,
    });
    blockedMids = scan.blockedMids;
    cursor.pageHints = scan.currentPageHints;
    if (blockedMids.length === 0) {
      cursor.pendingUploads = scan.uploads.map(toHistoricalCursorUpload);
      cursor.nextPageHints = scan.nextPageHints;
    }
    persistHistoricalSummaryCursor(resolvedCursorPath, cursor);
  }

  const uploads = (cursor.pendingUploads ?? []).map(toRecentUpload);
  if (blockedMids.length > 0) {
    return {
      targetDate: cursor.targetDate,
      cursorPath: resolvedCursorPath,
      dailyLimit: safeDailyLimit,
      quotaUsed: cursor.quotaUsed,
      uploads,
      runs: [],
      failures: [],
      skippedPinnedSummary: [],
      blockedMids,
      advanced: false,
    };
  }

  const completedBvids = new Set(cursor.completedBvids);
  const remainingQuota = Math.min(
    Math.max(0, safeDailyLimit - cursor.quotaUsed),
    safeMaxPipelineStartsPerRun,
  );
  const allPendingUploads = distributeUploadsByUser(
    uploads.filter((upload) => !completedBvids.has(upload.bvid)),
  );
  const pendingUploads = allPendingUploads.slice(0, remainingQuota);
  const hasDeferredUploads = allPendingUploads.length > pendingUploads.length;

  const execution = await runPipelinesWithConcurrency<RecentUpload, HistoricalPipelineResult>({
    uploads: pendingUploads,
    maxConcurrent: safeMaxConcurrent,
    userKeyForUpload(upload) {
      return String(upload.mid);
    },
    async runUpload(upload) {
      await requestGate();
      let topCommentState;
      try {
        topCommentState = await getGuestTopCommentImpl({
          oid: normalizePositiveInteger(upload.aid, `aid for ${upload.bvid}`),
          type: 1,
        });
      } catch (error) {
        throw new Error(
          `Unable to confirm live pinned-summary state for ${upload.bvid}: ${formatErrorMessage(error)}`,
          { cause: error },
        );
      }

      if (isPinnedSummaryComment(topCommentState.topComment?.message)) {
        completedBvids.add(upload.bvid);
        cursor.completedBvids = [...completedBvids];
        persistHistoricalSummaryCursor(resolvedCursorPath, cursor);
        onLog(
          `Skip ${upload.bvid}: webpage comment API confirms pinned summary rpid=${String(topCommentState.topComment?.rpid ?? "unknown")}`,
        );
        return {
          status: "pinned-summary",
          upload,
          topCommentRpid: topCommentState.topComment?.rpid ?? null,
        };
      }

      if (cursor.quotaUsed >= safeDailyLimit) {
        return {
          status: "quota-exhausted",
          upload,
        };
      }

      onLog(
        `Process ${upload.bvid}: webpage comment API confirms no pinned summary`
        + (topCommentState.hasTopComment ? " (current pinned comment is not a summary)" : ""),
      );
      cursor.nextProcessAt = computeNextHistoricalProcessAt({
        now,
        currentNextProcessAt: cursor.nextProcessAt,
        dailyLimit: safeDailyLimit,
      });
      persistHistoricalSummaryCursor(resolvedCursorPath, cursor);

      const uploadAuthFile = String(upload.authFile ?? authFile).trim();
      const result = await runPipelineTask(() =>
        runPipelineForBvidImpl({
          authFile: uploadAuthFile,
          cookieFile: null,
          dbPath,
          workRoot,
          bvid: upload.bvid,
          logDay,
          logGroup,
          publish: false,
          logger: logger?.child({
            task: "historical-summary",
            bvid: upload.bvid,
            mid: upload.mid,
          }) ?? null,
        }));

      cursor.quotaUsed += 1;
      completedBvids.add(upload.bvid);
      cursor.completedBvids = [...completedBvids];
      persistHistoricalSummaryCursor(resolvedCursorPath, cursor);
      return {
        status: "processed",
        upload,
        result,
      };
    },
  });

  const processedRuns = execution.runs
    .filter((item) => item.result.status === "processed")
    .map((item) => ({
      ...item,
      result: item.result.result,
    }));
  const skippedPinnedSummary = execution.runs
    .filter((item) => item.result.status === "pinned-summary")
    .map((item) => ({
      bvid: item.bvid,
      title: item.title,
      mid: item.mid,
      topCommentRpid: item.result.topCommentRpid ?? null,
    }));
  const quotaExhausted = execution.runs.some((item) => item.result.status === "quota-exhausted");
  const allUploadsCompleted = uploads.every((upload) => completedBvids.has(upload.bvid));
  const advanced = execution.failures.length === 0
    && !quotaExhausted
    && !hasDeferredUploads
    && allUploadsCompleted;

  if (advanced) {
    const completedDate = cursor.targetDate;
    cursor.targetDate = previousDateKey(cursor.targetDate);
    cursor.pageHints = cursor.nextPageHints;
    cursor.nextPageHints = {};
    cursor.pendingUploads = null;
    cursor.completedBvids = [];
    persistHistoricalSummaryCursor(resolvedCursorPath, cursor);
    onLog(`Historical date ${completedDate} completed; cursor advanced to ${cursor.targetDate}`);
  } else {
    cursor.completedBvids = [...completedBvids];
    persistHistoricalSummaryCursor(resolvedCursorPath, cursor);
  }

  return {
    targetDate: cursor.targetDate,
    cursorPath: resolvedCursorPath,
    dailyLimit: safeDailyLimit,
    quotaUsed: cursor.quotaUsed,
    uploads,
    runs: processedRuns,
    failures: execution.failures,
    skippedPinnedSummary,
    blockedMids,
    advanced,
  };
}

async function collectHistoricalUploadsForDate({
  targets,
  authFile,
  targetDate,
  pageHints,
  timezone,
  requestGate,
  onLog,
  findAuthFileForUserImpl,
  readCookieStringFromAuthFileImpl,
  createClientImpl,
}: {
  targets: SummaryUserTarget[];
  authFile: string;
  targetDate: string;
  pageHints: Record<string, number>;
  timezone: string;
  requestGate: () => Promise<void>;
  onLog: (message: string) => void;
  findAuthFileForUserImpl: typeof findAuthFileForUser;
  readCookieStringFromAuthFileImpl: typeof readCookieStringFromAuthFile;
  createClientImpl: typeof createClient;
}): Promise<HistoricalScanResult> {
  const scans: HistoricalUserScan[] = targets.map((target, index) => {
    const resolvedAuthFile = findAuthFileForUserImpl(authFile, index + 1);
    if (!resolvedAuthFile) {
      throw new Error(
        `Missing auth file for summary user #${index + 1}. Tried: ${buildAuthFileCandidates(authFile, index + 1).join(", ")}`,
      );
    }

    const hintedPage = normalizePageHint(pageHints[String(target.mid)]);
    return {
      target,
      authFile: resolvedAuthFile,
      client: createClientImpl(readCookieStringFromAuthFileImpl(resolvedAuthFile)),
      page: Math.max(1, hintedPage - 1),
      pagesFetched: 0,
      firstTargetPage: null,
      firstOlderPage: null,
      done: false,
      blocked: false,
    };
  });
  const uploadMap = new Map<string, RecentUpload>();

  while (scans.some((scan) => !scan.done)) {
    for (const scan of scans) {
      if (scan.done) {
        continue;
      }

      if (scan.pagesFetched >= HISTORICAL_MAX_PAGES_PER_USER) {
        scan.blocked = true;
        scan.done = true;
        onLog(`Stop uid ${scan.target.mid}: historical page scan safety limit reached`);
        continue;
      }

      await requestGate();
      onLog(`Fetching uid ${scan.target.mid} historical uploads page ${scan.page} for ${targetDate}`);
      let response;
      try {
        response = await scan.client.user.getVideos({
          mid: scan.target.mid,
          pn: scan.page,
          ps: HISTORICAL_UPLOAD_PAGE_SIZE,
          order: "pubdate",
        });
      } catch (error) {
        if (isBiliRiskControlError(error)) {
          scan.blocked = true;
          scan.done = true;
          onLog(
            `Stop uid ${scan.target.mid}: historical upload fetch blocked by Bilibili risk control (${formatErrorMessage(error)})`,
          );
          continue;
        }

        throw new Error(
          `Failed to fetch historical uploads for uid ${scan.target.mid}: ${formatErrorMessage(error)}`,
          { cause: error },
        );
      }

      scan.pagesFetched += 1;
      const videos = Array.isArray(response?.list?.vlist) ? response.list.vlist : [];
      if (videos.length === 0) {
        scan.done = true;
        scan.firstOlderPage ??= scan.page;
        continue;
      }

      let hasNewer = false;
      let hasTarget = false;
      let hasOlder = false;
      for (const video of videos) {
        const createdAtUnix = Number(video?.created ?? 0);
        const bvid = String(video?.bvid ?? "").trim();
        if (!bvid || !Number.isFinite(createdAtUnix) || createdAtUnix <= 0) {
          continue;
        }

        const videoDate = formatDateInTimeZone(new Date(createdAtUnix * 1000), timezone);
        if (videoDate > targetDate) {
          hasNewer = true;
          continue;
        }

        if (videoDate < targetDate) {
          hasOlder = true;
          continue;
        }

        hasTarget = true;
        scan.firstTargetPage ??= scan.page;
        if (isOnlySelfVisibleVideo(video)) {
          onLog(`Skip only-self-visible historical video ${bvid}`);
          continue;
        }

        uploadMap.set(bvid, {
          mid: scan.target.mid,
          bvid,
          aid: Number(video?.aid ?? 0) || null,
          title: String(video?.title ?? "").trim(),
          authFile: scan.authFile,
          createdAtUnix,
          createdAt: new Date(createdAtUnix * 1000).toISOString(),
          source: scan.target.source,
        });
      }

      if (hasOlder) {
        scan.firstOlderPage ??= scan.page;
      }
      if (hasOlder && !hasNewer) {
        scan.done = true;
        continue;
      }
      if (!hasTarget && hasOlder) {
        scan.done = true;
        continue;
      }

      scan.page += 1;
    }
  }

  return {
    uploads: [...uploadMap.values()].sort(
      (left, right) => right.createdAtUnix - left.createdAtUnix || left.mid - right.mid,
    ),
    blockedMids: scans.filter((scan) => scan.blocked).map((scan) => scan.target.mid),
    currentPageHints: Object.fromEntries(
      scans.map((scan) => [
        String(scan.target.mid),
        scan.firstTargetPage ?? Math.max(1, normalizePageHint(pageHints[String(scan.target.mid)])),
      ]),
    ),
    nextPageHints: Object.fromEntries(
      scans.map((scan) => [
        String(scan.target.mid),
        Math.max(1, (scan.firstOlderPage ?? scan.page) - 1),
      ]),
    ),
  };
}

export function isPinnedSummaryComment(message: unknown): boolean {
  return parseSummaryBlocks(String(message ?? "")).length > 0;
}

export function readHistoricalSummaryCursor(
  cursorPath: string,
  initialTargetDate: string,
): HistoricalSummaryCursor {
  try {
    const parsed = JSON.parse(fs.readFileSync(cursorPath, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      throw new Error("invalid cursor");
    }

    return {
      version: HISTORICAL_CURSOR_VERSION,
      targetDate: normalizeDateKey(parsed.targetDate) ?? initialTargetDate,
      pageHints: normalizePageHints(parsed.pageHints),
      nextPageHints: normalizePageHints(parsed.nextPageHints),
      pendingUploads: normalizeHistoricalCursorUploads(parsed.pendingUploads),
      completedBvids: Array.isArray(parsed.completedBvids)
        ? [...new Set(parsed.completedBvids.map((item) => String(item ?? "").trim()).filter(Boolean))]
        : [],
      quotaDate: normalizeDateKey(parsed.quotaDate) ?? initialTargetDate,
      quotaUsed: Math.max(0, Math.floor(Number(parsed.quotaUsed) || 0)),
      nextProcessAt: normalizeIsoTimestamp(parsed.nextProcessAt),
      updatedAt: String(parsed.updatedAt ?? "").trim(),
    };
  } catch {
    return {
      version: HISTORICAL_CURSOR_VERSION,
      targetDate: initialTargetDate,
      pageHints: {},
      nextPageHints: {},
      pendingUploads: null,
      completedBvids: [],
      quotaDate: initialTargetDate,
      quotaUsed: 0,
      nextProcessAt: null,
      updatedAt: "",
    };
  }
}

export function persistHistoricalSummaryCursor(
  cursorPath: string,
  cursor: HistoricalSummaryCursor,
) {
  const normalized = {
    ...cursor,
    version: HISTORICAL_CURSOR_VERSION,
    pageHints: normalizePageHints(cursor.pageHints),
    nextPageHints: normalizePageHints(cursor.nextPageHints),
    pendingUploads: normalizeHistoricalCursorUploads(cursor.pendingUploads),
    completedBvids: [...new Set(cursor.completedBvids)].sort(),
    quotaUsed: Math.max(0, Math.floor(Number(cursor.quotaUsed) || 0)),
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(cursorPath), { recursive: true });
  const temporaryPath = `${cursorPath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  fs.renameSync(temporaryPath, cursorPath);
}

function resolveHistoricalCursorPath({
  cursorPath,
  workRoot,
  repoRoot,
}: {
  cursorPath: string | null;
  workRoot: string;
  repoRoot: string;
}) {
  const configuredPath = String(cursorPath ?? "").trim();
  return path.resolve(
    repoRoot,
    configuredPath || path.join(workRoot, "state", "historical-summary-cursor.json"),
  );
}

function acquireHistoricalSummaryLock(cursorPath: string) {
  const lockPath = `${cursorPath}.lock`;
  const ownerPath = path.join(lockPath, "owner.json");
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  while (true) {
    try {
      fs.mkdirSync(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }

      if (!isStaleHistoricalSummaryLock(lockPath, ownerPath)) {
        throw new Error(`Historical summary backfill is already running: ${lockPath}`);
      }
      fs.rmSync(lockPath, { recursive: true, force: true });
    }
  }

  const writeOwner = () => {
    fs.writeFileSync(ownerPath, `${JSON.stringify({
      ...createProcessLockOwner(),
      cursorPath,
      updatedAt: new Date().toISOString(),
    }, null, 2)}\n`, "utf8");
  };
  writeOwner();
  const heartbeat = setInterval(() => {
    try {
      writeOwner();
    } catch {
      // Lock ownership is revalidated by the next invocation.
    }
  }, RUNTIME_LOCK_HEARTBEAT_MS);
  heartbeat.unref?.();

  return () => {
    clearInterval(heartbeat);
    fs.rmSync(lockPath, { recursive: true, force: true });
  };
}

function isStaleHistoricalSummaryLock(lockPath: string, ownerPath: string) {
  let owner: Record<string, unknown> | null = null;
  try {
    owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
  } catch {
    owner = null;
  }

  if (isOwnerProcessAlive(owner) === false) {
    return true;
  }

  try {
    const stats = fs.statSync(fs.existsSync(ownerPath) ? ownerPath : lockPath);
    return Date.now() - stats.mtimeMs
      > resolveHeartbeatLockStaleMs(owner, HISTORICAL_LOCK_STALE_MS);
  } catch {
    return false;
  }
}

function createRequestGate(
  minimumIntervalMs: number,
  sleepImpl: (timeoutMs: number) => Promise<void>,
) {
  let nextAllowedAt = 0;
  let chain = Promise.resolve();

  return async () => {
    const turn = chain.then(async () => {
      const waitMs = Math.max(0, nextAllowedAt - Date.now());
      if (waitMs > 0) {
        await sleepImpl(waitMs);
      }
      nextAllowedAt = Date.now() + minimumIntervalMs;
    });
    chain = turn.catch(() => {});
    await turn;
  };
}

function distributeUploadsByUser(uploads: RecentUpload[]) {
  const queues = new Map<number, RecentUpload[]>();
  for (const upload of uploads) {
    const queue = queues.get(upload.mid) ?? [];
    queue.push(upload);
    queues.set(upload.mid, queue);
  }

  const distributed: RecentUpload[] = [];
  while ([...queues.values()].some((queue) => queue.length > 0)) {
    for (const queue of queues.values()) {
      const upload = queue.shift();
      if (upload) {
        distributed.push(upload);
      }
    }
  }
  return distributed;
}

function previousDateKey(dateKey: string) {
  const normalized = normalizeDateKey(dateKey);
  if (!normalized) {
    throw new Error(`Invalid historical target date: ${dateKey}`);
  }

  const [year, month, day] = normalized.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day - 1, 12));
  return [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, "0"),
    String(date.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function normalizeDateKey(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return /^\d{4}-\d{2}-\d{2}$/u.test(normalized) ? normalized : null;
}

function normalizePageHints(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([mid, page]) => [String(mid), normalizePageHint(page)] as const)
      .filter(([mid]) => /^\d+$/u.test(mid)),
  );
}

function normalizePageHint(value: unknown) {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : 1;
}

function normalizeHistoricalCursorUploads(value: unknown): HistoricalCursorUpload[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  const uploads = value.flatMap((item) => {
    if (!item || typeof item !== "object") {
      return [];
    }

    const candidate = item as Record<string, unknown>;
    const mid = Number(candidate.mid);
    const bvid = String(candidate.bvid ?? "").trim();
    const createdAtUnix = Number(candidate.createdAtUnix);
    if (
      !Number.isInteger(mid)
      || mid <= 0
      || !bvid
      || !Number.isFinite(createdAtUnix)
      || createdAtUnix <= 0
    ) {
      return [];
    }

    return [{
      mid,
      bvid,
      aid: normalizeOptionalPositiveInteger(candidate.aid),
      title: String(candidate.title ?? "").trim(),
      authFile: String(candidate.authFile ?? "").trim() || null,
      createdAtUnix,
      createdAt: String(candidate.createdAt ?? "").trim()
        || new Date(createdAtUnix * 1000).toISOString(),
      source: String(candidate.source ?? "").trim() || String(mid),
    }];
  });

  return uploads;
}

function toHistoricalCursorUpload(upload: RecentUpload): HistoricalCursorUpload {
  return {
    mid: upload.mid,
    bvid: upload.bvid,
    aid: upload.aid,
    title: upload.title,
    authFile: upload.authFile ?? null,
    createdAtUnix: upload.createdAtUnix,
    createdAt: upload.createdAt,
    source: upload.source,
  };
}

function toRecentUpload(upload: HistoricalCursorUpload): RecentUpload {
  return {
    ...upload,
  };
}

function computeHistoricalProcessIntervalMs(dailyLimit: number) {
  return Math.ceil(24 * 60 * 60 * 1000 / Math.max(1, dailyLimit));
}

function computeNextHistoricalProcessAt({
  now,
  currentNextProcessAt,
  dailyLimit,
}: {
  now: Date;
  currentNextProcessAt: string | null;
  dailyLimit: number;
}) {
  const intervalMs = computeHistoricalProcessIntervalMs(dailyLimit);
  const currentNextMs = Date.parse(String(currentNextProcessAt ?? ""));
  const nowMs = now.getTime();
  const baseMs = Number.isFinite(currentNextMs) && currentNextMs >= nowMs - intervalMs
    ? currentNextMs
    : nowMs;
  return new Date(baseMs + intervalMs).toISOString();
}

function normalizeIsoTimestamp(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  return normalized && Number.isFinite(Date.parse(normalized))
    ? new Date(normalized).toISOString()
    : null;
}

function normalizeOptionalPositiveInteger(value: unknown): number | null {
  const normalized = Number(value);
  return Number.isInteger(normalized) && normalized > 0 ? normalized : null;
}

function normalizePositiveInteger(value: unknown, fieldName: string) {
  const normalized = Number(value);
  if (!Number.isInteger(normalized) || normalized <= 0) {
    throw new Error(`Cannot verify pinned summary without valid ${fieldName}`);
  }
  return normalized;
}

function isOnlySelfVisibleVideo(video: unknown): boolean {
  if (!video || typeof video !== "object") {
    return false;
  }

  const candidate = video as Record<string, unknown>;
  return candidate.is_self_view === true || Number(candidate.is_only_self ?? 0) === 1;
}

function isBiliRiskControlError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const candidate = error as {
    code?: unknown;
    rawResponse?: {
      data?: {
        code?: unknown;
      };
    };
  };
  return Number(candidate.code ?? candidate.rawResponse?.data?.code) === BILI_RISK_CONTROL_CODE;
}

function delay(timeoutMs: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
