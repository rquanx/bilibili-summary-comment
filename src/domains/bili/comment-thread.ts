import fs from "node:fs";
import path from "node:path";
import { utils } from "@renmu/bili-api";
import { createCliError, extractErrorDetails } from "../../shared/cli/errors";
import {
  getActiveVideoPartByPageNo,
  getPreferredSummaryTextForPart,
  getVideoById,
  markPartsPublished,
  normalizeStoredSummaryText,
  savePartProcessedSummary,
  updateVideoCommentThread,
} from "../../infra/db/index";
import { ensureVideoWorkDir } from "../../shared/work-paths";
import {
  extractCoveredPages,
  normalizeSummaryMarkers,
  parseSummaryBlocks,
  splitSummaryForComments,
} from "../summary/format";
import { getRepoRoot } from "../../shared/runtime-tools";

const sleep = (timeout) =>
  new Promise((resolve) => {
    setTimeout(resolve, timeout);
  });

const ROOT_TOP_DELAY_MS = 5000;
const ROOT_TOP_RETRY_DELAY_MS = 5000;
const REPLY_POST_DELAY_MS = 5000;
const GUEST_VISIBILITY_RETRY_DELAY_MS = 180_000;
const GUEST_VISIBILITY_RETRY_ATTEMPTS = 3;
const GUEST_COMMENT_SCAN_PAGE_LIMIT = 5;
const GUEST_REPLY_PAGE_SIZE = 20;
const BILIBILI_COMMENT_MAX_LENGTH = 700;
const TIMESTAMP_UNIT_PATTERN = /^(?<label>\d+#\d{1,2}:\d{2}(?::\d{2})?)\s+(?<rest>.+)$/u;
const GUEST_COMMENT_WEB_LOCATION = 1315875;
const GUEST_COMMENT_MODE = 3;
const PASTE_RS_MIN_INTERVAL_MS = Math.max(0, Number(process.env.PASTE_RS_MIN_INTERVAL_MS) || 5_000);
const PASTE_RS_RATE_LIMIT_WAIT_MS = 250;
const PASTE_RS_RATE_LIMIT_STALE_MS = Math.max(1_000, Number(process.env.PASTE_RS_RATE_LIMIT_STALE_MS) || 10_000);

interface CommentUnit {
  id: string;
  page: number;
  label: string | null;
  kind: "timepoint" | "text";
  text: string;
}

interface CommentPageBlock {
  page: number;
  marker: string;
  units: CommentUnit[];
}

interface PasteRateLimitState {
  pid: number | null;
  nextAllowedAt: number;
  updatedAt: string;
}

interface GuestReplyListParams {
  oid: number;
  type: number;
  sort?: 0 | 1 | 2;
  nohot?: 0 | 1;
  pn?: number;
  ps?: number;
  fetchImpl?: typeof fetch;
}

interface GuestReplyPagination {
  next_offset?: string;
  [key: string]: unknown;
}

interface GuestReplyCursor {
  is_begin?: boolean;
  prev?: number;
  next?: number;
  is_end?: boolean;
  pagination_reply?: GuestReplyPagination | null;
  session_id?: string;
  mode?: number;
  mode_text?: string;
  all_count?: number;
  support_mode?: number[];
  name?: string;
  [key: string]: unknown;
}

interface GuestReplyContent {
  message?: string;
  members?: unknown[];
  emote?: Record<string, unknown>;
  jump_url?: Record<string, unknown>;
  max_line?: number;
  [key: string]: unknown;
}

interface GuestReplyNode {
  rpid?: number | string;
  rpid_str?: string;
  root?: number | string;
  parent?: number | string;
  count?: number;
  rcount?: number;
  invisible?: boolean;
  content?: GuestReplyContent | null;
  replies?: GuestReplyNode[] | null;
  [key: string]: unknown;
}

interface GuestReplyPage {
  count?: number;
  acount?: number;
  num?: number;
  size?: number;
  [key: string]: unknown;
}

export interface GuestTopCommentReply {
  rpid: number;
  oid: unknown;
  mid: unknown;
  uname: string | null;
  message: string;
  like: unknown;
  count: unknown;
  ctime: unknown;
  raw: Record<string, unknown>;
}

export interface GuestTopCommentState {
  oid: number;
  type: number;
  hasTopComment: boolean;
  topComment: GuestTopCommentReply | null;
  raw: GuestReplyListResponse;
}

interface GuestReplyUpper {
  top?: GuestReplyNode | null;
  [key: string]: unknown;
}

interface GuestReplyListResponse {
  cursor?: GuestReplyCursor | null;
  upper?: GuestReplyUpper | null;
  top?: GuestReplyNode | null;
  root?: GuestReplyNode | null;
  replies?: GuestReplyNode[] | null;
  top_replies?: GuestReplyNode[] | null;
  page?: GuestReplyPage | null;
  [key: string]: unknown;
}

type GuestReplyListImpl = (params: GuestReplyListParams) => Promise<GuestReplyListResponse | null | undefined>;

export interface VisibleGuestSummaryThreadInspection {
  oid: number;
  type: number;
  expectedRootRpid: number | null;
  hasTopComment: boolean;
  topCommentRpid: number | null;
  topCommentMessage: string;
  matchesExpectedRoot: boolean;
  pastePages: number[];
  pasteUrls: string[];
  scannedReplyCount: number;
}

const DELETED_COMMENT_PATTERNS = [
  "已经被删除",
  "已被删除",
  "评论不存在",
  "该评论不存在",
  "根评论不存在",
  "楼层不存在",
];

const DUPLICATE_COMMENT_PATTERNS = ["重复评论"];
const defaultGuestReplyListImpl: GuestReplyListImpl = async (params) => {
  const targetPageNo = Math.max(1, Number(params.pn ?? 1) || 1);
  let offset = "";
  let response: GuestReplyListResponse | null = null;

  for (let pageNo = 1; pageNo <= targetPageNo; pageNo += 1) {
    response = await fetchGuestTopLevelRepliesByWbi({
      oid: params.oid,
      type: params.type,
      offset,
      fetchImpl: params.fetchImpl,
    });

    if (pageNo >= targetPageNo) {
      break;
    }

    const nextOffset = getGuestTopLevelNextOffset(response);
    if (!nextOffset) {
      break;
    }

    offset = nextOffset;
  }

  return response;
};

function getCommentErrorMessages(error) {
  const values = [
    error?.message,
    error?.rawResponse?.data?.message,
    error?.rawResponse?.data?.msg,
  ];

  return [...new Set(values.map((value) => String(value ?? "").trim()).filter(Boolean))];
}

function isDeletedCommentThreadError(error) {
  const messages = getCommentErrorMessages(error);
  return messages.some((message) => DELETED_COMMENT_PATTERNS.some((pattern) => message.includes(pattern)));
}

function isDuplicateCommentError(error) {
  const messages = getCommentErrorMessages(error);
  return messages.some((message) => DUPLICATE_COMMENT_PATTERNS.some((pattern) => message.includes(pattern)));
}

function isRetryableRootTopError(error) {
  const messages = getCommentErrorMessages(error);
  return messages.some((message) => message.includes("啥都木有") || message.includes("稍后"));
}

function buildCommentWarning({ step, rpid, error, details = null }) {
  return {
    step,
    rpid,
    message: error?.message ?? "Unknown comment error",
    ...(details && typeof details === "object" ? details : {}),
    ...extractErrorDetails(error),
  };
}

function normalizeCommentCount(value) {
  const count = Number(value ?? 0);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

function normalizeCommentRpid(value) {
  const rpid = Number(value ?? 0);
  return Number.isInteger(rpid) && rpid > 0 ? rpid : null;
}

function normalizeMessageForMatch(value) {
  return String(value ?? "").replace(/\r\n/g, "\n").trim();
}

function normalizeCommentMessageForMatch(value) {
  return normalizeMessageForMatch(normalizeSummaryMarkers(String(value ?? "")));
}

function commentMessageMatches(left, right) {
  return normalizeCommentMessageForMatch(left) === normalizeCommentMessageForMatch(right);
}

function collectReplyNodes(reply, bucket = []) {
  if (!reply || typeof reply !== "object") {
    return bucket;
  }

  bucket.push(reply);
  const nestedReplies = Array.isArray(reply.replies) ? reply.replies : [];
  for (const nestedReply of nestedReplies) {
    collectReplyNodes(nestedReply, bucket);
  }

  return bucket;
}

function collectReplyCandidates(response) {
  if (!response || typeof response !== "object") {
    return [];
  }

  const safeResponse = response as GuestReplyListResponse;
  const upper = safeResponse.upper && typeof safeResponse.upper === "object" ? safeResponse.upper : null;
  const root = safeResponse.root && typeof safeResponse.root === "object" ? safeResponse.root : null;

  return [
    upper?.top ?? null,
    safeResponse.top ?? null,
    root ?? null,
    ...(Array.isArray(safeResponse.top_replies) ? safeResponse.top_replies : []),
    ...(Array.isArray(root?.replies) ? root.replies : []),
    ...(Array.isArray(safeResponse.replies) ? safeResponse.replies : []),
  ].filter(Boolean);
}

function extractReplyMessage(reply) {
  if (!reply || typeof reply !== "object") {
    return "";
  }

  const content = (typeof reply.content === "object" && reply.content !== null
    ? reply.content
    : {}) as Record<string, unknown>;
  return normalizeMessageForMatch(content.message);
}

function findReplyNode(response, { targetRpid = null, expectedMessage = null }) {
  const normalizedTargetRpid = normalizeCommentRpid(targetRpid);
  const normalizedExpectedMessage = normalizeMessageForMatch(expectedMessage);

  for (const candidate of collectReplyCandidates(response)) {
    for (const reply of collectReplyNodes(candidate)) {
      const replyRpid = normalizeCommentRpid(reply?.rpid ?? reply?.rpid_str);
      if (normalizedTargetRpid && replyRpid === normalizedTargetRpid) {
        return reply;
      }

      if (normalizedExpectedMessage && commentMessageMatches(extractReplyMessage(reply), normalizedExpectedMessage)) {
        return reply;
      }
    }
  }

  return null;
}

function unwrapBilibiliPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }

  if ("data" in payload && payload.data !== undefined) {
    return payload.data;
  }

  return payload;
}

