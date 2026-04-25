import { utils } from "@renmu/bili-api";
import { createCliError, extractErrorDetails } from "../cli/errors";
import {
  getActiveVideoPartByPageNo,
  getPreferredSummaryTextForPart,
  markPartsPublished,
  normalizeStoredSummaryText,
  savePartProcessedSummary,
  updateVideoCommentThread,
} from "../db/index";
import {
  extractCoveredPages,
  normalizeSummaryMarkers,
  parseSummaryBlocks,
  splitSummaryForComments,
} from "../summary/format";

const sleep = (timeout) =>
  new Promise((resolve) => {
    setTimeout(resolve, timeout);
  });

const ROOT_TOP_DELAY_MS = 5000;
const ROOT_TOP_RETRY_DELAY_MS = 5000;
const REPLY_POST_DELAY_MS = 5000;
const GUEST_VISIBILITY_DELAY_MS = 20000;
const GUEST_COMMENT_SCAN_PAGE_LIMIT = 5;
const GUEST_REPLY_PAGE_SIZE = 20;
const BILIBILI_COMMENT_MAX_LENGTH = 700;
const TIMESTAMP_UNIT_PATTERN = /^(?<label>\d+#\d{1,2}:\d{2}(?::\d{2})?)\s+(?<rest>.+)$/u;
const GUEST_COMMENT_WEB_LOCATION = 1315875;
const GUEST_COMMENT_MODE = 3;

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

      if (normalizedExpectedMessage && extractReplyMessage(reply) === normalizedExpectedMessage) {
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
  await sleepImpl(GUEST_VISIBILITY_DELAY_MS);
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

function applyProcessedPagePatch(baseText, originalBlock, processedBlock) {
  if (
    processedBlock.units.length === 1
    && /^https:\/\/paste\.rs\/\S+$/u.test(String(processedBlock.units[0]?.text ?? "").trim())
  ) {
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
  message,
  fetchImpl = fetch,
  uploadToPasteImpl = uploadTextToPasteRs,
}) {
  const pageBlocks = parseCommentPageBlocks(message);
  const pasteUrl = await uploadToPasteImpl(message, fetchImpl);

  return {
    badUnitIds: pageBlocks.length > 0
      ? pageBlocks.flatMap((block) => block.units.map((unit) => unit.id))
      : ["full-comment"],
    processedMessage: buildWholeCommentPasteFallback(pageBlocks, pasteUrl),
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

  const initialPublish = await createComment(chunk.message);
  const initialRpid = normalizeCommentRpid(initialPublish.replyRes?.rpid);
  const visibilityRootRpid = isRoot ? initialRpid : rootRpid;

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
    };
  } catch (error) {
    let diagnosis;
    try {
      diagnosis = await diagnoseInvisibleComment({
        message: chunk.message,
        fetchImpl,
        uploadToPasteImpl,
      });
    } catch (diagnosisError) {
      if (initialRpid && isDuplicateCommentError(diagnosisError)) {
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
        };
      }

      throw diagnosisError;
    }

    const processedMessage = normalizeSummaryMarkers(diagnosis.processedMessage);
    if (!processedMessage || processedMessage === normalizeSummaryMarkers(chunk.message)) {
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

    const retryPublish = await createComment(processedMessage);
    const retryRpid = normalizeCommentRpid(retryPublish.replyRes?.rpid);
    const retryVisibilityRootRpid = isRoot ? retryRpid : rootRpid;

    await assertCommentVisibleAsGuest({
      oid,
      type,
      targetRpid: retryRpid,
      expectedMessage: processedMessage,
      isRoot,
      rootRpid: retryVisibilityRootRpid,
      sleepImpl,
      guestReplyListImpl,
      fetchImpl,
    });

    persistProcessedChunk({
      db,
      videoId,
      originalMessage: chunk.message,
      processedMessage,
    });

    return {
      replyRes: retryPublish.replyRes,
      rootRpid: isRoot ? retryRpid : rootRpid,
      finalMessage: processedMessage,
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

  let rootRpid = forcedRootRpid ?? existingRootRpid ?? topCommentState.topComment?.rpid ?? null;
  const initialRootRpid = rootRpid;
  const createdComments = [];
  const warnings = [];
  const adoptedPages = [];
  let recoveredFromDeletedRoot = false;
  let replacedRootCommentRpid = null;
  let reusedExistingRootComment = false;

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
    !forcedRootRpid
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

  for (const [index, chunk] of pendingChunks.entries()) {
    const shouldCreateRoot = !rootRpid;

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
        sleepImpl,
        guestReplyListImpl,
        fetchImpl,
        uploadToPasteImpl,
      });

      rootRpid = published.rootRpid;
      warnings.push(...published.warnings);
      createdComments.push(
        buildCreatedCommentRecord({
          replyRes: published.replyRes,
          rootRpid,
          chunk,
          isRoot: shouldCreateRoot,
          sanitizedMessage: published.finalMessage,
        }),
      );

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
          sleepImpl,
          guestReplyListImpl,
          fetchImpl,
          uploadToPasteImpl,
        });
        rootRpid = retried.rootRpid;
        warnings.push(...retried.warnings);
        createdComments.push(
          buildCreatedCommentRecord({
            replyRes: retried.replyRes,
            rootRpid,
            chunk,
            isRoot: true,
            sanitizedMessage: retried.finalMessage,
          }),
        );
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
