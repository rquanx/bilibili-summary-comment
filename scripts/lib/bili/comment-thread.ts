import { createCliError, extractErrorDetails } from "../cli/errors";
import { extractCoveredPages, normalizeSummaryMarkers, splitSummaryForComments } from "../summary/format";
import { markPartsPublished, updateVideoCommentThread } from "../db/index";

const sleep = (timeout) =>
  new Promise((resolve) => {
    setTimeout(resolve, timeout);
  });

const ROOT_TOP_DELAY_MS = 1000;
const ROOT_TOP_RETRY_DELAY_MS = 2500;
const REPLY_POST_DELAY_MS = 1500;
const THREAD_VISIBILITY_RETRY_DELAY_MS = 2000;
const THREAD_VISIBILITY_MAX_ATTEMPTS = 3;

const DELETED_COMMENT_PATTERNS = [
  "\u5df2\u7ecf\u88ab\u5220\u9664",
  "\u5df2\u88ab\u5220\u9664",
  "\u8bc4\u8bba\u4e0d\u5b58\u5728",
  "\u8be5\u8bc4\u8bba\u4e0d\u5b58\u5728",
  "\u6839\u8bc4\u8bba\u4e0d\u5b58\u5728",
  "\u697c\u5c42\u4e0d\u5b58\u5728",
];

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

function isRetryableRootTopError(error) {
  const messages = getCommentErrorMessages(error);
  return messages.some((message) => message.includes("啥都木有") || message.includes("稍后"));
}