function normalizeGuestReplyListResponse(payload: unknown): GuestReplyListResponse {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  return payload as GuestReplyListResponse;
}

function getGuestTopLevelNextOffset(response: GuestReplyListResponse | null | undefined) {
  return String(response?.cursor?.pagination_reply?.next_offset ?? "").trim();
}

function hasMoreGuestTopLevelReplyPages(
  response: GuestReplyListResponse | null | undefined,
  pageNo: number,
  pageSize = GUEST_REPLY_PAGE_SIZE,
) {
  if (!response) {
    return false;
  }

  if (response.cursor?.is_end === true) {
    return false;
  }

  if (getGuestTopLevelNextOffset(response)) {
    return true;
  }

  const totalCount = normalizeCommentCount(response.cursor?.all_count ?? response.page?.count);
  if (totalCount > 0) {
    return pageNo * pageSize < totalCount;
  }

  return false;
}

function hasMoreGuestChildReplyPages(
  response: GuestReplyListResponse | null | undefined,
  pageNo: number,
  pageSize = GUEST_REPLY_PAGE_SIZE,
) {
  if (!response) {
    return false;
  }

  const totalCount = normalizeCommentCount(response.page?.count ?? response.page?.acount);
  if (totalCount > 0) {
    return pageNo * pageSize < totalCount;
  }

  const currentPageReplies = Array.isArray(response.replies) ? response.replies.length : 0;
  return currentPageReplies >= pageSize;
}

async function fetchBilibiliGuestJson(url, fetchImpl = fetch) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      accept: "application/json, text/plain, */*",
      referer: "https://www.bilibili.com/",
      "user-agent": "Mozilla/5.0",
    },
  });

  if (!response.ok) {
    throw createCliError("Guest comment fetch failed", {
      status: response.status,
      url,
    });
  }

  return unwrapBilibiliPayload(await response.json());
}

