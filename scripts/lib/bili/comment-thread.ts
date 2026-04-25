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
const BILIBILI_COMMENT_MAX_LENGTH = 700;
const TIMESTAMP_UNIT_PATTERN = /^(?<label>\d+#\d{1,2}:\d{2}(?::\d{2})?)\s+(?<rest>.+)$/u;

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

const DELETED_COMMENT_PATTERNS = [
  "已经被删除",
  "已被删除",
  "评论不存在",
  "该评论不存在",
  "根评论不存在",
  "楼层不存在",
];

const DUPLICATE_COMMENT_PATTERNS = ["重复评论"];

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

  const safeResponse = response;
  const upper = safeResponse.upper && typeof safeResponse.upper === "object" ? safeResponse.upper : null;
  const root = safeResponse.root && typeof safeResponse.root === "object" ? safeResponse.root : null;

  return [
    upper?.top ?? null,
    safeResponse.top ?? null,
    root ?? null,
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

async function fetchGuestTopLevelReplies({ oid, type, pn, ps = 20, fetchImpl = fetch }) {
  return fetchBilibiliGuestJson(buildGuestApiUrl("/x/v2/reply", {
    oid,
    type,
    sort: 0,
    nohot: 0,
    pn,
    ps,
  }), fetchImpl);
}

async function fetchGuestChildReplies({ oid, type, rootRpid, pn, ps = 20, fetchImpl = fetch }) {
  return fetchBilibiliGuestJson(buildGuestApiUrl("/x/v2/reply/reply", {
    oid,
    type,
    root: rootRpid,
    pn,
    ps,
  }), fetchImpl);
}

async function findVisibleCommentAsGuest({
  oid,
  type,
  rootRpid = null,
  targetRpid,
  expectedMessage,
  isRoot,
  fetchImpl = fetch,
}) {
  if (isRoot) {
    for (let pageNo = 1; pageNo <= GUEST_COMMENT_SCAN_PAGE_LIMIT; pageNo += 1) {
      const response = await fetchGuestTopLevelReplies({
        oid,
        type,
        pn: pageNo,
        fetchImpl,
      });
      const match = findReplyNode(response, {
        targetRpid,
        expectedMessage,
      });
      if (match) {
        return match;
      }

      const totalCount = normalizeCommentCount(response?.page?.count);
      if (totalCount === 0 || pageNo * 20 >= totalCount) {
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
      fetchImpl,
    });
    const match = findReplyNode(response, {
      targetRpid,
      expectedMessage,
    });
    if (match) {
      return match;
    }

    const totalCount = normalizeCommentCount(response?.page?.count ?? response?.page?.acount);
    if (totalCount === 0 || pageNo * 20 >= totalCount) {
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

function filterPageBlocksByUnitIds(pageBlocks, unitIds) {
  const allowedUnitIds = new Set(unitIds);
  return pageBlocks
    .map((block) => ({
      ...block,
      units: block.units.filter((unit) => allowedUnitIds.has(unit.id)),
    }))
    .filter((block) => block.units.length > 0);
}

async function probeCommentVisibility({
  client,
  oid,
  type,
  rootRpid = null,
  message,
  isRoot,
  sleepImpl = sleep,
  fetchImpl = fetch,
}) {
  let postedRpid = null;

  try {
    const replyRes = isRoot
      ? await client.reply.add({
          oid,
          type,
          message,
          plat: 1,
        })
      : await client.reply.add({
          oid,
          type,
          root: rootRpid,
          parent: rootRpid,
          message,
          plat: 1,
        });
    postedRpid = normalizeCommentRpid(replyRes?.rpid);

    if (!postedRpid) {
      return false;
    }

    await sleepImpl(GUEST_VISIBILITY_DELAY_MS);
    const visibleComment = await findVisibleCommentAsGuest({
      oid,
      type,
      rootRpid: isRoot ? postedRpid : rootRpid,
      targetRpid: postedRpid,
      expectedMessage: message,
      isRoot,
      fetchImpl,
    });
    if (visibleComment) {
      return true;
    }
    return Boolean(await findVisibleCommentAsGuest({
      oid,
      type,
      rootRpid: isRoot ? postedRpid : rootRpid,
      targetRpid: postedRpid,
      expectedMessage: message,
      isRoot,
      fetchImpl,
    }));
  } finally {
    if (postedRpid) {
      await client.reply.delete({
        oid,
        type,
        rpid: postedRpid,
      }).catch(() => null);
    }
  }
}

async function collectProblematicUnitIds({
  pageBlocks,
  client,
  oid,
  type,
  rootRpid = null,
  isRoot,
  sleepImpl = sleep,
  fetchImpl = fetch,
}) {
  const allUnits = pageBlocks.flatMap((block) => block.units);
  const cache = new Map();

  const testUnitIds = async (unitIds) => {
    const testMessage = buildMessageFromPageBlocks(filterPageBlocksByUnitIds(pageBlocks, unitIds));
    if (!testMessage) {
      return true;
    }

    if (cache.has(testMessage)) {
      return cache.get(testMessage);
    }

    const visible = await probeCommentVisibility({
      client,
      oid,
      type,
      rootRpid,
      message: testMessage,
      isRoot,
      sleepImpl,
      fetchImpl,
    });
    cache.set(testMessage, visible);
    return visible;
  };

  async function collect(unitIds) {
    if (unitIds.length === 0) {
      return [];
    }

    const visible = await testUnitIds(unitIds);
    if (visible) {
      return [];
    }

    if (unitIds.length === 1) {
      return unitIds;
    }

    const middleIndex = Math.ceil(unitIds.length / 2);
    const leftIds = unitIds.slice(0, middleIndex);
    const rightIds = unitIds.slice(middleIndex);
    const badUnitIds = [];

    if (leftIds.length > 0 && !(await testUnitIds(leftIds))) {
      badUnitIds.push(...await collect(leftIds));
    }

    if (rightIds.length > 0 && !(await testUnitIds(rightIds))) {
      badUnitIds.push(...await collect(rightIds));
    }

    if (badUnitIds.length > 0) {
      return [...new Set(badUnitIds)];
    }

    const singleUnitMatches = [];
    for (const unitId of unitIds) {
      if (!(await testUnitIds([unitId]))) {
        singleUnitMatches.push(unitId);
      }
    }

    if (singleUnitMatches.length > 0) {
      return singleUnitMatches;
    }

    return unitIds;
  }

  return collect(allUnits.map((unit) => unit.id));
}

function buildSanitizedUnitText(unit, pasteUrl) {
  if (unit.label) {
    return `${unit.label} ${pasteUrl}`;
  }

  return pasteUrl;
}

function buildSanitizedPageBlocks(pageBlocks, badUnitUrls) {
  return pageBlocks.map((block) => ({
    ...block,
    units: block.units.map((unit) => {
      const pasteUrl = badUnitUrls.get(unit.id);
      if (!pasteUrl) {
        return unit;
      }

      return {
        ...unit,
        text: buildSanitizedUnitText(unit, pasteUrl),
      };
    }),
  }));
}

function applyProcessedPagePatch(baseText, originalBlock, processedBlock) {
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
  client,
  oid,
  type,
  rootRpid = null,
  message,
  isRoot,
  sleepImpl = sleep,
  fetchImpl = fetch,
  uploadToPasteImpl = uploadTextToPasteRs,
}) {
  const pageBlocks = parseCommentPageBlocks(message);
  if (pageBlocks.length === 0) {
    const pasteUrl = await uploadToPasteImpl(message, fetchImpl);
    return {
      badUnitIds: ["full-comment"],
      processedMessage: pasteUrl,
    };
  }

  const badUnitIds = await collectProblematicUnitIds({
    pageBlocks,
    client,
    oid,
    type,
    rootRpid,
    isRoot,
    sleepImpl,
    fetchImpl,
  });

  const badUnitUrls = new Map();
  for (const block of pageBlocks) {
    for (const unit of block.units) {
      if (!badUnitIds.includes(unit.id)) {
        continue;
      }

      badUnitUrls.set(unit.id, await uploadToPasteImpl(unit.text, fetchImpl));
    }
  }

  return {
    badUnitIds,
    processedMessage: buildMessageFromPageBlocks(buildSanitizedPageBlocks(pageBlocks, badUnitUrls)),
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
        client,
        oid,
        type,
        rootRpid,
        message: chunk.message,
        isRoot,
        sleepImpl,
        fetchImpl,
        uploadToPasteImpl,
      });
    } catch (diagnosisError) {
      if (initialRpid && isDuplicateCommentError(diagnosisError)) {
        return {
          replyRes: initialPublish.replyRes,
          rootRpid: isRoot ? initialRpid : rootRpid,
          finalMessage: chunk.message,
          warnings: [
            ...initialPublish.warnings,
            buildCommentWarning({
              step: isRoot
                ? "duplicate-probe-assumed-published-root-comment"
                : "duplicate-probe-assumed-published-reply-comment",
              rpid: initialRpid,
              error: diagnosisError,
              details: {
                assumedPublishedAfterDuplicateProbe: true,
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