function buildCommentWarning({ step, rpid, error }) {
  return {
    step,
    rpid,
    message: error?.message ?? "Unknown comment error",
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

function findReplyNodeByRpid(response, targetRpid) {
  const normalizedTargetRpid = normalizeCommentRpid(targetRpid);
  if (!normalizedTargetRpid || !response || typeof response !== "object") {
    return null;
  }

  const safeResponse = response;
  const upper = safeResponse.upper && typeof safeResponse.upper === "object" ? safeResponse.upper : null;
  const candidates = [
    upper?.top ?? null,
    safeResponse.top ?? null,
    ...(Array.isArray(safeResponse.replies) ? safeResponse.replies : []),
  ];

  for (const candidate of candidates) {
    for (const reply of collectReplyNodes(candidate)) {
      if (normalizeCommentRpid(reply?.rpid ?? reply?.rpid_str) === normalizedTargetRpid) {
        return reply;
      }
    }
  }

  return null;
}

async function assertCommentThreadVisible({
  client,
  oid,
  type,
  rootRpid,
  minVisibleReplyCount = null,
  sleepImpl = sleep,
}) {
  const normalizedRootRpid = normalizeCommentRpid(rootRpid);
  if (!normalizedRootRpid) {
    throw createCliError("Missing root comment rpid for visibility check", {
      oid,
      type,
      rootRpid,
    });
  }

  const expectedReplyCount =
    minVisibleReplyCount === null || minVisibleReplyCount === undefined
      ? null
      : Math.max(0, normalizeCommentCount(minVisibleReplyCount));
  let lastObservedReplyCount = null;
  let lastObservedPageCount = null;
  let lastHasTopComment = false;
  let foundRootComment = false;
  let threadVisible = false;

  for (let attempt = 0; attempt < THREAD_VISIBILITY_MAX_ATTEMPTS; attempt += 1) {
    const response = await client.reply.list({
      oid,
      type,
      pn: 1,
      ps: 20,
      sort: 0,
      nohot: 0,
    });
    const rootComment = findReplyNodeByRpid(response, normalizedRootRpid);

    foundRootComment = Boolean(rootComment);
    lastObservedReplyCount = rootComment ? normalizeCommentCount(rootComment.count ?? rootComment.rcount) : null;
    lastObservedPageCount = normalizeCommentCount(response?.page?.count);
    lastHasTopComment = Boolean(response?.upper?.top ?? response?.top);
    threadVisible = Boolean(rootComment) && (expectedReplyCount === null || lastObservedReplyCount >= expectedReplyCount);

    if (attempt < THREAD_VISIBILITY_MAX_ATTEMPTS - 1) {
      await sleepImpl(THREAD_VISIBILITY_RETRY_DELAY_MS);
    }
  }

  if (threadVisible) {
    return {
      observedReplyCount: lastObservedReplyCount,
      pageCount: lastObservedPageCount,
    };
  }

  throw createCliError("Published comment thread is not visible on the video page", {
    oid,
    type,
    rootRpid: normalizedRootRpid,
    expectedReplyCount,
    observedReplyCount: lastObservedReplyCount,
    pageCount: lastObservedPageCount,
    hasTopComment: lastHasTopComment,
    foundRootComment,
  });
}

export function isMissingCommentThreadError(error) {
  return isDeletedCommentThreadError(error);
}

function buildCreatedCommentRecord({ replyRes, rootRpid, chunk, isRoot }) {
  return {
    rpid: replyRes.rpid,
    root: rootRpid,
    parent: rootRpid,
    pages: chunk.pages,
    messageLength: chunk.message.length,
    isRoot,
  };
}

async function createRootComment({ client, oid, type, chunk, sleepImpl = sleep }) {
  const rootRes = await client.reply.add({
    oid,
    type,
    message: chunk.message,
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
    rootRes,
    topWarning: topError
      ? buildCommentWarning({
          step: "top-root-comment",
          rpid: rootRes.rpid,
          error: topError,
        })
      : null,
  };
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
}) {
  const normalizedMessage = normalizeSummaryMarkers(message);
  if (!normalizedMessage) {
    throw createCliError("Comment content is empty");
  }

  const chunks = splitSummaryForComments(normalizedMessage, 1000);
  if (chunks.length === 0) {
    throw createCliError("No comment chunks generated from summary");
  }

  let rootRpid = forcedRootRpid ?? existingRootRpid ?? topCommentState.topComment?.rpid ?? null;
  const initialRootRpid = rootRpid;
  const initialVisibleReplyCount =
    normalizeCommentRpid(topCommentState.topComment?.rpid) === normalizeCommentRpid(rootRpid)
      ? normalizeCommentCount(topCommentState.topComment?.count)
      : null;
  const createdComments = [];
  const warnings = [];
  let recoveredFromDeletedRoot = false;
  let replacedRootCommentRpid = null;

  if (!rootRpid) {
    const firstChunk = chunks.shift();
    const { rootRes, topWarning } = await createRootComment({
      client,
      oid,
      type,
      chunk: firstChunk,
      sleepImpl,
    });
    if (topWarning) {
      warnings.push(topWarning);
    }

    rootRpid = rootRes.rpid;
    createdComments.push(
      buildCreatedCommentRecord({
        replyRes: rootRes,
        rootRpid: rootRes.rpid,
        chunk: firstChunk,
        isRoot: true,
      }),
    );
  } else if (!topCommentState.hasTopComment || topCommentState.topComment?.rpid !== rootRpid) {
    await client.reply
      .top({
        oid,
        type,
        rpid: rootRpid,
        action: 1,
      })
      .catch(() => null);
  }

  for (const [index, chunk] of chunks.entries()) {
    try {
      const replyRes = await client.reply.add({
        oid,
        type,
        root: rootRpid,
        parent: rootRpid,
        message: chunk.message,
        plat: 1,
      });

      createdComments.push(
        buildCreatedCommentRecord({
          replyRes,
          rootRpid,
          chunk,
          isRoot: false,
        }),
      );

      // Bilibili child replies can appear out of order when they land too close together.
      // Spacing out posts makes the visible thread order match the summary page order more reliably.
      if (index < chunks.length - 1) {
        await sleepImpl(REPLY_POST_DELAY_MS);
      }
    } catch (error) {
      if (createdComments.length === 0 && rootRpid && isDeletedCommentThreadError(error)) {
        const { rootRes, topWarning } = await createRootComment({
          client,
          oid,
          type,
          chunk,
          sleepImpl,
        });
        if (topWarning) {
          warnings.push(topWarning);
        }

        replacedRootCommentRpid = rootRpid;
        rootRpid = rootRes.rpid;
        recoveredFromDeletedRoot = true;
        createdComments.push(
          buildCreatedCommentRecord({
            replyRes: rootRes,
            rootRpid,
            chunk,
            isRoot: true,
          }),
        );
        continue;
      }

      throw error;
    }
  }

  const createdReplyCount = createdComments.filter((item) => !item.isRoot).length;
  const minVisibleReplyCount =
    normalizeCommentRpid(initialRootRpid) === normalizeCommentRpid(rootRpid) && initialVisibleReplyCount !== null
      ? initialVisibleReplyCount + createdReplyCount
      : createdComments.some((item) => item.isRoot)
        ? createdReplyCount
        : null;

  await assertCommentThreadVisible({
    client,
    oid,
    type,
    rootRpid,
    minVisibleReplyCount,
    sleepImpl,
  });

  updateVideoCommentThread(db, videoId, {
    rootCommentRpid: rootRpid,
    topCommentRpid: rootRpid,
  });

  const coveredPages = [...new Set(createdComments.flatMap((item) => item.pages))].sort((a, b) => a - b);
  if (coveredPages.length > 0) {
    markPartsPublished(db, videoId, coveredPages, rootRpid);
  }

  return {
    action: createdComments.some((item) => item.isRoot) ? "comment-thread-created-or-extended" : "reply-to-comment-thread",
    normalizedMessage,
    coveredPagesFromMessage: extractCoveredPages(normalizedMessage),
    rootCommentRpid: rootRpid,
    recoveredFromDeletedRoot,
    replacedRootCommentRpid,
    createdComments,
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