function buildGuestApiUrl(pathname, params) {
  const url = new URL(pathname, "https://api.bilibili.com");
  for (const [key, value] of Object.entries(params)) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function fetchGuestTopLevelRepliesByWbi({
  oid,
  type,
  offset = "",
  fetchImpl = fetch,
}: {
  oid: number;
  type: number;
  offset?: string;
  fetchImpl?: typeof fetch;
}): Promise<GuestReplyListResponse> {
  const signedQuery = await utils.WbiSign({
    oid,
    type,
    mode: GUEST_COMMENT_MODE,
    pagination_str: JSON.stringify({ offset }),
    plat: 1,
    seek_rpid: "",
    web_location: GUEST_COMMENT_WEB_LOCATION,
  });

  return normalizeGuestReplyListResponse(await fetchBilibiliGuestJson(
    `https://api.bilibili.com/x/v2/reply/wbi/main?${signedQuery}`,
    fetchImpl,
  ));
}

export async function listGuestTopLevelReplies({
  oid,
  type,
  pn,
  ps = GUEST_REPLY_PAGE_SIZE,
  guestReplyListImpl = defaultGuestReplyListImpl,
  fetchImpl = fetch,
}): Promise<GuestReplyListResponse> {
  return normalizeGuestReplyListResponse(unwrapBilibiliPayload(await guestReplyListImpl({
    oid,
    type,
    sort: 0,
    nohot: 0,
    pn,
    ps,
    fetchImpl,
  })));
}

export async function getGuestTopComment({
  oid,
  type,
  guestReplyListImpl = defaultGuestReplyListImpl,
  fetchImpl = fetch,
}: {
  oid: number;
  type: number;
  guestReplyListImpl?: GuestReplyListImpl;
  fetchImpl?: typeof fetch;
}): Promise<GuestTopCommentState> {
  const response = await listGuestTopLevelReplies({
    oid,
    type,
    pn: 1,
    ps: GUEST_REPLY_PAGE_SIZE,
    guestReplyListImpl,
    fetchImpl,
  });
  const topReply = normalizeGuestTopReply(getPinnedTopReply(response));

  return {
    oid,
    type,
    hasTopComment: Boolean(topReply),
    topComment: topReply,
    raw: response,
  };
}

export async function inspectVisibleGuestSummaryThread({
  oid,
  type,
  expectedRootRpid = null,
  childReplyPageLimit = GUEST_COMMENT_SCAN_PAGE_LIMIT,
  guestReplyListImpl = defaultGuestReplyListImpl,
  fetchImpl = fetch,
}: {
  oid: number;
  type: number;
  expectedRootRpid?: number | null;
  childReplyPageLimit?: number;
  guestReplyListImpl?: GuestReplyListImpl;
  fetchImpl?: typeof fetch;
}): Promise<VisibleGuestSummaryThreadInspection> {
  const firstPage = await listGuestTopLevelReplies({
    oid,
    type,
    pn: 1,
    ps: GUEST_REPLY_PAGE_SIZE,
    guestReplyListImpl,
    fetchImpl,
  });
  const topReply = getPinnedTopReply(firstPage);
  const topCommentRpid = normalizeCommentRpid(topReply?.rpid ?? topReply?.rpid_str);
  const pastePageSet = new Set<number>();
  const pasteUrlSet = new Set<string>();
  const scannedReplyRpids = new Set<number>();

  collectPasteDataFromReply(topReply, {
    pageSet: pastePageSet,
    urlSet: pasteUrlSet,
    scannedReplyRpids,
  });

  if (topCommentRpid) {
    for (let pageNo = 1; pageNo <= Math.max(1, Number(childReplyPageLimit) || GUEST_COMMENT_SCAN_PAGE_LIMIT); pageNo += 1) {
      const response = await fetchGuestChildReplies({
        oid,
        type,
        rootRpid: topCommentRpid,
        pn: pageNo,
        ps: GUEST_REPLY_PAGE_SIZE,
        fetchImpl,
      });

      for (const candidate of collectReplyCandidates(response)) {
        for (const reply of collectReplyNodes(candidate)) {
          collectPasteDataFromReply(reply, {
            pageSet: pastePageSet,
            urlSet: pasteUrlSet,
            scannedReplyRpids,
          });
        }
      }

      if (!hasMoreGuestChildReplyPages(response, pageNo, GUEST_REPLY_PAGE_SIZE)) {
        break;
      }
    }
  }

  const normalizedExpectedRootRpid = normalizeCommentRpid(expectedRootRpid);
  return {
    oid,
    type,
    expectedRootRpid: normalizedExpectedRootRpid,
    hasTopComment: Boolean(topCommentRpid),
    topCommentRpid,
    topCommentMessage: extractReplyMessage(topReply),
    matchesExpectedRoot: Boolean(
      normalizedExpectedRootRpid
      && topCommentRpid
      && normalizedExpectedRootRpid === topCommentRpid,
    ),
    pastePages: [...pastePageSet].sort((left, right) => left - right),
    pasteUrls: [...pasteUrlSet].sort(),
    scannedReplyCount: scannedReplyRpids.size,
  };
}

async function fetchGuestChildReplies({ oid, type, rootRpid, pn, ps = GUEST_REPLY_PAGE_SIZE, fetchImpl = fetch }) {
  return normalizeGuestReplyListResponse(await fetchBilibiliGuestJson(buildGuestApiUrl("/x/v2/reply/reply", {
    oid,
    type,
    root: rootRpid,
    pn,
    ps,
  }), fetchImpl));
}

async function findVisibleCommentAsGuest({
  oid,
  type,
  rootRpid = null,
  targetRpid,
  expectedMessage,
  isRoot,
  guestReplyListImpl = defaultGuestReplyListImpl,
  fetchImpl = fetch,
}) {
  if (isRoot) {
    for (let pageNo = 1; pageNo <= GUEST_COMMENT_SCAN_PAGE_LIMIT; pageNo += 1) {
      const response = await listGuestTopLevelReplies({
        oid,
        type,
        pn: pageNo,
        ps: GUEST_REPLY_PAGE_SIZE,
        guestReplyListImpl,
        fetchImpl,
      });
      const match = findReplyNode(response, {
        targetRpid,
        expectedMessage,
      });
      if (match) {
        return match;
      }

      if (!hasMoreGuestTopLevelReplyPages(response, pageNo, GUEST_REPLY_PAGE_SIZE)) {
        break;
      }
    }

    return null;
  }

  const normalizedRootRpid = normalizeCommentRpid(rootRpid);
  if (!normalizedRootRpid) {
    return null;
  }

  for (let pageNo = 1; pageNo <= GUEST_COMMENT_SCAN_PAGE_LIMIT; pageNo += 1) {
    const response = await fetchGuestChildReplies({
      oid,
      type,
      rootRpid: normalizedRootRpid,
      pn: pageNo,
      ps: GUEST_REPLY_PAGE_SIZE,
      fetchImpl,
    });
    const match = findReplyNode(response, {
      targetRpid,
      expectedMessage,
    });
    if (match) {
      return match;
    }

    if (!hasMoreGuestChildReplyPages(response, pageNo, GUEST_REPLY_PAGE_SIZE)) {
      break;
    }
  }

  return null;
}

async function findVisibleCommentAsGuestWithRetries({
  oid,
  type,
  rootRpid = null,
  targetRpid = null,
  expectedMessage,
  isRoot,
  sleepImpl = sleep,
  guestReplyListImpl = defaultGuestReplyListImpl,
  fetchImpl = fetch,
  retryDelayMs = GUEST_VISIBILITY_RETRY_DELAY_MS,
  retryAttempts = GUEST_VISIBILITY_RETRY_ATTEMPTS,
}) {
  const attempts = Math.max(1, Number(retryAttempts) || GUEST_VISIBILITY_RETRY_ATTEMPTS);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await sleepImpl(retryDelayMs);
    const visibleComment = await findVisibleCommentAsGuest({
      oid,
      type,
      rootRpid,
      targetRpid,
      expectedMessage,
      isRoot,
      guestReplyListImpl,
      fetchImpl,
    });
    if (visibleComment) {
      return visibleComment;
    }
  }

  return null;
}

async function assertCommentVisibleAsGuest({
  oid,
  type,
  targetRpid,
  expectedMessage,
  isRoot,
  rootRpid = null,
  sleepImpl = sleep,
  guestReplyListImpl = defaultGuestReplyListImpl,
  fetchImpl = fetch,
}) {
  const visibleComment = await findVisibleCommentAsGuestWithRetries({
    oid,
    type,
    rootRpid,
    targetRpid,
    expectedMessage,
    isRoot,
    guestReplyListImpl,
    fetchImpl,
    sleepImpl,
  });

  if (visibleComment) {
    return visibleComment;
  }

  throw createCliError("Published comment is not visible to guests", {
    oid,
    type,
    rpid: normalizeCommentRpid(targetRpid),
    rootRpid: normalizeCommentRpid(rootRpid),
    isRoot,
    expectedMessage: normalizeMessageForMatch(expectedMessage),
  });
}

async function uploadTextToPasteRs(text, fetchImpl = fetch) {
  const response = await fetchImpl("https://paste.rs", {
    method: "POST",
    headers: {
      "content-type": "text/plain; charset=utf-8",
    },
    body: String(text ?? ""),
  });

  if (!response.ok) {
    throw createCliError("Failed to upload problematic comment content to paste.rs", {
      status: response.status,
    });
  }

  const pasteUrl = String(await response.text()).trim();
  if (!/^https:\/\/paste\.rs\/\S+$/u.test(pasteUrl)) {
    throw createCliError("paste.rs returned an invalid URL", {
      pasteUrl,
    });
  }

  return pasteUrl;
}

export async function waitForGlobalPasteUploadTurn({
  workRoot = "work",
  repoRoot = getRepoRoot(),
  minIntervalMs = PASTE_RS_MIN_INTERVAL_MS,
  waitMs = PASTE_RS_RATE_LIMIT_WAIT_MS,
  staleMs = PASTE_RS_RATE_LIMIT_STALE_MS,
  sleepImpl = sleep,
  nowImpl = () => Date.now(),
}: {
  workRoot?: string;
  repoRoot?: string;
  minIntervalMs?: number;
  waitMs?: number;
  staleMs?: number;
  sleepImpl?: (timeout: number) => Promise<unknown>;
  nowImpl?: () => number;
} = {}) {
  if (!Number.isFinite(minIntervalMs) || minIntervalMs <= 0) {
    return;
  }

  const lockRoot = path.join(repoRoot, workRoot, ".locks");
  const lockPath = path.join(lockRoot, "paste-rs-rate-limit.lock");
  const ownerPath = path.join(lockPath, "owner.json");
  const statePath = path.join(lockRoot, "paste-rs-rate-limit.json");
  fs.mkdirSync(lockRoot, { recursive: true });

  const release = await acquirePasteRateLimitLock({
    lockPath,
    ownerPath,
    staleMs,
    waitMs,
    sleepImpl,
    nowImpl,
  });

  try {
    const state = readPasteRateLimitState(statePath);
    const now = nowImpl();
    const nextAllowedAt = Math.max(0, Number(state?.nextAllowedAt ?? 0) || 0);
    const waitForMs = Math.max(0, nextAllowedAt - now);
    if (waitForMs > 0) {
      await sleepImpl(waitForMs);
    }

    const reservedAt = nowImpl() + minIntervalMs;
    const payload: PasteRateLimitState = {
      pid: Number.isInteger(process.pid) && process.pid > 0 ? process.pid : null,
      nextAllowedAt: reservedAt,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  } finally {
    release();
  }
}

async function acquirePasteRateLimitLock({
  lockPath,
  ownerPath,
  staleMs,
  waitMs,
  sleepImpl,
  nowImpl,
}: {
  lockPath: string;
  ownerPath: string;
  staleMs: number;
  waitMs: number;
  sleepImpl: (timeout: number) => Promise<unknown>;
  nowImpl: () => number;
}) {
  while (true) {
    try {
      fs.mkdirSync(lockPath);
      fs.writeFileSync(ownerPath, `${JSON.stringify({
        pid: Number.isInteger(process.pid) && process.pid > 0 ? process.pid : null,
        updatedAt: new Date(nowImpl()).toISOString(),
      }, null, 2)}\n`, "utf8");
      return () => {
        fs.rmSync(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") {
        throw error;
      }

      if (isStalePasteRateLimitLock(lockPath, ownerPath, staleMs, nowImpl)) {
        fs.rmSync(lockPath, { recursive: true, force: true });
        continue;
      }

      await sleepImpl(waitMs);
    }
  }
}

function isStalePasteRateLimitLock(
  lockPath: string,
  ownerPath: string,
  staleMs: number,
  nowImpl: () => number,
) {
  const owner = readPasteRateLimitLockOwner(ownerPath);
  const ownerPid = Number(owner?.pid ?? 0);
  if (Number.isInteger(ownerPid) && ownerPid > 0 && !isProcessAlive(ownerPid)) {
    return true;
  }

  try {
    const stats = fs.statSync(ownerPath);
    return nowImpl() - stats.mtimeMs > staleMs;
  } catch {
    try {
      const stats = fs.statSync(lockPath);
      return nowImpl() - stats.mtimeMs > staleMs;
    } catch {
      return false;
    }
  }
}

function readPasteRateLimitLockOwner(ownerPath: string): { pid?: number | null } | null {
  if (!fs.existsSync(ownerPath)) {
    return null;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    return payload && typeof payload === "object" ? payload as { pid?: number | null } : null;
  } catch {
    return null;
  }
}

function readPasteRateLimitState(statePath: string): PasteRateLimitState | null {
  if (!fs.existsSync(statePath)) {
    return null;
  }

  try {
    const payload = JSON.parse(fs.readFileSync(statePath, "utf8")) as Partial<PasteRateLimitState>;
    const nextAllowedAt = Number(payload?.nextAllowedAt ?? 0);
    return {
      pid: Number.isInteger(Number(payload?.pid)) && Number(payload?.pid) > 0 ? Number(payload?.pid) : null,
      nextAllowedAt: Number.isFinite(nextAllowedAt) && nextAllowedAt > 0 ? nextAllowedAt : 0,
      updatedAt: String(payload?.updatedAt ?? "").trim(),
    };
  } catch {
    return null;
  }
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

function getPinnedTopReply(response: GuestReplyListResponse | null | undefined): GuestReplyNode | null {
  if (!response || typeof response !== "object") {
    return null;
  }

  const upper = response.upper && typeof response.upper === "object" ? response.upper : null;
  if (upper?.top && typeof upper.top === "object") {
    return upper.top;
  }

  const topWrapper = response.top && typeof response.top === "object"
    ? response.top as Record<string, unknown>
    : null;
  if (topWrapper?.upper && typeof topWrapper.upper === "object") {
    return topWrapper.upper as GuestReplyNode;
  }

  const topReplies = Array.isArray(response.top_replies) ? response.top_replies : [];
  if (topReplies[0] && typeof topReplies[0] === "object") {
    return topReplies[0] as GuestReplyNode;
  }

  return topWrapper as GuestReplyNode | null;
}

function normalizeGuestTopReply(reply: GuestReplyNode | null | undefined): GuestTopCommentReply | null {
  if (!reply || typeof reply !== "object") {
    return null;
  }

  const rpid = normalizeCommentRpid(reply.rpid ?? reply.rpid_str);
  if (!rpid) {
    return null;
  }

  const member = (typeof reply.member === "object" && reply.member !== null
    ? reply.member
    : {}) as Record<string, unknown>;

  return {
    rpid,
    oid: reply.oid ?? null,
    mid: reply.mid ?? member.mid ?? null,
    uname: typeof member.uname === "string" ? member.uname : null,
    message: extractReplyMessage(reply),
    like: reply.like ?? 0,
    count: reply.count ?? reply.rcount ?? 0,
    ctime: reply.ctime ?? null,
    raw: reply as Record<string, unknown>,
  };
}

function collectPasteDataFromReply(
  reply: GuestReplyNode | null | undefined,
  {
    pageSet,
    urlSet,
    scannedReplyRpids,
  }: {
    pageSet: Set<number>;
    urlSet: Set<string>;
    scannedReplyRpids: Set<number>;
  },
) {
  const replyRpid = normalizeCommentRpid(reply?.rpid ?? reply?.rpid_str);
  if (replyRpid) {
    if (scannedReplyRpids.has(replyRpid)) {
      return;
    }
    scannedReplyRpids.add(replyRpid);
  }

  const message = extractReplyMessage(reply);
  if (!message) {
    return;
  }

  for (const block of parseSummaryBlocks(message)) {
    const pasteUrl = extractPasteUrlFromSummaryBlock(block.text, block.marker);
    if (!pasteUrl) {
      continue;
    }

    urlSet.add(pasteUrl);
    for (const page of block.coveredPages ?? [block.page]) {
      if (Number.isInteger(page) && page > 0) {
        pageSet.add(page);
      }
    }
  }
}

function extractPasteUrlFromSummaryBlock(blockText: string, marker: string): string | null {
  const normalizedText = String(blockText ?? "").trim();
  const body = normalizedText.startsWith(marker)
    ? normalizedText.slice(marker.length).trim()
    : normalizedText;
  return /^https:\/\/paste\.rs\/\S+$/u.test(body) ? body : null;
}

function buildPasteArtifactPageLabel(message) {
  const coveredPages = extractCoveredPages(normalizeSummaryMarkers(message));
  if (coveredPages.length === 0) {
    return "all";
  }

  if (coveredPages.length === 1) {
    return `p${String(coveredPages[0]).padStart(2, "0")}`;
  }

  const firstPage = coveredPages[0];
  const lastPage = coveredPages[coveredPages.length - 1];
  const isConsecutive = coveredPages.every((page, index) => index === 0 || page === coveredPages[index - 1] + 1);
  if (isConsecutive) {
    return `p${String(firstPage).padStart(2, "0")}-p${String(lastPage).padStart(2, "0")}`;
  }

  return `p${String(firstPage).padStart(2, "0")}-mixed`;
}

function quoteShellDouble(value) {
  return `"${String(value ?? "").replace(/(["\\$`])/gu, "\\$1")}"`;
}

function writePasteUploadAttemptArtifacts({
  db,
  videoId,
  workRoot = "work",
  message,
}: {
  db: Parameters<typeof getVideoById>[0];
  videoId: number;
  workRoot?: string;
  message: string;
}) {
  const video = getVideoById(db, videoId);
  if (!video) {
    return null;
  }

  const workDir = ensureVideoWorkDir({
    db,
    video,
    workRoot,
  });
  const pageLabel = buildPasteArtifactPageLabel(message);
  const payloadFileName = `paste-${pageLabel}.txt`;
  const recordFileName = `paste-${pageLabel}.md`;
  const payloadPath = path.join(workDir, payloadFileName);
  const recordPath = path.join(workDir, recordFileName);
  const normalizedMessage = String(message ?? "");
  const createdAt = new Date().toISOString();
  const curlCommand = [
    `cd ${quoteShellDouble(workDir)}`,
    [
      "curl --request POST https://paste.rs",
      '--header "content-type: text/plain; charset=utf-8"',
      `--data-binary @${quoteShellDouble(payloadFileName)}`,
    ].join(" \\\n  "),
  ].join("\n");

  fs.writeFileSync(payloadPath, normalizedMessage ? `${normalizedMessage}\n` : "", "utf8");
  fs.writeFileSync(recordPath, [
    `# paste.rs Upload ${pageLabel}`,
    "",
    `- createdAt: ${createdAt}`,
    `- pageLabel: ${pageLabel}`,
    `- payloadFile: ${payloadFileName}`,
    `- chars: ${normalizedMessage.length}`,
    `- bytesUtf8: ${Buffer.byteLength(normalizedMessage, "utf8")}`,
    "",
    "## Curl",
    "",
    "```bash",
    curlCommand,
    "```",
    "",
    "## Result",
    "",
    "- status: pending",
    "",
  ].join("\n"), "utf8");

  return {
    recordPath,
    payloadPath,
    pageLabel,
  };
}

function finalizePasteUploadAttemptArtifact(
  artifact: {
    recordPath: string;
    payloadPath: string;
    pageLabel: string;
  } | null,
  {
    pasteUrl = null,
    error = null,
  }: {
    pasteUrl?: string | null;
    error?: unknown;
  } = {},
) {
  if (!artifact) {
    return;
  }

  const normalizedPasteUrl = String(pasteUrl ?? "").trim();
  const status = normalizedPasteUrl ? "succeeded" : "failed";
  const details = normalizedPasteUrl
    ? [`- status: ${status}`, `- pasteUrl: ${normalizedPasteUrl}`]
    : [
      `- status: ${status}`,
      `- error: ${String((error as { message?: unknown })?.message ?? error ?? "Unknown error").trim() || "Unknown error"}`,
      ...(Number((error as { status?: unknown })?.status) > 0
        ? [`- httpStatus: ${Number((error as { status?: unknown })?.status)}`]
        : []),
    ];

  fs.appendFileSync(artifact.recordPath, [
    `- finishedAt: ${new Date().toISOString()}`,
    ...details,
    "",
  ].join("\n"), "utf8");
}

function parseCommentPageBlocks(message) {
  return parseSummaryBlocks(message).map((block): CommentPageBlock => {
    const lines = String(block.text ?? "").replace(/\r\n/g, "\n").split("\n");
    const firstLine = lines[0] ?? block.marker;
    const markerMatch = firstLine.match(/^<(?<page>\d+)P>\s*(?<rest>.*)$/u);
    const bodyLines = [];
    if (markerMatch?.groups?.rest) {
      bodyLines.push(markerMatch.groups.rest);
    }
    bodyLines.push(...lines.slice(1));

    const units: CommentUnit[] = [];
    let currentUnit: CommentUnit | null = null;
    let textIndex = 0;
    const flushCurrentUnit = () => {
      if (!currentUnit) {
        return;
      }

      units.push(currentUnit);
      currentUnit = null;
    };

    const startUnit = ({ text, label = null, kind }: { text: string; label?: string | null; kind: CommentUnit["kind"] }) => {
      flushCurrentUnit();
      currentUnit = {
        id: label ? `${block.page}|time|${label}` : `${block.page}|text|${textIndex}`,
        page: block.page,
        label,
        kind,
        text,
      };
      if (!label) {
        textIndex += 1;
      }
    };

    for (const rawLine of bodyLines) {
      const line = String(rawLine ?? "");
      if (!line.trim()) {
        if (currentUnit) {
          currentUnit.text = `${currentUnit.text}\n${line}`;
        }
        continue;
      }

      const timestampMatch = line.match(TIMESTAMP_UNIT_PATTERN);
      if (timestampMatch?.groups?.label) {
        startUnit({
          text: line,
          label: timestampMatch.groups.label,
          kind: "timepoint",
        });
        continue;
      }

      if (!currentUnit || currentUnit.kind !== "timepoint") {
        startUnit({
          text: line,
          kind: "text",
        });
        continue;
      }

      currentUnit.text = `${currentUnit.text}\n${line}`;
    }

    flushCurrentUnit();

    return {
      page: block.page,
      marker: block.marker,
      units,
    };
  });
}

function buildMessageFromPageBlocks(pageBlocks) {
  return pageBlocks
    .map((block) => {
      if (!block.units.length) {
        return block.marker;
      }

      return [block.marker, ...block.units.map((unit) => unit.text)].join("\n");
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

function buildWholeCommentPasteFallback(pageBlocks, pasteUrl) {
  if (pageBlocks.length === 0) {
    return pasteUrl;
  }

  return buildMessageFromPageBlocks(pageBlocks.map((block) => ({
    ...block,
    units: [{
      id: `${block.page}|paste`,
      page: block.page,
      label: null,
      kind: "text",
      text: pasteUrl,
    }],
  })));
}

function buildWholeCommentPasteComment(pageBlocks, pasteUrl) {
  const pageSet = new Set<number>();
  for (const block of pageBlocks) {
    const page = Number(block.page);
    if (Number.isInteger(page) && page > 0) {
      pageSet.add(page);
    }
  }

  const pages = [...pageSet].sort((left, right) => left - right);

  if (pages.length === 0) {
    return pasteUrl;
  }

  const pageGroups = [];
  let rangeStart = pages[0];
  let previousPage = pages[0];

  for (const page of pages.slice(1)) {
    if (page === previousPage + 1) {
      previousPage = page;
      continue;
    }

    pageGroups.push(
      rangeStart === previousPage
        ? `<${rangeStart}P>`
        : `<${rangeStart}P> ~ <${previousPage}P>`,
    );
    rangeStart = page;
    previousPage = page;
  }

  pageGroups.push(
    rangeStart === previousPage
      ? `<${rangeStart}P>`
      : `<${rangeStart}P> ~ <${previousPage}P>`,
  );

  return `${pageGroups.join(", ")}\n${pasteUrl}`;
}

function buildCompactedPasteCommentMessage(pageBlocks) {
  const segments: string[] = [];
  let pasteGroup: CommentPageBlock[] = [];
  let pasteUrl = "";

  const flushPasteGroup = () => {
    if (!pasteGroup.length || !pasteUrl) {
      pasteGroup = [];
      pasteUrl = "";
      return;
    }

    segments.push(buildWholeCommentPasteComment(pasteGroup, pasteUrl));
    pasteGroup = [];
    pasteUrl = "";
  };

  for (const block of pageBlocks) {
    if (isPasteOnlyPageBlock(block)) {
      const currentPasteUrl = String(block.units[0]?.text ?? "").trim();
      if (pasteGroup.length > 0 && currentPasteUrl === pasteUrl) {
        pasteGroup.push(block);
        continue;
      }

      flushPasteGroup();
      pasteGroup = [block];
      pasteUrl = currentPasteUrl;
      continue;
    }

    flushPasteGroup();
    segments.push(buildMessageFromPageBlocks([block]));
  }

  flushPasteGroup();
  return segments.filter(Boolean).join("\n\n").trim();
}

function isPasteOnlyPageBlock(block) {
  return (
    Array.isArray(block?.units)
    && block.units.length === 1
    && /^https:\/\/paste\.rs\/\S+$/u.test(String(block.units[0]?.text ?? "").trim())
  );
}

function buildPasteOnlyPageBlock(block, pasteUrl) {
  return {
    ...block,
    units: [{
      id: `${block.page}|paste`,
      page: block.page,
      label: null,
      kind: "text",
      text: pasteUrl,
    }],
  };
}

function applyProcessedPagePatch(baseText, originalBlock, processedBlock) {
  if (isPasteOnlyPageBlock(processedBlock)) {
    return buildMessageFromPageBlocks([processedBlock]);
  }

  const parsedBaseBlocks = parseCommentPageBlocks(baseText);
  const baseBlock = parsedBaseBlocks.find((candidate) => candidate.page === originalBlock.page) ?? {
    page: originalBlock.page,
    marker: originalBlock.marker,
    units: originalBlock.units,
  };

  const originalUnitsById = new Map<string, CommentUnit>(originalBlock.units.map((unit) => [unit.id, unit]));
  const processedUnitsById = new Map<string, CommentUnit>(processedBlock.units.map((unit) => [unit.id, unit]));
  const nextUnits = baseBlock.units.map((unit) => {
    const originalUnit = originalUnitsById.get(unit.id);
    if (!originalUnit) {
      return unit;
    }

    const processedUnit = processedUnitsById.get(unit.id) ?? originalUnit;
    if (processedUnit.text === originalUnit.text) {
      return unit;
    }

    return {
      ...unit,
      text: processedUnit.text,
      kind: processedUnit.kind,
      label: processedUnit.label,
    };
  });

  return buildMessageFromPageBlocks([{
    page: baseBlock.page,
    marker: baseBlock.marker,
    units: nextUnits,
  }]);
}

function resolveUploadSourcePageBlock({
  db,
  videoId,
  fallbackBlock,
}: {
  db: Parameters<typeof getActiveVideoPartByPageNo>[0];
  videoId: number;
  fallbackBlock: CommentPageBlock;
}): CommentPageBlock {
  const part = getActiveVideoPartByPageNo(db, videoId, fallbackBlock.page);
  if (!part) {
    return fallbackBlock;
  }

  const rawText = normalizeStoredSummaryText(part.summary_text);
  if (!rawText) {
    return fallbackBlock;
  }

  const rawBlock = parseCommentPageBlocks(rawText).find((candidate) => candidate.page === fallbackBlock.page)
    ?? parseCommentPageBlocks(rawText)[0];
  return rawBlock ?? fallbackBlock;
}

function persistProcessedChunk({
  db,
  videoId,
  originalMessage,
  processedMessage,
}) {
  if (normalizeMessageForMatch(originalMessage) === normalizeMessageForMatch(processedMessage)) {
    return;
  }

  const originalBlocks = parseCommentPageBlocks(originalMessage);
  const processedBlocks = new Map(parseCommentPageBlocks(processedMessage).map((block) => [block.page, block]));

  for (const originalBlock of originalBlocks) {
    const processedBlock = processedBlocks.get(originalBlock.page) ?? originalBlock;
    const part = getActiveVideoPartByPageNo(db, videoId, originalBlock.page);
    if (!part) {
      continue;
    }

    const baseText = getPreferredSummaryTextForPart(part) || normalizeStoredSummaryText(part.summary_text) || "";
    const nextProcessedText = applyProcessedPagePatch(baseText, originalBlock, processedBlock);
    const rawText = normalizeStoredSummaryText(part.summary_text);
    savePartProcessedSummary(
      db,
      videoId,
      originalBlock.page,
      normalizeMessageForMatch(nextProcessedText) === normalizeMessageForMatch(rawText) ? null : nextProcessedText,
    );
  }
}

async function diagnoseInvisibleComment({
  db,
  videoId,
  message,
  fetchImpl = fetch,
  uploadToPasteImpl = uploadTextToPasteRs,
}) {
  const pageBlocks = parseCommentPageBlocks(message);
  if (pageBlocks.length === 0) {
    const pasteUrl = await uploadToPasteImpl(message, fetchImpl);
    return {
      badUnitIds: ["full-comment"],
      processedCommentMessage: pasteUrl,
      processedMessage: pasteUrl,
    };
  }

  const uploadSourceBlocks = pageBlocks.map((block) => resolveUploadSourcePageBlock({
    db,
    videoId,
    fallbackBlock: block,
  }));
  const pasteUrl = await uploadToPasteImpl(buildMessageFromPageBlocks(uploadSourceBlocks), fetchImpl);
  const processedPageBlocks = pageBlocks.map((block) => buildPasteOnlyPageBlock(block, pasteUrl));

  const processedMessage = buildMessageFromPageBlocks(processedPageBlocks);

  return {
    badUnitIds: pageBlocks.flatMap((block) => block.units.map((unit) => unit.id)),
    processedCommentMessage: buildCompactedPasteCommentMessage(processedPageBlocks),
    processedMessage,
  };
}

function buildCreatedCommentRecord({ replyRes, rootRpid, chunk, isRoot, sanitizedMessage = null }) {
  return {
    rpid: replyRes.rpid,
    root: rootRpid,
    parent: rootRpid,
    pages: chunk.pages,
    messageLength: normalizeMessageForMatch(sanitizedMessage ?? chunk.message).length,
    isRoot,
  };
}

async function findAdoptableVisibleComment({
  oid,
  type,
  message,
  isRoot,
  rootRpid = null,
  guestReplyListImpl = defaultGuestReplyListImpl,
  fetchImpl = fetch,
}) {
  const visibleComment = await findVisibleCommentAsGuest({
    oid,
    type,
    rootRpid,
    targetRpid: null,
    expectedMessage: message,
    isRoot,
    guestReplyListImpl,
    fetchImpl,
  });
  if (!visibleComment) {
    return null;
  }

  const visibleRpid = normalizeCommentRpid(visibleComment?.rpid ?? visibleComment?.rpid_str);
  if (!visibleRpid) {
    return null;
  }

  return {
    rpid: visibleRpid,
    rootRpid: isRoot
      ? visibleRpid
      : normalizeCommentRpid(visibleComment?.root ?? rootRpid) ?? normalizeCommentRpid(rootRpid),
  };
}

async function createRootComment({ client, oid, type, message, sleepImpl = sleep }) {
  const rootRes = await client.reply.add({
    oid,
    type,
    message,
    plat: 1,
  });

  await sleepImpl(ROOT_TOP_DELAY_MS);
  let topError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await client.reply.top({
        oid,
        type,
        rpid: rootRes.rpid,
        action: 1,
      });
      topError = null;
      break;
    } catch (error) {
      topError = error;
      if (attempt === 0 && isRetryableRootTopError(error)) {
        await sleepImpl(ROOT_TOP_RETRY_DELAY_MS);
        continue;
      }
      break;
    }
  }

  return {
    replyRes: rootRes,
    warnings: topError
      ? [
        buildCommentWarning({
          step: "top-root-comment",
          rpid: rootRes.rpid,
          error: topError,
        }),
      ]
      : [],
  };
}

async function createReplyComment({ client, oid, type, rootRpid, message }) {
  return {
    replyRes: await client.reply.add({
      oid,
      type,
      root: rootRpid,
      parent: rootRpid,
      message,
      plat: 1,
    }),
    warnings: [],
  };
}

async function createCommentWithDuplicateRecovery({
  createComment,
  oid,
  type,
  message,
  isRoot,
  rootRpid = null,
  allowExistingCommentAdoption = true,
  sleepImpl = sleep,
  guestReplyListImpl = defaultGuestReplyListImpl,
  fetchImpl = fetch,
}) {
  try {
    const created = await createComment(message);
    return {
      ...created,
      adoptedExistingComment: false,
    };
  } catch (error) {
    const duplicateDetected = isDuplicateCommentError(error)
      || String((error as { message?: unknown })?.message ?? "").toLowerCase().includes("duplicate comment");
    if (!duplicateDetected) {
      throw error;
    }
    if (!allowExistingCommentAdoption) {
      throw error;
    }

    const visibleComment = await findVisibleCommentAsGuestWithRetries({
      oid,
      type,
      rootRpid,
      targetRpid: null,
      expectedMessage: message,
      isRoot,
      sleepImpl,
      guestReplyListImpl,
      fetchImpl,
    });
    if (!visibleComment) {
      throw createCliError("Published comment is not visible to guests", {
        oid,
        type,
        rootRpid: normalizeCommentRpid(rootRpid),
        isRoot,
        expectedMessage: normalizeMessageForMatch(message),
        duplicateDetected: true,
      });
    }

    return {
      replyRes: {
        rpid: visibleComment.rpid,
      },
      warnings: [
        buildCommentWarning({
          step: isRoot
            ? "duplicate-probe-confirmed-visible-root-comment"
            : "duplicate-probe-confirmed-visible-reply-comment",
          rpid: visibleComment.rpid,
          error,
          details: {
            confirmedVisibleAfterDuplicateProbe: true,
            visibleRpid: visibleComment.rpid,
          },
        }),
      ],
      adoptedExistingComment: true,
    };
  }
}

async function deleteCommentSilently({ client, oid, type, rpid }) {
  const normalizedRpid = normalizeCommentRpid(rpid);
  if (!normalizedRpid) {
    return;
  }

  await client.reply.delete({
    oid,
    type,
    rpid: normalizedRpid,
  }).catch(() => null);
}

async function publishCommentChunk({
  client,
  oid,
  type,
  db,
  videoId,
  chunk,
  isRoot,
  rootRpid = null,
  allowExistingCommentAdoption = true,
  sleepImpl = sleep,
  guestReplyListImpl = defaultGuestReplyListImpl,
  fetchImpl = fetch,
  uploadToPasteImpl = uploadTextToPasteRs,
}) {
  const createComment = isRoot
    ? async (message) => createRootComment({
        client,
      oid,
      type,
      message,
      sleepImpl,
    })
    : async (message) => createReplyComment({
      client,
      oid,
      type,
        rootRpid,
        message,
      });

  const initialPublish = await createCommentWithDuplicateRecovery({
    createComment,
    oid,
    type,
    message: chunk.message,
    isRoot,
    rootRpid,
    allowExistingCommentAdoption,
    sleepImpl,
    guestReplyListImpl,
    fetchImpl,
  });
  const initialRpid = normalizeCommentRpid(initialPublish.replyRes?.rpid);
  const visibilityRootRpid = isRoot ? initialRpid : rootRpid;

  if (initialPublish.adoptedExistingComment) {
    return {
      replyRes: initialPublish.replyRes,
      rootRpid: isRoot ? initialRpid : rootRpid,
      finalMessage: chunk.message,
      warnings: initialPublish.warnings,
      recoveredByProcessing: false,
      replacedInvisibleRpid: null,
      adoptedExistingComment: true,
    };
  }

  try {
    await assertCommentVisibleAsGuest({
      oid,
      type,
      targetRpid: initialRpid,
      expectedMessage: chunk.message,
      isRoot,
      rootRpid: visibilityRootRpid,
      sleepImpl,
      guestReplyListImpl,
      fetchImpl,
    });

    return {
      replyRes: initialPublish.replyRes,
      rootRpid: isRoot ? initialRpid : rootRpid,
      finalMessage: chunk.message,
      warnings: initialPublish.warnings,
      recoveredByProcessing: false,
      replacedInvisibleRpid: null,
      adoptedExistingComment: false,
    };
  } catch (error) {
    let diagnosis;
    try {
      diagnosis = await diagnoseInvisibleComment({
        db,
        videoId,
        message: chunk.message,
        fetchImpl,
        uploadToPasteImpl,
      });
    } catch (diagnosisError) {
      if (allowExistingCommentAdoption && initialRpid && isDuplicateCommentError(diagnosisError)) {
        const visibleComment = await findVisibleCommentAsGuest({
          oid,
          type,
          rootRpid: visibilityRootRpid,
          targetRpid: initialRpid,
          expectedMessage: chunk.message,
          isRoot,
          guestReplyListImpl,
          fetchImpl,
        });
        if (!visibleComment) {
          throw error;
        }

        return {
          replyRes: {
            ...initialPublish.replyRes,
            rpid: normalizeCommentRpid(visibleComment?.rpid ?? initialRpid) ?? initialRpid,
          },
          rootRpid: isRoot
            ? normalizeCommentRpid(visibleComment?.rpid ?? initialRpid) ?? initialRpid
            : rootRpid,
          finalMessage: chunk.message,
          warnings: [
            ...initialPublish.warnings,
            buildCommentWarning({
              step: isRoot
                ? "duplicate-probe-confirmed-visible-root-comment"
                : "duplicate-probe-confirmed-visible-reply-comment",
              rpid: initialRpid,
              error: diagnosisError,
              details: {
                confirmedVisibleAfterDuplicateProbe: true,
                visibleRpid: normalizeCommentRpid(visibleComment?.rpid ?? initialRpid) ?? initialRpid,
              },
            }),
          ],
          recoveredByProcessing: false,
          replacedInvisibleRpid: null,
          adoptedExistingComment: true,
        };
      }

      throw diagnosisError;
    }

    const processedCommentMessage = normalizeMessageForMatch(diagnosis.processedCommentMessage);
    const processedMessage = normalizeSummaryMarkers(diagnosis.processedMessage);
    const normalizedChunkMessage = normalizeSummaryMarkers(chunk.message);
    if (
      !processedCommentMessage
      || !processedMessage
      || (
        processedMessage === normalizedChunkMessage
        && processedCommentMessage === normalizeMessageForMatch(chunk.message)
      )
    ) {
      throw createCliError("Published comment is not visible to guests", {
        oid,
        type,
        rpid: initialRpid,
        rootRpid: visibilityRootRpid,
        isRoot,
        badUnitIds: diagnosis.badUnitIds,
      });
    }

    await deleteCommentSilently({
      client,
      oid,
      type,
      rpid: initialRpid,
    });

    const retryPublish = await createCommentWithDuplicateRecovery({
      createComment,
      oid,
      type,
      message: processedCommentMessage,
      isRoot,
      rootRpid,
      allowExistingCommentAdoption,
      sleepImpl,
      guestReplyListImpl,
      fetchImpl,
    });
    const retryRpid = normalizeCommentRpid(retryPublish.replyRes?.rpid);
    const retryVisibilityRootRpid = isRoot ? retryRpid : rootRpid;

    if (!retryPublish.adoptedExistingComment) {
      await assertCommentVisibleAsGuest({
        oid,
        type,
        targetRpid: retryRpid,
        expectedMessage: processedCommentMessage,
        isRoot,
        rootRpid: retryVisibilityRootRpid,
        sleepImpl,
        guestReplyListImpl,
        fetchImpl,
      });
    }

    persistProcessedChunk({
      db,
      videoId,
      originalMessage: chunk.message,
      processedMessage,
    });

    return {
      replyRes: retryPublish.replyRes,
      rootRpid: isRoot ? retryRpid : rootRpid,
      finalMessage: processedCommentMessage,
      warnings: [
        ...initialPublish.warnings,
        ...retryPublish.warnings,
        buildCommentWarning({
          step: isRoot ? "guest-visible-root-comment" : "guest-visible-reply-comment",
          rpid: initialRpid,
          error,
          details: {
            recoveredByProcessing: true,
            badUnitIds: diagnosis.badUnitIds,
          },
        }),
      ],
      recoveredByProcessing: true,
      replacedInvisibleRpid: initialRpid,
      adoptedExistingComment: retryPublish.adoptedExistingComment,
    };
  }
}

export function isMissingCommentThreadError(error) {
  return isDeletedCommentThreadError(error);
}

export async function postSummaryThread({
  client,
  oid,
  type,
  message,
  db,
  videoId,
  topCommentState,
  existingRootRpid = null,
  forcedRootRpid = null,
  workRoot = "work",
  allowExistingCommentAdoption = true,
  sleepImpl = sleep,
  guestReplyListImpl = defaultGuestReplyListImpl,
  fetchImpl = fetch,
  uploadToPasteImpl = uploadTextToPasteRs,
}) {
  const normalizedMessage = normalizeSummaryMarkers(message);
  if (!normalizedMessage) {
    throw createCliError("Comment content is empty");
  }

  const chunks = splitSummaryForComments(normalizedMessage, BILIBILI_COMMENT_MAX_LENGTH);
  if (chunks.length === 0) {
    throw createCliError("No comment chunks generated from summary");
  }

  let rootRpid = forcedRootRpid
    ?? existingRootRpid
    ?? (allowExistingCommentAdoption ? topCommentState.topComment?.rpid ?? null : null);
  const initialRootRpid = rootRpid;
  const createdComments = [];
  const warnings = [];
  const adoptedPages = [];
  let recoveredFromDeletedRoot = false;
  let replacedRootCommentRpid = null;
  let reusedExistingRootComment = false;
  const uploadToPasteWithArtifacts = async (text, activeFetchImpl = fetchImpl) => {
    const artifact = writePasteUploadAttemptArtifacts({
      db,
      videoId,
      workRoot,
      message: text,
    });

    try {
      await waitForGlobalPasteUploadTurn({
        workRoot,
      });
      const pasteUrl = await uploadToPasteImpl(text, activeFetchImpl);
      finalizePasteUploadAttemptArtifact(artifact, {
        pasteUrl,
      });
      return pasteUrl;
    } catch (error) {
      finalizePasteUploadAttemptArtifact(artifact, {
        error,
      });
      throw error;
    }
  };

  if (rootRpid && (!topCommentState.hasTopComment || topCommentState.topComment?.rpid !== rootRpid)) {
    await client.reply.top({
      oid,
      type,
      rpid: rootRpid,
      action: 1,
    }).catch(() => null);
  }

  const pendingChunks = [...chunks];
  if (
    allowExistingCommentAdoption
    && !forcedRootRpid
    && !existingRootRpid
    && rootRpid
    && topCommentState.topComment
    && commentMessageMatches(topCommentState.topComment.message, pendingChunks[0]?.message ?? "")
  ) {
    const adoptedRootChunk = pendingChunks.shift();
    if (adoptedRootChunk) {
      adoptedPages.push(...adoptedRootChunk.pages);
      reusedExistingRootComment = true;
    }
  }
  if (allowExistingCommentAdoption
    && !rootRpid
    && !forcedRootRpid
    && !existingRootRpid
    && pendingChunks[0]) {
    const visibleRootComment = await findAdoptableVisibleComment({
      oid,
      type,
      message: pendingChunks[0].message,
      isRoot: true,
      guestReplyListImpl,
      fetchImpl,
    });
    if (visibleRootComment) {
      const adoptedRootChunk = pendingChunks.shift();
      rootRpid = visibleRootComment.rpid;
      reusedExistingRootComment = true;
      if (adoptedRootChunk) {
        adoptedPages.push(...adoptedRootChunk.pages);
      }
    }
  }

  for (const [index, chunk] of pendingChunks.entries()) {
    const shouldCreateRoot = !rootRpid;

    if (allowExistingCommentAdoption && !shouldCreateRoot) {
      const visibleReplyComment = await findAdoptableVisibleComment({
        oid,
        type,
        message: chunk.message,
        isRoot: false,
        rootRpid,
        guestReplyListImpl,
        fetchImpl,
      });
      if (visibleReplyComment) {
        adoptedPages.push(...chunk.pages);
        continue;
      }
    }

    try {
      const published = await publishCommentChunk({
        client,
        oid,
        type,
        db,
        videoId,
        chunk,
        isRoot: shouldCreateRoot,
        rootRpid,
        allowExistingCommentAdoption,
        sleepImpl,
        guestReplyListImpl,
        fetchImpl,
        uploadToPasteImpl: uploadToPasteWithArtifacts,
      });

      rootRpid = published.rootRpid;
      warnings.push(...published.warnings);
      if (published.adoptedExistingComment) {
        adoptedPages.push(...chunk.pages);
        if (shouldCreateRoot) {
          reusedExistingRootComment = true;
        }
      } else {
        createdComments.push(
          buildCreatedCommentRecord({
            replyRes: published.replyRes,
            rootRpid,
            chunk,
            isRoot: shouldCreateRoot,
            sanitizedMessage: published.finalMessage,
          }),
        );
      }

      if (index < pendingChunks.length - 1) {
        await sleepImpl(REPLY_POST_DELAY_MS);
      }
    } catch (error) {
      if (createdComments.length === 0 && rootRpid && isDeletedCommentThreadError(error)) {
        replacedRootCommentRpid = rootRpid;
        rootRpid = null;
        recoveredFromDeletedRoot = true;
        const retried = await publishCommentChunk({
          client,
          oid,
          type,
          db,
          videoId,
          chunk,
          isRoot: true,
          rootRpid: null,
          allowExistingCommentAdoption,
          sleepImpl,
          guestReplyListImpl,
          fetchImpl,
          uploadToPasteImpl: uploadToPasteWithArtifacts,
        });
        rootRpid = retried.rootRpid;
          warnings.push(...retried.warnings);
          if (retried.adoptedExistingComment) {
            adoptedPages.push(...chunk.pages);
            reusedExistingRootComment = true;
          } else {
            createdComments.push(
              buildCreatedCommentRecord({
                replyRes: retried.replyRes,
                rootRpid,
                chunk,
                isRoot: true,
                sanitizedMessage: retried.finalMessage,
              }),
            );
          }
          continue;
        }

      throw error;
    }
  }

  updateVideoCommentThread(db, videoId, {
    rootCommentRpid: rootRpid,
    topCommentRpid: rootRpid,
  });

  const coveredPages = [...new Set([
    ...adoptedPages,
    ...createdComments.flatMap((item) => item.pages),
  ])].sort((a, b) => a - b);
  if (coveredPages.length > 0) {
    markPartsPublished(db, videoId, coveredPages, rootRpid);
  }

  return {
    action: createdComments.some((item) => item.isRoot)
      ? "comment-thread-created-or-extended"
      : reusedExistingRootComment && createdComments.length === 0
        ? "adopt-existing-root-comment-thread"
        : "reply-to-comment-thread",
    normalizedMessage,
    coveredPagesFromMessage: extractCoveredPages(normalizedMessage),
    rootCommentRpid: rootRpid,
    recoveredFromDeletedRoot,
    replacedRootCommentRpid: replacedRootCommentRpid ?? (normalizeCommentRpid(initialRootRpid) !== normalizeCommentRpid(rootRpid) ? initialRootRpid : null),
    createdComments,
    reusedExistingRootComment,
    warnings,
  };
}

export async function deleteSummaryThread({
  client,
  oid,
  type,
  rootRpid,
}) {
  if (!rootRpid) {
    return {
      ok: true,
      deleted: false,
      reason: "missing-root-rpid",
    };
  }

  try {
    await client.reply.delete({
      oid,
      type,
      rpid: rootRpid,
    });

    return {
      ok: true,
      deleted: true,
      rootRpid,
    };
  } catch (error) {
    if (isDeletedCommentThreadError(error)) {
      return {
        ok: true,
        deleted: false,
        rootRpid,
        alreadyMissing: true,
      };
    }

    throw error;
  }
}
